// Payroll-3B-4 (2026-08-29) — canonical Payroll Batch preparation.
//
// This service takes an approved Pay Period and produces a
// deterministic, frozen structural snapshot the future calculation
// engine (3B-5) will read. It does NOT compute dollars — no gross
// pay, no net pay, no CPP/EI/tax, no allowance-frequency conversion,
// no salary proration, no hourly rate × hours multiplication.
//
// Contract:
//   • Inputs: (principal, clubId, payPeriodId)
//   • Preconditions: Payroll Club config exists; every Department
//     with payable time for the period is APPROVED.
//   • Outputs: exactly one PayrollBatch in DRAFT (with BLOCKERs)
//     or PREPARED (no blockers). Idempotent — retrying returns the
//     existing PREPARED / DRAFT-with-blockers batch when the
//     source snapshot is still valid.
//   • Source facts: employee identity, active assignments in the
//     period, effective compensation records, snapshotted allowance
//     rows, approved-time reservations (`consumedByBatchId` set).
//   • Exceptions: PayrollBatchException rows with severity
//     BLOCKER / WARNING / INFO.

import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { ValidationError, NotFoundError } from "../errors";
import { intersect, coverageDays as intervalCoverageDays } from "./intervals";
import {
  assertValidSourceFactsV1,
  parseSourceFactsV1,
  type PayrollBatchSourceFactsV1,
  type SourceFactsCoverageV1,
} from "./source-facts-schema";
import { resolveTd1ClaimAtPreparation, isResolvedTd1, isTd1ResolutionFailure } from "./td1-claim-resolver";
import { TD1_CLAIM_RESOLUTION_FAILED } from "./calculation-blockers";
import { computePeriodSalary } from "./earnings-calculator";
import { resolvePeriodsPerYearFromCalendar } from "./statutory/periods-per-year";

const ENTITY = "PayrollBatch";

export type ExceptionSeverity = "BLOCKER" | "WARNING" | "INFO";

export interface PreparedBatchView {
  id: string;
  clubId: string;
  payGroupId: string;
  payPeriodId: string;
  status: string;
  sequence: number;
  sourceSnapshotAt: Date | null;
  preparedAt: Date | null;
  preparedByUserId: string | null;
  voidedAt: Date | null;
  voidedByUserId: string | null;
  voidReason: string | null;
  workIntakeItemId: string | null;
  employees: PreparedBatchEmployeeView[];
  exceptions: ExceptionView[];
}

export interface PreparedBatchEmployeeView {
  id: string;
  employeeId: string;
  status: string;
  salaried: boolean;
  employmentStartInPeriod: Date | null;
  employmentEndInPeriod: Date | null;
  approvedHoursSnapshot: string | null;
  jurisdictionCountry: string;
  jurisdictionProvince: string | null;
  employeeLifecycleAtPrep: string;
  bankingReady: boolean;
  bankingStatus: string | null;
  sinReady: boolean;
  federalTd1Ready: boolean;
  provincialTd1Ready: boolean;
  compensationReady: boolean;
  // Payroll-3B-5A (2026-08-31) — coverage window (§2, §5).
  membershipEffectiveFrom: Date | null;
  membershipEffectiveTo: Date | null;
  coverageStart: Date | null;
  coverageEnd: Date | null;
  // Payroll-3B-5B-1a (2026-08-31) — frozen DOB for CPP eligibility.
  dateOfBirthSnapshot: Date | null;
  sourceFacts: PayrollBatchSourceFactsV1 | null;
}

export interface ExceptionView {
  id: string;
  severity: ExceptionSeverity;
  code: string;
  message: string;
  batchEmployeeId: string | null;
  employeeId: string | null;
  employeeDisplayName: string | null;  // "First Last" — helps the Payroll Admin identify affected people
  recommendedAction: string | null;
  resolvedAt: Date | null;
}

// Payroll-3B-5A (2026-08-31) — the source-facts blob shape lives
// in src/lib/payroll/source-facts-schema.ts as
// `PayrollBatchSourceFactsV1`. This file consumes / produces that
// exact shape; both write and read paths validate it.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function iso(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString();
}

async function loadPayPeriod(clubId: string, payPeriodId: string) {
  const p = await prisma.payrollPayPeriod.findFirst({
    where: { id: payPeriodId, clubId },
    include: { payGroup: { select: { id: true, code: true, name: true, active: true, payFrequency: true } } },
  });
  if (!p) throw new NotFoundError("PayrollPayPeriod", payPeriodId);
  return p;
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

async function assertPreconditions(clubId: string, payPeriodId: string): Promise<{
  payPeriodId: string;
  payGroupId: string;
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  payFrequency: string;
}> {
  const period = await loadPayPeriod(clubId, payPeriodId);
  if (!period.payGroup.active) {
    throw new ValidationError([
      { path: "payGroupId", message: "Pay group is inactive; reactivate it before preparing payroll." },
    ]);
  }
  const config = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  if (!config) {
    throw new ValidationError([
      { path: "clubId", message: "Payroll has not been configured for this Club (no PayrollClubConfig)." },
    ]);
  }

  // Departments with payable time — every one must be APPROVED.
  const entries = await prisma.payrollApprovedTimeEntry.findMany({
    where: {
      clubId,
      workDate: { gte: period.periodStart, lt: period.periodEnd },
    },
    select: {
      employmentAssignment: { select: { departmentId: true } },
    },
  });
  const departmentIds = new Set<string>();
  for (const e of entries) {
    if (e.employmentAssignment?.departmentId) departmentIds.add(e.employmentAssignment.departmentId);
  }
  if (departmentIds.size > 0) {
    // Payroll-3D-3B Slice 7C (2026-09-06) — currency-gated
    // "approved" set: state=APPROVED AND (for new approvals) both
    // approvedRevision matches AND approvedScopeVersion matches.
    // Legacy null approvedScopeVersion falls back to revision-only.
    const approvals = await prisma.payrollDepartmentTimeApproval.findMany({
      where: { clubId, payPeriodId, departmentId: { in: Array.from(departmentIds) }, state: "APPROVED" },
      select: { departmentId: true, approvedRevision: true, approvedScopeVersion: true },
    });
    const { computeScopeRevision } = await import("../timesheets/approval-scope");
    const { readScopeVersion } = await import("../timesheets/scope-state");
    const approvedIds = new Set<string>();
    for (const a of approvals) {
      const rev = await computeScopeRevision(clubId, payPeriodId, a.departmentId);
      const ver = await readScopeVersion(clubId, payPeriodId, a.departmentId);
      // Legacy compat (§11): null revision + null version means a
      // pre-Slice-7B row (or the legacy 3D-2 approveDepartmentTime
      // path) — trust the persisted state as current. Non-null
      // fields must match; a mix (null revision + set version) is
      // treated conservatively as non-current.
      const revisionMatches = a.approvedRevision == null || a.approvedRevision === rev;
      const versionMatches = a.approvedScopeVersion == null || a.approvedScopeVersion === ver;
      if (revisionMatches && versionMatches) approvedIds.add(a.departmentId);
    }
    const missing = Array.from(departmentIds).filter((id) => !approvedIds.has(id));
    if (missing.length > 0) {
      const missingDepartments = await prisma.department.findMany({
        where: { id: { in: missing }, clubId },
        select: { name: true, code: true },
        orderBy: [{ code: "asc" }],
      });
      const names = missingDepartments.map((d) => d.name).join(", ");
      throw new ValidationError([
        {
          path: "departmentApproval",
          message: `Payroll cannot be prepared yet. ${names} still awaiting time approval.`,
        },
      ]);
    }
  }

  return {
    payPeriodId: period.id,
    payGroupId: period.payGroupId,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    payDate: period.payDate,
    payFrequency: period.payGroup.payFrequency,
  };
}

// ---------------------------------------------------------------------------
// Population — deterministic Pay Group membership resolution.
// ---------------------------------------------------------------------------

/**
 * Population rule — one PayrollBatchEmployee per MEMBERSHIP ROW
 * intersecting the Pay Period (not per Employee).
 *
 * Payroll-3B-5A (2026-08-31, §1): the 3B-4 assumption that overlap
 * prevention implies "one batch per employee per period" is not
 * generally true. An Employee whose membership in Group A ended on
 * Aug 15 and whose membership in Group B started on Aug 15 has
 * TWO non-overlapping memberships within a broad Aug 1–31 period.
 * Each Group runs its own batch; the Aug 1–31 broad range is not a
 * single Pay Period but two separate ones (one per Group).
 *
 * The narrower question for THIS batch is: which memberships in
 * THIS Pay Group intersect THIS Pay Period? Overlap prevention
 * from 3B-1 still guarantees at most one covering membership per
 * (Employee, PayGroup) instant — so within a single Pay Group's
 * batch, an Employee still appears at most once. But the coverage
 * window may not span the entire Pay Period; the future calculator
 * must consume `coverageStart` / `coverageEnd` to prorate salary
 * correctly and prevent duplicate pay across a transfer boundary.
 */
async function resolvePopulation(clubId: string, payGroupId: string, periodStart: Date, periodEnd: Date) {
  const members = await prisma.payrollPayGroupMember.findMany({
    where: {
      clubId,
      payGroupId,
      // half-open interval intersection
      effectiveFrom: { lt: periodEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: periodStart } }],
    },
    include: {
      employee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          employeeLifecycle: true,
          hireDate: true,
          terminationDate: true,
          // Payroll-3B-5B-1a — DOB is required for CPP age eligibility.
          dateOfBirth: true,
          userId: true,
        },
      },
    },
  });
  // Ordered deterministically for reproducibility.
  members.sort((a, b) => a.employee.lastName.localeCompare(b.employee.lastName) || a.employee.firstName.localeCompare(b.employee.firstName));
  return members;
}

/**
 * Compute coverage for a membership row within a Pay Period.
 * Uses the canonical interval-intersection utility so a future
 * consumer never has to redo the half-open boundary math.
 */
function coverageForMembership(
  membershipEffectiveFrom: Date,
  membershipEffectiveTo: Date | null,
  periodStart: Date,
  periodEnd: Date,
): SourceFactsCoverageV1 {
  const period = { start: periodStart, end: periodEnd };
  const membership = { start: membershipEffectiveFrom, end: membershipEffectiveTo };
  const isected = intersect(period, membership);
  if (!isected) {
    // Should be unreachable — populated members already passed the
    // half-open overlap filter. Defensive: emit a zero-day window.
    return {
      membershipEffectiveFrom: membershipEffectiveFrom.toISOString(),
      membershipEffectiveTo: membershipEffectiveTo?.toISOString() ?? null,
      coverageStart: periodStart.toISOString(),
      coverageEnd: periodStart.toISOString(),
      coverageDays: 0,
      periodDays: intervalCoverageDays({ start: periodStart, end: periodEnd }),
      isFullPeriod: false,
    };
  }
  const cs = isected.start;
  // The intersection with the bounded period is itself bounded.
  const ce = isected.end ?? periodEnd;
  const cDays = intervalCoverageDays({ start: cs, end: ce });
  const pDays = intervalCoverageDays({ start: periodStart, end: periodEnd });
  return {
    membershipEffectiveFrom: membershipEffectiveFrom.toISOString(),
    membershipEffectiveTo: membershipEffectiveTo?.toISOString() ?? null,
    coverageStart: cs.toISOString(),
    coverageEnd: ce.toISOString(),
    coverageDays: cDays,
    periodDays: pDays,
    isFullPeriod: cDays === pDays,
  };
}

// ---------------------------------------------------------------------------
// Snapshot per employee
// ---------------------------------------------------------------------------

interface EmployeeSnapshot {
  employeeId: string;
  payGroupMemberId: string;
  employeeLifecycleAtPrep: string;
  jurisdictionCountry: string;
  jurisdictionProvince: string | null;
  employmentStartInPeriod: Date | null;
  employmentEndInPeriod: Date | null;
  salaried: boolean;
  approvedHours: Decimal | null;
  approvedTimeEntryIds: string[];
  sourceFacts: PayrollBatchSourceFactsV1;
  membershipEffectiveFrom: Date;
  membershipEffectiveTo: Date | null;
  coverageStart: Date;
  coverageEnd: Date;
  // Payroll-3B-5B-1a — frozen Employee DOB (civil date) for CPP age
  // eligibility. NULL when the Employee has no DOB on file — the
  // snapshot writer emits a MISSING_DATE_OF_BIRTH BLOCKER in that
  // case.
  dateOfBirthSnapshot: Date | null;
  bankingReady: boolean;
  bankingStatus: string | null;
  sinReady: boolean;
  federalTd1Ready: boolean;
  provincialTd1Ready: boolean;
  compensationReady: boolean;
  // Slice E closeout (2026-09-19) — historical identity snapshot for
  // payroll documents (Register, PayStatement, PDF, CSV). Frozen here
  // so a later legal-name change does not rewrite historical artefacts.
  firstNameSnapshot: string;
  lastNameSnapshot: string;
  // Slice F (2026-09-19) — hourly overtime snapshot. NULL for salaried.
  regularHoursSnapshot: string | null;
  overtimeHoursSnapshot: string | null;
  hourlyBaseRateSnapshot: string | null;
  overtimeMultiplierSnapshot: string | null;
  overtimeRateSnapshot: string | null;
  overtimePolicyKindSnapshot: string | null;
  workweekStartDowSnapshot: number | null;
  exceptions: Array<{ severity: ExceptionSeverity; code: string; message: string; recommendedAction?: string }>;
}

async function snapshotEmployee(
  clubId: string,
  province: string | null,
  periodStart: Date,
  periodEnd: Date,
  member: Awaited<ReturnType<typeof resolvePopulation>>[number],
  // Slice E (2026-09-19) — batchId threaded so the snapshot can look
  // up existing PayrollZeroHoursAcknowledgement rows for this batch.
  // Nullable for backward compat with any test that stubs the fn.
  batchId?: string,
): Promise<EmployeeSnapshot> {
  const employeeId = member.employee.id;
  const exceptions: EmployeeSnapshot["exceptions"] = [];

  const employmentStart = member.employee.hireDate;
  const employmentEnd = member.employee.terminationDate;
  const employmentStartInPeriod =
    employmentStart && employmentStart >= periodStart && employmentStart < periodEnd
      ? employmentStart
      : null;
  const employmentEndInPeriod =
    employmentEnd && employmentEnd >= periodStart && employmentEnd < periodEnd
      ? employmentEnd
      : null;

  // Active assignments intersecting the period.
  const assignments = await prisma.employeeEmploymentAssignment.findMany({
    where: {
      clubId,
      employeeId,
      effectiveFrom: { lt: periodEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: periodStart } }],
    },
    orderBy: [{ role: "asc" }, { effectiveFrom: "asc" }],
  });
  if (assignments.length === 0) {
    exceptions.push({
      severity: "BLOCKER",
      code: "MISSING_ASSIGNMENT",
      message: "Employee has no employment assignment active during this pay period.",
      recommendedAction: "Add an active EmployeeEmploymentAssignment covering the pay period.",
    });
  }

  // Compensation records intersecting the period. Employees with
  // zero compensation cannot calculate; BLOCKER at prep.
  //
  // Payroll 3A hotfix (2026-09-11): also include compensation rows
  // whose `assignmentId` is NULL. These are legitimate
  // "employee-wide" comp records (the HR write path creates them
  // without an assignmentId when the employee has a single active
  // assignment). The prior assignmentId-scoped query silently
  // dropped them, causing Chris Turcato + Lise Montsion to appear
  // as MISSING_COMPENSATION ERRORED rows on staging despite having
  // a real compensation record. Query is now scoped by
  // `employeeId` for tenant-safety since null `assignmentId` is
  // no longer a scoping mechanism.
  const compensations = assignments.length
    ? await prisma.employeeCompensation.findMany({
        where: {
          clubId,
          employeeId,
          effectiveFrom: { lt: periodEnd },
          AND: [
            { OR: [{ effectiveTo: null }, { effectiveTo: { gt: periodStart } }] },
            { OR: [{ assignmentId: { in: assignments.map((a) => a.id) } }, { assignmentId: null }] },
          ],
        },
        orderBy: [{ effectiveFrom: "asc" }],
      })
    : [];
  const compensationReady = compensations.length > 0;
  if (!compensationReady && assignments.length > 0) {
    exceptions.push({
      severity: "BLOCKER",
      code: "MISSING_COMPENSATION",
      message: "Employee has no compensation record covering this pay period.",
      recommendedAction: "Add an EmployeeCompensation effective for at least part of the period.",
    });
  }
  // Structural salaried flag — set true if any covering compensation
  // has cadence=SALARY. The future calculator handles multi-record
  // cases; this flag is just a hint for the review UI.
  const salaried = compensations.some((c) => (c.cadence ?? "").toUpperCase() === "SALARY");

  // Slice F (2026-09-19) — fetch approved time for the FULL surrounding
  // workweek window, not just the pay-period window. The overtime
  // classifier needs complete workweek context (Alberta ES 8/44
  // greater-of rule) to allocate across cross-period workweeks
  // correctly. Filter by period after classification.
  const { surroundingWorkweekBounds } = await import("./overtime-classifier");
  // Resolve the workweek anchor. Read PayrollClubConfig for the policy.
  const clubConfigForWorkweek = await prisma.payrollClubConfig.findFirst({
    where: { clubId },
    select: { workweekStartDow: true, overtimePolicyKind: true, overtimeDailyThresholdHours: true, overtimeWeeklyThresholdHours: true, overtimeMultiplier: true },
  });
  const workweekStartDow = clubConfigForWorkweek?.workweekStartDow ?? 0;
  const { fetchStart, fetchEnd } = surroundingWorkweekBounds(periodStart, periodEnd, workweekStartDow);
  const approvedTime = await prisma.payrollApprovedTimeEntry.findMany({
    where: {
      clubId,
      employeeId,
      approvalState: "APPROVED",
      consumedByBatchId: null,
      supersededByApprovedTimeEntryId: null,
      workDate: { gte: fetchStart, lt: fetchEnd },
    },
    select: { id: true, hours: true, workDate: true },
  });
  // Slice F — filter to pay-period-only for the legacy scalar snapshot
  // (kept for backward compatibility with the calculator's coarse hourly
  // path). The Slice F classifier below consumes the FULL workweek set.
  const approvedTimeInPeriod = approvedTime.filter(
    (e) => e.workDate.getTime() >= periodStart.getTime() && e.workDate.getTime() < periodEnd.getTime(),
  );
  let approvedHours: Decimal | null = null;
  const approvedTimeEntryIds: string[] = [];
  if (approvedTimeInPeriod.length > 0) {
    approvedTimeEntryIds.push(...approvedTimeInPeriod.map((e) => e.id));
    // Sum via arithmetic (Prisma Decimal — safe to Number for hours).
    let sumCents = 0n;
    for (const e of approvedTimeInPeriod) sumCents += BigInt(Math.round(Number(e.hours.toString()) * 10_000));
    approvedHours = { toString: () => (Number(sumCents) / 10_000).toFixed(4) } as unknown as Decimal;
  }
  // ------------------------------------------------------------------
  // Slice F (2026-09-19) — Alberta ES overtime classification.
  //
  // Apply to HOURLY employees only. Salaried employees are exempt from
  // hourly OT (their earning is a period-fraction of annual salary).
  //
  // Policy state gate (§7, §17-19):
  //   STANDARD             → engine applies the Club default policy.
  //   EXEMPT               → skip classification (no OT).
  //   AGREEMENT_REQUIRED   → BLOCKER; Slice F does not calculate under
  //                          overtime agreements.
  //   AVERAGING_REQUIRED   → BLOCKER; Slice F does not calculate under
  //                          averaging arrangements.
  //
  // If Club has no PayrollClubConfig row (or the policy kind is not
  // ALBERTA_DEFAULT_ES) for a STANDARD hourly employee: BLOCKER.
  // ------------------------------------------------------------------
  let regularHoursSnapshot: string | null = null;
  let overtimeHoursSnapshot: string | null = null;
  let hourlyBaseRateSnapshot: string | null = null;
  let overtimeMultiplierSnapshot: string | null = null;
  let overtimeRateSnapshot: string | null = null;
  let overtimePolicyKindSnapshot: string | null = null;
  let workweekStartDowSnapshot: number | null = null;
  const isHourly = compensations.some(
    (c) => (c.cadence ?? "").toUpperCase() !== "SALARY",
  ) && !salaried;
  if (isHourly) {
    const policyState = (member.employee as unknown as { overtimePolicyState?: string }).overtimePolicyState ?? "STANDARD";
    if (policyState === "AGREEMENT_REQUIRED" || policyState === "AVERAGING_REQUIRED") {
      exceptions.push({
        severity: "BLOCKER",
        code: "OVERTIME_POLICY_UNSUPPORTED",
        message:
          `Employee overtime policy state ${policyState} is not yet supported by the Spectre payroll engine. ` +
          "Payroll cannot silently calculate under a special arrangement.",
        recommendedAction:
          "Configure the arrangement in Payroll Settings, OR revert the employee to STANDARD before Prepare.",
      });
    } else if (policyState === "STANDARD") {
      // Fail-closed if the Club has no explicit ALBERTA_DEFAULT_ES policy.
      if (!clubConfigForWorkweek || clubConfigForWorkweek.overtimePolicyKind !== "ALBERTA_DEFAULT_ES") {
        exceptions.push({
          severity: "BLOCKER",
          code: "OVERTIME_POLICY_REQUIRED",
          message:
            "The Club has no supported overtime policy configured. Alberta ESA default (8/44 greater-of, 1.5×, Sunday-anchored workweek) is the only policy Slice F supports.",
          recommendedAction:
            "Configure the Alberta ES default overtime policy in Payroll Settings, OR mark this employee EXEMPT if statutorily exempt.",
        });
      } else {
        // Classify.
        const { classifyForPayPeriod } = await import("./overtime-classifier");
        const policy = {
          kind: "ALBERTA_DEFAULT_ES" as const,
          dailyThresholdHours: new Decimal(clubConfigForWorkweek.overtimeDailyThresholdHours.toString()),
          weeklyThresholdHours: new Decimal(clubConfigForWorkweek.overtimeWeeklyThresholdHours.toString()),
          multiplier: new Decimal(clubConfigForWorkweek.overtimeMultiplier.toString()),
          workweekStartDow,
        };
        const cls = classifyForPayPeriod(
          approvedTime.map((e) => ({ id: e.id, workDate: e.workDate, hours: new Decimal(e.hours.toString()) })),
          periodStart, periodEnd, policy,
        );
        regularHoursSnapshot  = cls.regularHours.toFixed(4);
        overtimeHoursSnapshot = cls.overtimeHours.toFixed(4);
        overtimePolicyKindSnapshot = "ALBERTA_DEFAULT_ES";
        workweekStartDowSnapshot   = workweekStartDow;
        // Freeze base rate + multiplier + derived OT rate for the
        // FIRST hourly compensation covering the period.
        const firstHourly = compensations.find((c) => (c.cadence ?? "").toUpperCase() !== "SALARY");
        if (firstHourly) {
          const baseRate = new Decimal(firstHourly.rate.toString());
          const mult = policy.multiplier;
          const otRate = baseRate.times(mult);
          hourlyBaseRateSnapshot     = baseRate.toFixed(4);
          overtimeMultiplierSnapshot = mult.toFixed(4);
          overtimeRateSnapshot       = otRate.toFixed(4);
        }
      }
    }
    // EXEMPT → no snapshot, no blocker (paid as regular via legacy path).
  }

  // Slice E (2026-09-19) §17 — emit NO_APPROVED_HOURS_FOR_HOURLY. The
  // audit found this blocker was declared but never fired; a live
  // hourly employee with zero approved payable hours would silently
  // calculate to $0. Now fires BLOCKER unless the Payroll Admin has
  // explicitly recorded a `PayrollZeroHoursAcknowledgement` for this
  // batch × employee (leave / no shifts / seasonal / other).
  // (Slice E) — isHourly already computed above (§17 zero-hours block
  // reused it after Slice F refactored the cadence check into `isHourly`
  // earlier in this function). Re-use the same boolean here.
  const hoursSumNumeric = approvedHours ? Number(approvedHours.toString()) : 0;
  if (isHourly && hoursSumNumeric === 0) {
    let acknowledged = false;
    if (batchId) {
      const ack = await prisma.payrollZeroHoursAcknowledgement.findFirst({
        where: { clubId, batchId, employeeId },
        select: { id: true },
      });
      acknowledged = ack != null;
    }
    if (!acknowledged) {
      exceptions.push({
        severity: "BLOCKER",
        code: "NO_APPROVED_HOURS_FOR_HOURLY",
        message:
          "Hourly employee has no approved payable hours for this pay period. " +
          "Approve time, or acknowledge zero hours expected (with reason) to proceed.",
        recommendedAction:
          "Return to Department Approvals to approve the employee's hours, OR acknowledge zero hours expected under Payroll Review with a reason.",
      });
    }
  }

  // Allowances intersecting the period.
  const allowances = await prisma.employeeAllowance.findMany({
    where: {
      clubId,
      employeeId,
      effectiveFrom: { lt: periodEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: periodStart } }],
    },
    orderBy: [{ effectiveFrom: "asc" }],
  });

  // Payroll/HR Integration hotfix (2026-09-14) §3-4 — payroll-profile
  // readiness is derived from the ACTUAL identity + tax sources of truth,
  // never from the fragile `PayrollProfile.activatedAt` state transition
  // (which no onboarding-approval code path fires, so the flag was
  // permanently stuck at `NULL` for every real employee — see Marc's
  // staging state where the underlying SIN/TD1/DOB data were all present
  // yet the warning still fired). The `PayrollProfile.suspendedAt` flag
  // is still respected — an explicit suspension halts payroll.
  const payrollProfile = await prisma.payrollProfile.findUnique({ where: { employeeId } });
  const sensitiveIdentity = await prisma.employeeSensitiveIdentity.findFirst({
    where: { employeeId },
    select: { id: true, sinLastThree: true },
  });
  const sinReady =
    !!sensitiveIdentity &&
    typeof sensitiveIdentity.sinLastThree === "string" &&
    sensitiveIdentity.sinLastThree.length === 3 &&
    !payrollProfile?.suspendedAt;
  const taxProfile = await prisma.employeeTaxProfile.findFirst({
    where: {
      employeeId,
      effectiveFrom: { lte: periodStart },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: periodStart } }],
    },
    orderBy: [{ effectiveFrom: "desc" }],
    // Payroll-3B-5B-2c — include plain-column TD1 facts required by
    // the tax calculator (claimZero flags, additional-tax amounts).
    // Claim amounts themselves live behind KMS envelope refs.
    select: {
      federalClaimSecretRef: true, provincialClaimSecretRef: true,
      claimZeroFederal: true, claimZeroProvincial: true,
      totalIncomeLessThanClaim: true,
      additionalFederalTaxAmount: true, additionalProvincialTaxAmount: true,
    },
  });
  const federalTd1Ready = !!taxProfile && !!taxProfile.federalClaimSecretRef;
  const provincialTd1Ready = !!taxProfile && !!taxProfile.provincialClaimSecretRef;

  const bank = await prisma.employeeBankAccount.findFirst({
    where: { employeeId, status: "VERIFIED" },
    orderBy: [{ updatedAt: "desc" }],
    select: { status: true },
  });
  const bankingReady = !!bank;
  const bankingStatus = bank?.status ?? "MISSING";
  if (!bankingReady) {
    exceptions.push({
      severity: "WARNING",
      code: "BANKING_NOT_VERIFIED",
      message: "Employee has no VERIFIED bank account. Payroll can still be prepared; payment submission will require verification.",
      recommendedAction: "Verify the employee's banking on the HR profile before payment submission.",
    });
  }

  if (!sinReady) {
    // Payroll/HR Integration hotfix (2026-09-14) §14 — precise language.
    // The warning now says what is ACTUALLY missing (the SIN row) rather
    // than conflating multiple concerns into one generic "profile not
    // activated" message. Direct link is Employee → Payroll where the
    // Payroll Admin can supply the SIN.
    exceptions.push({
      severity: "WARNING",
      code: "MISSING_SIN",
      message: payrollProfile?.suspendedAt
        ? "Employee's Payroll profile is currently suspended. Resume the profile before calculation."
        : "Employee has no SIN on file. Calculation may proceed but T4 issuance requires this.",
      recommendedAction: payrollProfile?.suspendedAt
        ? "Review the employee's Payroll profile and resume it when appropriate."
        : "Add the employee's SIN via the Employee → Payroll tab.",
    });
  }
  if (!federalTd1Ready) {
    exceptions.push({
      severity: "WARNING",
      code: "MISSING_FEDERAL_TD1",
      message: "Employee has no federal TD1 on file. Calculation may proceed with default federal claim amounts.",
    });
  }
  if (!provincialTd1Ready) {
    exceptions.push({
      severity: "WARNING",
      code: "MISSING_PROVINCIAL_TD1",
      message: "Employee has no provincial TD1 on file. Calculation may proceed with default provincial claim amounts.",
    });
  }

  // Payroll-3B-5B-2c CORRECTION — resolve TD1 claim values through
  // the fail-closed resolver. NEVER substitute the package BPA for
  // a genuine decrypt failure. Missing tax profile (no ref at all)
  // falls back to BPA — that's the pre-2c documented WARNING path
  // already handled above.
  const fedResolve = await resolveTd1ClaimAtPreparation({
    secretReference: `td1-fed:${employeeId}`,
    ciphertext:      taxProfile?.federalClaimSecretRef ?? null,
    claimZero:       taxProfile?.claimZeroFederal ?? false,
  });
  const provResolve = await resolveTd1ClaimAtPreparation({
    secretReference: `td1-prov:${employeeId}`,
    ciphertext:      taxProfile?.provincialClaimSecretRef ?? null,
    claimZero:       taxProfile?.claimZeroProvincial ?? false,
  });
  if (isTd1ResolutionFailure(fedResolve)) {
    exceptions.push({
      severity: "BLOCKER",
      code: TD1_CLAIM_RESOLUTION_FAILED,
      message: "Federal TD1 claim could not be securely resolved. Payroll cannot proceed for this employee until the tax profile is corrected.",
      recommendedAction: "Re-enter the federal TD1 claim on the employee's tax profile; the encrypted value on file cannot be read by Payroll.",
    });
  }
  if (isTd1ResolutionFailure(provResolve)) {
    exceptions.push({
      severity: "BLOCKER",
      code: TD1_CLAIM_RESOLUTION_FAILED,
      message: "Provincial TD1 claim could not be securely resolved. Payroll cannot proceed for this employee until the tax profile is corrected.",
      recommendedAction: "Re-enter the Alberta TD1 claim on the employee's tax profile; the encrypted value on file cannot be read by Payroll.",
    });
  }
  // Frozen numeric string for `sourceFactsJson.tax`. On resolution
  // failure we still populate SOMETHING so the Zod shape is valid,
  // but the BLOCKER above prevents the calculator from ever running.
  // We use "0" (not the BPA) so a bug that ignored the BLOCKER
  // would produce a large tax deduction rather than a plausibly-
  // correct-looking one.
  const frozenFederalClaim = isResolvedTd1(fedResolve)
    ? fedResolve.value
    : (federalTd1Ready ? "0" : "16452");   // package.federal.bpaMax default only when no profile at all
  const frozenProvincialClaim = isResolvedTd1(provResolve)
    ? provResolve.value
    : (provincialTd1Ready ? "0" : "22769"); // package.provincial.bpa default only when no profile at all

  const coverage = coverageForMembership(
    member.effectiveFrom,
    member.effectiveTo ?? null,
    periodStart,
    periodEnd,
  );

  // Payroll-3B-5B-1a — freeze identity facts. DOB is required for
  // CPP age eligibility; missing DOB is a BLOCKER (the future
  // calculator refuses to guess age from any other field).
  const dateOfBirthSnapshot: Date | null = member.employee.dateOfBirth ?? null;
  if (!dateOfBirthSnapshot) {
    exceptions.push({
      severity: "BLOCKER",
      code: "MISSING_DATE_OF_BIRTH",
      message: "Date of birth is required to determine CPP deductions.",
      recommendedAction: "Set the employee's date of birth on their profile before preparing payroll.",
    });
  }

  const sourceFacts: PayrollBatchSourceFactsV1 = {
    schemaVersion: 1,
    coverage,
    identity: {
      dateOfBirth: dateOfBirthSnapshot ? dateOfBirthSnapshot.toISOString() : null,
    },
    assignments: assignments.map((a) => ({
      id: a.id,
      role: a.role,
      departmentId: a.departmentId,
      positionId: a.positionId,
      employmentType: a.employmentType,
      effectiveFrom: a.effectiveFrom.toISOString(),
      effectiveTo: iso(a.effectiveTo),
    })),
    compensations: compensations.map((c) => {
      const cadenceUpper = (c.cadence ?? "").toUpperCase();
      return {
        id: c.id,
        assignmentId: c.assignmentId,
        payType: cadenceUpper,
        hourlyRate: cadenceUpper === "HOURLY" ? c.rate.toString() : null,
        annualSalary: cadenceUpper === "SALARY" ? c.rate.toString() : null,
        effectiveFrom: c.effectiveFrom.toISOString(),
        effectiveTo: iso(c.effectiveTo),
      };
    }),
    allowances: allowances.map((al) => ({
      id: al.id,
      assignmentId: al.assignmentId ?? null,
      allowanceType: al.allowanceType,
      amount: al.amount.toString(),
      frequency: al.frequency,
      taxable: al.taxable,
      effectiveFrom: al.effectiveFrom.toISOString(),
      effectiveTo: iso(al.effectiveTo),
    })),
    // Payroll-3B-5B-2c CORRECTION (2026-09-01) — freeze RESOLVED
    // TD1 tax facts. Values come from the fail-closed resolver
    // above: encrypted `enc:` envelopes are decrypted via the
    // canonical HR KMS service; plain-decimal test/legacy values
    // are parsed; anything else raises TD1_CLAIM_RESOLUTION_FAILED
    // and never silently substitutes the package BPA.
    tax: {
      federalClaim:                  frozenFederalClaim,
      provincialClaim:               frozenProvincialClaim,
      claimZeroFederal:              taxProfile?.claimZeroFederal ?? false,
      claimZeroProvincial:           taxProfile?.claimZeroProvincial ?? false,
      totalIncomeLessThanClaim:      taxProfile?.totalIncomeLessThanClaim ?? false,
      additionalFederalTaxAmount:    (taxProfile?.additionalFederalTaxAmount    ?? "0").toString(),
      additionalProvincialTaxAmount: (taxProfile?.additionalProvincialTaxAmount ?? "0").toString(),
    },
  };

  // Fail loud if a future refactor produces an invalid shape.
  assertValidSourceFactsV1(sourceFacts);

  return {
    employeeId,
    payGroupMemberId: member.id,
    employeeLifecycleAtPrep: member.employee.employeeLifecycle,
    jurisdictionCountry: "CA",
    jurisdictionProvince: province,
    employmentStartInPeriod,
    employmentEndInPeriod,
    salaried,
    approvedHours,
    approvedTimeEntryIds,
    sourceFacts,
    membershipEffectiveFrom: member.effectiveFrom,
    membershipEffectiveTo: member.effectiveTo ?? null,
    coverageStart: new Date(coverage.coverageStart),
    coverageEnd: new Date(coverage.coverageEnd),
    dateOfBirthSnapshot,
    bankingReady,
    bankingStatus,
    sinReady,
    federalTd1Ready,
    provincialTd1Ready,
    compensationReady,
    // Slice E closeout — freeze the display name for historical payroll
    // documents. If Employee.firstName / lastName are ever nullable in
    // some future schema variant, fall back to empty string so the
    // snapshot column stays non-null (schema declares it as String? so
    // NULL is also legal, but frozen empty strings are clearer).
    firstNameSnapshot: (member.employee.firstName ?? "").trim(),
    lastNameSnapshot:  (member.employee.lastName  ?? "").trim(),
    // Slice F — hourly overtime freeze.
    regularHoursSnapshot,
    overtimeHoursSnapshot,
    hourlyBaseRateSnapshot,
    overtimeMultiplierSnapshot,
    overtimeRateSnapshot,
    overtimePolicyKindSnapshot,
    workweekStartDowSnapshot,
    exceptions,
  };
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

export interface PreparePayrollBatchResult {
  status: "prepared" | "prepared-with-blockers" | "existing";
  batchId: string;
  employeeCount: number;
  salariedCount: number;
  hourlyCount: number;
  approvedTimeEntryCount: number;
  blockerCount: number;
  warningCount: number;
}

export async function preparePayrollBatch(
  principal: Principal,
  clubId: string,
  payPeriodId: string,
): Promise<PreparePayrollBatchResult> {
  requirePermission(principal, clubId, "payroll:run");
  await assertPostingAllowed(principal, clubId, "payroll.batch.prepare", ENTITY, payPeriodId);

  // v-slice-1-followup-5 (2026-09-15) — canonical Step 1 gate.
  // Department Head approval of source time PRECEDES Prepare. When
  // the pay period has reviewable department scopes with outstanding
  // approvals, refuse Prepare here so the workflow order actually
  // reflects the founder-accepted governance. Salary-only periods
  // (no employees with time in the period) have scopeCount === 0
  // and skip this gate — Prepare proceeds immediately.
  //
  // `getTimeReadiness` reads `PayrollDepartmentTimeApproval` (keyed
  // by `(clubId, payPeriodId, departmentId)`) — that model already
  // supports pre-Prepare approval by design. No schema change
  // required.
  const readiness = await import("./time-readiness")
    .then((mod) => mod.getTimeReadiness(principal, clubId, payPeriodId));
  if (readiness.scopeCount > 0 && !readiness.allDepartmentApproved) {
    const outstanding = readiness.scopes
      .filter((s) => s.state !== "APPROVED_UNFROZEN" && s.state !== "FROZEN")
      .map((s) => s.departmentName || s.departmentCode)
      .join(", ");
    throw new ValidationError([{
      path: "departmentApprovals",
      message: `Cannot prepare payroll: ${readiness.departmentPendingScopeCount} department${
        readiness.departmentPendingScopeCount === 1 ? "" : "s"
      } still need${
        readiness.departmentPendingScopeCount === 1 ? "s" : ""
      } manager approval for this pay period${outstanding ? ` (${outstanding})` : ""}. Route through the Approvals step first.`,
    }]);
  }

  // v-slice-1-followup-7 (2026-09-15) — Payroll implementation gate.
  // The Club must have EXPLICITLY declared its payroll implementation
  // position for the batch's tax year before Prepare consumes any
  // payroll for that year. Spectre must never silently assume zero
  // prior YTD.
  //
  // Absent declaration → BLOCKER surfaced as a ValidationError with a
  // direct pointer to Payroll Settings → Payroll Implementation.
  //
  // Under MID_YEAR_MIGRATION, we do NOT check per-employee ACTIVE
  // opening balances here (the population isn't resolved yet). That
  // check happens INSIDE the per-employee snapshot loop below.
  const period = await prisma.payrollPayPeriod.findFirst({
    where: { id: payPeriodId, clubId },
    select: { taxYear: true, payDate: true },
  });
  if (!period) throw new NotFoundError("PayrollPayPeriod", payPeriodId);
  const { readImplementationForCalculation } = await import("./implementation-declaration");
  const implState = await readImplementationForCalculation(clubId, period.taxYear);
  if (!implState.hasDeclaration) {
    throw new ValidationError([{
      path: "payrollImplementation",
      message: `Payroll implementation not declared for tax year ${period.taxYear}. Confirm in Payroll Settings → Payroll Implementation before running payroll. Spectre will not assume zero prior year-to-date balances silently.`,
    }]);
  }

  const pre = await assertPreconditions(clubId, payPeriodId);

  // Idempotency: if a non-VOIDED batch already exists for this
  // (Club, PayGroup, PayPeriod), return it. The founder-mandated
  // policy is that source changes DO NOT auto-refresh — a stale
  // batch must be explicitly voided + re-prepared.
  const existing = await prisma.payrollBatch.findFirst({
    where: {
      clubId,
      payGroupId: pre.payGroupId,
      payPeriodId,
      status: { not: "VOIDED" },
    },
  });
  if (existing) {
    const [empCount, blockerCount, warningCount] = await Promise.all([
      prisma.payrollBatchEmployee.count({ where: { batchId: existing.id } }),
      prisma.payrollBatchException.count({ where: { batchId: existing.id, severity: "BLOCKER" } }),
      prisma.payrollBatchException.count({ where: { batchId: existing.id, severity: "WARNING" } }),
    ]);
    return {
      status: "existing",
      batchId: existing.id,
      employeeCount: empCount,
      salariedCount: await prisma.payrollBatchEmployee.count({ where: { batchId: existing.id, salaried: true } }),
      hourlyCount: await prisma.payrollBatchEmployee.count({ where: { batchId: existing.id, salaried: false } }),
      approvedTimeEntryCount: await prisma.payrollApprovedTimeEntry.count({
        where: { clubId, consumedByBatchId: existing.id },
      }),
      blockerCount,
      warningCount,
    };
  }

  const config = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  const province = config?.provinceOfEmployment ?? null;
  const members = await resolvePopulation(clubId, pre.payGroupId, pre.periodStart, pre.periodEnd);

  // Payroll-readiness hotfix (2026-09-14) §10-12 — exclusion visibility.
  // ACTIVE Employees at the Club who are NOT in the selected pay group's
  // membership for this period would otherwise silently vanish from Prepare.
  // Surface them as INFO exceptions so the founder can see who was skipped
  // and act (typically: enroll them via Payroll Setup → Membership). INFO
  // severity does NOT affect the batch's DRAFT/PREPARED status.
  const memberEmployeeIds = new Set(members.map((m) => m.employeeId));
  const unenrolledActive = await prisma.employee.findMany({
    where: {
      clubId,
      employeeLifecycle: "ACTIVE",
      onboardingState: "APPROVED",
      id: { notIn: [...memberEmployeeIds] },
    },
    select: { id: true, firstName: true, lastName: true, employeeNumber: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // Compute the next sequence within the (Club, PayGroup, PayPeriod)
  // — respects the accepted @@unique constraint. Voided batches
  // still hold a sequence; the new batch bumps.
  const maxSeq = await prisma.payrollBatch.aggregate({
    where: { clubId, payGroupId: pre.payGroupId, payPeriodId },
    _max: { sequence: true },
  });
  const nextSequence = (maxSeq._max.sequence ?? 0) + 1;

  const snapshottedAt = new Date();
  const snapshots: EmployeeSnapshot[] = [];
  for (const m of members) {
    // Slice E — batchId is intentionally omitted here: the batch has
    // not yet been created (that happens inside the transaction below).
    // The zero-hours-ack lookup inside snapshotEmployee therefore skips
    // and the NO_APPROVED_HOURS_FOR_HOURLY blocker fires on the FIRST
    // Prepare unconditionally. The PA acknowledges from the batch review
    // workspace (which also resolves the exception row directly), so
    // the blocker is cleared without needing a Re-Prepare.
    const snap = await snapshotEmployee(clubId, province, pre.periodStart, pre.periodEnd, m);

    // v-slice-1-followup-7 (2026-09-15) — MID_YEAR_MIGRATION per-employee
    // opening-balance gate. Under the founder-declared MID_YEAR_MIGRATION
    // mode, every included employee must have an ACTIVE
    // `PayrollOpeningBalance` for the batch's tax year. Missing / DRAFT /
    // VALIDATED are all treated as "not yet consumable" and produce a
    // BLOCKER exception so the founder can complete opening YTD before
    // this batch calculates. Legitimate zero YTD is expressed as an
    // ACTIVE row with all `ytd*` = 0 — this gate does NOT check dollar
    // amounts, only ACTIVE presence.
    if (implState.requiresOpeningBalances) {
      const activeOpening = await prisma.payrollOpeningBalance.findFirst({
        where: {
          clubId,
          employeeId: m.employeeId,
          taxYear: period.taxYear,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      if (!activeOpening) {
        snap.exceptions.push({
          severity: "BLOCKER",
          code: "MISSING_OPENING_YTD",
          message:
            `Spectre Payroll is configured as a mid-year implementation for ${period.taxYear}. ` +
            "Opening year-to-date payroll balances must be activated before payroll can be calculated for this employee.",
          recommendedAction:
            "Open Payroll Settings → Opening YTD Balances and activate this employee's opening balance.",
        });
      }
    }

    snapshots.push(snap);
  }

  // Payroll 3A hotfix (2026-09-11) — projected salary earnings.
  //
  // Snapshot the per-period base salary as a canonical
  // `PayrollBatchEarning` (earningType=SALARY, rateSource=
  // SALARY_PROJECTION) at Prepare time, so the Overview surface can
  // display a domain-authoritative gross-pay estimate for salaried
  // employees before Calculate runs. `computePeriodSalary` and
  // `resolvePeriodsPerYearFromCalendar` are the same helpers the
  // calculator uses at Calculate — so the row reconciles exactly
  // with what the calculator would derive later.
  //
  // Semantics we deliberately preserve (matching earnings-calculator.ts):
  //   • Full-period only. Non-full-period salaried employees trip
  //     the calculator's SALARY_PRORATION_POLICY_REQUIRED blocker
  //     at Calculate; Spectre has no founder-approved proration
  //     policy, so we skip the projection here (no gross-pay
  //     estimate → the Overview shows "—" for that row, honestly).
  //   • rate = annualSalary / periodsPerYear as a Decimal, NO
  //     per-row rounding. The calculator rounds only the final
  //     cashEarnings via roundCentsHalfUp. Storing a raw Decimal
  //     rate keeps sub-cent precision so a later recalc reconciles.
  //   • payType/annualSalary picked from the frozen sourceFacts
  //     compensations (the FIRST SALARY row, matching the
  //     calculator's `Array.prototype.find` selection).
  const periodTaxYear = pre.payDate.getUTCFullYear();
  // Payroll 3D acceptance hotfix (2026-09-12) — cross-check calendar
  // row count against the Pay Group's payFrequency. Under-populated
  // calendars would otherwise silently divide annual salary by too
  // few periods (e.g. one row → gross = full annual amount).
  const periodsPerYear = await resolvePeriodsPerYearFromCalendar({
    clubId,
    payGroupId: pre.payGroupId,
    taxYear: periodTaxYear,
    payFrequency: pre.payFrequency,
  });

  const anyBlocker = snapshots.some((s) => s.exceptions.some((e) => e.severity === "BLOCKER"));
  const targetStatus = anyBlocker ? "DRAFT" : "PREPARED";

  // Everything into one transaction — batch + per-employee snapshot +
  // allowance snapshots + exception rows + approved-time reservation.
  const { batch, exceptionSummary } = await prisma.$transaction(async (tx) => {
    const batch = await tx.payrollBatch.create({
      data: {
        clubId,
        payGroupId: pre.payGroupId,
        payPeriodId,
        status: targetStatus,
        sequence: nextSequence,
        preparedAt: targetStatus === "PREPARED" ? snapshottedAt : null,
        preparedByUserId: targetStatus === "PREPARED" ? principal.id : null,
        sourceSnapshotAt: snapshottedAt,
        createdByUserId: principal.id,
      },
    });

    let blockerCount = 0;
    let warningCount = 0;

    for (const s of snapshots) {
      const be = await tx.payrollBatchEmployee.create({
        data: {
          clubId,
          batchId: batch.id,
          employeeId: s.employeeId,
          payGroupMemberId: s.payGroupMemberId,
          jurisdictionCountry: s.jurisdictionCountry,
          jurisdictionProvince: s.jurisdictionProvince,
          employeeLifecycleAtPrep: s.employeeLifecycleAtPrep,
          salaried: s.salaried,
          employmentStartInPeriod: s.employmentStartInPeriod,
          employmentEndInPeriod: s.employmentEndInPeriod,
          approvedHoursSnapshot: s.approvedHours?.toString() ?? null,
          sourceFactsJson: JSON.stringify(s.sourceFacts),
          membershipEffectiveFrom: s.membershipEffectiveFrom,
          membershipEffectiveTo: s.membershipEffectiveTo,
          coverageStart: s.coverageStart,
          coverageEnd: s.coverageEnd,
          dateOfBirthSnapshot: s.dateOfBirthSnapshot,
          bankingReady: s.bankingReady,
          bankingStatus: s.bankingStatus,
          sinReady: s.sinReady,
          federalTd1Ready: s.federalTd1Ready,
          provincialTd1Ready: s.provincialTd1Ready,
          compensationReady: s.compensationReady,
          // Slice E closeout — freeze display identity.
          firstNameSnapshot: s.firstNameSnapshot,
          lastNameSnapshot:  s.lastNameSnapshot,
          // Slice F — hourly overtime freeze.
          regularHoursSnapshot:       s.regularHoursSnapshot,
          overtimeHoursSnapshot:      s.overtimeHoursSnapshot,
          hourlyBaseRateSnapshot:     s.hourlyBaseRateSnapshot,
          overtimeMultiplierSnapshot: s.overtimeMultiplierSnapshot,
          overtimeRateSnapshot:       s.overtimeRateSnapshot,
          overtimePolicyKindSnapshot: s.overtimePolicyKindSnapshot,
          workweekStartDowSnapshot:   s.workweekStartDowSnapshot,
          status: s.exceptions.some((e) => e.severity === "BLOCKER") ? "ERRORED" : "INCLUDED",
        },
      });

      // Payroll 3A hotfix (2026-09-11) — write a projected SALARY
      // earning row for full-period salaried employees. See the top
      // of preparePayrollBatch for the semantic rationale. Guarded
      // by `salaried && isFullPeriod` so we never guess at proration.
      if (s.salaried && s.sourceFacts.coverage.isFullPeriod) {
        const periodSalary = computePeriodSalary(s.sourceFacts, periodsPerYear);
        if (periodSalary) {
          await tx.payrollBatchEarning.create({
            data: {
              clubId,
              batchId: batch.id,
              batchEmployeeId: be.id,
              employeeId: s.employeeId,
              earningType: "SALARY",
              rateSource: "SALARY_PROJECTION",
              quantity: "1",
              rate: periodSalary.toString(),
              description: "Salary (annual / P) — projected at Prepare",
            },
          });
        }
      }

      // Slice F (2026-09-19) — hourly REGULAR + OVERTIME frozen earning
      // rows. Persist per-hour rate + quantity so the earnings
      // calculator's `earningRows` path consumes them directly and the
      // downstream Register / PayStatement / GL Preview render distinct
      // lines. Salaried employees do not enter this branch.
      if (!s.salaried && s.hourlyBaseRateSnapshot != null && s.regularHoursSnapshot != null) {
        const regHours = s.regularHoursSnapshot;
        if (Number(regHours) > 0) {
          await tx.payrollBatchEarning.create({
            data: {
              clubId,
              batchId: batch.id,
              batchEmployeeId: be.id,
              employeeId: s.employeeId,
              earningType: "REGULAR",
              rateSource: "HOURLY_APPROVED_TIME",
              quantity: regHours,
              rate: s.hourlyBaseRateSnapshot,
              description: `Regular (${regHours} hrs × ${s.hourlyBaseRateSnapshot})`,
            },
          });
        }
        const otHours = s.overtimeHoursSnapshot ?? "0";
        if (Number(otHours) > 0 && s.overtimeRateSnapshot != null) {
          await tx.payrollBatchEarning.create({
            data: {
              clubId,
              batchId: batch.id,
              batchEmployeeId: be.id,
              employeeId: s.employeeId,
              earningType: "OVERTIME",
              rateSource: "HOURLY_APPROVED_TIME",
              quantity: otHours,
              rate: s.overtimeRateSnapshot,
              description: `Overtime (${otHours} hrs × ${s.overtimeRateSnapshot} @ ${s.overtimeMultiplierSnapshot}×)`,
            },
          });
        }
      }

      // Allowance snapshots — one row per applicable allowance.
      // Payroll-3B-5B-3A closeout — carry the split classification
      // through. Source EmployeeAllowance.pensionable / .insurable
      // may be null on legacy rows; fall back to `taxable` per the
      // documented legacy-safe rule (schema comment). Explicitly-set
      // false values are preserved.
      for (const al of s.sourceFacts.allowances) {
        const src = await tx.employeeAllowance.findUnique({
          where: { id: al.id },
          select: { pensionable: true, insurable: true },
        });
        const pensionable = src?.pensionable ?? al.taxable;
        const insurable   = src?.insurable   ?? al.taxable;
        await tx.payrollBatchAllowanceSnapshot.create({
          data: {
            clubId,
            batchId: batch.id,
            batchEmployeeId: be.id,
            employeeId: s.employeeId,
            sourceAllowanceId: al.id,
            allowanceType: al.allowanceType,
            amount: al.amount,
            currency: "CAD",
            frequency: al.frequency,
            taxable: al.taxable,
            pensionable,
            insurable,
            sourceEffectiveFrom: new Date(al.effectiveFrom),
            sourceEffectiveTo: al.effectiveTo ? new Date(al.effectiveTo) : null,
          },
        });
      }

      // Time reservation — attach approved-time rows to this batch.
      if (s.approvedTimeEntryIds.length > 0) {
        await tx.payrollApprovedTimeEntry.updateMany({
          where: {
            clubId,
            id: { in: s.approvedTimeEntryIds },
            consumedByBatchId: null,
          },
          data: {
            consumedByBatchId: batch.id,
            consumedByBatchEmployeeId: be.id,
          },
        });
      }

      // Payroll-3C-2 (2026-09-07) — snapshot every active recurring
      // component assignment BEFORE emitting exceptions so any
      // component-side warnings (PERCENT_UNSUPPORTED, mid-period
      // change) join the employee's other exceptions in one place.
      const { snapshotEmployeeComponentsForBatch } = await import("./components-snapshot");
      const snap = await snapshotEmployeeComponentsForBatch({
        clubId,
        batchId: batch.id,
        batchEmployeeId: be.id,
        employeeId: s.employeeId,
        payPeriodId: pre.payPeriodId,
        periodStart: pre.periodStart,
        periodEnd: pre.periodEnd,
      }, tx);
      for (const w of snap.warnings) {
        await tx.payrollBatchException.create({
          data: {
            clubId,
            batchId: batch.id,
            batchEmployeeId: be.id,
            employeeId: s.employeeId,
            severity: "WARNING",
            code: w.code,
            message: `${w.componentCode}: ${w.message}`,
            recommendedAction: null,
          },
        });
        warningCount++;
      }

      // Exceptions.
      for (const e of s.exceptions) {
        await tx.payrollBatchException.create({
          data: {
            clubId,
            batchId: batch.id,
            batchEmployeeId: be.id,
            employeeId: s.employeeId,
            severity: e.severity,
            code: e.code,
            message: e.message,
            recommendedAction: e.recommendedAction ?? null,
          },
        });
        if (e.severity === "BLOCKER") blockerCount++;
        else if (e.severity === "WARNING") warningCount++;
      }
    }

    // Payroll-readiness hotfix (2026-09-14) — surface un-enrolled ACTIVE
    // Employees as batch-level INFO exceptions. No batchEmployee row is
    // created (they weren't populated), so `batchEmployeeId` stays null and
    // `employeeId` links directly. Recommended action tells the operator
    // where to fix it.
    for (const u of unenrolledActive) {
      await tx.payrollBatchException.create({
        data: {
          clubId,
          batchId: batch.id,
          batchEmployeeId: null,
          employeeId: u.id,
          severity: "INFO",
          code: "NOT_ENROLLED_IN_PAY_GROUP",
          message: `${u.firstName} ${u.lastName} (${u.employeeNumber}) is an active employee at this Club but is not enrolled in this pay group for the period, so no earnings were calculated. Enroll them via Payroll Setup → Membership if this pay period should include them.`,
          recommendedAction: "Payroll Setup → Membership",
        },
      });
    }

    return { batch, exceptionSummary: { blockerCount, warningCount, unenrolledCount: unenrolledActive.length } };
  });

  await audit(principal, {
    action: "payroll.batch.prepare",
    entityType: ENTITY,
    entityId: batch.id,
    clubId,
    after: {
      payPeriodId,
      payGroupId: pre.payGroupId,
      sequence: batch.sequence,
      status: batch.status,
      employeeCount: snapshots.length,
      blockerCount: exceptionSummary.blockerCount,
      warningCount: exceptionSummary.warningCount,
    },
  });

  return {
    status: targetStatus === "PREPARED" ? "prepared" : "prepared-with-blockers",
    batchId: batch.id,
    employeeCount: snapshots.length,
    salariedCount: snapshots.filter((s) => s.salaried).length,
    hourlyCount: snapshots.filter((s) => !s.salaried).length,
    approvedTimeEntryCount: snapshots.reduce((a, s) => a + s.approvedTimeEntryIds.length, 0),
    blockerCount: exceptionSummary.blockerCount,
    warningCount: exceptionSummary.warningCount,
  };
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

export interface VoidPayrollBatchResult {
  batchId: string;
  releasedTimeEntryCount: number;
}

/**
 * Void a pre-calculation Payroll Batch, releasing any approved-time
 * reservations. Preserves batch history — the row is transitioned
 * to VOIDED with voidedAt/voidedByUserId/voidReason set. Child
 * rows (employees, allowance snapshots, exceptions) are retained
 * as audit evidence.
 *
 * Refuses if the batch has already been APPROVED or POSTED —
 * calculated payroll can only be corrected via the future
 * payroll-correction workflow, never by simple void.
 */
export async function voidPayrollBatch(
  principal: Principal,
  clubId: string,
  batchId: string,
  reason?: string,
): Promise<VoidPayrollBatchResult> {
  requirePermission(principal, clubId, "payroll:run");
  await assertPostingAllowed(principal, clubId, "payroll.batch.void", ENTITY, batchId);

  const batch = await prisma.payrollBatch.findFirst({ where: { id: batchId, clubId } });
  if (!batch) throw new NotFoundError(ENTITY, batchId);
  if (batch.status === "APPROVED" || batch.status === "POSTED") {
    throw new ValidationError([
      { path: "status", message: `Batch is ${batch.status} — payroll correction is required to change it.` },
    ]);
  }
  if (batch.status === "VOIDED") {
    return { batchId: batch.id, releasedTimeEntryCount: 0 };
  }

  const { released } = await prisma.$transaction(async (tx) => {
    // Release approved-time reservations.
    const rel = await tx.payrollApprovedTimeEntry.updateMany({
      where: { clubId, consumedByBatchId: batch.id },
      data: { consumedByBatchId: null, consumedByBatchEmployeeId: null },
    });
    // Slice B closeout (2026-09-18) — reset any PayrollScheduledOneTimeEarning
    // rows that were APPLIED to THIS batch back to SCHEDULED so a
    // replacement Prepare re-picks them up. Defence in depth: the
    // outer guard already refuses to void APPROVED or POSTED, so a
    // POSTED source cannot reach this reset path. Atomic with the
    // status flip.
    await tx.payrollScheduledOneTimeEarning.updateMany({
      where: { appliedToBatchId: batch.id, status: "APPLIED" },
      data: {
        status: "SCHEDULED",
        appliedAt: null,
        appliedToBatchId: null,
        appliedSnapshotId: null,
      },
    });
    await tx.payrollBatch.update({
      where: { id: batch.id },
      data: {
        status: "VOIDED",
        voidedAt: new Date(),
        voidedByUserId: principal.id,
        voidReason: reason?.trim() || null,
      },
    });
    return { released: rel.count };
  });

  await audit(principal, {
    action: "payroll.batch.void",
    entityType: ENTITY,
    entityId: batch.id,
    clubId,
    before: { status: batch.status },
    after: { status: "VOIDED", releasedTimeEntryCount: released, voidReason: reason?.trim() || null },
  });

  return { batchId: batch.id, releasedTimeEntryCount: released };
}

/**
 * Discard-Prepared-Payroll hotfix (2026-09-14; DRAFT eligibility widened
 * 2026-09-15 per v399 Slice-1 followup #2 §5-10) — Payroll Admin's
 * founder-facing action to abandon an uncalculated batch and return to
 * a state from which Prepare can be run again after source corrections.
 *
 * Founder-facing terminology is "Discard Prepared Payroll". The internal
 * canonical state is VOIDED — one lifecycle sink; no second competing
 * cancellation mechanism. The distinction matters because "Void" implies
 * reversal of processed payroll — this action is exclusive to batches
 * that have NOT been calculated, submitted, approved, posted, or paid.
 *
 * Eligibility (widened 2026-09-15):
 *   * DRAFT     — prepare produced blockers; batch has snapshot rows +
 *                 exception rows but preparedAt is null. Legitimate to
 *                 discard so that fresh Prepare can capture corrected
 *                 canonical facts. This is Chris's exact case after
 *                 completing onboarding — his DRAFT batch was frozen
 *                 from the pre-onboarding facts.
 *   * PREPARED  — prepare produced zero blockers; batch has preparedAt.
 *                 Legitimate to discard so that source corrections
 *                 (compensation, department, banking verification) can
 *                 be re-snapshotted.
 *
 * Refused states:
 *   * CALCULATED, SUBMITTED_FOR_APPROVAL, APPROVED, POSTED — these have
 *     downstream payroll evidence. Use the appropriate lifecycle action
 *     for those states (reject / return, void-with-reason, or a manual
 *     accounting reversal — never this button).
 *
 * Strict guards (§9):
 *   * batch.status in {DRAFT, PREPARED} — hard fail on CALCULATED /
 *     SUBMITTED_FOR_APPROVAL / APPROVED / POSTED with a specific error.
 *   * idempotent on VOIDED — a second call returns success without side
 *     effects (satisfies §18 item 12 double-discard).
 *   * per-batch CAS via `where: { id, status: { in: [...] } }` inside
 *     the update — two concurrent discards land only one flip.
 *
 * Side effects (§10-12):
 *   * releases approved-time reservations (consumedByBatchId → null) so
 *     the replacement Prepare can consume the same entries.
 *   * retains PayrollBatchEmployee / exceptions / snapshots as historical
 *     audit evidence attached to the discarded batch — nothing hard-deleted.
 *   * emits `payroll.batch.discard` audit event distinct from the
 *     general `payroll.batch.void` audit for a clean lifecycle timeline;
 *     the audit `before.status` records whether the batch was DRAFT or
 *     PREPARED at the moment of discard.
 */

// v399 Slice-1 followup #2 (2026-09-15) — batches eligible for
// founder-facing Discard. Both are pre-calculation.
const DISCARD_ELIGIBLE_STATES = ["DRAFT", "PREPARED"] as const;

export async function discardPreparedPayrollBatch(
  principal: Principal,
  clubId: string,
  batchId: string,
  reason?: string,
): Promise<VoidPayrollBatchResult> {
  requirePermission(principal, clubId, "payroll:run");
  await assertPostingAllowed(principal, clubId, "payroll.batch.discard", ENTITY, batchId);

  const batch = await prisma.payrollBatch.findFirst({ where: { id: batchId, clubId } });
  if (!batch) throw new NotFoundError(ENTITY, batchId);

  // Idempotency — a second discard against an already-discarded batch
  // returns success with no side effects. This satisfies §18 item 12
  // ("concurrent double-discard is idempotent/CAS-safe") while still
  // giving the caller a stable response contract.
  if (batch.status === "VOIDED") {
    return { batchId: batch.id, releasedTimeEntryCount: 0 };
  }
  // Founder guard — this action is EXCLUSIVELY for uncalculated batches.
  if (!(DISCARD_ELIGIBLE_STATES as readonly string[]).includes(batch.status)) {
    throw new ValidationError([
      { path: "status",
        message: `Discard Prepared Payroll is only available for DRAFT or PREPARED batches (this batch is ${batch.status}). Use the appropriate lifecycle action for the current state.` },
    ]);
  }

  const priorStatus = batch.status;
  const { released } = await prisma.$transaction(async (tx) => {
    const rel = await tx.payrollApprovedTimeEntry.updateMany({
      where: { clubId, consumedByBatchId: batch.id },
      data: { consumedByBatchId: null, consumedByBatchEmployeeId: null },
    });
    // CAS on the eligible states — two concurrent discards land only once.
    const updated = await tx.payrollBatch.updateMany({
      where: { id: batch.id, status: { in: [...DISCARD_ELIGIBLE_STATES] } },
      data: {
        status: "VOIDED",
        voidedAt: new Date(),
        voidedByUserId: principal.id,
        voidReason: reason?.trim() || null,
      },
    });
    if (updated.count === 0) {
      // Lost the race — another concurrent discard already flipped it.
      // Roll back this transaction's release so the winner's release stands.
      throw new ValidationError([
        { path: "status", message: "Batch was concurrently discarded — no changes applied." },
      ]);
    }
    // Slice B closeout (2026-09-18) — reset APPLIED scheduled one-time
    // earnings for this discarded batch so a replacement Prepare
    // re-picks them up. Only fires when the CAS above actually flipped
    // the batch (updated.count === 1). DISCARD_ELIGIBLE_STATES is
    // DRAFT | PREPARED; APPROVED / POSTED reach this point only via
    // the never-branch, so POSTED scheduled earnings cannot be reset.
    await tx.payrollScheduledOneTimeEarning.updateMany({
      where: { appliedToBatchId: batch.id, status: "APPLIED" },
      data: {
        status: "SCHEDULED",
        appliedAt: null,
        appliedToBatchId: null,
        appliedSnapshotId: null,
      },
    });
    return { released: rel.count };
  });

  await audit(principal, {
    action: "payroll.batch.discard",
    entityType: ENTITY,
    entityId: batch.id,
    clubId,
    before: { status: priorStatus },
    after: {
      status: "VOIDED",
      releasedTimeEntryCount: released,
      voidReason: reason?.trim() || null,
    },
  });

  return { batchId: batch.id, releasedTimeEntryCount: released };
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export async function getPreparedBatch(
  principal: Principal,
  clubId: string,
  batchId: string,
): Promise<PreparedBatchView | null> {
  requirePermission(principal, clubId, "payroll:read");
  const batch = await prisma.payrollBatch.findFirst({
    where: { id: batchId, clubId },
    include: {
      employees: { orderBy: [{ employeeId: "asc" }] },
      exceptions: { orderBy: [{ severity: "asc" }, { code: "asc" }] },
    },
  });
  if (!batch) return null;

  // Enrich exceptions with employee display names — the Payroll Admin
  // needs to know WHOSE record is broken. We do a single scoped
  // lookup rather than an N+1 include on WorkIntakeException.
  const exceptionEmployeeIds = Array.from(new Set(
    batch.exceptions.map((x) => x.employeeId).filter((v): v is string => !!v),
  ));
  const employeeNameById = new Map<string, string>();
  if (exceptionEmployeeIds.length > 0) {
    const rows = await prisma.employee.findMany({
      where: { id: { in: exceptionEmployeeIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    for (const r of rows) {
      employeeNameById.set(r.id, `${r.firstName} ${r.lastName}`.trim());
    }
  }
  return {
    id: batch.id,
    clubId: batch.clubId,
    payGroupId: batch.payGroupId,
    payPeriodId: batch.payPeriodId,
    status: batch.status,
    sequence: batch.sequence,
    sourceSnapshotAt: batch.sourceSnapshotAt,
    preparedAt: batch.preparedAt,
    preparedByUserId: batch.preparedByUserId,
    voidedAt: batch.voidedAt,
    voidedByUserId: batch.voidedByUserId,
    voidReason: batch.voidReason,
    workIntakeItemId: batch.workIntakeItemId,
    employees: batch.employees.map((e) => {
      // Strict Zod parse — the calculator never sees an
      // unvalidated blob. A future evolution to v2 will surface
      // here as an `InvalidSourceFactsError`, forcing a schema
      // migration rather than a silent drift.
      const facts = parseSourceFactsV1(e.sourceFactsJson);
      return {
        id: e.id,
        employeeId: e.employeeId,
        status: e.status,
        salaried: e.salaried,
        employmentStartInPeriod: e.employmentStartInPeriod,
        employmentEndInPeriod: e.employmentEndInPeriod,
        approvedHoursSnapshot: e.approvedHoursSnapshot?.toString() ?? null,
        jurisdictionCountry: e.jurisdictionCountry,
        jurisdictionProvince: e.jurisdictionProvince,
        employeeLifecycleAtPrep: e.employeeLifecycleAtPrep,
        bankingReady: e.bankingReady,
        bankingStatus: e.bankingStatus,
        sinReady: e.sinReady,
        federalTd1Ready: e.federalTd1Ready,
        provincialTd1Ready: e.provincialTd1Ready,
        compensationReady: e.compensationReady,
        membershipEffectiveFrom: e.membershipEffectiveFrom,
        membershipEffectiveTo: e.membershipEffectiveTo,
        coverageStart: e.coverageStart,
        coverageEnd: e.coverageEnd,
        dateOfBirthSnapshot: e.dateOfBirthSnapshot,
        sourceFacts: facts,
      };
    }),
    exceptions: batch.exceptions.map((x) => ({
      id: x.id,
      severity: x.severity as ExceptionSeverity,
      code: x.code,
      message: x.message,
      batchEmployeeId: x.batchEmployeeId,
      employeeId: x.employeeId,
      employeeDisplayName: x.employeeId ? employeeNameById.get(x.employeeId) ?? null : null,
      recommendedAction: x.recommendedAction,
      resolvedAt: x.resolvedAt,
    })),
  };
}

/** Find the active (non-VOIDED) batch for a Period, if any. */
export async function findActiveBatchForPeriod(
  principal: Principal,
  clubId: string,
  payPeriodId: string,
): Promise<{ id: string; status: string } | null> {
  requirePermission(principal, clubId, "payroll:read");
  const b = await prisma.payrollBatch.findFirst({
    where: { clubId, payPeriodId, status: { not: "VOIDED" } },
    orderBy: [{ sequence: "desc" }],
    select: { id: true, status: true },
  });
  return b ?? null;
}

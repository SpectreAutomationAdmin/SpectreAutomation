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

import type { Decimal } from "@prisma/client/runtime/library";
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
    include: { payGroup: { select: { id: true, code: true, name: true, active: true } } },
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
    const approvals = await prisma.payrollDepartmentTimeApproval.findMany({
      where: { clubId, payPeriodId, departmentId: { in: Array.from(departmentIds) }, state: "APPROVED" },
      select: { departmentId: true },
    });
    const approvedIds = new Set(approvals.map((a) => a.departmentId));
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
  exceptions: Array<{ severity: ExceptionSeverity; code: string; message: string; recommendedAction?: string }>;
}

async function snapshotEmployee(
  clubId: string,
  province: string | null,
  periodStart: Date,
  periodEnd: Date,
  member: Awaited<ReturnType<typeof resolvePopulation>>[number],
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

  // Compensation records for the covering assignments intersecting
  // the period. Employees with zero compensation cannot calculate;
  // BLOCKER at prep.
  const compensations = assignments.length
    ? await prisma.employeeCompensation.findMany({
        where: {
          clubId,
          assignmentId: { in: assignments.map((a) => a.id) },
          effectiveFrom: { lt: periodEnd },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: periodStart } }],
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

  // Approved unconsumed time for this employee falling in the period.
  // Payroll-3D-4 — also exclude superseded (stale-freeze) rows so the
  // §32 unconsumed-stale case doesn't leak into batch consumption.
  const approvedTime = await prisma.payrollApprovedTimeEntry.findMany({
    where: {
      clubId,
      employeeId,
      approvalState: "APPROVED",
      consumedByBatchId: null,
      supersededByApprovedTimeEntryId: null,
      workDate: { gte: periodStart, lt: periodEnd },
    },
    select: { id: true, hours: true, workDate: true },
  });
  let approvedHours: Decimal | null = null;
  const approvedTimeEntryIds: string[] = [];
  if (approvedTime.length > 0) {
    approvedTimeEntryIds.push(...approvedTime.map((e) => e.id));
    // Sum via arithmetic (Prisma Decimal — safe to Number for hours).
    let sumCents = 0n;
    for (const e of approvedTime) sumCents += BigInt(Math.round(Number(e.hours.toString()) * 10_000));
    approvedHours = { toString: () => (Number(sumCents) / 10_000).toFixed(4) } as unknown as Decimal;
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

  // Readiness — PayrollProfile activation, TD1 (via EmployeeTaxProfile)
  // and banking. `sinReady` is the payroll-profile activation signal
  // (never touches the actual SIN ciphertext). TD1 readiness comes
  // from the effective EmployeeTaxProfile row, which carries the
  // KMS envelope refs (never displayed).
  const payrollProfile = await prisma.payrollProfile.findUnique({ where: { employeeId } });
  const sinReady = !!payrollProfile && !!payrollProfile.activatedAt && !payrollProfile.suspendedAt;
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
    exceptions.push({
      severity: "WARNING",
      code: "MISSING_SIN",
      message: "Employee has no activated Payroll profile / SIN. Calculation may proceed; T4 issuance requires this.",
      recommendedAction: "Complete the employee's Payroll onboarding to activate the payroll profile.",
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
    snapshots.push(await snapshotEmployee(clubId, province, pre.periodStart, pre.periodEnd, m));
  }

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
          status: s.exceptions.some((e) => e.severity === "BLOCKER") ? "ERRORED" : "INCLUDED",
        },
      });

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

    return { batch, exceptionSummary: { blockerCount, warningCount } };
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

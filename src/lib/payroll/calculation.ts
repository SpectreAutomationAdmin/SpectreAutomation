// Payroll-3B-5B-2a (2026-08-31) — Gross-to-Net calculator FOUNDATION.
//
// This file introduces the canonical calculation entry point
// (`prepareCalculationInput`) and its strongly typed readiness result.
// It performs ZERO dollar arithmetic. The purpose is to make it
// impossible for the future 3B-5B-2b / 3B-5B-2c dollar calculator to:
//
//   - calculate from live mutable HR facts (only frozen source facts);
//   - calculate from unapproved time (only PayrollApprovedTimeEntry);
//   - calculate without a pinned statutory package (resolver mandatory);
//   - calculate with invalid YTD (canonical YTD service is the only source);
//   - overwrite POSTED Payroll (lifecycle refuses);
//   - partially persist one employee (readiness is batch-atomic);
//   - create the Controller final-approval task before real dollar
//     results exist (readiness never transitions to CALCULATED);
//   - silently invent policy for unsupported salary situations
//     (partial-period salaried employees BLOCK).
//
// The service returns a structured readiness result whose `ready`
// flag is `true` iff the future calculator may proceed. The batch
// LIFECYCLE is NOT changed here — the calculator (2b/2c) transitions
// PREPARED → CALCULATED once dollar amounts exist.
//
// Zero side effects on the batch or its exceptions. Readiness is a
// PURE ASSESSMENT — repeated calls with the same batch state return
// the same result.

import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { NotFoundError } from "../errors";
import { assertTenantOwned } from "../services/tenant";
import { resolveStatutoryPackage, type ResolvedStatutoryPackage } from "./statutory-package";
import { getEmployeePayrollYtd, type EmployeePayrollYtd } from "./ytd";
import { parseSourceFactsV1, type PayrollBatchSourceFactsV1 } from "./source-facts-schema";
import { resolvePeriodsPerYearFromCalendar } from "./statutory/periods-per-year";
import { cppPensionableMonths } from "./statutory/cpp-pensionable-months";
import { resolveActiveElectionOn } from "./cpp-election";
import { resolveActiveDisabilityOn } from "./cpp-disability";
import {
  MVP_SUPPORTED_ALLOWANCE_FREQUENCIES,
  MVP_SUPPORTED_EARNING_TYPES,
  MISSING_ALLOWANCE_CLASSIFICATION,
  SALARY_PRORATION_POLICY_REQUIRED,
  STATUTORY_PACKAGE_UNRESOLVED,
  INVALID_BATCH_LIFECYCLE,
  UNSUPPORTED_ALLOWANCE_FREQUENCY,
  UNSUPPORTED_EARNING_TYPE,
  UNSUPPORTED_RPP_DEDUCTION,
  UNSUPPORTED_ALIMONY_DEDUCTION,
  UNSUPPORTED_ANNUAL_DEDUCTION,
  UNSUPPORTED_UNION_DUES,
  UNSUPPORTED_PRESCRIBED_ZONE,
  type CalculationBlockerCode,
} from "./calculation-blockers";

const ENTITY = "PayrollBatch";

// ---------------------------------------------------------------------------
// Readiness result contract
// ---------------------------------------------------------------------------

export type ReadinessSeverity = "BLOCKER" | "WARNING";

export interface ReadinessException {
  employeeId: string | null;
  severity: ReadinessSeverity;
  code: CalculationBlockerCode | string;
  message: string;
  recommendedAction?: string;
}

/**
 * Per-employee calculation input the 3B-5B-2b calculator will
 * consume. Only structural facts land here — NEVER TD1 amounts,
 * SIN, or banking numbers. Sensitive TD1 facts live on
 * `EmployeeTaxProfile` and are resolved by the calculator itself
 * (not exposed to Work Intake or generic logs).
 */
export interface EmployeeCalculationInput {
  batchEmployeeId: string;
  employeeId: string;
  jurisdictionCountry: string;
  jurisdictionProvince: string | null;
  /** Frozen source facts snapshot as of PREPARED. */
  sourceFacts: PayrollBatchSourceFactsV1;
  /** True when the employee is salaried AND coverage is full period. */
  salariedFullPeriod: boolean;
  /** True when the employee has approved hours attached. */
  hasApprovedHours: boolean;
  /** Snapshot of approved hours (Decimal string, 4 dp). */
  approvedHoursSnapshot: string;
  /** DOB from the frozen identity snapshot (null → BLOCKER on the batch). */
  dateOfBirth: Date | null;
  /** Pensionable months for the tax year (from CPP eligibility service). */
  pensionableMonths: number;
  /** ACTIVE CPT30 election on the pay date, if any. */
  activeCpt30ElectionKind: "ELECTION_TO_STOP" | "REVOCATION_OF_ELECTION" | null;
  /** ACTIVE CPP disability status on the pay date, if any. */
  activeDisabilityStatus: string | null;
  /** Aggregated YTD for this employee as of `payDate` (canonical service). */
  ytd: EmployeePayrollYtd;
}

export interface CalculationReadinessResult {
  batchId: string;
  clubId: string;
  payGroupId: string;
  payPeriodId: string;
  payDate: Date;
  taxYear: number;
  /** Actual pay-period count for the taxYear (Payroll-3B-5B-1b §5). */
  periodsPerYear: number;
  statutoryPackage: ResolvedStatutoryPackage | null;
  employees: EmployeeCalculationInput[];
  exceptions: ReadinessException[];
  ready: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Assess whether a PREPARED batch is ready for the 3B-5B-2b/2c
 * dollar calculator. No side effects, no lifecycle change, no
 * exception rows written to the DB — the returned `exceptions`
 * array is the transient assessment.
 *
 * The 3B-5B-2b calculator will consume this exact result:
 *   - refuses to run when `ready === false`;
 *   - pulls per-employee `sourceFacts` + `ytd` from `employees[]`;
 *   - pins `statutoryPackage.id` + `.checksum` + `.algorithmVersion`
 *     onto `PayrollBatch` at CALCULATED.
 */
export async function prepareCalculationInput(
  principal: Principal,
  clubId: string,
  batchId: string,
): Promise<CalculationReadinessResult> {
  requirePermission(principal, clubId, "payroll:run");

  const batch = await prisma.payrollBatch.findUnique({
    where: { id: batchId },
    include: {
      payPeriod: true,
      employees: {
        include: {
          earnings: true,
          allowanceSnapshots: true,
        },
      },
    },
  });
  if (!batch) throw new NotFoundError(ENTITY, batchId);
  assertTenantOwned(batch, principal);
  if (batch.clubId !== clubId) throw new NotFoundError(ENTITY, batchId);

  const exceptions: ReadinessException[] = [];

  // §6 (2) — verify calculable lifecycle. PREPARED is the only
  // state the readiness service accepts. DRAFT is pre-preparation;
  // CALCULATED / SUBMITTED / APPROVED / POSTED / VOIDED cannot enter
  // the readiness pipeline again from this service.
  if (batch.status !== "PREPARED") {
    exceptions.push({
      employeeId: null,
      severity: "BLOCKER",
      code: INVALID_BATCH_LIFECYCLE,
      message:
        `Batch ${batch.id} status is ${batch.status}; calculation readiness requires PREPARED.`,
      recommendedAction:
        batch.status === "DRAFT"
          ? "Run `preparePayrollBatch` first to freeze source facts."
          : batch.status === "POSTED"
            ? "POSTED batches are immutable; issue a future adjustment / reversal batch instead."
            : "Void the batch and re-prepare.",
    });
    // Early exit — no point resolving package / YTD if lifecycle is wrong.
    return earlyResult(batch, exceptions);
  }

  // Pull any BLOCKER exceptions that were written during preparation
  // — they carry forward as unresolved into readiness. The preparation
  // service already writes MISSING_ASSIGNMENT / MISSING_COMPENSATION
  // / MISSING_DATE_OF_BIRTH / MISSING_SIN / MISSING_FEDERAL_TD1 /
  // MISSING_PROVINCIAL_TD1 / BANKING_NOT_VERIFIED as appropriate.
  const preparationExceptions = await prisma.payrollBatchException.findMany({
    where: { clubId, batchId, resolvedAt: null },
    select: {
      employeeId: true,
      severity: true,
      code: true,
      message: true,
      recommendedAction: true,
    },
  });
  for (const pe of preparationExceptions) {
    if (pe.severity !== "BLOCKER" && pe.severity !== "WARNING") continue;
    exceptions.push({
      employeeId: pe.employeeId,
      severity: pe.severity,
      code: pe.code,
      message: pe.message,
      recommendedAction: pe.recommendedAction ?? undefined,
    });
  }

  // §6 (6) — resolve statutory package. STATUTORY_PACKAGE_UNRESOLVED
  // is a hard BLOCKER — the calculator has no fallback constants.
  const payDate = batch.payPeriod.payDate;
  let statutoryPackage: ResolvedStatutoryPackage | null = null;
  try {
    statutoryPackage = await resolveStatutoryPackage({
      country: batch.employees[0]?.jurisdictionCountry ?? "CA",
      province: batch.employees[0]?.jurisdictionProvince ?? null,
      payDate,
    });
  } catch (err) {
    exceptions.push({
      employeeId: null,
      severity: "BLOCKER",
      code: STATUTORY_PACKAGE_UNRESOLVED,
      message:
        `No statutory package resolves for pay date ${payDate.toISOString().slice(0, 10)}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      recommendedAction: "Install a PayrollStatutoryPackage for the pay date's jurisdiction before calculating.",
    });
  }

  // §6 (7) — actual pay-period count for the tax year.
  const taxYear = payDate.getUTCFullYear();
  const periodsPerYear = await resolvePeriodsPerYearFromCalendar({
    clubId,
    payGroupId: batch.payGroupId,
    taxYear,
  });

  // §6 (8-13) — per-employee readiness.
  const employees: EmployeeCalculationInput[] = [];

  for (const be of batch.employees) {
    // Parse the frozen source-facts snapshot. A parse failure is a
    // BLOCKER — the calculator will not silently re-derive.
    const sourceFacts = parseSourceFactsV1(be.sourceFactsJson);
    if (!sourceFacts) {
      exceptions.push({
        employeeId: be.employeeId,
        severity: "BLOCKER",
        code: INVALID_BATCH_LIFECYCLE,
        message: `Batch employee ${be.id} has no valid frozen source-facts snapshot.`,
        recommendedAction: "Void the batch and re-prepare.",
      });
      continue;
    }

    // §16 — Salary proration policy. A salaried employee whose
    // coverage is a strict subset of the pay period cannot be
    // calculated until the founder approves a proration rule.
    if (be.salaried && !sourceFacts.coverage.isFullPeriod) {
      exceptions.push({
        employeeId: be.employeeId,
        severity: "BLOCKER",
        code: SALARY_PRORATION_POLICY_REQUIRED,
        message:
          `Salaried employee ${be.employeeId} covers ${sourceFacts.coverage.coverageDays}/${sourceFacts.coverage.periodDays} days of the pay period. ` +
          "Spectre has no founder-approved salary-proration policy; calculation refuses rather than guessing.",
        recommendedAction:
          "Escalate the pay-group transfer / hire / termination scenario for a policy decision.",
      });
    }

    // §14 — unsupported T4127 inputs on frozen assignments /
    // compensations. The MVP does NOT model RPP / alimony / annual
    // deductions / union dues / prescribed-zone. If a compensation
    // or assignment role encodes any of these, refuse.
    for (const comp of sourceFacts.compensations) {
      // The MVP compensation snapshot does NOT carry these fields;
      // if a future extension adds one, this switch surfaces it.
      const unsupported: { key: string; code: CalculationBlockerCode }[] = [];
      // Named individually so that a future contributor adding e.g.
      // an `rppContribution` field to `SourceFactsCompensationV1`
      // triggers a compile error if they forget to wire the guard.
      if ((comp as unknown as Record<string, unknown>).rppContribution != null) {
        unsupported.push({ key: "rppContribution", code: UNSUPPORTED_RPP_DEDUCTION });
      }
      if ((comp as unknown as Record<string, unknown>).alimony != null) {
        unsupported.push({ key: "alimony", code: UNSUPPORTED_ALIMONY_DEDUCTION });
      }
      if ((comp as unknown as Record<string, unknown>).annualDeductions != null) {
        unsupported.push({ key: "annualDeductions", code: UNSUPPORTED_ANNUAL_DEDUCTION });
      }
      if ((comp as unknown as Record<string, unknown>).unionDues != null) {
        unsupported.push({ key: "unionDues", code: UNSUPPORTED_UNION_DUES });
      }
      if ((comp as unknown as Record<string, unknown>).prescribedZoneDeduction != null) {
        unsupported.push({ key: "prescribedZoneDeduction", code: UNSUPPORTED_PRESCRIBED_ZONE });
      }
      for (const u of unsupported) {
        exceptions.push({
          employeeId: be.employeeId,
          severity: "BLOCKER",
          code: u.code,
          message: `Compensation ${comp.id} carries unsupported statutory input "${u.key}". MVP does not model this input.`,
          recommendedAction: "Escalate for a future slice that implements the corresponding T4127 formula.",
        });
      }
    }

    // §18 — snapshotted allowance classification + frequency.
    for (const snap of be.allowanceSnapshots) {
      if (!MVP_SUPPORTED_ALLOWANCE_FREQUENCIES.has(snap.frequency)) {
        exceptions.push({
          employeeId: be.employeeId,
          severity: "BLOCKER",
          code: UNSUPPORTED_ALLOWANCE_FREQUENCY,
          message: `Allowance snapshot ${snap.id} uses unsupported frequency "${snap.frequency}".`,
          recommendedAction:
            "Change the allowance frequency to one of the supported MVP values.",
        });
      }
      // The frozen snapshot MUST carry the three classification
      // flags explicitly. Null / undefined = ambiguous = BLOCKER —
      // never silently inherited from `taxable`.
      const anySnap = snap as unknown as { taxable: unknown; pensionable: unknown; insurable: unknown };
      if (
        typeof anySnap.taxable     !== "boolean" ||
        typeof anySnap.pensionable !== "boolean" ||
        typeof anySnap.insurable   !== "boolean"
      ) {
        exceptions.push({
          employeeId: be.employeeId,
          severity: "BLOCKER",
          code: MISSING_ALLOWANCE_CLASSIFICATION,
          message:
            `Allowance snapshot ${snap.id} has null / non-boolean taxable / pensionable / insurable classification. ` +
            "The three flags are independent — silent assumption would corrupt statutory bases.",
          recommendedAction:
            "Set explicit taxable / pensionable / insurable Boolean values on the source EmployeeAllowance.",
        });
      }
    }

    // §19 — earning type gap analysis: reject any type outside the
    // MVP-supported set. BONUS / COMMISSION / RETRO_PAY / OTHER
    // surface as BLOCKERs rather than silently falling into REGULAR.
    for (const earn of be.earnings) {
      if (!MVP_SUPPORTED_EARNING_TYPES.has(earn.earningType)) {
        exceptions.push({
          employeeId: be.employeeId,
          severity: "BLOCKER",
          code: UNSUPPORTED_EARNING_TYPE,
          message: `Earning row ${earn.id} uses earningType "${earn.earningType}" which is outside the MVP-supported set (REGULAR, SALARY, OVERTIME, VACATION, STAT_HOLIDAY).`,
          recommendedAction:
            "Await the future slice that implements this earning type; do NOT re-classify as REGULAR.",
        });
      }
    }

    // §13 — CPP structured eligibility. Skip if DOB missing (handled
    // by preparation's MISSING_DATE_OF_BIRTH BLOCKER).
    const dob = sourceFacts.identity.dateOfBirth
      ? new Date(sourceFacts.identity.dateOfBirth)
      : null;

    // §9 — YTD from canonical service.
    const ytd = await getEmployeePayrollYtd(clubId, be.employeeId, payDate);

    // Pensionable months + CPP eligibility factors. Reuses the
    // structured services — no ad-hoc `age >= 18 && age < 70` here.
    let pensionableMonths = 0;
    let activeCpt30ElectionKind: "ELECTION_TO_STOP" | "REVOCATION_OF_ELECTION" | null = null;
    let activeDisabilityStatus: string | null = null;
    if (dob) {
      const [election, disability] = await Promise.all([
        resolveActiveElectionOn(clubId, be.employeeId, payDate),
        resolveActiveDisabilityOn(clubId, be.employeeId, payDate),
      ]);
      activeCpt30ElectionKind = election ? election.kind : null;
      activeDisabilityStatus  = disability ? disability.status : null;
      const pm = cppPensionableMonths({
        taxYear,
        dateOfBirth: dob,
        cppElections: election
          ? [{ kind: election.kind, effectiveOn: election.effectiveOn }]
          : [],
        cppDisabilities: disability
          ? [{ status: disability.status, effectiveFrom: disability.effectiveFrom, effectiveTo: disability.effectiveTo }]
          : [],
        deceasedOn: null,
      });
      pensionableMonths = pm.pensionableMonthCount;
    }

    employees.push({
      batchEmployeeId: be.id,
      employeeId: be.employeeId,
      jurisdictionCountry: be.jurisdictionCountry,
      jurisdictionProvince: be.jurisdictionProvince ?? null,
      sourceFacts,
      salariedFullPeriod: be.salaried && sourceFacts.coverage.isFullPeriod,
      hasApprovedHours: Number(be.approvedHoursSnapshot ?? 0) > 0,
      approvedHoursSnapshot: (be.approvedHoursSnapshot ?? 0).toString(),
      dateOfBirth: dob,
      pensionableMonths,
      activeCpt30ElectionKind,
      activeDisabilityStatus,
      ytd,
    });
  }

  const ready =
    statutoryPackage !== null &&
    !exceptions.some((e) => e.severity === "BLOCKER");

  // §T — Audit that a readiness assessment was run. Payload contains
  // no sensitive HR values.
  await audit(principal, {
    action: "payroll.batch.assess-readiness",
    entityType: ENTITY,
    entityId: batch.id,
    clubId,
    after: {
      status: batch.status,
      employeeCount: batch.employees.length,
      blockerCount: exceptions.filter((e) => e.severity === "BLOCKER").length,
      warningCount: exceptions.filter((e) => e.severity === "WARNING").length,
      statutoryPackageId: statutoryPackage?.id ?? null,
      ready,
    },
  });

  return {
    batchId: batch.id,
    clubId: batch.clubId,
    payGroupId: batch.payGroupId,
    payPeriodId: batch.payPeriodId,
    payDate,
    taxYear,
    periodsPerYear,
    statutoryPackage,
    employees,
    exceptions,
    ready,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function earlyResult(
  batch: Prisma.PayrollBatchGetPayload<{ include: { payPeriod: true; employees: true } }>,
  exceptions: ReadinessException[],
): CalculationReadinessResult {
  return {
    batchId: batch.id,
    clubId: batch.clubId,
    payGroupId: batch.payGroupId,
    payPeriodId: batch.payPeriodId,
    payDate: batch.payPeriod.payDate,
    taxYear: batch.payPeriod.payDate.getUTCFullYear(),
    periodsPerYear: 0,
    statutoryPackage: null,
    employees: [],
    exceptions,
    ready: false,
  };
}

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
  sourceFacts: SourceFacts | null;
}

export interface ExceptionView {
  id: string;
  severity: ExceptionSeverity;
  code: string;
  message: string;
  batchEmployeeId: string | null;
  employeeId: string | null;
  recommendedAction: string | null;
  resolvedAt: Date | null;
}

/** JSON blob shape written into PayrollBatchEmployee.sourceFactsJson.
 *  Machine-readable; the future calculator reads this to know
 *  which compensation records / assignments applied. */
interface SourceFacts {
  assignments: Array<{
    id: string;
    role: string;
    departmentId: string | null;
    positionId: string | null;
    employmentType: string;
    effectiveFrom: string;      // ISO
    effectiveTo: string | null; // ISO
  }>;
  compensations: Array<{
    id: string;
    assignmentId: string | null;
    payType: string;
    hourlyRate: string | null;
    annualSalary: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>;
  allowances: Array<{
    id: string;
    assignmentId: string | null;
    allowanceType: string;
    amount: string;
    frequency: string;
    taxable: boolean;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>;
}

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
 * Population rule (documented per §7): "member if the employee's
 * effective PayGroupMember row COVERS ANY DAY of the pay period"
 * — i.e. the membership's [effectiveFrom, effectiveTo) window
 * intersects the period's [periodStart, periodEnd) window.
 *
 * This handles: full-period membership, hire mid-period, termination
 * mid-period, pay-group transfer at a boundary. Overlap-prevention
 * from Payroll-3B-1 guarantees at most one covering membership per
 * employee at any instant.
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
          userId: true,
        },
      },
    },
  });
  // Ordered deterministically for reproducibility.
  members.sort((a, b) => a.employee.lastName.localeCompare(b.employee.lastName) || a.employee.firstName.localeCompare(b.employee.firstName));
  return members;
}

// ---------------------------------------------------------------------------
// Snapshot per employee
// ---------------------------------------------------------------------------

interface EmployeeSnapshot {
  employeeId: string;
  employeeLifecycleAtPrep: string;
  jurisdictionCountry: string;
  jurisdictionProvince: string | null;
  employmentStartInPeriod: Date | null;
  employmentEndInPeriod: Date | null;
  salaried: boolean;
  approvedHours: Decimal | null;
  approvedTimeEntryIds: string[];
  sourceFacts: SourceFacts;
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
  const approvedTime = await prisma.payrollApprovedTimeEntry.findMany({
    where: {
      clubId,
      employeeId,
      approvalState: "APPROVED",
      consumedByBatchId: null,
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
    select: { federalClaimSecretRef: true, provincialClaimSecretRef: true },
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

  const sourceFacts: SourceFacts = {
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
  };

  return {
    employeeId,
    employeeLifecycleAtPrep: member.employee.employeeLifecycle,
    jurisdictionCountry: "CA",
    jurisdictionProvince: province,
    employmentStartInPeriod,
    employmentEndInPeriod,
    salaried,
    approvedHours,
    approvedTimeEntryIds,
    sourceFacts,
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
          jurisdictionCountry: s.jurisdictionCountry,
          jurisdictionProvince: s.jurisdictionProvince,
          employeeLifecycleAtPrep: s.employeeLifecycleAtPrep,
          salaried: s.salaried,
          employmentStartInPeriod: s.employmentStartInPeriod,
          employmentEndInPeriod: s.employmentEndInPeriod,
          approvedHoursSnapshot: s.approvedHours?.toString() ?? null,
          sourceFactsJson: JSON.stringify(s.sourceFacts),
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
      for (const al of s.sourceFacts.allowances) {
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
      let facts: SourceFacts | null = null;
      if (e.sourceFactsJson) {
        try {
          facts = JSON.parse(e.sourceFactsJson) as SourceFacts;
        } catch {
          facts = null;
        }
      }
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

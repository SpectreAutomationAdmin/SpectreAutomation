// Payroll-3D-4 (2026-09-05) — Approved-timesheet → PayrollApprovedTimeEntry
// freeze service.
//
// This is the controlled bridge from the 3D-3 manager-approved
// timesheet layer to the frozen payroll input layer that
// batch-preparation.ts already reads. The invariants:
//
//   1. Freeze re-reads readiness AND revision at commit time.
//   2. Blocking timesheet exceptions or pending corrections → refuse.
//   3. Revision drift → refuse and invalidate the approval.
//   4. Every frozen row carries relational provenance to the source
//      PayrollTimesheetEntry (unique) AND the authorising
//      PayrollDepartmentTimeApproval + its revision.
//   5. Idempotent: the DB unique on payrollTimesheetEntryId collapses
//      concurrent freezes to a single canonical row.
//   6. Atomic: the entire scope freezes or none do.
//   7. Late (past cutoff) approvals still freeze the rows, but ALSO
//      create a PayrollTimeAdjustment(status=OPEN, reason=LATE_APPROVAL)
//      so Payroll Admin explicitly reviews before payroll consumption.
//   8. Salary-only pay periods produce zero frozen rows and are NOT
//      blocked from batch preparation.
//
// This module never mutates:
//   - the source PayrollTimesheetEntry;
//   - the source TimeClockEvent(s);
//   - any consumed PayrollApprovedTimeEntry (consumedByBatchId != null).

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { getScopeReview, computeScopeRevision } from "../timesheets/approval-scope";
import { invalidateApprovalIfDrifted } from "../timesheets/manager-approval";
import { computeCutoffInstant, classifyCutoffTiming } from "./cutoff";

const ENTITY = "PayrollApprovedTimeEntry";

export interface FreezeScopeInput {
  clubId:       string;
  payPeriodId:  string;
  departmentId: string;
}

export interface FreezeScopeResult {
  clubId:              string;
  payPeriodId:         string;
  departmentId:        string;
  approvalId:          string;
  approvedRevision:    string;
  frozenRevision:      string;
  frozenAt:            Date;
  frozenByUserId:      string;
  entriesCreated:      number;
  entriesAlreadyFrozen: number;
  timing:              "ON_TIME" | "LATE";
  lateAdjustmentId:    string | null;
}

/** Freeze a single (payPeriod × department) approved scope into
 *  PayrollApprovedTimeEntry rows. Only rows that don't already have
 *  a frozenAs mapping are created; existing frozen rows are left
 *  untouched (idempotent). */
export async function freezeApprovedScopeIntoPayroll(
  principal: Principal, input: FreezeScopeInput,
): Promise<FreezeScopeResult> {
  requirePermission(principal, input.clubId, "payroll:write");
  await assertPostingAllowed(
    principal, input.clubId, "payroll.approved-time.freeze",
    ENTITY, `${input.payPeriodId}:${input.departmentId}`,
  );

  // Load approval + period + club-tz + cutoff-lead in one round trip.
  const [approval, period, clubConfig, club] = await Promise.all([
    prisma.payrollDepartmentTimeApproval.findUnique({
      where: {
        clubId_payPeriodId_departmentId: {
          clubId: input.clubId, payPeriodId: input.payPeriodId, departmentId: input.departmentId,
        },
      },
    }),
    prisma.payrollPayPeriod.findFirst({
      where: { id: input.payPeriodId, clubId: input.clubId },
    }),
    prisma.payrollClubConfig.findUnique({ where: { clubId: input.clubId } }),
    prisma.club.findUnique({ where: { id: input.clubId }, select: { timezone: true } }),
  ]);
  if (!period) throw new NotFoundError("PayrollPayPeriod", input.payPeriodId);
  if (!approval || approval.state !== "APPROVED") {
    throw new ValidationError([{
      path: "approval",
      message: "Scope has no valid APPROVED manager approval. Wait for the department manager to approve, then re-run freeze.",
    }]);
  }

  // Re-check readiness AND revision at commit time.
  const review = await getScopeReview(input.clubId, input.payPeriodId, input.departmentId);
  if (!review.readiness.ready) {
    throw new ValidationError([{
      path: "readiness",
      message: "Scope has blocking issues. Resolve before freeze.",
    }]);
  }
  if (approval.approvedRevision !== review.currentRevision) {
    // §5 — treat as stale, invalidate, refuse.
    await invalidateApprovalIfDrifted(input.clubId, input.payPeriodId, input.departmentId);
    throw new ConflictError(
      "The manager-approved revision has drifted since approval. Ask the manager to re-attest.",
    );
  }

  // Compute cutoff timing.
  const leadDays = clubConfig?.payrollCutoffLeadDays ?? 5;
  const cutoffInstant = computeCutoffInstant(period.payDate, club?.timezone ?? null, leadDays);
  const timing = classifyCutoffTiming(approval.approvedAt, cutoffInstant);

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    // Fetch in-scope entries (assignment.departmentId == this dept).
    const entryRows = await tx.payrollTimesheetEntry.findMany({
      where: {
        clubId: input.clubId, timesheet: { payPeriodId: input.payPeriodId },
        employmentAssignment: { departmentId: input.departmentId },
      },
      orderBy: [{ employeeId: "asc" }, { clockInAt: "asc" }],
      select: {
        id: true, employeeId: true, employmentAssignmentId: true,
        workDate: true, recordedSeconds: true, earningClassification: true,
      },
    });

    // Existing frozen rows for these entries (idempotency).
    const existing = entryRows.length ? await tx.payrollApprovedTimeEntry.findMany({
      where: { payrollTimesheetEntryId: { in: entryRows.map((e) => e.id) } },
      select: { id: true, payrollTimesheetEntryId: true },
    }) : [];
    const frozenBySource = new Map(existing.map((e) => [e.payrollTimesheetEntryId!, e.id]));
    let created = 0;
    let alreadyFrozen = 0;
    for (const e of entryRows) {
      if (frozenBySource.has(e.id)) { alreadyFrozen += 1; continue; }
      const hoursDecimal = new Prisma.Decimal(e.recordedSeconds).div(3600);
      try {
        await tx.payrollApprovedTimeEntry.create({
          data: {
            clubId: input.clubId,
            employeeId: e.employeeId,
            employmentAssignmentId: e.employmentAssignmentId,
            workDate: e.workDate,
            hours: hoursDecimal,
            earningClassification: e.earningClassification,
            approvalState: "APPROVED",
            approvedAt: approval.approvedAt,
            approvedByUserId: approval.approvedByUserId,
            payrollTimesheetEntryId: e.id,
            sourceApprovalId: approval.id,
            sourceApprovalRevision: approval.approvedRevision,
          },
        });
        created += 1;
      } catch (err) {
        // Concurrent freeze already created the row.
        if (isP2002(err)) { alreadyFrozen += 1; continue; }
        throw err;
      }
    }

    // If late: create a single scope-level PayrollTimeAdjustment
    // (OPEN) so Payroll Admin sees the exception and can INCLUDE_CURRENT
    // (no-op — rows already exist) or DEFER_NEXT (unfreezes them).
    let lateAdjustmentId: string | null = null;
    if (timing === "LATE" && created > 0) {
      const totalHours = entryRows.reduce(
        (acc, e) => acc.plus(new Prisma.Decimal(e.recordedSeconds).div(3600)),
        new Prisma.Decimal(0),
      );
      // Idempotency: don't create a second LATE_APPROVAL if one is OPEN
      // for the same (payPeriod, scope, source approval).
      const existingAdj = await tx.payrollTimeAdjustment.findFirst({
        where: {
          clubId: input.clubId,
          payPeriodId: input.payPeriodId,
          reason: "LATE_APPROVAL",
          notes: { contains: `approval:${approval.id}` },
        },
        select: { id: true },
      });
      if (existingAdj) {
        lateAdjustmentId = existingAdj.id;
      } else {
        const first = entryRows[0];
        const adj = await tx.payrollTimeAdjustment.create({
          data: {
            clubId: input.clubId,
            employeeId: first?.employeeId ?? approval.approvedByUserId,
            payPeriodId: input.payPeriodId,
            reason: "LATE_APPROVAL",
            differenceHours: totalHours,
            status: "OPEN",
            createdByUserId: principal.id,
            notes: `approval:${approval.id} scope:${input.departmentId} frozenAt=${now.toISOString()}`,
          },
        });
        lateAdjustmentId = adj.id;
      }
    }

    return { created, alreadyFrozen, lateAdjustmentId };
  }, { timeout: 20_000, maxWait: 5_000 });

  await audit(principal, {
    clubId: input.clubId,
    action: "payroll.approved-time.freeze",
    entityType: ENTITY,
    entityId: approval.id,
    after: {
      payPeriodId: input.payPeriodId,
      departmentId: input.departmentId,
      approvedRevision: approval.approvedRevision,
      created: result.created,
      alreadyFrozen: result.alreadyFrozen,
      timing,
      lateAdjustmentId: result.lateAdjustmentId,
    },
  });

  return {
    clubId:               input.clubId,
    payPeriodId:          input.payPeriodId,
    departmentId:         input.departmentId,
    approvalId:           approval.id,
    approvedRevision:     approval.approvedRevision!,
    frozenRevision:       review.currentRevision,
    frozenAt:             now,
    frozenByUserId:       principal.id,
    entriesCreated:       result.created,
    entriesAlreadyFrozen: result.alreadyFrozen,
    timing,
    lateAdjustmentId:     result.lateAdjustmentId,
  };
}

// -------------------------------------------------------------------
// Pay-period time-readiness aggregate (§38, §39)
// -------------------------------------------------------------------
export interface ScopeReadinessRow {
  clubId:            string;
  payPeriodId:       string;
  departmentId:      string;
  departmentCode:    string;
  departmentName:    string;
  employeeCount:     number;
  entryCount:        number;
  recordedSeconds:   number;
  approvalState:     "PENDING" | "APPROVED" | "REVIEW_REQUIRED";
  approvalIsCurrent: boolean;
  entriesFrozen:     number;
  entriesFrozenAndCurrent: number;
  entriesNotYetFrozen: number;
  openLateAdjustments: number;
  overallState: "AWAITING_APPROVAL" | "APPROVAL_STALE" | "APPROVED_NOT_FROZEN"
              | "FROZEN_READY" | "FROZEN_LATE_REVIEW";
}

export interface PayPeriodTimeReadiness {
  clubId:       string;
  payPeriodId:  string;
  scopes:       ScopeReadinessRow[];
  overallReady: boolean;
  hasOpenLateAdjustments: boolean;
  hasStaleApprovals: boolean;
  hasUnapprovedScopes: boolean;
}

export async function getPayPeriodTimeReadiness(
  principal: Principal, clubId: string, payPeriodId: string,
): Promise<PayPeriodTimeReadiness> {
  requirePermission(principal, clubId, "payroll:timesheets:read");
  const period = await prisma.payrollPayPeriod.findFirst({
    where: { id: payPeriodId, clubId },
    select: { id: true },
  });
  if (!period) throw new NotFoundError("PayrollPayPeriod", payPeriodId);

  // Enumerate scopes with recorded time (from 3D-3 approval-scope).
  const { listReviewableScopes } = await import("../timesheets/approval-scope");
  const scopes = await listReviewableScopes(clubId, payPeriodId);
  if (scopes.length === 0) {
    return {
      clubId, payPeriodId, scopes: [],
      overallReady: true, // salary-only period is trivially "ready" for time
      hasOpenLateAdjustments: false,
      hasStaleApprovals: false,
      hasUnapprovedScopes: false,
    };
  }

  const approvals = await prisma.payrollDepartmentTimeApproval.findMany({
    where: { clubId, payPeriodId },
  });
  const approvalByDept = new Map(approvals.map((a) => [a.departmentId, a]));

  const rows: ScopeReadinessRow[] = [];
  let hasOpenLate = false;
  let hasStale = false;
  let hasUnapproved = false;
  for (const s of scopes) {
    const approval = approvalByDept.get(s.departmentId);
    const currentRevision = s.currentRevision;
    const approvalState =
      !approval ? "PENDING" as const
      : approval.state === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" as const
      : approval.state === "APPROVED" ? "APPROVED" as const
      : "PENDING" as const;
    const approvalIsCurrent = approval?.state === "APPROVED"
      && approval.approvedRevision === currentRevision;

    // Count frozen entries in scope + how many still map to current
    // timesheet entries (i.e. not superseded/stale).
    const frozen = await prisma.payrollApprovedTimeEntry.findMany({
      where: {
        clubId,
        sourceApprovalId: approval?.id,
      },
      select: {
        id: true, approvalState: true,
        supersededByApprovedTimeEntryId: true,
      },
    });
    const entriesFrozen = frozen.length;
    const entriesFrozenAndCurrent = frozen.filter((f) =>
      f.approvalState === "APPROVED" && !f.supersededByApprovedTimeEntryId,
    ).length;

    // Count late-adjustment openness.
    const openLate = await prisma.payrollTimeAdjustment.count({
      where: {
        clubId, payPeriodId,
        status: "OPEN",
        notes: { contains: `scope:${s.departmentId}` },
      },
    });
    if (openLate > 0) hasOpenLate = true;

    if (approvalState !== "APPROVED") hasUnapproved = true;
    if (approvalState === "APPROVED" && !approvalIsCurrent) hasStale = true;
    if (approvalState === "REVIEW_REQUIRED") hasStale = true;

    let overallState: ScopeReadinessRow["overallState"];
    if (approvalState !== "APPROVED") overallState = "AWAITING_APPROVAL";
    else if (!approvalIsCurrent) overallState = "APPROVAL_STALE";
    else if (entriesFrozenAndCurrent < s.entryCount) overallState = "APPROVED_NOT_FROZEN";
    else if (openLate > 0) overallState = "FROZEN_LATE_REVIEW";
    else overallState = "FROZEN_READY";

    rows.push({
      clubId, payPeriodId,
      departmentId: s.departmentId,
      departmentCode: s.departmentCode,
      departmentName: s.departmentName,
      employeeCount: s.employeeCount,
      entryCount: s.entryCount,
      recordedSeconds: s.recordedSeconds,
      approvalState, approvalIsCurrent,
      entriesFrozen, entriesFrozenAndCurrent,
      entriesNotYetFrozen: Math.max(0, s.entryCount - entriesFrozenAndCurrent),
      openLateAdjustments: openLate,
      overallState,
    });
  }
  return {
    clubId, payPeriodId,
    scopes: rows,
    overallReady: !hasUnapproved && !hasStale && !hasOpenLate
      && rows.every((r) => r.overallState === "FROZEN_READY"),
    hasOpenLateAdjustments: hasOpenLate,
    hasStaleApprovals: hasStale,
    hasUnapprovedScopes: hasUnapproved,
  };
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------
function isP2002(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { code?: string }).code === "P2002";
}

/** Test-only clock hook (currently unused; freeze uses `new Date()`). */
export const _internals = { computeScopeRevision };

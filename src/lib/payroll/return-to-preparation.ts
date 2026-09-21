// FPP-5C (2026-09-21) — Return to Preparation semantic correction.
//
// PRIOR SEMANTIC (Payroll-3D Option A): transitions CALCULATED → PREPARED
// in place, preserving frozen snapshots. If a subsequent Calculate ran
// against the SAME frozen snapshots the outputs would be identical —
// live config changes did NOT flow into the next calculation. To pick
// up live changes the operator additionally had to click Discard →
// Prepare. Three actions to express what founders considered ONE
// action.
//
// CORRECTED SEMANTIC: Return to Preparation now means "withdraw this
// calculated payroll and require a fresh Prepare against the current
// live configuration." Implementation:
//   * Batch status → VOIDED (same terminal-audit path as Discard).
//   * `calculatedAt`, `calculationVersion`, calculated columns and
//     every componentSnapshot / sourceFactsJson row are LEFT UNCHANGED
//     — the VOIDED batch remains fully auditable as the historical
//     record of calculation version 1.
//   * Approved time entries + APPLIED one-time earnings are released
//     the same way `discardPreparedPayrollBatch` releases them, so
//     the next Prepare can consume them.
//   * `preparePayrollBatch` filters out VOIDED batches when it
//     searches for an existing (Club, PayGroup, PayPeriod) → the next
//     Prepare freely creates a NEW batch at sequence + 1, freezing the
//     current live catalogue (statutory flags, RRSP tax treatment,
//     component setup, TD1, compensation, membership).
//   * The workspace `hasBatch` derives from non-VOIDED batches only,
//     so the header's "Prepare Payroll" button becomes primary
//     immediately.
//
// Historical calculation auditability: the VOIDED batch persists in
// full — status, calculatedAt, calculationVersion, algorithmVersion,
// packageChecksum, every batchEmployee's gross/net/deduction columns,
// every componentSnapshot's frozen amount and statutory flag. Nothing
// is deleted. Later slices can expose "Prior calculations" surfaces
// against VOIDED batches for the same (payGroup, payPeriod).
//
// Callers must update expectations: the returned `nextStatus` is now
// `"VOIDED"`, not `"PREPARED"`. A subsequent Prepare on the same period
// creates a fresh batch — it is not the same batch returned to a
// new lifecycle state.
//
// FROZEN-BATCH CONTRACT (Payroll 3D acceptance hotfix, 2026-09-12 §10-14):
//
// This service is Option A. It does NOT re-run `preparePayrollBatch`.
// The batch's frozen inputs — `PayrollBatchEmployee.sourceFactsJson`,
// the projected `PayrollBatchEarning` rows, `PayrollBatchComponentSnapshot`
// recurring rows, `PayrollBatchAllowanceSnapshot` rows — remain
// exactly as they were at Prepare time. When Calculate re-runs, it
// re-reads those frozen rows and produces the same output UNLESS a
// batch-local dataset (adjustments, review attestations, calculator
// parameters) has changed.
//
// USE CASES SUPPORTED:
//   • Add / remove a one-time adjustment on this batch.
//   • Mark a review dimension reviewed and recalculate.
//   • Rerun after correcting a calculator-parameter defect.
//
// USE CASES NOT SUPPORTED — the operator MUST void and re-prepare:
//   • Correcting an employee's compensation (annual salary, hourly
//     rate) in HR.
//   • Correcting an employee's TD1 / tax profile.
//   • Correcting an employment assignment or department.
//   • Approving additional source time or changing frozen hours.
//   • Rebuilding recurring-component setup for the batch.
//
// `preparePayrollBatch` is idempotent on non-VOIDED batches and
// returns the existing row (see batch-preparation.ts:700-730 —
// "The founder-mandated policy is that source changes DO NOT
// auto-refresh"). To pull in HR changes the operator must
// `voidPayrollBatch` and re-Prepare, which resnapshots.
//
// Contract details (§25):
//   • Requires `payroll:edit`.
//   • Refuses when batch is not CALCULATED (a batch already returned to
//     PREPARED, or any post-CALCULATED lifecycle: SUBMITTED_FOR_APPROVAL,
//     APPROVED, POSTED, VOIDED — none are reopened here).
//   • Preserves employee result columns (grossPay, netPay, deductions,
//     employer contributions) so the next `calculatePayrollBatch` can
//     overwrite them atomically. The UI hides them once status = PREPARED
//     (KPI `grossPaySemantics` reverts to PREPARED_ESTIMATE via
//     overview-view.ts's status-based branching).
//   • Preserves `calculationVersion` — the next Calculate bumps it, giving
//     a monotonically-increasing history without version reuse.
//   • Sets `calculatedAt = null` — the CALCULATED_PAYROLL fingerprint is
//     defined as sha256("CALCULATED_PAYROLL:empty") when
//     `calculatedAt IS NULL`, so any prior CALCULATED_PAYROLL attestation
//     is automatically stale on the next fingerprint compare. The
//     attestation is ALSO explicitly invalidated in the same
//     transaction so the historical trail carries the reason.
//   • Audits `payroll.batch.return-to-preparation` with actor + reason.
//
// Does NOT invalidate ONE_TIME_ADJUSTMENTS / RECURRING_COMPONENTS /
// EMPLOYEE_DATA attestations — the underlying data has not changed and
// those attestations remain accurate. Any subsequent write to those
// dimensions performs its own atomic invalidation as it did in 3C.

"use server";

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { audit } from "../audit";
import { ValidationError, NotFoundError } from "../errors";
import { invalidateAttestationForBatchDimension } from "./batch-review";

const ENTITY = "PayrollBatch";

export interface ReturnToPreparationResult {
  batchId: string;
  priorStatus: "CALCULATED" | "RETURNED_FOR_CORRECTION";
  /** FPP-5C — the returned batch is voided; a fresh Prepare must
   *  create a NEW batch for the same (Club, PayGroup, PayPeriod). */
  nextStatus: "VOIDED";
  /** Preserved from the voided batch for downstream audit surfaces. */
  calculationVersion: number;
  /** Attestations invalidated for this batch by the void. */
  invalidatedAttestationCount: number;
  /** PayrollApprovedTimeEntry rows released back to the pool so the
   *  next Prepare can consume them. */
  releasedTimeEntryCount: number;
}

export async function returnBatchToPreparation(
  principal: Principal,
  clubId: string,
  batchId: string,
  reason: string,
): Promise<ReturnToPreparationResult> {
  requirePermission(principal, clubId, "payroll:edit");
  await assertPostingAllowed(principal, clubId, "payroll.batch.return-to-preparation", ENTITY, batchId);

  const batch = await prisma.payrollBatch.findFirst({
    where: { id: batchId, clubId },
    select: { id: true, status: true, calculationVersion: true },
  });
  if (!batch) throw new NotFoundError(ENTITY, batchId);
  // Accepts CALCULATED (Payroll Admin self-service after Calculate) and
  // RETURNED_FOR_CORRECTION (Payroll Admin reopening a Controller-returned
  // batch). Refuses SUBMITTED_FOR_APPROVAL — the Controller must Return
  // first. Refuses APPROVED / POSTED / VOIDED / DRAFT / PREPARED —
  // wrong lifecycle stage (PREPARED users click Discard for a similar
  // outcome; DRAFT preparation had blockers and is discarded, not
  // returned).
  if (batch.status !== "CALCULATED" && batch.status !== "RETURNED_FOR_CORRECTION") {
    throw new ValidationError([{
      path: "status",
      message: `Batch is ${batch.status}; Return to Preparation accepts only CALCULATED or RETURNED_FOR_CORRECTION batches.`,
    }]);
  }
  const trimmed = (reason ?? "").trim();
  if (!trimmed) {
    throw new ValidationError([{ path: "reason", message: "Reason is required." }]);
  }

  const now = new Date();
  const { invalidated, released } = await prisma.$transaction(async (tx) => {
    // Release approved time entries the batch was holding so the next
    // Prepare can consume them.
    const rel = await tx.payrollApprovedTimeEntry.updateMany({
      where: { clubId, consumedByBatchId: batch.id },
      data: { consumedByBatchId: null, consumedByBatchEmployeeId: null },
    });
    // Reset APPLIED one-time earnings so a fresh Prepare re-picks them up.
    await tx.payrollScheduledOneTimeEarning.updateMany({
      where: { appliedToBatchId: batch.id, status: "APPLIED" },
      data: {
        status: "SCHEDULED",
        appliedAt: null,
        appliedToBatchId: null,
        appliedSnapshotId: null,
      },
    });
    // Void the batch. calculatedAt / calculationVersion / calculated
    // columns / componentSnapshots / sourceFactsJson are LEFT
    // UNCHANGED — the VOIDED row remains the historical audit record.
    await tx.payrollBatch.update({
      where: { id: batchId },
      data: {
        status: "VOIDED",
        voidedAt: now,
        voidedByUserId: principal.id,
        voidReason: trimmed,
      },
    });
    // Invalidate the CALCULATED_PAYROLL attestation so an operator
    // reading the void row later sees the reason recorded on the
    // attestation trail as well as the audit event.
    const count = await invalidateAttestationForBatchDimension(
      tx, clubId, batchId, "CALCULATED_PAYROLL", "payroll.batch.return-to-preparation",
    );
    return { invalidated: count, released: rel.count };
  });

  await audit(principal, {
    action: "payroll.batch.return-to-preparation",
    entityType: ENTITY, entityId: batchId, clubId,
    before: { status: batch.status, calculationVersion: batch.calculationVersion },
    after: {
      priorStatus: batch.status,
      nextStatus: "VOIDED",
      calculationVersion: batch.calculationVersion, // preserved on the voided row
      reason: trimmed,
      voidedAt: now.toISOString(),
      releasedTimeEntryCount: released,
    },
  });

  return {
    batchId,
    priorStatus: batch.status as "CALCULATED" | "RETURNED_FOR_CORRECTION",
    nextStatus: "VOIDED",
    calculationVersion: batch.calculationVersion,
    invalidatedAttestationCount: invalidated,
    releasedTimeEntryCount: released,
  };
}

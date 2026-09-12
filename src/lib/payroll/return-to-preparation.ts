// Payroll Admin Slice 3D (2026-09-12) — Return to Preparation.
//
// Safely transitions CALCULATED → PREPARED so a Payroll Admin can
// correct a BATCH-LOCAL input that was discovered post-Calculate
// (§24-25). This is the ONLY sanctioned path for editing a CALCULATED
// batch — silent-edit of a calculated payroll is forbidden.
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
  nextStatus:  "PREPARED";
  calculationVersion: number;
  invalidatedAttestationCount: number;
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
  // Payroll 3E (2026-09-12): accepts CALCULATED (Payroll Admin
  // self-service, from 3D) and RETURNED_FOR_CORRECTION (Payroll Admin
  // reopening a Controller-returned batch for a batch-local edit).
  // Refuses SUBMITTED_FOR_APPROVAL — the Controller must Return first.
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
  const invalidated = await prisma.$transaction(async (tx) => {
    await tx.payrollBatch.update({
      where: { id: batchId },
      data: { status: "PREPARED", calculatedAt: null },
    });
    const count = await invalidateAttestationForBatchDimension(
      tx, clubId, batchId, "CALCULATED_PAYROLL", "payroll.batch.return-to-preparation",
    );
    return count;
  });

  await audit(principal, {
    action: "payroll.batch.return-to-preparation",
    entityType: ENTITY, entityId: batchId, clubId,
    after: {
      priorStatus: batch.status,
      nextStatus: "PREPARED",
      calculationVersion: batch.calculationVersion,
      reason: trimmed,
      invalidatedAt: now.toISOString(),
    },
  });

  return {
    batchId,
    priorStatus: batch.status as "CALCULATED" | "RETURNED_FOR_CORRECTION",
    nextStatus: "PREPARED",
    calculationVersion: batch.calculationVersion,
    invalidatedAttestationCount: invalidated,
  };
}

// Payroll Admin Slice 3D (2026-09-12) — Return to Preparation.
//
// Safely transitions CALCULATED → PREPARED so a Payroll Admin can
// correct an input that was discovered post-Calculate (§24-25). This
// is the ONLY sanctioned path for editing a CALCULATED batch —
// silent-edit of a calculated payroll is forbidden.
//
// Contract (§25):
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
  priorStatus: "CALCULATED";
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
  if (batch.status !== "CALCULATED") {
    throw new ValidationError([{
      path: "status",
      message: `Batch is ${batch.status}; only CALCULATED batches can be returned to Preparation.`,
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
      priorStatus: "CALCULATED",
      nextStatus: "PREPARED",
      calculationVersion: batch.calculationVersion,
      reason: trimmed,
      invalidatedAt: now.toISOString(),
    },
  });

  return {
    batchId,
    priorStatus: "CALCULATED",
    nextStatus: "PREPARED",
    calculationVersion: batch.calculationVersion,
    invalidatedAttestationCount: invalidated,
  };
}

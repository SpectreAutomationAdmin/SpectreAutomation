// Payroll Admin Slice 3E (2026-09-12) — Return for Correction.
//
// Controller-driven inverse of Submit. Sends a SUBMITTED_FOR_APPROVAL
// batch back to the Payroll Admin so a batch-local correction (add
// or remove a one-time adjustment, re-review, recalculate) can be
// applied without approving.
//
// Contract (§16-19, §26-28 of the 3E directive):
//   • Permission: `payroll:return`.
//   • Prerequisites: batch.status === "SUBMITTED_FOR_APPROVAL".
//   • Non-empty return reason required (rejects whitespace-only).
//   • CAS transition on (id, clubId, status="SUBMITTED_FOR_APPROVAL",
//     calculationVersion=expectedVersion, submittedAt=expectedSubmitted).
//     Approve-vs-Return race: exactly one wins.
//   • Persists status="RETURNED_FOR_CORRECTION" (new value in the
//     free-form String enum — no Prisma migration required).
//     Clears submittedAt/submittedByUserId so the next Submit starts
//     fresh. Preserves calculationVersion (no recalculation happened).
//   • Resolves the Controller PAYROLL_FINAL_APPROVAL card with a
//     "returned for correction" activity note (reason preserved in
//     WorkIntakeActivity — no schema-column dependence).
//   • Materialises a PAYROLL_RETURNED_FOR_CORRECTION card owned by the
//     Payroll Admin so the correction is on their inbox.
//   • Invalidates the CALCULATED_PAYROLL attestation so the Payroll
//     Admin cannot silently re-submit without re-reviewing.
//   • Audits `payroll.batch.controller-return`.

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { audit } from "../audit";
import { NotFoundError, ValidationError, ConflictError } from "../errors";
import {
  materialiseReturnedForCorrectionItem,
  resolveFinalApprovalItem,
} from "./controller-work-intake";
import { invalidateAttestationForBatchDimension } from "./batch-review";

const ENTITY = "PayrollBatch";

export class ReturnConcurrencyConflictError extends Error {
  readonly code = "PAYROLL_RETURN_CONCURRENCY_CONFLICT";
  readonly batchId: string;
  readonly expectedStatus: string;
  readonly expectedVersion: number;
  constructor(batchId: string, expectedStatus: string, expectedVersion: number) {
    super(
      `Concurrent Return detected on batch ${batchId}: expected status=${expectedStatus} version=${expectedVersion} ` +
        "but the row changed under the transaction. Reload the batch and retry.",
    );
    this.batchId = batchId;
    this.expectedStatus = expectedStatus;
    this.expectedVersion = expectedVersion;
  }
}

export interface ReturnPayrollBatchResult {
  batchId: string;
  status: "RETURNED_FOR_CORRECTION";
  returnedAt: Date;
  returnedByUserId: string;
  returnReason: string;
  calculationVersion: number;
  payrollAdminWorkIntakeItemId: string | null;
}

export async function returnPayrollBatch(
  principal: Principal,
  clubId: string,
  batchId: string,
  reason: string,
): Promise<ReturnPayrollBatchResult> {
  requirePermission(principal, clubId, "payroll:return");
  await assertPostingAllowed(principal, clubId, "payroll.batch.controller-return", ENTITY, batchId);

  const trimmedReason = (reason ?? "").trim();
  if (!trimmedReason) {
    throw new ValidationError([{ path: "reason", message: "Return reason is required." }]);
  }

  const batch = await prisma.payrollBatch.findFirst({
    where: { id: batchId, clubId },
    select: {
      id: true, clubId: true, status: true, calculationVersion: true,
      submittedAt: true, submittedByUserId: true,
      payPeriodId: true,
    },
  });
  if (!batch) throw new NotFoundError(ENTITY, batchId);
  if (batch.status !== "SUBMITTED_FOR_APPROVAL") {
    throw new ConflictError(
      `Batch must be SUBMITTED_FOR_APPROVAL to be returned; current status is ${batch.status}.`,
    );
  }

  const now = new Date();

  // Atomic CAS + attestation invalidation.
  const casSucceeded = await prisma.$transaction(async (tx) => {
    const gate = await tx.payrollBatch.updateMany({
      where: {
        id: batchId, clubId,
        status: "SUBMITTED_FOR_APPROVAL",
        calculationVersion: batch.calculationVersion,
      },
      data: {
        status: "RETURNED_FOR_CORRECTION",
        submittedAt: null,
        submittedByUserId: null,
      },
    });
    if (gate.count !== 1) return false;
    await invalidateAttestationForBatchDimension(
      tx, clubId, batchId, "CALCULATED_PAYROLL", "payroll.batch.controller-return",
    );
    return true;
  });
  if (!casSucceeded) {
    throw new ReturnConcurrencyConflictError(batchId, "SUBMITTED_FOR_APPROVAL", batch.calculationVersion);
  }

  // Resolve Controller card + rearm Payroll Admin card.
  await resolveFinalApprovalItem(
    clubId, batchId, principal.id,
    `Returned for correction: ${trimmedReason}`,
  );

  const config = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  let payrollAdminWorkIntakeItemId: string | null = null;
  if (config?.payrollAdminUserId) {
    const period = await prisma.payrollPayPeriod.findFirst({
      where: { id: batch.payPeriodId, clubId },
      select: { periodStart: true, periodEnd: true },
    });
    const dateLabel = period
      ? `${period.periodStart.toISOString().slice(0, 10)} → ${new Date(period.periodEnd.getTime() - 86_400_000).toISOString().slice(0, 10)}`
      : batch.payPeriodId;
    payrollAdminWorkIntakeItemId = await materialiseReturnedForCorrectionItem({
      clubId, batchId,
      payrollAdminUserId: config.payrollAdminUserId,
      subject: `Payroll returned for correction · ${dateLabel}`,
      preview: `v${batch.calculationVersion} · Reason: ${trimmedReason} · Correct the batch and resubmit.`,
      returnedByUserId: principal.id,
      returnReason: trimmedReason,
    });
  }

  await audit(principal, {
    clubId,
    action: "payroll.batch.controller-return",
    entityType: ENTITY,
    entityId: batchId,
    before: {
      status: "SUBMITTED_FOR_APPROVAL",
      calculationVersion: batch.calculationVersion,
      submittedByUserId: batch.submittedByUserId,
    },
    after: {
      status: "RETURNED_FOR_CORRECTION",
      returnedAt: now,
      returnedByUserId: principal.id,
      returnReason: trimmedReason,
      calculationVersion: batch.calculationVersion,
      payrollAdminWorkIntakeItemId,
    },
  });

  return {
    batchId, status: "RETURNED_FOR_CORRECTION",
    returnedAt: now, returnedByUserId: principal.id,
    returnReason: trimmedReason,
    calculationVersion: batch.calculationVersion,
    payrollAdminWorkIntakeItemId,
  };
}

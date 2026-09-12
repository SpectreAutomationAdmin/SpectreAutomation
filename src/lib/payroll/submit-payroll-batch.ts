// Payroll Admin Slice 3E (2026-09-12) — Submit for Approval.
//
// Transitions a CALCULATED batch to SUBMITTED_FOR_APPROVAL and hands
// responsibility to the Controller via the PAYROLL_FINAL_APPROVAL
// Work Intake card. Formerly the Controller card was materialised at
// the end of Calculate; 3E moves that trigger to this Submit gesture
// so the workflow-stepper distinction between Step 5 (Review &
// Adjust) and Step 6 (Submit for Approval) is real.
//
// Contract (§2, §6, §7, §22, §26, §27, §29 of the 3E directive):
//
//   • Permission: `payroll:submit`.
//   • Prerequisites (server-side, independent of the UI):
//       - batch.status === "CALCULATED"
//       - batch.calculatedAt != null
//       - no BLOCKER exceptions unresolved
//       - CALCULATED_PAYROLL attestation exists AND is current
//         (fingerprint matches the live batch state)
//   • CAS transition: updateMany({ id, clubId, status:"CALCULATED",
//         calculationVersion:expectedVersion })
//     — the loser of a concurrent Submit race gets
//         SubmitConcurrencyConflictError.
//   • Persists: status="SUBMITTED_FOR_APPROVAL", submittedAt=now,
//         submittedByUserId=actorId.
//   • Materialises the PAYROLL_FINAL_APPROVAL Work Intake card
//         (idempotent via existing origin lookup) — reused/reopened
//         on resubmit.
//   • Resolves the outstanding PAYROLL_REVIEW card so the Payroll
//         Admin's inbox is clean.
//   • Also resolves any PAYROLL_RETURNED_FOR_CORRECTION card that
//         was open from a prior Return — the correction is now
//         complete; the Controller re-decides.
//   • Audits `payroll.batch.submit-for-approval` with the actor,
//         calculation version, CALCULATED_PAYROLL fingerprint,
//         optional note, and (when set) the referenced WI item id.
//
// Refuses without transitioning on any prerequisite failure. Never
// creates duplicate Origins; never leaves the batch in a half-state.

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { audit } from "../audit";
import { NotFoundError, ValidationError, ConflictError } from "../errors";
import { computeReviewFingerprint } from "./batch-review";
import {
  materialiseFinalApprovalItem,
  resolveOutstandingReviewItem,
  resolveReturnedForCorrectionItem,
} from "./controller-work-intake";

const ENTITY = "PayrollBatch";

export class SubmitConcurrencyConflictError extends Error {
  readonly code = "PAYROLL_SUBMIT_CONCURRENCY_CONFLICT";
  readonly batchId: string;
  readonly expectedStatus: string;
  readonly expectedVersion: number;
  constructor(batchId: string, expectedStatus: string, expectedVersion: number) {
    super(
      `Concurrent Submit detected on batch ${batchId}: expected status=${expectedStatus} version=${expectedVersion} ` +
        "but the row changed under the transaction. Reload the batch and retry.",
    );
    this.batchId = batchId;
    this.expectedStatus = expectedStatus;
    this.expectedVersion = expectedVersion;
  }
}

export interface SubmitPayrollBatchResult {
  batchId: string;
  status: "SUBMITTED_FOR_APPROVAL";
  submittedAt: Date;
  submittedByUserId: string;
  calculationVersion: number;
  calculatedPayrollFingerprint: string;
  workIntakeItemId: string | null;
  controllerGap: boolean;
}

export async function submitPayrollBatch(
  principal: Principal,
  clubId: string,
  batchId: string,
  options: { note?: string | null } = {},
): Promise<SubmitPayrollBatchResult> {
  requirePermission(principal, clubId, "payroll:submit");
  await assertPostingAllowed(principal, clubId, "payroll.batch.submit-for-approval", ENTITY, batchId);

  const batch = await prisma.payrollBatch.findFirst({
    where: { id: batchId, clubId },
    select: {
      id: true, clubId: true, status: true, calculationVersion: true,
      calculatedAt: true, payGroupId: true, payPeriodId: true,
    },
  });
  if (!batch) throw new NotFoundError(ENTITY, batchId);
  if (batch.status !== "CALCULATED") {
    throw new ConflictError(
      `Batch must be CALCULATED to submit for approval; current status is ${batch.status}.`,
    );
  }
  if (batch.calculatedAt == null) {
    throw new ConflictError("Batch is CALCULATED but calculatedAt is null; recalculate before submitting.");
  }

  // No BLOCKER exceptions.
  const blockerCount = await prisma.payrollBatchException.count({
    where: { clubId, batchId, severity: "BLOCKER", resolvedAt: null },
  });
  if (blockerCount > 0) {
    throw new ValidationError([{
      path: "batchId",
      message: `Batch has ${blockerCount} unresolved BLOCKER exception${blockerCount === 1 ? "" : "s"}. Resolve before submitting.`,
    }]);
  }

  // CALCULATED_PAYROLL review attestation must be current.
  const attestation = await prisma.payrollBatchReviewAttestation.findFirst({
    where: { clubId, batchId, dimension: "CALCULATED_PAYROLL", invalidatedAt: null },
    orderBy: { attestedAt: "desc" },
  });
  if (!attestation) {
    throw new ValidationError([{
      path: "calculatedPayrollReview",
      message: "Calculated payroll review has not been attested. Mark Reviewed before submitting.",
    }]);
  }
  const liveFingerprint = await computeReviewFingerprint(clubId, batchId, "CALCULATED_PAYROLL");
  if (attestation.fingerprint !== liveFingerprint) {
    throw new ValidationError([{
      path: "calculatedPayrollReview",
      message: "Calculated payroll review is stale (fingerprint mismatch). Re-review the calculation before submitting.",
    }]);
  }

  const now = new Date();
  const gate = await prisma.payrollBatch.updateMany({
    where: {
      id: batchId, clubId,
      status: "CALCULATED",
      calculationVersion: batch.calculationVersion,
    },
    data: {
      status: "SUBMITTED_FOR_APPROVAL",
      submittedAt: now,
      submittedByUserId: principal.id,
    },
  });
  if (gate.count !== 1) {
    throw new SubmitConcurrencyConflictError(batchId, "CALCULATED", batch.calculationVersion);
  }

  // Build the Controller card content OUTSIDE the state-transition CAS
  // so a WI failure never rolls back the Submit itself. If we cannot
  // create the WI (no controllerUserId), the Submit still succeeded —
  // we surface a `controllerGap` flag so the caller / UI can prompt
  // configuration.
  const config = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  let workIntakeItemId: string | null = null;
  let controllerGap = false;

  if (!config?.controllerUserId) {
    controllerGap = true;
  } else {
    const period = await prisma.payrollPayPeriod.findFirst({
      where: { id: batch.payPeriodId, clubId },
      select: { periodStart: true, periodEnd: true, payDate: true },
    });
    // Executive-summary preview — sum persisted employee results.
    const employees = await prisma.payrollBatchEmployee.findMany({
      where: { batchId, clubId },
      select: {
        grossPay: true, netPay: true, totalEmployeeDeductions: true,
        employerCppCombined: true, employerCpp2: true, employerEi: true,
      },
    });
    const totals = employees.reduce(
      (acc, be) => ({
        gross:    acc.gross    + Math.round(Number(be.grossPay ?? 0) * 100),
        deducted: acc.deducted + Math.round(Number(be.totalEmployeeDeductions ?? 0) * 100),
        net:      acc.net      + Math.round(Number(be.netPay ?? 0) * 100),
        employer: acc.employer + Math.round(Number(be.employerCppCombined ?? 0) * 100)
                              + Math.round(Number(be.employerCpp2 ?? 0) * 100)
                              + Math.round(Number(be.employerEi ?? 0) * 100),
      }),
      { gross: 0, deducted: 0, net: 0, employer: 0 },
    );
    const money = (cents: number) => (cents / 100).toFixed(2);
    const payDateLabel = period ? period.payDate.toISOString().slice(0, 10) : "unknown";
    const dateLabel = period
      ? `${period.periodStart.toISOString().slice(0, 10)} → ${new Date(period.periodEnd.getTime() - 86_400_000).toISOString().slice(0, 10)}`
      : batch.payPeriodId;
    const reviewUrl = `/app/admin/payroll/batches/${batchId}`;
    const preview =
      `v${batch.calculationVersion} · ${employees.length} employees · pay ${payDateLabel} · ` +
      `gross $${money(totals.gross)} · deductions $${money(totals.deducted)} · ` +
      `net $${money(totals.net)} · employer contributions $${money(totals.employer)} · ` +
      `Review payroll → ${reviewUrl}`;
    const subject = `Payroll for Controller approval · ${dateLabel}`;

    workIntakeItemId = await materialiseFinalApprovalItem({
      clubId, batchId,
      controllerUserId: config.controllerUserId,
      subject, preview,
      submittedByUserId: principal.id,
    });
  }

  // Close the sender-side inbox tasks so responsibility is unambiguous.
  await resolveOutstandingReviewItem(clubId, batchId, principal.id,
    "Payroll submitted for Controller approval — Payroll Admin review closed.");
  await resolveReturnedForCorrectionItem(clubId, batchId, principal.id,
    "Corrected payroll resubmitted for Controller approval.");

  await audit(principal, {
    clubId,
    action: "payroll.batch.submit-for-approval",
    entityType: ENTITY,
    entityId: batchId,
    before: { status: "CALCULATED", calculationVersion: batch.calculationVersion },
    after: {
      status: "SUBMITTED_FOR_APPROVAL",
      submittedAt: now,
      submittedByUserId: principal.id,
      calculationVersion: batch.calculationVersion,
      calculatedPayrollFingerprint: liveFingerprint,
      note: options.note?.trim() || null,
      workIntakeItemId,
      controllerGap,
    },
  });

  return {
    batchId, status: "SUBMITTED_FOR_APPROVAL",
    submittedAt: now, submittedByUserId: principal.id,
    calculationVersion: batch.calculationVersion,
    calculatedPayrollFingerprint: liveFingerprint,
    workIntakeItemId, controllerGap,
  };
}

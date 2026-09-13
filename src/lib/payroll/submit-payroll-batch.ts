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
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { audit } from "../audit";
import { NotFoundError, ValidationError, ConflictError } from "../errors";
import { computeReviewFingerprint } from "./batch-review";
import {
  FINAL_APPROVAL_ORIGIN_KIND,
  REVIEW_ORIGIN_KIND,
  RETURNED_ORIGIN_KIND,
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

  // Payroll 3E acceptance hotfix (2026-09-12) §1-3 — Controller
  // pre-flight. Refuse Submit BEFORE the state transition when no
  // reachable Controller exists. Guarantees §3: a successful Submit
  // means a valid Controller was assigned, and refuses to strand
  // a payroll in SUBMITTED_FOR_APPROVAL without a destination.
  const config = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  if (!config?.controllerUserId) {
    throw new ValidationError([{
      path: "controllerUserId",
      message: "Payroll cannot be submitted because no Controller is configured for final payroll approval. " +
        "Assign a Controller in Payroll → Setup → Configuration, then retry.",
    }]);
  }
  const controller = await prisma.user.findUnique({
    where: { id: config.controllerUserId },
    select: { id: true, status: true, name: true, email: true },
  });
  if (!controller || controller.status !== "ACTIVE") {
    throw new ValidationError([{
      path: "controllerUserId",
      message: `Payroll cannot be submitted because the configured Controller (${config.controllerUserId}) is not an active user. ` +
        "Reassign a Controller in Payroll → Setup → Configuration, then retry.",
    }]);
  }
  const controllerClubRole = await prisma.userClubRole.findFirst({
    where: { userId: controller.id, clubId, roleKey: "CONTROLLER" },
    select: { id: true },
  });
  if (!controllerClubRole) {
    throw new ValidationError([{
      path: "controllerUserId",
      message: `The configured Controller (${controller.email ?? controller.id}) is not assigned the CONTROLLER role at this club. ` +
        "Grant the CONTROLLER role or reassign the Controller before submitting.",
    }]);
  }
  // Verify the Controller carries the approval permission via RBAC.
  const controllerPrincipalStub = {
    id: controller.id, kind: "user" as const,
    memberships: [{ clubId, roleKey: "CONTROLLER" as const }],
    activeClubId: clubId,
  } as unknown as Principal;
  if (!hasPermission(controllerPrincipalStub, clubId, "payroll:approve")) {
    throw new ValidationError([{
      path: "controllerUserId",
      message: `The configured Controller does not hold the payroll:approve permission at this club. ` +
        "Update role permissions or reassign the Controller.",
    }]);
  }

  // Load period + employee totals BEFORE opening the transaction so
  // the inline preview computation is a pure read outside the atomic
  // state transition + WI create pair.
  const period = await prisma.payrollPayPeriod.findFirst({
    where: { id: batch.payPeriodId, clubId },
    select: { periodStart: true, periodEnd: true, payDate: true },
  });
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

  const now = new Date();

  // Payroll 3E acceptance hotfix §2 — ATOMIC: batch CAS AND
  // Work Intake creation happen in a single `$transaction`. If the WI
  // insert fails (unique-conflict, DB error), the batch state transition
  // is rolled back. There is NO possible half-state where the batch is
  // SUBMITTED_FOR_APPROVAL but the Controller has no card.
  let workIntakeItemId: string;
  try {
    workIntakeItemId = await prisma.$transaction(async (tx) => {
      const gate = await tx.payrollBatch.updateMany({
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
      // Idempotent upsert of the Controller card, inside the same
      // transaction as the batch CAS.
      const existing = await tx.workIntakeOrigin.findFirst({
        where: {
          clubId, kind: FINAL_APPROVAL_ORIGIN_KIND,
          referenceId: batchId, role: "PRIMARY",
        },
        select: { workIntakeItemId: true },
      });
      let itemId: string;
      if (existing) {
        await tx.workIntakeItem.update({
          where: { id: existing.workIntakeItemId },
          data: {
            status: "OPEN", ownerUserId: config.controllerUserId!,
            displaySubject: subject, displayPreview: preview,
            displayReceivedAt: now, resolvedAt: null, resolvedByUserId: null,
          },
        });
        await tx.workIntakeActivity.create({
          data: {
            workIntakeItemId: existing.workIntakeItemId,
            actorUserId: principal.id,
            action: "MATERIALISED",
            note: "Payroll (re)submitted — Controller task refreshed for the current calculation version.",
          },
        });
        itemId = existing.workIntakeItemId;
      } else {
        const created = await tx.workIntakeItem.create({
          data: {
            clubId, status: "OPEN", judgmentRequired: true,
            ownerUserId: config.controllerUserId!,
            classification: FINAL_APPROVAL_ORIGIN_KIND,
            classificationReason: "Payroll submitted by Payroll Admin — Controller final approval required.",
            classificationMethod: "RULE",
            classificationRuleKey: "payroll-orchestration.v1",
            classificationRuleVersion: 1,
            displaySourceLabel: "Spectre Payroll",
            displaySender: "Payroll orchestration",
            displaySubject: subject,
            displayPreview: preview,
            displayReceivedAt: now,
            displayHasAttachments: false,
            workDomain: "PAYROLL", workIntent: "APPROVE",
            workSubtype: FINAL_APPROVAL_ORIGIN_KIND,
            workDomainConfidence: 1,
            workDomainClassifiedAt: now,
            workDomainClassifierVersion: "payroll-orchestration.v1",
          },
          select: { id: true },
        });
        await tx.workIntakeOrigin.create({
          data: {
            clubId, workIntakeItemId: created.id,
            kind: FINAL_APPROVAL_ORIGIN_KIND, referenceId: batchId, role: "PRIMARY",
            linkReason: `Payroll Admin submitted batch ${batchId} for Controller approval.`,
          },
        });
        await tx.workIntakeActivity.create({
          data: {
            workIntakeItemId: created.id,
            actorUserId: principal.id,
            action: "MATERIALISED",
            note: "Controller final-approval task materialised on Submit.",
          },
        });
        itemId = created.id;
      }
      // Resolve the sender-side inbox items in the SAME transaction so
      // responsibility handoff is atomic.
      for (const kind of [REVIEW_ORIGIN_KIND, RETURNED_ORIGIN_KIND] as const) {
        const senderOrigin = await tx.workIntakeOrigin.findFirst({
          where: { clubId, kind, referenceId: batchId, role: "PRIMARY" },
          select: { workIntakeItemId: true },
        });
        if (!senderOrigin) continue;
        await tx.workIntakeItem.updateMany({
          where: { id: senderOrigin.workIntakeItemId, status: { not: "RESOLVED" } },
          data: { status: "RESOLVED", resolvedAt: now, resolvedByUserId: principal.id },
        });
        await tx.workIntakeActivity.create({
          data: {
            workIntakeItemId: senderOrigin.workIntakeItemId,
            actorUserId: principal.id, action: "RESOLVED",
            note: kind === REVIEW_ORIGIN_KIND
              ? "Payroll submitted for Controller approval — Payroll Admin review closed."
              : "Corrected payroll resubmitted for Controller approval.",
          },
        });
      }
      return itemId;
    });
  } catch (err) {
    if (err instanceof SubmitConcurrencyConflictError) throw err;
    // Any other transaction failure: batch state and WI item both
    // rolled back — payroll remains CALCULATED. Bubble up an actionable
    // ValidationError explaining the transient nature.
    throw new ValidationError([{
      path: "workIntake",
      message: "Submit failed while creating the Controller Work Intake card. The batch remains CALCULATED — reload and retry. " +
        `Underlying error: ${(err as Error).message}`,
    }]);
  }

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
      controllerUserId: config.controllerUserId,
    },
  });

  return {
    batchId, status: "SUBMITTED_FOR_APPROVAL",
    submittedAt: now, submittedByUserId: principal.id,
    calculationVersion: batch.calculationVersion,
    calculatedPayrollFingerprint: liveFingerprint,
    workIntakeItemId,
    controllerGap: false,
  };
}

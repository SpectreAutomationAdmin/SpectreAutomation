// Payroll Admin Slice 3E (2026-09-12) — shared Controller Work Intake
// orchestration extracted from calculation-execute.ts. The 3E design
// (§7, §22, §35) requires the PAYROLL_FINAL_APPROVAL card to be
// created at SUBMIT time, not at CALCULATE time. Both submit + resubmit
// use these helpers; return + approve use `resolveFinalApprovalItem`
// / `reopenFinalApprovalItem` symmetrically.
//
// Origin idempotency: `WorkIntakeOrigin` has a unique constraint on
// `(workIntakeItemId, kind, referenceId, role)` — NOT on the shorter
// tuple. Idempotency is enforced at the SERVICE layer by looking up
// via `findFirst({ clubId, kind, referenceId, role })` and upserting
// via the linked `WorkIntakeItem` (see `materialiseFinalApprovalItem`).
//
// All helpers here are pure orchestration — they never mutate the
// PayrollBatch itself. They may be called from services already
// inside a Prisma `$transaction`; every call therefore uses
// `updateMany` / `findFirst` against the standard `prisma` client
// so the transaction context is naturally inherited when spliced in
// via a transaction argument shim (the current callers pass the
// non-transactional `prisma` — order of writes is: batch state CAS
// first, then WI orchestration; WI failure logs and continues).

import { prisma } from "../prisma";

export const FINAL_APPROVAL_ORIGIN_KIND = "PAYROLL_FINAL_APPROVAL";
export const REVIEW_ORIGIN_KIND         = "PAYROLL_REVIEW";
export const RETURNED_ORIGIN_KIND       = "PAYROLL_RETURNED_FOR_CORRECTION";

/**
 * Idempotent create-or-refresh of the Controller's
 * PAYROLL_FINAL_APPROVAL Work Intake card for a batch. Called by
 * `submitPayrollBatch` and by `submitPayrollBatch`'s resubmit path.
 * Never fires from `calculatePayrollBatch` (3E moved the trigger).
 */
export async function materialiseFinalApprovalItem(args: {
  clubId: string;
  batchId: string;
  controllerUserId: string;
  subject: string;
  preview: string;
  submittedByUserId: string;
}): Promise<string> {
  const existing = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId: args.clubId, kind: FINAL_APPROVAL_ORIGIN_KIND,
      referenceId: args.batchId, role: "PRIMARY",
    },
    select: { workIntakeItemId: true },
  });
  const now = new Date();
  if (existing) {
    // Re-open on resubmit (§22, §36).
    await prisma.workIntakeItem.update({
      where: { id: existing.workIntakeItemId },
      data: {
        status: "OPEN", ownerUserId: args.controllerUserId,
        displaySubject: args.subject, displayPreview: args.preview,
        displayReceivedAt: now, resolvedAt: null, resolvedByUserId: null,
      },
    });
    await prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: existing.workIntakeItemId,
        actorUserId: args.submittedByUserId,
        action: "MATERIALISED",
        note: "Payroll resubmitted — Controller task reopened for the new calculation version.",
      },
    });
    return existing.workIntakeItemId;
  }
  const created = await prisma.workIntakeItem.create({
    data: {
      clubId: args.clubId, status: "OPEN", judgmentRequired: true,
      ownerUserId: args.controllerUserId,
      classification: FINAL_APPROVAL_ORIGIN_KIND,
      classificationReason: "Payroll submitted by Payroll Admin — Controller final approval required.",
      classificationMethod: "RULE",
      classificationRuleKey: "payroll-orchestration.v1",
      classificationRuleVersion: 1,
      displaySourceLabel: "Spectre Payroll",
      displaySender: "Payroll orchestration",
      displaySubject: args.subject,
      displayPreview: args.preview,
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
  await prisma.workIntakeOrigin.create({
    data: {
      clubId: args.clubId, workIntakeItemId: created.id,
      kind: FINAL_APPROVAL_ORIGIN_KIND, referenceId: args.batchId, role: "PRIMARY",
      linkReason: `Payroll Admin submitted batch ${args.batchId} for Controller approval.`,
    },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: created.id,
      actorUserId: args.submittedByUserId,
      action: "MATERIALISED",
      note: "Controller final-approval task materialised on Submit.",
    },
  });
  return created.id;
}

/** Close the PAYROLL_REVIEW (Payroll-Admin review) item at Submit
 *  — responsibility hands off to the Controller (§7, §14). */
export async function resolveOutstandingReviewItem(
  clubId: string, batchId: string, actorUserId: string, note?: string,
): Promise<void> {
  const link = await prisma.workIntakeOrigin.findFirst({
    where: { clubId, kind: REVIEW_ORIGIN_KIND, referenceId: batchId, role: "PRIMARY" },
    select: { workIntakeItemId: true },
  });
  if (!link) return;
  const now = new Date();
  await prisma.workIntakeItem.updateMany({
    where: { id: link.workIntakeItemId, status: { not: "RESOLVED" } },
    data: { status: "RESOLVED", resolvedAt: now, resolvedByUserId: actorUserId },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: link.workIntakeItemId, actorUserId, action: "RESOLVED",
      note: note ?? "Payroll submitted for Controller approval — Payroll Admin review closed.",
    },
  });
}

/** Close the Controller PAYROLL_FINAL_APPROVAL item — called on both
 *  Approve (§14) AND Return (§19). Symmetric callsites: both end the
 *  Controller's queue-side task; Approve leaves the batch APPROVED,
 *  Return leaves the batch RETURNED_FOR_CORRECTION and rearms
 *  a fresh PAYROLL_REVIEW / RETURNED task for the Payroll Admin. */
export async function resolveFinalApprovalItem(
  clubId: string, batchId: string, actorUserId: string, note: string,
): Promise<void> {
  const link = await prisma.workIntakeOrigin.findFirst({
    where: { clubId, kind: FINAL_APPROVAL_ORIGIN_KIND, referenceId: batchId, role: "PRIMARY" },
    select: { workIntakeItemId: true },
  });
  if (!link) return;
  const now = new Date();
  await prisma.workIntakeItem.updateMany({
    where: { id: link.workIntakeItemId, status: { not: "RESOLVED" } },
    data: { status: "RESOLVED", resolvedAt: now, resolvedByUserId: actorUserId },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: link.workIntakeItemId, actorUserId, action: "RESOLVED",
      note,
    },
  });
}

/** Create/rearm a Payroll Admin Work Intake card telling them the
 *  batch was returned for correction. Idempotent by
 *  `(clubId, kind=PAYROLL_RETURNED_FOR_CORRECTION, referenceId=batchId, role=PRIMARY)`.
 *  Called by `returnPayrollBatch` inside its transaction gap. */
export async function materialiseReturnedForCorrectionItem(args: {
  clubId: string;
  batchId: string;
  payrollAdminUserId: string;
  subject: string;
  preview: string;
  returnedByUserId: string;
  returnReason: string;
}): Promise<string> {
  const existing = await prisma.workIntakeOrigin.findFirst({
    where: {
      clubId: args.clubId, kind: RETURNED_ORIGIN_KIND,
      referenceId: args.batchId, role: "PRIMARY",
    },
    select: { workIntakeItemId: true },
  });
  const now = new Date();
  if (existing) {
    await prisma.workIntakeItem.update({
      where: { id: existing.workIntakeItemId },
      data: {
        status: "OPEN", ownerUserId: args.payrollAdminUserId,
        displaySubject: args.subject, displayPreview: args.preview,
        displayReceivedAt: now, resolvedAt: null, resolvedByUserId: null,
      },
    });
    await prisma.workIntakeActivity.create({
      data: {
        workIntakeItemId: existing.workIntakeItemId,
        actorUserId: args.returnedByUserId,
        action: "MATERIALISED",
        note: `Returned for correction: ${args.returnReason}`,
      },
    });
    return existing.workIntakeItemId;
  }
  const created = await prisma.workIntakeItem.create({
    data: {
      clubId: args.clubId, status: "OPEN", judgmentRequired: true,
      ownerUserId: args.payrollAdminUserId,
      classification: RETURNED_ORIGIN_KIND,
      classificationReason: "Controller returned payroll for correction.",
      classificationMethod: "RULE",
      classificationRuleKey: "payroll-orchestration.v1",
      classificationRuleVersion: 1,
      displaySourceLabel: "Spectre Payroll",
      displaySender: "Payroll orchestration",
      displaySubject: args.subject,
      displayPreview: args.preview,
      displayReceivedAt: now,
      displayHasAttachments: false,
      workDomain: "PAYROLL", workIntent: "REVIEW",
      workSubtype: RETURNED_ORIGIN_KIND,
      workDomainConfidence: 1,
      workDomainClassifiedAt: now,
      workDomainClassifierVersion: "payroll-orchestration.v1",
    },
    select: { id: true },
  });
  await prisma.workIntakeOrigin.create({
    data: {
      clubId: args.clubId, workIntakeItemId: created.id,
      kind: RETURNED_ORIGIN_KIND, referenceId: args.batchId, role: "PRIMARY",
      linkReason: `Controller returned batch ${args.batchId} for correction.`,
    },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: created.id,
      actorUserId: args.returnedByUserId,
      action: "MATERIALISED",
      note: `Returned for correction: ${args.returnReason}`,
    },
  });
  return created.id;
}

/** Close the Payroll Admin's PAYROLL_RETURNED_FOR_CORRECTION card
 *  when the Payroll Admin resubmits (a corrective resubmit closes
 *  the return-card and re-opens the Controller card). */
export async function resolveReturnedForCorrectionItem(
  clubId: string, batchId: string, actorUserId: string, note?: string,
): Promise<void> {
  const link = await prisma.workIntakeOrigin.findFirst({
    where: { clubId, kind: RETURNED_ORIGIN_KIND, referenceId: batchId, role: "PRIMARY" },
    select: { workIntakeItemId: true },
  });
  if (!link) return;
  const now = new Date();
  await prisma.workIntakeItem.updateMany({
    where: { id: link.workIntakeItemId, status: { not: "RESOLVED" } },
    data: { status: "RESOLVED", resolvedAt: now, resolvedByUserId: actorUserId },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: link.workIntakeItemId, actorUserId, action: "RESOLVED",
      note: note ?? "Payroll resubmitted after correction — Payroll Admin return card closed.",
    },
  });
}

/** Read submission + return history for a batch from the
 *  PAYROLL_FINAL_APPROVAL + PAYROLL_RETURNED_FOR_CORRECTION items'
 *  activity streams. Ordered oldest → newest. */
export async function getBatchApprovalHistory(clubId: string, batchId: string): Promise<Array<{
  itemId: string;
  originKind: string;
  actorUserId: string | null;
  action: string;
  note: string | null;
  createdAt: Date;
}>> {
  const origins = await prisma.workIntakeOrigin.findMany({
    where: {
      clubId, referenceId: batchId, role: "PRIMARY",
      kind: { in: [FINAL_APPROVAL_ORIGIN_KIND, RETURNED_ORIGIN_KIND, REVIEW_ORIGIN_KIND] },
    },
    select: { kind: true, workIntakeItemId: true },
  });
  if (origins.length === 0) return [];
  const byItem = new Map(origins.map((o) => [o.workIntakeItemId, o.kind]));
  const activities = await prisma.workIntakeActivity.findMany({
    where: { workIntakeItemId: { in: origins.map((o) => o.workIntakeItemId) } },
    orderBy: { createdAt: "asc" },
    select: { workIntakeItemId: true, actorUserId: true, action: true, note: true, createdAt: true },
  });
  return activities.map((a) => ({
    itemId: a.workIntakeItemId,
    originKind: byItem.get(a.workIntakeItemId) ?? "",
    actorUserId: a.actorUserId,
    action: a.action,
    note: a.note,
    createdAt: a.createdAt,
  }));
}

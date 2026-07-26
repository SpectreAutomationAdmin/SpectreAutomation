// Sprint 3 Checkpoint 15G (2026-07-24) — Statement reviewer actions.
//
// Records the reviewer's decision as WorkIntakeActivity + optional
// VendorStatementLineMatch.reviewerDecision. NEVER creates AP posts,
// payments, credits, or vendor communication.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import type { StatementReviewerAction } from "./types";
import { StatementIntelligenceError } from "./types";
import type { Principal } from "@/lib/rbac";

export interface StatementActionArgs {
  principal: Principal;
  clubId: string;
  workIntakeItemId: string;
  kind: StatementReviewerAction;
  notes?: string;
  payload?: {
    statementLineId?: string;
    linkToApInvoiceId?: string;
    linkToVendorPaymentId?: string;
    canonicalVendorId?: string;
  };
}

export interface StatementActionResult {
  ok: boolean;
  kind: StatementReviewerAction;
  reason?: string;
}

export async function applyStatementAction(args: StatementActionArgs): Promise<StatementActionResult> {
  const intake = await prisma.workIntakeItem.findFirst({
    where: { id: args.workIntakeItemId, clubId: args.clubId, classification: "VENDOR_STATEMENT_REVIEW" },
    select: {
      id: true,
      origins: { where: { role: "PRIMARY", kind: "INGESTED_DOCUMENT" }, select: { referenceId: true } },
    },
  });
  if (!intake) return { ok: false, kind: args.kind, reason: "not_found" };
  const documentOrigin = intake.origins[0];
  if (!documentOrigin) return { ok: false, kind: args.kind, reason: "no_document_origin" };
  const reconciliation = await prisma.vendorStatementReconciliation.findFirst({
    where: { clubId: args.clubId, ingestedDocumentId: documentOrigin.referenceId },
    select: { id: true },
  });
  if (!reconciliation) return { ok: false, kind: args.kind, reason: "no_reconciliation" };

  switch (args.kind) {
    case "CONFIRM_VENDOR":
    case "CORRECT_VENDOR":
    case "MARK_TIMING_DIFFERENCE":
    case "MARK_VENDOR_ERROR":
    case "MARK_SPECTRE_ERROR":
    case "DEFER_REVIEW":
      await recordActivity({ intakeId: intake.id, actorUserId: args.principal.id, kind: args.kind, notes: args.notes ?? null, payload: args.payload });
      if (args.kind === "CORRECT_VENDOR" && args.payload?.canonicalVendorId) {
        // Verify chosen vendor is in the club.
        const v = await prisma.vendor.count({ where: { id: args.payload.canonicalVendorId, clubId: args.clubId } });
        if (v === 0) return { ok: false, kind: args.kind, reason: "vendor_not_found" };
        await prisma.vendorStatementReconciliation.update({
          where: { id: reconciliation.id },
          data: { canonicalVendorId: args.payload.canonicalVendorId },
        });
      }
      return { ok: true, kind: args.kind };

    case "CONFIRM_LINE_MATCH":
    case "REJECT_LINE_MATCH":
    case "LINK_EXISTING_INVOICE":
    case "LINK_EXISTING_PAYMENT": {
      const lineId = args.payload?.statementLineId;
      if (!lineId) return { ok: false, kind: args.kind, reason: "missing_statementLineId" };
      const line = await prisma.vendorStatementLine.findFirst({
        where: { id: lineId, clubId: args.clubId, reconciliationId: reconciliation.id },
        select: { id: true },
      });
      if (!line) return { ok: false, kind: args.kind, reason: "line_not_found" };

      const reviewerDecision = { userId: args.principal.id, decision: args.kind, at: new Date().toISOString(), note: args.notes ?? null };
      if (args.kind === "LINK_EXISTING_INVOICE" && args.payload?.linkToApInvoiceId) {
        const ap = await prisma.aPInvoice.count({ where: { id: args.payload.linkToApInvoiceId, clubId: args.clubId } });
        if (ap === 0) return { ok: false, kind: args.kind, reason: "ap_invoice_not_found" };
        await prisma.vendorStatementLineMatch.create({
          data: {
            clubId: args.clubId, statementLineId: line.id,
            targetKind: "AP_INVOICE", targetReferenceId: args.payload.linkToApInvoiceId,
            matchState: "EXACT_MATCH",
            matchBasis: JSON.stringify({ ruleKey: "reviewer.link_existing_invoice", signals: ["reviewer"] }),
            reviewerDecision: JSON.stringify(reviewerDecision),
          },
        });
      } else if (args.kind === "LINK_EXISTING_PAYMENT" && args.payload?.linkToVendorPaymentId) {
        const p = await prisma.vendorPayment.count({ where: { id: args.payload.linkToVendorPaymentId, clubId: args.clubId } });
        if (p === 0) return { ok: false, kind: args.kind, reason: "vendor_payment_not_found" };
        await prisma.vendorStatementLineMatch.create({
          data: {
            clubId: args.clubId, statementLineId: line.id,
            targetKind: "VENDOR_PAYMENT", targetReferenceId: args.payload.linkToVendorPaymentId,
            matchState: "EXACT_MATCH",
            matchBasis: JSON.stringify({ ruleKey: "reviewer.link_existing_payment", signals: ["reviewer"] }),
            reviewerDecision: JSON.stringify(reviewerDecision),
          },
        });
      } else {
        // CONFIRM / REJECT — stamp the existing matches with reviewerDecision.
        await prisma.vendorStatementLineMatch.updateMany({
          where: { statementLineId: line.id },
          data: { reviewerDecision: JSON.stringify(reviewerDecision) },
        });
      }
      await recordActivity({ intakeId: intake.id, actorUserId: args.principal.id, kind: args.kind, notes: args.notes ?? null, payload: args.payload });
      return { ok: true, kind: args.kind };
    }

    case "RESOLVE_RECONCILIATION":
      await prisma.workIntakeItem.update({
        where: { id: intake.id },
        data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: args.principal.id },
      });
      await recordActivity({ intakeId: intake.id, actorUserId: args.principal.id, kind: args.kind, notes: args.notes ?? null, payload: null });
      return { ok: true, kind: args.kind };

    default:
      return { ok: false, kind: args.kind, reason: "unknown_kind" };
  }
}

async function recordActivity(args: { intakeId: string; actorUserId: string | null; kind: StatementReviewerAction; notes: string | null; payload: unknown }): Promise<void> {
  const payloadStr = args.payload ? JSON.stringify(args.payload) : null;
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: args.intakeId,
      actorUserId: args.actorUserId,
      action: `STATEMENT_${args.kind}`,
      note: [args.notes, payloadStr].filter(Boolean).join(" · ") || null,
    },
  });
}

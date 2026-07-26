// Sprint 3 Checkpoint 15E (2026-07-24) — AP-intelligence user
// actions.
//
// Records the reviewer's decision as a WorkIntakeActivity row so the
// intake carries a full audit trail. For decisions that CHANGE
// downstream state (attach-to-existing, create-draft), also updates
// origins and/or delegates to the existing AP service.
//
// NEVER approves, posts, or pays. NEVER modifies the original PDF.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import type { ApCorrectionKind } from "./types";
import { linkEvidence as linkDocumentEvidence } from "@/lib/documents/ingest";
import { upsertOrigins } from "@/lib/intelligence/origins";
import { analyseIngestedInvoice } from "./analyse";
import { createDraft as createDraftApInvoice, invoiceCreateSchema } from "@/lib/ap/invoices";
import type { Principal } from "@/lib/rbac";
import { toMoney, sumMoney } from "@/lib/accounting/decimal";

export interface ActionArgs {
  principal: Principal;
  clubId: string;
  workIntakeItemId: string;
  kind: ApCorrectionKind;
  notes?: string;
  payload?: Record<string, unknown>;
}

export interface ActionResult {
  ok: boolean;
  kind: ApCorrectionKind;
  reason?: string;
  createdApInvoiceId?: string;
  linkedApInvoiceId?: string;
  detailsJson?: string;
}

export async function applyApAction(args: ActionArgs): Promise<ActionResult> {
  // Tenant guard first — never allow cross-club action even accidentally.
  const intake = await prisma.workIntakeItem.findFirst({
    where: { id: args.workIntakeItemId, clubId: args.clubId },
    select: {
      id: true,
      origins: { select: { kind: true, referenceId: true, role: true } },
    },
  });
  if (!intake) {
    return { ok: false, kind: args.kind, reason: "not_found" };
  }
  const documentOrigin = intake.origins.find((o) => o.kind === "INGESTED_DOCUMENT" && o.role === "PRIMARY");
  if (!documentOrigin) {
    return { ok: false, kind: args.kind, reason: "no_document_origin" };
  }

  switch (args.kind) {
    case "APPROVE_EXTRACTION":
    case "REJECT_EXTRACTION":
    case "MARK_OPERATING":
    case "MARK_CAPITAL":
    case "CORRECT_VENDOR":
    case "CORRECT_GL_ACCOUNT":
      await recordActivity({
        workIntakeItemId: intake.id,
        actorUserId: args.principal.id,
        kind: args.kind,
        notes: args.notes ?? null,
        payload: args.payload ?? null,
      });
      logger.info("ap-intelligence.action.recorded", {
        clubId: args.clubId,
        intakeIdTail: intake.id.slice(-6),
        kind: args.kind,
      });
      return { ok: true, kind: args.kind };

    case "ATTACH_TO_EXISTING_INVOICE": {
      const apInvoiceId = typeof args.payload?.apInvoiceId === "string" ? args.payload.apInvoiceId : null;
      if (!apInvoiceId) return { ok: false, kind: args.kind, reason: "missing_apInvoiceId" };
      const ap = await prisma.aPInvoice.count({ where: { id: apInvoiceId, clubId: args.clubId } });
      if (ap === 0) return { ok: false, kind: args.kind, reason: "not_found" };

      // Link both directions:
      //   * IngestedDocumentEvidenceLink: doc → AP_INVOICE (audit)
      //   * WorkIntakeOrigin: intake → AP_INVOICE (MC discoverability)
      await linkDocumentEvidence({
        clubId: args.clubId,
        ingestedDocumentId: documentOrigin.referenceId,
        target: { targetKind: "AP_INVOICE", targetReferenceId: apInvoiceId, role: "EVIDENCE", reason: "User attached via review" },
        actorUserId: args.principal.id,
      });
      await upsertOrigins({
        clubId: args.clubId,
        workIntakeItemId: intake.id,
        origins: [{ kind: "AP_INVOICE", referenceId: apInvoiceId, role: "EVIDENCE" }],
      });
      await recordActivity({
        workIntakeItemId: intake.id,
        actorUserId: args.principal.id,
        kind: args.kind,
        notes: args.notes ?? null,
        payload: { apInvoiceId },
      });
      logger.info("ap-intelligence.action.attached", {
        clubId: args.clubId,
        intakeIdTail: intake.id.slice(-6),
        apInvoiceIdTail: apInvoiceId.slice(-6),
      });
      return { ok: true, kind: args.kind, linkedApInvoiceId: apInvoiceId };
    }

    case "CREATE_DRAFT_INVOICE": {
      // Re-run the analyser to get the most current extraction — a
      // reviewer may have edited signals since materialisation.
      const analysis = await analyseIngestedInvoice({ clubId: args.clubId, ingestedDocumentId: documentOrigin.referenceId });
      const vendorId = args.payload?.vendorId as string | undefined ?? (analysis.vendor.state === "MATCHED" ? analysis.vendor.candidates[0].id : null);
      if (!vendorId) return { ok: false, kind: args.kind, reason: "vendor_required" };
      if (!analysis.extraction.total || !analysis.extraction.invoiceDate || !analysis.extraction.invoiceNumber) {
        return { ok: false, kind: args.kind, reason: "extraction_incomplete" };
      }
      // Build minimal-line-item invoice from extraction. If the
      // extraction produced no line items, synthesise a single line
      // using the total minus tax.
      const total = toMoney(analysis.extraction.total);
      const tax = analysis.extraction.taxTotal ? toMoney(analysis.extraction.taxTotal) : toMoney("0");
      const subtotal = total.minus(tax);
      const glAccount = analysis.gl.accountNumber ?? (args.payload?.expenseAccountNumber as string | undefined);
      if (!glAccount) return { ok: false, kind: args.kind, reason: "gl_account_required" };

      const lines = analysis.extraction.lineItems.length > 0
        ? analysis.extraction.lineItems.map((l) => ({
            expenseAccountNumber: glAccount,
            description: l.description,
            amount: Number(toMoney(l.amount).toFixed(2)),
            taxAmount: 0,
            isCapital: analysis.capital.state === "CAPITAL",
          }))
        : [{
            expenseAccountNumber: glAccount,
            description: analysis.extraction.description ?? analysis.extraction.vendor.guessedName ?? "Invoice",
            amount: Number(subtotal.toFixed(2)),
            taxAmount: Number(tax.toFixed(2)),
            isCapital: analysis.capital.state === "CAPITAL",
          }];

      // Reconcile line totals to subtotal — if user provided lines
      // sum differently, fall back to synthesised single line.
      const linesSum = sumMoney(lines.map((l) => l.amount));
      const useLines = linesSum.equals(subtotal) || lines.length === 1 ? lines : [{
        expenseAccountNumber: glAccount,
        description: analysis.extraction.description ?? "Invoice",
        amount: Number(subtotal.toFixed(2)),
        taxAmount: Number(tax.toFixed(2)),
        isCapital: analysis.capital.state === "CAPITAL",
      }];

      const raw = {
        vendorId,
        vendorReference: analysis.extraction.invoiceNumber,
        invoiceDate: analysis.extraction.invoiceDate,
        dueDate: analysis.extraction.dueDate ?? undefined,
        description: analysis.extraction.description ?? undefined,
        currency: analysis.extraction.currency ?? "CAD",
        lines: useLines,
      };
      // Parse via existing zod schema to catch shape drift.
      invoiceCreateSchema.parse(raw);

      const draft = await createDraftApInvoice(args.principal, args.clubId, raw);

      // Attach the PDF to the freshly created AP invoice (both link
      // directions, same as attach-to-existing).
      await linkDocumentEvidence({
        clubId: args.clubId,
        ingestedDocumentId: documentOrigin.referenceId,
        target: { targetKind: "AP_INVOICE", targetReferenceId: draft.id, role: "PRIMARY", reason: "Attached from AP-review draft creation" },
        actorUserId: args.principal.id,
      });
      await upsertOrigins({
        clubId: args.clubId,
        workIntakeItemId: intake.id,
        origins: [{ kind: "AP_INVOICE", referenceId: draft.id, role: "EVIDENCE" }],
      });

      await recordActivity({
        workIntakeItemId: intake.id,
        actorUserId: args.principal.id,
        kind: args.kind,
        notes: args.notes ?? null,
        payload: { apInvoiceId: draft.id, vendorId, invoiceNumber: analysis.extraction.invoiceNumber },
      });

      logger.info("ap-intelligence.action.draft_created", {
        clubId: args.clubId,
        intakeIdTail: intake.id.slice(-6),
        apInvoiceIdTail: draft.id.slice(-6),
      });
      return { ok: true, kind: args.kind, createdApInvoiceId: draft.id };
    }

    default:
      return { ok: false, kind: args.kind, reason: "unknown_kind" };
  }
}

async function recordActivity(args: {
  workIntakeItemId: string;
  actorUserId: string | null;
  kind: ApCorrectionKind;
  notes: string | null;
  payload: unknown;
}): Promise<void> {
  const payloadStr = args.payload ? JSON.stringify(args.payload) : null;
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: args.workIntakeItemId,
      actorUserId: args.actorUserId,
      action: `AP_${args.kind}`,
      note: [args.notes, payloadStr].filter(Boolean).join(" · ") || null,
    },
  });
}

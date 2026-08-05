// Sprint 3 · Checkpoint 16H rejection #4 (2026-08-06) — GENERAL
// ops endpoint that runs the canonical AP materialisation path for
// any IngestedDocument in the active club that carries an invoice-
// candidate mime (application/pdf, image/*) and has NOT yet been
// linked to an ApIntakeSource.
//
// Class-level operation: required whenever the document classifier
// contract changes (as it did in this checkpoint — the mime-default
// INVOICE fallback). NOT item-specific.
//
// Gated by BACKFILL_TOKEN env secret + Bearer header match. Returns
// 404 (never 401) so the endpoint is not discoverable.
//
// The materialisation call is idempotent: rerunning is safe because
// materialiseSingleInvoiceDocument dedupes via SHA and canonical
// intake lookup.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { materialiseSingleInvoiceDocument } from "@/lib/ap-intelligence/materialise";

export const dynamic = "force-dynamic";

const COULEE_RIDGE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";

const CANDIDATE_MIMES = [
  "application/pdf",
  "image/jpeg", "image/jpg", "image/png",
  "image/tiff", "image/tif",
  "image/heic", "image/heif",
];

interface Report {
  ok: boolean;
  scanned: number;
  eligible: number;
  reclassified: number;
  materialised: number;
  skipped: number;
  perRow: Array<{
    docIdSuffix: string;
    filename: string;
    outcome: "materialised" | "already_linked" | "materialise_error" | "no_attachment_context";
    intakeIdSuffix?: string;
    relationship?: string | null;
    findingsCreated?: number;
    reason?: string;
  }>;
}

export async function POST(req: NextRequest) {
  const token = process.env.BACKFILL_TOKEN;
  if (!token) return NextResponse.json({ error: "backfill_disabled" }, { status: 404 });
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const docs = await prisma.ingestedDocument.findMany({
    where: {
      clubId: COULEE_RIDGE_CLUB_ID,
      mimeType: { in: CANDIDATE_MIMES },
      sourceKind: "EMAIL_ATTACHMENT",
    },
    select: {
      id: true, filename: true, mimeType: true,
      classification: true, classificationRuleKey: true,
      sourceReferenceId: true,
    },
  });

  // Existing links — do not rematerialise something that already has
  // an ApIntakeSource. Rerun-safe.
  const linkedDocIds = new Set(
    (await prisma.apIntakeSource.findMany({
      where: { clubId: COULEE_RIDGE_CLUB_ID, ingestedDocumentId: { in: docs.map((d) => d.id) } },
      select: { ingestedDocumentId: true },
    })).map((s) => s.ingestedDocumentId).filter((id): id is string => !!id),
  );
  const eligible = docs.filter((d) => !linkedDocIds.has(d.id));

  const perRow: Report["perRow"] = [];
  let reclassified = 0, materialised = 0, skipped = 0;

  for (const doc of eligible) {
    // Attachment context (required for ApIntakeSource + WI provenance).
    const att = await prisma.emailAttachment.findFirst({
      where: { id: doc.sourceReferenceId ?? "" },
      select: { id: true, emailMessageId: true, emailMessage: { select: { clubId: true } } },
    });
    if (!att || !att.emailMessage || att.emailMessage.clubId !== COULEE_RIDGE_CLUB_ID) {
      perRow.push({
        docIdSuffix: doc.id.slice(-8),
        filename: doc.filename,
        outcome: "no_attachment_context",
      });
      skipped++;
      continue;
    }
    // Reclassify if the mime-default rule now applies.
    if (doc.classification !== "INVOICE") {
      await prisma.ingestedDocument.update({
        where: { id: doc.id },
        data: {
          classification: "INVOICE",
          classificationSource: "RULE",
          classificationRuleKey: "mime.pdf_or_image_default_invoice",
        },
      });
      reclassified++;
    }
    try {
      const result = await materialiseSingleInvoiceDocument({
        clubId: COULEE_RIDGE_CLUB_ID,
        ingestedDocumentId: doc.id,
        sourceContext: {
          emailAttachmentId: att.id,
          emailMessageId: att.emailMessageId,
        },
      });
      perRow.push({
        docIdSuffix: doc.id.slice(-8),
        filename: doc.filename,
        outcome: "materialised",
        intakeIdSuffix: result.intakeId.slice(-8),
        relationship: result.apIntakeSourceRelationship ?? null,
        findingsCreated: result.findingsCreated,
      });
      materialised++;
    } catch (e) {
      perRow.push({
        docIdSuffix: doc.id.slice(-8),
        filename: doc.filename,
        outcome: "materialise_error",
        reason: (e as Error).message?.slice(0, 200),
      });
      skipped++;
    }
  }

  const report: Report = {
    ok: true, scanned: docs.length, eligible: eligible.length,
    reclassified, materialised, skipped, perRow,
  };
  logger.info("admin.rematerialize.completed", {
    scanned: docs.length, eligible: eligible.length,
    reclassified, materialised, skipped,
  });
  return NextResponse.json(report);
}

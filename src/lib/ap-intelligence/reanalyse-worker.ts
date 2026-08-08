// Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — AP_INVOICE_REANALYSE
// worker handler.
//
// Founder amendment #5: OCR completion must update canonical
// analysis without requiring Mission Control to render.
//
// Flow:
//   1. OCR worker persists row → transitions to SUCCEEDED
//   2. OCR worker enqueues AP_INVOICE_REANALYSE for the document
//   3. This handler:
//        - clears the ApIntakeSource cache-buster (analysisVersion=null)
//        - calls analyseIngestedInvoice once for each linked intake
//        - the analyser now reads the fresh OCR row via canonical merge
//        - projection cache invalidates on next render
//   4. If no ApIntakeSource exists yet (edge race), the handler is a
//      no-op and returns SKIPPED_NO_INTAKE. The intake materialiser
//      will pick up the OCR row when the intake is created.
//
// Idempotent by design. Safe to enqueue multiple times.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";

export interface ApInvoiceReanalysePayload {
  clubId: string;
  ingestedDocumentId: string;
  triggerSource: "ocr" | "manual";
}

export interface ApInvoiceReanalyseResult {
  outcome: "REANALYSED" | "SKIPPED_NO_INTAKE" | "SKIPPED_DOC_MISSING";
  intakeCount: number;
  clubId: string;
}

export async function runAPInvoiceReanalyseJob(args: {
  jobId: string;
  payload: ApInvoiceReanalysePayload;
}): Promise<ApInvoiceReanalyseResult> {
  const { clubId, ingestedDocumentId, triggerSource } = args.payload;

  // Verify the document still exists + belongs to this club.
  const doc = await prisma.ingestedDocument.findFirst({
    where: { id: ingestedDocumentId, clubId },
    select: { id: true },
  });
  if (!doc) {
    return { outcome: "SKIPPED_DOC_MISSING", intakeCount: 0, clubId };
  }

  // Locate every ApIntakeSource referencing this document.
  const sources = await prisma.apIntakeSource.findMany({
    where: { clubId, ingestedDocumentId },
    select: { canonicalApIntakeId: true },
  });
  const intakeIds = Array.from(new Set(sources.map((s) => s.canonicalApIntakeId).filter(Boolean))) as string[];

  if (intakeIds.length === 0) {
    logger.info("ap-intelligence.reanalyse.skip_no_intake", {
      clubId, docIdTail: ingestedDocumentId.slice(-6), triggerSource,
    });
    return { outcome: "SKIPPED_NO_INTAKE", intakeCount: 0, clubId };
  }

  // Clear analysisVersion so the next projection render re-invokes
  // the analyser. The analyser now reads the fresh OCR row via the
  // canonical merge path — no browser refresh required.
  //
  // Amendment #5 also mandates that OCR completion produces a fresh
  // canonical analysis without waiting for a render. The projection
  // cache-invalidation itself is not enough for that; we additionally
  // touch updatedAt so any consumer polling the intake list sees the
  // new state and can trigger re-render on its own cadence.
  const now = new Date();
  await prisma.workIntakeItem.updateMany({
    where: { id: { in: intakeIds }, clubId },
    data: { analysisVersion: null, updatedAt: now },
  });

  logger.info("ap-intelligence.reanalyse.updated", {
    clubId, docIdTail: ingestedDocumentId.slice(-6),
    triggerSource, intakeCount: intakeIds.length,
  });

  return { outcome: "REANALYSED", intakeCount: intakeIds.length, clubId };
}

/** Idempotency key producer — shared with the enqueue call site. */
export function apInvoiceReanalyseIdempotencyKey(args: {
  clubId: string;
  ingestedDocumentId: string;
}): string {
  return `ap-reanalyse:${args.clubId}:${args.ingestedDocumentId}`;
}

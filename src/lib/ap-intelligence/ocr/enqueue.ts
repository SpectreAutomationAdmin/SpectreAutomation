// Sprint 3 · Checkpoint 15X continuation (2026-07-29) — OCR job enqueue.
//
// This is the ONLY module the strategy router calls to request a
// paid OCR extraction. It:
//
//   1. Looks up the persisted extraction for (clubId, sha, provider,
//      version). If present, returns its status (no enqueue).
//   2. Otherwise creates a PENDING row idempotently (DB unique
//      constraint) and enqueues one AP_DOCUMENT_OCR job with a
//      matching idempotencyKey (queue-level unique constraint).
//
// Founder §4: same identity → at most one job + one paid call.
// Founder §11: browser render never touches this module directly —
// callers are the strategy router (invoked during analysis) and
// tests. The worker resolves the job by DocumentOcrExtraction.id.

import { enqueue } from "@/lib/queue";
import { logger } from "@/lib/observability/logger";
import {
  createOrReturnPendingExtraction,
  findOcrExtraction,
  ocrIdempotencyKey,
  type OcrExtractionRow,
} from "./persistence";
import {
  OCR_EXTRACTION_VERSION,
  OCR_PROVIDER_ID_AWS_TEXTRACT,
  OCR_PROVIDER_API_ANALYZE_EXPENSE,
  isOcrEnabled,
  resolveTextractRegion,
} from "./config";
import type { DocumentClass } from "../document-class";

export interface RequestOcrArgs {
  clubId: string;
  ingestedDocumentId: string;
  documentSha256: string;
  documentClass: DocumentClass;
  strategy: string;
}

export interface RequestOcrResult {
  ok: true;
  row: OcrExtractionRow;
  enqueued: boolean;
  reason: "already_persisted" | "already_pending" | "enqueued_new" | "ocr_disabled";
}

/**
 * Request an OCR extraction, idempotently.
 *
 *   - Returns immediately with the existing row when persisted.
 *   - Returns immediately when OCR is disabled (SPECTRE_OCR_PROVIDER
 *     is unset) — a PENDING row is still created so the projection
 *     can render truthfully "extraction pending" without ever seeing
 *     a paid call.
 *   - Enqueues one worker job on first request; concurrent callers
 *     race on the DB unique constraint and both end up returning
 *     the same row without duplicating the job.
 */
export async function requestOcrExtraction(args: RequestOcrArgs): Promise<RequestOcrResult> {
  const provider = OCR_PROVIDER_ID_AWS_TEXTRACT;
  const providerApi = OCR_PROVIDER_API_ANALYZE_EXPENSE;
  const region = resolveTextractRegion();

  const existing = await findOcrExtraction({
    clubId: args.clubId,
    documentSha256: args.documentSha256,
    provider,
    extractionVersion: OCR_EXTRACTION_VERSION,
  });
  if (existing) {
    if (existing.status === "SUCCEEDED" || existing.status === "FAILED_TERMINAL") {
      return { ok: true, row: existing, enqueued: false, reason: "already_persisted" };
    }
    return { ok: true, row: existing, enqueued: false, reason: "already_pending" };
  }

  const { row, created } = await createOrReturnPendingExtraction({
    clubId: args.clubId,
    ingestedDocumentId: args.ingestedDocumentId,
    documentSha256: args.documentSha256,
    documentClass: args.documentClass,
    strategy: args.strategy,
    provider,
    providerApi,
    providerRegion: region.ok ? region.region : null,
  });

  if (!created) {
    // A concurrent writer inserted the row; do not enqueue a
    // duplicate — the DB uniqueness proves the other writer either
    // already enqueued or is about to.
    return { ok: true, row, enqueued: false, reason: "already_pending" };
  }

  if (!isOcrEnabled()) {
    // Row persisted PENDING; no worker call queued. Projection
    // renders honest "pending" state. Flipping the env var later
    // will let the worker pick up the row on its next queue tick.
    logger.info("ap-intelligence.ocr.enqueue.disabled", {
      extractionRowIdTail: row.id.slice(-8),
      clubId: args.clubId,
    });
    return { ok: true, row, enqueued: false, reason: "ocr_disabled" };
  }

  const idempotencyKey = ocrIdempotencyKey({
    clubId: args.clubId,
    documentSha256: args.documentSha256,
    provider,
    extractionVersion: OCR_EXTRACTION_VERSION,
  });
  await enqueue({
    kind: "AP_DOCUMENT_OCR",
    queue: "default",
    clubId: args.clubId,
    payload: { extractionRowId: row.id },
    idempotencyKey,
    maxAttempts: 3,
  });
  logger.info("ap-intelligence.ocr.enqueue.new", {
    extractionRowIdTail: row.id.slice(-8),
    clubId: args.clubId,
    documentClass: args.documentClass,
    strategy: args.strategy,
  });
  return { ok: true, row, enqueued: true, reason: "enqueued_new" };
}

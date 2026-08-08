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
  /** Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — page-level dispatch.
   *  `0` = whole-document (pre-5.1 semantics); `≥1` = specific page.
   *  Router callers should pass the target page for targeted OCR
   *  extractions and rely on the page-splitter to hand the worker
   *  the correct single-page byte payload. */
  pageNumber?: number;
  /** Optional targeted-region identifier for future region-scoped
   *  extractions. Preserved on the persisted row for provenance. */
  regionKey?: string | null;
  /** Human-readable trigger reason (from ocr-trigger-reasons.ts)
   *  captured for diagnostics only. Never controls provider dispatch. */
  triggerReason?: string;
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
  const pageNumber = args.pageNumber ?? 0;

  const existing = await findOcrExtraction({
    clubId: args.clubId,
    documentSha256: args.documentSha256,
    provider,
    extractionVersion: OCR_EXTRACTION_VERSION,
    pageNumber,
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
    pageNumber,
    regionKey: args.regionKey ?? null,
  });

  if (!created) {
    return { ok: true, row, enqueued: false, reason: "already_pending" };
  }

  if (!isOcrEnabled()) {
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
    pageNumber,
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
    pageNumber,
    triggerReason: args.triggerReason ?? null,
  });
  return { ok: true, row, enqueued: true, reason: "enqueued_new" };
}

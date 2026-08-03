// Sprint 3 · Checkpoint 15X (2026-07-30) — deterministic extraction
// strategy router.
//
// Sprint 3 · Checkpoint 15X continuation (2026-07-29) — REBUILT so
// no browser render can invoke a paid OCR provider.
//
// Founder rules covered:
//   §1  Text-healthy docs → EMBEDDED_TEXT, no OCR ever.
//   §2  When OCR is required, the router asks the OCR subsystem for
//       a persisted extraction. If missing/pending, it enqueues one
//       worker job (idempotent) and returns without invoking a
//       provider. The worker (bin/worker.ts) is the ONLY code path
//       that talks to Textract.
//   §4  Idempotency is enforced at the persistence layer (DB unique
//       constraint) AND at the queue layer (idempotencyKey).
//   §11 Cache invalidation — when the worker persists SUCCEEDED,
//       the projection cache's docOcrRevision axis flips and the
//       next render surfaces the canonical extraction.

import { assessPdfExtraction, type PdfExtractionAssessment } from "../document-class";
import { extractPdfLayout, type PdfLayout } from "../pdf-layout-extract";
import { normalizeTextractExpense } from "./textract-to-canonical";
import type { CanonicalDocumentExtraction, DocumentExtractionStrategy } from "./canonical-model";
import { logger } from "@/lib/observability/logger";
import { createHash } from "node:crypto";
import { requestOcrExtraction } from "../ocr/enqueue";
import { findLatestOcrExtractionForDocument, readCanonicalFromRow, type OcrExtractionRow } from "../ocr/persistence";
import { recordOcrDuplicatePrevented } from "../ocr/telemetry";
import type { AnalyzeExpenseCommandOutput } from "@aws-sdk/client-textract";

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export interface StrategyRouterInput {
  bytes: Buffer;
  mimeType: string;
  // Optional context for the enqueue path. When absent, the router
  // still assesses the document but will NOT enqueue OCR (tests and
  // ad-hoc callers that lack tenant + document context).
  clubId?: string;
  ingestedDocumentId?: string;
  documentSha256?: string;
  correlationHash?: string;
}

export type OcrRequestStatus =
  | "NOT_REQUIRED"    // document is text-healthy; OCR would be waste
  | "NOT_ENQUEUED"    // router lacks the clubId/docId/sha context needed to enqueue
  | "PENDING"         // persisted PENDING or PROCESSING row exists
  | "SUCCEEDED"       // persisted SUCCEEDED row read from DB
  | "FAILED_TERMINAL" // persisted terminal row (permission denied, etc.)
  | "FAILED_RETRYABLE"// persisted retryable row awaiting next retry
  | "UNREADABLE";     // ENCRYPTED / UNSUPPORTED — OCR would not help

export interface StrategyRouterResult {
  strategy: DocumentExtractionStrategy;
  assessment: PdfExtractionAssessment;
  layout: PdfLayout | null;
  canonicalExtraction: CanonicalDocumentExtraction | null;
  ocrRequestStatus: OcrRequestStatus;
  ocrExtractionRowId: string | null;
  // Provider call counters for tests / diagnostics. The router
  // itself never invokes Textract in this build — always 0.
  ocrProviderCallsThisTurn: 0;
}

export async function runDocumentExtractionStrategy(input: StrategyRouterInput): Promise<StrategyRouterResult> {
  const correlationHash = input.correlationHash
    ?? createHash("sha256").update(input.bytes).digest("hex").slice(0, 16);

  // Step 1 — layout + text extraction (Strategies A + B combined:
  // pdf-layout-extract runs both flat text AND positioned items).
  let layout: PdfLayout | null = null;
  let layoutError: string | null = null;
  try {
    layout = await extractPdfLayout(input.bytes);
  } catch (e) {
    layoutError = (e as Error).message;
  }

  // Step 2 — assess document class.
  const positionedItemCount = layout?.items.length ?? 0;
  const positionedTextChars = layout?.items.reduce((s, it) => s + (it.text?.replace(/\s+/g, "").length ?? 0), 0) ?? 0;
  const flattenedText = layout?.flattenedText ?? "";
  const assessment = assessPdfExtraction({
    flattenedText,
    positionedItemCount,
    positionedTextChars,
    pageCount: layout?.pageCount ?? 0,
    parserThrew: !!layoutError,
    parserError: layoutError,
  });

  // Step 3 — route.
  if (assessment.documentClass === "TEXT_HEALTHY") {
    // Sprint 3 · Checkpoint 15Y-Rejected (2026-08-03) — even for
    // TEXT_HEALTHY docs, an earlier analyser call may have detected
    // structural degradation and requested an OCR extraction (see
    // structural-quality escalation in analyse.ts). If a persisted
    // SUCCEEDED extraction exists, use it as an additional evidence
    // source; the analyser will reconcile between flat-text and
    // canonical fields. No new paid provider call is made.
    if (input.clubId && input.ingestedDocumentId && input.documentSha256) {
      const persistedLatest = await findLatestOcrExtractionForDocument({
        clubId: input.clubId,
        ingestedDocumentId: input.ingestedDocumentId,
      });
      if (persistedLatest && persistedLatest.status === "SUCCEEDED") {
        recordOcrDuplicatePrevented({
          clubId: input.clubId,
          extractionRowIdTail: persistedLatest.id.slice(-8),
          reason: "already_persisted",
        });
        return {
          strategy: "AWS_TEXTRACT_EXPENSE",
          assessment,
          layout,
          canonicalExtraction: readCanonicalFromRow(persistedLatest),
          ocrRequestStatus: "SUCCEEDED",
          ocrExtractionRowId: persistedLatest.id,
          ocrProviderCallsThisTurn: 0,
        };
      }
    }
    return {
      strategy: "EMBEDDED_TEXT",
      assessment,
      layout,
      canonicalExtraction: null,
      ocrRequestStatus: "NOT_REQUIRED",
      ocrExtractionRowId: null,
      ocrProviderCallsThisTurn: 0,
    };
  }

  if (assessment.documentClass === "ENCRYPTED" || assessment.documentClass === "UNSUPPORTED") {
    // OCR would not help. Do NOT enqueue.
    return {
      strategy: "UNREADABLE",
      assessment,
      layout,
      canonicalExtraction: null,
      ocrRequestStatus: "UNREADABLE",
      ocrExtractionRowId: null,
      ocrProviderCallsThisTurn: 0,
    };
  }

  // TEXT_FRAGMENTED / IMAGE_ONLY / MIXED — OCR may help.
  //
  // §1 rule: the render path MUST NEVER invoke a paid provider.
  // Instead, we look up the persisted extraction for this document
  // and — if missing — enqueue one worker job. The worker (running
  // in bin/worker.ts) is the sole caller of AWS Textract.

  // Without full context (clubId + docId + sha) we cannot persist a
  // job. This branch protects ad-hoc callers (unit tests without a
  // DB, diagnostic bin scripts).
  if (!input.clubId || !input.ingestedDocumentId || !input.documentSha256) {
    logger.info("ap-intelligence.strategy-router.ocr-context-missing", {
      correlation: correlationHash,
      documentClass: assessment.documentClass,
      hasClubId: !!input.clubId,
      hasDocId: !!input.ingestedDocumentId,
      hasSha: !!input.documentSha256,
    });
    return {
      strategy: "AWS_TEXTRACT_EXPENSE",
      assessment,
      layout,
      canonicalExtraction: null,
      ocrRequestStatus: "NOT_ENQUEUED",
      ocrExtractionRowId: null,
      ocrProviderCallsThisTurn: 0,
    };
  }

  // Read existing extraction first — the common hot path.
  const latest = await findLatestOcrExtractionForDocument({
    clubId: input.clubId,
    ingestedDocumentId: input.ingestedDocumentId,
  });
  if (latest && latest.status === "SUCCEEDED") {
    // §11: no browser refresh triggers the provider — this branch
    // returns the persisted result and records duplicate-prevented
    // telemetry so ops can see how many paid calls were avoided.
    recordOcrDuplicatePrevented({
      clubId: input.clubId,
      extractionRowIdTail: latest.id.slice(-8),
      reason: "already_persisted",
    });
    return {
      strategy: "AWS_TEXTRACT_EXPENSE",
      assessment,
      layout,
      canonicalExtraction: readCanonicalFromRow(latest),
      ocrRequestStatus: "SUCCEEDED",
      ocrExtractionRowId: latest.id,
      ocrProviderCallsThisTurn: 0,
    };
  }

  // No persisted extraction yet. Enqueue one (idempotent).
  const request = await requestOcrExtraction({
    clubId: input.clubId,
    ingestedDocumentId: input.ingestedDocumentId,
    documentSha256: input.documentSha256,
    documentClass: assessment.documentClass,
    strategy: "AWS_TEXTRACT_EXPENSE",
  });

  const status = mapRowToStatus(request.row);
  return {
    strategy: "AWS_TEXTRACT_EXPENSE",
    assessment,
    layout,
    canonicalExtraction: readCanonicalFromRow(request.row),
    ocrRequestStatus: status,
    ocrExtractionRowId: request.row.id,
    ocrProviderCallsThisTurn: 0,
  };
}

function mapRowToStatus(row: OcrExtractionRow): OcrRequestStatus {
  switch (row.status) {
    case "SUCCEEDED": return "SUCCEEDED";
    case "FAILED_TERMINAL": return "FAILED_TERMINAL";
    case "FAILED_RETRYABLE": return "FAILED_RETRYABLE";
    case "PENDING":
    case "PROCESSING":
    default:
      return "PENDING";
  }
}

// -----------------------------------------------------------------------------
// Re-exports retained for backwards compatibility with existing
// import sites in analyse.ts. The router itself no longer calls
// these — they live on for tests and future controlled reprocessing
// flows.
// -----------------------------------------------------------------------------

export type { AnalyzeExpenseCommandOutput };
export { normalizeTextractExpense };

// Sprint 3 · Checkpoint 15X continuation (2026-07-29) — worker-side
// OCR handler.
//
// This is the ONLY code path allowed to invoke a paid OCR provider.
// The web application never enters this file; it runs exclusively
// on the spectre-staging-worker Fly app via bin/worker.ts.
//
// Founder rules covered:
//   §2  Async worker flow — this is the worker.
//   §4  Idempotency — claimPendingForProcessing enforces PENDING →
//       PROCESSING as an atomic conditional update; concurrent
//       workers get null for the losing side.
//   §9  Security — provider bytes never logged; provider response
//       never logged in raw form; sanitized error codes only.
//   §10 Retry — exponential backoff; permission / configuration
//       errors are terminal.
//   §11 Rerun AP intelligence — successful extraction triggers a
//       reset of the WorkIntakeItem.analysisVersion so the next
//       projection render invokes the analyser against the
//       persisted canonical extraction. No browser refresh needed
//       to invoke OCR (already async); a browser refresh after
//       success does NOT re-invoke the provider (see enqueue.ts).
//   §12 Telemetry — every terminal transition records a content-
//       free counter.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { resolveDocumentStorage } from "@/lib/documents/storage";
import {
  claimPendingForProcessing,
  markExtractionRetryable,
  markExtractionSucceeded,
  markExtractionTerminal,
  type OcrExtractionRow,
} from "./persistence";
import {
  OCR_BACKOFF_BASE_MS,
  OCR_BACKOFF_MAX_MS,
  OCR_MAX_ATTEMPTS,
  isOcrEnabled,
  ocrProvider,
} from "./config";
import { runTextractExpense } from "../document-extractors/aws-textract-expense";
import { normalizeTextractExpense } from "../document-extractors/textract-to-canonical";
import type { DocumentClass } from "../document-class";
import { recordOcrCallTelemetry } from "./telemetry";
// Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — page-level dispatch +
// async re-analyse re-enqueue.
import { extractSinglePagePdf, classifySplitError } from "../document-extractors/page-pdf-split";
import { enqueue as enqueueJob } from "@/lib/queue";

export interface OcrJobPayload {
  extractionRowId: string;
}

export interface OcrJobResult {
  extractionRowId: string;
  outcome: "SUCCESS" | "TERMINAL_FAIL" | "RETRYABLE_FAIL" | "SKIPPED_DUPLICATE" | "SKIPPED_DISABLED";
  sanitizedErrorCode: string | null;
}

/**
 * Worker entry point for AP_DOCUMENT_OCR jobs.
 *
 * Called by src/lib/queue/handlers.ts. The queue infrastructure
 * handles job-level retry accounting; this handler handles
 * extraction-row-level state transitions.
 */
export async function runAPDocumentOcrJob(args: {
  jobId: string;
  workerId: string;
  payload: OcrJobPayload;
}): Promise<OcrJobResult> {
  const { extractionRowId } = args.payload;

  // §4 concurrency — atomically claim the row. If another worker is
  // already PROCESSING, or the row is already terminal, exit
  // without touching the provider.
  const claimed = await claimPendingForProcessing({
    id: extractionRowId,
    workerId: args.workerId,
  });
  if (!claimed) {
    const row = await prisma.documentOcrExtraction.findUnique({
      where: { id: extractionRowId },
    });
    logger.info("ap-intelligence.ocr.worker.skip_duplicate", {
      extractionRowIdTail: extractionRowId.slice(-8),
      currentStatus: row?.status ?? "unknown",
    });
    return {
      extractionRowId,
      outcome: "SKIPPED_DUPLICATE",
      sanitizedErrorCode: null,
    };
  }

  const started = Date.now();

  // Provider gate — if OCR is disabled at the worker (env not set),
  // record a terminal failure with a distinct code so operators can
  // see the row without a paid call ever being made.
  if (!isOcrEnabled() || ocrProvider() !== "aws-textract") {
    const row = await markExtractionTerminal({
      id: extractionRowId,
      sanitizedErrorCode: "OCR_PROVIDER_DISABLED",
    });
    recordOcrCallTelemetry({
      clubId: row.clubId,
      extractionRowIdTail: row.id.slice(-8),
      documentClass: row.documentClass,
      outcome: "TERMINAL_FAIL",
      sanitizedErrorCode: "OCR_PROVIDER_DISABLED",
      attempt: row.attemptCount,
      latencyMs: Date.now() - started,
      byteLength: 0,
      pageCount: 0,
      providerRegion: row.providerRegion,
      strategy: row.strategy,
    });
    return {
      extractionRowId,
      outcome: "SKIPPED_DISABLED",
      sanitizedErrorCode: "OCR_PROVIDER_DISABLED",
    };
  }

  // Load the underlying document + fetch bytes.
  const doc = await prisma.ingestedDocument.findFirst({
    where: { id: claimed.ingestedDocumentId, clubId: claimed.clubId },
    select: {
      id: true,
      clubId: true,
      mimeType: true,
      storageBucket: true,
      storageKey: true,
      sha256Hash: true,
    },
  });
  if (!doc) {
    await markExtractionTerminal({
      id: extractionRowId,
      sanitizedErrorCode: "DOCUMENT_MISSING",
    });
    return {
      extractionRowId,
      outcome: "TERMINAL_FAIL",
      sanitizedErrorCode: "DOCUMENT_MISSING",
    };
  }

  const storage = await resolveDocumentStorage({ clubId: doc.clubId });
  const bytes = await storage.get({ storageKey: doc.storageKey });
  if (!bytes) {
    await markExtractionTerminal({
      id: extractionRowId,
      sanitizedErrorCode: "DOCUMENT_BYTES_UNAVAILABLE",
    });
    return {
      extractionRowId,
      outcome: "TERMINAL_FAIL",
      sanitizedErrorCode: "DOCUMENT_BYTES_UNAVAILABLE",
    };
  }
  const rawBuffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  // Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — page-level dispatch.
  // When the persistence row records a specific page (pageNumber ≥ 1),
  // extract that single page into its own PDF byte payload before
  // handing it to Textract. `pageNumber = 0` preserves the pre-5.1
  // whole-document semantics (image-only single-page uploads).
  let buffer: Buffer = rawBuffer;
  if (claimed.pageNumber >= 1 && /pdf$/i.test(doc.mimeType)) {
    try {
      const single = await extractSinglePagePdf(rawBuffer, claimed.pageNumber, doc.sha256Hash);
      buffer = single.bytes;
      logger.info("ap-intelligence.ocr.worker.page_split", {
        extractionRowIdTail: extractionRowId.slice(-8),
        pageNumber: claimed.pageNumber,
        singlePageBytes: single.byteLength,
        sourcePages: single.sourcePageCount,
      });
    } catch (splitErr) {
      const code = classifySplitError(splitErr);
      await markExtractionTerminal({
        id: extractionRowId,
        sanitizedErrorCode: code,
      });
      recordOcrCallTelemetry({
        clubId: claimed.clubId,
        extractionRowIdTail: extractionRowId.slice(-8),
        documentClass: claimed.documentClass,
        outcome: "TERMINAL_FAIL",
        sanitizedErrorCode: code,
        attempt: claimed.attemptCount,
        latencyMs: Date.now() - started,
        byteLength: rawBuffer.length,
        pageCount: 1,
        providerRegion: claimed.providerRegion,
        strategy: claimed.strategy,
      });
      return {
        extractionRowId,
        outcome: "TERMINAL_FAIL",
        sanitizedErrorCode: code,
      };
    }
  }

  // §6 verified input path: AWS Textract AnalyzeExpense sync mode
  // accepts { Document: { Bytes } } for single-page PDF up to 10 MB.
  const providerResult = await runTextractExpense({
    bytes: buffer,
    mimeType: doc.mimeType,
    pageCount: 1,
    correlationHash: doc.sha256Hash.slice(0, 16),
  });

  if (!providerResult.ok) {
    // Classify retryable vs terminal per §10.
    const isRetryable =
      providerResult.code === "PROVIDER_RATE_LIMITED" ||
      providerResult.code === "PROVIDER_TIMEOUT" ||
      providerResult.code === "PROVIDER_INTERNAL_ERROR";
    if (isRetryable) {
      const nextRetryAt = new Date(
        Date.now() + Math.min(
          OCR_BACKOFF_MAX_MS,
          OCR_BACKOFF_BASE_MS * Math.pow(2, claimed.attemptCount - 1),
        ),
      );
      const row = await markExtractionRetryable({
        id: extractionRowId,
        sanitizedErrorCode: providerResult.code,
        nextRetryAt,
        currentAttempt: claimed.attemptCount,
        maxAttempts: OCR_MAX_ATTEMPTS,
      });
      recordOcrCallTelemetry({
        clubId: row.clubId,
        extractionRowIdTail: row.id.slice(-8),
        documentClass: row.documentClass,
        outcome: row.status === "FAILED_TERMINAL" ? "TERMINAL_FAIL" : "RETRYABLE_FAIL",
        sanitizedErrorCode: providerResult.code,
        attempt: row.attemptCount,
        latencyMs: providerResult.latencyMs,
        byteLength: buffer.length,
        pageCount: 1,
        providerRegion: row.providerRegion,
        strategy: row.strategy,
      });
      // Rethrow so the queue-level retry accounting also records the
      // failure (§10 dual accounting: queue-level attempts + row-
      // level attemptCount). The queue's exponential backoff also
      // reschedules the same job id; whichever fires first, the
      // claim gate deduplicates.
      throw new Error(`OCR_RETRYABLE:${providerResult.code}`);
    }
    // Terminal: permission denied, unsupported doc, file too large,
    // multi-page (this checkpoint is sync-only), authentication.
    const row = await markExtractionTerminal({
      id: extractionRowId,
      sanitizedErrorCode: providerResult.code,
    });
    recordOcrCallTelemetry({
      clubId: row.clubId,
      extractionRowIdTail: row.id.slice(-8),
      documentClass: row.documentClass,
      outcome: "TERMINAL_FAIL",
      sanitizedErrorCode: providerResult.code,
      attempt: row.attemptCount,
      latencyMs: providerResult.latencyMs,
      byteLength: buffer.length,
      pageCount: 1,
      providerRegion: row.providerRegion,
      strategy: row.strategy,
    });
    return {
      extractionRowId,
      outcome: "TERMINAL_FAIL",
      sanitizedErrorCode: providerResult.code,
    };
  }

  // Success. Normalize + persist.
  const canonical = normalizeTextractExpense(
    providerResult.response,
    claimed.documentClass as DocumentClass,
  );
  const saved = await markExtractionSucceeded({
    id: extractionRowId,
    canonical,
  });

  // §11 downstream reanalysis — bump the AP intake row so the
  // projection cache (which includes vendorRevision / apInvRevision
  // fingerprints) invalidates. See intelligence-review-intakes.ts
  // for the cache-key axes.
  //
  // The projection cache also includes a new docOcrRevision axis
  // (added in this checkpoint) that bumps automatically off
  // DocumentOcrExtraction.updatedAt — so no explicit invalidate is
  // strictly required, but touching the ApIntakeSource(s) is a
  // belt-and-braces trigger for reviewers watching the feed.
  await maybeTouchApIntakesForDocument({
    clubId: claimed.clubId,
    ingestedDocumentId: claimed.ingestedDocumentId,
  });

  // Sprint 3 · Phase 4 Slice 5.1 (2026-08-08, amendment #5) — eager
  // AP re-analyse. OCR completion must update canonical analysis
  // WITHOUT requiring Mission Control to render. Enqueue a
  // background AP_INVOICE_REANALYSE job idempotently so multiple
  // page-level OCR completions for the same document collapse to
  // one re-analysis.
  try {
    const { apInvoiceReanalyseIdempotencyKey } = await import("../reanalyse-worker");
    await enqueueJob({
      kind: "AP_INVOICE_REANALYSE",
      queue: "default",
      clubId: claimed.clubId,
      payload: {
        clubId: claimed.clubId,
        ingestedDocumentId: claimed.ingestedDocumentId,
        triggerSource: "ocr",
      },
      idempotencyKey: apInvoiceReanalyseIdempotencyKey({
        clubId: claimed.clubId,
        ingestedDocumentId: claimed.ingestedDocumentId,
      }),
      maxAttempts: 3,
    });
    logger.info("ap-intelligence.ocr.worker.reanalyse_enqueued", {
      extractionRowIdTail: saved.id.slice(-8),
      docIdTail: claimed.ingestedDocumentId.slice(-6),
      pageNumber: claimed.pageNumber,
    });
  } catch (reErr) {
    logger.warn("ap-intelligence.ocr.worker.reanalyse_enqueue_failed", {
      extractionRowIdTail: saved.id.slice(-8),
      message: (reErr as Error).message.slice(0, 200),
    });
  }

  recordOcrCallTelemetry({
    clubId: saved.clubId,
    extractionRowIdTail: saved.id.slice(-8),
    documentClass: saved.documentClass,
    outcome: "SUCCESS",
    sanitizedErrorCode: null,
    attempt: saved.attemptCount,
    latencyMs: providerResult.latencyMs,
    byteLength: buffer.length,
    pageCount: 1,
    providerRegion: saved.providerRegion,
    strategy: saved.strategy,
  });

  return {
    extractionRowId,
    outcome: "SUCCESS",
    sanitizedErrorCode: null,
  };
}

/**
 * Touch every canonical AP intake sourced from this document so the
 * projection cache picks up the fresh extraction on the next render.
 * Idempotent, safe to run multiple times.
 */
async function maybeTouchApIntakesForDocument(args: {
  clubId: string;
  ingestedDocumentId: string;
}): Promise<void> {
  // Explicit source links (post-15S).
  const sources = await prisma.apIntakeSource.findMany({
    where: { clubId: args.clubId, ingestedDocumentId: args.ingestedDocumentId },
    select: { canonicalApIntakeId: true },
  });
  const ids = sources.map((s) => s.canonicalApIntakeId);
  if (ids.length === 0) return;
  await prisma.workIntakeItem.updateMany({
    where: { id: { in: ids }, clubId: args.clubId },
    data: {
      // Clearing analysisVersion signals the projection to rerun the
      // analyser next render — which now reads the SUCCEEDED
      // extraction from the DB instead of invoking OCR.
      analysisVersion: null,
      updatedAt: new Date(),
    },
  });
  logger.info("ap-intelligence.ocr.worker.touched_intakes", {
    clubId: args.clubId,
    docIdTail: args.ingestedDocumentId.slice(-6),
    intakeCount: ids.length,
  });
}

// Re-export the payload type so the queue handler can type its input.
export type { OcrJobPayload as APDocumentOcrJobPayload };

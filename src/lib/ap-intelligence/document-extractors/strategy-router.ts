// Sprint 3 · Checkpoint 15X (2026-07-30) — deterministic extraction
// strategy router.
//
// Founder rule §1:
//   Healthy embedded text          → existing text/layout extraction
//   Embedded text, fragmented      → positioned-text extraction
//   No usable text layer, renderable → AWS Textract AnalyzeExpense
//   All supported strategies fail  → truthful unreadable-doc exception
//
// The router NEVER invokes paid OCR for healthy text documents.

import { assessPdfExtraction, type PdfExtractionAssessment } from "../document-class";
import { extractPdfLayout, type PdfLayout } from "../pdf-layout-extract";
import { runTextractExpense, type TextractExpenseResult } from "./aws-textract-expense";
import { normalizeTextractExpense } from "./textract-to-canonical";
import type { CanonicalDocumentExtraction, DocumentExtractionStrategy } from "./canonical-model";
import { logger } from "@/lib/observability/logger";
import { createHash } from "node:crypto";

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export interface StrategyRouterInput {
  bytes: Buffer;
  mimeType: string;
  correlationHash?: string;   // for diagnostics; caller may pass document SHA
}

export interface StrategyRouterResult {
  strategy: DocumentExtractionStrategy;
  assessment: PdfExtractionAssessment;
  layout: PdfLayout | null;
  canonicalExtraction: CanonicalDocumentExtraction | null;
  ocrAttempted: boolean;
  ocrResult: TextractExpenseResult | null;
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
  //   TEXT_HEALTHY  → EMBEDDED_TEXT (no OCR needed; caller uses layout.flattenedText)
  //   TEXT_FRAGMENTED / IMAGE_ONLY / MIXED → try OCR
  //   ENCRYPTED / UNSUPPORTED → do not attempt OCR (won't help)
  const shouldTryOcr =
    assessment.documentClass === "IMAGE_ONLY"
    || assessment.documentClass === "TEXT_FRAGMENTED"
    || assessment.documentClass === "MIXED";

  if (!shouldTryOcr) {
    // Either text is healthy (no OCR needed) OR document is
    // encrypted / unsupported (OCR won't help). Return without
    // canonical extraction — the flat-text / layout path is used
    // by downstream extractors.
    return {
      strategy: assessment.documentClass === "TEXT_HEALTHY" ? "EMBEDDED_TEXT" : "UNREADABLE",
      assessment,
      layout,
      canonicalExtraction: null,
      ocrAttempted: false,
      ocrResult: null,
    };
  }

  // Step 4 — invoke Textract.
  logger.info("ap-intelligence.strategy-router.ocr-required", {
    correlation: correlationHash,
    documentClass: assessment.documentClass,
    pageCount: layout?.pageCount ?? 0,
  });
  const ocrResult = await runTextractExpense({
    bytes: input.bytes,
    mimeType: input.mimeType,
    pageCount: layout?.pageCount ?? 1,
    correlationHash,
  });

  if (!ocrResult.ok) {
    logger.warn("ap-intelligence.strategy-router.ocr-failed", {
      correlation: correlationHash,
      code: ocrResult.code,
      documentClass: assessment.documentClass,
    });
    return {
      strategy: "UNREADABLE",
      assessment,
      layout,
      canonicalExtraction: null,
      ocrAttempted: true,
      ocrResult,
    };
  }

  const canonical = normalizeTextractExpense(ocrResult.response, assessment.documentClass);
  logger.info("ap-intelligence.strategy-router.ocr-ok", {
    correlation: correlationHash,
    confidence: canonical.confidence,
    warningsCount: canonical.warnings.length,
    lineItemsCount: canonical.lineItems.length,
    hasSupplier: !!canonical.fields.supplierName,
    hasTotal: !!canonical.fields.total,
    hasPayableRef: !!canonical.fields.payableReference,
  });

  return {
    strategy: "AWS_TEXTRACT_EXPENSE",
    assessment,
    layout,
    canonicalExtraction: canonical,
    ocrAttempted: true,
    ocrResult,
  };
}

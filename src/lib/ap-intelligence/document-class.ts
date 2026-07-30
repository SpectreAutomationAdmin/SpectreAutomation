// Sprint 3 · Checkpoint 15W (2026-07-30) — document-class
// assessment.
//
// Founder rule §4: characterize the PDF's extractability BEFORE
// running the accounting analyser. Prevents an image-only scan
// from being fed to a text-based extractor that then invents
// vendor / GL from thin air. Founder rule §6 requires distinct
// exception codes for each failure mode:
//
//   ATTACHMENT_PENDING             - not exercised by this module
//   DOCUMENT_TEXT_UNAVAILABLE      - image-only / OCR required
//   DOCUMENT_LAYOUT_UNUSABLE       - flattened stream too fragmented
//                                    to reason about
//   DOCUMENT_ANALYSIS_FAILED       - pdf-parse threw / encrypted
//   SUPPLIER_UNRESOLVED            - extraction OK but no supplier
//   PAYABLE_REFERENCE_UNRESOLVED   - extraction OK but no invoice ref
//   TOTAL_UNRESOLVED               - extraction OK but no total
//   GL_UNSUPPORTED                 - no account has semantic evidence

export type DocumentClass =
  | "TEXT_HEALTHY"
  | "TEXT_FRAGMENTED"
  | "IMAGE_ONLY"
  | "MIXED"
  | "ENCRYPTED"
  | "UNSUPPORTED";

export type DocumentException =
  | "ATTACHMENT_PENDING"
  | "DOCUMENT_TEXT_UNAVAILABLE"
  | "DOCUMENT_LAYOUT_UNUSABLE"
  | "DOCUMENT_ANALYSIS_FAILED"
  | "SUPPLIER_UNRESOLVED"
  | "PAYABLE_REFERENCE_UNRESOLVED"
  | "TOTAL_UNRESOLVED"
  | "GL_UNSUPPORTED";

export interface PdfExtractionAssessment {
  documentClass: DocumentClass;
  textCoverage: number;               // 0..100 — approx characters as fraction of a typical invoice
  layoutCoherence: number;            // 0..100 — positioned-items coverage
  monetarySignalCount: number;        // count of $ / decimal / currency tokens
  identifierSignalCount: number;      // count of invoice-number-like tokens
  fallbackRequired: boolean;          // caller must invoke OCR (Strategy C) or abstain
  exceptions: DocumentException[];
  evidence: string[];
}

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export function assessPdfExtraction(input: {
  flattenedText: string;
  positionedItemCount: number;
  positionedTextChars: number;
  pageCount: number;
  parserThrew: boolean;
  parserError?: string | null;
}): PdfExtractionAssessment {
  const evidence: string[] = [];
  const exceptions: DocumentException[] = [];

  if (input.parserThrew) {
    const isEncryptedHint = /encrypt|password|permission/i.test(input.parserError ?? "");
    evidence.push(`parser-threw:${input.parserError?.slice(0, 60)}`);
    return {
      documentClass: isEncryptedHint ? "ENCRYPTED" : "UNSUPPORTED",
      textCoverage: 0,
      layoutCoherence: 0,
      monetarySignalCount: 0,
      identifierSignalCount: 0,
      fallbackRequired: true,
      exceptions: ["DOCUMENT_ANALYSIS_FAILED"],
      evidence,
    };
  }

  // Character-count coverage — a typical single-page text-based
  // invoice runs 500–2000 characters. Scale to 0..100 with a soft
  // cap so genuinely-populated docs read as fully healthy.
  const chars = input.flattenedText.replace(/\s+/g, "").length;
  const textCoverage = Math.min(100, Math.round((chars / 500) * 100));
  const positionedChars = input.positionedTextChars;
  const layoutCoherence = Math.min(100, Math.round((positionedChars / 500) * 100));

  const monetarySignalCount = (input.flattenedText.match(/[\$€£]\s*\d|\bCA\$|\bUS\$|\bCAD\b|\bUSD\b/g) ?? []).length;
  const identifierSignalCount = (input.flattenedText.match(/\bInvoice\s*(?:#|No\.?|Number)|\bStatement\s*(?:#|No\.?|Number)|\bReference\s*(?:#|No\.?|Number)/gi) ?? []).length;
  evidence.push(`chars:${chars}`, `positionedItems:${input.positionedItemCount}`, `positionedChars:${positionedChars}`, `monetary:${monetarySignalCount}`, `identifier:${identifierSignalCount}`);

  // Image-only — parser succeeded but returned no meaningful text.
  if (chars < 20 && input.positionedItemCount < 5) {
    exceptions.push("DOCUMENT_TEXT_UNAVAILABLE");
    return {
      documentClass: "IMAGE_ONLY",
      textCoverage: 0,
      layoutCoherence: 0,
      monetarySignalCount,
      identifierSignalCount,
      fallbackRequired: true,
      exceptions,
      evidence,
    };
  }

  // Sparse / fragmented — some text but not enough for structured
  // analysis. Downstream extractors may still recover partial info.
  if (chars < 100 || (input.positionedItemCount > 0 && positionedChars < 100)) {
    exceptions.push("DOCUMENT_LAYOUT_UNUSABLE");
    return {
      documentClass: "TEXT_FRAGMENTED",
      textCoverage,
      layoutCoherence,
      monetarySignalCount,
      identifierSignalCount,
      fallbackRequired: true,
      exceptions,
      evidence,
    };
  }

  // Mixed — has both meaningful text AND a page count > text pages
  // (some pages had text, others didn't). Currently we can't know
  // per-page splits without more instrumentation; treat as healthy
  // if character coverage is reasonable.
  if (chars >= 100 && monetarySignalCount === 0 && identifierSignalCount === 0) {
    // Text present but no accounting-shape signals — likely a
    // rendered image with a stray text layer OR a completely
    // unrelated document.
    return {
      documentClass: "MIXED",
      textCoverage,
      layoutCoherence,
      monetarySignalCount,
      identifierSignalCount,
      fallbackRequired: false,
      exceptions,
      evidence,
    };
  }

  return {
    documentClass: "TEXT_HEALTHY",
    textCoverage,
    layoutCoherence,
    monetarySignalCount,
    identifierSignalCount,
    fallbackRequired: false,
    exceptions,
    evidence,
  };
}

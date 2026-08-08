// Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — deterministic
// single-page PDF byte extraction.
//
// Founder amendment #1: page-level OCR dispatch must extract
// OCR-needed pages to deterministic single-page PDF bytes and call
// AnalyzeExpense only for those pages. Mixed PDFs run native
// evidence on digital pages and OCR on scanned/ambiguous pages.
//
// Uses `pdf-lib` for structural PDF surgery. Deterministic: same
// input bytes + same page number → byte-identical output (the sole
// difference vs the source is the mediabox/kids restriction).
//
// No provider calls. No filesystem writes. Safe to invoke from
// both the web tier (for validation) and the worker tier (for the
// actual OCR job body).

import { PDFDocument } from "pdf-lib";

export interface SinglePageExtractionResult {
  bytes: Buffer;
  byteLength: number;
  sourcePageNumber: number;
  sourcePageCount: number;
  sourceSha256Prefix: string;
}

/** Extract page `pageNumber` (1-indexed) from a multi-page PDF as
 *  a fresh single-page PDF byte buffer. Throws on invalid input:
 *  callers should classify the error via `classifySplitError`. */
export async function extractSinglePagePdf(
  sourceBytes: Buffer,
  pageNumber: number,
  sourceSha256Prefix: string,
): Promise<SinglePageExtractionResult> {
  if (pageNumber < 1) throw new Error("PAGE_NUMBER_OUT_OF_RANGE");
  const src = await PDFDocument.load(sourceBytes, { ignoreEncryption: false });
  const sourcePageCount = src.getPageCount();
  if (pageNumber > sourcePageCount) throw new Error("PAGE_NUMBER_OUT_OF_RANGE");

  const dst = await PDFDocument.create();
  const [copied] = await dst.copyPages(src, [pageNumber - 1]);
  dst.addPage(copied);
  const outBytes = Buffer.from(await dst.save({ useObjectStreams: false }));

  return {
    bytes: outBytes,
    byteLength: outBytes.length,
    sourcePageNumber: pageNumber,
    sourcePageCount,
    sourceSha256Prefix: sourceSha256Prefix.slice(0, 16),
  };
}

/** Classify an error thrown by `extractSinglePagePdf` into a stable
 *  sanitized code for logging + persistence. */
export function classifySplitError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/encryption|encrypted/i.test(msg)) return "PDF_ENCRYPTED";
  if (/PAGE_NUMBER_OUT_OF_RANGE/.test(msg)) return "PAGE_OUT_OF_RANGE";
  if (/invalid pdf|parse|no PDF header/i.test(msg)) return "PDF_UNPARSEABLE";
  return "PDF_SPLIT_UNKNOWN";
}

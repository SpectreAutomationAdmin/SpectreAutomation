// Sprint 3 Checkpoint 15E (2026-07-24) — Deterministic PDF text
// extraction wrapper.
//
// One responsibility: take a PDF buffer, return its text + page count,
// or a clean DOCUMENT_UNREADABLE outcome. NO OCR, NO LLM.
//
// pdf-parse is the only external dependency. It runs entirely offline
// against the buffer; no network. Extraction failure is a first-class
// outcome — the analyser handles DOCUMENT_UNREADABLE explicitly.

export interface PdfExtractResult {
  ok: boolean;
  reason?: "PDF_PARSE_ERROR" | "EMPTY_TEXT" | "NON_PDF_BYTES";
  numPages: number;
  text: string;
  textLength: number;
}

const PDF_MAGIC = Buffer.from("%PDF-");

export async function extractPdfText(bytes: Buffer): Promise<PdfExtractResult> {
  if (bytes.length < PDF_MAGIC.length || !bytes.slice(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return { ok: false, reason: "NON_PDF_BYTES", numPages: 0, text: "", textLength: 0 };
  }
  try {
    // dynamic import — keeps the pdf-parse init off the boot path for
    // routes that never touch it.
    const mod = await import("pdf-parse");
    const parser = (mod as unknown as { default: (buf: Buffer) => Promise<{ text: string; numpages: number }> }).default;
    const parsed = await parser(bytes);
    const text = typeof parsed.text === "string" ? parsed.text : "";
    if (!text || text.trim().length === 0) {
      return { ok: false, reason: "EMPTY_TEXT", numPages: parsed.numpages ?? 0, text: "", textLength: 0 };
    }
    return {
      ok: true,
      numPages: parsed.numpages ?? 0,
      text,
      textLength: text.length,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "PDF_PARSE_ERROR",
      numPages: 0,
      text: "",
      textLength: 0,
    };
  }
}

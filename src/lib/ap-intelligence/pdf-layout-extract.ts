// Sprint 3 · Checkpoint 15V Addendum-2 (2026-07-30) — coordinate-
// aware PDF text extraction.
//
// pdf-parse's default text output flattens positioned text into
// a single reading-order string, destroying column and header
// layout. Real invoices place the supplier block in the top-right
// (letterhead) and the recipient block on the left (bill-to). A
// flattened stream interleaves them; no regex on the flattened
// text can reliably tell which words belong to which entity.
//
// pdf-parse's `pagerender` hook gives us access to pdf.js's text
// content, including per-item x/y coordinates. This module wraps
// that hook and returns a structured LayoutTextItem[] per page
// plus visual lines reconstructed by y-band clustering.
//
// Deterministic. No LLM. Numeric outputs stable across engines.

import pdfParse from "pdf-parse";

export interface LayoutTextItem {
  text: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutVisualLine {
  page: number;
  y: number;                          // center y of the line
  text: string;                       // items joined in x-order with spaces
  items: LayoutTextItem[];
}

export interface PdfLayout {
  pageCount: number;
  items: LayoutTextItem[];            // every positioned item, in document order
  visualLines: LayoutVisualLine[];    // items grouped by y-band, sorted top-to-bottom
  flattenedText: string;              // fallback: default pdf-parse text output
}

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export async function extractPdfLayout(bytes: Buffer): Promise<PdfLayout> {
  const items: LayoutTextItem[] = [];
  let pageCount = 0;
  let coordsOk = true;

  // pdf-parse's `pagerender` receives a pdf.js page object. We call
  // getTextContent to enumerate every text item + its transform
  // matrix. `it.transform` is a 6-element affine matrix [a,b,c,d,e,f]
  // where (e, f) is the origin of the text run in PDF user space.
  let flattenedText = "";
  try {
    const parsed = await pdfParse(bytes, {
      pagerender: async (pageData: unknown) => {
        try {
          const page = pageData as {
            pageNumber?: number;
            pageIndex?: number;
            getTextContent: (opts?: unknown) => Promise<{
              items: Array<{ str: string; transform: number[]; width?: number; height?: number }>;
            }>;
          };
          const pageNum = page.pageNumber ?? ((page.pageIndex ?? 0) + 1);
          const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
          for (const it of content.items) {
            const t = it.transform ?? [0, 0, 0, 0, 0, 0];
            items.push({
              text: it.str ?? "",
              page: pageNum,
              x: round2(t[4] ?? 0),
              y: round2(t[5] ?? 0),
              width: round2(it.width ?? 0),
              height: round2(it.height ?? 0),
            });
          }
          // Return a text approximation for the default `parsed.text`
          // consumer (used as the fallback flattened source).
          return content.items.map((i) => i.str).join(" ") + "\n";
        } catch (e) {
          coordsOk = false;
          return "";
        }
      },
    });
    flattenedText = parsed.text ?? "";
    pageCount = parsed.numpages ?? 0;
  } catch (e) {
    coordsOk = false;
    // Fallback — plain pdf-parse.
    const parsed = await pdfParse(bytes);
    flattenedText = parsed.text ?? "";
    pageCount = parsed.numpages ?? 0;
  }

  if (!coordsOk || items.length === 0) {
    // Coordinate extraction failed — build visualLines from
    // flattenedText so downstream consumers still have SOMETHING.
    const visualLines = flattenedText.split(/\r?\n/).map((line, idx) => ({
      page: 1,
      y: idx,
      text: line,
      items: [],
    }));
    return { pageCount, items, visualLines, flattenedText };
  }

  const visualLines = clusterVisualLines(items);
  return { pageCount, items, visualLines, flattenedText };
}

// -----------------------------------------------------------------------------
// Cluster positioned items into visual lines by y-band
// -----------------------------------------------------------------------------

const Y_BAND_TOLERANCE = 3.5;   // PDF user-space units; ~1/4 of a typical line height

function clusterVisualLines(items: LayoutTextItem[]): LayoutVisualLine[] {
  if (items.length === 0) return [];
  // Sort primarily by page, then by y DESCENDING (PDF coords are
  // bottom-up, so higher y = top of page), then by x.
  const sorted = [...items].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > Y_BAND_TOLERANCE) return b.y - a.y;
    return a.x - b.x;
  });

  const lines: LayoutVisualLine[] = [];
  let current: LayoutTextItem[] = [];
  let currentY = sorted[0].y;
  let currentPage = sorted[0].page;

  const emit = () => {
    if (current.length === 0) return;
    current.sort((a, b) => a.x - b.x);
    lines.push({
      page: currentPage,
      y: currentY,
      text: joinItemsWithSpacing(current),
      items: current,
    });
    current = [];
  };

  for (const it of sorted) {
    if (it.page !== currentPage) {
      emit();
      currentPage = it.page;
      currentY = it.y;
    } else if (Math.abs(it.y - currentY) > Y_BAND_TOLERANCE) {
      emit();
      currentY = it.y;
    }
    current.push(it);
  }
  emit();
  return lines;
}

// Join items on the SAME visual line using x-distance heuristics:
// small x-gap → concatenate directly (they're the same word run
// that pdf.js split); larger gap → single space; big gap → tab-like
// spacing preserved as multiple spaces so downstream tokenizers can
// still tell that "Suite 800   $150.00" is two columns not one.
function joinItemsWithSpacing(items: LayoutTextItem[]): string {
  if (items.length === 0) return "";
  let out = items[0].text;
  let prevRight = items[0].x + items[0].width;
  for (let i = 1; i < items.length; i++) {
    const it = items[i];
    const gap = it.x - prevRight;
    if (gap < 1) {
      out += it.text;
    } else if (gap < 8) {
      out += (out.endsWith(" ") || it.text.startsWith(" ") ? "" : " ") + it.text;
    } else {
      out += "  " + it.text.trimStart();
    }
    prevRight = it.x + (it.width || 0);
  }
  return out.replace(/\s+/g, " ").trim();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

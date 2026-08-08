// Sprint 3 · Phase 4 Slice 5 (2026-08-07) — coordinate-normalized
// PDF text extraction with glyph-level positioning + per-page
// document-class classification.
//
// Prior versions of this module preserved PDF user-space coordinates
// (bottom-up y) which forced every downstream consumer to remember
// the orientation and inverted their comparisons — the y-inversion
// defect the Slice 5 trace found in positioned-table-reconstruct
// was a direct consequence.
//
// This version normalises to a canonical top-left convention (y = 0
// at page top, growing downward). Downstream reconstructors compare
// y like they would in HTML/CSS. Raw values are preserved on each
// item for provenance.
//
// It also asks pdf.js for uncombined text items so glyph-level runs
// stay separate. That gives the fused-row splitter proper x-position
// evidence to work from, without resorting to proportional character
// splitting as a primary strategy.
//
// Deterministic. No LLM. Numeric outputs stable across engines.

import pdfParse from "pdf-parse";

export interface LayoutTextItem {
  text: string;
  page: number;
  /** Left edge in PDF user-space units (unchanged across versions). */
  x: number;
  /** Top edge in canonical top-left coordinates (0 = top of page,
   *  growing DOWNWARD). This is the field downstream reconstructors
   *  should use for row comparisons. */
  y: number;
  width: number;
  height: number;
  /** Raw PDF user-space baseline y (bottom-up). Preserved so any
   *  future path that needs the original PDF coordinate can recover
   *  it without re-extracting. */
  yBaselineRaw?: number;
  /** Page height in PDF user-space units (for reference). */
  pageHeight?: number;
}

export interface LayoutVisualLine {
  page: number;
  /** Top-left y of the row's band. */
  y: number;
  text: string;
  items: LayoutTextItem[];
}

export type PdfPageClass =
  /** Positioned items sufficient for structural reconstruction. */
  | "DIGITAL_TEXT"
  /** Some positioned items but not enough distinct rows to reconstruct.
   *  Flattened text is likely useful; OCR may still help. */
  | "PARTIAL_TEXT"
  /** Zero positioned items — no exploitable text layer. Requires OCR
   *  to recover line-item structure. */
  | "IMAGE_ONLY";

export interface PdfPageDescriptor {
  page: number;
  pageWidth: number;
  pageHeight: number;
  itemCount: number;
  distinctYBandCount: number;
  pageClass: PdfPageClass;
}

export interface PdfLayout {
  pageCount: number;
  items: LayoutTextItem[];
  visualLines: LayoutVisualLine[];
  flattenedText: string;
  /** Per-page descriptors including document-class routing hint.
   *  Optional to preserve backward compatibility with fixtures that
   *  hand-construct a PdfLayout for testing. Production extraction
   *  always populates this. */
  pages?: PdfPageDescriptor[];
}

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

/** Number of distinct positioned items above which a page is
 *  considered DIGITAL_TEXT. Below this, PARTIAL_TEXT. Zero → IMAGE_ONLY. */
const DIGITAL_TEXT_MIN_ITEMS = 20;
/** Distinct y-bands required alongside item count for DIGITAL_TEXT. */
const DIGITAL_TEXT_MIN_YBANDS = 3;

export async function extractPdfLayout(bytes: Buffer): Promise<PdfLayout> {
  const items: LayoutTextItem[] = [];
  const pageHeights = new Map<number, { width: number; height: number }>();
  let pageCount = 0;
  let coordsOk = true;
  let flattenedText = "";

  try {
    const parsed = await pdfParse(bytes, {
      pagerender: async (pageData: unknown) => {
        try {
          const page = pageData as {
            pageNumber?: number;
            pageIndex?: number;
            getViewport?: (opts: { scale: number }) => { width: number; height: number };
            view?: number[];
            getTextContent: (opts?: unknown) => Promise<{
              items: Array<{ str: string; transform: number[]; width?: number; height?: number }>;
            }>;
          };
          const pageNum = page.pageNumber ?? ((page.pageIndex ?? 0) + 1);

          // Extract page height so we can normalise y to top-left.
          // Prefer getViewport(); fall back to mediabox view[3].
          let pageWidth = 612; // US Letter default
          let pageHeight = 792;
          try {
            const vp = page.getViewport?.({ scale: 1 });
            if (vp && Number.isFinite(vp.width) && Number.isFinite(vp.height)) {
              pageWidth = vp.width;
              pageHeight = vp.height;
            } else if (page.view && page.view.length >= 4) {
              pageWidth = page.view[2] - page.view[0];
              pageHeight = page.view[3] - page.view[1];
            }
          } catch { /* keep defaults */ }
          pageHeights.set(pageNum, { width: pageWidth, height: pageHeight });

          // Ask pdf.js for uncombined text items so glyph-level runs
          // stay separate — the fused-row splitter needs distinct x
          // positions to snap columns without proportional guessing.
          const content = await page.getTextContent({
            normalizeWhitespace: false,
            disableCombineTextItems: true,
          });
          for (const it of content.items) {
            const t = it.transform ?? [0, 0, 0, 0, 0, 0];
            const xRaw = round2(t[4] ?? 0);
            const yBaselineRaw = round2(t[5] ?? 0);
            const itemHeight = round2(it.height ?? 0);
            // Normalise to top-left: top = pageHeight − (baseline + itemHeight).
            // The baseline is where the text sits; itemHeight is
            // ascender extent above the baseline. Text at PDF y=750 on
            // a 792pt page has its top at 792 - 750 - h ≈ 32.
            const yTop = round2(pageHeight - yBaselineRaw - itemHeight);
            items.push({
              text: it.str ?? "",
              page: pageNum,
              x: xRaw,
              y: yTop,
              width: round2(it.width ?? 0),
              height: itemHeight,
              yBaselineRaw,
              pageHeight,
            });
          }
          return content.items.map((i) => i.str).join(" ") + "\n";
        } catch {
          coordsOk = false;
          return "";
        }
      },
    });
    flattenedText = parsed.text ?? "";
    pageCount = parsed.numpages ?? 0;
  } catch {
    coordsOk = false;
    const parsedFallback = await pdfParse(bytes);
    flattenedText = parsedFallback.text ?? "";
    pageCount = parsedFallback.numpages ?? 0;
  }

  if (!coordsOk || items.length === 0) {
    const visualLines = flattenedText.split(/\r?\n/).map((line, idx) => ({
      page: 1,
      y: idx,
      text: line,
      items: [] as LayoutTextItem[],
    }));
    const pages: PdfPageDescriptor[] = [];
    for (let p = 1; p <= Math.max(1, pageCount); p++) {
      pages.push({
        page: p,
        pageWidth: 0,
        pageHeight: 0,
        itemCount: 0,
        distinctYBandCount: 0,
        pageClass: "IMAGE_ONLY",
      });
    }
    return { pageCount, items, visualLines, flattenedText, pages };
  }

  const visualLines = clusterVisualLines(items);

  // Per-page classification. DIGITAL_TEXT requires both a minimum item
  // count and a minimum number of distinct y-bands (a page with 40
  // items all on one line is degenerate).
  const pages: PdfPageDescriptor[] = [];
  const seenPages = new Set<number>();
  for (let p = 1; p <= Math.max(1, pageCount); p++) {
    seenPages.add(p);
    const pageItems = items.filter((it) => it.page === p);
    const pageLines = visualLines.filter((vl) => vl.page === p);
    const dims = pageHeights.get(p) ?? { width: 0, height: 0 };
    let cls: PdfPageClass;
    if (pageItems.length === 0) {
      cls = "IMAGE_ONLY";
    } else if (pageItems.length >= DIGITAL_TEXT_MIN_ITEMS && pageLines.length >= DIGITAL_TEXT_MIN_YBANDS) {
      cls = "DIGITAL_TEXT";
    } else {
      cls = "PARTIAL_TEXT";
    }
    pages.push({
      page: p,
      pageWidth: dims.width,
      pageHeight: dims.height,
      itemCount: pageItems.length,
      distinctYBandCount: pageLines.length,
      pageClass: cls,
    });
  }

  return { pageCount, items, visualLines, flattenedText, pages };
}

// -----------------------------------------------------------------------------
// Cluster positioned items into visual lines by y-band
// -----------------------------------------------------------------------------

const Y_BAND_TOLERANCE = 3.5;

function clusterVisualLines(items: LayoutTextItem[]): LayoutVisualLine[] {
  if (items.length === 0) return [];
  // Sort primary by page, then by y ASCENDING (top-left convention),
  // then by x.
  const sorted = [...items].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > Y_BAND_TOLERANCE) return a.y - b.y;
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

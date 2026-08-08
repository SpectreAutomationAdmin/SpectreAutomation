// Sprint 3 · Checkpoint 15V Addendum-2 (2026-07-30) — layout-region
// clustering.
//
// Groups PDF visual lines into spatial regions based on x-column
// membership + vertical proximity. Real invoices place the supplier
// letterhead in one horizontal band (top-left OR top-right) and
// the recipient bill-to in a DIFFERENT horizontal band. Once we
// separate those bands, entity association becomes trivial: text
// in the same band belongs to the same entity.
//
// Deterministic. Numeric outputs stable across engines.

import type { LayoutVisualLine, LayoutTextItem } from "./pdf-layout-extract";

export type RegionKind =
  | "HEADER"                          // top area of page
  | "SUPPLIER_BLOCK"                  // best-guess supplier letterhead
  | "RECIPIENT_BLOCK"                 // best-guess bill-to / recipient
  | "SUMMARY"                         // totals / invoice # / dates
  | "LINE_ITEMS"                      // description + amount body
  | "FOOTER"                          // page footer
  | "UNKNOWN";

export interface LayoutRegion {
  id: string;
  page: number;
  kind: RegionKind;
  // Bounding box in PDF user space (bottom-left origin).
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  // Confidence in the KIND assignment (0..100).
  kindConfidence: number;
  lines: LayoutVisualLine[];
  // Concatenated text of the region in visual reading order.
  text: string;
  // Rationale for the region + its kind.
  evidence: string[];
}

// -----------------------------------------------------------------------------
// Region detection
// -----------------------------------------------------------------------------

// Vertical gap threshold (in PDF units) that separates two regions.
// A typical line height is ~12 units; blank lines are ~24. We use
// 18 as the boundary — anything larger indicates a section break.
const VERTICAL_GAP_THRESHOLD = 18;

// Horizontal cluster tolerance. Two lines whose x-ranges overlap by
// less than this are treated as separate columns.
const COLUMN_OVERLAP_TOLERANCE = 30;

// Header region — top ~25% of page height (typical invoice
// letterhead territory).
const HEADER_TOP_FRACTION = 0.25;
// Footer region — bottom ~15%.
const FOOTER_BOTTOM_FRACTION = 0.15;

export function detectLayoutRegions(visualLines: LayoutVisualLine[]): LayoutRegion[] {
  if (visualLines.length === 0) return [];
  // Group lines by page. Real invoices we care about are single-page,
  // but a statement PDF may span multiple.
  const byPage = new Map<number, LayoutVisualLine[]>();
  for (const l of visualLines) {
    let list = byPage.get(l.page);
    if (!list) { list = []; byPage.set(l.page, list); }
    list.push(l);
  }
  const regions: LayoutRegion[] = [];
  for (const [pageNum, pageLines] of byPage) {
    regions.push(...detectRegionsOnPage(pageNum, pageLines));
  }
  return regions;
}

function detectRegionsOnPage(page: number, lines: LayoutVisualLine[]): LayoutRegion[] {
  // Compute page bounds from all items.
  const allItems = lines.flatMap((l) => l.items);
  if (allItems.length === 0) return [];
  const pageXMin = Math.min(...allItems.map((i) => i.x));
  const pageXMax = Math.max(...allItems.map((i) => i.x + i.width));
  const pageYMin = Math.min(...allItems.map((i) => i.y));
  const pageYMax = Math.max(...allItems.map((i) => i.y + i.height));
  // Sprint 3 · Phase 4 Slice 5 (2026-08-07) — pdf-layout-extract now
  // emits top-left y coordinates (y=0 at page top, growing downward).
  // Header is the low-y band; footer is the high-y band.
  const headerBoundary = pageYMin + (pageYMax - pageYMin) * HEADER_TOP_FRACTION;
  const footerBoundary = pageYMax - (pageYMax - pageYMin) * FOOTER_BOTTOM_FRACTION;

  // Sort lines top-to-bottom (ascending y under top-left convention).
  const topDown = [...lines].sort((a, b) => a.y - b.y);

  // Split at each vertical gap larger than VERTICAL_GAP_THRESHOLD.
  const bands: LayoutVisualLine[][] = [];
  let currentBand: LayoutVisualLine[] = [];
  let lastY: number | null = null;
  for (const l of topDown) {
    if (lastY != null && l.y - lastY > VERTICAL_GAP_THRESHOLD) {
      if (currentBand.length > 0) bands.push(currentBand);
      currentBand = [];
    }
    currentBand.push(l);
    lastY = l.y;
  }
  if (currentBand.length > 0) bands.push(currentBand);

  // For each band, detect columns by x-clustering.
  const regionSeeds: Array<{ lines: LayoutVisualLine[]; xMin: number; xMax: number; yMin: number; yMax: number }> = [];
  for (const band of bands) {
    const columns = splitBandIntoColumns(band);
    for (const col of columns) {
      const items = col.flatMap((l) => l.items);
      if (items.length === 0) continue;
      regionSeeds.push({
        lines: col,
        xMin: Math.min(...items.map((i) => i.x)),
        xMax: Math.max(...items.map((i) => i.x + i.width)),
        yMin: Math.min(...items.map((i) => i.y)),
        yMax: Math.max(...items.map((i) => i.y + i.height)),
      });
    }
  }

  // Classify each region seed by kind. Kind assignment is heuristic
  // and MUST NOT gate a downstream extractor; every region is
  // returned regardless.
  return regionSeeds.map((seed, idx) => {
    const kind = classifyRegionKind({
      seed, headerBoundary, footerBoundary, pageXMin, pageXMax,
    });
    return {
      id: `p${page}-r${idx}`,
      page,
      kind: kind.kind,
      xMin: round2(seed.xMin),
      xMax: round2(seed.xMax),
      yMin: round2(seed.yMin),
      yMax: round2(seed.yMax),
      kindConfidence: kind.confidence,
      lines: seed.lines,
      text: seed.lines.map((l) => l.text).join("\n"),
      evidence: kind.evidence,
    };
  });
}

// Split a band into columns — lines whose x-ranges don't materially
// overlap belong to different columns.
function splitBandIntoColumns(band: LayoutVisualLine[]): LayoutVisualLine[][] {
  if (band.length <= 1) return [band];
  // Sort by x-start (leftmost first).
  const sorted = [...band].sort((a, b) => {
    const ax = Math.min(...a.items.map((i) => i.x));
    const bx = Math.min(...b.items.map((i) => i.x));
    return ax - bx;
  });
  const columns: LayoutVisualLine[][] = [];
  for (const line of sorted) {
    const items = line.items;
    if (items.length === 0) continue;
    const lineXMin = Math.min(...items.map((i) => i.x));
    const lineXMax = Math.max(...items.map((i) => i.x + i.width));
    // Try to place in an existing column with overlapping x-range.
    const target = columns.find((col) => {
      const colItems = col.flatMap((l) => l.items);
      const colXMin = Math.min(...colItems.map((i) => i.x));
      const colXMax = Math.max(...colItems.map((i) => i.x + i.width));
      const overlap = Math.min(lineXMax, colXMax) - Math.max(lineXMin, colXMin);
      return overlap >= COLUMN_OVERLAP_TOLERANCE;
    });
    if (target) target.push(line);
    else columns.push([line]);
  }
  // Preserve visual reading order within each column (top-down).
  for (const col of columns) {
    col.sort((a, b) => b.y - a.y);
  }
  return columns;
}

// -----------------------------------------------------------------------------
// Region-kind classification
// -----------------------------------------------------------------------------

const RECIPIENT_LABEL_RE = /\b(?:bill\s*to|invoice\s*to|sold\s*to|customer|attention|attn|ship\s*to|deliver\s*to|member\s+(?:name|address)|service\s+(?:address|usage))\b/i;
const SUPPLIER_LABEL_RE = /\b(?:from|remit\s+to|remittance|payments?\s+to|make\s+cheques?\s+payable|sold\s+by|vendor)\b/i;
const SUMMARY_LABEL_RE = /\b(?:invoice\s*(?:number|no\.?|#|date)|due\s+date|amount\s+due|subtotal|invoice\s+total|total\s+amount\s+due|balance\s+(?:due|owing)|statement\s+(?:number|no|#|date))\b/i;
const LINE_ITEM_HEADER_RE = /\b(?:description|item|qty|quantity|unit\s+price|amount|charge)\b/i;
const PHONE_LIKE_RE = /\b(?:1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b|\b1[\s.\-]?800[\s.\-]?\d{3}[\s.\-]?\d{4}\b/;
const WEBSITE_LIKE_RE = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?\/?/i;
const TAX_REG_RE = /\b(?:GST|HST|VAT|BN|EIN|Business\s+Number)\b\s*[:#]?\s*\d{2,}/i;
const CA_POSTAL_RE = /[A-Z]\s{0,3}\d\s{0,3}[A-Z]\s{0,3}\d\s{0,3}[A-Z]\s{0,3}\d/i;
const US_ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;
const STREET_RE = /^\s*\d+\s+[A-Za-z]/;
const PERSON_NAME_RE = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+(?:,\s*[A-Z]{2,6})?$/;

function classifyRegionKind(args: {
  seed: { lines: LayoutVisualLine[]; yMin: number; yMax: number; xMin: number; xMax: number };
  headerBoundary: number;
  footerBoundary: number;
  pageXMin: number;
  pageXMax: number;
}): { kind: RegionKind; confidence: number; evidence: string[] } {
  const { seed, headerBoundary, footerBoundary } = args;
  const text = seed.lines.map((l) => l.text).join("\n");
  const evidence: string[] = [];

  // Position heuristics. Slice 5: top-left y convention — header is
  // the low-y band, footer is the high-y band.
  const inHeader = seed.yMax <= headerBoundary;
  const inFooter = seed.yMin >= footerBoundary;
  if (inHeader) evidence.push("in-header-region");
  if (inFooter) evidence.push("in-footer-region");

  // Label heuristics.
  const isRecipientLabelled = RECIPIENT_LABEL_RE.test(text);
  const isSupplierLabelled = SUPPLIER_LABEL_RE.test(text);
  const isSummaryLabelled = SUMMARY_LABEL_RE.test(text);
  const isLineItemHeader = LINE_ITEM_HEADER_RE.test(text);
  if (isRecipientLabelled) evidence.push("recipient-label-present");
  if (isSupplierLabelled) evidence.push("supplier-label-present");
  if (isSummaryLabelled) evidence.push("summary-label-present");
  if (isLineItemHeader) evidence.push("line-item-header-present");

  // Contact-coherence signals — a business identity block typically
  // contains at least two of: address, phone, website, tax-id.
  const hasPhone = PHONE_LIKE_RE.test(text);
  const hasWebsite = WEBSITE_LIKE_RE.test(text);
  const hasTaxReg = TAX_REG_RE.test(text);
  const hasPostal = CA_POSTAL_RE.test(text) || US_ZIP_RE.test(text);
  const hasStreet = seed.lines.some((l) => STREET_RE.test(l.text));
  const contactSignals = [hasPhone, hasWebsite, hasTaxReg, hasPostal, hasStreet].filter(Boolean).length;
  if (contactSignals > 0) evidence.push(`contact-signals:${contactSignals}`);

  // Person-name signal (recipient hint).
  const hasPersonName = seed.lines.some((l) => PERSON_NAME_RE.test(l.text));
  if (hasPersonName) evidence.push("person-name-present");

  // Classification decision tree.
  if (isRecipientLabelled) {
    return { kind: "RECIPIENT_BLOCK", confidence: 90, evidence };
  }
  if (isSupplierLabelled) {
    return { kind: "SUPPLIER_BLOCK", confidence: 90, evidence };
  }
  if (isLineItemHeader) {
    return { kind: "LINE_ITEMS", confidence: 80, evidence };
  }
  if (inHeader && contactSignals >= 2) {
    return { kind: "SUPPLIER_BLOCK", confidence: 80, evidence };
  }
  if (inHeader && !hasPersonName && (hasStreet || hasPostal)) {
    // A header block that has an address but no person name is a
    // likely supplier letterhead.
    return { kind: "SUPPLIER_BLOCK", confidence: 70, evidence };
  }
  if (inHeader && hasPersonName && (hasStreet || hasPostal)) {
    return { kind: "RECIPIENT_BLOCK", confidence: 70, evidence };
  }
  if (isSummaryLabelled) {
    return { kind: "SUMMARY", confidence: 75, evidence };
  }
  if (inFooter && (hasWebsite || hasPhone)) {
    return { kind: "FOOTER", confidence: 70, evidence };
  }
  if (inHeader) {
    return { kind: "HEADER", confidence: 55, evidence };
  }
  if (inFooter) {
    return { kind: "FOOTER", confidence: 55, evidence };
  }
  return { kind: "UNKNOWN", confidence: 40, evidence };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// -----------------------------------------------------------------------------
// Convenience — pick the highest-confidence supplier region
// -----------------------------------------------------------------------------

export function pickSupplierRegion(regions: LayoutRegion[]): LayoutRegion | null {
  const supplierRegions = regions.filter((r) => r.kind === "SUPPLIER_BLOCK");
  if (supplierRegions.length === 0) {
    // Fall back to any header region that isn't a recipient block.
    const headerRegions = regions.filter(
      (r) => r.kind === "HEADER" && !RECIPIENT_LABEL_RE.test(r.text),
    );
    if (headerRegions.length === 0) return null;
    headerRegions.sort((a, b) => b.kindConfidence - a.kindConfidence);
    return headerRegions[0];
  }
  supplierRegions.sort((a, b) => {
    if (b.kindConfidence !== a.kindConfidence) return b.kindConfidence - a.kindConfidence;
    // Prefer regions higher on the page (larger y).
    return b.yMax - a.yMax;
  });
  return supplierRegions[0];
}

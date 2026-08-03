// Sprint 3 · Checkpoint 15Y-Rejected (2026-08-03) — positioned-
// layout text extraction.
//
// Consumes the PdfLayout produced by pdf-layout-extract (positioned
// items + visual lines) and produces field candidates from
// row/column-aware analysis rather than flattened text substrings.
//
// Used as a rescue path when the flattened text extractor produces
// a structurally-degraded ExtractedInvoice (see structural-quality.ts).
//
// GENERAL logic — no invoice / supplier / filename specificity.

import type { PdfLayout, LayoutVisualLine } from "./pdf-layout-extract";
import { labelDensity, rescueOrganizationFromText } from "./field-quality";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface PositionedFieldCandidate<T> {
  value: T;
  strategy: "positioned_layout";
  page: number;
  region: { x: number; y: number };
  supportingLine: string;   // full visual-line text for diagnostics only
  confidence: number;       // 0-100
  rationale: string;
}

export interface PositionedExtractionResult {
  supplier: PositionedFieldCandidate<string> | null;
  invoiceNumber: PositionedFieldCandidate<string> | null;
  purchaseOrderNumber: PositionedFieldCandidate<string> | null;
  invoiceDate: PositionedFieldCandidate<string> | null;
  totalCandidates: PositionedFieldCandidate<number>[];
}

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

const ORG_SUFFIX_TOKEN = /\b(?:LP|LLP|LLC|L\.L\.C\.|L\.P\.|Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?|Company|Ltd\.?|Limited|GmbH|Group|Holdings|Enterprises|Services|Systems|Solutions|Partners|Association|Society|Foundation|Trust|Bank|Insurance)\b/;

const INV_NUMBER_LABEL = /\b(?:invoice\s*(?:#|no\.?|number)?|inv[-# ]?no|inv[-# ]?#)\b/i;
const PO_NUMBER_LABEL = /\b(?:p\.?o\.?\s*(?:#|no\.?|number)?|purchase\s*order|po\s*#)\b/i;
const INV_DATE_LABEL = /\b(?:invoice\s*date|date)\b/i;
const TOTAL_LABEL = /\b(?:invoice\s*total|amount\s*due|total\s*due|grand\s*total|\btotal\b)\b/i;

const AMOUNT_RE = /([+-]?\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+\.\d{2})/;

export function extractFromPositionedLayout(layout: PdfLayout): PositionedExtractionResult {
  return {
    supplier: findSupplierCandidate(layout),
    invoiceNumber: findLabelledIdentifier(layout, INV_NUMBER_LABEL, "invoice_number"),
    purchaseOrderNumber: findLabelledIdentifier(layout, PO_NUMBER_LABEL, "purchase_order_number"),
    invoiceDate: findLabelledIdentifier(layout, INV_DATE_LABEL, "invoice_date"),
    totalCandidates: findTotalCandidates(layout),
  };
}

// -----------------------------------------------------------------------------
// Supplier — scan visual lines for org-suffix content in the top ~half
// -----------------------------------------------------------------------------

function findSupplierCandidate(layout: PdfLayout): PositionedFieldCandidate<string> | null {
  if (layout.visualLines.length === 0) return null;
  // Determine page height by max y across items.
  const maxY = Math.max(...layout.items.map((i) => i.y), 0);
  const topBand = maxY * 0.6; // top 60% of page height (letterhead region)

  const candidates: Array<{
    line: LayoutVisualLine;
    score: number;
    orgPhrase: string;
  }> = [];

  for (const line of layout.visualLines) {
    if (line.y > topBand) continue;             // skip footer band
    if (line.text.trim().length < 4) continue;
    // Line-density check first.
    const density = labelDensity(line.text);
    if (density > 0.5) continue;
    // Prefer lines containing an org-suffix token.
    if (!ORG_SUFFIX_TOKEN.test(line.text)) continue;
    // Extract just the org phrase.
    const rescued = rescueOrganizationFromText(line.text);
    if (!rescued) continue;

    // Score: prefer higher-in-page (smaller y) lines with contact-
    // adjacent info + low label density.
    const yProximity = 100 * (1 - (line.y / (maxY || 1))); // 100 at top, 0 at bottom
    const suffixBoost = 30;
    const densityPenalty = density * 50;
    const contactAdjacency = hasContactContext(layout, line) ? 20 : 0;
    const score = yProximity + suffixBoost + contactAdjacency - densityPenalty;
    candidates.push({ line, score, orgPhrase: rescued });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return {
    value: best.orgPhrase,
    strategy: "positioned_layout",
    page: best.line.page,
    region: { x: best.line.items[0]?.x ?? 0, y: best.line.y },
    supportingLine: best.line.text.slice(0, 200),
    confidence: Math.min(100, Math.round(best.score)),
    rationale: `positioned_supplier: org-suffix line, y=${best.line.y}, density=${labelDensity(best.line.text).toFixed(2)}, contact-adjacent=${hasContactContext(layout, best.line)}`,
  };
}

/**
 * Does the layout have contact-shape content within a small y-window
 * of `line`? (phone, email, or postal-code) Signals that the line
 * belongs to a supplier / recipient block, not a random org mention.
 */
function hasContactContext(layout: PdfLayout, line: LayoutVisualLine): boolean {
  const yBand = 60; // PDF user-space units
  for (const other of layout.visualLines) {
    if (other === line || other.page !== line.page) continue;
    if (Math.abs(other.y - line.y) > yBand) continue;
    if (/@|\bwww\.|https?:\/\/|\b\d{3}[\s\-]?\d{3}[\s\-]?\d{4}\b|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/.test(other.text)) {
      return true;
    }
  }
  return false;
}

// -----------------------------------------------------------------------------
// Labelled identifier — find a label token, then the value in the same
// visual line (right-of) OR the visual line directly below.
// -----------------------------------------------------------------------------

function findLabelledIdentifier(
  layout: PdfLayout,
  labelRe: RegExp,
  kind: string,
): PositionedFieldCandidate<string> | null {
  const labelLine = layout.visualLines.find((l) => labelRe.test(l.text));
  if (!labelLine) return null;

  // Same-line RIGHT-of-label: for lines with 2+ items, take the item
  // to the right of the label item.
  const labelItem = labelLine.items.find((it) => labelRe.test(it.text));
  if (labelItem) {
    const rightItems = labelLine.items
      .filter((it) => it !== labelItem && it.x > labelItem.x + labelItem.width * 0.5)
      .sort((a, b) => a.x - b.x);
    for (const it of rightItems) {
      const cleaned = it.text.trim().replace(/^[:#]\s*/, "");
      if (cleaned.length >= 2 && !/^(number|no\.?|#|:)$/i.test(cleaned)) {
        return {
          value: cleaned.slice(0, 40),
          strategy: "positioned_layout",
          page: labelLine.page,
          region: { x: it.x, y: it.y },
          supportingLine: labelLine.text.slice(0, 120),
          confidence: 75,
          rationale: `${kind}: right-of-label on same visual line`,
        };
      }
    }
  }

  // BELOW-label: find the visual line immediately below with a value
  // near the same x position as the label.
  const belowLines = layout.visualLines
    .filter((l) => l.page === labelLine.page && l.y > labelLine.y && l.y < labelLine.y + 40)
    .sort((a, b) => a.y - b.y);
  for (const bl of belowLines) {
    for (const it of bl.items) {
      if (labelItem && Math.abs(it.x - labelItem.x) > labelItem.width * 2) continue;
      const cleaned = it.text.trim().replace(/^[:#]\s*/, "");
      if (cleaned.length >= 2 && !labelRe.test(cleaned) && !/^(number|no\.?|#|:)$/i.test(cleaned)) {
        return {
          value: cleaned.slice(0, 40),
          strategy: "positioned_layout",
          page: bl.page,
          region: { x: it.x, y: it.y },
          supportingLine: bl.text.slice(0, 120),
          confidence: 60,
          rationale: `${kind}: below-label at aligned x`,
        };
      }
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Totals — find the RIGHT-most amount that follows a total-label line
// -----------------------------------------------------------------------------

function findTotalCandidates(layout: PdfLayout): PositionedFieldCandidate<number>[] {
  const out: PositionedFieldCandidate<number>[] = [];
  for (const line of layout.visualLines) {
    if (!TOTAL_LABEL.test(line.text)) continue;
    // Amount on the same line — usually right-aligned.
    for (const it of line.items) {
      const m = it.text.match(AMOUNT_RE);
      if (m) {
        const n = Number(m[1].replace(/[,\s$]/g, ""));
        if (Number.isFinite(n) && n > 0) {
          out.push({
            value: n,
            strategy: "positioned_layout",
            page: line.page,
            region: { x: it.x, y: it.y },
            supportingLine: line.text.slice(0, 120),
            confidence: 80,
            rationale: "total: labelled amount on same visual line",
          });
        }
      }
    }
  }
  return out;
}

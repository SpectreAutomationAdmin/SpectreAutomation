// Sprint 3 · Post-16H Phase 4 Slice 3 (2026-08-06) — canonical
// line-item extraction (§7) + arithmetic reconciliation (§8).
//
// This module is a text-first line-item builder. It runs against
// the flat text of a document and identifies:
//   * body rows with a description + amount
//   * quantity × unit price = extension patterns
//   * credit lines (negative amounts)
//   * surcharge / freight / interest / penalty lines
//
// It EXCLUDES summary rows (Subtotal / Tax / Total / GST / PST /
// Balance Due) so those never leak into lineItems.
//
// Positioned-text / Textract table extraction is a Slice 4 add.
// This slice covers text-layer invoices, which are the majority
// of the dev corpus.

import type {
  ExtractedLineItem,
  EvidenceCandidate,
  EvidenceConflict,
} from "./canonical-invoice-evidence";

const SUMMARY_LABELS = /^(Sub[\s-]?total|Tax|GST|HST|PST|QST|TPS|TVQ|VAT|Sales\s+Tax|Balance\s+Due|Amount\s+Due|Total|Grand\s+Total|Invoice\s+Total|Credit\s+Total|Total\s+Due|Total\s+Amount|Remit)/i;

// A line-item row: [ description ... ] [ qty? ] [ unit_price? ] [ extension ] [ currency? ]
// The extension is REQUIRED (that's what makes it a line item).
// Between description and extension there may be quantity and
// unit price, separated by whitespace.
//
// EXTENSION is strict 2-decimal money. UNIT_PRICE allows 1..4
// decimals because per-unit prices routinely use 3-4 decimal
// precision (e.g. fuel per litre "1.4190").
const AMOUNT = /-?\d{1,3}(?:,\d{3})*(?:\.\d{2})|-?\d+\.\d{2}/;
const UNIT_PRICE = /-?\d{1,3}(?:,\d{3})*\.\d{1,4}|-?\d+\.\d{1,4}/;
const QTY_UNIT_PRICE_EXT = new RegExp(
  // capture: description, qty, unit_price, extension
  `^\\s*(.+?)\\s{2,}(\\d+(?:\\.\\d+)?)\\s+(${UNIT_PRICE.source})\\s+(${AMOUNT.source})\\s*(?:CAD|USD|EUR|GBP)?\\s*$`,
);
const DESCRIPTION_EXT_ONLY = new RegExp(
  `^\\s*(.+?)\\s{2,}(${AMOUNT.source})\\s*(?:CAD|USD|EUR|GBP)?\\s*$`,
);

const CREDIT_MARKERS = /\b(credit|rebate|refund|discount|adjust)/i;
const SURCHARGE_MARKERS = /\b(surcharge|delivery|freight|shipping|fuel\s*surcharge|handling)/i;
const INTEREST_MARKERS = /\b(interest|penalty|late\s*fee|finance\s*charge)/i;

export interface LineItemExtractionResult {
  lineItems: ExtractedLineItem[];
  credits: ExtractedLineItem[];
  surcharges: ExtractedLineItem[];
  interestOrPenalty: ExtractedLineItem[];
  conflicts: EvidenceConflict[];
}

export function extractLineItemsFromText(text: string, pageCount: number = 1): LineItemExtractionResult {
  const lineItems: ExtractedLineItem[] = [];
  const credits: ExtractedLineItem[] = [];
  const surcharges: ExtractedLineItem[] = [];
  const interestOrPenalty: ExtractedLineItem[] = [];
  const conflicts: EvidenceConflict[] = [];

  const rows = text.split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    // Never treat a summary label as a line item.
    if (SUMMARY_LABELS.test(line)) continue;

    let matched: {
      description: string;
      quantity: number | null;
      unitPrice: number | null;
      extension: number;
    } | null = null;

    const qmp = line.match(QTY_UNIT_PRICE_EXT);
    if (qmp && qmp[1] && qmp[2] && qmp[3] && qmp[4]) {
      const qty = Number(qmp[2]);
      const unit = Number(qmp[3].replace(/,/g, ""));
      const ext = Number(qmp[4].replace(/,/g, ""));
      if (isFinite(qty) && isFinite(unit) && isFinite(ext)) {
        matched = { description: qmp[1].trim(), quantity: qty, unitPrice: unit, extension: ext };
      }
    }
    if (!matched) {
      const only = line.match(DESCRIPTION_EXT_ONLY);
      if (only && only[1] && only[2]) {
        const ext = Number(only[2].replace(/,/g, ""));
        if (isFinite(ext)) {
          matched = { description: only[1].trim(), quantity: null, unitPrice: null, extension: ext };
        }
      }
    }
    if (!matched) continue;

    // Description sanity — reject pure-numeric or single-char rows.
    if (matched.description.length < 3) continue;
    if (/^[\s\d.,\-]+$/.test(matched.description)) continue;
    // Reject anything ending with a summary-like tail.
    if (SUMMARY_LABELS.test(matched.description)) continue;

    const cand: ExtractedLineItem = {
      description: mkField(matched.description, i + 1),
      quantity: matched.quantity != null ? mkField(matched.quantity, i + 1) : undefined,
      unitPrice: matched.unitPrice != null ? mkField(matched.unitPrice, i + 1) : undefined,
      amount: mkField(matched.extension, i + 1),
    };

    // Classify.
    if (CREDIT_MARKERS.test(matched.description) || matched.extension < 0) {
      cand.isCredit = true;
      credits.push(cand);
    } else if (INTEREST_MARKERS.test(matched.description)) {
      interestOrPenalty.push(cand);
    } else if (SURCHARGE_MARKERS.test(matched.description)) {
      cand.isSurcharge = true;
      surcharges.push(cand);
    } else {
      lineItems.push(cand);
    }

    // §8 quantity × unit price ≈ extension arithmetic check.
    if (matched.quantity != null && matched.unitPrice != null) {
      const expected = round2(matched.quantity * matched.unitPrice);
      if (Math.abs(expected - matched.extension) > 0.02) {
        conflicts.push({
          code: "LINE_ITEMS_DO_NOT_SUM_TO_SUBTOTAL",
          message: `Line "${matched.description.slice(0, 40)}": qty(${matched.quantity})×unit(${matched.unitPrice})=${expected.toFixed(2)} but extension=${matched.extension.toFixed(2)}.`,
          affectedField: "lineItems",
        });
      }
    }

    void pageCount;
  }

  return { lineItems, credits, surcharges, interestOrPenalty, conflicts };
}

/** Sprint 3 · Post-16H Phase 4 Slice 3 (2026-08-06) — line-item
 *  reconciliation. Sums the extension of every non-credit line, adds
 *  surcharges/interest, subtracts credits, and compares to the
 *  claimed subtotal. Returns the delta + conflict if beyond
 *  tolerance. `null` when no line items present. */
export function reconcileLineItems(
  lineItems: ExtractedLineItem[],
  credits: ExtractedLineItem[],
  surcharges: ExtractedLineItem[],
  claimedSubtotal: number | null,
  opts: { toleranceCents?: number } = {},
): { sum: number; delta: number | null; conflict: EvidenceConflict | null } | null {
  if (lineItems.length === 0 && credits.length === 0 && surcharges.length === 0) return null;
  const sum = round2(
    lineItems.reduce((a, l) => a + l.amount.value, 0)
      + surcharges.reduce((a, l) => a + l.amount.value, 0)
      - credits.reduce((a, l) => a + Math.abs(l.amount.value), 0),
  );
  const delta = claimedSubtotal != null ? round2(sum - claimedSubtotal) : null;
  const tol = (opts.toleranceCents ?? 2) / 100;
  const conflict: EvidenceConflict | null =
    claimedSubtotal != null && Math.abs(delta ?? 0) > tol
      ? {
          code: "LINE_ITEMS_DO_NOT_SUM_TO_SUBTOTAL",
          message: `Sum of line extensions (${sum.toFixed(2)}) differs from claimed subtotal (${claimedSubtotal.toFixed(2)}) by ${(delta ?? 0).toFixed(2)}.`,
          affectedField: "lineItems",
        }
      : null;
  return { sum, delta, conflict };
}

function mkField<T>(value: T, lineIndex: number): EvidenceCandidate<T> {
  return {
    value,
    confidence: 75,
    strategy: "EMBEDDED_TEXT",
    ruleKey: "lineitem.text_row",
    region: { page: 1, lineIndex },
    validationStatus: "UNVALIDATED",
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

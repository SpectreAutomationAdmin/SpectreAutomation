// Sprint 3 · Phase 4 Slice 5 (2026-08-07) — the single canonical
// line-item authority.
//
// Founder rule: after Slice 5 there must be ONE line-item authority.
// Canonical evidence, economic-purpose classification, GL ranking,
// Work Intake projection and AP Coding all consume this type — none
// derive line items independently.
//
// Deliberately additive to CanonicalInvoiceEvidence rather than a
// replacement: `evidence.canonicalLineItems` carries the authority
// output; the legacy `evidence.lineItems` (ExtractedLineItem[]) is
// kept as a temporary bridge for consumers not yet migrated, but
// production writers must populate BOTH from the same source.

import type { BoundingRegion } from "./canonical-invoice-evidence";

// -----------------------------------------------------------------------------
// Line-item roles — accounting-relevant classification of each row.
// -----------------------------------------------------------------------------

export type CanonicalLineItemRole =
  /** The primary purchased good or service. Drives economic-purpose
   *  classification. */
  | "PRIMARY_PURCHASE"
  /** A surcharge (fuel surcharge, environmental fee, small-order fee,
   *  tire levy, etc.). Adds to invoice total but is not the primary
   *  purchase itself. */
  | "SURCHARGE"
  /** Delivery / shipping / freight charge. */
  | "FREIGHT"
  /** A credit — reduces invoice total. */
  | "CREDIT"
  /** Explicit discount. */
  | "DISCOUNT"
  /** Interest / finance charge. */
  | "INTEREST"
  /** Penalty / late fee / NSF. */
  | "PENALTY"
  /** Tax component. Should not flow into economic-purpose classification. */
  | "TAX";

// -----------------------------------------------------------------------------
// Source strategy — how the row was reconstructed.
// -----------------------------------------------------------------------------

export type CanonicalLineItemStrategy =
  /** Positioned-text reconstruction from a classic column table. */
  | "POSITIONED_CLASSIC_TABLE"
  /** Positioned-text reconstruction from a category-block statement. */
  | "POSITIONED_CATEGORY_BLOCK"
  /** Positioned-text row with proportional character splitting applied
   *  because pdf.js fused glyphs into a single item that spans multiple
   *  detected column x-centres. Lower-confidence — arithmetic
   *  validation required before commitment. */
  | "POSITIONED_PROPORTIONAL_SPLIT"
  /** Amazon Textract AnalyzeExpense LineItemGroups. Used for pages
   *  classified IMAGE_ONLY. */
  | "TEXTRACT_LINE_ITEM"
  /** Flattened-text fallback (line-items-extract.ts). Used when neither
   *  positioned reconstruction nor OCR produced any items. */
  | "FLATTENED_TEXT_FALLBACK";

export type CanonicalLineItemValidation =
  | "UNVALIDATED"
  | "ARITHMETIC_OK"
  | "ARITHMETIC_MISMATCH"
  | "ARITHMETIC_INSUFFICIENT_DATA";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CanonicalLineItemEvidenceCite {
  kind:
    | "column_header"
    | "column_alignment"
    | "arithmetic_qty_times_unit_equals_extension"
    | "arithmetic_sum_within_subtotal_tolerance"
    | "category_block_label"
    | "surcharge_keyword"
    | "credit_keyword"
    | "interest_keyword"
    | "penalty_keyword"
    | "freight_keyword"
    | "tax_keyword"
    | "textract_expense_line"
    | "flattened_text_row"
    | "wrapped_description_merge"
    | "cross_page_repeated_header"
    | "proportional_character_split";
  detail?: string;
}

export interface CanonicalLineItem {
  /** Human-readable description of the purchased good or service. */
  description: string;
  /** Optional SKU / product code. */
  sku?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unitPrice?: number | null;
  /** Row extension amount. Signed — negative for credits. */
  extension: number;

  /** Tax treatment. */
  taxTreatment?: {
    taxable?: boolean;
    taxType?: string;
    rate?: number;
  };

  /** Accounting-relevant classification of this row. */
  role: CanonicalLineItemRole;

  /** Page + coordinate region. */
  page: number;
  region?: BoundingRegion;

  /** Which reconstruction strategy produced this row. */
  sourceStrategy: CanonicalLineItemStrategy;

  /** Optional provider-reported confidence (Textract 0-100 etc.). */
  providerConfidence?: number;
  /** Spectre's own validation confidence after arithmetic + role checks. */
  validationConfidence: number;
  /** Arithmetic status. */
  arithmetic: CanonicalLineItemValidation;

  /** Evidence citations for downstream diagnostics. */
  evidence: CanonicalLineItemEvidenceCite[];
  /** Human-visible warnings (non-blocking). */
  warnings?: string[];
}

export interface CanonicalLineItemReconciliation {
  primarySum: number;
  surchargeSum: number;
  freightSum: number;
  creditSum: number;
  discountSum: number;
  interestPenaltySum: number;
  taxSumFromLineItems: number;
  /** Sum used against printed subtotal:
   *  primary + surcharge + freight − credit − discount + interest + penalty. */
  reconciledSubtotal: number;
  reconciledTotal: number;
  claimedSubtotal: number | null;
  claimedTax: number | null;
  claimedTotal: number | null;
  subtotalDelta: number | null;
  totalDelta: number | null;
  status:
    | "MATCHES_CLAIMED"
    | "WITHIN_TOLERANCE"
    | "MISMATCH"
    | "NO_LINE_ITEMS"
    | "NO_CLAIMED_TOTALS";
}

// -----------------------------------------------------------------------------
// Role classification — GENERIC. No supplier / SKU / filename specificity.
// -----------------------------------------------------------------------------

const CREDIT_KEYWORDS = /\b(credit|rebate|refund|adjust(?:ment)?|reversal|return)\b/i;
const DISCOUNT_KEYWORDS = /\b(discount|promo|allowance)\b/i;
const SURCHARGE_KEYWORDS =
  /\b(surcharge|environmental\s*fee|handling\s*fee|convenience\s*fee|small[-\s]order\s*fee|fuel\s*surcharge|tire\s*levy|environment(?:al)?\s*levy|eco\s*fee|core\s*charge|shop\s*supplies?)\b/i;
const FREIGHT_KEYWORDS = /\b(freight|shipping|delivery|carriage|transport|courier)\b/i;
const INTEREST_KEYWORDS = /\b(interest|finance\s*charge)\b/i;
const PENALTY_KEYWORDS = /\b(penalty|late\s*fee|late\s*payment|nsf|returned\s*cheque|dishonour)\b/i;
const TAX_KEYWORDS =
  /(?:\b(?:gst|hst|pst|qst|vat|tvq|tps|sales\s*tax|value[-\s]added\s*tax|goods\s+and\s+services\s+tax|harmonized\s+sales\s+tax|provincial\s+sales\s+tax)\b)|(?:G\.S\.T\.|H\.S\.T\.|P\.S\.T\.|Q\.S\.T\.|V\.A\.T\.)/i;

/** Classify a row's accounting role from its description + sign.
 *  Order of precedence:
 *    negative amount OR credit keyword → CREDIT
 *    tax keyword                       → TAX
 *    penalty keyword                   → PENALTY
 *    interest keyword                  → INTEREST
 *    freight keyword                   → FREIGHT
 *    surcharge keyword                 → SURCHARGE
 *    discount keyword                  → DISCOUNT
 *    default                           → PRIMARY_PURCHASE
 */
export function classifyLineItemRole(
  description: string,
  extension: number,
  opts?: { categoryHint?: CanonicalLineItemRole },
): { role: CanonicalLineItemRole; cite: CanonicalLineItemEvidenceCite | null } {
  if (opts?.categoryHint) {
    return { role: opts.categoryHint, cite: { kind: "category_block_label", detail: opts.categoryHint } };
  }
  if (extension < 0 || CREDIT_KEYWORDS.test(description)) {
    return { role: "CREDIT", cite: { kind: "credit_keyword", detail: description.slice(0, 60) } };
  }
  if (TAX_KEYWORDS.test(description)) {
    return { role: "TAX", cite: { kind: "tax_keyword", detail: description.slice(0, 60) } };
  }
  if (PENALTY_KEYWORDS.test(description)) {
    return { role: "PENALTY", cite: { kind: "penalty_keyword", detail: description.slice(0, 60) } };
  }
  if (INTEREST_KEYWORDS.test(description)) {
    return { role: "INTEREST", cite: { kind: "interest_keyword", detail: description.slice(0, 60) } };
  }
  if (FREIGHT_KEYWORDS.test(description)) {
    return { role: "FREIGHT", cite: { kind: "freight_keyword", detail: description.slice(0, 60) } };
  }
  if (SURCHARGE_KEYWORDS.test(description)) {
    return { role: "SURCHARGE", cite: { kind: "surcharge_keyword", detail: description.slice(0, 60) } };
  }
  if (DISCOUNT_KEYWORDS.test(description)) {
    return { role: "DISCOUNT", cite: { kind: "credit_keyword", detail: description.slice(0, 60) } };
  }
  return { role: "PRIMARY_PURCHASE", cite: null };
}

// -----------------------------------------------------------------------------
// Arithmetic validation
// -----------------------------------------------------------------------------

const AMOUNT_TOL = 0.02;

/** Validate qty × unit ≈ extension per row. Returns the arithmetic
 *  status; does NOT fabricate missing values. */
export function validateRowArithmetic(li: CanonicalLineItem): {
  arithmetic: CanonicalLineItemValidation;
  cite: CanonicalLineItemEvidenceCite | null;
} {
  if (li.quantity == null || li.unitPrice == null || li.extension == null) {
    return { arithmetic: "ARITHMETIC_INSUFFICIENT_DATA", cite: null };
  }
  const expected = Math.round(li.quantity * li.unitPrice * 100) / 100;
  const delta = Math.abs(expected - li.extension);
  if (delta <= AMOUNT_TOL) {
    return {
      arithmetic: "ARITHMETIC_OK",
      cite: {
        kind: "arithmetic_qty_times_unit_equals_extension",
        detail: `${li.quantity}×${li.unitPrice}=${expected.toFixed(2)} (Δ${delta.toFixed(2)})`,
      },
    };
  }
  return {
    arithmetic: "ARITHMETIC_MISMATCH",
    cite: {
      kind: "arithmetic_qty_times_unit_equals_extension",
      detail: `${li.quantity}×${li.unitPrice}=${expected.toFixed(2)} vs ext=${li.extension.toFixed(2)} (Δ${delta.toFixed(2)})`,
    },
  };
}

/** Reconcile a set of canonical line items against claimed subtotal /
 *  tax / total. Does NOT modify the input — returns a diagnostic. */
export function reconcileCanonicalLineItems(
  items: CanonicalLineItem[],
  claimed: { subtotal: number | null; tax: number | null; total: number | null },
): CanonicalLineItemReconciliation {
  if (items.length === 0) {
    return {
      primarySum: 0, surchargeSum: 0, freightSum: 0, creditSum: 0,
      discountSum: 0, interestPenaltySum: 0, taxSumFromLineItems: 0,
      reconciledSubtotal: 0, reconciledTotal: 0,
      claimedSubtotal: claimed.subtotal, claimedTax: claimed.tax, claimedTotal: claimed.total,
      subtotalDelta: null, totalDelta: null,
      status: "NO_LINE_ITEMS",
    };
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const sum = (r: CanonicalLineItemRole) =>
    round2(items.filter((i) => i.role === r).reduce((a, i) => a + i.extension, 0));

  const primarySum = sum("PRIMARY_PURCHASE");
  const surchargeSum = sum("SURCHARGE");
  const freightSum = sum("FREIGHT");
  const creditSum = Math.abs(sum("CREDIT"));
  const discountSum = Math.abs(sum("DISCOUNT"));
  const interestPenaltySum = round2(sum("INTEREST") + sum("PENALTY"));
  const taxSumFromLineItems = sum("TAX");

  const reconciledSubtotal = round2(
    primarySum + surchargeSum + freightSum + interestPenaltySum - creditSum - discountSum,
  );
  const taxForTotal = claimed.tax ?? taxSumFromLineItems;
  const reconciledTotal = round2(reconciledSubtotal + taxForTotal);

  const subtotalDelta = claimed.subtotal != null ? round2(reconciledSubtotal - claimed.subtotal) : null;
  const totalDelta = claimed.total != null ? round2(reconciledTotal - claimed.total) : null;

  let status: CanonicalLineItemReconciliation["status"];
  if (claimed.subtotal == null && claimed.total == null) {
    status = "NO_CLAIMED_TOTALS";
  } else if (
    (subtotalDelta == null || Math.abs(subtotalDelta) <= AMOUNT_TOL) &&
    (totalDelta == null || Math.abs(totalDelta) <= AMOUNT_TOL)
  ) {
    status = "MATCHES_CLAIMED";
  } else if (
    (subtotalDelta == null || Math.abs(subtotalDelta) <= Math.max(AMOUNT_TOL * 5, 0.10)) &&
    (totalDelta == null || Math.abs(totalDelta) <= Math.max(AMOUNT_TOL * 5, 0.10))
  ) {
    status = "WITHIN_TOLERANCE";
  } else {
    status = "MISMATCH";
  }
  return {
    primarySum, surchargeSum, freightSum, creditSum, discountSum,
    interestPenaltySum, taxSumFromLineItems,
    reconciledSubtotal, reconciledTotal,
    claimedSubtotal: claimed.subtotal, claimedTax: claimed.tax, claimedTotal: claimed.total,
    subtotalDelta, totalDelta,
    status,
  };
}

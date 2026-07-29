// Sprint 3 · Checkpoint 15Q (2026-07-28) — line-item extraction
// with per-line tax classification.
//
// Founder rule: invoices where SOME lines are taxable and OTHERS
// are exempt (e.g. late-payment penalty + membership dues) must
// reconcile correctly. The pre-15Q extractor at parse-invoice.ts
// pulled description + amount only — no tax rate, no taxable flag —
// so the invoice-wide reconciliation failed on any mixed layout.
//
// This module extracts rows AND classifies each row's tax treatment
// from the row wording + column layout + adjacent rate annotations.
//
// GENERALIZED — no invoice-specific rules, no vendor allowlist, no
// document-shaped fixtures. The classifier reads signals that
// appear across many real invoice layouts.
//
// Sprint 3 · Checkpoint 15T (2026-07-28) — extraction now flows
// through the shared document-layout layer's description→amount
// pairing (associateDescriptionAmounts) FIRST, which handles the
// label-on-line-N + amount-on-line-N+1 layout that pdf-parse
// produces for real invoices. The pre-15T same-line regex remains
// as a fallback so vendor documents that happen to fit that shape
// still parse cleanly.

import { parseDocumentLayout, associateDescriptionAmounts } from "./document-layout";

export type LineTaxTreatment =
  | "taxable"
  | "exempt"
  | "zero_rated"
  | "out_of_scope"
  | "unknown";

export type LineEvidenceKind =
  | "explicit_tax_amount_column"
  | "explicit_tax_rate_column"
  | "penalty_or_finance_charge"
  | "member_dues_language"
  | "exempt_language"
  | "adjacent_tax_group_header"
  | "amount_only";

export interface LineItem {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
  taxRate: number | null;         // percent, e.g. 5 for 5 %
  taxAmount: number | null;
  taxTreatment: LineTaxTreatment;
  evidence: LineEvidenceKind[];
  confidence: number;             // 0..100
  lineNo: number;
}

// -----------------------------------------------------------------------------
// Patterns (generic — never invoice-specific)
// -----------------------------------------------------------------------------

// A line is a plausible ITEM row when it ends with a currency-like
// amount and starts with a non-empty description that isn't a
// summary label. `\d+` (not `\d{1,3}`) allows 4+ digit amounts like
// 6500.00 to match without being truncated to their last 3 digits.
const AMOUNT_TAIL_RE = /([+-]?\$?\s*\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*$/;

// A summary-label row is one whose leading token names a total /
// subtotal / tax / summary line AND ends with a colon or percentage
// before the amount. "Tax return preparation  500.00" is NOT such a
// row — it's a genuine service line. "GST 5 %:  30.00" is.
const SUMMARY_LEADING_RE =
  /^\s*(?:sub[-\s]?total|tax|total|balance\s+due|amount\s+due|invoice\s+total|payment|thank\s+you|please\s+remit|amount\s+enclosed|balance|make\s+cheque|penalty|discount|credit|GST|HST|VAT|QST|PST|charges?|shipping|handling)\b/i;
// The description AFTER the trailing amount is stripped — if it
// ends with `:` or `%` it's a total / summary line.
const SUMMARY_TAIL_RE = /[:%]\s*$/;
function isSummaryRow(line: string, descAfterStrip: string): boolean {
  if (!SUMMARY_LEADING_RE.test(line)) return false;
  return SUMMARY_TAIL_RE.test(descAfterStrip);
}

// Sprint 3 · Checkpoint 15T — strict standalone rollup labels. When a
// description-after-strip is exactly one of these (case-insensitive),
// the row is a subtotal-style rollup, NOT a genuine line item. Applies
// to invoices that place a rollup total in the "line items" band
// (recurring-service statements often do this).
const STRICT_ROLLUP_LABEL_RE =
  /^\s*(?:ongoing\s+charges|pending\s+payments|previous\s+balance|new\s+charges|taxes?\/fees?|taxes\s*(?:and|&)\s*fees|amount\s+due|balance\s+due|balance|total\s+due|invoice\s+total|total\s+amount(?:\s+due)?|subtotal|sub[-\s]?total|credits?|discount|payment)\s*$/i;

// Sprint 3 · Checkpoint 15Q — LABEL-VALUE header line rejects.
// A form-field label with a value on the same line
// ("Invoice Number: A-20260714", "Invoice Date: 2026-06-01",
// "GST/HST 234567891RT0001") produces spurious "amounts" for the
// line-item extractor because the trailing digits satisfy
// AMOUNT_TAIL_RE. These are NEVER line items.
const HEADER_LABEL_RE =
  /^\s*(?:invoice|due|order|customer|po|purchase|reference|ref|member|account|statement|bill\s*to|sold\s*to|ship\s*to|remit|remittance|attn|attention|for|GST|HST|BN|business\s*number|tax\s*(?:registration|id|no)|Vendor\s*id|batch|receipt|voucher|check|cheque)\s*(?:number|no\.?|#|id|date)?\s*[:.]/i;

// A line whose "amount" is actually a date (e.g. 2026 or 2025-12-31)
// or a phone/order token — reject.
const DATE_LIKE_LINE_RE = /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{4}\b\s*$|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/;
const IDLIKE_TAIL_RE = /[-A-Z]\d{4,}\s*$/;

// Row wording that means "not taxable" in Canadian tax practice.
const PENALTY_RE = /\b(?:penalty|late[-\s]?fee|late[-\s]?payment|finance\s+charge|interest|nsf|returned\s+cheque)\b/i;
const EXEMPT_RE = /\b(?:exempt|zero[-\s]?rated|tax[-\s]?exempt|non[-\s]?taxable|out\s+of\s+scope)\b/i;

// Row wording that biases TOWARD taxable — real supplier line
// items. Not a hard rule; scored as one of several signals.
const TAXABLE_LANGUAGE_RE = /\b(?:dues|membership|subscription|fee|service|labour|labor|goods|product|supplies|maintenance|rental|licens[ec]|training|seminar)\b/i;

// Adjacent tax-group header (a table header row saying "Taxable" /
// "Non-taxable" / "GST 5%").
const GROUP_TAXABLE_HEADER_RE = /^\s*(?:taxable(?:\s+items?)?|subject\s+to\s+(?:GST|HST|tax))\b/i;
const GROUP_NON_TAXABLE_HEADER_RE = /^\s*(?:non[-\s]?taxable|not\s+taxed|exempt(?:\s+items?)?)\b/i;

// Column headers hinting at per-row tax fields.
const HEADER_TAX_AMOUNT_RE = /\b(?:tax\s*amount|tax\s*paid|GST\s*amount|HST\s*amount|VAT\s*amount)\b/i;
const HEADER_TAX_RATE_RE = /\b(?:tax\s*rate|rate|GST\s*rate|HST\s*rate|VAT\s*rate)\b/i;

const MAX_ROWS = 64;
const MAX_DESCRIPTION_LEN = 200;

// -----------------------------------------------------------------------------

// Sprint 3 · Checkpoint 15T — classify a description string for the
// per-row tax treatment classifier. Split out of the loop so it can
// be applied to layout-layer-produced rows as well as regex rows.
function classifyLineTax(
  description: string,
  context: { kind: "taxable" | "non_taxable" } | null,
): { treatment: LineTaxTreatment; evidence: LineEvidenceKind[]; confidence: number } {
  const evidence: LineEvidenceKind[] = ["amount_only"];
  let treatment: LineTaxTreatment = "unknown";
  if (context) {
    evidence.push("adjacent_tax_group_header");
    treatment = context.kind === "taxable" ? "taxable" : "exempt";
  }
  if (PENALTY_RE.test(description)) {
    evidence.push("penalty_or_finance_charge");
    treatment = "exempt";
  } else if (EXEMPT_RE.test(description)) {
    evidence.push("exempt_language");
    treatment = "exempt";
  }
  if (treatment === "unknown" && TAXABLE_LANGUAGE_RE.test(description)) {
    treatment = "taxable";
    evidence.push("member_dues_language");
  }
  let confidence = 40;
  if (evidence.includes("explicit_tax_amount_column")) confidence = 90;
  else if (evidence.includes("explicit_tax_rate_column")) confidence = 85;
  else if (evidence.includes("adjacent_tax_group_header")) confidence = 78;
  else if (evidence.includes("penalty_or_finance_charge")) confidence = 82;
  else if (evidence.includes("exempt_language")) confidence = 82;
  else if (evidence.includes("member_dues_language")) confidence = 55;
  return { treatment, evidence, confidence };
}

export function extractLineItems(text: string): LineItem[] {
  const lines = text.split(/\r?\n/);
  const items: LineItem[] = [];
  const consumedLineNos = new Set<number>();
  const groupContext: Array<{ from: number; kind: "taxable" | "non_taxable" }> = [];
  let sawTaxAmountColumn = false;
  let sawTaxRateColumn = false;

  // Sprint 3 · Checkpoint 15T — parse the layout ONCE (reused by
  // both the fallback guard and the layout-first pass below). The
  // fallback loop must NOT emit a garbage description from a line
  // that is ENTIRELY a currency amount ("CA$50.00" → desc="CA"
  // amt=50) — a set of BARE_AMOUNT indices lets the fallback skip
  // those cleanly without preventing the layout pass from using
  // them as the amount half of a cross-line pair.
  const preLayout = parseDocumentLayout(text);
  const bareAmountLineNos = new Set<number>();
  for (const l of preLayout.lines) {
    if (l.kind === "BARE_AMOUNT") bareAmountLineNos.add(l.index);
  }

  for (let i = 0; i < lines.length && items.length < MAX_ROWS; i++) {
    if (consumedLineNos.has(i)) continue;
    // Skip lines that are entirely a currency amount — they belong
    // to a cross-line pair the layout pass will handle.
    if (bareAmountLineNos.has(i)) continue;
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    // Column-header tracking (persists downward).
    if (HEADER_TAX_AMOUNT_RE.test(line)) sawTaxAmountColumn = true;
    if (HEADER_TAX_RATE_RE.test(line)) sawTaxRateColumn = true;

    // Group-context header tracking.
    if (GROUP_TAXABLE_HEADER_RE.test(line)) { groupContext.push({ from: i, kind: "taxable" }); continue; }
    if (GROUP_NON_TAXABLE_HEADER_RE.test(line)) { groupContext.push({ from: i, kind: "non_taxable" }); continue; }

    // Skip label:value header rows ("Invoice Number: X", "Due Date: Y",
    // "GST/HST 234567891RT0001") — the trailing digits are IDs / dates,
    // not amounts.
    if (HEADER_LABEL_RE.test(line)) continue;
    if (IDLIKE_TAIL_RE.test(line)) continue;

    // A candidate line item ends with a currency-like tail.
    const tail = line.match(AMOUNT_TAIL_RE);
    if (!tail) continue;
    const amountStr = tail[1];
    const amount = Number(amountStr.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(amount) || amount === 0) continue;
    // Amounts MUST have a decimal component (real invoice line items
    // carry cents). Bare integers appearing at the end of a line are
    // usually part of an identifier ("PO 4400", "Order #202"), not
    // a monetary value.
    if (!amountStr.includes(".")) continue;

    // Description = everything before the trailing amount.
    const description = line.slice(0, line.length - amountStr.length).trim();
    if (!description || description.length > MAX_DESCRIPTION_LEN) continue;
    // Sprint 3 · Checkpoint 15T — reject descriptions that are too
    // short to be meaningful OR that are just a currency-code
    // residue ("CA" left over from stripping "$50.00" off
    // "CA$50.00").
    if (description.length < 3) continue;
    if (/^(?:CA|US|EUR|GBP|CAD|USD)$/i.test(description)) continue;
    // Skip summary rows: leading token is a summary label AND
    // description ends with `:` or `%`. "Tax return preparation" is
    // a genuine service line even though it starts with "tax".
    if (isSummaryRow(line, description)) continue;
    // Sprint 3 · Checkpoint 15T — strict standalone rollup labels
    // (Ongoing charges / Pending payments / Taxes and Fees / Credits
    // / Balance / Total / Subtotal). These are rollup rows a
    // recurring-service statement lays out with the amount on the
    // same line; the layout layer already filters them out of the
    // description→amount pass, so the fallback must do the same.
    if (STRICT_ROLLUP_LABEL_RE.test(description)) continue;

    // Extract optional qty and unit price from within the description
    // (only when at least two currency-like tokens live in the middle).
    const midTokens = description.match(/(\d+(?:\.\d+)?)\s+\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/);
    const quantity = midTokens ? Number(midTokens[1]) : null;
    const unitPrice = midTokens ? Number(midTokens[2].replace(/[,]/g, "")) : null;

    // Classify tax treatment for THIS row.
    const evidence: LineEvidenceKind[] = ["amount_only"];
    let treatment: LineTaxTreatment = "unknown";
    let taxRate: number | null = null;
    let taxAmount: number | null = null;
    // When a tax-amount column reassigns the row's primary amount,
    // we swap these in place. Otherwise they stay null and the
    // original amount / description win.
    let overrideAmount: number | null = null;
    let overrideDescription: string | null = null;

    // Adjacent group context wins first.
    const context = groupContext.length > 0 ? groupContext[groupContext.length - 1] : null;
    if (context) {
      evidence.push("adjacent_tax_group_header");
      treatment = context.kind === "taxable" ? "taxable" : "exempt";
    }

    // Explicit non-taxable rules override.
    if (PENALTY_RE.test(description)) {
      evidence.push("penalty_or_finance_charge");
      treatment = "exempt";
    } else if (EXEMPT_RE.test(description)) {
      evidence.push("exempt_language");
      treatment = "exempt";
    }

    // If a tax-amount column exists AND the row has TWO trailing
    // amounts, the FIRST is the row's amount + the SECOND is the
    // tax. Our default `amount` was set from `AMOUNT_TAIL_RE` which
    // grabs the LAST amount — so when a tax column is present, we
    // reassign `amount` to the earlier number and `taxAmount` to
    // the trailing number.
    if (sawTaxAmountColumn && treatment === "unknown") {
      const twoAmts = raw.match(/([+-]?\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s+([+-]?\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*$/);
      if (twoAmts) {
        const first = Number(twoAmts[1].replace(/[$,\s]/g, ""));
        const second = Number(twoAmts[2].replace(/[$,\s]/g, ""));
        if (Number.isFinite(first) && Number.isFinite(second) && second >= 0 && second < first) {
          // Correction: reassign amount to the primary (larger)
          // trailing value; tax is the secondary.
          (items as unknown as Array<Record<string, unknown>>).length; // no-op — keep type inference
          // NB: JavaScript closes over `amount`; we need to update
          // it via the emitted item, not this local. Instead
          // rewrite the item below.
          taxAmount = second;
          treatment = "taxable";
          evidence.push("explicit_tax_amount_column");
          // Fix the item's amount by mutating the description to
          // strip the second amount and using the first as amount.
          // Easiest path: re-derive description from raw with BOTH
          // trailing amounts removed.
          const primaryAmountStr = twoAmts[1];
          const descRedone = line.slice(0, line.length - amountStr.length - primaryAmountStr.length).trim().replace(/\s+$/, "");
          // Overwrite the outer `amount` scoped variable via the
          // let alias below. Because this scope closes over a
          // `const amount`, we push into a mutable `overrideAmount`
          // consumed at the item-write step (added below).
          overrideAmount = first;
          overrideDescription = descRedone;
        }
      }
    }
    // If a tax-rate column exists AND the row has an adjacent
    // percentage-looking number, use it.
    if (sawTaxRateColumn && treatment === "unknown") {
      const rateHit = raw.match(/\b(\d{1,2}(?:\.\d{1,2})?)\s*%/);
      if (rateHit) {
        taxRate = Number(rateHit[1]);
        treatment = "taxable";
        evidence.push("explicit_tax_rate_column");
      }
    }

    // If the description contains taxable-language cue, bias toward
    // taxable (only when treatment is still unknown).
    if (treatment === "unknown" && TAXABLE_LANGUAGE_RE.test(description)) {
      // Membership dues / fees language leans taxable in most
      // Canadian invoicing patterns, but we mark as unknown-leaning
      // (the reconciliation step is the authoritative call).
      treatment = "taxable";
      evidence.push("member_dues_language");
    }

    // Confidence — coarse but honest.
    let confidence = 40;
    if (evidence.includes("explicit_tax_amount_column")) confidence = 90;
    else if (evidence.includes("explicit_tax_rate_column")) confidence = 85;
    else if (evidence.includes("adjacent_tax_group_header")) confidence = 78;
    else if (evidence.includes("penalty_or_finance_charge")) confidence = 82;
    else if (evidence.includes("exempt_language")) confidence = 82;
    else if (evidence.includes("member_dues_language")) confidence = 55;

    items.push({
      description: overrideDescription ?? description,
      quantity,
      unitPrice,
      amount: overrideAmount ?? amount,
      taxRate,
      taxAmount,
      taxTreatment: treatment,
      evidence,
      confidence,
      lineNo: i,
    });
    consumedLineNos.add(i);
  }

  // Sprint 3 · Checkpoint 15T — supplemental layout-first pass.
  // Runs AFTER the fallback so it preserves the fallback's group-
  // context + tax-column intelligence. Only picks up description +
  // amount pairs that span line boundaries (label on one line,
  // value on the next) — the founder-observed CPA / OXIO shape.
  if (items.length < MAX_ROWS) {
    const layout = preLayout;
    const layoutPairs = associateDescriptionAmounts(layout, {
      forwardMaxLines: 2,
      excludeDescription: (line) => {
        if (consumedLineNos.has(line.index)) return true;
        if (HEADER_LABEL_RE.test(line.text)) return true;
        if (IDLIKE_TAIL_RE.test(line.text)) return true;
        if (DATE_LIKE_LINE_RE.test(line.text)) return true;
        if (STRICT_ROLLUP_LABEL_RE.test(line.text)) return true;
        return false;
      },
    });
    for (const pair of layoutPairs) {
      if (items.length >= MAX_ROWS) break;
      if (consumedLineNos.has(pair.descriptionLineIndex)) continue;
      if (consumedLineNos.has(pair.amountLineIndex)) continue;
      // Same-line pairs are already handled by the fallback; this
      // supplemental pass focuses on cross-line pairs.
      if (pair.strategy === "same_line") continue;
      const { treatment, evidence, confidence } = classifyLineTax(pair.description, null);
      items.push({
        description: pair.description,
        quantity: null,
        unitPrice: null,
        amount: pair.negative ? -Math.abs(pair.amount) : Math.abs(pair.amount),
        taxRate: null,
        taxAmount: null,
        taxTreatment: treatment,
        evidence,
        confidence: Math.max(confidence, Math.round(pair.confidence * 0.9)),
        lineNo: pair.descriptionLineIndex,
      });
      consumedLineNos.add(pair.descriptionLineIndex);
      consumedLineNos.add(pair.amountLineIndex);
    }
  }

  return items;
}

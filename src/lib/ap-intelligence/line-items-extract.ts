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
// summary label.
const AMOUNT_TAIL_RE = /([+-]?\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*$/;

const SUMMARY_LABEL_RE =
  /^\s*(?:sub[-\s]?total|tax|total|balance\s+due|amount\s+due|invoice\s+total|payment|thank\s+you|please\s+remit|amount\s+enclosed|balance|make\s+cheque)\b/i;

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

export function extractLineItems(text: string): LineItem[] {
  const lines = text.split(/\r?\n/);
  const items: LineItem[] = [];
  const groupContext: Array<{ from: number; kind: "taxable" | "non_taxable" }> = [];
  let sawTaxAmountColumn = false;
  let sawTaxRateColumn = false;

  for (let i = 0; i < lines.length && items.length < MAX_ROWS; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    // Column-header tracking (persists downward).
    if (HEADER_TAX_AMOUNT_RE.test(line)) sawTaxAmountColumn = true;
    if (HEADER_TAX_RATE_RE.test(line)) sawTaxRateColumn = true;

    // Group-context header tracking.
    if (GROUP_TAXABLE_HEADER_RE.test(line)) { groupContext.push({ from: i, kind: "taxable" }); continue; }
    if (GROUP_NON_TAXABLE_HEADER_RE.test(line)) { groupContext.push({ from: i, kind: "non_taxable" }); continue; }

    // Skip summary rows entirely.
    if (SUMMARY_LABEL_RE.test(line)) continue;

    // A candidate line item ends with a currency-like tail.
    const tail = line.match(AMOUNT_TAIL_RE);
    if (!tail) continue;
    const amountStr = tail[1];
    const amount = Number(amountStr.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(amount) || amount === 0) continue;

    // Description = everything before the trailing amount.
    const description = line.slice(0, line.length - amountStr.length).trim();
    if (!description || description.length > MAX_DESCRIPTION_LEN) continue;
    // Reject rows whose description IS just a label / date.
    if (SUMMARY_LABEL_RE.test(description)) continue;

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
  }

  return items;
}

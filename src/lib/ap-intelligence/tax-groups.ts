// Sprint 3 · Checkpoint 15T (2026-07-28) — mixed-tax model.
//
// Founder rule (§9): the analyser must model taxable, exempt,
// zero-rated, out-of-scope subtotals plus credit lines separately.
// This supports (without vendor-specific rules):
//
//   * taxable professional dues plus non-taxable penalties
//   * non-taxable groceries plus taxable delivery/fuel surcharge
//   * credits
//   * mixed-rate invoices
//   * printed totals with unresolved allocation
//
// The founder further rules: DO NOT persist tax groups until
// arithmetic and evidence validation is complete. This module
// computes tax + credit groups IN-MEMORY only; they surface on the
// analyser result but are not written to Prisma this checkpoint.

import type { LineItem, LineTaxTreatment } from "./line-items-extract";

export type TaxTreatment = "TAXABLE" | "EXEMPT" | "ZERO_RATED" | "OUT_OF_SCOPE" | "UNKNOWN";

export interface ApTaxGroup {
  treatment: TaxTreatment;
  rate: number | null;                  // percent, e.g. 5 for 5 %
  subtotal: number;                     // sum of line amounts in this group
  taxAmount: number;                    // computed tax for this group
  lineItemIds: number[];                // lineNo indices in the extracted line array
}

export interface ApCreditGroup {
  amount: number;                       // positive total credit amount
  treatment: "PRE_TAX" | "POST_TAX" | "UNKNOWN";
  lineItemIds: number[];
}

export interface TaxGroupsResult {
  taxGroups: ApTaxGroup[];
  creditGroups: ApCreditGroup[];
  // A quick health flag: whether the tax groups' summed subtotal +
  // computed tax reconciles to the printed subtotal + printed tax
  // (within tolerance). Consumers that plan to persist should verify
  // this before writing.
  validationOk: boolean;
  notes: string[];
}

const TOLERANCE = 0.02;

function toTreatment(t: LineTaxTreatment): TaxTreatment {
  switch (t) {
    case "taxable": return "TAXABLE";
    case "exempt": return "EXEMPT";
    case "zero_rated": return "ZERO_RATED";
    case "out_of_scope": return "OUT_OF_SCOPE";
    default: return "UNKNOWN";
  }
}

export function buildTaxGroups(args: {
  lines: LineItem[];
  printedSubtotal: number | null;
  printedTax: number | null;
}): TaxGroupsResult {
  const { lines, printedSubtotal, printedTax } = args;
  const notes: string[] = [];

  // Split lines into positive (subtotal) and negative (credit).
  const positive = lines.filter((l) => l.amount > 0);
  const negative = lines.filter((l) => l.amount < 0);

  // Group positive by (treatment, rate) — treat null rate as its own
  // bucket per treatment.
  const key = (t: TaxTreatment, r: number | null) => `${t}|${r ?? "null"}`;
  const buckets = new Map<string, ApTaxGroup>();
  for (const l of positive) {
    const t = toTreatment(l.taxTreatment);
    const bucketKey = key(t, l.taxRate);
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { treatment: t, rate: l.taxRate, subtotal: 0, taxAmount: 0, lineItemIds: [] };
      buckets.set(bucketKey, bucket);
    }
    bucket.subtotal = round2(bucket.subtotal + l.amount);
    if (l.taxAmount != null) {
      bucket.taxAmount = round2(bucket.taxAmount + l.taxAmount);
    }
    bucket.lineItemIds.push(l.lineNo);
  }

  // If we have a printed tax total and only ONE taxable bucket with
  // no per-line tax amounts, attribute the printed tax to that bucket.
  const taxable = [...buckets.values()].filter((b) => b.treatment === "TAXABLE");
  if (taxable.length === 1 && taxable[0].taxAmount === 0 && printedTax != null) {
    taxable[0].taxAmount = printedTax;
    // Also compute an implied rate if the subtotal is nonzero.
    if (taxable[0].rate == null && taxable[0].subtotal > 0) {
      const impliedRate = round2((printedTax / taxable[0].subtotal) * 100);
      // Only fill in an implied rate that is plausible (0-30 %).
      if (impliedRate >= 0 && impliedRate <= 30) {
        taxable[0].rate = impliedRate;
      }
    }
  }

  // Credit groups — one per negative line, treatment defaults to
  // UNKNOWN unless the row wording says otherwise (we don't currently
  // classify credits further; UNKNOWN is safe and honest).
  const creditGroups: ApCreditGroup[] = negative.map((l) => ({
    amount: round2(Math.abs(l.amount)),
    treatment: "UNKNOWN",
    lineItemIds: [l.lineNo],
  }));

  // Validation — sum of bucket subtotals must equal printed subtotal
  // (within tolerance) IF a printed subtotal exists; sum of bucket
  // tax amounts must equal printed tax (within tolerance) IF a
  // printed tax exists.
  const summedSubtotal = round2([...buckets.values()].reduce((s, b) => s + b.subtotal, 0));
  const summedTax = round2([...buckets.values()].reduce((s, b) => s + b.taxAmount, 0));
  let validationOk = true;
  if (printedSubtotal != null && Math.abs(summedSubtotal - printedSubtotal) > TOLERANCE) {
    validationOk = false;
    notes.push(
      `Tax-group subtotal ${summedSubtotal.toFixed(2)} does not reconcile with printed subtotal ${printedSubtotal.toFixed(2)} (delta ${(summedSubtotal - printedSubtotal).toFixed(2)}).`,
    );
  }
  if (printedTax != null && Math.abs(summedTax - printedTax) > TOLERANCE) {
    validationOk = false;
    notes.push(
      `Tax-group tax ${summedTax.toFixed(2)} does not reconcile with printed tax ${printedTax.toFixed(2)} (delta ${(summedTax - printedTax).toFixed(2)}).`,
    );
  }
  if (buckets.size === 0 && positive.length > 0) {
    validationOk = false;
    notes.push(`No tax groups formed from ${positive.length} positive line item(s) — treatment classification failed for every row.`);
  }
  if (buckets.size === 0 && positive.length === 0 && printedSubtotal != null) {
    validationOk = false;
    notes.push(`Printed subtotal ${printedSubtotal.toFixed(2)} present but no positive line items extracted — tax groups cannot be constructed.`);
  }

  return {
    taxGroups: [...buckets.values()].sort((a, b) => b.subtotal - a.subtotal),
    creditGroups,
    validationOk,
    notes,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

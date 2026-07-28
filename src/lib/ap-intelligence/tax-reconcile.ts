// Sprint 3 · Checkpoint 15Q (2026-07-28) — mixed-line tax
// reconciliation.
//
// Founder rule: an invoice with SOME taxable lines and SOME
// non-taxable lines (e.g. dues + penalty) must reconcile
// arithmetically. The pre-15Q reconciler treated tax as a single
// invoice-wide guess ("does 5 % of the subtotal ≈ printed tax?")
// and failed on any mixed layout.
//
// Model:
//   taxableSubtotal   = sum of line.amount where treatment=taxable
//   nonTaxableSubtotal = sum of line.amount where treatment ∈
//                        {exempt, zero_rated, out_of_scope}
//   unknownSubtotal   = sum of line.amount where treatment=unknown
//   subtotalDerived   = taxable + nonTaxable + unknown
//
// For a candidate `rate` (usually 5 / 12 / 13 / 15 for Canada):
//   inferredTax = taxableSubtotal × rate / 100
//   arithmetic  = subtotalDerived + inferredTax
//
// A match against the printed `printedTotal` (± 0.02 tolerance)
// reconciles the invoice. When multiple rates match, prefer the
// smallest (invoices commonly use 5 % GST, not 15 % HST, unless
// explicitly labelled).

import type { LineItem } from "./line-items-extract";

export type TaxReconciliationOutcome =
  | "reconciled_single_rate"
  | "reconciled_no_tax"
  | "unresolved_missing_tax"
  | "unresolved_arithmetic_mismatch"
  | "unresolved_no_taxable_lines_but_positive_tax"
  | "unresolved_ambiguous";

export interface TaxReconciliation {
  outcome: TaxReconciliationOutcome;
  taxableSubtotal: number;
  nonTaxableSubtotal: number;
  unknownSubtotal: number;
  inferredTax: number | null;
  inferredRate: number | null;
  printedTax: number | null;
  printedTotal: number | null;
  derivedTotal: number | null;
  message: string;
  actionable: string | null;      // concrete reviewer guidance
}

const CANADA_RATES = [5, 7, 8, 12, 13, 14.975, 15];
const TOLERANCE = 0.02;

export function reconcileTax(args: {
  lines: LineItem[];
  printedSubtotal: number | null;
  printedTax: number | null;
  printedTotal: number | null;
}): TaxReconciliation {
  const taxableSubtotal  = sum(args.lines.filter((l) => l.taxTreatment === "taxable").map((l) => l.amount));
  const nonTaxableSubtotal = sum(args.lines.filter((l) => l.taxTreatment === "exempt" || l.taxTreatment === "zero_rated" || l.taxTreatment === "out_of_scope").map((l) => l.amount));
  const unknownSubtotal  = sum(args.lines.filter((l) => l.taxTreatment === "unknown").map((l) => l.amount));
  const lineSubtotal = round2(taxableSubtotal + nonTaxableSubtotal + unknownSubtotal);

  // Case A: printed tax = 0 or absent, no taxable lines → clean
  // no-tax reconciliation as long as printedTotal ≈ lineSubtotal.
  if ((args.printedTax === null || Math.abs(args.printedTax) < TOLERANCE) && taxableSubtotal === 0) {
    if (args.printedTotal !== null && Math.abs(lineSubtotal - args.printedTotal) <= TOLERANCE) {
      return baseResult({
        outcome: "reconciled_no_tax",
        taxableSubtotal, nonTaxableSubtotal, unknownSubtotal,
        inferredTax: 0, inferredRate: null,
        printedTax: args.printedTax, printedTotal: args.printedTotal,
        derivedTotal: lineSubtotal,
        message: "No taxable lines and no printed tax; totals reconcile.",
        actionable: null,
      });
    }
  }

  // Case B: printed tax > 0 but no taxable lines detected. This is
  // the specific defect the founder called out — sometimes taxable
  // lines are misclassified as unknown. Try promoting unknown →
  // taxable and see if a Canadian rate fits.
  if ((args.printedTax ?? 0) > TOLERANCE && taxableSubtotal < TOLERANCE) {
    const candidateTaxable = unknownSubtotal;
    if (candidateTaxable > TOLERANCE && args.printedTax !== null) {
      const impliedRate = round2((args.printedTax / candidateTaxable) * 100);
      const nearMatch = CANADA_RATES.find((r) => Math.abs(r - impliedRate) < 0.15);
      if (nearMatch) {
        return baseResult({
          outcome: "reconciled_single_rate",
          taxableSubtotal: candidateTaxable, nonTaxableSubtotal, unknownSubtotal: 0,
          inferredTax: args.printedTax, inferredRate: nearMatch,
          printedTax: args.printedTax, printedTotal: args.printedTotal,
          derivedTotal: round2(candidateTaxable + nonTaxableSubtotal + args.printedTax),
          message: `Reconciled at ${nearMatch} % against unknown-classified lines totalling ${candidateTaxable.toFixed(2)}.`,
          actionable: "Confirm the unknown lines are subject to the identified rate.",
        });
      }
      return baseResult({
        outcome: "unresolved_no_taxable_lines_but_positive_tax",
        taxableSubtotal, nonTaxableSubtotal, unknownSubtotal,
        inferredTax: args.printedTax, inferredRate: impliedRate,
        printedTax: args.printedTax, printedTotal: args.printedTotal,
        derivedTotal: lineSubtotal,
        message: `Printed tax ${args.printedTax.toFixed(2)} implies rate ${impliedRate.toFixed(2)} % against ${candidateTaxable.toFixed(2)} unclassified lines — outside the accepted set (${CANADA_RATES.join(", ")}).`,
        actionable: "Identify the taxable lines manually before posting.",
      });
    }
  }

  // Case C: taxable lines exist. Try each Canadian rate.
  if (taxableSubtotal > TOLERANCE) {
    for (const rate of CANADA_RATES) {
      const inferredTax = round2((taxableSubtotal * rate) / 100);
      const derived = round2(taxableSubtotal + nonTaxableSubtotal + unknownSubtotal + inferredTax);
      const taxMatchesPrinted = args.printedTax !== null && Math.abs(inferredTax - args.printedTax) <= TOLERANCE;
      const totalMatchesPrinted = args.printedTotal !== null && Math.abs(derived - args.printedTotal) <= TOLERANCE;
      if (taxMatchesPrinted && totalMatchesPrinted) {
        return baseResult({
          outcome: "reconciled_single_rate",
          taxableSubtotal, nonTaxableSubtotal, unknownSubtotal,
          inferredTax, inferredRate: rate,
          printedTax: args.printedTax, printedTotal: args.printedTotal,
          derivedTotal: derived,
          message: `Reconciled at ${rate} % on ${taxableSubtotal.toFixed(2)} taxable subtotal; non-taxable lines total ${nonTaxableSubtotal.toFixed(2)}.`,
          actionable: null,
        });
      }
    }
    // Try again allowing printed values to disagree with derived by
    // tolerance — surfaces the actionable-mismatch cases the founder
    // wants us to explain.
    for (const rate of CANADA_RATES) {
      const inferredTax = round2((taxableSubtotal * rate) / 100);
      if (args.printedTax !== null && Math.abs(inferredTax - args.printedTax) <= TOLERANCE) {
        return baseResult({
          outcome: "unresolved_arithmetic_mismatch",
          taxableSubtotal, nonTaxableSubtotal, unknownSubtotal,
          inferredTax, inferredRate: rate,
          printedTax: args.printedTax, printedTotal: args.printedTotal,
          derivedTotal: round2(taxableSubtotal + nonTaxableSubtotal + unknownSubtotal + inferredTax),
          message: `${rate} % on the taxable subtotal (${taxableSubtotal.toFixed(2)}) matches the printed tax, but the printed total does not add up.`,
          actionable: "Verify subtotal + tax against total; a non-taxable line may be missing.",
        });
      }
    }
  }

  // Case D: no taxable + no printed tax + no reconciliation reached.
  return baseResult({
    outcome: "unresolved_ambiguous",
    taxableSubtotal, nonTaxableSubtotal, unknownSubtotal,
    inferredTax: null, inferredRate: null,
    printedTax: args.printedTax, printedTotal: args.printedTotal,
    derivedTotal: lineSubtotal,
    message: `Could not reconcile: taxable=${taxableSubtotal.toFixed(2)}, non-taxable=${nonTaxableSubtotal.toFixed(2)}, unknown=${unknownSubtotal.toFixed(2)}, printedTax=${args.printedTax ?? "?"}, printedTotal=${args.printedTotal ?? "?"}.`,
    actionable: "Confirm each line's tax treatment manually.",
  });
}

function sum(nums: number[]): number { return round2(nums.reduce((a, b) => a + b, 0)); }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function baseResult(r: TaxReconciliation): TaxReconciliation { return r; }

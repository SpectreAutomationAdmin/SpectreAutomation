// Sprint 3 · Checkpoint 15T (2026-07-28) — amount hierarchy.
//
// Founder rule (§6): the gross amount is populated from the highest-
// authority source available, in this order:
//
//   1. Reliable printed total          → PRINTED_TOTAL
//   2. Arithmetically reconciled total → RECONCILED
//   3. Subtotal + printed tax - credits → SUBTOTAL_PLUS_TAX_MINUS_CREDITS
//   4. Sum of line items               → LINE_ITEM_SUM
//   5. Unknown                         → NULL
//
// A reliable printed total must NOT be blanked simply because tax
// allocation remains unresolved. The analysis can simultaneously
// report:
//   * "gross payable known"
//   * "tax allocation requires review"

import type { LineItem } from "./line-items-extract";

export type AmountSource =
  | "PRINTED_TOTAL"
  | "RECONCILED"
  | "SUBTOTAL_PLUS_TAX_MINUS_CREDITS"
  | "LINE_ITEM_SUM"
  | "NONE";

export interface AmountHierarchyResult {
  value: number | null;                 // gross payable, or null when unknown
  source: AmountSource;
  reason: string;
  // Printed values retained verbatim regardless of which source won.
  printedTotal: number | null;
  printedSubtotal: number | null;
  printedTax: number | null;
  creditTotal: number;                  // sum of negative-amount lines
  lineItemSum: number;                  // sum of positive-amount lines
  // Arithmetic reconciliation — set when the printed total and the
  // subtotal-plus-tax-minus-credits derivation agree within tolerance.
  reconciled: boolean;
  variance: number | null;              // printed - derived; positive means printed > derived
}

const TOLERANCE = 0.02;

export function computeAmountHierarchy(args: {
  printedTotal: number | null;
  printedSubtotal: number | null;
  printedTax: number | null;
  lineItems: LineItem[];
}): AmountHierarchyResult {
  const { printedTotal, printedSubtotal, printedTax, lineItems } = args;
  const lineItemSum = round2(
    lineItems
      .filter((l) => l.amount > 0)
      .reduce((sum, l) => sum + l.amount, 0),
  );
  const creditTotal = round2(
    lineItems
      .filter((l) => l.amount < 0)
      .reduce((sum, l) => sum + Math.abs(l.amount), 0),
  );

  // Derived total: subtotal + tax - credits. Applies only when both
  // subtotal AND tax are known; credits pass through as 0 when none
  // were extracted.
  const derived =
    printedSubtotal != null && printedTax != null
      ? round2(printedSubtotal + printedTax - creditTotal)
      : null;

  const variance =
    printedTotal != null && derived != null
      ? round2(printedTotal - derived)
      : null;
  const reconciled = variance != null && Math.abs(variance) <= TOLERANCE;

  // Case 1 — printed total exists AND reconciles → PRINTED_TOTAL,
  // reconciled=true.
  if (printedTotal != null && reconciled) {
    return {
      value: printedTotal,
      source: "RECONCILED",
      reason: `Printed total ${printedTotal.toFixed(2)} reconciles with subtotal + tax - credits = ${derived?.toFixed(2)}.`,
      printedTotal, printedSubtotal, printedTax, creditTotal, lineItemSum,
      reconciled: true,
      variance,
    };
  }

  // Case 2 — printed total exists but does not reconcile. Founder
  // rule: DO NOT force reconciliation and DO NOT blank the printed
  // total. The printed value is what the supplier is invoicing; the
  // reconciliation status flags the discrepancy separately.
  if (printedTotal != null) {
    return {
      value: printedTotal,
      source: "PRINTED_TOTAL",
      reason:
        derived != null
          ? `Printed total ${printedTotal.toFixed(2)} used verbatim; derived (subtotal + tax - credits) = ${derived.toFixed(2)}; variance = ${(variance ?? 0).toFixed(2)} — tax allocation requires review.`
          : `Printed total ${printedTotal.toFixed(2)} used verbatim; insufficient printed detail to reconcile arithmetically.`,
      printedTotal, printedSubtotal, printedTax, creditTotal, lineItemSum,
      reconciled: false,
      variance,
    };
  }

  // Case 3 — no printed total, but we can derive from subtotal+tax.
  if (derived != null) {
    return {
      value: derived,
      source: "SUBTOTAL_PLUS_TAX_MINUS_CREDITS",
      reason: `Printed total not extracted; using subtotal + tax - credits = ${derived.toFixed(2)}.`,
      printedTotal, printedSubtotal, printedTax, creditTotal, lineItemSum,
      reconciled: false,
      variance: null,
    };
  }

  // Case 4 — no printed subtotal/tax/total, but we have line items.
  if (lineItemSum > 0) {
    return {
      value: lineItemSum,
      source: "LINE_ITEM_SUM",
      reason: `Printed totals unavailable; using sum of ${lineItems.length} extracted line item(s) = ${lineItemSum.toFixed(2)}.`,
      printedTotal, printedSubtotal, printedTax, creditTotal, lineItemSum,
      reconciled: false,
      variance: null,
    };
  }

  return {
    value: null,
    source: "NONE",
    reason: "No printed total, no derivable subtotal/tax, no extracted line items.",
    printedTotal, printedSubtotal, printedTax, creditTotal, lineItemSum,
    reconciled: false,
    variance: null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

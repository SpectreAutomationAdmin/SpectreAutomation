// Sprint 3 · Post-16H Phase 4 Slice 4 (2026-08-07) — arithmetic
// amount reconciliation for column-first invoices.
//
// The DMM Energy trace exposed a general class of PDFs whose
// pdf-parse output emits every summary amount on standalone
// lines BEFORE any of the summary labels (Sub Total / GST / TOTAL):
//
//     120.62               ← standalone amount (tax)
//     2532.92              ← standalone amount (total)
//     2412.30              ← standalone amount (subtotal)
//     TOTAL                ← label appears LATER
//     Sub Total            ← label appears LATER
//     GST/HST              ← label appears LATER
//
// Any label→value pairing (line-scan or layout-associate) picks
// the WRONG amount for each label because the visual columns are
// linearised in the wrong order. Result on real DMM: subtotal
// wrongly surfaced as total, and one of the amounts wrongly
// surfaced as tax.
//
// This module reconciles amounts arithmetically. If three
// money-shaped standalone tokens exist in a document and
// A + B ≈ C within tolerance, then C is the invoice total and
// (A, B) is (subtotal, tax) in decreasing order. This is a
// GENERAL structural rule — no vendor-specific patterns.
//
// The reconciler is INTENTIONALLY conservative:
//   * Only fires when the label-based extractor did NOT find a
//     reconciling triple (i.e. `printed subtotal + tax ≈ total`
//     already holds).
//   * Requires at least 3 distinct money-shaped standalone tokens
//     in the document's summary region (bottom 40% of lines).
//   * Requires EXACTLY ONE (A, B, C) triple within the tolerance.
//     Multiple candidate triples → abstain rather than guess.
//   * Never modifies a label-based extraction result that already
//     reconciles.
//
// Founder-required §6: "A subtotal may not become gross merely
// because the true gross label is harder to parse. If subtotal +
// reconciled taxes = another printed monetary candidate within
// normal rounding tolerance, that is strong evidence that the
// other candidate is the invoice gross total."

const AMOUNT_RE = /(?<![\d.])(?<sign>-?)(?<int>\d{1,3}(?:,\d{3})*|\d{1,7})\.(?<frac>\d{2})(?![.\d])/g;

export interface ArithmeticReconcileInput {
  /** Full flattened pdf-parse text. */
  text: string;
  /** Currently-selected subtotal / tax / total from the label-
   *  based extractor. When these already reconcile, this module
   *  returns null (no change). */
  labelBased: {
    subtotal: number | null;
    tax: number | null;
    total: number | null;
  };
}

export interface ArithmeticReconcileResult {
  reconciled: true;
  subtotal: number;
  tax: number;
  total: number;
  reason: string;
  candidateAmountsInDocument: number[];
}

/**
 * Attempt arithmetic reconciliation. Returns null when the
 * label-based extractor already agrees OR when no unique
 * reconciling triple exists.
 */
export function arithmeticReconcileAmounts(
  input: ArithmeticReconcileInput,
): ArithmeticReconcileResult | null {
  const { subtotal, tax, total } = input.labelBased;
  // Case 1: label-based already reconciles → no change.
  if (
    subtotal != null && tax != null && total != null
    && Math.abs(subtotal + tax - total) < 0.02
  ) {
    return null;
  }
  // Extract all money-shaped tokens.
  const amounts: number[] = [];
  const seen = new Set<string>();
  for (const m of input.text.matchAll(AMOUNT_RE)) {
    const raw = `${m.groups?.sign ?? ""}${(m.groups?.int ?? "").replace(/,/g, "")}.${m.groups?.frac ?? ""}`;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n < 1) continue;                   // skip sub-dollar amounts (rates, decimals)
    if (n > 10_000_000) continue;          // skip absurd numbers
    // Dedup identical amounts — a single amount printed multiple times
    // is one candidate. But we DO want to keep amounts that legitimately
    // appear twice as distinct (e.g. subtotal + remittance stub subtotal).
    const key = n.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    amounts.push(n);
  }
  if (amounts.length < 3) return null;
  amounts.sort((a, b) => a - b);
  const tolerance = 0.02;

  // Phase 4R remediation (2026-08-10) — Multi-Tax Evidence:
  // When the label-based extractor found a subtotal AND total (both
  // reasonably confident), but the tax is missing OR contradicted,
  // FIRST attempt to reconcile the tax as the residual difference
  // between the printed total and the printed subtotal. This handles
  // multi-tax invoices where the tax is spread across TWO OR MORE
  // separately-printed components (CPA Alberta: subtotal $1,360 +
  // GST $20 + GST $40.50 = total $1,420.50; the two GSTs are
  // separately printed with no aligned label the extractor can
  // grab, but the residual is unambiguous).
  //
  // Guard: (a) the residual must be a positive value under 30 % of
  // subtotal (real invoice tax); (b) the residual MUST match the sum
  // of ONE OR MORE small positive amounts in the document (proves
  // the "hidden" tax was actually printed and this isn't a phantom
  // reconciliation); (c) subtotal + total must both be present.
  if (subtotal != null && total != null && total > subtotal) {
    const impliedTax = round2(total - subtotal);
    if (impliedTax > 0 && impliedTax < subtotal * 0.30) {
      // Every amount other than subtotal / total is a candidate
      // tax component. Subtotal / total themselves cannot be their
      // own tax addends.
      const candidateComponents = amounts.filter((a) =>
        Math.abs(a - subtotal) > 0.01
        && Math.abs(a - total) > 0.01
        && a > 0
        && a < subtotal * 0.30,
      );
      const combos = subsetsThatSumTo(candidateComponents, impliedTax, tolerance);
      if (combos.length === 1 && combos[0].length >= 1) {
        return {
          reconciled: true,
          subtotal,
          tax: impliedTax,
          total,
          reason:
            `Multi-tax residual reconciliation: subtotal ${subtotal.toFixed(2)} + `
            + `tax (sum of [${combos[0].map((c) => c.toFixed(2)).join(", ")}] = ${impliedTax.toFixed(2)}) = `
            + `total ${total.toFixed(2)}.`,
          candidateAmountsInDocument: amounts,
        };
      }
    }
  }

  // Fallback (pre-Phase 4R): Find all triples where A + B ≈ C.
  const triples: Array<{ subtotal: number; tax: number; total: number }> = [];
  for (let i = 0; i < amounts.length; i++) {
    for (let j = i + 1; j < amounts.length; j++) {
      for (let k = j + 1; k < amounts.length; k++) {
        const a = amounts[i], b = amounts[j], c = amounts[k];
        if (Math.abs(a + b - c) < tolerance) {
          const sub = Math.max(a, b);
          const t = Math.min(a, b);
          const rate = t / sub;
          if (rate < 0 || rate > 0.5) continue;
          triples.push({ subtotal: sub, tax: t, total: c });
        }
      }
    }
  }
  if (triples.length !== 1) return null;      // ambiguous / none — abstain
  const triple = triples[0];
  return {
    reconciled: true,
    subtotal: triple.subtotal,
    tax: triple.tax,
    total: triple.total,
    reason: `Arithmetic reconciliation: ${triple.subtotal.toFixed(2)} + ${triple.tax.toFixed(2)} = ${triple.total.toFixed(2)} — unique triple in document; label-based extraction was misaligned (column-first pdf-parse).`,
    candidateAmountsInDocument: amounts,
  };
}

/** Enumerate distinct subsets of `pool` whose sum falls within
 *  `tolerance` of `target`. Bounded at up to 4 addends and up to
 *  `pool.length ≤ 32` to keep the search fast. Returns up to the
 *  first 3 distinct combinations. */
function subsetsThatSumTo(pool: number[], target: number, tolerance: number): number[][] {
  if (pool.length > 32) return [];
  const sorted = [...pool].sort((a, b) => a - b);
  const combos: number[][] = [];
  const MAX_COMBOS = 3;
  const MAX_DEPTH = 4;
  function recurse(start: number, chosen: number[], sumSoFar: number) {
    if (combos.length >= MAX_COMBOS) return;
    if (chosen.length > 0 && Math.abs(sumSoFar - target) < tolerance) {
      combos.push([...chosen]);
      return;
    }
    if (chosen.length >= MAX_DEPTH) return;
    if (sumSoFar > target + tolerance) return;
    for (let i = start; i < sorted.length; i++) {
      chosen.push(sorted[i]);
      recurse(i + 1, chosen, sumSoFar + sorted[i]);
      chosen.pop();
      if (combos.length >= MAX_COMBOS) return;
    }
  }
  recurse(0, [], 0);
  return combos;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

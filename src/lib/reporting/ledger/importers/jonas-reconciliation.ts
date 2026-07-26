// Jonas Trial Balance reconciliation tally.
//
// Pure function. Takes the parser's row output + the (optional)
// account mapping and produces the debit/credit/delta totals the
// preview UI surfaces.
//
// CRITICAL business rule from the founder spec:
//   For Jonas-native trial balances, the reconciliation totals MUST
//   be computed from the RAW source columns (Closing Bal Debit /
//   Closing Bal Credit) — NOT from any derived `periodBalance`,
//   NOT from account-classification heuristics, NOT from normal-
//   balance rules. The totals an accountant verifies against the
//   Jonas printout are the column sums; anything else is a different
//   number.
//
// Fallback for spectre-normalised inputs (which sometimes ship
// only a YTDBalance column with no explicit debit/credit split):
//   Use the YTD value with natural-side classification via the
//   account mapping. This is the legacy spectre convention and
//   only fires for rows where `debit === null && credit === null`.

import type {
  JonasGlCsvRow,
} from "@/lib/reporting/ledger/importers/jonas-gl-csv";
import {
  DEFAULT_JONAS_ACCOUNT_MAPPING,
  mapJonasAccount,
  type JonasAccountMapping,
} from "@/lib/reporting/ledger/importers/jonas-gl-mapping";

export type JonasReconciliationResult = {
  totalDebits: number;
  totalCredits: number;
  /** totalDebits − totalCredits. Positive = debits exceed credits. */
  delta: number;
  /** Within $1 tolerance. */
  isBalanced: boolean;
};

/**
 * Tally the debit + credit sides of a parsed Jonas extract.
 *
 * Per-row source preference, in order:
 *   1. Explicit Debit + Credit columns (always present after Jonas-
 *      native normalisation; sometimes present in spectre-normalised
 *      CSVs that ship splits). The totals are `Σ |debit| + Σ |credit|`
 *      — ABS magnitudes, no classification.
 *   2. Fallback: YTDBalance + natural-side derivation via the
 *      supplied account mapping. Only used when neither debit nor
 *      credit is present on the row. Unmapped accounts contribute
 *      nothing (no way to classify; surface separately as a
 *      mapping diagnostic).
 *
 * The function does not return or accept account-mapping diagnostics
 * — that's a separate concern handled by the preview action. This
 * helper's only job is the numeric tally.
 */
export function tallyJonasReconciliation(
  rows: ReadonlyArray<JonasGlCsvRow>,
  mapping: JonasAccountMapping = DEFAULT_JONAS_ACCOUNT_MAPPING,
): JonasReconciliationResult {
  let totalDebits = 0;
  let totalCredits = 0;

  for (const row of rows) {
    if (row.debit !== null || row.credit !== null) {
      totalDebits += Math.abs(row.debit ?? 0);
      totalCredits += Math.abs(row.credit ?? 0);
      continue;
    }
    // Fallback: YTDBalance + natural-side classification.
    const mapped = mapJonasAccount(
      {
        accountNumber: row.accountNumber,
        accountDescription: row.accountDescription,
        jonasAccountType: row.jonasAccountType,
      },
      mapping,
    );
    if (!mapped) continue;
    const naturalDebit = mapped.category === "asset" || mapped.category === "expense";
    const balance = row.ytdBalance;
    if (naturalDebit) {
      if (balance >= 0) totalDebits += balance;
      else totalCredits += -balance;
    } else {
      if (balance >= 0) totalCredits += balance;
      else totalDebits += -balance;
    }
  }

  const delta = totalDebits - totalCredits;
  return {
    totalDebits,
    totalCredits,
    delta,
    isBalanced: Math.abs(delta) < 1,
  };
}

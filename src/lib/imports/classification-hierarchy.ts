// COA-UX-2b (2026-09-29) — Classification hierarchy helpers.
//
// The Spectre Chart-of-Accounts classification is a three-level
// hierarchy:
//
//     Account.type  (ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE)
//         │
//     AccountCategory.key (CURRENT_ASSETS, CAPITAL_ASSETS, PAYROLL_BENEFITS, …)
//         │
//     FinancialStatementGroup.key (BS_CASH_EQUIVALENTS, BS_CAPITAL_ASSETS, …)
//
// TYPE→CATEGORY is enforced by a DB column: `AccountCategory.type`.
// The Inspector's Category `<select>` already filters against it.
//
// CATEGORY→FS_GROUP has NO DB column linking `FinancialStatementGroup`
// back to `AccountCategory`. The only authoritative mapping today is
// the `FS_GROUP_TO_CATEGORY` constant in `coa-predictor.ts`, which
// the import predictor consults when emitting its default triples.
//
// This module inverts that constant into a Category→FS_Group filter
// and re-exports it as the single source of truth used by:
//
//   * BulkCoaReviewControls Inspector (FS Group `<select>`)
//   * BulkCoaReviewControls bulk Classification menu
//   * unit tests that verify the UI filter and the predictor cannot
//     drift apart
//
// Non-canonical FS Group keys (any key NOT present in the predictor's
// constant — e.g. a hand-added club-specific group) are considered
// "unclassified" and remain visible under every Category so the
// operator can still see them; they only fail this filter for known
// canonical keys, matching the founder rule "Do NOT show unrelated
// FS Groups" while keeping custom rows editable.

import { FS_GROUP_TO_CATEGORY } from "./coa-predictor";

/**
 * Inverse of FS_GROUP_TO_CATEGORY: for every AccountCategory key
 * that appears as a value in the predictor's constant, the set of
 * FS Group keys mapped into it. Frozen at module load.
 */
export const CATEGORY_TO_FS_GROUPS: Readonly<Record<string, ReadonlyArray<string>>> = (() => {
  const acc: Record<string, string[]> = {};
  for (const [fsGroupKey, categoryKey] of Object.entries(FS_GROUP_TO_CATEGORY)) {
    if (!acc[categoryKey]) acc[categoryKey] = [];
    acc[categoryKey].push(fsGroupKey);
  }
  // Deterministic ordering for stable dropdowns.
  for (const key of Object.keys(acc)) acc[key].sort();
  return Object.freeze(acc);
})();

/**
 * FS Group keys the predictor knows about — anything else is
 * "unclassified" and passes through every filter unchanged.
 */
export const KNOWN_FS_GROUP_KEYS: ReadonlySet<string> = new Set(Object.keys(FS_GROUP_TO_CATEGORY));

/**
 * Return the Category key for a canonical FS Group key, or `null`
 * for keys the predictor doesn't classify (custom, retired, etc.).
 */
export function getCategoryForFsGroup(fsGroupKey: string | null | undefined): string | null {
  if (!fsGroupKey) return null;
  return FS_GROUP_TO_CATEGORY[fsGroupKey] ?? null;
}

/**
 * Is `fsGroupKey` valid inside `categoryKey`?
 *
 * Rules:
 *   * If `fsGroupKey` isn't in the canonical mapping constant, it's
 *     considered unclassified and is allowed under any Category.
 *   * Otherwise, must match `FS_GROUP_TO_CATEGORY[fsGroupKey]`.
 *
 * A `null`/empty `categoryKey` disables the Category-side filter
 * (every FS Group passes — used when the operator hasn't picked
 * a Category yet).
 */
export function isFsGroupValidForCategory(
  fsGroupKey: string | null | undefined,
  categoryKey: string | null | undefined,
): boolean {
  if (!fsGroupKey) return true;
  if (!categoryKey) return true;
  const mapped = FS_GROUP_TO_CATEGORY[fsGroupKey];
  if (mapped === undefined) return true; // unclassified — permissive
  return mapped === categoryKey;
}

/**
 * Filter a caller-supplied list of FS Group options down to those
 * valid for `categoryKey`. If `categoryKey` is null/empty, returns
 * the input unchanged.
 */
export function filterFsGroupOptionsByCategory<T extends { key: string }>(
  options: ReadonlyArray<T>,
  categoryKey: string | null | undefined,
): T[] {
  if (!categoryKey) return options.slice();
  return options.filter((o) => isFsGroupValidForCategory(o.key, categoryKey));
}

/**
 * Filter Category options by AccountType. This is the same rule the
 * Inspector's Category `<select>` already applies inline; centralising
 * it so callers can reuse one helper and so unit tests can assert on
 * a single symbol.
 */
export function filterCategoryOptionsByType<T extends { accountType: string }>(
  options: ReadonlyArray<T>,
  accountType: string | null | undefined,
): T[] {
  if (!accountType) return options.slice();
  return options.filter((o) => o.accountType === accountType);
}

/**
 * When Type changes to `nextType`, decide whether `currentCategoryKey`
 * is still valid. If not, the caller should clear Category (§10).
 *
 * `catalog` is the list of AccountCategory options; the current key
 * is validated by looking it up and checking its `accountType`.
 */
export function categoryStillValidUnderType<T extends { key: string; accountType: string }>(
  currentCategoryKey: string | null | undefined,
  nextType: string | null | undefined,
  catalog: ReadonlyArray<T>,
): boolean {
  if (!currentCategoryKey) return true;
  if (!nextType) return true;
  const row = catalog.find((c) => c.key === currentCategoryKey);
  if (!row) return true; // unknown category — permissive
  return row.accountType === nextType;
}

/**
 * Given the selected rows, determine which AccountType they all
 * share. Returns null if the selection spans multiple types (in
 * which case the bulk Category and FS Group controls must be
 * disabled per §6).
 */
export function commonAccountType(rows: ReadonlyArray<{ type: string }>): string | null {
  if (rows.length === 0) return null;
  const first = rows[0].type;
  for (const r of rows) if (r.type !== first) return null;
  return first;
}

/**
 * Same idea as `commonAccountType` but for the category key. Used
 * to decide whether bulk FS Group can even be offered without
 * asking the operator to pick a common Category first.
 */
export function commonCategoryKey(rows: ReadonlyArray<{ categoryKey: string }>): string | null {
  if (rows.length === 0) return null;
  const first = rows[0].categoryKey;
  for (const r of rows) if (r.categoryKey !== first) return null;
  return first || null;
}

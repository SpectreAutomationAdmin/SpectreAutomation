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

// ---------------------------------------------------------------------------
// COA-UX-2d (2026-09-30) — Classification uplift + coherence check.
//
// §4 of the directive: a founder classification change must result in
// ONE internally valid persisted mapping. Picking an FS Group that
// implies a different Type/Category can no longer leave the row in
// an incoherent state (e.g. Account 7000: EXPENSE + —no Category— +
// Other Revenue). The Inspector + bulk Classification + server-side
// save MUST all route through these helpers.
// ---------------------------------------------------------------------------

/**
 * Look up the AccountType an AccountCategory key resolves to via
 * the tenant's category catalog. Returns null for unknown keys.
 */
export function getTypeForCategory<T extends { key: string; accountType: string }>(
  categoryKey: string | null | undefined,
  catalog: ReadonlyArray<T>,
): string | null {
  if (!categoryKey) return null;
  const row = catalog.find((c) => c.key === categoryKey);
  return row ? row.accountType : null;
}

/** The result of a classification coherence check. */
export type ClassificationCoherence =
  | { coherent: true }
  | { coherent: false; reason: string; code: ClassificationViolationCode };

export type ClassificationViolationCode =
  | "TYPE_CATEGORY_MISMATCH"      // Category.type !== Type
  | "CATEGORY_FS_GROUP_MISMATCH"  // FS Group's canonical Category !== Category
  | "FS_GROUP_WITHOUT_CATEGORY"   // FS Group set but Category missing — §3/§4 forbidden combo
  | "FS_GROUP_WITHOUT_TYPE";      // FS Group set but Type missing

/**
 * Decide whether a (type, categoryKey, fsGroupKey) triple is internally
 * valid under the tenant's catalog + the canonical FS Group → Category
 * mapping. The three fields are allowed to be independently null; the
 * check is permissive for unknown canonical keys so a club-specific
 * FS Group doesn't fail validation.
 */
export function checkClassificationCoherence<T extends { key: string; accountType: string }>(
  input: {
    type: string | null | undefined;
    categoryKey: string | null | undefined;
    fsGroupKey: string | null | undefined;
  },
  categoryCatalog: ReadonlyArray<T>,
): ClassificationCoherence {
  const { type, categoryKey, fsGroupKey } = input;

  // Type ↔ Category (DB-backed via AccountCategory.type).
  if (type && categoryKey) {
    const catRow = categoryCatalog.find((c) => c.key === categoryKey);
    // Unknown category key — treat as permissive (custom category).
    if (catRow && catRow.accountType !== type) {
      return {
        coherent: false,
        code: "TYPE_CATEGORY_MISMATCH",
        reason: `Category ${categoryKey} is for ${catRow.accountType}, not ${type}.`,
      };
    }
  }

  // Category ↔ FS Group (code-based via FS_GROUP_TO_CATEGORY constant).
  if (fsGroupKey && categoryKey) {
    const mappedCategory = FS_GROUP_TO_CATEGORY[fsGroupKey];
    if (mappedCategory !== undefined && mappedCategory !== categoryKey) {
      return {
        coherent: false,
        code: "CATEGORY_FS_GROUP_MISMATCH",
        reason: `FS Group ${fsGroupKey} belongs to ${mappedCategory}, not ${categoryKey}.`,
      };
    }
  }

  // FS Group present but Category missing — §3/§4 explicitly forbids
  // this as it was the Account 7000 defect shape.
  if (fsGroupKey && !categoryKey) {
    const mappedCategory = FS_GROUP_TO_CATEGORY[fsGroupKey];
    if (mappedCategory !== undefined) {
      return {
        coherent: false,
        code: "FS_GROUP_WITHOUT_CATEGORY",
        reason: `FS Group ${fsGroupKey} requires Category ${mappedCategory}, but Category is empty.`,
      };
    }
    // Unknown FS Group with no Category — permissive; the operator
    // may be using a custom club-specific group outside the canonical
    // mapping. Normal DIM validation at commit time will catch this
    // if it's actually broken.
  }

  // FS Group with Category but no Type — also incoherent.
  if (fsGroupKey && categoryKey && !type) {
    return {
      coherent: false,
      code: "FS_GROUP_WITHOUT_TYPE",
      reason: `Category ${categoryKey} + FS Group ${fsGroupKey} require a Type, but Type is empty.`,
    };
  }

  return { coherent: true };
}

/**
 * Canonicalise a (partial) classification by filling in Type and
 * Category when they can be unambiguously derived from downstream
 * fields:
 *
 *   * FS Group given → Category = FS_GROUP_TO_CATEGORY[fsGroupKey]
 *   * Category given (or derived) → Type = AccountCategory.type
 *
 * Fields the caller sent explicitly are preserved exactly as given
 * (even if `null`). Only MISSING / UNDEFINED fields are filled in.
 * This is how the Inspector's "picking an FS Group fills in Type + Category"
 * atomic UX works without the client having to know the catalog.
 *
 * The returned triple is NOT guaranteed to be coherent — a caller
 * that passes conflicting fields explicitly (e.g. Type=EXPENSE +
 * FS Group=IS_OTHER_REVENUE) gets its explicit values back; use
 * `checkClassificationCoherence` next.
 */
export function canonicaliseClassification<T extends { key: string; accountType: string }>(
  input: {
    type?: string | null;
    categoryKey?: string | null;
    fsGroupKey?: string | null;
  },
  categoryCatalog: ReadonlyArray<T>,
): { type: string | null; categoryKey: string | null; fsGroupKey: string | null } {
  const explicit = {
    type: input.type === undefined ? undefined : input.type,
    categoryKey: input.categoryKey === undefined ? undefined : input.categoryKey,
    fsGroupKey: input.fsGroupKey === undefined ? undefined : input.fsGroupKey,
  };

  // Derive Category from FS Group when Category wasn't explicitly set.
  let categoryKey = explicit.categoryKey;
  if (categoryKey === undefined && explicit.fsGroupKey) {
    const derived = FS_GROUP_TO_CATEGORY[explicit.fsGroupKey];
    if (derived !== undefined) categoryKey = derived;
  }

  // Derive Type from Category (either explicit or just-derived) when
  // Type wasn't explicitly set.
  let type = explicit.type;
  if (type === undefined && categoryKey) {
    const derived = getTypeForCategory(categoryKey, categoryCatalog);
    if (derived !== null) type = derived;
  }

  return {
    type: type === undefined ? null : type,
    categoryKey: categoryKey === undefined ? null : categoryKey,
    fsGroupKey: explicit.fsGroupKey === undefined ? null : explicit.fsGroupKey,
  };
}

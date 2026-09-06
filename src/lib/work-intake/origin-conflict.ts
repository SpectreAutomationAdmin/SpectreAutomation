// Payroll-3D-3B Slice 1 (2026-09-06) — canonical detection of the
// correction-review partial-unique constraint violation.
//
// Purpose: when the DB rejects a WorkIntakeOrigin insert with P2002
// because a concurrent creator already inserted the canonical row, we
// want to treat the loser branch as idempotent success (refetch the
// canonical row and return it) — but ONLY for OUR specific constraint.
// A P2002 from any other index means a different bug and must not be
// swallowed.
//
// The index name is the source of truth (matches the migration in
// prisma-postgres/migrations/20260911_payroll_3d3b_correction_review_partial_unique/).
// The columns are stable across engines; the name-vs-columns split
// exists because Prisma's error surface varies:
//   * Postgres/SQLite via prisma@5.x: meta.target is typically an
//     array of column names OR the constraint/index name string
//     depending on adapter version.
//   * Some Prisma minor versions report the index name directly.
// We accept either surface so a Prisma bump does not silently break
// idempotency detection.

export const CORRECTION_REVIEW_ORIGIN_INDEX_NAME =
  "WorkIntakeOrigin_timeclock_correction_primary_key" as const;

const CORRECTION_REVIEW_ORIGIN_COLUMNS = ["clubId", "kind", "referenceId"] as const;

/**
 * Returns true iff the given error is a Prisma P2002 unique-constraint
 * violation on the partial-unique index that guards correction-review
 * WorkIntakeOrigin rows.
 *
 * Callers use this to distinguish "I lost a benign race, refetch the
 * canonical row" from "unrelated P2002, propagate the error."
 */
export function isCorrectionReviewOriginConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { code?: unknown; meta?: unknown };
  if (anyErr.code !== "P2002") return false;
  // The target-tuple check IS the second gate — a bespoke error shape
  // would need to fake both .code AND the exact 3-column meta.target,
  // which is narrow enough that we don't need a .name check on top.
  return targetMatches(anyErr.meta);
}

function targetMatches(meta: unknown): boolean {
  if (!meta || typeof meta !== "object") return false;
  const target = (meta as { target?: unknown }).target;
  // Prisma surfaces `target` as:
  //   * a string (index name OR comma-separated columns depending on adapter)
  //   * an array of column names
  //   * a single column name (rare)
  if (typeof target === "string") {
    if (target === CORRECTION_REVIEW_ORIGIN_INDEX_NAME) return true;
    if (target.includes(CORRECTION_REVIEW_ORIGIN_INDEX_NAME)) return true;
    // Column-list surface as a comma-joined string.
    return matchesColumnList(target.split(",").map((s) => s.trim()));
  }
  if (Array.isArray(target)) {
    return matchesColumnList(target);
  }
  return false;
}

function matchesColumnList(cols: unknown[]): boolean {
  if (cols.length !== CORRECTION_REVIEW_ORIGIN_COLUMNS.length) return false;
  // Order does not matter — Prisma reports columns in index order but
  // some adapters sort alphabetically. Compare as sets of strings.
  const set = new Set(cols.map((c) => String(c)));
  for (const expected of CORRECTION_REVIEW_ORIGIN_COLUMNS) {
    if (!set.has(expected)) return false;
  }
  return true;
}

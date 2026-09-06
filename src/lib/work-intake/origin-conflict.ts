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

// Payroll-3D-3B Slice 7 (2026-09-06) — timesheet-approval scope
// partial-unique. Same shape as the correction-review index, distinct
// index name so P2002 targets can be distinguished.
export const SCOPE_APPROVAL_ORIGIN_INDEX_NAME =
  "WorkIntakeOrigin_timesheet_approval_primary_key" as const;

const CORRECTION_REVIEW_ORIGIN_COLUMNS = ["clubId", "kind", "referenceId"] as const;
// Same column tuple for both indexes; the discriminator is the index
// name / kind. Callers pass the expected index name when checking.
const SCOPE_APPROVAL_ORIGIN_COLUMNS = ["clubId", "kind", "referenceId"] as const;

/**
 * Returns true iff the given error is a Prisma P2002 unique-constraint
 * violation on the partial-unique index that guards correction-review
 * WorkIntakeOrigin rows.
 *
 * Callers use this to distinguish "I lost a benign race, refetch the
 * canonical row" from "unrelated P2002, propagate the error."
 */
export function isCorrectionReviewOriginConflict(err: unknown): boolean {
  return isP2002ForIndex(err, CORRECTION_REVIEW_ORIGIN_INDEX_NAME, CORRECTION_REVIEW_ORIGIN_COLUMNS);
}

// Payroll-3D-3B Slice 7 (2026-09-06) — recognises P2002 on the
// timesheet-approval scope partial-unique. Same column tuple; the
// index name is the discriminator when Prisma surfaces the target
// as a string. When the target is a column-array, the shim can't
// distinguish which of the two indexes fired — that's acceptable
// because both indexes name the same origin canonical uniqueness
// guarantee: refetch canonical → return existing. Callers that need
// to distinguish (rare) should read the origin.kind on the refetched
// row.
export function isScopeApprovalOriginConflict(err: unknown): boolean {
  return isP2002ForIndex(err, SCOPE_APPROVAL_ORIGIN_INDEX_NAME, SCOPE_APPROVAL_ORIGIN_COLUMNS);
}

// Combined check: either narrow WorkIntakeOrigin index fired. Safe
// callers that just need "refetch canonical" semantics.
export function isWorkIntakeOriginConflict(err: unknown): boolean {
  return isCorrectionReviewOriginConflict(err) || isScopeApprovalOriginConflict(err);
}

function isP2002ForIndex(err: unknown, indexName: string, cols: readonly string[]): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { code?: unknown; meta?: unknown };
  if (anyErr.code !== "P2002") return false;
  return targetMatches(anyErr.meta, indexName, cols);
}

function targetMatches(meta: unknown, indexName: string, cols: readonly string[]): boolean {
  if (!meta || typeof meta !== "object") return false;
  const target = (meta as { target?: unknown }).target;
  if (typeof target === "string") {
    if (target === indexName) return true;
    if (target.includes(indexName)) return true;
    return matchesColumnList(target.split(",").map((s) => s.trim()), cols);
  }
  if (Array.isArray(target)) {
    return matchesColumnList(target, cols);
  }
  return false;
}

function matchesColumnList(actualCols: unknown[], expectedCols: readonly string[]): boolean {
  if (actualCols.length !== expectedCols.length) return false;
  const set = new Set(actualCols.map((c) => String(c)));
  for (const expected of expectedCols) {
    if (!set.has(expected)) return false;
  }
  return true;
}

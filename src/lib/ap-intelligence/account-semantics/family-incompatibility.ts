// Sprint 3 · Ranker Authority slice (2026-08-10) — generalized
// family-incompatibility gate for per-cluster GL ranking.
//
// Founder rule (§2 · §4): "Account-name lexical similarity must NOT
// overpower a materially incompatible accounting meaning." The
// existing ranker aggregates directLineMatch + accountNameSimilarity
// + fsGroupTaxonomySimilarity into one score. When a line's own
// tokens ("maintenance") happen to match a competitor account's name
// ("R & M Preventative Maintenance"), the lexical channel can outrun
// the fsGroupKey channel and the material-substance winner loses.
//
// This module implements the §4 "compatibility before relevance"
// principle: given a cluster's canonical concept, exclude accounts
// whose fsGroupKey belongs to a KNOWN materially-incompatible family
// BEFORE relevance scoring runs. Lexical similarity remains useful
// for tie-breaking between accounts that ARE mutually compatible;
// it stops deciding between materially different accounting
// substances.
//
// The matrix is deliberately small and symmetric. It encodes only
// the mutual exclusions that generalize across tenants:
//
//   IT SOFTWARE  ↔ REPAIRS AND MAINTENANCE
//   IT SOFTWARE  ↔ TELEPHONE AND INTERNET
//   PAYROLL      ↔ everything else (payroll is guarded separately by
//                 rulePayrollAccountExcluded — kept here for
//                 completeness / documentation)
//
// Not encoded: mutual compatibilities within a family (e.g. multiple
// IT accounts), close-adjacent families where a tenant COA could
// legitimately post either (e.g. IT SOFTWARE ↔ LICENCES_PERMITS —
// the tenant may house cloud subscriptions in either), or minor
// distinctions the ranker's relevance layer handles well.
//
// §3 rule: this is NOT a boost for one specific account. It is a
// generalized structural gate.
// §5 reverse controls (proven by tests):
//   - Genuine R&M invoice (mower repair) → IS_IT_SOFTWARE accounts
//     excluded from the r&m cluster (§5 test C).
//   - OXIO Internet invoice → IS_REPAIRS_MAINTENANCE excluded (§5).
//   - Cybersecurity invoice → IS_REPAIRS_MAINTENANCE and
//     IS_TELEPHONE_INTERNET excluded (§5).
//   - Software subscription → IS_REPAIRS_MAINTENANCE excluded (§5).
//   - Ambiguous "maintenance fee" (no IT / physical context) → NO
//     exclusion fires, ranker falls back to normal (§5 abstention).

// Small symmetric matrix keyed by fsGroupKey. Two families that
// each list the other are MUTUALLY INCOMPATIBLE. Add pairs by
// listing them in BOTH directions.
const INCOMPATIBLE_FSGROUP_FAMILIES: Record<string, Set<string>> = {
  IS_IT_SOFTWARE: new Set([
    "IS_REPAIRS_MAINTENANCE",
    "IS_TELEPHONE_INTERNET",
    "IS_PAYROLL",
  ]),
  IS_REPAIRS_MAINTENANCE: new Set([
    "IS_IT_SOFTWARE",
    "IS_PAYROLL",
  ]),
  IS_TELEPHONE_INTERNET: new Set([
    "IS_IT_SOFTWARE",
    "IS_PAYROLL",
  ]),
  IS_PAYROLL: new Set([
    // Payroll is broadly incompatible with any non-payroll cluster.
    // The founder-frozen `rulePayrollAccountExcluded` already fires
    // in the document-level eligibility service (Payroll semantics
    // slice), but the allocation composer's per-cluster pool does
    // NOT run that service. Encoding payroll here makes the same
    // guard apply to per-cluster candidate filtering — no more
    // "Wages - Maintenance" sneaking into the it_services cluster
    // via lexical overlap on "Maintenance".
    "IS_IT_SOFTWARE",
    "IS_REPAIRS_MAINTENANCE",
    "IS_TELEPHONE_INTERNET",
    "IS_LICENCES_PERMITS",
    "IS_MEMBERSHIPS_SUBS",
  ]),
};

/** Return TRUE when a cluster whose concept hints at `clusterFsGroupHints`
 *  is materially INCOMPATIBLE with the account's `accountFsGroupKey`.
 *
 *  Returns FALSE when:
 *    - either side is null / empty (no hint → no restriction);
 *    - the account fsGroupKey is not present in the incompatibility
 *      table for any of the cluster's hints;
 *    - the fsGroupKeys match (family agrees with itself).
 *
 *  Symmetric by construction: `isIncompatible(A → B) === isIncompatible(B → A)`
 *  because the matrix lists each pair in both directions. */
export function isFsGroupFamilyIncompatibleWithCluster(
  accountFsGroupKey: string | null | undefined,
  clusterFsGroupHints: ReadonlyArray<string> | null | undefined,
): boolean {
  if (!accountFsGroupKey) return false;
  if (!clusterFsGroupHints || clusterFsGroupHints.length === 0) return false;
  // Family agrees with itself — if the account is in the cluster's own
  // hint list, it is compatible regardless of the matrix.
  if (clusterFsGroupHints.includes(accountFsGroupKey)) return false;
  // Symmetric lookup — the matrix may list the pair from EITHER side.
  const accountIncompatibleSet = INCOMPATIBLE_FSGROUP_FAMILIES[accountFsGroupKey];
  for (const hint of clusterFsGroupHints) {
    const hintIncompatibleSet = INCOMPATIBLE_FSGROUP_FAMILIES[hint];
    if (hintIncompatibleSet?.has(accountFsGroupKey)) return true;
    if (accountIncompatibleSet?.has(hint)) return true;
  }
  return false;
}

/** Diagnostic-only helper — surfaces the offending hint for logs / tests. */
export function describeFsGroupFamilyIncompatibility(
  accountFsGroupKey: string | null | undefined,
  clusterFsGroupHints: ReadonlyArray<string> | null | undefined,
): string | null {
  if (!isFsGroupFamilyIncompatibleWithCluster(accountFsGroupKey, clusterFsGroupHints)) {
    return null;
  }
  const conflicting = (clusterFsGroupHints ?? []).find(
    (h) => INCOMPATIBLE_FSGROUP_FAMILIES[h]?.has(accountFsGroupKey ?? ""),
  );
  return `Account fsGroup=${accountFsGroupKey} is incompatible with cluster fsGroup family hint=${conflicting}`;
}

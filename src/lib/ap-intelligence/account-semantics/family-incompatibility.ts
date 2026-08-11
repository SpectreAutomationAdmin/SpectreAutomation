// Sprint 3 · Phase 4R remediation (2026-08-10) — payroll-only hard
// incompatibility gate + purpose-specific compatibility scoring.
//
// The Phase 4 baseline treated IT ↔ R&M, IT ↔ Telephone/Internet as
// HARD MUTUAL EXCLUSIONS. Real-world evidence (Club Support: managed
// IT + VoIP + hardware repair on ONE invoice) proved this too
// coarse: a legitimate line was made impossible to route to its
// correct account. Founder ruling (§13): supplier/invoice family is
// CONTEXT; PURCHASED PURPOSE is AUTHORITY.
//
// This module now encodes only the ONE hard incompatibility that
// generalises across every tenant COA:
//
//   PAYROLL  ↔  every non-payroll family
//
// Every other purpose-driven compatibility is scored at ranking time
// by `purpose-account-compatibility.ts` — the ranker prefers accounts
// whose FS group is STRONG/VALID for the CLUSTER'S OWN CONCEPT, but
// no account is HARD-EXCLUDED merely because a sibling cluster on the
// same invoice speaks a different family.
//
// §5 reverse controls (proven by tests):
//   - Genuine R&M invoice (mower repair) → payroll accounts excluded
//     from the r&m cluster; IT-adjacent accounts remain eligible
//     (ranker prefers R&M via compatibility scoring, not exclusion).
//   - OXIO Internet invoice → payroll excluded; Telephone accounts
//     preferred via purpose-compatibility scoring.
//   - IT-provider invoice with a VoIP line → cluster concept
//     `telephony`, Telephone accounts REMAIN eligible; the family
//     matrix does NOT exclude them.
//   - IT-provider invoice with a hardware repair line → cluster
//     concept `equipment_repair` (a specific R&M child), R&M
//     accounts REMAIN eligible.
//   - Payroll — external AP supplier with no affirmative payroll
//     evidence → payroll-only accounts still HARD-excluded (§15).

// Phase 4R remediation (2026-08-10) — Purpose-specific compatibility.
//
// The previous matrix listed IT ↔ R&M, IT ↔ Telephone/Internet, and
// R&M ↔ IT as HARD MUTUAL EXCLUSIONS. The founder ruling (§13):
// "supplier/invoice family is CONTEXT. Purchased purpose is
// AUTHORITY." An IT-family invoice can legitimately contain VoIP
// (IS_TELEPHONE_INTERNET), hardware repair (IS_REPAIRS_MAINTENANCE),
// software subscription (IS_IT_SOFTWARE), cloud storage, and
// cybersecurity. Blanket-excluding those families from an IT cluster
// pool made the correct account impossible.
//
// The rule that survives is PAYROLL (§15): an external ordinary AP
// invoice with no affirmative payroll evidence must not route to a
// payroll-only account, because that would post supplier payments
// through a payroll bucket — a true source/accounting-substance
// incompatibility, not just semantic disagreement. This one hard
// gate remains, symmetric.
//
// All other purpose-driven compatibility is now scored via
// `purpose-account-compatibility.ts` at ranking time: the ranker
// prefers accounts whose FS group has STRONG or VALID compatibility
// with the CLUSTER'S OWN CONCEPT (not the invoice's overall
// family), and lexical similarity acts as a tie-breaker between
// compatible accounts. That preserves per-line purpose authority
// (§22) without excluding legitimate cross-family purchases.
const INCOMPATIBLE_FSGROUP_FAMILIES: Record<string, Set<string>> = {
  // Payroll HARD gate — symmetric.
  IS_PAYROLL: new Set([
    "IS_IT_SOFTWARE",
    "IS_REPAIRS_MAINTENANCE",
    "IS_TELEPHONE_INTERNET",
    "IS_LICENCES_PERMITS",
    "IS_MEMBERSHIPS_SUBS",
    "IS_UTILITIES",
    "IS_OFFICE_SUPPLIES",
    "IS_PROFESSIONAL_FEES",
    "IS_INSURANCE",
    "IS_INTEREST_EXPENSE",
    "IS_BANK_CHARGES",
    "IS_COGS_FOOD",
    "IS_COGS_BEV",
    "IS_FB_SUPPLIES",
    "IS_COURSE_MAINT",
    "IS_OTHER_EXPENSES",
    "IS_COMMUNICATIONS",
  ]),
  // Reverse edges of the payroll gate — a NON-payroll cluster must
  // never accept a payroll account.
  IS_IT_SOFTWARE: new Set(["IS_PAYROLL"]),
  IS_REPAIRS_MAINTENANCE: new Set(["IS_PAYROLL"]),
  IS_TELEPHONE_INTERNET: new Set(["IS_PAYROLL"]),
  IS_LICENCES_PERMITS: new Set(["IS_PAYROLL"]),
  IS_MEMBERSHIPS_SUBS: new Set(["IS_PAYROLL"]),
  IS_UTILITIES: new Set(["IS_PAYROLL"]),
  IS_OFFICE_SUPPLIES: new Set(["IS_PAYROLL"]),
  IS_PROFESSIONAL_FEES: new Set(["IS_PAYROLL"]),
  IS_INSURANCE: new Set(["IS_PAYROLL"]),
  IS_INTEREST_EXPENSE: new Set(["IS_PAYROLL"]),
  IS_BANK_CHARGES: new Set(["IS_PAYROLL"]),
  IS_COGS_FOOD: new Set(["IS_PAYROLL"]),
  IS_COGS_BEV: new Set(["IS_PAYROLL"]),
  IS_FB_SUPPLIES: new Set(["IS_PAYROLL"]),
  IS_COURSE_MAINT: new Set(["IS_PAYROLL"]),
  IS_OTHER_EXPENSES: new Set(["IS_PAYROLL"]),
  IS_COMMUNICATIONS: new Set(["IS_PAYROLL"]),
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

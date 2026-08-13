// Phase 4R · Phase 7.2 (2026-08-13) — Candidate discovery layer.
//
// FOUNDER ARCHITECTURAL LAW:
//   "Spectre may have multiple independent ways to DISCOVER plausible
//    GL accounts, but exactly one mechanism may RANK and SELECT the GL
//    account."
//
// This module is the DISCOVERY layer. Its only job is to answer:
//
//   "Which accounts deserve consideration for this cluster?"
//
// It NEVER answers:
//
//   "Which account should win?"
//
// The sole winner-selection authority remains `rankCanonical()`
// (`canonical-ranker.ts`). Discovery here PRODUCES a candidate pool;
// canonical ranking CONSUMES the pool and picks the winner.
//
// Discovery may be plural. Selection must remain singular.
//
// The forensic old-vs-new comparison (docs/phase-4r-forensic-old-vs-
// new-comparison.md, 2026-08-12) established that Phase 7.1's
// candidate recall collapsed vs v206 (GL Top-1 17/42 → 9/42, +1 unsafe)
// because Phase 7.1 restricted cluster candidates to the
// `fsGroupKeyHints`-matching subset without preserving v206's four
// independent full-COA discovery passes. This module restores those
// discovery mechanisms in discover-only mode, discarding every
// winner/rank/status output before returning identities.
//
// See docs/phase-4r-forensic-old-vs-new-comparison.md §21 (Option B)
// for the architectural rationale and the founder's authorisation
// directive dated 2026-08-13.

import type { AccountView } from "../gl-account-concepts";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Discovery source provenance. Kept for diagnostics + audit trail only.
 *  Canonical ranking MUST NOT weight candidates by their discovery source
 *  or by how many sources found them. Discovery frequency is not
 *  accounting evidence. */
export type DiscoverySource =
  | { kind: "cluster_hint"; hintKey: string }
  | { kind: "purpose_ontology"; concept: string; reason: string }
  | { kind: "nature_scoped"; nature: string; reason: string }
  | { kind: "capital_aware"; decision: string; reason: string }
  | { kind: "semantic_full_coa"; reason: string }
  | { kind: "vendor_history"; accountNumber: string };

/** A candidate discovered by ONE OR MORE discovery mechanisms.
 *  Deduplicated by account identity across all sources — a candidate
 *  found by three discovery sources gets ONE entry in this list with
 *  three `discoverySources`. Canonical ranker consumes the account +
 *  the full COA pool it already receives; the discoverySources are
 *  informational-only (provenance for the recommendation reason). */
export interface DiscoveredAccountCandidate {
  accountId: string;
  accountNumber: string;
  discoverySources: DiscoverySource[];
}

/** Every discovery input the union orchestrator needs.
 *  Constructed once per cluster by the caller (`gl-allocations.ts` →
 *  `rankClusters`) and passed to `discoverCandidates`. */
export interface CandidateDiscoveryInput {
  /** The complete tenant COA already filtered through hard payroll
   *  exclusion. Discovery scans this pool — never Prisma-queries the
   *  DB directly. */
  eligibleAccounts: AccountView[];
  /** Cluster line-item descriptions — the transactionally-relevant
   *  text surface. NEVER the full document text. */
  clusterLineDescriptions: string[];
  /** Cluster concept id (may be null for unresolved clusters). */
  clusterConceptId: string | null;
  /** Cluster effective fsGroupKeyHints (walked up the concept
   *  hierarchy). Empty when unresolved. */
  clusterFsGroupHints: string[];
  /** Global signals shared across all clusters on the invoice. */
  globalSignals: DiscoveryGlobalSignals;
}

export interface DiscoveryGlobalSignals {
  supplierName: string | null;
  natureLeader: string | null;
  natureIsDefensible: boolean;
  natureConfidence: number;
  capitalDecision: string | null;
  capitalConfidence: number;
  hasHighQualityDurableAssetContext: boolean;
  hasFinancingEvidence: boolean;
  departmentKey: string | null;
  priorCodingAccountNumbers: readonly string[];
  preferredAccountNumbers: readonly string[];
  contradictedAccountNumbers: readonly string[];
}

export interface CandidateDiscoveryResult {
  /** All discovered candidates, deduplicated by accountId. Provenance
   *  from every source retained on each entry. */
  candidates: DiscoveredAccountCandidate[];
  /** Diagnostic counts by source. Founder audit surface. */
  diagnostic: Record<DiscoverySource["kind"], number>;
}

// ---------------------------------------------------------------------------
// Discovery source interface — every provider implements this
// ---------------------------------------------------------------------------

export interface DiscoveryProvider {
  readonly kind: DiscoverySource["kind"];
  /** Return the account IDs this source considers plausible for the
   *  cluster. Return an empty array (not null) when the source is
   *  inactive for this cluster. NEVER return a winner, rank, or
   *  score — this contract is intentionally impoverished so the
   *  provider physically cannot smuggle selection authority in. */
  discover(input: CandidateDiscoveryInput): Iterable<DiscoveryHit>;
}

/** A single discovery hit before dedup. */
export interface DiscoveryHit {
  accountId: string;
  accountNumber: string;
  source: DiscoverySource;
}

// ---------------------------------------------------------------------------
// Orchestrator — compose registered providers into a deduped pool
// ---------------------------------------------------------------------------

// Hard eligibility exclusions applied to EVERY discovery source.
// Mirrors v206 nature-scoped-ranker.ts §8 + the safety floor established
// by the pre-refactor engine (0 unsafe on the sealed corpus). These
// accounts must NEVER enter the candidate pool via any discovery path.
//
// TWO classes of hard exclusion:
//   1. Name-based: accum-depr, amortization, contra-assets, allowance
//      for doubtful — these are contra accounts that must never be
//      an AP debit target regardless of type.
//   2. Flag-based: bank/cash/control accounts + non-manual-posting
//      accounts — these are foundational accounting integrity rules
//      the tenant COA marks on the account record. Bank/cash cannot
//      receive AP debits without breaking the ledger; control accounts
//      are system-managed; non-manual-posting means the tenant has
//      explicitly disallowed direct entries.
const HARD_EXCLUSION_NAME_PATTERNS = [
  /\baccum(?:ulated)?\.?\s*deprec/i,   // Accum Deprec, Accumulated Depreciation, Accum. Deprec
  /\bamortization\b/i,
  /depreciation\s*[-—]/i,               // "Depreciation - " or "Depreciation —"
  /allowance\s+for\s+doubtful/i,
  /contra[-\s]*asset/i,
];
function isHardExcluded(acct: AccountView): boolean {
  for (const p of HARD_EXCLUSION_NAME_PATTERNS) if (p.test(acct.name)) return true;
  if (acct.isBankAccount) return true;
  if (acct.isCashAccount) return true;
  if (acct.isControlAccount) return true;
  if (acct.allowManualPosting === false) return true;
  return false;
}

/** Runs every registered provider, deduplicates by accountId, applies
 *  hard eligibility exclusions (contra-asset / accum-depr), retains
 *  the full provenance chain, and returns the widened candidate pool.
 *  The caller (gl-allocations.rankClusters) unions this with its own
 *  hint-preferred pool before feeding rankCanonical. */
export function discoverCandidates(
  providers: readonly DiscoveryProvider[],
  input: CandidateDiscoveryInput,
): CandidateDiscoveryResult {
  const excludedIds = new Set<string>();
  for (const acct of input.eligibleAccounts) {
    if (isHardExcluded(acct)) excludedIds.add(acct.id);
  }
  const byId = new Map<string, DiscoveredAccountCandidate>();
  const diagnostic: Record<DiscoverySource["kind"], number> = {
    cluster_hint: 0,
    purpose_ontology: 0,
    nature_scoped: 0,
    capital_aware: 0,
    semantic_full_coa: 0,
    vendor_history: 0,
  };
  for (const provider of providers) {
    for (const hit of provider.discover(input)) {
      if (excludedIds.has(hit.accountId)) continue;
      diagnostic[hit.source.kind]++;
      const existing = byId.get(hit.accountId);
      if (existing) {
        existing.discoverySources.push(hit.source);
      } else {
        byId.set(hit.accountId, {
          accountId: hit.accountId,
          accountNumber: hit.accountNumber,
          discoverySources: [hit.source],
        });
      }
    }
  }
  return { candidates: Array.from(byId.values()), diagnostic };
}

/** Union a discovery result with a pre-existing account pool
 *  (typically the cluster-hint-preferred pool built by `rankClusters`).
 *  Deduplication is by accountId. Applies hard eligibility exclusion
 *  (contra-asset / accum-depr) uniformly across BOTH the cluster
 *  pool and the discovered set — mirrors v206 nature-scoped-ranker §8.
 *  Returns the widened AccountView[] pool ready for
 *  `rankClusterCanonically`. */
export function unionEligiblePool(
  clusterPool: readonly AccountView[],
  fullTenantCoa: readonly AccountView[],
  discovery: CandidateDiscoveryResult,
): AccountView[] {
  const byId = new Map<string, AccountView>();
  for (const a of clusterPool) {
    if (isHardExcluded(a)) continue;
    byId.set(a.id, a);
  }
  const coaById = new Map<string, AccountView>();
  for (const a of fullTenantCoa) coaById.set(a.id, a);
  for (const cand of discovery.candidates) {
    if (byId.has(cand.accountId)) continue;
    const acct = coaById.get(cand.accountId);
    if (acct && !isHardExcluded(acct)) byId.set(cand.accountId, acct);
  }
  return Array.from(byId.values());
}

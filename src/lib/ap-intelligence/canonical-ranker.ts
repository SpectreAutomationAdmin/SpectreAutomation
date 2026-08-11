// Phase 4R · single-GL-authority refactor · Phase 2.2 canonical types +
// Phase 2.3 unified ranker (2026-08-11).
//
// FOUNDER §1 ARCHITECTURAL LAW — for every single-account GL
// recommendation:
//
//     analysis.gl.accountNumber === analysis.gl.candidates[0].accountNumber
//
// The winner is at candidates[0] because ONE canonical ranker chose it.
// Type contract enforces this: `RankedCandidates` is a non-empty
// readonly tuple whose head IS the winner. There is no separate
// `winnerAccountNumber` field that could diverge from `candidates[0]`.
// Downstream code reads `.candidates[0]` for the winner. Divergence is
// structurally impossible at this boundary.
//
// FOUNDER §7 DISCRIMINATED RESULT — the result union distinguishes:
//   - RECOMMEND — candidates exist, winner is materially supported
//   - ABSTAIN — candidates exist, winner is candidates[0], but total
//               evidence is insufficient for automated recommendation
//   - NO_ELIGIBLE_CANDIDATES — Phase-2 eligibility produced zero
//                              accounts
//   - ANALYSIS_FAILURE — candidate generation failed unexpectedly
//                        (empty COA, evidence extractor threw, etc.)
//
// A successful RECOMMEND with an empty candidates array is structurally
// impossible.

import type { AccountView } from "./gl-account-concepts";
import type { PostingBlocker } from "./gl-recommend";

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

/** Normalised transaction / economic interpretation. Feeds every
 *  scoring family. This is the single input to the canonical ranker;
 *  all pre-ranking intelligence upstream of the ranker (economic
 *  purpose, capital classification, department inference, vendor
 *  history, line items, taxonomy, tax treatment) has been consolidated
 *  into this shape by the caller. */
export interface NormalisedTransactionInterpretation {
  /** Committed economic purpose (from the purpose authority) — may
   *  be null when no defensible commit is available. */
  purposeConcept: string | null;
  purposeConfidence: number;  // 0..100
  purposeQuality: "HIGH" | "MEDIUM" | "LOW" | "NONE";

  /** Capital classification decision — from evaluateCapitalObjectEvidence. */
  capitalDecision: "CAPITAL_CANDIDATE" | "OPERATING" | "REPAIR_MAINTENANCE" | "UNRESOLVED" | null;
  capitalConfidence: number;  // 0..100

  /** Committed accounting nature — from the accounting-nature classifier. */
  natureLeader: string;       // e.g. "OPERATING_EXPENSE" | "CAPITAL_ASSET" | "REPAIR_MAINTENANCE" | ...
  natureConfidence: number;
  natureIsDefensible: boolean;

  /** Department inference — key + name-pattern list for account-name
   *  matching. */
  departmentKey: string | null;
  departmentAccountNamePatterns: ReadonlyArray<RegExp>;

  /** Line items (canonical). Used for Jaccard + concept extraction +
   *  document-phrase evidence. */
  canonicalLineItems: ReadonlyArray<{
    description: string;
    role: string;              // "PRIMARY_PURCHASE" | "SURCHARGE" | "FREIGHT" | etc.
    extension: number | null;
  }>;

  /** Query concepts extracted from the transaction (line items +
   *  document phrases + vendor context + prior coding). Each carries
   *  a source, a weight, and the concept id. Used by the ranker to
   *  score against account concepts via conceptRelatedness. */
  queryConcepts: ReadonlyArray<{
    conceptId: string;
    weight: number;
    source: "line_item_description" | "economic_purpose" | "document_phrase" | "vendor_history" | "supplier_identity" | string;
    evidenceSnippet: string;
  }>;

  /** Vendor context — the tenant vendor identifier if the vendor is
   *  matched, the vendor-default expense account if any, and prior
   *  coding preferences. */
  vendor: {
    matchedVendorId: string | null;
    defaultAccountId: string | null;
    priorCodingAccountNumbers: ReadonlyArray<string>;
  };

  /** Full document text — for document-phrase evidence emission. */
  documentPhraseText: string | null;
}

/** Complete input to `rankCanonical`. */
export interface CanonicalRankerInput {
  transaction: NormalisedTransactionInterpretation;
  eligibleAccounts: ReadonlyArray<AccountView>;
  postingBlockersByAccount: Map<string, PostingBlocker[]>;
}

// ---------------------------------------------------------------------------
// Evidence model (Phase 4 will add DECISION/DIAGNOSTIC role; Phase 2
// emits evidence with a raw `contribution` value so Phase 4's threshold
// derivation has real data to work with.)
// ---------------------------------------------------------------------------

/** Evidence-family taxonomy per §3.3 of the scoring doc. */
export type CanonicalEvidenceFamily =
  | "TRANSACTION_TEXT"    // line items + document phrases + phrase-derived concepts
  | "TAXONOMY_ALIGNMENT"  // account-name / fs-group / category similarity to dominant concept
  | "NATURE_ROLE"         // capital vs operating + account role + nature-compat
  | "VENDOR_HISTORY"      // prior coding + vendor-default + supplier context
  | "DEPARTMENT_CONTEXT"; // organisational beneficiary

/** Machine-readable evidence emitted by the ranker. Phase 4 will add
 *  `role: "DECISION" | "DIAGNOSTIC"` derived empirically. */
export interface CanonicalEvidence {
  family: CanonicalEvidenceFamily;
  /** Sub-kind within family — e.g. "LINE_ITEM_MATCH" / "ONTOLOGY_MATCH" /
   *  "LINE_ITEM_JACCARD" for TRANSACTION_TEXT. */
  kind: string;
  /** Contribution to the candidate's total score (before family
   *  MAX-collapse). Positive for support, negative for contradiction. */
  contribution: number;
  /** Human-readable snippet naming the evidence source. */
  description: string;
}

// ---------------------------------------------------------------------------
// Candidate + result contracts
// ---------------------------------------------------------------------------

/** A single scored candidate. */
export interface CanonicalCandidate {
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: string;             // "EXPENSE" | "ASSET" | ...
  categoryKey: string | null;
  fsGroupKey: string | null;

  /** Canonical score 0..100 (harmonised scale). */
  score: number;

  /** Per-family contribution AFTER max-within-family collapse. */
  familyContributions: Readonly<Record<CanonicalEvidenceFamily, number>>;

  /** Total negative penalty applied. */
  contradictionPenalty: number;

  /** All raw evidence observations (pre-collapse). Phase 4 will
   *  classify each as DECISION or DIAGNOSTIC. */
  evidence: ReadonlyArray<CanonicalEvidence>;

  /** Machine-readable contradiction reason codes. */
  contradictions: ReadonlyArray<string>;

  /** Posting eligibility (surfaced from the eligibility filter). */
  postable: boolean;
  postingBlockers: ReadonlyArray<PostingBlocker>;
}

/** Provenance metadata for §9 winner-provenance requirement. */
export interface CanonicalRankerProvenance {
  rulesFired: ReadonlyArray<string>;
  totalCandidatesConsidered: number;
  eligibilityRejectedCount: number;
  rankerVersion: number;
}

/** Non-empty readonly candidate list. */
export type RankedCandidatesNonEmpty =
  Readonly<[CanonicalCandidate, ...CanonicalCandidate[]]>;

/** DISCRIMINATED RESULT UNION (§7). Each variant makes the invalid
 *  states of the other variants unrepresentable. */
export type CanonicalRankerResult =
  | {
      /** RECOMMEND — candidates exist, winner is materially supported.
       *  winner === candidates[0] by construction. */
      readonly status: "RECOMMEND";
      readonly candidates: RankedCandidatesNonEmpty;
      readonly abstentionReason: null;
      readonly provenance: CanonicalRankerProvenance;
    }
  | {
      /** ABSTAIN — candidates exist, winner is candidates[0], but
       *  evidence is insufficient for automated recommendation. */
      readonly status: "ABSTAIN";
      readonly candidates: RankedCandidatesNonEmpty;
      readonly abstentionReason: string;
      readonly provenance: CanonicalRankerProvenance;
    }
  | {
      /** NO_ELIGIBLE_CANDIDATES — Phase-2 eligibility produced zero
       *  accounts. Distinct from RECOMMEND/ABSTAIN. */
      readonly status: "NO_ELIGIBLE_CANDIDATES";
      readonly candidates: readonly [];
      readonly abstentionReason: string;
      readonly provenance: CanonicalRankerProvenance;
    }
  | {
      /** ANALYSIS_FAILURE — unexpected failure in candidate
       *  generation. Distinct from the above. */
      readonly status: "ANALYSIS_FAILURE";
      readonly candidates: readonly [];
      readonly abstentionReason: string;
      readonly provenance: CanonicalRankerProvenance;
    };

// ---------------------------------------------------------------------------
// Selector helpers (winner is ALWAYS candidates[0])
// ---------------------------------------------------------------------------

/** Returns the canonical winner accountNumber. Only defined for
 *  RECOMMEND and ABSTAIN statuses. NO_ELIGIBLE_CANDIDATES / ANALYSIS_
 *  FAILURE return null — those states are semantically "no winner". */
export function canonicalWinnerAccountNumber(result: CanonicalRankerResult): string | null {
  if (result.status === "RECOMMEND" || result.status === "ABSTAIN") {
    return result.candidates[0].accountNumber;
  }
  return null;
}

/** Returns true when a RECOMMEND result exists. */
export function canonicalHasRecommendation(result: CanonicalRankerResult): boolean {
  return result.status === "RECOMMEND";
}

// ---------------------------------------------------------------------------
// Phase 2.3 · rankCanonical implementation
// ---------------------------------------------------------------------------
// STUB — Phase 2.3 implementation to be written in the next session
// following the design in docs/phase-4r-unified-ranker-scoring.md §6.
// Types + result contract complete in this file; implementation
// intentionally deferred so this file compiles and can be imported
// by the Phase 1 tests without introducing runtime side effects.

const RANKER_VERSION = 1;

/** Placeholder implementation. Returns a NO_ELIGIBLE_CANDIDATES
 *  result unconditionally so callers can wire the type contract
 *  without triggering behaviour. Phase 2.3 replaces this body. */
export function rankCanonical(input: CanonicalRankerInput): CanonicalRankerResult {
  void input;
  return {
    status: "NO_ELIGIBLE_CANDIDATES",
    candidates: [],
    abstentionReason: "rankCanonical: Phase 2.3 implementation pending — placeholder returns NO_ELIGIBLE_CANDIDATES",
    provenance: {
      rulesFired: [],
      totalCandidatesConsidered: 0,
      eligibilityRejectedCount: 0,
      rankerVersion: RANKER_VERSION,
    },
  };
}

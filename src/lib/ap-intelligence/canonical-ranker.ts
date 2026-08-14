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
//
// A successful RECOMMEND with an empty candidates array is structurally
// impossible.

import type { AccountView } from "./gl-account-concepts";
import { extractConceptsForAccount } from "./gl-account-concepts";
import type { PostingBlocker } from "./gl-recommend";
import { conceptRelatedness, isContradiction } from "./gl-concepts";
import { evaluatePurposeAccountAffinity } from "./purpose-to-gl-ontology";
// Phase 4R · Phase 7.2L (2026-08-13) — static import for tier assignment.
// account-semantics has NO import of canonical-ranker (verified) so no cycle.
import { resolveAccountSemantics as _resolveAccountSemantics } from "./account-semantics";

/** Local mirror of purposeExpectedRoles from purpose-driven-ranker.ts.
 *  Kept private to canonical-ranker so this file has no dependency on
 *  the legacy pipeline. Small closed list. */
const PURPOSE_ROLE_HINTS: Record<string, ReadonlyArray<string>> = {
  FUEL: ["OPERATING_EXPENSE"],
  LUBRICANTS: ["OPERATING_EXPENSE", "R&M_EXPENSE"],
  EQUIPMENT_PARTS: ["R&M_EXPENSE", "OPERATING_EXPENSE"],
  REPAIR_MAINTENANCE: ["R&M_EXPENSE"],
  CAPITAL_EQUIPMENT: ["CAPITAL_ASSET"],
  TELECOMMUNICATIONS: ["OPERATING_EXPENSE"],
  INTERNET_CONNECTIVITY: ["OPERATING_EXPENSE"],
  SOFTWARE_SUBSCRIPTION: ["OPERATING_EXPENSE"],
  PROFESSIONAL_MEMBERSHIP: ["OPERATING_EXPENSE"],
  PROFESSIONAL_SERVICES: ["OPERATING_EXPENSE"],
  BUILDING_MAINTENANCE: ["R&M_EXPENSE"],
  COURSE_MAINTENANCE: ["OPERATING_EXPENSE", "R&M_EXPENSE"],
  OFFICE_SUPPLIES: ["OPERATING_EXPENSE"],
  INTEREST: ["OPERATING_EXPENSE"],
  PENALTY: ["OPERATING_EXPENSE"],
};
function expectedAccountRoles(concept: string): ReadonlyArray<string> {
  return PURPOSE_ROLE_HINTS[concept] ?? [];
}

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

  /** Phase 4R · Phase 3.4 (Group C) — compatibility-gate verdicts
   *  computed upstream (facade) from productIdentity + purchasedObjects
   *  + capital decision + CIP/financing evidence + department signals.
   *  Replaces Group C's capital-aware full-COA ranker with pre-ranking
   *  scoring evidence inside the CAPITAL_NATURE family. When populated,
   *  every account.accountNumber listed here receives the corresponding
   *  observation during canonical scoring.
   *
   *  preferredAccountNumbers → NATURE_GATE_PREFERRED (+12)
   *  contradictedAccountNumbers → NATURE_GATE_CONTRADICTED (-20) + contradiction
   *
   *  MAX-within-family scoring already collapses correlated CAPITAL_NATURE
   *  observations, so these do not double-count against NATURE_COMPAT /
   *  CAPITAL_ASSET_MATCH / RM_EXPENSE_MATCH. Not a second competition —
   *  scoring evidence inside the single canonical rank. */
  preferredAccountNumbers?: ReadonlyArray<string>;
  contradictedAccountNumbers?: ReadonlyArray<string>;

  /** Phase 4R · Phase 3.5 (Group D) — purchased-object substance signal.
   *  True when the primary purchased object is HIGH-quality evidence of
   *  a durable-asset context (COMPLETE_MACHINE / SERIALIZED_COMPONENT /
   *  UNKNOWN with brand+model). Used by canonical scoring to contradict
   *  fee-family EXPENSE accounts (IS_INTEREST_EXPENSE / IS_BANK_CHARGES
   *  / IS_MERCHANT_FEES) by TAXONOMY (fsGroupKey) — not by account-name
   *  regex — when the transaction clearly represents a physical purchase
   *  and no financing evidence is present. Replaces Group D's
   *  post-canonical object-authority guard. */
  hasHighQualityDurableAssetContext?: boolean;
  /** Phase 4R · Phase 3.5 (Group D) — financing signal (from facade
   *  detectFinancingEvidence). When true, the transaction may
   *  legitimately involve interest/fee accounts even if a durable asset
   *  is also present (e.g., financed equipment lease). Used to guard
   *  the durable-asset-vs-fee contradiction so it defeasibly disables
   *  when the transaction genuinely represents financing. */
  hasFinancingEvidence?: boolean;

  /** Phase 4R · Phase 7.2L (2026-08-13) — composed accounting treatment
   *  (the CanonicalAccountingTreatment from treatment-composition.ts).
   *  Consumed ONLY by the tier-assignment step inside rankCanonical.
   *  Never used to score a candidate directly. When absent, tier
   *  assignment falls back to OPEN_TREATMENT mode (every eligible
   *  account is PLAUSIBLE). */
  canonicalAccountingTreatment?: import("./treatment-composition").CanonicalAccountingTreatment;
}

/** Complete input to `rankCanonical`. */
export interface CanonicalRankerInput {
  transaction: NormalisedTransactionInterpretation;
  eligibleAccounts: ReadonlyArray<AccountView>;
  postingBlockersByAccount: Map<string, PostingBlocker[]>;
  /** Phase 4R · Phase 7.2L (2026-08-13) — pre-resolved
   *  CanonicalAccountSemantics per account, keyed by accountId.
   *  Consumed by tier assignment ONLY. Kept separate from AccountView
   *  so scoring observations (NATURE_COMPAT, CAPITAL_ASSET_MATCH,
   *  PURPOSE_TYPE_COMPAT) that read `accountType` don't silently
   *  change activation pattern (see analyse.ts comment at
   *  `allocationAccounts` for the rationale — Founder §14 activation-
   *  change safety on LOCKED cases). */
  accountSemanticsByAccountId?: Map<string, { statementRole: string; accountingClass: string }>;
}

// ---------------------------------------------------------------------------
// Phase 4R · Phase 7.2L (2026-08-13) — Hierarchical canonical competition.
//
// Founder §1: "rankCanonical() remains the ONLY winner-selection authority."
//
// Phase 7.2L introduces a TIER dimension applied INSIDE rankCanonical
// before the numeric sort. Tier is an organizing dimension, NOT another
// evidence weight (Founder §8). The comparator respects tier priority
// ONLY when the composed treatment is defensibly asserted
// (ASSERTED_TREATMENT mode); under OPEN_TREATMENT mode the existing
// flat score decides (Founder §3).
//
// Semantic contracts consumed:
//   - CanonicalAccountingTreatment (from transaction.canonicalAccountingTreatment)
//   - CanonicalAccountSemantics (resolved per candidate)
//
// See docs/phase-4r-phase72l-checkpoint.md for the full design.
// ---------------------------------------------------------------------------

/** Treatment compatibility tier per Founder §2. Tier is metadata on
 *  each `CanonicalCandidate`; canonical ordering respects tier
 *  priority conditionally (see `CompetitionMode`). */
export type CandidateTier =
  | "PRIMARY"        // account semantics directly match asserted treatment
  | "PLAUSIBLE"      // legitimate cross-treatment / unresolved-treatment candidate
  | "CONTRADICTED"   // structurally postable but materially inconsistent with ASSERTED treatment
  | "INELIGIBLE";    // reserved for structural posting restrictions ONLY

/** Competition mode per Founder §3.
 *
 *  ASSERTED_TREATMENT: composed treatment defensibility is STRONG.
 *    Tier priority governs cross-tier ordering (PRIMARY before
 *    PLAUSIBLE before CONTRADICTED). Within a tier, existing numeric
 *    score decides.
 *
 *  OPEN_TREATMENT: composed treatment defensibility is WEAK or
 *    UNRESOLVED, or treatment is absent. Tier priority DOES NOT
 *    govern cross-tier ordering; existing flat numeric score decides
 *    across all tiers. INELIGIBLE candidates are still last (they
 *    are structural, not treatment-inferred). */
export type CompetitionMode = "ASSERTED_TREATMENT" | "OPEN_TREATMENT";

// ---------------------------------------------------------------------------
// Evidence model (Phase 4 will add DECISION/DIAGNOSTIC role; Phase 2
// emits evidence with a raw `contribution` value so Phase 4's threshold
// derivation has real data to work with.)
// ---------------------------------------------------------------------------

/** Evidence-family taxonomy per §3.3 of the scoring doc (revised in
 *  Phase 2.3 per founder §3 — validate families represent
 *  reasonably independent accounting evidence).
 *
 *  Rationale for each family:
 *    - TRANSACTION_TEXT: signals derived from the invoice's own text
 *      content (line items, document phrases, purpose extractions,
 *      ontology matches, Jaccard). MAX because they're derivatives
 *      of the same underlying textual observation.
 *    - TAXONOMY_ALIGNMENT: signals about the ACCOUNT's own taxonomy
 *      (name / fsGroup / category) matching the dominant transaction
 *      concept + specificity bonus. MAX because they're all
 *      account-side taxonomy views of the same account.
 *    - CAPITAL_NATURE: signals about accounting nature (capital vs
 *      operating vs repair) — capital classifier decision, nature
 *      classifier compat, account-role expected role. MAX because
 *      they're all "is this account the right NATURE for this
 *      transaction?".
 *    - VENDOR_HISTORY: signals from tenant's prior coding + vendor-
 *      default + supplier context. MAX because they all encode
 *      "this vendor has been coded to this account before".
 *    - DEPARTMENT_CONTEXT: department affinity (organisational
 *      beneficiary). Single signal, MAX trivially.
 *
 *  Contradictions are handled separately (not a family) — they
 *  SUM across all triggered rules because each represents a
 *  distinct negative observation. */
export type CanonicalEvidenceFamily =
  | "TRANSACTION_TEXT"
  | "TAXONOMY_ALIGNMENT"
  | "CAPITAL_NATURE"
  | "VENDOR_HISTORY"
  | "DEPARTMENT_CONTEXT";

/** Machine-readable evidence emitted by the ranker. Phase 4 added
 *  `role: "DECISION" | "DIAGNOSTIC"` assigned during MAX-within-family
 *  collapse (see collapseByFamily). See docs/phase-4-evidence-integrity
 *  for the empirical derivation of the DECISION rule. */
export type CanonicalEvidenceRole = "DECISION" | "DIAGNOSTIC";
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
  /** True when this observation contributed to the candidate's
   *  score. False when it was suppressed by the family MAX-collapse
   *  (retained for engineering diagnostics per §4). */
  countedTowardScore: boolean;
  /** Phase 4R · Phase 4 (2026-08-11) — DECISION vs DIAGNOSTIC role.
   *  DECISION: this observation materially contributes to the
   *    candidate's accounting reasoning (may feed founder-facing
   *    explanations, competitor qualification, confidence).
   *  DIAGNOSTIC: retained for engineering traceability but too weak
   *    or too correlated to represent substantive accounting support.
   *
   *  Empirical rule (derived from observed ranker weights + the
   *  COMMIT_MIN_SCORE=30 threshold, see calibration in
   *  docs/phase-4-evidence-integrity.md):
   *
   *    Suppressed positives (countedTowardScore=false) → DIAGNOSTIC always
   *      (they were correlated with a stronger sibling; retained only
   *      for engineering).
   *    Contradictions (contribution < 0) with |contribution| >= 10 → DECISION
   *      (they materially change ranking outcome).
   *    Positive counted observations with contribution >= 10 → DECISION
   *      (single observation carries >=1/3 of COMMIT_MIN_SCORE).
   *    Positive counted observations with contribution >= 5 AND
   *      family total >= 15 → DECISION (small observation is part of a
   *      family that materially contributes; family cap ranges 12-40
   *      so 15 is the "meaningful family narrative" floor).
   *    Everything else → DIAGNOSTIC.
   */
  role: CanonicalEvidenceRole;
}

/** Machine-readable contradiction reason. */
export interface CanonicalContradiction {
  /** Rule identifier, e.g. "capital_candidate_but_account_is_rm_expense". */
  code: string;
  /** Penalty magnitude (positive; subtracted from the total). */
  penalty: number;
  /** Human-readable snippet naming the contradiction. */
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
  contradictions: ReadonlyArray<CanonicalContradiction>;

  /** Posting eligibility (surfaced from the eligibility filter). */
  postable: boolean;
  postingBlockers: ReadonlyArray<PostingBlocker>;

  /** Phase 4R · Phase 7.2L (2026-08-13) — treatment compatibility tier.
   *  Metadata, NOT score. Consumed by the sort comparator under
   *  ASSERTED_TREATMENT competition mode. Under OPEN_TREATMENT mode,
   *  tier does not affect ordering (except INELIGIBLE which is always
   *  last — structural). */
  tier: CandidateTier;

  /** Phase 4R · Phase 7.2L — human-readable tier assignment reason
   *  for founder-facing explanations + engineering diagnostics. */
  tierReason: string;
}

/** Provenance metadata for §9 winner-provenance requirement. */
export interface CanonicalRankerProvenance {
  rulesFired: ReadonlyArray<string>;
  totalCandidatesConsidered: number;
  eligibilityRejectedCount: number;
  rankerVersion: number;
}

/** Winner separation info — Phase 2 exit-gate §3 requirement.
 *
 *  Downstream consumers (Phase 4 confidence) MUST distinguish:
 *    - deterministic tie-break: `score[0] === score[1]` — a
 *      technical winner picked by accountNumber ordering, NOT
 *      evidentiary superiority. Confidence policy must not treat
 *      this as a strong recommendation.
 *    - material margin: `score[0] > score[1]` by a meaningful gap
 *      reflecting real accounting evidence separation.
 *
 *  §3: "A deterministic winner is not an evidentiary winner."
 *
 *  Emitted on RECOMMEND and ABSTAIN variants inside the candidates
 *  array via a top-level `separation` field. */
export interface CanonicalWinnerSeparation {
  /** Absolute score gap: candidates[0].score - candidates[1].score.
   *  Zero when there is a tie or only one candidate. */
  marginToRunnerUp: number;
  /** True when candidates[0].score === candidates[1].score. The
   *  winner is technically selected by deterministic accountNumber
   *  ordering, not by material score advantage. */
  isDeterministicTieBreak: boolean;
  /** Number of runners-up whose score equals candidates[0].score
   *  (i.e. structurally-tied competitors). Zero when no tie. */
  tiedRunnerUpCount: number;
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
      readonly separation: CanonicalWinnerSeparation;
      readonly abstentionReason: null;
      readonly provenance: CanonicalRankerProvenance;
    }
  | {
      /** ABSTAIN — candidates exist, winner is candidates[0], but
       *  evidence is insufficient for automated recommendation. */
      readonly status: "ABSTAIN";
      readonly candidates: RankedCandidatesNonEmpty;
      readonly separation: CanonicalWinnerSeparation;
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

const RANKER_VERSION = 2;

/** Scoring weights (harmonised 0..100 scale). Total maximum ~130
 *  across families before penalties; normalised at emit time. */
const WEIGHTS = {
  // TRANSACTION_TEXT family (max 40)
  LINE_ITEM_MATCH: 25,           // strong direct line-item concept ↔ account concept
  ECONOMIC_PURPOSE: 20,          // committed purpose ↔ account concept
  DOCUMENT_PHRASE: 15,           // document-phrase concept ↔ account concept
  PURPOSE_TYPE_COMPAT: 12,       // account TYPE compatible with purpose
  PURPOSE_TYPE_MISMATCH: -6,     // account TYPE NOT compatible with purpose (soft)
  PURPOSE_CATEGORY_HINT: 10,     // account categoryKey ∈ purpose category hints
  ONTOLOGY_NAME_MATCH: 20,       // ontology name-substring boost
  LINE_ITEM_JACCARD_MAX: 15,     // Jaccard(line-item tokens, account-name tokens) × 15
  // TAXONOMY_ALIGNMENT family (max 30)
  ACCOUNT_NAME_SIMILARITY_MAX: 20,
  FS_GROUP_TAXONOMY_MAX: 15,
  CATEGORY_TAXONOMY_MAX: 10,
  SPECIFICITY_BONUS_PER_DEPTH: 5,
  // CAPITAL_NATURE family (max 25)
  NATURE_COMPAT_MATCH: 15,
  NATURE_INCOMPATIBLE_PENALTY: -18,
  ACCOUNT_ROLE_MATCH: 10,
  CAPITAL_ASSET_MATCH: 20,           // ASSET account when CAPITAL_CANDIDATE
  CAPITAL_ASSET_CATEGORY_BONUS: 6,
  RM_EXPENSE_MATCH: 20,              // R&M expense when REPAIR_MAINTENANCE
  CAPITAL_ACCOUNT_CONTRADICTION: -25, // asset account when REPAIR_MAINTENANCE
  RM_EXPENSE_CONTRADICTION: -12,     // R&M expense when CAPITAL_CANDIDATE
  // Phase 4R · Phase 3.4 (Group C) — pre-ranking compatibility-gate
  // verdicts, computed upstream in the facade from productIdentity +
  // purchasedObjects + capital decision + CIP/financing evidence.
  NATURE_GATE_PREFERRED: 12,         // account passes gate as PREFERRED
  NATURE_GATE_CONTRADICTED: -20,     // account rejected as INCOMPATIBLE/CONTRADICTED
  // Phase 4R · Phase 3.5 (Group D) — durable-asset object contradicts
  // fee-family EXPENSE accounts (fsGroupKey taxonomy-based, not name
  // regex). Defeasible: only fires when financing evidence is absent.
  OBJECT_ROLE_CONTRADICTION: -22,    // durable asset with no financing evidence vs IS_INTEREST_EXPENSE / IS_BANK_CHARGES / IS_MERCHANT_FEES
  // VENDOR_HISTORY family (max 20)
  VENDOR_DEFAULT_MATCH: 15,
  PRIOR_CODING_MATCH: 12,
  SUPPLIER_CONTEXT_MATCH: 10,
  // DEPARTMENT_CONTEXT family (max 12)
  DEPARTMENT_AFFINITY: 12,
  // Contradictions
  CONTRADICTION_PENALTY: 18,
} as const;

/** Score below this floor triggers ABSTAIN, but candidates[0] still
 *  populated so the invariant holds. */
const COMMIT_MIN_SCORE = 30;

/** Normalisation cap — the raw sum before normalisation. Values above
 *  this are clamped to 100. Chosen empirically so a strong single-
 *  concept invoice with vendor default + department match reaches
 *  ~85, and a weak-evidence winner sits in the 30-50 range. */
const RAW_SCORE_CAP = 105;

// ---------------------------------------------------------------------------
// Helper: convert raw evidence observations into family contributions
// with MAX-within-family + retain suppressed evidence for diagnostics
// ---------------------------------------------------------------------------

interface RawObservation {
  family: CanonicalEvidenceFamily;
  kind: string;
  contribution: number;
  description: string;
}

/** Phase 4R · Phase 4 (2026-08-11) — empirical DECISION-role rule.
 *  Assigns role at the point where family totals are known (§4 —
 *  do not reverse-engineer role in downstream projections).
 *
 *  Absolute thresholds are grounded in the ranker's own weights:
 *    - COMMIT_MIN_SCORE = 30 (canonical winner floor)
 *    - Individual weights range 5..25 (see WEIGHTS)
 *    - Family caps: TRANSACTION_TEXT max ~40, TAXONOMY_ALIGNMENT
 *      max ~30, CAPITAL_NATURE max ~25 (via MAX-within-family)
 *
 *  DECISION rule:
 *    - suppressed positives (countedTowardScore === false) → DIAGNOSTIC
 *      (a stronger sibling carried the family; this one is retained
 *      only for engineering traceability)
 *    - contradictions (contribution < 0) with |contribution| >= 10
 *      → DECISION (they materially change ranking outcome —
 *      NATURE_INCOMPATIBLE_PENALTY=-18, RM_EXPENSE_CONTRADICTION=-12,
 *      NATURE_GATE_CONTRADICTED=-20, OBJECT_ROLE_CONTRADICTION=-22)
 *    - positive counted observations with |contribution| >= 10
 *      → DECISION (carries >=1/3 of COMMIT_MIN_SCORE alone)
 *    - positive counted observations with 5 <= |contribution| < 10
 *      AND |familyContribution| >= 15 → DECISION (small individual
 *      observation but part of a meaningfully-contributing family)
 *    - everything else → DIAGNOSTIC
 */
function classifyEvidenceRole(
  contribution: number,
  countedTowardScore: boolean,
  familyContribution: number,
): CanonicalEvidenceRole {
  const abs = Math.abs(contribution);
  const familyAbs = Math.abs(familyContribution);
  const isContradiction = contribution < 0;
  if (!countedTowardScore) return "DIAGNOSTIC";
  if (isContradiction) return abs >= 10 ? "DECISION" : "DIAGNOSTIC";
  if (abs >= 10) return "DECISION";
  if (abs >= 5 && familyAbs >= 15) return "DECISION";
  return "DIAGNOSTIC";
}

/** Phase 4R · Phase 7.2E-a (2026-08-13) — evidence-independence key.
 *
 *  Derives a provenance identifier per observation so `collapseByFamily`
 *  can distinguish correlated derivatives (multiple transformations of
 *  the same source fact) from genuinely independent observations
 *  (different reasoning paths / different physical invoice lines).
 *
 *  Same origin key ⇒ correlated ⇒ MAX-collapse.
 *  Different origin keys within the same family ⇒ potentially
 *  independent ⇒ bounded SUM (cap = INDEPENDENT_ORIGINS_CAP).
 *
 *  Origin is inferred from the observation `kind` + `description`
 *  because `RawObservation` didn't previously retain per-line
 *  provenance directly. Per-line kinds (LINE_ITEM_MATCH,
 *  ECONOMIC_PURPOSE, DOCUMENT_PHRASE, PRIOR_CODING, SUPPLIER_CONTEXT)
 *  use `${kind}:${description}` — each qc's evidenceSnippet encodes
 *  the source phrase / concept so distinct sources produce distinct
 *  descriptions. Whole-invoice kinds share one origin per authority
 *  (purpose_authority / nature_classifier / capital_classifier /
 *  compat_gate / taxonomy_alignment / vendor_default / department /
 *  line_item_jaccard).
 *
 *  Founder §3: "The aggregation rule should reason from provenance."
 *  Founder §5: "Do not permit unbounded stacking."
 */
const INDEPENDENT_ORIGINS_CAP = 2;

function inferObservationOrigin(obs: RawObservation): string {
  const k = obs.kind;
  // Per-line / per-source kinds — description encodes the source
  // phrase or concept so distinct sources produce distinct origins.
  if (k === "LINE_ITEM_MATCH" || k === "ECONOMIC_PURPOSE"
      || k === "DOCUMENT_PHRASE" || k === "PRIOR_CODING"
      || k === "SUPPLIER_CONTEXT" || k === "NAME_KEYWORD") {
    return `${k}:${obs.description}`;
  }
  // Whole-invoice signals derived from single classifier/authority.
  if (k === "PURPOSE_TYPE_COMPAT" || k === "PURPOSE_TYPE_MISMATCH"
      || k === "PURPOSE_CATEGORY_HINT" || k === "ONTOLOGY_NAME_MATCH") {
    return "purpose_authority";
  }
  if (k === "NATURE_COMPAT" || k === "NATURE_INCOMPATIBLE"
      || k === "ACCOUNT_ROLE_MATCH") {
    return "nature_classifier";
  }
  if (k === "CAPITAL_ASSET_MATCH" || k === "CAPITAL_ASSET_CATEGORY_BONUS"
      || k === "RM_EXPENSE_MATCH" || k === "RM_EXPENSE_CONTRADICTION"
      || k === "CAPITAL_ACCOUNT_CONTRADICTION") {
    return "capital_classifier";
  }
  if (k === "NATURE_GATE_PREFERRED" || k === "NATURE_GATE_CONTRADICTED"
      || k === "OBJECT_ROLE_CONTRADICTION") {
    return "compat_gate";
  }
  if (k === "ACCOUNT_NAME_SIMILARITY" || k === "FS_GROUP_TAXONOMY"
      || k === "CATEGORY_TAXONOMY" || k === "SPECIFICITY_BONUS") {
    return "taxonomy_alignment";
  }
  if (k === "VENDOR_DEFAULT") return "vendor_default";
  if (k === "LINE_ITEM_JACCARD") return "line_item_jaccard";
  if (k === "DEPARTMENT_AFFINITY") return "department";
  // Unknown kind — treat as unique so it counts independently.
  return `${k}:${obs.description}`;
}

/** Collapse a candidate's raw observations by family (Phase 7.2E-a:
 *  correlated-group MAX + bounded independent SUM within family) and
 *  emit the CanonicalEvidence array with `countedTowardScore`
 *  + `role` markers per §4. Roles are computed here (not in the
 *  projection) so downstream code doesn't reverse-engineer them. */
function collapseByFamily(observations: RawObservation[]): {
  familyContributions: Record<CanonicalEvidenceFamily, number>;
  evidence: CanonicalEvidence[];
} {
  const familyContributions: Record<CanonicalEvidenceFamily, number> = {
    TRANSACTION_TEXT: 0,
    TAXONOMY_ALIGNMENT: 0,
    CAPITAL_NATURE: 0,
    VENDOR_HISTORY: 0,
    DEPARTMENT_CONTEXT: 0,
  };
  // Split observations by family.
  const byFamily = new Map<CanonicalEvidenceFamily, RawObservation[]>();
  for (const obs of observations) {
    const bucket = byFamily.get(obs.family) ?? [];
    bucket.push(obs);
    byFamily.set(obs.family, bucket);
  }
  const evidence: CanonicalEvidence[] = [];
  for (const [family, obs] of byFamily) {
    // Split positive vs negative — MAX applies to positive observations
    // only. Negative observations (contradictions within a family)
    // SUM because they represent distinct penalties.
    //
    // Phase 4R · Phase 7.2E-a (2026-08-13) — bounded-corroboration
    // aggregation was ATTEMPTED at this location but REVERTED under
    // §8 mandatory safety (unsafe rose from 0 to 1 on
    // `statement-of-account`). See docs/phase-4r-phase72e-a-checkpoint.md
    // for the full report. `inferObservationOrigin` +
    // `INDEPENDENT_ORIGINS_CAP` remain in the file above so a future
    // slice can re-attempt with a stricter gate (e.g. only apply
    // bounded SUM when the document is classified INVOICE and the
    // canonical purpose committed). MAX-within-family restored.
    const positive = obs.filter((o) => o.contribution >= 0);
    const negative = obs.filter((o) => o.contribution < 0);
    let winningContribution = 0;
    let winningObs: RawObservation | null = null;
    if (positive.length > 0) {
      winningObs = positive.reduce((max, o) => o.contribution > max.contribution ? o : max);
      winningContribution = winningObs.contribution;
    }
    // Sum negatives.
    const negativeSum = negative.reduce((s, o) => s + o.contribution, 0);
    familyContributions[family] = winningContribution + negativeSum;
    const familyTotal = familyContributions[family];
    // Emit evidence — winning observation counted, others suppressed
    // but retained for diagnostics. Role assigned inline per §4.
    for (const o of positive) {
      const counted = o === winningObs;
      evidence.push({
        family,
        kind: o.kind,
        contribution: o.contribution,
        description: o.description,
        countedTowardScore: counted,
        role: classifyEvidenceRole(o.contribution, counted, familyTotal),
      });
    }
    for (const o of negative) {
      evidence.push({
        family,
        kind: o.kind,
        contribution: o.contribution,
        description: o.description,
        countedTowardScore: true,
        role: classifyEvidenceRole(o.contribution, true, familyTotal),
      });
    }
  }
  return { familyContributions, evidence };
}

// ---------------------------------------------------------------------------
// Score a single candidate against the transaction interpretation
// ---------------------------------------------------------------------------

// Purpose-to-account-type compatibility matrix (mirrors the legacy
// PURPOSE_ACCOUNT_TYPE + PURPOSE_CATEGORY_HINTS from purpose-driven-
// ranker.ts §2.1-2.2 in the scoring doc). Kept as a local closed
// list because it's the canonical ranker's own semantic gate.
const PURPOSE_ACCOUNT_TYPE: Record<string, ReadonlyArray<string>> = {
  FUEL: ["EXPENSE"],
  LUBRICANTS: ["EXPENSE"],
  EQUIPMENT: ["ASSET", "EXPENSE"],
  EQUIPMENT_PARTS: ["EXPENSE"],
  REPAIR_MAINTENANCE: ["EXPENSE"],
  CAPITAL_EQUIPMENT: ["ASSET"],
  TELECOMMUNICATIONS: ["EXPENSE"],
  INTERNET_CONNECTIVITY: ["EXPENSE"],
  SOFTWARE_SUBSCRIPTION: ["EXPENSE", "ASSET"],
  PROFESSIONAL_MEMBERSHIP: ["EXPENSE"],
  PROFESSIONAL_SERVICES: ["EXPENSE"],
  FOOD: ["EXPENSE", "COST_OF_SALES", "COGS"],
  BEVERAGE: ["EXPENSE", "COST_OF_SALES", "COGS"],
  FREIGHT_DELIVERY: ["EXPENSE"],
  BUILDING_MAINTENANCE: ["EXPENSE"],
  COURSE_MAINTENANCE: ["EXPENSE"],
  OFFICE_SUPPLIES: ["EXPENSE"],
  INTEREST: ["EXPENSE"],
  PENALTY: ["EXPENSE"],
  // Phase 4R · Phase 7.2F (2026-08-13) — new accounting-nature purposes.
  CAPITAL_IMPROVEMENT: ["ASSET"],
  LAND_ACQUISITION: ["ASSET"],
  BUILDING_ACQUISITION: ["ASSET"],
  CONSTRUCTION_IN_PROGRESS: ["ASSET"],
  SOFTWARE_INTANGIBLE: ["ASSET"],
  PREPAID_EXPENSE: ["ASSET"],
  INVENTORY_ACQUISITION: ["ASSET"],
  FINANCED_EQUIPMENT_ACQUISITION: ["ASSET"],
  OTHER: ["EXPENSE", "ASSET", "COST_OF_SALES", "COGS"],
};

const PURPOSE_CATEGORY_HINTS: Record<string, ReadonlyArray<string>> = {
  FUEL: ["REPAIRS_MAINTENANCE", "COST_OF_SALES"],
  LUBRICANTS: ["REPAIRS_MAINTENANCE"],
  EQUIPMENT_PARTS: ["REPAIRS_MAINTENANCE", "OTHER_EXPENSES"],
  REPAIR_MAINTENANCE: ["REPAIRS_MAINTENANCE"],
  CAPITAL_EQUIPMENT: ["CAPITAL_ASSETS"],
  TELECOMMUNICATIONS: ["ADMIN_EXPENSES", "UTILITIES"],
  INTERNET_CONNECTIVITY: ["ADMIN_EXPENSES", "UTILITIES"],
  SOFTWARE_SUBSCRIPTION: ["ADMIN_EXPENSES"],
  PROFESSIONAL_MEMBERSHIP: ["ADMIN_EXPENSES"],
  PROFESSIONAL_SERVICES: ["PROFESSIONAL_SERVICES", "ADMIN_EXPENSES"],
  BUILDING_MAINTENANCE: ["REPAIRS_MAINTENANCE", "UTILITIES"],
  COURSE_MAINTENANCE: ["OTHER_EXPENSES"],
  OFFICE_SUPPLIES: ["ADMIN_EXPENSES"],
  INTEREST: ["OTHER_EXPENSES"],
  PENALTY: ["OTHER_EXPENSES"],
  // Phase 4R · Phase 7.2F (2026-08-13) — new accounting-nature purposes.
  CAPITAL_IMPROVEMENT: ["CAPITAL_ASSETS", "FIXED_ASSETS"],
  LAND_ACQUISITION: ["CAPITAL_ASSETS", "FIXED_ASSETS"],
  BUILDING_ACQUISITION: ["CAPITAL_ASSETS", "FIXED_ASSETS"],
  CONSTRUCTION_IN_PROGRESS: ["CAPITAL_ASSETS", "FIXED_ASSETS"],
  SOFTWARE_INTANGIBLE: ["CAPITAL_ASSETS", "INTANGIBLE_ASSETS"],
  PREPAID_EXPENSE: ["CURRENT_ASSETS"],
  INVENTORY_ACQUISITION: ["INVENTORY", "CURRENT_ASSETS"],
  FINANCED_EQUIPMENT_ACQUISITION: ["CAPITAL_ASSETS", "FIXED_ASSETS"],
};

/** Nature → acceptable account types.
 *
 *  Accepts both the canonical-ranker-native literals and the wider
 *  vocabulary that `classifyAccountingNature` in accounting-nature.ts
 *  emits (Phase 4R · Phase 3.3, 2026-08-11). The two vocabularies
 *  differ in three names (REPAIR_MAINTENANCE vs REPAIR_AND_MAINTENANCE,
 *  plus TAX_OR_REGULATORY / INTEREST_OR_PENALTY / PREPAID_EXPENSE
 *  from the classifier). Duplicating the entries here keeps the
 *  facade a pure projection — no vocabulary translation required.
 */
const ACCEPTABLE_TYPES_BY_NATURE: Record<string, ReadonlySet<string>> = {
  CAPITAL_ASSET: new Set(["ASSET"]),
  OPERATING_EXPENSE: new Set(["EXPENSE"]),
  REPAIR_MAINTENANCE: new Set(["EXPENSE"]),
  REPAIR_AND_MAINTENANCE: new Set(["EXPENSE"]),
  COST_OF_SALES: new Set(["EXPENSE", "COST_OF_SALES", "COGS"]),
  INVENTORY: new Set(["ASSET"]),
  PREPAID_EXPENSE: new Set(["ASSET"]),
  UTILITY_OR_RECURRING_SERVICE: new Set(["EXPENSE"]),
  PROFESSIONAL_SERVICE: new Set(["EXPENSE"]),
  TAX_OR_REGULATORY: new Set(["EXPENSE"]),
  INTEREST_OR_PENALTY: new Set(["EXPENSE"]),
  UNKNOWN: new Set(["EXPENSE", "ASSET"]),
};

const NAME_TOKEN_RE = /[A-Za-z][A-Za-z0-9]{2,}/g;

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(NAME_TOKEN_RE)) out.add(m[0]);
  return out;
}

function scoreCandidateAgainstTransaction(
  account: AccountView,
  accountType: string,
  transaction: NormalisedTransactionInterpretation,
  vendorDefaultAccountId: string | null,
  itemTokens: Set<string>,
): { observations: RawObservation[]; contradictions: CanonicalContradiction[] } {
  const observations: RawObservation[] = [];
  const contradictions: CanonicalContradiction[] = [];
  const accountConcepts = extractConceptsForAccount(account);

  // ---------- TRANSACTION_TEXT family --------------------------------
  // Per query concept, compute best-matching account concept and emit
  // an observation labelled by the concept's SOURCE.
  const seenSourceKinds = new Set<string>();
  for (const qc of transaction.queryConcepts) {
    let bestRel = 0;
    let bestAccountConceptName: string | null = null;
    for (const ac of accountConcepts) {
      const rel = conceptRelatedness(qc.conceptId, ac.conceptId);
      if (rel === 0) continue;
      const contribution = (qc.weight * ac.totalMatchStrength * rel) / (100 * 33);
      if (contribution > bestRel) {
        bestRel = contribution;
        bestAccountConceptName = ac.concept.canonicalName;
      }
    }
    if (bestRel > 0 && bestAccountConceptName) {
      const kind =
        qc.source === "line_item_description" ? "LINE_ITEM_MATCH" :
        qc.source === "economic_purpose" ? "ECONOMIC_PURPOSE" :
        qc.source === "document_phrase" ? "DOCUMENT_PHRASE" :
        qc.source === "vendor_history" ? "PRIOR_CODING" :
        qc.source === "supplier_identity" ? "SUPPLIER_CONTEXT" :
        "NAME_KEYWORD";
      const family: CanonicalEvidenceFamily =
        kind === "PRIOR_CODING" ? "VENDOR_HISTORY" :
        kind === "SUPPLIER_CONTEXT" ? "VENDOR_HISTORY" :
        "TRANSACTION_TEXT";
      // Cap the contribution at the family's per-kind weight.
      const cap =
        kind === "LINE_ITEM_MATCH" ? WEIGHTS.LINE_ITEM_MATCH :
        kind === "ECONOMIC_PURPOSE" ? WEIGHTS.ECONOMIC_PURPOSE :
        kind === "DOCUMENT_PHRASE" ? WEIGHTS.DOCUMENT_PHRASE :
        kind === "PRIOR_CODING" ? WEIGHTS.PRIOR_CODING_MATCH :
        kind === "SUPPLIER_CONTEXT" ? WEIGHTS.SUPPLIER_CONTEXT_MATCH :
        8; // NAME_KEYWORD conservative cap
      observations.push({
        family,
        kind,
        contribution: Math.min(cap, Math.round(bestRel)),
        description: `${qc.evidenceSnippet.slice(0, 60)} → ${bestAccountConceptName}`,
      });
      seenSourceKinds.add(kind);
    }
  }

  // Purpose type compatibility (TRANSACTION_TEXT family — encodes
  // "does account TYPE match what this purpose can post to?").
  if (transaction.purposeConcept) {
    const acceptable = new Set(PURPOSE_ACCOUNT_TYPE[transaction.purposeConcept] ?? PURPOSE_ACCOUNT_TYPE.OTHER);
    if (acceptable.has(accountType.toUpperCase())) {
      observations.push({
        family: "TRANSACTION_TEXT",
        kind: "PURPOSE_TYPE_COMPAT",
        contribution: WEIGHTS.PURPOSE_TYPE_COMPAT,
        description: `purpose ${transaction.purposeConcept} compatible with account type ${accountType}`,
      });
    } else {
      observations.push({
        family: "TRANSACTION_TEXT",
        kind: "PURPOSE_TYPE_MISMATCH",
        contribution: WEIGHTS.PURPOSE_TYPE_MISMATCH,
        description: `purpose ${transaction.purposeConcept} not compatible with account type ${accountType}`,
      });
    }
    const catHints = new Set(PURPOSE_CATEGORY_HINTS[transaction.purposeConcept] ?? []);
    if (account.categoryKey && catHints.has(account.categoryKey)) {
      observations.push({
        family: "TRANSACTION_TEXT",
        kind: "PURPOSE_CATEGORY_HINT",
        contribution: WEIGHTS.PURPOSE_CATEGORY_HINT,
        description: `purpose ${transaction.purposeConcept} category-hint matches account category ${account.categoryKey}`,
      });
    }
    // Ontology name-substring boost.
    const ontology = evaluatePurposeAccountAffinity(transaction.purposeConcept as any, account.name);
    if (ontology) {
      observations.push({
        family: "TRANSACTION_TEXT",
        kind: "ONTOLOGY_NAME_MATCH",
        contribution: WEIGHTS.ONTOLOGY_NAME_MATCH,
        description: `purpose ${transaction.purposeConcept} ontology matches account name "${account.name}"`,
      });
    }
  }

  // Line-item Jaccard vs account name (TRANSACTION_TEXT).
  if (itemTokens.size > 0) {
    const nameTokens = tokenize(account.name);
    if (nameTokens.size > 0) {
      let hits = 0;
      for (const t of nameTokens) if (itemTokens.has(t)) hits++;
      const jaccard = hits / Math.max(nameTokens.size, itemTokens.size);
      if (jaccard > 0) {
        observations.push({
          family: "TRANSACTION_TEXT",
          kind: "LINE_ITEM_JACCARD",
          contribution: Math.round(jaccard * WEIGHTS.LINE_ITEM_JACCARD_MAX),
          description: `line-item tokens overlap account name (jaccard=${jaccard.toFixed(2)})`,
        });
      }
    }
  }

  // ---------- TAXONOMY_ALIGNMENT family ------------------------------
  // Compute account-side taxonomy strength against the DOMINANT query
  // concept (highest weight). Uses the same account-concept extractor
  // as Pipeline A.
  const dominant = transaction.queryConcepts.length > 0
    ? [...transaction.queryConcepts].reduce((max, qc) => qc.weight > max.weight ? qc : max)
    : null;
  if (dominant) {
    let bestName = 0, bestFsGroup = 0, bestCategory = 0, bestDepth = 0;
    for (const ac of accountConcepts) {
      const rel = conceptRelatedness(dominant.conceptId, ac.conceptId);
      if (rel === 0) continue;
      const nameContrib = (ac.nameMatchStrength * rel) / 100;
      const fsContrib = (ac.fsGroupMatchStrength * rel) / 100;
      const catContrib = (ac.categoryMatchStrength * rel) / 100;
      if (nameContrib > bestName) bestName = nameContrib;
      if (fsContrib > bestFsGroup) bestFsGroup = fsContrib;
      if (catContrib > bestCategory) bestCategory = catContrib;
      if (rel === 100 && ac.concept.depth >= 2 && ac.concept.depth > bestDepth) {
        bestDepth = ac.concept.depth;
      }
    }
    if (bestName > 0) {
      observations.push({
        family: "TAXONOMY_ALIGNMENT",
        kind: "ACCOUNT_NAME_SIMILARITY",
        contribution: Math.min(WEIGHTS.ACCOUNT_NAME_SIMILARITY_MAX, Math.round((bestName / 100) * WEIGHTS.ACCOUNT_NAME_SIMILARITY_MAX)),
        description: `account name similarity to dominant concept "${dominant.conceptId}"`,
      });
    }
    if (bestFsGroup > 0) {
      observations.push({
        family: "TAXONOMY_ALIGNMENT",
        kind: "FS_GROUP_TAXONOMY",
        contribution: Math.min(WEIGHTS.FS_GROUP_TAXONOMY_MAX, Math.round((bestFsGroup / 100) * WEIGHTS.FS_GROUP_TAXONOMY_MAX)),
        description: `account fsGroup matches dominant concept "${dominant.conceptId}"`,
      });
    }
    if (bestCategory > 0) {
      observations.push({
        family: "TAXONOMY_ALIGNMENT",
        kind: "CATEGORY_TAXONOMY",
        contribution: Math.min(WEIGHTS.CATEGORY_TAXONOMY_MAX, Math.round((bestCategory / 100) * WEIGHTS.CATEGORY_TAXONOMY_MAX)),
        description: `account category matches dominant concept "${dominant.conceptId}"`,
      });
    }
    if (bestDepth >= 2) {
      observations.push({
        family: "TAXONOMY_ALIGNMENT",
        kind: "SPECIFICITY_BONUS",
        contribution: WEIGHTS.SPECIFICITY_BONUS_PER_DEPTH * (bestDepth - 1),
        description: `deep concept match (depth ${bestDepth}) — specificity bonus`,
      });
    }
  }

  // ---------- CAPITAL_NATURE family ----------------------------------
  const acceptableTypesForNature = ACCEPTABLE_TYPES_BY_NATURE[transaction.natureLeader];
  if (acceptableTypesForNature && acceptableTypesForNature.has(accountType.toUpperCase())) {
    observations.push({
      family: "CAPITAL_NATURE",
      kind: "NATURE_COMPAT",
      contribution: WEIGHTS.NATURE_COMPAT_MATCH,
      description: `nature ${transaction.natureLeader} accepts account type ${accountType}`,
    });
  } else if (transaction.natureIsDefensible && acceptableTypesForNature) {
    observations.push({
      family: "CAPITAL_NATURE",
      kind: "NATURE_INCOMPATIBLE",
      contribution: WEIGHTS.NATURE_INCOMPATIBLE_PENALTY,
      description: `nature ${transaction.natureLeader} rejects account type ${accountType}`,
    });
    contradictions.push({
      code: `nature_${transaction.natureLeader}_rejects_type_${accountType}`,
      penalty: -WEIGHTS.NATURE_INCOMPATIBLE_PENALTY,
      description: `nature ${transaction.natureLeader} does not accept account type ${accountType}`,
    });
  }
  // Account role compat.
  if (transaction.purposeConcept) {
    const accountRoleField = (account as unknown as { accountRole?: string }).accountRole;
    const expectedRoles = expectedAccountRoles(transaction.purposeConcept);
    if (accountRoleField && expectedRoles.some((r) => String(r) === accountRoleField)) {
      observations.push({
        family: "CAPITAL_NATURE",
        kind: "ACCOUNT_ROLE_MATCH",
        contribution: WEIGHTS.ACCOUNT_ROLE_MATCH,
        description: `account role ${accountRoleField} expected for purpose ${transaction.purposeConcept}`,
      });
    }
  }
  // Capital-decision boosts + contradictions.
  if (transaction.capitalDecision && transaction.capitalConfidence >= 40) {
    const typeUpper = accountType.toUpperCase();
    const nameLower = account.name.toLowerCase();
    const rmNameHit = /\b(?:repair|maintenance|r&m|r\/m)\b/.test(nameLower);
    const catUpper = (account.categoryKey ?? "").toUpperCase();
    if (transaction.capitalDecision === "CAPITAL_CANDIDATE") {
      if (typeUpper === "ASSET") {
        observations.push({
          family: "CAPITAL_NATURE",
          kind: "CAPITAL_ASSET_MATCH",
          contribution: WEIGHTS.CAPITAL_ASSET_MATCH,
          description: `capital candidate + account type ASSET`,
        });
        if (catUpper.includes("CAPITAL") || catUpper.includes("FIXED")) {
          observations.push({
            family: "CAPITAL_NATURE",
            kind: "CAPITAL_ASSET_CATEGORY_BONUS",
            contribution: WEIGHTS.CAPITAL_ASSET_CATEGORY_BONUS,
            description: `capital candidate + account category ${catUpper}`,
          });
        }
      } else if (rmNameHit) {
        observations.push({
          family: "CAPITAL_NATURE",
          kind: "RM_EXPENSE_CONTRADICTION",
          contribution: WEIGHTS.RM_EXPENSE_CONTRADICTION,
          description: `capital candidate but account is R&M expense — contradicts`,
        });
        contradictions.push({
          code: "capital_candidate_but_account_is_rm_expense",
          penalty: -WEIGHTS.RM_EXPENSE_CONTRADICTION,
          description: `Capital candidate but "${account.name}" is an R&M expense account`,
        });
      }
    } else if (transaction.capitalDecision === "REPAIR_MAINTENANCE") {
      if (typeUpper === "EXPENSE" && rmNameHit) {
        observations.push({
          family: "CAPITAL_NATURE",
          kind: "RM_EXPENSE_MATCH",
          contribution: WEIGHTS.RM_EXPENSE_MATCH,
          description: `repair-maintenance + R&M expense account`,
        });
      } else if (typeUpper === "ASSET") {
        observations.push({
          family: "CAPITAL_NATURE",
          kind: "CAPITAL_ACCOUNT_CONTRADICTION",
          contribution: WEIGHTS.CAPITAL_ACCOUNT_CONTRADICTION,
          description: `repair-maintenance but account is ASSET — contradicts`,
        });
        contradictions.push({
          code: "rm_but_account_is_capital_asset",
          penalty: -WEIGHTS.CAPITAL_ACCOUNT_CONTRADICTION,
          description: `Repair-maintenance decision but "${account.name}" is a capital asset account`,
        });
      }
    }
  }

  // Phase 4R · Phase 3.4 (Group C) — compatibility-gate verdicts
  // computed by the facade upstream. Emitted as CAPITAL_NATURE-family
  // observations so MAX-within-family collapses correlated signals
  // (NATURE_COMPAT / CAPITAL_ASSET_MATCH already fire from the leader-
  // driven path). NOT a second competition — pre-scored per-account
  // features that reach the ranker as evidence.
  if (transaction.preferredAccountNumbers && transaction.preferredAccountNumbers.includes(account.accountNumber)) {
    observations.push({
      family: "CAPITAL_NATURE",
      kind: "NATURE_GATE_PREFERRED",
      contribution: WEIGHTS.NATURE_GATE_PREFERRED,
      description: `compatibility gate: PREFERRED for this transaction`,
    });
  }
  if (transaction.contradictedAccountNumbers && transaction.contradictedAccountNumbers.includes(account.accountNumber)) {
    observations.push({
      family: "CAPITAL_NATURE",
      kind: "NATURE_GATE_CONTRADICTED",
      contribution: WEIGHTS.NATURE_GATE_CONTRADICTED,
      description: `compatibility gate: contradicted (nature/functional/department mismatch or missing CIP/financing evidence)`,
    });
    contradictions.push({
      code: "nature_gate_contradicted",
      penalty: -WEIGHTS.NATURE_GATE_CONTRADICTED,
      description: `compatibility gate rejected account "${account.name}"`,
    });
  }

  // Phase 4R · Phase 3.5 (Group D) — taxonomy-based durable-asset vs
  // fee-family contradiction. Replaces the post-canonical
  // object-authority guard that used to clear gl.accountNumber via
  // regex on account NAME. Now uses fsGroupKey taxonomy (§3 founder
  // constraint: contradiction derives from transaction interpretation
  // AND account taxonomy/role, not from account-name regex or
  // account-number literals). Defeasible via hasFinancingEvidence so
  // genuine interest/financing invoices are not suppressed.
  const FEE_FAMILY_FS_GROUPS = new Set([
    "IS_INTEREST_EXPENSE",
    "IS_BANK_CHARGES",
    "IS_MERCHANT_FEES",
  ]);
  if (
    transaction.hasHighQualityDurableAssetContext
    && !transaction.hasFinancingEvidence
    && account.fsGroupKey
    && FEE_FAMILY_FS_GROUPS.has(account.fsGroupKey)
  ) {
    observations.push({
      family: "CAPITAL_NATURE",
      kind: "OBJECT_ROLE_CONTRADICTION",
      contribution: WEIGHTS.OBJECT_ROLE_CONTRADICTION,
      description: `durable-asset object context is incompatible with fee-family account (fsGroup=${account.fsGroupKey})`,
    });
    contradictions.push({
      code: "durable_asset_object_vs_fee_family_account",
      penalty: -WEIGHTS.OBJECT_ROLE_CONTRADICTION,
      description: `Transaction has HIGH-quality durable-asset purchased-object evidence and no financing evidence; account "${account.name}" (fsGroup=${account.fsGroupKey}) is a fee-family account and cannot post this transaction.`,
    });
  }

  // ---------- VENDOR_HISTORY family ----------------------------------
  if (vendorDefaultAccountId && account.id === vendorDefaultAccountId) {
    observations.push({
      family: "VENDOR_HISTORY",
      kind: "VENDOR_DEFAULT",
      contribution: WEIGHTS.VENDOR_DEFAULT_MATCH,
      description: `account is vendor's default expense account`,
    });
  }
  if (transaction.vendor.priorCodingAccountNumbers.includes(account.accountNumber)) {
    observations.push({
      family: "VENDOR_HISTORY",
      kind: "PRIOR_CODING",
      contribution: WEIGHTS.PRIOR_CODING_MATCH,
      description: `vendor has historically coded to this account`,
    });
  }

  // ---------- DEPARTMENT_CONTEXT family ------------------------------
  if (transaction.departmentAccountNamePatterns.length > 0) {
    if (transaction.departmentAccountNamePatterns.some((p) => p.test(account.name))) {
      observations.push({
        family: "DEPARTMENT_CONTEXT",
        kind: "DEPARTMENT_AFFINITY",
        contribution: WEIGHTS.DEPARTMENT_AFFINITY,
        description: `account name matches department (${transaction.departmentKey ?? "?"}) pattern`,
      });
    }
  }

  // ---------- Standalone contradictions (concept-level) ---------------
  for (const ac of accountConcepts) {
    for (const qc of transaction.queryConcepts) {
      if (qc.weight < 6) continue;
      if (isContradiction(qc.conceptId, ac.conceptId)) {
        contradictions.push({
          code: `concept_${qc.conceptId}_contradicts_${ac.conceptId}`,
          penalty: WEIGHTS.CONTRADICTION_PENALTY,
          description: `Account concept "${ac.concept.canonicalName}" contradicts invoice concept "${qc.conceptId}"`,
        });
        break;
      }
    }
  }

  return { observations, contradictions };
}

/** rankCanonical — the canonical single GL-recommendation authority.
 *
 *  §1 architectural law: winner is candidates[0] by type construction.
 *  §3 family model: MAX within family, SUM across families,
 *    contradictions penalise separately.
 *  §4 diagnostics preserved: suppressed correlated evidence retained
 *    with countedTowardScore=false.
 *  §7 discriminated result: distinct RECOMMEND / ABSTAIN /
 *    NO_ELIGIBLE_CANDIDATES / ANALYSIS_FAILURE outcomes.
 */
export function rankCanonical(input: CanonicalRankerInput): CanonicalRankerResult {
  const eligible = input.eligibleAccounts;
  if (eligible.length === 0) {
    return {
      status: "NO_ELIGIBLE_CANDIDATES",
      candidates: [],
      abstentionReason: "Phase-2 eligibility produced zero accounts for this transaction.",
      provenance: {
        rulesFired: [],
        totalCandidatesConsidered: 0,
        eligibilityRejectedCount: 0,
        rankerVersion: RANKER_VERSION,
      },
    };
  }
  const vendorDefaultAccountId = input.transaction.vendor.defaultAccountId;
  // Precompute item-token set once.
  const itemDescriptions = input.transaction.canonicalLineItems
    .filter((l) => l.role === "PRIMARY_PURCHASE" || l.role === "SURCHARGE" || l.role === "FREIGHT")
    .map((l) => l.description)
    .join(" ");
  const itemTokens = tokenize(itemDescriptions);

  // Phase 4R · Phase 7.2L (2026-08-13) — competition mode derived
  // from composed treatment defensibility. Governs whether tier
  // priority participates in cross-tier ordering (Founder §3).
  const treatment = input.transaction.canonicalAccountingTreatment;
  const competitionMode: CompetitionMode = treatment?.defensibility === "STRONG"
    ? "ASSERTED_TREATMENT"
    : "OPEN_TREATMENT";

  // Score each candidate + derive tier metadata (§Founder 5 — tier
  // consumes typed CanonicalAccountSemantics + CanonicalAccountingTreatment,
  // NOT raw account.type / fsGroupKey / natureLeader / capital-state
  // strings).
  const scored: CanonicalCandidate[] = [];
  const rulesFiredSet = new Set<string>();
  for (const account of eligible) {
    // Phase 4R · Phase 7.2L — account.type resolution. `AccountView.type`
    // is the intentional typed canonical input; when the caller has not
    // populated it (legacy fixtures), default to "EXPENSE" so scoring
    // observations that need account type remain conservative. Previously
    // this used an `as unknown as { type?: string }` cast — the Phase
    // 7.2K checkpoint audit flagged it as a semantic backdoor. Phase
    // 7.2L consumes AccountView.type explicitly via the interface's
    // optional field (already declared in gl-account-concepts.ts).
    const accountType = account.type ?? "EXPENSE";
    const { observations, contradictions } = scoreCandidateAgainstTransaction(
      account,
      accountType,
      input.transaction,
      vendorDefaultAccountId,
      itemTokens,
    );
    const { familyContributions, evidence } = collapseByFamily(observations);
    for (const e of evidence) if (e.countedTowardScore) rulesFiredSet.add(e.kind);
    const familySum =
      familyContributions.TRANSACTION_TEXT
      + familyContributions.TAXONOMY_ALIGNMENT
      + familyContributions.CAPITAL_NATURE
      + familyContributions.VENDOR_HISTORY
      + familyContributions.DEPARTMENT_CONTEXT;
    const contradictionPenalty = contradictions.reduce((s, c) => s + Math.max(0, c.penalty), 0);
    const rawScore = Math.max(0, familySum - contradictionPenalty);
    const normalisedScore = Math.min(100, Math.round((rawScore / RAW_SCORE_CAP) * 100));
    const postingBlockers = input.postingBlockersByAccount.get(account.id) ?? [];
    const postable = postingBlockers.length === 0;

    // Phase 4R · Phase 7.2L — tier assignment. Prefer pre-resolved
    // semantics from the input map; fall back to internal resolver
    // (uses `accountType` defaulted to "EXPENSE" — the exact
    // scoring-behavior-preserving default).
    const preResolved = input.accountSemanticsByAccountId?.get(account.id);
    const { tier, tierReason } = assignCandidateTier({
      account,
      accountType,
      postable,
      treatment,
      preResolvedSemantics: preResolved,
    });

    scored.push({
      accountId: account.id,
      accountNumber: account.accountNumber,
      accountName: account.name,
      accountType,
      categoryKey: account.categoryKey,
      fsGroupKey: account.fsGroupKey,
      score: normalisedScore,
      familyContributions,
      contradictionPenalty,
      evidence,
      contradictions,
      postable,
      postingBlockers,
      tier,
      tierReason,
    });
  }

  // Phase 4R · Phase 7.2L — hierarchical comparator (Founder §9).
  // Deterministic. Reads competition mode (already derived above).
  //
  //   INELIGIBLE candidates are ALWAYS last regardless of mode
  //     (structural, not treatment-inferred).
  //   Under ASSERTED_TREATMENT: PRIMARY > PLAUSIBLE > CONTRADICTED,
  //     then existing score desc, then accountNumber (tie-break).
  //   Under OPEN_TREATMENT: existing score desc governs (INELIGIBLE
  //     still last), then accountNumber (tie-break). Tier does NOT
  //     influence cross-tier ordering because treatment defensibility
  //     is too weak to structurally suppress a legitimate cross-family
  //     candidate (Founder §3).
  //
  // Winner is candidates[0] by construction — single-authority
  // invariant preserved. Tier is metadata inside candidates, NOT a
  // second selector.
  scored.sort((a, b) => canonicalCompare(a, b, competitionMode));

  const provenance: CanonicalRankerProvenance = {
    rulesFired: [...rulesFiredSet],
    totalCandidatesConsidered: scored.length,
    eligibilityRejectedCount: 0,
    rankerVersion: RANKER_VERSION,
  };

  // Every candidate scored 0 — treat as NO_ELIGIBLE (structurally
  // distinct from ABSTAIN, per §7). This happens when no query
  // concept matches any account and no nature/capital signals fired.
  if (scored[0].score === 0) {
    return {
      status: "NO_ELIGIBLE_CANDIDATES",
      candidates: [],
      abstentionReason: "No account scored above zero on the transaction — no candidate has any material accounting evidence.",
      provenance,
    };
  }

  // Enforce non-empty tuple type.
  const [winner, ...rest] = scored;
  const candidates: RankedCandidatesNonEmpty = [winner, ...rest];

  // §3 winner separation — expose margin + tie state so downstream
  // (Phase 4 confidence) can distinguish "won by material evidence"
  // from "won by deterministic accountNumber tie-break".
  const runnerUp = rest.length > 0 ? rest[0] : null;
  const marginToRunnerUp = runnerUp ? winner.score - runnerUp.score : winner.score;
  const tiedRunnerUpCount = rest.filter((c) => c.score === winner.score).length;
  const separation: CanonicalWinnerSeparation = {
    marginToRunnerUp,
    isDeterministicTieBreak: tiedRunnerUpCount > 0,
    tiedRunnerUpCount,
  };

  if (winner.score < COMMIT_MIN_SCORE) {
    return {
      status: "ABSTAIN",
      candidates,
      separation,
      abstentionReason: `Top candidate ${winner.accountNumber} ${winner.accountName} scored ${winner.score}, below the commit floor ${COMMIT_MIN_SCORE}. Human review required.`,
      provenance,
    };
  }
  return {
    status: "RECOMMEND",
    candidates,
    separation,
    abstentionReason: null,
    provenance,
  };
}

// ---------------------------------------------------------------------------
// Phase 4R · Phase 7.2L — Tier assignment + hierarchical comparator.
//
// PURE functions. No side effects. Deterministic. Testable in isolation.
// ---------------------------------------------------------------------------

/** Numeric tier priority for deterministic ordering. Lower number =
 *  higher priority. Used ONLY by the comparator under ASSERTED_TREATMENT
 *  mode. Under OPEN_TREATMENT mode, only INELIGIBLE priority matters
 *  (INELIGIBLE always last). */
function tierPriority(tier: CandidateTier): number {
  switch (tier) {
    case "PRIMARY": return 0;
    case "PLAUSIBLE": return 1;
    case "CONTRADICTED": return 2;
    case "INELIGIBLE": return 3;
  }
}

/** Assign a candidate tier from AccountSemantics + composed treatment.
 *  Founder §5: uses typed semantic contracts, not raw fields. Founder
 *  §2: INELIGIBLE reserved for structural posting restrictions only —
 *  never for inferred treatment mismatch. */
function assignCandidateTier(input: {
  account: AccountView;
  accountType: string;
  postable: boolean;
  treatment: import("./treatment-composition").CanonicalAccountingTreatment | undefined;
  /** Pre-resolved AccountSemantics keyed on the caller side (analyse.ts).
   *  When provided, tier assignment reads statementRole/accountingClass
   *  from here instead of re-deriving via `account.type ?? "EXPENSE"`. */
  preResolvedSemantics?: { statementRole: string; accountingClass: string };
}): { tier: CandidateTier; tierReason: string } {
  const { account, postable, treatment, preResolvedSemantics } = input;

  // Structural INELIGIBLE — Founder §2 & §4. Only true posting
  // restrictions land here. Consumes the semantic contract's
  // structuralPostingRestrictions via `postable` (already derived
  // from postingBlockersByAccount) + a defensive check on
  // AccountView's structural flags.
  if (!postable) {
    return { tier: "INELIGIBLE", tierReason: "postable=false (structural posting restriction)" };
  }
  if ((account as unknown as { isBankAccount?: boolean }).isBankAccount === true
    || (account as unknown as { isCashAccount?: boolean }).isCashAccount === true
    || (account as unknown as { isControlAccount?: boolean }).isControlAccount === true) {
    return { tier: "INELIGIBLE", tierReason: "bank/cash/control account (structural)" };
  }

  // No composed treatment → OPEN_TREATMENT semantics — every otherwise
  // postable candidate is PLAUSIBLE. Founder §3: weak treatment
  // evidence must not structurally suppress a candidate.
  if (!treatment) {
    return { tier: "PLAUSIBLE", tierReason: "no composed treatment; open competition" };
  }

  // Resolve AccountSemantics.statementRole and .accountingClass via
  // the SINGLE typed derivation. Founder §5. Prefer pre-resolved map
  // (caller has AccountSemantics already computed from real
  // Account.type / accountRole / flags).
  const semantics = preResolvedSemantics ?? resolveAccountSemanticsForCandidate(account);

  // NON_AP_POSTABLE accountingClass is a structural signal (REVENUE /
  // LIABILITY / EQUITY types). Mark INELIGIBLE per Founder §4.
  if (semantics.statementRole === "REVENUE"
    || semantics.statementRole === "BALANCE_SHEET_EQUITY"
    || semantics.statementRole === "BALANCE_SHEET_LIABILITY") {
    return { tier: "INELIGIBLE", tierReason: `structurally non-AP-postable: ${semantics.statementRole}` };
  }

  // UNRESOLVED treatment → every remaining candidate is PLAUSIBLE
  // (Founder §6 — hierarchy must not manufacture certainty).
  if (treatment.defensibility === "UNRESOLVED") {
    return { tier: "PLAUSIBLE", tierReason: "treatment unresolved; open competition" };
  }

  // Direct statement-role match → PRIMARY.
  if (treatment.statementRole !== "UNKNOWN"
    && semantics.statementRole === treatment.statementRole) {
    return {
      tier: "PRIMARY",
      tierReason: `account.statementRole=${semantics.statementRole} matches treatment.statementRole`,
    };
  }

  // Related-family PLAUSIBLE match — expense family (OPERATING_EXPENSE ↔
  // COST_OF_SALES) or asset family (BALANCE_SHEET_CAPITAL_ASSET ↔
  // BALANCE_SHEET_CURRENT_ASSET). Founder §4: cross-family plausibility.
  if (isRelatedStatementFamilyRanker(semantics.statementRole, treatment.statementRole)) {
    return {
      tier: "PLAUSIBLE",
      tierReason: `account.statementRole=${semantics.statementRole} in related family of treatment.statementRole=${treatment.statementRole}`,
    };
  }

  // Founder §4: CONTRADICTED requires actual accounting contradiction.
  // Under WEAK defensibility (already filtered out above — WEAK is
  // OPEN_TREATMENT mode which uses PLAUSIBLE), we only reach here
  // when defensibility is STRONG. Structural incompatibility on
  // STRONG treatment = CONTRADICTED.
  if (treatment.defensibility === "STRONG") {
    return {
      tier: "CONTRADICTED",
      tierReason: `account.statementRole=${semantics.statementRole} structurally inconsistent with STRONG treatment.statementRole=${treatment.statementRole}`,
    };
  }

  // WEAK defensibility fallback → PLAUSIBLE (never CONTRADICTED on
  // weak evidence — Founder §5).
  return {
    tier: "PLAUSIBLE",
    tierReason: `account.statementRole=${semantics.statementRole} vs treatment.statementRole=${treatment.statementRole} (WEAK defensibility — PLAUSIBLE)`,
  };
}

/** Related-family match for tier assignment. Mirrors the classifier
 *  in treatment-aware.ts to keep both provider + ranker consistent. */
function isRelatedStatementFamilyRanker(
  accountRole: string,
  treatmentRole: import("./treatment-composition").CanonicalAccountingTreatment["statementRole"],
): boolean {
  if (treatmentRole === "UNKNOWN") return true;
  if ((treatmentRole === "OPERATING_EXPENSE" || treatmentRole === "COST_OF_SALES")
    && (accountRole === "OPERATING_EXPENSE" || accountRole === "COST_OF_SALES")) {
    return true;
  }
  if ((treatmentRole === "BALANCE_SHEET_CAPITAL_ASSET"
        || treatmentRole === "BALANCE_SHEET_CURRENT_ASSET")
    && (accountRole === "BALANCE_SHEET_CAPITAL_ASSET"
        || accountRole === "BALANCE_SHEET_CURRENT_ASSET")) {
    return true;
  }
  return false;
}

/** Resolver — consumes the SINGLE typed derivation of
 *  CanonicalAccountSemantics from account-semantics/index.ts. Called
 *  once per candidate per rank call; volume is bounded (dozens of
 *  accounts). No cyclic dependency (account-semantics does not import
 *  canonical-ranker). */
function resolveAccountSemanticsForCandidate(account: AccountView):
  { statementRole: string; accountingClass: string } {
  return _resolveAccountSemantics({
    accountNumber: account.accountNumber,
    name: account.name,
    type: account.type ?? "EXPENSE",
    normalBalance: "DEBIT",
    isActive: true,
    isHeader: false,
    allowManualPosting: account.allowManualPosting ?? true,
    isControlAccount: account.isControlAccount ?? false,
    isBankAccount: account.isBankAccount ?? false,
    isCashAccount: account.isCashAccount ?? false,
    categoryKey: account.categoryKey ?? null,
    fsGroupKey: account.fsGroupKey ?? null,
    accountRole: account.accountRole ?? null,
  });
}

/** Phase 4R · Phase 7.2L hierarchical comparator. Deterministic.
 *  Winner === candidates[0] by construction — this comparator alone
 *  produces the final ordering. NO second selector runs after this.
 *  (Structural test in tests/phase4r-phase72l-hierarchy-invariants.test.ts
 *  asserts this.) */
function canonicalCompare(
  a: CanonicalCandidate,
  b: CanonicalCandidate,
  mode: CompetitionMode,
): number {
  // INELIGIBLE is ALWAYS last regardless of mode. Structural.
  const aPri = tierPriority(a.tier);
  const bPri = tierPriority(b.tier);
  const aInel = a.tier === "INELIGIBLE" ? 1 : 0;
  const bInel = b.tier === "INELIGIBLE" ? 1 : 0;
  if (aInel !== bInel) return aInel - bInel;

  // Under ASSERTED_TREATMENT, tier priority governs cross-tier order
  // (PRIMARY before PLAUSIBLE before CONTRADICTED). Founder §3.
  if (mode === "ASSERTED_TREATMENT" && a.tier !== b.tier) {
    return aPri - bPri;
  }

  // Under OPEN_TREATMENT (or within a tier under either mode):
  // existing numeric score decides. Founder §9.
  if (b.score !== a.score) return b.score - a.score;

  // Deterministic tie-break on accountNumber. Unchanged from pre-L.
  return a.accountNumber.localeCompare(b.accountNumber);
}

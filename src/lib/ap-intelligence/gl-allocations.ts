// Sprint 3 · Checkpoint 15V (2026-07-29) — multi-GL allocation
// engine.
//
// Founder rule 15V §1: preserve the 15U full-tenant deterministic
// ranker. Every allocation runs the same ranking pipeline over the
// same eligible tenant COA. This module CLUSTERS invoice lines into
// economic-purpose groups and asks the 15U ranker for the best
// account per group.
//
// Groups are formed by:
//   1. Extracting the dominant concept per line from the line's own
//      description (matchStrongestPhrase across the whole catalog).
//   2. When a line has NO strong per-line concept, falling back to
//      the DOCUMENT-level dominant concept (invoice header context —
//      e.g. "Member Dues for [Name]" in the CPA doc lifts otherwise
//      opaque lines like "CPA Alberta Fee" into the membership-dues
//      bucket).
//   3. Optionally, when a line has NEITHER a per-line concept nor a
//      document-level fallback, treating it as UNRESOLVED — an
//      allocation that requiresReview.
//
// Two clusters are MERGED after ranking when both select the same
// tenant account — a tenant COA that doesn't split e.g. draft vs
// packaged beer naturally collapses to one allocation without any
// explicit rule.
//
// Materiality (§6): interest, tax, credits, and separately stated
// ancillary charges (delivery / freight / surcharge / penalty)
// retain their own allocation regardless of amount. Other concepts
// use a small de-minimis threshold ($1) to avoid emitting spurious
// allocations from rounding noise.
//
// Amount-weighted evidence (§7): the DOMINANT invoice concept
// (single-concept classification, display summary, card confidence)
// uses amount-weighted evidence. Per-line ALLOCATION decisions are
// grounded in the line's own text — a small side charge retains its
// own allocation even when it's a small fraction of the invoice.

import { type PostingBlocker, type GlRecommendation, type GlCandidate } from "./gl-recommend";
import type { AccountView } from "./gl-account-concepts";
import { isFsGroupFamilyIncompatibleWithCluster } from "./account-semantics/family-incompatibility";
import {
  discoverCandidates,
  unionEligiblePool,
  type CandidateDiscoveryInput,
} from "./candidate-discovery";
import { ALL_DISCOVERY_PROVIDERS } from "./candidate-discovery/providers";
import { extractQueryConcepts, dominantQueryConcept, type QueryConcept } from "./gl-query-concepts";
import { ACCOUNTING_CONCEPTS, CONCEPT_BY_ID } from "./gl-concepts";
import { matchStrongestPhrase } from "./gl-similarity";
import type { LineItem, LineTaxTreatment } from "./line-items-extract";
import type { PurposeCandidate } from "./economic-purpose";
import type { EconomicPurposeDecision } from "./economic-purpose-authority";
import type { EconomicPurposeConcept } from "./economic-purpose-taxonomy";
// Phase 4R · Phase 5 (2026-08-11) — allocations now use the SAME
// canonical ranker + recommendation-policy + confidence-assessment
// pipeline as document-level classification. See rankClusterCanonically()
// below. Legacy rankAccountsPure ranker no longer invoked here.
import {
  rankCanonical,
  type CanonicalCandidate,
  type NormalisedTransactionInterpretation,
} from "./canonical-ranker";
import { evaluateRecommendationPolicy, type RecommendationStatus } from "./recommendation-policy";
import { assessCanonicalConfidence, type CanonicalConfidenceAssessment } from "./canonical-confidence";

export type AllocationTaxTreatment =
  | "TAXABLE"
  | "EXEMPT"
  | "ZERO_RATED"
  | "OUT_OF_SCOPE"
  | "MIXED"
  | "UNKNOWN";

export interface AllocationRecommendedAccount {
  accountId: string;
  accountNumber: string;
  accountName: string;
  confidence: number;                 // 0..100
  requiresReview: boolean;
  postingBlockers: PostingBlocker[];
}

export interface AllocationAlternative {
  accountId: string;
  accountNumber: string;
  accountName: string;
  score: number;
}

export interface ApGlAllocation {
  id: string;                         // deterministic — hash of concept + accountNumber + line ids
  sourceLineItemIds: string[];        // stringified lineNo indices
  descriptions: string[];
  economicPurpose: {
    concept: string;                  // AccountingConcept.id or "unresolved"
    confidence: number;
    supportingEvidence: string[];
  };
  amount: number;                     // sum of positive line amounts in this group
  taxTreatment: AllocationTaxTreatment;
  taxRate: number | null;
  taxAmount: number | null;
  recommendedAccount: AllocationRecommendedAccount | null;   // null when unresolved
  alternatives: AllocationAlternative[];
  // Phase 4R · Phase 5 (2026-08-11) — per-allocation canonical
  // provenance. Each allocation now runs through the SAME canonical
  // ranker + recommendation-policy + confidence-assessment pipeline
  // as document-level classification. Allocation confidence and
  // genuine competitors come from the canonical competition; no
  // parallel allocation ranker exists after Phase 5.
  canonicalWinnerAccountNumber?: string | null;
  recommendationStatus?: import("./recommendation-policy").RecommendationStatus;
  canonicalConfidence?: import("./canonical-confidence").CanonicalConfidenceAssessment;
}

export interface AllocationTotals {
  allocationsSubtotal: number;        // sum of positive allocation amounts
  taxTotal: number;                   // recoverable + non-recoverable tax on taxable allocations
  creditTotal: number;                // sum of |negative line amounts| across the invoice
  grossTotal: number;                 // printed gross payable
  allocationVariance: number;         // gross - (subtotal + tax - credits)
}

export interface AllocationResult {
  allocations: ApGlAllocation[];
  totals: AllocationTotals;
  // Derived Category cell value per §8. "Multiple" when >=2 material
  // GL allocations; single account name when 1; null when nothing
  // was resolvable.
  cardCategory: string | null;
  requiresReview: boolean;
  // Sprint 3 · Post-16H Phase 2.1 (2026-08-06) — allocation
  // eligibility mode.
  //   PER_ALLOCATION    — each allocation was evaluated with its own
  //                       AccountingTransactionContext derived from its
  //                       own line-item / purpose evidence.
  //   DOCUMENT_FALLBACK — one document-level context reused across
  //                       every allocation (current Phase 2 wiring).
  //   NOT_EVALUATED     — eligibility service was not consulted for
  //                       this allocation set (e.g. legacy path).
  // Only PER_ALLOCATION may qualify for AUTO_APPROVAL_ELIGIBLE
  // (Phase 3 §B3). Multi-allocation invoices under DOCUMENT_FALLBACK
  // must remain requiresReview=true — Phase 2.1 §A5.
  allocationEligibilityMode: "PER_ALLOCATION" | "DOCUMENT_FALLBACK" | "NOT_EVALUATED";
}

export interface AllocationInput {
  lineItems: LineItem[];
  accounts: AccountView[];
  postingBlockersByAccount: Map<string, PostingBlocker[]>;
  economicPurposeCandidates: PurposeCandidate[] | null;
  fullDocumentText: string | null;
  supplierName: string | null;
  vendorHistoryConceptIds?: string[];
  printedSubtotal: number | null;
  printedTax: number | null;
  printedTotal: number | null;
  // Phase 4R · Phase 7.1 (2026-08-13) — canonical purpose decision
  // consumed by clustering per founder investigation of 221178.
  // When CANONICAL_COMMITTED, its concept becomes the primary
  // cluster identity (overrides per-line synonym matches except for
  // SPECIAL_HANDLING lines or very-strong-distinct signals).
  purposeDecision?: EconomicPurposeDecision | null;
  // Phase 4R · Phase 7.2B (2026-08-13) — legacy-direct discovery
  // context (rich accounts + already-computed evidence) threaded
  // from analyse.ts to the candidate-discovery layer. Consumed by
  // discover-only providers that call v206 discovery functions
  // directly. Never read by canonical ranking.
  discoveryContext?: import("./candidate-discovery/legacy-bridge").DiscoveryContext;
  // Phase 4R · Phase 5 (2026-08-11) — global signals passed as
  // CLUSTER-shared context. Individual clusters still rank
  // independently from their own line items + concept, but shared
  // signals (department, nature, capital decision, purchased-object
  // durable-asset context, financing evidence, gate-preferred lists,
  // vendor identity/history) are provided as read-only context. §6:
  // these are legitimately global — one cluster's evidence still
  // cannot force another's winner because the per-cluster query
  // concepts remain the primary scoring driver.
  globalSignals?: {
    departmentKey?: string | null;
    departmentAccountNamePatterns?: ReadonlyArray<RegExp>;
    natureLeader?: string;
    natureConfidence?: number;
    natureIsDefensible?: boolean;
    capitalDecision?: "CAPITAL_CANDIDATE" | "OPERATING" | "REPAIR_MAINTENANCE" | "UNRESOLVED" | null;
    capitalConfidence?: number;
    hasHighQualityDurableAssetContext?: boolean;
    hasFinancingEvidence?: boolean;
    preferredAccountNumbers?: ReadonlyArray<string>;
    contradictedAccountNumbers?: ReadonlyArray<string>;
    priorCodingAccountNumbers?: ReadonlyArray<string>;
    matchedVendorId?: string | null;
  };
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Materiality threshold (§6). Amounts below this are still assigned
// to their own allocation IF the concept is in the SPECIAL_HANDLING
// set below (interest, penalty, credit, ancillary charges) —
// otherwise merged into the nearest sibling by concept relatedness.
const DE_MINIMIS_AMOUNT = 1.00;

// Concepts that ALWAYS retain their own allocation regardless of
// amount (§6). The founder's rule: interest, tax, credits, and
// separately stated ancillary charges may require their own
// accounting treatment regardless of materiality.
const SPECIAL_HANDLING_CONCEPTS = new Set<string>([
  "interest_and_penalties",
  "finance_interest_charge",
  "late_payment_penalty",
  "delivery_and_freight",
  "fuel_surcharge",
  "environmental_surcharge",
]);

// Per-line minimum evidence to accept a per-line concept assignment.
// Below this, the line falls back to the document-level dominant
// concept.
const PER_LINE_CONCEPT_MIN_STRENGTH = 55;

// Phase 4R · Phase 6 (2026-08-11) — RECOMMENDATION_MIN_SCORE=40
// removed. It was the pre-Phase-5 legacy `rankAccountsPure` scoring
// threshold used at two sites (toAllocations + mergeSameAccountClusters)
// to decide review-eligibility / merge-eligibility. Both sites now
// consume the canonical recommendation policy (r.canonical.recommendationStatus)
// which the per-cluster canonical ranker already computed via
// evaluateRecommendationPolicy(). No independent numeric threshold
// remains in the allocation projection or merge path.

// -----------------------------------------------------------------------------
// Per-line concept assignment
// -----------------------------------------------------------------------------

interface LineAssignment {
  line: LineItem;
  conceptId: string | null;
  conceptSource: "line_description" | "document_fallback" | "unresolved";
  matchStrength: number;              // 0..100
  matchedPhrase: string;
}

// Phase 4R · Phase 7.1 (2026-08-13) — economic-clustering correction
// per founder investigation of 221178. When a per-line synonym match
// is a SPECIAL_HANDLING concept, or when it is very strong (>= 80)
// AND materially different from the document-canonical concept, the
// per-line concept wins to preserve legitimate tax/materiality
// independence. Otherwise, if the document canonical purpose is
// CANONICAL_COMMITTED, the document-canonical concept is authoritative
// for cluster identity — the classifier's whole-document evidence is
// stronger than any single line's raw synonym match.
const PER_LINE_OVERRIDE_STRENGTH = 80;

function assignConceptToLine(
  line: LineItem,
  docFallbackConceptId: string | null,
  canonicalDocConceptId: string | null,
  canonicalIsCommitted: boolean,
): LineAssignment {
  // Search the whole catalog for the strongest per-line concept match.
  let best: { conceptId: string; strength: number; phrase: string; depth: number } | null = null;
  for (const concept of ACCOUNTING_CONCEPTS) {
    const hit = matchStrongestPhrase(line.description, concept.synonyms, { minStrength: PER_LINE_CONCEPT_MIN_STRENGTH });
    if (!hit) continue;
    // Specificity tie-break — deeper concept wins when strengths are close.
    if (!best
        || hit.strength > best.strength + 3
        || (Math.abs(hit.strength - best.strength) <= 3 && concept.depth > best.depth)) {
      best = { conceptId: concept.id, strength: hit.strength, phrase: hit.matchedPhrase, depth: concept.depth };
    }
  }
  // Phase 7.1: when the document canonical concept is committed, use
  // it as the primary cluster identity UNLESS the per-line match is
  // (a) a SPECIAL_HANDLING concept (interest/penalty/delivery/freight
  // etc. — retain independent allocation per §6) or (b) very strong
  // AND concept-different from the document canonical (legitimate
  // distinct economic component).
  if (canonicalIsCommitted && canonicalDocConceptId) {
    const perLineIsSpecial = best != null && SPECIAL_HANDLING_CONCEPTS.has(best.conceptId);
    const perLineIsStrongDistinct = best != null
      && best.strength >= PER_LINE_OVERRIDE_STRENGTH
      && best.conceptId !== canonicalDocConceptId;
    if (!perLineIsSpecial && !perLineIsStrongDistinct) {
      return {
        line,
        conceptId: canonicalDocConceptId,
        conceptSource: "document_fallback",
        matchStrength: 85,
        matchedPhrase: best?.phrase ?? "",
      };
    }
    // else fall through — per-line wins because it's SPECIAL_HANDLING
    // or a very strong distinct signal.
  }
  if (best) {
    return { line, conceptId: best.conceptId, conceptSource: "line_description", matchStrength: best.strength, matchedPhrase: best.phrase };
  }
  if (docFallbackConceptId) {
    return { line, conceptId: docFallbackConceptId, conceptSource: "document_fallback", matchStrength: 40, matchedPhrase: "" };
  }
  return { line, conceptId: null, conceptSource: "unresolved", matchStrength: 0, matchedPhrase: "" };
}

// -----------------------------------------------------------------------------
// Determine the document-level fallback concept
// -----------------------------------------------------------------------------

function documentFallbackConcept(args: {
  economicPurposeCandidates: PurposeCandidate[] | null;
  fullDocumentText: string | null;
  purposeDecision?: EconomicPurposeDecision | null;
}): { conceptId: string; supportingEvidence: string[] } | null {
  // Phase 4R · Phase 7.1 (2026-08-13) — prefer the CANONICAL purpose
  // decision when the classifier committed. Founder investigation of
  // 221178: the CANONICAL purposeDecision correctly identified
  // SOFTWARE_SUBSCRIPTION at confidence 96 (CANONICAL_COMMITTED) but
  // the legacy economicPurposeCandidates top score was only 33,
  // failing the >= 40 threshold. The document consequently had no
  // fallback concept and the 5 IT-service line items fragmented into
  // multiple clusters. Fix: consume the canonical decision when
  // committed — its whole-document evidence is stronger than the
  // legacy vote.
  if (args.purposeDecision != null
      && args.purposeDecision.concept != null
      && (args.purposeDecision.source === "CANONICAL_COMMITTED"
          || args.purposeDecision.source === "CANONICAL_LEGACY_CONCUR")) {
    const conceptId = CANONICAL_PURPOSE_TO_CONCEPT[args.purposeDecision.concept];
    if (conceptId) {
      return {
        conceptId,
        supportingEvidence: [`Document canonical purpose "${args.purposeDecision.label}" (source=${args.purposeDecision.source}, confidence=${args.purposeDecision.confidence})`],
      };
    }
  }
  const purpose = args.economicPurposeCandidates?.[0];
  if (purpose && purpose.score >= 40) {
    const conceptId = PURPOSE_TO_CONCEPT[purpose.purpose];
    if (conceptId) {
      return {
        conceptId,
        supportingEvidence: [`Document legacy purpose "${purpose.classificationConcept}" (score ${purpose.score})`],
      };
    }
  }
  return null;
}

// Phase 4R · Phase 7.1 (2026-08-13) — canonical purpose → concept
// catalog id. Maps the Slice-5 canonical EconomicPurposeConcept enum
// (economic-purpose-taxonomy.ts) to concept ids in the ACCOUNTING_CONCEPTS
// catalog (gl-concepts.ts). Not exhaustive — covers the common
// canonical concepts. Unmapped canonical concepts fall through to
// the legacy PURPOSE_TO_CONCEPT (or unresolved) path.
const CANONICAL_PURPOSE_TO_CONCEPT: Partial<Record<EconomicPurposeConcept, string>> = {
  SOFTWARE_SUBSCRIPTION: "software_subscription_service",
  CYBERSECURITY_SERVICE: "cybersecurity_service",
  TELECOMMUNICATIONS: "telephony",
  INTERNET_CONNECTIVITY: "connectivity_internet",
  REPAIR_MAINTENANCE: "repairs_and_maintenance",
  BUILDING_MAINTENANCE: "repairs_and_maintenance",
  COURSE_MAINTENANCE: "course_maintenance_supplies",
  PROFESSIONAL_MEMBERSHIP: "professional_membership_dues",
  PROFESSIONAL_SERVICES: "professional_services",
  FOOD: "food_cost_of_sales",
  BEVERAGE: "beverage_cost_of_sales",
  FREIGHT_DELIVERY: "delivery_and_freight",
  OFFICE_SUPPLIES: "office_supplies_general",
  INTEREST: "finance_interest_charge",
  PENALTY: "late_payment_penalty",
  // Concepts NOT mapped (no direct concept-catalog id): FUEL,
  // LUBRICANTS, EQUIPMENT, EQUIPMENT_PARTS, CAPITAL_EQUIPMENT,
  // OTHER, UNKNOWN. These canonical concepts fall through to
  // legacy PURPOSE_TO_CONCEPT or per-line matching; adding
  // catalog entries for them is out of scope for Phase 7.1.
};

// Duplicate of the mapping in gl-query-concepts.ts, kept local so
// this module can be tested in isolation without imports cycles.
const PURPOSE_TO_CONCEPT: Record<string, string> = {
  employee_professional_membership_dues: "professional_membership_dues",
  external_accounting_or_audit_services: "external_accounting_services",
  professional_education_training: "training_and_education",
  licences_and_certifications: "licences_and_permits",
  regulatory_fees: "licences_and_permits",
  penalties_and_late_fees: "late_payment_penalty",
  member_dues_charged_by_club: "professional_membership_dues",
  employee_reimbursement: "professional_services",
  legal_or_consulting_services: "legal_services",
  recurring_communications_or_connectivity_service: "communications",
  recurring_utility_or_facility_service: "utilities",
  generic_supplies_or_services: "office_supplies_general",
};

// -----------------------------------------------------------------------------
// Cluster lines by concept
// -----------------------------------------------------------------------------

interface RawCluster {
  conceptId: string | null;           // null = unresolved cluster
  assignments: LineAssignment[];
  totalAmount: number;
}

function buildClusters(assignments: LineAssignment[]): RawCluster[] {
  const clusters = new Map<string, RawCluster>();
  for (const a of assignments) {
    const key = a.conceptId ?? "__unresolved__";
    let c = clusters.get(key);
    if (!c) {
      c = { conceptId: a.conceptId, assignments: [], totalAmount: 0 };
      clusters.set(key, c);
    }
    c.assignments.push(a);
    c.totalAmount += a.line.amount;   // may be negative for credits
  }
  return [...clusters.values()];
}

// -----------------------------------------------------------------------------
// Rank each cluster against the full tenant COA
// -----------------------------------------------------------------------------

/** Legacy-shaped candidate emitted by rankClusterCanonically so
 *  downstream toAllocations() / mergeSameAccountClusters() code
 *  can continue to consume the pre-Phase-5 shape without change. */
interface AllocationRankedRow {
  accountNumber: string;
  accountName: string;
  semanticScore: number;
  rank: number;
  postingBlockers: PostingBlocker[];
}

interface RankedCluster {
  cluster: RawCluster;
  rankedTop: AllocationRankedRow[];
  /** Phase 4R · Phase 5 (2026-08-11) — canonical outputs for this
   *  cluster. Same shape/semantics as document-level canonical
   *  classification. */
  canonical?: {
    winnerAccountNumber: string | null;
    recommendationStatus: RecommendationStatus;
    confidence: CanonicalConfidenceAssessment;
    /** Full canonical candidates in canonical order (winner = candidates[0]
     *  when RECOMMEND or ABSTAIN). Retained for provenance. */
    candidates: ReadonlyArray<CanonicalCandidate>;
  };
}

/**
 * Phase 4R · Phase 5 · per-cluster canonical ranker.
 *
 * Each allocation cluster runs through the SAME canonical ranker used
 * for document-level classification. Inputs:
 *   - cluster's own line items (never the whole invoice)
 *   - cluster's dominant concept as a synthetic queryConcept
 *     (existing behaviour — allocation retains cluster-scoped evidence
 *     so one cluster's evidence cannot force another's winner, §6)
 *   - global signals passed by the caller (supplier / department /
 *     capital nature) treated as CLUSTER-shared context
 *   - eligible accounts pre-filtered by fsGroupKey hints
 *
 * Emits both:
 *   - the compat rankedTop rows toAllocations already consumes
 *   - the full canonical result + recommendation policy + confidence
 *     assessment attached to the RankedCluster for per-allocation
 *     projection
 */
function rankClusterCanonically(input: {
  cluster: RawCluster;
  eligibleAccounts: AccountView[];
  queryConcepts: QueryConcept[];
  postingBlockersByAccount: Map<string, PostingBlocker[]>;
  globalSignals: {
    departmentKey: string | null;
    departmentAccountNamePatterns: ReadonlyArray<RegExp>;
    natureLeader: string;
    natureConfidence: number;
    natureIsDefensible: boolean;
    capitalDecision: "CAPITAL_CANDIDATE" | "OPERATING" | "REPAIR_MAINTENANCE" | "UNRESOLVED" | null;
    capitalConfidence: number;
    hasHighQualityDurableAssetContext: boolean;
    hasFinancingEvidence: boolean;
    preferredAccountNumbers?: ReadonlyArray<string>;
    contradictedAccountNumbers?: ReadonlyArray<string>;
    priorCodingAccountNumbers: ReadonlyArray<string>;
    matchedVendorId: string | null;
  };
}): RankedCluster {
  const clusterLines = input.cluster.assignments.map((a) => a.line);
  const clusterConceptId = input.cluster.conceptId;
  const transaction: NormalisedTransactionInterpretation = {
    purposeConcept: clusterConceptId ?? null,
    purposeConfidence: clusterConceptId ? 85 : 0,
    purposeQuality: clusterConceptId ? "MEDIUM" : "NONE",
    capitalDecision: input.globalSignals.capitalDecision,
    capitalConfidence: input.globalSignals.capitalConfidence,
    natureLeader: input.globalSignals.natureLeader,
    natureConfidence: input.globalSignals.natureConfidence,
    natureIsDefensible: input.globalSignals.natureIsDefensible,
    preferredAccountNumbers: input.globalSignals.preferredAccountNumbers,
    contradictedAccountNumbers: input.globalSignals.contradictedAccountNumbers,
    hasHighQualityDurableAssetContext: input.globalSignals.hasHighQualityDurableAssetContext,
    hasFinancingEvidence: input.globalSignals.hasFinancingEvidence,
    departmentKey: input.globalSignals.departmentKey,
    departmentAccountNamePatterns: input.globalSignals.departmentAccountNamePatterns,
    canonicalLineItems: clusterLines.map((li) => ({
      description: li.description ?? "",
      role: "PRIMARY_PURCHASE",
      extension: li.amount ?? null,
    })),
    queryConcepts: input.queryConcepts.map((qc) => ({
      conceptId: qc.conceptId,
      weight: qc.weight,
      source: qc.source,
      evidenceSnippet: qc.evidenceSnippet,
    })),
    vendor: {
      matchedVendorId: input.globalSignals.matchedVendorId,
      defaultAccountId: null,
      priorCodingAccountNumbers: input.globalSignals.priorCodingAccountNumbers,
    },
    documentPhraseText: null,
  };
  const result = rankCanonical({
    transaction,
    eligibleAccounts: input.eligibleAccounts,
    postingBlockersByAccount: input.postingBlockersByAccount,
  });
  const canonicalStatus = result.status;
  const winnerAccountNumber = (canonicalStatus === "RECOMMEND" || canonicalStatus === "ABSTAIN")
    ? result.candidates[0]?.accountNumber ?? null
    : null;
  const canonicalAbstentionReason =
    canonicalStatus === "ABSTAIN" || canonicalStatus === "NO_ELIGIBLE_CANDIDATES" || canonicalStatus === "ANALYSIS_FAILURE"
      ? result.abstentionReason
      : null;
  const recommendation = evaluateRecommendationPolicy({
    canonicalStatus,
    canonicalWinnerAccountNumber: winnerAccountNumber,
    canonicalAbstentionReason,
    // Allocations run after document-level extraction; upstream field
    // quality is a document-wide concern, not a per-cluster one. If
    // the document's field quality is bad, gl.recommendationStatus
    // already reflects ABSTAIN_QUALITY and the overall allocation
    // review policy (§10) handles it at the analyse.ts layer.
    fieldQualityEligible: true,
    fieldQualityAbstentionReasons: [],
  });
  const confidence = assessCanonicalConfidence({ canonical: result, recommendation });
  // Project canonical candidates into the compat rankedTop shape.
  const candidates = (canonicalStatus === "RECOMMEND" || canonicalStatus === "ABSTAIN")
    ? result.candidates
    : [];
  const rankedTop: AllocationRankedRow[] = candidates.map((c, i) => ({
    accountNumber: c.accountNumber,
    accountName: c.accountName,
    semanticScore: c.score,
    rank: i + 1,
    postingBlockers: [...c.postingBlockers] as PostingBlocker[],
  }));
  return {
    cluster: input.cluster,
    rankedTop,
    canonical: {
      winnerAccountNumber,
      recommendationStatus: recommendation.status,
      confidence,
      candidates,
    },
  };
}

/** Phase 4R (2026-08-10) — walk the concept-hierarchy upward to
 *  gather effective fsGroupKeyHints. A leaf concept without direct
 *  hints inherits its parent's hints. Depth-1 root concepts have
 *  their own hints. Deduplicated. */
function computeEffectiveClusterHints(concept: { id: string; parent: string | null; fsGroupKeyHints: string[] } | undefined | null): string[] {
  if (!concept) return [];
  const collected: string[] = [];
  let cursor: { id: string; parent: string | null; fsGroupKeyHints: string[] } | undefined = concept;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    for (const h of cursor.fsGroupKeyHints) {
      if (!collected.includes(h)) collected.push(h);
    }
    if (cursor.fsGroupKeyHints.length > 0) break; // stop at first depth with hints
    if (!cursor.parent) break;
    cursor = CONCEPT_BY_ID[cursor.parent];
  }
  return collected;
}

function rankClusters(args: {
  clusters: RawCluster[];
  accounts: AccountView[];
  postingBlockersByAccount: Map<string, PostingBlocker[]>;
  vendorHistoryConceptIds?: string[];
  globalSignals?: AllocationInput["globalSignals"];
  discoveryContext?: AllocationInput["discoveryContext"];
}): RankedCluster[] {
  const g = args.globalSignals ?? {};
  return args.clusters.map((cluster) => {
    // Phase 4R · Phase 7 (2026-08-12) — cluster-owned architecture:
    // even unresolved clusters (no dominant concept identified from
    // line-item text) still run through the canonical ranker on their
    // OWN line-item + globalSignals evidence. Previously we early-
    // exited on !conceptId because the doc-level canonical facade
    // would produce a fallback recommendation. Under cluster-owned
    // architecture there is no fallback: unresolved clusters must
    // still get their fair chance at canonical ranking, and
    // rankCanonical will honestly ABSTAIN when its own scoring
    // produces no candidate above COMMIT_MIN_SCORE.
    // Sprint 3 · Checkpoint 15V — per-cluster ranking is grounded in
    // the cluster's own CONCEPT + its own line evidence. The
    // cluster's conceptId (from per-line evidence OR from document-
    // level fallback) becomes a synthetic query concept so lines
    // like "CPA Alberta Fee" that carry no per-line synonym match
    // still steer their cluster toward the right membership-dues
    // account. The document-WIDE purpose (which spans ALL clusters
    // and would drag the interest allocation back onto membership)
    // is NOT replayed here.
    const clusterLines = cluster.assignments.map((a) => a.line);
    const queryConcepts = extractQueryConcepts({
      lineItems: clusterLines,
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      vendorHistoryConceptIds: args.vendorHistoryConceptIds,
    });
    // Synthetic cluster-concept evidence — always add the cluster's
    // dominant concept as a supporting query signal so the ranker
    // can route an opaque line to the semantically correct account.
    // Phase 7: cluster.conceptId may be null (unresolved cluster).
    // Skip synthetic concept evidence when null; rankCanonical still
    // scores against cluster line-item text + globalSignals.
    const clusterConcept = cluster.conceptId ? CONCEPT_BY_ID[cluster.conceptId] : null;
    if (cluster.conceptId && clusterConcept) {
      queryConcepts.push({
        conceptId: cluster.conceptId,
        concept: clusterConcept,
        source: "economic_purpose",
        matchStrength: 85,
        weight: 20,
        evidenceSnippet: `Cluster concept "${clusterConcept.canonicalName}"`,
      });
    }
    // Sprint 3 · Ranker Authority slice (2026-08-10, §2 · §4) —
    // Phase 4R (2026-08-10) — Purpose-specific compatibility.
    //
    // Compute effective cluster hints by WALKING UP the concept
    // hierarchy: a leaf concept like `equipment_repair` (no direct
    // hints) inherits its parent `repairs_and_maintenance`'s hints
    // `[IS_REPAIRS_MAINTENANCE]`. Similarly `telephony` /
    // `connectivity_internet` inherit `communications`'s
    // `[IS_TELEPHONE_INTERNET, IS_COMMUNICATIONS]`.
    //
    // Filter strategy = "prefer-if-available":
    //   1. Start from the payroll-hard-exclusion filter (family-
    //      incompatibility.ts — payroll only).
    //   2. If the cluster has effective hints AND ≥1 non-payroll
    //      account in the COA carries a matching fsGroupKey,
    //      restrict the pool to those matching accounts. Purpose is
    //      authority (§13, §22): a `telephony` cluster prefers
    //      Telephone accounts even inside an IT-provider invoice.
    //   3. If NO account matches the hints, retain the full non-
    //      payroll pool — the relevance scorer picks the best
    //      available account. Prevents a semantically-strong line
    //      from being made impossible to allocate on a tenant COA
    //      that lacks the ideal family.
    const clusterFsGroupHints = computeEffectiveClusterHints(clusterConcept);
    const nonPayrollAccounts = args.accounts.filter(
      (a) => !isFsGroupFamilyIncompatibleWithCluster(a.fsGroupKey, clusterFsGroupHints),
    );
    let eligibleAccounts = nonPayrollAccounts;
    if (clusterFsGroupHints.length > 0) {
      const hintMatching = nonPayrollAccounts.filter(
        (a) => a.fsGroupKey != null && clusterFsGroupHints.includes(a.fsGroupKey),
      );
      if (hintMatching.length > 0) {
        eligibleAccounts = hintMatching;
      }
      // else: no hint-matching account — keep the non-payroll pool
      // so allocation still succeeds on tenant COAs that lack the
      // ideal family.
    }
    // Phase 4R · Phase 7.2 (2026-08-13) — CANDIDATE-DISCOVERY UNION.
    //
    // Founder architectural law (§1 of the Phase 7.2 directive):
    //   "Spectre may have multiple independent ways to DISCOVER
    //    plausible GL accounts, but exactly one mechanism may RANK
    //    and SELECT the GL account."
    //
    // Phase 7.1 restricted `eligibleAccounts` to the hint-matched
    // subset (or full non-payroll pool when no hints matched). The
    // forensic v206-vs-Phase7.1 comparison established that this
    // narrowed the candidate pool below v206's recall floor and
    // dropped GL Top-1 accuracy from 17/42 to 9/42.
    //
    // Phase 7.2 restores v206's discovery capability WITHOUT
    // restoring its multi-authority winner selection: discovery
    // providers (candidate-discovery/providers) each contribute
    // ACCOUNT IDENTITIES only, and the union widens the eligible
    // pool. `rankCanonical` remains the sole winner-selection
    // authority. Discovery frequency is NOT accounting evidence.
    const discoveryInput: CandidateDiscoveryInput = {
      eligibleAccounts: nonPayrollAccounts, // full non-payroll pool for discovery scanning
      clusterLineDescriptions: clusterLines.map((l) => l.description),
      clusterConceptId: cluster.conceptId,
      clusterFsGroupHints,
      discoveryContext: args.discoveryContext,
      globalSignals: {
        supplierName: null, // reserved for a future slice; not needed by current providers
        natureLeader: g.natureLeader ?? null,
        natureIsDefensible: g.natureIsDefensible ?? false,
        natureConfidence: g.natureConfidence ?? 0,
        capitalDecision: g.capitalDecision ?? null,
        capitalConfidence: g.capitalConfidence ?? 0,
        hasHighQualityDurableAssetContext: g.hasHighQualityDurableAssetContext ?? false,
        hasFinancingEvidence: g.hasFinancingEvidence ?? false,
        departmentKey: g.departmentKey ?? null,
        priorCodingAccountNumbers: g.priorCodingAccountNumbers ?? [],
        preferredAccountNumbers: g.preferredAccountNumbers ?? [],
        contradictedAccountNumbers: g.contradictedAccountNumbers ?? [],
      },
    };
    const discovery = discoverCandidates(ALL_DISCOVERY_PROVIDERS, discoveryInput);
    // Union the hint-preferred pool with discovered candidates. Hard
    // eligibility (payroll exclusion, active/postable status) is
    // already applied to `nonPayrollAccounts`; discovery only adds
    // candidates from within that pool.
    eligibleAccounts = unionEligiblePool(eligibleAccounts, nonPayrollAccounts, discovery);
    // Phase 4R · Phase 5 — canonical per-cluster ranker replaces
    // the legacy rankAccountsPure. Same evidence-role model, same
    // recommendation policy, same confidence assessment as
    // document-level classification.
    return rankClusterCanonically({
      cluster,
      eligibleAccounts,
      queryConcepts,
      postingBlockersByAccount: args.postingBlockersByAccount,
      globalSignals: {
        departmentKey: g.departmentKey ?? null,
        departmentAccountNamePatterns: g.departmentAccountNamePatterns ?? [],
        natureLeader: g.natureLeader ?? "UNKNOWN",
        natureConfidence: g.natureConfidence ?? 0,
        natureIsDefensible: g.natureIsDefensible ?? false,
        capitalDecision: g.capitalDecision ?? null,
        capitalConfidence: g.capitalConfidence ?? 0,
        hasHighQualityDurableAssetContext: g.hasHighQualityDurableAssetContext ?? false,
        hasFinancingEvidence: g.hasFinancingEvidence ?? false,
        preferredAccountNumbers: g.preferredAccountNumbers,
        contradictedAccountNumbers: g.contradictedAccountNumbers,
        priorCodingAccountNumbers: g.priorCodingAccountNumbers ?? [],
        matchedVendorId: g.matchedVendorId ?? null,
      },
    });
  });
}

// -----------------------------------------------------------------------------
// Merge clusters that select the same account
// -----------------------------------------------------------------------------

function mergeSameAccountClusters(ranked: RankedCluster[]): RankedCluster[] {
  const byAccount = new Map<string, RankedCluster[]>();
  const unresolved: RankedCluster[] = [];
  for (const r of ranked) {
    const top = r.rankedTop[0];
    // Phase 4R · Phase 6 (2026-08-11) — same-defect migration as
    // toAllocations. Merge eligibility now reads the canonical
    // recommendation status rather than a legacy numeric threshold
    // (RECOMMENDATION_MIN_SCORE=40 was calibrated to the pre-Phase-5
    // rankAccountsPure scale and does not match the canonical
    // scoring scale). Clusters where canonical policy said ABSTAIN /
    // NO_CANDIDATES / ANALYSIS_FAILURE go to unresolved; clusters
    // with a canonical RECOMMEND are eligible to be merged with
    // siblings that picked the same account.
    const canonicalRecommend = r.canonical?.recommendationStatus === "RECOMMEND";
    if (!top || !canonicalRecommend) {
      // No confident recommendation — retain as its own cluster (may
      // be merged into unresolved allocation later).
      unresolved.push(r);
      continue;
    }
    const key = top.accountNumber;
    let list = byAccount.get(key);
    if (!list) { list = []; byAccount.set(key, list); }
    list.push(r);
  }
  const merged: RankedCluster[] = [];
  for (const [_accountNumber, list] of byAccount) {
    if (list.length === 1) {
      merged.push(list[0]);
      continue;
    }
    // Merge: combine cluster line assignments into one.
    const combined: RawCluster = {
      // Concept id becomes the dominant one across the merged list.
      conceptId: pickDominantConcept(list),
      assignments: list.flatMap((r) => r.cluster.assignments),
      totalAmount: list.reduce((s, r) => s + r.cluster.totalAmount, 0),
    };
    // Reuse the ranker top from the highest-scoring input.
    const best = list.reduce((a, b) => (a.rankedTop[0]?.semanticScore ?? 0) >= (b.rankedTop[0]?.semanticScore ?? 0) ? a : b);
    merged.push({ cluster: combined, rankedTop: best.rankedTop });
  }
  // Concatenate unresolved separately so they don't merge into
  // account clusters.
  merged.push(...unresolved);
  return merged;
}

function pickDominantConcept(list: RankedCluster[]): string {
  // Amount-weighted vote across concepts within the merged list.
  const totals = new Map<string, number>();
  for (const r of list) {
    if (!r.cluster.conceptId) continue;
    totals.set(r.cluster.conceptId, (totals.get(r.cluster.conceptId) ?? 0) + Math.abs(r.cluster.totalAmount));
  }
  const ranked = [...totals.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  return ranked[0]?.[0] ?? "unresolved";
}

// -----------------------------------------------------------------------------
// Materiality: apply §6 rules to keep or merge small allocations
// -----------------------------------------------------------------------------

function applyMateriality(clusters: RankedCluster[]): RankedCluster[] {
  return clusters.filter((r) => {
    const positiveAmount = r.cluster.assignments
      .filter((a) => a.line.amount > 0)
      .reduce((s, a) => s + a.line.amount, 0);
    if (Math.abs(r.cluster.totalAmount) < DE_MINIMIS_AMOUNT && positiveAmount < DE_MINIMIS_AMOUNT) return false;
    if (positiveAmount >= DE_MINIMIS_AMOUNT) return true;
    // Below de-minimis. Keep only if special-handling concept.
    if (r.cluster.conceptId && SPECIAL_HANDLING_CONCEPTS.has(r.cluster.conceptId)) return true;
    return false;
  });
}

// -----------------------------------------------------------------------------
// Convert clusters into ApGlAllocation objects
// -----------------------------------------------------------------------------

function toAllocations(clusters: RankedCluster[]): ApGlAllocation[] {
  return clusters.map((r) => {
    const positiveLines = r.cluster.assignments.filter((a) => a.line.amount > 0);
    const amount = round2(positiveLines.reduce((s, a) => s + a.line.amount, 0));
    const taxTreatment = aggregateTaxTreatment(r.cluster.assignments.map((a) => a.line.taxTreatment));
    const taxRate = pickTaxRate(r.cluster.assignments);
    const taxAmount = pickTaxAmount(r.cluster.assignments);
    const top = r.rankedTop[0] ?? null;
    // Phase 4R · Phase 6 (2026-08-11) — allocation projection reads
    // canonical recommendation policy (already computed per-cluster
    // in rankClusterCanonically), NOT a legacy numeric score
    // threshold. The Phase 5 canonical ranker's own COMMIT_MIN_SCORE
    // (30) already gated RECOMMEND vs ABSTAIN before we get here;
    // re-applying the pre-Phase-5 RECOMMENDATION_MIN_SCORE=40 threshold
    // was flagging valid canonical RECOMMENDs (scoring 30-39) as
    // requiring review, which then broke deriveCardCategory.
    // toAllocations remains a pure projection: it consumes
    // r.canonical.recommendationStatus, does not re-decide.
    const requiresReview = r.canonical
      ? r.canonical.recommendationStatus !== "RECOMMEND"
      : (top == null);
    const recommendedAccount: AllocationRecommendedAccount | null = top
      ? {
          accountId: `a-${top.accountNumber}`,
          accountNumber: top.accountNumber,
          accountName: top.accountName,
          confidence: Math.min(95, top.semanticScore),
          requiresReview,
          postingBlockers: top.postingBlockers,
        }
      : null;
    const alternatives: AllocationAlternative[] = r.rankedTop.slice(1, 4).map((c) => ({
      accountId: `a-${c.accountNumber}`,
      accountNumber: c.accountNumber,
      accountName: c.accountName,
      score: c.semanticScore,
    }));
    return {
      id: allocationId(r.cluster.conceptId ?? "unresolved", top?.accountNumber ?? "0000", r.cluster.assignments.map((a) => a.line.lineNo)),
      sourceLineItemIds: r.cluster.assignments.map((a) => String(a.line.lineNo)),
      descriptions: r.cluster.assignments.map((a) => a.line.description),
      economicPurpose: {
        concept: r.cluster.conceptId ?? "unresolved",
        confidence: r.cluster.conceptId
          ? Math.min(95, Math.round(r.cluster.assignments.reduce((s, a) => s + a.matchStrength, 0) / r.cluster.assignments.length))
          : 0,
        supportingEvidence: r.cluster.assignments
          .filter((a) => a.matchedPhrase)
          .map((a) => `Line "${a.line.description.slice(0, 60)}" → ${a.matchedPhrase} (${a.conceptSource})`)
          .slice(0, 6),
      },
      amount,
      taxTreatment,
      taxRate,
      taxAmount,
      recommendedAccount,
      alternatives,
      // Phase 4R · Phase 5 — per-allocation canonical provenance.
      canonicalWinnerAccountNumber: r.canonical?.winnerAccountNumber ?? null,
      recommendationStatus: r.canonical?.recommendationStatus,
      canonicalConfidence: r.canonical?.confidence,
    };
  });
}

function aggregateTaxTreatment(treatments: LineTaxTreatment[]): AllocationTaxTreatment {
  const distinct = new Set(treatments);
  if (distinct.size === 0) return "UNKNOWN";
  if (distinct.size === 1) {
    const only = [...distinct][0];
    switch (only) {
      case "taxable": return "TAXABLE";
      case "exempt": return "EXEMPT";
      case "zero_rated": return "ZERO_RATED";
      case "out_of_scope": return "OUT_OF_SCOPE";
      case "unknown": return "UNKNOWN";
    }
  }
  return "MIXED";
}

function pickTaxRate(assignments: LineAssignment[]): number | null {
  for (const a of assignments) {
    if (a.line.taxRate != null) return a.line.taxRate;
  }
  return null;
}

function pickTaxAmount(assignments: LineAssignment[]): number | null {
  const taxable = assignments
    .filter((a) => a.line.taxAmount != null)
    .reduce((s, a) => s + (a.line.taxAmount ?? 0), 0);
  return taxable > 0 ? round2(taxable) : null;
}

function allocationId(conceptId: string, accountNumber: string, lineNos: number[]): string {
  const lines = lineNos.slice().sort((a, b) => a - b).join(",");
  // Simple deterministic hash — good enough for test IDs; not a
  // cryptographic identifier.
  let hash = 0;
  const raw = `${conceptId}|${accountNumber}|${lines}`;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return `alloc_${(hash >>> 0).toString(36)}`;
}

// -----------------------------------------------------------------------------
// Deterministic sort of allocations (§1)
// -----------------------------------------------------------------------------

function sortAllocations(allocations: ApGlAllocation[]): ApGlAllocation[] {
  return [...allocations].sort((a, b) => {
    if (b.amount !== a.amount) return b.amount - a.amount;
    if ((b.economicPurpose.confidence) !== (a.economicPurpose.confidence)) {
      return b.economicPurpose.confidence - a.economicPurpose.confidence;
    }
    const aAcct = a.recommendedAccount?.accountNumber ?? "9999";
    const bAcct = b.recommendedAccount?.accountNumber ?? "9999";
    return aAcct.localeCompare(bAcct);
  });
}

// -----------------------------------------------------------------------------
// Reconciliation totals + card category derivation
// -----------------------------------------------------------------------------

function computeTotals(args: {
  allocations: ApGlAllocation[];
  lineItems: LineItem[];
  printedSubtotal: number | null;
  printedTax: number | null;
  printedTotal: number | null;
}): AllocationTotals {
  const allocationsSubtotal = round2(args.allocations.reduce((s, a) => s + a.amount, 0));
  const creditTotal = round2(
    args.lineItems
      .filter((l) => l.amount < 0)
      .reduce((s, l) => s + Math.abs(l.amount), 0),
  );
  const taxTotal = args.printedTax ?? 0;
  const grossTotal = args.printedTotal ?? (args.printedSubtotal ?? allocationsSubtotal) + taxTotal - creditTotal;
  const derived = round2(allocationsSubtotal + taxTotal - creditTotal);
  const allocationVariance = round2(grossTotal - derived);
  return { allocationsSubtotal, taxTotal, creditTotal, grossTotal, allocationVariance };
}

function deriveCardCategory(allocations: ApGlAllocation[]): string | null {
  // §8: Multiple specifically means more than one PROPOSED expense/
  // asset GL allocation. Tax splits alone do NOT trigger Multiple.
  const withAccount = allocations.filter((a) => a.recommendedAccount != null && !a.recommendedAccount.requiresReview);
  if (withAccount.length === 0) return null;
  if (withAccount.length === 1) return withAccount[0].recommendedAccount!.accountName;
  return "Multiple";
}

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export function computeAllocations(input: AllocationInput): AllocationResult {
  const positiveLines = input.lineItems.filter((l) => l.amount > 0);
  if (positiveLines.length === 0) {
    return {
      allocations: [],
      totals: computeTotals({
        allocations: [],
        lineItems: input.lineItems,
        printedSubtotal: input.printedSubtotal,
        printedTax: input.printedTax,
        printedTotal: input.printedTotal,
      }),
      cardCategory: null,
      requiresReview: true,
      allocationEligibilityMode: "NOT_EVALUATED",
    };
  }

  // Step 1: document-level fallback concept. Phase 7.1 (2026-08-13)
  // now consumes canonical purposeDecision (if committed) in
  // preference to the legacy economicPurposeCandidates vote.
  const docFallback = documentFallbackConcept({
    economicPurposeCandidates: input.economicPurposeCandidates,
    fullDocumentText: input.fullDocumentText,
    purposeDecision: input.purposeDecision ?? null,
  });

  // Step 2: per-line concept assignment. Phase 7.1: when the
  // canonical document purpose is committed, its concept overrides
  // per-line synonym matches EXCEPT for SPECIAL_HANDLING or very-
  // strong-distinct signals. This corrects the 221178 fragmentation
  // where 5 IT-service lines were splitting on incidental synonym
  // matches despite canonical committing to SOFTWARE_SUBSCRIPTION.
  const canonicalIsCommitted = input.purposeDecision != null
    && (input.purposeDecision.source === "CANONICAL_COMMITTED"
        || input.purposeDecision.source === "CANONICAL_LEGACY_CONCUR")
    && input.purposeDecision.concept != null;
  const canonicalDocConceptId = canonicalIsCommitted && input.purposeDecision?.concept
    ? (CANONICAL_PURPOSE_TO_CONCEPT[input.purposeDecision.concept] ?? null)
    : null;
  const assignments = positiveLines.map((line) =>
    assignConceptToLine(
      line,
      docFallback?.conceptId ?? null,
      canonicalDocConceptId,
      canonicalIsCommitted && canonicalDocConceptId != null,
    ),
  );

  // Step 2b: Sprint 3 · 221178 IT-taxonomy slice (2026-08-10) §6 —
  // document-level coherence.
  //
  // Phase 4R remediation (2026-08-10) — narrowed. When ≥2 resolved
  // sibling lines carry an `IS_IT_SOFTWARE` fsGroupKeyHint, promote
  // the GENERIC `repairs_and_maintenance` bucket to `it_services`
  // (that generic bucket usually represents "the word 'maintenance'
  // appeared with no domain-specific context" — on Club Support
  // 221178, "Service Maintenance Fee" is IT service maintenance).
  //
  // §20 / §22 reverse control: SPECIFIC R&M children —
  // `equipment_repair` (mentions specific equipment), `building_
  // maintenance` (mentions building/roof/HVAC), `course_maintenance`
  // (mentions greens/fairway) — are STRONGLY identified per-line
  // purposes and MUST NOT be overwritten by document family. An IT
  // provider that separately invoices "repair server hardware" gets
  // `equipment_repair` and keeps eligibility for R&M accounts.
  const itHintSiblings = assignments.filter((a) => {
    if (!a.conceptId) return false;
    const c = CONCEPT_BY_ID[a.conceptId];
    return !!c && c.fsGroupKeyHints.includes("IS_IT_SOFTWARE");
  }).length;
  if (itHintSiblings >= 2) {
    for (let i = 0; i < assignments.length; i++) {
      const a = assignments[i];
      // ONLY override the GENERIC r&m bucket. Specific R&M children
      // stay put — their evidence is stronger than document family.
      if (a.conceptId === "repairs_and_maintenance") {
        assignments[i] = {
          ...a,
          conceptId: "it_services",
          conceptSource: "document_fallback",
          matchedPhrase: a.matchedPhrase + " (reclassified: IT-dominant invoice)",
        };
      }
    }
  }

  // Step 3: raw clustering by concept.
  const rawClusters = buildClusters(assignments);

  // Step 4: rank each cluster against the full tenant COA.
  // Phase 4R · Phase 5 — canonical per-cluster ranker + policy +
  // confidence assessment.
  const ranked = rankClusters({
    clusters: rawClusters,
    accounts: input.accounts,
    postingBlockersByAccount: input.postingBlockersByAccount,
    vendorHistoryConceptIds: input.vendorHistoryConceptIds,
    globalSignals: input.globalSignals,
    discoveryContext: input.discoveryContext,
  });

  // Step 5: merge clusters that select the same account.
  const merged = mergeSameAccountClusters(ranked);

  // Step 6: materiality filter (keeps special-handling small
  // allocations; drops others below de-minimis).
  const material = applyMateriality(merged);

  // Step 7: build allocations.
  const allocations = sortAllocations(toAllocations(material));

  // Step 8: reconciliation totals.
  const totals = computeTotals({
    allocations,
    lineItems: input.lineItems,
    printedSubtotal: input.printedSubtotal,
    printedTax: input.printedTax,
    printedTotal: input.printedTotal,
  });

  // Step 9: derive card category + requiresReview.
  const cardCategory = deriveCardCategory(allocations);
  // Phase 2.1 (2026-08-06) §A5 — until per-allocation eligibility
  // context wiring lands, multi-allocation invoices are always
  // requiresReview=true. The current Phase 2 wire threads one
  // document-level `expectedDebitRole` through recommendGlAccount,
  // which the ranker reuses for every candidate; each allocation
  // has NOT been evaluated with its own transaction context yet.
  // Report the mode explicitly so the workflow layer (Phase 3) can
  // block AUTO_APPROVAL_ELIGIBLE on anything other than
  // PER_ALLOCATION.
  const materialAllocations = allocations.filter((a) => Math.abs(a.amount) >= 0.01).length;
  // NOTE: DOCUMENT_FALLBACK is currently the only mode this function
  // emits — per-allocation contexts are threaded end-to-end in Phase 3.
  // Widening `allocationEligibilityMode` to a broader union here
  // avoids a spurious TS "no overlap" check on the requiresReview
  // guard below and keeps the invariant explicit.
  const allocationEligibilityMode: AllocationResult["allocationEligibilityMode"] = "DOCUMENT_FALLBACK";
  const multiAllocationBlocked =
    materialAllocations >= 2 && (allocationEligibilityMode as string) !== "PER_ALLOCATION";
  const requiresReview =
    allocations.length === 0
    || allocations.some((a) => a.recommendedAccount == null || a.recommendedAccount.requiresReview)
    || Math.abs(totals.allocationVariance) > 0.02
    || multiAllocationBlocked;

  return { allocations, totals, cardCategory, requiresReview, allocationEligibilityMode };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Phase 4R · Phase 7 (2026-08-12) — cluster-owned document GL projection.
//
// The founder-approved architecture: THE ECONOMIC TRANSACTION CLUSTER IS THE
// UNIT OF GL CLASSIFICATION. `analyseIngestedInvoice` no longer runs a
// second document-level canonical competition; it consumes the cluster
// canonical results already computed by `rankClusterCanonically` and
// projects them into a `GlRecommendation`.
//
// - Single-cluster invoice: document GL === cluster canonical result
//   (winner, candidates, confidence, recommendationStatus, provenance).
// - Multi-cluster invoice: gl.accountNumber = null (no single truthful
//   account). Overall status = strictest cluster status (any ABSTAIN_*
//   → overall reflects that category). Overall confidence = weakest
//   cluster level. Overall requiresReview = any cluster requires review.
// - Field-quality fail: overall ABSTAIN_QUALITY regardless of cluster
//   outcomes; canonical winner (if any) preserved on
//   `gl.canonicalWinnerAccountNumber` for single-cluster only.
// - No allocations at all: NO_ELIGIBLE_CANDIDATES.
// ---------------------------------------------------------------------------

type ProjClusterMinimal = Pick<
  ApGlAllocation,
  "canonicalWinnerAccountNumber" | "recommendationStatus" | "canonicalConfidence" | "recommendedAccount"
>;

/**
 * Aggregation precedence for recommendation status across clusters (§7):
 *   any ABSTAIN_QUALITY         → overall ABSTAIN_QUALITY
 *   else any ABSTAIN_ANALYSIS_FAILURE → overall ABSTAIN_ANALYSIS_FAILURE
 *   else any ABSTAIN_NO_CANDIDATES    → overall ABSTAIN_NO_CANDIDATES
 *   else any ABSTAIN_AMBIGUITY        → overall ABSTAIN_AMBIGUITY
 *   else all RECOMMEND               → overall RECOMMEND
 */
function aggregateRecommendationStatus(
  statuses: ReadonlyArray<import("./recommendation-policy").RecommendationStatus | undefined>,
): import("./recommendation-policy").RecommendationStatus {
  const defined = statuses.filter((s): s is import("./recommendation-policy").RecommendationStatus => s != null);
  if (defined.length === 0) return "ABSTAIN_NO_CANDIDATES";
  if (defined.some((s) => s === "ABSTAIN_QUALITY")) return "ABSTAIN_QUALITY";
  if (defined.some((s) => s === "ABSTAIN_ANALYSIS_FAILURE")) return "ABSTAIN_ANALYSIS_FAILURE";
  if (defined.some((s) => s === "ABSTAIN_NO_CANDIDATES")) return "ABSTAIN_NO_CANDIDATES";
  if (defined.some((s) => s === "ABSTAIN_AMBIGUITY")) return "ABSTAIN_AMBIGUITY";
  return "RECOMMEND";
}

/**
 * Aggregation precedence for confidence level across clusters (§8):
 *   any REVIEW_REQUIRED → REVIEW_REQUIRED
 *   else any LOW        → LOW
 *   else any MODERATE   → MODERATE
 *   else all HIGH       → HIGH
 */
function aggregateConfidenceLevel(
  levels: ReadonlyArray<import("./canonical-confidence").ConfidenceLevel | undefined>,
): import("./canonical-confidence").ConfidenceLevel {
  const defined = levels.filter((l): l is import("./canonical-confidence").ConfidenceLevel => l != null);
  if (defined.length === 0) return "REVIEW_REQUIRED";
  if (defined.some((l) => l === "REVIEW_REQUIRED")) return "REVIEW_REQUIRED";
  if (defined.some((l) => l === "LOW")) return "LOW";
  if (defined.some((l) => l === "MODERATE")) return "MODERATE";
  return "HIGH";
}

export interface ProjectClustersToGlOpts {
  fieldQualityEligible: boolean;
  fieldQualityAbstentionReasons: ReadonlyArray<string>;
  totalAccountsEvaluated: number;
}

export function projectClustersToGlRecommendation(
  allocations: ReadonlyArray<ApGlAllocation>,
  opts: ProjectClustersToGlOpts,
): GlRecommendation {
  // Case A · no allocations at all → NO_ELIGIBLE_CANDIDATES.
  if (allocations.length === 0) {
    return emptyGlRec(opts.totalAccountsEvaluated, "no_allocations_derived_from_invoice", {
      recommendationStatus: "ABSTAIN_NO_CANDIDATES",
      abstentionCategory: "NO_CANDIDATES",
      abstentionReasons: ["no_allocations_derived_from_invoice"],
    });
  }

  // Case B · field-quality fail → ABSTAIN_QUALITY overall regardless
  // of cluster outcomes. Winner provenance retained for single cluster.
  if (!opts.fieldQualityEligible) {
    const single = allocations.length === 1 ? allocations[0] : null;
    return emptyGlRec(opts.totalAccountsEvaluated, `abstained_field_quality:${opts.fieldQualityAbstentionReasons.join(",")}`, {
      recommendationStatus: "ABSTAIN_QUALITY",
      abstentionCategory: "QUALITY",
      abstentionReasons: [...opts.fieldQualityAbstentionReasons],
      canonicalWinnerAccountNumber: single?.canonicalWinnerAccountNumber ?? null,
      canonicalConfidence: single?.canonicalConfidence,
    });
  }

  // Case C · single-cluster invoice → gl mirrors cluster canonical
  // result. This is the founder-approved single-authority rule for
  // single-cluster invoices: exactly ONE accounting competition
  // determined the answer.
  if (allocations.length === 1) {
    return projectSingleClusterToGl(allocations[0], opts.totalAccountsEvaluated);
  }

  // Case D · multi-cluster invoice → gl.accountNumber = null (per
  // founder §7 Option A: no synthetic representative GL). Overall
  // status/confidence aggregated across clusters.
  const statuses = allocations.map((a) => a.recommendationStatus);
  const levels = allocations.map((a) => a.canonicalConfidence?.level);
  const overallStatus = aggregateRecommendationStatus(statuses);
  const overallLevel = aggregateConfidenceLevel(levels);
  const abstentionReasons = allocations.flatMap((a) => a.canonicalConfidence?.reasonCodes ?? []);
  return emptyGlRec(opts.totalAccountsEvaluated,
    `multi_allocation:${allocations.length}_clusters · status=${overallStatus} · confidence=${overallLevel}`,
    {
      recommendationStatus: overallStatus,
      abstentionCategory: overallStatus === "RECOMMEND" ? null : (
        overallStatus === "ABSTAIN_QUALITY" ? "QUALITY"
        : overallStatus === "ABSTAIN_AMBIGUITY" ? "AMBIGUITY"
        : overallStatus === "ABSTAIN_NO_CANDIDATES" ? "NO_CANDIDATES"
        : "ANALYSIS_FAILURE"
      ),
      abstentionReasons,
      canonicalWinnerAccountNumber: null,
      canonicalConfidence: {
        level: overallLevel,
        winnerAccountId: null,
        winnerAccountNumber: null,
        winnerScore: null,
        winnerDecisionEvidenceCount: 0,
        winnerDecisionFamilyCount: 0,
        winnerContradictions: [],
        genuineCompetitors: [],
        marginToStrongestCompetitor: null,
        isDeterministicTieBreak: false,
        recommendationStatus: overallStatus,
        reasonCodes: [`multi_allocation_aggregate:${allocations.length}_clusters`, `overall_status:${overallStatus}`, `overall_level:${overallLevel}`],
        humanReadableReason: `Multi-allocation invoice (${allocations.length} clusters) — overall ${overallLevel}. Per-allocation results are authoritative; no single document-level GL account.`,
      },
    },
  );
}

function projectSingleClusterToGl(
  alloc: ApGlAllocation,
  totalAccountsEvaluated: number,
): GlRecommendation {
  const rec = alloc.recommendedAccount;
  const status = alloc.recommendationStatus ?? "ABSTAIN_NO_CANDIDATES";
  const conf = alloc.canonicalConfidence;
  const isRecommend = status === "RECOMMEND" && rec != null;
  return {
    ruleVersion: 2,
    accountNumber: isRecommend ? rec!.accountNumber : null,
    accountName: isRecommend ? rec!.accountName : null,
    categoryKey: null,
    fsGroupKey: null,
    confidence: isRecommend ? rec!.confidence : null,
    reason: isRecommend
      ? `cluster_owned_projection:single_cluster:winner=${rec!.accountNumber}(conf=${rec!.confidence})`
      : `cluster_owned_projection:single_cluster:${status.toLowerCase()}`,
    source: isRecommend ? "SEMANTIC_MATCH" : "NONE",
    candidates: (() => {
      if (rec != null) {
        const alts = alloc.alternatives.map((a) => ({
          accountId: a.accountId,
          accountNumber: a.accountNumber,
          accountName: a.accountName,
          categoryKey: null as string | null,
          fsGroupKey: null as string | null,
          confidence: a.score,
          evidence: [],
          postable: true,
          postingBlockers: [] as PostingBlocker[],
        }));
        const winnerCand: GlCandidate = {
          accountId: rec.accountId,
          accountNumber: rec.accountNumber,
          accountName: rec.accountName,
          categoryKey: null,
          fsGroupKey: null,
          confidence: rec.confidence,
          evidence: [],
          postable: !rec.requiresReview,
          postingBlockers: rec.postingBlockers ?? [],
        };
        return [winnerCand, ...alts];
      }
      return [];
    })(),
    leaderIsPostable: isRecommend ? !rec!.requiresReview : false,
    leaderPostingBlockers: isRecommend ? (rec!.postingBlockers ?? []) : [],
    autoApprovalEligible: isRecommend && conf?.level === "HIGH",
    rationale: {
      selectedAccountId: isRecommend ? rec!.accountId : null,
      selectedConcept: null,
      supportingDocumentEvidence: [],
      supportingTaxonomyEvidence: [],
      contradictedAccountConcepts: [],
      alternativeAccounts: alloc.alternatives.slice(0, 4).map((a) => ({
        accountId: a.accountId,
        accountNumber: a.accountNumber,
        accountName: a.accountName,
        semanticScore: a.score,
        reason: `cluster alternative score ${a.score}`,
      })),
      requiresReview: !isRecommend,
      minRelevanceThreshold: 30,
    },
    totalAccountsEvaluated,
    requiresReview: !isRecommend,
    splitRecommendations: [],
    recommendationStatus: status,
    abstentionCategory: status === "RECOMMEND" ? null : (
      status === "ABSTAIN_QUALITY" ? "QUALITY"
      : status === "ABSTAIN_AMBIGUITY" ? "AMBIGUITY"
      : status === "ABSTAIN_NO_CANDIDATES" ? "NO_CANDIDATES"
      : "ANALYSIS_FAILURE"
    ),
    abstentionReasons: conf?.reasonCodes ?? [],
    canonicalWinnerAccountNumber: alloc.canonicalWinnerAccountNumber ?? null,
    canonicalConfidence: conf,
  };
}

function emptyGlRec(
  totalAccountsEvaluated: number,
  reason: string,
  extras: Partial<GlRecommendation>,
): GlRecommendation {
  return {
    ruleVersion: 2,
    accountNumber: null,
    accountName: null,
    categoryKey: null,
    fsGroupKey: null,
    confidence: null,
    reason,
    source: "NONE",
    candidates: [],
    leaderIsPostable: false,
    leaderPostingBlockers: [],
    autoApprovalEligible: false,
    rationale: {
      selectedAccountId: null,
      selectedConcept: null,
      supportingDocumentEvidence: [],
      supportingTaxonomyEvidence: [],
      contradictedAccountConcepts: [],
      alternativeAccounts: [],
      requiresReview: true,
      minRelevanceThreshold: 30,
    },
    totalAccountsEvaluated,
    requiresReview: true,
    splitRecommendations: [],
    ...extras,
  };
}

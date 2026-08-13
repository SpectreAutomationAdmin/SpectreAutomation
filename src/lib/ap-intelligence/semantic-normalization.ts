// Phase 4R · Phase 7.2D (2026-08-13) — Canonical semantic normalization.
//
// FOUNDER §3 BOUNDARY:
//   "The canonical ranker should receive a deliberately normalized
//    semantic representation. Do not rely on callers knowing which
//    internal enum a downstream helper expects."
//
// Every source of "what kind of transaction is this?" — the canonical
// purpose classifier, the cluster's ACCOUNTING_CONCEPTS id, the
// legacy PurposeCandidate — is normalised HERE into a single
// canonical `EconomicPurposeConcept` value that downstream lookup
// tables (`PURPOSE_ACCOUNT_NAME_SUBSTRINGS`, `PURPOSE_ACCOUNT_TYPE`,
// `PURPOSE_CATEGORY_HINTS`) can consume without further translation.
//
// Phase 7.2C fixed the committed-canonical branch at gl-allocations
// but left the fallback branch (cluster.conceptId, lowercase snake_case)
// shipping the wrong vocabulary. This module is the fix — it inverts
// CANONICAL_PURPOSE_TO_CONCEPT and adds a few additional cluster-
// concept-id → canonical-purpose mappings for concepts that are
// commonly reached via clustering but never emitted by the canonical
// purpose classifier (e.g. `bank_charges`, `interest_and_penalties`).
//
// SEMANTIC-INVARIANT tests must lock in every mapping. See
// tests/phase4r-phase72d-semantic-normalization.test.ts.

import type { EconomicPurposeConcept } from "./economic-purpose-taxonomy";
import type { EconomicPurposeDecision } from "./economic-purpose-authority";

/** ACCOUNTING_CONCEPTS.id (lowercase snake_case from gl-concepts.ts)
 *  → canonical EconomicPurposeConcept enum value.
 *
 *  The inverse of CANONICAL_PURPOSE_TO_CONCEPT in gl-allocations.ts,
 *  plus additional cluster-concepts that are commonly reached via
 *  per-line matching but never emitted by the canonical purpose
 *  classifier (e.g. interest_and_penalties, bank_charges,
 *  fuel_surcharge, delivery_and_freight, food_cost_of_sales without
 *  a canonical decision, etc.).
 *
 *  Every entry is a CLASS-of-thing mapping. No vendor/invoice/account
 *  literals. */
const CLUSTER_CONCEPT_TO_CANONICAL_PURPOSE: Record<string, EconomicPurposeConcept> = {
  // Inversions of CANONICAL_PURPOSE_TO_CONCEPT
  software_subscription_service: "SOFTWARE_SUBSCRIPTION",
  cybersecurity_service: "CYBERSECURITY_SERVICE",
  telephony: "TELECOMMUNICATIONS",
  connectivity_internet: "INTERNET_CONNECTIVITY",
  telephone_and_internet_bundle: "TELECOMMUNICATIONS",
  repairs_and_maintenance: "REPAIR_MAINTENANCE",
  course_maintenance_supplies: "COURSE_MAINTENANCE",
  professional_membership_dues: "PROFESSIONAL_MEMBERSHIP",
  professional_services: "PROFESSIONAL_SERVICES",
  external_accounting_services: "PROFESSIONAL_SERVICES",
  legal_services: "PROFESSIONAL_SERVICES",
  consulting_services: "PROFESSIONAL_SERVICES",
  food_cost_of_sales: "FOOD",
  beverage_cost_of_sales: "BEVERAGE",
  draft_beer_cost_of_sales: "BEVERAGE",
  packaged_beer_cost_of_sales: "BEVERAGE",
  wine_cost_of_sales: "BEVERAGE",
  spirits_cost_of_sales: "BEVERAGE",
  delivery_and_freight: "FREIGHT_DELIVERY",
  office_supplies_general: "OFFICE_SUPPLIES",
  finance_interest_charge: "INTEREST",
  interest_and_penalties: "INTEREST",
  late_payment_penalty: "PENALTY",
  bank_charges: "PENALTY",
  // Utilities cluster — canonical taxonomy has no single UTILITY
  // concept; individual utility concepts map to the closest canonical
  // enum member. TELECOMMUNICATIONS is the nearest match for these
  // for taxonomy purposes.
  electricity_utility: "TELECOMMUNICATIONS",
  natural_gas_utility: "TELECOMMUNICATIONS",
  water_sewer_utility: "TELECOMMUNICATIONS",
  waste_disposal_utility: "TELECOMMUNICATIONS",
  // IT services family
  it_services: "SOFTWARE_SUBSCRIPTION",
  // Fuel surcharge → FUEL for semantic-bridge purposes (name-substring
  // "fuel" surfaces via the FUEL bridge; the cluster itself is
  // classified as a delivery add-on but the ontology reasoning here
  // is about the account taxonomy).
  fuel_surcharge: "FUEL",
  // Cross-family miscellaneous — no canonical mapping, intentionally
  // omitted to force the caller to handle "no canonical purpose"
  // rather than silently guessing. Additional entries added
  // conservatively as diagnostic data supports.
};

/** The Phase 7.2C directive committed only when the source is one of
 *  these two values. Anything below (LEGACY_FALLBACK / ABSTAIN) is
 *  low-confidence and should NOT drive the ontology-name-match
 *  scoring, but the cluster-concept fallback CAN still supply the
 *  vocabulary. */
type CommittedPurposeSource = "CANONICAL_COMMITTED" | "CANONICAL_LEGACY_CONCUR";
function isCommittedPurpose(pd: EconomicPurposeDecision | null | undefined): boolean {
  if (!pd) return false;
  return pd.source === "CANONICAL_COMMITTED" || pd.source === "CANONICAL_LEGACY_CONCUR";
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface NormalizeInput {
  /** Canonical purpose decision from resolveEconomicPurpose. Preferred
   *  when it committed (source ∈ {CANONICAL_COMMITTED, CANONICAL_LEGACY_CONCUR}). */
  purposeDecision?: EconomicPurposeDecision | null;
  /** ACCOUNTING_CONCEPTS.id from cluster.conceptId (lowercase
   *  snake_case). Used as fallback vocabulary when the canonical
   *  purpose didn't commit. */
  clusterConceptId?: string | null;
}

export interface NormalizeResult {
  /** The single canonical enum value the ranker should use for its
   *  ontology / PURPOSE_ACCOUNT_TYPE / PURPOSE_CATEGORY_HINT lookups.
   *  Null when no vocabulary is available. */
  canonicalPurposeConcept: EconomicPurposeConcept | null;
  /** Provenance: how the value was derived. */
  source: "canonical_committed" | "canonical_legacy_concur" | "cluster_concept_fallback" | "no_signal";
  /** Diagnostic — the raw input value that produced the result. */
  raw: string | null;
}

/** Normalise any semantic-input path to a single canonical
 *  EconomicPurposeConcept. Applied at the boundary between cluster
 *  construction and the canonical ranker.
 *
 *  Priority:
 *    1. purposeDecision.concept when source ∈ committed set.
 *    2. clusterConceptId translated via CLUSTER_CONCEPT_TO_CANONICAL_PURPOSE.
 *    3. null (no vocabulary — canonical ranker skips the ontology
 *       branch, which is correct behaviour for genuinely unresolved
 *       transactions).
 */
export function normalizeToCanonicalPurpose(input: NormalizeInput): NormalizeResult {
  if (isCommittedPurpose(input.purposeDecision) && input.purposeDecision?.concept) {
    return {
      canonicalPurposeConcept: input.purposeDecision.concept,
      source: input.purposeDecision.source === "CANONICAL_COMMITTED"
        ? "canonical_committed"
        : "canonical_legacy_concur",
      raw: input.purposeDecision.concept,
    };
  }
  if (input.clusterConceptId) {
    const mapped = CLUSTER_CONCEPT_TO_CANONICAL_PURPOSE[input.clusterConceptId];
    if (mapped) {
      return {
        canonicalPurposeConcept: mapped,
        source: "cluster_concept_fallback",
        raw: input.clusterConceptId,
      };
    }
  }
  return {
    canonicalPurposeConcept: null,
    source: "no_signal",
    raw: input.clusterConceptId ?? null,
  };
}

/** Exported for tests and diagnostics. */
export function getClusterConceptToCanonicalPurposeMap(): Readonly<Record<string, EconomicPurposeConcept>> {
  return CLUSTER_CONCEPT_TO_CANONICAL_PURPOSE;
}

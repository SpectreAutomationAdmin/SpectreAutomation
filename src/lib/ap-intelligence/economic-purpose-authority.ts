// Sprint 3 · Phase 4 Slice 5.2 (2026-08-08) — economic-purpose
// authority.
//
// Founder amendment #1 (approved):
//   - Canonical economic purpose becomes the PRIMARY authority.
//   - Legacy CONCEPT_CATALOG MAY NOT regain full authority simply
//     because canonical confidence is below 60.
//   - When canonical evidence is insufficient, legacy evidence may
//     provide SUPPORTING candidates; it may NOT override
//     contradictory canonical evidence.
//   - If neither source is defensible → abstain / UNKNOWN.
//
// This module is the single funnel every downstream accounting
// consumer should call to get the "official" economic-purpose
// decision. It composes:
//   - Slice-5 DeterministicTaxonomyProvider (canonical, evidence-cited)
//   - Legacy classifyEconomicPurpose (CONCEPT_CATALOG on transactional text)
//
// It returns a decision + a supplemental candidate list that
// downstream code (GL ranker, nature-scoped gate, allocation model)
// can consume as one coherent thing.

import type { CanonicalLineItem } from "./evidence/canonical-line-item";
import {
  DeterministicTaxonomyProvider,
  type EconomicPurposeConcept,
  type PurposeClassification,
} from "./economic-purpose-taxonomy";
import {
  classifyEconomicPurpose,
  type EconomicPurposeInput,
  type PurposeCandidate,
} from "./economic-purpose";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type PurposeAuthoritySource =
  /** Canonical Slice-5 taxonomy committed the concept. */
  | "CANONICAL_COMMITTED"
  /** Canonical taxonomy was below the commit threshold; legacy
   *  supported the same conclusion so we adopt canonical anyway. */
  | "CANONICAL_LEGACY_CONCUR"
  /** Legacy classifier produced a defensible conclusion; canonical
   *  taxonomy was UNKNOWN or below threshold and did NOT contradict. */
  | "LEGACY_FALLBACK"
  /** Neither source is defensible OR they contradict. Abstain. */
  | "ABSTAIN";

export interface EconomicPurposeDecision {
  source: PurposeAuthoritySource;
  /** Canonical concept when committed; null when abstained. */
  concept: EconomicPurposeConcept | null;
  /** Confidence in the committed conclusion (0-100). */
  confidence: number;
  /** Human-readable label. */
  label: string;
  /** Canonical classifications considered. */
  canonicalTop3: PurposeClassification[];
  /** Legacy classifier candidates for supporting context. Downstream
   *  GL ranker consumes this as `economicPurposeCandidates`. */
  legacyCandidates: PurposeCandidate[];
  /** Diagnostic showing what happened. */
  diagnostic: string;
}

// -----------------------------------------------------------------------------
// Commit thresholds
// -----------------------------------------------------------------------------

/** Canonical Slice-5 taxonomy commits the concept as authoritative
 *  when confidence ≥ this. Chosen to match Slice-5's own commit
 *  threshold and the founder's proposal (§1 amendment). */
const CANONICAL_COMMIT_THRESHOLD = 60;
/** Canonical concept is defensible support when confidence ≥ this
 *  even without full commit. Used by CANONICAL_LEGACY_CONCUR path. */
const CANONICAL_SUPPORT_THRESHOLD = 30;
/** Legacy classifier must clear this to be considered a valid
 *  fallback conclusion when canonical abstains. */
const LEGACY_FALLBACK_THRESHOLD = 40;

// -----------------------------------------------------------------------------
// Concept ↔ legacy-purpose compatibility — used to detect contradictions.
// A canonical concept is "contradicted" by a legacy candidate only
// when the legacy candidate's PURPOSE is on an OPPOSITE-family list
// (e.g. FUEL is contradicted by "recurring_communications_or_connectivity_service").
// -----------------------------------------------------------------------------

const CONTRADICTORY_LEGACY_PURPOSES: Partial<Record<EconomicPurposeConcept, ReadonlySet<string>>> = {
  FUEL: new Set(["recurring_communications_or_connectivity_service", "external_accounting_or_audit_services", "employee_professional_membership_dues", "legal_or_consulting_services"]),
  LUBRICANTS: new Set(["recurring_communications_or_connectivity_service", "external_accounting_or_audit_services", "employee_professional_membership_dues"]),
  EQUIPMENT_PARTS: new Set(["recurring_communications_or_connectivity_service", "employee_professional_membership_dues"]),
  REPAIR_MAINTENANCE: new Set(["recurring_communications_or_connectivity_service", "employee_professional_membership_dues"]),
  CAPITAL_EQUIPMENT: new Set(["recurring_communications_or_connectivity_service", "employee_professional_membership_dues"]),
  TELECOMMUNICATIONS: new Set(["employee_professional_membership_dues", "external_accounting_or_audit_services"]),
  INTERNET_CONNECTIVITY: new Set(["employee_professional_membership_dues", "external_accounting_or_audit_services"]),
  PROFESSIONAL_MEMBERSHIP: new Set(["recurring_communications_or_connectivity_service", "recurring_utility_or_facility_service"]),
  PROFESSIONAL_SERVICES: new Set(["recurring_communications_or_connectivity_service"]),
  COURSE_MAINTENANCE: new Set(["recurring_communications_or_connectivity_service", "employee_professional_membership_dues"]),
  BUILDING_MAINTENANCE: new Set(["recurring_communications_or_connectivity_service", "employee_professional_membership_dues"]),
  FOOD: new Set(["recurring_communications_or_connectivity_service"]),
  BEVERAGE: new Set(["recurring_communications_or_connectivity_service"]),
};

function legacyContradictsCanonical(canonicalConcept: EconomicPurposeConcept, legacyPurpose: string): boolean {
  return CONTRADICTORY_LEGACY_PURPOSES[canonicalConcept]?.has(legacyPurpose) === true;
}

// -----------------------------------------------------------------------------
// Concept → label helper for downstream diagnostics
// -----------------------------------------------------------------------------

const CONCEPT_LABELS: Record<EconomicPurposeConcept, string> = {
  FUEL: "Fuel / petroleum product",
  LUBRICANTS: "Lubricants / oils",
  EQUIPMENT: "Equipment",
  EQUIPMENT_PARTS: "Equipment parts / consumables",
  REPAIR_MAINTENANCE: "Repair / maintenance service",
  TELECOMMUNICATIONS: "Telecommunications service",
  INTERNET_CONNECTIVITY: "Internet / connectivity",
  SOFTWARE_SUBSCRIPTION: "Software / SaaS subscription",
  PROFESSIONAL_MEMBERSHIP: "Professional membership dues",
  PROFESSIONAL_SERVICES: "Professional / advisory services",
  FOOD: "Food purchases",
  BEVERAGE: "Beverage purchases",
  FREIGHT_DELIVERY: "Freight / delivery",
  CAPITAL_EQUIPMENT: "Capital equipment",
  BUILDING_MAINTENANCE: "Building maintenance",
  COURSE_MAINTENANCE: "Course maintenance",
  OFFICE_SUPPLIES: "Office supplies",
  INTEREST: "Interest / finance charge",
  PENALTY: "Penalty / late fee",
  OTHER: "Other",
  UNKNOWN: "Unknown",
};

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export interface EconomicPurposeAuthorityInput {
  canonicalLineItems: CanonicalLineItem[];
  supplierName: string | null;
  /** DOCUMENT-ROLE transactional text (from transactional-text.ts).
   *  Legacy classifier and canonical taxonomy both consume this
   *  rather than the raw flattened PDF so contact/policy/footer
   *  regions cannot contribute (amendment #4). */
  transactionalText: string | null;
  /** Legacy classifier's additional flags. */
  hasPenaltyLine: boolean;
  hasMembershipLine: boolean;
  hasProfessionalCredentialContext: boolean;
  /** Sprint 3 · Phase 4 Slice 5.10 (2026-08-09) — §6 authority
   *  consumption. When the upstream PurchasedObjectIdentity layer
   *  has committed a role for a line, pass it through so the
   *  taxonomy classifier can demote adjectival EQUIPMENT_PARTS /
   *  REPAIR_MAINTENANCE cues on COMPLETE_MACHINE rows. Aligned by
   *  index with `canonicalLineItems`. */
  purchasedObjectRolesByLineIndex?: Array<
    "COMPLETE_MACHINE" | "SERIALIZED_COMPONENT" | "COMPONENT"
    | "ACCESSORY" | "CONSUMABLE" | "SERVICE" | "UNKNOWN" | null
  >;
}

const CANONICAL_PROVIDER = new DeterministicTaxonomyProvider();

export function resolveEconomicPurpose(input: EconomicPurposeAuthorityInput): EconomicPurposeDecision {
  const canonicalTop3 = CANONICAL_PROVIDER.classify(input.canonicalLineItems, {
    supplierName: input.supplierName,
    // Slice 5.10 §3 authority hierarchy needs body text for
    // boilerplate-zone detection. transactionalText is preferred
    // (Slice 5.2 supplier/recipient/footer already excluded). When
    // the layout-based extractor didn't run (synthetic benchmark
    // TEXT_OVERRIDE path), the caller passes null / empty — we do
    // NOT synthesize the raw pdfText here because
    // resolveEconomicPurpose's contract already guarantees the
    // caller has scoped the text appropriately.
    fullDocumentText: input.transactionalText,
    purchasedObjectRolesByLineIndex: input.purchasedObjectRolesByLineIndex,
  });
  const canonicalTop = canonicalTop3[0] ?? null;

  const legacyInput: EconomicPurposeInput = {
    supplierName: input.supplierName,
    lineDescriptions: input.canonicalLineItems.map((li) => li.description),
    fullDocumentText: input.transactionalText,
    paymentDirection: "club_pays_vendor",
    hasPenaltyLine: input.hasPenaltyLine,
    hasMembershipLine: input.hasMembershipLine,
    hasProfessionalCredentialContext: input.hasProfessionalCredentialContext,
  };
  const legacyCandidates = classifyEconomicPurpose(legacyInput);
  const legacyTop = legacyCandidates[0] ?? null;

  // --- Path A: canonical committed --------------------------------------
  if (canonicalTop && canonicalTop.concept !== "UNKNOWN" && canonicalTop.confidence >= CANONICAL_COMMIT_THRESHOLD) {
    // Reject a canonical commit only when it explicitly conflicts
    // with an equally- or higher-scoring legacy conclusion. In
    // practice legacy rarely outscores a committed canonical.
    const legacyContradicts = legacyTop
      && legacyTop.score > canonicalTop.confidence
      && legacyContradictsCanonical(canonicalTop.concept, legacyTop.purpose);
    if (!legacyContradicts) {
      return {
        source: "CANONICAL_COMMITTED",
        concept: canonicalTop.concept,
        confidence: canonicalTop.confidence,
        label: canonicalTop.label,
        canonicalTop3,
        legacyCandidates,
        diagnostic: `canonical=${canonicalTop.concept}(${canonicalTop.confidence}) legacyTop=${legacyTop?.purpose ?? "none"}(${legacyTop?.score ?? 0})`,
      };
    }
    // Contradiction path — abstain rather than commit either side.
    return {
      source: "ABSTAIN",
      concept: null,
      confidence: 0,
      label: "Contradictory purpose evidence — review",
      canonicalTop3,
      legacyCandidates,
      diagnostic: `contradiction: canonical=${canonicalTop.concept}(${canonicalTop.confidence}) vs legacy=${legacyTop?.purpose}(${legacyTop?.score})`,
    };
  }

  // --- Path B: canonical below commit threshold but defensible +
  //             legacy concurs (or at least does not contradict) --------
  if (canonicalTop && canonicalTop.concept !== "UNKNOWN" && canonicalTop.confidence >= CANONICAL_SUPPORT_THRESHOLD) {
    const legacyContradicts = legacyTop
      && legacyTop.score >= LEGACY_FALLBACK_THRESHOLD
      && legacyContradictsCanonical(canonicalTop.concept, legacyTop.purpose);
    if (legacyContradicts) {
      return {
        source: "ABSTAIN",
        concept: null, confidence: 0, label: "Contradictory purpose evidence — review",
        canonicalTop3, legacyCandidates,
        diagnostic: `contradiction (canonical mid-conf): canonical=${canonicalTop.concept}(${canonicalTop.confidence}) vs legacy=${legacyTop?.purpose}(${legacyTop?.score})`,
      };
    }
    return {
      source: "CANONICAL_LEGACY_CONCUR",
      concept: canonicalTop.concept,
      confidence: canonicalTop.confidence,
      label: canonicalTop.label,
      canonicalTop3,
      legacyCandidates,
      diagnostic: `canonical mid-conf=${canonicalTop.concept}(${canonicalTop.confidence}); legacy did not contradict`,
    };
  }

  // --- Path C: canonical UNKNOWN or below-support; legacy defensible ---
  if (legacyTop && legacyTop.score >= LEGACY_FALLBACK_THRESHOLD) {
    return {
      source: "LEGACY_FALLBACK",
      concept: legacyPurposeToConcept(legacyTop.purpose),
      confidence: legacyTop.score,
      label: legacyTop.classificationConcept,
      canonicalTop3,
      legacyCandidates,
      diagnostic: `canonical=UNKNOWN/weak; legacy=${legacyTop.purpose}(${legacyTop.score})`,
    };
  }

  // --- Path D: neither defensible ---------------------------------------
  return {
    source: "ABSTAIN",
    concept: null,
    confidence: 0,
    label: "Purpose unresolved",
    canonicalTop3,
    legacyCandidates,
    diagnostic: `abstain: canonical=${canonicalTop?.concept ?? "none"}(${canonicalTop?.confidence ?? 0}) legacy=${legacyTop?.purpose ?? "none"}(${legacyTop?.score ?? 0})`,
  };
}

/** Best-effort mapping from a legacy PurposeCandidate.purpose string
 *  to the Slice-5 canonical concept enum. Not lossless — legacy has
 *  concepts (`member_dues_charged_by_club`) that don't exist in the
 *  canonical taxonomy; those map to OTHER. */
function legacyPurposeToConcept(legacyPurpose: string): EconomicPurposeConcept {
  switch (legacyPurpose) {
    case "employee_professional_membership_dues": return "PROFESSIONAL_MEMBERSHIP";
    case "external_accounting_or_audit_services": return "PROFESSIONAL_SERVICES";
    case "professional_education_training":       return "PROFESSIONAL_SERVICES";
    case "licences_and_certifications":           return "PROFESSIONAL_MEMBERSHIP";
    case "regulatory_fees":                       return "PROFESSIONAL_SERVICES";
    case "penalties_and_late_fees":               return "PENALTY";
    case "legal_or_consulting_services":          return "PROFESSIONAL_SERVICES";
    case "recurring_communications_or_connectivity_service": return "INTERNET_CONNECTIVITY";
    case "recurring_utility_or_facility_service": return "BUILDING_MAINTENANCE";
    case "generic_supplies_or_services":          return "OTHER";
    case "member_dues_charged_by_club":           return "OTHER";
    default: return "OTHER";
  }
}

export function economicPurposeConceptLabel(concept: EconomicPurposeConcept): string {
  return CONCEPT_LABELS[concept];
}

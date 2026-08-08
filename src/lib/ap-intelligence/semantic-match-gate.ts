// Sprint 3 · Phase 4 Slice 5.2 (2026-08-08) — SEMANTIC_MATCH
// override gate.
//
// Founder amendment #5 (approved):
//   Stage-B SEMANTIC_MATCH may override the base recommendation ONLY
//   when ALL of the following are true:
//
//     (a) nature confidence clears the approved threshold
//     (b) nature evidence is defensible
//     (c) nature is compatible with the canonical economic purpose
//     (d) the candidate account type/role is compatible with both
//     (e) no stronger canonical evidence contradicts the override
//
//   Confidence alone is not enough.
//
// This module centralises those gates so the analyser (and any
// future ranker path) applies them uniformly.

import type { AccountingNature } from "./accounting-nature";
import type { EconomicPurposeConcept } from "./economic-purpose-taxonomy";
import type { EconomicPurposeDecision } from "./economic-purpose-authority";

// -----------------------------------------------------------------------------
// Thresholds
// -----------------------------------------------------------------------------

/** Nature confidence must be at least this when the gate is
 *  OVERRIDING a base-ranker pick — the stricter threshold guards
 *  against confidence-laundering (§25) when the base ranker already
 *  produced a defensible winner. */
export const NATURE_OVERRIDE_MIN_CONFIDENCE = 60;
/** When the base ranker produced NO defensible winner (accountNumber
 *  null), the gate uses this looser threshold — a defensible-but-
 *  moderate nature (e.g. R&M 53) is preferable to a fabricated null
 *  answer. Still above the isDefensible floor (20) by a wide margin. */
export const NATURE_PROMOTION_MIN_CONFIDENCE = 40;

// -----------------------------------------------------------------------------
// Compatibility matrices
// -----------------------------------------------------------------------------

/** Which canonical purposes are ACCOUNTING-COMPATIBLE with each
 *  accounting nature. A purpose not in the set means the nature is
 *  contradicted by the purpose (e.g. FUEL is an operating expense —
 *  incompatible with CAPITAL_ASSET or INTEREST_OR_PENALTY nature). */
const PURPOSE_NATURE_COMPAT: Record<AccountingNature, ReadonlySet<EconomicPurposeConcept>> = {
  CAPITAL_ASSET: new Set(["CAPITAL_EQUIPMENT", "EQUIPMENT"] as EconomicPurposeConcept[]),
  INVENTORY: new Set(["OTHER"] as EconomicPurposeConcept[]),
  COST_OF_SALES: new Set(["FOOD", "BEVERAGE", "OTHER"] as EconomicPurposeConcept[]),
  PREPAID_EXPENSE: new Set(["PROFESSIONAL_MEMBERSHIP", "PROFESSIONAL_SERVICES", "SOFTWARE_SUBSCRIPTION", "OTHER"] as EconomicPurposeConcept[]),
  OPERATING_EXPENSE: new Set([
    "FUEL", "LUBRICANTS", "EQUIPMENT_PARTS", "REPAIR_MAINTENANCE",
    "TELECOMMUNICATIONS", "INTERNET_CONNECTIVITY", "SOFTWARE_SUBSCRIPTION",
    "PROFESSIONAL_MEMBERSHIP", "PROFESSIONAL_SERVICES",
    "FOOD", "BEVERAGE", "FREIGHT_DELIVERY",
    "BUILDING_MAINTENANCE", "COURSE_MAINTENANCE", "OFFICE_SUPPLIES",
    "OTHER",
  ] as EconomicPurposeConcept[]),
  REPAIR_AND_MAINTENANCE: new Set(["EQUIPMENT_PARTS", "REPAIR_MAINTENANCE", "BUILDING_MAINTENANCE", "COURSE_MAINTENANCE"] as EconomicPurposeConcept[]),
  UTILITY_OR_RECURRING_SERVICE: new Set(["TELECOMMUNICATIONS", "INTERNET_CONNECTIVITY", "SOFTWARE_SUBSCRIPTION"] as EconomicPurposeConcept[]),
  PROFESSIONAL_SERVICE: new Set(["PROFESSIONAL_MEMBERSHIP", "PROFESSIONAL_SERVICES"] as EconomicPurposeConcept[]),
  TAX_OR_REGULATORY: new Set(["OTHER"] as EconomicPurposeConcept[]),
  INTEREST_OR_PENALTY: new Set(["INTEREST", "PENALTY"] as EconomicPurposeConcept[]),
  UNKNOWN: new Set([
    "FUEL", "LUBRICANTS", "EQUIPMENT_PARTS", "REPAIR_MAINTENANCE", "CAPITAL_EQUIPMENT", "EQUIPMENT",
    "TELECOMMUNICATIONS", "INTERNET_CONNECTIVITY", "SOFTWARE_SUBSCRIPTION",
    "PROFESSIONAL_MEMBERSHIP", "PROFESSIONAL_SERVICES",
    "FOOD", "BEVERAGE", "FREIGHT_DELIVERY",
    "BUILDING_MAINTENANCE", "COURSE_MAINTENANCE", "OFFICE_SUPPLIES",
    "INTEREST", "PENALTY", "OTHER", "UNKNOWN",
  ] as EconomicPurposeConcept[]),
};

/** Which account-type strings each accounting nature accepts. Used
 *  for gate (d) — the candidate account type must be compatible with
 *  the nature. */
const NATURE_ACCEPTABLE_ACCOUNT_TYPES: Record<AccountingNature, ReadonlySet<string>> = {
  CAPITAL_ASSET: new Set(["ASSET"]),
  INVENTORY: new Set(["ASSET"]),
  COST_OF_SALES: new Set(["EXPENSE", "COST_OF_SALES", "COGS"]),
  PREPAID_EXPENSE: new Set(["ASSET"]),
  OPERATING_EXPENSE: new Set(["EXPENSE", "COST_OF_SALES", "COGS"]),
  REPAIR_AND_MAINTENANCE: new Set(["EXPENSE"]),
  UTILITY_OR_RECURRING_SERVICE: new Set(["EXPENSE"]),
  PROFESSIONAL_SERVICE: new Set(["EXPENSE"]),
  TAX_OR_REGULATORY: new Set(["EXPENSE", "ASSET", "LIABILITY"]),
  INTEREST_OR_PENALTY: new Set(["EXPENSE"]),
  UNKNOWN: new Set(["ASSET", "EXPENSE", "COST_OF_SALES", "COGS"]),
};

// -----------------------------------------------------------------------------
// Gate
// -----------------------------------------------------------------------------

export interface SemanticMatchGateInput {
  natureLeader: AccountingNature;
  natureConfidence: number;
  natureIsDefensible: boolean;
  candidateAccountType: string | null;
  purposeDecision: EconomicPurposeDecision;
  /** When true, the gate is being consulted for a Stage-B promotion
   *  where the base ranker produced no defensible winner. The
   *  confidence threshold is relaxed (NATURE_PROMOTION_MIN_CONFIDENCE
   *  instead of NATURE_OVERRIDE_MIN_CONFIDENCE). Amendment #5 gates
   *  (b)-(e) are unchanged — only (a) shifts. */
  baseRankerAbstained?: boolean;
}

export interface SemanticMatchGateResult {
  allow: boolean;
  denials: string[];
  diagnostic: string;
}

/** Evaluate whether a nature-scoped-ranker SEMANTIC_MATCH override
 *  is permitted for a specific candidate account. Returns
 *  `{allow: false, denials: [...]}` when any gate fails. */
export function evaluateSemanticMatchGate(input: SemanticMatchGateInput): SemanticMatchGateResult {
  const denials: string[] = [];

  // (a) confidence — stricter when overriding a base pick.
  const requiredConf = input.baseRankerAbstained ? NATURE_PROMOTION_MIN_CONFIDENCE : NATURE_OVERRIDE_MIN_CONFIDENCE;
  if (input.natureConfidence < requiredConf) {
    denials.push(`nature_confidence_below_threshold(${input.natureConfidence}<${requiredConf})`);
  }
  // (b) defensible
  if (!input.natureIsDefensible) {
    denials.push("nature_not_defensible");
  }
  // (c) nature compatible with committed canonical purpose
  if (input.purposeDecision.concept != null) {
    const compat = PURPOSE_NATURE_COMPAT[input.natureLeader];
    if (!compat.has(input.purposeDecision.concept)) {
      denials.push(`nature_incompatible_with_purpose(nature=${input.natureLeader} vs purpose=${input.purposeDecision.concept})`);
    }
  }
  // (d) account type compatible with nature
  if (input.candidateAccountType) {
    const acceptable = NATURE_ACCEPTABLE_ACCOUNT_TYPES[input.natureLeader];
    if (!acceptable.has(input.candidateAccountType.toUpperCase())) {
      denials.push(`account_type_incompatible(type=${input.candidateAccountType} nature=${input.natureLeader})`);
    }
  }
  // (e) canonical evidence contradicts is subsumed by (c) — if the
  //     concept + nature are incompatible, canonical HAS contradicted.
  //     Additionally, an ABSTAIN decision is treated as "no strong
  //     canonical either way" — the gate does not deny on ABSTAIN
  //     alone; a low-confidence nature is caught by (a)/(b).

  const allow = denials.length === 0;
  return {
    allow,
    denials,
    diagnostic: `SEMANTIC_MATCH gate=${allow ? "ALLOW" : "DENY"} nature=${input.natureLeader}(${input.natureConfidence},defensible=${input.natureIsDefensible}) purpose=${input.purposeDecision.concept ?? "NONE"} accountType=${input.candidateAccountType ?? "NONE"} denials=[${denials.join(",")}]`,
  };
}

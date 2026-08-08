// Sprint 3 · Phase 4 Slice 5.2 completion (2026-08-08) — economic-
// purpose EVIDENCE QUALITY gate.
//
// Founder amendment #4 + #5:
//   A high semantic/taxonomy score over bad source evidence cannot
//   launder that source evidence into a high-confidence accounting
//   decision. Add a purpose evidence-quality gate SEPARATE from
//   numeric confidence.
//
//   commitEligible = taxonomyConfidence ≥ 60 AND evidenceQuality != LOW
//
// LOW quality happens when:
//   - the primary line-item description is short (< 6 substantive chars)
//     AND does not itself contain a discriminative substring for the
//     committed concept (i.e. the concept was reached by contextual
//     lexicon inference rather than a direct name match on the item)
//   - the primary line-item description is a summary-shape phrase
//     ("2 Lines Total", "Line item", "Amount Due" etc.)
//
// HIGH quality happens when:
//   - the primary line-item description is ≥ 6 substantive chars AND
//     directly contains a discriminative substring for the concept
//   - OR the concept was reached via multiple corroborating strong
//     evidence citations (LineItem descriptions with substantive
//     content)
//
// This module is DIAGNOSTIC + a GATE — it never modifies the taxonomy
// output; it publishes a parallel commit-eligibility verdict.

import type { CanonicalLineItem } from "./evidence/canonical-line-item";
import type { EconomicPurposeDecision } from "./economic-purpose-authority";
import type { EconomicPurposeConcept } from "./economic-purpose-taxonomy";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type PurposeEvidenceQuality = "HIGH" | "MEDIUM" | "LOW";

export interface PurposeEvidenceQualityResult {
  quality: PurposeEvidenceQuality;
  commitEligible: boolean;
  reason: string;
  primaryItemDescription: string | null;
  primaryItemLen: number;
  hasDiscriminativeMatch: boolean;
  isSummaryShape: boolean;
  contributingLineCount: number;
  diagnostic: string;
}

// -----------------------------------------------------------------------------
// Detection helpers
// -----------------------------------------------------------------------------

/** A line description that reads like a summary / column-label leak
 *  rather than an actual purchased item. */
const SUMMARY_SHAPE_RE =
  /^(?:\d*\s*lines?(?:\s+total)?|\s*subtotal|\s*total|\s*balance(?:\s*due)?|\s*amount(?:\s*due)?|\s*credits?|\s*pending\s+payments?|\s*ongoing\s+charges?|\s*taxes?\s*(?:and|&|\/)\s*fees?|\s*line\s*item|\s*item|\s*grand\s*total|\s*payment)\s*$/i;

/** Concept → discriminative substrings for direct name-match on the
 *  primary item. Broader than the ontology's account-name substrings
 *  because we're checking whether the DOCUMENT'S OWN ITEM text
 *  contains vocabulary that DIRECTLY belongs to this concept. */
const CONCEPT_ITEM_VOCABULARY: Partial<Record<EconomicPurposeConcept, RegExp[]>> = {
  FUEL: [
    /\b(diesel|gasoline|gas\s*ls|dyed|petroleum|fuel(?:\s+oil)?|jet\s*fuel|marine\s*fuel|kerosene|propane|natural\s*gas|LNG)\b/i,
  ],
  LUBRICANTS: [
    /\b(hydraulic\s*(?:oil|fluid)|engine\s*oil|motor\s*oil|transmission\s*fluid|coolant|antifreeze|def\s*fluid|grease|gear\s*oil|lubricant)\b/i,
  ],
  EQUIPMENT: [
    /\b(mower|tractor|utility\s*vehicle|golf\s*cart|aerator|topdresser|sprayer|blower|generator|compressor|forklift)\b/i,
  ],
  EQUIPMENT_PARTS: [
    /\b(bearing|seal|spacer|belt|filter|blade|reel|bedknife|spring|bolt|nut|washer|gasket|hose|fitting|valve|switch|solenoid|sensor|spark\s*plug|tire|tyre|tube|rim|battery|alternator|starter|clutch|brake\s*pad|rotor|caliper|replacement\s*part|kit|hardware|wheel|axle|shaft|pulley|sprocket|chain|cable|wire|fuse|relay|coil|element|nozzle|piston|ring)s?\b/i,
  ],
  REPAIR_MAINTENANCE: [
    /\b(labor|labour|repair|maintenance|service\s*call|installation|install|inspection|adjust(?:ment)?|calibrat(?:e|ion)|tune[-\s]?up|overhaul|rebuild)\b/i,
  ],
  CAPITAL_EQUIPMENT: [
    /\b(mower|tractor|utility\s*vehicle|golf\s*cart|aerator|topdresser|sprayer|blower|generator|compressor|forklift|hvac\s*unit|new\s*equipment|used\s*equipment)\b/i,
  ],
  TELECOMMUNICATIONS: [
    /\b(telephone|phone\s*line|voip|long\s*distance|toll\s*free|mobile\s*(?:plan|service)|cellular|sim\s*card|calling\s*plan|voice\s*service)\b/i,
  ],
  INTERNET_CONNECTIVITY: [
    /\b(internet|broadband|fiber|fibre|dsl|wifi|wi[-\s]?fi|bandwidth|mbit\/?s|mbps|gbps|isp\s*service|ethernet\s*service)\b/i,
  ],
  SOFTWARE_SUBSCRIPTION: [
    /\b(software\s*(?:licen[cs]e|subscription)|saas|user\s*licen[cs]e|seat\s*licen[cs]e|annual\s*subscription|cloud\s*service|renewal\s*—?\s*software)\b/i,
  ],
  PROFESSIONAL_MEMBERSHIP: [
    /\b(member(?:ship)?\s*(?:dues|fee)|annual\s*dues|professional\s*dues|association\s*dues|chapter\s*dues|CPA\s*(?:Alberta|Canada|BC|Ontario))\b/i,
  ],
  PROFESSIONAL_SERVICES: [
    /\b(consulting|audit|advisory|legal\s*service|accountant|accounting\s*service|tax\s*preparation|bookkeeping)\b/i,
  ],
  FOOD: [
    /\b(produce|meat|poultry|beef|pork|chicken|seafood|fish|bakery|dairy|eggs?|vegetables?|fruit|frozen\s*food|prepared\s*food)\b/i,
  ],
  BEVERAGE: [
    /\b(beer|wine|spirits|liquor|whisky|whiskey|vodka|gin|rum|tequila|soda|juice|coffee\s*beans?|tea)\b/i,
  ],
  FREIGHT_DELIVERY: [
    /\b(freight|shipping|delivery|carriage|transport|courier)\b/i,
  ],
  BUILDING_MAINTENANCE: [
    /\b(plumbing|electrical\s*repair|hvac\s*(?:service|repair|maintenance)|painting|roofing|drywall|carpentry|flooring|janitorial|window\s*(?:cleaning|washing)|pest\s*control|snow\s*removal)\b/i,
  ],
  COURSE_MAINTENANCE: [
    /\b(fertili(?:z|s)er|seed|sod|turf|top\s*dressing|dressing\s*sand|pesticide|herbicide|fungicide|insecticide|irrigation\s*(?:parts?|repair|service)|greens\s*sand|bunker\s*sand|divot\s*mix)\b/i,
  ],
  OFFICE_SUPPLIES: [
    /\b(toner|ink\s*cartridge|paper\s*ream|envelopes?|stationery|binders?|stapl(?:e|er))\b/i,
  ],
  INTEREST: [
    /\b(interest\s*charge|finance\s*charge|interest\s*expense)\b/i,
  ],
  PENALTY: [
    /\b(penalty|late\s*fee|late\s*payment|nsf\s*fee|dishonour(?:ed)?\s*cheque|returned\s*cheque)\b/i,
  ],
};

// -----------------------------------------------------------------------------
// Assessment
// -----------------------------------------------------------------------------

const MIN_SUBSTANTIVE_LEN = 6;
const COMMIT_MIN_CONFIDENCE = 60;

/** Assess whether a purpose decision has evidence quality strong
 *  enough to authorise a full-COA GL commitment. */
export function assessPurposeEvidenceQuality(
  decision: EconomicPurposeDecision,
  canonicalLineItems: CanonicalLineItem[],
): PurposeEvidenceQualityResult {
  // Amendment #4: evidence quality is about the PRIMARY PURCHASE.
  // Surcharges and freight lines are AUXILIARY — a tire levy on a
  // large-value invoice does not tell us the primary purchase was
  // tires. Only PRIMARY_PURCHASE lines contribute to quality.
  const primaryPurchaseLines = canonicalLineItems.filter((li) => li.role === "PRIMARY_PURCHASE");
  const primary = primaryPurchaseLines[0] ?? null;
  const primaryDesc = primary?.description ?? null;
  const primaryLen = primaryDesc?.trim().length ?? 0;
  const isSummaryShape = primaryDesc ? SUMMARY_SHAPE_RE.test(primaryDesc.trim()) : false;

  const concept = decision.concept;
  const vocab = concept ? CONCEPT_ITEM_VOCABULARY[concept] ?? [] : [];
  const hasDiscriminativeMatch = concept != null
    && primaryPurchaseLines.some((li) => vocab.some((r) => r.test(li.description)));

  let quality: PurposeEvidenceQuality;
  let reason: string;

  if (concept == null || concept === "UNKNOWN") {
    quality = "LOW";
    reason = "PURPOSE_UNRESOLVED";
  } else if (isSummaryShape && !hasDiscriminativeMatch) {
    quality = "LOW";
    reason = "PRIMARY_PURCHASE_DESCRIPTION_UNRESOLVED"; // §5 example
  } else if (primaryLen < MIN_SUBSTANTIVE_LEN && !hasDiscriminativeMatch) {
    quality = "LOW";
    reason = "PRIMARY_PURCHASE_DESCRIPTION_TOO_SHORT";
  } else if (hasDiscriminativeMatch) {
    quality = "HIGH";
    reason = "DISCRIMINATIVE_MATCH_ON_LINE_ITEM";
  } else if (primaryPurchaseLines.length >= 2 && primaryLen >= MIN_SUBSTANTIVE_LEN * 2) {
    // Multiple substantive primary lines contributing to the concept
    // even without a direct vocabulary hit.
    quality = "MEDIUM";
    reason = "MULTIPLE_SUBSTANTIVE_LINES";
  } else {
    quality = "MEDIUM";
    reason = "SUBSTANTIVE_LINE_BUT_NO_DISCRIMINATIVE_MATCH";
  }

  const meetsConfidence = decision.confidence >= COMMIT_MIN_CONFIDENCE;
  const commitEligible = meetsConfidence && quality !== "LOW";

  return {
    quality,
    commitEligible,
    reason,
    primaryItemDescription: primaryDesc?.slice(0, 120) ?? null,
    primaryItemLen: primaryLen,
    hasDiscriminativeMatch,
    isSummaryShape,
    contributingLineCount: primaryPurchaseLines.length,
    diagnostic: `concept=${concept ?? "none"} taxonomyConfidence=${decision.confidence} quality=${quality} commitEligible=${commitEligible} reason=${reason} primaryLen=${primaryLen} discriminativeMatch=${hasDiscriminativeMatch} summaryShape=${isSummaryShape} primaryLines=${primaryPurchaseLines.length}`,
  };
}

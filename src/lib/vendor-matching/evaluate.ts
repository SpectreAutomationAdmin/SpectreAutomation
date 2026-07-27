// Sprint 3 · Checkpoint 15P-3 (2026-07-27) — vendor-match
// evaluator. Turns a field-by-field comparison into:
//
//   • matched / differed / notComparable field lists
//   • agreement            — matched-weight / comparable-weight  (0..1)
//   • evidenceCoverage     — matched-weight / MAX_POSSIBLE_WEIGHT (0..1)
//   • rankingScore         — 100 · agreement · sqrt(evidenceCoverage)
//   • classification       — "exact" | "strong" | "possible" | "conflicting"
//
// FORMULAS
// --------
//
//   comparableWeight       = Σ weight[f]  over fields where state = matched or differed
//   matchedWeight          = Σ weight[f]  over fields where state = matched
//   differedWeight         = Σ weight[f]  over fields where state = differed
//
//   agreement              = matchedWeight / comparableWeight
//                            (0 when comparableWeight = 0)
//
//   evidenceCoverage       = matchedWeight / MAX_POSSIBLE_WEIGHT
//
//   availableEvidenceWeight = matchedWeight − differedWeight
//                             (kept in the response so clients can
//                              display a signed "net evidence" figure)
//
//   rankingScore           = round( 100 · agreement · sqrt(evidenceCoverage) )
//
//     The sqrt on evidenceCoverage means the score reaches
//     meaningful values quickly (matching tax id + name = 65 /
//     168 ≈ 0.39 coverage → sqrt = 0.62 → rankingScore ≈ 62 when
//     agreement = 1.0). It also means a perfect agreement with only
//     one weak field matched can't dominate ranking — the coverage
//     term keeps them in check.
//
// CLASSIFICATION
// --------------
//
// Step 1. Conflicts short-circuit.
//
//   If any CONFLICT_CRITICAL field is `differed` (both sides
//   populated, values disagree) → classification = "conflicting".
//   Rationale: a tax-id or legal-name disagreement is a hard signal
//   the two records describe DIFFERENT organizations.
//
//   Else if there's ≥ 1 differed field AND agreement < 0.7 →
//   classification = "conflicting". Enough weak-field
//   disagreements pile up to look like the wrong vendor.
//
// Step 2. Positive classifications (no critical conflict AND
//         agreement ≥ 0.7).
//
//   agreement == 1.0 AND matchedWeight ≥ 65 → "exact"
//     (tax id + name, or a fuller record match)
//
//   agreement == 1.0 AND matchedWeight ≥ 40 → "strong"
//     (either tax id alone, OR name + a few supporting fields)
//
//   agreement ≥ 0.85 AND matchedWeight ≥ 40 → "strong"
//     (a materially-supported match with a minor blemish)
//
//   otherwise → "possible"
//     (name-only match, or a match with limited evidence and no
//     critical conflict)
//
// See tests/c15p3-vendor-matching.test.ts for the worked cases the
// classifier is required to match.

import { compareAllFields, type FieldComparisonResult, type MatchInputProfile } from "./compare";
import {
  CONFLICT_CRITICAL, CONFLICT_AGREEMENT_CEILING,
  EXACT_MATCHED_WEIGHT_FLOOR, STRONG_MATCHED_WEIGHT_FLOOR,
  MAX_POSSIBLE_WEIGHT,
} from "./weights";

export type MatchClassification = "exact" | "strong" | "possible" | "conflicting";

export interface VendorMatchEvaluation {
  matchedFields: string[];
  differedFields: string[];
  notComparableFields: string[];
  fieldsCompared: number;
  matchedWeight: number;
  differedWeight: number;
  comparableWeight: number;
  availableEvidenceWeight: number;   // matched - differed
  agreement: number;                 // 0..1
  evidenceCoverage: number;          // 0..1
  rankingScore: number;              // integer 0..100 — for internal sorting
  classification: MatchClassification;
  results: FieldComparisonResult[];
}

/**
 * Evaluate a persisted vendor row against the currently-extracted
 * profile. Everything downstream (API response, UI chip, sort
 * order) reads from this result.
 */
export function evaluateVendorMatch(
  extracted: MatchInputProfile,
  persisted: MatchInputProfile,
): VendorMatchEvaluation {
  const results = compareAllFields(extracted, persisted);
  const matched  = results.filter((r) => r.state === "matched");
  const differed = results.filter((r) => r.state === "differed");
  const notComp  = results.filter((r) => r.state === "notComparable");

  const matchedWeight    = matched.reduce((a, r) => a + r.weight, 0);
  const differedWeight   = differed.reduce((a, r) => a + r.weight, 0);
  const comparableWeight = matchedWeight + differedWeight;
  const availableEvidenceWeight = matchedWeight - differedWeight;

  const agreement = comparableWeight > 0 ? matchedWeight / comparableWeight : 0;
  const evidenceCoverage = matchedWeight / MAX_POSSIBLE_WEIGHT;
  const rankingScore = Math.round(100 * agreement * Math.sqrt(evidenceCoverage));

  // Classification.
  let classification: MatchClassification;
  const criticalConflict = differed.some((r) => CONFLICT_CRITICAL.has(r.key));
  if (criticalConflict) {
    classification = "conflicting";
  } else if (differed.length > 0 && agreement < CONFLICT_AGREEMENT_CEILING) {
    classification = "conflicting";
  } else if (agreement === 1 && matchedWeight >= EXACT_MATCHED_WEIGHT_FLOOR) {
    classification = "exact";
  } else if (agreement >= 0.85 && matchedWeight >= STRONG_MATCHED_WEIGHT_FLOOR) {
    classification = "strong";
  } else {
    classification = "possible";
  }

  return {
    matchedFields:       matched.map((r) => r.key),
    differedFields:      differed.map((r) => r.key),
    notComparableFields: notComp.map((r) => r.key),
    fieldsCompared:      comparableWeight > 0 ? matched.length + differed.length : 0,
    matchedWeight,
    differedWeight,
    comparableWeight,
    availableEvidenceWeight,
    agreement,
    evidenceCoverage,
    rankingScore,
    classification,
    results,
  };
}

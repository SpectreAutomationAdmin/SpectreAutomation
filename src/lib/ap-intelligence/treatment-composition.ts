// Phase 4R · Phase 7.2J-A (2026-08-13) — CanonicalAccountingTreatment.
//
// Founder rule §1-§3 of the Phase 7.2J-A directive:
//   "Multiple classifiers may contribute evidence; one normalized
//    treatment representation should be consumed downstream.
//    Do not create a fourth competing treatment authority.
//    Do not use inferred treatment as hard eligibility."
//
// This module is a PURE composition primitive. It composes the two
// existing structured accounting-treatment classifiers
// (capital-vs-operating + accounting-nature) into a SINGLE normalised
// interpretation with defensibility gradation and provenance.
//
// The composed result feeds downstream reasoning in two safe ways:
//   (A) candidate admission widening — a defensible ASSET-side
//       treatment (CAPITAL_ASSET / INVENTORY / PREPAID_EXPENSE) can
//       open the Phase-2 eligibility gate at analyse.ts.
//       (Phase 7.2I-b already implements this for CAPITAL_ASSET.
//        Phase 7.2J-A extends to INVENTORY / PREPAID_EXPENSE /
//        REPAIR_AND_MAINTENANCE.)
//   (B) canonical role compatibility / contradiction — the composed
//       nature+defensibility flows into `NormalisedTransactionInterpretation`
//       so the ranker's existing bounded `NATURE_INCOMPATIBLE_PENALTY`
//       fires naturally on operating-treatment ASSET candidates
//       (and vice versa) when defensibility is STRONG.
//
// NO new canonical weights are introduced. NO hard filtering of
// technically-postable ASSET/EXPENSE accounts is applied on inferred
// treatment (founder §2). The composition is DEFEASIBLE — weak
// treatment verdicts (e.g. base-state OPERATING from capital classifier
// with no positive signals) do NOT trigger the same downstream
// contradictions as strong verdicts.

import type { CapitalVsOperatingState } from "./types";
import type { AccountingNature, AccountingNatureAssessment } from "./accounting-nature";
import type { ExpectedDebitRole } from "@/lib/accounting/eligibility";

/** Coarse financial-statement classification for the composed
 *  treatment. Distinct from `ExpectedDebitRole` (which drives
 *  admission for the eligibility gate). `statementRole` is the
 *  reasoning artefact — "where does this transaction belong on the
 *  financial statements?" — that downstream role-contradiction
 *  logic reads. */
export type StatementRole =
  | "BALANCE_SHEET_CAPITAL_ASSET"
  | "BALANCE_SHEET_CURRENT_ASSET"
  | "OPERATING_EXPENSE"
  | "COST_OF_SALES"
  | "UNKNOWN";

/** Defensibility of the composed treatment verdict.
 *
 *  STRONG: at least one classifier committed with defensible positive
 *    evidence (capital classifier returned CAPITAL/OPERATING via a
 *    keyword hit rather than base-state fallback; OR accounting-nature
 *    classifier's `isDefensible === true`).
 *  WEAK: the verdict comes from base-state fallback only — e.g.
 *    capital=OPERATING because "no keywords + below threshold" (base
 *    state per capital-vs-operating.ts:161-169). Do NOT propagate
 *    role-contradictions as if a defensible operating verdict was
 *    reached. Founder §5.
 *  UNRESOLVED: capital is AMBIGUOUS AND nature is not defensible.
 *    No treatment can be reasoned about. Review is appropriate. */
export type TreatmentDefensibility = "STRONG" | "WEAK" | "UNRESOLVED";

export interface TreatmentProvenance {
  capitalVerdict: CapitalVsOperatingState;
  natureLeader: AccountingNature;
  natureIsDefensible: boolean;
  /** Which composition path produced the final verdict — engineering
   *  diagnostics only. */
  winningSource:
    | "capital_classifier_strong"
    | "capital_classifier_weak_operating"
    | "nature_defensible"
    | "capital_ambiguous_default"
    | "default_unknown";
}

export interface CanonicalAccountingTreatment {
  /** Consumed by Phase-2 eligibility (`ruleNatureAssetExcluded`) to
   *  widen the candidate universe. Never used as a hard exclusion of
   *  otherwise-postable accounts on the opposite side. */
  expectedDebitRole: ExpectedDebitRole;

  /** Coarse financial-statement classification for the composed
   *  treatment. Consumed by canonical role-contradiction reasoning. */
  statementRole: StatementRole;

  /** Strength of the composed treatment verdict. */
  defensibility: TreatmentDefensibility;

  /** Full provenance so downstream can inspect which classifiers
   *  contributed and which branch was taken. */
  provenance: TreatmentProvenance;

  /** Structured disagreement — surfaces cases where classifiers
   *  point in materially different directions. Not a penalty; the
   *  composition preserves both signals for review-appropriate
   *  downstream behaviour. Founder §9. */
  contradictions: ReadonlyArray<string>;

  /** Composed `natureLeader` for downstream canonical scoring.
   *  When STRONG: this may reflect a compositional derivation (e.g.
   *  capital classifier says CAPITAL → natureLeader=CAPITAL_ASSET).
   *  When WEAK/UNRESOLVED: prefer the raw nature classifier verdict. */
  composedNatureLeader: AccountingNature;
  composedNatureIsDefensible: boolean;
}

/** Detect strong-positive capital verdict — the classifier reached
 *  CAPITAL via `overThreshold && capitalKeyword` OR OPERATING via
 *  `operatingKeyword && !capitalKeyword`. NOT reachable via base-state
 *  fallback. Reads the supporting evidence to distinguish. */
function isCapitalVerdictStrong(
  state: CapitalVsOperatingState,
  supportingEvidence: ReadonlyArray<string>,
): boolean {
  if (state === "CAPITAL" || state === "OPERATING") {
    // Base-state OPERATING has ONLY the two "below threshold + no
    // keywords" evidence lines. Strong OPERATING carries a positive
    // "Operating-suggesting keyword: X" line.
    if (state === "OPERATING") {
      return supportingEvidence.some((e) => /Operating-suggesting keyword/i.test(e));
    }
    // CAPITAL requires both overThreshold AND capital keyword —
    // always a positive evidence path.
    return true;
  }
  return false;
}

export interface ComposeTreatmentInput {
  capitalState: CapitalVsOperatingState;
  capitalSupportingEvidence: ReadonlyArray<string>;
  nature: AccountingNatureAssessment;
}

/** Compose the two treatment classifiers into a single normalised
 *  interpretation. Pure function — no side effects, no logging.
 *  Every branch is testable in isolation. */
export function composeAccountingTreatment(
  input: ComposeTreatmentInput,
): CanonicalAccountingTreatment {
  const { capitalState, capitalSupportingEvidence, nature } = input;
  const capitalStrong = isCapitalVerdictStrong(capitalState, capitalSupportingEvidence);
  const contradictions: string[] = [];

  // Detect structured disagreement — capital verdict points one way,
  // defensible nature points another. Founder §9: represent conflicts
  // explicitly, do not silently resolve.
  if (capitalState === "CAPITAL" && nature.isDefensible
    && (nature.leader === "INVENTORY"
        || nature.leader === "PREPAID_EXPENSE"
        || nature.leader === "COST_OF_SALES"
        || nature.leader === "OPERATING_EXPENSE"
        || nature.leader === "REPAIR_AND_MAINTENANCE")) {
    contradictions.push(
      `capital=CAPITAL but accounting-nature=${nature.leader} (defensible)`,
    );
  }
  if (capitalState === "OPERATING" && capitalStrong && nature.isDefensible
    && (nature.leader === "CAPITAL_ASSET"
        || nature.leader === "INVENTORY"
        || nature.leader === "PREPAID_EXPENSE")) {
    contradictions.push(
      `capital=OPERATING (strong) but accounting-nature=${nature.leader} (defensible)`,
    );
  }

  // ----- Priority-ordered composition -----------------------------

  // 1. CAPITAL classifier verdict is authoritative on capital-vs-
  //    operating question when its evidence is positive.
  if (capitalState === "CAPITAL") {
    return {
      expectedDebitRole: "CAPITAL_ASSET",
      statementRole: "BALANCE_SHEET_CAPITAL_ASSET",
      defensibility: "STRONG",
      composedNatureLeader: "CAPITAL_ASSET",
      composedNatureIsDefensible: true,
      provenance: {
        capitalVerdict: capitalState,
        natureLeader: nature.leader,
        natureIsDefensible: nature.isDefensible,
        winningSource: "capital_classifier_strong",
      },
      contradictions,
    };
  }

  // 2-6. Defensible nature verdicts (positive-evidence paths).
  if (nature.isDefensible) {
    switch (nature.leader) {
      case "CAPITAL_ASSET":
        // Phase 7.2I-b: nature-composed capital admission.
        return {
          expectedDebitRole: "CAPITAL_ASSET",
          statementRole: "BALANCE_SHEET_CAPITAL_ASSET",
          defensibility: "STRONG",
          composedNatureLeader: "CAPITAL_ASSET",
          composedNatureIsDefensible: true,
          provenance: {
            capitalVerdict: capitalState,
            natureLeader: nature.leader,
            natureIsDefensible: true,
            winningSource: "nature_defensible",
          },
          contradictions,
        };
      case "INVENTORY":
        return {
          expectedDebitRole: "INVENTORY",
          statementRole: "BALANCE_SHEET_CURRENT_ASSET",
          defensibility: "STRONG",
          composedNatureLeader: "INVENTORY",
          composedNatureIsDefensible: true,
          provenance: {
            capitalVerdict: capitalState,
            natureLeader: nature.leader,
            natureIsDefensible: true,
            winningSource: "nature_defensible",
          },
          contradictions,
        };
      case "PREPAID_EXPENSE":
        return {
          expectedDebitRole: "PREPAID_EXPENSE",
          statementRole: "BALANCE_SHEET_CURRENT_ASSET",
          defensibility: "STRONG",
          composedNatureLeader: "PREPAID_EXPENSE",
          composedNatureIsDefensible: true,
          provenance: {
            capitalVerdict: capitalState,
            natureLeader: nature.leader,
            natureIsDefensible: true,
            winningSource: "nature_defensible",
          },
          contradictions,
        };
      case "REPAIR_AND_MAINTENANCE":
        return {
          expectedDebitRole: "REPAIR_AND_MAINTENANCE",
          statementRole: "OPERATING_EXPENSE",
          defensibility: "STRONG",
          composedNatureLeader: "REPAIR_AND_MAINTENANCE",
          composedNatureIsDefensible: true,
          provenance: {
            capitalVerdict: capitalState,
            natureLeader: nature.leader,
            natureIsDefensible: true,
            winningSource: "nature_defensible",
          },
          contradictions,
        };
      case "COST_OF_SALES":
        // COGS maps to OPERATING_EXPENSE for eligibility admission
        // (COGS accounts are EXPENSE-type in most COAs) but the
        // statementRole records the COGS distinction.
        return {
          expectedDebitRole: "OPERATING_EXPENSE",
          statementRole: "COST_OF_SALES",
          defensibility: "STRONG",
          composedNatureLeader: "COST_OF_SALES",
          composedNatureIsDefensible: true,
          provenance: {
            capitalVerdict: capitalState,
            natureLeader: nature.leader,
            natureIsDefensible: true,
            winningSource: "nature_defensible",
          },
          contradictions,
        };
      case "OPERATING_EXPENSE":
      case "PROFESSIONAL_SERVICE":
      case "UTILITY_OR_RECURRING_SERVICE":
      case "TAX_OR_REGULATORY":
      case "INTEREST_OR_PENALTY":
        return {
          expectedDebitRole: "OPERATING_EXPENSE",
          statementRole: "OPERATING_EXPENSE",
          defensibility: "STRONG",
          composedNatureLeader: nature.leader,
          composedNatureIsDefensible: true,
          provenance: {
            capitalVerdict: capitalState,
            natureLeader: nature.leader,
            natureIsDefensible: true,
            winningSource: "nature_defensible",
          },
          contradictions,
        };
      case "UNKNOWN":
        // Fall through to capital-based branches.
        break;
    }
  }

  // 7. Strong OPERATING verdict from capital classifier (positive
  //    operating keyword hit — not base state).
  if (capitalState === "OPERATING" && capitalStrong) {
    return {
      expectedDebitRole: "OPERATING_EXPENSE",
      statementRole: "OPERATING_EXPENSE",
      defensibility: "STRONG",
      composedNatureLeader: "OPERATING_EXPENSE",
      composedNatureIsDefensible: true,
      provenance: {
        capitalVerdict: capitalState,
        natureLeader: nature.leader,
        natureIsDefensible: nature.isDefensible,
        winningSource: "capital_classifier_strong",
      },
      contradictions,
    };
  }

  // 8. Weak OPERATING (base state — no keywords, below threshold).
  //    Do NOT propagate as if defensible. Founder §5.
  if (capitalState === "OPERATING") {
    return {
      expectedDebitRole: "OPERATING_EXPENSE",
      statementRole: "OPERATING_EXPENSE",
      defensibility: "WEAK",
      composedNatureLeader: nature.leader,
      composedNatureIsDefensible: nature.isDefensible,
      provenance: {
        capitalVerdict: capitalState,
        natureLeader: nature.leader,
        natureIsDefensible: nature.isDefensible,
        winningSource: "capital_classifier_weak_operating",
      },
      contradictions,
    };
  }

  // 9. AMBIGUOUS or INSUFFICIENT_EVIDENCE — no defensible treatment.
  return {
    expectedDebitRole: "UNKNOWN",
    statementRole: "UNKNOWN",
    defensibility: "UNRESOLVED",
    composedNatureLeader: nature.leader,
    composedNatureIsDefensible: nature.isDefensible,
    provenance: {
      capitalVerdict: capitalState,
      natureLeader: nature.leader,
      natureIsDefensible: nature.isDefensible,
      winningSource: capitalState === "AMBIGUOUS" ? "capital_ambiguous_default" : "default_unknown",
    },
    contradictions,
  };
}

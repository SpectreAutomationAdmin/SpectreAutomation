// Phase 4R · single-GL-authority refactor · Phase 3.6 (Group E) —
// recommendation-quality policy, separated from ranking authority.
//
// FOUNDER §7 · ARCHITECTURAL SEPARATION:
//   Classification: "What is the strongest GL interpretation of this
//     transaction?" — answered ONLY by the canonical ranker.
//   Automation policy: "Is Spectre sufficiently confident in the
//     upstream transaction interpretation to recommend acting on the
//     canonical answer?" — answered here.
//
// This module contains NO account-selection logic. It reads:
//   - canonical ranker result status
//   - field-quality gate result (upstream extraction quality)
// and returns a RecommendationDecision that consumers project onto
// the compat GlRecommendation.projected `accountNumber` / `requiresReview`
// / `autoApprovalEligible` fields.
//
// §6 explicitly forbidden: "if account name looks like X, allow it" /
// "if candidate Y is present, replace/suppress it". This module never
// touches candidates.

export type RecommendationStatus =
  | "RECOMMEND"
  | "ABSTAIN_QUALITY"          // upstream extraction insufficient for automated recommendation
  | "ABSTAIN_AMBIGUITY"        // canonical result present but ambiguous (Phase 4 will use)
  | "ABSTAIN_NO_CANDIDATES"    // no structurally valid GL candidate exists
  | "ABSTAIN_ANALYSIS_FAILURE"; // technical/intelligence processing failure

export type AbstentionCategory =
  | "QUALITY"
  | "AMBIGUITY"
  | "NO_CANDIDATES"
  | "ANALYSIS_FAILURE";

export interface RecommendationDecision {
  status: RecommendationStatus;
  abstentionCategory: AbstentionCategory | null;
  abstentionReasons: string[];
  reason: string;
  /** For diagnostics: the canonical winner accountNumber even when
   *  status is an ABSTAIN. Preserves winner provenance (§4). */
  canonicalWinnerAccountNumber: string | null;
  /** Safety invariant (§11): ABSTAIN → must never flow automatically
   *  into posting as if it were RECOMMEND. */
  autoApprovalEligible: boolean;
  requiresReview: boolean;
}

export interface RecommendationPolicyInput {
  /** The canonical ranker's own status. */
  canonicalStatus: "RECOMMEND" | "ABSTAIN" | "NO_ELIGIBLE_CANDIDATES" | "ANALYSIS_FAILURE";
  /** The winner accountNumber if canonical has any candidates. */
  canonicalWinnerAccountNumber: string | null;
  /** Reason string from canonical if it abstained. */
  canonicalAbstentionReason: string | null;
  /** Upstream field-quality gate verdict. */
  fieldQualityEligible: boolean;
  /** Upstream field-quality gate diagnostic reasons. */
  fieldQualityAbstentionReasons: readonly string[];
}

/**
 * Evaluate whether Spectre's canonical winner may be presented as a
 * recommendation, or whether the transaction requires review.
 *
 * Never mutates candidates. Never selects an account. Never reorders.
 * Reads only status + policy inputs.
 *
 * §5 distinguishes multiple abstention reasons:
 *   - QUALITY: weak transaction interpretation (extraction insufficient)
 *   - AMBIGUITY: legitimate accounting competition (canonical returned ABSTAIN)
 *   - NO_CANDIDATES: no structurally valid GL candidate
 *   - ANALYSIS_FAILURE: technical failure
 */
export function evaluateRecommendationPolicy(
  input: RecommendationPolicyInput,
): RecommendationDecision {
  // NO_ELIGIBLE_CANDIDATES / ANALYSIS_FAILURE take precedence — those
  // are structural signals from the ranker.
  if (input.canonicalStatus === "NO_ELIGIBLE_CANDIDATES") {
    return {
      status: "ABSTAIN_NO_CANDIDATES",
      abstentionCategory: "NO_CANDIDATES",
      abstentionReasons: [input.canonicalAbstentionReason ?? "no_eligible_candidates"],
      reason: input.canonicalAbstentionReason ?? "No structurally valid GL candidate exists for this transaction.",
      canonicalWinnerAccountNumber: null,
      autoApprovalEligible: false,
      requiresReview: true,
    };
  }
  if (input.canonicalStatus === "ANALYSIS_FAILURE") {
    return {
      status: "ABSTAIN_ANALYSIS_FAILURE",
      abstentionCategory: "ANALYSIS_FAILURE",
      abstentionReasons: [input.canonicalAbstentionReason ?? "analysis_failure"],
      reason: input.canonicalAbstentionReason ?? "Canonical ranking could not be completed.",
      canonicalWinnerAccountNumber: null,
      autoApprovalEligible: false,
      requiresReview: true,
    };
  }

  // Field-quality gate — the Group E migration. Even when canonical
  // returned RECOMMEND, if upstream extraction is too weak, Spectre
  // abstains from AUTOMATED recommendation. Canonical winner
  // provenance is preserved (§4).
  if (!input.fieldQualityEligible) {
    return {
      status: "ABSTAIN_QUALITY",
      abstentionCategory: "QUALITY",
      abstentionReasons: [...input.fieldQualityAbstentionReasons],
      reason: `abstained_field_quality:${input.fieldQualityAbstentionReasons.join(",")}`,
      canonicalWinnerAccountNumber: input.canonicalWinnerAccountNumber,
      autoApprovalEligible: false,
      requiresReview: true,
    };
  }

  // Canonical ABSTAIN — genuine accounting ambiguity or below-commit-
  // floor score. Winner provenance preserved for diagnostics.
  if (input.canonicalStatus === "ABSTAIN") {
    return {
      status: "ABSTAIN_AMBIGUITY",
      abstentionCategory: "AMBIGUITY",
      abstentionReasons: [input.canonicalAbstentionReason ?? "canonical_ambiguity"],
      reason: input.canonicalAbstentionReason ?? "Canonical ranker did not commit to a winner.",
      canonicalWinnerAccountNumber: input.canonicalWinnerAccountNumber,
      autoApprovalEligible: false,
      requiresReview: true,
    };
  }

  // All gates cleared — RECOMMEND.
  return {
    status: "RECOMMEND",
    abstentionCategory: null,
    abstentionReasons: [],
    reason: "recommendation_policy_ok:canonical_recommend+field_quality_eligible",
    canonicalWinnerAccountNumber: input.canonicalWinnerAccountNumber,
    // §11 safety invariant: RECOMMEND is a NECESSARY condition for
    // automated posting; other integration-layer gates (approvals,
    // duplicates, etc.) remain independent authorities.
    autoApprovalEligible: true,
    requiresReview: false,
  };
}

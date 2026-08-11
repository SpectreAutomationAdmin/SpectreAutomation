// Phase 4R · Phase 4 (2026-08-11) — canonical confidence assessment.
//
// FOUNDER §13-§17 · SEMANTIC CONFIDENCE, NOT SCORE MAPPING:
//   HIGH: transaction interpretation is good, winner has strong
//     independent DECISION evidence, no genuine competitor is close
//     enough to materially challenge.
//   MODERATE: credible leading interpretation but a genuine
//     alternative exists AND/OR evidence separation is limited
//     AND/OR meaningful interpretation uncertainty remains.
//   LOW: evidence is weak/conflicted enough that the system should
//     not present the recommendation as dependable.
//   REVIEW_REQUIRED: policy or extraction quality forbids automated
//     recommendation (mapped from RecommendationDecision).
//
// FOUNDER §11 SEPARATION: confidence labels are explanation /
//   decision-support signals, NOT permission to post.
//   `autoApprovalEligible` remains a separate contract governed by
//   `RecommendationDecision`. HIGH confidence does NOT imply
//   autoApprovalEligible=true — a HIGH confidence classification on
//   an ABSTAIN_QUALITY transaction still cannot auto-post.
//
// FOUNDER §15 SINGLE-CANONICAL-SET: genuine competitors are derived
//   from the SAME canonical competition that produced the winner.
//   No parallel alternate pool is constructed anywhere in this
//   module. Consumers receive the qualified competitor set directly.

import type {
  CanonicalRankerResult,
  CanonicalCandidate,
  CanonicalEvidence,
} from "./canonical-ranker";
import type { RecommendationDecision } from "./recommendation-policy";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type ConfidenceLevel = "HIGH" | "MODERATE" | "LOW" | "REVIEW_REQUIRED";

/**
 * Founder-facing genuine competitor. Distinct-identity, DECISION-quality
 * alternate that would materially challenge the winner. Non-competitors
 * (weak semantic accidents, adjacent-taxonomy near-ties without
 * substantive evidence) do NOT appear here.
 */
export interface CanonicalGenuineCompetitor {
  accountId: string;
  accountNumber: string;
  accountName: string;
  score: number;
  /** margin FROM this competitor to the winner (winner.score − this.score) */
  marginToWinner: number;
  /** Reason this candidate qualified as a genuine competitor. */
  qualificationReason: string;
}

/**
 * Canonical confidence assessment — first-class policy output derived
 * from the canonical competition + recommendation decision. Consumers
 * (Mission Control, founder popover, allocation projection) render
 * this directly rather than reconstructing confidence heuristics
 * independently (§16 contract).
 */
export interface CanonicalConfidenceAssessment {
  level: ConfidenceLevel;
  /** Winner identity + score, mirrored for convenience. */
  winnerAccountId: string | null;
  winnerAccountNumber: string | null;
  winnerScore: number | null;
  /** Number of DECISION-role evidence observations on the winner. */
  winnerDecisionEvidenceCount: number;
  /** Distinct evidence families that contributed DECISION evidence. */
  winnerDecisionFamilyCount: number;
  /** Contradiction reasons applying to the winner (may be empty). */
  winnerContradictions: string[];
  /** Distinct-identity + DECISION-quality alternates only. */
  genuineCompetitors: CanonicalGenuineCompetitor[];
  /** Margin winner → strongest competitor. null when no competitors. */
  marginToStrongestCompetitor: number | null;
  /** True when ordering (accountNumber tiebreak) determined candidates[0]. */
  isDeterministicTieBreak: boolean;
  /** Recommendation-policy status (mirrored). */
  recommendationStatus: RecommendationDecision["status"];
  /** Diagnostic reason codes accumulated from the derivation. */
  reasonCodes: string[];
  /** Human-readable one-liner for the founder-facing popover. */
  humanReadableReason: string;
}

// ---------------------------------------------------------------------------
// §6-§7 · Genuine competitor qualification
// ---------------------------------------------------------------------------

/**
 * Empirical genuine-competitor rule (derived from ranker weights +
 * COMMIT_MIN_SCORE=30, see docs/phase-4-evidence-integrity.md):
 *
 * A candidate qualifies as a founder-facing competitor when ALL:
 *   1. Distinct identity from winner (accountId AND accountNumber)
 *   2. score >= COMMIT_MIN_SCORE (30) — the "canonical winner floor"
 *      itself is the qualification threshold. A candidate below the
 *      commit floor could never have been a canonical winner in its
 *      own right, so it cannot represent a genuine accounting
 *      alternative.
 *   3. score >= 60% of winner.score — a candidate more than 40%
 *      behind is not close enough to materially challenge. 60% is
 *      derived from the observation that under family caps
 *      (TRANSACTION_TEXT 40, TAXONOMY_ALIGNMENT 30, CAPITAL_NATURE 25),
 *      a candidate at <60% of winner's score is short at least one
 *      full evidence family. That IS a material accounting difference.
 *   4. At least one DECISION-role evidence observation. Winner
 *      that has only DIAGNOSTIC evidence (semantic accident) is a
 *      non-competitor by construction.
 *   5. Overall contradiction penalty (SUM of contradictions) does not
 *      dominate the candidate — otherwise the ranker itself would
 *      consider the account economically implausible.
 */
export function qualifyGenuineCompetitors(
  candidates: ReadonlyArray<CanonicalCandidate>,
  winner: CanonicalCandidate,
): CanonicalGenuineCompetitor[] {
  const COMMIT_MIN_SCORE = 30;
  const RELATIVE_MIN_RATIO = 0.6;

  const winnerScore = winner.score;
  if (winnerScore <= 0) return [];

  const out: CanonicalGenuineCompetitor[] = [];
  for (const c of candidates) {
    // 1. Distinct identity (both id AND number, per §7 identity invariant).
    if (c.accountId === winner.accountId) continue;
    if (c.accountNumber === winner.accountNumber) continue;

    // 2. Above the canonical winner floor.
    if (c.score < COMMIT_MIN_SCORE) continue;

    // 3. Within 60% of winner score.
    if (c.score < winnerScore * RELATIVE_MIN_RATIO) continue;

    // 4. Has at least one DECISION evidence observation.
    const hasDecisionEvidence = c.evidence.some((e) => e.role === "DECISION" && e.contribution > 0);
    if (!hasDecisionEvidence) continue;

    // 5. Overall contradiction penalty does not dominate. Penalty is
    //    positive-valued in the contradictions record; a candidate is
    //    dominated when its penalty sum exceeds its own score.
    const contradictionSum = c.contradictions.reduce((s, k) => s + Math.abs(k.penalty), 0);
    if (contradictionSum >= c.score) continue;

    out.push({
      accountId: c.accountId,
      accountNumber: c.accountNumber,
      accountName: c.accountName,
      score: c.score,
      marginToWinner: winnerScore - c.score,
      qualificationReason:
        `distinct identity + score ${c.score} >= 60% of winner ${winnerScore} + DECISION evidence present + contradictions ${contradictionSum} < score`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// §13 · Confidence-level derivation
// ---------------------------------------------------------------------------

/**
 * Derive the confidence level from the canonical competition + the
 * recommendation decision.
 *
 * Precedence (semantic, not numeric):
 *   1. If RecommendationDecision says any ABSTAIN_* status →
 *      REVIEW_REQUIRED (§14 — never manufacture confidence over an
 *      abstention).
 *   2. If the winner has no DECISION evidence at all → LOW.
 *      A winner supported only by DIAGNOSTIC observations is not
 *      dependable regardless of raw score.
 *   3. If a genuine competitor exists → MODERATE.
 *      The founder-facing message is "credible leader but a real
 *      alternative competes."
 *   4. If the winner is a deterministic tie-break with tied
 *      competitor > 0 → MODERATE (§9 — ties never become HIGH just
 *      from stable ordering).
 *   5. If the winner has multiple independent DECISION families
 *      (>=2) AND no contradictions → HIGH.
 *   6. Otherwise → MODERATE (single-family support is credible but
 *      not HIGH-confidence).
 */
function deriveConfidenceLevel(input: {
  recommendationStatus: RecommendationDecision["status"];
  winnerDecisionEvidenceCount: number;
  winnerDecisionFamilyCount: number;
  winnerContradictionCount: number;
  genuineCompetitorCount: number;
  isDeterministicTieBreak: boolean;
  tiedRunnerUpCount: number;
}): { level: ConfidenceLevel; reasonCodes: string[] } {
  const reasonCodes: string[] = [];

  if (input.recommendationStatus !== "RECOMMEND") {
    reasonCodes.push(`policy_${input.recommendationStatus.toLowerCase()}`);
    return { level: "REVIEW_REQUIRED", reasonCodes };
  }
  if (input.winnerDecisionEvidenceCount === 0) {
    reasonCodes.push("winner_has_no_decision_evidence");
    return { level: "LOW", reasonCodes };
  }
  if (input.genuineCompetitorCount > 0) {
    reasonCodes.push(`genuine_competitors:${input.genuineCompetitorCount}`);
    return { level: "MODERATE", reasonCodes };
  }
  if (input.isDeterministicTieBreak && input.tiedRunnerUpCount > 0) {
    reasonCodes.push(`deterministic_tie:${input.tiedRunnerUpCount}`);
    return { level: "MODERATE", reasonCodes };
  }
  if (input.winnerDecisionFamilyCount >= 2 && input.winnerContradictionCount === 0) {
    reasonCodes.push(`independent_decision_families:${input.winnerDecisionFamilyCount}`);
    reasonCodes.push("no_winner_contradictions");
    return { level: "HIGH", reasonCodes };
  }
  reasonCodes.push(`single_family_support_or_contradictions:${input.winnerDecisionFamilyCount}`);
  if (input.winnerContradictionCount > 0) reasonCodes.push(`winner_contradictions:${input.winnerContradictionCount}`);
  return { level: "MODERATE", reasonCodes };
}

// ---------------------------------------------------------------------------
// §16 · Public entry point
// ---------------------------------------------------------------------------

export function assessCanonicalConfidence(input: {
  canonical: CanonicalRankerResult;
  recommendation: RecommendationDecision;
}): CanonicalConfidenceAssessment {
  const { canonical, recommendation } = input;

  // Structural cases — no winner in the canonical result.
  if (canonical.status === "NO_ELIGIBLE_CANDIDATES" || canonical.status === "ANALYSIS_FAILURE") {
    return {
      level: "REVIEW_REQUIRED",
      winnerAccountId: null,
      winnerAccountNumber: null,
      winnerScore: null,
      winnerDecisionEvidenceCount: 0,
      winnerDecisionFamilyCount: 0,
      winnerContradictions: [],
      genuineCompetitors: [],
      marginToStrongestCompetitor: null,
      isDeterministicTieBreak: false,
      recommendationStatus: recommendation.status,
      reasonCodes: [`canonical_${canonical.status.toLowerCase()}`],
      humanReadableReason: canonical.abstentionReason,
    };
  }

  // RECOMMEND or ABSTAIN — both have candidates[] + separation.
  const winner = canonical.candidates[0];
  const winnerDecisionEvidence = winner.evidence.filter((e: CanonicalEvidence) => e.role === "DECISION" && e.contribution > 0);
  const winnerDecisionFamilyCount = new Set(winnerDecisionEvidence.map((e) => e.family)).size;
  const genuineCompetitors = qualifyGenuineCompetitors(canonical.candidates.slice(1), winner);
  const marginToStrongest = genuineCompetitors.length > 0 ? genuineCompetitors[0].marginToWinner : null;
  const separation = canonical.separation;

  const { level, reasonCodes } = deriveConfidenceLevel({
    recommendationStatus: recommendation.status,
    winnerDecisionEvidenceCount: winnerDecisionEvidence.length,
    winnerDecisionFamilyCount,
    winnerContradictionCount: winner.contradictions.length,
    genuineCompetitorCount: genuineCompetitors.length,
    isDeterministicTieBreak: separation.isDeterministicTieBreak,
    tiedRunnerUpCount: separation.tiedRunnerUpCount,
  });

  return {
    level,
    winnerAccountId: winner.accountId,
    winnerAccountNumber: winner.accountNumber,
    winnerScore: winner.score,
    winnerDecisionEvidenceCount: winnerDecisionEvidence.length,
    winnerDecisionFamilyCount,
    winnerContradictions: winner.contradictions.map((c) => c.code),
    genuineCompetitors,
    marginToStrongestCompetitor: marginToStrongest,
    isDeterministicTieBreak: separation.isDeterministicTieBreak,
    recommendationStatus: recommendation.status,
    reasonCodes,
    humanReadableReason: humanize(level, {
      winnerAccountNumber: winner.accountNumber,
      winnerScore: winner.score,
      genuineCompetitors,
      isDeterministicTieBreak: separation.isDeterministicTieBreak,
      recommendationStatus: recommendation.status,
    }),
  };
}

function humanize(level: ConfidenceLevel, ctx: {
  winnerAccountNumber: string;
  winnerScore: number;
  genuineCompetitors: CanonicalGenuineCompetitor[];
  isDeterministicTieBreak: boolean;
  recommendationStatus: RecommendationDecision["status"];
}): string {
  if (level === "REVIEW_REQUIRED") {
    return `Review required (${ctx.recommendationStatus}).`;
  }
  if (level === "LOW") {
    return `Low confidence — winner ${ctx.winnerAccountNumber} lacks decision-quality evidence.`;
  }
  if (level === "MODERATE" && ctx.genuineCompetitors.length > 0) {
    const top = ctx.genuineCompetitors[0];
    return `Moderate confidence — winner ${ctx.winnerAccountNumber} (score ${ctx.winnerScore}) has a genuine competitor: ${top.accountNumber} (score ${top.score}, margin ${top.marginToWinner}).`;
  }
  if (level === "MODERATE" && ctx.isDeterministicTieBreak) {
    return `Moderate confidence — winner ${ctx.winnerAccountNumber} was selected by deterministic tie-break.`;
  }
  if (level === "MODERATE") {
    return `Moderate confidence — winner ${ctx.winnerAccountNumber} has credible but single-family support.`;
  }
  return `High confidence — winner ${ctx.winnerAccountNumber} (score ${ctx.winnerScore}) has multiple independent decision-evidence families and no genuine competitor.`;
}

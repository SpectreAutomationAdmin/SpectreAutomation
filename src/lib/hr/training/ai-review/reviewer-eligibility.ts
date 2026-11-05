// EP-TRAIN-6D-4P (2026-11-05) — server-derived reviewer eligibility.
//
// The client NEVER computes approvability. This module is the single
// source of truth the `/app/admin/ai-training/review/persisted` page
// consults when it decides which UI controls to render. The real
// authority still lives in `approveTrainingQuestionCandidate`
// (approval-service.ts) — this file produces a conservative,
// presentation-safe gate so the UI can show an informative refusal
// WITHOUT round-tripping to the server for every candidate.
//
// Rule of composition: if `eligible === true`, the UI MAY open the
// approval dialog. The POST route still re-checks every 4B/4N gate;
// a UI eligible === true that disagrees with the server is a bug but
// NOT a privilege escalation (the route refuses with 4N codes).
//
// This file does NOT make any mutation. It reads the already-resolved
// detail + verified-answer + evidence shapes and reports the reasons.

import type { Principal } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac";
import type { CandidateDetail } from "./read-service";
import type { CandidateEvidence } from "./evidence-reader";
import type { VerifiedAnswerResolution } from "./verified-answer-reader";

export type EligibilityReason =
  | "STATE_NOT_REQUIRES_HUMAN_REVIEW"
  | "QUESTION_TYPE_UNSUPPORTED"
  | "HISTORICAL_EVIDENCE_UNAVAILABLE"
  | "EVIDENCE_INTEGRITY_FAILURE"
  | "VALIDATION_HAS_HARD_ERRORS"
  | "ALREADY_VERIFIED"
  | "VALIDATION_ROW_MISSING";

export interface SelectedDraftEligibility {
  readonly eligible: boolean;
  readonly reasons: readonly EligibilityReason[];
}

export interface ReviewerEligibility {
  readonly canApprove: boolean;
  readonly reviewerUserId: string;
  readonly reviewerDisplayName: string;
  readonly selectedDraftEligibility: SelectedDraftEligibility | null;
}

/**
 * Supported-type whitelist. MULTI_ANSWER remains refused at both the
 * server (4N approval-service) and the client until a separate slice
 * extends the contract to carry a multi-index selection.
 */
const APPROVABLE_QUESTION_TYPES: ReadonlySet<string> = new Set([
  "SINGLE_CHOICE",
  "TRUE_FALSE",
]);

/**
 * Compute reviewer eligibility for the currently-selected candidate.
 *
 * `principal` — the signed-in reviewer. Must already be authenticated.
 * `clubId` — the active club.
 * `detail` — the already-resolved candidate detail. Null when no
 *            candidate is selected (eligibility is then null).
 * `evidence` — the 4M evidence resolution (authentic / historical /
 *              integrity-failure).
 * `verifiedAnswer` — the 4N verified-answer resolution.
 *
 * Returns a `SelectedDraftEligibility` even when a candidate IS
 * ineligible; the caller renders it accordingly.
 */
export function computeReviewerEligibility(
  principal: Principal,
  clubId: string,
  detail: CandidateDetail | null,
  evidence: CandidateEvidence | null,
  verifiedAnswer: VerifiedAnswerResolution | null,
  reviewerDisplayName: string,
): ReviewerEligibility {
  const canApprove = hasPermission(principal, clubId, "hr:training:ai:approve");

  if (!detail) {
    return {
      canApprove,
      reviewerUserId: principal.id,
      reviewerDisplayName,
      selectedDraftEligibility: null,
    };
  }

  const reasons: EligibilityReason[] = [];

  if (detail.state !== "REQUIRES_HUMAN_REVIEW") {
    reasons.push("STATE_NOT_REQUIRES_HUMAN_REVIEW");
  }

  if (!APPROVABLE_QUESTION_TYPES.has(detail.draft.questionType)) {
    reasons.push("QUESTION_TYPE_UNSUPPORTED");
  }

  if (evidence) {
    if (evidence.kind === "historical-unavailable") {
      reasons.push("HISTORICAL_EVIDENCE_UNAVAILABLE");
    } else if (evidence.kind === "evidence-integrity-failure") {
      reasons.push("EVIDENCE_INTEGRITY_FAILURE");
    }
  }

  const latestValidation = detail.latestValidation;
  if (!latestValidation) {
    reasons.push("VALIDATION_ROW_MISSING");
  } else if (latestValidation.errors.length > 0) {
    reasons.push("VALIDATION_HAS_HARD_ERRORS");
  }

  if (verifiedAnswer?.kind === "verified") {
    reasons.push("ALREADY_VERIFIED");
  }

  return {
    canApprove,
    reviewerUserId: principal.id,
    reviewerDisplayName,
    selectedDraftEligibility: {
      eligible: reasons.length === 0,
      reasons,
    },
  };
}

/**
 * Plain-language copy for every eligibility reason. The UI reads this
 * dictionary rather than hard-coding sentences at the component level;
 * it's shared between the workspace + the dialog so the two surfaces
 * stay in sync.
 */
export const ELIGIBILITY_REASON_COPY: Readonly<Record<EligibilityReason, string>> = {
  STATE_NOT_REQUIRES_HUMAN_REVIEW:
    "This candidate is not in a reviewable state.",
  QUESTION_TYPE_UNSUPPORTED:
    "Multi-answer questions are not yet supported for approval. A separate slice will add that contract.",
  HISTORICAL_EVIDENCE_UNAVAILABLE:
    "Approval is unavailable: the pilot-era transcript evidence was not durably persisted for this candidate.",
  EVIDENCE_INTEGRITY_FAILURE:
    "Approval is unavailable: evidence integrity cannot be confirmed.",
  VALIDATION_HAS_HARD_ERRORS:
    "This candidate has hard validation errors and cannot be approved.",
  ALREADY_VERIFIED:
    "This candidate has already been reviewer-verified.",
  VALIDATION_ROW_MISSING:
    "This candidate has no validation to bind an approval to.",
};

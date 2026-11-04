// EP-TRAIN-6C-10B — shared types for the AI-assisted training question
// generation / validation pipeline.
//
// This file encodes the two authoritative schemas Spectre's validation
// pipeline operates on:
//
//   - TrainingQuestionDraftLiteV1 — model-facing schema (what Qwen is
//     prompted and lm-format-enforcer constrains it to). The model may
//     produce only: questionType, questionText, options[], explanation,
//     sourceSegmentIds[]. It MAY NOT produce timestamps, quotations,
//     placement, groundingStatus, or reviewStatus.
//
//   - TrainingQuestionProposalV1 — Spectre's strict contract. The
//     deterministic converter is the single authority for every field
//     the model is not allowed to produce.
//
// The schemas are intentionally frozen in the acceptance of EP-TRAIN-6C-4
// and are NOT widened or softened here. Any future change requires a new
// authorization slice.

export const DRAFT_SCHEMA_VERSION = "training-question-draft-lite-v1" as const;
export const PROPOSAL_SCHEMA_VERSION = "training-question-proposal-v1" as const;

export type QuestionType = "SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE";

// ---------- Model-facing Lite draft ----------

export interface TrainingQuestionDraftOption {
  readonly text: string;
  readonly isCorrect: boolean;
}

export interface TrainingQuestionDraftLiteV1 {
  readonly questionType: QuestionType;
  readonly questionText: string;
  readonly options: readonly TrainingQuestionDraftOption[];
  readonly explanation: string;
  readonly sourceSegmentIds: readonly number[];
}

// ---------- Spectre's authoritative proposal ----------

export type PlacementKind = "CHECKPOINT" | "FINAL_ASSESSMENT";

export interface CheckpointPlacement {
  readonly kind: "CHECKPOINT";
  readonly atSec: number;
}
export interface FinalAssessmentPlacement {
  readonly kind: "FINAL_ASSESSMENT";
}
export type Placement = CheckpointPlacement | FinalAssessmentPlacement;

export interface SupportingCitation {
  readonly segmentId: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly quotation: string;
}

export interface TrainingQuestionProposalOption {
  readonly text: string;
  readonly isCorrect: boolean;
}

export type GroundingStatus =
  | "GROUNDED"
  | "REQUIRES_HUMAN_VERIFICATION"
  | "REJECTED";

export interface TrainingQuestionProposalV1 {
  readonly schemaVersion: typeof PROPOSAL_SCHEMA_VERSION;
  readonly proposalId: string;
  readonly placement: Placement;
  readonly questionType: QuestionType;
  readonly questionText: string;
  readonly options: readonly TrainingQuestionProposalOption[];
  readonly explanation: string;
  readonly supportingCitations: readonly SupportingCitation[];
  readonly groundingStatus: GroundingStatus;
  readonly reviewStatus: "PENDING_REVIEW";
}

// ---------- Grounding projection (authorized passages) ----------

export interface GroundingPassageFlags {
  readonly pendingReview: readonly string[];
  readonly sourceOrgMismatch: readonly string[];
  readonly uncertaintyWarning: string | null;
}

export interface GroundingPassage {
  readonly passageId: number;
  readonly sourceSegmentIds: readonly number[];
  readonly sourceStartSec: number;
  readonly sourceEndSec: number;
  readonly text: string;
  readonly citationHandle: string;
  readonly flags: GroundingPassageFlags;
}

export interface GroundingProjection {
  readonly schemaVersion: "training-grounding-v1";
  readonly operation: "GENERATE_DRAFT_QUESTIONS";
  readonly tenantId: string;
  readonly courseId: string;
  readonly versionId: string;
  readonly sourceVideoSha256: string;
  readonly resolvedTranscriptBuildId: string;
  readonly passages: readonly GroundingPassage[];
  readonly excludedPassages?: readonly {
    readonly passageId: number;
    readonly sourceSegmentIds: readonly number[];
    readonly reason: string;
  }[];
  readonly sourceOrgMismatchFlagsPresent?: boolean;
  readonly pendingReviewPresent?: boolean;
}

// ---------- Pilot authorization ----------

export interface PilotRestrictions {
  readonly publicationProhibited: boolean;
  readonly employeeAssignmentProhibited: boolean;
  readonly databaseWritesProhibited: boolean;
  readonly automaticRetriesProhibited: boolean;
  readonly excludedSegmentIds: readonly number[];
  readonly scope: string;
}

export interface PilotAuthorizationV1 {
  readonly schemaVersion: "pilot-generation-authorization-v1";
  readonly authorizationId: string;
  readonly tenantId: string;
  readonly courseId: string;
  readonly versionId: string;
  readonly sourceVideoSha256: string;
  readonly resolvedTranscriptBuildId: string;
  readonly approvedGroundingProjectionSha256: string;
  readonly operation: "GENERATE_DRAFT_QUESTIONS";
  readonly maxRequestedQuestions: number;
  readonly pilotRestrictions: PilotRestrictions;
  readonly issuedAtUtc: string;
  readonly expiresAtUtc: string;
  readonly issuedBy: string;
  readonly fingerprint: string;
}

// ---------- Error / flag shape ----------

export interface ValidatorError {
  readonly code: string;
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
}
export interface ValidatorWarning {
  readonly code: string;
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

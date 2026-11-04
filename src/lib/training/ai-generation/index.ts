// EP-TRAIN-6C-10B — public API for Spectre's AI-assisted training
// question validation pipeline.
//
// All consumers (admin review surface, assignment preview, future API
// routes) MUST import `validateTrainingQuestion` from here and MUST NOT
// reach past it into the converter or the grounding validator directly.
// The pipeline is the authoritative entry point.

export {
  validateTrainingQuestion,
  type PipelineInput,
  type PipelineResult,
  type ValidationStage,
  PIPELINE_ERRORS,
} from "./pipeline";

export {
  VALIDATOR_ERRORS,
  VALIDATOR_FLAGS,
  REGULATORY_BODIES,
  INSURANCE_TERMS,
  KNOWN_SOURCE_ORG_NAMES,
  KNOWN_TENANT_ORG_NAMES,
  type Verdict,
  type ValidatorResult,
} from "./grounding-validator";

export { CONVERT_ERRORS } from "./convert-draft-to-proposal";

export type {
  TrainingQuestionDraftLiteV1,
  TrainingQuestionDraftOption,
  TrainingQuestionProposalV1,
  TrainingQuestionProposalOption,
  GroundingProjection,
  GroundingPassage,
  GroundingPassageFlags,
  PilotAuthorizationV1,
  PilotRestrictions,
  Placement,
  CheckpointPlacement,
  FinalAssessmentPlacement,
  SupportingCitation,
  QuestionType,
  GroundingStatus,
  ValidatorError,
  ValidatorWarning,
} from "./types";

export { DRAFT_SCHEMA_VERSION, PROPOSAL_SCHEMA_VERSION } from "./types";

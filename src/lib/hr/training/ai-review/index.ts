// EP-TRAIN-6D-4B — public barrel for the AI-review governance module.
//
// API routes + service layer MUST import from this file. The internal
// files above are implementation details and callers should not reach
// past this barrel.

export {
  LIFECYCLE_STATES,
  TRANSITIONS,
  evaluateTransition,
  listAllowedTransitionsFrom,
  isTerminal,
  type LifecycleState,
  type LifecycleReason,
  type TransitionRule,
  type TransitionDecision,
  type TransitionBlockReason,
} from "./lifecycle";

export {
  canonicalise,
  sha256Hex,
  draftContentHash,
  canonicalDraftJson,
} from "./content-hash";

export {
  evaluateApprovalServerSide,
  type ServerApprovalBlockReason,
  type ServerApprovalDecision,
  type GuardDraftSnapshot,
  type GuardValidationSnapshot,
  type GuardCourseVersionSnapshot,
  type EvaluateServerApprovalArgs,
} from "./approval-guard";

export {
  writeStateTransition,
  sanitiseMetaJson,
  TransitionBlockedError,
  type TxClient,
  type WriteStateTransitionArgs,
} from "./transactional-audit";

// EP-TRAIN-6D-4B — Lifecycle state machine for AI-drafted training
// questions. Pure functions. Zero DB dependency. Fully unit-testable.
//
// Every allowed transition is enumerated in TRANSITIONS below. Any
// transition not listed is prohibited. The server-side route handlers
// MUST call `evaluateTransition(...)` before mutating state; the
// transactional-audit writer MUST call it again inside the transaction
// as defence-in-depth against race conditions.

export const LIFECYCLE_STATES = [
  "GENERATED",
  "VALIDATION_PENDING",
  "REQUIRES_HUMAN_REVIEW",
  "APPROVED_DRAFT",
  "REJECTED",
  "EDITED_VALIDATION_STALE",
  "VALIDATION_FAILED",
  "ARCHIVED",
] as const;
export type LifecycleState = typeof LIFECYCLE_STATES[number];

export type LifecycleReason =
  | "GENERATION_PERSISTED"
  | "VALIDATION_ENQUEUED"
  | "VALIDATION_COMPLETE_RHV"
  | "VALIDATION_COMPLETE_GROUNDED"
  | "VERDICT_REJECTED"
  | "PIPELINE_EXCEPTION"
  | "VALIDATION_RETRY_ENQUEUED"
  | "REVIEWER_APPROVED"
  | "REVIEWER_REJECTED"
  | "EDIT_SAVED"
  | "SUPERSEDED_BY_EDIT"
  | "REVALIDATION_REQUESTED"
  | "REMEDIATION_RETURNED_TO_REVIEW"
  | "RETENTION_ARCHIVE"
  | "OPERATOR_ARCHIVE";

/**
 * Required permissions (any one of) for a given transition. Empty array
 * means "system transition, no per-user permission required".
 */
export interface TransitionRule {
  readonly from: LifecycleState;
  readonly to: LifecycleState;
  readonly reason: LifecycleReason;
  readonly requires: readonly string[];
}

export const TRANSITIONS: readonly TransitionRule[] = [
  // Generation + validation pipeline (system)
  { from: "GENERATED",             to: "VALIDATION_PENDING",       reason: "VALIDATION_ENQUEUED",       requires: [] },
  { from: "VALIDATION_PENDING",    to: "REQUIRES_HUMAN_REVIEW",    reason: "VALIDATION_COMPLETE_RHV",   requires: [] },
  { from: "VALIDATION_PENDING",    to: "REQUIRES_HUMAN_REVIEW",    reason: "VALIDATION_COMPLETE_GROUNDED", requires: [] },
  { from: "VALIDATION_PENDING",    to: "REJECTED",                 reason: "VERDICT_REJECTED",          requires: [] },
  { from: "VALIDATION_PENDING",    to: "VALIDATION_FAILED",        reason: "PIPELINE_EXCEPTION",        requires: [] },

  // Validation retry
  { from: "VALIDATION_FAILED",     to: "VALIDATION_PENDING",       reason: "VALIDATION_RETRY_ENQUEUED", requires: ["hr:training:ai:revalidate"] },

  // Reviewer flows (from REQUIRES_HUMAN_REVIEW)
  { from: "REQUIRES_HUMAN_REVIEW", to: "APPROVED_DRAFT",           reason: "REVIEWER_APPROVED",         requires: ["hr:training:ai:approve"] },
  { from: "REQUIRES_HUMAN_REVIEW", to: "REJECTED",                 reason: "REVIEWER_REJECTED",         requires: ["hr:training:ai:review"] },
  { from: "REQUIRES_HUMAN_REVIEW", to: "EDITED_VALIDATION_STALE",  reason: "EDIT_SAVED",                requires: ["hr:training:ai:edit"] },

  // Stale-edit flow
  { from: "EDITED_VALIDATION_STALE", to: "VALIDATION_PENDING",     reason: "REVALIDATION_REQUESTED",    requires: ["hr:training:ai:revalidate"] },

  // Remediation (REJECTED → back into review) — explicitly gated by
  // the scoped-tight hr:training:ai:remediate-rejected permission.
  // Does NOT allow direct REJECTED → APPROVED_DRAFT; that remains
  // prohibited. The reviewer must go through REQUIRES_HUMAN_REVIEW →
  // APPROVED_DRAFT after a NEW validation on a NEW contentHash.
  { from: "REJECTED",              to: "REQUIRES_HUMAN_REVIEW",    reason: "REMEDIATION_RETURNED_TO_REVIEW", requires: ["hr:training:ai:remediate-rejected"] },

  // Supersession on edit — the OLD draft row transitions to ARCHIVED.
  { from: "GENERATED",             to: "ARCHIVED",                 reason: "SUPERSEDED_BY_EDIT",        requires: ["hr:training:ai:edit"] },
  { from: "VALIDATION_PENDING",    to: "ARCHIVED",                 reason: "SUPERSEDED_BY_EDIT",        requires: ["hr:training:ai:edit"] },
  { from: "REQUIRES_HUMAN_REVIEW", to: "ARCHIVED",                 reason: "SUPERSEDED_BY_EDIT",        requires: ["hr:training:ai:edit"] },
  { from: "EDITED_VALIDATION_STALE", to: "ARCHIVED",               reason: "SUPERSEDED_BY_EDIT",        requires: ["hr:training:ai:edit"] },
  { from: "VALIDATION_FAILED",     to: "ARCHIVED",                 reason: "SUPERSEDED_BY_EDIT",        requires: ["hr:training:ai:edit"] },

  // Terminal archive (retention window / operator cleanup)
  { from: "REJECTED",              to: "ARCHIVED",                 reason: "OPERATOR_ARCHIVE",          requires: ["hr:training:ai:archive"] },
  { from: "APPROVED_DRAFT",        to: "ARCHIVED",                 reason: "OPERATOR_ARCHIVE",          requires: ["hr:training:ai:archive"] },
  { from: "REJECTED",              to: "ARCHIVED",                 reason: "RETENTION_ARCHIVE",         requires: ["hr:training:ai:archive"] },
  { from: "APPROVED_DRAFT",        to: "ARCHIVED",                 reason: "RETENTION_ARCHIVE",         requires: ["hr:training:ai:archive"] },
];

export type TransitionBlockReason =
  | "TRANSITION_NOT_ALLOWED"
  | "PERMISSION_MISSING";

export interface TransitionDecision {
  readonly allowed: boolean;
  readonly reason: TransitionBlockReason | null;
  readonly message: string;
  /** The matched TransitionRule when allowed, else null. */
  readonly rule: TransitionRule | null;
}

export interface EvaluateTransitionArgs {
  readonly from: LifecycleState;
  readonly to: LifecycleState;
  readonly reasonCode: LifecycleReason;
  /** Permission keys the actor already has for the active club. */
  readonly actorPermissions: ReadonlySet<string>;
}

export function evaluateTransition(args: EvaluateTransitionArgs): TransitionDecision {
  const matches = TRANSITIONS.filter(
    (t) => t.from === args.from && t.to === args.to && t.reason === args.reasonCode,
  );
  if (matches.length === 0) {
    return {
      allowed: false,
      reason: "TRANSITION_NOT_ALLOWED",
      message: `Transition ${args.from} → ${args.to} (${args.reasonCode}) is not in the allowed-transition table.`,
      rule: null,
    };
  }
  // If any match has empty requires[] it's a system transition — allowed.
  // Otherwise the actor must hold at least ONE of the required permissions.
  const rule = matches[0];
  if (rule.requires.length === 0) {
    return { allowed: true, reason: null, message: "", rule };
  }
  const anyHeld = rule.requires.some((p) => args.actorPermissions.has(p));
  if (!anyHeld) {
    return {
      allowed: false,
      reason: "PERMISSION_MISSING",
      message: `Transition ${args.from} → ${args.to} requires one of: ${rule.requires.join(", ")}`,
      rule: null,
    };
  }
  return { allowed: true, reason: null, message: "", rule };
}

/**
 * Convenience: list every destination state reachable from `from`.
 * Used by UI and tooling; not part of the guard path.
 */
export function listAllowedTransitionsFrom(from: LifecycleState): readonly TransitionRule[] {
  return TRANSITIONS.filter((t) => t.from === from);
}

/**
 * Terminal check. ARCHIVED is fully terminal. APPROVED_DRAFT and
 * REJECTED are "reviewer-terminal" but retain archival transitions
 * for the retention policy. Returns true only when NO transition
 * exits this state.
 */
export function isTerminal(state: LifecycleState): boolean {
  return TRANSITIONS.every((t) => t.from !== state);
}

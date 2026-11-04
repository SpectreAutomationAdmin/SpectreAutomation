// EP-TRAIN-6D-3 — single authoritative approval guard for the manager
// review surface. Pure function so it's trivially testable AND so the
// UI (button-disabled logic) and the action handler (double-check on
// Approve click) can call the same source of truth.
//
// Per directive §3, approval MUST be blocked when ANY of the following
// hold:
//
//   1. `validationStatus` is not "complete"
//        → includes "unknown", "pending", "stale", "failed"
//   2. `latestValidation` is missing
//   3. `latestValidation.verdict === "REJECTED"`
//   4. `latestValidation.errors.length > 0` (unresolved hard errors)
//
// Advisory flags do NOT block approval (per 6C-10A design — advisories
// require human attention but are not hard failures).
//
// This file imports nothing from the UI so it stays unit-testable.

import type { PipelineResult } from "@/lib/training/ai-generation";

export type ValidationStatus = "unknown" | "pending" | "complete" | "stale" | "failed";

export type ApprovalBlockReason =
  | "VALIDATION_MISSING"
  | "VALIDATION_PENDING"
  | "VALIDATION_FAILED"
  | "VALIDATION_STALE"
  | "VALIDATION_STATUS_UNKNOWN"
  | "VERDICT_REJECTED"
  | "UNRESOLVED_HARD_ERRORS";

export interface ApprovalGuardInput {
  readonly latestValidation: PipelineResult | null | undefined;
  readonly validationStatus: ValidationStatus;
}

export interface ApprovalGuardDecision {
  readonly allowed: boolean;
  /** Reasons approval is NOT allowed. Empty when allowed. */
  readonly reasons: readonly ApprovalBlockReason[];
  /** One-line human-readable message suitable for inline display.
   *  Non-empty when blocked; empty string when allowed. */
  readonly message: string;
}

const MESSAGES: Record<ApprovalBlockReason, string> = {
  VALIDATION_MISSING:
    "Approval blocked: validation has not yet run for this candidate.",
  VALIDATION_PENDING:
    "Approval blocked: validation is still running. Wait for the pipeline to complete.",
  VALIDATION_FAILED:
    "Approval blocked: the most recent validation failed. Retry validation before approving.",
  VALIDATION_STALE:
    "Approval blocked: content was edited after the most recent validation. Re-run validation on the edited draft before approving.",
  VALIDATION_STATUS_UNKNOWN:
    "Approval blocked: validation state is unknown. Load a candidate and run validation before approving.",
  VERDICT_REJECTED:
    "Approval blocked: validation verdict is REJECTED. Edit the question and re-validate, or reject the candidate.",
  UNRESOLVED_HARD_ERRORS:
    "Approval blocked: one or more unresolved hard errors remain in the most recent validation.",
};

export function evaluateApproval(input: ApprovalGuardInput): ApprovalGuardDecision {
  const reasons: ApprovalBlockReason[] = [];

  // Status-first checks. Order matters: a missing/pending/failed/stale/unknown
  // status short-circuits to a specific reason BEFORE we inspect the
  // validation payload (which may be present-but-stale).
  switch (input.validationStatus) {
    case "unknown":
      reasons.push("VALIDATION_STATUS_UNKNOWN");
      break;
    case "pending":
      reasons.push("VALIDATION_PENDING");
      break;
    case "failed":
      reasons.push("VALIDATION_FAILED");
      break;
    case "stale":
      reasons.push("VALIDATION_STALE");
      break;
    case "complete":
      // fall through to payload checks below
      break;
  }

  // Payload checks. These stack on top of status checks so the operator
  // sees every reason, not just the first one.
  if (!input.latestValidation) {
    reasons.push("VALIDATION_MISSING");
  } else {
    if (input.latestValidation.verdict === "REJECTED") {
      reasons.push("VERDICT_REJECTED");
    }
    if (input.latestValidation.errors.length > 0 && !reasons.includes("VERDICT_REJECTED")) {
      // Hard errors always force REJECTED under the pipeline contract, so
      // this clause normally will not fire on its own. We keep it here as
      // defense-in-depth against any future pipeline change that could
      // emit errors without the matching verdict.
      reasons.push("UNRESOLVED_HARD_ERRORS");
    }
  }

  if (reasons.length === 0) {
    return { allowed: true, reasons: [], message: "" };
  }
  // First reason drives the inline message (the operator sees the most
  // specific / earliest one); the full list stays in reasons for audit.
  const message = MESSAGES[reasons[0]];
  return { allowed: false, reasons, message };
}

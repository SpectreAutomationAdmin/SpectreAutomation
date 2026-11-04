// EP-TRAIN-6C-10B — authoritative validation entry point.
//
// This is the SINGLE function any future training-question workflow
// (admin review surface, assignment preview, API routes, worker jobs)
// MUST call to validate a generated training-question draft. It composes
// the deterministic converter and the hardened grounding validator so
// callers do not accidentally reach past the validator into raw draft
// or raw proposal state.
//
// Fail-closed contract (directive §4):
//   - Any exception thrown inside the validator or converter becomes a
//     REJECTED verdict with ERR_PIPELINE_EXCEPTION. No path can produce
//     GROUNDED or REQUIRES_HUMAN_VERIFICATION from an exception.
//   - If the converter rejects, the pipeline stops at the CONVERT stage
//     and returns REJECTED with the converter's errors; the validator
//     never runs on a rejected conversion.
//   - Advisory flags (soft) are visible but never flip a REJECTED
//     verdict to a passing verdict.
//
// This function is pure and deterministic. It does not read the
// filesystem, call the network, or mutate inputs.

import type {
  GroundingProjection,
  PilotAuthorizationV1,
  Placement,
  TrainingQuestionDraftLiteV1,
  TrainingQuestionProposalV1,
  ValidatorError,
  ValidatorWarning,
} from "./types";
import { convertDraftToProposal } from "./convert-draft-to-proposal";
import type { Verdict } from "./grounding-validator";
import { validateProposal } from "./grounding-validator";

export type ValidationStage = "CONVERT" | "VALIDATE" | "EXCEPTION";

export interface PipelineInput {
  readonly draft: TrainingQuestionDraftLiteV1 | null | undefined;
  readonly grounding: GroundingProjection | null | undefined;
  readonly authorization: PilotAuthorizationV1 | null | undefined;
  readonly placement?: Placement;
}

export interface PipelineResult {
  readonly verdict: Verdict;
  readonly stage: ValidationStage;
  readonly proposal: TrainingQuestionProposalV1 | null;
  readonly propagatedSourceOrgFlags: readonly string[];
  readonly errors: readonly ValidatorError[];
  readonly warnings: readonly ValidatorWarning[];
  readonly flags: readonly string[];
}

export const PIPELINE_ERRORS = Object.freeze({
  EXCEPTION: "ERR_PIPELINE_EXCEPTION",
} as const);

export function validateTrainingQuestion(input: PipelineInput): PipelineResult {
  try {
    const convertRes = convertDraftToProposal({
      draft: input.draft,
      grounding: input.grounding,
      authorization: input.authorization,
      placement: input.placement,
    });
    if (!convertRes.ok) {
      return {
        verdict: "REJECTED",
        stage: "CONVERT",
        proposal: null,
        propagatedSourceOrgFlags: [],
        errors: convertRes.errors,
        warnings: [],
        flags: [],
      };
    }
    const validateRes = validateProposal({
      proposal: convertRes.value,
      grounding: input.grounding,
      authorization: input.authorization,
    });
    return {
      verdict: validateRes.verdict,
      stage: "VALIDATE",
      proposal: convertRes.value,
      propagatedSourceOrgFlags: convertRes.propagatedSourceOrgFlags,
      errors: validateRes.errors,
      warnings: validateRes.warnings,
      flags: validateRes.flags,
    };
  } catch (err) {
    // Fail-closed: any uncaught exception becomes a REJECTED verdict.
    // The exception never surfaces as GROUNDED or REQUIRES_HUMAN_VERIFICATION.
    const message = err instanceof Error ? err.message : String(err);
    return {
      verdict: "REJECTED",
      stage: "EXCEPTION",
      proposal: null,
      propagatedSourceOrgFlags: [],
      errors: [{
        code: PIPELINE_ERRORS.EXCEPTION,
        message: `pipeline exception: ${message}`,
        detail: {},
      }],
      warnings: [],
      flags: [],
    };
  }
}

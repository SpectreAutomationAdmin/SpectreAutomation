// EP-TRAIN-4Y-BF — fail-closed boundary in front of every billable
// inference provider call.
//
// Real (billable) transcription and question generation may only leave
// this process when the environment says so explicitly:
//
//   TRAINING_BILLABLE_INFERENCE=enabled
//
// Any other value — including the variable being absent — refuses the
// call BEFORE credentials are read or a socket is opened. The check
// lives inside each provider client, the lowest point every billable
// call passes through, so no caller, queue entry, retry or missing test
// marker can route around it.
//
// This is an environment boundary, not a manager control. A deployment
// that serves real customers sets the variable; an environment used for
// automated tests leaves it unset, and then nothing in that environment
// can spend on inference no matter what a request looks like.

import { ModalContractError } from "./errors";

export const ENV_BILLABLE_INFERENCE = "TRAINING_BILLABLE_INFERENCE" as const;
export const BILLABLE_INFERENCE_ENABLED_VALUE = "enabled" as const;

export function isBillableInferenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV_BILLABLE_INFERENCE] === BILLABLE_INFERENCE_ENABLED_VALUE;
}

/** Throws `BILLABLE_INFERENCE_LOCKED` (non-retryable) unless the
 *  environment has enabled billable inference. */
export function assertBillableInferenceEnabled(
  operation: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isBillableInferenceEnabled(env)) return;
  throw new ModalContractError(
    "BILLABLE_INFERENCE_LOCKED",
    `Billable inference is not enabled in this environment; ${operation} was refused before any provider call.`,
  );
}

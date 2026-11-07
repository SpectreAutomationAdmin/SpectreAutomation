// EP-TRAIN-4Y-B-IMPL (2026-11-07) — fail-closed env reader for the
// Hybrid Modal auth contract.
//
// §D.2: managed secrets with least-privilege. §7 of the directive:
// avoid putting inference credentials on the web application if only
// the worker needs them. This module centralises env reads so the
// secret-inventory doc + the deployment runbook stay accurate.
//
// Every env var is read on demand. Nothing is captured at module
// load. Nothing is logged.

import { ModalContractError } from "./errors";
import type { OperationId } from "./types";
import { OPERATION_GENERATE, OPERATION_TRANSCRIBE } from "./types";

/** Logical names of the secrets. Fly secret names use the same
 *  spelling. */
export const ENV_MODAL_KEY = "MODAL_KEY" as const;
export const ENV_MODAL_SECRET = "MODAL_SECRET" as const;
export const ENV_TRANSCRIBE_URL = "MODAL_TRANSCRIBE_URL" as const;
export const ENV_GENERATE_URL = "MODAL_GENERATE_URL" as const;
export const ENV_REQUEST_HMAC_KEY = "MODAL_SPECTRE_HMAC_KEY" as const;
export const ENV_FINGERPRINT_SECRET = "SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET" as const;
export const ENV_RESPONSE_HMAC_KEY = "MODAL_SPECTRE_RESPONSE_HMAC_KEY" as const;

/** Credentials the Spectre worker needs to send a Hybrid-contract
 *  request. Every field is a string; absence at read time is a
 *  fail-closed CREDENTIAL_ABSENT. */
export interface ResolvedModalCredentials {
  readonly proxyKey: string;
  readonly proxySecret: string;
  readonly requestHmacKey: string;
  readonly responseHmacKey: string;
  readonly fingerprintSecret: string;
  readonly endpointUrl: string;
}

/** Read + validate credentials for a given operation. Does NOT log
 *  any value. Returns a plain object; never a Promise. Throws
 *  `ModalContractError` with code `CREDENTIAL_ABSENT` on any
 *  missing field. */
export function resolveModalCredentials(
  operation: OperationId,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedModalCredentials {
  const proxyKey = env[ENV_MODAL_KEY];
  const proxySecret = env[ENV_MODAL_SECRET];
  const requestHmacKey = env[ENV_REQUEST_HMAC_KEY];
  const fingerprintSecret = env[ENV_FINGERPRINT_SECRET];
  // Response HMAC key may be the same as request HMAC key when
  // §Q.5 chooses the single-secret path; the env surface still
  // declares a separate name so the operator has the option.
  const responseHmacKey = env[ENV_RESPONSE_HMAC_KEY] ?? requestHmacKey;

  const endpointUrl =
    operation === OPERATION_TRANSCRIBE
      ? env[ENV_TRANSCRIBE_URL]
      : operation === OPERATION_GENERATE
        ? env[ENV_GENERATE_URL]
        : undefined;

  const missing: string[] = [];
  if (!proxyKey) missing.push(ENV_MODAL_KEY);
  if (!proxySecret) missing.push(ENV_MODAL_SECRET);
  if (!requestHmacKey) missing.push(ENV_REQUEST_HMAC_KEY);
  if (!fingerprintSecret) missing.push(ENV_FINGERPRINT_SECRET);
  if (!endpointUrl) {
    missing.push(
      operation === OPERATION_TRANSCRIBE ? ENV_TRANSCRIBE_URL : ENV_GENERATE_URL,
    );
  }
  if (missing.length > 0) {
    // The error message carries only the LOGICAL names, never any
    // value. Safe to log.
    throw new ModalContractError(
      "CREDENTIAL_ABSENT",
      `Modal credentials not configured: ${missing.join(", ")}.`,
    );
  }

  return {
    proxyKey: proxyKey!,
    proxySecret: proxySecret!,
    requestHmacKey: requestHmacKey!,
    responseHmacKey: responseHmacKey!,
    fingerprintSecret: fingerprintSecret!,
    endpointUrl: endpointUrl!,
  };
}

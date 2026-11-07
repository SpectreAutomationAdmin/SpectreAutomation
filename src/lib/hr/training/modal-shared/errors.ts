// EP-TRAIN-4Y-B-IMPL (2026-11-07) — error-code union for the Hybrid
// Modal auth contract.
//
// The union is the authoritative list of ways the contract can fail.
// Both client-side and Modal-side code emit these codes. Downstream
// (worker handler, job service, admin UI) switches on the code to
// decide retryability + operator messaging.

/** All possible contract-level failure modes. Non-contract errors
 *  (ingest failures, prisma faults, etc.) are emitted by downstream
 *  services and do NOT appear here. */
export type ModalContractFailureCode =
  // Env / credential surface
  | "CREDENTIAL_ABSENT"
  // Transport
  | "MODAL_HTTP_ERROR"
  | "MODAL_TIMEOUT"
  // Request-side integrity (client would detect during signing OR
  // Modal detects during verification)
  | "REQUEST_HMAC_INVALID"
  | "REQUEST_BODY_INVALID"
  | "TIMESTAMP_SKEW_EXCEEDED"
  | "UNKNOWN_OPERATION"
  | "OPERATION_MISMATCH"
  | "CONTRACT_VERSION_MISMATCH"
  | "ASCII_SCOPE_REQUIRED"
  // Authorization envelope
  | "PILOT_AUTH_FINGERPRINT_MISMATCH"
  | "PILOT_AUTH_EXPIRED"
  | "PILOT_AUTH_OPERATION_MISMATCH"
  | "PILOT_AUTH_SCHEMA_MISMATCH"
  | "TENANT_MISMATCH"
  | "COURSE_VERSION_MISMATCH"
  | "VIDEO_SHA_MISMATCH_AT_BOUNDARY"
  // Replay
  | "REPLAY_DETECTED"
  | "REPLAY_STORE_UNAVAILABLE"
  // Response-side integrity
  | "MODAL_HMAC_INVALID"
  | "MODAL_BODY_INVALID"
  | "RESPONSE_REQUEST_ID_MISMATCH"
  | "RESPONSE_OPERATION_MISMATCH";

/** Classification used by worker handlers to decide retry policy.
 *  Documented alongside the implementation plan §4.5. */
export const NON_RETRYABLE_CODES: ReadonlySet<ModalContractFailureCode> = new Set([
  "CREDENTIAL_ABSENT",
  "REQUEST_HMAC_INVALID",
  "REQUEST_BODY_INVALID",
  "MODAL_HMAC_INVALID",
  "MODAL_BODY_INVALID",
  "PILOT_AUTH_FINGERPRINT_MISMATCH",
  "PILOT_AUTH_SCHEMA_MISMATCH",
  "PILOT_AUTH_OPERATION_MISMATCH",
  "TENANT_MISMATCH",
  "COURSE_VERSION_MISMATCH",
  "VIDEO_SHA_MISMATCH_AT_BOUNDARY",
  "OPERATION_MISMATCH",
  "UNKNOWN_OPERATION",
  "CONTRACT_VERSION_MISMATCH",
  "ASCII_SCOPE_REQUIRED",
  "RESPONSE_REQUEST_ID_MISMATCH",
  "RESPONSE_OPERATION_MISMATCH",
]);

/** `MODAL_TIMEOUT` and `MODAL_HTTP_ERROR 5xx` are retryable; HMAC /
 *  envelope / schema mismatches are NOT — they indicate protocol
 *  divergence and need operator intervention. `PILOT_AUTH_EXPIRED`
 *  is retryable with a FRESH authorization. `REPLAY_DETECTED` is
 *  retryable with a FRESH request id + authorization (per §Q.4).
 *  `REPLAY_STORE_UNAVAILABLE` is retryable — fails closed on the
 *  server but returns a code that the worker can retry once with
 *  backoff. `TIMESTAMP_SKEW_EXCEEDED` is retryable with a fresh
 *  timestamp (clock drift). */
export function isRetryable(code: ModalContractFailureCode): boolean {
  return !NON_RETRYABLE_CODES.has(code);
}

/** Standard error class for the contract. The `code` is the
 *  authoritative dispatch key; `message` is the operator-facing
 *  diagnostic and MUST NOT contain any secret / token / HMAC value
 *  / proxy credential. */
export class ModalContractError extends Error {
  readonly code: ModalContractFailureCode;
  readonly httpStatus: number | null;
  constructor(
    code: ModalContractFailureCode,
    message: string,
    opts?: { httpStatus?: number },
  ) {
    super(message);
    this.name = "ModalContractError";
    this.code = code;
    this.httpStatus = opts?.httpStatus ?? null;
  }
}

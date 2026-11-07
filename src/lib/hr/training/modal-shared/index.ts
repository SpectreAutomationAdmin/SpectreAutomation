// EP-TRAIN-4Y-B-IMPL (2026-11-07) — barrel for the shared Modal
// contract library.

export {
  canonicalise,
  assertPrintableAscii,
  sha256HexOfCanonical,
  sha256HexOfCanonicalSync,
} from "./canonicalise";

export {
  CONTRACT_VERSION,
  SIG_VERSION,
  OPERATION_TRANSCRIBE,
  OPERATION_GENERATE,
  DEFAULT_AUTH_TTL_SEC,
  DEFAULT_TIMESTAMP_SKEW_SEC,
  DEFAULT_R2_URL_TTL_SEC,
  DEFAULT_REPLAY_WINDOW_SEC,
  TRANSCRIBE_PLACEHOLDER_TRANSCRIPT_BUILD_ID,
  TRANSCRIBE_PLACEHOLDER_GROUNDING_SHA,
  SYSTEM_CLOCK,
} from "./types";
export type {
  OperationId,
  PilotAuthorizationOperation,
  PilotAuthorizationV1,
  PilotRestrictions,
  RequestSigningHeaders,
  ResponseSigningHeaders,
  ModalRequestBody,
  TranscribePayload,
  GeneratePayload,
  TranscribeResponseBody,
  GenerateResponseBody,
  Clock,
} from "./types";

export {
  ModalContractError,
  NON_RETRYABLE_CODES,
  isRetryable,
} from "./errors";
export type { ModalContractFailureCode } from "./errors";

export {
  ENV_MODAL_KEY,
  ENV_MODAL_SECRET,
  ENV_TRANSCRIBE_URL,
  ENV_GENERATE_URL,
  ENV_REQUEST_HMAC_KEY,
  ENV_FINGERPRINT_SECRET,
  ENV_RESPONSE_HMAC_KEY,
  resolveModalCredentials,
} from "./env";
export type { ResolvedModalCredentials } from "./env";

export {
  issuePilotAuthorization,
  verifyPilotAuthorizationFingerprint,
  isPilotAuthorizationExpired,
} from "./pilot-authorization";

export { signRequest, verifyRequestSignature } from "./request-signer";
export type { SignRequestInput, SignedRequest } from "./request-signer";

export {
  verifyResponseSignature,
  signResponse,
  RESPONSE_SIG_VERSION,
} from "./response-verifier";
export type { VerifyResponseInput } from "./response-verifier";

export {
  InMemoryReplayRegistry,
  NullReplayRegistry,
  replayKey,
} from "./replay-registry";
export type {
  ReplayRegistry,
  ReplayRegistryRecordInput,
  ReplayRegistryRecordResult,
} from "./replay-registry";

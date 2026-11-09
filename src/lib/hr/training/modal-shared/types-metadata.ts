// EP-TRAIN-4Y-W §4 (2026-11-09) — dedicated metadata-generation
// contract on the Hybrid Modal transport.
//
// 4Y-V repurposed the question-generation schema for title +
// description by encoding metadata as a fake SINGLE_CHOICE
// "proposal". That path was ambiguous server-side (the Modal
// container has no way to distinguish a real question-generation
// call from a metadata call) and was rejected by the founder in
// §4 of the W directive.
//
// This slice defines the SHAPE of a real metadata operation on the
// same authenticated HMAC transport. The payload + response schemas
// are added to the TypeScript contract so the client, tests, and
// a future Modal-side implementation can agree on the wire. The
// Modal-side implementation is a SEPARATE slice (requires a Modal
// deploy with a new allowed operation) — this slice ships the
// contract + the client + the offline tests only.
//
// Operation id reserves a new slug under the same contract version:
//   spectre.training.metadata.v1
//
// Shared with:
//   - CONTRACT_VERSION = "4yb-v1"
//   - RequestSigningHeaders (identical)
//   - PilotAuthorizationV1 (operation widened to include
//     GENERATE_COURSE_METADATA; Modal-side verifier updated in
//     the follow-up slice)
//
// No GPU invocation is performed by this module. It only defines
// the types, serialiser/validator, client wrapper, and offline
// tests.

import {
  CONTRACT_VERSION,
  type OperationId,
  type PilotAuthorizationV1,
  type RequestSigningHeaders,
  type ResponseSigningHeaders,
} from "./types";

/** New operation id for metadata requests. Both sides refuse any
 *  other value in the signed envelope. */
export const OPERATION_METADATA = "spectre.training.metadata.v1" as const;

/** Widen the operation id union locally. Keeps the primary
 *  `OperationId` union intact for the existing transcribe / generate
 *  paths; this module's consumers import `MetadataOperationId` when
 *  they handle metadata calls. */
export type MetadataOperationId = typeof OPERATION_METADATA;

/** Metadata-specific request payload. No `jsonSchema` field — the
 *  Modal-side is a fixed schema for {title, description, sourceSegmentIds}
 *  that the schema validator in the GPU container enforces. */
export interface MetadataPayload {
  readonly modelVariant: "qwen-2.5-7b-instruct-awq";
  readonly systemPrompt: string;
  readonly transcript: string;
  readonly constraints: {
    readonly maxTitleLength: number;       // 10-80
    readonly maxDescriptionLength: number; // 40-320
    readonly maxOutputTokens: number;      // ≤ 512
    readonly clubName?: string;            // provenance hint, not used for grounding
  };
}

/** Metadata-specific response body. The GPU container emits ONLY the
 *  three fields below (not proposals + options). Each field is a
 *  grounded extractive-or-abstractive output from the same transcript
 *  windows used for question generation. */
export interface MetadataResponseBody {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly operation: MetadataOperationId;
  readonly requestId: string;
  readonly modelVariant: "qwen-2.5-7b-instruct-awq";
  readonly title: string;
  readonly description: string;
  /** Segment indices (from the transcript the client passed) that
   *  most strongly anchor the title. Used by the client for audit;
   *  not re-grounded server-side. */
  readonly sourceSegmentIds: readonly number[];
  readonly elapsedMs: { readonly coldBoot: number; readonly generate: number };
  readonly tokenCounts: { readonly prompt: number; readonly output: number };
}

/** Signed error envelope — identical shape to the generate error. */
export interface MetadataErrorBody {
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly operation: MetadataOperationId;
  readonly requestId: string;
  readonly error: { readonly code: string; readonly message: string };
}

/** Field limits enforced client-side AND in the response validator. */
export const METADATA_LIMITS = {
  TITLE_MIN_LEN: 3,
  TITLE_MAX_LEN: 80,
  DESCRIPTION_MIN_LEN: 10,
  DESCRIPTION_MAX_LEN: 320,
  MAX_OUTPUT_TOKENS: 512,
  MAX_RESPONSE_BYTES: 8 * 1024, // 8 KiB — any legit response fits
} as const;

/** Failure-code union used by the client to classify errors. */
export type MetadataClientFailureCode =
  | "MODAL_HTTP_ERROR"
  | "MODAL_TIMEOUT"
  | "MODAL_HMAC_INVALID"
  | "MODAL_BODY_INVALID"
  | "METADATA_JSON_INVALID"
  | "METADATA_EMPTY_TITLE"
  | "METADATA_EMPTY_DESCRIPTION"
  | "METADATA_TITLE_TOO_LONG"
  | "METADATA_DESCRIPTION_TOO_LONG"
  | "METADATA_RESPONSE_TOO_LARGE"
  | "RESPONSE_REQUEST_ID_MISMATCH"
  | "RESPONSE_OPERATION_MISMATCH"
  | "CREDENTIAL_ABSENT";

export class MetadataContractError extends Error {
  readonly code: MetadataClientFailureCode;
  readonly httpStatus?: number;
  constructor(code: MetadataClientFailureCode, message: string, opts: { httpStatus?: number } = {}) {
    super(message);
    this.name = "MetadataContractError";
    this.code = code;
    this.httpStatus = opts.httpStatus;
  }
}

/** Validate a parsed response body against the contract. Separated
 *  from the HTTP client so the validator is callable without a
 *  real fetch — the offline tests use it directly on hand-crafted
 *  payloads to exercise invalid-JSON / oversize / empty-field
 *  behaviour.
 *
 *  Returns the validated body. Throws MetadataContractError on
 *  violation. */
export function validateMetadataResponseBody(
  raw: unknown,
  expectedRequestId: string,
): MetadataResponseBody {
  if (!raw || typeof raw !== "object") {
    throw new MetadataContractError("MODAL_BODY_INVALID", "Response is not an object.");
  }
  const o = raw as Record<string, unknown>;
  if (o.contractVersion !== CONTRACT_VERSION) {
    throw new MetadataContractError(
      "MODAL_BODY_INVALID",
      `contractVersion is ${JSON.stringify(o.contractVersion)}.`,
    );
  }
  if (o.operation !== OPERATION_METADATA) {
    throw new MetadataContractError(
      "RESPONSE_OPERATION_MISMATCH",
      `operation is ${JSON.stringify(o.operation)}.`,
    );
  }
  if (o.requestId !== expectedRequestId) {
    throw new MetadataContractError(
      "RESPONSE_REQUEST_ID_MISMATCH",
      "requestId does not match request.",
    );
  }
  if (typeof o.title !== "string") {
    throw new MetadataContractError("MODAL_BODY_INVALID", "title is not a string.");
  }
  const title = o.title as string;
  if (title.trim().length < METADATA_LIMITS.TITLE_MIN_LEN) {
    throw new MetadataContractError("METADATA_EMPTY_TITLE", "title is empty or too short.");
  }
  if (title.length > METADATA_LIMITS.TITLE_MAX_LEN) {
    throw new MetadataContractError(
      "METADATA_TITLE_TOO_LONG",
      `title exceeds ${METADATA_LIMITS.TITLE_MAX_LEN} chars.`,
    );
  }
  if (typeof o.description !== "string") {
    throw new MetadataContractError("MODAL_BODY_INVALID", "description is not a string.");
  }
  const description = o.description as string;
  if (description.trim().length < METADATA_LIMITS.DESCRIPTION_MIN_LEN) {
    throw new MetadataContractError("METADATA_EMPTY_DESCRIPTION", "description is empty or too short.");
  }
  if (description.length > METADATA_LIMITS.DESCRIPTION_MAX_LEN) {
    throw new MetadataContractError(
      "METADATA_DESCRIPTION_TOO_LONG",
      `description exceeds ${METADATA_LIMITS.DESCRIPTION_MAX_LEN} chars.`,
    );
  }
  if (!Array.isArray(o.sourceSegmentIds) || !o.sourceSegmentIds.every((n) => Number.isInteger(n) && (n as number) >= 0)) {
    throw new MetadataContractError("MODAL_BODY_INVALID", "sourceSegmentIds shape invalid.");
  }
  const elapsed = o.elapsedMs as Record<string, unknown> | undefined;
  if (!elapsed || typeof elapsed.coldBoot !== "number" || typeof elapsed.generate !== "number") {
    throw new MetadataContractError("MODAL_BODY_INVALID", "elapsedMs shape invalid.");
  }
  const tokens = o.tokenCounts as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens.prompt !== "number" || typeof tokens.output !== "number") {
    throw new MetadataContractError("MODAL_BODY_INVALID", "tokenCounts shape invalid.");
  }
  return raw as MetadataResponseBody;
}

/** Enforce the response-size byte cap. Called by the HTTP client
 *  BEFORE parsing JSON so a runaway response is refused instead of
 *  consuming unbounded memory. */
export function assertMetadataResponseSize(bodyText: string): void {
  if (bodyText.length > METADATA_LIMITS.MAX_RESPONSE_BYTES) {
    throw new MetadataContractError(
      "METADATA_RESPONSE_TOO_LARGE",
      `Response is ${bodyText.length} bytes (limit ${METADATA_LIMITS.MAX_RESPONSE_BYTES}).`,
    );
  }
}

/** Parse the response text into a validated body. Isolated so tests
 *  can exercise JSON-parse errors without a real socket. */
export function parseAndValidateMetadataResponse(
  bodyText: string,
  expectedRequestId: string,
): MetadataResponseBody {
  assertMetadataResponseSize(bodyText);
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch (err) {
    throw new MetadataContractError(
      "METADATA_JSON_INVALID",
      `Body is not valid JSON: ${(err as Error)?.message ?? "parse error"}`,
    );
  }
  return validateMetadataResponseBody(raw, expectedRequestId);
}

/** Re-export shared pieces the client uses so consumers import from
 *  a single surface. */
export type {
  PilotAuthorizationV1,
  RequestSigningHeaders,
  ResponseSigningHeaders,
  OperationId,
};

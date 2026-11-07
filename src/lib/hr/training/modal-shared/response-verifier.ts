// EP-TRAIN-4Y-B-IMPL (2026-11-07) — response-side HMAC verifier.
//
// §5 signed-response binding:
//   response-sig-v1.{contractVersion}.{operation}.{requestId}.
//     {httpStatus}.{sha256HexOfCanonical(body)}
//
// The response signature covers the HTTP status so a legitimate
// 200 cannot be substituted for a 400 (or vice versa). It covers
// the requestId so a response to call A cannot be replayed as a
// response to call B. It covers the operation so a generate
// response cannot be served to a transcribe caller.
//
// §Q.3 defence in depth: the Modal function also returns an
// `x-spectre-response-operation` header which the client matches
// against the expected operation. The signature is the
// cryptographic authority; the header is a cheap pre-signature
// shape check that fails fast on misconfiguration.
//
// §5: unsigned success responses MUST be rejected. There is no
// bypass path.

import { createHmac } from "node:crypto";
import { sha256HexOfCanonicalSync } from "./canonicalise";
import {
  CONTRACT_VERSION,
  type OperationId,
  type ResponseSigningHeaders,
} from "./types";
import { ModalContractError, type ModalContractFailureCode } from "./errors";

/** Response-signature version identifier. */
export const RESPONSE_SIG_VERSION = "response-sig-v1" as const;

export interface VerifyResponseInput {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly bodyText: string;
  readonly expectedOperation: OperationId;
  readonly expectedRequestId: string;
  readonly httpStatus: number;
  readonly responseHmacKey: string;
}

/**
 * Verifies the response signature. On success, returns the parsed
 * JSON body. On failure, throws `ModalContractError` with the
 * specific code.
 */
export function verifyResponseSignature(
  input: VerifyResponseInput,
): Readonly<Record<string, unknown>> {
  const hdr = (k: string): string | undefined =>
    input.headers[k] ?? input.headers[k.toLowerCase()];

  const signature = hdr("x-spectre-response-signature");
  const op = hdr("x-spectre-response-operation");
  const rid = hdr("x-spectre-response-request-id");
  const cv = hdr("x-spectre-contract-version");

  if (!signature) {
    throw new ModalContractError(
      "MODAL_HMAC_INVALID",
      "Response is missing x-spectre-response-signature header.",
      { httpStatus: input.httpStatus },
    );
  }
  if (!op || !rid || !cv) {
    throw new ModalContractError(
      "MODAL_HMAC_INVALID",
      "Response is missing one or more response-signing headers.",
      { httpStatus: input.httpStatus },
    );
  }
  if (cv !== CONTRACT_VERSION) {
    throw new ModalContractError(
      "CONTRACT_VERSION_MISMATCH",
      `Response x-spectre-contract-version is ${cv}; expected ${CONTRACT_VERSION}.`,
      { httpStatus: input.httpStatus },
    );
  }
  if (op !== input.expectedOperation) {
    throw new ModalContractError(
      "RESPONSE_OPERATION_MISMATCH",
      `Response operation ${op} does not match expected ${input.expectedOperation}.`,
      { httpStatus: input.httpStatus },
    );
  }
  if (rid !== input.expectedRequestId) {
    throw new ModalContractError(
      "RESPONSE_REQUEST_ID_MISMATCH",
      `Response request-id ${rid} does not match expected ${input.expectedRequestId}.`,
      { httpStatus: input.httpStatus },
    );
  }

  // Parse body (needed for canonical digest).
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.bodyText);
  } catch {
    throw new ModalContractError(
      "MODAL_BODY_INVALID",
      "Response body is not valid JSON.",
      { httpStatus: input.httpStatus },
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new ModalContractError(
      "MODAL_BODY_INVALID",
      "Response body is not a JSON object.",
      { httpStatus: input.httpStatus },
    );
  }

  const bodyDigest = sha256HexOfCanonicalSync(parsed);
  const signedMessage = `${RESPONSE_SIG_VERSION}.${CONTRACT_VERSION}.${op}.${rid}.${input.httpStatus}.${bodyDigest}`;
  const expected = createHmac("sha256", input.responseHmacKey)
    .update(signedMessage, "utf-8")
    .digest("base64url");

  if (!constantTimeEqualAscii(signature, expected)) {
    throw new ModalContractError(
      "MODAL_HMAC_INVALID",
      "x-spectre-response-signature did not verify.",
      { httpStatus: input.httpStatus },
    );
  }

  return parsed as Readonly<Record<string, unknown>>;
}

/**
 * Server-side signer helper used by the Modal function and by
 * mock servers in the test suite. Returns the headers that should
 * be attached to the response.
 */
export function signResponse(args: {
  readonly operation: OperationId;
  readonly requestId: string;
  readonly httpStatus: number;
  readonly bodyText: string;
  readonly responseHmacKey: string;
}): ResponseSigningHeaders {
  // The body-digest is computed from the canonical form of the
  // PARSED body so client and server agree even if whitespace or
  // key-order drifts across HTTP intermediaries.
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.bodyText);
  } catch {
    throw new ModalContractError(
      "MODAL_BODY_INVALID",
      "signResponse: bodyText is not valid JSON.",
      { httpStatus: args.httpStatus },
    );
  }
  const bodyDigest = sha256HexOfCanonicalSync(parsed);
  const signedMessage = `${RESPONSE_SIG_VERSION}.${CONTRACT_VERSION}.${args.operation}.${args.requestId}.${args.httpStatus}.${bodyDigest}`;
  const signature = createHmac("sha256", args.responseHmacKey)
    .update(signedMessage, "utf-8")
    .digest("base64url");
  return Object.freeze({
    "x-spectre-response-signature": signature,
    "x-spectre-response-operation": args.operation,
    "x-spectre-response-request-id": args.requestId,
    "x-spectre-contract-version": CONTRACT_VERSION,
  });
}

function constantTimeEqualAscii(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type { ModalContractFailureCode };

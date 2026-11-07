// EP-TRAIN-4Y-B-IMPL (2026-11-07) — request-side HMAC signer.
//
// Signs:
//   signedMessage = v1.{operation}.{requestId}.{ts}.{body-digest}
//
// where body-digest = sha256HexOfCanonical(body). Byte-identical to
// the EP-TRAIN-6C-11 workstation signing format
// (`scratchpad/ep-train-6b/gen/generate-lite-run.mjs:45-46`) with
// `signature` encoded as base64url (NOT hex) per §4.3 of the design
// review.

import { createHmac } from "node:crypto";
import { canonicalise, assertPrintableAscii, sha256HexOfCanonicalSync } from "./canonicalise";
import {
  CONTRACT_VERSION,
  SIG_VERSION,
  type OperationId,
  type RequestSigningHeaders,
  type ModalRequestBody,
  type Clock,
  SYSTEM_CLOCK,
} from "./types";
import { ModalContractError } from "./errors";

export interface SignRequestInput<P extends object> {
  readonly operation: OperationId;
  readonly requestId: string;
  readonly hmacKey: string;
  readonly body: ModalRequestBody<P>;
  readonly clock?: Clock;
  readonly timestampOverrideSec?: number;
}

export interface SignedRequest<P extends object> {
  readonly headers: RequestSigningHeaders;
  readonly bodyText: string;
}

/**
 * Produce the signed headers + canonical body text ready for POST.
 *
 * Preconditions:
 * - `requestId` is printable ASCII (we recommend 32-char hex).
 * - `operation` matches `body.operation`.
 * - `body.contractVersion` matches CONTRACT_VERSION.
 * - `body.requestId` matches the `requestId` argument.
 *
 * Any mismatch throws `ModalContractError` with the appropriate
 * code. The caller is expected to feed consistent inputs; the
 * guardrails are defence-in-depth, not control flow.
 */
export function signRequest<P extends object>(
  input: SignRequestInput<P>,
): SignedRequest<P> {
  if (input.body.operation !== input.operation) {
    throw new ModalContractError(
      "OPERATION_MISMATCH",
      "signRequest: body.operation does not match input.operation.",
    );
  }
  if (input.body.contractVersion !== CONTRACT_VERSION) {
    throw new ModalContractError(
      "CONTRACT_VERSION_MISMATCH",
      `signRequest: body.contractVersion is ${input.body.contractVersion}; expected ${CONTRACT_VERSION}.`,
    );
  }
  if (input.body.requestId !== input.requestId) {
    throw new ModalContractError(
      "REQUEST_BODY_INVALID",
      "signRequest: body.requestId does not match input.requestId.",
    );
  }
  assertPrintableAscii("requestId", input.requestId);
  assertPrintableAscii("operation", input.operation);

  const clock = input.clock ?? SYSTEM_CLOCK;
  const ts = String(input.timestampOverrideSec ?? Math.floor(clock.nowMs() / 1000));
  // body.timestamp must agree with signed timestamp.
  if (input.body.timestamp !== ts) {
    throw new ModalContractError(
      "REQUEST_BODY_INVALID",
      "signRequest: body.timestamp does not match signed timestamp.",
    );
  }

  const bodyDigest = sha256HexOfCanonicalSync(input.body);
  const signedMessage = `${SIG_VERSION}.${input.operation}.${input.requestId}.${ts}.${bodyDigest}`;
  const signature = createHmac("sha256", input.hmacKey)
    .update(signedMessage, "utf-8")
    .digest("base64url");

  const headers: RequestSigningHeaders = Object.freeze({
    "x-spectre-sig-version": SIG_VERSION,
    "x-spectre-operation": input.operation,
    "x-spectre-request-id": input.requestId,
    "x-spectre-timestamp": ts,
    "x-spectre-body-digest": bodyDigest,
    "x-spectre-signature": signature,
    "x-spectre-contract-version": CONTRACT_VERSION,
  });

  // Return the canonicalised body TEXT (not re-stringified) so the
  // server verifies against exactly what we signed.
  const bodyText = canonicalise(input.body);
  return { headers, bodyText };
}

/** Server-side verification helper used by the Modal function and
 *  by the test suite that mocks it. Returns a tuple
 *  `{ ok, code }`; constant-time compares the signature. */
export function verifyRequestSignature(args: {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly bodyText: string;
  readonly hmacKey: string;
  readonly clock?: Clock;
  readonly timestampSkewSec: number;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly code: import("./errors").ModalContractFailureCode; readonly message: string } {
  const hdr = (k: string): string | undefined => args.headers[k] ?? args.headers[k.toLowerCase()];

  const sigVersion = hdr("x-spectre-sig-version");
  const operation = hdr("x-spectre-operation");
  const requestId = hdr("x-spectre-request-id");
  const timestamp = hdr("x-spectre-timestamp");
  const bodyDigest = hdr("x-spectre-body-digest");
  const signature = hdr("x-spectre-signature");
  const contractVersion = hdr("x-spectre-contract-version");

  if (!sigVersion || !operation || !requestId || !timestamp || !bodyDigest || !signature || !contractVersion) {
    return {
      ok: false,
      code: "REQUEST_HMAC_INVALID",
      message: "Missing one or more x-spectre-* headers.",
    };
  }
  if (sigVersion !== SIG_VERSION) {
    return { ok: false, code: "REQUEST_HMAC_INVALID", message: `Unknown sig-version: ${sigVersion}.` };
  }
  if (contractVersion !== CONTRACT_VERSION) {
    return { ok: false, code: "CONTRACT_VERSION_MISMATCH", message: `Unknown contract-version: ${contractVersion}.` };
  }
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, code: "REQUEST_HMAC_INVALID", message: "Non-numeric timestamp." };
  }
  const nowSec = Math.floor((args.clock ?? SYSTEM_CLOCK).nowMs() / 1000);
  if (Math.abs(nowSec - ts) > args.timestampSkewSec) {
    return {
      ok: false,
      code: "TIMESTAMP_SKEW_EXCEEDED",
      message: `Timestamp ${ts} is outside ±${args.timestampSkewSec}s of ${nowSec}.`,
    };
  }

  // Recompute body digest.
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const actualDigest = createHash("sha256").update(args.bodyText, "utf-8").digest("hex");
  if (actualDigest !== bodyDigest) {
    return {
      ok: false,
      code: "REQUEST_HMAC_INVALID",
      message: "x-spectre-body-digest does not match canonical body SHA-256.",
    };
  }

  const expectedSig = createHmac("sha256", args.hmacKey)
    .update(`${SIG_VERSION}.${operation}.${requestId}.${timestamp}.${bodyDigest}`, "utf-8")
    .digest("base64url");

  if (!constantTimeEqualAscii(expectedSig, signature)) {
    return {
      ok: false,
      code: "REQUEST_HMAC_INVALID",
      message: "x-spectre-signature did not verify.",
    };
  }

  return { ok: true };
}

function constantTimeEqualAscii(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

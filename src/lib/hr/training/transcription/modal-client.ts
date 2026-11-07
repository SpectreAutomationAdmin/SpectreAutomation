// EP-TRAIN-4Y-B-IMPL (2026-11-07) — Hybrid-contract Modal
// faster-whisper HTTP client.
//
// Supersedes the EP-TRAIN-6D-4V Bearer-only client. The security
// envelope is now:
//
//   - Modal proxy auth via `Modal-Key` + `Modal-Secret` headers.
//   - Per-request HMAC covering operation + requestId + timestamp +
//     canonical body digest (via `signRequest`).
//   - `PilotAuthorizationV1` embedded in the request body with
//     fingerprint over seven bound identifiers (tenant / course /
//     version / video SHA / transcript build / grounding projection
//     / operation) + TTL + restrictions (via
//     `issuePilotAuthorization`, called by the worker handler).
//   - Response HMAC bound to request-id + operation + HTTP status +
//     response-body digest + contract version (via
//     `verifyResponseSignature`).
//   - Bounded wall-clock via `AbortController`.
//   - Fail-closed on missing credentials.
//   - No credential ever reaches logs.

import {
  canonicalise,
  resolveModalCredentials,
  signRequest,
  verifyResponseSignature,
  CONTRACT_VERSION,
  OPERATION_TRANSCRIBE,
  SYSTEM_CLOCK,
  ModalContractError,
  type Clock,
  type ModalRequestBody,
  type PilotAuthorizationV1,
  type TranscribePayload,
  type TranscribeResponseBody,
} from "../modal-shared";

export interface ModalTranscribeInput {
  readonly requestId: string;
  readonly audioUrl: string;
  readonly languageCode: string;
  readonly modelVariant: string;
  readonly pilotAuthorization: PilotAuthorizationV1;
}

export interface ModalTranscribeClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
}

/**
 * Call the Modal transcribe endpoint using the Hybrid contract.
 * Mocked in tests via `fetchImpl`. Does NOT reach the network in
 * offline builds (env absent → `CREDENTIAL_ABSENT`).
 */
export async function callModalTranscribe(
  input: ModalTranscribeInput,
  opts: ModalTranscribeClientOptions = {},
): Promise<TranscribeResponseBody> {
  const clock = opts.clock ?? SYSTEM_CLOCK;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const creds = resolveModalCredentials(OPERATION_TRANSCRIBE, opts.env ?? process.env);

  const timestamp = String(Math.floor(clock.nowMs() / 1000));
  const payload: TranscribePayload = {
    audioUrl: input.audioUrl,
    languageCode: input.languageCode,
    modelVariant: input.modelVariant,
  };
  const body: ModalRequestBody<TranscribePayload> = {
    contractVersion: CONTRACT_VERSION,
    operation: OPERATION_TRANSCRIBE,
    requestId: input.requestId,
    timestamp,
    pilotAuthorization: input.pilotAuthorization,
    payload,
  };

  const signed = signRequest({
    operation: OPERATION_TRANSCRIBE,
    requestId: input.requestId,
    hmacKey: creds.requestHmacKey,
    body,
    clock,
    timestampOverrideSec: Number.parseInt(timestamp, 10),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10 * 60 * 1000);

  let res: Response;
  try {
    res = await fetchImpl(creds.endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Modal-Key": creds.proxyKey,
        "Modal-Secret": creds.proxySecret,
        ...signed.headers,
      },
      body: signed.bodyText,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error)?.name === "AbortError") {
      throw new ModalContractError("MODAL_TIMEOUT", "Modal transcribe request timed out.");
    }
    throw new ModalContractError(
      "MODAL_HTTP_ERROR",
      `Modal transcribe request failed: ${(err as Error)?.message ?? String(err)}`,
    );
  }
  clearTimeout(timer);

  const respText = await res.text();
  const headerMap: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headerMap[k.toLowerCase()] = v;
  });

  // EP-TRAIN-4Y-C §3 — verify response signature for BOTH success
  // and error paths when signed-response headers are present.
  //
  // Decision tree on non-2xx:
  //   (a) signed-response headers present → verify; if OK, trust the
  //       x-spectre-failure-code header. If signature fails, throw
  //       MODAL_HMAC_INVALID — attacker-controlled failure codes are
  //       rejected.
  //   (b) signed-response headers absent (e.g. proxy-level 502 /
  //       Modal workspace rejection before our function runs) →
  //       classify as MODAL_HTTP_ERROR without trusting any header.
  if (!res.ok) {
    const hasSignedHeaders =
      !!headerMap["x-spectre-response-signature"] &&
      !!headerMap["x-spectre-response-operation"] &&
      !!headerMap["x-spectre-response-request-id"] &&
      !!headerMap["x-spectre-contract-version"];
    if (hasSignedHeaders) {
      // This throws if the signature is invalid — attacker cannot
      // inject a crafted failure code without a valid HMAC.
      verifyResponseSignature({
        headers: headerMap,
        bodyText: respText,
        expectedOperation: OPERATION_TRANSCRIBE,
        expectedRequestId: input.requestId,
        httpStatus: res.status,
        responseHmacKey: creds.responseHmacKey,
      });
      const serverCode = headerMap["x-spectre-failure-code"];
      throw new ModalContractError(
        coerceServerCode(serverCode) ?? "MODAL_HTTP_ERROR",
        `Modal returned HTTP ${res.status}${serverCode ? ` (${serverCode})` : ""}.`,
        { httpStatus: res.status },
      );
    }
    // Unsigned error response — do NOT trust any header from it.
    throw new ModalContractError(
      "MODAL_HTTP_ERROR",
      `Modal returned HTTP ${res.status} with no signed-response headers; classifying as transport error.`,
      { httpStatus: res.status },
    );
  }

  // Success path — unchanged. Fail-closed on unsigned success.
  const parsedUnknown = verifyResponseSignature({
    headers: headerMap,
    bodyText: respText,
    expectedOperation: OPERATION_TRANSCRIBE,
    expectedRequestId: input.requestId,
    httpStatus: res.status,
    responseHmacKey: creds.responseHmacKey,
  });

  const body2 = asTranscribeBody(parsedUnknown, input.requestId);
  return body2;
}

function coerceServerCode(code: string | undefined): import("../modal-shared").ModalContractFailureCode | null {
  if (!code) return null;
  // Narrow to the known union. If the server returns anything else
  // we ignore it and fall through to `MODAL_HTTP_ERROR`.
  const KNOWN = new Set([
    "REQUEST_HMAC_INVALID",
    "REQUEST_BODY_INVALID",
    "TIMESTAMP_SKEW_EXCEEDED",
    "UNKNOWN_OPERATION",
    "OPERATION_MISMATCH",
    "CONTRACT_VERSION_MISMATCH",
    "ASCII_SCOPE_REQUIRED",
    "PILOT_AUTH_FINGERPRINT_MISMATCH",
    "PILOT_AUTH_EXPIRED",
    "PILOT_AUTH_OPERATION_MISMATCH",
    "PILOT_AUTH_SCHEMA_MISMATCH",
    "TENANT_MISMATCH",
    "COURSE_VERSION_MISMATCH",
    "VIDEO_SHA_MISMATCH_AT_BOUNDARY",
    "REPLAY_DETECTED",
    "REPLAY_STORE_UNAVAILABLE",
  ]);
  return KNOWN.has(code) ? (code as import("../modal-shared").ModalContractFailureCode) : null;
}

function asTranscribeBody(
  value: Readonly<Record<string, unknown>>,
  expectedRequestId: string,
): TranscribeResponseBody {
  if (value.contractVersion !== CONTRACT_VERSION) {
    throw new ModalContractError(
      "CONTRACT_VERSION_MISMATCH",
      `Response contractVersion is ${String(value.contractVersion)}.`,
    );
  }
  if (value.operation !== OPERATION_TRANSCRIBE) {
    throw new ModalContractError(
      "RESPONSE_OPERATION_MISMATCH",
      `Response body operation is ${String(value.operation)}.`,
    );
  }
  if (value.requestId !== expectedRequestId) {
    throw new ModalContractError(
      "RESPONSE_REQUEST_ID_MISMATCH",
      "Response body requestId does not match request.",
    );
  }
  if (typeof value.audioSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.audioSha256)) {
    throw new ModalContractError("MODAL_BODY_INVALID", "audioSha256 is not valid hex.");
  }
  if (!Array.isArray(value.segments)) {
    throw new ModalContractError("MODAL_BODY_INVALID", "segments is not an array.");
  }
  // elapsedMs shape is server-trusted but shape-checked.
  const elapsed = value.elapsedMs as Record<string, unknown> | undefined;
  if (!elapsed || typeof elapsed.coldBoot !== "number" || typeof elapsed.transcribe !== "number") {
    throw new ModalContractError("MODAL_BODY_INVALID", "elapsedMs shape invalid.");
  }
  return value as unknown as TranscribeResponseBody;
}

/**
 * Deterministic cost estimate. Preserves the EP-TRAIN-6D-4V formula.
 */
export function estimateTranscribeCostMicros(elapsedMsTotal: number): number {
  const hours = elapsedMsTotal / (3600 * 1000);
  const usd = hours * 1.95;
  return Math.ceil(usd * 1_000_000);
}

// Re-export the typed body so existing callers keep their imports.
export type { TranscribeResponseBody };
// Re-export the error class under its legacy name for a transition
// period; new code should prefer `ModalContractError`.
export { ModalContractError as ModalClientError } from "../modal-shared";
// Canonicalise is exported for cases where the caller needs to
// precompute a body digest (tests, diagnostics).
export { canonicalise };

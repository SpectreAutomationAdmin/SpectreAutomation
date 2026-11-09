// EP-TRAIN-4Y-W §4 (2026-11-09) — dedicated metadata Modal client.
//
// Replaces the 4Y-V qwen-metadata-client that repurposed the
// question-generation schema. This client speaks the new
// `spectre.training.metadata.v1` operation defined in
// types-metadata.ts: the response is `{title, description,
// sourceSegmentIds, elapsedMs, tokenCounts}` with no fake
// proposal/options wrapper.
//
// Transport: identical to the generate client — same HMAC headers,
// same response-signature verification. Modal-side implementation
// is a SEPARATE deploy slice; this file ships only the client +
// its contract, and is exercised by the offline test suite without
// a real socket.
//
// Idempotency: the (authorizationId, requestId) composite is unique
// per invocation (ALL `issuePilotAuthorization` calls produce a new
// authorizationId). A retry carries a fresh requestId so Modal's
// replay registry does NOT reject it as a duplicate.

import { randomBytes } from "node:crypto";
import {
  canonicalise,
  resolveModalCredentials,
  signRequest,
  verifyResponseSignature,
  CONTRACT_VERSION,
  SYSTEM_CLOCK,
  type Clock,
} from "../modal-shared";
import {
  MetadataContractError,
  OPERATION_METADATA,
  type MetadataPayload,
  type MetadataResponseBody,
  parseAndValidateMetadataResponse,
  METADATA_LIMITS,
} from "../modal-shared/types-metadata";
import type { PilotAuthorizationV1 } from "../modal-shared";

export interface MetadataClientInput {
  readonly pilotAuthorization: PilotAuthorizationV1;
  readonly systemPrompt: string;
  readonly transcript: string;
  readonly clubName?: string;
}

export interface MetadataClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
}

export async function callModalMetadata(
  input: MetadataClientInput,
  opts: MetadataClientOptions = {},
): Promise<MetadataResponseBody> {
  const clock = opts.clock ?? SYSTEM_CLOCK;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  // Reuse the generate credentials — same transport, same HMAC key.
  // When the Modal-side implementation lands it will be served at the
  // same endpoint, distinguished only by the signed `operation` field.
  let creds: ReturnType<typeof resolveModalCredentials>;
  try {
    // NOTE: resolveModalCredentials in modal-shared is keyed by the
    // existing OPERATION_GENERATE id today. When the Modal-side
    // metadata endpoint lands, this helper (or a sibling) will accept
    // OPERATION_METADATA. For this slice we fail-closed: without the
    // generate credentials present the metadata client refuses before
    // ever reaching the wire.
    const { OPERATION_GENERATE } = await import("../modal-shared");
    creds = resolveModalCredentials(OPERATION_GENERATE, opts.env ?? process.env);
  } catch (err) {
    throw new MetadataContractError(
      "CREDENTIAL_ABSENT",
      `Modal credentials missing: ${(err as Error)?.message ?? "unknown"}`,
    );
  }

  const requestId =
    `md-${input.pilotAuthorization.versionId}-${randomBytes(10).toString("hex")}`;
  const timestamp = String(Math.floor(clock.nowMs() / 1000));
  // Strip undefined fields so the canonicaliser never emits
  // `"clubName":undefined,` (which breaks JSON.parse round-trip).
  const constraints: MetadataPayload["constraints"] = {
    maxTitleLength: METADATA_LIMITS.TITLE_MAX_LEN,
    maxDescriptionLength: METADATA_LIMITS.DESCRIPTION_MAX_LEN,
    maxOutputTokens: METADATA_LIMITS.MAX_OUTPUT_TOKENS,
    ...(typeof input.clubName === "string" && input.clubName.length > 0
      ? { clubName: input.clubName }
      : {}),
  };
  const payload: MetadataPayload = {
    modelVariant: "qwen-2.5-7b-instruct-awq",
    systemPrompt: input.systemPrompt,
    transcript: input.transcript,
    constraints,
  };
  const body = {
    contractVersion: CONTRACT_VERSION,
    operation: OPERATION_METADATA,
    requestId,
    timestamp,
    pilotAuthorization: input.pilotAuthorization,
    payload,
  };

  const signed = signRequest({
    operation: OPERATION_METADATA,
    requestId,
    hmacKey: creds.requestHmacKey,
    body,
    clock,
    timestampOverrideSec: Number.parseInt(timestamp, 10),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10 * 60 * 1000);

  // EP-TRAIN-4Y-X §4 — the dedicated metadata endpoint is served
  // under `/metadata` of the same Modal app the generate route uses
  // (see modal_endpoints/generate_app.py Starlette routes). Append
  // the suffix to the base generate URL, respecting any existing
  // trailing slash.
  const metadataUrl =
    creds.endpointUrl.endsWith("/")
      ? `${creds.endpointUrl}metadata`
      : `${creds.endpointUrl}/metadata`;

  let res: Response;
  try {
    res = await fetchImpl(metadataUrl, {
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
      throw new MetadataContractError("MODAL_TIMEOUT", "Metadata request timed out.");
    }
    throw new MetadataContractError(
      "MODAL_HTTP_ERROR",
      `Metadata request transport failed: ${(err as Error)?.message ?? String(err)}`,
    );
  }
  clearTimeout(timer);

  const respText = await res.text();
  const headerMap: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headerMap[k.toLowerCase()] = v;
  });

  if (!res.ok) {
    // Only trust error codes when the response carries signed headers.
    const hasSignedHeaders =
      !!headerMap["x-spectre-response-signature"] &&
      !!headerMap["x-spectre-response-operation"] &&
      !!headerMap["x-spectre-response-request-id"] &&
      !!headerMap["x-spectre-contract-version"];
    if (hasSignedHeaders) {
      // Verify the signature even on error, so a tampered error body
      // cannot inject a misleading code.
      try {
        verifyResponseSignature({
          headers: headerMap,
          bodyText: respText,
          expectedOperation: OPERATION_METADATA,
          expectedRequestId: requestId,
          httpStatus: res.status,
          responseHmacKey: creds.responseHmacKey,
        });
      } catch {
        throw new MetadataContractError(
          "MODAL_HMAC_INVALID",
          "Response HMAC verification failed on error body.",
          { httpStatus: res.status },
        );
      }
      const serverCode = headerMap["x-spectre-failure-code"];
      throw new MetadataContractError(
        "MODAL_HTTP_ERROR",
        `Modal returned HTTP ${res.status}${serverCode ? ` (${serverCode})` : ""}.`,
        { httpStatus: res.status },
      );
    }
    throw new MetadataContractError(
      "MODAL_HTTP_ERROR",
      `Modal returned HTTP ${res.status} with no signed-response headers.`,
      { httpStatus: res.status },
    );
  }

  // Success path — enforce size, parse, validate, THEN verify HMAC.
  // The size+parse happens first so a malformed oversize response is
  // refused without computing HMAC over a potentially gigantic body.
  const parsedBody = parseAndValidateMetadataResponse(respText, requestId);
  try {
    verifyResponseSignature({
      headers: headerMap,
      bodyText: respText,
      expectedOperation: OPERATION_METADATA,
      expectedRequestId: requestId,
      httpStatus: res.status,
      responseHmacKey: creds.responseHmacKey,
    });
  } catch {
    throw new MetadataContractError(
      "MODAL_HMAC_INVALID",
      "Response HMAC verification failed on success body.",
      { httpStatus: res.status },
    );
  }
  return parsedBody;
}

export { canonicalise };

// EP-TRAIN-4Y-B-IMPL (2026-11-07) — Hybrid-contract Modal Qwen
// generate endpoint HTTP client. Supersedes the 4W Bearer-only
// client. Security envelope is symmetric to transcription; see the
// transcription client header comment for details.

import {
  canonicalise,
  resolveModalCredentials,
  signRequest,
  verifyResponseSignature,
  CONTRACT_VERSION,
  OPERATION_GENERATE,
  SYSTEM_CLOCK,
  ModalContractError,
  type Clock,
  type GeneratePayload,
  type GenerateResponseBody,
  type ModalRequestBody,
  type PilotAuthorizationV1,
} from "../modal-shared";

export const PROPOSAL_SCHEMA_VERSION = "training-proposals-v1" as const;

export interface ModalGenerateInput {
  readonly requestId: string;
  readonly pilotAuthorization: PilotAuthorizationV1;
  readonly modelVariant: string;
  readonly systemPrompt: string;
  readonly transcript: string;
  readonly constraints: GeneratePayload["constraints"];
}

export interface ModalGenerateClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
}

export async function callModalGenerate(
  input: ModalGenerateInput,
  opts: ModalGenerateClientOptions = {},
): Promise<GenerateResponseBody> {
  const clock = opts.clock ?? SYSTEM_CLOCK;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const creds = resolveModalCredentials(OPERATION_GENERATE, opts.env ?? process.env);

  const timestamp = String(Math.floor(clock.nowMs() / 1000));
  const payload: GeneratePayload = {
    modelVariant: input.modelVariant,
    systemPrompt: input.systemPrompt,
    transcript: input.transcript,
    constraints: input.constraints,
  };
  const body: ModalRequestBody<GeneratePayload> = {
    contractVersion: CONTRACT_VERSION,
    operation: OPERATION_GENERATE,
    requestId: input.requestId,
    timestamp,
    pilotAuthorization: input.pilotAuthorization,
    payload,
  };

  const signed = signRequest({
    operation: OPERATION_GENERATE,
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
      throw new ModalContractError("MODAL_TIMEOUT", "Modal generate request timed out.");
    }
    throw new ModalContractError(
      "MODAL_HTTP_ERROR",
      `Modal generate request failed: ${(err as Error)?.message ?? String(err)}`,
    );
  }
  clearTimeout(timer);

  const respText = await res.text();

  if (!res.ok) {
    const serverCode = res.headers.get("x-spectre-failure-code") ?? undefined;
    throw new ModalContractError(
      coerceServerCode(serverCode) ?? "MODAL_HTTP_ERROR",
      `Modal returned HTTP ${res.status}${serverCode ? ` (${serverCode})` : ""}.`,
      { httpStatus: res.status },
    );
  }

  const headerMap: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headerMap[k.toLowerCase()] = v;
  });
  const parsed = verifyResponseSignature({
    headers: headerMap,
    bodyText: respText,
    expectedOperation: OPERATION_GENERATE,
    expectedRequestId: input.requestId,
    httpStatus: res.status,
    responseHmacKey: creds.responseHmacKey,
  });

  return asGenerateBody(parsed, input.requestId);
}

function coerceServerCode(code: string | undefined): import("../modal-shared").ModalContractFailureCode | null {
  if (!code) return null;
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

function asGenerateBody(
  value: Readonly<Record<string, unknown>>,
  expectedRequestId: string,
): GenerateResponseBody {
  if (value.contractVersion !== CONTRACT_VERSION) {
    throw new ModalContractError(
      "CONTRACT_VERSION_MISMATCH",
      `Response contractVersion is ${String(value.contractVersion)}.`,
    );
  }
  if (value.operation !== OPERATION_GENERATE) {
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
  if (!Array.isArray(value.proposals)) {
    throw new ModalContractError("MODAL_BODY_INVALID", "proposals is not an array.");
  }
  for (const p of value.proposals as readonly unknown[]) {
    if (!p || typeof p !== "object") {
      throw new ModalContractError("MODAL_BODY_INVALID", "proposal shape invalid.");
    }
    const pp = p as Record<string, unknown>;
    if (
      typeof pp.questionText !== "string" ||
      !Array.isArray(pp.options) ||
      !Array.isArray(pp.sourceSegmentIds)
    ) {
      throw new ModalContractError("MODAL_BODY_INVALID", "proposal field shape invalid.");
    }
  }
  const elapsed = value.elapsedMs as Record<string, unknown> | undefined;
  if (!elapsed || typeof elapsed.coldBoot !== "number" || typeof elapsed.generate !== "number") {
    throw new ModalContractError("MODAL_BODY_INVALID", "elapsedMs shape invalid.");
  }
  const tokens = value.tokenCounts as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens.prompt !== "number" || typeof tokens.output !== "number") {
    throw new ModalContractError("MODAL_BODY_INVALID", "tokenCounts shape invalid.");
  }
  return value as unknown as GenerateResponseBody;
}

// Legacy-name re-exports for callers mid-migration.
export type { GenerateResponseBody as ModalGenerateResponse };
export type ModalGenerateProposal = GenerateResponseBody["proposals"][number];
export { ModalContractError as ModalGenerateClientError } from "../modal-shared";
export { canonicalise };

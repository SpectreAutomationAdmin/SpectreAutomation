// EP-TRAIN-6D-4V (2026-11-06) — Modal faster-whisper HTTP client.
//
// Thin HTTPS adapter for the Modal transcription endpoint specified
// in docs/ep-train-6a-audit.md §B.2. The client is isolated here so
// tests can mock `fetch` without reaching into the worker handler.
//
// This slice does NOT invoke Modal. The client is defined so the
// worker handler (and tests) have a stable contract to call against;
// a separate (post-authorization) slice flips the activation flag.
//
// Security (directive §5 + §8):
//   - Bearer token auth via MODAL_SPECTRE_SHARED_TOKEN.
//   - HMAC-SHA-256 verification of the response using the same token.
//   - Fail-closed on missing credentials.
//   - No credential ever reaches logs.
//   - Bounded wall-clock via AbortController.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface ModalTranscribeRequest {
  readonly requestId: string;                // cuid, used for idempotency logging
  readonly audioUrl: string;                 // short-lived signed URL
  readonly languageCode: string;             // e.g. "en"
  readonly modelVariant: string;             // e.g. "faster-whisper-large-v3"
  readonly schemaVersion: "transcribe-v1";
}

export interface ModalTranscribeSegment {
  readonly id: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  readonly avgConfidence: number;
}

export interface ModalTranscribeResponse {
  readonly schemaVersion: "transcribe-v1";
  readonly modelVariant: string;
  readonly durationSec: number;
  readonly segments: readonly ModalTranscribeSegment[];
  readonly elapsedMs: {
    readonly coldBoot: number;
    readonly transcribe: number;
  };
  /** Server-computed SHA-256 of the audio bytes read by Modal. Spectre
   *  compares this against the stored videoSha256. Required for the
   *  SHA_MISMATCH gate. */
  readonly audioSha256: string;
}

export class ModalClientError extends Error {
  readonly code: "MODAL_HTTP_ERROR" | "MODAL_TIMEOUT" | "MODAL_HMAC_INVALID" | "MODAL_BODY_INVALID" | "CREDENTIAL_ABSENT";
  constructor(code: ModalClientError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface ModalClientOptions {
  /** Injected for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Wall-clock timeout in ms. */
  readonly timeoutMs?: number;
}

/**
 * Call the Modal `/transcribe` endpoint. Mocked in tests via
 * `fetchImpl`. Does NOT reach the network in offline builds.
 */
export async function callModalTranscribe(
  request: ModalTranscribeRequest,
  opts: ModalClientOptions = {},
): Promise<ModalTranscribeResponse> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const url = env.MODAL_TRANSCRIBE_URL;
  const token = env.MODAL_SPECTRE_SHARED_TOKEN;

  if (!url || !token) {
    throw new ModalClientError(
      "CREDENTIAL_ABSENT",
      "Modal credentials not configured in environment.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10 * 60 * 1000);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error)?.name === "AbortError") {
      throw new ModalClientError("MODAL_TIMEOUT", "Modal request timed out.");
    }
    throw new ModalClientError(
      "MODAL_HTTP_ERROR",
      `Modal request failed: ${(err as Error)?.message ?? String(err)}`,
    );
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new ModalClientError(
      "MODAL_HTTP_ERROR",
      `Modal returned HTTP ${res.status}.`,
    );
  }

  // Verify HMAC of the body before trusting any field. The Modal
  // function signs `body` with the shared token and ships the signature
  // in the `X-Spectre-Signature` header (base-64 encoded).
  const bodyText = await res.text();
  const signatureHeader = res.headers.get("x-spectre-signature");
  if (!signatureHeader) {
    throw new ModalClientError(
      "MODAL_HMAC_INVALID",
      "Modal response is missing the HMAC signature header.",
    );
  }
  const expected = createHmac("sha256", token).update(bodyText, "utf-8").digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signatureHeader, "base64");
  } catch {
    throw new ModalClientError("MODAL_HMAC_INVALID", "Modal response HMAC is not valid base64.");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ModalClientError("MODAL_HMAC_INVALID", "Modal response HMAC did not verify.");
  }

  let body: ModalTranscribeResponse;
  try {
    body = JSON.parse(bodyText) as ModalTranscribeResponse;
  } catch {
    throw new ModalClientError("MODAL_BODY_INVALID", "Modal response body is not valid JSON.");
  }
  if (body.schemaVersion !== "transcribe-v1") {
    throw new ModalClientError(
      "MODAL_BODY_INVALID",
      `Unexpected schemaVersion: ${body.schemaVersion}`,
    );
  }
  if (!Array.isArray(body.segments)) {
    throw new ModalClientError("MODAL_BODY_INVALID", "Modal response segments is not an array.");
  }
  if (typeof body.audioSha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.audioSha256)) {
    throw new ModalClientError("MODAL_BODY_INVALID", "Modal response audioSha256 is not valid hex.");
  }
  return body;
}

/**
 * Deterministic cost estimate for a transcribe call. The $1.95/hr
 * L40S rate from EP-TRAIN-6A audit §A.2. Returns micros.
 *
 * Isolated here so tests can pin the exact formula.
 */
export function estimateTranscribeCostMicros(elapsedMsTotal: number): number {
  const hours = elapsedMsTotal / (3600 * 1000);
  const usd = hours * 1.95;
  return Math.ceil(usd * 1_000_000);
}

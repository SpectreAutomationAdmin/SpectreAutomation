// EP-TRAIN-6D-4V — Modal client contract tests with fully mocked fetch.
//
// The client is the ONLY surface that reaches the Modal network. In
// 4V offline scope, zero real Modal calls happen. Tests mock `fetch`
// and verify every boundary: credential fail-closed, HMAC check,
// response-shape validation, timeout handling.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  callModalTranscribe,
  estimateTranscribeCostMicros,
  ModalClientError,
} from "@/lib/hr/training/transcription/modal-client";

const URL = "https://modal.example/transcribe";
const TOKEN = "shared-secret-token-not-real";

function signedResponse(body: Record<string, unknown>): Response {
  const bodyText = JSON.stringify(body);
  const sig = createHmac("sha256", TOKEN).update(bodyText, "utf-8").digest("base64");
  return new Response(bodyText, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-spectre-signature": sig,
    },
  });
}

const GOOD_BODY = {
  schemaVersion: "transcribe-v1" as const,
  modelVariant: "faster-whisper-large-v3",
  durationSec: 120,
  segments: [
    { id: 0, startSec: 0, endSec: 60, text: "part one", avgConfidence: 0.95 },
    { id: 1, startSec: 60, endSec: 120, text: "part two", avgConfidence: 0.93 },
  ],
  elapsedMs: { coldBoot: 5000, transcribe: 55000 },
  audioSha256: "a".repeat(64),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EP-TRAIN-6D-4V — Modal client", () => {
  it("fail-closed when credentials absent", async () => {
    await expect(
      callModalTranscribe(
        { requestId: "x", audioUrl: "https://x", languageCode: "en", modelVariant: "x", schemaVersion: "transcribe-v1" },
        { env: {} },
      ),
    ).rejects.toMatchObject({ code: "CREDENTIAL_ABSENT" });
  });

  it("happy path returns a verified body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(signedResponse(GOOD_BODY));
    const r = await callModalTranscribe(
      { requestId: "x", audioUrl: "https://x", languageCode: "en", modelVariant: "x", schemaVersion: "transcribe-v1" },
      { env: { MODAL_TRANSCRIBE_URL: URL, MODAL_SPECTRE_SHARED_TOKEN: TOKEN }, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(r.modelVariant).toBe("faster-whisper-large-v3");
    expect(r.segments.length).toBe(2);
    expect(r.audioSha256).toBe("a".repeat(64));
  });

  it("non-2xx -> MODAL_HTTP_ERROR", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 502 }));
    await expect(
      callModalTranscribe(
        { requestId: "x", audioUrl: "https://x", languageCode: "en", modelVariant: "x", schemaVersion: "transcribe-v1" },
        { env: { MODAL_TRANSCRIBE_URL: URL, MODAL_SPECTRE_SHARED_TOKEN: TOKEN }, fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "MODAL_HTTP_ERROR" });
  });

  it("missing HMAC header -> MODAL_HMAC_INVALID", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(GOOD_BODY), { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(
      callModalTranscribe(
        { requestId: "x", audioUrl: "https://x", languageCode: "en", modelVariant: "x", schemaVersion: "transcribe-v1" },
        { env: { MODAL_TRANSCRIBE_URL: URL, MODAL_SPECTRE_SHARED_TOKEN: TOKEN }, fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "MODAL_HMAC_INVALID" });
  });

  it("wrong HMAC -> MODAL_HMAC_INVALID (constant-time compare rejects)", async () => {
    const bodyText = JSON.stringify(GOOD_BODY);
    const wrongSig = createHmac("sha256", "wrong-token").update(bodyText).digest("base64");
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(bodyText, {
        status: 200,
        headers: { "content-type": "application/json", "x-spectre-signature": wrongSig },
      }),
    );
    await expect(
      callModalTranscribe(
        { requestId: "x", audioUrl: "https://x", languageCode: "en", modelVariant: "x", schemaVersion: "transcribe-v1" },
        { env: { MODAL_TRANSCRIBE_URL: URL, MODAL_SPECTRE_SHARED_TOKEN: TOKEN }, fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "MODAL_HMAC_INVALID" });
  });

  it("wrong schemaVersion -> MODAL_BODY_INVALID", async () => {
    const bad = { ...GOOD_BODY, schemaVersion: "transcribe-v2" };
    const fetchImpl = vi.fn().mockResolvedValue(signedResponse(bad));
    await expect(
      callModalTranscribe(
        { requestId: "x", audioUrl: "https://x", languageCode: "en", modelVariant: "x", schemaVersion: "transcribe-v1" },
        { env: { MODAL_TRANSCRIBE_URL: URL, MODAL_SPECTRE_SHARED_TOKEN: TOKEN }, fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "MODAL_BODY_INVALID" });
  });

  it("missing audioSha256 -> MODAL_BODY_INVALID", async () => {
    const bad = { ...GOOD_BODY, audioSha256: "not-hex" };
    const fetchImpl = vi.fn().mockResolvedValue(signedResponse(bad));
    await expect(
      callModalTranscribe(
        { requestId: "x", audioUrl: "https://x", languageCode: "en", modelVariant: "x", schemaVersion: "transcribe-v1" },
        { env: { MODAL_TRANSCRIBE_URL: URL, MODAL_SPECTRE_SHARED_TOKEN: TOKEN }, fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "MODAL_BODY_INVALID" });
  });

  it("abort / timeout -> MODAL_TIMEOUT", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      // Simulate abort by throwing an AbortError when the signal aborts.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          (e as Error & { name: string }).name = "AbortError";
          reject(e);
        });
      });
    });
    await expect(
      callModalTranscribe(
        { requestId: "x", audioUrl: "https://x", languageCode: "en", modelVariant: "x", schemaVersion: "transcribe-v1" },
        { env: { MODAL_TRANSCRIBE_URL: URL, MODAL_SPECTRE_SHARED_TOKEN: TOKEN }, fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 20 },
      ),
    ).rejects.toMatchObject({ code: "MODAL_TIMEOUT" });
  });

  it("estimateTranscribeCostMicros math is stable", () => {
    // 10 min = 600_000 ms → 10/60 hr × $1.95 = $0.325 = 325_000 micros
    // ceil applied.
    expect(estimateTranscribeCostMicros(600_000)).toBe(325_000);
    // 60 min = $1.95 = 1_950_000 micros
    expect(estimateTranscribeCostMicros(3_600_000)).toBe(1_950_000);
  });
});

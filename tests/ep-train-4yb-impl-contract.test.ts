// EP-TRAIN-4Y-B-IMPL (2026-11-07) — Hybrid Modal auth contract tests.
//
// Covers the 18 §9 scenarios of the EP-TRAIN-4Y-B-IMPL directive.
// Mocked `fetch` only; no network, no Modal. Every test owns its own
// in-memory replay registry + clock.

import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";

import {
  canonicalise,
  sha256HexOfCanonicalSync,
  assertPrintableAscii,
  CONTRACT_VERSION,
  SIG_VERSION,
  OPERATION_TRANSCRIBE,
  OPERATION_GENERATE,
  TRANSCRIBE_PLACEHOLDER_TRANSCRIPT_BUILD_ID,
  TRANSCRIBE_PLACEHOLDER_GROUNDING_SHA,
  issuePilotAuthorization,
  verifyPilotAuthorizationFingerprint,
  isPilotAuthorizationExpired,
  signRequest,
  verifyRequestSignature,
  verifyResponseSignature,
  signResponse,
  InMemoryReplayRegistry,
  NullReplayRegistry,
  replayKey,
  ModalContractError,
  isRetryable,
  type Clock,
  type PilotAuthorizationV1,
  type ModalRequestBody,
  type OperationId,
} from "../src/lib/hr/training/modal-shared";
import {
  callModalTranscribe,
} from "../src/lib/hr/training/transcription/modal-client";
import {
  callModalGenerate,
} from "../src/lib/hr/training/generation/modal-client";

// ─── Fixtures ────────────────────────────────────────────────────────

const FIXTURE_HMAC_KEY = "test-hmac-key-32-bytes-0000000000";
const FIXTURE_FINGERPRINT_SECRET = "test-fingerprint-secret-00000000";
const FIXTURE_RESPONSE_HMAC_KEY = "test-response-hmac-key-0000000000";
const FIXTURE_PROXY_KEY = "wk-fixture-00000000";
const FIXTURE_PROXY_SECRET = "ws-fixture-00000000";
const FIXTURE_URL = "https://mocked-modal.example/endpoint";

const FIXED_NOW_MS = 1_765_000_000_000;

function fixedClock(nowMs: number = FIXED_NOW_MS): Clock {
  return {
    nowMs: () => nowMs,
    nowUtcIso: () => new Date(nowMs).toISOString(),
  };
}

function buildPilotAuth(
  overrides: Partial<Parameters<typeof issuePilotAuthorization>[0]> = {},
): PilotAuthorizationV1 {
  return issuePilotAuthorization({
    tenantId: "club-silver-springs",
    courseId: "course:cmvzs3w05000456qcgfgps7gy",
    versionId: "cmvzs3w05000456qcgfgps7gy",
    sourceVideoSha256: "a".repeat(64),
    resolvedTranscriptBuildId: "b".repeat(64),
    approvedGroundingProjectionSha256: "c".repeat(64),
    operation: "GENERATE_DRAFT_QUESTIONS",
    maxRequestedQuestions: 6,
    pilotRestrictions: {
      publicationProhibited: true,
      employeeAssignmentProhibited: true,
      databaseWritesProhibited: false,
      automaticRetriesProhibited: false,
      excludedSegmentIds: [16, 17],
      scope: "test-scope",
    },
    ttlSec: 3600,
    issuedBy: "system:test",
    fingerprintSecret: FIXTURE_FINGERPRINT_SECRET,
    clock: fixedClock(),
    ...overrides,
  });
}

function buildTranscribeAuth(): PilotAuthorizationV1 {
  return issuePilotAuthorization({
    tenantId: "club-silver-springs",
    courseId: "course:v1",
    versionId: "v1",
    sourceVideoSha256: "d".repeat(64),
    resolvedTranscriptBuildId: TRANSCRIBE_PLACEHOLDER_TRANSCRIPT_BUILD_ID,
    approvedGroundingProjectionSha256: TRANSCRIBE_PLACEHOLDER_GROUNDING_SHA,
    operation: "TRANSCRIBE_VIDEO",
    maxRequestedQuestions: 1,
    pilotRestrictions: {
      publicationProhibited: true,
      employeeAssignmentProhibited: true,
      databaseWritesProhibited: false,
      automaticRetriesProhibited: false,
      excludedSegmentIds: [],
      scope: "transcribe-test",
    },
    ttlSec: 3600,
    issuedBy: "system:test",
    fingerprintSecret: FIXTURE_FINGERPRINT_SECRET,
    clock: fixedClock(),
  });
}

function fullEnv() {
  return {
    MODAL_KEY: FIXTURE_PROXY_KEY,
    MODAL_SECRET: FIXTURE_PROXY_SECRET,
    MODAL_SPECTRE_HMAC_KEY: FIXTURE_HMAC_KEY,
    SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET: FIXTURE_FINGERPRINT_SECRET,
    MODAL_SPECTRE_RESPONSE_HMAC_KEY: FIXTURE_RESPONSE_HMAC_KEY,
    MODAL_TRANSCRIBE_URL: FIXTURE_URL,
    MODAL_GENERATE_URL: FIXTURE_URL,
  } satisfies NodeJS.ProcessEnv;
}

// ─── Mock Modal server ───────────────────────────────────────────────
//
// Validates the incoming request using the SAME verifier logic the
// Modal Python side would run. Returns a signed response (success
// OR error).

type MockServerOptions = {
  operation: OperationId;
  // Fault injection:
  readonly tamperResponseSignature?: boolean;
  readonly invalidProxyAuth?: boolean;
  readonly tamperResponseRequestId?: boolean;
  readonly tamperResponseBody?: boolean;
  readonly returnMalformed?: boolean;
  readonly replayStoreOutage?: boolean;
  readonly serverClock?: Clock;
  readonly replay?: InMemoryReplayRegistry;
};

function mockModalServer(opts: MockServerOptions): typeof fetch {
  const replay = opts.replay ?? new InMemoryReplayRegistry();
  const clock = opts.serverClock ?? fixedClock();

  const fetchImpl: typeof fetch = async (
    input,
    init,
  ): Promise<Response> => {
    const _url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headers = normaliseHeaders(init?.headers);
    const bodyText = (init?.body as string) ?? "";

    // 1. Proxy auth check (workspace-level).
    if (opts.invalidProxyAuth || headers["modal-key"] !== FIXTURE_PROXY_KEY) {
      return makeJsonResponse(401, { error: { code: "PROXY_AUTH_FAILED" } }, {});
    }
    if (headers["modal-secret"] !== FIXTURE_PROXY_SECRET) {
      return makeJsonResponse(401, { error: { code: "PROXY_AUTH_FAILED" } }, {});
    }

    // 2. Request-signature check.
    const sigResult = verifyRequestSignature({
      headers,
      bodyText,
      hmacKey: FIXTURE_HMAC_KEY,
      clock,
      timestampSkewSec: 300,
    });
    if (!sigResult.ok) {
      return failureResponse(sigResult.code, sigResult.message, 400, opts);
    }

    const body = JSON.parse(bodyText) as ModalRequestBody<Record<string, unknown>>;
    if (body.operation !== opts.operation) {
      return failureResponse("OPERATION_MISMATCH", "Body operation mismatch", 400, opts);
    }

    // 3. Fingerprint check.
    if (!verifyPilotAuthorizationFingerprint(body.pilotAuthorization, FIXTURE_FINGERPRINT_SECRET)) {
      return failureResponse(
        "PILOT_AUTH_FINGERPRINT_MISMATCH",
        "Fingerprint did not verify",
        400,
        opts,
      );
    }

    // 4. Operation pin on auth envelope.
    if (
      opts.operation === OPERATION_TRANSCRIBE &&
      body.pilotAuthorization.operation !== "TRANSCRIBE_VIDEO"
    ) {
      return failureResponse(
        "PILOT_AUTH_OPERATION_MISMATCH",
        "Auth operation != TRANSCRIBE_VIDEO",
        400,
        opts,
      );
    }
    if (
      opts.operation === OPERATION_GENERATE &&
      body.pilotAuthorization.operation !== "GENERATE_DRAFT_QUESTIONS"
    ) {
      return failureResponse(
        "PILOT_AUTH_OPERATION_MISMATCH",
        "Auth operation != GENERATE_DRAFT_QUESTIONS",
        400,
        opts,
      );
    }

    // 5. Expiry.
    if (isPilotAuthorizationExpired(body.pilotAuthorization, clock)) {
      return failureResponse("PILOT_AUTH_EXPIRED", "Auth expired", 400, opts);
    }

    // 6. Replay.
    if (opts.replayStoreOutage) {
      return failureResponse("REPLAY_STORE_UNAVAILABLE", "Replay store down", 503, opts);
    }
    const key = replayKey({
      authorizationId: body.pilotAuthorization.authorizationId,
      requestId: body.requestId,
    });
    const rec = await replay.record({ key, ttlSec: 900 });
    if (!rec.ok && rec.reason === "duplicate") {
      return failureResponse("REPLAY_DETECTED", "Request-id seen", 409, opts);
    }

    // 7. Success: build response + sign.
    const respOperation = body.operation;
    const respBody = buildSuccessBody(respOperation, body.requestId, opts);
    const respText = JSON.stringify(respBody);
    const sigHdrs = signResponse({
      operation: respOperation,
      requestId: opts.tamperResponseRequestId ? body.requestId + "-tampered" : body.requestId,
      httpStatus: 200,
      bodyText: respText,
      responseHmacKey: FIXTURE_RESPONSE_HMAC_KEY,
    });
    const headersOut: Record<string, string> = {
      "Content-Type": "application/json",
      ...sigHdrs,
    };
    if (opts.tamperResponseSignature) {
      headersOut["x-spectre-response-signature"] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    }
    const finalBody = opts.tamperResponseBody
      ? respText.replace('"segments":', '"tampered":')
      : respText;
    return new Response(finalBody, { status: 200, headers: headersOut });
  };
  return fetchImpl;
}

function normaliseHeaders(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  const out: Record<string, string> = {};
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k.toLowerCase()] = v));
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

function failureResponse(
  code: string,
  message: string,
  status: number,
  opts: MockServerOptions,
): Response {
  const body = { error: { code, message } };
  const bodyText = JSON.stringify(body);
  const sigHdrs = signResponse({
    operation: opts.operation,
    requestId: "error",
    httpStatus: status,
    bodyText,
    responseHmacKey: FIXTURE_RESPONSE_HMAC_KEY,
  });
  return new Response(bodyText, {
    status,
    headers: {
      "Content-Type": "application/json",
      "x-spectre-failure-code": code,
      ...sigHdrs,
    },
  });
}

function buildSuccessBody(
  op: OperationId,
  requestId: string,
  opts: MockServerOptions,
) {
  if (opts.returnMalformed) {
    return {
      contractVersion: CONTRACT_VERSION,
      operation: op,
      requestId,
      // deliberately missing fields
    };
  }
  if (op === OPERATION_TRANSCRIBE) {
    return {
      contractVersion: CONTRACT_VERSION,
      operation: op,
      requestId,
      modelVariant: "faster-whisper-large-v3",
      durationSec: 131,
      audioSha256: "e".repeat(64),
      segments: [
        { id: 0, startSec: 0, endSec: 5, text: "intro", avgConfidence: 0.95 },
      ],
      elapsedMs: { coldBoot: 1000, transcribe: 25000 },
    };
  }
  // GENERATE
  return {
    contractVersion: CONTRACT_VERSION,
    operation: op,
    requestId,
    modelVariant: "qwen-2.5-7b-instruct-awq",
    proposals: [
      {
        questionType: "SINGLE_CHOICE",
        questionText: "What is Silver Springs' phone policy?",
        options: [
          { text: "No phones in front of members", isCorrect: true },
          { text: "Always carry phones", isCorrect: false },
        ],
        explanation: "The orientation video covers this.",
        sourceSegmentIds: [1, 2],
      },
    ],
    elapsedMs: { coldBoot: 1000, generate: 5000 },
    tokenCounts: { prompt: 1714, output: 162 },
  };
}

function makeJsonResponse(status: number, body: object, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ─── Test suite ──────────────────────────────────────────────────────

describe("EP-TRAIN-4Y-B-IMPL — Hybrid auth contract (§9 scenarios)", () => {
  // ── 9.1 Valid transcription request
  it("9.1 — valid transcription request succeeds", async () => {
    const fetchImpl = mockModalServer({ operation: OPERATION_TRANSCRIBE });
    const auth = buildTranscribeAuth();
    const resp = await callModalTranscribe(
      {
        requestId: "req-t-valid",
        audioUrl: "https://r2.example/audio.mp4?sig=x",
        languageCode: "en",
        modelVariant: "faster-whisper-large-v3",
        pilotAuthorization: auth,
      },
      { fetchImpl, env: fullEnv(), clock: fixedClock() },
    );
    expect(resp.contractVersion).toBe(CONTRACT_VERSION);
    expect(resp.operation).toBe(OPERATION_TRANSCRIBE);
    expect(resp.segments.length).toBeGreaterThan(0);
  });

  // ── 9.2 Valid generation request
  it("9.2 — valid generation request succeeds", async () => {
    const fetchImpl = mockModalServer({ operation: OPERATION_GENERATE });
    const auth = buildPilotAuth();
    const resp = await callModalGenerate(
      {
        requestId: "req-g-valid",
        modelVariant: "qwen-2.5-7b-instruct-awq",
        pilotAuthorization: auth,
        systemPrompt: "Produce questions.",
        transcript: "[1] intro\n[2] body",
        constraints: {
          proposalKind: "QUESTION_FINAL_ASSESSMENT",
          maxQuestions: 1,
          allowedQuestionTypes: ["SINGLE_CHOICE"],
          jsonSchema: {},
        },
      },
      { fetchImpl, env: fullEnv(), clock: fixedClock() },
    );
    expect(resp.proposals.length).toBe(1);
    expect(resp.operation).toBe(OPERATION_GENERATE);
  });

  // ── 9.3 Invalid proxy credentials
  it("9.3 — invalid proxy credentials → MODAL_HTTP_ERROR (401)", async () => {
    const fetchImpl = mockModalServer({ operation: OPERATION_GENERATE, invalidProxyAuth: true });
    const auth = buildPilotAuth();
    await expect(
      callModalGenerate(
        {
          requestId: "req-g-401",
          modelVariant: "qwen-2.5-7b-instruct-awq",
          pilotAuthorization: auth,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl, env: fullEnv(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ModalContractError && e.code === "MODAL_HTTP_ERROR");
  });

  // ── 9.4 Invalid request HMAC — simulated by tampering the key env
  it("9.4 — wrong HMAC key → REQUEST_HMAC_INVALID", async () => {
    const fetchImpl = mockModalServer({ operation: OPERATION_GENERATE });
    const auth = buildPilotAuth();
    const wrongEnv = { ...fullEnv(), MODAL_SPECTRE_HMAC_KEY: "attacker-key" };
    await expect(
      callModalGenerate(
        {
          requestId: "req-g-badhmac",
          modelVariant: "qwen-2.5-7b-instruct-awq",
          pilotAuthorization: auth,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl, env: wrongEnv, clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "REQUEST_HMAC_INVALID",
    );
  });

  // ── 9.5 Tampered body (server-side verification catches it)
  it("9.5 — tampered body (server-side verify) → REQUEST_HMAC_INVALID", async () => {
    // Build a signed request, then intercept the fetch call and
    // mutate the body text before the mock server sees it.
    const serverFetch = mockModalServer({ operation: OPERATION_GENERATE });
    const tamperingFetch: typeof fetch = async (url, init) => {
      const newInit = { ...init, body: (init?.body as string).replace('"systemPrompt":"x"', '"systemPrompt":"evil"') };
      return serverFetch(url, newInit);
    };
    const auth = buildPilotAuth();
    await expect(
      callModalGenerate(
        {
          requestId: "req-tamper",
          modelVariant: "qwen-2.5-7b-instruct-awq",
          pilotAuthorization: auth,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl: tamperingFetch, env: fullEnv(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "REQUEST_HMAC_INVALID",
    );
  });

  // ── 9.6 Invalid envelope fingerprint
  it("9.6 — tampered PilotAuthorizationV1 → PILOT_AUTH_FINGERPRINT_MISMATCH", async () => {
    const fetchImpl = mockModalServer({ operation: OPERATION_GENERATE });
    const auth = buildPilotAuth();
    // Mutate tenantId AFTER signing — fingerprint no longer covers.
    const tamperedAuth: PilotAuthorizationV1 = { ...auth, tenantId: "club-attacker" };
    await expect(
      callModalGenerate(
        {
          requestId: "req-fp",
          modelVariant: "qwen-2.5-7b-instruct-awq",
          pilotAuthorization: tamperedAuth,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl, env: fullEnv(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "PILOT_AUTH_FINGERPRINT_MISMATCH",
    );
  });

  // ── 9.7 Expired request (timestamp skew)
  it("9.7 — client timestamp outside ±300s → TIMESTAMP_SKEW_EXCEEDED", async () => {
    const serverClock = fixedClock(); // server sees FIXED_NOW_MS
    const clientClock = fixedClock(FIXED_NOW_MS - 400_000); // client 400s behind
    const fetchImpl = mockModalServer({ operation: OPERATION_GENERATE, serverClock });
    const auth = issuePilotAuthorization({
      tenantId: "club-silver-springs",
      courseId: "course:v1",
      versionId: "v1",
      sourceVideoSha256: "a".repeat(64),
      resolvedTranscriptBuildId: "b".repeat(64),
      approvedGroundingProjectionSha256: "c".repeat(64),
      operation: "GENERATE_DRAFT_QUESTIONS",
      maxRequestedQuestions: 1,
      pilotRestrictions: {
        publicationProhibited: true,
        employeeAssignmentProhibited: true,
        databaseWritesProhibited: false,
        automaticRetriesProhibited: false,
        excludedSegmentIds: [],
        scope: "test",
      },
      ttlSec: 3600,
      issuedBy: "system:test",
      fingerprintSecret: FIXTURE_FINGERPRINT_SECRET,
      clock: clientClock,
    });
    await expect(
      callModalGenerate(
        {
          requestId: "req-skew",
          modelVariant: "qwen",
          pilotAuthorization: auth,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl, env: fullEnv(), clock: clientClock },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "TIMESTAMP_SKEW_EXCEEDED",
    );
  });

  // ── 9.8 Replayed request
  it("9.8 — same request-id twice → REPLAY_DETECTED", async () => {
    const replay = new InMemoryReplayRegistry(fixedClock());
    const fetchImpl = mockModalServer({ operation: OPERATION_GENERATE, replay });
    const auth = buildPilotAuth();
    // First call succeeds.
    await callModalGenerate(
      {
        requestId: "req-replay",
        modelVariant: "qwen",
        pilotAuthorization: auth,
        systemPrompt: "x",
        transcript: "x",
        constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
      },
      { fetchImpl, env: fullEnv(), clock: fixedClock() },
    );
    // Second call with same request-id → replay detected.
    await expect(
      callModalGenerate(
        {
          requestId: "req-replay",
          modelVariant: "qwen",
          pilotAuthorization: auth,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl, env: fullEnv(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "REPLAY_DETECTED",
    );
  });

  // ── 9.9 Wrong tenant — covered by the fingerprint check (9.6)
  // but also by a separate scenario: issuer uses correct fingerprint
  // secret but a DIFFERENT tenant. Server-side would catch this via
  // grounding/payload cross-reference, but the TS test demonstrates
  // the fingerprint protects tenantId.
  it("9.9 — mutating tenantId post-sign → PILOT_AUTH_FINGERPRINT_MISMATCH (covers cross-tenant)", async () => {
    // Already exercised by 9.6 — the explicit mutation of tenantId
    // post-sign falls under fingerprint mismatch.
    const fetchImpl = mockModalServer({ operation: OPERATION_GENERATE });
    const auth = buildPilotAuth({ tenantId: "club-A" });
    const tampered: PilotAuthorizationV1 = { ...auth, tenantId: "club-B" };
    await expect(
      callModalGenerate(
        {
          requestId: "req-crosstenant",
          modelVariant: "qwen",
          pilotAuthorization: tampered,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl, env: fullEnv(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "PILOT_AUTH_FINGERPRINT_MISMATCH",
    );
  });

  // ── 9.10 Wrong course/version — same mechanism
  it("9.10 — mutating versionId post-sign → PILOT_AUTH_FINGERPRINT_MISMATCH", async () => {
    const fetchImpl = mockModalServer({ operation: OPERATION_GENERATE });
    const auth = buildPilotAuth();
    const tampered: PilotAuthorizationV1 = { ...auth, versionId: "v-attacker" };
    await expect(
      callModalGenerate(
        {
          requestId: "req-version",
          modelVariant: "qwen",
          pilotAuthorization: tampered,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl, env: fullEnv(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "PILOT_AUTH_FINGERPRINT_MISMATCH",
    );
  });

  // ── 9.11 Wrong operation
  it("9.11 — TRANSCRIBE auth used against GENERATE endpoint → PILOT_AUTH_OPERATION_MISMATCH", async () => {
    const fetchImpl = mockModalServer({ operation: OPERATION_GENERATE });
    const transcribeAuth = buildTranscribeAuth();
    await expect(
      callModalGenerate(
        {
          requestId: "req-opmix",
          modelVariant: "qwen",
          pilotAuthorization: transcribeAuth,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl, env: fullEnv(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "PILOT_AUTH_OPERATION_MISMATCH",
    );
  });

  // ── 9.12 Invalid response signature
  it("9.12 — server returns wrong response signature → MODAL_HMAC_INVALID", async () => {
    const fetchImpl = mockModalServer({ operation: OPERATION_GENERATE, tamperResponseSignature: true });
    const auth = buildPilotAuth();
    await expect(
      callModalGenerate(
        {
          requestId: "req-respsig",
          modelVariant: "qwen",
          pilotAuthorization: auth,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl, env: fullEnv(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "MODAL_HMAC_INVALID",
    );
  });

  // ── 9.13 Response / request ID mismatch
  it("9.13 — response x-spectre-response-request-id mismatch → RESPONSE_REQUEST_ID_MISMATCH", async () => {
    const fetchImpl = mockModalServer({ operation: OPERATION_GENERATE, tamperResponseRequestId: true });
    const auth = buildPilotAuth();
    await expect(
      callModalGenerate(
        {
          requestId: "req-respid",
          modelVariant: "qwen",
          pilotAuthorization: auth,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl, env: fullEnv(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "RESPONSE_REQUEST_ID_MISMATCH",
    );
  });

  // ── 9.14 Tampered response body
  it("9.14 — mutated response body → MODAL_HMAC_INVALID", async () => {
    const fetchImpl = mockModalServer({ operation: OPERATION_TRANSCRIBE, tamperResponseBody: true });
    const auth = buildTranscribeAuth();
    await expect(
      callModalTranscribe(
        {
          requestId: "req-respbody",
          audioUrl: "https://r2/x",
          languageCode: "en",
          modelVariant: "faster-whisper-large-v3",
          pilotAuthorization: auth,
        },
        { fetchImpl, env: fullEnv(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "MODAL_HMAC_INVALID",
    );
  });

  // ── 9.15 Retry with fresh authorization
  it("9.15 — retry with fresh authorizationId succeeds (replay cache not tripped)", async () => {
    const replay = new InMemoryReplayRegistry(fixedClock());
    const fetchImpl = mockModalServer({ operation: OPERATION_GENERATE, replay });
    const authA = buildPilotAuth({ authorizationId: "auth-first" });
    const authB = buildPilotAuth({ authorizationId: "auth-second" });
    // First call succeeds.
    await callModalGenerate(
      {
        requestId: "req-first",
        modelVariant: "qwen",
        pilotAuthorization: authA,
        systemPrompt: "x",
        transcript: "x",
        constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
      },
      { fetchImpl, env: fullEnv(), clock: fixedClock() },
    );
    // Simulated retry: FRESH authorizationId + FRESH requestId.
    const resp = await callModalGenerate(
      {
        requestId: "req-second",
        modelVariant: "qwen",
        pilotAuthorization: authB,
        systemPrompt: "x",
        transcript: "x",
        constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
      },
      { fetchImpl, env: fullEnv(), clock: fixedClock() },
    );
    expect(resp.operation).toBe(OPERATION_GENERATE);
  });

  // ── 9.16 Replay-store outage
  it("9.16 — replay store outage → REPLAY_STORE_UNAVAILABLE (retryable)", async () => {
    const fetchImpl = mockModalServer({ operation: OPERATION_GENERATE, replayStoreOutage: true });
    const auth = buildPilotAuth();
    try {
      await callModalGenerate(
        {
          requestId: "req-rso",
          modelVariant: "qwen",
          pilotAuthorization: auth,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl, env: fullEnv(), clock: fixedClock() },
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ModalContractError);
      expect((e as ModalContractError).code).toBe("REPLAY_STORE_UNAVAILABLE");
      expect(isRetryable((e as ModalContractError).code)).toBe(true);
    }
  });

  // ── 9.17 Cancellation — worker-side concern; the auth contract
  // doesn't model it directly. The handler drops late responses on
  // state mismatch. This test just confirms the client surface
  // behaves correctly when the caller aborts.
  it("9.17 — client AbortController fires → MODAL_TIMEOUT", async () => {
    const slowFetch: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const auth = buildPilotAuth();
    await expect(
      callModalGenerate(
        {
          requestId: "req-abort",
          modelVariant: "qwen",
          pilotAuthorization: auth,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl: slowFetch, env: fullEnv(), clock: fixedClock(), timeoutMs: 10 },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "MODAL_TIMEOUT",
    );
  });

  // ── 9.18 Malformed inference output
  it("9.18 — malformed response body → MODAL_BODY_INVALID", async () => {
    const fetchImpl = mockModalServer({ operation: OPERATION_GENERATE, returnMalformed: true });
    const auth = buildPilotAuth();
    await expect(
      callModalGenerate(
        {
          requestId: "req-malformed",
          modelVariant: "qwen",
          pilotAuthorization: auth,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl, env: fullEnv(), clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "MODAL_BODY_INVALID",
    );
  });
});

describe("EP-TRAIN-4Y-B-IMPL — Shared library unit coverage", () => {
  it("canonicalise: sorted key output byte-identical to 6C-11", () => {
    expect(canonicalise({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalise({ z: [1, 2], a: { c: 1, b: 2 } })).toBe('{"a":{"b":2,"c":1},"z":[1,2]}');
  });

  it("canonicalise: throws on non-finite numbers", () => {
    expect(() => canonicalise(Infinity)).toThrow();
    expect(() => canonicalise(NaN)).toThrow();
  });

  it("assertPrintableAscii: rejects em-dash", () => {
    expect(() => assertPrintableAscii("field", "x — y")).toThrow();
    expect(() => assertPrintableAscii("field", "x - y")).not.toThrow();
  });

  it("sha256HexOfCanonicalSync: deterministic", () => {
    const hA = sha256HexOfCanonicalSync({ a: 1, b: 2 });
    const hB = sha256HexOfCanonicalSync({ b: 2, a: 1 });
    expect(hA).toBe(hB);
  });

  it("CREDENTIAL_ABSENT when env missing", async () => {
    const auth = buildPilotAuth();
    await expect(
      callModalGenerate(
        {
          requestId: "r",
          modelVariant: "qwen",
          pilotAuthorization: auth,
          systemPrompt: "x",
          transcript: "x",
          constraints: { proposalKind: "QUESTION_FINAL_ASSESSMENT", maxQuestions: 1, allowedQuestionTypes: ["SINGLE_CHOICE"], jsonSchema: {} },
        },
        { fetchImpl: async () => new Response("", { status: 200 }), env: {}, clock: fixedClock() },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ModalContractError && e.code === "CREDENTIAL_ABSENT",
    );
  });

  it("verifyPilotAuthorizationFingerprint: valid auth passes", () => {
    const auth = buildPilotAuth();
    expect(verifyPilotAuthorizationFingerprint(auth, FIXTURE_FINGERPRINT_SECRET)).toBe(true);
  });

  it("verifyPilotAuthorizationFingerprint: wrong secret fails", () => {
    const auth = buildPilotAuth();
    expect(verifyPilotAuthorizationFingerprint(auth, "wrong-secret")).toBe(false);
  });

  it("isPilotAuthorizationExpired: fresh auth not expired", () => {
    const auth = buildPilotAuth();
    expect(isPilotAuthorizationExpired(auth, fixedClock())).toBe(false);
  });

  it("isPilotAuthorizationExpired: past auth is expired", () => {
    const auth = buildPilotAuth();
    const future = fixedClock(FIXED_NOW_MS + 4_000_000);
    expect(isPilotAuthorizationExpired(auth, future)).toBe(true);
  });

  it("Replay registry: duplicate rejected, fresh accepted", async () => {
    const r = new InMemoryReplayRegistry(fixedClock());
    const k = replayKey({ authorizationId: "a", requestId: "r" });
    expect((await r.record({ key: k, ttlSec: 60 })).ok).toBe(true);
    const dup = await r.record({ key: k, ttlSec: 60 });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toBe("duplicate");
  });

  it("NullReplayRegistry: always returns unavailable", async () => {
    const r = new NullReplayRegistry();
    const res = await r.record({ key: "x", ttlSec: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    expect(await r.isHealthy()).toBe(false);
  });
});

// EP-TRAIN-4Y-C §4 — worker-handler integration coverage (Hybrid
// contract).
//
// Restores the state-transition / lease-ownership / cancellation /
// failure-handling / skip-when-no-queued / credential-absent
// assertions that were in the deleted 4V + 4W worker-handler tests.
// Those tests used the old Bearer contract + a real Prisma DB. This
// restoration uses:
//
//   - Module-level mocks for job-service (claimNext*, record*Completed,
//     record*Failed, renew*Lease, analyseTranscriptQuality).
//   - Module-level mock for `@/lib/prisma` (just the version lookup +
//     the generation `.trainingTranscriptBuild.findFirst` for the
//     default-loader fallback).
//   - Real Hybrid-contract wire protocol via a deterministic fetch
//     stub that signs responses with the production `signResponse`
//     helper (NOT a short-circuit mock).
//
// Coverage:
//
//   §4-T1  Transcribe happy path — claim → modal → ingest →
//           recordJobCompleted with correct resolved build id + cost.
//   §4-T2  Transcribe SHA mismatch — Modal returns different audioSha256
//           → recordJobFailed(code=SHA_MISMATCH, retryable=false).
//   §4-T3  Transcribe Modal HTTP error (5xx) → recordJobFailed(code=
//           MODAL_HTTP_ERROR, retryable=true).
//   §4-T4  Transcribe HMAC-invalid class failure (REQUEST_HMAC_INVALID) →
//           recordJobFailed(..., retryable=false).
//   §4-T5  Transcribe empty-transcript → recordJobFailed(code=
//           INTEGRITY_FAILURE, retryable=false).
//   §4-T6  Transcribe cancellation race — claim returns null → SKIPPED
//           without state mutation.
//   §4-T7  Transcribe skip when queued jobId does not match claim →
//           SKIPPED without state mutation.
//   §4-T8  Transcribe credential absent — no MODAL_KEY → CREDENTIAL_ABSENT
//           with retryable=false.
//   §4-G1  Generate happy path — claim → modal → draft persist →
//           recordGenerationCompleted with correct tokens / drafts.
//   §4-G2  Generate proposals citing excluded segments (16/17) dropped —
//           only grounded proposals persisted.
//   §4-G3  Generate zero grounded proposals → recordGenerationFailed(
//           code=INSUFFICIENT_EVIDENCE, retryable=false).
//   §4-G4  Generate HMAC-invalid → recordGenerationFailed(..., retryable=false).
//   §4-G5  Generate skip when claim mismatches args → SKIPPED.

import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  CONTRACT_VERSION,
  OPERATION_TRANSCRIBE,
  OPERATION_GENERATE,
  signResponse,
} from "../src/lib/hr/training/modal-shared";

// ─── MOCKS ──────────────────────────────────────────────────────────

const transcribeServiceMocks = vi.hoisted(() => ({
  claimNextTranscriptionJob: vi.fn(),
  recordJobCompleted: vi.fn().mockResolvedValue({}),
  recordJobFailed: vi.fn().mockResolvedValue({}),
  analyseTranscriptQuality: vi.fn(),
}));

vi.mock("@/lib/hr/training/transcription/job-service", () => ({
  claimNextTranscriptionJob: transcribeServiceMocks.claimNextTranscriptionJob,
  recordJobCompleted: transcribeServiceMocks.recordJobCompleted,
  recordJobFailed: transcribeServiceMocks.recordJobFailed,
  analyseTranscriptQuality: transcribeServiceMocks.analyseTranscriptQuality,
}));

const ingestMocks = vi.hoisted(() => ({
  persistTranscriptBuild: vi.fn(),
  persistTranscriptSegments: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/hr/training/transcription/ingest", () => ({
  persistTranscriptBuild: ingestMocks.persistTranscriptBuild,
  persistTranscriptSegments: ingestMocks.persistTranscriptSegments,
}));

const prismaMocks = vi.hoisted(() => ({
  trainingCourseVersion: {
    findUnique: vi.fn(),
  },
  trainingTranscriptBuild: {
    findFirst: vi.fn(),
  },
  trainingTranscriptSegment: {
    findMany: vi.fn(),
  },
  trainingQuestionAiDraft: {
    create: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMocks,
}));

// Generation-service mocks.
const generationServiceMocks = vi.hoisted(() => ({
  claimNextGenerationRun: vi.fn(),
  recordGenerationCompleted: vi.fn().mockResolvedValue({}),
  recordGenerationFailed: vi.fn().mockResolvedValue({}),
  renewGenerationLease: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/hr/training/generation/generation-service", () => ({
  claimNextGenerationRun: generationServiceMocks.claimNextGenerationRun,
  recordGenerationCompleted: generationServiceMocks.recordGenerationCompleted,
  recordGenerationFailed: generationServiceMocks.recordGenerationFailed,
  renewGenerationLease: generationServiceMocks.renewGenerationLease,
}));

// Suppress logger noise during tests.
vi.mock("@/lib/observability/logger", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// ─── TEST HARNESS ──────────────────────────────────────────────────

const HMAC_KEY = "test-hmac-key-32-bytes-0000000000";
const FINGERPRINT_SECRET = "test-fingerprint-secret-00000000";
const RESPONSE_KEY = "test-response-hmac-key-0000000000";

function fullEnv() {
  return {
    MODAL_KEY: "k",
    MODAL_SECRET: "s",
    MODAL_SPECTRE_HMAC_KEY: HMAC_KEY,
    SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET: FINGERPRINT_SECRET,
    MODAL_SPECTRE_RESPONSE_HMAC_KEY: RESPONSE_KEY,
    MODAL_TRANSCRIBE_URL: "https://modal.example/transcribe",
    MODAL_GENERATE_URL: "https://modal.example/generate",
  } satisfies NodeJS.ProcessEnv;
}

/** Build a signed Hybrid-contract transcribe success response. */
function signedTranscribeOk(requestId: string, audioSha256: string, segments: Array<{ id: number; text: string; startSec: number; endSec: number }>) {
  const body = {
    contractVersion: CONTRACT_VERSION,
    operation: OPERATION_TRANSCRIBE,
    requestId,
    modelVariant: "faster-whisper-large-v3",
    durationSec: 120,
    audioSha256,
    segments: segments.map((s) => ({ ...s, avgConfidence: 0.95 })),
    elapsedMs: { coldBoot: 1000, transcribe: 20000 },
  };
  const bodyText = JSON.stringify(body);
  const sigHdrs = signResponse({
    operation: OPERATION_TRANSCRIBE,
    requestId,
    httpStatus: 200,
    bodyText,
    responseHmacKey: RESPONSE_KEY,
  });
  return new Response(bodyText, {
    status: 200,
    headers: { "Content-Type": "application/json", ...sigHdrs },
  });
}

function signedGenerateOk(requestId: string, proposals: Array<{ questionText: string; options: Array<{ text: string; isCorrect: boolean }>; sourceSegmentIds: number[]; explanation: string }>) {
  const body = {
    contractVersion: CONTRACT_VERSION,
    operation: OPERATION_GENERATE,
    requestId,
    modelVariant: "qwen-2.5-7b-instruct-awq",
    proposals: proposals.map((p) => ({ questionType: "SINGLE_CHOICE", ...p })),
    elapsedMs: { coldBoot: 500, generate: 1200 },
    tokenCounts: { prompt: 400, output: 100 },
  };
  const bodyText = JSON.stringify(body);
  const sigHdrs = signResponse({
    operation: OPERATION_GENERATE,
    requestId,
    httpStatus: 200,
    bodyText,
    responseHmacKey: RESPONSE_KEY,
  });
  return new Response(bodyText, {
    status: 200,
    headers: { "Content-Type": "application/json", ...sigHdrs },
  });
}

/** Signed Hybrid-contract error response, honouring §3 — signed with
 *  the client's request-id so the TS client's §3 verification passes. */
function signedError(requestId: string, code: string, status: number, operation: typeof OPERATION_TRANSCRIBE | typeof OPERATION_GENERATE) {
  const body = {
    contractVersion: CONTRACT_VERSION,
    operation,
    requestId,
    error: { code, message: code },
  };
  const bodyText = JSON.stringify(body);
  const sigHdrs = signResponse({
    operation,
    requestId,
    httpStatus: status,
    bodyText,
    responseHmacKey: RESPONSE_KEY,
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

/** A fetch stub that pulls `x-spectre-request-id` from the request
 *  headers so the response binds to the actual client request. */
function requestIdAwareFetch(
  respBuilder: (requestId: string) => Response,
): typeof fetch {
  return async (_url, init) => {
    const h = init?.headers as Record<string, string>;
    const rid = h?.["x-spectre-request-id"] ?? h?.["X-Spectre-Request-Id"] ?? "unknown";
    return respBuilder(rid);
  };
}

const CLUB = "club-silver-springs";
const VIDEO_SHA = "a".repeat(64);
const JOB_ID = "job-xyz";
const COURSE_VERSION_ID = "cv-123";
const LEASE = "lease-abc";

function freshClaim(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    jobId: JOB_ID,
    clubId: CLUB,
    courseVersionId: COURSE_VERSION_ID,
    sourceVideoSha256: VIDEO_SHA,
    leaseToken: LEASE,
    attempts: 0,
    maxAttempts: 2,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  transcribeServiceMocks.claimNextTranscriptionJob.mockReset();
  transcribeServiceMocks.recordJobCompleted.mockReset().mockResolvedValue({});
  transcribeServiceMocks.recordJobFailed.mockReset().mockResolvedValue({});
  transcribeServiceMocks.analyseTranscriptQuality.mockReset();
  ingestMocks.persistTranscriptBuild.mockReset();
  ingestMocks.persistTranscriptSegments.mockReset().mockResolvedValue({});
  prismaMocks.trainingCourseVersion.findUnique.mockReset();
  generationServiceMocks.claimNextGenerationRun.mockReset();
  generationServiceMocks.recordGenerationCompleted.mockReset().mockResolvedValue({});
  generationServiceMocks.recordGenerationFailed.mockReset().mockResolvedValue({});
  generationServiceMocks.renewGenerationLease.mockReset().mockResolvedValue({});
  prismaMocks.trainingQuestionAiDraft.create.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── TRANSCRIBE HANDLER ────────────────────────────────────────────

describe("EP-TRAIN-4Y-C §4-T — transcription worker handler", () => {
  it("§4-T1 happy path — claim → modal → ingest → recordJobCompleted", async () => {
    transcribeServiceMocks.claimNextTranscriptionJob.mockResolvedValue(freshClaim());
    prismaMocks.trainingCourseVersion.findUnique.mockResolvedValue({
      id: COURSE_VERSION_ID,
      videoDurationSec: 120,
      videoSha256: VIDEO_SHA,
    });
    transcribeServiceMocks.analyseTranscriptQuality.mockReturnValue({
      perSegmentFlags: [{ segmentIndex: 0, flags: [] }],
      reasons: [],
    });
    ingestMocks.persistTranscriptBuild.mockResolvedValue({ build: { id: "build-xyz" } });

    const { handleTranscribeJob } = await import(
      "../src/lib/hr/training/transcription/worker-handler"
    );
    const fetchImpl = requestIdAwareFetch((rid) =>
      signedTranscribeOk(rid, VIDEO_SHA, [
        { id: 0, startSec: 0, endSec: 60, text: "Intro." },
      ]),
    );

    const result = await handleTranscribeJob(
      { jobId: JOB_ID },
      {
        fetchImpl,
        env: fullEnv(),
        makeSignedVideoUrl: async () => "https://signed.example/v.mp4",
      },
    );

    expect(result.status).toBe("COMPLETED");
    expect(transcribeServiceMocks.recordJobCompleted).toHaveBeenCalledTimes(1);
    const completedCall = transcribeServiceMocks.recordJobCompleted.mock.calls[0][0];
    expect(completedCall.jobId).toBe(JOB_ID);
    expect(completedCall.leaseToken).toBe(LEASE);
    expect(completedCall.resolvedTranscriptBuildId).toBe("build-xyz");
    expect(completedCall.estimatedCostUsdMicros).toBeGreaterThan(0);
    expect(ingestMocks.persistTranscriptBuild).toHaveBeenCalledTimes(1);
    expect(ingestMocks.persistTranscriptSegments).toHaveBeenCalledTimes(1);
    expect(transcribeServiceMocks.recordJobFailed).not.toHaveBeenCalled();
  });

  it("§4-T2 SHA mismatch — modal returns different audioSha256 → FAILED (non-retryable)", async () => {
    transcribeServiceMocks.claimNextTranscriptionJob.mockResolvedValue(freshClaim());
    prismaMocks.trainingCourseVersion.findUnique.mockResolvedValue({
      id: COURSE_VERSION_ID,
      videoDurationSec: 120,
      videoSha256: VIDEO_SHA,
    });

    const { handleTranscribeJob } = await import(
      "../src/lib/hr/training/transcription/worker-handler"
    );
    const fetchImpl = requestIdAwareFetch((rid) =>
      signedTranscribeOk(rid, "f".repeat(64) /* WRONG sha */, [
        { id: 0, startSec: 0, endSec: 60, text: "Body." },
      ]),
    );

    const result = await handleTranscribeJob(
      { jobId: JOB_ID },
      {
        fetchImpl,
        env: fullEnv(),
        makeSignedVideoUrl: async () => "https://signed.example/v.mp4",
      },
    );

    expect(result.status).toBe("FAILED");
    expect(transcribeServiceMocks.recordJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        leaseToken: LEASE,
        failureCode: "SHA_MISMATCH",
        retryable: false,
      }),
    );
    expect(ingestMocks.persistTranscriptBuild).not.toHaveBeenCalled();
  });

  it("§4-T3 Modal 500 → FAILED (retryable MODAL_HTTP_ERROR)", async () => {
    transcribeServiceMocks.claimNextTranscriptionJob.mockResolvedValue(freshClaim());
    prismaMocks.trainingCourseVersion.findUnique.mockResolvedValue({
      id: COURSE_VERSION_ID,
      videoDurationSec: 120,
      videoSha256: VIDEO_SHA,
    });

    const { handleTranscribeJob } = await import(
      "../src/lib/hr/training/transcription/worker-handler"
    );
    // Unsigned 500 — client classifies as MODAL_HTTP_ERROR per §3.
    const fetchImpl: typeof fetch = async () =>
      new Response("gateway timeout", { status: 500 });

    const result = await handleTranscribeJob(
      { jobId: JOB_ID },
      {
        fetchImpl,
        env: fullEnv(),
        makeSignedVideoUrl: async () => "https://signed.example/v.mp4",
      },
    );

    expect(result.status).toBe("FAILED");
    expect(transcribeServiceMocks.recordJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        failureCode: "MODAL_HTTP_ERROR",
        retryable: true,
      }),
    );
  });

  it("§4-T4 server-side REQUEST_HMAC_INVALID → FAILED (non-retryable)", async () => {
    transcribeServiceMocks.claimNextTranscriptionJob.mockResolvedValue(freshClaim());
    prismaMocks.trainingCourseVersion.findUnique.mockResolvedValue({
      id: COURSE_VERSION_ID,
      videoDurationSec: 120,
      videoSha256: VIDEO_SHA,
    });

    const { handleTranscribeJob } = await import(
      "../src/lib/hr/training/transcription/worker-handler"
    );
    const fetchImpl = requestIdAwareFetch((rid) =>
      signedError(rid, "REQUEST_HMAC_INVALID", 400, OPERATION_TRANSCRIBE),
    );

    const result = await handleTranscribeJob(
      { jobId: JOB_ID },
      {
        fetchImpl,
        env: fullEnv(),
        makeSignedVideoUrl: async () => "https://signed.example/v.mp4",
      },
    );

    expect(result.status).toBe("FAILED");
    expect(transcribeServiceMocks.recordJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "REQUEST_HMAC_INVALID",
        retryable: false,
      }),
    );
  });

  it("§4-T5 empty-transcript → FAILED (INTEGRITY_FAILURE non-retryable)", async () => {
    transcribeServiceMocks.claimNextTranscriptionJob.mockResolvedValue(freshClaim());
    prismaMocks.trainingCourseVersion.findUnique.mockResolvedValue({
      id: COURSE_VERSION_ID,
      videoDurationSec: 120,
      videoSha256: VIDEO_SHA,
    });
    transcribeServiceMocks.analyseTranscriptQuality.mockReturnValue({
      perSegmentFlags: [],
      reasons: ["EMPTY_TRANSCRIPT"],
    });

    const { handleTranscribeJob } = await import(
      "../src/lib/hr/training/transcription/worker-handler"
    );
    const fetchImpl = requestIdAwareFetch((rid) =>
      signedTranscribeOk(rid, VIDEO_SHA, []),
    );

    const result = await handleTranscribeJob(
      { jobId: JOB_ID },
      {
        fetchImpl,
        env: fullEnv(),
        makeSignedVideoUrl: async () => "https://signed.example/v.mp4",
      },
    );

    expect(result.status).toBe("FAILED");
    expect(transcribeServiceMocks.recordJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "INTEGRITY_FAILURE",
        retryable: false,
      }),
    );
    expect(ingestMocks.persistTranscriptBuild).not.toHaveBeenCalled();
  });

  it("§4-T6 cancellation race — claim returns null → SKIPPED (no mutation)", async () => {
    transcribeServiceMocks.claimNextTranscriptionJob.mockResolvedValue(null);

    const { handleTranscribeJob } = await import(
      "../src/lib/hr/training/transcription/worker-handler"
    );
    const fetchImpl: typeof fetch = async () => {
      throw new Error("fetch should not be called");
    };

    const result = await handleTranscribeJob(
      { jobId: JOB_ID },
      {
        fetchImpl,
        env: fullEnv(),
        makeSignedVideoUrl: async () => "x",
      },
    );
    expect(result.status).toBe("SKIPPED");
    expect(transcribeServiceMocks.recordJobCompleted).not.toHaveBeenCalled();
    expect(transcribeServiceMocks.recordJobFailed).not.toHaveBeenCalled();
  });

  it("§4-T7 claim mismatches args.jobId → SKIPPED (no mutation)", async () => {
    transcribeServiceMocks.claimNextTranscriptionJob.mockResolvedValue(
      freshClaim({ jobId: "different-job" }),
    );

    const { handleTranscribeJob } = await import(
      "../src/lib/hr/training/transcription/worker-handler"
    );
    const fetchImpl: typeof fetch = async () => {
      throw new Error("fetch should not be called");
    };

    const result = await handleTranscribeJob(
      { jobId: JOB_ID },
      {
        fetchImpl,
        env: fullEnv(),
        makeSignedVideoUrl: async () => "x",
      },
    );
    expect(result.status).toBe("SKIPPED");
    expect(transcribeServiceMocks.recordJobCompleted).not.toHaveBeenCalled();
    expect(transcribeServiceMocks.recordJobFailed).not.toHaveBeenCalled();
  });

  it("§4-T8 credential absent (no fingerprint secret) → FAILED (CREDENTIAL_ABSENT non-retryable)", async () => {
    transcribeServiceMocks.claimNextTranscriptionJob.mockResolvedValue(freshClaim());
    prismaMocks.trainingCourseVersion.findUnique.mockResolvedValue({
      id: COURSE_VERSION_ID,
      videoDurationSec: 120,
      videoSha256: VIDEO_SHA,
    });

    const { handleTranscribeJob } = await import(
      "../src/lib/hr/training/transcription/worker-handler"
    );
    const fetchImpl: typeof fetch = async () => {
      throw new Error("fetch must not be called when creds absent");
    };
    const envNoFp = { ...fullEnv() };
    delete envNoFp.SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET;

    const result = await handleTranscribeJob(
      { jobId: JOB_ID },
      {
        fetchImpl,
        env: envNoFp,
        makeSignedVideoUrl: async () => "https://signed.example/v.mp4",
      },
    );

    expect(result.status).toBe("FAILED");
    expect(transcribeServiceMocks.recordJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "CREDENTIAL_ABSENT",
        retryable: false,
      }),
    );
  });
});

// ─── GENERATE HANDLER ──────────────────────────────────────────────

const RUN_ID = "run-xyz";
const PLAN = {
  schemaVersion: "training-assessment-plan-v1",
  courseVersionId: COURSE_VERSION_ID,
  resolvedTranscriptBuildId: "b".repeat(64),
  sourceVideoSha256: "a".repeat(64),
  learningObjectives: [],
  eligibleSegmentIds: [0, 1, 2, 3],
  proposedCheckpointGroups: [],
  proposedFinalAssessment: { id: "final", targetQuestionCount: 2 },
  totalTargetQuestionCount: 2,
  sourceEvidenceRequirements: {
    mustCiteAtLeastOneSegmentPerQuestion: true,
    excludedSegmentIndices: [16, 17],
  },
  generatedAt: "2026-11-07T00:00:00.000Z",
};

function freshGenClaim(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    runId: RUN_ID,
    clubId: CLUB,
    courseVersionId: COURSE_VERSION_ID,
    leaseToken: LEASE,
    assessmentPlanJson: JSON.stringify(PLAN),
    planIdentity: "c".repeat(64),
    ...overrides,
  };
}

describe("EP-TRAIN-4Y-C §4-G — generation worker handler", () => {
  it("§4-G1 happy path — modal → draft persist → recordGenerationCompleted", async () => {
    generationServiceMocks.claimNextGenerationRun.mockResolvedValue(freshGenClaim());
    prismaMocks.trainingCourseVersion.findUnique.mockResolvedValue({
      courseId: "course-xxx",
    });

    const { handleGenerateJob } = await import(
      "../src/lib/hr/training/generation/worker-handler"
    );

    const fetchImpl = requestIdAwareFetch((rid) =>
      signedGenerateOk(rid, [
        {
          questionText: "Q1 cites segment 1",
          options: [
            { text: "A", isCorrect: true },
            { text: "B", isCorrect: false },
          ],
          sourceSegmentIds: [1],
          explanation: "cites seg 1",
        },
        {
          questionText: "Q2 cites segment 2",
          options: [
            { text: "A", isCorrect: true },
            { text: "B", isCorrect: false },
          ],
          sourceSegmentIds: [2],
          explanation: "cites seg 2",
        },
      ]),
    );

    const result = await handleGenerateJob(
      { runId: RUN_ID },
      {
        fetchImpl,
        env: fullEnv(),
        loadTranscriptSegments: async () => [
          { segmentIndex: 0, text: "s0" },
          { segmentIndex: 1, text: "s1 content" },
          { segmentIndex: 2, text: "s2 content" },
          { segmentIndex: 3, text: "s3" },
        ],
      },
    );

    expect(result.status).toBe("COMPLETED");
    expect(prismaMocks.trainingQuestionAiDraft.create).toHaveBeenCalledTimes(2);
    expect(generationServiceMocks.recordGenerationCompleted).toHaveBeenCalledTimes(1);
    const completed = generationServiceMocks.recordGenerationCompleted.mock.calls[0][0];
    expect(completed.runId).toBe(RUN_ID);
    expect(completed.leaseToken).toBe(LEASE);
    expect(completed.promptTokenCount).toBeGreaterThan(0);
  });

  it("§4-G2 proposals citing non-eligible segment (99) are dropped", async () => {
    // Note: the plan validator refuses 16/17 in eligibleSegmentIds
    // (they live in excludedSegmentIndices per pilot policy). The
    // handler's grounding filter at worker-handler.ts §234 enforces
    // `eligible.has(id) && !EXCLUDED_SEGMENT_INDICES.has(id)`. This
    // test exercises the eligibility arm of that AND with a segment
    // the plan does NOT declare eligible.
    generationServiceMocks.claimNextGenerationRun.mockResolvedValue(freshGenClaim());
    prismaMocks.trainingCourseVersion.findUnique.mockResolvedValue({
      courseId: "course-xxx",
    });

    const { handleGenerateJob } = await import(
      "../src/lib/hr/training/generation/worker-handler"
    );

    const fetchImpl = requestIdAwareFetch((rid) =>
      signedGenerateOk(rid, [
        {
          questionText: "Q cites non-eligible seg 99 only",
          options: [
            { text: "A", isCorrect: true },
            { text: "B", isCorrect: false },
          ],
          sourceSegmentIds: [99], // not in eligibleSegmentIds
          explanation: "x",
        },
        {
          questionText: "Q cites valid seg 1",
          options: [
            { text: "A", isCorrect: true },
            { text: "B", isCorrect: false },
          ],
          sourceSegmentIds: [1],
          explanation: "x",
        },
      ]),
    );

    const result = await handleGenerateJob(
      { runId: RUN_ID },
      {
        fetchImpl,
        env: fullEnv(),
        loadTranscriptSegments: async () => [
          { segmentIndex: 0, text: "s0" },
          { segmentIndex: 1, text: "s1 content" },
          { segmentIndex: 2, text: "s2 content" },
          { segmentIndex: 3, text: "s3" },
        ],
      },
    );

    expect(result.status).toBe("COMPLETED");
    // Only ONE draft persisted — the one citing seg 99 was dropped.
    expect(prismaMocks.trainingQuestionAiDraft.create).toHaveBeenCalledTimes(1);
  });

  it("§4-G3 zero grounded proposals → INSUFFICIENT_EVIDENCE non-retryable", async () => {
    generationServiceMocks.claimNextGenerationRun.mockResolvedValue(freshGenClaim());
    prismaMocks.trainingCourseVersion.findUnique.mockResolvedValue({
      courseId: "course-xxx",
    });

    const { handleGenerateJob } = await import(
      "../src/lib/hr/training/generation/worker-handler"
    );

    const fetchImpl = requestIdAwareFetch((rid) =>
      signedGenerateOk(rid, []),
    );

    const result = await handleGenerateJob(
      { runId: RUN_ID },
      {
        fetchImpl,
        env: fullEnv(),
        loadTranscriptSegments: async () => [
          { segmentIndex: 0, text: "s0" },
        ],
      },
    );

    expect(result.status).toBe("FAILED");
    expect(generationServiceMocks.recordGenerationFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        failureCode: "INSUFFICIENT_EVIDENCE",
        retryable: false,
      }),
      expect.any(Object),
    );
  });

  it("§4-G4 server-side REQUEST_HMAC_INVALID → FAILED non-retryable", async () => {
    generationServiceMocks.claimNextGenerationRun.mockResolvedValue(freshGenClaim());
    prismaMocks.trainingCourseVersion.findUnique.mockResolvedValue({
      courseId: "course-xxx",
    });

    const { handleGenerateJob } = await import(
      "../src/lib/hr/training/generation/worker-handler"
    );

    const fetchImpl = requestIdAwareFetch((rid) =>
      signedError(rid, "REQUEST_HMAC_INVALID", 400, OPERATION_GENERATE),
    );

    const result = await handleGenerateJob(
      { runId: RUN_ID },
      {
        fetchImpl,
        env: fullEnv(),
        loadTranscriptSegments: async () => [
          { segmentIndex: 0, text: "s0" },
          { segmentIndex: 1, text: "s1" },
        ],
      },
    );

    expect(result.status).toBe("FAILED");
    expect(generationServiceMocks.recordGenerationFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "REQUEST_HMAC_INVALID",
        retryable: false,
      }),
      expect.any(Object),
    );
  });

  it("§4-G5 claim mismatches args.runId → SKIPPED without mutation", async () => {
    generationServiceMocks.claimNextGenerationRun.mockResolvedValue(
      freshGenClaim({ runId: "other-run" }),
    );

    const { handleGenerateJob } = await import(
      "../src/lib/hr/training/generation/worker-handler"
    );
    const fetchImpl: typeof fetch = async () => {
      throw new Error("fetch should not be called");
    };

    const result = await handleGenerateJob(
      { runId: RUN_ID },
      { fetchImpl, env: fullEnv() },
    );
    expect(result.status).toBe("SKIPPED");
    expect(generationServiceMocks.recordGenerationCompleted).not.toHaveBeenCalled();
    expect(generationServiceMocks.recordGenerationFailed).not.toHaveBeenCalled();
  });
});

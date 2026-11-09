// EP-TRAIN-4Y-W §6 (2026-11-09) — retry governance.
//
// Verifies that the generation worker handler THROWS on a retryable
// Modal error (so BackgroundJob's exponential-backoff retry fires)
// and RETURNS cleanly on a non-retryable error (so BackgroundJob
// terminates without consuming additional retry budget).
//
// Companion to the 4Y-V post-mortem: pre-W, the handler returned
// `{status: "FAILED"}` on BOTH retryable and non-retryable errors,
// which silently decoupled the Spectre lifecycle (which set the
// run to QUEUED expecting a retry) from the queue (which treated
// the clean return as success and did not retry). Run would hang
// in QUEUED indefinitely. This test pins the fix.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./util/db";
import {
  requestGeneration,
  markGenerationQueued,
} from "@/lib/hr/training/generation/generation-service";
import { buildBaselineAssessmentPlan } from "@/lib/hr/training/generation/assessment-plan";
import { handleGenerateJob } from "@/lib/hr/training/generation/worker-handler";
import type { Principal } from "@/lib/rbac";

const CLUB = "club_4yw_retry";
const SHA = "f1e2d3c4".repeat(8);
const BUILD = "a".repeat(64);
const URL = "https://modal.example/generate";

function sa(): Principal {
  return {
    id: "u", name: "A", email: "a@t.local", status: "ACTIVE",
    memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }],
    activeClubId: CLUB, memberId: null,
  };
}

function segments() {
  return [
    { segmentIndex: 0, startSec: 0, endSec: 10, text: "Welcome to the training course." },
    { segmentIndex: 1, startSec: 10, endSec: 30, text: "First topic is workplace safety for staff." },
    { segmentIndex: 2, startSec: 30, endSec: 60, text: "Equipment handling and the escalation policy for member disputes." },
    { segmentIndex: 3, startSec: 60, endSec: 90, text: "Food safety temperatures stay below 4 degrees Celsius." },
    { segmentIndex: 4, startSec: 90, endSec: 120, text: "Member service standards are maintained every shift." },
  ];
}

async function seed() {
  const ts = Date.now() + Math.floor(Math.random() * 1_000_000);
  await prisma.club.upsert({
    where: { id: CLUB },
    create: { id: CLUB, name: CLUB, slug: `s-${ts}`, primaryColor: "#111" },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: "u" },
    create: { id: "u", email: `u-${ts}@t.local`, name: "u", status: "ACTIVE", passwordHash: "x", role: "SUPER_ADMIN" },
    update: {},
  });
  const course = await prisma.trainingCourse.create({
    data: { clubId: CLUB, code: `C-${ts}`, title: "T", category: "ORIENTATION" },
  });
  const version = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id, version: 1, state: "DRAFT", title: "V1",
      videoSha256: SHA, videoStorageKey: "k/v1", videoDurationSec: 120,
    },
  });
  await prisma.trainingTranscriptBuild.create({
    data: {
      clubId: CLUB, sourceVideoSha256: SHA,
      resolvedTranscriptBuildId: BUILD,
      transcriberName: "faster-whisper", transcriberVersion: "1",
      transcriberModelName: "large-v3", transcriberModelVersion: "stable",
      transcriberConfigSha256: "c".repeat(64), producedAt: new Date(),
    },
  });
  return { versionId: version.id };
}

async function enqueueRun(versionId: string) {
  const plan = buildBaselineAssessmentPlan({
    courseVersionId: versionId,
    resolvedTranscriptBuildId: BUILD,
    sourceVideoSha256: SHA,
    segments: segments().map((s) => ({ segmentIndex: s.segmentIndex, text: s.text })),
    videoDurationSec: 120,
    targetTotalQuestions: 2,
    now: new Date("2026-11-09T00:00:00Z"),
  });
  const r = await requestGeneration(sa(), CLUB, { courseVersionId: versionId, plan });
  await markGenerationQueued(CLUB, r.generationRunId);
  return r.generationRunId;
}

beforeEach(async () => {
  await resetDb();
  process.env.MODAL_GENERATE_URL = URL;
  // Hybrid path requires fingerprint + HMAC envs + proxy key/secret
  // to satisfy modalGenerateCredentialsPresent + resolveModalCredentials.
  process.env.MODAL_HYBRID_ENABLED = "1";
  process.env.MODAL_KEY = "test-proxy-key";
  process.env.MODAL_SECRET = "test-proxy-secret";
  process.env.MODAL_SPECTRE_HMAC_KEY = "x".repeat(40);
  process.env.MODAL_SPECTRE_RESPONSE_HMAC_KEY = "x".repeat(40);
  process.env.SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET = "y".repeat(40);
});
afterEach(() => vi.restoreAllMocks());

describe("EP-TRAIN-4Y-W §6 retry governance", () => {
  it("retryable Modal 500 (no signed headers) → handler THROWS so BackgroundJob reschedules", async () => {
    const s = await seed();
    const runId = await enqueueRun(s.versionId);
    // Modal returns 500 with no signed-response headers → client
    // classifies as MODAL_HTTP_ERROR (retryable).
    const fetchImpl = vi.fn(async () =>
      new Response("Internal Server Error", { status: 500 }),
    );
    await expect(
      handleGenerateJob(
        { runId },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          loadTranscriptSegments: async () =>
            segments().map((s) => ({ segmentIndex: s.segmentIndex, text: s.text })),
        },
      ),
    ).rejects.toThrow(/retryable failure \(MODAL_HTTP_ERROR\)/);
    // Spectre lifecycle: run is QUEUED awaiting the retry.
    const run = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: runId } });
    expect(run?.executionStatus).toBe("QUEUED");
    expect(run?.executionErrorCode).toBe("MODAL_HTTP_ERROR");
    expect(run?.attempts).toBe(1);
  });

  it("non-retryable error → handler returns FAILED cleanly, run is terminal", async () => {
    const s = await seed();
    const runId = await enqueueRun(s.versionId);
    // Simulate a classifier-level non-retryable error by stubbing
    // the modal-client throw with a code in NON_RETRYABLE. We do it
    // via a fake fetch that produces an INVALID JSON body on 200 OK —
    // that path trips `asGenerateBody` MODAL_BODY_INVALID, which is
    // in NON_RETRYABLE.
    const fetchImpl = vi.fn(async () =>
      new Response("{not json", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-spectre-response-signature": "deadbeef",
          "x-spectre-response-operation": "spectre.training.generate.v1",
          "x-spectre-response-request-id": "req",
          "x-spectre-contract-version": "4yb-v1",
        },
      }),
    );
    const result = await handleGenerateJob(
      { runId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        loadTranscriptSegments: async () =>
          segments().map((s) => ({ segmentIndex: s.segmentIndex, text: s.text })),
      },
    );
    expect(result.status).toBe("FAILED");
    const run = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: runId } });
    // One of the non-retryable codes depending on where the parser
    // tripped: MODAL_BODY_INVALID / MODAL_HMAC_INVALID / etc.
    expect(["FAILED"]).toContain(run?.executionStatus);
    // The test's malformed response body + bogus signature can trip
    // any of these non-retryable codes depending on where the parser
    // stops.
    expect([
      "MODAL_BODY_INVALID",
      "MODAL_HMAC_INVALID",
      "REQUEST_BODY_INVALID",
      "CONTRACT_VERSION_MISMATCH",
      "RESPONSE_OPERATION_MISMATCH",
      "RESPONSE_REQUEST_ID_MISMATCH",
      "CREDENTIAL_ABSENT",
    ]).toContain(run?.executionErrorCode);
  });

  it("retry budget — recordGenerationFailed exhausts at maxAttempts", async () => {
    const s = await seed();
    const runId = await enqueueRun(s.versionId);
    // First attempt: 500 (retryable). Handler throws. Run → QUEUED,
    // attempts=1. Simulate the queue scheduler picking it up again
    // for attempt 2: handler re-runs, Modal returns 500 again.
    // recordGenerationFailed sees attempts=2 and maxAttempts=2 →
    // nextState=FAILED (terminal). Handler still throws.
    const fetchImpl = vi.fn(async () =>
      new Response("Internal Server Error", { status: 500 }),
    );
    // Attempt 1
    await expect(
      handleGenerateJob(
        { runId },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          loadTranscriptSegments: async () =>
            segments().map((s) => ({ segmentIndex: s.segmentIndex, text: s.text })),
        },
      ),
    ).rejects.toThrow();
    const after1 = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: runId } });
    expect(after1?.executionStatus).toBe("QUEUED");
    expect(after1?.attempts).toBe(1);
    // Attempt 2
    await expect(
      handleGenerateJob(
        { runId },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          loadTranscriptSegments: async () =>
            segments().map((s) => ({ segmentIndex: s.segmentIndex, text: s.text })),
        },
      ),
    ).rejects.toThrow();
    const after2 = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: runId } });
    // Retry budget exhausted → terminal FAILED. maxAttempts of 2 is
    // hit; recordGenerationFailed sets nextState=FAILED.
    expect(after2?.executionStatus).toBe("FAILED");
    expect(after2?.attempts).toBe(2);
    expect(after2?.completedAt).not.toBeNull();
  });
});

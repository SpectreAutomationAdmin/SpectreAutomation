// EP-TRAIN-6D-4V — worker handler integration tests with mocked Modal
// + injected signed-URL stub. Zero Modal network calls. End-to-end
// from REQUESTED → QUEUED → RUNNING → COMPLETED including 4L ingest.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./util/db";
import {
  requestTranscription,
  markQueued,
  cancelTranscriptionJob,
} from "@/lib/hr/training/transcription/job-service";
import { handleTranscribeJob } from "@/lib/hr/training/transcription/worker-handler";
import type { Principal } from "@/lib/rbac";

const CLUB_ID = "club_4v_wh";
const USER_ADMIN = "user_4v_wh_admin";
const VIDEO_SHA = "a1b2c3d4".repeat(8); // 64 hex chars
const URL = "https://modal.example/transcribe";
const TOKEN = "shared-secret";

function superAdmin(): Principal {
  return {
    id: USER_ADMIN, name: "A", email: "a@t.local", status: "ACTIVE",
    memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }],
    activeClubId: CLUB_ID, memberId: null,
  };
}

async function seed() {
  const ts = Date.now() + Math.floor(Math.random() * 1_000_000);
  await prisma.club.upsert({
    where: { id: CLUB_ID },
    create: { id: CLUB_ID, name: CLUB_ID, slug: `s-${ts}`, primaryColor: "#111" },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: USER_ADMIN },
    create: { id: USER_ADMIN, email: `a-${ts}@t.local`, name: "A", status: "ACTIVE", passwordHash: "x", role: "SUPER_ADMIN" },
    update: {},
  });
  const course = await prisma.trainingCourse.create({
    data: { clubId: CLUB_ID, code: `C-${ts}`, title: "T", category: "ORIENTATION" },
  });
  const version = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id, version: 1, state: "DRAFT", title: "V1",
      videoSha256: VIDEO_SHA, videoStorageKey: "k/v1", videoDurationSec: 120,
    },
  });
  return { versionId: version.id };
}

function signedBody(body: Record<string, unknown>): Response {
  const text = JSON.stringify(body);
  const sig = createHmac("sha256", TOKEN).update(text).digest("base64");
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json", "x-spectre-signature": sig },
  });
}

const GOOD_RESPONSE = {
  schemaVersion: "transcribe-v1" as const,
  modelVariant: "faster-whisper-large-v3",
  durationSec: 120,
  segments: [
    { id: 0, startSec: 0, endSec: 60, text: "Part one of the lesson.", avgConfidence: 0.94 },
    { id: 1, startSec: 60, endSec: 120, text: "Part two, conclusion.", avgConfidence: 0.92 },
  ],
  elapsedMs: { coldBoot: 4000, transcribe: 56000 },
  audioSha256: VIDEO_SHA,
};

beforeEach(async () => {
  await resetDb();
  process.env.MODAL_TRANSCRIBE_URL = URL;
  process.env.MODAL_SPECTRE_SHARED_TOKEN = TOKEN;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("EP-TRAIN-6D-4V — worker handler", () => {
  it("W1 happy path: REQUESTED -> QUEUED -> RUNNING -> COMPLETED + build persisted via 4L", async () => {
    const s = await seed();
    const req = await requestTranscription(superAdmin(), CLUB_ID, { courseVersionId: s.versionId });
    await markQueued(CLUB_ID, req.jobId);
    const fetchImpl = vi.fn().mockResolvedValue(signedBody(GOOD_RESPONSE));
    const result = await handleTranscribeJob(
      { jobId: req.jobId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        makeSignedVideoUrl: async () => "https://signed-url.example/video.mp4",
      },
    );
    expect(result.status).toBe("COMPLETED");
    const job = await prisma.trainingTranscriptionJob.findUnique({ where: { id: req.jobId } });
    expect(job?.state).toBe("COMPLETED");
    expect(job?.resolvedTranscriptBuildId).not.toBeNull();
    expect(job?.estimatedCostUsdMicros).toBeGreaterThan(0);
    // Transcript build + segments persisted via 4L.
    const build = await prisma.trainingTranscriptBuild.findUnique({
      where: { id: job!.resolvedTranscriptBuildId! },
    });
    expect(build?.transcriberName).toBe("faster-whisper");
    const segs = await prisma.trainingTranscriptSegment.findMany({
      where: { transcriptBuildId: build!.id },
    });
    expect(segs.length).toBe(2);
    // Every segment carries SOURCE_ORG_PENDING_REVIEW per 4V heuristics.
    for (const s of segs) {
      expect(s.pendingReviewJson).toContain("SOURCE_ORG_PENDING_REVIEW");
    }
  });

  it("W2 SHA mismatch -> FAILED (non-retryable)", async () => {
    const s = await seed();
    const req = await requestTranscription(superAdmin(), CLUB_ID, { courseVersionId: s.versionId });
    await markQueued(CLUB_ID, req.jobId);
    const bad = { ...GOOD_RESPONSE, audioSha256: "feedface".repeat(8) }; // different valid hex
    const fetchImpl = vi.fn().mockResolvedValue(signedBody(bad));
    const result = await handleTranscribeJob(
      { jobId: req.jobId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        makeSignedVideoUrl: async () => "https://signed-url/x",
      },
    );
    expect(result.status).toBe("FAILED");
    const job = await prisma.trainingTranscriptionJob.findUnique({ where: { id: req.jobId } });
    expect(job?.state).toBe("FAILED");
    expect(job?.failureCode).toBe("SHA_MISMATCH");
  });

  it("W3 Modal HTTP error -> FAILED (retryable: back to QUEUED, attempts bumps)", async () => {
    const s = await seed();
    const req = await requestTranscription(superAdmin(), CLUB_ID, { courseVersionId: s.versionId });
    await markQueued(CLUB_ID, req.jobId);
    const fetchImpl = vi.fn().mockResolvedValue(new Response("err", { status: 502 }));
    const result = await handleTranscribeJob(
      { jobId: req.jobId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        makeSignedVideoUrl: async () => "https://signed-url/x",
      },
    );
    expect(result.status).toBe("FAILED");
    const job = await prisma.trainingTranscriptionJob.findUnique({ where: { id: req.jobId } });
    // MODAL_HTTP_ERROR is retryable; attempts=1 < max=2 so we re-queue.
    expect(job?.state).toBe("QUEUED");
    expect(job?.attempts).toBe(1);
    expect(job?.failureCode).toBe("MODAL_HTTP_ERROR");
  });

  it("W4 HMAC invalid -> FAILED (non-retryable)", async () => {
    const s = await seed();
    const req = await requestTranscription(superAdmin(), CLUB_ID, { courseVersionId: s.versionId });
    await markQueued(CLUB_ID, req.jobId);
    const bodyText = JSON.stringify(GOOD_RESPONSE);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(bodyText, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const result = await handleTranscribeJob(
      { jobId: req.jobId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        makeSignedVideoUrl: async () => "https://signed-url/x",
      },
    );
    expect(result.status).toBe("FAILED");
    const job = await prisma.trainingTranscriptionJob.findUnique({ where: { id: req.jobId } });
    expect(job?.state).toBe("FAILED");
    expect(job?.failureCode).toBe("MODAL_HMAC_INVALID");
  });

  it("W5 empty transcript -> FAILED (INTEGRITY_FAILURE)", async () => {
    const s = await seed();
    const req = await requestTranscription(superAdmin(), CLUB_ID, { courseVersionId: s.versionId });
    await markQueued(CLUB_ID, req.jobId);
    const empty = { ...GOOD_RESPONSE, segments: [] };
    const fetchImpl = vi.fn().mockResolvedValue(signedBody(empty));
    const result = await handleTranscribeJob(
      { jobId: req.jobId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        makeSignedVideoUrl: async () => "https://signed-url/x",
      },
    );
    expect(result.status).toBe("FAILED");
    const job = await prisma.trainingTranscriptionJob.findUnique({ where: { id: req.jobId } });
    expect(job?.failureCode).toBe("INTEGRITY_FAILURE");
  });

  it("W6 cancellation race: cancel after claim -> late Modal response does not create COMPLETED", async () => {
    const s = await seed();
    const req = await requestTranscription(superAdmin(), CLUB_ID, { courseVersionId: s.versionId });
    await markQueued(CLUB_ID, req.jobId);
    // Pretend the worker starts, the operator cancels mid-flight, then
    // Modal replies. Simulate by injecting a fetchImpl that cancels the
    // job BEFORE returning the signed body.
    let cancelled = false;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      if (!cancelled) {
        await cancelTranscriptionJob(superAdmin(), CLUB_ID, req.jobId);
        cancelled = true;
      }
      return signedBody(GOOD_RESPONSE);
    });
    const result = await handleTranscribeJob(
      { jobId: req.jobId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        makeSignedVideoUrl: async () => "https://signed-url/x",
      },
    );
    // Either FAILED (because the terminal write refused) or SKIPPED.
    // Critical invariant: the job is NOT COMPLETED.
    const job = await prisma.trainingTranscriptionJob.findUnique({ where: { id: req.jobId } });
    expect(["CANCELLED", "FAILED"]).toContain(job?.state);
    expect(job?.state).not.toBe("COMPLETED");
    expect(["COMPLETED", "FAILED", "SKIPPED"]).toContain(result.status);
    expect(result.status).not.toBe("COMPLETED");
  });

  it("W7 handler skips cleanly when no job is in QUEUED state", async () => {
    // No job queued at all. handleTranscribeJob should SKIP.
    const result = await handleTranscribeJob(
      { jobId: "does-not-exist" },
      {
        fetchImpl: vi.fn() as unknown as typeof fetch,
        makeSignedVideoUrl: async () => "https://x",
      },
    );
    expect(result.status).toBe("SKIPPED");
  });

  it("W8 no Modal invocation when credentials absent -> FAILED (CREDENTIAL_ABSENT, non-retryable)", async () => {
    const s = await seed();
    const req = await requestTranscription(superAdmin(), CLUB_ID, { courseVersionId: s.versionId });
    await markQueued(CLUB_ID, req.jobId);
    delete process.env.MODAL_TRANSCRIBE_URL;
    const fetchImpl = vi.fn();
    const result = await handleTranscribeJob(
      { jobId: req.jobId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        makeSignedVideoUrl: async () => "https://x",
      },
    );
    expect(result.status).toBe("FAILED");
    expect(fetchImpl).not.toHaveBeenCalled();
    const job = await prisma.trainingTranscriptionJob.findUnique({ where: { id: req.jobId } });
    expect(job?.state).toBe("FAILED");
    expect(job?.failureCode).toBe("CREDENTIAL_ABSENT");
  });
});

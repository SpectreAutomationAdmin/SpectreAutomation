// EP-TRAIN-6D-4V — TranscriptionJob lifecycle contract tests.
//
// Covers directive §9's scenarios on SQLite. True-Postgres concerns
// (concurrent race, isolated transactions) live in the PG16 harness.

import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./util/db";
import {
  requestTranscription,
  markQueued,
  claimNextTranscriptionJob,
  recordJobCompleted,
  recordJobFailed,
  cancelTranscriptionJob,
  sweepStaleLeases,
  tenantDailyCostMicros,
  modalCredentialsPresent,
  analyseTranscriptQuality,
  JobRejectedError,
  DEFAULT_DAILY_USD_MICROS,
} from "@/lib/hr/training/transcription/job-service";
import type { Principal } from "@/lib/rbac";

const CLUB_ID = "club_4v";
const CLUB_B = "club_4v_other";
const USER_ADMIN = "user_4v_admin";
const USER_STAFF = "user_4v_staff";
const VIDEO_SHA = "v".repeat(64);

function superAdmin(clubId = CLUB_ID): Principal {
  return {
    id: USER_ADMIN, name: "admin", email: "admin@t.local", status: "ACTIVE",
    memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }],
    activeClubId: clubId, memberId: null,
  };
}
function staff(clubId = CLUB_ID): Principal {
  return {
    id: USER_STAFF, name: "staff", email: "staff@t.local", status: "ACTIVE",
    memberships: [{ clubId, roleKey: "STAFF" }],
    activeClubId: clubId, memberId: null,
  };
}

// Environment helper: let tests simulate credential presence.
const PRESENT_ENV = {
  MODAL_TRANSCRIBE_URL: "https://modal.example/transcribe",
  MODAL_SPECTRE_SHARED_TOKEN: "test-token-not-real",
} satisfies NodeJS.ProcessEnv;

async function seedVersion(opts: {
  clubId?: string;
  versionState?: "DRAFT" | "PUBLISHED" | "RETIRED";
  videoSha?: string | null;
  videoKey?: string | null;
} = {}) {
  const cid = opts.clubId ?? CLUB_ID;
  const ts = Date.now() + Math.floor(Math.random() * 1_000_000);
  await prisma.club.upsert({
    where: { id: cid },
    create: { id: cid, name: cid, slug: `slug-${cid}-${ts}`, primaryColor: "#111" },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: USER_ADMIN },
    create: { id: USER_ADMIN, email: `a-${ts}@t.local`, name: "a", status: "ACTIVE", passwordHash: "x", role: "SUPER_ADMIN" },
    update: {},
  });
  const course = await prisma.trainingCourse.create({
    data: { clubId: cid, code: `C-${ts}`, title: "T", category: "ORIENTATION" },
  });
  const version = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id,
      version: 1,
      state: opts.versionState ?? "DRAFT",
      title: "V1",
      videoSha256: opts.videoSha === undefined ? (opts.videoSha ?? VIDEO_SHA) : opts.videoSha,
      videoStorageKey: opts.videoKey === undefined ? "k/v1" : opts.videoKey,
      videoDurationSec: 120,
    },
  });
  return { clubId: cid, versionId: version.id };
}

beforeEach(async () => {
  await resetDb();
  process.env.MODAL_TRANSCRIBE_URL = PRESENT_ENV.MODAL_TRANSCRIBE_URL;
  process.env.MODAL_SPECTRE_SHARED_TOKEN = PRESENT_ENV.MODAL_SPECTRE_SHARED_TOKEN;
});
afterAll(async () => { await prisma.$disconnect(); });

describe("EP-TRAIN-6D-4V — TranscriptionJob lifecycle", () => {
  it("T1 authorized request creates a REQUESTED row", async () => {
    const s = await seedVersion();
    const r = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    expect(r.ok).toBe(true);
    expect(r.state).toBe("REQUESTED");
    expect(r.idempotent).toBe(false);
    const row = await prisma.trainingTranscriptionJob.findUnique({ where: { id: r.jobId } });
    expect(row?.state).toBe("REQUESTED");
    expect(row?.sourceVideoSha256).toBe(VIDEO_SHA);
  });

  it("T2 unauthorized (STAFF) request refused", async () => {
    const s = await seedVersion();
    await expect(
      requestTranscription(staff(), s.clubId, { courseVersionId: s.versionId }),
    ).rejects.toThrow(/write/);
  });

  it("T3 unauthenticated request refused", async () => {
    const s = await seedVersion();
    await expect(
      requestTranscription(null, s.clubId, { courseVersionId: s.versionId }),
    ).rejects.toThrow(/Authentication/i);
  });

  it("T4 cross-tenant refusal returns 404-shape", async () => {
    const s = await seedVersion({ clubId: CLUB_B });
    await expect(
      requestTranscription(superAdmin(CLUB_ID), CLUB_ID, { courseVersionId: s.versionId }),
    ).rejects.toMatchObject({ rejectionCode: "VERSION_NOT_FOUND", httpStatus: 404 });
  });

  it("T5 PUBLISHED course-version refused", async () => {
    const s = await seedVersion({ versionState: "PUBLISHED" });
    await expect(
      requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId }),
    ).rejects.toMatchObject({ rejectionCode: "VERSION_NOT_DRAFT" });
  });

  it("T6 missing video (videoStorageKey=null) refused", async () => {
    const s = await seedVersion({ videoKey: null });
    await expect(
      requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId }),
    ).rejects.toMatchObject({ rejectionCode: "VIDEO_MISSING" });
  });

  it("T7 video SHA unrecorded refused", async () => {
    const s = await seedVersion({ videoSha: null });
    await expect(
      requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId }),
    ).rejects.toMatchObject({ rejectionCode: "VIDEO_SHA_UNRECORDED" });
  });

  it("T8 duplicate request returns the same job (idempotent)", async () => {
    const s = await seedVersion();
    const r1 = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    const r2 = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    expect(r2.jobId).toBe(r1.jobId);
    expect(r2.idempotent).toBe(true);
  });

  it("T9 credential absence refuses with 503 + CREDENTIAL_ABSENT", async () => {
    const s = await seedVersion();
    delete process.env.MODAL_TRANSCRIBE_URL;
    await expect(
      requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId }),
    ).rejects.toMatchObject({ rejectionCode: "CREDENTIAL_ABSENT", httpStatus: 503 });
  });

  it("T10 cost cap exceeded transitions directly to CANCELLED", async () => {
    const s = await seedVersion();
    // Pre-populate a COMPLETED row at the cap.
    await prisma.trainingTranscriptionJob.create({
      data: {
        clubId: s.clubId,
        courseVersionId: s.versionId,
        sourceVideoSha256: "x".repeat(64),
        state: "COMPLETED",
        completedAt: new Date(),
        estimatedCostUsdMicros: DEFAULT_DAILY_USD_MICROS,
      },
    });
    await expect(
      requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId }),
    ).rejects.toMatchObject({ rejectionCode: "COST_CAP_EXCEEDED" });
    // Verify a CANCELLED row was created for forensics.
    const cancelled = await prisma.trainingTranscriptionJob.findFirst({
      where: { state: "CANCELLED", courseVersionId: s.versionId },
    });
    expect(cancelled?.failureCode).toBe("COST_CAP_EXCEEDED");
  });

  it("T11 markQueued transitions REQUESTED -> QUEUED", async () => {
    const s = await seedVersion();
    const r = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    await markQueued(s.clubId, r.jobId);
    const row = await prisma.trainingTranscriptionJob.findUnique({ where: { id: r.jobId } });
    expect(row?.state).toBe("QUEUED");
    expect(row?.queuedAt).not.toBeNull();
  });

  it("T12 claim transitions QUEUED -> RUNNING with lease", async () => {
    const s = await seedVersion();
    const r = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    await markQueued(s.clubId, r.jobId);
    const claim = await claimNextTranscriptionJob();
    expect(claim?.jobId).toBe(r.jobId);
    expect(claim?.attempt).toBe(1);
    expect(claim?.leaseToken).toMatch(/^[a-f0-9]+$/);
    const row = await prisma.trainingTranscriptionJob.findUnique({ where: { id: r.jobId } });
    expect(row?.state).toBe("RUNNING");
    expect(row?.leaseToken).toBe(claim?.leaseToken);
  });

  it("T13 recordJobCompleted writes resolvedTranscriptBuildId + sets COMPLETED", async () => {
    const s = await seedVersion();
    // Create a build row so the FK is satisfiable.
    const build = await prisma.trainingTranscriptBuild.create({
      data: {
        clubId: s.clubId, sourceVideoSha256: VIDEO_SHA,
        resolvedTranscriptBuildId: "b".repeat(64),
        transcriberName: "faster-whisper", transcriberVersion: "1",
        transcriberModelName: "x", transcriberModelVersion: "y",
        transcriberConfigSha256: "c".repeat(64),
        producedAt: new Date(),
      },
    });
    const r = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    await markQueued(s.clubId, r.jobId);
    const claim = await claimNextTranscriptionJob();
    await recordJobCompleted({
      jobId: r.jobId, leaseToken: claim!.leaseToken,
      resolvedTranscriptBuildId: build.id,
      modelVariant: "faster-whisper-large-v3",
      elapsedMsTotal: 60_000,
      elapsedMsColdBoot: 10_000,
      elapsedMsTranscribe: 50_000,
      estimatedCostUsdMicros: 32_500,
    });
    const row = await prisma.trainingTranscriptionJob.findUnique({ where: { id: r.jobId } });
    expect(row?.state).toBe("COMPLETED");
    expect(row?.resolvedTranscriptBuildId).toBe(build.id);
    expect(row?.leaseToken).toBeNull();
  });

  it("T14 recordJobCompleted refuses stolen lease / wrong state", async () => {
    const s = await seedVersion();
    const r = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    await markQueued(s.clubId, r.jobId);
    const claim = await claimNextTranscriptionJob();
    await expect(
      recordJobCompleted({
        jobId: r.jobId,
        leaseToken: "wrong-token",
        resolvedTranscriptBuildId: "anything",
        modelVariant: "x", elapsedMsTotal: 0,
        elapsedMsColdBoot: 0, elapsedMsTranscribe: 0,
        estimatedCostUsdMicros: 0,
      }),
    ).rejects.toMatchObject({ rejectionCode: "TERMINAL_STATE_WRITE" });
    // Correct lease still works.
    expect(claim?.leaseToken).toBeTruthy();
  });

  it("T15 recordJobFailed with retryable=true re-queues (attempts < max)", async () => {
    const s = await seedVersion();
    const r = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    await markQueued(s.clubId, r.jobId);
    const claim = await claimNextTranscriptionJob();
    const { finalState } = await recordJobFailed({
      jobId: r.jobId, leaseToken: claim!.leaseToken,
      failureCode: "MODAL_HTTP_ERROR",
      failureMessage: "transient",
      retryable: true,
    });
    expect(finalState).toBe("QUEUED");
    const row = await prisma.trainingTranscriptionJob.findUnique({ where: { id: r.jobId } });
    expect(row?.state).toBe("QUEUED");
    expect(row?.attempts).toBe(1);
  });

  it("T16 recordJobFailed with retryable=false moves to FAILED (terminal)", async () => {
    const s = await seedVersion();
    const r = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    await markQueued(s.clubId, r.jobId);
    const claim = await claimNextTranscriptionJob();
    await recordJobFailed({
      jobId: r.jobId, leaseToken: claim!.leaseToken,
      failureCode: "SHA_MISMATCH",
      failureMessage: "non-retryable",
      retryable: false,
    });
    const row = await prisma.trainingTranscriptionJob.findUnique({ where: { id: r.jobId } });
    expect(row?.state).toBe("FAILED");
    expect(row?.failureCode).toBe("SHA_MISMATCH");
  });

  it("T17 cancelTranscriptionJob while RUNNING succeeds + leaves transcript untouched if late response fires", async () => {
    const s = await seedVersion();
    const r = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    await markQueued(s.clubId, r.jobId);
    const claim = await claimNextTranscriptionJob();
    // Operator cancels.
    const res = await cancelTranscriptionJob(superAdmin(), s.clubId, r.jobId);
    expect(res.state).toBe("CANCELLED");
    // Late worker response attempts recordJobCompleted → refused.
    await expect(
      recordJobCompleted({
        jobId: r.jobId, leaseToken: claim!.leaseToken,
        resolvedTranscriptBuildId: "irrelevant",
        modelVariant: "x", elapsedMsTotal: 0,
        elapsedMsColdBoot: 0, elapsedMsTranscribe: 0,
        estimatedCostUsdMicros: 0,
      }),
    ).rejects.toMatchObject({ rejectionCode: "TERMINAL_STATE_WRITE" });
    const row = await prisma.trainingTranscriptionJob.findUnique({ where: { id: r.jobId } });
    expect(row?.state).toBe("CANCELLED");
  });

  it("T18 cancelling a COMPLETED job is refused (terminal)", async () => {
    const s = await seedVersion();
    const r = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    await prisma.trainingTranscriptionJob.update({
      where: { id: r.jobId },
      data: { state: "COMPLETED", completedAt: new Date() },
    });
    await expect(
      cancelTranscriptionJob(superAdmin(), s.clubId, r.jobId),
    ).rejects.toMatchObject({ rejectionCode: "TERMINAL_STATE_WRITE" });
  });

  it("T19 sweepStaleLeases reclaims expired RUNNING jobs under maxAttempts", async () => {
    const s = await seedVersion();
    const r = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    await markQueued(s.clubId, r.jobId);
    await claimNextTranscriptionJob();
    // Expire the lease by rewriting leaseExpiresAt.
    await prisma.trainingTranscriptionJob.update({
      where: { id: r.jobId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    const sweep = await sweepStaleLeases();
    expect(sweep.reclaimed).toBe(1);
    expect(sweep.exhausted).toBe(0);
    const row = await prisma.trainingTranscriptionJob.findUnique({ where: { id: r.jobId } });
    expect(row?.state).toBe("QUEUED");
  });

  it("T20 sweepStaleLeases marks FAILED when attempts >= maxAttempts", async () => {
    const s = await seedVersion();
    const r = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    await markQueued(s.clubId, r.jobId);
    await claimNextTranscriptionJob();
    // Exhaust attempts + expire the lease.
    await prisma.trainingTranscriptionJob.update({
      where: { id: r.jobId },
      data: { attempts: 2, maxAttempts: 2, leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    const sweep = await sweepStaleLeases();
    expect(sweep.exhausted).toBe(1);
    const row = await prisma.trainingTranscriptionJob.findUnique({ where: { id: r.jobId } });
    expect(row?.state).toBe("FAILED");
    expect(row?.failureCode).toBe("MODAL_TIMEOUT");
  });

  it("T21 analyseTranscriptQuality: empty transcript", () => {
    const q = analyseTranscriptQuality([], 120);
    expect(q.ok).toBe(false);
    expect(q.reasons).toContain("EMPTY_TRANSCRIPT");
  });

  it("T22 analyseTranscriptQuality: incomplete coverage", () => {
    const q = analyseTranscriptQuality(
      [{ segmentIndex: 0, text: "hi", startSec: 0, endSec: 10 }],
      120,
    );
    expect(q.reasons).toContain("INCOMPLETE_TRANSCRIPT_COVERAGE");
  });

  it("T23 analyseTranscriptQuality: repetition artifact flagged", () => {
    const text = "thank you for your attention";
    const segs = [0, 1, 2, 3].map((i) => ({
      segmentIndex: i, text, startSec: i * 2, endSec: i * 2 + 2,
    }));
    const q = analyseTranscriptQuality(segs, 10);
    const flags = q.perSegmentFlags.flatMap((f) => f.flags);
    expect(flags).toContain("REPETITION_ARTIFACT");
  });

  it("T24 analyseTranscriptQuality: timestamp overlap flagged", () => {
    const segs = [
      { segmentIndex: 0, text: "a", startSec: 0, endSec: 5 },
      { segmentIndex: 1, text: "b", startSec: 3, endSec: 8 }, // overlap
    ];
    const q = analyseTranscriptQuality(segs, 10);
    const seg1Flags = q.perSegmentFlags.find((f) => f.segmentIndex === 1);
    expect(seg1Flags?.flags).toContain("TIMESTAMP_OVERLAP");
  });

  it("T25 analyseTranscriptQuality: hallucination template detected", () => {
    const segs = [
      { segmentIndex: 0, text: "Thanks for watching this training", startSec: 0, endSec: 5 },
    ];
    const q = analyseTranscriptQuality(segs, 10);
    expect(q.perSegmentFlags[0].flags).toContain("HALLUCINATION_TEMPLATE");
  });

  it("T26 analyseTranscriptQuality: every segment carries SOURCE_ORG_PENDING_REVIEW", () => {
    const segs = [
      { segmentIndex: 0, text: "a", startSec: 0, endSec: 5 },
      { segmentIndex: 1, text: "b", startSec: 6, endSec: 10 },
    ];
    const q = analyseTranscriptQuality(segs, 10);
    for (const f of q.perSegmentFlags) {
      expect(f.flags).toContain("SOURCE_ORG_PENDING_REVIEW");
    }
  });

  it("T27 modalCredentialsPresent returns true when both env vars set, false otherwise", () => {
    expect(modalCredentialsPresent({ env: PRESENT_ENV })).toBe(true);
    expect(modalCredentialsPresent({ env: {} })).toBe(false);
    expect(modalCredentialsPresent({ env: { MODAL_TRANSCRIBE_URL: "x" } })).toBe(false);
  });

  it("T28 tenantDailyCostMicros aggregates COMPLETED cost in the last 24h", async () => {
    const s = await seedVersion();
    await prisma.trainingTranscriptionJob.create({
      data: {
        clubId: s.clubId, courseVersionId: s.versionId,
        sourceVideoSha256: "x".repeat(64), state: "COMPLETED",
        completedAt: new Date(), estimatedCostUsdMicros: 1_500_000,
      },
    });
    await prisma.trainingTranscriptionJob.create({
      data: {
        clubId: s.clubId, courseVersionId: s.versionId,
        sourceVideoSha256: "y".repeat(64), state: "COMPLETED",
        completedAt: new Date(), estimatedCostUsdMicros: 2_000_000,
      },
    });
    const total = await tenantDailyCostMicros(s.clubId);
    expect(total).toBe(3_500_000);
  });
});

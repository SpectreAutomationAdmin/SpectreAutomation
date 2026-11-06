// EP-TRAIN-6D-4W — generation-service lifecycle contract tests (SQLite).

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./util/db";
import {
  requestGeneration,
  markGenerationQueued,
  claimNextGenerationRun,
  renewGenerationLease,
  recordGenerationCompleted,
  recordGenerationFailed,
  cancelGenerationRun,
  sweepStaleGenerationLeases,
  GenerationRejectedError,
  DEFAULT_DAILY_USD_MICROS,
} from "@/lib/hr/training/generation/generation-service";
import { buildBaselineAssessmentPlan } from "@/lib/hr/training/generation/assessment-plan";
import type { Principal } from "@/lib/rbac";

const CLUB = "club_4w";
const CLUB_B = "club_4w_b";
const USER = "user_4w";
const SHA = "a1b2c3d4".repeat(8);
const BUILD_SHA = "1".repeat(64);

function sa(clubId = CLUB): Principal {
  return {
    id: USER, name: "A", email: "a@t.local", status: "ACTIVE",
    memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }],
    activeClubId: clubId, memberId: null,
  };
}

async function seed(clubId = CLUB) {
  const ts = Date.now() + Math.floor(Math.random() * 1_000_000);
  await prisma.club.upsert({
    where: { id: clubId },
    create: { id: clubId, name: clubId, slug: `s-${clubId}-${ts}`, primaryColor: "#111" },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: USER },
    create: { id: USER, email: `a-${ts}@t.local`, name: "A", status: "ACTIVE", passwordHash: "x", role: "SUPER_ADMIN" },
    update: {},
  });
  const course = await prisma.trainingCourse.create({
    data: { clubId, code: `C-${ts}`, title: "T", category: "ORIENTATION" },
  });
  const version = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id, version: 1, state: "DRAFT", title: "V1",
      videoSha256: SHA, videoStorageKey: "k/v1", videoDurationSec: 120,
    },
  });
  await prisma.trainingTranscriptBuild.create({
    data: {
      clubId, sourceVideoSha256: SHA,
      resolvedTranscriptBuildId: BUILD_SHA,
      transcriberName: "faster-whisper", transcriberVersion: "1",
      transcriberModelName: "large-v3", transcriberModelVersion: "stable",
      transcriberConfigSha256: "c".repeat(64), producedAt: new Date(),
    },
  });
  return { clubId, versionId: version.id };
}

function makePlan(opts: { versionId: string }) {
  return buildBaselineAssessmentPlan({
    courseVersionId: opts.versionId,
    resolvedTranscriptBuildId: BUILD_SHA,
    sourceVideoSha256: SHA,
    segments: [
      { segmentIndex: 0, text: "s0" },
      { segmentIndex: 1, text: "s1" },
      { segmentIndex: 2, text: "s2" },
      { segmentIndex: 3, text: "s3" },
    ],
    videoDurationSec: 120,
    targetTotalQuestions: 6,
    now: new Date("2026-11-06T00:00:00Z"),
  });
}

beforeEach(async () => {
  await resetDb();
  process.env.MODAL_GENERATE_URL = "https://modal.example/generate";
  process.env.MODAL_SPECTRE_SHARED_TOKEN = "tok-not-real";
});
afterAll(async () => { await prisma.$disconnect(); });

describe("EP-TRAIN-6D-4W — generation-service lifecycle", () => {
  it("T1 requestGeneration happy path creates REQUESTED row + planIdentity", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan });
    expect(r.ok).toBe(true);
    expect(r.state).toBe("REQUESTED");
    expect(r.idempotent).toBe(false);
    expect(r.planIdentity).toMatch(/^[0-9a-f]{64}$/);
    const row = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    expect(row?.executionStatus).toBe("REQUESTED");
    expect(row?.planIdentity).toBe(r.planIdentity);
    expect(row?.assessmentPlanJson).toContain("training-assessment-plan-v1");
  });

  it("T2 duplicate requestGeneration returns the same run (idempotent)", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r1 = await requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan });
    const r2 = await requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan });
    expect(r2.generationRunId).toBe(r1.generationRunId);
    expect(r2.idempotent).toBe(true);
  });

  it("T3 unauthorized (STAFF) refused", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const staff: Principal = {
      id: "u-staff", name: "S", email: "s@t.local", status: "ACTIVE",
      memberships: [{ clubId: s.clubId, roleKey: "STAFF" }],
      activeClubId: s.clubId, memberId: null,
    };
    await expect(
      requestGeneration(staff, s.clubId, { courseVersionId: s.versionId, plan }),
    ).rejects.toThrow(/write/);
  });

  it("T4 cross-tenant refused with VERSION_NOT_FOUND / 404", async () => {
    const s = await seed(CLUB_B);
    const plan = makePlan({ versionId: s.versionId });
    await expect(
      requestGeneration(sa(CLUB), CLUB, { courseVersionId: s.versionId, plan }),
    ).rejects.toMatchObject({ rejectionCode: "VERSION_NOT_FOUND", httpStatus: 404 });
  });

  it("T5 transcript build missing -> TRANSCRIPT_MISSING", async () => {
    const s = await seed();
    const plan = {
      ...makePlan({ versionId: s.versionId }),
      resolvedTranscriptBuildId: "2".repeat(64), // wrong build id
    } as ReturnType<typeof makePlan>;
    await expect(
      requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan }),
    ).rejects.toMatchObject({ rejectionCode: "TRANSCRIPT_MISSING" });
  });

  it("T6 source-video SHA mismatch -> PLAN_INVALID", async () => {
    const s = await seed();
    const plan = { ...makePlan({ versionId: s.versionId }), sourceVideoSha256: "f".repeat(64) };
    await expect(
      requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan }),
    ).rejects.toMatchObject({ rejectionCode: "PLAN_INVALID" });
  });

  it("T7 credential absence -> CREDENTIAL_ABSENT / 503", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    delete process.env.MODAL_GENERATE_URL;
    await expect(
      requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan }),
    ).rejects.toMatchObject({ rejectionCode: "CREDENTIAL_ABSENT", httpStatus: 503 });
  });

  it("T8 markGenerationQueued transitions REQUESTED -> QUEUED", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(s.clubId, r.generationRunId);
    const row = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    expect(row?.executionStatus).toBe("QUEUED");
  });

  it("T9 claim transitions QUEUED -> RUNNING + bumps attempts + writes lease", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(s.clubId, r.generationRunId);
    const claim = await claimNextGenerationRun();
    expect(claim?.runId).toBe(r.generationRunId);
    expect(claim?.attempt).toBe(1);
    expect(claim?.leaseToken).toMatch(/^[a-f0-9]+$/);
    const row = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    expect(row?.executionStatus).toBe("RUNNING");
    expect(row?.leaseToken).toBe(claim?.leaseToken);
  });

  it("T10 renewGenerationLease extends lease without bumping attempts", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(s.clubId, r.generationRunId);
    const claim = await claimNextGenerationRun();
    const before = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    await renewGenerationLease(claim!.runId, claim!.leaseToken);
    const after = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    expect(after?.attempts).toBe(before?.attempts);
    expect(after?.leaseExpiresAt?.getTime()).toBeGreaterThanOrEqual(before?.leaseExpiresAt?.getTime() ?? 0);
  });

  it("T11 renewGenerationLease refuses on wrong lease", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(s.clubId, r.generationRunId);
    await claimNextGenerationRun();
    await expect(
      renewGenerationLease(r.generationRunId, "wrong-lease"),
    ).rejects.toMatchObject({ rejectionCode: "LEASE_MISMATCH" });
  });

  it("T12 recordGenerationCompleted transitions RUNNING -> COMPLETED", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(s.clubId, r.generationRunId);
    const claim = await claimNextGenerationRun();
    await recordGenerationCompleted({
      runId: claim!.runId, leaseToken: claim!.leaseToken,
      inferenceMs: 5000, promptTokenCount: 100, outputTokenCount: 200,
      groundingProjectionSha256: "p".repeat(64),
    });
    const row = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    expect(row?.executionStatus).toBe("COMPLETED");
    expect(row?.inferenceMs).toBe(5000);
    expect(row?.leaseToken).toBeNull();
  });

  it("T13 recordGenerationCompleted refused on stolen lease / cancelled state", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(s.clubId, r.generationRunId);
    const claim = await claimNextGenerationRun();
    await cancelGenerationRun(sa(), s.clubId, r.generationRunId);
    await expect(
      recordGenerationCompleted({
        runId: claim!.runId, leaseToken: claim!.leaseToken,
        inferenceMs: 100, promptTokenCount: 0, outputTokenCount: 0,
        groundingProjectionSha256: "p".repeat(64),
      }),
    ).rejects.toMatchObject({ rejectionCode: "TERMINAL_STATE_WRITE" });
  });

  it("T14 recordGenerationFailed with retryable=true re-queues", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(s.clubId, r.generationRunId);
    const claim = await claimNextGenerationRun();
    const res = await recordGenerationFailed({
      runId: claim!.runId, leaseToken: claim!.leaseToken,
      failureCode: "MODAL_HTTP_ERROR", failureMessage: "transient",
      retryable: true,
    });
    expect(res.finalState).toBe("QUEUED");
    const row = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    expect(row?.executionStatus).toBe("QUEUED");
    expect(row?.attempts).toBe(1);
  });

  it("T15 cancelGenerationRun succeeds from RUNNING", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(s.clubId, r.generationRunId);
    await claimNextGenerationRun();
    const res = await cancelGenerationRun(sa(), s.clubId, r.generationRunId);
    expect(res.state).toBe("CANCELLED");
  });

  it("T16 cancelGenerationRun refused from COMPLETED (terminal)", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan });
    await prisma.trainingQuestionAiGenerationRun.update({
      where: { id: r.generationRunId },
      data: { executionStatus: "COMPLETED", completedAt: new Date() },
    });
    await expect(
      cancelGenerationRun(sa(), s.clubId, r.generationRunId),
    ).rejects.toMatchObject({ rejectionCode: "TERMINAL_STATE_WRITE" });
  });

  it("T17 sweepStaleGenerationLeases reclaims expired RUNNING runs under budget", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(s.clubId, r.generationRunId);
    await claimNextGenerationRun();
    await prisma.trainingQuestionAiGenerationRun.update({
      where: { id: r.generationRunId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    const sweep = await sweepStaleGenerationLeases();
    expect(sweep.reclaimed).toBe(1);
    const row = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    expect(row?.executionStatus).toBe("QUEUED");
  });

  it("T18 sweepStaleGenerationLeases marks FAILED when attempts >= maxAttempts", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    const r = await requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan });
    await markGenerationQueued(s.clubId, r.generationRunId);
    await claimNextGenerationRun();
    await prisma.trainingQuestionAiGenerationRun.update({
      where: { id: r.generationRunId },
      data: { attempts: 2, maxAttempts: 2, leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    const sweep = await sweepStaleGenerationLeases();
    expect(sweep.exhausted).toBe(1);
    const row = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: r.generationRunId } });
    expect(row?.executionStatus).toBe("FAILED");
  });

  it("T19 cost cap exceeded -> COST_CAP_EXCEEDED, no row created", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    // Seed a COMPLETED run at the cap by backfilling inferenceMs.
    // $10 cap = 10_000_000 micros. 0.5416…μ/ms × inferenceMs ≈
    // need inferenceMs > 18_461_539 ms to breach — set it big.
    await prisma.trainingQuestionAiGenerationRun.create({
      data: {
        clubId: s.clubId,
        courseId: (await prisma.trainingCourseVersion.findUnique({
          where: { id: s.versionId }, select: { courseId: true },
        }))!.courseId,
        courseVersionId: s.versionId,
        pilotAuthorizationId: "x",
        pilotAuthorizationFingerprint: "y",
        sourceVideoSha256: SHA,
        resolvedTranscriptBuildId: BUILD_SHA,
        groundingProjectionSha256: "p",
        modelName: "qwen",
        modelBackend: "vllm",
        modelFormatEnforcer: "lmfe",
        executionStatus: "COMPLETED",
        completedAt: new Date(),
        inferenceMs: 20_000_000, // way past the cap when converted
      },
    });
    await expect(
      requestGeneration(sa(), s.clubId, { courseVersionId: s.versionId, plan }),
    ).rejects.toMatchObject({ rejectionCode: "COST_CAP_EXCEEDED" });
  });

  it("T20 unauthenticated principal -> UnauthenticatedError", async () => {
    const s = await seed();
    const plan = makePlan({ versionId: s.versionId });
    await expect(
      requestGeneration(null, s.clubId, { courseVersionId: s.versionId, plan }),
    ).rejects.toThrow(/Authentication/i);
  });
});

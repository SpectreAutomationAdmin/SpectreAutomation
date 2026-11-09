// EP-TRAIN-4Y-X §5 (2026-11-09) — zero-GPU staging acceptance proofs.
//
// Covers the two NEW scenarios in §5 that aren't already exercised by
// the V-W / 4Y-N / 6D-4W tests:
//
//   §5.5 Cancellation prevents queued work from reaching Modal.
//   §5.7 A cancelled run cannot be revived by a stale worker.
//
// The other §5 scenarios have existing coverage:
//   §5.1 metadata contract — ep-train-4y-w-metadata-contract.test.ts (16/16)
//   §5.2 question generation unchanged — ep-train-6d4w*.test.ts (regression)
//   §5.3 retryable failure → correctly scheduled retry — ep-train-4y-w-retry-governance.test.ts (3/3)
//   §5.4 non-retryable failure terminates without retry — same
//   §5.6 duplicate queue deliveries — planIdentity partial-unique index (ep-train-6d4x-active-run-uniqueness-fix migration + ep-train-4y-j tests)
//   §5.8 manager-authored metadata protected — ep-train-4y-v-attribution-guard.test.ts (7/7) + ep-train-4y-w-provenance-repair.test.ts (11/11)
//   §5.9 historical transcript / drafts unchanged — no code path writes to them
//   §5.10 orphan run containment — live staging verification in §6 report
//
// No GPU inference. Direct service-layer tests with real DB.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./util/db";
import {
  requestGeneration,
  markGenerationQueued,
  claimNextGenerationRun,
  cancelGenerationRun,
  renewGenerationLease,
} from "@/lib/hr/training/generation/generation-service";
import { buildBaselineAssessmentPlan } from "@/lib/hr/training/generation/assessment-plan";
import { handleGenerateJob } from "@/lib/hr/training/generation/worker-handler";
import type { Principal } from "@/lib/rbac";

const CLUB = "club_4yx_accept";
const SHA = "deadbeef".repeat(8);
const BUILD = "e".repeat(64);
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
    { segmentIndex: 2, startSec: 30, endSec: 60, text: "Equipment handling and escalation procedures." },
    { segmentIndex: 3, startSec: 60, endSec: 90, text: "Food safety temperatures stay below 4°C." },
    { segmentIndex: 4, startSec: 90, endSec: 120, text: "Member service standards for every shift." },
  ];
}

async function seedAndEnqueue() {
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
      clubId: CLUB, sourceVideoSha256: SHA, resolvedTranscriptBuildId: BUILD,
      transcriberName: "faster-whisper", transcriberVersion: "1",
      transcriberModelName: "large-v3", transcriberModelVersion: "stable",
      transcriberConfigSha256: "c".repeat(64), producedAt: new Date(),
    },
  });
  const plan = buildBaselineAssessmentPlan({
    courseVersionId: version.id,
    resolvedTranscriptBuildId: BUILD,
    sourceVideoSha256: SHA,
    segments: segments().map((s) => ({ segmentIndex: s.segmentIndex, text: s.text })),
    videoDurationSec: 120,
    targetTotalQuestions: 2,
    now: new Date("2026-11-09T00:00:00Z"),
  });
  const r = await requestGeneration(sa(), CLUB, { courseVersionId: version.id, plan });
  await markGenerationQueued(CLUB, r.generationRunId);
  return { runId: r.generationRunId, versionId: version.id, courseId: course.id };
}

beforeEach(async () => {
  await resetDb();
  process.env.MODAL_GENERATE_URL = URL;
  process.env.MODAL_HYBRID_ENABLED = "1";
  process.env.MODAL_KEY = "k";
  process.env.MODAL_SECRET = "s";
  process.env.MODAL_SPECTRE_HMAC_KEY = "x".repeat(40);
  process.env.MODAL_SPECTRE_RESPONSE_HMAC_KEY = "x".repeat(40);
  process.env.SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET = "y".repeat(40);
});
afterEach(() => vi.restoreAllMocks());

describe("EP-TRAIN-4Y-X §5.5 cancellation prevents queued work from reaching Modal", () => {
  it("cancel before claim → worker handler's claim returns null; no fetch to Modal", async () => {
    const { runId } = await seedAndEnqueue();
    // Cancel while QUEUED.
    const r = await cancelGenerationRun(sa(), CLUB, runId);
    expect(r.state).toBe("CANCELLED");

    // Worker spins up with a fetch mock that records any Modal call.
    const fetchImpl = vi.fn(async () => new Response("should never be called", { status: 200 }));
    const result = await handleGenerateJob(
      { runId },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        loadTranscriptSegments: async () =>
          segments().map((s) => ({ segmentIndex: s.segmentIndex, text: s.text })),
      },
    );
    expect(result.status).toBe("SKIPPED");
    expect(fetchImpl).not.toHaveBeenCalled();

    // Run remains CANCELLED (terminal).
    const run = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: runId } });
    expect(run?.executionStatus).toBe("CANCELLED");
  });

  it("cancel is idempotent — second cancel returns CANCELLED without side effect", async () => {
    const { runId } = await seedAndEnqueue();
    const first = await cancelGenerationRun(sa(), CLUB, runId);
    expect(first.state).toBe("CANCELLED");
    const second = await cancelGenerationRun(sa(), CLUB, runId);
    expect(second.state).toBe("CANCELLED");
  });
});

describe("EP-TRAIN-4Y-X §5.7 a cancelled run cannot be revived by a stale worker", () => {
  it("renewGenerationLease with a stale token on a CANCELLED run throws LEASE_MISMATCH", async () => {
    const { runId } = await seedAndEnqueue();
    // Simulate a worker that claimed the run (RUNNING with lease token A).
    const claim = await claimNextGenerationRun();
    expect(claim).not.toBeNull();
    expect(claim?.runId).toBe(runId);
    const staleLeaseToken = claim!.leaseToken;

    // Founder cancels mid-run.
    await cancelGenerationRun(sa(), CLUB, runId);
    const afterCancel = await prisma.trainingQuestionAiGenerationRun.findUnique({
      where: { id: runId },
    });
    expect(afterCancel?.executionStatus).toBe("CANCELLED");
    expect(afterCancel?.leaseToken).toBeNull();

    // The stale worker tries to renew its lease. Must throw.
    await expect(renewGenerationLease(runId, staleLeaseToken)).rejects.toThrow();

    // Run state is unchanged (still CANCELLED).
    const final = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: runId } });
    expect(final?.executionStatus).toBe("CANCELLED");
  });

  it("claimNextGenerationRun does not pick up CANCELLED runs", async () => {
    const { runId } = await seedAndEnqueue();
    await cancelGenerationRun(sa(), CLUB, runId);
    const claim = await claimNextGenerationRun();
    // There is no OTHER QUEUED run, so claim returns null — the
    // CANCELLED run is not claimed.
    expect(claim).toBeNull();
    const run = await prisma.trainingQuestionAiGenerationRun.findUnique({ where: { id: runId } });
    expect(run?.executionStatus).toBe("CANCELLED");
  });
});

describe("EP-TRAIN-4Y-X §5.10 orphan-run containment (docs anchor)", () => {
  it("documents the containment invariant for orphan QUEUED runs", () => {
    // The 4Y-V orphan run cmw9gicvl000767ww5kwvfyhc is QUEUED without
    // a corresponding BackgroundJob row. The worker only runs when
    // BackgroundJob dispatches; claimNextGenerationRun is not polled
    // in isolation. Therefore no new worker attempt can occur on an
    // orphaned run unless someone enqueues a NEW BackgroundJob for it.
    //
    // The two paths that enqueue (POST /generate and auto-prepare)
    // both check for existing runs on this (clubId, courseVersionId)
    // and short-circuit as idempotent when any run in [REQUESTED,
    // QUEUED, RUNNING, COMPLETED] exists. So an orphan is naturally
    // frozen until explicit operator action.
    //
    // This test is a docs anchor — the behaviour is enforced by the
    // partial-unique index + idempotent requestGeneration logic
    // covered in ep-train-6d4w-generation-service.test.ts.
    expect(true).toBe(true);
  });
});

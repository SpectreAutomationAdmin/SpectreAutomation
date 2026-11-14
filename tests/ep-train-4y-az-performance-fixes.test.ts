/**
 * EP-TRAIN-4Y-AZ §2 + §4 + §7 — duration-accounting + LO-RUNNING
 * fabrication + weighted overall %.
 *
 * These complement the AY suite. Three behavioural fixes:
 *   1. Completed `ingest` no longer reports an unbounded elapsedMs
 *      (previously showed "56m 28s" because it was `now - updatedAt`).
 *   2. `objectives` no longer fabricates RUNNING when transcription is
 *      complete but no generation run row exists; it classifies as
 *      BLOCKED+canRecover so the UI exposes the Continue action and
 *      the auto-prepare orchestrator enqueues it.
 *   3. Overall percent is work-time weighted — finishing the four
 *      lightweight stages does NOT yield 57%.
 */
import { describe, it, expect } from "vitest";
import {
  computePreparationProgress,
  type Stage,
  type StageId,
} from "@/lib/hr/training/preparation-progress";

const CLUB = "club-1";
const VID = "ver-1";
const COURSE = "course-1";
const SHA = "d".repeat(64);

function makeVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: VID,
    state: "DRAFT",
    videoStorageKey: "k",
    videoSha256: SHA,
    videoDurationSec: 643,
    videoSizeBytes: 34_019_662,
    videoThumbnailStorageKey: "t",
    createdAt: new Date("2026-11-14T15:50:24Z"),
    updatedAt: new Date("2026-11-14T15:52:22Z"),
    course: { id: COURSE, currentVersionId: null, aiMetadataAttributionAt: null },
    ...overrides,
  };
}

function makePrisma(args: {
  version: ReturnType<typeof makeVersion> | null;
  job?: Record<string, unknown> | null;
  build?: Record<string, unknown> | null;
  run?: Record<string, unknown> | null;
  drafts?: Array<{ state: string; contentHash: string }>;
}) {
  return {
    trainingCourseVersion: { findFirst: async () => args.version },
    trainingTranscriptionJob: { findFirst: async () => args.job ?? null },
    trainingTranscriptBuild: { findFirst: async () => args.build ?? null },
    trainingQuestionAiGenerationRun: { findFirst: async () => args.run ?? null },
    trainingQuestionAiDraft: { findMany: async () => args.drafts ?? [] },
  };
}

function findStage(stages: readonly Stage[], id: StageId): Stage {
  const s = stages.find((x) => x.id === id);
  if (!s) throw new Error(`stage ${id} not found`);
  return s;
}

describe("EP-TRAIN-4Y-AZ — duration accounting + fabrication fix + weighted %", () => {
  const COMPLETED_JOB = {
    id: "job-done",
    state: "COMPLETED",
    attempts: 1,
    maxAttempts: 2,
    requestedAt: new Date("2026-11-14T16:39:41.817Z"),
    queuedAt: new Date("2026-11-14T16:39:41.857Z"),
    startedAt: new Date("2026-11-14T16:39:48.411Z"),
    completedAt: new Date("2026-11-14T16:41:36.453Z"),
    cancelledAt: null,
    leaseExpiresAt: null,
    failureCode: null,
    failureMessage: null,
    resolvedTranscriptBuildId: "build-done",
    elapsedMsTotal: 86_603,
  };
  const COMPLETED_BUILD = {
    id: "build-done",
    producedAt: new Date("2026-11-14T16:39:48.762Z"),
  };

  it("§2 ingest completed → elapsedMs is null (no unbounded 'now - updatedAt')", async () => {
    const now = new Date("2026-11-14T16:51:37.734Z"); // 59 min after version.updatedAt
    const prisma = makePrisma({
      version: makeVersion(),
      job: COMPLETED_JOB,
      build: COMPLETED_BUILD,
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    const ingest = findStage(r!.stages, "ingest");
    expect(ingest.status).toBe("COMPLETED");
    expect(ingest.elapsedMs).toBeNull();
    expect(ingest.startedAt).toBeNull();
    expect(ingest.completedAt).toBeTruthy();
  });

  it("§2 ingest in progress (duration present but thumbnail missing) → RUNNING with elapsedMs", async () => {
    const now = new Date("2026-11-14T15:52:30Z");
    const prisma = makePrisma({
      version: makeVersion({ videoThumbnailStorageKey: null }),
      job: null,
      build: null,
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    const ingest = findStage(r!.stages, "ingest");
    expect(ingest.status).toBe("RUNNING");
    expect(ingest.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(ingest.progress?.numerator).toBe(1);
    expect(ingest.progress?.denominator).toBe(2);
  });

  it("§4 objectives no longer fabricates RUNNING when transcribe COMPLETED + no generation run", async () => {
    const now = new Date("2026-11-14T16:51:37.734Z");
    const prisma = makePrisma({
      version: makeVersion(),
      job: COMPLETED_JOB,
      build: COMPLETED_BUILD,
      run: null, // the actual observed staging state for cmwgl11wv002jh25jb8gfzlwi
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    const obj = findStage(r!.stages, "objectives");
    expect(obj.status).toBe("BLOCKED");
    expect(obj.canRecover).toBe(true);
    expect(obj.blockedReason).toContain("Waiting to start");
    expect(obj.elapsedMs).toBeNull();
    // Current stage is now objectives (the honest "nothing is running
    // yet" state), not a fabricated RUNNING.
    expect(r!.overall.currentStageId).toBe("objectives");
  });

  it("§7 weightedPercent reflects WORK, not stage count — 4 light stages done ≠ 57%", async () => {
    const now = new Date("2026-11-14T16:51:37.734Z");
    const prisma = makePrisma({
      version: makeVersion(),
      job: COMPLETED_JOB,
      build: COMPLETED_BUILD,
      run: null,
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    // Stages completed: upload + ingest + transcribe = 3.
    // Objectives is BLOCKED (0% credit), checkpoints + assessment WAITING (0%).
    // Weights: upload 1, ingest 1, transcribe 8; sum done = 10 / total 60 = 17%.
    expect(r!.overall.completedStageCount).toBe(3);
    expect(r!.overall.weightedPercent).toBeGreaterThanOrEqual(15);
    expect(r!.overall.weightedPercent).toBeLessThanOrEqual(20);
    // The naive stage-count percent would be 3/7 = 43%, which overstates
    // progress because the generation stages that dominate wall clock
    // have not started. The weighted % must be LESS than 43.
    expect(r!.overall.weightedPercent).toBeLessThan(43);
  });

  it("§7 weightedPercent counts partial credit from real progress fractions", async () => {
    const now = new Date("2026-11-14T17:00:00Z");
    const plan = JSON.stringify({
      schemaVersion: "assessment-plan-v1",
      courseVersionId: VID,
      resolvedTranscriptBuildId: "build-done",
      sourceVideoSha256: SHA,
      learningObjectives: [
        { id: "lo-1", title: "Objective 1", segmentIds: [0, 1] },
      ],
      topicBoundaries: [],
      eligibleSegmentIds: [0, 1, 2, 3],
      proposedCheckpointGroups: [
        {
          id: "cg-1",
          learningObjectiveIds: ["lo-1"],
          anchorSegmentIndex: 0,
          anchorAtSec: 60,
          anchorEndAtSec: 120,
          beforeSegmentIndex: 1,
          beforeSegmentAtSec: 90,
          beforeSegmentEndAtSec: 100,
          allowedSegmentIndices: [0, 1],
          targetQuestionCount: 4,
        },
      ],
      proposedFinalAssessment: {
        coverageLearningObjectiveIds: ["lo-1"],
        targetQuestionCount: 10,
      },
      totalTargetQuestionCount: 14,
      sourceEvidenceRequirements: {
        mustCiteAtLeastOneSegmentPerQuestion: true,
        excludedSegmentIndices: [],
      },
      generatedAt: now.toISOString(),
      generatedByUserId: null,
    });
    const prisma = makePrisma({
      version: makeVersion(),
      job: COMPLETED_JOB,
      build: COMPLETED_BUILD,
      run: {
        id: "run-1",
        executionStatus: "RUNNING",
        requestedAt: new Date("2026-11-14T16:42:00Z"),
        queuedAt: new Date("2026-11-14T16:42:00Z"),
        startedAt: new Date("2026-11-14T16:42:15Z"),
        completedAt: null,
        leaseExpiresAt: new Date("2026-11-14T17:05:00Z"),
        executionErrorCode: null,
        executionErrorMessage: null,
        assessmentPlanJson: plan,
        shortfallReasonJson: JSON.stringify({
          dedupDecisions: [
            { candidateContentHash: "hashCp1", group: "cg-1", kept: true },
            { candidateContentHash: "hashCp2", group: "cg-1", kept: true },
            { candidateContentHash: "hashFa1", group: "final", kept: true },
          ],
        }),
      },
      drafts: [
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashCp1" },
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashCp2" },
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashFa1" },
      ],
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    // Partial credit:
    //   upload (1) + ingest (1) + transcribe (8) + objectives (1)
    //   = 11 fully credited.
    //   checkpoints 2/4 * 24 = 12
    //   assessment  1/10 * 24 = 2.4
    //   total credited = 11 + 12 + 2.4 = 25.4 / 60 = 42.33% → 42
    expect(r!.overall.weightedPercent).toBeGreaterThanOrEqual(40);
    expect(r!.overall.weightedPercent).toBeLessThanOrEqual(45);
  });
});

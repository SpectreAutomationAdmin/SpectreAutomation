/**
 * EP-TRAIN-4Y-BB §2 + §5 — duration-based sizing + preparation
 * lifecycle outcome classification + marker resolver preference.
 */
import { describe, it, expect } from "vitest";
import { sizeForDuration, DURATION_SIZING_POLICY, clampToBucket } from "@/lib/hr/training/generation/duration-sizing";
import { computePreparationProgress, type Stage, type StageId } from "@/lib/hr/training/preparation-progress";

const CLUB = "club-1";
const VID = "ver-1";
const SHA = "e".repeat(64);

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
    course: { id: "c1", currentVersionId: null, aiMetadataAttributionAt: null },
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

describe("EP-TRAIN-4Y-BB §2 — duration-based sizing", () => {
  it("maps 643-sec video to the 10-15 min bucket (default 4 CP + 8 FA)", () => {
    const r = sizeForDuration(643);
    expect(r.bucket.label).toBe("10-15 minutes");
    expect(r.checkpointCount).toBe(4);
    expect(r.finalCount).toBe(8);
    expect(r.totalCount).toBe(12);
  });

  it("maps every table bucket to its documented defaults", () => {
    const expected: Array<[number, number, number]> = [
      // [sec, cp, fa]
      [60, 1, 4],       // under 3 min
      [240, 2, 5],      // 3-5 min
      [540, 3, 6],      // 5-10 min
      [643, 4, 8],      // 10-15 min (current course)
      [1200, 6, 10],    // 15-30 min
      [2700, 10, 12],   // 30-60 min
      [5400, 14, 16],   // over 60 min
    ];
    for (const [sec, cp, fa] of expected) {
      const r = sizeForDuration(sec);
      expect({ sec, cp: r.checkpointCount, fa: r.finalCount }).toEqual({ sec, cp, fa });
    }
  });

  it("clamps caller overrides to the bucket's min/max", () => {
    const bucket = DURATION_SIZING_POLICY.find((b) => b.label === "10-15 minutes")!;
    expect(clampToBucket(bucket, { checkpointCount: 100 })).toEqual({ checkpointCount: 5, finalCount: 8 });
    expect(clampToBucket(bucket, { checkpointCount: -3 })).toEqual({ checkpointCount: 3, finalCount: 8 });
    expect(clampToBucket(bucket, { finalCount: 50 })).toEqual({ checkpointCount: 4, finalCount: 10 });
  });

  it("falls back to the first bucket for null / 0 duration", () => {
    expect(sizeForDuration(null).bucket.label).toBe("under 3 minutes");
    expect(sizeForDuration(0).bucket.label).toBe("under 3 minutes");
    expect(sizeForDuration(-5).bucket.label).toBe("under 3 minutes");
  });
});

describe("EP-TRAIN-4Y-BB §5 — preparation-lifecycle outcome", () => {
  const COMPLETED_JOB = {
    id: "job-done", state: "COMPLETED", attempts: 1, maxAttempts: 2,
    requestedAt: new Date("2026-11-14T16:39:41Z"),
    queuedAt: new Date("2026-11-14T16:39:41Z"),
    startedAt: new Date("2026-11-14T16:39:48Z"),
    completedAt: new Date("2026-11-14T16:41:36Z"),
    cancelledAt: null, leaseExpiresAt: null,
    failureCode: null, failureMessage: null,
    resolvedTranscriptBuildId: "build-done", elapsedMsTotal: 86_603,
  };
  const COMPLETED_BUILD = { id: "build-done", producedAt: new Date("2026-11-14T16:39:48Z") };

  function makeRun(status: string, extras: Record<string, unknown> = {}) {
    return {
      id: "run-x",
      executionStatus: status,
      requestedAt: new Date("2026-11-14T17:40:47Z"),
      queuedAt: new Date("2026-11-14T17:40:47Z"),
      startedAt: new Date("2026-11-14T17:40:48Z"),
      completedAt: new Date("2026-11-14T17:42:42Z"),
      leaseExpiresAt: null,
      executionErrorCode: null,
      executionErrorMessage: null,
      assessmentPlanJson: JSON.stringify({
        schemaVersion: "assessment-plan-v1",
        courseVersionId: VID,
        resolvedTranscriptBuildId: "build-done",
        sourceVideoSha256: SHA,
        learningObjectives: [{ id: "lo-1", title: "L1", segmentIds: [0] }],
        topicBoundaries: [],
        eligibleSegmentIds: [0, 1, 2],
        proposedCheckpointGroups: [
          { id: "cg-1", learningObjectiveIds: ["lo-1"], anchorSegmentIndex: 0, anchorAtSec: 60, anchorEndAtSec: 120, beforeSegmentIndex: 0, beforeSegmentAtSec: 90, beforeSegmentEndAtSec: 100, allowedSegmentIndices: [0], targetQuestionCount: 1 },
        ],
        proposedFinalAssessment: { coverageLearningObjectiveIds: ["lo-1"], targetQuestionCount: 5 },
        totalTargetQuestionCount: 6,
        sourceEvidenceRequirements: { mustCiteAtLeastOneSegmentPerQuestion: true, excludedSegmentIndices: [] },
        generatedAt: new Date("2026-11-14T17:40:48Z").toISOString(),
        generatedByUserId: null,
      }),
      shortfallReasonJson: JSON.stringify({
        dedupDecisions: [
          { candidateContentHash: "hashFa1", group: "final", kept: true },
          { candidateContentHash: "hashFa2", group: "final", kept: true },
          { candidateContentHash: "hashFa3", group: "final", kept: true },
          { candidateContentHash: "hashFa4", group: "final", kept: true },
        ],
      }),
      ...extras,
    };
  }

  it("PARTIALLY_GENERATED when run COMPLETED but produced less than planned (4 FA of 5 + 0 CP of 1)", async () => {
    // Matches the exact shape of cmwgl11wv002jh25jb8gfzlwi today.
    const now = new Date("2026-11-14T18:00:00Z");
    const prisma = makePrisma({
      version: makeVersion(),
      job: COMPLETED_JOB,
      build: COMPLETED_BUILD,
      run: makeRun("COMPLETED"),
      drafts: [
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashFa1" },
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashFa2" },
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashFa3" },
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashFa4" },
      ],
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    expect(r!.overall.outcome).toBe("PARTIALLY_GENERATED");
    expect(r!.overall.generationShortfall).toEqual({
      checkpointProduced: 0,
      checkpointPlanned: 1,
      finalProduced: 4,
      finalPlanned: 5,
    });
  });

  it("READY_FOR_REVIEW when every stage COMPLETED AND no shortfall", async () => {
    const now = new Date("2026-11-14T18:00:00Z");
    const prisma = makePrisma({
      version: makeVersion(),
      job: COMPLETED_JOB,
      build: COMPLETED_BUILD,
      run: makeRun("COMPLETED"),
      drafts: [
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashCp1" },
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashFa1" },
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashFa2" },
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashFa3" },
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashFa4" },
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashFa5" },
      ],
    });
    // Different shortfall map: cg-1 for CP, final for FA.
    (prisma.trainingQuestionAiGenerationRun as { findFirst: () => Promise<Record<string, unknown>> }).findFirst = async () => ({
      ...makeRun("COMPLETED"),
      shortfallReasonJson: JSON.stringify({
        dedupDecisions: [
          { candidateContentHash: "hashCp1", group: "cg-1", kept: true },
          { candidateContentHash: "hashFa1", group: "final", kept: true },
          { candidateContentHash: "hashFa2", group: "final", kept: true },
          { candidateContentHash: "hashFa3", group: "final", kept: true },
          { candidateContentHash: "hashFa4", group: "final", kept: true },
          { candidateContentHash: "hashFa5", group: "final", kept: true },
        ],
      }),
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    expect(r!.overall.outcome).toBe("READY_FOR_REVIEW");
    expect(r!.overall.generationShortfall).toBeNull();
  });

  it("BLOCKED when objectives is BLOCKED (no run yet) — not PREPARING", async () => {
    const now = new Date("2026-11-14T18:00:00Z");
    const prisma = makePrisma({
      version: makeVersion(),
      job: COMPLETED_JOB,
      build: COMPLETED_BUILD,
      run: null, // no generation run yet
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    expect(r!.overall.outcome).toBe("BLOCKED");
  });

  it("PREPARING when a stage is still RUNNING and no shortfall yet", async () => {
    const now = new Date("2026-11-14T18:00:00Z");
    const prisma = makePrisma({
      version: makeVersion(),
      job: COMPLETED_JOB,
      build: COMPLETED_BUILD,
      run: makeRun("RUNNING"),
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    expect(r!.overall.outcome).toBe("PREPARING");
  });
});

/**
 * EP-TRAIN-4Y-AY §7/§8 — preparation-progress computation contract.
 *
 * Covers the seven-stage classifier end-to-end against a fake prisma
 * surface. Every assertion is on real telemetry fields — no snapshot
 * tests, no fabricated percents — so a regression that makes a stage
 * drift (e.g. BLOCKED becomes RUNNING, or a percent is miscomputed)
 * fails here.
 */
import { describe, it, expect } from "vitest";
import {
  computePreparationProgress,
  MAX_QUEUE_WAIT_MS,
  LEASE_GRACE_MS,
  type Stage,
  type StageId,
} from "@/lib/hr/training/preparation-progress";

const CLUB = "club-1";
const VID = "ver-1";
const COURSE = "course-1";
const SHA = "a".repeat(64);

type VersionRow = {
  id: string;
  state: string;
  videoStorageKey: string | null;
  videoSha256: string | null;
  videoDurationSec: number | null;
  videoSizeBytes: number | null;
  videoThumbnailStorageKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  course: { id: string; currentVersionId: string | null; aiMetadataAttributionAt: Date | null };
};

function makeVersion(overrides: Partial<VersionRow> = {}): VersionRow {
  return {
    id: VID,
    state: "DRAFT",
    videoStorageKey: null,
    videoSha256: null,
    videoDurationSec: null,
    videoSizeBytes: null,
    videoThumbnailStorageKey: null,
    createdAt: new Date("2026-11-14T15:50:00Z"),
    updatedAt: new Date("2026-11-14T15:52:00Z"),
    course: { id: COURSE, currentVersionId: null, aiMetadataAttributionAt: null },
    ...overrides,
  };
}

type Fake = ReturnType<typeof makeFakePrisma>;

function makeFakePrisma(args: {
  version: VersionRow | null;
  job?: Record<string, unknown> | null;
  build?: Record<string, unknown> | null;
  run?: Record<string, unknown> | null;
  drafts?: Array<{ state: string; contentHash: string }>;
}) {
  return {
    trainingCourseVersion: {
      findFirst: async (_q: unknown) => args.version,
    },
    trainingTranscriptionJob: {
      findFirst: async (_q: unknown) => args.job ?? null,
    },
    trainingTranscriptBuild: {
      findFirst: async (_q: unknown) => args.build ?? null,
    },
    trainingQuestionAiGenerationRun: {
      findFirst: async (_q: unknown) => args.run ?? null,
    },
    trainingQuestionAiDraft: {
      findMany: async (_q: unknown) => args.drafts ?? [],
    },
  };
}

function findStage(stages: readonly Stage[], id: StageId): Stage {
  const s = stages.find((x) => x.id === id);
  if (!s) throw new Error(`stage ${id} not found`);
  return s;
}

describe("EP-TRAIN-4Y-AY — computePreparationProgress", () => {
  it("returns null for a cross-tenant / missing version", async () => {
    const prisma = makeFakePrisma({ version: null });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID },
      prisma as unknown as never,
    );
    expect(r).toBeNull();
  });

  it("§1 upload RUNNING when video sha256 is not yet persisted", async () => {
    const prisma = makeFakePrisma({ version: makeVersion({ videoSha256: null }) });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now: new Date("2026-11-14T16:00:00Z") },
      prisma as unknown as never,
    );
    expect(r).not.toBeNull();
    expect(findStage(r!.stages, "upload").status).toBe("RUNNING");
    expect(findStage(r!.stages, "ingest").status).toBe("WAITING");
  });

  it("§1 upload COMPLETED when videoSha256 is persisted", async () => {
    const prisma = makeFakePrisma({
      version: makeVersion({
        videoSha256: SHA,
        videoDurationSec: 643,
        videoSizeBytes: 34_019_662,
        videoThumbnailStorageKey: "thumb/...",
      }),
      job: null,
      build: null,
      run: null,
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now: new Date("2026-11-14T16:00:00Z") },
      prisma as unknown as never,
    );
    expect(findStage(r!.stages, "upload").status).toBe("COMPLETED");
    expect(findStage(r!.stages, "upload").progress?.percent).toBe(100);
  });

  it("§3 transcribe is BLOCKED (recoverable) when video is uploaded but no job exists — the exact stalled state", async () => {
    const prisma = makeFakePrisma({
      version: makeVersion({
        videoSha256: SHA,
        videoDurationSec: 643,
        videoSizeBytes: 34_019_662,
        videoThumbnailStorageKey: "thumb/...",
      }),
      job: null,
      build: null,
      run: null,
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now: new Date("2026-11-14T16:00:00Z") },
      prisma as unknown as never,
    );
    const t = findStage(r!.stages, "transcribe");
    expect(t.status).toBe("BLOCKED");
    expect(t.canRecover).toBe(true);
    expect(t.blockedReason).toContain("Waiting to start");
    // Overall stage identifies this as the current stage so the UI
    // surfaces the recovery action.
    expect(r!.overall.currentStageId).toBe("transcribe");
  });

  it("§6 queue-stuck → BLOCKED when QUEUED for longer than MAX_QUEUE_WAIT_MS", async () => {
    const now = new Date("2026-11-14T16:30:00Z");
    const requestedAt = new Date(now.getTime() - (MAX_QUEUE_WAIT_MS + 60_000));
    const prisma = makeFakePrisma({
      version: makeVersion({
        videoSha256: SHA,
        videoDurationSec: 643,
        videoThumbnailStorageKey: "thumb/...",
      }),
      job: {
        id: "job-1",
        state: "QUEUED",
        attempts: 0,
        maxAttempts: 2,
        requestedAt,
        queuedAt: requestedAt,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        leaseExpiresAt: null,
        failureCode: null,
        failureMessage: null,
        resolvedTranscriptBuildId: null,
        elapsedMsTotal: null,
      },
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    const t = findStage(r!.stages, "transcribe");
    expect(t.status).toBe("BLOCKED");
    expect(t.canRecover).toBe(true);
    expect(t.blockedReason).toContain("queue appears stuck");
  });

  it("§6 lease-expired → BLOCKED when RUNNING past leaseExpiresAt + grace", async () => {
    const now = new Date("2026-11-14T16:30:00Z");
    const startedAt = new Date(now.getTime() - 30 * 60 * 1000);
    const leaseExpiresAt = new Date(now.getTime() - (LEASE_GRACE_MS + 60_000));
    const prisma = makeFakePrisma({
      version: makeVersion({
        videoSha256: SHA,
        videoDurationSec: 643,
        videoThumbnailStorageKey: "thumb/...",
      }),
      job: {
        id: "job-2",
        state: "RUNNING",
        attempts: 1,
        maxAttempts: 2,
        requestedAt: startedAt,
        queuedAt: startedAt,
        startedAt,
        completedAt: null,
        cancelledAt: null,
        leaseExpiresAt,
        failureCode: null,
        failureMessage: null,
        resolvedTranscriptBuildId: null,
        elapsedMsTotal: null,
      },
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    const t = findStage(r!.stages, "transcribe");
    expect(t.status).toBe("BLOCKED");
    expect(t.canRecover).toBe(true);
    expect(t.blockedReason).toContain("worker lost its lease");
  });

  it("§3 transcribe is RUNNING (indeterminate progress) while worker is heartbeating", async () => {
    const now = new Date("2026-11-14T16:05:00Z");
    const startedAt = new Date(now.getTime() - 60 * 1000);
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1000);
    const prisma = makeFakePrisma({
      version: makeVersion({
        videoSha256: SHA,
        videoDurationSec: 643,
        videoThumbnailStorageKey: "thumb/...",
      }),
      job: {
        id: "job-3",
        state: "RUNNING",
        attempts: 1,
        maxAttempts: 2,
        requestedAt: startedAt,
        queuedAt: startedAt,
        startedAt,
        completedAt: null,
        cancelledAt: null,
        leaseExpiresAt,
        failureCode: null,
        failureMessage: null,
        resolvedTranscriptBuildId: null,
        elapsedMsTotal: null,
      },
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    const t = findStage(r!.stages, "transcribe");
    expect(t.status).toBe("RUNNING");
    expect(t.progress).toBeNull(); // never fabricated
    expect(t.elapsedMs).toBeGreaterThanOrEqual(60_000);
  });

  it("§3 transcribe COMPLETED when a TrainingTranscriptBuild exists for the same sha", async () => {
    const now = new Date("2026-11-14T17:00:00Z");
    const prisma = makeFakePrisma({
      version: makeVersion({
        videoSha256: SHA,
        videoDurationSec: 643,
        videoThumbnailStorageKey: "thumb/...",
      }),
      job: {
        id: "job-4",
        state: "COMPLETED",
        attempts: 1,
        maxAttempts: 2,
        requestedAt: new Date(now.getTime() - 15 * 60 * 1000),
        queuedAt: new Date(now.getTime() - 15 * 60 * 1000),
        startedAt: new Date(now.getTime() - 14 * 60 * 1000),
        completedAt: new Date(now.getTime() - 10 * 60 * 1000),
        cancelledAt: null,
        leaseExpiresAt: null,
        failureCode: null,
        failureMessage: null,
        resolvedTranscriptBuildId: "build-1",
        elapsedMsTotal: 240_000,
      },
      build: { id: "build-1", producedAt: new Date(now.getTime() - 10 * 60 * 1000) },
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    const t = findStage(r!.stages, "transcribe");
    expect(t.status).toBe("COMPLETED");
    expect(t.progress?.percent).toBe(100);
    expect(t.progress?.unit).toBe("seconds");
  });

  it("§4-§6 checkpoints + assessment numerators come from real draft rows, not fabricated", async () => {
    const now = new Date("2026-11-14T18:00:00Z");
    // Shortfall map ties contentHashes to groups: cg-1/cg-2 → checkpoints,
    // final → final assessment.
    const shortfallReasonJson = JSON.stringify({
      dedupDecisions: [
        { candidateContentHash: "hashCp1", group: "cg-1", kept: true },
        { candidateContentHash: "hashCp2", group: "cg-2", kept: true },
        { candidateContentHash: "hashFa1", group: "final", kept: true },
        { candidateContentHash: "hashFa2", group: "final", kept: true },
      ],
    });
    const plan = {
      schemaVersion: "assessment-plan-v1",
      courseVersionId: VID,
      resolvedTranscriptBuildId: "build-1",
      sourceVideoSha256: SHA,
      learningObjectives: [
        { id: "lo-1", title: "Objective 1", segmentIds: [0, 1] },
        { id: "lo-2", title: "Objective 2", segmentIds: [2, 3] },
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
          targetQuestionCount: 2,
        },
        {
          id: "cg-2",
          learningObjectiveIds: ["lo-2"],
          anchorSegmentIndex: 2,
          anchorAtSec: 180,
          anchorEndAtSec: 240,
          beforeSegmentIndex: 3,
          beforeSegmentAtSec: 220,
          beforeSegmentEndAtSec: 230,
          allowedSegmentIndices: [2, 3],
          targetQuestionCount: 2,
        },
      ],
      proposedFinalAssessment: {
        coverageLearningObjectiveIds: ["lo-1", "lo-2"],
        targetQuestionCount: 5,
      },
      totalTargetQuestionCount: 9,
      sourceEvidenceRequirements: {
        mustCiteAtLeastOneSegmentPerQuestion: true as const,
        excludedSegmentIndices: [],
      },
      generatedAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
      generatedByUserId: null,
    };
    const prisma = makeFakePrisma({
      version: makeVersion({
        videoSha256: SHA,
        videoDurationSec: 643,
        videoSizeBytes: 34_019_662,
        videoThumbnailStorageKey: "thumb/...",
      }),
      job: {
        id: "job-5",
        state: "COMPLETED",
        attempts: 1,
        maxAttempts: 2,
        requestedAt: new Date(now.getTime() - 20 * 60 * 1000),
        queuedAt: new Date(now.getTime() - 20 * 60 * 1000),
        startedAt: new Date(now.getTime() - 19 * 60 * 1000),
        completedAt: new Date(now.getTime() - 15 * 60 * 1000),
        cancelledAt: null,
        leaseExpiresAt: null,
        failureCode: null,
        failureMessage: null,
        resolvedTranscriptBuildId: "build-1",
        elapsedMsTotal: 240_000,
      },
      build: { id: "build-1", producedAt: new Date(now.getTime() - 15 * 60 * 1000) },
      run: {
        id: "run-1",
        executionStatus: "RUNNING",
        requestedAt: new Date(now.getTime() - 5 * 60 * 1000),
        queuedAt: new Date(now.getTime() - 5 * 60 * 1000),
        startedAt: new Date(now.getTime() - 4 * 60 * 1000),
        completedAt: null,
        leaseExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        executionErrorCode: null,
        executionErrorMessage: null,
        assessmentPlanJson: JSON.stringify(plan),
        shortfallReasonJson,
      },
      drafts: [
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashCp1" },
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashCp2" },
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashFa1" },
        { state: "GENERATED", contentHash: "hashFa2" }, // should NOT count — not in producedStates
      ],
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    expect(findStage(r!.stages, "transcribe").status).toBe("COMPLETED");
    expect(findStage(r!.stages, "objectives").status).toBe("COMPLETED");
    const cp = findStage(r!.stages, "checkpoints");
    const fa = findStage(r!.stages, "assessment");
    expect(cp.progress?.numerator).toBe(2);
    expect(cp.progress?.denominator).toBe(4); // cg-1 (2) + cg-2 (2)
    expect(cp.progress?.percent).toBe(50);
    expect(cp.status).toBe("RUNNING");
    expect(fa.progress?.numerator).toBe(1); // GENERATED does NOT count; attempted != completed
    expect(fa.progress?.denominator).toBe(5);
  });

  it("§4 ready stage is COMPLETED only when ALL six upstream stages are COMPLETED", async () => {
    const now = new Date("2026-11-14T19:00:00Z");
    const plan = {
      schemaVersion: "assessment-plan-v1",
      courseVersionId: VID,
      resolvedTranscriptBuildId: "build-1",
      sourceVideoSha256: SHA,
      learningObjectives: [{ id: "lo-1", title: "Objective 1", segmentIds: [0] }],
      topicBoundaries: [],
      eligibleSegmentIds: [0],
      proposedCheckpointGroups: [
        {
          id: "cg-1",
          learningObjectiveIds: ["lo-1"],
          anchorSegmentIndex: 0,
          anchorAtSec: 60,
          anchorEndAtSec: 120,
          beforeSegmentIndex: 0,
          beforeSegmentAtSec: 90,
          beforeSegmentEndAtSec: 100,
          allowedSegmentIndices: [0],
          targetQuestionCount: 1,
        },
      ],
      proposedFinalAssessment: {
        coverageLearningObjectiveIds: ["lo-1"],
        targetQuestionCount: 1,
      },
      totalTargetQuestionCount: 2,
      sourceEvidenceRequirements: {
        mustCiteAtLeastOneSegmentPerQuestion: true as const,
        excludedSegmentIndices: [],
      },
      generatedAt: now.toISOString(),
      generatedByUserId: null,
    };
    const prisma = makeFakePrisma({
      version: makeVersion({
        videoSha256: SHA,
        videoDurationSec: 643,
        videoSizeBytes: 34_019_662,
        videoThumbnailStorageKey: "thumb/...",
      }),
      job: {
        id: "job-6",
        state: "COMPLETED",
        attempts: 1,
        maxAttempts: 2,
        requestedAt: new Date(now.getTime() - 30 * 60 * 1000),
        queuedAt: new Date(now.getTime() - 30 * 60 * 1000),
        startedAt: new Date(now.getTime() - 29 * 60 * 1000),
        completedAt: new Date(now.getTime() - 25 * 60 * 1000),
        cancelledAt: null,
        leaseExpiresAt: null,
        failureCode: null,
        failureMessage: null,
        resolvedTranscriptBuildId: "build-1",
        elapsedMsTotal: 240_000,
      },
      build: { id: "build-1", producedAt: new Date(now.getTime() - 25 * 60 * 1000) },
      run: {
        id: "run-2",
        executionStatus: "COMPLETED",
        requestedAt: new Date(now.getTime() - 20 * 60 * 1000),
        queuedAt: new Date(now.getTime() - 20 * 60 * 1000),
        startedAt: new Date(now.getTime() - 19 * 60 * 1000),
        completedAt: new Date(now.getTime() - 10 * 60 * 1000),
        leaseExpiresAt: null,
        executionErrorCode: null,
        executionErrorMessage: null,
        assessmentPlanJson: JSON.stringify(plan),
        shortfallReasonJson: JSON.stringify({
          dedupDecisions: [
            { candidateContentHash: "hashCp1", group: "cg-1", kept: true },
            { candidateContentHash: "hashFa1", group: "final", kept: true },
          ],
        }),
      },
      drafts: [
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashCp1" },
        { state: "REQUIRES_HUMAN_REVIEW", contentHash: "hashFa1" },
      ],
    });
    const r = await computePreparationProgress(
      { clubId: CLUB, versionId: VID, now },
      prisma as unknown as never,
    );
    const ready = findStage(r!.stages, "ready");
    expect(ready.status).toBe("COMPLETED");
    expect(r!.overall.completedStageCount).toBe(7);
  });
});

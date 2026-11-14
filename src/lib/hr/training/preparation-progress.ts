// EP-TRAIN-4Y-AY §3 — Canonical seven-stage course-preparation telemetry.
//
// Computes the authoritative preparation status for a single
// TrainingCourseVersion from existing durable state (no new tables).
// Every field is derived from DB rows the manager can inspect; nothing
// is fabricated.
//
// Stages:
//   1. upload       — video bytes committed to R2 (videoSha256 set)
//   2. ingest       — server-side probe + thumbnail landed
//   3. transcribe   — TrainingTranscriptionJob + TrainingTranscriptBuild
//   4. objectives   — learning objectives extracted (assessment plan)
//   5. checkpoints  — CHECKPOINT drafts validated / planned
//   6. assessment   — FINAL_ASSESSMENT drafts validated / planned
//   7. ready        — all six above COMPLETED
//
// Honesty rules (directive §4):
//   - Progress numerator / denominator only when objectively measurable.
//   - Indeterminate progress for active work without measurable fraction.
//   - Attempted questions are NOT completed questions.
//
// Stall classification (directive §6):
//   - WAITING  — upstream dependency not yet satisfied
//   - QUEUED   — job row exists in a queue state (REQUESTED / QUEUED)
//   - RUNNING  — worker actively processing with a live lease
//   - BLOCKED  — queue or lease-expiry exceeded the healthy threshold
//   - FAILED   — terminal failure with reason
//   - COMPLETED — all exit conditions satisfied

import type { PrismaClient } from "@prisma/client";
import {
  parseShortfallGroupMap,
  destinationKindForGroup,
} from "@/lib/hr/training/generation/destination-resolver";

export type StageId =
  | "upload"
  | "ingest"
  | "transcribe"
  | "objectives"
  | "checkpoints"
  | "assessment"
  | "ready";

export type StageStatus =
  | "WAITING"
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED";

export interface StageProgress {
  readonly numerator: number;
  readonly denominator: number;
  /** 0-100 inclusive; always == round(100 * numerator / denominator). */
  readonly percent: number;
  /** Unit label (bytes, seconds, questions, checkpoints, boolean). */
  readonly unit: string;
}

export interface Stage {
  readonly id: StageId;
  readonly label: string;
  readonly status: StageStatus;
  /** Present only when objectively measurable. Indeterminate otherwise. */
  readonly progress: StageProgress | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly elapsedMs: number | null;
  readonly failureReason: string | null;
  readonly blockedReason: string | null;
  readonly canRecover: boolean;
  /** Human-readable description of how progress is measured. */
  readonly measurementMethod: string;
}

export interface PreparationProgress {
  readonly versionId: string;
  readonly overall: {
    readonly currentStageId: StageId;
    readonly currentStageStartedAt: string | null;
    readonly currentStageElapsedMs: number | null;
    readonly lastActivityAt: string | null;
    readonly completedStageCount: number;
    readonly totalStageCount: 7;
  };
  readonly stages: readonly Stage[];
}

// ─── Health thresholds (§6 stall detection) ─────────────────────────

/** QUEUED for longer than this → BLOCKED (queue-stuck classification). */
export const MAX_QUEUE_WAIT_MS = 5 * 60 * 1000;

/** RUNNING past the lease TTL without a refresh → BLOCKED (dead worker). */
export const LEASE_GRACE_MS = 60 * 1000;

// ─── Computation ────────────────────────────────────────────────────

const STAGE_LABELS: Record<StageId, string> = {
  upload: "Uploading video",
  ingest: "Preparing video",
  transcribe: "Transcribing speech",
  objectives: "Identifying learning objectives",
  checkpoints: "Generating knowledge checkpoints",
  assessment: "Preparing final assessment",
  ready: "Course ready for review",
};

const MEASUREMENT_METHOD: Record<StageId, string> = {
  upload: "videoSha256 present on the version row",
  ingest: "videoDurationSec and videoThumbnailStorageKey present on the version row",
  transcribe: "TrainingTranscriptionJob lifecycle + TrainingTranscriptBuild existence",
  objectives: "learningObjectives count in the run's assessmentPlanJson",
  checkpoints: "TrainingQuestionAiDraft rows with destination CHECKPOINT vs plan's proposedCheckpointGroups target",
  assessment: "TrainingQuestionAiDraft rows with destination FINAL_ASSESSMENT vs plan's proposedFinalAssessment target",
  ready: "all six upstream stages COMPLETED",
};

function pct(n: number, d: number): number {
  if (d <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((100 * n) / d)));
}

function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function elapsedMs(from: Date | null | undefined, to: Date): number | null {
  return from ? Math.max(0, to.getTime() - from.getTime()) : null;
}

export interface ComputeInput {
  readonly clubId: string;
  readonly versionId: string;
  readonly now?: Date;
}

export async function computePreparationProgress(
  input: ComputeInput,
  prisma: PrismaClient,
): Promise<PreparationProgress | null> {
  const now = input.now ?? new Date();

  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: input.versionId, course: { clubId: input.clubId } },
    select: {
      id: true,
      state: true,
      videoStorageKey: true,
      videoSha256: true,
      videoDurationSec: true,
      videoSizeBytes: true,
      videoThumbnailStorageKey: true,
      createdAt: true,
      updatedAt: true,
      course: {
        select: {
          id: true,
          currentVersionId: true,
          aiMetadataAttributionAt: true,
        },
      },
    },
  });
  if (!version) return null;

  // ── 1. UPLOAD ────────────────────────────────────────────────────
  const uploadCompleted = !!version.videoSha256;
  const upload: Stage = {
    id: "upload",
    label: STAGE_LABELS.upload,
    status: uploadCompleted ? "COMPLETED" : "RUNNING",
    progress: uploadCompleted
      ? {
          numerator: version.videoSizeBytes ?? 0,
          denominator: version.videoSizeBytes ?? 0,
          percent: 100,
          unit: "bytes",
        }
      : null,
    startedAt: isoOrNull(version.createdAt),
    completedAt: uploadCompleted ? isoOrNull(version.updatedAt) : null,
    lastActivityAt: isoOrNull(version.updatedAt),
    elapsedMs: uploadCompleted
      ? elapsedMs(version.createdAt, version.updatedAt)
      : elapsedMs(version.createdAt, now),
    failureReason: null,
    blockedReason: null,
    canRecover: !uploadCompleted,
    measurementMethod: MEASUREMENT_METHOD.upload,
  };

  // ── 2. INGEST (server-side probe + thumbnail) ────────────────────
  const ingestCompleted =
    uploadCompleted &&
    typeof version.videoDurationSec === "number" &&
    version.videoDurationSec > 0;
  const ingestHasThumbnail = !!version.videoThumbnailStorageKey;
  const ingest: Stage = {
    id: "ingest",
    label: STAGE_LABELS.ingest,
    status: !uploadCompleted
      ? "WAITING"
      : ingestCompleted
        ? "COMPLETED"
        : "RUNNING",
    progress: uploadCompleted
      ? {
          numerator:
            (ingestCompleted ? 1 : 0) + (ingestHasThumbnail ? 1 : 0),
          denominator: 2,
          percent: pct(
            (ingestCompleted ? 1 : 0) + (ingestHasThumbnail ? 1 : 0),
            2,
          ),
          unit: "milestones",
        }
      : null,
    startedAt: uploadCompleted ? isoOrNull(version.updatedAt) : null,
    completedAt: ingestCompleted ? isoOrNull(version.updatedAt) : null,
    lastActivityAt: isoOrNull(version.updatedAt),
    elapsedMs: uploadCompleted
      ? elapsedMs(version.updatedAt, now)
      : null,
    failureReason: null,
    blockedReason: null,
    canRecover: uploadCompleted && !ingestCompleted,
    measurementMethod: MEASUREMENT_METHOD.ingest,
  };

  // ── 3. TRANSCRIBE ────────────────────────────────────────────────
  const job = uploadCompleted
    ? await prisma.trainingTranscriptionJob.findFirst({
        where: {
          clubId: input.clubId,
          courseVersionId: version.id,
          sourceVideoSha256: version.videoSha256 ?? "",
        },
        orderBy: { requestedAt: "desc" },
        select: {
          id: true, state: true, attempts: true, maxAttempts: true,
          requestedAt: true, queuedAt: true, startedAt: true,
          completedAt: true, cancelledAt: true, leaseExpiresAt: true,
          failureCode: true, failureMessage: true,
          resolvedTranscriptBuildId: true, elapsedMsTotal: true,
        },
      })
    : null;

  // Transcript may exist from a prior version of the same video.
  const existingBuild =
    uploadCompleted && version.videoSha256
      ? await prisma.trainingTranscriptBuild.findFirst({
          where: {
            clubId: input.clubId,
            sourceVideoSha256: version.videoSha256,
          },
          orderBy: { producedAt: "desc" },
          select: { id: true, producedAt: true },
        })
      : null;

  const transcribe: Stage = classifyTranscribe({
    uploadCompleted,
    job,
    existingBuild,
    now,
    videoDurationSec: version.videoDurationSec,
  });

  // ── 4/5/6. OBJECTIVES / CHECKPOINTS / ASSESSMENT ─────────────────
  const run = uploadCompleted
    ? await prisma.trainingQuestionAiGenerationRun.findFirst({
        where: { clubId: input.clubId, courseVersionId: version.id },
        orderBy: { requestedAt: "desc" },
        select: {
          id: true, executionStatus: true,
          requestedAt: true, queuedAt: true, startedAt: true,
          completedAt: true, leaseExpiresAt: true,
          executionErrorCode: true, executionErrorMessage: true,
          assessmentPlanJson: true, shortfallReasonJson: true,
        },
      })
    : null;

  // Extract plan counts tolerantly. This is a status-surface read — we
  // intentionally do NOT run the strict validator (which rejects plans
  // missing the pilot exclusion policy) because an older-schema or
  // imperfect plan still has real per-stage counts we want to surface.
  // Unknown JSON shapes degrade to nulls → stages render indeterminate.
  let planLearningObjectiveCount: number | null = null;
  let planCheckpointGroupTarget: number | null = null;
  let planFinalAssessmentTarget: number | null = null;
  if (run?.assessmentPlanJson) {
    try {
      const parsed = JSON.parse(run.assessmentPlanJson) as Record<string, unknown>;
      if (Array.isArray(parsed.learningObjectives)) {
        planLearningObjectiveCount = parsed.learningObjectives.length;
      }
      if (Array.isArray(parsed.proposedCheckpointGroups)) {
        let sum = 0;
        for (const g of parsed.proposedCheckpointGroups as unknown[]) {
          if (g && typeof g === "object") {
            const t = (g as { targetQuestionCount?: unknown }).targetQuestionCount;
            if (typeof t === "number") sum += t;
          }
        }
        planCheckpointGroupTarget = sum;
      }
      const fa = parsed.proposedFinalAssessment as Record<string, unknown> | undefined;
      if (fa && typeof fa.targetQuestionCount === "number") {
        planFinalAssessmentTarget = fa.targetQuestionCount;
      }
    } catch {
      // Keep nulls → objectives/checkpoints/assessment render indeterminate.
    }
  }

  // Draft breakdown by destination. Destination isn't a column on
  // TrainingQuestionAiDraft — it's resolved via the run's
  // shortfallReasonJson group map (CP groups → CHECKPOINT,
  // final/fa-* → FINAL_ASSESSMENT). REQUIRES_HUMAN_REVIEW is the
  // canonical "validated and ready for the manager" state;
  // APPROVED_DRAFT and PROMOTED also count as produced.
  const drafts = run
    ? await prisma.trainingQuestionAiDraft.findMany({
        where: {
          clubId: input.clubId,
          courseVersionId: version.id,
          generationRunId: run.id,
        },
        select: { state: true, contentHash: true },
      })
    : [];
  const producedStates = new Set([
    "REQUIRES_HUMAN_REVIEW",
    "APPROVED_DRAFT",
    "PROMOTED",
    "EDITED_VALIDATION_STALE",
    "VALIDATION_PENDING",
  ]);
  const groupMap = parseShortfallGroupMap(run?.shortfallReasonJson ?? null);
  let cpCount = 0;
  let faCount = 0;
  for (const d of drafts) {
    if (!producedStates.has(d.state)) continue;
    const kind = destinationKindForGroup(groupMap.get(d.contentHash) ?? null);
    if (kind === "CHECKPOINT") cpCount++;
    else if (kind === "FINAL_ASSESSMENT") faCount++;
    // UNKNOWN drafts don't count toward either bucket.
  }

  const objectives = classifyObjectives({
    transcribeCompleted: transcribe.status === "COMPLETED",
    attributionAt: version.course.aiMetadataAttributionAt,
    planLearningObjectiveCount,
    run,
    now,
  });

  const checkpoints = classifyGenerationStage({
    stageId: "checkpoints",
    upstreamCompleted: objectives.status === "COMPLETED",
    run,
    numerator: cpCount,
    denominator: planCheckpointGroupTarget,
    unit: "questions",
    now,
  });

  // Assessment waits on OBJECTIVES, not on CHECKPOINTS: both the CP
  // bucket and the FA bucket are populated by the same generation run
  // in parallel, so the FA progress-bar must not sit at WAITING while
  // the CP bar advances.
  const assessment = classifyGenerationStage({
    stageId: "assessment",
    upstreamCompleted: objectives.status === "COMPLETED",
    run,
    numerator: faCount,
    denominator: planFinalAssessmentTarget,
    unit: "questions",
    now,
  });

  // ── 7. READY ─────────────────────────────────────────────────────
  const allUpstream = [
    upload,
    ingest,
    transcribe,
    objectives,
    checkpoints,
    assessment,
  ];
  const upstreamCompleted = allUpstream.every((s) => s.status === "COMPLETED");
  const ready: Stage = {
    id: "ready",
    label: STAGE_LABELS.ready,
    status: upstreamCompleted ? "COMPLETED" : "WAITING",
    progress: {
      numerator: allUpstream.filter((s) => s.status === "COMPLETED").length,
      denominator: 6,
      percent: pct(
        allUpstream.filter((s) => s.status === "COMPLETED").length,
        6,
      ),
      unit: "stages",
    },
    startedAt: null,
    completedAt: upstreamCompleted ? isoOrNull(assessment.completedAt ? new Date(assessment.completedAt) : now) : null,
    lastActivityAt: null,
    elapsedMs: null,
    failureReason: null,
    blockedReason: null,
    canRecover: false,
    measurementMethod: MEASUREMENT_METHOD.ready,
  };

  const stages: Stage[] = [
    upload, ingest, transcribe, objectives, checkpoints, assessment, ready,
  ];

  // Identify current stage = first non-COMPLETED.
  const current = stages.find((s) => s.status !== "COMPLETED") ?? ready;
  const lastActivityAt = stages
    .map((s) => s.lastActivityAt)
    .filter((x): x is string => !!x)
    .sort()
    .pop() ?? null;
  const completedCount = stages.filter((s) => s.status === "COMPLETED").length;

  return {
    versionId: version.id,
    overall: {
      currentStageId: current.id,
      currentStageStartedAt: current.startedAt,
      currentStageElapsedMs: current.elapsedMs,
      lastActivityAt,
      completedStageCount: completedCount,
      totalStageCount: 7,
    },
    stages,
  };
}

// ─── Stage classifiers ──────────────────────────────────────────────

interface TranscribeInput {
  readonly uploadCompleted: boolean;
  readonly job: {
    readonly id: string;
    readonly state: string;
    readonly requestedAt: Date;
    readonly queuedAt: Date | null;
    readonly startedAt: Date | null;
    readonly completedAt: Date | null;
    readonly cancelledAt: Date | null;
    readonly leaseExpiresAt: Date | null;
    readonly failureCode: string | null;
    readonly failureMessage: string | null;
    readonly resolvedTranscriptBuildId: string | null;
    readonly elapsedMsTotal: number | null;
    readonly attempts: number;
    readonly maxAttempts: number;
  } | null;
  readonly existingBuild: { readonly id: string; readonly producedAt: Date } | null;
  readonly now: Date;
  readonly videoDurationSec: number | null;
}

function classifyTranscribe(input: TranscribeInput): Stage {
  const { uploadCompleted, job, existingBuild, now, videoDurationSec } = input;

  if (!uploadCompleted) {
    return stageShell("transcribe", "WAITING", {
      blockedReason: null,
      measurementMethod: MEASUREMENT_METHOD.transcribe,
    });
  }

  // Build reused from a prior upload counts as COMPLETED.
  if (existingBuild && (!job || job.state === "COMPLETED")) {
    return {
      id: "transcribe",
      label: STAGE_LABELS.transcribe,
      status: "COMPLETED",
      progress: {
        numerator: videoDurationSec ?? 1,
        denominator: videoDurationSec ?? 1,
        percent: 100,
        unit: "seconds",
      },
      startedAt: isoOrNull(job?.startedAt ?? existingBuild.producedAt),
      completedAt: isoOrNull(job?.completedAt ?? existingBuild.producedAt),
      lastActivityAt: isoOrNull(job?.completedAt ?? existingBuild.producedAt),
      elapsedMs: job?.elapsedMsTotal ?? null,
      failureReason: null,
      blockedReason: null,
      canRecover: false,
      measurementMethod: MEASUREMENT_METHOD.transcribe,
    };
  }

  if (!job) {
    // Upload complete but no job and no build. This is the "stalled"
    // state — nothing has enqueued transcription. Classify as BLOCKED
    // with an actionable reason the UI can surface a recovery button for.
    return {
      id: "transcribe",
      label: STAGE_LABELS.transcribe,
      status: "BLOCKED",
      progress: null,
      startedAt: null,
      completedAt: null,
      lastActivityAt: null,
      elapsedMs: null,
      failureReason: null,
      blockedReason: "Waiting to start transcription",
      canRecover: true,
      measurementMethod: MEASUREMENT_METHOD.transcribe,
    };
  }

  // Terminal states.
  if (job.state === "COMPLETED") {
    // Completed but we couldn't resolve the build above → waiting on ingest.
    return {
      id: "transcribe",
      label: STAGE_LABELS.transcribe,
      status: "RUNNING",
      progress: null,
      startedAt: isoOrNull(job.startedAt),
      completedAt: null,
      lastActivityAt: isoOrNull(job.completedAt),
      elapsedMs: elapsedMs(job.startedAt, now),
      failureReason: null,
      blockedReason: null,
      canRecover: false,
      measurementMethod: MEASUREMENT_METHOD.transcribe,
    };
  }
  if (job.state === "FAILED" || job.state === "CANCELLED") {
    return {
      id: "transcribe",
      label: STAGE_LABELS.transcribe,
      status: "FAILED",
      progress: null,
      startedAt: isoOrNull(job.startedAt),
      completedAt: isoOrNull(job.completedAt ?? job.cancelledAt),
      lastActivityAt: isoOrNull(job.completedAt ?? job.cancelledAt),
      elapsedMs: elapsedMs(job.startedAt, job.completedAt ?? job.cancelledAt ?? now),
      failureReason:
        job.failureMessage ??
        job.failureCode ??
        (job.state === "CANCELLED" ? "Transcription cancelled." : "Transcription failed."),
      blockedReason: null,
      canRecover: job.attempts < job.maxAttempts,
      measurementMethod: MEASUREMENT_METHOD.transcribe,
    };
  }

  // Active states. Classify queue-stuck + lease-expiry as BLOCKED.
  const queueElapsed = elapsedMs(job.requestedAt, now) ?? 0;
  const isQueueStuck =
    (job.state === "REQUESTED" || job.state === "QUEUED") &&
    queueElapsed > MAX_QUEUE_WAIT_MS;
  const isLeaseExpired =
    job.state === "RUNNING" &&
    !!job.leaseExpiresAt &&
    job.leaseExpiresAt.getTime() + LEASE_GRACE_MS < now.getTime();

  if (isQueueStuck) {
    return {
      id: "transcribe",
      label: STAGE_LABELS.transcribe,
      status: "BLOCKED",
      progress: null,
      startedAt: isoOrNull(job.startedAt),
      completedAt: null,
      lastActivityAt: isoOrNull(job.queuedAt ?? job.requestedAt),
      elapsedMs: queueElapsed,
      failureReason: null,
      blockedReason: `Transcription queued for ${Math.round(queueElapsed / 1000)}s with no worker — queue appears stuck.`,
      canRecover: true,
      measurementMethod: MEASUREMENT_METHOD.transcribe,
    };
  }
  if (isLeaseExpired) {
    return {
      id: "transcribe",
      label: STAGE_LABELS.transcribe,
      status: "BLOCKED",
      progress: null,
      startedAt: isoOrNull(job.startedAt),
      completedAt: null,
      lastActivityAt: isoOrNull(job.leaseExpiresAt),
      elapsedMs: elapsedMs(job.startedAt, now),
      failureReason: null,
      blockedReason: "Transcription worker lost its lease — likely crashed. Safe to retry.",
      canRecover: true,
      measurementMethod: MEASUREMENT_METHOD.transcribe,
    };
  }

  // Healthy active state: indeterminate progress (Modal is a batch call —
  // no observable fraction during RUNNING). We never fabricate a percent.
  return {
    id: "transcribe",
    label: STAGE_LABELS.transcribe,
    status: job.state === "RUNNING" ? "RUNNING" : "QUEUED",
    progress: null,
    startedAt: isoOrNull(job.startedAt),
    completedAt: null,
    lastActivityAt: isoOrNull(job.leaseExpiresAt ?? job.startedAt ?? job.queuedAt ?? job.requestedAt),
    elapsedMs: elapsedMs(job.startedAt ?? job.queuedAt ?? job.requestedAt, now),
    failureReason: null,
    blockedReason: null,
    canRecover: false,
    measurementMethod: MEASUREMENT_METHOD.transcribe,
  };
}

interface ObjectivesInput {
  readonly transcribeCompleted: boolean;
  readonly attributionAt: Date | null;
  readonly planLearningObjectiveCount: number | null;
  readonly run: {
    readonly id: string;
    readonly executionStatus: string;
    readonly startedAt: Date | null;
    readonly leaseExpiresAt: Date | null;
  } | null;
  readonly now: Date;
}

function classifyObjectives(input: ObjectivesInput): Stage {
  const { transcribeCompleted, attributionAt, planLearningObjectiveCount, run, now } = input;
  if (!transcribeCompleted) {
    return stageShell("objectives", "WAITING", {
      blockedReason: null,
      measurementMethod: MEASUREMENT_METHOD.objectives,
    });
  }
  // The assessment plan being present on the run is the authoritative
  // "objectives extracted" signal — the plan builder populates
  // learningObjectives before persisting the row.
  if (planLearningObjectiveCount && planLearningObjectiveCount > 0) {
    return {
      id: "objectives",
      label: STAGE_LABELS.objectives,
      status: "COMPLETED",
      progress: {
        numerator: planLearningObjectiveCount,
        denominator: planLearningObjectiveCount,
        percent: 100,
        unit: "objectives",
      },
      startedAt: isoOrNull(run?.startedAt),
      completedAt: isoOrNull(attributionAt ?? run?.startedAt),
      lastActivityAt: isoOrNull(attributionAt ?? run?.startedAt),
      elapsedMs: elapsedMs(run?.startedAt, attributionAt ?? now),
      failureReason: null,
      blockedReason: null,
      canRecover: false,
      measurementMethod: MEASUREMENT_METHOD.objectives,
    };
  }
  // Transcript ready but no plan yet → QUEUED (waiting for generation
  // run to start) unless a run exists with RUNNING state.
  const status: StageStatus =
    run?.executionStatus === "REQUESTED" || run?.executionStatus === "QUEUED"
      ? "QUEUED"
      : run?.executionStatus === "COMPLETED" || run?.executionStatus === "FAILED"
        ? "FAILED"
        : "RUNNING";
  return {
    id: "objectives",
    label: STAGE_LABELS.objectives,
    status,
    progress: null,
    startedAt: isoOrNull(run?.startedAt),
    completedAt: null,
    lastActivityAt: isoOrNull(run?.leaseExpiresAt ?? run?.startedAt),
    elapsedMs: elapsedMs(run?.startedAt, now),
    failureReason: null,
    blockedReason: null,
    canRecover: false,
    measurementMethod: MEASUREMENT_METHOD.objectives,
  };
}

interface GenerationStageInput {
  readonly stageId: "checkpoints" | "assessment";
  readonly upstreamCompleted: boolean;
  readonly run: {
    readonly id: string;
    readonly executionStatus: string;
    readonly startedAt: Date | null;
    readonly completedAt: Date | null;
    readonly leaseExpiresAt: Date | null;
    readonly executionErrorCode: string | null;
    readonly executionErrorMessage: string | null;
  } | null;
  readonly numerator: number;
  readonly denominator: number | null;
  readonly unit: string;
  readonly now: Date;
}

function classifyGenerationStage(input: GenerationStageInput): Stage {
  const { stageId, upstreamCompleted, run, numerator, denominator, unit, now } = input;
  if (!upstreamCompleted) {
    return stageShell(stageId, "WAITING", {
      blockedReason: null,
      measurementMethod: MEASUREMENT_METHOD[stageId],
    });
  }

  const effectiveDenominator = denominator && denominator > 0 ? denominator : null;
  const progress: StageProgress | null = effectiveDenominator
    ? {
        numerator: Math.min(numerator, effectiveDenominator),
        denominator: effectiveDenominator,
        percent: pct(Math.min(numerator, effectiveDenominator), effectiveDenominator),
        unit,
      }
    : null;

  // Failure: a terminal run that produced fewer than the plan target
  // for this stage is FAILED for this stage (shortfall).
  if (run?.executionStatus === "FAILED") {
    return {
      id: stageId,
      label: STAGE_LABELS[stageId],
      status: "FAILED",
      progress,
      startedAt: isoOrNull(run.startedAt),
      completedAt: isoOrNull(run.completedAt),
      lastActivityAt: isoOrNull(run.completedAt),
      elapsedMs: elapsedMs(run.startedAt, run.completedAt ?? now),
      failureReason:
        run.executionErrorMessage ??
        run.executionErrorCode ??
        "Generation did not complete.",
      blockedReason: null,
      canRecover: true,
      measurementMethod: MEASUREMENT_METHOD[stageId],
    };
  }

  // Completed when numerator reaches denominator OR the run is COMPLETED
  // and we hit the plan's target for this bucket.
  if (effectiveDenominator && numerator >= effectiveDenominator) {
    return {
      id: stageId,
      label: STAGE_LABELS[stageId],
      status: "COMPLETED",
      progress,
      startedAt: isoOrNull(run?.startedAt),
      completedAt: isoOrNull(run?.completedAt),
      lastActivityAt: isoOrNull(run?.completedAt),
      elapsedMs: elapsedMs(run?.startedAt, run?.completedAt ?? now),
      failureReason: null,
      blockedReason: null,
      canRecover: false,
      measurementMethod: MEASUREMENT_METHOD[stageId],
    };
  }

  // Active or queued.
  const status: StageStatus =
    run?.executionStatus === "RUNNING"
      ? "RUNNING"
      : run?.executionStatus === "REQUESTED" || run?.executionStatus === "QUEUED"
        ? "QUEUED"
        : run?.executionStatus === "COMPLETED"
          ? // Run completed but this bucket didn't fully populate — shortfall.
            "FAILED"
          : "QUEUED";

  return {
    id: stageId,
    label: STAGE_LABELS[stageId],
    status,
    progress,
    startedAt: isoOrNull(run?.startedAt),
    completedAt: null,
    lastActivityAt: isoOrNull(run?.leaseExpiresAt ?? run?.startedAt),
    elapsedMs: elapsedMs(run?.startedAt, now),
    failureReason:
      status === "FAILED"
        ? `Shortfall: produced ${numerator} of ${effectiveDenominator ?? "?"} planned ${unit}.`
        : null,
    blockedReason: null,
    canRecover: status === "FAILED",
    measurementMethod: MEASUREMENT_METHOD[stageId],
  };
}

function stageShell(
  id: StageId,
  status: StageStatus,
  partial: { readonly blockedReason: string | null; readonly measurementMethod: string },
): Stage {
  return {
    id,
    label: STAGE_LABELS[id],
    status,
    progress: null,
    startedAt: null,
    completedAt: null,
    lastActivityAt: null,
    elapsedMs: null,
    failureReason: null,
    blockedReason: partial.blockedReason,
    canRecover: false,
    measurementMethod: partial.measurementMethod,
  };
}

// EP-TRAIN-4Y-BE — server-side course-preparation orchestrator.
//
// One function decides the next step of the pipeline from durable DB
// state and performs it. It is called from three places, never from a
// poll or a GET:
//   - the video-upload route      (trigger "UPLOAD")
//   - the transcription worker    (trigger "TRANSCRIPTION_COMPLETED")
//   - the Continue-preparation route (trigger "MANAGER_CONTINUE")
//
// Safety properties:
//   - Requires a fresh GENERATE_FULL authorization for every enqueue.
//   - Check-then-create is serialized per version with a Postgres
//     advisory lock, so two triggers can never create two live runs.
//   - Automatic triggers never retry after a failure and never touch a
//     live row; only an explicit manager action may retry, or supersede
//     a row that has stalled by the same thresholds the page uses to
//     offer the Continue button.
//   - A version authorized for MOCK inference never starts real
//     transcription.

import { prisma } from "@/lib/prisma";
import { hasPermission, loadPrincipal, type Principal } from "@/lib/rbac";
import { enqueue } from "@/lib/queue";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import {
  requestTranscription,
  markQueued,
  JobRejectedError,
} from "./transcription/job-service";
import {
  buildPlanAndRequestGeneration,
  BuildAndEnqueueRejected,
} from "./generation/enqueue-helper";
import {
  hasFreshProcessingAuthorization,
  readProcessingAuthorizationStatus,
  resolveInferenceModeForVersion,
} from "./generation/processing-authorization";
import { MAX_QUEUE_WAIT_MS, LEASE_GRACE_MS } from "./preparation-progress";

export type PreparationTrigger = "UPLOAD" | "TRANSCRIPTION_COMPLETED" | "MANAGER_CONTINUE";

export type AdvanceAction =
  | "TRANSCRIPTION_ENQUEUED"
  | "TRANSCRIPTION_IN_PROGRESS"
  | "GENERATION_ENQUEUED"
  | "GENERATION_IN_PROGRESS"
  | "GENERATION_COMPLETE"
  | "WOULD_ENQUEUE_TRANSCRIPTION"
  | "WOULD_ENQUEUE_GENERATION"
  | "NOT_AUTHORIZED"
  | "PRIOR_FAILURE_NEEDS_MANAGER"
  | "NO_VIDEO"
  | "NOT_DRAFT"
  | "NOT_FOUND"
  | "REJECTED";

export interface AdvanceResult {
  readonly action: AdvanceAction;
  /** Plain-language sentence a manager can read. */
  readonly message: string;
  readonly generationRunId?: string;
  readonly transcriptionJobId?: string;
  readonly rejectionCode?: string;
}

const LIVE_STATES = ["REQUESTED", "QUEUED", "RUNNING"];

function isStalled(
  row: { state: string; requestedAt: Date; leaseExpiresAt: Date | null },
  now: Date,
): boolean {
  if (row.state === "REQUESTED" || row.state === "QUEUED") {
    return now.getTime() - row.requestedAt.getTime() > MAX_QUEUE_WAIT_MS;
  }
  return (
    row.state === "RUNNING" &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt.getTime() + LEASE_GRACE_MS < now.getTime()
  );
}

/** Serialize preparation decisions for one version. Postgres only; the
 *  SQLite test database is single-writer already. */
export async function withPreparationLock<T>(
  clubId: string,
  courseVersionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!(process.env.DATABASE_URL ?? "").startsWith("postgres")) return fn();
  const key = `training-preparation:${clubId}:${courseVersionId}`;
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      return fn();
    },
    { timeout: 45_000, maxWait: 15_000 },
  );
}

export async function advancePreparation(
  principal: Principal,
  args: {
    readonly clubId: string;
    readonly courseVersionId: string;
    readonly trigger: PreparationTrigger;
    /** Report what would happen without writing anything. */
    readonly dryRun?: boolean;
  },
): Promise<AdvanceResult> {
  if (args.dryRun === true) return decideAndAct(principal, args);
  return withPreparationLock(args.clubId, args.courseVersionId, () => decideAndAct(principal, args));
}

async function decideAndAct(
  principal: Principal,
  args: {
    readonly clubId: string;
    readonly courseVersionId: string;
    readonly trigger: PreparationTrigger;
    readonly dryRun?: boolean;
  },
): Promise<AdvanceResult> {
  const { clubId, courseVersionId, trigger } = args;
  const dryRun = args.dryRun === true;
  const automatic = trigger !== "MANAGER_CONTINUE";
  const now = new Date();

  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: courseVersionId, course: { clubId } },
    select: { id: true, state: true, videoSha256: true },
  });
  if (!version) return { action: "NOT_FOUND", message: "This course version was not found." };
  if (version.state !== "DRAFT") {
    return { action: "NOT_DRAFT", message: "This course is no longer a draft, so it cannot be prepared again." };
  }
  if (!version.videoSha256) {
    return { action: "NO_VIDEO", message: "Upload a video before preparation can start." };
  }

  const build = await prisma.trainingTranscriptBuild.findFirst({
    where: { clubId, sourceVideoSha256: version.videoSha256 },
    orderBy: { producedAt: "desc" },
    select: { id: true },
  });

  if (!build) {
    const jobs = await prisma.trainingTranscriptionJob.findMany({
      where: { clubId, courseVersionId, sourceVideoSha256: version.videoSha256 },
      select: { id: true, state: true, requestedAt: true, leaseExpiresAt: true },
    });
    const liveJob = jobs.find((j) => LIVE_STATES.includes(j.state));
    const stalledJob = liveJob && !automatic && isStalled(liveJob, now) ? liveJob : null;
    if (liveJob && !stalledJob) {
      return {
        action: "TRANSCRIPTION_IN_PROGRESS",
        message: "Transcription is already under way. Nothing else is needed.",
        transcriptionJobId: liveJob.id,
      };
    }
    if (automatic && jobs.some((j) => j.state === "FAILED")) {
      return {
        action: "PRIOR_FAILURE_NEEDS_MANAGER",
        message: "Transcription failed earlier. Click Continue preparation to try again.",
      };
    }
    if ((await resolveInferenceModeForVersion({ clubId, courseVersionId })) === "MOCK") {
      return {
        action: "REJECTED",
        message:
          "This is a mock-inference test course and its video has no existing transcript. " +
          "Mock courses never start real transcription.",
        rejectionCode: "MOCK_REQUIRES_EXISTING_TRANSCRIPT",
      };
    }
    if (dryRun) {
      return {
        action: "WOULD_ENQUEUE_TRANSCRIPTION",
        message: stalledJob
          ? "Transcription stalled. Spectre will restart it, then write the checkpoint and final-assessment questions."
          : "Spectre will transcribe the video, then write the checkpoint and final-assessment questions.",
      };
    }
    if (!(await hasFreshProcessingAuthorization({ clubId, courseVersionId, operation: "GENERATE_FULL" }))) {
      return { action: "NOT_AUTHORIZED", message: "Preparation needs a manager's confirmation before it can start." };
    }
    if (stalledJob) {
      // Compare-and-set: only retire the row if it is STILL stalled. A
      // worker that claimed it in between keeps it, so two transcription
      // calls can never overlap.
      const retired = await prisma.trainingTranscriptionJob.updateMany({
        where: {
          id: stalledJob.id,
          clubId,
          OR: [
            { state: { in: ["REQUESTED", "QUEUED"] }, requestedAt: { lt: new Date(now.getTime() - MAX_QUEUE_WAIT_MS) } },
            { state: "RUNNING", leaseExpiresAt: { lt: new Date(now.getTime() - LEASE_GRACE_MS) } },
          ],
        },
        data: {
          state: "CANCELLED",
          cancelledAt: now,
          cancelledByUserId: principal.id,
          failureCode: "MODAL_TIMEOUT",
          failureMessage: "Stalled job superseded by Continue preparation.",
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (retired.count === 0) {
        return {
          action: "TRANSCRIPTION_IN_PROGRESS",
          message: "Transcription is already under way. Nothing else is needed.",
          transcriptionJobId: stalledJob.id,
        };
      }
      await prisma.backgroundJob.updateMany({
        where: {
          clubId,
          kind: "TRAINING_TRANSCRIBE_VIDEO",
          idempotencyKey: `training-transcribe:${stalledJob.id}`,
          status: { in: ["QUEUED", "RUNNING"] },
        },
        data: { status: "CANCELLED", finishedAt: now },
      });
      await audit(principal, {
        action: "hr.training.transcription.supersede_stalled",
        entityType: "TrainingTranscriptionJob",
        entityId: stalledJob.id,
        clubId,
        after: { previousState: stalledJob.state, trigger },
      });
    }
    try {
      const result = await requestTranscription(principal, clubId, { courseVersionId });
      if (!result.idempotent) {
        await markQueued(clubId, result.jobId);
        await enqueue({
          kind: "TRAINING_TRANSCRIBE_VIDEO",
          clubId,
          payload: { jobId: result.jobId },
          maxAttempts: 2,
          idempotencyKey: `training-transcribe:${result.jobId}`,
        });
      }
      logger.info("training.preparation.advance.transcription", {
        clubId, courseVersionId, trigger, jobId: result.jobId, idempotent: result.idempotent,
      });
      return {
        action: result.idempotent ? "TRANSCRIPTION_IN_PROGRESS" : "TRANSCRIPTION_ENQUEUED",
        message: result.idempotent
          ? "Transcription is already under way. Nothing else is needed."
          : "Transcription has started. Questions will be written automatically when it finishes.",
        transcriptionJobId: result.jobId,
      };
    } catch (err) {
      if (err instanceof JobRejectedError) {
        logger.warn("training.preparation.advance.transcription_rejected", {
          clubId, courseVersionId, trigger, rejectionCode: err.rejectionCode,
        });
        return {
          action: "REJECTED",
          message: `Transcription could not start: ${err.safeMessage}`,
          rejectionCode: err.rejectionCode,
        };
      }
      throw err;
    }
  }

  // Transcript exists — generation leg.
  const runs = await prisma.trainingQuestionAiGenerationRun.findMany({
    where: { clubId, courseVersionId },
    select: { id: true, executionStatus: true, requestedAt: true, leaseExpiresAt: true },
    orderBy: { requestedAt: "desc" },
  });
  const liveRun = runs.find((r) => LIVE_STATES.includes(r.executionStatus));
  const stalledRun =
    liveRun &&
    !automatic &&
    isStalled(
      { state: liveRun.executionStatus, requestedAt: liveRun.requestedAt, leaseExpiresAt: liveRun.leaseExpiresAt },
      now,
    )
      ? liveRun
      : null;
  if (liveRun && !stalledRun) {
    return {
      action: "GENERATION_IN_PROGRESS",
      message: "Questions are already being written. Nothing else is needed.",
      generationRunId: liveRun.id,
    };
  }
  const completedRun = runs.find((r) => r.executionStatus === "COMPLETED");
  if (completedRun) {
    return {
      action: "GENERATION_COMPLETE",
      message: "Question writing has already finished for this course.",
      generationRunId: completedRun.id,
    };
  }
  if (automatic && runs.length > 0) {
    return {
      action: "PRIOR_FAILURE_NEEDS_MANAGER",
      message: "Question writing failed earlier. Click Continue preparation to try again.",
    };
  }
  if (dryRun) {
    return {
      action: "WOULD_ENQUEUE_GENERATION",
      message: stalledRun
        ? "Question writing stalled. Spectre will restart it from the existing transcript."
        : "The transcript is ready. Spectre will now write the checkpoint and final-assessment questions.",
    };
  }
  if (!(await hasFreshProcessingAuthorization({ clubId, courseVersionId, operation: "GENERATE_FULL" }))) {
    return { action: "NOT_AUTHORIZED", message: "Preparation needs a manager's confirmation before it can start." };
  }
  if (stalledRun) {
    const retired = await prisma.trainingQuestionAiGenerationRun.updateMany({
      where: {
        id: stalledRun.id,
        clubId,
        OR: [
          { executionStatus: { in: ["REQUESTED", "QUEUED"] }, requestedAt: { lt: new Date(now.getTime() - MAX_QUEUE_WAIT_MS) } },
          { executionStatus: "RUNNING", leaseExpiresAt: { lt: new Date(now.getTime() - LEASE_GRACE_MS) } },
        ],
      },
      data: {
        executionStatus: "FAILED",
        executionErrorCode: "MODAL_TIMEOUT",
        executionErrorMessage: "Stalled run superseded by Continue preparation.",
        completedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (retired.count === 0) {
      return {
        action: "GENERATION_IN_PROGRESS",
        message: "Questions are already being written. Nothing else is needed.",
        generationRunId: stalledRun.id,
      };
    }
    // Make the superseded queue entry inert so it can never claim the
    // fresh run.
    await prisma.backgroundJob.updateMany({
      where: {
        clubId,
        kind: "TRAINING_GENERATE_QUESTIONS",
        idempotencyKey: `training-generate:${stalledRun.id}`,
        status: { in: ["QUEUED", "RUNNING"] },
      },
      data: { status: "CANCELLED", finishedAt: now },
    });
    await audit(principal, {
      action: "hr.training.generation.supersede_stalled",
      entityType: "TrainingQuestionAiGenerationRun",
      entityId: stalledRun.id,
      clubId,
      after: { previousState: stalledRun.executionStatus, trigger },
    });
  }
  try {
    const result = await buildPlanAndRequestGeneration(principal, { clubId, courseVersionId });
    logger.info("training.preparation.advance.generation", {
      clubId, courseVersionId, trigger, generationRunId: result.generationRunId, idempotent: result.idempotent,
    });
    return {
      action: result.idempotent ? "GENERATION_IN_PROGRESS" : "GENERATION_ENQUEUED",
      message: result.idempotent
        ? "Questions are already being written. Nothing else is needed."
        : "Question writing has started. This page will update as each stage finishes.",
      generationRunId: result.generationRunId,
    };
  } catch (err) {
    if (err instanceof BuildAndEnqueueRejected) {
      logger.warn("training.preparation.advance.generation_rejected", {
        clubId, courseVersionId, trigger, rejectionCode: err.rejectionCode,
      });
      return {
        action: "REJECTED",
        message: `Question writing could not start: ${err.message}`,
        rejectionCode: err.rejectionCode,
      };
    }
    throw err;
  }
}

/** Called by the transcription worker after a job reaches COMPLETED.
 *  Continues the pipeline on behalf of the manager whose upload (or
 *  Continue click) authorized it; the manager must still hold
 *  hr:training:write. Never throws — a failure here must not turn a
 *  successful transcription into a failed job. */
export async function advancePreparationAfterTranscription(args: {
  readonly clubId: string;
  readonly courseVersionId: string;
}): Promise<AdvanceResult> {
  try {
    const auth = await readProcessingAuthorizationStatus(args);
    if (!auth || auth.operation !== "GENERATE_FULL" || !auth.authorizedByUserId) {
      return { action: "NOT_AUTHORIZED", message: "No fresh preparation authorization for this version." };
    }
    const principal = await loadPrincipal(auth.authorizedByUserId, args.clubId);
    if (!principal || !hasPermission(principal, args.clubId, "hr:training:write")) {
      return { action: "NOT_AUTHORIZED", message: "The authorizing manager no longer has training access." };
    }
    return await advancePreparation(principal, { ...args, trigger: "TRANSCRIPTION_COMPLETED" });
  } catch (err) {
    logger.error("training.preparation.advance_after_transcription.failed", {
      clubId: args.clubId,
      courseVersionId: args.courseVersionId,
      error: (err as Error)?.message ?? String(err),
    });
    return { action: "REJECTED", message: "Could not continue preparation automatically." };
  }
}

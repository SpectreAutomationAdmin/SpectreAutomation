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
//   - Idempotent: a live transcription job or generation run is reported,
//     never duplicated (the services' own partial-unique indexes back
//     this up under concurrency).
//   - Automatic triggers never retry after a failure; only an explicit
//     manager action does.

import { prisma } from "@/lib/prisma";
import { hasPermission, loadPrincipal, type Principal } from "@/lib/rbac";
import { enqueue } from "@/lib/queue";
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
} from "./generation/processing-authorization";

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

const LIVE_JOB_STATES = ["REQUESTED", "QUEUED", "RUNNING"];

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
  const { clubId, courseVersionId, trigger } = args;
  const dryRun = args.dryRun === true;
  const automatic = trigger !== "MANAGER_CONTINUE";

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
      select: { id: true, state: true },
    });
    const liveJob = jobs.find((j) => LIVE_JOB_STATES.includes(j.state));
    if (liveJob) {
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
    if (dryRun) {
      return {
        action: "WOULD_ENQUEUE_TRANSCRIPTION",
        message: "Spectre will transcribe the video, then write the checkpoint and final-assessment questions.",
      };
    }
    if (!(await hasFreshProcessingAuthorization({ clubId, courseVersionId, operation: "GENERATE_FULL" }))) {
      return { action: "NOT_AUTHORIZED", message: "Preparation needs a manager's confirmation before it can start." };
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
    select: { id: true, executionStatus: true },
    orderBy: { requestedAt: "desc" },
  });
  const liveRun = runs.find((r) => LIVE_JOB_STATES.includes(r.executionStatus));
  if (liveRun) {
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
      message: "The transcript is ready. Spectre will now write the checkpoint and final-assessment questions.",
    };
  }
  if (!(await hasFreshProcessingAuthorization({ clubId, courseVersionId, operation: "GENERATE_FULL" }))) {
    return { action: "NOT_AUTHORIZED", message: "Preparation needs a manager's confirmation before it can start." };
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

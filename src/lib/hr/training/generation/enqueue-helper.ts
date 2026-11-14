// EP-TRAIN-4Y-V §5 (2026-11-09) — shared "build-plan + request + enqueue"
// helper used by BOTH the admin /generate route (manager click) AND
// the /auto-prepare route (automatic trigger on transcript ready).
//
// Idempotency: `requestGeneration` returns `idempotent: true` when a
// run with the same `planIdentity` already exists for the (clubId,
// courseVersionId, resolvedTranscriptBuildId). Repeated calls — e.g.
// browser poll cycles — never create duplicate Modal work.
//
// §5 of the founder directive requires:
//   - idempotent by club, course version, source video, plan identity
//   - no duplicate GPU calls from refresh / event replay
//   - no automatic retry after non-retryable errors (preserved by
//     the queue's maxAttempts=2 + the generation lifecycle service)
//   - no automatic approval / promotion / publication (none of this
//     helper writes against TrainingQuestion.active, course publish,
//     or TrainingAssignment)

import { prisma } from "@/lib/prisma";
import { type Principal } from "@/lib/rbac";
import { enqueue } from "@/lib/queue";
import {
  requestGeneration,
  markGenerationQueued,
  GenerationRejectedError,
} from "./generation-service";
import {
  buildBaselineAssessmentPlan,
  type AssessmentPlanV1,
} from "./assessment-plan";
import { buildTopicAwareAssessmentPlan } from "./placement";
import { sizeForDuration } from "./duration-sizing";

export interface BuildAndEnqueueInput {
  readonly clubId: string;
  readonly courseVersionId: string;
  readonly resolvedTranscriptBuildId?: string;
  readonly targetTotalQuestions?: number;
  // EP-TRAIN-4Y-V (2026-11-09) — explicit plan-shape overrides. When
  // provided, both must be set; otherwise the ratio split applies.
  readonly checkpointCount?: number;
  readonly finalCount?: number;
  readonly checkpointGroupStrategy?: "DEFAULT" | "ONE_PER_GROUP";
}

export interface BuildAndEnqueueResult {
  readonly ok: true;
  readonly generationRunId: string;
  readonly state: "REQUESTED" | "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  readonly idempotent: boolean;
  readonly planIdentity: string;
}

export class BuildAndEnqueueRejected extends Error {
  readonly rejectionCode: string;
  readonly httpStatus: number;
  readonly detail: Record<string, unknown>;
  constructor(code: string, message: string, httpStatus: number, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "BuildAndEnqueueRejected";
    this.rejectionCode = code;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

/** Build the baseline + topic-aware plan, call `requestGeneration`,
 *  and (if non-idempotent) enqueue the queued-run job. Shared by the
 *  explicit /generate route and the auto-trigger inside /auto-prepare.
 *  Tenant / permission / DRAFT guards must be enforced by the
 *  caller. */
export async function buildPlanAndRequestGeneration(
  principal: Principal,
  input: BuildAndEnqueueInput,
): Promise<BuildAndEnqueueResult> {
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: input.courseVersionId },
    select: {
      id: true, state: true, videoSha256: true, videoDurationSec: true,
      course: { select: { clubId: true } },
    },
  });
  if (!version || version.course.clubId !== input.clubId) {
    throw new BuildAndEnqueueRejected("VERSION_NOT_FOUND", "Version not found.", 404);
  }
  if (version.state !== "DRAFT") {
    throw new BuildAndEnqueueRejected(
      "VERSION_NOT_DRAFT",
      `Cannot generate for ${version.state} version.`,
      409,
    );
  }
  if (!version.videoSha256) {
    throw new BuildAndEnqueueRejected("VIDEO_SHA_UNRECORDED", "video_sha_unrecorded", 409);
  }
  const build = await prisma.trainingTranscriptBuild.findFirst({
    where: {
      clubId: input.clubId,
      sourceVideoSha256: version.videoSha256,
      ...(input.resolvedTranscriptBuildId
        ? { resolvedTranscriptBuildId: input.resolvedTranscriptBuildId }
        : {}),
    },
    orderBy: { producedAt: "desc" },
    select: { id: true, resolvedTranscriptBuildId: true },
  });
  if (!build) {
    throw new BuildAndEnqueueRejected("TRANSCRIPT_MISSING", "transcript_missing", 409);
  }
  const segments = await prisma.trainingTranscriptSegment.findMany({
    where: { clubId: input.clubId, transcriptBuildId: build.id },
    select: { segmentIndex: true, text: true, startSec: true, endSec: true },
    orderBy: [{ segmentIndex: "asc" }],
  });

  // EP-TRAIN-4Y-BB §2 — Duration-based AI question sizing.
  //
  // When the caller did NOT pass an explicit (checkpointCount, finalCount)
  // split AND did NOT pass a targetTotalQuestions, we derive both from
  // the video's duration bucket. A 643-second video now defaults to
  // 4 CP + 8 FA (the 10-15 min bucket) instead of the historical
  // ratio-split of targetTotalQuestions=6. Callers that DO pass an
  // explicit split or total still take precedence.
  const hasCallerExplicitSplit =
    typeof input.checkpointCount === "number" &&
    typeof input.finalCount === "number";
  let derivedCheckpointCount: number | undefined;
  let derivedFinalCount: number | undefined;
  if (!hasCallerExplicitSplit && typeof input.targetTotalQuestions !== "number") {
    const sized = sizeForDuration(version.videoDurationSec);
    derivedCheckpointCount = sized.checkpointCount;
    derivedFinalCount = sized.finalCount;
  }
  const effectiveCheckpointCount = input.checkpointCount ?? derivedCheckpointCount;
  const effectiveFinalCount = input.finalCount ?? derivedFinalCount;
  const hasExplicitSplit =
    typeof effectiveCheckpointCount === "number" &&
    typeof effectiveFinalCount === "number";

  let plan: AssessmentPlanV1;
  if (hasExplicitSplit) {
    plan = buildBaselineAssessmentPlan({
      courseVersionId: input.courseVersionId,
      resolvedTranscriptBuildId: build.resolvedTranscriptBuildId,
      sourceVideoSha256: version.videoSha256,
      segments: segments.map((s) => ({ segmentIndex: s.segmentIndex, text: s.text })),
      videoDurationSec: version.videoDurationSec,
      checkpointCount: effectiveCheckpointCount,
      finalCount: effectiveFinalCount,
      checkpointGroupStrategy: input.checkpointGroupStrategy ?? "DEFAULT",
      generatedByUserId: principal.id,
    });
  } else {
    const placement = buildTopicAwareAssessmentPlan({
      courseVersionId: input.courseVersionId,
      resolvedTranscriptBuildId: build.resolvedTranscriptBuildId,
      sourceVideoSha256: version.videoSha256,
      segments: segments.map((s) => ({
        segmentIndex: s.segmentIndex,
        text: s.text,
        startSec: Number(s.startSec),
        endSec: Number(s.endSec),
      })),
      videoDurationSec: version.videoDurationSec,
      targetTotalQuestions: input.targetTotalQuestions,
      generatedByUserId: principal.id,
    });
    plan = placement.plan.learningObjectives.some((lo) => lo.segmentIds.length > 0)
      ? placement.plan
      : buildBaselineAssessmentPlan({
          courseVersionId: input.courseVersionId,
          resolvedTranscriptBuildId: build.resolvedTranscriptBuildId,
          sourceVideoSha256: version.videoSha256,
          segments: segments.map((s) => ({ segmentIndex: s.segmentIndex, text: s.text })),
          videoDurationSec: version.videoDurationSec,
          targetTotalQuestions: input.targetTotalQuestions,
          generatedByUserId: principal.id,
        });
  }

  try {
    const result = await requestGeneration(principal, input.clubId, {
      courseVersionId: input.courseVersionId,
      plan,
    });
    if (!result.idempotent) {
      await markGenerationQueued(input.clubId, result.generationRunId);
      await enqueue({
        kind: "TRAINING_GENERATE_QUESTIONS",
        clubId: input.clubId,
        payload: { generationRunId: result.generationRunId },
        maxAttempts: 2,
        idempotencyKey: `training-generate:${result.generationRunId}`,
      });
    }
    return {
      ok: true,
      generationRunId: result.generationRunId,
      state: result.idempotent ? result.state : "QUEUED",
      idempotent: result.idempotent,
      planIdentity: result.planIdentity,
    };
  } catch (err) {
    if (err instanceof GenerationRejectedError) {
      throw new BuildAndEnqueueRejected(
        err.rejectionCode,
        err.safeMessage,
        err.httpStatus,
        err.detail,
      );
    }
    throw err;
  }
}

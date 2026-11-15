// EP-TRAIN-4Y-BE — fully automatic course-preparation orchestrator.
//
// A successful video upload is the authorization to prepare the whole
// course. From there this module — and only this module — decides the
// next step from durable DB state and performs it:
//
//   upload → transcription → objectives + questions → repair → ready
//
// It is invoked by the upload route, by the transcription and
// generation workers when they finish, and by a worker-side watchdog
// that resumes anything that stalled (for example after a worker
// restart). No manager action, browser poll or page visit ever starts
// or resumes processing.
//
// Operational controls (never shown to a manager):
//   - every decision is serialized per version (advisory lock), so
//     triggers that race cannot create two live jobs or runs;
//   - bounded attempts per upload: MAX_TRANSCRIPTION_ATTEMPTS and
//     MAX_GENERATION_RUNS;
//   - a hard per-course cost ceiling: nothing billable is enqueued
//     unless spent + reserved + its own worst case fits;
//   - anything that cannot proceed is HALTED with an internal code,
//     an audit row and an error log for Spectre operators.

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
  requestGenerationForPlan,
  BuildAndEnqueueRejected,
} from "./generation/enqueue-helper";
import {
  PREPARATION_COMPLETED_ACTION,
  PREPARATION_HALT_ACTION,
  hasPreparationCompleted,
  readPipelineAuthorization,
  readPreparationHalt,
  type PipelineAuthorization,
  type PreparationHaltCode,
} from "./generation/processing-authorization";
import {
  buildFinalAssessmentChunks,
  type AssessmentPlanV1,
} from "./generation/assessment-plan";
import {
  parseShortfallGroupMap,
  destinationKindForGroup,
  resolveByDraftLineage,
} from "./generation/destination-resolver";
import { sizeForDuration } from "./generation/duration-sizing";
import {
  generationWorstCaseMicros,
  getPilotBudgetMicros,
  loadCourseProcessingCostMicros,
  plannedCallCount,
  transcriptionWorstCaseMicros,
} from "./generation/pilot-budget-guard";
import { ensureCheckpointEventsForVersion } from "./generation/checkpoint-events";
import { MAX_QUEUE_WAIT_MS, LEASE_GRACE_MS } from "./preparation-progress";

export type PreparationTrigger =
  | "UPLOAD"
  | "TRANSCRIPTION_COMPLETED"
  | "GENERATION_FINISHED"
  | "WATCHDOG"
  | "ADMIN_RECOVERY";

export type AdvanceAction =
  | "TRANSCRIPTION_ENQUEUED"
  | "TRANSCRIPTION_IN_PROGRESS"
  | "GENERATION_ENQUEUED"
  | "REPAIR_ENQUEUED"
  | "GENERATION_IN_PROGRESS"
  | "COMPLETE"
  | "HALTED"
  | "NOT_AUTHORIZED"
  | "NOT_APPLICABLE";

export interface AdvanceResult {
  readonly action: AdvanceAction;
  /** Internal detail for logs and diagnostics — never rendered. */
  readonly detail: string;
  readonly generationRunId?: string;
  readonly transcriptionJobId?: string;
}

/** Transcription jobs allowed per upload (first try + two recoveries). */
export const MAX_TRANSCRIPTION_ATTEMPTS = 3;
/** Generation runs allowed per upload (first pass + three retries or
 *  repair passes for missing or rejected questions). */
export const MAX_GENERATION_RUNS = 4;

const LIVE_STATES = ["REQUESTED", "QUEUED", "RUNNING"];
const PRODUCED_STATES = new Set([
  "REQUIRES_HUMAN_REVIEW",
  "APPROVED_DRAFT",
  "PROMOTED",
  "EDITED_VALIDATION_STALE",
  "VALIDATION_PENDING",
]);
/** A run that failed for one of these reasons will fail again. */
const NON_RETRYABLE_RUN_FAILURES = new Set([
  "PILOT_BUDGET_EXCEEDED",
  "COST_CAP_EXCEEDED",
  "CREDENTIAL_ABSENT",
  "INSUFFICIENT_EVIDENCE",
  "TRANSCRIPT_MISSING",
  "SOURCE_VIDEO_MISMATCH",
]);

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

/** Decide and perform the next step for one version. Never throws:
 *  callers are workers and the upload route, none of which may fail
 *  because orchestration had a problem. */
export async function advancePreparation(args: {
  readonly clubId: string;
  readonly courseVersionId: string;
  readonly trigger: PreparationTrigger;
}): Promise<AdvanceResult> {
  try {
    const result = await withPreparationLock(args.clubId, args.courseVersionId, () => decideAndAct(args));
    if (result.action !== "COMPLETE" && result.action !== "NOT_AUTHORIZED" && result.action !== "NOT_APPLICABLE") {
      logger.info("training.preparation.advance", { ...args, action: result.action, detail: result.detail });
    }
    return result;
  } catch (err) {
    logger.error("training.preparation.advance.failed", {
      ...args,
      error: (err as Error)?.message ?? String(err),
    });
    return { action: "NOT_APPLICABLE", detail: "orchestration error; the watchdog will retry" };
  }
}

async function halt(
  auth: PipelineAuthorization,
  args: { readonly clubId: string; readonly courseVersionId: string; readonly trigger: PreparationTrigger },
  code: PreparationHaltCode,
  detail: string,
): Promise<AdvanceResult> {
  await audit(auth.authorizedByUserId ? { id: auth.authorizedByUserId } : null, {
    action: PREPARATION_HALT_ACTION,
    entityType: "TrainingCourseVersion",
    entityId: args.courseVersionId,
    clubId: args.clubId,
    after: { code, detail, trigger: args.trigger },
  });
  // Operator alert: preparation needs Spectre attention.
  logger.error("training.preparation.halted", { ...args, code, detail });
  return { action: "HALTED", detail: `${code}: ${detail}` };
}

interface ProducedState {
  readonly producedCheckpoints: number;
  readonly producedFinal: number;
  readonly filledGroupIds: ReadonlySet<string>;
  readonly questionTexts: readonly string[];
}

async function loadProducedState(clubId: string, courseVersionId: string): Promise<ProducedState> {
  const runs = await prisma.trainingQuestionAiGenerationRun.findMany({
    where: { clubId, courseVersionId },
    select: { shortfallReasonJson: true },
    orderBy: { requestedAt: "asc" },
  });
  const groupByHash = new Map<string, string>();
  for (const r of runs) {
    for (const [hash, group] of parseShortfallGroupMap(r.shortfallReasonJson).entries()) {
      if (!groupByHash.has(hash)) groupByHash.set(hash, group);
    }
  }
  const drafts = await prisma.trainingQuestionAiDraft.findMany({
    where: { clubId, courseVersionId },
    select: { id: true, state: true, contentHash: true, supersedesDraftId: true, draftJson: true },
  });
  const draftById = new Map(drafts.map((d) => [d.id, d] as const));
  let producedCheckpoints = 0;
  let producedFinal = 0;
  const filledGroupIds = new Set<string>();
  const questionTexts: string[] = [];
  for (const d of drafts) {
    if (!PRODUCED_STATES.has(d.state)) continue;
    // A question the manager edited is a new draft; it still fills the
    // place of the one it replaced.
    const group = resolveByDraftLineage(d, draftById, groupByHash);
    const kind = destinationKindForGroup(group);
    if (kind === "CHECKPOINT") {
      producedCheckpoints++;
      if (group) filledGroupIds.add(group);
    } else if (kind === "FINAL_ASSESSMENT") {
      producedFinal++;
    }
    try {
      const body = JSON.parse(d.draftJson) as { questionText?: unknown };
      if (typeof body.questionText === "string" && body.questionText.length > 0) {
        questionTexts.push(body.questionText);
      }
    } catch {
      // Unreadable draft body: nothing to add to the duplicate guard.
    }
  }
  return { producedCheckpoints, producedFinal, filledGroupIds, questionTexts };
}

function parsePlan(json: string | null): AssessmentPlanV1 | null {
  if (!json) return null;
  try {
    const plan = JSON.parse(json) as AssessmentPlanV1;
    return Array.isArray(plan.proposedCheckpointGroups) && Array.isArray(plan.learningObjectives) ? plan : null;
  } catch {
    return null;
  }
}

/** A plan that asks only for what is still missing: the checkpoint
 *  events of the original plan that have no question yet, plus the
 *  missing number of final-assessment questions. Existing questions
 *  are passed as duplicates-to-avoid; nothing already produced is
 *  regenerated. */
function buildRepairPlan(
  base: AssessmentPlanV1,
  input: {
    readonly unfilledGroupIds: readonly string[];
    readonly missingFinal: number;
    readonly existingQuestionTexts: readonly string[];
    readonly userId: string;
  },
): AssessmentPlanV1 {
  const unfilled = new Set(input.unfilledGroupIds);
  const groups = base.proposedCheckpointGroups
    .filter((g) => unfilled.has(g.id))
    .map((g) => ({ ...g, targetQuestionCount: 1 }));
  const chunks = buildFinalAssessmentChunks(base.learningObjectives, input.missingFinal);
  const { proposedFinalAssessmentChunks: _dropped, ...rest } = base;
  void _dropped;
  return {
    ...rest,
    proposedCheckpointGroups: groups,
    proposedFinalAssessment: {
      ...base.proposedFinalAssessment,
      targetQuestionCount: input.missingFinal,
    },
    ...(chunks ? { proposedFinalAssessmentChunks: chunks } : {}),
    totalTargetQuestionCount: groups.length + input.missingFinal,
    priorQuestionTextsForDedup: [...input.existingQuestionTexts],
    generatedAt: new Date().toISOString(),
    generatedByUserId: input.userId,
  };
}

async function decideAndAct(args: {
  readonly clubId: string;
  readonly courseVersionId: string;
  readonly trigger: PreparationTrigger;
}): Promise<AdvanceResult> {
  const { clubId, courseVersionId, trigger } = args;
  const now = new Date();

  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: courseVersionId, course: { clubId } },
    select: { id: true, state: true, videoSha256: true, videoDurationSec: true },
  });
  if (!version || version.state !== "DRAFT" || !version.videoSha256) {
    return { action: "NOT_APPLICABLE", detail: "no draft version with a video" };
  }

  const auth = await readPipelineAuthorization({ clubId, courseVersionId, now });
  if (!auth) return { action: "NOT_AUTHORIZED", detail: "no upload authorization inside the pipeline window" };

  const halted = await readPreparationHalt({ clubId, courseVersionId, since: auth.authorizedAt });
  if (halted) return { action: "HALTED", detail: `already halted: ${halted.code}` };
  if (await hasPreparationCompleted({ clubId, courseVersionId, since: auth.authorizedAt })) {
    return { action: "COMPLETE", detail: "preparation already completed for this upload" };
  }

  let principal: Principal | null = null;
  if (auth.authorizedByUserId) principal = await loadPrincipal(auth.authorizedByUserId, clubId);
  if (!principal || !hasPermission(principal, clubId, "hr:training:write")) {
    return halt(auth, args, "AUTHORIZER_LOST_ACCESS", "uploading manager no longer has training access");
  }

  const ceilingMicros = getPilotBudgetMicros(courseVersionId);
  const target = sizeForDuration(version.videoDurationSec);
  const fullRunWorstCase = generationWorstCaseMicros(
    plannedCallCount({
      checkpointEvents: target.checkpointCount,
      finalQuestions: target.finalCount,
      finalChunks: Math.ceil(target.finalCount / 3),
    }),
  );

  const build = await prisma.trainingTranscriptBuild.findFirst({
    where: { clubId, sourceVideoSha256: version.videoSha256 },
    orderBy: { producedAt: "desc" },
    select: { id: true },
  });

  // ── Transcription leg ────────────────────────────────────────────
  if (!build) {
    const jobs = await prisma.trainingTranscriptionJob.findMany({
      where: {
        clubId,
        courseVersionId,
        sourceVideoSha256: version.videoSha256,
        requestedAt: { gte: auth.authorizedAt },
      },
      select: { id: true, state: true, requestedAt: true, leaseExpiresAt: true },
    });
    const liveJob = jobs.find((j) => LIVE_STATES.includes(j.state));
    if (liveJob) {
      if (!isStalled(liveJob, now)) {
        return { action: "TRANSCRIPTION_IN_PROGRESS", detail: "live job", transcriptionJobId: liveJob.id };
      }
      // Compare-and-set: retire the row only if it is STILL stalled, so
      // a worker that claimed it meanwhile keeps it and two
      // transcriptions can never overlap.
      const retired = await prisma.trainingTranscriptionJob.updateMany({
        where: {
          id: liveJob.id,
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
          failureMessage: "Stalled job superseded by automatic recovery.",
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (retired.count === 0) {
        return { action: "TRANSCRIPTION_IN_PROGRESS", detail: "job resumed on its own", transcriptionJobId: liveJob.id };
      }
      await prisma.backgroundJob.updateMany({
        where: {
          clubId,
          kind: "TRAINING_TRANSCRIBE_VIDEO",
          idempotencyKey: `training-transcribe:${liveJob.id}`,
          status: { in: ["QUEUED", "RUNNING"] },
        },
        data: { status: "CANCELLED", finishedAt: now },
      });
      logger.warn("training.preparation.transcription.superseded_stalled", { clubId, courseVersionId, jobId: liveJob.id });
    }
    if (auth.inferenceMode === "MOCK") {
      return halt(auth, args, "MOCK_REQUIRES_EXISTING_TRANSCRIPT", "mock version has no transcript to reuse");
    }
    if (jobs.length >= MAX_TRANSCRIPTION_ATTEMPTS) {
      return halt(auth, args, "TRANSCRIPTION_ATTEMPTS_EXHAUSTED", `${jobs.length} transcription attempts used`);
    }
    // Feasibility: the whole pipeline must fit under the ceiling before
    // the first billable second is spent.
    const spent = await loadCourseProcessingCostMicros({ clubId, courseVersionId });
    const projected = spent + transcriptionWorstCaseMicros(version.videoDurationSec) + fullRunWorstCase;
    if (projected > ceilingMicros) {
      return halt(auth, args, "BUDGET_INFEASIBLE", `projected ${projected} micros exceeds ceiling ${ceilingMicros}`);
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
      return {
        action: result.idempotent ? "TRANSCRIPTION_IN_PROGRESS" : "TRANSCRIPTION_ENQUEUED",
        detail: `trigger ${trigger}`,
        transcriptionJobId: result.jobId,
      };
    } catch (err) {
      if (err instanceof JobRejectedError) {
        return halt(auth, args, "TRANSCRIPTION_REJECTED", err.rejectionCode);
      }
      throw err;
    }
  }

  // ── Generation leg ───────────────────────────────────────────────
  const runs = await prisma.trainingQuestionAiGenerationRun.findMany({
    where: { clubId, courseVersionId, requestedAt: { gte: auth.authorizedAt } },
    select: {
      id: true,
      executionStatus: true,
      executionErrorCode: true,
      requestedAt: true,
      leaseExpiresAt: true,
      assessmentPlanJson: true,
    },
    orderBy: { requestedAt: "asc" },
  });
  const liveRun = runs.find((r) => LIVE_STATES.includes(r.executionStatus));
  if (liveRun) {
    const stalled = isStalled(
      { state: liveRun.executionStatus, requestedAt: liveRun.requestedAt, leaseExpiresAt: liveRun.leaseExpiresAt },
      now,
    );
    if (!stalled) return { action: "GENERATION_IN_PROGRESS", detail: "live run", generationRunId: liveRun.id };
    const retired = await prisma.trainingQuestionAiGenerationRun.updateMany({
      where: {
        id: liveRun.id,
        clubId,
        OR: [
          { executionStatus: { in: ["REQUESTED", "QUEUED"] }, requestedAt: { lt: new Date(now.getTime() - MAX_QUEUE_WAIT_MS) } },
          { executionStatus: "RUNNING", leaseExpiresAt: { lt: new Date(now.getTime() - LEASE_GRACE_MS) } },
        ],
      },
      data: {
        executionStatus: "FAILED",
        executionErrorCode: "MODAL_TIMEOUT",
        executionErrorMessage: "Stalled run superseded by automatic recovery.",
        completedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (retired.count === 0) {
      return { action: "GENERATION_IN_PROGRESS", detail: "run resumed on its own", generationRunId: liveRun.id };
    }
    // Make the superseded queue entry inert so it can never claim the
    // replacement run.
    await prisma.backgroundJob.updateMany({
      where: {
        clubId,
        kind: "TRAINING_GENERATE_QUESTIONS",
        idempotencyKey: `training-generate:${liveRun.id}`,
        status: { in: ["QUEUED", "RUNNING"] },
      },
      data: { status: "CANCELLED", finishedAt: now },
    });
    logger.warn("training.preparation.generation.superseded_stalled", { clubId, courseVersionId, runId: liveRun.id });
  }

  const produced = await loadProducedState(clubId, courseVersionId);
  const missingCheckpoints = Math.max(0, target.checkpointCount - produced.producedCheckpoints);
  const missingFinal = Math.max(0, target.finalCount - produced.producedFinal);
  if (missingCheckpoints === 0 && missingFinal === 0) {
    await ensureCheckpointEventsForVersion({ clubId, courseVersionId, actorUserId: principal.id });
    await audit(principal, {
      action: PREPARATION_COMPLETED_ACTION,
      entityType: "TrainingCourseVersion",
      entityId: courseVersionId,
      clubId,
      after: {
        checkpointQuestions: produced.producedCheckpoints,
        finalQuestions: produced.producedFinal,
        generationPasses: runs.length,
        trigger,
      },
    });
    logger.info("training.preparation.completed", { clubId, courseVersionId, trigger, passes: runs.length });
    return { action: "COMPLETE", detail: "all planned questions exist" };
  }

  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
  if (
    lastRun &&
    lastRun.executionStatus === "FAILED" &&
    lastRun.executionErrorCode &&
    NON_RETRYABLE_RUN_FAILURES.has(lastRun.executionErrorCode)
  ) {
    return halt(auth, args, "NON_RETRYABLE_FAILURE", lastRun.executionErrorCode);
  }
  if (runs.length >= MAX_GENERATION_RUNS) {
    await ensureCheckpointEventsForVersion({ clubId, courseVersionId, actorUserId: principal.id });
    const anything = produced.producedCheckpoints + produced.producedFinal > 0;
    return halt(
      auth,
      args,
      anything ? "PARTIAL_AFTER_REPAIR" : "GENERATION_ATTEMPTS_EXHAUSTED",
      `${runs.length} runs used; missing ${missingCheckpoints} checkpoint and ${missingFinal} final questions`,
    );
  }

  // First pass, or a retry after a pass that produced nothing: the full
  // plan. Otherwise a repair pass for exactly what is missing.
  const basePlan =
    runs
      .filter((r) => r.executionStatus === "COMPLETED")
      .map((r) => parsePlan(r.assessmentPlanJson))
      .find((p): p is AssessmentPlanV1 => p !== null) ?? null;
  const unfilledGroupIds = basePlan
    ? basePlan.proposedCheckpointGroups
        .filter((g) => !produced.filledGroupIds.has(g.id))
        .slice(0, missingCheckpoints)
        .map((g) => g.id)
    : [];
  const isRepair = basePlan !== null && produced.producedCheckpoints + produced.producedFinal > 0;

  const nextCalls = isRepair
    ? plannedCallCount({
        checkpointEvents: unfilledGroupIds.length,
        finalQuestions: missingFinal,
        finalChunks: missingFinal > 3 ? Math.ceil(missingFinal / 3) : 0,
      })
    : plannedCallCount({
        checkpointEvents: target.checkpointCount,
        finalQuestions: target.finalCount,
        finalChunks: Math.ceil(target.finalCount / 3),
      });
  const spent = await loadCourseProcessingCostMicros({ clubId, courseVersionId });
  if (spent + generationWorstCaseMicros(nextCalls) > ceilingMicros) {
    await ensureCheckpointEventsForVersion({ clubId, courseVersionId, actorUserId: principal.id });
    return halt(
      auth,
      args,
      "BUDGET_EXHAUSTED",
      `spent+reserved ${spent} micros; next pass worst case ${generationWorstCaseMicros(nextCalls)}; ceiling ${ceilingMicros}`,
    );
  }

  try {
    if (isRepair && basePlan) {
      if (unfilledGroupIds.length === 0 && missingFinal === 0) {
        // Checkpoint questions are missing but every planned event of
        // the original plan is filled: nothing coherent left to ask for.
        return halt(auth, args, "PARTIAL_AFTER_REPAIR", "no unfilled checkpoint events remain in the plan");
      }
      const result = await requestGenerationForPlan(principal, {
        clubId,
        courseVersionId,
        plan: buildRepairPlan(basePlan, {
          unfilledGroupIds,
          missingFinal,
          existingQuestionTexts: produced.questionTexts,
          userId: principal.id,
        }),
      });
      return {
        action: "REPAIR_ENQUEUED",
        detail: `missing ${unfilledGroupIds.length} checkpoint and ${missingFinal} final questions`,
        generationRunId: result.generationRunId,
      };
    }
    const result = await buildPlanAndRequestGeneration(principal, { clubId, courseVersionId });
    return {
      action: result.idempotent ? "GENERATION_IN_PROGRESS" : "GENERATION_ENQUEUED",
      detail: `trigger ${trigger}; pass ${runs.length + 1} of ${MAX_GENERATION_RUNS}`,
      generationRunId: result.generationRunId,
    };
  } catch (err) {
    if (err instanceof BuildAndEnqueueRejected) {
      return halt(auth, args, "GENERATION_REJECTED", err.rejectionCode);
    }
    throw err;
  }
}

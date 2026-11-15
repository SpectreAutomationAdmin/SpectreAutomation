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
//   - single flight per version: while ANY transcription job or
//     generation run is live for the version — whichever upload or
//     recovery started it — nothing new is dispatched;
//   - test-identity versions are simulated, and real versions are
//     only dispatched where billable inference is enabled;
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
  retireStalledTranscriptionJobs,
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
  isMockInferenceAllowed,
  readPipelineAuthorization,
  readPreparationHalt,
  resolveInferenceModeForVersion,
  type PipelineAuthorization,
  type PreparationHaltCode,
} from "./generation/processing-authorization";
import { retireStalledGenerationRuns } from "./generation/generation-service";
import { isBillableInferenceEnabled } from "./modal-shared";
import { MOCK_TRANSCRIPT_MODEL_VARIANT } from "./transcription/mock-transcript";
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
  // The process that received the upload cannot dispatch real work (it
  // does not have billable inference enabled). Nothing is decided
  // here; the worker — which holds the provider credentials and the
  // lock that matters — decides on its next pass.
  | "DEFERRED"
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
  "BILLABLE_INFERENCE_LOCKED",
  "INSUFFICIENT_EVIDENCE",
  "TRANSCRIPT_MISSING",
  "SOURCE_VIDEO_MISMATCH",
]);

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
  return inProcessTurn(() => advanceOnce(args));
}

/** One orchestration decision at a time PER PROCESS. This is not what
 *  makes decisions safe — the per-version database lock does that,
 *  across processes. It only keeps one process from holding several
 *  lock connections at once: each decision pins a connection for its
 *  lock while it works on others, and a small pool can be starved if
 *  several uploads finish in the same instant. A decision takes well
 *  under a second. */
let turn: Promise<unknown> = Promise.resolve();
function inProcessTurn<T>(fn: () => Promise<T>): Promise<T> {
  const run = turn.then(fn, fn);
  turn = run.catch(() => undefined);
  return run;
}

async function advanceOnce(args: {
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

/** What already exists for THIS video. Questions generated from a
 *  video the manager has since replaced do not count: they describe a
 *  different recording. */
async function loadProducedState(
  clubId: string,
  courseVersionId: string,
  sourceVideoSha256: string,
): Promise<ProducedState> {
  const runs = await prisma.trainingQuestionAiGenerationRun.findMany({
    where: { clubId, courseVersionId, sourceVideoSha256 },
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
    where: { clubId, courseVersionId, sourceVideoSha256 },
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

  // EP-TRAIN-4Y-BF — how this version is processed is resolved from
  // durable state (test execution identity), never from the request
  // that happened to trigger this pass. A non-billable version is
  // simulated; a real one is only dispatched where billable inference
  // is enabled. Either mismatch halts before anything is queued.
  const inferenceMode = await resolveInferenceModeForVersion({ clubId, courseVersionId });
  const dispatchBlock: { code: PreparationHaltCode; detail: string } | null =
    inferenceMode === "MOCK"
      ? isMockInferenceAllowed()
        ? null
        : {
            code: "TEST_ISOLATION_UNAVAILABLE",
            detail: "non-billable (test identity) version; simulated processing is not enabled here",
          }
      : isBillableInferenceEnabled()
        ? null
        : {
            code: "BILLABLE_INFERENCE_LOCKED",
            detail: "billable inference is not enabled in this environment",
          };

  /** What to do when this process may not dispatch. A closed billable
   *  lock seen by the process that merely RECEIVED the upload is not
   *  final — the worker owns the provider credentials and its own
   *  lock, and it decides on its next pass (within seconds). Every
   *  other case halts. */
  const refuseDispatch = async (block: { code: PreparationHaltCode; detail: string }): Promise<AdvanceResult> => {
    if (block.code === "BILLABLE_INFERENCE_LOCKED" && trigger === "UPLOAD") {
      return { action: "DEFERRED", detail: `${block.detail}; left for the worker to decide` };
    }
    return halt(auth, args, block.code, block.detail);
  };

  // A real version never builds on a simulated transcript, even if a
  // test once uploaded the same bytes.
  const build = await prisma.trainingTranscriptBuild.findFirst({
    where: {
      clubId,
      sourceVideoSha256: version.videoSha256,
      ...(inferenceMode === "LIVE" ? { transcriberModelName: { not: MOCK_TRANSCRIPT_MODEL_VARIANT } } : {}),
    },
    orderBy: { producedAt: "desc" },
    select: { id: true },
  });

  // ── Single flight ────────────────────────────────────────────────
  // Anything already in flight for this version is THE workflow, no
  // matter which upload, recovery or request started it. Look at every
  // job and run for the version — not only those since the newest
  // authorization — so a second upload can never start a second run
  // beside one that is still working.
  // Abandoned jobs are retired first (compare-and-set, queue entry
  // cancelled, lease cleared — which fences the old worker). A job that
  // is merely waiting its turn on the worker is NOT abandoned.
  const retiredJobs = await retireStalledTranscriptionJobs({
    clubId,
    courseVersionId,
    now,
    retiredByUserId: principal.id,
  });
  for (const jobId of retiredJobs.retiredJobIds) {
    logger.warn("training.preparation.transcription.superseded_stalled", { clubId, courseVersionId, jobId });
  }
  const liveJob = await prisma.trainingTranscriptionJob.findFirst({
    where: { clubId, courseVersionId, state: { in: LIVE_STATES } },
    orderBy: { requestedAt: "asc" },
    select: { id: true },
  });
  if (liveJob) {
    return { action: "TRANSCRIPTION_IN_PROGRESS", detail: "live job", transcriptionJobId: liveJob.id };
  }
  // Abandoned generation runs are retired (compare-and-set, queue entry
  // cancelled, lease cleared); any run still live after that is in
  // flight and is waited for.
  const retiredRuns = await retireStalledGenerationRuns({ clubId, courseVersionId, now });
  for (const runId of retiredRuns.retiredRunIds) {
    logger.warn("training.preparation.generation.superseded_stalled", { clubId, courseVersionId, runId });
  }
  const allRuns = await prisma.trainingQuestionAiGenerationRun.findMany({
    where: { clubId, courseVersionId },
    select: {
      id: true,
      executionStatus: true,
      executionErrorCode: true,
      requestedAt: true,
      completedAt: true,
      sourceVideoSha256: true,
      assessmentPlanJson: true,
    },
    orderBy: { requestedAt: "asc" },
  });
  const liveRun = allRuns.find((r) => LIVE_STATES.includes(r.executionStatus));
  if (liveRun) {
    return { action: "GENERATION_IN_PROGRESS", detail: "live run", generationRunId: liveRun.id };
  }

  // ── Transcription leg ────────────────────────────────────────────
  if (!build) {
    // Attempts are counted per upload (authorization) and per video. A
    // job that was still in flight when this upload arrived belongs to
    // this upload's workflow too.
    const jobs = await prisma.trainingTranscriptionJob.findMany({
      where: {
        clubId,
        courseVersionId,
        sourceVideoSha256: version.videoSha256,
        OR: [
          { requestedAt: { gte: auth.authorizedAt } },
          { completedAt: { gte: auth.authorizedAt } },
          { cancelledAt: { gte: auth.authorizedAt } },
        ],
      },
      select: { id: true },
    });
    if (dispatchBlock) return refuseDispatch(dispatchBlock);
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
          payload: { jobId: result.jobId, nonBillable: inferenceMode === "MOCK" },
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
  // Passes are counted per upload (authorization) and per video. A run
  // that was still in flight when this upload arrived — and was waited
  // for by the single-flight check above — belongs to this upload's
  // workflow: its plan, its outcome and its attempt all count. Without
  // that, its questions would be ignored and a second full run started.
  const epochStart = auth.authorizedAt.getTime();
  const runs = allRuns.filter(
    (r) =>
      r.sourceVideoSha256 === version.videoSha256 &&
      (r.requestedAt.getTime() >= epochStart ||
        (r.completedAt !== null && r.completedAt.getTime() >= epochStart)),
  );

  const produced = await loadProducedState(clubId, courseVersionId, version.videoSha256);
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

  if (dispatchBlock) return refuseDispatch(dispatchBlock);

  // First pass, or a retry after a pass that produced nothing: the full
  // plan. Otherwise a repair pass for exactly what is missing.
  //
  // The plan to repair against is the fullest plan that ever completed
  // for THIS video — whichever upload started it. Questions that already
  // exist are never asked for again, so re-uploading the same video
  // after a partial result tops it up instead of doubling it.
  const basePlan =
    allRuns
      .filter((r) => r.executionStatus === "COMPLETED" && r.sourceVideoSha256 === version.videoSha256)
      .map((r) => parsePlan(r.assessmentPlanJson))
      .filter((p): p is AssessmentPlanV1 => p !== null)
      .reduce<AssessmentPlanV1 | null>(
        (best, p) =>
          best === null || p.proposedCheckpointGroups.length > best.proposedCheckpointGroups.length ? p : best,
        null,
      );
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
        action: result.idempotent ? "GENERATION_IN_PROGRESS" : "REPAIR_ENQUEUED",
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

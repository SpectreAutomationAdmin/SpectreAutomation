// EP-TRAIN-4Y-AF §5 — targeted final-assessment recovery service.
//
// Given an existing (COMPLETED) generation run whose FA group produced
// zero drafts, build a NEW recovery plan containing:
//   - proposedCheckpointGroups: []        (the 5 checkpoints stay bound
//                                           to the original run, untouched)
//   - proposedFinalAssessment:   target = N (shortfall count)
//   - proposedFinalAssessmentChunks: N chunks of ≤3 (§4 coverage planner)
// and request a new generation run via the existing lifecycle service.
//
// Preservation guarantees (directive §5):
//   - the existing 5 checkpoint drafts are NOT modified
//   - the existing run's shortfallReasonJson is NOT modified
//   - the existing run's assessmentPlanJson is NOT modified
//   - the existing run's executionStatus stays COMPLETED
//   - the existing TrainingGroundingProjection + transcript are preserved
//
// Budget guarantees (directive §7):
//   - a single recovery call never spawns a retry loop: the enqueued
//     job has maxAttempts: 1.
//   - the run's own `maxAttempts` is 1 — even if the queue job retries
//     (e.g. a transient DB write failure), the Modal lifecycle refuses
//     a second attempt.

import { prisma as defaultPrisma } from "@/lib/prisma";
import { hasPermission, type Principal } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { AppError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { enqueue } from "@/lib/queue";
import {
  requestGeneration,
  markGenerationQueued,
  GenerationRejectedError,
} from "./generation-service";
import {
  ASSESSMENT_PLAN_SCHEMA_VERSION,
  validateAssessmentPlan,
  type AssessmentPlanV1,
  type AssessmentPlanFinalAssessmentChunk,
} from "./assessment-plan";
import {
  buildFinalAssessmentCoverage,
  FA_CHUNK_MAX_TARGET,
} from "./final-assessment-coverage";
import {
  composeGroupMapsFromRuns,
  destinationKindForGroup,
} from "./destination-resolver";
import type { PrismaClient } from "@prisma/client";

export type FinalAssessmentRecoveryState =
  | "REQUESTED"
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export class FinalAssessmentRecoveryRejectedError extends AppError {
  readonly rejectionCode:
    | "ORIGINAL_RUN_NOT_FOUND"
    | "ORIGINAL_RUN_NOT_COMPLETED"
    | "ORIGINAL_PLAN_MISSING"
    | "ORIGINAL_PLAN_INVALID"
    | "TARGET_ALREADY_SATISFIED"
    | "COVERAGE_INSUFFICIENT"
    | "UNDERLYING_GENERATION_REJECTED";
  readonly detail: Record<string, unknown>;

  constructor(
    code: FinalAssessmentRecoveryRejectedError["rejectionCode"],
    message: string,
    httpStatus: number,
    detail: Record<string, unknown> = {},
  ) {
    super(code, message, httpStatus);
    this.rejectionCode = code;
    this.detail = detail;
  }
}

export interface RequestFinalAssessmentRecoveryInput {
  readonly originalRunId: string;
  /** Operator-specified total FA target. Defaults to the ORIGINAL
   *  run's `proposedFinalAssessment.targetQuestionCount` (10 for the
   *  4Y-Z pilot). The service deducts existing FA draft count to
   *  compute the SHORTFALL that this recovery actually generates. */
  readonly targetTotal?: number;
  /** Operator-specified per-chunk ceiling. Defaults to §4's 3. */
  readonly maxPerChunk?: number;
}

export interface RequestFinalAssessmentRecoveryResult {
  readonly ok: true;
  readonly recoveryRunId: string;
  readonly state: FinalAssessmentRecoveryState;
  readonly idempotent: boolean;
  readonly planIdentity: string;
  /** Number of FA drafts already present for this courseVersion
   *  BEFORE this recovery — used to compute the actual shortfall. */
  readonly existingFinalAssessmentDraftCount: number;
  readonly targetTotalRequested: number;
  readonly targetShortfall: number;
  readonly chunksProposed: readonly {
    readonly id: string;
    readonly targetQuestionCount: number;
    readonly focusTopicLabel: string;
  }[];
  /** Worst-case Modal inference budget in USD, projected from
   *  (chunk count × 180s ceiling + cold-boot). Used by the operator
   *  BEFORE firing the live call. */
  readonly projectedCostUsd: number;
}

/** Convert Modal ms to USD using the L40S per-ms rate used by the
 *  pilot-budget guard. Kept local so the preflight stays pure. */
export const PROJECTED_MS_COST_USD_PER_MS = 1.95 / (3600 * 1000);

export function projectRecoveryCostUsd(args: {
  readonly chunkCount: number;
  readonly perChunkCeilingSec?: number;
  readonly coldBootSec?: number;
}): number {
  const perChunkMs = ((args.perChunkCeilingSec ?? 180) * 1000) * args.chunkCount;
  const coldBootMs = (args.coldBootSec ?? 60) * 1000;
  return (perChunkMs + coldBootMs) * PROJECTED_MS_COST_USD_PER_MS;
}

export async function requestFinalAssessmentRecovery(
  principal: Principal | null,
  clubId: string,
  input: RequestFinalAssessmentRecoveryInput,
  opts: { prisma?: PrismaClient } = {},
): Promise<RequestFinalAssessmentRecoveryResult> {
  if (!principal) throw new ForbiddenError("authentication required");
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    throw new ForbiddenError("hr:training:write required");
  }
  const db = opts.prisma ?? defaultPrisma;

  // 1. Load the ORIGINAL run + verify COMPLETED + same tenant.
  const original = await db.trainingQuestionAiGenerationRun.findUnique({
    where: { id: input.originalRunId },
    select: {
      id: true, clubId: true, courseId: true, courseVersionId: true,
      executionStatus: true, assessmentPlanJson: true, shortfallReasonJson: true,
      resolvedTranscriptBuildId: true, sourceVideoSha256: true,
      groundingProjectionSha256: true,
    },
  });
  if (!original) throw new NotFoundError("TrainingQuestionAiGenerationRun", input.originalRunId);
  if (original.clubId !== clubId) throw new NotFoundError("TrainingQuestionAiGenerationRun", input.originalRunId);
  if (original.executionStatus !== "COMPLETED") {
    throw new FinalAssessmentRecoveryRejectedError(
      "ORIGINAL_RUN_NOT_COMPLETED",
      `Original run is in state ${original.executionStatus}; expected COMPLETED.`,
      409,
      { originalRunId: original.id, state: original.executionStatus },
    );
  }
  if (!original.assessmentPlanJson) {
    throw new FinalAssessmentRecoveryRejectedError(
      "ORIGINAL_PLAN_MISSING",
      "Original run has no assessmentPlanJson.",
      409,
    );
  }

  // 2. Parse + validate the original plan. We RE-USE its LO list +
  //    transcript build id verbatim.
  let originalPlan: AssessmentPlanV1;
  try {
    const parsed = JSON.parse(original.assessmentPlanJson) as unknown;
    originalPlan = validateAssessmentPlan(parsed);
  } catch (err) {
    throw new FinalAssessmentRecoveryRejectedError(
      "ORIGINAL_PLAN_INVALID",
      `Original plan failed re-validation: ${(err as Error).message}`,
      409,
      { issues: (err as Error & { issues?: unknown }).issues ?? [] },
    );
  }

  // 3. Count existing FA drafts across every completed run for this
  //    courseVersion. We compose group maps across runs and count
  //    drafts whose destination resolves to FINAL_ASSESSMENT.
  //    Drafts in ARCHIVED state DO count — they still occupy a logical
  //    FA slot — but only if their supersedere chain terminates in a
  //    FINAL_ASSESSMENT ancestor.
  const allCompletedRuns = await db.trainingQuestionAiGenerationRun.findMany({
    where: {
      clubId,
      courseVersionId: original.courseVersionId,
      executionStatus: "COMPLETED",
    },
    select: { id: true, shortfallReasonJson: true },
    orderBy: [{ completedAt: "asc" }],
  });
  const composedMap = composeGroupMapsFromRuns(
    allCompletedRuns.map((r) => r.shortfallReasonJson),
  );
  const faDrafts = await db.trainingQuestionAiDraft.findMany({
    where: {
      clubId,
      courseVersionId: original.courseVersionId,
      state: {
        // Count FA drafts that are LIVE in review OR already approved.
        // ARCHIVED-only chains (manager fully discarded) do NOT count.
        in: [
          "GENERATED",
          "VALIDATION_PENDING",
          "REQUIRES_HUMAN_REVIEW",
          "EDITED_VALIDATION_STALE",
          "VALIDATION_FAILED",
          "APPROVED_DRAFT",
          "PROMOTED",
        ],
      },
    },
    select: { id: true, contentHash: true },
  });
  let existingFinalAssessmentDraftCount = 0;
  for (const d of faDrafts) {
    const g = composedMap.get(d.contentHash) ?? null;
    if (destinationKindForGroup(g) === "FINAL_ASSESSMENT") existingFinalAssessmentDraftCount++;
  }

  // 4. Compute the shortfall.
  const defaultTarget = originalPlan.proposedFinalAssessment.targetQuestionCount;
  const requestedTotal = input.targetTotal ?? defaultTarget;
  const shortfall = Math.max(0, requestedTotal - existingFinalAssessmentDraftCount);
  if (shortfall === 0) {
    throw new FinalAssessmentRecoveryRejectedError(
      "TARGET_ALREADY_SATISFIED",
      `Final assessment already has ${existingFinalAssessmentDraftCount} draft(s); target is ${requestedTotal}.`,
      409,
      {
        existingFinalAssessmentDraftCount,
        targetTotalRequested: requestedTotal,
      },
    );
  }

  // 5. Build FA coverage chunks over the original plan's LO list.
  const coverage = buildFinalAssessmentCoverage({
    learningObjectives: originalPlan.learningObjectives,
    target: shortfall,
    maxPerChunk: input.maxPerChunk ?? FA_CHUNK_MAX_TARGET,
  });
  if (coverage.chunks.length === 0) {
    throw new FinalAssessmentRecoveryRejectedError(
      "COVERAGE_INSUFFICIENT",
      "Underlying plan has no grounded learning objectives to cover.",
      409,
      { loCount: originalPlan.learningObjectives.length },
    );
  }

  // 6. Build the RECOVERY plan. Reuses the original plan's transcript +
  //    video sha + eligible segments. Drops checkpoints (an empty list),
  //    sets FA target to the shortfall, and attaches the chunks.
  const now = new Date();
  const recoveryPlan: AssessmentPlanV1 = {
    schemaVersion: ASSESSMENT_PLAN_SCHEMA_VERSION,
    courseVersionId: originalPlan.courseVersionId,
    resolvedTranscriptBuildId: originalPlan.resolvedTranscriptBuildId,
    sourceVideoSha256: originalPlan.sourceVideoSha256,
    learningObjectives: originalPlan.learningObjectives,
    topicBoundaries: originalPlan.topicBoundaries,
    eligibleSegmentIds: originalPlan.eligibleSegmentIds,
    proposedCheckpointGroups: [],
    proposedFinalAssessment: {
      targetQuestionCount: shortfall,
      coverageLearningObjectiveIds: originalPlan.proposedFinalAssessment.coverageLearningObjectiveIds,
    },
    proposedFinalAssessmentChunks: coverage.chunks,
    totalTargetQuestionCount: shortfall,
    sourceEvidenceRequirements: originalPlan.sourceEvidenceRequirements,
    generatedAt: now.toISOString(),
    generatedByUserId: principal.id,
    generationPromptContract: "ctx-v1",
  };
  // Re-validate before handing to requestGeneration — a defence against
  // future field drift between this builder and the validator.
  validateAssessmentPlan(recoveryPlan);

  // 7. Call the shared generation-request lifecycle. Idempotent on
  //    planIdentity — repeated calls with the same inputs return the
  //    existing recovery run without creating a new Modal budget.
  let request;
  try {
    request = await requestGeneration(principal, clubId, {
      courseVersionId: original.courseVersionId,
      plan: recoveryPlan,
    }, { prisma: db });
  } catch (err) {
    if (err instanceof GenerationRejectedError) {
      throw new FinalAssessmentRecoveryRejectedError(
        "UNDERLYING_GENERATION_REJECTED",
        err.safeMessage,
        err.httpStatus,
        { rejectionCode: err.rejectionCode, ...err.detail },
      );
    }
    throw err;
  }

  // 8. If new, flip to QUEUED + enqueue the worker job. ONE attempt
  //    only (directive §7 — no automatic retries that could exceed the
  //    pilot budget). The run's own maxAttempts default (set by the
  //    generation-service at REQUESTED-create time) is 2; we lower it
  //    to 1 explicitly for this recovery row.
  if (!request.idempotent) {
    await db.trainingQuestionAiGenerationRun.updateMany({
      where: { id: request.generationRunId, clubId, executionStatus: "REQUESTED" },
      data: { maxAttempts: 1 },
    });
    await markGenerationQueued(clubId, request.generationRunId, { prisma: db });
    await enqueue({
      kind: "TRAINING_GENERATE_QUESTIONS",
      clubId,
      payload: { generationRunId: request.generationRunId },
      maxAttempts: 1, // NO automatic retries.
      idempotencyKey: `training-fa-recovery:${request.generationRunId}`,
    });
  }

  void audit(principal, {
    action: "hr.training.generation.final_assessment_recovery.request",
    entityType: "TrainingQuestionAiGenerationRun",
    entityId: request.generationRunId,
    clubId,
    after: {
      originalRunId: original.id,
      courseVersionId: original.courseVersionId,
      shortfall,
      chunks: coverage.chunks.length,
      idempotent: request.idempotent,
    },
  });

  return {
    ok: true,
    recoveryRunId: request.generationRunId,
    state: request.idempotent ? request.state : "QUEUED",
    idempotent: request.idempotent,
    planIdentity: request.planIdentity,
    existingFinalAssessmentDraftCount,
    targetTotalRequested: requestedTotal,
    targetShortfall: shortfall,
    chunksProposed: coverage.chunks.map((c) => ({
      id: c.id,
      targetQuestionCount: c.targetQuestionCount,
      focusTopicLabel: c.focusTopicLabel,
    })),
    projectedCostUsd: projectRecoveryCostUsd({ chunkCount: coverage.chunks.length }),
  };
}

/** Preflight — compute the recovery plan + cost projection WITHOUT
 *  calling requestGeneration. Used by the API route to satisfy the
 *  directive §7 "STOP and request explicit founder authorization"
 *  gate: the operator sees the exact chunk count, projected cost,
 *  and existing-draft count BEFORE any Modal invocation. Pure read.
 *  Never enqueues, never audits. */
export interface PreflightFinalAssessmentRecoveryResult {
  readonly preflight: true;
  readonly ready: boolean;
  readonly reason: string | null;
  readonly existingFinalAssessmentDraftCount: number;
  readonly targetTotalRequested: number;
  readonly targetShortfall: number;
  readonly chunksProposed: readonly {
    readonly id: string;
    readonly targetQuestionCount: number;
    readonly focusTopicLabel: string;
  }[];
  readonly projectedCostUsd: number;
}

export async function preflightFinalAssessmentRecovery(
  principal: Principal | null,
  clubId: string,
  input: RequestFinalAssessmentRecoveryInput,
  opts: { prisma?: PrismaClient } = {},
): Promise<PreflightFinalAssessmentRecoveryResult> {
  if (!principal) throw new ForbiddenError("authentication required");
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    throw new ForbiddenError("hr:training:write required");
  }
  const db = opts.prisma ?? defaultPrisma;

  const original = await db.trainingQuestionAiGenerationRun.findUnique({
    where: { id: input.originalRunId },
    select: {
      id: true, clubId: true, courseVersionId: true,
      executionStatus: true, assessmentPlanJson: true,
    },
  });
  if (!original || original.clubId !== clubId) {
    throw new NotFoundError("TrainingQuestionAiGenerationRun", input.originalRunId);
  }

  const ready =
    original.executionStatus === "COMPLETED" &&
    typeof original.assessmentPlanJson === "string" &&
    original.assessmentPlanJson.length > 0;
  const reason = !ready
    ? `original run in state ${original.executionStatus}; expected COMPLETED with assessmentPlanJson`
    : null;

  let plan: AssessmentPlanV1 | null = null;
  try {
    if (ready && original.assessmentPlanJson) {
      plan = validateAssessmentPlan(JSON.parse(original.assessmentPlanJson));
    }
  } catch {
    return {
      preflight: true,
      ready: false,
      reason: "original plan failed re-validation",
      existingFinalAssessmentDraftCount: 0,
      targetTotalRequested: input.targetTotal ?? 0,
      targetShortfall: 0,
      chunksProposed: [],
      projectedCostUsd: 0,
    };
  }
  if (!plan) {
    return {
      preflight: true,
      ready: false,
      reason: reason ?? "plan unavailable",
      existingFinalAssessmentDraftCount: 0,
      targetTotalRequested: input.targetTotal ?? 0,
      targetShortfall: 0,
      chunksProposed: [],
      projectedCostUsd: 0,
    };
  }

  const allRuns = await db.trainingQuestionAiGenerationRun.findMany({
    where: { clubId, courseVersionId: original.courseVersionId, executionStatus: "COMPLETED" },
    select: { shortfallReasonJson: true },
  });
  const composed = composeGroupMapsFromRuns(allRuns.map((r) => r.shortfallReasonJson));
  const faDrafts = await db.trainingQuestionAiDraft.findMany({
    where: {
      clubId,
      courseVersionId: original.courseVersionId,
      state: {
        in: ["GENERATED", "VALIDATION_PENDING", "REQUIRES_HUMAN_REVIEW",
             "EDITED_VALIDATION_STALE", "VALIDATION_FAILED", "APPROVED_DRAFT", "PROMOTED"],
      },
    },
    select: { contentHash: true },
  });
  let existingFinalAssessmentDraftCount = 0;
  for (const d of faDrafts) {
    const g = composed.get(d.contentHash) ?? null;
    if (destinationKindForGroup(g) === "FINAL_ASSESSMENT") existingFinalAssessmentDraftCount++;
  }

  const requestedTotal = input.targetTotal ?? plan.proposedFinalAssessment.targetQuestionCount;
  const shortfall = Math.max(0, requestedTotal - existingFinalAssessmentDraftCount);
  const coverage = buildFinalAssessmentCoverage({
    learningObjectives: plan.learningObjectives,
    target: shortfall,
    maxPerChunk: input.maxPerChunk ?? FA_CHUNK_MAX_TARGET,
  });

  return {
    preflight: true,
    ready,
    reason,
    existingFinalAssessmentDraftCount,
    targetTotalRequested: requestedTotal,
    targetShortfall: shortfall,
    chunksProposed: coverage.chunks.map((c) => ({
      id: c.id,
      targetQuestionCount: c.targetQuestionCount,
      focusTopicLabel: c.focusTopicLabel,
    })),
    projectedCostUsd: projectRecoveryCostUsd({ chunkCount: coverage.chunks.length }),
  };
}

/** Chunks of the recovery plan, exposed for operator reports. */
export type RecoveryChunkDescription = Pick<
  AssessmentPlanFinalAssessmentChunk,
  "id" | "targetQuestionCount" | "focusTopicLabel"
>;

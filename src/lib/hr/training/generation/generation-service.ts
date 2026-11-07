// EP-TRAIN-6D-4W (2026-11-06) — Question-generation lifecycle service.
//
// The ONLY code path that may:
//   - create REQUESTED generation runs with a validated plan;
//   - transition QUEUED → RUNNING (atomic claim with bounded lease);
//   - renew a lease without resetting attempts (fencing);
//   - transition RUNNING → COMPLETED with shortfall persisted;
//   - transition * → FAILED or * → CANCELLED;
//   - reclaim RUNNING runs whose leases expired.
//
// Plan immutability (founder requirement 4): once state leaves
// REQUESTED, assessmentPlanJson + planIdentity are frozen. The
// service refuses to mutate them.
//
// DB-boundary dedup (founder requirement 5): the partial-unique
// index on (clubId, courseVersionId, resolvedTranscriptBuildId,
// planIdentity, executionStatus) collapses duplicate non-terminal
// runs. A concurrent duplicate raises P2002; the service maps that
// to an idempotent-replay return.
//
// Cost governance (founder requirement 6): per-tenant daily USD
// cap defaults to $10 to match the founder's Modal account cap.

import { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { hasPermission, type Principal } from "@/lib/rbac";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from "@/lib/errors";
import { randomBytes } from "node:crypto";
import {
  validateAssessmentPlan,
  planIdentityHash,
  type AssessmentPlanV1,
} from "./assessment-plan";

export type GenerationState =
  | "REQUESTED"
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type GenerationFailureCode =
  | "MODAL_HTTP_ERROR"
  | "MODAL_TIMEOUT"
  | "MODAL_HMAC_INVALID"
  | "MODAL_BODY_INVALID"
  | "INVALID_STRUCTURED_OUTPUT"
  | "CREDENTIAL_ABSENT"
  | "COST_CAP_EXCEEDED"
  | "INSUFFICIENT_EVIDENCE"
  | "SOURCE_VIDEO_MISMATCH"
  | "TRANSCRIPT_MISSING"
  | "DRAFT_PERSIST_FAILED"
  // EP-TRAIN-4Y-B-IMPL widening — Hybrid contract failure codes.
  | "REQUEST_HMAC_INVALID"
  | "REQUEST_BODY_INVALID"
  | "TIMESTAMP_SKEW_EXCEEDED"
  | "UNKNOWN_OPERATION"
  | "OPERATION_MISMATCH"
  | "CONTRACT_VERSION_MISMATCH"
  | "ASCII_SCOPE_REQUIRED"
  | "PILOT_AUTH_FINGERPRINT_MISMATCH"
  | "PILOT_AUTH_EXPIRED"
  | "PILOT_AUTH_OPERATION_MISMATCH"
  | "PILOT_AUTH_SCHEMA_MISMATCH"
  | "TENANT_MISMATCH"
  | "COURSE_VERSION_MISMATCH"
  | "VIDEO_SHA_MISMATCH_AT_BOUNDARY"
  | "REPLAY_DETECTED"
  | "REPLAY_STORE_UNAVAILABLE"
  | "RESPONSE_REQUEST_ID_MISMATCH"
  | "RESPONSE_OPERATION_MISMATCH";

export type RequestRejectionCode =
  | "VERSION_NOT_FOUND"
  | "VERSION_NOT_DRAFT"
  | "TRANSCRIPT_MISSING"
  | "PLAN_INVALID"
  | "DUPLICATE_LIVE_RUN"
  | "COST_CAP_EXCEEDED"
  | "CREDENTIAL_ABSENT";

export class GenerationRejectedError extends AppError {
  readonly rejectionCode:
    | RequestRejectionCode
    | "PLAN_FROZEN"
    | "CLAIM_RACE"
    | "TERMINAL_STATE_WRITE"
    | "LEASE_MISMATCH";
  readonly detail: Record<string, unknown>;

  constructor(
    rejectionCode: GenerationRejectedError["rejectionCode"],
    message: string,
    httpStatus: number,
    detail: Record<string, unknown> = {},
  ) {
    super(rejectionCode, message, httpStatus);
    this.rejectionCode = rejectionCode;
    this.detail = detail;
  }
}

// ─── Credentials + cost governance ──────────────────────────────────

export function modalGenerateCredentialsPresent(opts: { env?: NodeJS.ProcessEnv } = {}): boolean {
  const env = opts.env ?? process.env;
  return typeof env.MODAL_GENERATE_URL === "string" &&
    env.MODAL_GENERATE_URL.length > 0 &&
    typeof env.MODAL_SPECTRE_SHARED_TOKEN === "string" &&
    env.MODAL_SPECTRE_SHARED_TOKEN.length > 0;
}

export const DEFAULT_DAILY_USD_MICROS = 10 * 1_000_000; // $10 × 1e6
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;    // 10 min
export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;      // 15 min

export async function tenantGenerationDailyCostMicros(
  clubId: string,
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<number> {
  const db = opts.prisma ?? defaultPrisma;
  const since = new Date((opts.now ?? new Date()).getTime() - 24 * 3600 * 1000);
  // Sum inferenceMs across COMPLETED runs in the last 24h. Multiply
  // by the per-ms L40S rate (~$1.95/hr → $0.000542/ms). Stored as
  // micros = raw usd × 1e6.
  const r = await db.trainingQuestionAiGenerationRun.aggregate({
    where: {
      clubId,
      executionStatus: "COMPLETED",
      completedAt: { gte: since },
    },
    _sum: { inferenceMs: true },
  });
  const inferenceMs = r._sum.inferenceMs ?? 0;
  // $1.95/hr = 1.95 / (3600 * 1000) $/ms = 5.4166…e-7 $/ms
  // In micros: 0.54166… micros / ms → round up
  return Math.ceil(inferenceMs * 0.541_666_7);
}

// ─── Lifecycle service ──────────────────────────────────────────────

export interface RequestGenerationInput {
  readonly courseVersionId: string;
  readonly plan: AssessmentPlanV1;
  readonly modelName?: string;         // default: qwen-2.5-7b-instruct-awq
  readonly modelBackend?: string;      // default: vllm
  readonly modelFormatEnforcer?: string; // default: lm-format-enforcer
  readonly modalAppIdentity?: string;
}

export interface RequestGenerationResult {
  readonly ok: true;
  readonly generationRunId: string;
  readonly state: GenerationState;
  readonly idempotent: boolean;
  readonly planIdentity: string;
}

export async function requestGeneration(
  principal: Principal | null,
  clubId: string,
  input: RequestGenerationInput,
  opts: { prisma?: PrismaClient } = {},
): Promise<RequestGenerationResult> {
  if (!principal) throw new UnauthenticatedError();
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    throw new ForbiddenError("hr:training:write required");
  }
  const db = opts.prisma ?? defaultPrisma;

  // Validate the plan contract.
  let plan: AssessmentPlanV1;
  try {
    plan = validateAssessmentPlan(input.plan);
  } catch (err) {
    throw new GenerationRejectedError(
      "PLAN_INVALID",
      (err as Error)?.message ?? "assessment plan validation failed",
      400,
      { issues: (err as Error & { issues?: unknown })?.issues ?? [] },
    );
  }

  // Load the course-version + verify tenant + DRAFT state.
  const version = await db.trainingCourseVersion.findUnique({
    where: { id: input.courseVersionId },
    select: {
      id: true, state: true, videoSha256: true,
      course: { select: { id: true, clubId: true } },
    },
  });
  if (!version || version.course.clubId !== clubId) {
    throw new GenerationRejectedError("VERSION_NOT_FOUND", "Version not found.", 404);
  }
  if (version.state !== "DRAFT") {
    throw new GenerationRejectedError("VERSION_NOT_DRAFT", `Cannot generate for ${version.state} version.`, 409);
  }
  if (!version.videoSha256 || version.videoSha256 !== plan.sourceVideoSha256) {
    throw new GenerationRejectedError(
      "PLAN_INVALID",
      "Plan sourceVideoSha256 does not match the current course-version video.",
      400,
    );
  }

  // Verify transcript build exists for this (club, video sha,
  // resolvedTranscriptBuildId).
  const build = await db.trainingTranscriptBuild.findUnique({
    where: {
      clubId_sourceVideoSha256_resolvedTranscriptBuildId: {
        clubId,
        sourceVideoSha256: plan.sourceVideoSha256,
        resolvedTranscriptBuildId: plan.resolvedTranscriptBuildId,
      },
    },
    select: { id: true },
  });
  if (!build) {
    throw new GenerationRejectedError(
      "TRANSCRIPT_MISSING",
      "Transcript build referenced by the plan does not exist.",
      409,
    );
  }

  // Credentials fail-closed BEFORE creating a REQUESTED row.
  if (!modalGenerateCredentialsPresent()) {
    throw new GenerationRejectedError(
      "CREDENTIAL_ABSENT",
      "Generation provider credentials are not configured.",
      503,
    );
  }

  const identity = planIdentityHash(plan);

  // Return any existing non-terminal run with this identity (DB-
  // boundary dedup + application-level pre-check).
  const existing = await db.trainingQuestionAiGenerationRun.findFirst({
    where: {
      clubId,
      courseVersionId: input.courseVersionId,
      resolvedTranscriptBuildId: plan.resolvedTranscriptBuildId,
      planIdentity: identity,
      executionStatus: { in: ["REQUESTED", "QUEUED", "RUNNING", "COMPLETED"] },
    },
    select: { id: true, executionStatus: true },
  });
  if (existing) {
    return {
      ok: true,
      generationRunId: existing.id,
      state: existing.executionStatus as GenerationState,
      idempotent: true,
      planIdentity: identity,
    };
  }

  // Cost cap.
  const currentCost = await tenantGenerationDailyCostMicros(clubId, { prisma: db });
  const estimateMicros = 1_000_000; // $1.00 per generation run (worst-case estimate)
  if (currentCost + estimateMicros > DEFAULT_DAILY_USD_MICROS) {
    throw new GenerationRejectedError(
      "COST_CAP_EXCEEDED",
      "Daily generation cost cap would be exceeded.",
      409,
      { currentCostMicros: currentCost, capMicros: DEFAULT_DAILY_USD_MICROS },
    );
  }

  // Create the REQUESTED run.
  try {
    const run = await db.trainingQuestionAiGenerationRun.create({
      data: {
        clubId,
        courseId: version.course.id,
        courseVersionId: input.courseVersionId,
        pilotAuthorizationId: "4w-generation",
        pilotAuthorizationFingerprint: identity.slice(0, 32),
        sourceVideoSha256: plan.sourceVideoSha256,
        resolvedTranscriptBuildId: plan.resolvedTranscriptBuildId,
        groundingProjectionSha256: "pending",
        modelName: input.modelName ?? "qwen-2.5-7b-instruct-awq",
        modelBackend: input.modelBackend ?? "vllm",
        modelFormatEnforcer: input.modelFormatEnforcer ?? "lm-format-enforcer",
        modalAppIdentity: input.modalAppIdentity ?? null,
        requestedByUserId: principal.id,
        executionStatus: "REQUESTED",
        assessmentPlanJson: JSON.stringify(plan),
        planIdentity: identity,
      },
      select: { id: true },
    });
    void audit(principal, {
      action: "hr.training.generation.request",
      entityType: "TrainingQuestionAiGenerationRun",
      entityId: run.id,
      clubId,
      after: {
        courseVersionId: input.courseVersionId,
        planIdentity: identity,
        totalTargetQuestionCount: plan.totalTargetQuestionCount,
      },
    });
    return {
      ok: true,
      generationRunId: run.id,
      state: "REQUESTED",
      idempotent: false,
      planIdentity: identity,
    };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Race — someone wrote the same planIdentity while we were
      // between the pre-check and the create. Re-read the winner.
      const winner = await db.trainingQuestionAiGenerationRun.findFirst({
        where: {
          clubId,
          courseVersionId: input.courseVersionId,
          resolvedTranscriptBuildId: plan.resolvedTranscriptBuildId,
          planIdentity: identity,
          executionStatus: { in: ["REQUESTED", "QUEUED", "RUNNING", "COMPLETED"] },
        },
        select: { id: true, executionStatus: true },
      });
      if (winner) {
        return {
          ok: true,
          generationRunId: winner.id,
          state: winner.executionStatus as GenerationState,
          idempotent: true,
          planIdentity: identity,
        };
      }
    }
    throw err;
  }
}

/** Transition REQUESTED → QUEUED. Refuses on any other starting state. */
export async function markGenerationQueued(
  clubId: string,
  runId: string,
  opts: { prisma?: PrismaClient } = {},
): Promise<void> {
  const db = opts.prisma ?? defaultPrisma;
  const n = await db.trainingQuestionAiGenerationRun.updateMany({
    where: { id: runId, clubId, executionStatus: "REQUESTED" },
    data: { executionStatus: "QUEUED", queuedAt: new Date() },
  });
  if (n.count === 0) {
    throw new GenerationRejectedError(
      "CLAIM_RACE",
      "Run is not REQUESTED.",
      409,
    );
  }
}

export interface GenerationClaimResult {
  readonly ok: true;
  readonly runId: string;
  readonly attempt: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly clubId: string;
  readonly courseVersionId: string;
  readonly planIdentity: string;
  readonly assessmentPlanJson: string;
}

function newLeaseToken(): string {
  return randomBytes(16).toString("hex");
}

/** Worker-side atomic claim. QUEUED → RUNNING with lease; falls
 *  back to RUNNING rows whose leaseExpiresAt has passed (stale-lease
 *  recovery), subject to attempts < maxAttempts. */
export async function claimNextGenerationRun(
  opts: { prisma?: PrismaClient; now?: Date; leaseTtlMs?: number } = {},
): Promise<GenerationClaimResult | null> {
  const db = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + (opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS));
  const leaseToken = newLeaseToken();

  const queuedCandidate = await db.trainingQuestionAiGenerationRun.findFirst({
    where: { executionStatus: "QUEUED", leaseToken: null },
    orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
    select: { id: true, attempts: true, maxAttempts: true, clubId: true, courseVersionId: true, planIdentity: true, assessmentPlanJson: true },
  });
  if (queuedCandidate) {
    const upd = await db.trainingQuestionAiGenerationRun.updateMany({
      where: { id: queuedCandidate.id, executionStatus: "QUEUED", leaseToken: null },
      data: {
        executionStatus: "RUNNING",
        startedAt: now,
        leaseToken,
        leaseExpiresAt,
        attempts: { increment: 1 },
      },
    });
    if (upd.count === 1) {
      return {
        ok: true,
        runId: queuedCandidate.id,
        attempt: queuedCandidate.attempts + 1,
        leaseToken,
        leaseExpiresAt,
        clubId: queuedCandidate.clubId,
        courseVersionId: queuedCandidate.courseVersionId,
        planIdentity: queuedCandidate.planIdentity ?? "",
        assessmentPlanJson: queuedCandidate.assessmentPlanJson ?? "",
      };
    }
  }

  // Stale-lease reclaim.
  const stale = await db.trainingQuestionAiGenerationRun.findFirst({
    where: {
      executionStatus: "RUNNING",
      leaseExpiresAt: { lt: now },
    },
    orderBy: [{ leaseExpiresAt: "asc" }, { id: "asc" }],
    select: { id: true, attempts: true, maxAttempts: true, clubId: true, courseVersionId: true, planIdentity: true, assessmentPlanJson: true },
  });
  if (!stale) return null;

  if (stale.attempts >= stale.maxAttempts) {
    await db.trainingQuestionAiGenerationRun.updateMany({
      where: { id: stale.id, executionStatus: "RUNNING" },
      data: {
        executionStatus: "FAILED",
        executionErrorCode: "MODAL_TIMEOUT",
        executionErrorMessage: "Stale lease + attempts exhausted.",
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: now,
      },
    });
    return null;
  }

  const upd = await db.trainingQuestionAiGenerationRun.updateMany({
    where: { id: stale.id, executionStatus: "RUNNING" },
    data: {
      leaseToken,
      leaseExpiresAt,
      attempts: { increment: 1 },
    },
  });
  if (upd.count === 1) {
    return {
      ok: true,
      runId: stale.id,
      attempt: stale.attempts + 1,
      leaseToken,
      leaseExpiresAt,
      clubId: stale.clubId,
      courseVersionId: stale.courseVersionId,
      planIdentity: stale.planIdentity ?? "",
      assessmentPlanJson: stale.assessmentPlanJson ?? "",
    };
  }
  return null;
}

/** Lease renewal (founder requirement 2 — "lease renewal or
 *  equivalent fencing"). Pushes the lease forward without
 *  incrementing attempts. Refuses on lease mismatch. */
export async function renewGenerationLease(
  runId: string,
  leaseToken: string,
  opts: { prisma?: PrismaClient; now?: Date; leaseTtlMs?: number } = {},
): Promise<{ leaseExpiresAt: Date }> {
  const db = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + (opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS));
  const upd = await db.trainingQuestionAiGenerationRun.updateMany({
    where: { id: runId, executionStatus: "RUNNING", leaseToken },
    data: { leaseExpiresAt },
  });
  if (upd.count === 0) {
    throw new GenerationRejectedError(
      "LEASE_MISMATCH",
      "Cannot renew lease: run is not RUNNING or lease token mismatched.",
      409,
    );
  }
  return { leaseExpiresAt };
}

export interface CompleteGenerationInput {
  readonly runId: string;
  readonly leaseToken: string;
  readonly inferenceMs: number;
  readonly promptTokenCount: number;
  readonly outputTokenCount: number;
  readonly groundingProjectionSha256: string; // the projection drafts cite
  readonly shortfallReasonJson?: string;
}

export async function recordGenerationCompleted(
  input: CompleteGenerationInput,
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<void> {
  const db = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const upd = await db.trainingQuestionAiGenerationRun.updateMany({
    where: {
      id: input.runId,
      executionStatus: "RUNNING",
      leaseToken: input.leaseToken,
    },
    data: {
      executionStatus: "COMPLETED",
      completedAt: now,
      inferenceMs: input.inferenceMs,
      promptTokenCount: input.promptTokenCount,
      outputTokenCount: input.outputTokenCount,
      groundingProjectionSha256: input.groundingProjectionSha256,
      shortfallReasonJson: input.shortfallReasonJson ?? null,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (upd.count === 0) {
    throw new GenerationRejectedError(
      "TERMINAL_STATE_WRITE",
      "Cannot complete: run is not RUNNING with the expected lease.",
      409,
    );
  }
}

export interface FailGenerationInput {
  readonly runId: string;
  readonly leaseToken: string;
  readonly failureCode: GenerationFailureCode;
  readonly failureMessage: string;
  readonly retryable?: boolean;
}

export async function recordGenerationFailed(
  input: FailGenerationInput,
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<{ finalState: "FAILED" | "QUEUED" }> {
  const db = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const row = await db.trainingQuestionAiGenerationRun.findFirst({
    where: { id: input.runId, executionStatus: "RUNNING", leaseToken: input.leaseToken },
    select: { attempts: true, maxAttempts: true },
  });
  if (!row) {
    throw new GenerationRejectedError(
      "TERMINAL_STATE_WRITE",
      "Cannot fail: run is not RUNNING with the expected lease.",
      409,
    );
  }
  const canRetry = (input.retryable ?? false) && row.attempts < row.maxAttempts;
  const nextState: "FAILED" | "QUEUED" = canRetry ? "QUEUED" : "FAILED";
  const upd = await db.trainingQuestionAiGenerationRun.updateMany({
    where: { id: input.runId, executionStatus: "RUNNING", leaseToken: input.leaseToken },
    data: {
      executionStatus: nextState,
      executionErrorCode: input.failureCode,
      executionErrorMessage: input.failureMessage,
      leaseToken: null,
      leaseExpiresAt: null,
      ...(canRetry
        ? { startedAt: null, queuedAt: now }
        : { completedAt: now }),
    },
  });
  if (upd.count === 0) {
    throw new GenerationRejectedError(
      "TERMINAL_STATE_WRITE",
      "Cannot fail: run state changed.",
      409,
    );
  }
  return { finalState: nextState };
}

export async function cancelGenerationRun(
  principal: Principal,
  clubId: string,
  runId: string,
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<{ state: GenerationState }> {
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    throw new ForbiddenError("hr:training:write required");
  }
  const db = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const existing = await db.trainingQuestionAiGenerationRun.findFirst({
    where: { id: runId, clubId },
    select: { executionStatus: true },
  });
  if (!existing) throw new NotFoundError("TrainingQuestionAiGenerationRun", runId);
  if (existing.executionStatus === "CANCELLED") return { state: "CANCELLED" };
  if (existing.executionStatus === "COMPLETED" || existing.executionStatus === "FAILED") {
    throw new GenerationRejectedError(
      "TERMINAL_STATE_WRITE",
      `Cannot cancel run in terminal state ${existing.executionStatus}.`,
      409,
      { state: existing.executionStatus },
    );
  }
  const upd = await db.trainingQuestionAiGenerationRun.updateMany({
    where: { id: runId, clubId, executionStatus: { in: ["REQUESTED", "QUEUED", "RUNNING"] } },
    data: {
      executionStatus: "CANCELLED",
      completedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (upd.count === 0) {
    const current = await db.trainingQuestionAiGenerationRun.findUnique({
      where: { id: runId }, select: { executionStatus: true },
    });
    return { state: (current?.executionStatus ?? "FAILED") as GenerationState };
  }
  void audit(principal, {
    action: "hr.training.generation.cancel",
    entityType: "TrainingQuestionAiGenerationRun",
    entityId: runId,
    clubId,
    after: { previousState: existing.executionStatus },
  });
  return { state: "CANCELLED" };
}

export async function sweepStaleGenerationLeases(
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<{ reclaimed: number; exhausted: number }> {
  const db = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const stale = await db.trainingQuestionAiGenerationRun.findMany({
    where: { executionStatus: "RUNNING", leaseExpiresAt: { lt: now } },
    select: { id: true, attempts: true, maxAttempts: true },
  });
  let reclaimed = 0;
  let exhausted = 0;
  for (const r of stale) {
    if (r.attempts >= r.maxAttempts) {
      await db.trainingQuestionAiGenerationRun.updateMany({
        where: { id: r.id, executionStatus: "RUNNING" },
        data: {
          executionStatus: "FAILED",
          executionErrorCode: "MODAL_TIMEOUT",
          executionErrorMessage: "Stale lease + attempts exhausted.",
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: now,
        },
      });
      exhausted++;
    } else {
      const upd = await db.trainingQuestionAiGenerationRun.updateMany({
        where: { id: r.id, executionStatus: "RUNNING" },
        data: {
          executionStatus: "QUEUED",
          startedAt: null,
          queuedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (upd.count === 1) reclaimed++;
    }
  }
  return { reclaimed, exhausted };
}

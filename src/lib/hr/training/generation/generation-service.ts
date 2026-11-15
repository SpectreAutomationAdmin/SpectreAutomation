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
import {
  HARD_QUEUE_WAIT_MS,
  LEASE_GRACE_MS,
  LIVE_EXECUTION_STATES,
  MAX_QUEUE_WAIT_MS,
  hasLiveQueueEntry,
} from "./stall-policy";
import { resolveTestScope } from "./test-execution-identity";

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
  // EP-TRAIN-4Y-BF — this environment has not enabled billable inference.
  | "BILLABLE_INFERENCE_LOCKED"
  // EP-TRAIN-4Y-BF — an unexpected error inside the worker after it
  // claimed the run. Retryable: the run is handed back to the queue.
  | "WORKER_ERROR"
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
  | "RESPONSE_OPERATION_MISMATCH"
  // EP-TRAIN-4Y-Z §3 — pilot-specific cumulative spending guard.
  // Distinct from COST_CAP_EXCEEDED (per-tenant daily $10 cap). This
  // trips when the conservative worst-case projection of a bounded
  // pilot (metadata + question-generation calls + retries) would
  // exceed the authorised $1 pilot ceiling.
  | "PILOT_BUDGET_EXCEEDED";

export type RequestRejectionCode =
  | "VERSION_NOT_FOUND"
  | "VERSION_NOT_DRAFT"
  | "TRANSCRIPT_MISSING"
  | "PLAN_INVALID"
  | "DUPLICATE_LIVE_RUN"
  | "COST_CAP_EXCEEDED"
  | "CREDENTIAL_ABSENT"
  // EP-TRAIN-4Y-BF — a test principal may only work on test courses.
  | "TEST_PRINCIPAL_SCOPE";

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
  // EP-TRAIN-4Y-G §5 — symmetric to modalCredentialsPresent() in
  // transcription/job-service.ts. Web-side precheck uses the
  // MODAL_HYBRID_ENABLED=1 non-sensitive signal; legacy fallback
  // preserved for backwards compat in older test envs.
  const env = opts.env ?? process.env;
  const hybridEnabled =
    typeof env.MODAL_HYBRID_ENABLED === "string" &&
    env.MODAL_HYBRID_ENABLED === "1";
  const legacyShared =
    typeof env.MODAL_GENERATE_URL === "string" &&
    env.MODAL_GENERATE_URL.length > 0 &&
    typeof env.MODAL_SPECTRE_SHARED_TOKEN === "string" &&
    env.MODAL_SPECTRE_SHARED_TOKEN.length > 0;
  return hybridEnabled || legacyShared;
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
  /** EP-TRAIN-4Y-BF — true when another run was already live for this
   *  version and the request resolved to it instead of creating a second
   *  run. The live run may carry a different plan than the one asked for. */
  readonly resolvedToActiveRun?: boolean;
}

/** Client usable both on the pool and inside a transaction. */
type Db = PrismaClient | Prisma.TransactionClient;

/** Message written on a run retired as abandoned. The per-course cost
 *  loader recognises it (a retired RUNNING run has unknown real cost and
 *  is counted at its worst case). */
export const SUPERSEDED_RUN_MESSAGE = "Stalled run superseded by automatic recovery.";

/** EP-TRAIN-4Y-BF — retire generation runs that were abandoned:
 *    - RUNNING long past a lease nobody renewed (the worker died);
 *    - REQUESTED / QUEUED with no queue entry left to run them, or
 *      queued beyond the hard limit.
 *  A run that is merely WAITING behind another job on the serial worker
 *  is not abandoned and is left alone. Each retirement is a
 *  compare-and-set on the row's state, so a run a worker claimed or
 *  renewed in the meantime is untouched. The run's queue entry is
 *  cancelled, and its lease token is cleared — which fences its
 *  worker: every later write by that worker is conditional on the
 *  token. */
export async function retireStalledGenerationRuns(
  args: { readonly clubId: string; readonly courseVersionId: string; readonly now?: Date },
  opts: { prisma?: Db } = {},
): Promise<{ readonly retiredRunIds: readonly string[] }> {
  const db: Db = opts.prisma ?? defaultPrisma;
  const now = args.now ?? new Date();
  const leaseCutoff = new Date(now.getTime() - LEASE_GRACE_MS);
  const candidates = await db.trainingQuestionAiGenerationRun.findMany({
    where: {
      clubId: args.clubId,
      courseVersionId: args.courseVersionId,
      executionStatus: { in: [...LIVE_EXECUTION_STATES] },
    },
    select: { id: true, executionStatus: true, requestedAt: true, queuedAt: true, leaseExpiresAt: true },
  });
  const retiredRunIds: string[] = [];
  for (const c of candidates) {
    const queueKeys = [`training-generate:${c.id}`, `training-fa-recovery:${c.id}`];
    let where: Prisma.TrainingQuestionAiGenerationRunWhereInput;
    if (c.executionStatus === "RUNNING") {
      if (c.leaseExpiresAt === null || c.leaseExpiresAt.getTime() >= leaseCutoff.getTime()) continue;
      where = { id: c.id, clubId: args.clubId, executionStatus: "RUNNING", leaseExpiresAt: { lt: leaseCutoff } };
    } else {
      const waitingSince = c.queuedAt ?? c.requestedAt;
      const waitedMs = now.getTime() - waitingSince.getTime();
      if (waitedMs <= MAX_QUEUE_WAIT_MS) continue;
      if (
        waitedMs <= HARD_QUEUE_WAIT_MS &&
        (await hasLiveQueueEntry(db, {
          clubId: args.clubId,
          kind: "TRAINING_GENERATE_QUESTIONS",
          idempotencyKeys: queueKeys,
          now,
        }))
      ) {
        // Waiting its turn behind another job: not abandoned.
        continue;
      }
      const waitCutoff = new Date(now.getTime() - MAX_QUEUE_WAIT_MS);
      where = {
        id: c.id,
        clubId: args.clubId,
        executionStatus: { in: ["REQUESTED", "QUEUED"] },
        OR: [{ queuedAt: { lt: waitCutoff } }, { queuedAt: null, requestedAt: { lt: waitCutoff } }],
      };
    }
    const retired = await db.trainingQuestionAiGenerationRun.updateMany({
      where,
      data: {
        executionStatus: "FAILED",
        executionErrorCode: "MODAL_TIMEOUT",
        executionErrorMessage: SUPERSEDED_RUN_MESSAGE,
        completedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (retired.count === 0) continue;
    retiredRunIds.push(c.id);
    await db.backgroundJob.updateMany({
      where: {
        clubId: args.clubId,
        kind: "TRAINING_GENERATE_QUESTIONS",
        idempotencyKey: { in: queueKeys },
        status: { in: ["QUEUED", "RUNNING"] },
      },
      data: { status: "CANCELLED", finishedAt: now },
    });
  }
  return { retiredRunIds };
}

/** EP-TRAIN-4Y-BF — single-flight per (club, course version) for the
 *  generation operation. "Is a run live? If not, create one" executes
 *  under a per-version database lock, so two requests that arrive
 *  together cannot both create a run — whatever their plans, whoever
 *  sent them, and whichever process they run in. The lock is held by
 *  the database transaction; nothing in memory or in a browser is
 *  relied on. (SQLite, used by the unit tests, serializes writers.) */
async function withGenerationSingleFlight<T>(
  db: PrismaClient,
  clubId: string,
  courseVersionId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const isPostgres = (process.env.DATABASE_URL ?? "").startsWith("postgres");
  const key = `training-generation-single-flight:${clubId}:${courseVersionId}`;
  return db.$transaction(
    async (tx) => {
      if (isPostgres) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      }
      return fn(tx);
    },
    { timeout: 20_000, maxWait: 15_000 },
  );
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
  // EP-TRAIN-4Y-BF — a test principal may only work on courses a test
  // principal created. Requesting a run on a real manager's course would
  // mark that course as non-billable for good.
  if (
    (await resolveTestScope(principal, { clubId, courseVersionId: input.courseVersionId }, { prisma: db })) ===
    "TEST_PRINCIPAL_ON_REAL_COURSE"
  ) {
    throw new GenerationRejectedError(
      "TEST_PRINCIPAL_SCOPE",
      "Test accounts can only work on courses they created.",
      409,
    );
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

  // Cost cap (read before taking the single-flight lock).
  const currentCost = await tenantGenerationDailyCostMicros(clubId, { prisma: db });
  const estimateMicros = 1_000_000; // $1.00 per generation run (worst-case estimate)
  const overCostCap = currentCost + estimateMicros > DEFAULT_DAILY_USD_MICROS;

  // EP-TRAIN-4Y-BF — single-flight. Under the per-version lock:
  //   1. retire abandoned runs (so a dead run cannot block forever);
  //   2. if ANY run is still live for this version, resolve to it;
  //   3. if this exact plan already completed, return that run;
  //   4. otherwise create the one new run.
  type Outcome =
    | { readonly kind: "ACTIVE"; readonly id: string; readonly state: GenerationState; readonly planIdentity: string | null }
    | { readonly kind: "COMPLETED"; readonly id: string }
    | { readonly kind: "COST_CAP" }
    | { readonly kind: "CREATED"; readonly id: string };
  let outcome: Outcome;
  try {
    outcome = await withGenerationSingleFlight(db, clubId, input.courseVersionId, async (tx): Promise<Outcome> => {
      await retireStalledGenerationRuns(
        { clubId, courseVersionId: input.courseVersionId },
        { prisma: tx },
      );
      const live = await tx.trainingQuestionAiGenerationRun.findFirst({
        where: {
          clubId,
          courseVersionId: input.courseVersionId,
          executionStatus: { in: [...LIVE_EXECUTION_STATES] },
        },
        orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
        select: { id: true, executionStatus: true, planIdentity: true },
      });
      if (live) {
        return {
          kind: "ACTIVE",
          id: live.id,
          state: live.executionStatus as GenerationState,
          planIdentity: live.planIdentity,
        };
      }
      const completed = await tx.trainingQuestionAiGenerationRun.findFirst({
        where: {
          clubId,
          courseVersionId: input.courseVersionId,
          resolvedTranscriptBuildId: plan.resolvedTranscriptBuildId,
          planIdentity: identity,
          executionStatus: "COMPLETED",
        },
        select: { id: true },
      });
      if (completed) return { kind: "COMPLETED", id: completed.id };
      if (overCostCap) return { kind: "COST_CAP" };
      const run = await tx.trainingQuestionAiGenerationRun.create({
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
      return { kind: "CREATED", id: run.id };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // The DB-boundary unique index caught a duplicate the lock could
      // not (for example a writer outside this service). Re-read the
      // winner and resolve to it.
      const winner = await db.trainingQuestionAiGenerationRun.findFirst({
        where: {
          clubId,
          courseVersionId: input.courseVersionId,
          executionStatus: { in: ["REQUESTED", "QUEUED", "RUNNING", "COMPLETED"] },
        },
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        select: { id: true, executionStatus: true, planIdentity: true },
      });
      if (winner) {
        return {
          ok: true,
          generationRunId: winner.id,
          state: winner.executionStatus as GenerationState,
          idempotent: true,
          planIdentity: winner.planIdentity ?? identity,
          resolvedToActiveRun: winner.executionStatus !== "COMPLETED",
        };
      }
    }
    throw err;
  }

  if (outcome.kind === "ACTIVE") {
    return {
      ok: true,
      generationRunId: outcome.id,
      state: outcome.state,
      idempotent: true,
      planIdentity: outcome.planIdentity ?? identity,
      resolvedToActiveRun: true,
    };
  }
  if (outcome.kind === "COMPLETED") {
    return {
      ok: true,
      generationRunId: outcome.id,
      state: "COMPLETED",
      idempotent: true,
      planIdentity: identity,
    };
  }
  if (outcome.kind === "COST_CAP") {
    throw new GenerationRejectedError(
      "COST_CAP_EXCEEDED",
      "Daily generation cost cap would be exceeded.",
      409,
      { currentCostMicros: currentCost, capMicros: DEFAULT_DAILY_USD_MICROS },
    );
  }
  void audit(principal, {
    action: "hr.training.generation.request",
    entityType: "TrainingQuestionAiGenerationRun",
    entityId: outcome.id,
    clubId,
    after: {
      courseVersionId: input.courseVersionId,
      planIdentity: identity,
      totalTargetQuestionCount: plan.totalTargetQuestionCount,
    },
  });
  return {
    ok: true,
    generationRunId: outcome.id,
    state: "REQUESTED",
    idempotent: false,
    planIdentity: identity,
  };
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
  opts: {
    prisma?: PrismaClient;
    now?: Date;
    leaseTtlMs?: number;
    /** EP-TRAIN-4Y-BF — claim exactly this run. A queue entry must only
     *  ever claim the run it was enqueued for; claiming "whatever is
     *  next" let one entry take another run's lease and then skip it,
     *  leaving that run leased and unprocessed until the lease expired. */
    runId?: string;
  } = {},
): Promise<GenerationClaimResult | null> {
  const db = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + (opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS));
  const leaseToken = newLeaseToken();

  const only = opts.runId ? { id: opts.runId } : {};
  const queuedCandidate = await db.trainingQuestionAiGenerationRun.findFirst({
    where: { ...only, executionStatus: "QUEUED", leaseToken: null },
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
      ...only,
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
  /** EP-TRAIN-4Y-Z §3 — accumulated Modal inference time for this
   *  attempt BEFORE the failure. Persisted so that the pilot-budget
   *  guard on a subsequent retry attempt can read the true prior cost.
   *  Omitting this (undefined) does NOT overwrite a previously
   *  persisted value — the field is only written when the caller
   *  passes a non-null number. */
  readonly inferenceMs?: number;
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
      // EP-TRAIN-4Y-Z §3 — persist partial inference cost on failure so
      // the pilot-budget guard on a retry attempt reads a truthful
      // prior-cost basis.
      ...(typeof input.inferenceMs === "number" && input.inferenceMs > 0
        ? { inferenceMs: input.inferenceMs }
        : {}),
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

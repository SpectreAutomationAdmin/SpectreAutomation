// EP-TRAIN-6D-4V (2026-11-06) — TrainingTranscriptionJob lifecycle service.
//
// The ONLY code path that may:
//   - create REQUESTED rows;
//   - transition QUEUED → RUNNING (claim with a bounded lease);
//   - transition RUNNING → COMPLETED (ingest-verified via 4L);
//   - transition * → FAILED or * → CANCELLED;
//   - reclaim RUNNING rows whose leases expired (stale-lease recovery).
//
// Founder-authorised on 2026-11-06 with eight requirements. See
// docs/training/ai-generation/PHASE-D-4V-TRANSCRIPTION-DESIGN.md.
//
// Design principles:
//   - No Modal call lives here. The worker handler owns outbound I/O.
//     This service owns DURABLE STATE + CONCURRENCY GUARANTEES.
//   - Every transition checks the current state inside the same
//     $transaction and refuses stale transitions.
//   - Cancellation safety (requirement 7): a worker handler that
//     tries to COMPLETE a CANCELLED row is REJECTED. No race window.
//   - Bounded retries (requirement 3): attempts >= maxAttempts
//     refuses re-queue and moves to FAILED.
//   - Cost cap (requirement 4): checked in requestTranscription at
//     acceptance time. DB-level only; the external Modal cap is
//     documented and NOT relied on.

import { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { hasPermission, type Principal } from "@/lib/rbac";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "@/lib/errors";
import { randomBytes } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────

export type JobState =
  | "REQUESTED"
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type JobFailureCode =
  | "MODAL_HTTP_ERROR"
  | "MODAL_TIMEOUT"
  | "MODAL_HMAC_INVALID"
  | "SHA_MISMATCH"
  | "INGEST_FAILED"
  | "CREDENTIAL_ABSENT"
  | "COST_CAP_EXCEEDED"
  | "INTEGRITY_FAILURE";

export type RequestRejectionCode =
  | "VERSION_NOT_FOUND"                       // 404 same-shape
  | "VERSION_NOT_DRAFT"                       // 409 — PUBLISHED/RETIRED
  | "VIDEO_MISSING"                           // 409 — no videoStorageKey
  | "VIDEO_SHA_UNRECORDED"                    // 409 — no videoSha256
  | "DUPLICATE_LIVE_JOB"                      // 409 — a non-terminal row already exists
  | "COST_CAP_EXCEEDED"                       // 409 — tenant daily cap
  | "CREDENTIAL_ABSENT";                      // 503 — Fly secrets missing

export class JobRejectedError extends AppError {
  readonly rejectionCode: RequestRejectionCode | "CLAIM_RACE" | "TERMINAL_STATE_WRITE";
  readonly detail: Record<string, unknown>;

  constructor(
    rejectionCode: RequestRejectionCode | "CLAIM_RACE" | "TERMINAL_STATE_WRITE",
    message: string,
    httpStatus: number,
    detail: Record<string, unknown> = {},
  ) {
    super(rejectionCode, message, httpStatus);
    this.rejectionCode = rejectionCode;
    this.detail = detail;
  }
}

export interface RequestTranscriptionInput {
  readonly courseVersionId: string;
}

export interface RequestTranscriptionResult {
  readonly ok: true;
  readonly jobId: string;
  readonly state: JobState;
  readonly idempotent: boolean;                // true if returning an existing live row
}

// ─── Credential + cost governance ───────────────────────────────────

/**
 * Fail-closed credential check (founder requirement 4). Reads two Fly
 * secrets at call time. Service NEVER returns the values — only
 * whether they exist.
 */
export function modalCredentialsPresent(opts: { env?: NodeJS.ProcessEnv } = {}): boolean {
  const env = opts.env ?? process.env;
  return typeof env.MODAL_TRANSCRIBE_URL === "string" &&
    env.MODAL_TRANSCRIBE_URL.length > 0 &&
    typeof env.MODAL_SPECTRE_SHARED_TOKEN === "string" &&
    env.MODAL_SPECTRE_SHARED_TOKEN.length > 0;
}

export const DEFAULT_DAILY_USD_MICROS = 10 * 1_000_000; // $10 × 1e6

/**
 * Per-tenant daily cost rollup. Returns the micros already
 * consumed by COMPLETED jobs in the last 24 hours. The service
 * refuses a new REQUESTED job when `current + plannedEstimate >
 * cap`. The external Modal account cap ($10) is enforced separately
 * at the Modal side; this is defence in depth (requirement 4).
 */
export async function tenantDailyCostMicros(
  clubId: string,
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<number> {
  const db = opts.prisma ?? defaultPrisma;
  const since = new Date((opts.now ?? new Date()).getTime() - 24 * 3600 * 1000);
  const r = await db.trainingTranscriptionJob.aggregate({
    where: {
      clubId,
      state: "COMPLETED",
      completedAt: { gte: since },
    },
    _sum: { estimatedCostUsdMicros: true },
  });
  return r._sum.estimatedCostUsdMicros ?? 0;
}

/**
 * Per-job wall-clock cap enforced by the worker handler via
 * AbortController. Not persisted; configuration-only.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

/** Bounded lease TTL. A worker that holds a lease has this long to
 *  complete the job before the sweeper may reclaim it. */
export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000; // 15 min (> job timeout)

// ─── Service functions ──────────────────────────────────────────────

/**
 * Create a new REQUESTED job, or return an existing live row for the
 * same (clubId, courseVersionId, sourceVideoSha256).
 *
 * The @@unique([clubId, courseVersionId, sourceVideoSha256, state])
 * constraint lets the service return a cached row atomically — a
 * concurrent duplicate request collides at the DB layer and the
 * retry sees the winner's row (requirement 2 + 3).
 *
 * If the tenant daily cost cap would be exceeded, the service
 * transitions directly to CANCELLED with code COST_CAP_EXCEEDED.
 */
export async function requestTranscription(
  principal: Principal | null,
  clubId: string,
  input: RequestTranscriptionInput,
  opts: { prisma?: PrismaClient } = {},
): Promise<RequestTranscriptionResult> {
  if (!principal) throw new UnauthenticatedError();
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    throw new ForbiddenError("hr:training:write required");
  }

  const db = opts.prisma ?? defaultPrisma;

  // Load the version + verify tenant + DRAFT state + video presence.
  const version = await db.trainingCourseVersion.findUnique({
    where: { id: input.courseVersionId },
    select: {
      id: true, state: true,
      videoStorageKey: true, videoSha256: true,
      course: { select: { clubId: true } },
    },
  });
  if (!version || version.course.clubId !== clubId) {
    throw new JobRejectedError("VERSION_NOT_FOUND", "Version not found.", 404);
  }
  if (version.state !== "DRAFT") {
    throw new JobRejectedError(
      "VERSION_NOT_DRAFT",
      `Cannot transcribe a ${version.state} course version. Open a new draft first.`,
      409,
      { versionState: version.state },
    );
  }
  if (!version.videoStorageKey) {
    throw new JobRejectedError("VIDEO_MISSING", "No video uploaded for this version.", 409);
  }
  if (!version.videoSha256) {
    throw new JobRejectedError(
      "VIDEO_SHA_UNRECORDED",
      "Video is uploaded but its SHA-256 is not persisted. Re-upload the video.",
      409,
    );
  }

  // Credential precheck (requirement 4) — fail-closed BEFORE creating
  // a REQUESTED row that would never run.
  if (!modalCredentialsPresent()) {
    throw new JobRejectedError(
      "CREDENTIAL_ABSENT",
      "Transcription provider credentials are not configured. Contact support.",
      503,
    );
  }

  const sourceVideoSha256 = version.videoSha256;

  // Idempotent-request lookup: any non-terminal row for this video.
  const existing = await db.trainingTranscriptionJob.findFirst({
    where: {
      clubId,
      courseVersionId: input.courseVersionId,
      sourceVideoSha256,
      state: { in: ["REQUESTED", "QUEUED", "RUNNING", "COMPLETED"] },
    },
    select: { id: true, state: true },
  });
  if (existing) {
    return {
      ok: true,
      jobId: existing.id,
      state: existing.state as JobState,
      idempotent: true,
    };
  }

  // Cost cap check (requirement 4).
  const current = await tenantDailyCostMicros(clubId, { prisma: db });
  // Estimate conservatively: default to 1 hour of L40S time at $1.95/hr.
  // The actual cost is refined at COMPLETED time.
  const plannedEstimateMicros = 1_950_000; // $1.95
  if (current + plannedEstimateMicros > DEFAULT_DAILY_USD_MICROS) {
    // Create a CANCELLED row so the admin UI can surface the refusal.
    const cancelled = await db.trainingTranscriptionJob.create({
      data: {
        clubId,
        courseVersionId: input.courseVersionId,
        sourceVideoSha256,
        state: "CANCELLED",
        cancelledAt: new Date(),
        failureCode: "COST_CAP_EXCEEDED",
        failureMessage: "Daily cost cap would be exceeded.",
        requestedByUserId: principal.id,
        cancelledByUserId: principal.id,
      },
      select: { id: true },
    });
    throw new JobRejectedError(
      "COST_CAP_EXCEEDED",
      "Daily transcription cost cap exceeded.",
      409,
      { jobId: cancelled.id, dailyCostMicros: current, capMicros: DEFAULT_DAILY_USD_MICROS },
    );
  }

  // Create the REQUESTED row. P2002 on the @@unique index means a
  // concurrent request won; retry-read the winner.
  try {
    const job = await db.trainingTranscriptionJob.create({
      data: {
        clubId,
        courseVersionId: input.courseVersionId,
        sourceVideoSha256,
        state: "REQUESTED",
        requestedByUserId: principal.id,
      },
      select: { id: true, state: true },
    });
    void audit(principal, {
      action: "hr.training.transcription.request",
      entityType: "TrainingTranscriptionJob",
      entityId: job.id,
      clubId,
      after: { courseVersionId: input.courseVersionId, sourceVideoSha256 },
    });
    return { ok: true, jobId: job.id, state: "REQUESTED", idempotent: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Lost the race; re-read the winner.
      const winner = await db.trainingTranscriptionJob.findFirst({
        where: {
          clubId,
          courseVersionId: input.courseVersionId,
          sourceVideoSha256,
          state: { in: ["REQUESTED", "QUEUED", "RUNNING", "COMPLETED"] },
        },
        select: { id: true, state: true },
      });
      if (winner) {
        return { ok: true, jobId: winner.id, state: winner.state as JobState, idempotent: true };
      }
    }
    throw err;
  }
}

/** Issued by the admin route after `requestTranscription` succeeds.
 *  Writes queuedAt and (for a real deployment) enqueues the job onto
 *  the Spectre queue. 4V keeps the enqueue a separate concern so the
 *  worker handler can stay pure.
 *
 *  Refuses if state is not REQUESTED (cancellation race). */
export async function markQueued(
  clubId: string,
  jobId: string,
  opts: { prisma?: PrismaClient } = {},
): Promise<void> {
  const db = opts.prisma ?? defaultPrisma;
  const n = await db.trainingTranscriptionJob.updateMany({
    where: { id: jobId, clubId, state: "REQUESTED" },
    data: { state: "QUEUED", queuedAt: new Date() },
  });
  if (n.count === 0) {
    throw new JobRejectedError(
      "CLAIM_RACE",
      "Job is not REQUESTED (already queued, cancelled, or does not exist).",
      409,
    );
  }
}

// ─── Lease + claim ──────────────────────────────────────────────────

function newLeaseToken(): string {
  return randomBytes(16).toString("hex");
}

export interface ClaimResult {
  readonly ok: true;
  readonly jobId: string;
  readonly attempt: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly sourceVideoSha256: string;
  readonly courseVersionId: string;
  readonly clubId: string;
}

/**
 * Worker-side atomic claim. Transitions QUEUED → RUNNING with a
 * bounded lease. Returns null when no eligible job is available.
 *
 * Claim semantics (requirement 3):
 *   - Prefer QUEUED jobs where leaseToken IS NULL.
 *   - Fallback: RUNNING jobs whose leaseExpiresAt < now (stale lease
 *     recovery). Increments attempts for the reclaim.
 *   - Refuses when attempts >= maxAttempts; flips the row to FAILED.
 */
export async function claimNextTranscriptionJob(
  opts: { prisma?: PrismaClient; now?: Date; leaseTtlMs?: number } = {},
): Promise<ClaimResult | null> {
  const db = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + (opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS));
  const leaseToken = newLeaseToken();

  // Path 1: a QUEUED job waiting to be claimed.
  const queuedCandidate = await db.trainingTranscriptionJob.findFirst({
    where: { state: "QUEUED", leaseToken: null },
    orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
    select: { id: true, attempts: true, maxAttempts: true, sourceVideoSha256: true, courseVersionId: true, clubId: true },
  });
  if (queuedCandidate) {
    // Atomic transition.
    const upd = await db.trainingTranscriptionJob.updateMany({
      where: { id: queuedCandidate.id, state: "QUEUED", leaseToken: null },
      data: {
        state: "RUNNING",
        startedAt: now,
        leaseToken,
        leaseExpiresAt,
        attempts: { increment: 1 },
      },
    });
    if (upd.count === 1) {
      return {
        ok: true,
        jobId: queuedCandidate.id,
        attempt: queuedCandidate.attempts + 1,
        leaseToken,
        leaseExpiresAt,
        sourceVideoSha256: queuedCandidate.sourceVideoSha256,
        courseVersionId: queuedCandidate.courseVersionId,
        clubId: queuedCandidate.clubId,
      };
    }
    // Lost the race; fall through.
  }

  // Path 2: a RUNNING job whose lease expired (stale-lease recovery).
  const staleCandidate = await db.trainingTranscriptionJob.findFirst({
    where: {
      state: "RUNNING",
      leaseExpiresAt: { lt: now },
    },
    orderBy: [{ leaseExpiresAt: "asc" }, { id: "asc" }],
    select: { id: true, attempts: true, maxAttempts: true, sourceVideoSha256: true, courseVersionId: true, clubId: true },
  });
  if (!staleCandidate) return null;

  // Refuse to reclaim if attempts would exceed the budget.
  if (staleCandidate.attempts >= staleCandidate.maxAttempts) {
    await db.trainingTranscriptionJob.updateMany({
      where: { id: staleCandidate.id, state: "RUNNING" },
      data: {
        state: "FAILED",
        failureCode: "MODAL_TIMEOUT",
        failureMessage: "Job exceeded maxAttempts after a stale-lease reclaim.",
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: now,
      },
    });
    return null;
  }

  const upd = await db.trainingTranscriptionJob.updateMany({
    where: { id: staleCandidate.id, state: "RUNNING" },
    data: {
      leaseToken,
      leaseExpiresAt,
      attempts: { increment: 1 },
    },
  });
  if (upd.count === 1) {
    return {
      ok: true,
      jobId: staleCandidate.id,
      attempt: staleCandidate.attempts + 1,
      leaseToken,
      leaseExpiresAt,
      sourceVideoSha256: staleCandidate.sourceVideoSha256,
      courseVersionId: staleCandidate.courseVersionId,
      clubId: staleCandidate.clubId,
    };
  }
  return null;
}

// ─── Success + failure terminals ────────────────────────────────────

export interface CompleteSuccessInput {
  readonly jobId: string;
  readonly leaseToken: string;
  readonly resolvedTranscriptBuildId: string; // the 4L-persisted build row
  readonly modelVariant: string;
  readonly elapsedMsTotal: number;
  readonly elapsedMsColdBoot: number;
  readonly elapsedMsTranscribe: number;
  readonly estimatedCostUsdMicros: number;
}

/**
 * Worker-side: transition RUNNING → COMPLETED. Refuses if the row is
 * NOT in RUNNING state (cancellation safety per requirement 7), or if
 * the lease token doesn't match (stolen lease).
 *
 * The caller MUST have already successfully called the 4L ingest
 * services + verified integrity + obtained `resolvedTranscriptBuildId`.
 * This service DOES NOT re-verify — it's the terminal pointer write.
 */
export async function recordJobCompleted(
  input: CompleteSuccessInput,
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<void> {
  const db = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const upd = await db.trainingTranscriptionJob.updateMany({
    where: {
      id: input.jobId,
      state: "RUNNING",
      leaseToken: input.leaseToken,
    },
    data: {
      state: "COMPLETED",
      completedAt: now,
      resolvedTranscriptBuildId: input.resolvedTranscriptBuildId,
      modelVariant: input.modelVariant,
      elapsedMsTotal: input.elapsedMsTotal,
      elapsedMsColdBoot: input.elapsedMsColdBoot,
      elapsedMsTranscribe: input.elapsedMsTranscribe,
      estimatedCostUsdMicros: input.estimatedCostUsdMicros,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (upd.count === 0) {
    throw new JobRejectedError(
      "TERMINAL_STATE_WRITE",
      "Cannot complete job: row is not RUNNING with the expected lease (cancelled, reclaimed, or stolen).",
      409,
    );
  }
}

export interface FailJobInput {
  readonly jobId: string;
  readonly leaseToken: string;
  readonly failureCode: JobFailureCode;
  readonly failureMessage: string;
  /** When true, decrement-remaining attempts and put back to QUEUED;
   *  when false (default), terminal FAILED. */
  readonly retryable?: boolean;
}

/**
 * Worker-side: transition RUNNING → FAILED (or back to QUEUED if
 * retryable AND attempts < maxAttempts). Refuses on
 * cancellation-race (state != RUNNING OR lease mismatch).
 */
export async function recordJobFailed(
  input: FailJobInput,
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<{ finalState: "FAILED" | "QUEUED" }> {
  const db = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();

  // Load attempts + maxAttempts (we need these for retryable branching).
  const row = await db.trainingTranscriptionJob.findFirst({
    where: { id: input.jobId, state: "RUNNING", leaseToken: input.leaseToken },
    select: { attempts: true, maxAttempts: true },
  });
  if (!row) {
    throw new JobRejectedError(
      "TERMINAL_STATE_WRITE",
      "Cannot mark job failed: row is not RUNNING with the expected lease.",
      409,
    );
  }

  const canRetry = (input.retryable ?? false) && row.attempts < row.maxAttempts;
  const nextState: "FAILED" | "QUEUED" = canRetry ? "QUEUED" : "FAILED";

  const upd = await db.trainingTranscriptionJob.updateMany({
    where: { id: input.jobId, state: "RUNNING", leaseToken: input.leaseToken },
    data: {
      state: nextState,
      failureCode: input.failureCode,
      failureMessage: input.failureMessage,
      leaseToken: null,
      leaseExpiresAt: null,
      // On canRetry: wipe startedAt so the next claim shows a fresh
      // run. On terminal: write completedAt to lock the row.
      ...(canRetry
        ? { startedAt: null, queuedAt: now }
        : { completedAt: now }),
    },
  });
  if (upd.count === 0) {
    throw new JobRejectedError(
      "TERMINAL_STATE_WRITE",
      "Cannot mark job failed: row state changed under us.",
      409,
    );
  }
  return { finalState: nextState };
}

/**
 * Operator-side cancellation. Admin principals can cancel any job
 * they own; moves REQUESTED/QUEUED/RUNNING → CANCELLED. Idempotent
 * on CANCELLED. Refuses once COMPLETED or FAILED (terminal rows
 * cannot be rewritten per requirement 7's immutability principle).
 */
export async function cancelTranscriptionJob(
  principal: Principal,
  clubId: string,
  jobId: string,
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<{ state: JobState }> {
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    throw new ForbiddenError("hr:training:write required");
  }
  const db = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();
  // Idempotency: already CANCELLED returns OK.
  const existing = await db.trainingTranscriptionJob.findFirst({
    where: { id: jobId, clubId },
    select: { state: true },
  });
  if (!existing) {
    throw new NotFoundError("TrainingTranscriptionJob", jobId);
  }
  if (existing.state === "CANCELLED") {
    return { state: "CANCELLED" };
  }
  if (existing.state === "COMPLETED" || existing.state === "FAILED") {
    throw new JobRejectedError(
      "TERMINAL_STATE_WRITE",
      `Cannot cancel job in terminal state ${existing.state}.`,
      409,
      { state: existing.state },
    );
  }
  const upd = await db.trainingTranscriptionJob.updateMany({
    where: { id: jobId, clubId, state: { in: ["REQUESTED", "QUEUED", "RUNNING"] } },
    data: {
      state: "CANCELLED",
      cancelledAt: now,
      cancelledByUserId: principal.id,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (upd.count === 0) {
    // Lost a race; reread + treat appropriately.
    const current = await db.trainingTranscriptionJob.findUnique({
      where: { id: jobId },
      select: { state: true },
    });
    return { state: (current?.state ?? "FAILED") as JobState };
  }
  void audit(principal, {
    action: "hr.training.transcription.cancel",
    entityType: "TrainingTranscriptionJob",
    entityId: jobId,
    clubId,
    after: { previousState: existing.state },
  });
  return { state: "CANCELLED" };
}

/**
 * Sweep stale leases. The worker binary calls this periodically to
 * reclaim RUNNING rows whose leases expired without a completion
 * signal. Returns the count of rows reclaimed OR failed.
 */
export async function sweepStaleLeases(
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<{ reclaimed: number; exhausted: number }> {
  const db = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const stale = await db.trainingTranscriptionJob.findMany({
    where: { state: "RUNNING", leaseExpiresAt: { lt: now } },
    select: { id: true, attempts: true, maxAttempts: true },
  });
  let reclaimed = 0;
  let exhausted = 0;
  for (const row of stale) {
    if (row.attempts >= row.maxAttempts) {
      await db.trainingTranscriptionJob.updateMany({
        where: { id: row.id, state: "RUNNING" },
        data: {
          state: "FAILED",
          failureCode: "MODAL_TIMEOUT",
          failureMessage: "Stale lease + attempts exhausted.",
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: now,
        },
      });
      exhausted++;
    } else {
      const upd = await db.trainingTranscriptionJob.updateMany({
        where: { id: row.id, state: "RUNNING" },
        data: {
          state: "QUEUED",
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

// ─── Transcript quality heuristics ──────────────────────────────────

export interface TranscriptSegmentInput {
  readonly segmentIndex: number;
  readonly text: string;
  readonly startSec: number;
  readonly endSec: number;
}

export interface TranscriptQualityReport {
  readonly ok: boolean;
  readonly reasons: readonly string[];        // reviewer-facing list
  readonly perSegmentFlags: readonly {
    readonly segmentIndex: number;
    readonly flags: readonly string[];
  }[];
}

const HALLUCINATION_TEMPLATES = [
  "thanks for watching",
  "please subscribe",
  "like and subscribe",
  "see you next time",
  "see you in the next video",
];

/**
 * Pure (no DB, no network) heuristics (requirement from directive §7).
 * Called by the worker handler AFTER Modal returns + BEFORE 4L
 * persistence to attach per-segment flags. Never discards segments —
 * only flags them.
 */
export function analyseTranscriptQuality(
  segments: readonly TranscriptSegmentInput[],
  videoDurationSec: number | null,
): TranscriptQualityReport {
  const reasons: string[] = [];
  const perSegmentFlags: { segmentIndex: number; flags: string[] }[] = segments.map((s) => ({
    segmentIndex: s.segmentIndex,
    flags: [] as string[],
  }));
  const idx = new Map(perSegmentFlags.map((p) => [p.segmentIndex, p]));

  // Empty / incomplete.
  if (segments.length === 0) {
    reasons.push("EMPTY_TRANSCRIPT");
  }
  if (videoDurationSec && segments.length > 0) {
    const lastEnd = Math.max(...segments.map((s) => s.endSec));
    if (lastEnd / videoDurationSec < 0.5) {
      reasons.push("INCOMPLETE_TRANSCRIPT_COVERAGE");
    }
  }

  // Timestamp anomalies.
  for (const s of segments) {
    if (!(s.startSec >= 0 && s.endSec >= s.startSec)) {
      idx.get(s.segmentIndex)!.flags.push("TIMESTAMP_ANOMALY");
    }
    if (videoDurationSec !== null && s.startSec > videoDurationSec + 1) {
      idx.get(s.segmentIndex)!.flags.push("TIMESTAMP_PAST_VIDEO_END");
    }
  }

  // Overlap check.
  const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startSec < sorted[i - 1].endSec - 0.01) {
      idx.get(sorted[i].segmentIndex)!.flags.push("TIMESTAMP_OVERLAP");
    }
  }

  // Repetition: three or more contiguous segments with jaccard(prev)>0.9.
  function jaccard(a: string, b: string): number {
    const aw = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
    const bw = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
    if (aw.size === 0 && bw.size === 0) return 1;
    let inter = 0;
    for (const w of aw) if (bw.has(w)) inter++;
    return inter / (aw.size + bw.size - inter || 1);
  }
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (jaccard(sorted[i - 1].text, sorted[i].text) > 0.9) {
      run++;
      if (run >= 3) {
        idx.get(sorted[i].segmentIndex)!.flags.push("REPETITION_ARTIFACT");
      }
    } else {
      run = 1;
    }
  }

  // Hallucination templates.
  for (const s of segments) {
    const low = s.text.toLowerCase();
    for (const t of HALLUCINATION_TEMPLATES) {
      if (low.includes(t)) {
        idx.get(s.segmentIndex)!.flags.push("HALLUCINATION_TEMPLATE");
        break;
      }
    }
  }

  // Source-org pending review marker — can't be computed here without
  // the authoring club's org name. Mark every segment so projection-
  // time logic can lift it (requirement + 4V §7).
  for (const p of perSegmentFlags) {
    p.flags.push("SOURCE_ORG_PENDING_REVIEW");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    perSegmentFlags,
  };
}

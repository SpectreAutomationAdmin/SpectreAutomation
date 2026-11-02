// EP-TRAIN-5C-2 (2026-11-02) — Obligation-scoped training session helper.
//
// Server-side orchestrator for the player + completion write paths.
// Only consulted when an OUTSTANDING TrainingObligation exists for
// the (employee × courseVersion); when no obligation is active, the
// legacy pre-5C-2 path runs unchanged (preserving EP-TRAIN-4E
// completed-course replay).
//
// Responsibilities:
//
//   1. resolveActiveObligationForSession — pick the FIFO-oldest
//      OUTSTANDING obligation on (employee × courseVersion).  Secondary
//      sort by id so two obligations issued in the same ms resolve
//      deterministically.
//   2. upsertObligationScopedProgress — manual find-first + update-or-
//      create keyed by (employeeId, courseVersionId, obligationId).
//      Legacy path (obligationId === null) finds the singleton row.
//   3. completeAndSatisfyAtomic — prisma.$transaction: create
//      TrainingCompletion + satisfyObligationWithCompletion.  Rolls
//      back any partial state on failure.  Idempotency guard: the
//      attempt's existing completion (attemptId @unique) is returned
//      unchanged on retry.
//
// Not consulted by any UI, API route, or legacy resolver yet.
// Exported for 5C-2's attempt-flow rewiring + contract tests + the
// eventual 5C-3 player integration.

import type { Prisma } from "@prisma/client";
import { prisma } from "../../prisma";
import { ConflictError, ValidationError } from "../../errors";
import { satisfyObligationWithCompletion } from "./obligations";

type TxLike = Prisma.TransactionClient | typeof prisma;

export interface ActiveObligation {
  id: string;
  reason: "INITIAL" | "REVISION" | "MANUAL_REINSTATE" | "RECERTIFICATION";
  issuedAt: Date;
  dueAt: Date | null;
  reasonNote: string | null;
}

/** EP-TRAIN-5C-2 — pick the FIFO-oldest OUTSTANDING obligation for
 *  (employee × courseVersion).  Deterministic secondary sort by `id`
 *  (cuid is monotonic + stable).  Null when no obligation exists.
 *
 *  The resolver is tenant-scoped by courseVersionId: the obligation
 *  must share the courseVersion's clubId, which is enforced by the
 *  obligation table's FK + the courseVersion lookup. */
export async function resolveActiveObligationForSession(args: {
  employeeId: string;
  courseVersionId: string;
  tx?: TxLike;
}): Promise<ActiveObligation | null> {
  const client = args.tx ?? prisma;
  const row = await client.trainingObligation.findFirst({
    where: {
      employeeId: args.employeeId,
      courseVersionId: args.courseVersionId,
      status: "OUTSTANDING",
    },
    orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
    select: { id: true, reason: true, issuedAt: true, dueAt: true, reasonNote: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    reason: row.reason as ActiveObligation["reason"],
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    reasonNote: row.reasonNote,
  };
}

interface ObligationScopedProgressRow {
  id: string;
  secondsWatched: number;
  farthestSecond: number;
  percentComplete: number;
  checkpointClearedJson: string | null;
  obligationId: string | null;
}

/** EP-TRAIN-5C-2 — upsert the correct progress row for the current
 *  session.  obligationId === null routes to the legacy singleton
 *  row (preserved by the DB-level partial UNIQUE WHERE obligationId
 *  IS NULL).  A non-null obligationId routes to the obligation-scoped
 *  row (per-obligation partial UNIQUE).  Monotonic — the caller
 *  passes the "next" values; the helper refuses regressions. */
export async function upsertObligationScopedProgress(args: {
  clubId: string;
  employeeId: string;
  courseVersionId: string;
  obligationId: string | null;
  nextSecondsWatched: number;
  nextFarthestSecond: number;
  nextPercentComplete: number;
  nextCheckpointClearedJson?: string | null;
  tx?: TxLike;
}): Promise<ObligationScopedProgressRow> {
  const client = args.tx ?? prisma;
  // Partial unique indexes don't give us Prisma.upsert; use manual
  // find-first + conditional create / update.
  const existing = await client.trainingProgress.findFirst({
    where: {
      employeeId: args.employeeId,
      courseVersionId: args.courseVersionId,
      obligationId: args.obligationId, // includes NULL
    },
  });
  if (existing) {
    // Monotonic refuse-regress on cumulative counters.
    const nextSeconds = Math.max(args.nextSecondsWatched, existing.secondsWatched);
    const nextFarthest = Math.max(args.nextFarthestSecond, existing.farthestSecond);
    const nextPct = Math.max(args.nextPercentComplete, existing.percentComplete);
    const updated = await client.trainingProgress.update({
      where: { id: existing.id },
      data: {
        secondsWatched: nextSeconds,
        farthestSecond: nextFarthest,
        percentComplete: nextPct,
        ...(args.nextCheckpointClearedJson !== undefined
          ? { checkpointClearedJson: args.nextCheckpointClearedJson }
          : {}),
      },
    });
    return {
      id: updated.id,
      secondsWatched: updated.secondsWatched,
      farthestSecond: updated.farthestSecond,
      percentComplete: updated.percentComplete,
      checkpointClearedJson: updated.checkpointClearedJson,
      obligationId: updated.obligationId,
    };
  }
  const created = await client.trainingProgress.create({
    data: {
      clubId: args.clubId,
      employeeId: args.employeeId,
      courseVersionId: args.courseVersionId,
      obligationId: args.obligationId,
      secondsWatched: args.nextSecondsWatched,
      farthestSecond: args.nextFarthestSecond,
      percentComplete: args.nextPercentComplete,
      checkpointClearedJson: args.nextCheckpointClearedJson ?? null,
    },
  });
  return {
    id: created.id,
    secondsWatched: created.secondsWatched,
    farthestSecond: created.farthestSecond,
    percentComplete: created.percentComplete,
    checkpointClearedJson: created.checkpointClearedJson,
    obligationId: created.obligationId,
  };
}

export interface CompleteAndSatisfyArgs {
  clubId: string;
  employeeId: string;
  courseId: string;
  courseVersionId: string;
  attemptId: string;
  score: number;
  /** The active obligation to satisfy (nullable — a legacy session
   *  completes without satisfying any obligation).  When set, the
   *  obligation MUST be OUTSTANDING at tx-start; the helper rolls
   *  back if the obligation has moved to a terminal status. */
  activeObligationId: string | null;
}

export interface CompleteAndSatisfyResult {
  completionId: string;
  createdCompletion: boolean;
  satisfiedObligationId: string | null;
}

/** EP-TRAIN-5C-2 — atomic completion + obligation satisfaction.
 *
 *  Within one `prisma.$transaction`:
 *    1. Idempotency: if a TrainingCompletion already exists for this
 *       `attemptId` (per @unique guard), return it unchanged.  Do NOT
 *       re-satisfy any obligation.
 *    2. Create the TrainingCompletion.
 *    3. If activeObligationId is set, call
 *       satisfyObligationWithCompletion — the helper verifies the
 *       obligation is OUTSTANDING + verifies invariants 2/3/4 from
 *       EP-TRAIN-5A-1 (one completion satisfies at most one; old
 *       completion cannot auto-satisfy later obligation; subject
 *       match).  If the obligation has gone terminal mid-flight the
 *       whole tx rolls back — no orphaned completion.
 */
export async function completeAndSatisfyAtomic(
  args: CompleteAndSatisfyArgs,
): Promise<CompleteAndSatisfyResult> {
  if (!Number.isInteger(args.score) || args.score < 0 || args.score > 100) {
    throw new ValidationError([{ path: "score", message: "score must be an integer in [0, 100]" }]);
  }
  return prisma.$transaction(async (tx) => {
    const existing = await tx.trainingCompletion.findUnique({
      where: { attemptId: args.attemptId },
    });
    if (existing) {
      // Already written on a prior successful call.  Do not create
      // a second completion.  Do not re-satisfy any obligation; the
      // first call already handled it (and the obligation-level
      // UNIQUE on satisfiedByCompletionId would reject a double-link
      // regardless).
      return {
        completionId: existing.id,
        createdCompletion: false,
        satisfiedObligationId: null,
      };
    }
    // Defense-in-depth: attempt must belong to this (clubId, employeeId,
    // courseVersionId) subject.  Prevents a browser-smuggled attemptId
    // from a different employee from being used to post a completion
    // against this employee's authenticated session.
    const attempt = await tx.trainingAttempt.findUnique({
      where: { id: args.attemptId },
      select: { clubId: true, employeeId: true, courseVersionId: true, courseVersion: { select: { courseId: true } } },
    });
    if (!attempt) throw new ConflictError(`TrainingAttempt ${args.attemptId} not found`);
    if (attempt.clubId !== args.clubId
        || attempt.employeeId !== args.employeeId
        || attempt.courseVersionId !== args.courseVersionId
        || attempt.courseVersion.courseId !== args.courseId) {
      throw new ValidationError([{
        path: "attemptId",
        message: "attempt does not match the authenticated subject",
      }]);
    }
    const completion = await tx.trainingCompletion.create({
      data: {
        clubId: args.clubId,
        employeeId: args.employeeId,
        courseId: args.courseId,
        courseVersionId: args.courseVersionId,
        attemptId: args.attemptId,
        score: args.score,
      },
    });
    let satisfiedObligationId: string | null = null;
    if (args.activeObligationId) {
      await satisfyObligationWithCompletion({
        obligationId: args.activeObligationId,
        completionId: completion.id,
        tx,
      });
      satisfiedObligationId = args.activeObligationId;
    }
    return {
      completionId: completion.id,
      createdCompletion: true,
      satisfiedObligationId,
    };
  });
}

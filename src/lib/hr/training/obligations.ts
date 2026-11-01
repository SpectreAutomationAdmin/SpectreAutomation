// EP-TRAIN-5A (2026-11-01) — Training obligation service (DORMANT).
//
// This module is the single write-side authority on TrainingObligation
// state transitions.  It is deployed in EP-TRAIN-5A but NOT YET
// CONSULTED by any UI, API route, or resolver.  5B wires the
// manager-side flows (revision publication + manual reinstatement)
// against these helpers; 5C swaps the employee-facing resolver /
// dashboard / player off the old "completion-row-equals-done"
// derivation and onto this authoritative model.
//
// All helpers are strict about:
//   - tenant isolation (every write accepts a `clubId` and refuses to
//     cross it; the API-layer caller is still expected to run
//     requirePermission + assertTenantOwned before invoking)
//   - idempotency (invariant 1 + invariant 3 are both enforced below)
//   - immutability of history (SATISFIED / CANCELED / SUPERSEDED
//     obligations are never re-opened; another obligation is issued
//     instead when a new event occurs)
//
// Reasons:
//   INITIAL          — the course first becomes applicable to this
//                      employee (future 5C work issues this; 5A does
//                      not create any INITIAL rows itself)
//   REVISION         — Option B/C publish of a new version requires
//                      this employee to complete the new version
//   MANUAL_REINSTATE — a manager asked this employee to retake the
//                      same version
//   RECERTIFICATION  — reserved for future recurring work; no issuer
//                      exists in 5A
//
// Statuses: OUTSTANDING → (SATISFIED | CANCELED | SUPERSEDED).
// Terminal statuses are frozen.

import type { Prisma } from "@prisma/client";
import { prisma } from "../../prisma";
import { NotFoundError, ValidationError } from "../../errors";

export type ObligationReason =
  | "INITIAL"
  | "REVISION"
  | "MANUAL_REINSTATE"
  | "RECERTIFICATION";

export type ObligationStatus =
  | "OUTSTANDING"
  | "SATISFIED"
  | "CANCELED"
  | "SUPERSEDED";

const TERMINAL_STATUSES: readonly ObligationStatus[] = [
  "SATISFIED",
  "CANCELED",
  "SUPERSEDED",
];

/** Public shape used by the (future) resolver. */
export interface ObligationRecord {
  id: string;
  clubId: string;
  employeeId: string;
  courseId: string;
  courseVersionId: string;
  reason: ObligationReason;
  reasonNote: string | null;
  issuedByUserId: string | null;
  issuedAt: Date;
  dueAt: Date | null;
  status: ObligationStatus;
  satisfiedByCompletionId: string | null;
  satisfiedAt: Date | null;
  supersededByObligationId: string | null;
}

type TxLike = Prisma.TransactionClient | typeof prisma;

/** EP-TRAIN-5A-1 helper: compose a conventional MANUAL_REINSTATE
 *  issuance key from a stable retake-request id.  Callers that
 *  already have their own event id (e.g. a server-generated cuid
 *  for the manager's Require-Retake confirmation) should pass that
 *  directly instead of composing in client code.  Keeping the
 *  shape convention centralised here so a future audit can
 *  pattern-match. */
export function composeIssuanceKey(reason: ObligationReason, eventId: string): string {
  const prefix: Record<ObligationReason, string> = {
    INITIAL: "init",
    REVISION: "rev",
    MANUAL_REINSTATE: "rtk",
    RECERTIFICATION: "rec",
  };
  return `${prefix[reason]}:${eventId}`;
}

/**
 * Idempotently issue an obligation keyed by a caller-supplied
 * `issuanceKey` representing ONE authorized event.
 *
 * EP-TRAIN-5A-1 (2026-11-01) — identity model:
 *
 *   - The composite UNIQUE
 *     (clubId, employeeId, courseVersionId, reason, issuanceKey)
 *     is the sole idempotency guard.  A repeat call with the SAME
 *     `issuanceKey` returns the existing row unchanged.  Different
 *     keys produce distinct rows that may coexist OUTSTANDING.
 *
 *   - The CALLER owns issuanceKey assignment:
 *       * one key per publish-with-retake confirmation ⇒ idempotent
 *         against publish-button double-click / network retry;
 *       * one key per Require-Retake form submission ⇒ idempotent
 *         against form-resubmit;
 *       * two separate authorized manager actions ⇒ two separate
 *         keys ⇒ two coexisting OUTSTANDING rows.
 *
 *   - A completion satisfies the OLDEST OUTSTANDING obligation first
 *     (FIFO by issuedAt); see the resolver policy table in
 *     docs/ep-train-5a1-completion-and-issuance.md §4.
 *
 * The caller is expected to have already:
 *   - checked the principal's `hr:training:write` permission on clubId
 *   - loaded the (courseId, courseVersionId) pair
 *   - run `assertTenantOwned` on the course
 *
 * We re-validate (course ↔ version) + (course ↔ club) here as
 * defense in depth because this helper is also invoked from scripts
 * (the backfill) that have no principal.
 */
export async function issueObligation(args: {
  clubId: string;
  employeeId: string;
  courseId: string;
  courseVersionId: string;
  reason: ObligationReason;
  /** EP-TRAIN-5A-1 (required) — stable per-authorized-event identifier.
   *  Pass the SAME value on retry to get idempotency; pass a DIFFERENT
   *  value to create a second coexisting obligation. */
  issuanceKey: string;
  reasonNote?: string | null;
  issuedByUserId: string | null;
  dueAt?: Date | null;
  issuedAt?: Date;
  tx?: TxLike;
}): Promise<ObligationRecord> {
  const client = args.tx ?? prisma;
  if (!args.issuanceKey || args.issuanceKey.trim() === "") {
    throw new ValidationError([
      { path: "issuanceKey", message: "issuanceKey is required (EP-TRAIN-5A-1)" },
    ]);
  }
  // Defense-in-depth: confirm the version belongs to the course AND
  // the course belongs to the club.  A caller-induced mismatch here
  // is a bug, not a normal path.
  const version = await client.trainingCourseVersion.findUnique({
    where: { id: args.courseVersionId },
    select: { courseId: true, course: { select: { clubId: true } } },
  });
  if (!version) throw new NotFoundError("TrainingCourseVersion", args.courseVersionId);
  if (version.courseId !== args.courseId) {
    throw new ValidationError([
      { path: "courseId", message: "courseId does not match the version's courseId" },
    ]);
  }
  if (version.course.clubId !== args.clubId) {
    // Cross-tenant attempt — never create.
    throw new ValidationError([
      { path: "clubId", message: "clubId does not match the course's club" },
    ]);
  }

  // Idempotency via the composite UNIQUE on
  // (clubId, employeeId, courseVersionId, reason, issuanceKey).  If
  // this exact authorized event already landed, return the existing
  // row (regardless of its current status — a repeat submit of the
  // same CANCELED event is still a no-op; the caller MUST allocate a
  // NEW issuanceKey to re-request after cancellation).
  const existing = await client.trainingObligation.findUnique({
    where: {
      clubId_employeeId_courseVersionId_reason_issuanceKey: {
        clubId: args.clubId,
        employeeId: args.employeeId,
        courseVersionId: args.courseVersionId,
        reason: args.reason,
        issuanceKey: args.issuanceKey,
      },
    },
  });
  if (existing) return existing as ObligationRecord;

  const created = await client.trainingObligation.create({
    data: {
      clubId: args.clubId,
      employeeId: args.employeeId,
      courseId: args.courseId,
      courseVersionId: args.courseVersionId,
      reason: args.reason,
      reasonNote: args.reasonNote ?? null,
      issuedByUserId: args.issuedByUserId,
      issuedAt: args.issuedAt ?? new Date(),
      dueAt: args.dueAt ?? null,
      status: "OUTSTANDING",
      issuanceKey: args.issuanceKey,
    },
  });
  return created as ObligationRecord;
}

/**
 * Satisfy an obligation using a completion.
 *
 * Invariant 2 (one completion satisfies AT MOST one obligation) is
 * enforced by the DB (TrainingObligation.satisfiedByCompletionId is
 * UNIQUE).  If a second obligation tries to claim the same completion,
 * Prisma raises a unique-constraint error and this helper surfaces
 * ValidationError.
 *
 * Invariant 3 (old completion must not auto-satisfy a new obligation)
 * is enforced here: we require `completion.completedAt >= obligation.issuedAt`.
 * The caller is expected to pass a completion that was CREATED after
 * the obligation was issued; this check catches regressions in the
 * caller.
 */
export async function satisfyObligationWithCompletion(args: {
  obligationId: string;
  completionId: string;
  tx?: TxLike;
}): Promise<ObligationRecord> {
  const client = args.tx ?? prisma;
  const obligation = await client.trainingObligation.findUnique({
    where: { id: args.obligationId },
    select: {
      id: true, clubId: true, employeeId: true, courseVersionId: true,
      status: true, issuedAt: true,
    },
  });
  if (!obligation) throw new NotFoundError("TrainingObligation", args.obligationId);
  if (obligation.status !== "OUTSTANDING") {
    throw new ValidationError([
      { path: "status", message: `Only OUTSTANDING obligations can be satisfied; current = ${obligation.status}` },
    ]);
  }
  const completion = await client.trainingCompletion.findUnique({
    where: { id: args.completionId },
    select: {
      id: true, clubId: true, employeeId: true, courseVersionId: true, completedAt: true,
    },
  });
  if (!completion) throw new NotFoundError("TrainingCompletion", args.completionId);
  // Scope checks — the completion must match the obligation's subject.
  if (completion.clubId !== obligation.clubId
      || completion.employeeId !== obligation.employeeId
      || completion.courseVersionId !== obligation.courseVersionId) {
    throw new ValidationError([
      { path: "completionId", message: "completion does not match obligation subject" },
    ]);
  }
  if (completion.completedAt.getTime() < obligation.issuedAt.getTime()) {
    throw new ValidationError([
      {
        path: "completionId",
        message: "completion predates obligation issuance; a prior completion cannot satisfy a later obligation",
      },
    ]);
  }
  const updated = await client.trainingObligation.update({
    where: { id: args.obligationId },
    data: {
      status: "SATISFIED",
      satisfiedByCompletionId: args.completionId,
      satisfiedAt: new Date(),
      // EP-TRAIN-5A-1: issuanceKey is NOT cleared on terminal
      // transition.  The composite UNIQUE still refuses a repeat of
      // the same authorized event even after SATISFIED, which is the
      // correct semantics (the caller must allocate a NEW
      // issuanceKey to re-request a retake after the earlier one was
      // satisfied).
    },
  });
  return updated as ObligationRecord;
}

/**
 * Cancel an outstanding obligation (manager-initiated withdrawal).
 * Terminal; audit-visible via the standard audit() wrapper the caller
 * invokes.
 */
export async function cancelObligation(args: {
  obligationId: string;
  cancelReason: string;
  tx?: TxLike;
}): Promise<ObligationRecord> {
  const client = args.tx ?? prisma;
  const obligation = await client.trainingObligation.findUnique({
    where: { id: args.obligationId },
    select: { id: true, status: true, reasonNote: true },
  });
  if (!obligation) throw new NotFoundError("TrainingObligation", args.obligationId);
  if (obligation.status !== "OUTSTANDING") {
    throw new ValidationError([
      { path: "status", message: `Only OUTSTANDING obligations can be canceled; current = ${obligation.status}` },
    ]);
  }
  const updated = await client.trainingObligation.update({
    where: { id: args.obligationId },
    data: {
      status: "CANCELED",
      // Preserve original reasonNote AND append cancellation reason so
      // the terminal row carries both narratives for audit.
      reasonNote: obligation.reasonNote
        ? `${obligation.reasonNote}\n[canceled] ${args.cancelReason}`
        : `[canceled] ${args.cancelReason}`,
      // issuanceKey intentionally preserved on terminal transition
      // (EP-TRAIN-5A-1).  A manager retake re-request must allocate
      // a new issuanceKey; this prevents accidental re-issuance of
      // the same authorized event.
    },
  });
  return updated as ObligationRecord;
}

/**
 * Supersede an outstanding obligation (REVISION publication retires
 * an earlier obligation that no longer reflects the required version).
 *
 * Example: Alice has an outstanding INITIAL for v1.  Manager publishes
 * v2 with Option B.  5B issues a REVISION for v2 then calls
 * `supersedeObligation(aliceV1Obligation, aliceV2Obligation)` to mark
 * the v1 obligation closed with a pointer to the replacement.
 */
export async function supersedeObligation(args: {
  obligationId: string;
  supersededByObligationId: string;
  tx?: TxLike;
}): Promise<ObligationRecord> {
  const client = args.tx ?? prisma;
  const [current, replacement] = await Promise.all([
    client.trainingObligation.findUnique({
      where: { id: args.obligationId },
      select: { id: true, clubId: true, employeeId: true, courseId: true, status: true },
    }),
    client.trainingObligation.findUnique({
      where: { id: args.supersededByObligationId },
      select: { id: true, clubId: true, employeeId: true, courseId: true, status: true },
    }),
  ]);
  if (!current) throw new NotFoundError("TrainingObligation", args.obligationId);
  if (!replacement) throw new NotFoundError("TrainingObligation", args.supersededByObligationId);
  if (current.status !== "OUTSTANDING") {
    throw new ValidationError([
      { path: "status", message: `Only OUTSTANDING obligations can be superseded; current = ${current.status}` },
    ]);
  }
  // Supersession must stay within the same (club, employee, course).
  if (current.clubId !== replacement.clubId
      || current.employeeId !== replacement.employeeId
      || current.courseId !== replacement.courseId) {
    throw new ValidationError([
      { path: "supersededByObligationId", message: "replacement obligation must share club/employee/course" },
    ]);
  }
  const updated = await client.trainingObligation.update({
    where: { id: args.obligationId },
    data: {
      status: "SUPERSEDED",
      supersededByObligationId: args.supersededByObligationId,
      // issuanceKey preserved — the superseded row is a historical
      // audit record, and the composite UNIQUE still rejects a repeat
      // of the same original authorized event.
    },
  });
  return updated as ObligationRecord;
}

/**
 * Read-side helper for the (future) resolver.  Returns every
 * OUTSTANDING obligation for the employee, enriched with the course
 * title + version so the caller can render the dashboard without a
 * second round-trip.
 *
 * The current (pre-5C) applicability resolver does NOT call this.
 * The function is exported so the contract tests + the eventual 5C
 * swap can exercise it.
 */
export async function listOutstandingObligationsForEmployee(
  employeeId: string,
): Promise<ReadonlyArray<ObligationRecord & { courseTitle: string; versionNumber: number }>> {
  const rows = await prisma.trainingObligation.findMany({
    where: { employeeId, status: "OUTSTANDING" },
    include: {
      course: { select: { title: true } },
      courseVersion: { select: { version: true } },
    },
    orderBy: [{ dueAt: "asc" }, { issuedAt: "asc" }],
  });
  return rows.map((r) => ({
    ...(r as unknown as ObligationRecord),
    courseTitle: r.course.title,
    versionNumber: r.courseVersion.version,
  }));
}

/**
 * EP-TRAIN-5A-1 (2026-11-01) — FIFO completion-to-obligation matcher.
 *
 * When an employee completes a course version, this helper picks the
 * oldest OUTSTANDING obligation for that (employee, courseVersionId)
 * subject that the completion is eligible to satisfy (i.e. where
 * completion.completedAt >= obligation.issuedAt).  Subsequent
 * completions satisfy the next OUTSTANDING in issuedAt order.  The
 * caller is responsible for invoking satisfyObligationWithCompletion
 * with the returned id; this helper only READS.  Dormant in 5A-1:
 * no code consumes it yet; 5C's resolver + attempt-submission path
 * are the intended callers.
 */
export async function pickObligationToSatisfy(args: {
  employeeId: string;
  courseVersionId: string;
  completionCompletedAt: Date;
}): Promise<ObligationRecord | null> {
  const row = await prisma.trainingObligation.findFirst({
    where: {
      employeeId: args.employeeId,
      courseVersionId: args.courseVersionId,
      status: "OUTSTANDING",
      issuedAt: { lte: args.completionCompletedAt },
    },
    orderBy: { issuedAt: "asc" },
  });
  return (row ?? null) as ObligationRecord | null;
}

// Exported for the contract tests + future callers only.  Not used
// internally.
export const _internal = { TERMINAL_STATUSES };

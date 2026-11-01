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

/** Compose the outstandingUniqueKey the UNIQUE index enforces. */
function outstandingKey(employeeId: string, courseVersionId: string, reason: ObligationReason): string {
  return `${employeeId}|${courseVersionId}|${reason}`;
}

/**
 * Idempotently issue an obligation.  If an OUTSTANDING obligation
 * already exists for (employeeId, courseVersionId, reason) the
 * existing row is returned unchanged — this is how we honor the
 * directive invariant "repeated publication / page refreshes / retries
 * must not create duplicate obligations" at the service layer and NOT
 * only in the UI.
 *
 * The caller is expected to have already:
 *   - checked the principal's `hr:training:write` permission on the
 *     clubId
 *   - loaded the (courseId, courseVersionId) pair and confirmed they
 *     reference each other
 *   - run `assertTenantOwned` on the course
 *
 * We re-validate the (course ↔ version) match here as a defense in
 * depth because this helper is also invoked from the backfill script.
 */
export async function issueObligation(args: {
  clubId: string;
  employeeId: string;
  courseId: string;
  courseVersionId: string;
  reason: ObligationReason;
  reasonNote?: string | null;
  issuedByUserId: string | null;
  dueAt?: Date | null;
  issuedAt?: Date;
  tx?: TxLike;
}): Promise<ObligationRecord> {
  const client = args.tx ?? prisma;
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

  const key = outstandingKey(args.employeeId, args.courseVersionId, args.reason);
  // Invariant 1 (idempotency on OUTSTANDING).
  const existing = await client.trainingObligation.findUnique({
    where: { outstandingUniqueKey: key },
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
      outstandingUniqueKey: key,
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
      // Terminal transition — clear the OUTSTANDING unique key so a
      // future obligation for the same (employee, version, reason)
      // can be issued without collision.
      outstandingUniqueKey: null,
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
      outstandingUniqueKey: null,
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
      outstandingUniqueKey: null,
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

// Exported for the contract tests + future callers only.  Not used
// internally.
export const _internal = { outstandingKey, TERMINAL_STATUSES };

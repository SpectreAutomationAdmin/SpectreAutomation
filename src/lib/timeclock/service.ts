// Payroll-3D-1 (2026-09-05) — Employee Clock In / Clock Out service.
//
// Architectural principles (from the 3D-1 brief):
//
//   §2  Three layers:
//       Layer 1 — Clock Event       (append-only historical fact — this file)
//       Layer 2 — Timesheet         (3D-2 — interpreted work)
//       Layer 3 — PayrollApprovedTimeEntry (existing — frozen payroll input)
//
//   §7  Server determines the authoritative timestamp. Client-supplied
//       timestamps are NEVER accepted as the canonical `occurredAt`.
//
//   §9  Append-only. This file never UPDATEs or DELETEs a TimeClockEvent.
//       Corrections come later (3D-2) as new events referencing the
//       original.
//
//   §11 State machine:  OFF_CLOCK / WORKING / ON_BREAK.
//       Legal transitions enforced inside a $transaction so a
//       concurrent double-tap cannot produce two events.
//
//   §12 Duplicate-request safety — two concurrent CLOCK_IN calls must
//       yield exactly one CLOCK_IN event. Enforced via a state check
//       inside the transaction: any writer entering after another
//       already inserted a CLOCK_IN sees the new state and refuses.
//
//   §34 Timekeeping eligibility — CLOCK_REQUIRED employees may
//       transact; NO_TIME_ENTRY_REQUIRED / MANUAL_TIMESHEET /
//       SCHEDULE_DERIVED cannot.
//
//   §38 NO GPS. This service never reads or writes `lat` / `lng`.
//
//   §47 Clock events NEVER create PayrollApprovedTimeEntry rows.
//
// All writes attribute to `source: "EMPLOYEE_PORTAL"`. Admin
// corrections (future 3D-2) will use `source: "ADMIN_CORRECTION"`.

import type { Prisma as PrismaTypes } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import type { EmployeePortalPrincipal } from "../employee-portal-session";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";

export type ClockEventKind = "CLOCK_IN" | "CLOCK_OUT" | "BREAK_START" | "BREAK_END";
export type ClockState     = "OFF_CLOCK" | "WORKING" | "ON_BREAK";

export const TIMEKEEPING_METHODS = [
  "NO_TIME_ENTRY_REQUIRED",
  "CLOCK_REQUIRED",
  "MANUAL_TIMESHEET",
  "SCHEDULE_DERIVED",
] as const;
export type TimekeepingMethod = (typeof TIMEKEEPING_METHODS)[number];

/** Derived from the most recent CLOCK_IN / OUT / BREAK_START / END event. */
export interface ClockStateView {
  state:                ClockState;
  /** Most recent CLOCK_IN that has not been closed by a CLOCK_OUT. */
  currentSessionStart?: Date;
  /** Most recent BREAK_START that has not been closed by a BREAK_END. */
  currentBreakStart?:   Date;
  /** Total unpaid break time within the current OPEN session, in seconds. */
  currentSessionBreakSeconds: number;
  /** True when the last event was BREAK_START and no BREAK_END has come. */
  onBreak:              boolean;
  timekeepingMethod:    TimekeepingMethod;
  /** Non-null when the current session's CLOCK_IN carried an assignment. */
  currentSessionAssignmentId?: string | null;
}

// -------------------------------------------------------------------
// State computation
// -------------------------------------------------------------------
/**
 * Compute the state a given tx-view sees for `employeeId`. Reads the
 * most recent CLOCK_IN → then everything that follows it. If no
 * CLOCK_IN, state is OFF_CLOCK.
 *
 * Must be called INSIDE a $transaction when the caller intends to
 * write a new event; the read + write together form the atomic
 * state transition (§11, §12).
 */
async function readState(
  tx: PrismaTypes.TransactionClient,
  clubId: string,
  employeeId: string,
): Promise<{
  view: ClockStateView;
  events: Array<{ id: string; kind: string; occurredAt: Date; employmentAssignmentId: string | null }>;
  /**
   * Payroll-3D-1A — value at the moment of read. Every clock-write
   * transition MUST compare-and-swap this back to N+1 as the last
   * action of its transaction; if the CAS matches zero rows, a
   * concurrent writer already advanced state, and this transaction
   * rolls back — annihilating its would-be TimeClockEvent insert.
   */
  stateVersion: number;
}> {
  // Load timekeeping method + concurrency version — always needed by callers.
  const emp = await tx.employee.findUnique({
    where: { id: employeeId },
    select: {
      clubId: true, status: true, employeeLifecycle: true,
      timekeepingMethod: true, timekeepingStateVersion: true,
    },
  });
  if (!emp || emp.clubId !== clubId) {
    throw new NotFoundError("Employee", employeeId);
  }
  const method = (emp.timekeepingMethod ?? "NO_TIME_ENTRY_REQUIRED") as TimekeepingMethod;
  const stateVersion = emp.timekeepingStateVersion ?? 0;

  // Find the most recent CLOCK_IN for this employee. Everything
  // strictly after it — until (but not including) a CLOCK_OUT —
  // belongs to the current OPEN session.
  const lastClockIn = await tx.timeClockEvent.findFirst({
    where: { employeeId, kind: "CLOCK_IN" },
    orderBy: { occurredAt: "desc" },
  });

  if (!lastClockIn) {
    return {
      stateVersion,
      view: {
        state: "OFF_CLOCK",
        currentSessionBreakSeconds: 0,
        onBreak: false,
        timekeepingMethod: method,
        currentSessionAssignmentId: null,
      },
      events: [],
    };
  }

  // Every event >= this CLOCK_IN occurredAt.
  const following = await tx.timeClockEvent.findMany({
    where: { employeeId, occurredAt: { gte: lastClockIn.occurredAt } },
    orderBy: { occurredAt: "asc" },
    select: { id: true, kind: true, occurredAt: true, employmentAssignmentId: true },
  });

  // Walk the events to derive state.
  let state: ClockState = "WORKING";
  let breakSeconds = 0;
  let openBreakStart: Date | undefined;
  let sessionEnded = false;
  for (const ev of following) {
    if (ev.kind === "CLOCK_IN") continue; // the anchor itself
    if (sessionEnded) continue;            // a later CLOCK_IN is beyond THIS session
    if (ev.kind === "BREAK_START") {
      openBreakStart = ev.occurredAt;
      state = "ON_BREAK";
    } else if (ev.kind === "BREAK_END") {
      if (openBreakStart) {
        breakSeconds += Math.max(0, Math.floor((ev.occurredAt.getTime() - openBreakStart.getTime()) / 1000));
      }
      openBreakStart = undefined;
      state = "WORKING";
    } else if (ev.kind === "CLOCK_OUT") {
      // §11 — if OUT during ON_BREAK, close the open break at the
      // same authoritative timestamp so we don't leave a dangling
      // open-break in the historical record.
      if (openBreakStart) {
        breakSeconds += Math.max(0, Math.floor((ev.occurredAt.getTime() - openBreakStart.getTime()) / 1000));
        openBreakStart = undefined;
      }
      state = "OFF_CLOCK";
      sessionEnded = true;
    }
  }

  return {
    view: {
      state,
      currentSessionStart: sessionEnded ? undefined : lastClockIn.occurredAt,
      currentBreakStart:   openBreakStart,
      currentSessionBreakSeconds: sessionEnded ? 0 : breakSeconds,
      onBreak: state === "ON_BREAK",
      timekeepingMethod: method,
      currentSessionAssignmentId: sessionEnded ? null : lastClockIn.employmentAssignmentId,
    },
    events: following,
    stateVersion,
  };
}

// -------------------------------------------------------------------
// Payroll-3D-1A — Compare-and-swap primitive.
//
// Every clock-write transition ends with `bumpStateVersion(tx, id, v)`.
// If the CAS matches ZERO rows, another concurrent transaction has
// already advanced the version — this transaction rolls back and
// throws. The throw is inside the outer `$transaction` callback, so
// Prisma discards the TimeClockEvent this call would have created.
async function bumpStateVersion(
  tx: PrismaTypes.TransactionClient,
  employeeId: string,
  expected: number,
): Promise<void> {
  const result = await tx.employee.updateMany({
    where: { id: employeeId, timekeepingStateVersion: expected },
    data:  { timekeepingStateVersion: expected + 1 },
  });
  if (result.count === 0) {
    throw new ConflictError(
      "Clock transition lost to a concurrent transition — please retry.",
    );
  }
}

// -------------------------------------------------------------------
// Public reads
// -------------------------------------------------------------------
export async function getMyClockState(
  principal: EmployeePortalPrincipal,
): Promise<ClockStateView> {
  const r = await readState(prisma as unknown as PrismaTypes.TransactionClient, principal.clubId, principal.employeeId);
  return r.view;
}

export interface RecentClockEvent {
  id:         string;
  kind:       ClockEventKind;
  occurredAt: Date;
  source:     string;
  employmentAssignmentId: string | null;
}
export async function listMyRecentClockEvents(
  principal: EmployeePortalPrincipal,
  opts?: { limit?: number },
): Promise<RecentClockEvent[]> {
  const rows = await prisma.timeClockEvent.findMany({
    where: { employeeId: principal.employeeId, clubId: principal.clubId },
    orderBy: { occurredAt: "desc" },
    take: Math.min(Math.max(opts?.limit ?? 30, 1), 200),
    select: {
      id: true, kind: true, occurredAt: true, source: true,
      employmentAssignmentId: true,
    },
  });
  return rows as RecentClockEvent[];
}

// -------------------------------------------------------------------
// Transitions — always server-timestamped, always inside a tx.
// -------------------------------------------------------------------
function assertEligible(method: TimekeepingMethod, kind: ClockEventKind): void {
  // Payroll-3D-1 — only CLOCK_REQUIRED may transact via this service.
  // MANUAL_TIMESHEET / SCHEDULE_DERIVED land in future slices with
  // their own entry paths. NO_TIME_ENTRY_REQUIRED is the safe default
  // for salaried employees — they must not be able to clock.
  if (method !== "CLOCK_REQUIRED") {
    throw new ForbiddenError(
      `This employee's timekeeping method is ${method}; ${kind} via clock-in is not permitted.`,
    );
  }
}

function assertEmployeeActive(status: string, lifecycle: string): void {
  if (status !== "ACTIVE") {
    throw new ForbiddenError(`Employee status ${status} cannot create clock events.`);
  }
  if (lifecycle === "TERMINATED") {
    throw new ForbiddenError("Terminated employees cannot create clock events.");
  }
}

export interface ClockInInput {
  employmentAssignmentId?: string | null;
  notes?: string;
}
export async function clockIn(
  principal: EmployeePortalPrincipal,
  input: ClockInInput = {},
): Promise<{ event: RecentClockEvent; state: ClockStateView; idempotent: boolean }> {
  return prisma.$transaction(async (tx) => {
    // Re-read state INSIDE the transaction (§11, §12 — atomic).
    const emp = await tx.employee.findUniqueOrThrow({
      where: { id: principal.employeeId },
      select: { clubId: true, status: true, employeeLifecycle: true, timekeepingMethod: true },
    });
    if (emp.clubId !== principal.clubId) throw new NotFoundError("Employee", principal.employeeId);
    assertEmployeeActive(emp.status, emp.employeeLifecycle);
    assertEligible(emp.timekeepingMethod as TimekeepingMethod, "CLOCK_IN");

    const { view, stateVersion } = await readState(tx, principal.clubId, principal.employeeId);

    // Idempotency: if the last event within the last 3 seconds is a
    // CLOCK_IN with the same assignment, treat the duplicate as
    // already-succeeded (double-tap / retry). Note the 3-second
    // window is UX polish for the intra-single-tx retry case; the
    // CROSS-transaction guarantee comes from the stateVersion CAS
    // below (Payroll-3D-1A §13).
    const now = new Date();
    if (view.state === "WORKING" && view.currentSessionStart) {
      const withinDoubleTap = (now.getTime() - view.currentSessionStart.getTime()) < 3_000;
      if (withinDoubleTap) {
        const existing = await tx.timeClockEvent.findFirstOrThrow({
          where: { employeeId: principal.employeeId, kind: "CLOCK_IN" },
          orderBy: { occurredAt: "desc" },
        });
        return {
          event: {
            id: existing.id, kind: "CLOCK_IN" as const,
            occurredAt: existing.occurredAt, source: existing.source,
            employmentAssignmentId: existing.employmentAssignmentId,
          },
          state: view,
          idempotent: true as const,
        };
      }
      throw new ConflictError("Already clocked in.");
    }
    if (view.state === "ON_BREAK") {
      throw new ConflictError("You are on break — end the break before clocking out or starting a new session.");
    }

    // Assignment must belong to this employee if given.
    let assignmentId: string | null = null;
    if (input.employmentAssignmentId) {
      const assn = await tx.employeeEmploymentAssignment.findFirst({
        where: {
          id: input.employmentAssignmentId,
          clubId: principal.clubId,
          employeeId: principal.employeeId,
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
        select: { id: true },
      });
      if (!assn) throw new ValidationError([{
        path: "employmentAssignmentId",
        message: "Not a current assignment of yours.",
      }]);
      assignmentId = assn.id;
    } else {
      // Payroll-3D-2 — UX default. When the employee has exactly one
      // currently-active assignment we bind the clock event to it so
      // downstream timesheet materialisation does not surface a
      // spurious MISSING_ASSIGNMENT exception. Ambiguous multi-assn
      // cases still require an explicit pick from the UI.
      const activeAssignments = await tx.employeeEmploymentAssignment.findMany({
        where: {
          clubId: principal.clubId,
          employeeId: principal.employeeId,
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        },
        select: { id: true },
        take: 2,
      });
      if (activeAssignments.length === 1) assignmentId = activeAssignments[0].id;
    }

    const ev = await tx.timeClockEvent.create({
      data: {
        clubId: principal.clubId,
        employeeId: principal.employeeId,
        kind: "CLOCK_IN",
        occurredAt: now,
        source: "EMPLOYEE_PORTAL",
        employmentAssignmentId: assignmentId,
        notes: input.notes ?? null,
      },
    });
    // Payroll-3D-1A — compare-and-swap. If a concurrent tx bumped
    // the version first, this fails and rolls back the JE insert.
    await bumpStateVersion(tx, principal.employeeId, stateVersion);
    const nextView = (await readState(tx, principal.clubId, principal.employeeId)).view;
    return {
      event: {
        id: ev.id, kind: "CLOCK_IN" as const,
        occurredAt: ev.occurredAt, source: ev.source,
        employmentAssignmentId: ev.employmentAssignmentId,
      },
      state: nextView,
      idempotent: false as const,
    };
  }, { timeout: 15_000, maxWait: 5_000 })
    .then(async (result) => {
      if (!result.idempotent) {
        await audit(null, {
          clubId: principal.clubId,
          action: "timeclock.clock_in",
          entityType: "TimeClockEvent",
          entityId: result.event.id,
          after: { occurredAt: result.event.occurredAt.toISOString() },
        });
      }
      return result;
    });
}

export async function clockOut(
  principal: EmployeePortalPrincipal,
): Promise<{ event: RecentClockEvent; state: ClockStateView; idempotent: boolean }> {
  return prisma.$transaction(async (tx) => {
    const emp = await tx.employee.findUniqueOrThrow({
      where: { id: principal.employeeId },
      select: { clubId: true, status: true, employeeLifecycle: true, timekeepingMethod: true },
    });
    if (emp.clubId !== principal.clubId) throw new NotFoundError("Employee", principal.employeeId);
    assertEmployeeActive(emp.status, emp.employeeLifecycle);
    assertEligible(emp.timekeepingMethod as TimekeepingMethod, "CLOCK_OUT");

    const { view, stateVersion } = await readState(tx, principal.clubId, principal.employeeId);
    const now = new Date();

    // Idempotency: if the last event was a CLOCK_OUT within 3s,
    // return it silently.
    if (view.state === "OFF_CLOCK") {
      const lastOut = await tx.timeClockEvent.findFirst({
        where: { employeeId: principal.employeeId, kind: "CLOCK_OUT" },
        orderBy: { occurredAt: "desc" },
      });
      if (lastOut && (now.getTime() - lastOut.occurredAt.getTime()) < 3_000) {
        return {
          event: {
            id: lastOut.id, kind: "CLOCK_OUT" as const,
            occurredAt: lastOut.occurredAt, source: lastOut.source,
            employmentAssignmentId: lastOut.employmentAssignmentId,
          },
          state: view,
          idempotent: true as const,
        };
      }
      throw new ConflictError("You are not clocked in.");
    }
    // WORKING or ON_BREAK — both allowed. When ON_BREAK, the state
    // computation will treat the open break as ending at the same
    // authoritative CLOCK_OUT timestamp.

    const ev = await tx.timeClockEvent.create({
      data: {
        clubId: principal.clubId,
        employeeId: principal.employeeId,
        kind: "CLOCK_OUT",
        occurredAt: now,
        source: "EMPLOYEE_PORTAL",
      },
    });
    await bumpStateVersion(tx, principal.employeeId, stateVersion);
    const nextView = (await readState(tx, principal.clubId, principal.employeeId)).view;
    return {
      event: {
        id: ev.id, kind: "CLOCK_OUT" as const,
        occurredAt: ev.occurredAt, source: ev.source,
        employmentAssignmentId: ev.employmentAssignmentId,
      },
      state: nextView,
      idempotent: false as const,
    };
  }, { timeout: 15_000, maxWait: 5_000 })
    .then(async (result) => {
      if (!result.idempotent) {
        await audit(null, {
          clubId: principal.clubId,
          action: "timeclock.clock_out",
          entityType: "TimeClockEvent",
          entityId: result.event.id,
          after: { occurredAt: result.event.occurredAt.toISOString() },
        });
      }
      return result;
    });
}

export async function breakStart(
  principal: EmployeePortalPrincipal,
): Promise<{ event: RecentClockEvent; state: ClockStateView; idempotent: boolean }> {
  return prisma.$transaction(async (tx) => {
    const emp = await tx.employee.findUniqueOrThrow({
      where: { id: principal.employeeId },
      select: { clubId: true, status: true, employeeLifecycle: true, timekeepingMethod: true },
    });
    if (emp.clubId !== principal.clubId) throw new NotFoundError("Employee", principal.employeeId);
    assertEmployeeActive(emp.status, emp.employeeLifecycle);
    assertEligible(emp.timekeepingMethod as TimekeepingMethod, "BREAK_START");

    const { view, stateVersion } = await readState(tx, principal.clubId, principal.employeeId);
    const now = new Date();

    if (view.state === "ON_BREAK" && view.currentBreakStart) {
      const withinDoubleTap = (now.getTime() - view.currentBreakStart.getTime()) < 3_000;
      if (withinDoubleTap) {
        const existing = await tx.timeClockEvent.findFirstOrThrow({
          where: { employeeId: principal.employeeId, kind: "BREAK_START" },
          orderBy: { occurredAt: "desc" },
        });
        return {
          event: {
            id: existing.id, kind: "BREAK_START" as const,
            occurredAt: existing.occurredAt, source: existing.source,
            employmentAssignmentId: existing.employmentAssignmentId,
          },
          state: view,
          idempotent: true as const,
        };
      }
      throw new ConflictError("Already on break.");
    }
    if (view.state !== "WORKING") {
      throw new ConflictError("You must be clocked in and not on break to start a break.");
    }

    const ev = await tx.timeClockEvent.create({
      data: {
        clubId: principal.clubId,
        employeeId: principal.employeeId,
        kind: "BREAK_START",
        occurredAt: now,
        source: "EMPLOYEE_PORTAL",
      },
    });
    await bumpStateVersion(tx, principal.employeeId, stateVersion);
    const nextView = (await readState(tx, principal.clubId, principal.employeeId)).view;
    return {
      event: {
        id: ev.id, kind: "BREAK_START" as const,
        occurredAt: ev.occurredAt, source: ev.source,
        employmentAssignmentId: ev.employmentAssignmentId,
      },
      state: nextView,
      idempotent: false as const,
    };
  }, { timeout: 15_000, maxWait: 5_000 })
    .then(async (result) => {
      if (!result.idempotent) {
        await audit(null, {
          clubId: principal.clubId,
          action: "timeclock.break_start",
          entityType: "TimeClockEvent",
          entityId: result.event.id,
          after: { occurredAt: result.event.occurredAt.toISOString() },
        });
      }
      return result;
    });
}

export async function breakEnd(
  principal: EmployeePortalPrincipal,
): Promise<{ event: RecentClockEvent; state: ClockStateView; idempotent: boolean }> {
  return prisma.$transaction(async (tx) => {
    const emp = await tx.employee.findUniqueOrThrow({
      where: { id: principal.employeeId },
      select: { clubId: true, status: true, employeeLifecycle: true, timekeepingMethod: true },
    });
    if (emp.clubId !== principal.clubId) throw new NotFoundError("Employee", principal.employeeId);
    assertEmployeeActive(emp.status, emp.employeeLifecycle);
    assertEligible(emp.timekeepingMethod as TimekeepingMethod, "BREAK_END");

    const { view, stateVersion } = await readState(tx, principal.clubId, principal.employeeId);
    const now = new Date();

    if (view.state === "WORKING") {
      const lastEnd = await tx.timeClockEvent.findFirst({
        where: { employeeId: principal.employeeId, kind: "BREAK_END" },
        orderBy: { occurredAt: "desc" },
      });
      if (lastEnd && (now.getTime() - lastEnd.occurredAt.getTime()) < 3_000) {
        return {
          event: {
            id: lastEnd.id, kind: "BREAK_END" as const,
            occurredAt: lastEnd.occurredAt, source: lastEnd.source,
            employmentAssignmentId: lastEnd.employmentAssignmentId,
          },
          state: view,
          idempotent: true as const,
        };
      }
      throw new ConflictError("You are not on break.");
    }
    if (view.state !== "ON_BREAK") {
      throw new ConflictError("You must be on break to end a break.");
    }

    const ev = await tx.timeClockEvent.create({
      data: {
        clubId: principal.clubId,
        employeeId: principal.employeeId,
        kind: "BREAK_END",
        occurredAt: now,
        source: "EMPLOYEE_PORTAL",
      },
    });
    await bumpStateVersion(tx, principal.employeeId, stateVersion);
    const nextView = (await readState(tx, principal.clubId, principal.employeeId)).view;
    return {
      event: {
        id: ev.id, kind: "BREAK_END" as const,
        occurredAt: ev.occurredAt, source: ev.source,
        employmentAssignmentId: ev.employmentAssignmentId,
      },
      state: nextView,
      idempotent: false as const,
    };
  }, { timeout: 15_000, maxWait: 5_000 })
    .then(async (result) => {
      if (!result.idempotent) {
        await audit(null, {
          clubId: principal.clubId,
          action: "timeclock.break_end",
          entityType: "TimeClockEvent",
          entityId: result.event.id,
          after: { occurredAt: result.event.occurredAt.toISOString() },
        });
      }
      return result;
    });
}

// -------------------------------------------------------------------
// Session summary helper — used by the "today summary" panel.
// -------------------------------------------------------------------
export interface CompletedSessionSummary {
  clockInAt:            Date;
  clockOutAt:           Date;
  breakSeconds:         number;
  paidElapsedSeconds:   number;  // gross elapsed − break
  grossElapsedSeconds:  number;
  assignmentId:         string | null;
}

/**
 * Reconstruct all completed clock sessions between `from` (inclusive)
 * and `to` (exclusive) for an employee. In-progress sessions
 * (last-CLOCK_IN with no matching CLOCK_OUT) are omitted.
 */
export async function listCompletedSessions(
  principal: EmployeePortalPrincipal,
  from: Date,
  to: Date,
): Promise<CompletedSessionSummary[]> {
  const events = await prisma.timeClockEvent.findMany({
    where: {
      employeeId: principal.employeeId,
      clubId: principal.clubId,
      // Include some slack before `from` so a session that spans the
      // boundary is still discoverable.
      occurredAt: { gte: new Date(from.getTime() - 24 * 60 * 60 * 1000), lt: to },
    },
    orderBy: { occurredAt: "asc" },
    select: { kind: true, occurredAt: true, employmentAssignmentId: true },
  });

  const sessions: CompletedSessionSummary[] = [];
  let current: { start: Date; assignmentId: string | null; breakSeconds: number; openBreak: Date | undefined } | null = null;
  for (const ev of events) {
    if (ev.kind === "CLOCK_IN") {
      current = { start: ev.occurredAt, assignmentId: ev.employmentAssignmentId, breakSeconds: 0, openBreak: undefined };
    } else if (current) {
      if (ev.kind === "BREAK_START") {
        current.openBreak = ev.occurredAt;
      } else if (ev.kind === "BREAK_END" && current.openBreak) {
        current.breakSeconds += Math.max(0, Math.floor((ev.occurredAt.getTime() - current.openBreak.getTime()) / 1000));
        current.openBreak = undefined;
      } else if (ev.kind === "CLOCK_OUT") {
        // §11 — close any open break at the CLOCK_OUT timestamp.
        if (current.openBreak) {
          current.breakSeconds += Math.max(0, Math.floor((ev.occurredAt.getTime() - current.openBreak.getTime()) / 1000));
          current.openBreak = undefined;
        }
        const gross = Math.max(0, Math.floor((ev.occurredAt.getTime() - current.start.getTime()) / 1000));
        // Only keep sessions that at least partially fall inside [from, to).
        if (ev.occurredAt >= from && current.start < to) {
          sessions.push({
            clockInAt:           current.start,
            clockOutAt:          ev.occurredAt,
            grossElapsedSeconds: gross,
            breakSeconds:        current.breakSeconds,
            paidElapsedSeconds:  Math.max(0, gross - current.breakSeconds),
            assignmentId:        current.assignmentId,
          });
        }
        current = null;
      }
    }
  }
  return sessions;
}

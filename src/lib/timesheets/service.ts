// Payroll-3D-2 (2026-09-05) — Timesheet materializer + reader service.
//
// Reads immutable TimeClockEvent facts and produces (or reconciles)
// canonical PayrollTimesheet + PayrollTimesheetEntry rows for a
// given (employee × pay period). Never mutates clock events. Never
// creates PayrollApprovedTimeEntry rows.
//
// Layered architecture:
//   TimeClockEvent → PayrollTimesheet(Entry) → [3D-3] Manager approval
//                                            → [3D-4] PayrollApprovedTimeEntry
//
// Cross-midnight policy (§44 of 3D-2 brief): entire session is
// attributed to the local Club-tz date of CLOCK_IN. A shift starting
// Sep 5 22:00 and ending Sep 6 02:00 belongs to Sep 5.
//
// Concurrency (§37, §69): two simultaneous materializer runs cannot
// duplicate rows. The DB unique constraints do the work:
//   - PayrollTimesheet(clubId, employeeId, payPeriodId) unique
//   - PayrollTimesheetEntry(timesheetId, clockInAt) unique
//   - PayrollTimesheetEntryClockEvent(timesheetEntryId, clockEventId) unique
// Upserts + P2002 loser-swallow tolerance produce a single canonical
// state regardless of race outcome.

import type { Prisma as PrismaTypes } from "@prisma/client";
import { prisma } from "../prisma";
import { NotFoundError } from "../errors";
import type { EmployeePortalPrincipal } from "../employee-portal-session";

const DAY_MS = 24 * 60 * 60 * 1000;

function isPrismaP2002(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { code?: string };
  return anyErr.code === "P2002";
}

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------
export type TimesheetStatus = "OPEN" | "NEEDS_ATTENTION" | "READY_FOR_REVIEW" | "SUBMITTED";

export interface CompletedClockSession {
  clockInEventId:  string;
  clockOutEventId: string;
  clockInAt:       Date;
  clockOutAt:      Date;
  workDate:        Date;          // UTC-midnight of CLOCK_IN's local Club-tz date
  recordedSeconds: number;
  breakSeconds:    number;
  breakEvents:     Array<{ id: string; role: "BREAK_START" | "BREAK_END" }>;
  employmentAssignmentId: string | null;
}

export interface TimesheetException {
  kind: "MISSING_CLOCK_OUT" | "OPEN_BREAK" | "MISSING_ASSIGNMENT" | "INVALID_SEQUENCE";
  message: string;
  contextClockEventId?: string;
  contextEntryId?:      string;
}

export interface TimesheetPeriodView {
  payPeriod: {
    id: string; taxYear: number; sequenceInYear: number;
    periodStart: Date; periodEnd: Date; payDate: Date;
  };
  timesheetId:    string | null;
  status:         TimesheetStatus;
  entries:        Array<{
    id: string;
    workDate: Date;
    clockInAt: Date;
    clockOutAt: Date;
    recordedSeconds: number;
    breakSeconds: number;
    employmentAssignmentId: string | null;
    earningClassification: string;
  }>;
  exceptions:     TimesheetException[];
  totalSeconds:   number;
  clubTimezone:   string | null;
}

// -------------------------------------------------------------------
// Local-date helpers
// -------------------------------------------------------------------
/** UTC-midnight instant representing the calendar date of `at` in
 *  the Club's IANA timezone. E.g. a 22:00 America/Edmonton event
 *  on 2026-09-05 → 2026-09-05T00:00:00.000Z. */
export function localWorkDate(at: Date, tz: string | null): Date {
  const iana = tz ?? "UTC";
  // Use Intl to pull YYYY-MM-DD components in the Club tz.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: iana, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value);
  const d = Number(parts.find((p) => p.type === "day")!.value);
  return new Date(Date.UTC(y, m - 1, d));
}

// -------------------------------------------------------------------
// Completed-session extractor (pure) — walks event stream, emits
// completed sessions. Open trailing session → surface as exception.
// -------------------------------------------------------------------
export function extractCompletedSessions(
  events: Array<{
    id: string;
    kind: string;
    occurredAt: Date;
    employmentAssignmentId: string | null;
  }>,
  tz: string | null,
): { sessions: CompletedClockSession[]; openSession: { clockInEventId: string; clockInAt: Date } | null; openBreak: { breakStartEventId: string; breakStartAt: Date } | null } {
  const sessions: CompletedClockSession[] = [];
  let current:
    | {
        clockInEventId: string;
        clockInAt: Date;
        employmentAssignmentId: string | null;
        breakSeconds: number;
        openBreak: { id: string; at: Date } | null;
        breakEvents: Array<{ id: string; role: "BREAK_START" | "BREAK_END" }>;
      }
    | null = null;
  for (const ev of events) {
    if (ev.kind === "CLOCK_IN") {
      current = {
        clockInEventId: ev.id,
        clockInAt: ev.occurredAt,
        employmentAssignmentId: ev.employmentAssignmentId,
        breakSeconds: 0,
        openBreak: null,
        breakEvents: [],
      };
    } else if (current && ev.kind === "BREAK_START") {
      current.openBreak = { id: ev.id, at: ev.occurredAt };
      current.breakEvents.push({ id: ev.id, role: "BREAK_START" });
    } else if (current && ev.kind === "BREAK_END" && current.openBreak) {
      current.breakSeconds += Math.max(
        0,
        Math.floor((ev.occurredAt.getTime() - current.openBreak.at.getTime()) / 1000),
      );
      current.openBreak = null;
      current.breakEvents.push({ id: ev.id, role: "BREAK_END" });
    } else if (current && ev.kind === "CLOCK_OUT") {
      // §11 mirror: an open break at CLOCK_OUT closes at CLOCK_OUT.
      if (current.openBreak) {
        current.breakSeconds += Math.max(
          0,
          Math.floor((ev.occurredAt.getTime() - current.openBreak.at.getTime()) / 1000),
        );
        current.openBreak = null;
      }
      const grossSeconds = Math.max(
        0,
        Math.floor((ev.occurredAt.getTime() - current.clockInAt.getTime()) / 1000),
      );
      const recorded = Math.max(0, grossSeconds - current.breakSeconds);
      sessions.push({
        clockInEventId: current.clockInEventId,
        clockOutEventId: ev.id,
        clockInAt: current.clockInAt,
        clockOutAt: ev.occurredAt,
        workDate: localWorkDate(current.clockInAt, tz),
        recordedSeconds: recorded,
        breakSeconds: current.breakSeconds,
        breakEvents: current.breakEvents,
        employmentAssignmentId: current.employmentAssignmentId,
      });
      current = null;
    }
  }
  return {
    sessions,
    openSession: current ? { clockInEventId: current.clockInEventId, clockInAt: current.clockInAt } : null,
    openBreak: current?.openBreak ? { breakStartEventId: current.openBreak.id, breakStartAt: current.openBreak.at } : null,
  };
}

// -------------------------------------------------------------------
// Materialize a single (employee × pay period)
// -------------------------------------------------------------------
export interface MaterializeResult {
  timesheetId:    string;
  status:         TimesheetStatus;
  entriesUpserted: number;
  entriesDeletedStale: number;
  exceptions:     TimesheetException[];
}

/**
 * Idempotent. Safe to run repeatedly. Concurrent-safe via DB unique
 * constraints — a losing tx sees P2002 and reloads the canonical row.
 *
 * `principal` may be either the employee (portal) OR a system caller.
 * All writes are club-scoped by (clubId, employeeId, payPeriodId).
 */
export async function materializeEmployeeTimesheet(
  clubId: string,
  employeeId: string,
  payPeriodId: string,
): Promise<MaterializeResult> {
  // Load pay period + club timezone.
  const [period, club] = await Promise.all([
    prisma.payrollPayPeriod.findUnique({ where: { id: payPeriodId } }),
    prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } }),
  ]);
  if (!period) throw new NotFoundError("PayrollPayPeriod", payPeriodId);
  if (period.clubId !== clubId) throw new NotFoundError("PayrollPayPeriod", payPeriodId);
  const tz = club?.timezone ?? null;

  // Load clock events whose CLOCK_IN falls inside the period. Cross-
  // midnight and cross-boundary policy (§45): whole session belongs
  // to the period containing CLOCK_IN — we widen the read to +48h
  // after periodEnd to capture the CLOCK_OUT of a shift that started
  // at the tail of the period.
  const events = await prisma.timeClockEvent.findMany({
    where: {
      clubId, employeeId,
      occurredAt: {
        gte: period.periodStart,
        lt:  new Date(period.periodEnd.getTime() + 2 * DAY_MS),
      },
      // Payroll-3D-3 (2026-09-05) — supersession: skip events that
      // have been superseded by an ADMIN_CORRECTION resolution event.
      // The corrected event stays in the table (append-only history),
      // but the materialiser interprets the resolution event as the
      // operative fact for that punch position.
      supersededByEventId: null,
    },
    orderBy: { occurredAt: "asc" },
    select: { id: true, kind: true, occurredAt: true, employmentAssignmentId: true },
  });

  const { sessions, openSession, openBreak } = extractCompletedSessions(events, tz);
  // Filter to sessions whose CLOCK_IN is inside this pay period (§45).
  const inPeriod = sessions.filter(
    (s) => s.clockInAt >= period.periodStart && s.clockInAt < period.periodEnd,
  );

  // Detect exceptions.
  const exceptions: TimesheetException[] = [];
  if (openSession && openSession.clockInAt >= period.periodStart && openSession.clockInAt < period.periodEnd) {
    exceptions.push({
      kind: "MISSING_CLOCK_OUT",
      message: "You have an open work session with no matching Clock Out.",
      contextClockEventId: openSession.clockInEventId,
    });
  }
  if (openBreak) {
    exceptions.push({
      kind: "OPEN_BREAK",
      message: "You have an open break with no matching Break End.",
      contextClockEventId: openBreak.breakStartEventId,
    });
  }
  for (const s of inPeriod) {
    if (!s.employmentAssignmentId) {
      exceptions.push({
        kind: "MISSING_ASSIGNMENT",
        message: "This session has no work assignment recorded.",
        contextClockEventId: s.clockInEventId,
      });
    }
  }

  // Upsert timesheet + entries in a transaction. Concurrent-safe:
  // unique constraints reject duplicates from a losing tx, and the
  // service tolerates P2002 by re-reading the canonical row.
  const result = await prisma.$transaction(async (tx) => {
    const timesheet = await tx.payrollTimesheet.upsert({
      where: {
        clubId_employeeId_payPeriodId: {
          clubId, employeeId, payPeriodId,
        },
      },
      update: { updatedAt: new Date() },
      create: { clubId, employeeId, payPeriodId, status: "OPEN" },
    });

    // Existing entries for this timesheet, keyed by clockInAt.
    const existingEntries = await tx.payrollTimesheetEntry.findMany({
      where: { timesheetId: timesheet.id },
      include: { provenance: true },
    });
    const existingByClockIn = new Map(existingEntries.map((e) => [e.clockInAt.getTime(), e]));
    const seenClockIns = new Set<number>();

    let upserted = 0;
    // Payroll-3D-3B Slice 7B (2026-09-06) — track TRULY-material
    // changes (new entry OR existing entry with a diff) so no-op
    // materialise passes don't spuriously bump the scope version and
    // trigger false REVIEW_REQUIRED cascades.
    let materiallyChanged = 0;
    for (const s of inPeriod) {
      seenClockIns.add(s.clockInAt.getTime());
      const existing = existingByClockIn.get(s.clockInAt.getTime()) ?? null;
      let entry;
      if (existing) {
        // Compare BEFORE writing — cheap diff on the material fields
        // hashed into computeScopeRevision.
        const diff =
          existing.clockOutAt.getTime() !== s.clockOutAt.getTime()
          || existing.recordedSeconds !== s.recordedSeconds
          || existing.breakSeconds !== s.breakSeconds
          || existing.workDate.getTime() !== s.workDate.getTime()
          || existing.employmentAssignmentId !== s.employmentAssignmentId;
        entry = await tx.payrollTimesheetEntry.update({
          where: { id: existing.id },
          data: {
            clockOutAt:      s.clockOutAt,
            recordedSeconds: s.recordedSeconds,
            breakSeconds:    s.breakSeconds,
            workDate:        s.workDate,
            employmentAssignmentId: s.employmentAssignmentId,
            earningClassification:  "REGULAR",
          },
        });
        if (diff) materiallyChanged += 1;
      } else {
        entry = await tx.payrollTimesheetEntry.create({
          data: {
            clubId, timesheetId: timesheet.id, employeeId,
            workDate: s.workDate,
            employmentAssignmentId: s.employmentAssignmentId,
            earningClassification:  "REGULAR",
            clockInAt: s.clockInAt, clockOutAt: s.clockOutAt,
            recordedSeconds: s.recordedSeconds,
            breakSeconds:    s.breakSeconds,
          },
        });
        materiallyChanged += 1;
      }
      upserted += 1;

      // Provenance — idempotent via upsert on the (timesheetEntryId,
      // clockEventId) composite unique. Postgres-safe: a failed
      // per-row create that we swallow with try/catch WOULD abort
      // the surrounding transaction on Postgres (SQLSTATE 25P02),
      // even though SQLite tolerates it. Upsert is portable to both.
      const provRows = [
        { clockEventId: s.clockInEventId,  role: "ANCHOR_IN"   as const },
        { clockEventId: s.clockOutEventId, role: "ANCHOR_OUT"  as const },
        ...s.breakEvents.map((b) => ({ clockEventId: b.id, role: b.role })),
      ];
      for (const p of provRows) {
        await tx.payrollTimesheetEntryClockEvent.upsert({
          where: {
            timesheetEntryId_clockEventId: {
              timesheetEntryId: entry.id,
              clockEventId: p.clockEventId,
            },
          },
          update: {}, // provenance is immutable — nothing to update
          create: {
            clubId, timesheetEntryId: entry.id,
            clockEventId: p.clockEventId, role: p.role,
          },
        });
      }
    }

    // Remove stale entries — any entry whose ANCHOR_IN event was
    // deleted (extremely rare — a fixture reset for a synthetic
    // employee is the only path). NEVER remove entries that still
    // have valid source data.
    const staleIds = existingEntries
      .filter((e) => !seenClockIns.has(e.clockInAt.getTime()))
      .map((e) => e.id);
    let deletedStale = 0;
    if (staleIds.length > 0) {
      // Delete provenance first, then entries.
      await tx.payrollTimesheetEntryClockEvent.deleteMany({
        where: { timesheetEntryId: { in: staleIds } },
      });
      const del = await tx.payrollTimesheetEntry.deleteMany({
        where: { id: { in: staleIds } },
      });
      deletedStale = del.count;
    }

    // Status: NEEDS_ATTENTION if any exceptions, else READY_FOR_REVIEW
    // when entries exist and no exceptions, else OPEN (empty period).
    const status: TimesheetStatus =
      exceptions.length > 0 ? "NEEDS_ATTENTION"
      : upserted > 0 ? "READY_FOR_REVIEW"
      : "OPEN";
    if (timesheet.status !== status) {
      await tx.payrollTimesheet.update({ where: { id: timesheet.id }, data: { status } });
    }

    // Payroll-3D-3B Slice 7B (2026-09-06) — atomically bump the
    // scope-version for every department whose material state
    // changed. Skips no-op materialise passes (no entries upserted,
    // no stale deletions, no status change) so unchanged reads don't
    // pathologically invalidate a still-valid approval. Otherwise
    // enumerate affected departments via the current entries + the
    // deleted-stale entries.
    const materialChanged = materiallyChanged > 0 || deletedStale > 0 || timesheet.status !== status;
    if (materialChanged) {
      // Enumerate department ids the current + pre-existing entries
      // reference. Two Prisma reads inside the tx so we see committed
      // state without races.
      const currentEntries = await tx.payrollTimesheetEntry.findMany({
        where: { timesheetId: timesheet.id },
        select: {
          employmentAssignmentId: true,
        },
      });
      const assnIds = new Set<string>();
      for (const e of currentEntries) {
        if (e.employmentAssignmentId) assnIds.add(e.employmentAssignmentId);
      }
      // Include pre-existing entries' assignments (so a delete-only
      // materialise still bumps the department whose entry vanished).
      for (const e of existingEntries) {
        if (e.employmentAssignmentId) assnIds.add(e.employmentAssignmentId);
      }
      const assignments = assnIds.size > 0
        ? await tx.employeeEmploymentAssignment.findMany({
            where: { id: { in: Array.from(assnIds) } },
            select: { departmentId: true },
          })
        : [];
      const deptIds = Array.from(new Set(
        assignments.map((a) => a.departmentId).filter((d): d is string => !!d),
      )).sort();
      for (const departmentId of deptIds) {
        await tx.payrollDepartmentTimeScopeState.upsert({
          where: {
            clubId_payPeriodId_departmentId: { clubId, payPeriodId, departmentId },
          },
          update: { version: { increment: 1 } },
          create: { clubId, payPeriodId, departmentId, version: 1 },
        });
      }
    }

    return {
      timesheetId: timesheet.id,
      status,
      entriesUpserted: upserted,
      entriesDeletedStale: deletedStale,
      exceptions,
    };
  }, { timeout: 20_000, maxWait: 5_000 });

  // Payroll-3D-3B Slice 3 (2026-09-06) — proactive department
  // timesheet-approval Work Intake. Post-commit awaited orchestration
  // with durable BackgroundJob recovery on failure. Only fires when
  // the timesheet holds actionable state — an OPEN empty period
  // doesn't need to wake a manager card. This is what removes the
  // page-load dependency from the manager's discovery flow.
  if (result.status === "READY_FOR_REVIEW" || result.status === "NEEDS_ATTENTION") {
    const { orchestrateTimesheetApprovalWorkItem } = await import(
      "../work-intake/timesheet-approval-orchestration"
    );
    await orchestrateTimesheetApprovalWorkItem(clubId, payPeriodId);
  }

  return result;
}

// -------------------------------------------------------------------
// Read the current period timesheet for an employee (view builder)
// -------------------------------------------------------------------
export async function getMyCurrentTimesheet(
  principal: EmployeePortalPrincipal,
  opts?: { asOf?: Date; materialize?: boolean },
): Promise<TimesheetPeriodView | { state: "NO_PAY_GROUP" | "NO_ACTIVE_PERIOD" }> {
  const asOf = opts?.asOf ?? new Date();
  // Find the employee's active pay-group membership.
  const membership = await prisma.payrollPayGroupMember.findFirst({
    where: {
      clubId: principal.clubId, employeeId: principal.employeeId,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
    },
    select: { payGroupId: true },
  });
  if (!membership) return { state: "NO_PAY_GROUP" };

  // Find the pay period containing `asOf` — its half-open interval.
  const period = await prisma.payrollPayPeriod.findFirst({
    where: {
      clubId: principal.clubId, payGroupId: membership.payGroupId,
      periodStart: { lte: asOf },
      periodEnd:   { gt: asOf },
    },
  });
  if (!period) return { state: "NO_ACTIVE_PERIOD" };

  // Materialize on read so viewing the page reconciles state without
  // requiring a separate button.
  if (opts?.materialize !== false) {
    await materializeEmployeeTimesheet(principal.clubId, principal.employeeId, period.id);
  }
  return getTimesheetForPeriod(principal, period.id);
}

export async function getTimesheetForPeriod(
  principal: EmployeePortalPrincipal,
  payPeriodId: string,
): Promise<TimesheetPeriodView> {
  const [period, club, timesheet] = await Promise.all([
    prisma.payrollPayPeriod.findUniqueOrThrow({ where: { id: payPeriodId } }),
    prisma.club.findUnique({ where: { id: principal.clubId }, select: { timezone: true } }),
    prisma.payrollTimesheet.findUnique({
      where: {
        clubId_employeeId_payPeriodId: {
          clubId: principal.clubId, employeeId: principal.employeeId, payPeriodId,
        },
      },
      include: {
        entries: { orderBy: { clockInAt: "asc" } },
      },
    }),
  ]);
  if (period.clubId !== principal.clubId) {
    throw new NotFoundError("PayrollPayPeriod", payPeriodId);
  }

  // Read exceptions live from the event stream (do NOT persist them).
  // Payroll-3D-3 — respect supersession.
  const events = await prisma.timeClockEvent.findMany({
    where: {
      clubId: principal.clubId, employeeId: principal.employeeId,
      occurredAt: { gte: period.periodStart, lt: new Date(period.periodEnd.getTime() + 2 * DAY_MS) },
      supersededByEventId: null,
    },
    orderBy: { occurredAt: "asc" },
    select: { id: true, kind: true, occurredAt: true, employmentAssignmentId: true },
  });
  const { openSession, openBreak, sessions } = extractCompletedSessions(events, club?.timezone ?? null);
  const inPeriod = sessions.filter((s) => s.clockInAt >= period.periodStart && s.clockInAt < period.periodEnd);
  const exceptions: TimesheetException[] = [];
  if (openSession && openSession.clockInAt >= period.periodStart && openSession.clockInAt < period.periodEnd) {
    exceptions.push({
      kind: "MISSING_CLOCK_OUT",
      message: "You have an open work session with no matching Clock Out.",
      contextClockEventId: openSession.clockInEventId,
    });
  }
  if (openBreak) exceptions.push({
    kind: "OPEN_BREAK",
    message: "You have an open break with no matching Break End.",
    contextClockEventId: openBreak.breakStartEventId,
  });
  for (const s of inPeriod) {
    if (!s.employmentAssignmentId) exceptions.push({
      kind: "MISSING_ASSIGNMENT",
      message: "This session has no work assignment recorded.",
      contextClockEventId: s.clockInEventId,
    });
  }

  const entries = (timesheet?.entries ?? []).map((e) => ({
    id: e.id,
    workDate: e.workDate,
    clockInAt: e.clockInAt,
    clockOutAt: e.clockOutAt,
    recordedSeconds: e.recordedSeconds,
    breakSeconds: e.breakSeconds,
    employmentAssignmentId: e.employmentAssignmentId,
    earningClassification: e.earningClassification,
  }));
  const totalSeconds = entries.reduce((a, e) => a + e.recordedSeconds, 0);

  return {
    payPeriod: {
      id: period.id, taxYear: period.taxYear, sequenceInYear: period.sequenceInYear,
      periodStart: period.periodStart, periodEnd: period.periodEnd, payDate: period.payDate,
    },
    timesheetId: timesheet?.id ?? null,
    status: ((timesheet?.status ?? (exceptions.length ? "NEEDS_ATTENTION" : entries.length ? "READY_FOR_REVIEW" : "OPEN")) as TimesheetStatus),
    entries,
    exceptions,
    totalSeconds,
    clubTimezone: club?.timezone ?? null,
  };
}

// -------------------------------------------------------------------
// Historical periods list (recent N pay periods for this employee)
// -------------------------------------------------------------------
export async function listMyRecentPayPeriods(
  principal: EmployeePortalPrincipal,
  opts?: { limit?: number },
): Promise<Array<{ id: string; sequenceInYear: number; taxYear: number; periodStart: Date; periodEnd: Date; payDate: Date }>> {
  const membership = await prisma.payrollPayGroupMember.findFirst({
    where: { clubId: principal.clubId, employeeId: principal.employeeId },
    orderBy: { effectiveFrom: "desc" },
    select: { payGroupId: true },
  });
  if (!membership) return [];
  return prisma.payrollPayPeriod.findMany({
    where: { clubId: principal.clubId, payGroupId: membership.payGroupId },
    orderBy: { periodStart: "desc" },
    take: Math.min(Math.max(opts?.limit ?? 6, 1), 24),
    select: { id: true, sequenceInYear: true, taxYear: true, periodStart: true, periodEnd: true, payDate: true },
  });
}

/* Payroll-3D-2 unused import guard — keep TransactionClient available
 * for future 3D-3 extensions without churn. */
export type _TxClient = PrismaTypes.TransactionClient;

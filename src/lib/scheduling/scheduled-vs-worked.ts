// Scheduling Foundation · Phase D (2026-09-07) — scheduled-vs-worked
// reconciliation service.
//
// Founder amendment §11:
//   "Implement reconciliation as a dedicated read/service function,
//    not ad-hoc JSX logic. It should be possible later to reuse this
//    reconciliation for:
//      - manager schedule views
//      - overage Work Intake alerts
//      - payroll exception detection
//      - labour-budget reporting"
//
// Match rule (in priority order):
//   1. Same clubId + same employmentAssignmentId (§11 join key).
//   2. PayrollTimesheetEntry's ANCHOR_IN clock instant falls inside
//      [ shift.startAt - 6h, shift.endAt + 6h ). The overlap window
//      generously catches early clock-ins + late clock-outs while
//      still refusing an entry that belongs to a different shift.
//      The date-based match would misfire for overnight shifts
//      crossing midnight, per §11 warning.
//   3. Each PayrollTimesheetEntry can match AT MOST one shift; each
//      shift at most one entry. Ambiguity is resolved by choosing
//      the entry whose ANCHOR_IN is closest to shift.startAt.
//
// The service NEVER mutates either source (§11 orthogonality).

import { prisma } from "../prisma";

const OVERLAP_HALF_WINDOW_MS = 6 * 3600 * 1000;

export interface ReconciliationEntry {
  assignmentId: string;
  shiftId: string;
  shiftDate: Date;
  scheduledStart: Date;
  scheduledEnd: Date;
  scheduledSeconds: number;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  templateCode: string;
  templateName: string;
  positionId: string | null;
  positionName: string | null;
  // Worked-time reconciliation. `worked === null` means no matching
  // PayrollTimesheetEntry was found — either the employee didn't
  // clock this shift yet or the shift is still upcoming.
  worked: null | {
    payrollTimesheetEntryId: string;
    clockInAt: Date;
    clockOutAt: Date;
    workedSeconds: number;
  };
  /** worked.workedSeconds - scheduledSeconds; `null` when unmatched. */
  varianceSeconds: number | null;
}

export interface ReconciliationResult {
  windowStart: Date;
  windowEnd: Date;
  entries: ReconciliationEntry[];
}

/**
 * Reconcile scheduled shifts and worked-time entries for one
 * employee inside a [windowStart, windowEnd) instant window.
 *
 * The window bounds the SHIFT.startAt, not the shiftDate — an
 * overnight shift whose startAt is 23:30 on the last day of the
 * window will be included; one starting at 00:30 the next day
 * will not.
 */
export async function reconcileEmployeeScheduleWindow(
  clubId: string, employeeId: string,
  windowStart: Date, windowEnd: Date,
): Promise<ReconciliationResult> {
  // Read the assignments' shifts + the employee's worked entries in
  // the SAME window in parallel — both queries are scoped by clubId
  // for tenant isolation.
  const [assignments, workedEntries] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where: {
        clubId, employeeId,
        // Include REPLACED to show "gave up" cards in Recent shifts,
        // but Phase D scope is ASSIGNED only (Give Up ships Phase F).
        // Filter to ASSIGNED to keep Phase D output truthful.
        state: "ASSIGNED",
        shift: {
          clubId,
          state: "PUBLISHED",
          startAt: { gte: windowStart, lt: windowEnd },
        },
      },
      include: {
        shift: {
          include: {
            department: { select: { id: true, code: true, name: true } },
            shiftTemplate: { select: { code: true, name: true } },
            position: { select: { id: true, name: true } },
          },
        },
      },
    }),
    // Worked entries lookup: ANCHOR_IN provenance is the source of
    // truth for shift/entry timing. The PayrollTimesheetEntry stores
    // clockInAt + clockOutAt directly and links to the assignment.
    prisma.payrollTimesheetEntry.findMany({
      where: {
        clubId, employeeId,
        clockInAt: {
          gte: new Date(windowStart.getTime() - OVERLAP_HALF_WINDOW_MS),
          lt: new Date(windowEnd.getTime() + OVERLAP_HALF_WINDOW_MS),
        },
      },
      select: {
        id: true,
        employmentAssignmentId: true,
        clockInAt: true, clockOutAt: true,
        recordedSeconds: true,
      },
    }),
  ]);

  // Bucket worked entries by employmentAssignmentId for fast lookup.
  const workedByAssn = new Map<string, typeof workedEntries>();
  for (const w of workedEntries) {
    if (!w.employmentAssignmentId) continue;
    if (!workedByAssn.has(w.employmentAssignmentId)) {
      workedByAssn.set(w.employmentAssignmentId, []);
    }
    workedByAssn.get(w.employmentAssignmentId)!.push(w);
  }

  const usedEntryIds = new Set<string>();
  const entries: ReconciliationEntry[] = [];
  // Sort assignments by scheduledStart so ambiguous ties resolve
  // deterministically (earliest shift gets the closest entry first).
  const sortedAssignments = [...assignments].sort(
    (a, b) => a.shift.startAt.getTime() - b.shift.startAt.getTime(),
  );

  for (const a of sortedAssignments) {
    const scheduledStart = a.shift.startAt;
    const scheduledEnd = a.shift.endAt;
    const scheduledSeconds = Math.max(
      0, Math.floor((scheduledEnd.getTime() - scheduledStart.getTime()) / 1000),
    );

    // Candidate worked entries: same assignmentId + clockInAt inside
    // the scheduled window ± 6h + not already used by an earlier shift.
    const winFrom = scheduledStart.getTime() - OVERLAP_HALF_WINDOW_MS;
    const winTo = scheduledEnd.getTime() + OVERLAP_HALF_WINDOW_MS;
    const candidates = (workedByAssn.get(a.employmentAssignmentId) ?? [])
      .filter((w) => !usedEntryIds.has(w.id))
      .filter((w) => w.clockInAt.getTime() >= winFrom && w.clockInAt.getTime() < winTo);

    let matched: typeof workedEntries[number] | null = null;
    if (candidates.length) {
      // Pick the candidate whose clockInAt is closest to scheduledStart.
      candidates.sort((x, y) =>
        Math.abs(x.clockInAt.getTime() - scheduledStart.getTime())
        - Math.abs(y.clockInAt.getTime() - scheduledStart.getTime()),
      );
      matched = candidates[0];
      usedEntryIds.add(matched.id);
    }

    const workedSeconds = matched ? matched.recordedSeconds : null;
    entries.push({
      assignmentId: a.id,
      shiftId: a.shiftId,
      shiftDate: a.shift.shiftDate,
      scheduledStart,
      scheduledEnd,
      scheduledSeconds,
      departmentId: a.shift.department.id,
      departmentCode: a.shift.department.code,
      departmentName: a.shift.department.name,
      templateCode: a.shift.shiftTemplate.code,
      templateName: a.shift.shiftTemplate.name,
      positionId: a.shift.position?.id ?? null,
      positionName: a.shift.position?.name ?? null,
      worked: matched ? {
        payrollTimesheetEntryId: matched.id,
        clockInAt: matched.clockInAt,
        clockOutAt: matched.clockOutAt,
        workedSeconds: matched.recordedSeconds,
      } : null,
      varianceSeconds:
        workedSeconds != null ? workedSeconds - scheduledSeconds : null,
    });
  }
  return { windowStart, windowEnd, entries };
}

/**
 * Aggregate week-summary metrics from a reconciliation.
 *   scheduledSeconds — sum of every ASSIGNED shift's duration
 *   workedSeconds    — sum of every reconciled worked entry
 *   remainingSeconds — sum of ASSIGNED shifts whose start is in the
 *                      future OR that are unmatched (i.e. still to
 *                      be worked). Founder amendment §8: never
 *                      compute `remaining = scheduled - worked`;
 *                      it must represent duration of scheduled work
 *                      still ahead so over/under prior worked time
 *                      doesn't distort the number.
 */
export interface WeekSummary {
  scheduledSeconds: number;
  workedSeconds: number;
  remainingSeconds: number;
}
export function summariseReconciliation(
  r: ReconciliationResult, now: Date = new Date(),
): WeekSummary {
  let scheduled = 0, worked = 0, remaining = 0;
  for (const e of r.entries) {
    scheduled += e.scheduledSeconds;
    if (e.worked) worked += e.worked.workedSeconds;
    // "Remaining scheduled hours" = future + not-yet-worked shifts.
    // A completed shift with a matched worked entry drops out.
    if (!e.worked && e.scheduledEnd.getTime() > now.getTime()) {
      remaining += e.scheduledSeconds;
    } else if (!e.worked && e.scheduledStart.getTime() > now.getTime()) {
      // Future upcoming shift (also included by branch above; kept
      // for clarity — no double-count).
    }
  }
  return { scheduledSeconds: scheduled, workedSeconds: worked, remainingSeconds: remaining };
}

/**
 * Pick the "next shift" from a reconciliation — the earliest
 * ASSIGNED shift whose startAt is in the future (relative to `now`).
 * Returns null if no such shift exists.
 */
export function nextShift(
  r: ReconciliationResult, now: Date = new Date(),
): ReconciliationEntry | null {
  const future = r.entries
    .filter((e) => e.scheduledStart.getTime() > now.getTime())
    .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());
  return future[0] ?? null;
}

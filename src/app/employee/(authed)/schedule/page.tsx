// Scheduling Foundation · Phase D (2026-09-07) — My Schedule server
// component.
//
// Loads eligibility + weekly reconciliation data server-side and
// hands a serialised view to ScheduleView (client). Training-locked
// employees never see any shift data (server-side enforcement per §2).
//
// Route query params (all optional):
//   ?weekStart=YYYY-MM-DD   — Monday of the viewed week (defaults to
//                             the Monday of today).
//   ?view=week|month        — default `week`.
//   ?day=YYYY-MM-DD         — mobile-only selected-day highlight.

import { redirect } from "next/navigation";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { prisma } from "@/lib/prisma";
import {
  resolveEmployeeSchedulingEligibility,
} from "@/lib/hr/training/applicability";
import {
  reconcileEmployeeScheduleWindow,
  summariseReconciliation,
  nextShift as pickNextShift,
  type ReconciliationEntry,
} from "@/lib/scheduling/scheduled-vs-worked";
import { isoWeekStart, addDays } from "@/lib/scheduling/week-window";
import LockedState from "./LockedState";
import ScheduleView, { type ScheduleViewShift } from "./ScheduleView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RECENT_LOOKBACK_DAYS = 14;

function toViewShift(
  e: ReconciliationEntry,
  openOpportunity: { id: string; offeredAtIso: string } | null,
): ScheduleViewShift {
  return {
    assignmentId: e.assignmentId,
    shiftId: e.shiftId,
    shiftDateIso: e.shiftDate.toISOString(),
    scheduledStartIso: e.scheduledStart.toISOString(),
    scheduledEndIso: e.scheduledEnd.toISOString(),
    scheduledSeconds: e.scheduledSeconds,
    departmentCode: e.departmentCode,
    departmentName: e.departmentName,
    templateCode: e.templateCode,
    templateName: e.templateName,
    positionName: e.positionName,
    worked: e.worked ? {
      clockInIso: e.worked.clockInAt.toISOString(),
      clockOutIso: e.worked.clockOutAt.toISOString(),
      workedSeconds: e.worked.workedSeconds,
    } : null,
    varianceSeconds: e.varianceSeconds,
    openOpportunity,
  };
}

function parseWeekStartParam(raw: string | undefined): Date {
  if (!raw) return isoWeekStart(new Date());
  // YYYY-MM-DD → UTC midnight of that date, then anchor to its ISO week.
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return isoWeekStart(new Date());
  return isoWeekStart(parsed);
}

export default async function EmployeePortalSchedulePage({
  searchParams,
}: {
  searchParams?: {
    weekStart?: string; view?: string; day?: string;
    offered?: string; withdrawn?: string; picked?: string; err?: string;
  };
}) {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  // Server-side eligibility gate. Ineligible → LockedState. No shift
  // data is loaded or leaked.
  const eligibility = await resolveEmployeeSchedulingEligibility(principal.employeeId);
  const [employee, timeOffRoute] = await Promise.all([
    prisma.employee.findUnique({
      where: { id: principal.employeeId },
      select: { firstName: true, preferredName: true, compensationType: true },
    }),
    Promise.resolve(false), // /employee/time-off route does not exist yet (Phase D §9 truthful state)
  ]);
  if (!employee) redirect("/employee/login");

  if (!eligibility.eligible) {
    const totalApplicable = eligibility.applicable.filter((c) => c.version.required).length;
    const completedApplicable = eligibility.applicable.filter(
      (c) => c.version.required && c.completed,
    ).length;
    const outstanding = eligibility.outstandingTraining.map((o) => ({
      title: o.title, category: o.category,
    }));
    return (
      <LockedState
        completedCount={completedApplicable}
        totalCount={totalApplicable}
        outstanding={outstanding}
      />
    );
  }

  // Currently only hourly employees have Phase D schedule data. A
  // salaried employee is rendered a truthful "not applicable" panel
  // rather than a fake weekly grid (§3 amendment).
  if (employee.compensationType !== "HOURLY") {
    return (
      <div className="space-y-6" data-testid="portal-schedule-salaried-notice">
        <header>
          <h1 className="font-serif text-3xl text-club-ink">My Schedule</h1>
        </header>
        <section className="rounded-lg border border-stone-200 bg-white px-6 py-8">
          <p className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
            Salaried role
          </p>
          <p className="mt-2 text-sm text-stone-700 max-w-xl">
            Salaried employees don't work a shift-based schedule. Time in
            lieu and salaried scheduling views will be handled in a future
            release. In the meantime, use{" "}
            <a href="/employee/availability" className="underline underline-offset-4 text-club-green-800">
              Availability
            </a>{" "}
            to share your usual availability with your Club.
          </p>
        </section>
      </div>
    );
  }

  // Resolve week window + reconciliation.
  const now = new Date();
  const weekStart = parseWeekStartParam(searchParams?.weekStart);
  const weekEnd = addDays(weekStart, 7);
  const prevWeekStart = addDays(weekStart, -7);
  const nextWeekStart = addDays(weekStart, 7);
  const today = new Date();
  const view = searchParams?.view === "month" ? "month" : "week";

  const [reconciliation, recentReconciliation] = await Promise.all([
    reconcileEmployeeScheduleWindow(principal.clubId, principal.employeeId, weekStart, weekEnd),
    reconcileEmployeeScheduleWindow(
      principal.clubId, principal.employeeId,
      addDays(now, -RECENT_LOOKBACK_DAYS), now,
    ),
  ]);

  // Phase E — load OPEN ShiftOpportunities for the employee's own
  // shifts (both windows) so the ScheduleView cards render offered
  // state + the detail panel can withdraw.
  const openOpps = await prisma.shiftOpportunity.findMany({
    where: {
      clubId: principal.clubId,
      state: "OPEN",
      offeredByEmployeeId: principal.employeeId,
      shift: { state: "PUBLISHED" },
    },
    select: {
      id: true, offeredAt: true, offeredByAssignmentId: true,
    },
  });
  const oppByAssignmentId = new Map(
    openOpps.map((o) => [o.offeredByAssignmentId, { id: o.id, offeredAtIso: o.offeredAt.toISOString() }]),
  );

  const weekShifts = reconciliation.entries.map((e) =>
    toViewShift(e, oppByAssignmentId.get(e.assignmentId) ?? null),
  );
  const summary = summariseReconciliation(reconciliation, now);
  const nextShiftEntry = pickNextShift(reconciliation, now);
  // Recent list: worked shifts inside the lookback window that
  // reconciled to a PayrollTimesheetEntry, newest first.
  const recentShifts = recentReconciliation.entries
    .filter((e) => e.worked != null)
    .sort((a, b) => b.scheduledStart.getTime() - a.scheduledStart.getTime())
    .slice(0, 5)
    .map((e) => toViewShift(e, oppByAssignmentId.get(e.assignmentId) ?? null));

  const displayName = employee.preferredName?.trim().length
    ? employee.preferredName
    : employee.firstName;

  // Toast surface from server-action redirects.
  const toast =
      searchParams?.offered === "1"
        ? { kind: "success" as const, msg: "Shift offered. Waiting for a coworker." }
    : searchParams?.withdrawn === "1"
        ? { kind: "success" as const, msg: "Offer withdrawn. The shift is back on your schedule." }
    : searchParams?.picked
        ? { kind: "success" as const, msg: "Shift added to your schedule." }
    : searchParams?.err
        ? { kind: "error" as const, msg: searchParams.err }
    : null;

  return (
    <ScheduleView
      weekStartIso={weekStart.toISOString()}
      prevWeekStartIso={prevWeekStart.toISOString()}
      nextWeekStartIso={nextWeekStart.toISOString()}
      todayIso={isoWeekStart(today).toISOString()}
      view={view}
      weekShifts={weekShifts}
      scheduledSeconds={summary.scheduledSeconds}
      workedSeconds={summary.workedSeconds}
      remainingSeconds={summary.remainingSeconds}
      nextShift={nextShiftEntry ? toViewShift(nextShiftEntry, oppByAssignmentId.get(nextShiftEntry.assignmentId) ?? null) : null}
      recentShifts={recentShifts}
      employeeDisplayName={displayName ?? "there"}
      hasTimeOffRoute={timeOffRoute}
      toast={toast}
    />
  );
}

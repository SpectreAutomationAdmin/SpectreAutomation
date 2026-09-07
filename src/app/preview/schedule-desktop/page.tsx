// Dev-only preview route — renders the DESKTOP schedule with a
// hard-coded populated fixture, wrapped in a minimal portal-shell
// stand-in. Used for local visual iteration against
// docs/design/scheduling/employee-schedule-desktop-approved.png.
//
// NOT for production use. Never linked from the app.

import ScheduleView from "@/app/employee/(authed)/schedule/ScheduleView";
import EmployeePortalSidebar from "@/components/employee/EmployeePortalSidebar";
import EmployeePortalTopBar from "@/components/employee/EmployeePortalTopBar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const weekStartIso = "2026-09-07T00:00:00.000Z";
const prev = "2026-08-31T00:00:00.000Z";
const next = "2026-09-14T00:00:00.000Z";

function shift(dayOffsetDays: number, positionName: string, templateName: string, startH: number, startM: number, endH: number, endM: number, opts: { assignmentId: string; shiftId: string }) {
  const start = new Date(Date.UTC(2026, 8, 7 + dayOffsetDays, startH, startM, 0));
  const end   = new Date(Date.UTC(2026, 8, 7 + dayOffsetDays, endH,   endM,   0));
  return {
    assignmentId: opts.assignmentId,
    shiftId: opts.shiftId,
    shiftDateIso: new Date(Date.UTC(2026, 8, 7 + dayOffsetDays, 0, 0, 0)).toISOString(),
    scheduledStartIso: start.toISOString(),
    scheduledEndIso: end.toISOString(),
    scheduledSeconds: Math.round((end.getTime() - start.getTime()) / 1000),
    departmentCode: "EVENTS",
    departmentName: "Events",
    templateCode: templateName.toUpperCase().replace(/\s+/g, "-"),
    templateName,
    positionName,
    worked: null,
    varianceSeconds: null,
    openOpportunity: null,
  } as const;
}

// Concept-matched shift pattern:
// Mon 7  empty, Tue 8 Day Shift 11-5:30, Wed 9 Evening 5:30-11, Thu 10 Evening 5:30-11,
// Fri 11 Evening 5:30-11, Sat 12 Bartender Evening 5:30-Close, Sun 13 empty.
const weekShifts = [
  shift(1, "Server",    "Day Shift",     11, 0,  17, 30, { assignmentId: "prev-a1", shiftId: "prev-s1" }),
  shift(2, "Server",    "Evening Shift", 17, 30, 23, 0,  { assignmentId: "prev-a2", shiftId: "prev-s2" }),
  shift(3, "Server",    "Evening Shift", 17, 30, 23, 0,  { assignmentId: "prev-a3", shiftId: "prev-s3" }),
  shift(4, "Server",    "Evening Shift", 17, 30, 23, 0,  { assignmentId: "prev-a4", shiftId: "prev-s4" }),
  shift(5, "Bartender", "Evening Shift", 17, 30, 23, 30, { assignmentId: "prev-a5", shiftId: "prev-s5" }),
];

const nextShift = weekShifts[0]; // Tue Sep 8 · Server · Day Shift 11-5:30 → matches concept

const recent = [{
  assignmentId: "prev-recent-1",
  shiftId: "prev-recent-shift-1",
  shiftDateIso: "2026-08-31T00:00:00.000Z",
  scheduledStartIso: "2026-08-31T11:00:00.000Z",
  scheduledEndIso:   "2026-08-31T17:30:00.000Z",
  scheduledSeconds: 6 * 3600 + 30 * 60,
  departmentCode: "EVENTS",
  departmentName: "Events",
  templateCode: "DAY",
  templateName: "Day Shift",
  positionName: "Server",
  worked: {
    clockInIso:  "2026-08-31T10:58:00.000Z",
    clockOutIso: "2026-08-31T17:42:00.000Z",
    workedSeconds: 6 * 3600 + 44 * 60,
  },
  varianceSeconds: 14 * 60,
  openOpportunity: null,
} as const];

export default function ScheduleDesktopPreview() {
  return (
    <div className="hidden md:flex min-h-screen bg-club-cream" data-testid="portal-desktop-shell">
      <EmployeePortalSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <EmployeePortalTopBar
          clubName="Coulee Ridge Golf & Country Club"
          displayName="Taylor Hourly"
          givenName="Taylor"
          employeeNumber="EMP-0001"
          hasPhoto={false}
          photoVersion={null}
        />
        <main className="flex-1 min-w-0 flex flex-col">
          <ScheduleView
            weekStartIso={weekStartIso}
            prevWeekStartIso={prev}
            nextWeekStartIso={next}
            todayIso={weekStartIso}
            view="week"
            weekShifts={weekShifts as any}
            scheduledSeconds={(18 * 3600) + (30 * 60)}
            workedSeconds={(6 * 3600) + (34 * 60)}
            remainingSeconds={(11 * 3600) + (56 * 60)}
            nextShift={nextShift as any}
            recentShifts={recent as any}
            employeeDisplayName="Taylor"
            hasTimeOffRoute={false}
            toast={null}
          />
        </main>
      </div>
    </div>
  );
}

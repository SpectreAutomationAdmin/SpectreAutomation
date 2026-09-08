// Dev-only functional preview — renders the REAL production
// ScheduleView with hard-coded prop shapes matching the reference
// concept, so we can verify locally that the desktop presentation
// layer visually matches the approved shell BEFORE any staging deploy.
//
// This route does NOT touch the real Schedule route, does NOT use
// live data, and is not linked from any production surface.

import ScheduleView, {
  type ScheduleViewShift,
} from "@/app/employee/(authed)/schedule/ScheduleView";
import EmployeePortalSidebar from "@/components/employee/EmployeePortalSidebar";
import EmployeePortalTopBar from "@/components/employee/EmployeePortalTopBar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const weekStartIso = "2026-09-07T00:00:00.000Z";
const prev = "2026-08-31T00:00:00.000Z";
const next = "2026-09-14T00:00:00.000Z";

function makeShift(
  dayOffsetDays: number,
  positionName: string,
  templateName: string,
  startH: number, startM: number,
  endH: number, endM: number,
  opts: { assignmentId: string; shiftId: string },
): ScheduleViewShift {
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
  };
}

const weekShifts: ScheduleViewShift[] = [
  makeShift(1, "Server",    "Day Shift",     11, 0,  17, 30, { assignmentId: "fn-a1", shiftId: "fn-s1" }),
  makeShift(2, "Server",    "Evening Shift", 17, 30, 23, 0,  { assignmentId: "fn-a2", shiftId: "fn-s2" }),
  makeShift(3, "Server",    "Evening Shift", 17, 30, 23, 0,  { assignmentId: "fn-a3", shiftId: "fn-s3" }),
  makeShift(4, "Server",    "Evening Shift", 17, 30, 23, 0,  { assignmentId: "fn-a4", shiftId: "fn-s4" }),
  makeShift(5, "Bartender", "Evening Shift", 17, 30, 23, 30, { assignmentId: "fn-a5", shiftId: "fn-s5" }),
];

const nextShift = weekShifts[0];

const recent: ScheduleViewShift[] = [{
  assignmentId: "fn-recent-1",
  shiftId: "fn-recent-shift-1",
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
}];

export default function ScheduleFunctionalPreview() {
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
            weekShifts={weekShifts}
            scheduledSeconds={(18 * 3600) + (30 * 60)}
            workedSeconds={(6 * 3600) + (34 * 60)}
            remainingSeconds={(11 * 3600) + (56 * 60)}
            nextShift={nextShift}
            recentShifts={recent}
            employeeDisplayName="Taylor"
            hasTimeOffRoute={false}
            toast={null}
          />
        </main>
      </div>
    </div>
  );
}

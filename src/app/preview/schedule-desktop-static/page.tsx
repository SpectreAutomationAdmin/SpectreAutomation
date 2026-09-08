// Isolated static desktop Schedule prototype.
// Reproduces docs/design/scheduling/employee-schedule-desktop-1440x900-approved.png
// as closely as possible for founder review.
//
// STATIC. No data binding. No real handlers. No responsive
// behavior. Intentionally isolated from the production ScheduleView
// implementation.
//
// Reachable at /preview/schedule-desktop-static — never linked from
// the app. Delete or rewrite freely without affecting any real
// scheduling behavior.

import StaticScheduleDesktop from "./StaticScheduleDesktop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function StaticScheduleDesktopPreview() {
  return <StaticScheduleDesktop />;
}

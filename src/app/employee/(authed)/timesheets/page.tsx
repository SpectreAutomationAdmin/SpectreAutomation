// Payroll-3D-2 (2026-09-05) — Employee Portal Timesheet page.
//
// Server component: resolves the portal principal, materializes the
// current pay period timesheet on read (idempotent), returns the
// view + pending corrections to the client. Salaried employees
// (NO_TIME_ENTRY_REQUIRED) see a friendly non-interactive message
// so nobody thinks their salary is broken.

import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { getMyCurrentTimesheet } from "@/lib/timesheets/service";
import { listMyCorrectionRequests } from "@/lib/timesheets/correction-service";
import TimesheetClient from "./TimesheetClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmployeePortalTimesheetPage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  // Timekeeping method gates whether we render the interactive UI.
  const emp = await prisma.employee.findUniqueOrThrow({
    where: { id: principal.employeeId },
    select: { timekeepingMethod: true },
  });

  const nonInteractive = emp.timekeepingMethod !== "CLOCK_REQUIRED";
  if (nonInteractive) {
    return (
      <div className="max-w-2xl">
        <nav className="mb-4 text-xs">
          <Link href="/employee" className="text-stone-500 underline">← Home</Link>
        </nav>
        <h1 className="font-serif text-3xl text-club-ink">Timesheet</h1>
        <div className="mt-4 rounded-lg border border-stone-200 bg-white p-4"
             data-testid="portal-timesheet-non-interactive">
          <p className="text-sm text-stone-700">
            Time entry is not required for your role. If you believe this is a mistake, please
            contact your manager.
          </p>
        </div>
      </div>
    );
  }

  const timesheet = await getMyCurrentTimesheet(principal, { materialize: true });
  if ("state" in timesheet) {
    return (
      <div className="max-w-2xl">
        <nav className="mb-4 text-xs">
          <Link href="/employee" className="text-stone-500 underline">← Home</Link>
        </nav>
        <h1 className="font-serif text-3xl text-club-ink">Timesheet</h1>
        <div className="mt-4 rounded-lg border border-stone-200 bg-white p-4"
             data-testid="portal-timesheet-no-period">
          <p className="text-sm text-stone-700">
            {timesheet.state === "NO_PAY_GROUP"
              ? "You are not currently assigned to a pay group. Contact your manager if you believe this is a mistake."
              : "There is no active pay period for your pay group right now."}
          </p>
        </div>
      </div>
    );
  }

  // Pending + recently-cancelled corrections (limit to short window).
  const pending = await listMyCorrectionRequests(principal, { status: "PENDING", limit: 20 });

  const view = {
    payPeriod: {
      id: timesheet.payPeriod.id,
      taxYear: timesheet.payPeriod.taxYear,
      sequenceInYear: timesheet.payPeriod.sequenceInYear,
      periodStartIso: timesheet.payPeriod.periodStart.toISOString(),
      periodEndIso:   timesheet.payPeriod.periodEnd.toISOString(),
      payDateIso:     timesheet.payPeriod.payDate.toISOString(),
    },
    status: timesheet.status,
    entries: timesheet.entries.map((e) => ({
      id: e.id,
      workDateIso: e.workDate.toISOString(),
      clockInIso:  e.clockInAt.toISOString(),
      clockOutIso: e.clockOutAt.toISOString(),
      recordedSeconds: e.recordedSeconds,
      breakSeconds:    e.breakSeconds,
      employmentAssignmentId: e.employmentAssignmentId,
    })),
    exceptions: timesheet.exceptions,
    totalSeconds: timesheet.totalSeconds,
    clubTimezone: timesheet.clubTimezone,
    pendingCorrections: pending.map((c) => ({
      id: c.id,
      requestType: c.requestType,
      originalClockEventId: c.originalClockEventId,
      requestedOccurredAtIso: c.requestedOccurredAt?.toISOString() ?? null,
      reason: c.reason,
      status: c.status,
      createdAtIso: c.createdAt.toISOString(),
    })),
  };

  return (
    <TimesheetClient
      view={view}
      employmentAssignmentId={null}
    />
  );
}

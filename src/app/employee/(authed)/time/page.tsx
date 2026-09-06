// Payroll-3D-1 (2026-09-05) — Employee Portal Time & Attendance page.
//
// Server component: resolves the portal principal, reads current
// clock state + recent events + Club timezone, hands the client
// component the initial state. Follows the same architecture as
// /employee/pay (server-resolved principal → domain lib → client).

import { redirect } from "next/navigation";
import Link from "next/link";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { prisma } from "@/lib/prisma";
import {
  getMyClockState,
  listMyRecentClockEvents,
} from "@/lib/timeclock/service";
import TimeClockClient from "./TimeClockClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmployeePortalTimePage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  const [state, history, club, assignments] = await Promise.all([
    getMyClockState(principal),
    listMyRecentClockEvents(principal, { limit: 20 }),
    prisma.club.findUnique({
      where: { id: principal.clubId },
      select: { timezone: true },
    }),
    // Payroll-3D-3A — active assignments for the picker. Only fetched
    // for CLOCK_REQUIRED employees; the shape is safe for any role
    // (client only renders the picker when >1 assignments exist).
    prisma.employeeEmploymentAssignment.findMany({
      where: {
        clubId: principal.clubId,
        employeeId: principal.employeeId,
        effectiveFrom: { lte: new Date() },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
      },
      orderBy: [{ role: "asc" }, { effectiveFrom: "asc" }],
      select: {
        id: true, role: true,
        department: { select: { code: true, name: true } },
      },
    }),
  ]);

  return (
    <div className="max-w-3xl">
      <nav className="mb-4 flex items-center justify-between text-xs">
        <Link href="/employee" className="text-stone-500 underline">
          ← Home
        </Link>
        <Link href="/employee/timesheets" className="text-stone-500 underline">
          Timesheet →
        </Link>
      </nav>

      <header className="mb-6 border-b border-stone-200 pb-4">
        <h1 className="font-serif text-3xl text-club-ink">Clock In / Out</h1>
        <p className="mt-1 text-sm text-stone-500">
          Record your work time. Recorded time is reviewed by your manager before it becomes
          payroll-approved hours.
        </p>
      </header>

      <TimeClockClient
        initialState={{
          state:                       state.state,
          currentSessionStart:         state.currentSessionStart?.toISOString() ?? null,
          currentBreakStart:           state.currentBreakStart?.toISOString()   ?? null,
          currentSessionBreakSeconds:  state.currentSessionBreakSeconds,
          onBreak:                     state.onBreak,
          timekeepingMethod:           state.timekeepingMethod,
          currentSessionAssignmentId:  state.currentSessionAssignmentId ?? null,
        }}
        history={history.map((e) => ({
          id:         e.id,
          kind:       e.kind as "CLOCK_IN" | "CLOCK_OUT" | "BREAK_START" | "BREAK_END",
          occurredAt: e.occurredAt.toISOString(),
        }))}
        clubTimezone={club?.timezone ?? null}
        now={new Date().toISOString()}
        activeAssignments={assignments.map((a) => ({
          id: a.id,
          roleLabel: a.role,
          departmentCode: a.department?.code ?? null,
          departmentName: a.department?.name ?? null,
        }))}
      />
    </div>
  );
}

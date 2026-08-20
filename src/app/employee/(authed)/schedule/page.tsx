// HR-2B.5 §35 (2026-08-19) — Schedule area.

import { redirect } from "next/navigation";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmployeePortalSchedulePage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  return (
    <div data-testid="portal-schedule">
      <h1 className="font-serif text-3xl text-club-ink">Schedule</h1>
      <p className="mt-2 text-sm text-stone-500">
        Your upcoming shifts and work schedule will appear here.
      </p>
      <div
        className="mt-8 rounded-lg border border-dashed border-stone-300 bg-white px-6 py-10 text-center"
        data-testid="portal-schedule-empty"
      >
        <p className="text-sm text-stone-600">No shifts scheduled.</p>
        <p className="mt-2 text-xs text-stone-500">
          When your Club publishes your schedule, your shifts will appear here.
        </p>
      </div>
    </div>
  );
}

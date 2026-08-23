// HR-2C B4 (2026-08-23) — Schedule page.
//
// Spectre does not yet ship a scheduling engine; when it does, this
// page will render the employee's upcoming shifts. Meanwhile the
// page surfaces the canonical scheduling-eligibility state so an
// employee understands whether training is blocking future
// scheduling. Ineligibility here does NOT hide the page (§7 —
// "may VIEW Schedule") and never hides historical shifts (there
// are none to render yet).

import { redirect } from "next/navigation";
import Link from "next/link";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { getSchedulingEligibilitySummary } from "@/lib/hr/scheduling-eligibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmployeePortalSchedulePage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  const eligibility = await getSchedulingEligibilitySummary(principal.employeeId);

  return (
    <div className="space-y-8" data-testid="portal-schedule">
      <header>
        <h1 className="font-serif text-3xl text-club-ink">Schedule</h1>
        <p className="mt-2 text-sm text-stone-500">
          Your upcoming shifts and work schedule will appear here.
        </p>
      </header>

      {!eligibility.eligible && (
        <section
          className="rounded-lg border border-amber-200 bg-amber-50/70 px-5 py-4"
          data-testid="portal-schedule-eligibility"
        >
          <div className="text-[11px] uppercase tracking-[0.2em] text-amber-800">
            Scheduling eligibility
          </div>
          <p className="mt-1 text-sm text-amber-900">
            Complete{" "}
            <strong data-testid="portal-schedule-outstanding-count">
              {eligibility.outstanding.length}
            </strong>{" "}
            required training{" "}
            {eligibility.outstanding.length === 1 ? "course" : "courses"} before
            you can be scheduled for new shifts.
          </p>
          <div className="mt-3">
            <Link
              href="/employee/safety-training"
              className="text-xs uppercase tracking-[0.16em] text-club-green-800 hover:text-club-green-900 underline underline-offset-4"
              data-testid="portal-schedule-cta-training"
            >
              Open Safety &amp; Training
            </Link>
          </div>
        </section>
      )}

      <div
        className="rounded-lg border border-dashed border-stone-300 bg-white px-6 py-10 text-center"
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

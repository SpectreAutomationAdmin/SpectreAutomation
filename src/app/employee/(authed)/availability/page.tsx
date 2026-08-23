// HR-2C B4 (2026-08-23) — Availability page.
//
// Two states:
//   * Eligible → real weekly-availability form (7 checkboxes + notes)
//     driven by `saveAvailabilityAction`. Existing weeks render as
//     an editable list.
//   * Ineligible → "Training required" panel with the outstanding
//     required course titles + CTA to /employee/safety-training.
//     Existing availability, if any, still renders as read-only per
//     §3 ("Existing availability, if any, remains visible but
//     read-only").
//
// The server action is guarded by the canonical
// `assertSchedulingEligibility` — a crafted POST cannot bypass the
// gate even if this page renders the form.

import { redirect } from "next/navigation";
import Link from "next/link";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { getSchedulingEligibilitySummary } from "@/lib/hr/scheduling-eligibility";
import {
  listAvailabilityWeeks,
  currentWeekStart,
} from "@/lib/hr/availability";
import { saveAvailabilityAction } from "./_actions";
import AvailabilityWeekForm from "./AvailabilityWeekForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatWeekRange(mon: Date): string {
  const sun = new Date(mon);
  sun.setUTCDate(sun.getUTCDate() + 6);
  const monLabel = mon.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const sunLabel = sun.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${monLabel} – ${sunLabel}`;
}

export default async function EmployeePortalAvailabilityPage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  const [eligibility, weeks] = await Promise.all([
    getSchedulingEligibilitySummary(principal.employeeId),
    listAvailabilityWeeks(principal, { limit: 8 }),
  ]);
  const thisWeek = currentWeekStart();
  const hasThisWeek = weeks.some((w) => w.weekStart.getTime() === thisWeek.getTime());

  return (
    <div className="space-y-8" data-testid="portal-availability">
      <header>
        <h1 className="font-serif text-3xl text-club-ink">Availability</h1>
        <p className="mt-2 text-sm text-stone-500">
          Let your Club know which days you&rsquo;re available to work.
        </p>
      </header>

      {!eligibility.eligible && (
        <section
          className="rounded-lg border border-amber-200 bg-amber-50/70 px-5 py-5"
          data-testid="portal-availability-training-required"
        >
          <h2 className="font-serif text-lg text-club-ink">Training required</h2>
          <p className="mt-2 text-sm text-amber-900">
            Complete your required Safety &amp; Training before submitting your
            availability.
          </p>
          {eligibility.outstanding.length > 0 && (
            <ul
              className="mt-3 text-sm text-stone-800 list-disc pl-5 space-y-1"
              data-testid="portal-availability-outstanding"
            >
              {eligibility.outstanding.map((c) => (
                <li key={c.courseId}>
                  <span className="font-medium">{c.title}</span>
                  <span className="text-stone-500"> · {c.category}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4">
            <Link
              href="/employee/safety-training"
              className="btn btn-primary"
              data-testid="portal-availability-cta-training"
            >
              Complete required training
            </Link>
          </div>
        </section>
      )}

      {eligibility.eligible && !hasThisWeek && (
        <section
          className="rounded-lg border border-stone-200 bg-white p-5"
          data-testid="portal-availability-form-this-week"
        >
          <h2 className="font-serif text-lg text-club-ink">This week</h2>
          <p className="mt-1 text-xs text-stone-500">
            {formatWeekRange(thisWeek)}
          </p>
          <AvailabilityWeekForm
            weekStart={thisWeek.toISOString()}
            initial={null}
            action={saveAvailabilityAction}
            editable={true}
          />
        </section>
      )}

      <section data-testid="portal-availability-weeks">
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
          {weeks.length === 0 ? "Your availability" : "Your saved availability"}
        </h2>
        {weeks.length === 0 ? (
          <div
            className="mt-3 rounded-lg border border-dashed border-stone-300 bg-white px-6 py-8 text-center"
            data-testid="portal-availability-empty"
          >
            <p className="text-sm text-stone-600">
              {eligibility.eligible
                ? "No availability submitted yet. Use the form above to submit this week."
                : "You haven't submitted any availability yet."}
            </p>
          </div>
        ) : (
          <ul className="mt-3 space-y-3">
            {weeks.map((w) => (
              <li
                key={w.id}
                className="rounded-lg border border-stone-200 bg-white p-5"
                data-testid={`portal-availability-week-${w.weekStart.toISOString().slice(0, 10)}`}
              >
                <div className="text-sm font-medium text-club-ink">
                  {formatWeekRange(w.weekStart)}
                </div>
                <AvailabilityWeekForm
                  weekStart={w.weekStart.toISOString()}
                  initial={w}
                  action={saveAvailabilityAction}
                  // Existing rows visible even when ineligible, but
                  // read-only. Editable only when eligible.
                  editable={eligibility.eligible}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// HR-2C §5, §21 (2026-08-20) — Employee Portal Safety & Training landing.
//
// Slice A2 lands the nav item + placeholder page so the tour anchor is
// real. The full course dashboard (course cards, required vs completed,
// video player + quiz) arrives with slice B3. Until then the page
// shows a truthful "no training assigned yet" state — never a fake
// list of courses (§50).

import { redirect } from "next/navigation";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmployeePortalSafetyTrainingPage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  return (
    <div data-testid="portal-safety-training">
      <h1 className="font-serif text-3xl text-club-ink">Safety &amp; Training</h1>
      <p className="mt-2 text-sm text-stone-500">
        Your Club&rsquo;s required training and safety courses appear here.
      </p>
      <div
        className="mt-8 rounded-lg border border-dashed border-stone-300 bg-white px-6 py-10 text-center"
        data-testid="portal-safety-training-empty"
      >
        <p className="text-sm text-stone-600">
          No training has been assigned to you yet.
        </p>
        <p className="mt-2 text-xs text-stone-500">
          When your Club assigns a course, it will appear here.
        </p>
      </div>
    </div>
  );
}

// HR-2B.5 §36 (2026-08-19) — Availability area.
//
// Availability submission engine not built. Do not fabricate save
// controls (§36). Truthful empty state only.

import { redirect } from "next/navigation";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmployeePortalAvailabilityPage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  return (
    <div data-testid="portal-availability">
      <h1 className="font-serif text-3xl text-club-ink">Availability</h1>
      <p className="mt-2 text-sm text-stone-500">
        Let your Club know when you&rsquo;re available to work.
      </p>
      <div
        className="mt-8 rounded-lg border border-dashed border-stone-300 bg-white px-6 py-10 text-center"
        data-testid="portal-availability-empty"
      >
        <p className="text-sm text-stone-600">
          Availability submissions aren&rsquo;t open yet at your Club.
        </p>
        <p className="mt-2 text-xs text-stone-500">
          When they open, you&rsquo;ll be able to submit your weekly availability here.
        </p>
      </div>
    </div>
  );
}

// HR-2B.1 (2026-08-18) — Employee onboarding session continuation.
// HR-2B.2 (2026-08-18) — Redirects into the About You conversational flow.
//
// After a successful invitation redemption the welcome page routes
// here. In HR-2B.1 this was a placeholder ("You're in!"); in HR-2B.2
// it's a thin router that resolves the employee's actor and jumps
// them into the first incomplete About You step. If the actor is
// gone (session revoked, invitation expired, cookie cleared) they
// land on the neutral expired page.

import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HrOnboardingSessionEntry() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");
  redirect("/hr/onboarding/about-you");
}

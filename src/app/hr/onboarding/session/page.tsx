// HR-2B.1 (2026-08-18) — Employee onboarding session continuation.
// HR-2B.2 (2026-08-18) — Redirects into the About You conversational flow.
// HR-2B.3.2 §2 (2026-08-18) — Routes to the CANONICAL next incomplete
// step (may be anywhere in About You OR Payroll) rather than always
// entering at /about-you. Founder-mandated: an invitation is a
// continuation link, not a wizard entrance.

import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { resolveOnboardingContinuation } from "@/lib/hr/onboarding-continuation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HrOnboardingSessionEntry() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");
  const target = await resolveOnboardingContinuation({
    sessionId: actor.sessionId,
    employeeId: actor.employeeId,
    clubId: actor.clubId,
  });
  redirect(target);
}

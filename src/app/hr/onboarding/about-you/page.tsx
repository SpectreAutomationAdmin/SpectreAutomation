// HR-2B.2 (2026-08-18) — About You hub.
// HR-2B.3.2 §2 (2026-08-18) — Delegates to the canonical
// `resolveOnboardingContinuation` so /about-you hub and every other
// entry point return the same next-incomplete-step decision. The
// hub keeps the URL semantic — the employee never sees this route
// render its own content.

import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { resolveOnboardingContinuation } from "@/lib/hr/onboarding-continuation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AboutYouHub() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");
  const target = await resolveOnboardingContinuation({
    sessionId: actor.sessionId,
    employeeId: actor.employeeId,
    clubId: actor.clubId,
  });
  redirect(target);
}

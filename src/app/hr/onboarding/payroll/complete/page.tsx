// HR-2B.3 (2026-08-19) — Payroll · Complete.
// HR-2B.5 blocker fix (2026-08-20) — This page was the obsolete
// HR-2B.3 phase boundary that stranded a founder on staging with a
// disabled "Continue (available soon)" button after Provincial TD1.
//
// It is now a PURE FORWARD ROUTER — it never renders its own final
// content. Any legitimate visit (a stale bookmark, an old email link
// from HR-2B.3) delegates to `resolveOnboardingContinuation()` and
// redirects to the true next incomplete step (Emergency in the
// normal HR-2B.4+ flow, Portal Password / Review / Complete for
// employees further along).
//
// Do NOT reintroduce a static terminal card here. Every progression
// from Payroll onward must flow through the canonical continuation
// authority. See src/lib/hr/onboarding-continuation.ts.

import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { resolveOnboardingContinuation } from "@/lib/hr/onboarding-continuation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PayrollCompleteForwarder() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");
  const next = await resolveOnboardingContinuation({
    sessionId: actor.sessionId,
    employeeId: actor.employeeId,
    clubId: actor.clubId,
  });
  // Guard against the resolver ever returning back here (would loop);
  // in that case route to the session entrypoint which always makes
  // forward progress.
  if (next === "/hr/onboarding/payroll/complete") {
    redirect("/hr/onboarding/session");
  }
  redirect(next);
}

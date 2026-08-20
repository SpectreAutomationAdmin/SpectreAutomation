// HR-2B.4 (2026-08-19) — Post-Documents boundary page.
// HR-2B.5 (2026-08-19) — Boundary superseded by /hr/onboarding/review.
//
// This page is now a pure forward-router: it defers to the canonical
// continuation resolver and redirects to whatever step is actually
// next (portal-password when the credential isn't set, review when it
// is, complete when the session has been submitted). It never
// renders its own final content — kept only so bookmarked or older
// email links don't 404.

import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { resolveOnboardingContinuation } from "@/lib/hr/onboarding-continuation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ReadyForReviewStep() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  // HR-2B.5 — unconditional forward-router. The canonical resolver
  // decides the real destination; a legacy bookmark to this URL now
  // resolves to portal-password / review / complete as appropriate.
  const next = await resolveOnboardingContinuation({
    sessionId: actor.sessionId,
    employeeId: actor.employeeId,
    clubId: actor.clubId,
  });
  if (next !== "/hr/onboarding/ready-for-review") redirect(next);

  // Fall-through render — only reachable if the resolver itself
  // pathologically returns this URL (which it no longer does).
  // HR-2B.5 blocker fix (2026-08-20) — Defensive-only render. The
  // canonical resolver never routes here (this URL is a legacy
  // HR-2B.4 boundary superseded by /hr/onboarding/review). The forward
  // redirect above should always fire; this render only exists to
  // avoid a runtime crash on the vanishingly small "resolver returned
  // this exact URL" edge case. Route the user through the session
  // entrypoint so they always end up somewhere productive.
  redirect("/hr/onboarding/session");
}

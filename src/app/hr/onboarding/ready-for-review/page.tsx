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
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { resolveOnboardingContinuation } from "@/lib/hr/onboarding-continuation";
import PostPayrollShell from "../_post-payroll-shell";

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
  return (
    <PostPayrollShell
      actor={actor}
      currentSection="ready-for-review"
      headline="Everything we've asked for so far is complete."
      subhead="Your final review is coming next."
    >
      <article
        className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10"
        data-testid="ready-for-review"
      >
        <h2 className="font-serif text-2xl leading-tight text-stone-900">
          Thanks — that&apos;s the last piece for now.
        </h2>
        <p className="mt-3 text-sm text-stone-500 leading-relaxed">
          You&apos;ve completed every section your Club has asked you to fill in.
          The final review and submission step will be available shortly.
          You can close this window; your progress is saved and you&apos;ll be
          able to return through your original invitation link.
        </p>
        <div className="mt-6 flex items-center gap-3">
          <Link
            href="/hr/onboarding/emergency"
            className="text-sm text-stone-500 hover:text-stone-800"
            data-testid="ready-for-review-emergency-link"
          >
            &larr; Revisit Emergency
          </Link>
          <Link
            href="/hr/onboarding/documents"
            className="text-sm text-stone-500 hover:text-stone-800"
            data-testid="ready-for-review-documents-link"
          >
            &larr; Revisit Documents
          </Link>
        </div>
      </article>
    </PostPayrollShell>
  );
}

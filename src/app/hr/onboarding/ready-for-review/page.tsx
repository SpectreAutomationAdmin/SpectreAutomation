// HR-2B.4 (2026-08-19) — Post-Documents boundary page.
//
// HR-2B.5 will replace this with the real /hr/onboarding/review + Submit
// action. For HR-2B.4 the boundary is a truthful "your final review is
// coming next" copy — never a fake Submit button.

import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import {
  isDocumentsSectionComplete,
  isEmergencySectionComplete,
} from "@/lib/hr/onboarding-requirements";
import { resolveOnboardingContinuation } from "@/lib/hr/onboarding-continuation";
import PostPayrollShell from "../_post-payroll-shell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ReadyForReviewStep() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  // Defensive: if the employee lands here early (via direct URL), route
  // them to the actual next incomplete step. The canonical resolver
  // does exactly this computation.
  const [emergencyDone, documentsDone] = await Promise.all([
    isEmergencySectionComplete(actor),
    isDocumentsSectionComplete(actor),
  ]);
  if (!emergencyDone || !documentsDone) {
    const next = await resolveOnboardingContinuation({
      sessionId: actor.sessionId,
      employeeId: actor.employeeId,
      clubId: actor.clubId,
    });
    if (next !== "/hr/onboarding/ready-for-review") redirect(next);
  }

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

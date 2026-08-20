// HR-2B.5 §31 (2026-08-19) — Post-onboarding-Submit portal handoff.
//
// The onboarding-complete page's primary CTA links here. This page
// stamps the permanent Employee Portal cookie from the onboarding
// actor's identity (no password re-entry — the employee just proved
// possession by completing onboarding) and hands them off to
// `/employee`.
//
// Renders a tiny "preparing your portal" panel with a form that
// auto-submits via a client-side effect — the CTA button is also
// present in case the auto-submit is blocked.

import { handoffFromOnboardingAction } from "../../_login-actions";
import HandoffAutoSubmit from "./HandoffAutoSubmit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function OnboardingHandoffPage() {
  return (
    <main className="min-h-screen bg-stone-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-lg border border-stone-200 bg-white px-8 py-10 text-center">
        <h1 className="font-serif text-2xl text-club-ink">Opening your portal…</h1>
        <p className="mt-3 text-sm text-stone-500">
          One moment while we set up your access.
        </p>
        <form action={handoffFromOnboardingAction} className="mt-6">
          <HandoffAutoSubmit />
          <button
            type="submit"
            className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900"
            data-testid="employee-handoff-submit"
          >
            Continue
          </button>
        </form>
      </div>
    </main>
  );
}

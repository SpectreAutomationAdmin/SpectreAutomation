// HR-2B.5 §29-31 (2026-08-19) — Post-submit terminal page.
//
// The session is SUBMITTED (or a downstream terminal state). The
// employee is not sent to a dead "you're done" screen — this page
// hands them off to the permanent Employee Portal (§31).
//
// The onboarding session cookie is deliberately NOT consumed here.
// A real "handoff" to the Employee Portal — which stamps the
// spectre_employee_session cookie — lives at
// /employee/login/handoff-from-onboarding (slice 6). Users can also
// go there directly (the "Continue to your employee portal" CTA
// links straight to that route).

import { redirect } from "next/navigation";
import Link from "next/link";
import { getEmployeeOnboardingSession } from "@/lib/hr/employee-onboarding-session";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function OnboardingCompletePage() {
  // HR-2B.5 §31 (2026-08-19) — This page must accept TERMINAL session
  // states (SUBMITTED / APPROVED / REJECTED). The canonical
  // `resolveEmployeeOnboardingActor()` intentionally rejects
  // non-resumable states to lock down mutation surfaces (§46), so it
  // is the wrong guard here. Read the cookie directly and validate
  // the session's tenant triangle inline — the page is read-only and
  // renders only public-safe identifiers.
  const cookie = await getEmployeeOnboardingSession();
  if (!cookie.sessionId || !cookie.employeeId || !cookie.clubId) {
    redirect("/hr/onboarding/expired");
  }

  const [employee, session, club] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: cookie.employeeId!, clubId: cookie.clubId! },
      select: { firstName: true, preferredName: true, employeeNumber: true },
    }),
    prisma.employeeOnboardingSession.findFirst({
      where: { id: cookie.sessionId!, employeeId: cookie.employeeId!, clubId: cookie.clubId! },
      select: { state: true, submittedAt: true },
    }),
    prisma.club.findFirst({ where: { id: cookie.clubId! }, select: { name: true } }),
  ]);
  if (!employee || !session || !club) redirect("/hr/onboarding/expired");

  const displayName = employee.preferredName?.trim().length
    ? employee.preferredName
    : employee.firstName;
  const isSubmitted = session.state === "SUBMITTED"
    || session.state === "APPROVED"
    || session.state === "REJECTED";

  // Defensive: if the session hasn't been submitted, don't imply it
  // has been. Route back to the resolver.
  if (!isSubmitted) redirect("/hr/onboarding/session");

  return (
    <main className="mx-auto max-w-2xl px-4 pt-12 pb-16 md:pt-16 md:pb-24">
      <div className="text-center md:text-left">
        <p className="text-[11px] uppercase tracking-[0.25em] text-stone-500">
          {club.name}
        </p>
        <h1 className="mt-3 font-serif text-3xl md:text-4xl leading-tight text-stone-900">
          Thanks, {displayName}.
        </h1>
        <p className="mt-4 text-base text-stone-700 leading-relaxed">
          Your onboarding has been sent to {club.name} for review. Your Club
          will finish setting things up on their end; you don&apos;t need to do
          anything else here.
        </p>
        <p className="mt-3 text-base text-stone-700 leading-relaxed">
          Your employee portal is ready. Sign in any time using your email
          address and the password you just created.
        </p>

        {/* HR mobile-hotfix (2026-08-25) — Employee number is shown
           for reference (payroll, Club records) but is NOT the
           portal username. */}
        <div className="mt-6 rounded-md border border-stone-200 bg-stone-50 px-4 py-4">
          <p className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Employee number</p>
          <p
            className="mt-1 font-mono text-2xl text-stone-900"
            data-testid="complete-employee-number"
          >
            {employee.employeeNumber}
          </p>
          <p className="mt-1 text-xs text-stone-500">
            For payroll and Club records — not your portal sign-in.
          </p>
        </div>

        <div className="mt-8 flex items-center gap-4">
          <Link
            href="/employee/login/handoff-from-onboarding"
            className="rounded-md bg-emerald-800 px-6 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
            data-testid="complete-continue-to-portal"
          >
            Continue to your employee portal
          </Link>
          <Link
            href="/employee/login"
            className="text-sm text-stone-500 hover:text-stone-800 underline underline-offset-4"
          >
            Or sign in later
          </Link>
        </div>
      </div>
    </main>
  );
}

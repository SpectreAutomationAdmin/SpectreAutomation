// HR-2B.1 (2026-08-18) — Employee onboarding session continuation
// placeholder.
//
// Reads the employee-onboarding iron-session cookie and confirms the
// employee has landed successfully. HR-2B.2+ replaces this with the
// conversational About You flow. Explicitly not a final surface —
// clearly labelled as such so a founder review knows what's coming.

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getEmployeeOnboardingSession } from "@/lib/hr/employee-onboarding-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HrOnboardingSessionPage() {
  const session = await getEmployeeOnboardingSession();
  if (!session.employeeId || !session.clubId || !session.sessionId) {
    redirect("/hr/onboarding/expired");
  }

  // Re-read Prisma every request. Tenant scope re-verified here so
  // a stale cookie can't leak into another club.
  const employee = await prisma.employee.findFirst({
    where: { id: session.employeeId, clubId: session.clubId },
    select: {
      firstName: true,
      preferredName: true,
      club: { select: { name: true } },
    },
  });
  if (!employee) redirect("/hr/onboarding/expired");

  const displayName = employee.preferredName?.trim().length
    ? employee.preferredName
    : employee.firstName;

  return (
    <main className="flex items-start justify-center px-4 py-12 md:py-20">
      <div className="w-full max-w-xl">
        <header className="text-center">
          <p className="text-[11px] uppercase tracking-[0.25em] text-stone-500">
            {employee.club.name}
          </p>
          <h1 className="mt-3 font-serif text-3xl md:text-4xl leading-tight text-stone-900">
            You're in, {displayName}.
          </h1>
        </header>
        <section className="mt-8 rounded-lg bg-white border border-stone-200 px-6 py-8 md:px-8 md:py-10">
          <p className="text-base leading-relaxed text-stone-700">
            Your onboarding session is active. The step-by-step conversation
            about your role, payroll, and documents lands in the next release.
          </p>
          <p className="mt-4 text-sm text-stone-500">
            You can safely close this tab and return to this link at any time
            before your invitation expires.
          </p>
        </section>
      </div>
    </main>
  );
}

// HR-2B.2 (2026-08-18) — About You · Complete.
// HR-2B.3 (2026-08-19) — wired the CTA into the payroll flow.
//
// Employee has finished the About You section. This screen is now the
// hand-off to the payroll section: the primary CTA opens the payroll
// hub, which redirects to the first incomplete payroll step.

import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AboutYouComplete() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const employee = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: {
      firstName: true,
      preferredName: true,
      profilePhotoDocumentId: true,
    },
  });
  if (!employee) redirect("/hr/onboarding/expired");

  const displayName = employee.preferredName?.trim().length
    ? employee.preferredName
    : employee.firstName;

  return (
    <article className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10">
      <h2 className="font-serif text-2xl leading-tight text-stone-900">
        Thanks, {displayName}.
      </h2>
      <p className="mt-3 text-sm text-stone-700 leading-relaxed">
        We&apos;ve saved everything you&apos;ve shared so far. The next
        section covers payroll details &mdash; the tax and banking
        information we need to pay you correctly.
      </p>
      <p className="mt-4 text-sm text-stone-500 leading-relaxed">
        You can safely close this tab and return to this link any time before
        your invitation expires.
      </p>

      <div className="mt-8 flex items-center justify-end border-t border-stone-100 pt-6">
        <Link
          href="/hr/onboarding/payroll"
          data-testid="continue-to-payroll"
          className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
        >
          Continue to payroll
        </Link>
      </div>
    </article>
  );
}

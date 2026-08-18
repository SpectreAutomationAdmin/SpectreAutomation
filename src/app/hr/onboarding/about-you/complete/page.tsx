// HR-2B.2 (2026-08-18) — About You · Complete.
//
// Employee has finished the About You section. HR-2B.3 will replace
// the "up next" copy with a link into the SIN / banking / TD1 flow;
// HR-2B.5 with the final review/submit gate. For HR-2B.2 the section
// ends here — clearly labelled as such so a founder review knows
// what's coming.

import { redirect } from "next/navigation";
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
        We've saved everything you've shared so far. The next section covers
        payroll details — the tax and banking information we need to pay you
        correctly. We'll notify you when it's ready.
      </p>
      <p className="mt-4 text-sm text-stone-500 leading-relaxed">
        You can safely close this tab and return to this link any time before
        your invitation expires.
      </p>
    </article>
  );
}

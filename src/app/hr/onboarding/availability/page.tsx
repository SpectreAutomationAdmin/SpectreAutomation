// Scheduling Foundation · Phase C (2026-09-07) — hourly onboarding
// "Your Availability" step server component.
//
// Placed between About You/Photo and Payroll/SIN per founder amendment
// §3. Salaried employees are redirected THROUGH the continuation
// resolver so they skip this step entirely.
//
// Uses a dedicated small wrapper (not the About-You shell, not the
// Post-Payroll shell) per amendment §2: "prefer the dedicated
// wrapper" over a generic pre-payroll abstraction. The wrapper
// mirrors the About-You shell's chrome (rail + typography + card
// styling) so the visual result stays inside the approved onboarding
// design language.

import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { prisma } from "@/lib/prisma";
import { OnboardingProgressRail } from "@/components/hr/OnboardingProgressRail";
import { OnboardingStepErrorFromSearchParam } from "@/components/hr/OnboardingStepErrorFromSearchParam";
import { listShiftTemplatesForEmployee } from "@/lib/scheduling/shift-templates";
import {
  resolveApplicableAvailabilityProfile,
} from "@/lib/scheduling/availability-profiles";
import { resolveOnboardingContinuation } from "@/lib/hr/onboarding-continuation";
import AvailabilityForm from "./AvailabilityForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUGGESTED_PREFERRED_HOURS = 20;
const SUGGESTED_MAXIMUM_HOURS = 30;

export default async function AvailabilityStep() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const [club, employee] = await Promise.all([
    prisma.club.findFirst({
      where: { id: actor.clubId },
      select: { name: true },
    }),
    prisma.employee.findFirst({
      where: { id: actor.employeeId, clubId: actor.clubId },
      select: {
        firstName: true, preferredName: true,
        compensationType: true,
        profilePhotoDocumentId: true, personalEmail: true, mobilePhone: true,
      },
    }),
  ]);
  if (!club || !employee) redirect("/hr/onboarding/expired");

  // Salaried employees never see this step — route them via the
  // canonical continuation resolver so they land on whichever
  // Payroll / About-You step is actually next for them.
  if (employee.compensationType !== "HOURLY") {
    const next = await resolveOnboardingContinuation({
      sessionId: actor.sessionId,
      employeeId: actor.employeeId,
      clubId: actor.clubId,
    });
    redirect(next);
  }

  const [templates, priorProfile, aboutYouSignals] = await Promise.all([
    listShiftTemplatesForEmployee(actor.clubId, actor.employeeId),
    resolveApplicableAvailabilityProfile(actor.employeeId, new Date()),
    prisma.employeeOnboardingAcknowledgement.findMany({
      where: {
        sessionId: actor.sessionId,
        clubId: actor.clubId,
        kind: {
          in: [
            "about_you_name_confirmation",
            "about_you_contact_confirmation",
            "about_you_address_confirmation",
            "employment_confirmation",
          ],
        },
      },
      select: { kind: true },
    }),
  ]);

  // Rail state — mirrors the About-You / Payroll layouts so the same
  // employee sees a consistent portrait of progress everywhere.
  const kinds = new Set(aboutYouSignals.map((a) => a.kind));
  const nameDone = kinds.has("about_you_name_confirmation");
  const contactDone = kinds.has("about_you_contact_confirmation");
  const addressDone = kinds.has("about_you_address_confirmation");
  const employmentDone = kinds.has("employment_confirmation");
  const photoDone = Boolean(employee.profilePhotoDocumentId);
  const aboutYouDone = nameDone && contactDone && addressDone && employmentDone && photoDone;

  const displayName = employee.preferredName?.trim().length
    ? employee.preferredName
    : employee.firstName;

  // Prior-state — for prepopulation on return.
  const prior = {
    cellKeys: new Set(
      priorProfile?.rules.filter((r) => r.available).map((r) => `${r.weekday}::${r.shiftTemplateId}`) ?? [],
    ),
    preferredHoursPerWeek: priorProfile?.preferredHoursPerWeek ?? null,
    maximumHoursPerWeek: priorProfile?.maximumHoursPerWeek ?? null,
    notes: priorProfile?.notes ?? "",
    effectiveFromDate: priorProfile
      ? priorProfile.effectiveFrom.toISOString().slice(0, 10)
      : null,
  };

  // Templates with department metadata for the client.
  const clientTemplates = await Promise.all(templates.map(async (t) => {
    const dept = await prisma.department.findUniqueOrThrow({
      where: { id: t.departmentId },
      select: { code: true, name: true },
    });
    return {
      id: t.id,
      code: t.code,
      name: t.name,
      departmentId: t.departmentId,
      departmentCode: dept.code,
      departmentName: dept.name,
      startTimeMinutes: t.startTimeMinutes,
      endTimeMinutes: t.endTimeMinutes,
    };
  }));

  return (
    <main className="mx-auto max-w-5xl px-4 pt-8 pb-16 md:pt-12 md:pb-24">
      <header className="text-center md:text-left">
        <p className="text-[11px] uppercase tracking-[0.25em] text-stone-500">
          {club.name}
        </p>
        <h1 className="mt-2 font-serif text-2xl md:text-3xl leading-tight text-stone-900">
          Your Availability
        </h1>
        <p className="mt-2 text-sm text-stone-500 md:max-w-xl">
          When are you normally available to work, {displayName}?
        </p>
        <p className="mt-2 text-sm text-stone-500 md:max-w-xl">
          Select the shifts you are typically able to work. You can select as many
          as apply. This helps us build schedules that work for you and the Club.
        </p>
      </header>

      <div className="mt-8 md:mt-10 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6 md:gap-10">
        <aside className="md:sticky md:top-8 md:self-start">
          <OnboardingProgressRail
            stages={[
              {
                key: "about-you",
                label: "About you",
                done: aboutYouDone,
                current: false,
                href: "/hr/onboarding/about-you",
                subStages: [
                  { key: "name", label: "Name", done: nameDone, href: nameDone ? "/hr/onboarding/about-you/name" : undefined },
                  { key: "contact", label: "Contact", done: contactDone, href: contactDone ? "/hr/onboarding/about-you/contact" : undefined },
                  { key: "employment", label: "Employment", done: employmentDone, href: employmentDone ? "/hr/onboarding/about-you/employment" : undefined },
                  { key: "photo", label: "Photo", done: photoDone, href: photoDone ? "/hr/onboarding/about-you/photo" : undefined },
                ],
              },
              // Phase C — dedicated Availability stage between About You
              // and Payroll for hourly employees.
              {
                key: "availability",
                label: "Availability",
                done: Boolean(priorProfile),
                current: true,
              },
              { key: "payroll", label: "Payroll", done: false, current: false, future: true },
              { key: "emergency", label: "Emergency", done: false, current: false, future: true },
              { key: "documents", label: "Documents", done: false, current: false, future: true },
              { key: "review", label: "Review", done: false, current: false, future: true },
            ]}
          />
        </aside>
        <section>
          <OnboardingStepErrorFromSearchParam />
          <AvailabilityForm
            templates={clientTemplates}
            prior={{
              cellKeys: Array.from(prior.cellKeys),
              preferredHoursPerWeek: prior.preferredHoursPerWeek,
              maximumHoursPerWeek: prior.maximumHoursPerWeek,
              notes: prior.notes,
              effectiveFromDate: prior.effectiveFromDate,
            }}
            suggestedPreferredHours={SUGGESTED_PREFERRED_HOURS}
            suggestedMaximumHours={SUGGESTED_MAXIMUM_HOURS}
          />
        </section>
      </div>
    </main>
  );
}

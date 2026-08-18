// HR-2B.3 (2026-08-19) — Payroll conversational-flow layout.
//
// Wraps every /hr/onboarding/payroll/* step in the Club-branded ground
// and the shared progress rail (with sub-stages for the four Payroll
// steps: SIN / Direct deposit / Federal TD1 / Provincial TD1).
// Enforces the employee-onboarding actor gate — an unauthenticated
// visitor is redirected to the neutral expired page.

import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { prisma } from "@/lib/prisma";
import {
  getPayrollCompletion,
} from "@/lib/hr/employee-self-service";
import { OnboardingProgressRail } from "@/components/hr/OnboardingProgressRail";
import { OnboardingStepErrorFromSearchParam } from "@/components/hr/OnboardingStepErrorFromSearchParam";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PayrollLayout({ children }: { children: ReactNode }) {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const [club, employee, completion] = await Promise.all([
    prisma.club.findFirst({
      where: { id: actor.clubId },
      select: { name: true },
    }),
    prisma.employee.findFirst({
      where: { id: actor.employeeId, clubId: actor.clubId },
      select: {
        firstName: true,
        preferredName: true,
        personalEmail: true,
        mobilePhone: true,
        profilePhotoDocumentId: true,
      },
    }),
    getPayrollCompletion(actor),
  ]);
  if (!club || !employee) redirect("/hr/onboarding/expired");

  const displayName = employee.preferredName?.trim().length
    ? employee.preferredName
    : employee.firstName;

  // HR-2B.3.1 (2026-08-18) — see about-you/layout.tsx for rationale.
  // The prior cookie-mutation-during-render pattern was the root
  // cause of the founder's SIN-entry crash on staging (Next.js 14
  // forbids cookie writes in server-component renders). Errors now
  // flow via `?err=<msg>` search param + a client component.

  // About-you stages: all considered done by the time the employee is
  // inside /hr/onboarding/payroll (About-you hub redirects here only
  // after About-you completion). We still read persisted facts to keep
  // the rail honest if the employee somehow revisits mid-flow.
  const nameDone = Boolean(employee.preferredName?.trim() || employee.firstName?.trim());
  const contactDone = Boolean(employee.personalEmail?.trim() || employee.mobilePhone?.trim());
  const photoDone = Boolean(employee.profilePhotoDocumentId);
  // Employment ack was required before the About You complete gate;
  // trust the About-you completion when inside /payroll.
  const employmentDone = true;

  return (
    <main className="mx-auto max-w-5xl px-4 pt-8 pb-16 md:pt-12 md:pb-24">
      <header className="text-center md:text-left">
        <p className="text-[11px] uppercase tracking-[0.25em] text-stone-500">
          {club.name}
        </p>
        <h1 className="mt-2 font-serif text-2xl md:text-3xl leading-tight text-stone-900">
          A few payroll details, {displayName}.
        </h1>
        <p className="mt-2 text-sm text-stone-500 md:max-w-xl">
          The information here is what your Club needs to pay you correctly.
          Everything is encrypted at rest and only visible to authorized payroll
          staff.
        </p>
      </header>

      <div className="mt-8 md:mt-10 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6 md:gap-10">
        <aside className="md:sticky md:top-8 md:self-start">
          <OnboardingProgressRail
            stages={[
              { key: "name", label: "About you", done: nameDone, current: false },
              { key: "contact", label: "Contact", done: contactDone, current: false },
              { key: "employment", label: "Employment", done: employmentDone, current: false },
              { key: "photo", label: "Photo", done: photoDone, current: false },
              {
                key: "payroll",
                label: "Payroll",
                done: completion.complete,
                current: true,
                subStages: [
                  { key: "sin", label: "SIN", done: completion.sin },
                  { key: "direct-deposit", label: "Direct deposit", done: completion.banking },
                  {
                    key: "td1-federal",
                    label: "Federal TD1",
                    done: completion.taxProfile && completion.federalAttestation,
                  },
                  {
                    key: "td1-provincial",
                    label: "Provincial TD1",
                    done: completion.taxProfile && completion.provincialAttestation,
                  },
                ],
              },
              { key: "emergency", label: "Emergency", done: false, current: false, future: true },
              { key: "documents", label: "Documents", done: false, current: false, future: true },
              { key: "review", label: "Review", done: false, current: false, future: true },
            ]}
          />
        </aside>
        <section>
          <OnboardingStepErrorFromSearchParam />
          {children}
        </section>
      </div>
    </main>
  );
}

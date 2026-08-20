// HR-2B.4 (2026-08-19) — Shared shell for the Emergency + Documents +
// Ready-for-review post-payroll stages.
//
// Extracted so each of the three routes has ONE source of truth for
// the rail state + the About-you / Payroll parent completion signals.
// Every rail-completion boolean here reads through the SAME persisted
// server-side sources the canonical continuation resolver uses.
// Browser state, URL history, and localStorage are deliberately never
// consulted.

import type { ReactNode } from "react";
import { prisma } from "@/lib/prisma";
import {
  getPayrollCompletion,
} from "@/lib/hr/employee-self-service";
import {
  isDocumentsSectionComplete,
  isEmergencySectionComplete,
} from "@/lib/hr/onboarding-requirements";
import type { EmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { OnboardingProgressRail } from "@/components/hr/OnboardingProgressRail";
import { OnboardingStepErrorFromSearchParam } from "@/components/hr/OnboardingStepErrorFromSearchParam";

interface Props {
  actor: EmployeeOnboardingActor;
  /** Which post-payroll section this shell is wrapping. Drives the
   *  `current` flag on the rail. */
  currentSection: "emergency" | "documents" | "ready-for-review";
  headline: string;
  subhead: string;
  children: ReactNode;
}

export default async function PostPayrollShell({
  actor, currentSection, headline, subhead, children,
}: Props) {
  const [club, employee, completion, nameAck, contactAck, employmentAck, corrections, emergencyDone, documentsDone] = await Promise.all([
    prisma.club.findFirst({ where: { id: actor.clubId }, select: { name: true } }),
    prisma.employee.findFirst({
      where: { id: actor.employeeId, clubId: actor.clubId },
      select: { firstName: true, preferredName: true, profilePhotoDocumentId: true },
    }),
    getPayrollCompletion(actor),
    prisma.employeeOnboardingAcknowledgement.findFirst({
      where: { sessionId: actor.sessionId, clubId: actor.clubId, kind: "about_you_name_confirmation" },
      select: { id: true },
    }),
    prisma.employeeOnboardingAcknowledgement.findFirst({
      where: { sessionId: actor.sessionId, clubId: actor.clubId, kind: "about_you_contact_confirmation" },
      select: { id: true },
    }),
    prisma.employeeOnboardingAcknowledgement.findFirst({
      where: { sessionId: actor.sessionId, clubId: actor.clubId, kind: "employment_confirmation" },
      select: { id: true },
    }),
    prisma.employeeOnboardingCorrection.findMany({
      where: {
        sessionId: actor.sessionId, clubId: actor.clubId,
        field: { in: ["positionId", "departmentId", "expectedStartDate", "employmentType"] },
      },
      select: { field: true },
    }),
    isEmergencySectionComplete(actor),
    isDocumentsSectionComplete(actor),
  ]);
  if (!club || !employee) {
    // Rare — actor resolved but employee/club vanished. Let the page
    // handle its own redirect.
    return <>{children}</>;
  }
  const nameDone = Boolean(nameAck);
  const contactDone = Boolean(contactAck);
  const employmentDone = Boolean(employmentAck) || corrections.length > 0;
  const photoDone = Boolean(employee.profilePhotoDocumentId);
  const aboutYouDone = nameDone && contactDone && employmentDone && photoDone;

  const displayName = employee.preferredName?.trim().length
    ? employee.preferredName
    : employee.firstName;

  return (
    <main className="mx-auto max-w-5xl px-4 pt-8 pb-16 md:pt-12 md:pb-24">
      <header className="text-center md:text-left">
        <p className="text-[11px] uppercase tracking-[0.25em] text-stone-500">
          {club.name}
        </p>
        <h1 className="mt-2 font-serif text-2xl md:text-3xl leading-tight text-stone-900">
          {headline.replace("{name}", displayName ?? "")}
        </h1>
        <p className="mt-2 text-sm text-stone-500 md:max-w-xl">{subhead}</p>
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
              {
                key: "payroll",
                label: "Payroll",
                done: completion.complete,
                current: false,
                href: "/hr/onboarding/payroll",
                subStages: [
                  { key: "sin", label: "SIN", done: completion.sin, href: completion.sin ? "/hr/onboarding/payroll/sin" : undefined },
                  { key: "direct-deposit", label: "Direct deposit", done: completion.banking, href: completion.banking ? "/hr/onboarding/payroll/direct-deposit" : undefined },
                  {
                    key: "td1-federal", label: "Federal TD1",
                    done: completion.taxProfile && completion.federalAttestation,
                    href: completion.taxProfile && completion.federalAttestation ? "/hr/onboarding/payroll/td1-federal" : undefined,
                  },
                  {
                    key: "td1-provincial", label: "Provincial TD1",
                    done: completion.taxProfile && completion.provincialAttestation,
                    href: completion.taxProfile && completion.provincialAttestation ? "/hr/onboarding/payroll/td1-provincial" : undefined,
                  },
                ],
              },
              {
                key: "emergency",
                label: "Emergency",
                done: emergencyDone,
                current: currentSection === "emergency",
                href: emergencyDone ? "/hr/onboarding/emergency" : undefined,
              },
              {
                key: "documents",
                label: "Documents",
                done: documentsDone,
                current: currentSection === "documents",
                href: documentsDone ? "/hr/onboarding/documents" : (emergencyDone ? "/hr/onboarding/documents" : undefined),
              },
              {
                key: "review",
                label: "Review",
                done: false,
                current: currentSection === "ready-for-review",
                future: !(emergencyDone && documentsDone),
              },
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

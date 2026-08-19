// HR-2B.2 (2026-08-18) — About You conversational-flow layout.
//
// Wraps every /hr/onboarding/about-you/* step in the Club-branded
// ground and the shared progress rail. Enforces the employee-
// onboarding actor gate — an unauthenticated visitor is redirected
// to the neutral expired page (no oracle for "which step you were
// on"). Mobile-first: single narrow column that grows into a
// two-column layout at md.

import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { prisma } from "@/lib/prisma";
import { OnboardingProgressRail } from "@/components/hr/OnboardingProgressRail";
import { OnboardingStepErrorFromSearchParam } from "@/components/hr/OnboardingStepErrorFromSearchParam";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AboutYouLayout({ children }: { children: ReactNode }) {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  // HR-2B.3.3 (2026-08-18) — Completion signals are read from the
  // same persisted-event sources the canonical resolver reads (see
  // `src/lib/hr/onboarding-continuation.ts`). The rail and the
  // resolver are now guaranteed to agree on every step's done state.
  const [club, employee, nameAck, contactAck, employmentAck, corrections] =
    await Promise.all([
      prisma.club.findFirst({
        where: { id: actor.clubId },
        select: { name: true },
      }),
      prisma.employee.findFirst({
        where: { id: actor.employeeId, clubId: actor.clubId },
        select: {
          firstName: true,
          preferredName: true,
          profilePhotoDocumentId: true,
        },
      }),
      prisma.employeeOnboardingAcknowledgement.findFirst({
        where: {
          sessionId: actor.sessionId,
          clubId: actor.clubId,
          kind: "about_you_name_confirmation",
        },
        select: { id: true },
      }),
      prisma.employeeOnboardingAcknowledgement.findFirst({
        where: {
          sessionId: actor.sessionId,
          clubId: actor.clubId,
          kind: "about_you_contact_confirmation",
        },
        select: { id: true },
      }),
      prisma.employeeOnboardingAcknowledgement.findFirst({
        where: {
          sessionId: actor.sessionId,
          clubId: actor.clubId,
          kind: "employment_confirmation",
        },
        select: { id: true },
      }),
      prisma.employeeOnboardingCorrection.findMany({
        where: {
          sessionId: actor.sessionId,
          clubId: actor.clubId,
          field: { in: ["positionId", "departmentId", "expectedStartDate", "employmentType"] },
        },
        select: { field: true },
      }),
    ]);
  if (!club || !employee) redirect("/hr/onboarding/expired");

  const nameDone = Boolean(nameAck);
  const contactDone = Boolean(contactAck);
  const employmentDone = Boolean(employmentAck) || corrections.length > 0;
  const photoDone = Boolean(employee.profilePhotoDocumentId);
  const aboutYouDone = nameDone && contactDone && employmentDone && photoDone;

  const displayName = employee.preferredName?.trim().length
    ? employee.preferredName
    : employee.firstName;

  // HR-2B.3.1 (2026-08-18) — Error banners now flow via `?err=<msg>`
  // URL search param + a client component that reads it. The prior
  // pattern (server-render cookieStore.delete) is illegal in
  // Next.js 14 and 500s the render.

  return (
    <main className="mx-auto max-w-5xl px-4 pt-8 pb-16 md:pt-12 md:pb-24">
      <header className="text-center md:text-left">
        <p className="text-[11px] uppercase tracking-[0.25em] text-stone-500">
          {club.name}
        </p>
        <h1 className="mt-2 font-serif text-2xl md:text-3xl leading-tight text-stone-900">
          A few details, {displayName}.
        </h1>
        <p className="mt-2 text-sm text-stone-500 md:max-w-xl">
          Take your time. Your answers save as you go — you can safely close
          this tab and return via the same link.
        </p>
      </header>

      <div className="mt-8 md:mt-10 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6 md:gap-10">
        <aside className="md:sticky md:top-8 md:self-start">
          <OnboardingProgressRail
            stages={[
              // HR-2B.3.3 — parent "About you" row aggregates the four
              // sub-stages; done reflects the CANONICAL state, mirroring
              // Payroll's rail shape. The parent is `current` whenever
              // the employee is anywhere inside /hr/onboarding/about-you/*.
              //
              // HR-2B.3.6 — hrefs on completed sub-stages so the
              // employee can navigate back to correct a completed
              // answer. `href` is set ONLY when canonical state says
              // the step was completed. Future / incomplete steps have
              // no href.
              {
                key: "about-you",
                label: "About you",
                done: aboutYouDone,
                current: !aboutYouDone,
                subStages: [
                  { key: "name", label: "Name", done: nameDone, href: nameDone ? "/hr/onboarding/about-you/name" : undefined },
                  { key: "contact", label: "Contact", done: contactDone, href: contactDone ? "/hr/onboarding/about-you/contact" : undefined },
                  { key: "employment", label: "Employment", done: employmentDone, href: employmentDone ? "/hr/onboarding/about-you/employment" : undefined },
                  { key: "photo", label: "Photo", done: photoDone, href: photoDone ? "/hr/onboarding/about-you/photo" : undefined },
                ],
              },
              { key: "payroll", label: "Payroll", done: false, current: aboutYouDone, future: !aboutYouDone, href: aboutYouDone ? "/hr/onboarding/payroll" : undefined },
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

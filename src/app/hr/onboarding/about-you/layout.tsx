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
import { cookies } from "next/headers";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { prisma } from "@/lib/prisma";
import { OnboardingProgressRail } from "@/components/hr/OnboardingProgressRail";
import { OnboardingStepError } from "@/components/hr/OnboardingStepError";

const ERROR_COOKIE = "spectre_hr_onboarding_error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AboutYouLayout({ children }: { children: ReactNode }) {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  // Load the club name + the employee's photo pointer for the header /
  // progress rail. Deliberately scoped by clubId AND id so a stale
  // cookie cannot leak into another club.
  const [club, employee] = await Promise.all([
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
  ]);
  if (!club || !employee) redirect("/hr/onboarding/expired");

  // Determine step completion from PERSISTED facts, not adjacent
  // progress inference:
  //   • Name       : employee has saved their preferredName.
  //   • Contact    : employee has saved either personalEmail or mobilePhone.
  //   • Employment : the durable EmployeeOnboardingAcknowledgement row
  //                  exists (kind=employment_confirmation) OR the employee
  //                  has flagged at least one field-level correction.
  //   • Photo      : Employee.profilePhotoDocumentId is set.
  const [ack, corrections] = await Promise.all([
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
  const nameDone = Boolean(employee.preferredName?.trim());
  const contactDone = Boolean(employee.personalEmail?.trim() || employee.mobilePhone?.trim());
  const photoDone = Boolean(employee.profilePhotoDocumentId);
  const employmentDone = Boolean(ack) || corrections.length > 0;

  const displayName = employee.preferredName?.trim().length
    ? employee.preferredName
    : employee.firstName;

  const cookieStore = cookies();
  const actionError = cookieStore.get(ERROR_COOKIE)?.value ?? null;
  if (actionError) cookieStore.delete(ERROR_COOKIE);

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
              { key: "name", label: "About you", done: nameDone, current: false },
              { key: "contact", label: "Contact", done: contactDone, current: false },
              { key: "employment", label: "Employment", done: employmentDone, current: false },
              { key: "photo", label: "Photo", done: photoDone, current: false },
              { key: "payroll", label: "Payroll", done: false, current: false, future: true },
              { key: "emergency", label: "Emergency", done: false, current: false, future: true },
              { key: "documents", label: "Documents", done: false, current: false, future: true },
              { key: "review", label: "Review", done: false, current: false, future: true },
            ]}
          />
        </aside>
        <section>
          {actionError && <OnboardingStepError message={actionError} />}
          {children}
        </section>
      </div>
    </main>
  );
}

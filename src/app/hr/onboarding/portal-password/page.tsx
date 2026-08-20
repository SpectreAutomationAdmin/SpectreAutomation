// HR-2B.5 §3-9 (2026-08-19) — Portal password onboarding step.
//
// The employee sees their canonical Employee Number (E-00142 style)
// and creates the permanent password they'll use to sign into the
// Employee Portal after onboarding. The password is hashed by
// `establishPortalPassword` (bcrypt cost 12 via `hashPassword()`) and
// never re-rendered.
//
// Placement in the flow:
//   Documents & Credentials → PORTAL PASSWORD → Review
//
// A resumed session where the credential is already set drops the
// employee straight to Review — see resolveOnboardingContinuation.

import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { prisma } from "@/lib/prisma";
import { establishPortalPasswordAction } from "../_hr2b5-actions";
import { PORTAL_PASSWORD_MIN } from "@/lib/hr/employee-portal-credential";
import PostPayrollShell from "../_post-payroll-shell";
import PortalPasswordForm from "./PortalPasswordForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PortalPasswordStep() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const employee = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: {
      employeeNumber: true,
      firstName: true,
      preferredName: true,
    },
  });
  if (!employee) redirect("/hr/onboarding/expired");

  const existingCredential = await prisma.employeePortalCredential.findFirst({
    where: { employeeId: actor.employeeId, clubId: actor.clubId },
    select: { id: true },
  });
  const hasExisting = Boolean(existingCredential);

  return (
    <PostPayrollShell
      actor={actor}
      currentSection="portal-password"
      headline="Your employee portal, {name}."
      subhead="Create the password you'll use to sign into your employee portal after onboarding is complete."
    >
      <article className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10">
        <div className="mb-6 rounded-md border border-stone-200 bg-stone-50 px-4 py-4">
          <p className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Employee number</p>
          <p
            className="mt-1 font-mono text-2xl text-stone-900"
            data-testid="portal-employee-number"
          >
            {employee.employeeNumber}
          </p>
          <p className="mt-2 text-sm text-stone-500">
            This is your permanent username for the employee portal. You&rsquo;ll use it
            with the password you create below to sign in.
          </p>
        </div>

        {hasExisting && (
          <p
            className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"
            data-testid="portal-password-existing-notice"
          >
            You&rsquo;ve already set a password. You can update it below or leave it
            unchanged and continue to Review.
          </p>
        )}

        <PortalPasswordForm
          action={establishPortalPasswordAction}
          minLength={PORTAL_PASSWORD_MIN}
        />
      </article>
    </PostPayrollShell>
  );
}

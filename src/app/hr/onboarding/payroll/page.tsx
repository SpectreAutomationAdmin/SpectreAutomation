// HR-2B.3 (2026-08-19) — Payroll hub.
// HR-2B.3.2 §2 (2026-08-18) — Delegates to the canonical
// `resolveOnboardingContinuation`. If About You is not yet complete
// the resolver takes the employee BACK to the incomplete About You
// step (an admin-generated deep link to /payroll no longer allows
// the employee to skip identity confirmation).

import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { resolveOnboardingContinuation } from "@/lib/hr/onboarding-continuation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PayrollHub() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");
  const target = await resolveOnboardingContinuation({
    sessionId: actor.sessionId,
    employeeId: actor.employeeId,
    clubId: actor.clubId,
  });
  redirect(target);
}

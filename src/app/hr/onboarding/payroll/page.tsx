// HR-2B.3 (2026-08-19) — Payroll hub.
//
// Every entry into /hr/onboarding/payroll resolves to the FIRST
// incomplete step. On fully-complete flows, redirects to the review
// screen. Keeps the URL semantic — the employee never sees this route
// render its own content.

import { redirect } from "next/navigation";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { getPayrollCompletion } from "@/lib/hr/employee-self-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PayrollHub() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const completion = await getPayrollCompletion(actor);
  if (!completion.sin) redirect("/hr/onboarding/payroll/sin");
  if (!completion.banking) redirect("/hr/onboarding/payroll/direct-deposit");
  if (!completion.taxProfile) redirect("/hr/onboarding/payroll/td1-federal");
  if (!completion.federalAttestation) redirect("/hr/onboarding/payroll/td1-federal");
  if (!completion.provincialAttestation) redirect("/hr/onboarding/payroll/td1-provincial");
  redirect("/hr/onboarding/payroll/review");
}

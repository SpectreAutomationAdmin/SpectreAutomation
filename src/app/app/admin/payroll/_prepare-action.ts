// Payroll 3A hotfix (2026-09-11) — Prepare Payroll server action for
// the Payroll Overview. Delegates entirely to the existing domain
// service `preparePayrollBatch` (batch-preparation.ts:675) — no new
// preparation logic, no new state machinery. The action is idempotent
// server-side (the domain returns the existing non-VOIDED batch if one
// already exists), and it does not calculate or approve.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";

export async function preparePayrollAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) {
    redirect("/app/admin");
  }

  const payPeriodId = String(formData.get("payPeriodId") ?? "").trim();
  if (!payPeriodId) redirect("/app/admin/payroll");

  await preparePayrollBatch(principal, clubId, payPeriodId);
  revalidatePath("/app/admin/payroll");
  redirect(`/app/admin/payroll?payPeriodId=${encodeURIComponent(payPeriodId)}`);
}

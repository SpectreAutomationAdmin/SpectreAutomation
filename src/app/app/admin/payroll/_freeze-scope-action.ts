// Payroll 3B semantics-hotfix (2026-09-12) — Freeze server action
// invocable from the Payroll Overview Approvals tab.
//
// Delegates entirely to the same canonical `freezeApprovedScopeIntoPayroll`
// service the /app/admin/payroll/process page uses (see
// src/app/app/admin/payroll/process/_time-readiness-actions.ts:22).
// The two callers exist because they revalidate different paths:
// this one refreshes the Overview after a freeze from the
// Approvals tab; the process-page action refreshes the process
// page. No new freeze logic is introduced — the domain service is
// the single source of truth for the freeze mutation and all its
// preconditions (approval currency, scope-version, revision hash).

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { freezeApprovedScopeIntoPayroll } from "@/lib/payroll/freeze-service";

export async function freezeScopeFromOverviewAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/app/admin");

  const payPeriodId  = String(formData.get("payPeriodId")  ?? "").trim();
  const departmentId = String(formData.get("departmentId") ?? "").trim();
  if (!payPeriodId || !departmentId) redirect("/app/admin/payroll");

  await freezeApprovedScopeIntoPayroll(principal, {
    clubId, payPeriodId, departmentId,
  });
  revalidatePath("/app/admin/payroll");
  redirect(`/app/admin/payroll?payPeriodId=${encodeURIComponent(payPeriodId)}&tab=approvals`);
}

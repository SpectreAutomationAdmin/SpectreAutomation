// Payroll Consolidation (2026-09-14) — Discard Prepared Payroll server
// action for the CANONICAL Finance → Payroll workspace.
//
// This action reuses the exact same `discardPreparedPayrollBatch` domain
// service the v396 process workspace already calls — there is ONE
// canonical implementation of Discard (see docs/payroll/canonical-payroll-ui.md).
// The action lives beside the other canonical payroll actions
// (`_prepare-action.ts`, `_calculate-action.ts`, etc.) so the whole
// Finance workspace has one coherent action surface.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { discardPreparedPayrollBatch } from "@/lib/payroll/batch-preparation";

async function context() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/app/admin");
  return { principal, clubId };
}

function back(payPeriodId: string, payGroupId: string | null): never {
  const q = new URLSearchParams();
  if (payGroupId) q.set("payGroupId", payGroupId);
  if (payPeriodId) q.set("payPeriodId", payPeriodId);
  redirect(`/app/admin/payroll?${q.toString()}`);
}

export async function discardPreparedPayrollAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const payPeriodId = String(formData.get("payPeriodId") ?? "").trim();
  const payGroupId = String(formData.get("payGroupId") ?? "").trim() || null;
  const batchId = String(formData.get("batchId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!batchId) back(payPeriodId, payGroupId);

  await discardPreparedPayrollBatch(principal, clubId, batchId, reason || undefined);
  revalidatePath("/app/admin/payroll");
  back(payPeriodId, payGroupId);
}

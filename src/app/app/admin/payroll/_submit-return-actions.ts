// Payroll Admin Slice 3E (2026-09-12) — Submit + Return server
// actions for the Payroll Overview surface. Delegates to canonical
// domain services. Preserves `payGroupId` in the redirect (§3D lesson).

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { submitPayrollBatch } from "@/lib/payroll/submit-payroll-batch";
import { returnPayrollBatch } from "@/lib/payroll/return-payroll-batch";

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

export async function submitPayrollAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const payPeriodId = String(formData.get("payPeriodId") ?? "").trim();
  const payGroupId  = String(formData.get("payGroupId")  ?? "").trim() || null;
  const batchId     = String(formData.get("batchId")     ?? "").trim();
  const note        = String(formData.get("note")        ?? "").trim() || null;
  if (!batchId) back(payPeriodId, payGroupId);
  await submitPayrollBatch(principal, clubId, batchId, { note });
  revalidatePath("/app/admin/payroll");
  back(payPeriodId, payGroupId);
}

export async function returnPayrollFromAdminAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const payPeriodId = String(formData.get("payPeriodId") ?? "").trim();
  const payGroupId  = String(formData.get("payGroupId")  ?? "").trim() || null;
  const batchId     = String(formData.get("batchId")     ?? "").trim();
  const reason      = String(formData.get("reason")      ?? "").trim();
  if (!batchId || !reason) back(payPeriodId, payGroupId);
  await returnPayrollBatch(principal, clubId, batchId, reason);
  revalidatePath("/app/admin/payroll");
  back(payPeriodId, payGroupId);
}

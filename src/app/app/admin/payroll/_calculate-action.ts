// Payroll Admin Slice 3D (2026-09-12) — Calculate Payroll +
// Return-to-Preparation server actions for the Payroll Admin
// Overview surface. Both delegate to canonical domain services;
// neither introduces new payroll math or lifecycle rules.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { returnBatchToPreparation } from "@/lib/payroll/return-to-preparation";

async function context() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/app/admin");
  return { principal, clubId };
}

function back(payPeriodId: string, payGroupId: string | null, tab: string | null = null): never {
  const q = new URLSearchParams();
  if (payGroupId) q.set("payGroupId", payGroupId);
  if (payPeriodId) q.set("payPeriodId", payPeriodId);
  if (tab) q.set("tab", tab);
  redirect(`/app/admin/payroll?${q.toString()}`);
}

export async function calculatePayrollAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const payPeriodId = String(formData.get("payPeriodId") ?? "").trim();
  const payGroupId  = String(formData.get("payGroupId")  ?? "").trim() || null;
  const batchId     = String(formData.get("batchId")     ?? "").trim();
  if (!batchId) back(payPeriodId, payGroupId);

  await calculatePayrollBatch(principal, clubId, batchId);
  revalidatePath("/app/admin/payroll");
  back(payPeriodId, payGroupId);
}

export async function returnToPreparationAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const payPeriodId = String(formData.get("payPeriodId") ?? "").trim();
  const payGroupId  = String(formData.get("payGroupId")  ?? "").trim() || null;
  const batchId     = String(formData.get("batchId")     ?? "").trim();
  const reason      = String(formData.get("reason")      ?? "").trim();
  if (!batchId) back(payPeriodId, payGroupId);
  if (!reason) back(payPeriodId, payGroupId, "adjustments");

  await returnBatchToPreparation(principal, clubId, batchId, reason);
  revalidatePath("/app/admin/payroll");
  back(payPeriodId, payGroupId);
}

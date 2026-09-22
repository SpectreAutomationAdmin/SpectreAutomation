// FPP-9C.1 (2026-09-22) — Compare-page server actions.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { returnPayrollBatch } from "@/lib/payroll/return-payroll-batch";

export async function returnCorrectionFromCompare(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/app/admin");
  const batchId = String(formData.get("batchId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!batchId || !reason) redirect(`/app/admin/payroll/batches/${batchId}/compare?err=missing`);
  await returnPayrollBatch(principal, clubId, batchId, reason);
  revalidatePath(`/app/admin/payroll/batches/${batchId}/compare`);
  redirect(`/app/admin/payroll/batches/${batchId}/compare?ok=returned`);
}

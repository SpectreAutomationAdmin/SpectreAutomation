// Payroll 3C acceptance hotfix (2026-09-12) — Mark Reviewed server
// action. Delegates to the canonical `attestBatchReview` domain
// service; adds `revalidatePath("/app/admin/payroll")` + redirect
// back to the Adjustments tab.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { attestBatchReview, REVIEW_DIMENSIONS, type ReviewDimension } from "@/lib/payroll/batch-review";

async function context() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/app/admin");
  return { principal, clubId };
}

export async function attestBatchReviewAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const payPeriodId  = String(formData.get("payPeriodId") ?? "").trim();
  const batchId      = String(formData.get("batchId")     ?? "").trim();
  const dimensionRaw = String(formData.get("dimension")   ?? "").trim();
  if (!batchId || !dimensionRaw) redirect(`/app/admin/payroll?payPeriodId=${encodeURIComponent(payPeriodId)}&tab=adjustments`);
  if (!(REVIEW_DIMENSIONS as readonly string[]).includes(dimensionRaw)) {
    redirect(`/app/admin/payroll?payPeriodId=${encodeURIComponent(payPeriodId)}&tab=adjustments&err=bad-dim`);
  }
  await attestBatchReview(principal, clubId, batchId, dimensionRaw as ReviewDimension);
  revalidatePath("/app/admin/payroll");
  redirect(`/app/admin/payroll?payPeriodId=${encodeURIComponent(payPeriodId)}&tab=adjustments`);
}

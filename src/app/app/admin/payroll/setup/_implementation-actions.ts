// v-slice-1-followup-7 (2026-09-15) — Payroll Implementation server
// actions for the setup surface. Wraps
// declareImplementation / revokeImplementationDeclaration with the
// standard principal + active-club resolution + revalidatePath.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import {
  declareImplementation,
  revokeImplementationDeclaration,
  isImplementationMode,
} from "@/lib/payroll/implementation-declaration";
import { isAppError } from "@/lib/errors";

async function context() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/app/admin");
  return { principal, clubId };
}

function back(err?: string, ok?: string): never {
  const q = new URLSearchParams();
  if (err) q.set("implErr", err);
  if (ok) q.set("implOk", ok);
  redirect(`/app/admin/payroll/setup${q.toString() ? `?${q.toString()}` : ""}`);
}

export async function declareImplementationAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const taxYearStr = String(formData.get("taxYear") ?? "").trim();
  const mode = String(formData.get("mode") ?? "").trim();
  const firstStr = String(formData.get("firstSpectrePayDate") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const taxYear = Number.parseInt(taxYearStr, 10);
  if (!Number.isInteger(taxYear)) back("Tax year is required.");
  if (!isImplementationMode(mode)) back("Choose an implementation mode.");

  const firstSpectrePayDate = firstStr ? new Date(firstStr + "T00:00:00.000Z") : null;
  if (mode === "MID_YEAR_MIGRATION" && !firstSpectrePayDate) {
    back("First Spectre pay date is required for a mid-year implementation.");
  }
  if (firstSpectrePayDate && Number.isNaN(firstSpectrePayDate.getTime())) {
    back("First Spectre pay date is invalid.");
  }

  try {
    await declareImplementation(principal, clubId, {
      taxYear,
      mode,
      firstSpectrePayDate,
      notes,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = isAppError(err) ? err.safeMessage : (err as Error).message;
    back(`Could not save implementation declaration: ${msg}`);
  }
  revalidatePath("/app/admin/payroll/setup");
  revalidatePath("/app/admin/payroll");
  back(undefined, `Payroll implementation for ${taxYear} saved.`);
}

export async function revokeImplementationAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const taxYear = Number.parseInt(String(formData.get("taxYear") ?? ""), 10);
  if (!Number.isInteger(taxYear)) back("Tax year is required.");
  try {
    await revokeImplementationDeclaration(principal, clubId, taxYear);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = isAppError(err) ? err.safeMessage : (err as Error).message;
    back(`Could not revoke implementation declaration: ${msg}`);
  }
  revalidatePath("/app/admin/payroll/setup");
  revalidatePath("/app/admin/payroll");
  back(undefined, `Payroll implementation for ${taxYear} unconfirmed.`);
}

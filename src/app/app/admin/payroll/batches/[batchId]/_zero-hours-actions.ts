"use server";

// Slice E (2026-09-19) — server action for zero-hours acknowledgement.
// Called from the payroll batch review workspace. Requires payroll:edit.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import {
  acknowledgeZeroHours,
  type ZeroHoursReason,
} from "@/lib/payroll/zero-hours-acknowledgement";
import { ValidationError, ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";

function toErr(e: unknown): string {
  if (e instanceof ValidationError) return e.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
  if (e instanceof ConflictError || e instanceof ForbiddenError || e instanceof NotFoundError) return e.message;
  return e instanceof Error ? e.message : "Unexpected error";
}

export async function acknowledgeZeroHoursAction(form: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const batchId = String(form.get("batchId") ?? "");
  const batchEmployeeId = String(form.get("batchEmployeeId") ?? "");
  const reason = String(form.get("reason") ?? "") as ZeroHoursReason;
  const reasonDetail = String(form.get("reasonDetail") ?? "").trim() || null;
  try {
    await acknowledgeZeroHours(principal, clubId, { batchEmployeeId, reason, reasonDetail });
  } catch (e) {
    redirect(`/app/admin/payroll/batches/${batchId}?zeroHoursErr=${encodeURIComponent(toErr(e))}`);
  }
  revalidatePath(`/app/admin/payroll/batches/${batchId}`);
  redirect(`/app/admin/payroll/batches/${batchId}?zeroHoursOk=1`);
}

"use server";
// Slice B (2026-09-18) — server actions for pre-batch scheduled one-time
// earnings (Employee → Payroll → One-Time Earnings).

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import {
  scheduleOneTimeEarning,
  editOneTimeEarning,
  cancelOneTimeEarning,
  type ScheduleOneTimeEarningInput,
  type EditOneTimeEarningInput,
} from "@/lib/payroll/scheduled-one-time-earning";
import { isAppError } from "@/lib/errors";

export async function scheduleOneTimeEarningAction(
  clubId: string,
  employeeId: string,
  input: Omit<ScheduleOneTimeEarningInput, "employeeId"> & { employeeId?: string },
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const principal = await getCurrentPrincipal();
  if (!principal) return { ok: false, error: "Authentication required" };
  try {
    const view = await scheduleOneTimeEarning(principal, clubId, {
      employeeId,
      payPeriodId: input.payPeriodId,
      componentId: input.componentId,
      amount: input.amount,
      reason: input.reason,
      notes: input.notes ?? null,
      currency: input.currency ?? null,
    });
    revalidatePath(`/app/admin/people/employees/${employeeId}`);
    return { ok: true, id: view.id };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: err.message };
    return { ok: false, error: "Failed to schedule one-time earning." };
  }
}

export async function editOneTimeEarningAction(
  clubId: string,
  employeeId: string,
  scheduledId: string,
  input: EditOneTimeEarningInput,
): Promise<{ ok: boolean; error?: string }> {
  const principal = await getCurrentPrincipal();
  if (!principal) return { ok: false, error: "Authentication required" };
  try {
    await editOneTimeEarning(principal, clubId, scheduledId, input);
    revalidatePath(`/app/admin/people/employees/${employeeId}`);
    return { ok: true };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: err.message };
    return { ok: false, error: "Failed to edit one-time earning." };
  }
}

export async function cancelOneTimeEarningAction(
  clubId: string,
  employeeId: string,
  scheduledId: string,
  reason?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const principal = await getCurrentPrincipal();
  if (!principal) return { ok: false, error: "Authentication required" };
  try {
    await cancelOneTimeEarning(principal, clubId, scheduledId, { reason: reason ?? null });
    revalidatePath(`/app/admin/people/employees/${employeeId}`);
    return { ok: true };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: err.message };
    return { ok: false, error: "Failed to cancel one-time earning." };
  }
}

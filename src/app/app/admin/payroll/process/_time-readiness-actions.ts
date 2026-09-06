"use server";

// Payroll-3D-4 (2026-09-05) — Server actions for the time-readiness
// section on the Payroll Admin processing workspace.

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { getCurrentUser } from "@/lib/session";
import { freezeApprovedScopeIntoPayroll } from "@/lib/payroll/freeze-service";
import { resolveLateAdjustment, assertValidResolution } from "@/lib/payroll/late-time-service";

async function requireContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) throw new Error("Not authenticated");
  return { principal, clubId };
}

export async function freezeScopeAction(input: {
  payPeriodId:  string;
  departmentId: string;
}): Promise<{ ok: true; entriesCreated: number; entriesAlreadyFrozen: number; timing: "ON_TIME" | "LATE" } | { ok: false; error: string }> {
  try {
    const { principal, clubId } = await requireContext();
    const r = await freezeApprovedScopeIntoPayroll(principal, {
      clubId, payPeriodId: input.payPeriodId, departmentId: input.departmentId,
    });
    revalidatePath("/app/admin/payroll/process");
    return { ok: true, entriesCreated: r.entriesCreated, entriesAlreadyFrozen: r.entriesAlreadyFrozen, timing: r.timing };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Freeze failed." };
  }
}

export async function resolveLateAdjustmentAction(input: {
  adjustmentId: string;
  resolution:   string;
  notes?:       string | null;
}): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  try {
    const { principal, clubId } = await requireContext();
    assertValidResolution(input.resolution);
    const r = await resolveLateAdjustment(principal, clubId, {
      adjustmentId: input.adjustmentId,
      resolution: input.resolution,
      notes: input.notes ?? null,
    });
    revalidatePath("/app/admin/payroll/process");
    return { ok: true, status: r.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Resolve failed." };
  }
}

"use server";

// Payroll-3D-3 (2026-09-05) — Server actions for the manager
// timesheet-approval workspace.

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { getCurrentUser } from "@/lib/session";
import {
  approveCorrectionRequest,
  rejectCorrectionRequest,
} from "@/lib/timesheets/correction-service";
import { approveTimesheetScope } from "@/lib/timesheets/manager-approval";
import { ensureTimesheetApprovalWorkItems } from "@/lib/timesheets/orchestration";

async function requireContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) throw new Error("Not authenticated");
  return { principal, clubId };
}

export async function approveCorrectionAction(input: {
  requestId: string;
  reviewerNote?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { principal, clubId } = await requireContext();
    await approveCorrectionRequest(principal, clubId, {
      requestId: input.requestId,
      reviewerNote: input.reviewerNote ?? null,
    });
    revalidatePath("/app/admin/payroll/time");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to approve." };
  }
}

export async function rejectCorrectionAction(input: {
  requestId: string;
  reviewerNote?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { principal, clubId } = await requireContext();
    await rejectCorrectionRequest(principal, clubId, {
      requestId: input.requestId,
      reviewerNote: input.reviewerNote ?? null,
    });
    revalidatePath("/app/admin/payroll/time");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to reject." };
  }
}

export async function approveTimesheetScopeAction(input: {
  payPeriodId: string;
  departmentId: string;
  attestedRevision: string;
  notes?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { principal, clubId } = await requireContext();
    await approveTimesheetScope(principal, {
      clubId, payPeriodId: input.payPeriodId,
      departmentId: input.departmentId,
      attestedRevision: input.attestedRevision,
      notes: input.notes ?? null,
    });
    revalidatePath("/app/admin/payroll/time");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to approve." };
  }
}

export async function refreshWorkItemsAction(input: {
  payPeriodId: string;
}): Promise<{ ok: true; itemCount: number } | { ok: false; error: string }> {
  try {
    const { clubId } = await requireContext();
    const r = await ensureTimesheetApprovalWorkItems(clubId, input.payPeriodId);
    revalidatePath("/app/admin/payroll/time");
    return { ok: true, itemCount: r.items.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to refresh." };
  }
}

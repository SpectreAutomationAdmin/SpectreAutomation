"use server";

// Payroll-3D-3A (2026-09-05) — Tenant Admin server action for
// assigning / unassigning the DEPARTMENT_TIME_APPROVAL responsibility.

import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { getCurrentUser } from "@/lib/session";
import { assignDepartmentTimeApprover } from "@/lib/tenant-admin/department-responsibilities";
import { ensureTimesheetApprovalWorkItems } from "@/lib/timesheets/orchestration";
import { prisma } from "@/lib/prisma";

async function requireContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) throw new Error("Not authenticated");
  return { principal, clubId };
}

export async function assignTimeApproverAction(input: {
  departmentId: string;
  userId: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { principal, clubId } = await requireContext();
    await assignDepartmentTimeApprover(principal, {
      clubId, departmentId: input.departmentId, userId: input.userId,
    });
    // Re-materialise Work Intake cards for every currently-open pay
    // period so the config-gap card is retired / the manager card
    // appears with the new owner without waiting for the next cron.
    const openPeriods = await prisma.payrollPayPeriod.findMany({
      where: { clubId, periodEnd: { gt: new Date() } },
      select: { id: true }, take: 6,
    });
    for (const p of openPeriods) {
      await ensureTimesheetApprovalWorkItems(clubId, p.id);
    }
    revalidatePath("/app/admin/settings/time-approvers");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to save." };
  }
}

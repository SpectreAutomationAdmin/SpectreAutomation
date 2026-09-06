// Payroll MVP posting hotfix (2026-09-07) — server-side loader for
// the Controller · Final Approval queue rendered on the Payroll
// Processing page.
//
// Authorization rule (§3): only the user configured on
// PayrollClubConfig.controllerUserId sees this queue. The Payroll
// Admin (Raelene) must NOT see it — even with broad `payroll:read`.
// The temporary Founder Preview bridge (payrollAdminUserId /
// controllerUserId on PayrollClubConfig) governs this — the
// Responsibility Resolver (TA-1F) will replace it.
//
// Never infers from title, role label, or `payroll:approve`
// capability alone. The DB-configured Controller identity is the
// sole gate for this local Founder Preview.

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";

export interface ControllerQueueCard {
  workIntakeItemId: string;
  batchId:          string;
  subject:          string;
  preview:          string;
  receivedAtIso:    string;
  reviewHref:       string;
}

/**
 * Return the Controller's open PAYROLL_FINAL_APPROVAL cards for the
 * club, OR an empty array if the caller is not the configured
 * Controller for the club. Requires `payroll:read` (defense in depth
 * — a non-payroll user should not even reach the page).
 */
export async function loadControllerFinalApprovalQueue(
  principal: Principal,
  clubId: string,
): Promise<ControllerQueueCard[]> {
  requirePermission(principal, clubId, "payroll:read");

  const config = await prisma.payrollClubConfig.findUnique({
    where: { clubId },
    select: { controllerUserId: true },
  });
  if (!config?.controllerUserId) return [];
  if (config.controllerUserId !== principal.id) return [];

  const rows = await prisma.workIntakeOrigin.findMany({
    where: {
      clubId,
      kind: "PAYROLL_FINAL_APPROVAL",
      role: "PRIMARY",
      workIntakeItem: { status: "OPEN" },
    },
    select: {
      referenceId: true,
      workIntakeItem: {
        select: {
          id: true, displaySubject: true, displayPreview: true, displayReceivedAt: true,
          workDomain: true, workIntent: true, workSubtype: true,
          ownerUserId: true,
        },
      },
    },
    orderBy: { workIntakeItem: { displayReceivedAt: "desc" } },
    take: 20,
  });

  return rows.map((r) => ({
    workIntakeItemId: r.workIntakeItem.id,
    batchId:          r.referenceId,
    subject:          r.workIntakeItem.displaySubject,
    preview:          r.workIntakeItem.displayPreview,
    receivedAtIso:    r.workIntakeItem.displayReceivedAt.toISOString(),
    reviewHref:       `/app/admin/payroll/batches/${encodeURIComponent(r.referenceId)}`,
  }));
}

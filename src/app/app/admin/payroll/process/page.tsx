// Payroll-3B-4 (2026-08-29) — canonical Payroll Processing
// workspace. Deep-link target of the Work Intake PAYROLL_ADMIN_
// PROCESSING and PAYROLL_REVIEW cards.

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { findActiveBatchForPeriod, getPreparedBatch } from "@/lib/payroll/batch-preparation";
import { getDepartmentApprovalStatus } from "@/lib/payroll/department-approval";
import PayrollProcessWorkspace from "./PayrollProcessWorkspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PayrollProcessPage({
  searchParams,
}: {
  searchParams?: { payPeriodId?: string; batchId?: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) redirect("/app/admin");
  const canRun = hasPermission(principal, clubId, "payroll:run");

  const [payPeriods, club] = await Promise.all([
    prisma.payrollPayPeriod.findMany({
      where: { clubId },
      orderBy: [{ periodStart: "desc" }],
      take: 12,
      select: {
        id: true, periodStart: true, periodEnd: true, payDate: true,
        payGroup: { select: { name: true, code: true } },
      },
    }),
    prisma.club.findFirst({ where: { id: clubId }, select: { name: true } }),
  ]);

  const initialPeriodId = searchParams?.payPeriodId ?? payPeriods[0]?.id ?? null;
  let initialBatchId = searchParams?.batchId ?? null;
  if (!initialBatchId && initialPeriodId) {
    const b = await findActiveBatchForPeriod(principal, clubId, initialPeriodId);
    initialBatchId = b?.id ?? null;
  }
  const initialBatch = initialBatchId
    ? await getPreparedBatch(principal, clubId, initialBatchId)
    : null;
  const initialStatus = initialPeriodId
    ? await getDepartmentApprovalStatus(principal, clubId, initialPeriodId)
    : [];

  return (
    <div className="max-w-[1120px]" data-testid="payroll-process-page">
      <header className="mb-spectre-6">
        <div
          className="text-[11px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: "var(--spectre-text-muted)" }}
        >
          Operations · Payroll
        </div>
        <h1 className="mt-1 text-spectre-h1 font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
          Payroll processing
        </h1>
        <p className="mt-2 text-spectre-body" style={{ color: "var(--spectre-text-secondary)" }}>
          {club?.name ?? "Your Club"} — assemble the structural payroll batch once every
          department has approved its time. Dollar calculation is not performed here yet; that
          arrives in a later release.
        </p>
      </header>

      <PayrollProcessWorkspace
        clubId={clubId}
        canRun={canRun}
        payPeriods={payPeriods.map((p) => ({
          id: p.id,
          payGroupName: p.payGroup.name,
          payGroupCode: p.payGroup.code,
          periodStart: p.periodStart.toISOString(),
          periodEnd: p.periodEnd.toISOString(),
          payDate: p.payDate.toISOString(),
        }))}
        initialPeriodId={initialPeriodId}
        initialBatch={initialBatch}
        initialDepartmentStatus={initialStatus.map((s) => ({
          departmentId: s.departmentId,
          code: s.departmentCode,
          name: s.departmentName,
          state: s.state,
          employeeCount: s.employeeCount,
          totalHours: s.totalHours,
        }))}
      />
    </div>
  );
}

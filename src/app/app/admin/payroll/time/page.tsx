// Payroll-3B-3 (2026-08-28) — canonical Payroll Time workspace.
//
// This is the detail surface behind the Work Intake cards for
// department time approval. It is intentionally an operational
// workspace — Work Intake remains the orchestration layer (§30).
//
// Query params:
//   ?payPeriodId=... — pre-select a Pay Period (from the WI card)
//   ?departmentId=... — pre-select a Department (from the WI card)

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { getCurrentUser } from "@/lib/session";
import { getDepartmentApprovalStatus } from "@/lib/payroll/department-approval";
import PayrollTimeWorkspace from "./PayrollTimeWorkspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PayrollTimePage({
  searchParams,
}: {
  searchParams?: { payPeriodId?: string; departmentId?: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:timesheets:read")) redirect("/app/admin");

  const canWrite = hasPermission(principal, clubId, "payroll:write");
  const canApprove = hasPermission(principal, clubId, "payroll:timesheets:approve");

  const [payPeriods, departments, employees, club] = await Promise.all([
    prisma.payrollPayPeriod.findMany({
      where: { clubId },
      orderBy: [{ periodStart: "desc" }],
      take: 24,
      select: {
        id: true, taxYear: true, sequenceInYear: true,
        periodStart: true, periodEnd: true, payDate: true,
        payGroup: { select: { code: true, name: true } },
      },
    }),
    prisma.department.findMany({
      where: { clubId, isActive: true },
      orderBy: [{ code: "asc" }],
      select: { id: true, code: true, name: true },
    }),
    prisma.employee.findMany({
      where: { clubId },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: {
        id: true, firstName: true, lastName: true,
        preferredName: true, employeeNumber: true,
        employmentAssignments: {
          where: {
            role: "PRIMARY",
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
          },
          select: {
            id: true, departmentId: true, positionId: true,
            effectiveFrom: true, effectiveTo: true,
          },
        },
      },
    }),
    prisma.club.findFirst({ where: { id: clubId }, select: { name: true } }),
  ]);

  const activePeriodId = searchParams?.payPeriodId ?? payPeriods[0]?.id ?? null;
  const activeDepartmentId = searchParams?.departmentId ?? null;

  const initialStatus = activePeriodId
    ? await getDepartmentApprovalStatus(principal, clubId, activePeriodId)
    : [];

  return (
    <div className="max-w-[1120px]" data-testid="payroll-time-page">
      <header className="mb-spectre-6">
        <div
          className="text-[11px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: "var(--spectre-text-muted)" }}
        >
          Operations · Payroll
        </div>
        <h1 className="mt-1 text-spectre-h1 font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
          Payroll time
        </h1>
        <p className="mt-2 text-spectre-body" style={{ color: "var(--spectre-text-secondary)" }}>
          {club?.name ?? "Your Club"} — review and approve time by department for a pay period.
          Required work reaches you through the Work Intake feed; this page is the workspace behind those tasks.
        </p>
      </header>

      <PayrollTimeWorkspace
        clubId={clubId}
        canWrite={canWrite}
        canApprove={canApprove}
        payPeriods={payPeriods.map((p) => ({
          id: p.id,
          label: `${p.payGroup.name} · ${p.periodStart.toISOString().slice(0, 10)} → ${new Date(p.periodEnd.getTime() - 86_400_000).toISOString().slice(0, 10)}`,
          payDate: p.payDate.toISOString(),
        }))}
        departments={departments}
        employees={employees.map((e) => {
          const primary = e.employmentAssignments[0];
          return {
            id: e.id,
            display: [e.preferredName?.trim() || e.firstName, e.lastName].filter(Boolean).join(" "),
            employeeNumber: e.employeeNumber,
            primaryAssignmentId: primary?.id ?? null,
            primaryDepartmentId: primary?.departmentId ?? null,
          };
        })}
        initialPeriodId={activePeriodId}
        initialDepartmentId={activeDepartmentId}
        initialStatus={initialStatus.map((s) => ({
          ...s,
          approvedAt: s.approvedAt?.toISOString() ?? null,
          reopenedAt: s.reopenedAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}

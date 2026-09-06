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
import { loadControllerFinalApprovalQueue } from "@/lib/payroll/controller-queue";
import PayrollProcessWorkspace from "./PayrollProcessWorkspace";
import TimeReadinessSection from "./TimeReadinessSection";
import { getPayPeriodTimeReadiness } from "@/lib/payroll/freeze-service";
import { listOpenLateExceptions } from "@/lib/payroll/late-time-service";

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

  const [payPeriods, club, deepLinkedPeriod] = await Promise.all([
    prisma.payrollPayPeriod.findMany({
      where: { clubId },
      orderBy: [{ periodStart: "desc" }],
      take: 60,   // Payroll-3C-3 — enough to include every 2026
                  //   period across BOTH pay groups so a WI deep-link
                  //   never lands on a period the dropdown filtered out.
      select: {
        id: true, periodStart: true, periodEnd: true, payDate: true,
        payGroup: { select: { name: true, code: true } },
      },
    }),
    prisma.club.findFirst({ where: { id: clubId }, select: { name: true } }),
    // Payroll-3C-3 — belt-and-braces: always include the deep-linked
    // period even if it falls outside the take:60 window.
    searchParams?.payPeriodId
      ? prisma.payrollPayPeriod.findFirst({
          where: { id: searchParams.payPeriodId, clubId },
          select: {
            id: true, periodStart: true, periodEnd: true, payDate: true,
            payGroup: { select: { name: true, code: true } },
          },
        })
      : Promise.resolve(null),
  ]);
  const mergedPeriods = deepLinkedPeriod && !payPeriods.some((p) => p.id === deepLinkedPeriod.id)
    ? [deepLinkedPeriod, ...payPeriods]
    : payPeriods;
  const initialPeriodId = searchParams?.payPeriodId ?? mergedPeriods[0]?.id ?? null;
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

  // Payroll-3D-4 — time-readiness aggregate + open late exceptions.
  const timeReadiness = initialPeriodId
    ? await getPayPeriodTimeReadiness(principal, clubId, initialPeriodId)
    : null;
  const lateExceptions = initialPeriodId
    ? await listOpenLateExceptions(principal, clubId, initialPeriodId)
    : [];

  // Controller · Final approval queue — server-side scoped to the
  // configured Controller via PayrollClubConfig.controllerUserId
  // (see loadControllerFinalApprovalQueue). Returns [] for any user
  // who is not the Controller — including the Payroll Admin. The
  // Payroll Admin (Raelene) must never see Chris's approval work
  // on this page.
  const controllerQueue = await loadControllerFinalApprovalQueue(principal, clubId);

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
          {club?.name ?? "Your Club"} — confirm payroll readiness, prepare the batch, and
          calculate payroll for the selected pay period. Final approval is performed by the
          Controller on the batch review page.
        </p>
      </header>

      {controllerQueue.length > 0 && (
        <section
          className="mb-spectre-6 rounded-xl border border-emerald-200 bg-emerald-50/50 p-4"
          data-testid="payroll-controller-queue"
        >
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.06em]"
            style={{ color: "var(--spectre-text-muted)" }}
          >
            Controller · Final approval queue
          </div>
          <ul className="mt-3 space-y-3">
            {controllerQueue.map((c) => (
              <li
                key={c.workIntakeItemId}
                className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-stone-200 bg-white p-3"
                data-testid={`controller-queue-card:${c.batchId}`}
              >
                <div className="flex-1 min-w-[280px]">
                  <div className="text-sm font-medium" style={{ color: "var(--spectre-text-primary)" }}>
                    {c.subject}
                  </div>
                  <div className="mt-1 text-xs" style={{ color: "var(--spectre-text-secondary)" }}>
                    {c.preview}
                  </div>
                </div>
                <a
                  href={c.reviewHref}
                  className="btn btn-primary btn-sm whitespace-nowrap"
                  data-testid={`controller-queue-review:${c.batchId}`}
                >
                  Review payroll
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {timeReadiness && initialPeriodId ? (
        <TimeReadinessSection
          payPeriodId={initialPeriodId}
          scopes={timeReadiness.scopes.map((s) => ({
            departmentId: s.departmentId,
            departmentCode: s.departmentCode,
            departmentName: s.departmentName,
            employeeCount: s.employeeCount,
            entryCount: s.entryCount,
            entriesFrozenAndCurrent: s.entriesFrozenAndCurrent,
            entriesNotYetFrozen: s.entriesNotYetFrozen,
            openLateAdjustments: s.openLateAdjustments,
            approvalState: s.approvalState,
            approvalIsCurrent: s.approvalIsCurrent,
            overallState: s.overallState,
          }))}
          lateExceptions={lateExceptions.map((e) => ({
            id: e.id,
            employeeDisplay: `${e.employee.firstName} ${e.employee.lastName}`,
            reason: e.reason,
            differenceHours: e.differenceHours.toString(),
            createdAtIso: e.createdAt.toISOString(),
            notes: e.notes ?? null,
          }))}
          overallReady={timeReadiness.overallReady}
          hasOpenLateAdjustments={timeReadiness.hasOpenLateAdjustments}
          hasStaleApprovals={timeReadiness.hasStaleApprovals}
          hasUnapprovedScopes={timeReadiness.hasUnapprovedScopes}
          canFreeze={canRun}
        />
      ) : null}

      <PayrollProcessWorkspace
        clubId={clubId}
        canRun={canRun}
        payPeriods={mergedPeriods.map((p) => ({
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

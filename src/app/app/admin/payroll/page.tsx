// Payroll Admin 3A (2026-09-10) — real-data /app/admin/payroll route.
//
// Wraps the founder-approved Payroll Admin surface with real Payroll
// domain data assembled by `buildPayrollOverview`. URL params drive
// selection + filters + pagination so the operator can share a link
// to a specific period + filter state:
//
//   ?payGroupId=<pg>&payPeriodId=<pp>
//     &q=<name>&department=<departmentId>
//     &employmentType=Hourly|Salary&status=<display>&page=<n>
//
// READ-ONLY. This route never mutates a Payroll batch, never creates
// one, never calculates. Slice 3B+ handle mutations.
//
// Reference: docs/design/payroll/payroll-admin-desktop-1440x900-approved.png
// SHA-256:   d741321543eedbf3fa7991978132956d1f57359c4b01fce9f939c7948e72a7ce

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { buildPayrollOverview } from "@/lib/payroll/overview-view";
import PayrollAdminOverview from "@/components/payroll/PayrollAdminOverview";
import { preparePayrollAction } from "./_prepare-action";
import { freezeScopeFromOverviewAction } from "./_freeze-scope-action";
import {
  addAdjustmentAction,
  removeAdjustmentAction,
  createRecurringAssignmentAction,
  endRecurringAssignmentAction,
} from "./_adjustment-actions";
import { attestBatchReviewAction } from "./_review-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams?: {
    payGroupId?: string;
    payPeriodId?: string;
    q?: string;
    department?: string;
    employmentType?: string;
    status?: string;
    page?: string;
    pageSize?: string;
    tab?: string;
  };
}

export default async function PayrollAdminOverviewPage({ searchParams }: PageProps) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) {
    redirect("/app/admin");
  }
  const rawEmp = searchParams?.employmentType;
  const employmentType: "Hourly" | "Salary" | null =
    rawEmp === "Hourly" || rawEmp === "Salary" ? rawEmp : null;

  const pageSizeRaw = searchParams?.pageSize ? Number.parseInt(searchParams.pageSize, 10) : null;
  const pageSize = pageSizeRaw === 25 || pageSizeRaw === 50 ? pageSizeRaw : 10;

  const view = await buildPayrollOverview({
    principal,
    clubId,
    payGroupId: searchParams?.payGroupId ?? null,
    payPeriodId: searchParams?.payPeriodId ?? null,
    q: searchParams?.q ?? null,
    department: searchParams?.department ?? null,
    employmentType,
    status: searchParams?.status ?? null,
    page: searchParams?.page ? Math.max(1, Number.parseInt(searchParams.page, 10) || 1) : 1,
    pageSize,
    tab: searchParams?.tab ?? null,
  });

  const canPrepare = hasPermission(principal, clubId, "payroll:run");
  const canFreeze  = hasPermission(principal, clubId, "payroll:write");
  const canEditAdjustments = hasPermission(principal, clubId, "payroll:edit");
  const canWriteRecurring  = hasPermission(principal, clubId, "payroll:write");
  return (
    <PayrollAdminOverview
      view={view}
      prepare={{ action: preparePayrollAction, canPrepare }}
      freeze={{ action: freezeScopeFromOverviewAction, canFreeze }}
      adjustments={{
        addAction: addAdjustmentAction,
        removeAction: removeAdjustmentAction,
        canEdit: canEditAdjustments,
      }}
      recurring={{
        createAction: createRecurringAssignmentAction,
        endAction: endRecurringAssignmentAction,
        canWrite: canWriteRecurring,
      }}
      review={{
        action: attestBatchReviewAction,
        canAttest: canEditAdjustments,
      }}
    />
  );
}

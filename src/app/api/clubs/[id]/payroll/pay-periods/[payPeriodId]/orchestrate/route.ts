// Payroll-3B-3 (2026-08-28) — trigger the Work Intake orchestration
// for a Pay Period. Idempotent: repeat calls do NOT duplicate cards.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  orchestrateDepartmentApprovalTasks,
  orchestratePayrollAdminHandoff,
} from "@/lib/payroll/orchestration";
import { getDepartmentApprovalStatus } from "@/lib/payroll/department-approval";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; payPeriodId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:timesheets:read")) return NOT_FOUND;
  const status = await getDepartmentApprovalStatus(principal, params.id, params.payPeriodId);
  return NextResponse.json({ status });
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string; payPeriodId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:write")) return NOT_FOUND;
  try {
    const departmentTasks = await orchestrateDepartmentApprovalTasks(
      principal, params.id, params.payPeriodId,
    );
    const handoff = await orchestratePayrollAdminHandoff(
      principal, params.id, params.payPeriodId,
    );
    return NextResponse.json({ departmentTasks, handoff });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

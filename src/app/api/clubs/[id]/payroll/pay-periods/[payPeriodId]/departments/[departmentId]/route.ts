// Payroll-3B-3 (2026-08-28) — department-level approval + reopen.
// POST { action: "approve" | "reopen", reason? }

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  approveDepartmentTime,
  reopenDepartmentTime,
} from "@/lib/payroll/department-approval";
import { orchestratePayrollAdminHandoff } from "@/lib/payroll/orchestration";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; payPeriodId: string; departmentId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:timesheets:approve")) return NOT_FOUND;
  let body: { action?: "approve" | "reopen"; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    if (body.action === "approve") {
      const result = await approveDepartmentTime(
        principal, params.id, params.payPeriodId, params.departmentId,
      );
      // After every department approval, evaluate the Payroll Admin
      // handoff — if this was the last outstanding department, the
      // handoff card is created here.
      const handoff = await orchestratePayrollAdminHandoff(principal, params.id, params.payPeriodId);
      return NextResponse.json({ result, handoff });
    }
    if (body.action === "reopen") {
      const result = await reopenDepartmentTime(
        principal, params.id, params.payPeriodId, params.departmentId, body.reason,
      );
      return NextResponse.json({ result });
    }
    return NextResponse.json({ error: "action must be 'approve' or 'reopen'" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

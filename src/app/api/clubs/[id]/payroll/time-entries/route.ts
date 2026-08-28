// Payroll-3B-3 (2026-08-28) — PayrollApprovedTimeEntry list + create.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  listTimeEntries,
  createTimeEntry,
  type EarningClassification,
  type ApprovalState,
} from "@/lib/payroll/approved-time";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:timesheets:read")) return NOT_FOUND;
  const url = new URL(req.url);
  const entries = await listTimeEntries(principal, params.id, {
    employeeId: url.searchParams.get("employeeId") ?? undefined,
    departmentId: url.searchParams.get("departmentId") ?? undefined,
    payPeriodId: url.searchParams.get("payPeriodId") ?? undefined,
    approvalState: (url.searchParams.get("approvalState") as ApprovalState | null) ?? undefined,
  });
  return NextResponse.json({ entries });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:write")) return NOT_FOUND;
  let body: {
    employeeId?: string;
    employmentAssignmentId?: string | null;
    workDate?: string;
    hours?: number | string;
    earningClassification?: EarningClassification;
    notes?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.employeeId || !body.workDate || body.hours === undefined) {
    return NextResponse.json({ error: "employeeId, workDate, and hours required" }, { status: 400 });
  }
  try {
    const result = await createTimeEntry(principal, params.id, {
      employeeId: body.employeeId,
      employmentAssignmentId: body.employmentAssignmentId ?? null,
      workDate: new Date(body.workDate),
      hours: body.hours,
      earningClassification: body.earningClassification,
      notes: body.notes ?? null,
    });
    return NextResponse.json({ entry: result.entry, departmentId: result.departmentId }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

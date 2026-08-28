// Payroll-3B-3 (2026-08-28) — single-entry PATCH + DELETE.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  updateTimeEntry,
  deleteTimeEntry,
  type EarningClassification,
} from "@/lib/payroll/approved-time";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; entryId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:write")) return NOT_FOUND;
  let body: {
    workDate?: string;
    hours?: number | string;
    earningClassification?: EarningClassification;
    employmentAssignmentId?: string | null;
    notes?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await updateTimeEntry(principal, params.id, params.entryId, {
      workDate: body.workDate ? new Date(body.workDate) : undefined,
      hours: body.hours,
      earningClassification: body.earningClassification,
      employmentAssignmentId: body.employmentAssignmentId,
      notes: body.notes,
    });
    return NextResponse.json({ entry: result.entry });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; entryId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:write")) return NOT_FOUND;
  try {
    const result = await deleteTimeEntry(principal, params.id, params.entryId);
    return NextResponse.json({ ok: true, departmentId: result.departmentId });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

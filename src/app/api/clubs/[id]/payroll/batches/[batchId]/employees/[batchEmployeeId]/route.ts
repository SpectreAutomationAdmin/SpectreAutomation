// Payroll-3B-5B-3A — per-employee Payroll Review DTO API.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getBatchEmployeeReview } from "@/lib/payroll/review-dto";
import { NotFoundError } from "@/lib/errors";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; batchId: string; batchEmployeeId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:read")) return NOT_FOUND;
  try {
    const detail = await getBatchEmployeeReview(principal, params.id, params.batchEmployeeId);
    return NextResponse.json(detail);
  } catch (err) {
    if (err instanceof NotFoundError) return NOT_FOUND;
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

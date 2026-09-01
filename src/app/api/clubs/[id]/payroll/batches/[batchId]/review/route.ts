// Payroll-3B-5B-3A — Payroll Review DTO (batch-level) API.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getBatchReview } from "@/lib/payroll/review-dto";
import { NotFoundError } from "@/lib/errors";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; batchId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:read")) return NOT_FOUND;
  try {
    const review = await getBatchReview(principal, params.id, params.batchId);
    return NextResponse.json(review);
  } catch (err) {
    if (err instanceof NotFoundError) return NOT_FOUND;
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

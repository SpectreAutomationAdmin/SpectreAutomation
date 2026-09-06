// Payroll MVP posting (2026-09-05) — approve batch endpoint.
//
// POST /api/clubs/[id]/payroll/batches/[batchId]/approve
//
// Requires `payroll:approve` at the club. Transitions
// CALCULATED → APPROVED. Idempotent — a repeat call by the same
// approver returns the current batch state without a second write.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { approvePayrollBatch } from "@/lib/payroll/approve-and-post";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string; batchId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  try {
    const batch = await approvePayrollBatch(principal, params.batchId);
    return NextResponse.json({
      ok: true,
      batch: {
        id: batch?.id, status: batch?.status,
        approvedAt: batch?.approvedAt, approvedByUserId: batch?.approvedByUserId,
      },
    });
  } catch (err) {
    if (err instanceof ValidationError) return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    if (err instanceof NotFoundError)   return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ConflictError)   return NextResponse.json({ error: err.message }, { status: 409 });
    if (err instanceof ForbiddenError)  return NextResponse.json({ error: err.message }, { status: 403 });
    // eslint-disable-next-line no-console
    console.error("[payroll approve]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

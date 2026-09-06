// Payroll-3C-4 (2026-09-09) — POST one-time payroll adjustment.
//
// POST /api/clubs/[id]/payroll/batches/[batchId]/adjustments
//   Body: { batchEmployeeId, componentCode, amount?, percentBps?, reason }
//
// Requires `payroll:run`. Batch must be PREPARED.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { addOneTimeAdjustment } from "@/lib/payroll/adjustments";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; batchId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  let body: {
    batchEmployeeId?: string; componentCode?: string;
    amount?: string | number | null; percentBps?: number | null; reason?: string;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  try {
    if (!body.batchEmployeeId || !body.componentCode || !body.reason) {
      return NextResponse.json({ error: "batchEmployeeId, componentCode and reason are required" }, { status: 400 });
    }
    const out = await addOneTimeAdjustment(principal, params.id, params.batchId, {
      batchEmployeeId: body.batchEmployeeId,
      componentCode: body.componentCode,
      amount: body.amount ?? null,
      percentBps: body.percentBps ?? null,
      reason: body.reason,
    });
    return NextResponse.json({ ok: true, snapshotId: out.snapshotId });
  } catch (err) {
    if (err instanceof ValidationError) return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    if (err instanceof NotFoundError)   return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ConflictError)   return NextResponse.json({ error: err.message }, { status: 409 });
    if (err instanceof ForbiddenError)  return NextResponse.json({ error: err.message }, { status: 403 });
    // eslint-disable-next-line no-console
    console.error("[payroll adjustment add]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

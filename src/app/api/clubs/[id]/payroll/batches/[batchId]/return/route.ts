// Payroll Admin Slice 3E (2026-09-12) — Return batch endpoint.
//
// POST /api/clubs/[id]/payroll/batches/[batchId]/return
// Body: { reason: string }
//
// Requires `payroll:return`. Transitions SUBMITTED_FOR_APPROVAL →
// RETURNED_FOR_CORRECTION, resolves the Controller Work Intake card,
// and materialises a PAYROLL_RETURNED_FOR_CORRECTION card for the
// Payroll Admin.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import {
  returnPayrollBatch,
  ReturnConcurrencyConflictError,
} from "@/lib/payroll/return-payroll-batch";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; batchId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  let reason = "";
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.reason === "string") reason = body.reason;
  } catch {
    /* fall through */
  }
  try {
    const result = await returnPayrollBatch(principal, params.id, params.batchId, reason);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    if (err instanceof ReturnConcurrencyConflictError)
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    if (err instanceof ValidationError)
      return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    if (err instanceof NotFoundError)   return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ConflictError)   return NextResponse.json({ error: err.message }, { status: 409 });
    if (err instanceof ForbiddenError)  return NextResponse.json({ error: err.message }, { status: 403 });
    // eslint-disable-next-line no-console
    console.error("[payroll return]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

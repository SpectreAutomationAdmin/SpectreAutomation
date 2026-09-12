// Payroll Admin Slice 3E (2026-09-12) — Submit batch endpoint.
//
// POST /api/clubs/[id]/payroll/batches/[batchId]/submit
// Body: { note?: string }
//
// Requires `payroll:submit`. Transitions CALCULATED → SUBMITTED_FOR_APPROVAL
// and materialises the Controller PAYROLL_FINAL_APPROVAL Work Intake card.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import {
  submitPayrollBatch,
  SubmitConcurrencyConflictError,
} from "@/lib/payroll/submit-payroll-batch";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; batchId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  let note: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.note === "string") note = body.note;
  } catch {
    /* fall through */
  }
  try {
    const result = await submitPayrollBatch(principal, params.id, params.batchId, { note });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    if (err instanceof SubmitConcurrencyConflictError)
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    if (err instanceof ValidationError)
      return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    if (err instanceof NotFoundError)   return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ConflictError)   return NextResponse.json({ error: err.message }, { status: 409 });
    if (err instanceof ForbiddenError)  return NextResponse.json({ error: err.message }, { status: 403 });
    // eslint-disable-next-line no-console
    console.error("[payroll submit]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// Payroll MVP posting (2026-09-05) — post batch endpoint.
//
// POST /api/clubs/[id]/payroll/batches/[batchId]/post
//
// Requires `payroll:post` at the club. Transitions APPROVED → POSTED
// and writes the balanced GL journal in one transaction. Idempotent
// on re-attempt.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string; batchId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  try {
    const result = await postPayrollBatch(principal, params.batchId);
    return NextResponse.json({
      ok: true,
      batch: {
        id: result.batch?.id, status: result.batch?.status,
        postedAt: result.batch?.postedAt, postedByUserId: result.batch?.postedByUserId,
        glJournalEntryId: result.journalEntryId,
      },
      gl: {
        journalEntryId: result.journalEntryId,
        totalDebits: result.totalDebits,
        totalCredits: result.totalCredits,
      },
      paymentTransmissionEnabled: false,
    });
  } catch (err) {
    if (err instanceof ValidationError) return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    if (err instanceof NotFoundError)   return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ConflictError)   return NextResponse.json({ error: err.message }, { status: 409 });
    if (err instanceof ForbiddenError)  return NextResponse.json({ error: err.message }, { status: 403 });
    // eslint-disable-next-line no-console
    console.error("[payroll post]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

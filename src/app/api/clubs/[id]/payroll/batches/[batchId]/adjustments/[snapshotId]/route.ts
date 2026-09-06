// Payroll-3C-4 (2026-09-09) — DELETE one-time payroll adjustment.
//
// DELETE /api/clubs/[id]/payroll/batches/[batchId]/adjustments/[snapshotId]

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { removeOneTimeAdjustment } from "@/lib/payroll/adjustments";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; batchId: string; snapshotId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  try {
    await removeOneTimeAdjustment(principal, params.id, { snapshotId: params.snapshotId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ValidationError) return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    if (err instanceof NotFoundError)   return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ConflictError)   return NextResponse.json({ error: err.message }, { status: 409 });
    if (err instanceof ForbiddenError)  return NextResponse.json({ error: err.message }, { status: 403 });
    // eslint-disable-next-line no-console
    console.error("[payroll adjustment remove]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

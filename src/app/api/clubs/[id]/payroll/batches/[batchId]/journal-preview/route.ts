// Payroll Admin Slice 3F (2026-09-13) — GL journal preview endpoint.
// GET /api/clubs/[id]/payroll/batches/[batchId]/journal-preview
// Requires `payroll:read`. Returns the canonical journal that would
// be committed by Post. NEVER writes.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { previewPayrollJournal } from "@/lib/payroll/payroll-journal-preview";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; batchId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  try {
    const preview = await previewPayrollJournal(principal, params.id, params.batchId);
    return NextResponse.json({ ok: true, preview });
  } catch (err) {
    if (err instanceof ValidationError) return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    if (err instanceof NotFoundError)   return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ConflictError)   return NextResponse.json({ error: err.message }, { status: 409 });
    if (err instanceof ForbiddenError)  return NextResponse.json({ error: err.message }, { status: 403 });
    // eslint-disable-next-line no-console
    console.error("[payroll journal-preview]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

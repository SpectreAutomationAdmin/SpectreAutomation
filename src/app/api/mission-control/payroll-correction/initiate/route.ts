// FPP-9B (2026-09-22) — Payroll correction initiate API route.
// POST /api/mission-control/payroll-correction/initiate
// Body: { originalBatchId: string, reason: string }
//
// Delegates to `initiateReverseAndCorrect` which enforces the full
// guard stack + creates the reversal + correction pair.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { initiateReverseAndCorrect } from "@/lib/payroll/correction";
import { ValidationError, NotFoundError, ConflictError, ForbiddenError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ ok: false, message: "Unauthenticated." }, { status: 401 });

  let body: { originalBatchId?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON." }, { status: 400 });
  }
  const originalBatchId = body.originalBatchId?.trim();
  const reason = body.reason;
  if (!originalBatchId || typeof reason !== "string") {
    return NextResponse.json({ ok: false, message: "originalBatchId and reason are required." }, { status: 400 });
  }

  const batch = await prisma.payrollBatch.findFirst({
    where: { id: originalBatchId },
    select: { clubId: true },
  });
  if (!batch) return NextResponse.json({ ok: false, message: "Original batch not found." }, { status: 404 });

  try {
    const result = await initiateReverseAndCorrect(principal, batch.clubId, originalBatchId, reason);
    return NextResponse.json({
      ok: true,
      reversalBatchId: result.reversalBatchId,
      correctionBatchId: result.correctionBatchId,
      originalBatchId: result.originalBatchId,
    });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", message: err.message }, { status: 403 });
    }
    if (err instanceof ValidationError) {
      return NextResponse.json({ ok: false, code: "VALIDATION", message: err.message, issues: err.issues }, { status: 400 });
    }
    if (err instanceof NotFoundError) {
      return NextResponse.json({ ok: false, code: "NOT_FOUND", message: "Batch not found." }, { status: 404 });
    }
    if (err instanceof ConflictError) {
      return NextResponse.json({ ok: false, code: "CONFLICT", message: err.message }, { status: 409 });
    }
    return NextResponse.json(
      { ok: false, code: "INTERNAL", message: (err as Error).message ?? "Unexpected error." },
      { status: 500 },
    );
  }
}

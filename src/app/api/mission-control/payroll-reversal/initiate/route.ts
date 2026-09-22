// FPP-9A (2026-09-22) — Payroll reversal initiate API route.
// POST /api/mission-control/payroll-reversal/initiate
// Body: { originalBatchId: string, reason: string }
//
// Payroll Admin authenticated. Delegates to `initiatePayrollReversal`
// which enforces payroll:submit + posting-guard + reason validity +
// original-batch POSTED-only + no-double-reversal + full atomic
// creation of the reversal PayrollBatch + WI item.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { initiatePayrollReversal } from "@/lib/payroll/reversal";
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

  // Resolve the batch's clubId — tenant scope check inside the service.
  const batch = await prisma.payrollBatch.findFirst({
    where: { id: originalBatchId },
    select: { clubId: true },
  });
  if (!batch) {
    return NextResponse.json({ ok: false, message: "Original batch not found." }, { status: 404 });
  }

  try {
    const result = await initiatePayrollReversal(principal, batch.clubId, originalBatchId, reason);
    return NextResponse.json({
      ok: true,
      reversalBatchId: result.reversalBatchId,
      workIntakeItemId: result.workIntakeItemId,
      totalGrossNegatedDisplay: result.totalGrossNegatedDisplay,
      totalNetNegatedDisplay: result.totalNetNegatedDisplay,
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

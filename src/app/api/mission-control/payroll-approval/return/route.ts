// FPP-6 (2026-09-21) — Mission Control preview: Controller returns a
// submitted payroll batch back to the Payroll Administrator. Backed
// by the existing `returnPayrollBatch` governance service:
//   • payroll:return permission
//   • training-mode + support-readonly guards
//   • only SUBMITTED_FOR_APPROVAL batches are returnable
//   • trimmed non-empty reason required
// The batch transitions to RETURNED_FOR_CORRECTION — NOT VOIDED. This
// is the Controller-return semantic, distinct from FPP-5C's
// Payroll-Admin Return-to-Preparation which voids the batch.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { returnPayrollBatch } from "@/lib/payroll/return-payroll-batch";
import { ValidationError, NotFoundError, ConflictError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ ok: false, message: "Unauthenticated." }, { status: 401 });

  let body: { workIntakeItemId?: string; batchId?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON." }, { status: 400 });
  }
  const workIntakeItemId = body.workIntakeItemId?.trim();
  const batchId = body.batchId?.trim();
  const reason = body.reason?.trim();
  if (!workIntakeItemId || !batchId) {
    return NextResponse.json({ ok: false, message: "workIntakeItemId and batchId are required." }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ ok: false, message: "Reason is required." }, { status: 400 });
  }

  // Tenant-scoped binding: WI item origin must reference this batch.
  const origin = await prisma.workIntakeOrigin.findFirst({
    where: {
      workIntakeItemId,
      kind: "PAYROLL_FINAL_APPROVAL",
      role: "PRIMARY",
      referenceId: batchId,
    },
    select: { clubId: true },
  });
  if (!origin) {
    return NextResponse.json(
      { ok: false, message: "This approval request is not linked to the referenced batch." },
      { status: 404 },
    );
  }

  try {
    await returnPayrollBatch(principal, origin.clubId, batchId, reason);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ ok: false, code: "VALIDATION", message: err.message }, { status: 400 });
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

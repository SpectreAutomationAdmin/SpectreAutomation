// FPP-6 (2026-09-21) — Mission Control preview: Controller approves
// a submitted payroll batch. Backed by the existing
// `approvePayrollBatch` governance service, which enforces:
//   • payroll:approve permission
//   • training-mode + support-readonly guards (posting-guard)
//   • submitter != approver segregation-of-duties
//   • calculationVersion CAS
// This route adds no new behaviour — it is a thin JSON adapter.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { approvePayrollBatch, ApproveSegregationOfDutiesError } from "@/lib/payroll/approve-and-post";
import { ValidationError, NotFoundError, ConflictError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ ok: false, message: "Unauthenticated." }, { status: 401 });

  let body: { workIntakeItemId?: string; batchId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON." }, { status: 400 });
  }
  const workIntakeItemId = body.workIntakeItemId?.trim();
  const batchId = body.batchId?.trim();
  if (!workIntakeItemId || !batchId) {
    return NextResponse.json({ ok: false, message: "workIntakeItemId and batchId are required." }, { status: 400 });
  }

  // Tenant-scoped binding check: the WI item MUST originate the batch
  // via a PAYROLL_FINAL_APPROVAL PRIMARY origin. This prevents a
  // client from mixing a WI id from one tenant with a batch id from
  // another.
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
    await approvePayrollBatch(principal, batchId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ApproveSegregationOfDutiesError) {
      return NextResponse.json(
        { ok: false, code: "SELF_APPROVAL", message: "You cannot approve a payroll you submitted." },
        { status: 403 },
      );
    }
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

// FPP-8 (2026-09-21) — Mission Control preview: Payroll Admin posts
// an APPROVED payroll batch. Backed by the existing
// `postPayrollBatch` governance service, which enforces:
//   • payroll:post permission
//   • training-mode + support-readonly guards (posting-guard)
//   • batch.status === APPROVED (via atomic CAS in $transaction)
//   • idempotent — already POSTED returns existing journal
//   • balanced canonical GL journal (via previewPayrollJournal
//     resolver — same one the UI preview consumes)
//   • GL readiness + PayrollGlAccountingProfile presence
// This route adds no new behaviour — it is a thin JSON adapter that
// binds the Work Intake origin to the batch and delegates.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { ValidationError, NotFoundError, ConflictError, ForbiddenError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ ok: false, message: "Unauthenticated." }, { status: 401 });

  let body: { workIntakeItemId?: string; batchId?: string; expectedCalculationVersion?: number };
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
  // via a PAYROLL_READY_TO_POST PRIMARY origin.
  const origin = await prisma.workIntakeOrigin.findFirst({
    where: {
      workIntakeItemId,
      kind: "PAYROLL_READY_TO_POST",
      role: "PRIMARY",
      referenceId: batchId,
    },
    select: { clubId: true },
  });
  if (!origin) {
    return NextResponse.json(
      { ok: false, message: "This posting task is not linked to the referenced batch." },
      { status: 404 },
    );
  }

  try {
    // Pre-flight calculationVersion check — refuse if the approved
    // package the client reviewed has drifted. The server-side
    // postPayrollBatch also guards on status === APPROVED via CAS,
    // so this pre-flight is defence in depth, not the authoritative
    // guard.
    if (typeof body.expectedCalculationVersion === "number") {
      const cur = await prisma.payrollBatch.findFirst({
        where: { id: batchId, clubId: origin.clubId },
        select: { calculationVersion: true },
      });
      if (cur && cur.calculationVersion !== body.expectedCalculationVersion) {
        return NextResponse.json(
          {
            ok: false,
            code: "STALE_CALCULATION",
            message: `Payroll changed after approval (expected v${body.expectedCalculationVersion}, current v${cur.calculationVersion}). Reload and review the current approval.`,
          },
          { status: 409 },
        );
      }
    }
    const result = await postPayrollBatch(principal, batchId);
    return NextResponse.json({
      ok: true,
      journalEntryId: result.journalEntryId,
      totalDebits: result.totalDebits,
      totalCredits: result.totalCredits,
    });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { ok: false, code: "FORBIDDEN", message: "You do not have permission to post payroll." },
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

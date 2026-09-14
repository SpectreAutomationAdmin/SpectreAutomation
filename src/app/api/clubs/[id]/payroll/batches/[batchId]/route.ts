// Payroll-3B-4 (2026-08-29) — batch GET + POST(void).

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  discardPreparedPayrollBatch,
  getPreparedBatch,
  voidPayrollBatch,
} from "@/lib/payroll/batch-preparation";
import { orchestratePayrollReviewVoid } from "@/lib/payroll/orchestration";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; batchId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:read")) return NOT_FOUND;
  const batch = await getPreparedBatch(principal, params.id, params.batchId);
  if (!batch) return NOT_FOUND;
  return NextResponse.json({ batch });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; batchId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:run")) return NOT_FOUND;
  let body: { action?: "void" | "discard"; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  // Discard-Prepared-Payroll hotfix (2026-09-14) — `discard` is the
  // founder-facing verb for abandoning a PREPARED batch; internally it
  // lands the batch in VOIDED (one canonical state, distinct audit event).
  if (body.action !== "void" && body.action !== "discard") {
    return NextResponse.json({ error: "action must be 'void' or 'discard'" }, { status: 400 });
  }
  try {
    const result = body.action === "discard"
      ? await discardPreparedPayrollBatch(principal, params.id, params.batchId, body.reason)
      : await voidPayrollBatch(principal, params.id, params.batchId, body.reason);
    // Also transition WI cards.
    const batch = await getPreparedBatch(principal, params.id, params.batchId);
    if (batch) {
      await orchestratePayrollReviewVoid(principal, params.id, batch.payPeriodId, params.batchId);
    }
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

// Payroll-3B-4 (2026-08-29) — prepare batch.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { orchestratePayrollReviewHandoff } from "@/lib/payroll/orchestration";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:run")) return NOT_FOUND;
  let body: { payPeriodId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.payPeriodId) {
    return NextResponse.json({ error: "payPeriodId required" }, { status: 400 });
  }
  try {
    const result = await preparePayrollBatch(principal, params.id, body.payPeriodId);
    // Only spawn the Review handoff for a successful non-existing
    // preparation (or an existing PREPARED batch).
    const handoff = result.status === "prepared" || result.status === "prepared-with-blockers"
      ? await orchestratePayrollReviewHandoff(principal, params.id, body.payPeriodId, result.batchId)
      : null;
    return NextResponse.json({ result, handoff });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

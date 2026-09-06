// Payroll MVP posting hotfix (2026-09-07) — calculate endpoint.
//
// POST /api/clubs/[id]/payroll/batches/[batchId]/calculate
//
// Requires `payroll:run`. Transitions PREPARED → CALCULATED via the
// canonical calculatePayrollBatch service. Idempotent when re-run
// (service refuses/handles a batch already at CALCULATED / later
// state through its own guards).

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string; batchId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:run")) return NOT_FOUND;
  try {
    const result = await calculatePayrollBatch(principal, params.id, params.batchId);
    return NextResponse.json({ result });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[payroll calculate]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

// PAY-1A/5 (2026-09-26) — Payroll → Payments prepare API.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { preparePayrollPayments } from "@/lib/payments";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: { batchId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    clubId?: string;
    fundingBankAccountId?: string;
    requestedExecutionDate?: string;
  };
  if (!body.clubId || !body.fundingBankAccountId) {
    return NextResponse.json({ error: "clubId + fundingBankAccountId required" }, { status: 400 });
  }
  try {
    const result = await preparePayrollPayments(principal, {
      clubId: body.clubId,
      payrollBatchId: params.batchId,
      fundingBankAccountId: body.fundingBankAccountId,
      requestedExecutionDate: body.requestedExecutionDate ? new Date(body.requestedExecutionDate) : null,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

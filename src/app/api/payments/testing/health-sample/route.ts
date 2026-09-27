// PAY-1B.1 (2026-09-27) — health-sample testing hook.
//
// Feeds a health outcome (OK / FAILURE) into a PaymentProviderConnection
// so the deployed circuit-breaker can be exercised end-to-end from
// Playwright without a real provider outage.
//
// Guards (same shape as the simulator-directive hook):
//   • refuses when PAYMENTS_REAL_MONEY_ENABLED is true;
//   • requires payment:authorize (Controller-tier);
//   • operates ONLY on PaymentProviderConnection.health tracking —
//     never on financial state.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordHealthSample } from "@/lib/payments/provider/health";
import { realMoneyEnabled } from "@/lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (realMoneyEnabled()) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    connectionId?: string;
    outcome?: "OK" | "FAILURE";
    times?: number;
  };
  if (!body.connectionId || !body.outcome) {
    return NextResponse.json({ error: "connectionId + outcome required" }, { status: 400 });
  }

  const c = await prisma.paymentProviderConnection.findUnique({
    where: { id: body.connectionId },
    select: { clubId: true },
  });
  if (!c) return NextResponse.json({ error: "connection not found" }, { status: 404 });
  if (!hasPermission(principal, c.clubId, "payment:authorize")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const n = Math.max(1, Math.min(body.times ?? 1, 20));
  let last;
  for (let i = 0; i < n; i++) {
    last = await recordHealthSample({ connectionId: body.connectionId, outcome: body.outcome });
  }
  return NextResponse.json({ ok: true, samplesRecorded: n, final: last });
}

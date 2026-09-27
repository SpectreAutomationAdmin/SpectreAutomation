// PAY-1A/5 (2026-09-26) — PaymentRun action API.
//
// One route handles: submit-for-authorization, authorize, return,
// cancel, submit-to-provider, poll. Body: { action, reason? }.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import {
  submitForAuthorization,
  authorizePaymentRun,
  returnPaymentRun,
  cancelPaymentRun,
  scheduleAndSubmit,
  pollAndAdvance,
  retrySubmit,
} from "@/lib/payments";
import { assertConnectionUsable } from "@/lib/payments/provider/health";
import { resolveActiveConnection } from "@/lib/payments/provider/connection";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: { runId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    reason?: string;
    connectionId?: string;
  };
  try {
    switch (body.action) {
      case "submit-for-authorization": {
        const r = await submitForAuthorization(principal, params.runId);
        return NextResponse.json(r);
      }
      case "authorize": {
        const r = await authorizePaymentRun(principal, params.runId);
        return NextResponse.json(r);
      }
      case "return": {
        await returnPaymentRun(principal, params.runId, body.reason ?? "");
        return NextResponse.json({ ok: true });
      }
      case "cancel": {
        await cancelPaymentRun(principal, params.runId, body.reason ?? "");
        return NextResponse.json({ ok: true });
      }
      case "submit-to-provider": {
        // PAY-1B.1: optional connectionId gates on
        // assertConnectionUsable (DEGRADED / SUSPENDED / REVOKED
        // refused) AND resolveActiveConnection (PRODUCTION on
        // staging refused) before any provider call.
        if (body.connectionId) {
          const run = await prisma.paymentRun.findUnique({
            where: { id: params.runId },
            select: { clubId: true },
          });
          if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
          const conn = await prisma.paymentProviderConnection.findUnique({
            where: { id: body.connectionId },
            select: { clubId: true, providerType: true },
          });
          if (!conn) return NextResponse.json({ error: "connection not found" }, { status: 404 });
          if (conn.clubId !== run.clubId) {
            return NextResponse.json({ error: "connection tenant mismatch" }, { status: 403 });
          }
          await assertConnectionUsable(body.connectionId);
          await resolveActiveConnection(conn.clubId, conn.providerType);
        }
        const r = await scheduleAndSubmit(principal, params.runId);
        return NextResponse.json(r);
      }
      case "retry-submit": {
        const r = await retrySubmit(principal, params.runId);
        return NextResponse.json(r);
      }
      case "poll": {
        const r = await pollAndAdvance(params.runId);
        return NextResponse.json(r);
      }
      default:
        return NextResponse.json({ error: `unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

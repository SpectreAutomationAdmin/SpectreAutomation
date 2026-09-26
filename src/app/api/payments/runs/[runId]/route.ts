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
} from "@/lib/payments";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: { runId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { action?: string; reason?: string };
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
        const r = await scheduleAndSubmit(principal, params.runId);
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

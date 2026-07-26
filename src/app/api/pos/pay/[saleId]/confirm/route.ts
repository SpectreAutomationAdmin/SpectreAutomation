// Public QR-pay simulator endpoint: confirm a pending payment.
//
// Auth model: this endpoint is public (the QR code is the bearer
// credential). It's deliberately fenced to dev/training by an
// env check — never enabled in production — and uses the original
// sale's creator principal so the AR/GL post is attributed to the
// operator who issued the QR.
//
// A real payment processor would call /api/integrations/pos/[provider]/webhook
// with a signed callback and use the same `confirmQRPayment` service.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { confirmQRPayment, principalForSaleConfirmation } from "@/lib/pos/checks";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { saleId: string } }) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Simulator endpoints disabled in production" }, { status: 403 });
  }
  const principal = await principalForSaleConfirmation(params.saleId);
  if (!principal) {
    return NextResponse.json({ error: "Sale not found or no creator" }, { status: 404 });
  }
  try {
    const proto = req.headers.get("x-forwarded-proto") ?? "http";
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
    const origin = `${proto}://${host}`;
    await confirmQRPayment(principal, params.saleId, {
      origin,
      gatewayReference: `dev-sim-${Date.now()}`,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

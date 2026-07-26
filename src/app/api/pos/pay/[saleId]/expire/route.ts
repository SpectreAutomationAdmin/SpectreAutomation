// Public QR-pay simulator endpoint: expire a pending payment.

import { NextRequest, NextResponse } from "next/server";
import { expireQRPayment, principalForSaleConfirmation } from "@/lib/pos/checks";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, { params }: { params: { saleId: string } }) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Simulator endpoints disabled in production" }, { status: 403 });
  }
  const principal = await principalForSaleConfirmation(params.saleId);
  if (!principal) {
    return NextResponse.json({ error: "Sale not found or no creator" }, { status: 404 });
  }
  try {
    await expireQRPayment(principal, params.saleId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

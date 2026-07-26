// Phase 11F — Billing webhook receiver.
//
// Stripe (or mock) POSTs JSON; this route verifies the signature, persists
// the BillingWebhookEvent, and updates ClubSubscription entitlement status.

import { NextRequest, NextResponse } from "next/server";
import { handleWebhook } from "@/lib/billing";
import { logger } from "@/lib/observability/logger";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature") ?? req.headers.get("x-spectre-billing-signature") ?? "";
  const clubId = req.nextUrl.searchParams.get("clubId") ?? undefined;
  try {
    const result = await handleWebhook({ rawBody, signature, clubId });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("billing.webhook.route_error", { error: message });
    return NextResponse.json({ error: "billing webhook handling failed", detail: message }, { status: 500 });
  }
}

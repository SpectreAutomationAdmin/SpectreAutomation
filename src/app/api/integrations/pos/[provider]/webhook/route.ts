// Phase 8B — Public POS webhook receiver.
//
// Provider POSTs raw JSON; this route verifies the signature, persists the
// POSWebhookEvent, and enqueues a job. No authentication header — security is
// the provider signature + replay prevention + rate limiting.

import { NextRequest, NextResponse } from "next/server";
import { receiveWebhook } from "@/lib/pos/webhooks";
import { logger } from "@/lib/observability/logger";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { provider: string } }) {
  const clubId = req.nextUrl.searchParams.get("clubId");
  if (!clubId) return NextResponse.json({ error: "clubId query parameter is required" }, { status: 400 });
  const rawBody = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const remoteAddress = req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip") ?? undefined;
  try {
    const result = await receiveWebhook({
      clubId, providerKey: params.provider, rawBody, headers,
      url: req.nextUrl.toString(),
      remoteAddress: remoteAddress ?? undefined,
    });
    return NextResponse.json(result, { status: result.status === "FAILED" ? 401 : 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("pos.webhook.route_error", { provider: params.provider, error: message });
    return NextResponse.json({ error: "webhook handling failed", detail: message }, { status: 500 });
  }
}

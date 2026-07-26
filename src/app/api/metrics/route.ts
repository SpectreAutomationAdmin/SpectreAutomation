// Phase 9A — Prometheus metrics endpoint.
//
// GET /api/metrics → text/plain Prometheus exposition. The endpoint is
// public-but-rate-limited so a load balancer can scrape; protect at the
// network layer (allowlist) for production.

import { NextRequest, NextResponse } from "next/server";
import { getObservability } from "@/lib/observability/adapter";
import { consumeRate } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for") ?? "unknown";
  const limit = await consumeRate("download", `metrics:${ip}`);
  if (!limit.allowed) {
    return new NextResponse("rate limited", { status: 429, headers: { "retry-after": Math.ceil((limit.retryAfterMs ?? 60_000) / 1000).toString() } });
  }
  const body = await getObservability().exportMetrics();
  return new NextResponse(body, { status: 200, headers: { "content-type": "text/plain; version=0.0.4" } });
}

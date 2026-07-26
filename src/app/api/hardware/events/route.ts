// Phase 8E — Public hardware event ingestion.
//
// Devices POST { serial, authToken, eventType, metadata }. The default
// hardware adapter verifies the auth-token hash against the registered
// device and stores a DeviceEvent + (for HEARTBEAT) a DeviceStatus.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ingestDeviceEvent } from "@/lib/hardware";
import { consumeRate } from "@/lib/security/rate-limit";
import { logger } from "@/lib/observability/logger";

export const runtime = "nodejs";

const schema = z.object({
  clubId: z.string(),
  serial: z.string(),
  authToken: z.string(),
  eventType: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  occurredAt: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const remote = req.headers.get("x-forwarded-for") ?? "unknown";
  const limit = await consumeRate("webhook_pos", `hardware:${remote}`);
  if (!limit.allowed) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": Math.ceil((limit.retryAfterMs ?? 60_000) / 1000).toString() } });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 400 });
  const d = parsed.data;
  try {
    const result = await ingestDeviceEvent({
      clubId: d.clubId, deviceSerial: d.serial, authToken: d.authToken,
      eventType: d.eventType, metadata: d.metadata,
      occurredAt: d.occurredAt ? new Date(d.occurredAt) : undefined,
    });
    if (!result.accepted) return NextResponse.json({ error: result.reason }, { status: 403 });
    return NextResponse.json({ accepted: true, eventId: result.eventId });
  } catch (err) {
    logger.error("hardware.event.route_error", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "ingestion failed" }, { status: 500 });
  }
}

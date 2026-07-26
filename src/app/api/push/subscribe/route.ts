// Phase 9D — Push subscription endpoint.
//
// Browser POSTs the PushManager.subscribe() result; we persist it as a
// WebPushSubscription scoped to the current user / member.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { subscribe, unsubscribe } from "@/lib/push";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  try {
    const sub = await subscribe(principal, clubId, body);
    return NextResponse.json({ subscribed: true, id: sub.id });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  let body: { endpoint?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  if (!body.endpoint) return NextResponse.json({ error: "endpoint required" }, { status: 400 });
  await unsubscribe(principal, body.endpoint);
  return NextResponse.json({ unsubscribed: true });
}

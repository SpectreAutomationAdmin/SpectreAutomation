// PAY-1B/5 (2026-09-27) — SIMULATOR webhook.
//
// Public HTTP entry point for the simulator's async event stream.
// Every payload is fed through the simulator's verifyExternalEvent
// (synthetic signature check), normalized into an
// ExternalPaymentEventEnvelope, and handed to ingestExternalEvent
// which enforces the boundary invariants:
//   • duplicate replay is IGNORED_DUPLICATE
//   • unverified signature is REJECTED_UNVERIFIED
//   • wrong tenant is REJECTED_TENANT_MISMATCH
//   • unknown status is REJECTED_UNKNOWN_STATUS
//   • amount/currency mismatch is fail-closed
//   • out-of-order events cannot regress financial state
//
// The webhook is public (no session cookie required) — this is the
// nature of provider callbacks. The security boundary is the
// signature verification enforced by the adapter and re-checked by
// the ingestion service.

import { NextRequest, NextResponse } from "next/server";
import { getSimulatorV2 } from "@/lib/payments/provider/simulator";
import { ingestExternalEvent } from "@/lib/payments/external-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const clubId = url.searchParams.get("clubId");
  if (!clubId) {
    return NextResponse.json({ error: "clubId query param required" }, { status: 400 });
  }
  const raw = await req.text();
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: "invalid JSON payload" }, { status: 400 });
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });

  const provider = getSimulatorV2();
  const envelope = await provider.verifyExternalEvent!(payload, headers);
  const result = await ingestExternalEvent({ clubId, envelope });
  return NextResponse.json({ ...result, verificationStatus: envelope.verificationStatus });
}

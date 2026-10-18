// WI-SYNC-1d (2026-10-18) — Microsoft Graph change-notification
// webhook.  Handles two separate operations through one URL:
//
//   1. VALIDATION HANDSHAKE (one-shot, on subscription creation).
//      Graph POSTs with `?validationToken=<opaque>`.  Spectre
//      MUST echo the exact validationToken as plain text, 200,
//      within 10 seconds.  No DB touch, no auth needed.
//
//   2. NOTIFICATION DELIVERY (ongoing).  Graph POSTs a JSON body
//      `{ value: [ { subscriptionId, clientState, changeType,
//        resource, resourceData, tenantId, ... } ] }` whenever a
//      watched resource changes.  Spectre:
//        a. parses each notification;
//        b. matches `subscriptionId` to a GraphSubscription row;
//        c. verifies hash(clientState) === row.clientStateSecretRef;
//        d. tenant-checks row.clubId against the mailbox;
//        e. updates row.lastNotificationAt + enqueues a time-
//           bucketed MAILBOX_DELTA_SYNC job (idempotent — the
//           polling scheduler's same job kind + bucket collision
//           prevents duplicate work when both arrive);
//        f. responds 202.
//      Invalid / unrecognised notifications are rejected with 400
//      and NEVER trigger any mailbox operation.
//
// Public endpoint: NO session required (Graph has no cookies).
// Security relies on:
//   - clientState hash check — only Spectre + Microsoft know the
//     plaintext secret;
//   - subscriptionId whitelist — row must exist;
//   - tenant isolation — the row's clubId is used for enqueue.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { hashClientState } from "@/lib/mailbox/subscriptions";
import { isMailboxIntegrationEnabled } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  resourceData?: {
    "@odata.id"?: string;
    id?: string;
    "@odata.type"?: string;
  };
  tenantId?: string;
  subscriptionExpirationDateTime?: string;
}

export async function POST(req: NextRequest) {
  // --- 1. VALIDATION HANDSHAKE -------------------------------------
  const validationToken = req.nextUrl.searchParams.get("validationToken");
  if (validationToken) {
    // Echo plain text, 200.  Graph is strict about Content-Type.
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (!isMailboxIntegrationEnabled()) {
    // The webhook is disabled — respond 410 so Graph eventually
    // retires the subscription.
    return NextResponse.json({ error: "integration_disabled" }, { status: 410 });
  }

  // --- 2. NOTIFICATION DELIVERY ------------------------------------
  let body: { value?: GraphNotification[] } | null = null;
  try {
    body = (await req.json()) as { value?: GraphNotification[] };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || !Array.isArray(body.value) || body.value.length === 0) {
    return NextResponse.json({ error: "empty_notifications" }, { status: 400 });
  }

  const results: Array<{
    subscriptionId: string | null;
    outcome:
      | "ENQUEUED"
      | "DUPLICATE_SUPPRESSED"
      | "UNKNOWN_SUBSCRIPTION"
      | "CLIENT_STATE_MISMATCH"
      | "INVALID_SHAPE";
  }> = [];

  for (const n of body.value) {
    if (!n.subscriptionId || !n.clientState) {
      results.push({ subscriptionId: n.subscriptionId ?? null, outcome: "INVALID_SHAPE" });
      continue;
    }
    const sub = await prisma.graphSubscription.findUnique({
      where: { microsoftSubscriptionId: n.subscriptionId },
      select: {
        id: true,
        clubId: true,
        mailboxConnectionId: true,
        clientStateSecretRef: true,
        lifecycleState: true,
      },
    });
    if (!sub) {
      results.push({ subscriptionId: n.subscriptionId, outcome: "UNKNOWN_SUBSCRIPTION" });
      continue;
    }
    if (hashClientState(n.clientState) !== sub.clientStateSecretRef) {
      logger.warn("mailbox.webhook.client_state_mismatch", {
        subscriptionIdTail: sub.id.slice(-6),
      });
      results.push({ subscriptionId: n.subscriptionId, outcome: "CLIENT_STATE_MISMATCH" });
      continue;
    }
    // Update lastNotificationAt + enqueue expedited delta.  The
    // delta scheduler uses a time-bucketed idempotency key so
    // concurrent notifications in the same minute collapse to one
    // Graph round-trip.
    const now = new Date();
    const intervalMs = Number(process.env.MAILBOX_AUTO_SYNC_INTERVAL_MS ?? "60000");
    const bucket = Math.floor(now.getTime() / intervalMs);
    const { enqueue } = await import("@/lib/queue");
    let outcome: "ENQUEUED" | "DUPLICATE_SUPPRESSED" = "ENQUEUED";
    try {
      await enqueue({
        kind: "MAILBOX_DELTA_SYNC",
        queue: "mailbox",
        clubId: sub.clubId,
        payload: { mailboxConnectionId: sub.mailboxConnectionId },
        idempotencyKey: `mailbox:webhook-delta:${sub.mailboxConnectionId}:${bucket}`,
        maxAttempts: 3,
      });
    } catch (e) {
      // Enqueue conflicts are expected under duplicate delivery —
      // record and continue.
      outcome = "DUPLICATE_SUPPRESSED";
      logger.info("mailbox.webhook.enqueue.duplicate_suppressed", {
        subscriptionIdTail: sub.id.slice(-6),
        error: e instanceof Error ? e.message : String(e),
      });
    }
    await prisma.graphSubscription.update({
      where: { id: sub.id },
      data: {
        lastNotificationAt: now,
        lastNotificationTriggeredDeltaAt: outcome === "ENQUEUED" ? now : undefined,
      },
    });
    results.push({ subscriptionId: n.subscriptionId, outcome });
  }

  logger.info("mailbox.webhook.processed", { count: body.value.length });
  // Graph treats 202 as success.  200 would also work.  Always
  // respond quickly (we're already fully-processed by here).
  return NextResponse.json({ ok: true, results }, { status: 202 });
}

/** Graph also permits GET for the validation-token handshake on
 *  some scenarios.  Preserve support. */
export async function GET(req: NextRequest) {
  const validationToken = req.nextUrl.searchParams.get("validationToken");
  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return NextResponse.json({ error: "method_not_allowed_without_validation_token" }, { status: 405 });
}

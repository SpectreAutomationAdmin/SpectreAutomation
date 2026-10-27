// SIGNUP-2 Phase 2E (2026-10-26) -- Stripe webhook receiver.
//
// Durable receipt + signature verification + dedup.  Processing is
// gated by SPECTRE_SIGNUP_2E_PAYMENT_LIVE: when OFF, events are
// still persisted (durable receipt per founder §4 "do not lose
// financial events merely because the application feature is
// disabled") but no state transitions fire.  Operators can replay
// stored events once the flag is on.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { resolveStripeAdapter } from "@/lib/billing/stripe-adapter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  // Read the RAW body before any JSON parse (signature verification
  // requires the exact bytes Stripe signed).
  const rawBody = await req.text();
  const signatureHeader = req.headers.get("stripe-signature");
  const signingSecret = process.env.STRIPE_WEBHOOK_SIGNING_SECRET ?? "";

  const stripe = resolveStripeAdapter();
  const verification = stripe.verifyWebhookSignature({
    rawBody,
    signatureHeader,
    signingSecret,
  });

  if (!verification.ok) {
    logger.warn("stripe.webhook.verification_failed", {
      reason: verification.reason,
      signaturePresent: !!signatureHeader,
    });
    return new NextResponse("verification_failed", { status: 400 });
  }

  const event = verification.event;

  // M2-Validation (2026-10-27, founder §2): staging MUST refuse any
  // event whose livemode === true.  Even if someone misconfigures the
  // Stripe dashboard to send live-money events here, this guard
  // prevents them from being persisted, dispatched, or processed.
  // Production reversal of this guard requires a separately-authorised
  // slice.
  if (event.livemode === true) {
    logger.warn("stripe.webhook.livemode_refused", {
      stripeEventIdTail: event.id.slice(-8),
      eventType: event.type,
    });
    return new NextResponse("livemode_refused", { status: 403 });
  }

  // Durable receipt FIRST.  Dedup on event id (unique index on
  // StripeWebhookEvent.stripeEventId).  Any later processing works
  // off this stored event.
  try {
    await prisma.stripeWebhookEvent.create({
      data: {
        // Phase-2A schema uses event.id as the primary key directly
        // (no separate stripeEventId column).  livemode + created
        // are embedded in payloadJson for forensic replay.
        id: event.id,
        eventType: event.type,
        payloadJson: event.rawPayloadJson,
      },
    });
  } catch (err) {
    // Dedup collision (unique index violation) is the expected
    // path on retries; treat as noop.
    const code = (err as any)?.code;
    if (code === "P2002") {
      logger.info("stripe.webhook.replay", {
        stripeEventIdTail: event.id.slice(-8),
        eventType: event.type,
      });
      return new NextResponse("replay", { status: 200 });
    }
    logger.error("stripe.webhook.persist_failed", {
      stripeEventIdTail: event.id.slice(-8),
      eventType: event.type,
      detail: err instanceof Error ? err.message : String(err),
    });
    return new NextResponse("persist_failed", { status: 500 });
  }

  // Flag-OFF path:  persist only; no state transitions.  Founder §4.
  if (process.env.SPECTRE_SIGNUP_2E_PAYMENT_LIVE !== "1") {
    logger.info("stripe.webhook.received_disabled", {
      stripeEventIdTail: event.id.slice(-8),
      eventType: event.type,
    });
    await audit(null, {
      action: "stripe.webhook.received_disabled",
      entityType: "StripeWebhookEvent",
      entityId: event.id,
      clubId: null,
      meta: {
        stripeEventIdTail: event.id.slice(-8),
        eventType: event.type,
      },
    });
    return new NextResponse("received_disabled", { status: 200 });
  }

  // Flag-ON dispatch.
  try {
    const { dispatchStripeEvent } = await import("@/lib/billing/signup-2e-webhook-dispatch");
    await dispatchStripeEvent(event);
  } catch (err) {
    logger.error("stripe.webhook.dispatch_failed", {
      stripeEventIdTail: event.id.slice(-8),
      eventType: event.type,
      detail: err instanceof Error ? err.message : String(err),
    });
    // Still return 200 so Stripe does not retry the already-persisted
    // event forever.  Operators can replay via the inbox.
  }

  return new NextResponse("ok", { status: 200 });
}

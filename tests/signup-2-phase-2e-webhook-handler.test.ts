// SIGNUP-2 Phase 2E (2026-10-26) -- Webhook handler contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const WEBHOOK = readFileSync(join(ROOT, "src/app/api/webhooks/stripe/route.ts"), "utf8");
const DISPATCH = readFileSync(join(ROOT, "src/lib/billing/signup-2e-webhook-dispatch.ts"), "utf8");

describe("SIGNUP-2 Phase 2E · webhook signature verification", () => {
  it("reads the RAW request body (not JSON) before any processing", () => {
    expect(WEBHOOK).toMatch(/const rawBody = await req\.text\(\);/);
  });

  it("passes raw body to the adapter's verifyWebhookSignature", () => {
    expect(WEBHOOK).toMatch(/stripe\.verifyWebhookSignature\(\{\s*rawBody,/);
  });

  it("reads Stripe-Signature header + STRIPE_WEBHOOK_SIGNING_SECRET env", () => {
    expect(WEBHOOK).toMatch(/req\.headers\.get\("stripe-signature"\)/);
    expect(WEBHOOK).toMatch(/process\.env\.STRIPE_WEBHOOK_SIGNING_SECRET/);
  });

  it("returns 400 on verification failure (no further processing)", () => {
    expect(WEBHOOK).toMatch(/if \(!verification\.ok\)[\s\S]+?status: 400/);
  });
});

describe("SIGNUP-2 Phase 2E · durable receipt + dedup (founder §4)", () => {
  it("inserts to stripeWebhookEvent BEFORE any dispatch", () => {
    const persistIdx = WEBHOOK.indexOf("stripeWebhookEvent.create");
    const dispatchIdx = WEBHOOK.indexOf("dispatchStripeEvent");
    expect(persistIdx).toBeGreaterThan(0);
    expect(dispatchIdx).toBeGreaterThan(persistIdx);
  });

  it("treats P2002 unique-index violation as a successful replay (noop)", () => {
    expect(WEBHOOK).toMatch(/code === "P2002"[\s\S]+?"replay"[\s\S]+?status: 200/);
  });
});

describe("SIGNUP-2 Phase 2E · flag-OFF path persists but does not dispatch (founder §4)", () => {
  it("checks SPECTRE_SIGNUP_2E_PAYMENT_LIVE AFTER the durable receipt insert", () => {
    // Match the actual code reference (process.env.<name>), not the
    // header comment that documents the flag's name.
    const persistIdx = WEBHOOK.indexOf("stripeWebhookEvent.create");
    const flagIdx = WEBHOOK.indexOf("process.env.SPECTRE_SIGNUP_2E_PAYMENT_LIVE");
    expect(persistIdx).toBeGreaterThan(0);
    expect(flagIdx).toBeGreaterThan(persistIdx);
  });

  it("returns 200 'received_disabled' and does NOT call dispatchStripeEvent when both flags unset", () => {
    // M3B (2026-10-28): dispatch is enabled by EITHER
    // SPECTRE_SIGNUP_2E_PAYMENT_LIVE OR SPECTRE_SIGNUP_2M3_WEBHOOK_DISPATCH.
    const block = WEBHOOK.match(/if \(!dispatchEnabled\)[\s\S]+?return new NextResponse\("received_disabled"[\s\S]*?\);\s*\}/)!;
    expect(block[0]).toMatch(/received_disabled/);
    // dispatchStripeEvent is dynamically imported AFTER this block.
    expect(block[0]).not.toMatch(/dispatchStripeEvent/);
  });
});

describe("SIGNUP-2 Phase 2E · dispatch handles the required Stripe events", () => {
  const required = [
    "payment_intent.processing",
    "payment_intent.succeeded",
    "payment_intent.payment_failed",
    "charge.succeeded",
    "charge.refunded",
    "charge.dispute.created",
  ];
  for (const type of required) {
    it(`handles ${type}`, () => {
      expect(DISPATCH).toMatch(new RegExp(`case "${type.replace(/\./g, "\\.")}"`));
    });
  }

  it("marks each dispatched event as processed=success on the StripeWebhookEvent row", () => {
    expect(DISPATCH).toMatch(/stripeWebhookEvent\.update[\s\S]+?processingResult:\s*"success"/);
  });

  it("conditional updateMany defeats out-of-order webhook races", () => {
    expect(DISPATCH).toMatch(/subscriptionStatus:\s*\{\s*in:\s*\["INITIATED"\]/);
    expect(DISPATCH).toMatch(/subscriptionStatus:\s*\{\s*in:\s*\["INITIATED",\s*"AWAITING_SETTLEMENT"\]/);
  });
});

describe("SIGNUP-2 Phase 2E · operator alerts for failures / disputes / reversals", () => {
  it("payment_intent.payment_failed writes an IMMEDIATE operator alert (M1b: INITIAL_PAYMENT_FAILURE | RENEWAL_PAYMENT_FAILURE)", () => {
    const h = DISPATCH.match(/async function onPaymentIntentFailed[\s\S]+?async function onChargeSucceeded/m)!;
    expect(h[0]).toMatch(/severity:\s*"IMMEDIATE"/);
    // M1b (2026-10-26) separates initial vs renewal payment failure.
    expect(h[0]).toMatch(/category: isInitialPaymentFailure \? "INITIAL_PAYMENT_FAILURE" : "RENEWAL_PAYMENT_FAILURE"/);
  });

  it("charge.refunded writes an IMMEDIATE operator alert (REVERSAL) + revokes activation per §5", () => {
    const h = DISPATCH.match(/async function onChargeRefunded[\s\S]+?^}/m)!;
    expect(h[0]).toMatch(/severity:\s*"IMMEDIATE"/);
    expect(h[0]).toMatch(/category:\s*"REVERSAL"/);
    expect(h[0]).toMatch(/reversedAt:\s*new Date\(\)/);
    expect(h[0]).toMatch(/subscriptionStatus:\s*"REVERSED"/);
  });

  it("charge.dispute.created writes an IMMEDIATE operator alert (DISPUTE) + revokes activation per §5", () => {
    const h = DISPATCH.match(/async function onChargeDisputeCreated[\s\S]+?^}/m)!;
    expect(h[0]).toMatch(/category:\s*"DISPUTE"/);
    expect(h[0]).toMatch(/reversedAt:\s*new Date\(\)/);
    expect(h[0]).toMatch(/subscriptionStatus:\s*"DISPUTE_OPEN"/);
  });
});

describe("SIGNUP-2 Phase 2E · activation gate (§5 revocable)", () => {
  it("onChargeSucceeded fetches BalanceTransaction + flips to ACTIVATION_READY only when available + available_on <= now", () => {
    const h = DISPATCH.match(/async function onChargeSucceeded[\s\S]+?^}/m)!;
    expect(h[0]).toMatch(/retrieveBalanceTransaction/);
    expect(h[0]).toMatch(/bal\.status === "available" && bal\.availableAt\.getTime\(\) <= Date\.now\(\)/);
    expect(h[0]).toMatch(/subscriptionStatus:\s*"ACTIVATION_READY"/);
  });

  it("activation signal is REVOCABLE: a subsequent refund / dispute writes REVERSED / DISPUTE_OPEN", () => {
    // Already asserted above (reversedAt + subscriptionStatus = REVERSED / DISPUTE_OPEN).
    expect(DISPATCH).toMatch(/subscriptionStatus:\s*"REVERSED"/);
    expect(DISPATCH).toMatch(/subscriptionStatus:\s*"DISPUTE_OPEN"/);
  });
});

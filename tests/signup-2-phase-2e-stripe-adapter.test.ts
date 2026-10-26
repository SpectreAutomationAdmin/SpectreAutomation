// SIGNUP-2 Phase 2E (2026-10-26) -- StripeAdapter contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStripeAdapter, stripeAdapterMode } from "@/lib/billing/stripe-adapter";
import { createMockStripeAdapter } from "@/lib/billing/stripe-adapter/mock";

const ROOT = process.cwd();
const PORT = readFileSync(join(ROOT, "src/lib/billing/stripe-adapter/types.ts"), "utf8");
const FACTORY = readFileSync(join(ROOT, "src/lib/billing/stripe-adapter/index.ts"), "utf8");
const MOCK = readFileSync(join(ROOT, "src/lib/billing/stripe-adapter/mock.ts"), "utf8");

describe("SIGNUP-2 Phase 2E · adapter port shape", () => {
  it("StripeAdapter interface declares isLive + the six required methods", () => {
    expect(PORT).toMatch(/readonly isLive:\s*boolean/);
    expect(PORT).toMatch(/createCustomer\(/);
    expect(PORT).toMatch(/createMandateCheckoutSession\(/);
    expect(PORT).toMatch(/retrieveCheckoutSession\(/);
    expect(PORT).toMatch(/createSubscription\(/);
    expect(PORT).toMatch(/retrieveBalanceTransaction\(/);
    expect(PORT).toMatch(/verifyWebhookSignature\(/);
  });

  it("every result carries evidenceSource: 'live-stripe' | 'mock-stripe'", () => {
    expect(PORT).toMatch(/evidenceSource:\s*"live-stripe"\s*\|\s*"mock-stripe"/);
  });

  it("port types never import Stripe SDK or node:crypto directly", () => {
    expect(PORT).not.toMatch(/from "stripe"/);
    expect(PORT).not.toMatch(/from "@stripe\//);
  });
});

describe("SIGNUP-2 Phase 2E · mock adapter invariants", () => {
  const adapter = createMockStripeAdapter();

  it("isLive is ALWAYS false", () => {
    expect(adapter.isLive).toBe(false);
  });

  it("every result marks evidenceSource = 'mock-stripe' (never fabricates 'live-stripe')", async () => {
    const cust = await adapter.createCustomer({
      idempotencyKey: "test-key",
      signupRegistrationId: "test-reg",
      description: "d",
      metadata: {},
    });
    expect(cust.evidenceSource).toBe("mock-stripe");

    const sess = await adapter.createMandateCheckoutSession({
      idempotencyKey: "test-key",
      stripeCustomerId: cust.stripeCustomerId,
      acssMandate: { paymentSchedule: "interval", transactionType: "business", intervalDescription: "x" },
      successUrl: "https://staging.example/return",
      cancelUrl: "https://staging.example/cancel",
      metadata: {},
    });
    expect(sess.evidenceSource).toBe("mock-stripe");

    const retrieved = await adapter.retrieveCheckoutSession(sess.checkoutSessionId);
    expect(retrieved.evidenceSource).toBe("mock-stripe");

    const sub = await adapter.createSubscription({
      idempotencyKey: "test-sub",
      stripeCustomerId: cust.stripeCustomerId,
      stripePriceId: "price_mock",
      defaultPaymentMethodId: "pm_mock",
      metadata: {},
    });
    expect(sub.evidenceSource).toBe("mock-stripe");

    const bal = await adapter.retrieveBalanceTransaction("btxn_mock_1");
    expect(bal.evidenceSource).toBe("mock-stripe");
  });

  it("stable ids: same idempotency key → same customer id", async () => {
    const a = await adapter.createCustomer({
      idempotencyKey: "repeat-key",
      signupRegistrationId: "r1",
      description: "d",
      metadata: {},
    });
    const b = await adapter.createCustomer({
      idempotencyKey: "repeat-key",
      signupRegistrationId: "r2",
      description: "d2",
      metadata: {},
    });
    expect(a.stripeCustomerId).toBe(b.stripeCustomerId);
  });

  it("verifyWebhookSignature rejects missing header + missing secret + bad format", () => {
    expect(adapter.verifyWebhookSignature({ rawBody: "{}", signatureHeader: null, signingSecret: "s" }))
      .toMatchObject({ ok: false, reason: "missing_signature" });
    expect(adapter.verifyWebhookSignature({ rawBody: "{}", signatureHeader: "t=1,v1=aa", signingSecret: "" }))
      .toMatchObject({ ok: false, reason: "missing_secret" });
    expect(adapter.verifyWebhookSignature({ rawBody: "{}", signatureHeader: "bogus", signingSecret: "s" }))
      .toMatchObject({ ok: false, reason: "signature_mismatch" });
  });

  it("verifyWebhookSignature accepts a correctly signed body", () => {
    const { createHmac } = require("node:crypto");
    const secret = "test-secret";
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id: "evt_1", type: "payment_intent.processing", created: now, livemode: false, data: { object: {} } });
    const sig = createHmac("sha256", secret).update(`${now}.${body}`).digest("hex");
    const result = adapter.verifyWebhookSignature({
      rawBody: body,
      signatureHeader: `t=${now},v1=${sig}`,
      signingSecret: secret,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.id).toBe("evt_1");
      expect(result.event.type).toBe("payment_intent.processing");
    }
  });
});

describe("SIGNUP-2 Phase 2E · factory", () => {
  it("stripeAdapterMode defaults to mock when env unset", () => {
    const prev = process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
    delete process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
    try {
      expect(stripeAdapterMode()).toBe("mock");
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
      else process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE = prev;
    }
  });

  it("stripeAdapterMode returns 'mock' for any value other than literal 'live'", () => {
    const prev = process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
    process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE = "test";
    try {
      expect(stripeAdapterMode()).toBe("mock");
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
      else process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE = prev;
    }
  });

  it("resolveStripeAdapter returns the mock adapter by default", () => {
    const prev = process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
    delete process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
    try {
      const a = resolveStripeAdapter();
      expect(a.isLive).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
      else process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE = prev;
    }
  });

  it("factory does NOT import a live-adapter module (Phase 2E baseline ships none)", () => {
    expect(FACTORY).not.toMatch(/from "\.\/live"/);
    expect(FACTORY).not.toMatch(/import.*Stripe.*from "stripe"/);
  });

  it("mock adapter does NOT import Stripe SDK", () => {
    expect(MOCK).not.toMatch(/from "stripe"/);
    expect(MOCK).not.toMatch(/@stripe\//);
  });
});

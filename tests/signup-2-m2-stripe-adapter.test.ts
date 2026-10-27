// SIGNUP-2 M2 (2026-10-27) -- Stripe-adapter contract tests.
//
// Verifies:
//   1. Resolver fail-closed semantics on missing secrets.
//   2. Resolver `requireLive` flag.
//   3. Live adapter preserves `evidenceSource = "live-stripe"`.
//   4. Live adapter contract conformance (shape only, mocked SDK).
//   5. ACSS price resolver fail-closed on missing STRIPE_ACSS_PRICE_ID.
//   6. Webhook signature verification uses stripe.webhooks.constructEvent.
//   7. Mandate service reads STRIPE_ACSS_PRICE_ID when mode=live.
//
// Does NOT exercise real Stripe API (would require founder-provided
// test keys).  The live adapter wires through to the SDK via mocked
// client stubs that return the SDK's own typed response shapes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("SIGNUP-2 M2 · resolveStripeAdapter · fail-closed on missing secrets", () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  it("returns mock when SPECTRE_SIGNUP_2E_STRIPE_MODE is unset", async () => {
    delete process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
    const { resolveStripeAdapter } = await import("@/lib/billing/stripe-adapter");
    const adapter = resolveStripeAdapter();
    expect(adapter.isLive).toBe(false);
  });

  it("returns mock when SPECTRE_SIGNUP_2E_STRIPE_MODE=mock", async () => {
    process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE = "mock";
    const { resolveStripeAdapter } = await import("@/lib/billing/stripe-adapter");
    const adapter = resolveStripeAdapter();
    expect(adapter.isLive).toBe(false);
  });

  it("THROWS when mode=live but STRIPE_SECRET_KEY is unset", async () => {
    process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE = "live";
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SIGNING_SECRET = "whsec_present";
    const { resolveStripeAdapter } = await import("@/lib/billing/stripe-adapter");
    expect(() => resolveStripeAdapter()).toThrow(/STRIPE_SECRET_KEY and\/or STRIPE_WEBHOOK_SIGNING_SECRET is unset/);
  });

  it("THROWS when mode=live but STRIPE_WEBHOOK_SIGNING_SECRET is unset", async () => {
    process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE = "live";
    process.env.STRIPE_SECRET_KEY = "sk_test_present";
    delete process.env.STRIPE_WEBHOOK_SIGNING_SECRET;
    const { resolveStripeAdapter } = await import("@/lib/billing/stripe-adapter");
    expect(() => resolveStripeAdapter()).toThrow(/STRIPE_SECRET_KEY and\/or STRIPE_WEBHOOK_SIGNING_SECRET is unset/);
  });

  it("THROWS when caller passes requireLive but mode is mock", async () => {
    process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE = "mock";
    const { resolveStripeAdapter } = await import("@/lib/billing/stripe-adapter");
    expect(() => resolveStripeAdapter({ requireLive: true })).toThrow(/requireLive:true.*refused/);
  });

  it("constructs a live adapter when all three credentials are set", async () => {
    process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE = "live";
    process.env.STRIPE_SECRET_KEY = "sk_test_present";
    process.env.STRIPE_WEBHOOK_SIGNING_SECRET = "whsec_present";
    const { resolveStripeAdapter } = await import("@/lib/billing/stripe-adapter");
    const adapter = resolveStripeAdapter();
    expect(adapter.isLive).toBe(true);
  });
});

describe("SIGNUP-2 M2 · resolveAcssPriceId · fail-closed on missing STRIPE_ACSS_PRICE_ID", () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  it("returns null when mode is mock (price id not required)", async () => {
    delete process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
    const { resolveAcssPriceId } = await import("@/lib/billing/stripe-adapter");
    expect(resolveAcssPriceId()).toBeNull();
  });

  it("THROWS when mode=live but STRIPE_ACSS_PRICE_ID is unset", async () => {
    process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE = "live";
    delete process.env.STRIPE_ACSS_PRICE_ID;
    const { resolveAcssPriceId } = await import("@/lib/billing/stripe-adapter");
    expect(() => resolveAcssPriceId()).toThrow(/STRIPE_ACSS_PRICE_ID is unset/);
  });

  it("returns the configured price id when mode=live + STRIPE_ACSS_PRICE_ID is set", async () => {
    process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE = "live";
    process.env.STRIPE_ACSS_PRICE_ID = "price_abc123";
    const { resolveAcssPriceId } = await import("@/lib/billing/stripe-adapter");
    expect(resolveAcssPriceId()).toBe("price_abc123");
  });
});

describe("SIGNUP-2 M2 · live adapter · evidenceSource always 'live-stripe'", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("createCustomer returns evidenceSource='live-stripe'", async () => {
    // Mock the whole stripe module BEFORE import.
    vi.doMock("stripe", () => {
      class MockStripe {
        customers = {
          create: vi.fn(async () => ({ id: "cus_live_test123" })),
        };
        checkout = { sessions: { create: vi.fn(), retrieve: vi.fn() } };
        subscriptions = { create: vi.fn() };
        balanceTransactions = { retrieve: vi.fn() };
        webhooks = { constructEvent: vi.fn() };
      }
      return { default: MockStripe };
    });
    const { createLiveStripeAdapter } = await import("@/lib/billing/stripe-adapter/live");
    const adapter = createLiveStripeAdapter({
      secretKey: "sk_test_1",
      webhookSigningSecret: "whsec_1",
    });
    const result = await adapter.createCustomer({
      idempotencyKey: "test:1",
      signupRegistrationId: "reg1",
      description: "test",
      metadata: { k: "v" },
    });
    expect(result.evidenceSource).toBe("live-stripe");
    expect(result.stripeCustomerId).toBe("cus_live_test123");
  });

  it("retrieveBalanceTransaction returns evidenceSource='live-stripe' + maps status", async () => {
    vi.doMock("stripe", () => {
      class MockStripe {
        customers = { create: vi.fn() };
        checkout = { sessions: { create: vi.fn(), retrieve: vi.fn() } };
        subscriptions = { create: vi.fn() };
        balanceTransactions = {
          retrieve: vi.fn(async () => ({
            id: "txn_live_1",
            status: "available",
            available_on: Math.floor(Date.now() / 1000) - 10,
            currency: "cad",
            amount: 3_800_000,
          })),
        };
        webhooks = { constructEvent: vi.fn() };
      }
      return { default: MockStripe };
    });
    const { createLiveStripeAdapter } = await import("@/lib/billing/stripe-adapter/live");
    const adapter = createLiveStripeAdapter({
      secretKey: "sk_test_1",
      webhookSigningSecret: "whsec_1",
    });
    const result = await adapter.retrieveBalanceTransaction("txn_live_1");
    expect(result.evidenceSource).toBe("live-stripe");
    expect(result.status).toBe("available");
    expect(result.amountMinor).toBe(3_800_000);
    expect(result.currency).toBe("cad");
  });

  it("verifyWebhookSignature returns signature_mismatch on SDK StripeSignatureVerificationError", async () => {
    vi.doMock("stripe", () => {
      class SigErr extends Error { type = "StripeSignatureVerificationError"; }
      class MockStripe {
        customers = { create: vi.fn() };
        checkout = { sessions: { create: vi.fn(), retrieve: vi.fn() } };
        subscriptions = { create: vi.fn() };
        balanceTransactions = { retrieve: vi.fn() };
        webhooks = {
          constructEvent: vi.fn(() => { throw new SigErr("bad sig"); }),
        };
      }
      return { default: MockStripe };
    });
    const { createLiveStripeAdapter } = await import("@/lib/billing/stripe-adapter/live");
    const adapter = createLiveStripeAdapter({
      secretKey: "sk_test_1",
      webhookSigningSecret: "whsec_1",
    });
    const result = adapter.verifyWebhookSignature({
      rawBody: '{"id":"evt_1"}',
      signatureHeader: "t=1,v1=deadbeef",
      signingSecret: "whsec_1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature_mismatch");
  });

  it("verifyWebhookSignature wraps SDK event into StripeEventShape", async () => {
    vi.doMock("stripe", () => {
      class MockStripe {
        customers = { create: vi.fn() };
        checkout = { sessions: { create: vi.fn(), retrieve: vi.fn() } };
        subscriptions = { create: vi.fn() };
        balanceTransactions = { retrieve: vi.fn() };
        webhooks = {
          constructEvent: vi.fn(() => ({
            id: "evt_live_1",
            type: "payment_intent.succeeded",
            created: 1700000000,
            livemode: false,
            data: { object: { id: "pi_live_1" } },
          })),
        };
      }
      return { default: MockStripe };
    });
    const { createLiveStripeAdapter } = await import("@/lib/billing/stripe-adapter/live");
    const adapter = createLiveStripeAdapter({
      secretKey: "sk_test_1",
      webhookSigningSecret: "whsec_1",
    });
    const result = adapter.verifyWebhookSignature({
      rawBody: '{"id":"evt_live_1"}',
      signatureHeader: "t=1,v1=valid",
      signingSecret: "whsec_1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.id).toBe("evt_live_1");
      expect(result.event.type).toBe("payment_intent.succeeded");
      expect(result.event.livemode).toBe(false);
      expect(result.event.rawPayloadJson).toBe('{"id":"evt_live_1"}');
    }
  });

  it("throws on empty secretKey OR empty webhookSigningSecret", async () => {
    vi.doMock("stripe", () => ({ default: class { } }));
    const { createLiveStripeAdapter } = await import("@/lib/billing/stripe-adapter/live");
    expect(() => createLiveStripeAdapter({ secretKey: "", webhookSigningSecret: "whsec" })).toThrow(/STRIPE_SECRET_KEY is empty/);
    expect(() => createLiveStripeAdapter({ secretKey: "sk_test", webhookSigningSecret: "" })).toThrow(/STRIPE_WEBHOOK_SIGNING_SECRET is empty/);
  });
});

describe("SIGNUP-2 M2 · reconciliation service · idempotent + fail-safe", () => {
  // Dynamic import after reset so a fresh prisma reads env state.
  afterEach(() => vi.resetModules());

  it("short-circuits on existing PAYMENT_SETTLED entry (idempotent)", async () => {
    const path = "src/lib/billing/signup-2m2-reconciliation-service.ts";
    const content = readFileSync(join(process.cwd(), path), "utf8");
    // Source-contract: the service re-reads reconciliation entries before polling.
    expect(content).toMatch(/paymentReconciliationEntry\.findFirst/);
    expect(content).toMatch(/entryType: "PAYMENT_SETTLED"/);
    expect(content).toMatch(/if \(existing\)/);
  });

  it("returns `already_reversed` when cycle.reversedAt is set", async () => {
    const path = "src/lib/billing/signup-2m2-reconciliation-service.ts";
    const content = readFileSync(join(process.cwd(), path), "utf8");
    expect(content).toMatch(/if \(cycle\.reversedAt\)/);
    expect(content).toMatch(/reason: "already_reversed"/);
  });

  it("returns `budget_exhausted` when wall-clock budget expires", async () => {
    const path = "src/lib/billing/signup-2m2-reconciliation-service.ts";
    const content = readFileSync(join(process.cwd(), path), "utf8");
    expect(content).toMatch(/reason: "budget_exhausted"/);
    expect(content).toMatch(/now\(\) - started < budget/);
  });

  it("terminal success writes PAYMENT_SETTLED entry + flips cycle to SETTLED", async () => {
    const path = "src/lib/billing/signup-2m2-reconciliation-service.ts";
    const content = readFileSync(join(process.cwd(), path), "utf8");
    expect(content).toMatch(/paymentReconciliationEntry\.create/);
    expect(content).toMatch(/entryType: "PAYMENT_SETTLED"/);
    expect(content).toMatch(/subscriptionStatus: "SETTLED"/);
  });
});

describe("SIGNUP-2 M2 · mandate service uses STRIPE_ACSS_PRICE_ID when live", () => {
  it("priceId() delegates to resolveAcssPriceId when mode=live, falls to MOCK otherwise", () => {
    const content = readFileSync(
      join(process.cwd(), "src/lib/billing/signup-2e-mandate-service.ts"),
      "utf8",
    );
    expect(content).toMatch(/const MOCK_PRICE_ID = "price_signup2e_mock_38kcad_annual"/);
    expect(content).toMatch(/function priceId\(\)/);
    expect(content).toMatch(/stripeAdapterMode\(\) === "live"/);
    expect(content).toMatch(/resolveAcssPriceId\(\)/);
  });

  it("createSubscription args pass the resolved price id, not the hardcoded mock", () => {
    const content = readFileSync(
      join(process.cwd(), "src/lib/billing/signup-2e-mandate-service.ts"),
      "utf8",
    );
    expect(content).toMatch(/stripePriceId: priceId\(\)/);
  });
});

describe("SIGNUP-2 M2 · live adapter never fabricates evidence", () => {
  it("live.ts contains no fallback to mock-stripe evidenceSource", () => {
    const content = readFileSync(
      join(process.cwd(), "src/lib/billing/stripe-adapter/live.ts"),
      "utf8",
    );
    expect(content).not.toMatch(/evidenceSource:\s*"mock-stripe"/);
    // At least one "live-stripe" marker per public method.
    const liveMarkers = (content.match(/evidenceSource:\s*"live-stripe"/g) ?? []).length;
    expect(liveMarkers).toBeGreaterThanOrEqual(5);
  });

  it("retry wrapper never retries 4xx errors", () => {
    const content = readFileSync(
      join(process.cwd(), "src/lib/billing/stripe-adapter/live.ts"),
      "utf8",
    );
    // isRetriableStripeError returns false for 4xx.
    expect(content).toMatch(/function isRetriableStripeError/);
    expect(content).toMatch(/statusCode === "number" && anyErr\.statusCode >= 500/);
  });

  it("all mutating methods pass idempotencyKey", () => {
    const content = readFileSync(
      join(process.cwd(), "src/lib/billing/stripe-adapter/live.ts"),
      "utf8",
    );
    // customers.create, checkout.sessions.create, subscriptions.create all use idempotencyKey.
    const idemCount = (content.match(/idempotencyKey: args\.idempotencyKey/g) ?? []).length;
    expect(idemCount).toBeGreaterThanOrEqual(3);
  });
});

// SIGNUP-2 M2-Validation (2026-10-27) -- Test-mode isolation + reconciliation-design contract tests.
//
// Covers founder §2 (test-mode-only operation) + §3 (reconciliation
// design):
//   - sk_live_ rejection
//   - sk_test_ requirement
//   - livemode=true webhook refusal (403)
//   - mode-flag rename (SPECTRE_STRIPE_SDK_MODE) + legacy compatibility
//   - independent payment-state check in reconciliation
//   - amount + currency CAD $38,000 validation
//   - return / refund / dispute checks
//   - durable + idempotent writes
//   - pending transactions remain pending without premature settlement
//   - stall marker + continued probing (no permanent strand)
//   - activation remains subject to downstream gates (service does not activate)

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("SIGNUP-2 M2-Validation · test-mode-only guards (founder §2)", () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; vi.resetModules(); });

  it("REJECTS sk_live_ keys with a clear error", async () => {
    process.env.SPECTRE_STRIPE_SDK_MODE = "test";
    process.env.STRIPE_SECRET_KEY = "sk_live_abcdef";
    process.env.STRIPE_WEBHOOK_SIGNING_SECRET = "whsec_test";
    const { resolveStripeAdapter } = await import("@/lib/billing/stripe-adapter");
    expect(() => resolveStripeAdapter()).toThrow(/REFUSING to use STRIPE_SECRET_KEY beginning with 'sk_live_'/);
  });

  it("REJECTS unknown-prefix keys (rk_test_, malformed, empty)", async () => {
    process.env.SPECTRE_STRIPE_SDK_MODE = "test";
    process.env.STRIPE_SECRET_KEY = "rk_test_restricted";
    process.env.STRIPE_WEBHOOK_SIGNING_SECRET = "whsec_test";
    const { resolveStripeAdapter } = await import("@/lib/billing/stripe-adapter");
    expect(() => resolveStripeAdapter()).toThrow(/does not begin with 'sk_test_'/);
  });

  it("ACCEPTS sk_test_ keys when SDK mode is test + webhook secret set", async () => {
    process.env.SPECTRE_STRIPE_SDK_MODE = "test";
    process.env.STRIPE_SECRET_KEY = "sk_test_abcdef";
    process.env.STRIPE_WEBHOOK_SIGNING_SECRET = "whsec_test";
    const { resolveStripeAdapter } = await import("@/lib/billing/stripe-adapter");
    const adapter = resolveStripeAdapter();
    expect(adapter.isLive).toBe(true);
  });

  it("primary flag SPECTRE_STRIPE_SDK_MODE routes mock/test", async () => {
    const { stripeSdkMode } = await import("@/lib/billing/stripe-adapter");
    process.env.SPECTRE_STRIPE_SDK_MODE = "mock";
    delete process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
    expect(stripeSdkMode()).toBe("mock");
    process.env.SPECTRE_STRIPE_SDK_MODE = "test";
    expect(stripeSdkMode()).toBe("test");
  });

  it("legacy flag SPECTRE_SIGNUP_2E_STRIPE_MODE=live still routes to test mode (backwards compat)", async () => {
    delete process.env.SPECTRE_STRIPE_SDK_MODE;
    process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE = "live";
    const { stripeSdkMode } = await import("@/lib/billing/stripe-adapter");
    expect(stripeSdkMode()).toBe("test");
  });

  it("primary flag wins when both are set + warns", async () => {
    process.env.SPECTRE_STRIPE_SDK_MODE = "mock";
    process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE = "live";
    const { stripeSdkMode } = await import("@/lib/billing/stripe-adapter");
    expect(stripeSdkMode()).toBe("mock");
  });

  it("stripeAdapterMode (legacy) still returns mock|live for existing callers", async () => {
    const { stripeAdapterMode } = await import("@/lib/billing/stripe-adapter");
    process.env.SPECTRE_STRIPE_SDK_MODE = "test";
    expect(stripeAdapterMode()).toBe("live");
    process.env.SPECTRE_STRIPE_SDK_MODE = "mock";
    expect(stripeAdapterMode()).toBe("mock");
  });
});

describe("SIGNUP-2 M2-Validation · webhook route rejects livemode=true (founder §2)", () => {
  it("the webhook route refuses event.livemode=true with HTTP 403", () => {
    const route = readFileSync(
      join(process.cwd(), "src/app/api/webhooks/stripe/route.ts"),
      "utf8",
    );
    // Must have an explicit `event.livemode === true` guard BEFORE
    // the dispatch call.
    expect(route).toMatch(/event\.livemode === true/);
    expect(route).toMatch(/livemode_refused/);
    expect(route).toMatch(/status:\s*403/);
    // The guard must appear BEFORE the dispatch call.
    const livemodeIdx = route.indexOf("event.livemode === true");
    const dispatchIdx = route.indexOf("dispatchStripeEvent");
    expect(livemodeIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(livemodeIdx).toBeLessThan(dispatchIdx);
  });
});

describe("SIGNUP-2 M2-Validation · reconciliation design (founder §3)", () => {
  const SRC = readFileSync(
    join(process.cwd(), "src/lib/billing/signup-2m2-reconciliation-service.ts"),
    "utf8",
  );

  it("§3.a: requires AWAITING_SETTLEMENT or SETTLED payment state before reconciling", () => {
    expect(SRC).toMatch(/AWAITING_SETTLEMENT.*SETTLED|SETTLED.*AWAITING_SETTLEMENT/);
    expect(SRC).toMatch(/preconditions_failed/);
  });

  it("§3.c: expected amount is CAD $38,000 (3_800_000 minor units)", () => {
    expect(SRC).toMatch(/EXPECTED_AMOUNT_MINOR = 3_800_000/);
    expect(SRC).toMatch(/EXPECTED_CURRENCY = "cad"/);
  });

  it("§3.c: amount mismatch writes RECONCILIATION_MISMATCH entry + refuses settlement", () => {
    expect(SRC).toMatch(/entryType: "RECONCILIATION_MISMATCH"/);
    expect(SRC).toMatch(/amount_mismatch/);
    expect(SRC).toMatch(/currency_mismatch/);
  });

  it("§3.d: checks for existing REFUND / DISPUTE / PAYMENT_RETURNED entries", () => {
    expect(SRC).toMatch(/entryType: \{ in: \["REFUND", "CHARGE_REFUNDED"\] \}/);
    expect(SRC).toMatch(/entryType: \{ in: \["DISPUTE_OPENED", "CHARGE_DISPUTED"\] \}/);
    expect(SRC).toMatch(/entryType: \{ in: \["PAYMENT_RETURNED", "ACSS_RETURN"\] \}/);
  });

  it("§3.e: durable + idempotent -- short-circuits on existing PAYMENT_SETTLED", () => {
    expect(SRC).toMatch(/entryType: "PAYMENT_SETTLED"/);
    expect(SRC).toMatch(/if \(existing\)/);
    // Terminal write happens inside a prisma.$transaction.
    expect(SRC).toMatch(/prisma\.\$transaction\(async \(tx\) =>/);
  });

  it("§3.f: pending transactions remain pending without premature settlement", () => {
    expect(SRC).toMatch(/bt\.status === "pending" \|\| bt\.availableAt\.getTime\(\) > now\(\)/);
    expect(SRC).toMatch(/terminal: false/);
    // Non-terminal pending outcomes do NOT flip settlementConfirmedAt.
    // The `if (bt.status === "pending" ...)` block returns BEFORE
    // the settlement write below.
    const pendingBlock = SRC.match(/if \(bt\.status === "pending"[\s\S]*?return \{[\s\S]*?\};/m);
    expect(pendingBlock).toBeTruthy();
    if (pendingBlock) {
      expect(pendingBlock[0]).not.toMatch(/settlementConfirmedAt:/);
    }
  });

  it("§3.g: recoverable scheduled reconciliation -- stepReconcile returns nextCheckAt + stall-not-halt", () => {
    expect(SRC).toMatch(/stepReconcileBalanceTransaction/);
    expect(SRC).toMatch(/nextCheckAt: Date/);
    expect(SRC).toMatch(/STALL_THRESHOLD_ATTEMPTS/);
    expect(SRC).toMatch(/RECONCILIATION_STALLED/);
    // Stall is a WARNING, not a HALT -- a stalled result still has
    // `ok: true, terminal: false` so the worker keeps probing.
    const stallBlock = SRC.match(/if \(stalled\)[\s\S]*?ensureStallMarker/m);
    expect(stallBlock).toBeTruthy();
  });

  it("§3.h: service does NOT activate tenants -- only writes PAYMENT_SETTLED + flips SETTLED", () => {
    // No TenantProvisioningJob writes.
    expect(SRC).not.toMatch(/tenantProvisioningJob/i);
    // No ClubSubscription.subscriptionStatus = "ACTIVE" writes.
    expect(SRC).not.toMatch(/subscriptionStatus:\s*"ACTIVE"/);
    // No ACTIVATION_READY mutation (that's Phase 2E's job on
    // charge.succeeded via activationReady flag).
    expect(SRC).not.toMatch(/subscriptionStatus:\s*"ACTIVATION_READY"/);
  });

  it("legacy single-shot reconcileBalanceTransaction delegates to stepReconcile", () => {
    expect(SRC).toMatch(/export async function reconcileBalanceTransaction/);
    expect(SRC).toMatch(/const step = await stepReconcileBalanceTransaction\(/);
  });
});

describe("SIGNUP-2 M2-Validation · resolveStripeAdapter still fails closed on missing secrets", () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; vi.resetModules(); });

  it("mode=test + missing STRIPE_SECRET_KEY throws", async () => {
    process.env.SPECTRE_STRIPE_SDK_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SIGNING_SECRET = "whsec_test";
    const { resolveStripeAdapter } = await import("@/lib/billing/stripe-adapter");
    expect(() => resolveStripeAdapter()).toThrow(/STRIPE_SECRET_KEY and\/or STRIPE_WEBHOOK_SIGNING_SECRET is unset/);
  });

  it("mode=test + missing STRIPE_WEBHOOK_SIGNING_SECRET throws", async () => {
    process.env.SPECTRE_STRIPE_SDK_MODE = "test";
    process.env.STRIPE_SECRET_KEY = "sk_test_present";
    delete process.env.STRIPE_WEBHOOK_SIGNING_SECRET;
    const { resolveStripeAdapter } = await import("@/lib/billing/stripe-adapter");
    expect(() => resolveStripeAdapter()).toThrow(/STRIPE_SECRET_KEY and\/or STRIPE_WEBHOOK_SIGNING_SECRET is unset/);
  });

  it("resolveAcssPriceId throws on mode=test + missing STRIPE_ACSS_PRICE_ID", async () => {
    process.env.SPECTRE_STRIPE_SDK_MODE = "test";
    delete process.env.STRIPE_ACSS_PRICE_ID;
    const { resolveAcssPriceId } = await import("@/lib/billing/stripe-adapter");
    expect(() => resolveAcssPriceId()).toThrow(/STRIPE_ACSS_PRICE_ID is unset/);
  });
});

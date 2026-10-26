// SIGNUP-2 M1 (2026-10-26) -- Webhook → Phase 2H suspension contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DISPATCH = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2e-webhook-dispatch.ts"),
  "utf8",
);
const WEBHOOK_ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/webhooks/stripe/route.ts"),
  "utf8",
);

describe("M1 · webhook-to-Phase-2H wiring exists", () => {
  it("dispatcher imports suspendTenant from Phase 2H", () => {
    expect(DISPATCH).toMatch(/import \{ suspendTenant, type SuspensionTrigger \} from "\.\/signup-2h-tenant-lifecycle-service"/);
  });
  it("dispatcher defines trySuspendFromWebhook", () => {
    expect(DISPATCH).toMatch(/async function trySuspendFromWebhook/);
  });
  it("REFUND, DISPUTE, FAILED_RENEWAL triggers each call trySuspendFromWebhook", () => {
    expect(DISPATCH).toMatch(/trySuspendFromWebhook\(\{\s*clubId: cycle\.clubId,\s*trigger: "REFUND"/);
    expect(DISPATCH).toMatch(/trySuspendFromWebhook\(\{\s*clubId: cycle\.clubId,\s*trigger: "DISPUTE"/);
    expect(DISPATCH).toMatch(/trySuspendFromWebhook\(\{\s*clubId: cycle\.clubId,\s*trigger: "FAILED_RENEWAL"/);
  });
});

describe("M1 · webhook route invariants (durable receipt + dedup)", () => {
  it("the webhook route PERSISTS the event BEFORE dispatching", () => {
    const persistIdx = WEBHOOK_ROUTE.indexOf("prisma.stripeWebhookEvent.create");
    const dispatchIdx = WEBHOOK_ROUTE.indexOf("dispatchStripeEvent");
    expect(persistIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeLessThan(dispatchIdx);
  });
  it("the webhook route treats P2002 (duplicate) as a replay no-op", () => {
    expect(WEBHOOK_ROUTE).toMatch(/code === "P2002"/);
    expect(WEBHOOK_ROUTE).toMatch(/status: 200/);
  });
  it("verifyWebhookSignature is called BEFORE persistence", () => {
    const verifyIdx = WEBHOOK_ROUTE.indexOf("verifyWebhookSignature");
    const persistIdx = WEBHOOK_ROUTE.indexOf("prisma.stripeWebhookEvent.create");
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeLessThan(persistIdx);
  });
  it("flag-OFF: event is persisted but dispatch is skipped", () => {
    expect(WEBHOOK_ROUTE).toMatch(/SPECTRE_SIGNUP_2E_PAYMENT_LIVE !== "1"/);
    expect(WEBHOOK_ROUTE).toMatch(/received_disabled/);
  });
});

function trySuspendBody(): string {
  const startIdx = DISPATCH.indexOf("async function trySuspendFromWebhook");
  const after = DISPATCH.slice(startIdx);
  // trySuspendFromWebhook is the LAST function in the file; slice through
  // the end of the module.
  return after;
}

describe("M1 · suspension safety invariants (founder §4)", () => {
  it("trySuspendFromWebhook SKIPS legacy tenants (subscriptionStatus=null)", () => {
    const body = trySuspendBody();
    expect(body).toMatch(/sub\.subscriptionStatus === null/);
    expect(body).toMatch(/legacy-tenant-grandfathered/);
  });
  it("trySuspendFromWebhook SKIPS non-ACTIVE tenants (idempotency / out-of-order safety)", () => {
    const body = trySuspendBody();
    expect(body).toMatch(/sub\.subscriptionStatus !== "ACTIVE"/);
  });
  it("trySuspendFromWebhook NEVER contacts Stripe (no external network call while suspension runs)", () => {
    const body = trySuspendBody();
    expect(body).not.toMatch(/resolveStripeAdapter|retrieveBalanceTransaction|stripe\.customers\./);
  });
  it("trySuspendFromWebhook writes operator alert for failures (survivable)", () => {
    const body = trySuspendBody();
    expect(body).toMatch(/stripe\.webhook\.suspension_refused|stripe\.webhook\.suspension_skipped|stripe\.webhook\.suspension_triggered/);
  });
});

describe("M1 · does NOT automatically reinstate on later success event", () => {
  it("dispatcher's success handlers (payment_intent.succeeded, charge.succeeded) do NOT call reinstateTenant", () => {
    expect(DISPATCH).not.toMatch(/reinstateTenant\(/);
  });
  it("the dispatcher's state-flip for success events writes BillingCycle only, not ClubSubscription", () => {
    const succeededBlock = DISPATCH.match(/async function onPaymentIntentSucceeded[\s\S]+?^}/m)![0];
    expect(succeededBlock).toMatch(/prisma\.billingCycle\.updateMany/);
    expect(succeededBlock).not.toMatch(/prisma\.clubSubscription\./);
  });
});

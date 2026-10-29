// SIGNUP-2 Phase 2E (2026-10-26) -- Mock StripeAdapter.
//
// Deterministic test-mode adapter used when Stripe credentials have
// not been verified or configured.  Produces stable ids keyed off
// the idempotency key so a replay returns the same object.
//
// Hard safety:  isLive === false ALWAYS.  No outbound HTTP.  No
// Stripe SDK.  No fabrication of "live" evidence anywhere.
// evidenceSource === "mock-stripe" on every result so downstream
// consumers (reconciliation, acceptance docs) know the source.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  StripeAdapter,
  CreateCustomerArgs,
  CustomerRef,
  CreateMandateSessionArgs,
  MandateSessionRef,
  CheckoutSessionResult,
  CreateSubscriptionArgs,
  SubscriptionRef,
  BalanceTransactionResult,
  VerifyWebhookArgs,
  WebhookVerificationResult,
  StripeEventShape,
  SetupIntentResult,
  SetupIntentStatus,
} from "./types";

function stableIdFromKey(prefix: string, idempotencyKey: string): string {
  const h = createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
  return `${prefix}_mock_${h.slice(0, 24)}`;
}

export function createMockStripeAdapter(): StripeAdapter {
  return {
    isLive: false,

    async createCustomer(args: CreateCustomerArgs): Promise<CustomerRef> {
      return {
        stripeCustomerId: stableIdFromKey("cus", args.idempotencyKey),
        evidenceSource: "mock-stripe",
      };
    },

    async createMandateCheckoutSession(args: CreateMandateSessionArgs): Promise<MandateSessionRef> {
      const sessionId = stableIdFromKey("cs", args.idempotencyKey);
      // The mock "checkout url" is a Spectre-hosted stub that the
      // Playwright acceptance pretends is Stripe's hosted page.
      // Signatories NEVER see this in production -- Phase 2E ships
      // with the feature flag OFF so the live route is unreachable.
      return {
        checkoutSessionId: sessionId,
        checkoutUrl: `about:blank#mock-checkout-${sessionId}`,
        evidenceSource: "mock-stripe",
      };
    },

    async retrieveCheckoutSession(id: string): Promise<CheckoutSessionResult> {
      // Mock: a session retrieval always returns "complete" with a
      // stable mandate id derived from the session id.  The sign-in
      // moment is purely virtual.  M3 (2026-10-27) extends the shape
      // with setupIntentId + setupIntentStatus = "succeeded" so the
      // instant-verification branch exercises in acceptance tests.
      // Microdeposit + failure branches are exercised via explicit
      // webhook injection in the test harness.
      return {
        checkoutSessionId: id,
        status: "complete",
        mandateId: `mandate_mock_${id.slice(-16)}`,
        paymentMethodId: `pm_mock_${id.slice(-16)}`,
        customerId: `cus_mock_${id.slice(-16)}`,
        setupIntentId: `seti_mock_${id.slice(-16)}`,
        setupIntentStatus: "succeeded",
        evidenceSource: "mock-stripe",
      };
    },

    async retrieveSetupIntent(id: string): Promise<SetupIntentResult> {
      // Mock: deterministic succeeded SetupIntent that lets M3's §5
      // Stripe-state re-validation pass in acceptance tests.
      // Microdeposit / failure branches are produced via explicit
      // webhook injection, not by this read.
      const status: SetupIntentStatus = "succeeded";
      return {
        setupIntentId: id,
        status,
        customerId: `cus_mock_${id.slice(-16)}`,
        paymentMethodId: `pm_mock_${id.slice(-16)}`,
        mandateId: `mandate_mock_${id.slice(-16)}`,
        nextAction: null,
        lastSetupErrorCode: null,
        lastSetupErrorMessage: null,
        evidenceSource: "mock-stripe",
      };
    },

    async createSubscription(args: CreateSubscriptionArgs): Promise<SubscriptionRef> {
      const subscriptionId = stableIdFromKey("sub", args.idempotencyKey);
      return {
        stripeSubscriptionId: subscriptionId,
        firstPaymentIntentId: stableIdFromKey("pi", args.idempotencyKey + ":firstpi"),
        evidenceSource: "mock-stripe",
      };
    },

    async scheduleSubscriptionCancellation(args: {
      stripeSubscriptionId: string;
      cancelAt: Date;
      idempotencyKey: string;
    }): Promise<{ stripeSubscriptionId: string; stripeCancelAt: Date; status: string; evidenceSource: "mock-stripe" }> {
      // M4-cancellation mock: records the requested cancel_at timestamp
      // verbatim.  Does NOT alter subscription status immediately -- the
      // real-world webhook would deliver customer.subscription.updated
      // with cancel_at set, and later customer.subscription.deleted at
      // the effective moment.  Acceptance tests exercise those via the
      // signed-webhook injection path.
      return {
        stripeSubscriptionId: args.stripeSubscriptionId,
        stripeCancelAt: args.cancelAt,
        status: "active",
        evidenceSource: "mock-stripe",
      };
    },

    async resumeSubscription(args: {
      stripeSubscriptionId: string;
      idempotencyKey: string;
    }): Promise<{ stripeSubscriptionId: string; status: string; evidenceSource: "mock-stripe" }> {
      // M4-cancellation mock: un-schedules the cancel_at.  Status
      // stays "active".
      return {
        stripeSubscriptionId: args.stripeSubscriptionId,
        status: "active",
        evidenceSource: "mock-stripe",
      };
    },

    async retrieveBalanceTransaction(id: string): Promise<BalanceTransactionResult> {
      // Mock: always returns "available" with available_on in the
      // immediate past so the activation gate flips in acceptance
      // tests.  Live adapters will return the real Stripe values
      // and the reconciliation layer will poll until available.
      const now = Date.now();
      return {
        balanceTransactionId: id,
        status: "available",
        availableAt: new Date(now - 60_000),
        currency: "cad",
        amountMinor: 3_800_000, // CAD $38,000.00 in cents
        evidenceSource: "mock-stripe",
      };
    },

    verifyWebhookSignature(args: VerifyWebhookArgs): WebhookVerificationResult {
      // Mock verification: accepts a deterministic HMAC-SHA-256 over
      // "<timestamp>.<rawBody>" using the signing secret.  Mimics
      // Stripe's own signature scheme closely enough that Playwright
      // tests can fabricate valid signatures by signing the same
      // way.  Live adapter will use `stripe.webhooks.constructEvent`
      // against the real signing secret.
      if (!args.signatureHeader) return { ok: false, reason: "missing_signature" };
      if (!args.signingSecret) return { ok: false, reason: "missing_secret" };
      // Expected header format: `t=<ts>,v1=<hex-hmac>`
      const match = args.signatureHeader.match(/t=(\d+),v1=([0-9a-f]+)/);
      if (!match) return { ok: false, reason: "signature_mismatch" };
      const timestamp = match[1];
      const signature = match[2];
      const expected = createHmac("sha256", args.signingSecret)
        .update(`${timestamp}.${args.rawBody}`)
        .digest("hex");
      try {
        const sigBuf = Buffer.from(signature, "hex");
        const expBuf = Buffer.from(expected, "hex");
        if (sigBuf.length !== expBuf.length) return { ok: false, reason: "signature_mismatch" };
        if (!timingSafeEqual(sigBuf, expBuf)) return { ok: false, reason: "signature_mismatch" };
      } catch {
        return { ok: false, reason: "signature_mismatch" };
      }
      try {
        const parsed = JSON.parse(args.rawBody) as Partial<StripeEventShape>;
        if (!parsed.id || !parsed.type || typeof parsed.created !== "number") {
          return { ok: false, reason: "parse_error" };
        }
        return {
          ok: true,
          event: {
            id: parsed.id,
            type: parsed.type,
            created: parsed.created,
            livemode: parsed.livemode === true, // mock defaults false
            data: (parsed.data as any) ?? { object: {} },
            rawPayloadJson: args.rawBody,
          },
        };
      } catch {
        return { ok: false, reason: "parse_error" };
      }
    },
  };
}

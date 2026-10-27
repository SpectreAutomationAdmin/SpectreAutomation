// SIGNUP-2 M2 (2026-10-27) -- Live StripeAdapter (official SDK).
//
// Implements the `StripeAdapter` port against the official Stripe
// Node.js SDK (v23).  Runs ONLY when SPECTRE_SIGNUP_2E_STRIPE_MODE
// === "live" AND STRIPE_SECRET_KEY is set.  Fail-closed otherwise
// (resolver throws).
//
// Credential contract (set via `flyctl secrets set --app <app>`):
//   STRIPE_SECRET_KEY            sk_test_...   (live mode: sk_live_...)
//   STRIPE_WEBHOOK_SIGNING_SECRET whsec_...
//   STRIPE_ACSS_PRICE_ID         price_...    (CAD $38,000 annual ACSS)
//   SPECTRE_SIGNUP_2E_STRIPE_MODE  = "live"
//
// M2 ships this adapter + the resolver; by default the mode remains
// "mock" so NO Stripe calls happen until the operator flips the
// flag + provisions the three credentials.
//
// Safety invariants:
//   - evidenceSource === "live-stripe" on every result.
//   - Idempotency keys are passed to every mutating endpoint so
//     Stripe deduplicates on retries.
//   - All non-idempotent reads (retrieve*) use the standard REST
//     call -- they are safe to retry on 5xx.
//   - Mutating methods wrap in `withStripeRetry` (exponential
//     backoff + bounded attempts) to tolerate transient network
//     + 5xx errors.
//   - verifyWebhookSignature uses `stripe.webhooks.constructEvent`
//     against the configured signing secret.  Returns a verification
//     result -- never throws so the webhook route decides HTTP code.
//   - Rejects `livemode === true` events on staging (via the webhook
//     route's own guard; see src/app/api/webhooks/stripe/route.ts).

import Stripe from "stripe";
import { logger } from "@/lib/observability/logger";
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
} from "./types";

const API_VERSION: Stripe.LatestApiVersion = "2026-09-30.endive";

// ---- Retry wrapper -----------------------------------------------
//
// Bounded exponential backoff with jitter.  Retries only on
// StripeConnectionError, StripeAPIError (5xx), and the "api_connection"
// type.  Never retries 4xx (invalid request / idempotency conflict /
// signature mismatch).

interface RetryOpts { maxAttempts?: number; baseDelayMs?: number; cap?: number; }

async function withStripeRetry<T>(fn: () => Promise<T>, label: string, opts: RetryOpts = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const base = opts.baseDelayMs ?? 400;
  const cap = opts.cap ?? 5_000;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retriable = isRetriableStripeError(err);
      if (!retriable || attempt === maxAttempts) {
        logger.warn("stripe.live.call_failed", {
          label,
          attempt,
          final: true,
          type: (err as Stripe.StripeRawError | undefined)?.type ?? "unknown",
          code: (err as any)?.code ?? null,
          statusCode: (err as any)?.statusCode ?? null,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      const jitter = Math.random() * 100;
      const delay = Math.min(cap, base * Math.pow(2, attempt - 1)) + jitter;
      logger.info("stripe.live.call_retry", {
        label,
        attempt,
        delayMs: Math.round(delay),
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`stripe retry exhausted: ${label}`);
}

function isRetriableStripeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { type?: string; statusCode?: number };
  if (anyErr.type === "StripeConnectionError") return true;
  if (anyErr.type === "StripeAPIError") return true;
  if (typeof anyErr.statusCode === "number" && anyErr.statusCode >= 500) return true;
  return false;
}

// ---- Live adapter factory -----------------------------------------

export interface LiveAdapterConfig {
  secretKey: string;
  webhookSigningSecret: string;
}

export function createLiveStripeAdapter(config: LiveAdapterConfig): StripeAdapter {
  if (!config.secretKey) {
    throw new Error("[signup-2m2] createLiveStripeAdapter: STRIPE_SECRET_KEY is empty");
  }
  if (!config.webhookSigningSecret) {
    throw new Error("[signup-2m2] createLiveStripeAdapter: STRIPE_WEBHOOK_SIGNING_SECRET is empty");
  }
  const stripe = new Stripe(config.secretKey, {
    apiVersion: API_VERSION,
    typescript: true,
    maxNetworkRetries: 0, // we handle retries via withStripeRetry
    timeout: 15_000,
    telemetry: false,
  });

  return {
    isLive: true,

    async createCustomer(args: CreateCustomerArgs): Promise<CustomerRef> {
      const customer = await withStripeRetry(
        () => stripe.customers.create(
          {
            description: args.description,
            metadata: {
              ...args.metadata,
              signupRegistrationId: args.signupRegistrationId,
              source: "spectre-signup-2m2",
            },
          },
          { idempotencyKey: args.idempotencyKey },
        ),
        "customers.create",
      );
      return {
        stripeCustomerId: customer.id,
        evidenceSource: "live-stripe",
      };
    },

    async createMandateCheckoutSession(args: CreateMandateSessionArgs): Promise<MandateSessionRef> {
      const session = await withStripeRetry(
        () => stripe.checkout.sessions.create(
          // M2-ACSS-Audit (2026-10-27): per Stripe docs the Canadian
          // ACSS Debit flow for ANNUAL SUBSCRIPTIONS must:
          //   1. Use Checkout `mode: "setup"` (subscription mode is
          //      explicitly unsupported for ACSS per
          //      https://docs.stripe.com/payments/acss-debit).
          //   2. Set `payment_method_types: ["acss_debit"]` EXPLICITLY
          //      (not inferred from payment_method_options).
          //   3. Set `payment_method_options.acss_debit.mandate_options.
          //      default_for = ["invoice", "subscription"]` so the saved
          //      mandate can be reused by future invoices + subscription
          //      renewals without re-collecting from the signatory.
          //   4. Set `payment_method_options.acss_debit.setup_future_usage
          //      = "off_session"` so Stripe treats the mandate as valid
          //      for future unattended renewals.
          //   5. Keep `payment_schedule: "interval"` + `interval_description`
          //      + `transaction_type: "business"` (ACSS requires these).
          {
            mode: "setup",
            customer: args.stripeCustomerId,
            payment_method_types: ["acss_debit"],
            payment_method_options: {
              acss_debit: {
                currency: "cad",
                setup_future_usage: "off_session",
                mandate_options: {
                  payment_schedule: "interval",
                  interval_description: args.acssMandate.intervalDescription,
                  transaction_type: "business",
                  default_for: ["invoice", "subscription"],
                },
              },
            },
            success_url: args.successUrl,
            cancel_url: args.cancelUrl,
            metadata: args.metadata,
          } as Stripe.Checkout.SessionCreateParams,
          { idempotencyKey: args.idempotencyKey },
        ),
        "checkout.sessions.create",
      );
      return {
        checkoutSessionId: session.id,
        checkoutUrl: session.url ?? "",
        evidenceSource: "live-stripe",
      };
    },

    async retrieveCheckoutSession(id: string): Promise<CheckoutSessionResult> {
      const session = await withStripeRetry(
        () => stripe.checkout.sessions.retrieve(id, {
          expand: ["setup_intent", "setup_intent.payment_method"],
        }),
        "checkout.sessions.retrieve",
      );
      // Extract mandate + payment method from the setup_intent.
      const setupIntent = session.setup_intent as Stripe.SetupIntent | string | null;
      let mandateId: string | null = null;
      let paymentMethodId: string | null = null;
      if (setupIntent && typeof setupIntent !== "string") {
        const si = setupIntent as Stripe.SetupIntent;
        if (typeof si.mandate === "string") mandateId = si.mandate;
        else if (si.mandate && typeof si.mandate === "object" && "id" in si.mandate) {
          mandateId = (si.mandate as Stripe.Mandate).id;
        }
        if (typeof si.payment_method === "string") paymentMethodId = si.payment_method;
        else if (si.payment_method && typeof si.payment_method === "object" && "id" in si.payment_method) {
          paymentMethodId = (si.payment_method as Stripe.PaymentMethod).id;
        }
      }
      const customerId = typeof session.customer === "string" ? session.customer : (session.customer?.id ?? "");
      const status: CheckoutSessionResult["status"] =
        session.status === "complete" ? "complete" :
        session.status === "expired" ? "expired" : "open";
      return {
        checkoutSessionId: session.id,
        status,
        mandateId,
        paymentMethodId,
        customerId,
        evidenceSource: "live-stripe",
      };
    },

    async createSubscription(args: CreateSubscriptionArgs): Promise<SubscriptionRef> {
      const sub = await withStripeRetry(
        () => stripe.subscriptions.create(
          {
            customer: args.stripeCustomerId,
            items: [{ price: args.stripePriceId }],
            default_payment_method: args.defaultPaymentMethodId,
            payment_behavior: "default_incomplete",
            payment_settings: {
              payment_method_types: ["acss_debit"],
              save_default_payment_method: "on_subscription",
            },
            expand: ["latest_invoice.payment_intent"],
            metadata: args.metadata,
          },
          { idempotencyKey: args.idempotencyKey },
        ),
        "subscriptions.create",
      );
      // Extract the first payment_intent from the latest invoice.
      const invoice = sub.latest_invoice as Stripe.Invoice | string | null;
      let firstPaymentIntentId = "";
      if (invoice && typeof invoice !== "string") {
        const pi = (invoice as Stripe.Invoice & { payment_intent?: Stripe.PaymentIntent | string }).payment_intent;
        if (typeof pi === "string") firstPaymentIntentId = pi;
        else if (pi && typeof pi === "object" && "id" in pi) firstPaymentIntentId = pi.id;
      }
      if (!firstPaymentIntentId) {
        // Stripe did not surface a payment_intent on the first invoice.
        // This is unexpected for `default_incomplete` with ACSS; log + fail
        // the activation flow upstream rather than fabricating an id.
        logger.warn("stripe.live.subscription_missing_payment_intent", {
          subscriptionId: sub.id,
          invoiceId: typeof invoice === "string" ? invoice : (invoice?.id ?? null),
        });
      }
      return {
        stripeSubscriptionId: sub.id,
        firstPaymentIntentId,
        evidenceSource: "live-stripe",
      };
    },

    async retrieveBalanceTransaction(id: string): Promise<BalanceTransactionResult> {
      const bt = await withStripeRetry(
        () => stripe.balanceTransactions.retrieve(id),
        "balanceTransactions.retrieve",
      );
      const availableAt = new Date(bt.available_on * 1000);
      const status: BalanceTransactionResult["status"] = bt.status === "available" ? "available" : "pending";
      return {
        balanceTransactionId: bt.id,
        status,
        availableAt,
        currency: bt.currency,
        amountMinor: bt.amount,
        evidenceSource: "live-stripe",
      };
    },

    verifyWebhookSignature(args: VerifyWebhookArgs): WebhookVerificationResult {
      if (!args.signatureHeader) return { ok: false, reason: "missing_signature" };
      if (!args.signingSecret) return { ok: false, reason: "missing_secret" };
      try {
        const event = stripe.webhooks.constructEvent(
          args.rawBody,
          args.signatureHeader,
          args.signingSecret,
        );
        const shape: StripeEventShape = {
          id: event.id,
          type: event.type,
          created: event.created,
          livemode: event.livemode,
          data: {
            object: (event.data?.object ?? {}) as unknown as Record<string, unknown>,
          },
          rawPayloadJson: args.rawBody,
        };
        return { ok: true, event: shape };
      } catch (err) {
        const type = (err as { type?: string } | undefined)?.type;
        if (type === "StripeSignatureVerificationError") {
          return { ok: false, reason: "signature_mismatch" };
        }
        logger.warn("stripe.live.webhook_verify_parse_error", {
          detail: err instanceof Error ? err.message : String(err),
        });
        return { ok: false, reason: "parse_error" };
      }
    },
  };
}

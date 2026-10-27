// SIGNUP-2 Phase 2E (2026-10-26) -- StripeAdapter port.
//
// Provider-independent interface for Stripe interactions.  Phase 2E
// ships only the MOCK implementation (per founder §1: Stripe
// capabilities + credentials were not independently verified, so
// Phase 2E implements provider-independent components + mocked
// contracts; no fabricated Stripe acceptance evidence).  A live
// adapter is a separately-authorised later slice.

export interface StripeAdapter {
  readonly isLive: boolean;
  createCustomer(args: CreateCustomerArgs): Promise<CustomerRef>;
  createMandateCheckoutSession(args: CreateMandateSessionArgs): Promise<MandateSessionRef>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSessionResult>;
  createSubscription(args: CreateSubscriptionArgs): Promise<SubscriptionRef>;
  retrieveBalanceTransaction(id: string): Promise<BalanceTransactionResult>;
  verifyWebhookSignature(args: VerifyWebhookArgs): WebhookVerificationResult;
  // SIGNUP-2 M3 (2026-10-27) -- required for the §5 Stripe-state
  // re-validation performed immediately before subscription creation
  // and for the setup_intent.* webhook enrichment path.
  retrieveSetupIntent(id: string): Promise<SetupIntentResult>;
}

export interface CreateCustomerArgs {
  idempotencyKey: string;        // "signup-2e-customer:<signupRegistrationId>"
  signupRegistrationId: string;  // for provenance only; never leaves this call
  description: string;           // e.g. "Spectre subscription customer -- registration <tail>"
  metadata: Record<string, string>; // e.g. { signupRegistrationIdTail }
}

export interface CustomerRef {
  stripeCustomerId: string;
  evidenceSource: "live-stripe" | "mock-stripe"; // never fabricated
}

export interface CreateMandateSessionArgs {
  idempotencyKey: string;
  stripeCustomerId: string;
  acssMandate: {
    paymentSchedule: "interval";
    transactionType: "business";
    intervalDescription: string;
  };
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export interface MandateSessionRef {
  checkoutSessionId: string;
  checkoutUrl: string; // where the signatory lands to sign
  evidenceSource: "live-stripe" | "mock-stripe";
}

export interface CheckoutSessionResult {
  checkoutSessionId: string;
  status: "complete" | "open" | "expired";
  mandateId: string | null;      // Stripe mandate id (acss_debit)
  paymentMethodId: string | null;
  customerId: string;
  // SIGNUP-2 M3 (2026-10-27) -- expanded for the bank-verification tier.
  setupIntentId: string | null;  // the SetupIntent that produced the mandate
  setupIntentStatus: SetupIntentStatus | null;
  evidenceSource: "live-stripe" | "mock-stripe";
}

/** SIGNUP-2 M3 (2026-10-27) -- Stripe SetupIntent lifecycle.
 *  See https://docs.stripe.com/api/setup_intents and SetupIntents.d.ts
 *  in stripe@23.0.1 for the full enum; we narrow to the values that
 *  concern Spectre's bank-verification tier. */
export type SetupIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "canceled"
  | "succeeded";

/** SIGNUP-2 M3 (2026-10-27) -- fields read by M3's §5 Stripe-state
 *  re-validation + the setup_intent.* webhook handlers.  Shape is
 *  deliberately narrow -- we never pass raw Stripe objects around. */
export interface SetupIntentResult {
  setupIntentId: string;
  status: SetupIntentStatus;
  customerId: string | null;
  paymentMethodId: string | null;
  mandateId: string | null;
  // When status === "requires_action" AND payment is acss_debit:
  //   nextAction.type        = "verify_with_microdeposits"
  //   nextAction.arrivalDate = Stripe-reported expected deposit arrival
  //   nextAction.hostedUrl   = Stripe hosted microdeposit confirmation URL
  //   nextAction.depositType = "amounts" | "descriptor_code"
  nextAction: SetupIntentNextAction | null;
  // last_setup_error.code when status is setup_failed / requires_payment_method.
  lastSetupErrorCode: string | null;
  lastSetupErrorMessage: string | null;
  evidenceSource: "live-stripe" | "mock-stripe";
}

export interface SetupIntentNextAction {
  type: "verify_with_microdeposits" | string;
  arrivalDate: Date | null;
  hostedUrl: string | null;
  depositType: "amounts" | "descriptor_code" | null;
}

export interface CreateSubscriptionArgs {
  idempotencyKey: string;
  stripeCustomerId: string;
  stripePriceId: string;         // "price_signup2e_38kcad_annual" (mock) or a live price id
  defaultPaymentMethodId: string;
  metadata: Record<string, string>;
}

export interface SubscriptionRef {
  stripeSubscriptionId: string;
  firstPaymentIntentId: string;  // the invoice.payment_intent for the first cycle
  evidenceSource: "live-stripe" | "mock-stripe";
}

export interface BalanceTransactionResult {
  balanceTransactionId: string;
  status: "available" | "pending";
  availableAt: Date;             // T+5 for ACSS debit standard
  currency: string;              // "cad"
  amountMinor: number;           // 3800000 for CAD $38,000
  evidenceSource: "live-stripe" | "mock-stripe";
}

export interface VerifyWebhookArgs {
  rawBody: string;               // RAW request body (not re-serialised JSON)
  signatureHeader: string | null; // Stripe-Signature header
  signingSecret: string;         // whsec_... (test or live)
}

export type WebhookVerificationResult =
  | { ok: true; event: StripeEventShape }
  | { ok: false; reason: "missing_signature" | "missing_secret" | "signature_mismatch" | "parse_error" };

/** A minimal, provider-independent shape of a Stripe event.  Live
 *  adapters cast the real stripe.events.X type into this shape; mock
 *  adapters produce it directly. */
export interface StripeEventShape {
  id: string;
  type: string;                  // "payment_intent.processing" | ...
  created: number;               // epoch seconds
  livemode: boolean;             // MUST be false on staging
  data: {
    object: Record<string, unknown>;
  };
  // Original raw payload, retained for durable receipt storage.
  rawPayloadJson: string;
}

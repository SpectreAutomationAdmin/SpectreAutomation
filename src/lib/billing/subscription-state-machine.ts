// SIGNUP-2 Phase 2A (2026-10-25) + M3 (2026-10-27) -- Subscription state machine primitives.
//
// Pure functions.  No DB calls, no Stripe calls, no side effects beyond
// the return value.  The state-transition rules live here so they can
// be unit-tested without a database AND imported from webhook routes,
// operator actions, and reconciliation jobs without duplication.
//
// Phase 2A ships the baseline state machine.  M3 (2026-10-27) adds the
// three bank-verification states that sit between AUTHORISED and
// INITIATED (aka PAYMENT_INITIATED in M3 vocabulary):
//
//   AUTHORISED
//     -> BANK_VERIFICATION_PENDING   (setup_intent moves to requires_action
//                                     -- microdeposit path)
//     -> BANK_VERIFIED               (setup_intent succeeded -- instant path
//                                     or microdeposit confirmation complete)
//     -> BANK_VERIFICATION_FAILED    (setup_intent setup_failed / canceled /
//                                     Stripe-driven TTL expiry)
//
//   BANK_VERIFIED -> INITIATED       (operator- or automation-driven call to
//                                     advanceToPaymentInitiated, gated behind
//                                     SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION=1)
//
// Founder-vocabulary mapping (M3 authorisation 2026-10-27):
//
//   PAYMENT_INITIATED  == INITIATED             (subscription + first invoice created)
//   PAYMENT_PROCESSING == AWAITING_SETTLEMENT   (payment_intent.processing)
//   FUNDS_AVAILABLE    == ACTIVATION_READY      (balance_transaction available)
//   TENANT_ACTIVATED   == ACTIVE                (Phase 2G provisioning complete)
//
// Preserved verbatim per M3 founder §10 (tenant isolation, webhook sig,
// idempotency, synthetic restrictions, settled-funds activation gate):
//   - evaluateActivationGate still requires status==="SETTLED" AND
//     balance_transaction.status==="available" AND NOT reversed.
//     Bank verification does NOT imply funds availability (§7).
//   - All existing permitted transitions remain unchanged.

import { AppError } from "@/lib/errors";

/** SIGNUP-2 subscription states + the operator-elected manual-invoice
 *  branch + the M3 bank-verification tier.  Written to
 *  `ClubSubscription.subscriptionStatus` and `BillingCycle.subscriptionStatus`. */
export const SUBSCRIPTION_STATES = [
  "AUTHORISED",
  // -- M3 bank-verification tier (2026-10-27) ------------------------
  "BANK_VERIFICATION_PENDING",   // microdeposit path -- Stripe owns the 10d TTL
  "BANK_VERIFIED",               // SetupIntent.succeeded; mandate reusable
  "BANK_VERIFICATION_FAILED",    // setup_failed / canceled / TTL exhausted
  // -- Phase 2A payment tier (unchanged) ------------------------------
  "INITIATED",                   // M3 vocab: PAYMENT_INITIATED
  "AWAITING_SETTLEMENT",         // M3 vocab: PAYMENT_PROCESSING
  "SETTLED",
  "ACTIVATION_READY",            // M3 vocab: FUNDS_AVAILABLE
  "ACTIVE",                      // M3 vocab: TENANT_ACTIVATED
  "SUSPENDED",
  "PAYMENT_FAILED",
  "CANCELLED",
  "MANUAL_INVOICE",
] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

/** M3 (2026-10-27): the three bank-verification states.  Any transition
 *  OUT of this set and INTO INITIATED must call advanceToPaymentInitiated,
 *  which performs the mandatory Stripe-state re-validation per founder §5. */
export const BANK_VERIFICATION_STATES: ReadonlySet<SubscriptionState> = new Set([
  "BANK_VERIFICATION_PENDING",
  "BANK_VERIFIED",
  "BANK_VERIFICATION_FAILED",
]);

/** Terminal states -- no further forward transitions permitted. */
export const TERMINAL_STATES: ReadonlySet<SubscriptionState> = new Set([
  "ACTIVE",     // steady-state operation (reversible to SUSPENDED only)
  "CANCELLED",
]);

/** States from which the Club is holding Tier 1 (staged) access.
 *  M3 (2026-10-27): the three bank-verification states extend Tier 1 --
 *  the Club has signed the mandate and attestation but has not been
 *  debited; access-tier semantics match AUTHORISED. */
export const TIER1_STATES: ReadonlySet<SubscriptionState> = new Set([
  "AUTHORISED",
  "BANK_VERIFICATION_PENDING",
  "BANK_VERIFIED",
  "BANK_VERIFICATION_FAILED",
  "INITIATED",
  "AWAITING_SETTLEMENT",
  "SETTLED",
  "ACTIVATION_READY",
  "PAYMENT_FAILED",
]);

/** States from which the Club has Tier 2 (full) access. */
export const TIER2_STATES: ReadonlySet<SubscriptionState> = new Set([
  "ACTIVE",
  "MANUAL_INVOICE",
]);

/** States that collapse Tier 2 back to Tier-1-read-only. */
export const SUSPENDED_READ_ONLY_STATES: ReadonlySet<SubscriptionState> =
  new Set(["SUSPENDED"]);

/**
 * The permitted forward transition set.  Values are the states that
 * MAY immediately follow a key.  Any transition not in this map is
 * forbidden.
 *
 * The map is intentionally conservative -- adding permitted edges in
 * the future is a reviewed change, not a free parameter.
 */
export const PERMITTED_TRANSITIONS: Readonly<Record<SubscriptionState, readonly SubscriptionState[]>> = {
  // From AUTHORISED (M3 vocabulary: pre-verification), Spectre enters
  // the bank-verification tier.  The legacy direct edge to INITIATED
  // remains permitted so that Phase 2E in mock mode (M3 flag OFF) and
  // historical cycles continue to function.
  AUTHORISED:          ["BANK_VERIFICATION_PENDING", "BANK_VERIFIED", "BANK_VERIFICATION_FAILED", "INITIATED", "CANCELLED"],
  // M3: microdeposit path -- resolves to BANK_VERIFIED on signatory
  // confirmation OR BANK_VERIFICATION_FAILED on failure / Stripe TTL
  // expiry (Stripe owns the 10-day TTL per founder §1; Spectre does
  // not force-fail a Stripe-verifiable account).
  BANK_VERIFICATION_PENDING: ["BANK_VERIFIED", "BANK_VERIFICATION_FAILED", "CANCELLED"],
  // M3: BANK_VERIFIED is the sole permitted precondition for INITIATED
  // when SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION=1.  advanceToPaymentInitiated
  // in signup-2m3-bank-verification-service.ts additionally re-fetches
  // the SetupIntent from Stripe and re-validates per founder §5.
  BANK_VERIFIED:       ["INITIATED", "CANCELLED"],
  // M3: BANK_VERIFICATION_FAILED is recoverable -- a new Checkout
  // session (new SetupIntent) returns the registration to AUTHORISED,
  // from which the bank-verification tier restarts.
  BANK_VERIFICATION_FAILED: ["AUTHORISED", "CANCELLED"],
  // From INITIATED, Stripe moves us to AWAITING_SETTLEMENT (processing)
  // or straight to PAYMENT_FAILED (invalid account, immediate decline).
  INITIATED:           ["AWAITING_SETTLEMENT", "PAYMENT_FAILED"],
  // AWAITING_SETTLEMENT resolves to SETTLED on charge.succeeded OR to
  // PAYMENT_FAILED on charge.failed.
  AWAITING_SETTLEMENT: ["SETTLED", "PAYMENT_FAILED"],
  // SETTLED gates on balance_transaction.status == available via the
  // reconciliation step before ACTIVATION_READY.
  SETTLED:             ["ACTIVATION_READY", "SUSPENDED"],
  // ACTIVATION_READY is consumed by TenantProvisioningJob reaching
  // COMPLETED.  Reversal (dispute) can bypass to SUSPENDED.
  ACTIVATION_READY:    ["ACTIVE", "SUSPENDED"],
  // ACTIVE can only be downgraded to SUSPENDED (reversal) or
  // CANCELLED (end of relationship).  Never back to AUTHORISED.
  ACTIVE:              ["SUSPENDED", "CANCELLED"],
  // SUSPENDED can be restored to ACTIVE (fresh cycle settled) or
  // CANCELLED (operator / timeout).
  SUSPENDED:           ["ACTIVE", "CANCELLED"],
  // PAYMENT_FAILED can be retried (back to AWAITING_SETTLEMENT via a
  // fresh Smart Retry attempt) or operator-cancelled.
  PAYMENT_FAILED:      ["AWAITING_SETTLEMENT", "CANCELLED"],
  // CANCELLED is terminal.
  CANCELLED:           [],
  // MANUAL_INVOICE is operator-only; from here the Club is treated
  // as effectively ACTIVE until the operator cancels.
  MANUAL_INVOICE:      ["CANCELLED"],
} as const;

/**
 * Explicitly-forbidden transitions.  Members of this set should
 * NEVER be seen in production and warrant an audit if they ever are.
 * The predicate `isTransitionPermitted` is the authoritative check;
 * this list exists so operator and reviewer code can call it out
 * specifically.
 */
export const FORBIDDEN_TRANSITIONS: readonly { from: SubscriptionState; to: SubscriptionState }[] = [
  // Cannot un-pay.
  { from: "ACTIVE",              to: "AUTHORISED" },
  { from: "ACTIVE",              to: "INITIATED" },
  { from: "ACTIVE",              to: "AWAITING_SETTLEMENT" },
  { from: "ACTIVE",              to: "BANK_VERIFICATION_PENDING" },
  { from: "ACTIVE",              to: "BANK_VERIFIED" },
  { from: "ACTIVE",              to: "BANK_VERIFICATION_FAILED" },
  { from: "SUSPENDED",           to: "AUTHORISED" },
  // Cannot skip the gate.
  { from: "SETTLED",             to: "ACTIVE" },
  // M3 (2026-10-27): cannot skip bank verification once past it.
  { from: "INITIATED",           to: "BANK_VERIFICATION_PENDING" },
  { from: "INITIATED",           to: "BANK_VERIFIED" },
  { from: "INITIATED",           to: "BANK_VERIFICATION_FAILED" },
  { from: "AWAITING_SETTLEMENT", to: "BANK_VERIFIED" },
  // Cannot regress from a terminal.
  { from: "CANCELLED",           to: "AUTHORISED" },
  { from: "CANCELLED",           to: "ACTIVE" },
  { from: "CANCELLED",           to: "BANK_VERIFICATION_PENDING" },
  { from: "CANCELLED",           to: "BANK_VERIFIED" },
] as const;

export function isTransitionPermitted(
  from: SubscriptionState,
  to: SubscriptionState,
): boolean {
  if (from === to) return false; // self-transitions are a no-op, not permitted
  const allowed = PERMITTED_TRANSITIONS[from];
  return allowed.includes(to);
}

export function requireTransition(
  from: SubscriptionState,
  to: SubscriptionState,
): void {
  if (!isTransitionPermitted(from, to)) {
    throw new AppError(
      "SIGNUP_2_FORBIDDEN_TRANSITION",
      `SIGNUP-2 subscription-state transition not permitted: ${from} -> ${to}`,
      400,
    );
  }
}

/**
 * Reversal transitions -- edges that regress a formerly-ACTIVE
 * subscription back to a locked state.  Documented for audit; the
 * three sources are PAD NSF post-settlement, business-account PAD
 * dispute within 10 bd, and operator-initiated suspend.  All three
 * route through ACTIVE -> SUSPENDED.
 */
export const REVERSAL_EDGES: readonly { from: SubscriptionState; to: SubscriptionState; reason: string }[] = [
  { from: "ACTIVE",           to: "SUSPENDED", reason: "pad_nsf_post_settlement" },
  { from: "ACTIVE",           to: "SUSPENDED", reason: "pad_dispute_within_window" },
  { from: "ACTIVE",           to: "SUSPENDED", reason: "operator_initiated_suspend" },
  { from: "ACTIVATION_READY", to: "SUSPENDED", reason: "pre_activation_reversal" },
] as const;

/**
 * The precise FULL_ACCESS activation gate conditions.  Called by
 * the reconciliation step before transitioning SETTLED ->
 * ACTIVATION_READY.
 *
 * Phase 2A ships the predicate.  The actual webhook + reconciliation
 * code paths that CALL this live in Phase 2F.
 */
export interface ActivationGateInput {
  subscriptionStatus: SubscriptionState | null;
  balanceTransactionStatus: "available" | "pending" | null; // Stripe BalanceTransaction.status
  balanceAvailableOn: Date | null;                           // Stripe BalanceTransaction.available_on
  nowUtc: Date;
  disputeOrRefundExistsForCycle: boolean;
}
export interface ActivationGateResult {
  pass: boolean;
  reason?:
    | "wrong_subscription_status"
    | "balance_transaction_not_available"
    | "available_on_in_future"
    | "dispute_or_refund_exists_for_cycle";
}

export function evaluateActivationGate(input: ActivationGateInput): ActivationGateResult {
  if (input.subscriptionStatus !== "SETTLED") {
    return { pass: false, reason: "wrong_subscription_status" };
  }
  if (input.balanceTransactionStatus !== "available") {
    return { pass: false, reason: "balance_transaction_not_available" };
  }
  if (!input.balanceAvailableOn || input.balanceAvailableOn.getTime() > input.nowUtc.getTime()) {
    return { pass: false, reason: "available_on_in_future" };
  }
  if (input.disputeOrRefundExistsForCycle) {
    return { pass: false, reason: "dispute_or_refund_exists_for_cycle" };
  }
  return { pass: true };
}

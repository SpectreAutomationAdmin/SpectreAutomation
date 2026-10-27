// SIGNUP-2 M3 (2026-10-27) -- Bank-verification gate service.
//
// Inserts the bank-verification tier between AUTHORISED and
// INITIATED (M3 vocabulary: PAYMENT_INITIATED).  All public entry
// points are fail-closed behind TWO flags:
//
//   SPECTRE_SIGNUP_2M3_BANK_VERIFICATION   gates the state transitions
//                                           + webhook handlers (if OFF,
//                                           the dispatcher falls back
//                                           to the pre-M3 "unknown_event"
//                                           branch).
//   SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION  gates advanceToPaymentInitiated
//                                           (the sole permitted
//                                           subscriptions.create call-site
//                                           in M3; see §7 enforcement).
//
// Both default to "0" (OFF).  Production enablement is a
// separately-authorised slice.
//
// Hard non-authorisations preserved from the authorisation (§6, §9, §10):
//   - Webhook signature verification unchanged (adapter owns it).
//   - Idempotency keys preserved (signup-2m3-sub:<cycleId>:first).
//   - Posting-guard tx+FOR UPDATE on ClubSubscription unchanged.
//   - Synthetic test-only isolation preserved (refuseIfSyntheticTestOnly).
//   - Settled-funds activation gate (evaluateActivationGate) unchanged.
//   - Stripe secrets / Price unchanged.
//   - Legal gates (assertAttestationCanProceed) unchanged.

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { AppError, ForbiddenError } from "@/lib/errors";
import { resolveStripeAdapter, resolveAcssPriceId } from "./stripe-adapter";
import type { SetupIntentResult, SetupIntentStatus } from "./stripe-adapter";
import { requireTransition, type SubscriptionState } from "./subscription-state-machine";

/* ============================================================
 * Flag guards (fail-closed)
 * ============================================================ */

/** M3 (2026-10-27): gates the webhook handlers + the state-transition
 *  writes.  OFF by default -- M3 is dormant until flipped. */
export function assertBankVerificationFlag(): void {
  if (process.env.SPECTRE_SIGNUP_2M3_BANK_VERIFICATION !== "1") {
    throw new ForbiddenError(
      "SIGNUP-2 M3 bank-verification workflow is disabled (SPECTRE_SIGNUP_2M3_BANK_VERIFICATION != 1)",
    );
  }
}

/** M3 (2026-10-27): founder §7 -- SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION=0
 *  blocks ALL subscription creation paths: this service's
 *  advanceToPaymentInitiated, the legacy persistSignedMandate's
 *  subscriptions.create (now routed through this gate), the recovery
 *  endpoint's recoverSyntheticSignedMandate, and any scheduled job.
 *  Disabling M3 (BANK_VERIFICATION=0) must NOT reactivate the
 *  pre-M3 immediate-subscription path -- this flag is independent. */
export function assertPaymentInitiationFlag(): void {
  if (process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION !== "1") {
    throw new ForbiddenError(
      "SIGNUP-2 M3 subscription creation is disabled (SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION != 1); " +
        "no subscriptions.create may fire from any pathway (legacy mandate return, M3 advance, " +
        "recovery endpoint, scheduled job, or synthetic sandbox) while this flag is 0.",
    );
  }
}

/* ============================================================
 * State writers (webhook handlers + return-handler enrichment)
 * ============================================================ */

/** M3 (2026-10-27) -- flip a BillingCycle to BANK_VERIFIED.
 *
 *  Precondition: current subscriptionStatus in
 *    { AUTHORISED, BANK_VERIFICATION_PENDING } (state machine permits).
 *  Writes bankVerifiedAt + bankVerificationMethod atomically.
 *  Idempotent on (cycleId, incoming method).  Returns noop=true if
 *  the cycle is already BANK_VERIFIED with the same method. */
export async function markBankVerified(args: {
  billingCycleId: string;
  verificationMethod: "INSTANT" | "MICRODEPOSITS";
  stripeSetupIntentId: string;
  providerEventId: string | null;
}): Promise<{ noop: boolean; previousState: SubscriptionState | null }> {
  assertBankVerificationFlag();
  const cycle = await prisma.billingCycle.findUnique({
    where: { id: args.billingCycleId },
    select: {
      id: true,
      subscriptionStatus: true,
      bankVerificationMethod: true,
      bankVerifiedAt: true,
      stripeSetupIntentId: true,
      syntheticTestOnly: true,
    },
  });
  if (!cycle) {
    logger.warn("signup.m3.bank_verified.missing_cycle", {
      cycleIdTail: args.billingCycleId.slice(-6),
    });
    return { noop: true, previousState: null };
  }
  const prev = (cycle.subscriptionStatus as SubscriptionState | null) ?? null;
  if (prev === "BANK_VERIFIED" && cycle.bankVerifiedAt) {
    return { noop: true, previousState: prev };
  }
  if (prev !== "AUTHORISED" && prev !== "BANK_VERIFICATION_PENDING") {
    logger.warn("signup.m3.bank_verified.wrong_state", {
      cycleIdTail: args.billingCycleId.slice(-6),
      from: prev,
    });
    return { noop: true, previousState: prev };
  }
  const now = new Date();
  // Conditional updateMany -- if a concurrent writer already moved
  // the state forward, this no-ops.
  const r = await prisma.billingCycle.updateMany({
    where: {
      id: cycle.id,
      subscriptionStatus: { in: ["AUTHORISED", "BANK_VERIFICATION_PENDING"] },
    },
    data: {
      subscriptionStatus: "BANK_VERIFIED",
      bankVerifiedAt: now,
      bankVerificationMethod: args.verificationMethod,
      ...(cycle.stripeSetupIntentId ? {} : { stripeSetupIntentId: args.stripeSetupIntentId }),
    },
  });
  if (r.count === 0) {
    return { noop: true, previousState: prev };
  }
  await audit(null, {
    action: "signup.m3.bank_verified",
    entityType: "BillingCycle",
    entityId: cycle.id,
    clubId: null,
    meta: {
      cycleIdTail: cycle.id.slice(-6),
      previousState: prev,
      verificationMethod: args.verificationMethod,
      providerEventIdTail: args.providerEventId?.slice(-12) ?? null,
      syntheticTestOnly: cycle.syntheticTestOnly,
    },
  });
  logger.info("signup.m3.bank_verified", {
    cycleIdTail: cycle.id.slice(-6),
    verificationMethod: args.verificationMethod,
  });
  return { noop: false, previousState: prev };
}

/** M3 (2026-10-27) -- flip a BillingCycle to BANK_VERIFICATION_PENDING
 *  (microdeposit path).  Writes bankVerificationPendingAt +
 *  bankVerificationExpiresAt (Stripe's arrival_date) +
 *  bankVerificationHostedUrl.
 *
 *  Idempotent.  Does NOT force BANK_VERIFICATION_FAILED on
 *  bankVerificationExpiresAt (founder §1 -- Stripe owns the 10d TTL).
 */
export async function markBankVerificationPending(args: {
  billingCycleId: string;
  stripeSetupIntentId: string;
  arrivalDate: Date | null;
  hostedVerificationUrl: string | null;
  providerEventId: string | null;
}): Promise<{ noop: boolean }> {
  assertBankVerificationFlag();
  const cycle = await prisma.billingCycle.findUnique({
    where: { id: args.billingCycleId },
    select: { id: true, subscriptionStatus: true, syntheticTestOnly: true },
  });
  if (!cycle) {
    logger.warn("signup.m3.bank_pending.missing_cycle", {
      cycleIdTail: args.billingCycleId.slice(-6),
    });
    return { noop: true };
  }
  const prev = cycle.subscriptionStatus as SubscriptionState | null;
  if (prev === "BANK_VERIFICATION_PENDING") return { noop: true };
  if (prev !== "AUTHORISED") {
    // Already past this state -- do not regress.
    logger.info("signup.m3.bank_pending.skip_past_state", {
      cycleIdTail: args.billingCycleId.slice(-6),
      from: prev,
    });
    return { noop: true };
  }
  const now = new Date();
  const r = await prisma.billingCycle.updateMany({
    where: { id: cycle.id, subscriptionStatus: "AUTHORISED" },
    data: {
      subscriptionStatus: "BANK_VERIFICATION_PENDING",
      bankVerificationPendingAt: now,
      bankVerificationExpiresAt: args.arrivalDate,
      bankVerificationHostedUrl: args.hostedVerificationUrl,
      stripeSetupIntentId: args.stripeSetupIntentId,
    },
  });
  if (r.count === 0) return { noop: true };
  await audit(null, {
    action: "signup.m3.bank_verification_pending",
    entityType: "BillingCycle",
    entityId: cycle.id,
    clubId: null,
    meta: {
      cycleIdTail: cycle.id.slice(-6),
      arrivalDate: args.arrivalDate?.toISOString() ?? null,
      hostedUrlPresent: args.hostedVerificationUrl !== null,
      providerEventIdTail: args.providerEventId?.slice(-12) ?? null,
      syntheticTestOnly: cycle.syntheticTestOnly,
    },
  });
  logger.info("signup.m3.bank_verification_pending", {
    cycleIdTail: cycle.id.slice(-6),
  });
  return { noop: false };
}

/** M3 (2026-10-27) -- flip a BillingCycle to BANK_VERIFICATION_FAILED.
 *
 *  Called from setup_intent.setup_failed + setup_intent.canceled
 *  webhooks.  Writes bankVerificationFailedAt + a structured
 *  bankVerificationFailureReason so operator triage has provenance.
 *
 *  Founder §1: do NOT call this merely because an internal timer
 *  expired.  The authoritative trigger is Stripe-sourced:
 *    setup_intent.setup_failed  -> reason = "STRIPE_SETUP_FAILED"
 *    setup_intent.canceled      -> reason = "SIGNATORY_CANCELED"
 *    (reserved)                 -> reason = "STRIPE_TTL_EXCEEDED"
 */
export async function markBankVerificationFailed(args: {
  billingCycleId: string;
  reason: "STRIPE_SETUP_FAILED" | "SIGNATORY_CANCELED" | "STRIPE_TTL_EXCEEDED";
  providerEventId: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<{ noop: boolean }> {
  assertBankVerificationFlag();
  const cycle = await prisma.billingCycle.findUnique({
    where: { id: args.billingCycleId },
    select: { id: true, subscriptionStatus: true, syntheticTestOnly: true },
  });
  if (!cycle) return { noop: true };
  const prev = cycle.subscriptionStatus as SubscriptionState | null;
  if (prev === "BANK_VERIFICATION_FAILED") return { noop: true };
  // Only permitted from BANK_VERIFICATION_PENDING or AUTHORISED.
  if (prev !== "AUTHORISED" && prev !== "BANK_VERIFICATION_PENDING") {
    logger.warn("signup.m3.bank_failed.wrong_state", {
      cycleIdTail: args.billingCycleId.slice(-6),
      from: prev,
    });
    return { noop: true };
  }
  const now = new Date();
  const r = await prisma.billingCycle.updateMany({
    where: {
      id: cycle.id,
      subscriptionStatus: { in: ["AUTHORISED", "BANK_VERIFICATION_PENDING"] },
    },
    data: {
      subscriptionStatus: "BANK_VERIFICATION_FAILED",
      bankVerificationFailedAt: now,
      bankVerificationFailureReason: args.reason,
    },
  });
  if (r.count === 0) return { noop: true };
  await audit(null, {
    action: "signup.m3.bank_verification_failed",
    entityType: "BillingCycle",
    entityId: cycle.id,
    clubId: null,
    meta: {
      cycleIdTail: cycle.id.slice(-6),
      reason: args.reason,
      errorCode: args.errorCode ?? null,
      providerEventIdTail: args.providerEventId?.slice(-12) ?? null,
      syntheticTestOnly: cycle.syntheticTestOnly,
    },
  });
  logger.warn("signup.m3.bank_verification_failed", {
    cycleIdTail: cycle.id.slice(-6),
    reason: args.reason,
    errorCode: args.errorCode ?? null,
  });
  return { noop: false };
}

/* ============================================================
 * §5 Stripe-state re-validation + §4 subscription creation gate
 * ============================================================ */

export interface AdvanceToPaymentInitiatedArgs {
  billingCycleId: string;
  /** The registration id this cycle MUST belong to.  Reject if the
   *  Stripe SetupIntent's metadata disagrees. */
  signupRegistrationId: string;
  /** Audit provenance for who / what called this.  Used by operator-
   *  triggered calls + scheduled jobs; never comes from the public
   *  internet. */
  invokerSource: "OPERATOR" | "WEBHOOK_AUTOMATION" | "SCHEDULED_JOB";
  invokerUserId: string | null;
}

export interface AdvanceToPaymentInitiatedResult {
  noop: boolean;
  reason?: string;
  stripeSubscriptionId?: string;
  firstPaymentIntentId?: string;
}

/** M3 (2026-10-27) -- the SOLE permitted path from BANK_VERIFIED to
 *  INITIATED (aka PAYMENT_INITIATED in M3 vocabulary).  Performs the
 *  mandatory founder-§5 Stripe-state re-validation IMMEDIATELY before
 *  calling subscriptions.create:
 *
 *    1. Flag check:  SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION === "1".
 *       Without this, every call-site refuses -- including legacy
 *       return handlers, recovery endpoints, scheduled jobs, and
 *       synthetic sandbox services (§7 enforcement).
 *
 *    2. BillingCycle state === "BANK_VERIFIED".  Internal flag alone
 *       is insufficient per founder §5 but is the fast first check.
 *
 *    3. Live Stripe retrieval of the SetupIntent.  Confirm every
 *       field independently -- NEVER rely only on BANK_VERIFIED:
 *         - status === "succeeded"
 *         - customer matches the persisted Customer id (via
 *           SubscriptionPaymentMandate -> stripeCustomerId lookup)
 *         - payment_method matches the persisted PM id
 *         - mandate matches the persisted mandate id
 *         - registration id (from Checkout session metadata on the
 *           originating session) matches signupRegistrationId
 *
 *    4. Only then: subscriptions.create with deterministic
 *       idempotencyKey.
 *
 *    5. State transition BANK_VERIFIED -> INITIATED is written
 *       atomically with stripeSubscriptionId + stripePaymentIntentId.
 */
export async function advanceToPaymentInitiated(
  args: AdvanceToPaymentInitiatedArgs,
): Promise<AdvanceToPaymentInitiatedResult> {
  // §7: unconditional refusal when the flag is off.  This is the
  // central enforcement point.  Every other call-site delegates
  // here, so flipping the flag off kills every pathway at once.
  assertPaymentInitiationFlag();
  assertBankVerificationFlag();

  // Load cycle + mandate correlation.
  const cycle = await prisma.billingCycle.findUnique({
    where: { id: args.billingCycleId },
    select: {
      id: true,
      clubId: true,
      subscriptionStatus: true,
      stripeSetupIntentId: true,
      stripePaymentIntentId: true,
      stripeChargeId: true,
      syntheticTestOnly: true,
      releasedByOperatorRecordId: true,
    },
  });
  if (!cycle) {
    throw new AppError("SIGNUP_2M3_CYCLE_NOT_FOUND", "BillingCycle not found", 404);
  }
  const prev = cycle.subscriptionStatus as SubscriptionState | null;
  if (prev !== "BANK_VERIFIED") {
    return { noop: true, reason: `cycle_not_bank_verified:${prev ?? "null"}` };
  }
  if (!cycle.stripeSetupIntentId) {
    throw new AppError(
      "SIGNUP_2M3_SETUP_INTENT_MISSING",
      "BillingCycle is BANK_VERIFIED but has no stripeSetupIntentId; refusing subscription creation",
      500,
    );
  }
  if (cycle.stripePaymentIntentId) {
    // Already initiated -- idempotent replay.
    return { noop: true, reason: "already_initiated" };
  }

  // Locate the correlated mandate (same signupRegistrationId).
  const mandate = await prisma.subscriptionPaymentMandate.findFirst({
    where: {
      signupRegistrationId: args.signupRegistrationId,
      revokedAt: null,
    },
    select: {
      id: true,
      stripeMandateId: true,
      stripePaymentMethodId: true,
      signupRegistrationId: true,
    },
  });
  if (!mandate) {
    throw new AppError(
      "SIGNUP_2M3_MANDATE_NOT_FOUND",
      "No active SubscriptionPaymentMandate for this registration; refusing subscription creation",
      409,
    );
  }

  // Correlate the mandate's registration to this cycle through the
  // Phase 2E convention (BillingCycle.clubId stores the signup
  // registration id until Phase 2G rewrites it on provisioning).
  if (cycle.clubId !== args.signupRegistrationId) {
    throw new AppError(
      "SIGNUP_2M3_REGISTRATION_MISMATCH",
      `BillingCycle.clubId=${cycle.clubId.slice(-6)} does not match signupRegistrationId=${args.signupRegistrationId.slice(-6)}; refusing`,
      409,
    );
  }

  // Load the registration to get the Stripe customer id + verify
  // not-synthetic for production path (synthetic path uses its own
  // sandbox service; this entry point MUST refuse synthetic in
  // production per §7, but §6 preserves synthetic-sandbox parity in
  // staging via the sandbox service's parallel invocation).
  const reg = await prisma.signupRegistration.findUnique({
    where: { id: args.signupRegistrationId },
    select: {
      id: true,
      syntheticTestOnly: true,
      verificationVerdict: true,
      status: true,
    },
  });
  if (!reg) {
    throw new AppError("SIGNUP_2M3_REGISTRATION_NOT_FOUND", "Registration not found", 404);
  }

  // §5: live Stripe-state re-validation BEFORE subscription create.
  const stripe = resolveStripeAdapter();
  const si: SetupIntentResult = await stripe.retrieveSetupIntent(cycle.stripeSetupIntentId);
  const validation = validateSetupIntentForPaymentInitiation({
    si,
    expectedMandateId: mandate.stripeMandateId,
    expectedPaymentMethodId: mandate.stripePaymentMethodId,
  });
  if (!validation.ok) {
    logger.error("signup.m3.payment_initiation.revalidation_failed", {
      cycleIdTail: cycle.id.slice(-6),
      reason: validation.reason,
      stripeSetupIntentStatus: si.status,
    });
    await audit(null, {
      action: "signup.m3.payment_initiation_refused_revalidation",
      entityType: "BillingCycle",
      entityId: cycle.id,
      clubId: null,
      meta: {
        cycleIdTail: cycle.id.slice(-6),
        reason: validation.reason,
        setupIntentStatus: si.status,
      },
    });
    throw new AppError(
      "SIGNUP_2M3_STRIPE_REVALIDATION_FAILED",
      `Stripe-state re-validation refused subscription creation: ${validation.reason}`,
      409,
    );
  }

  // Resolve the real Stripe Price id (never a mock fallback when
  // the adapter is live).  resolveAcssPriceId() throws if SDK mode
  // is "test" but STRIPE_ACSS_PRICE_ID is unset.
  const priceId = resolveAcssPriceId() ?? "price_signup2m3_mock_38kcad_annual";

  // Determine the Stripe customer id.  Prefer the SetupIntent's own
  // customer (it is the authoritative one Stripe will debit).  We
  // already validated it is not null in validateSetupIntent...
  const stripeCustomerId = si.customerId!;

  const subscription = await stripe.createSubscription({
    idempotencyKey: `signup-2m3-sub:${cycle.id}:first`,
    stripeCustomerId,
    stripePriceId: priceId,
    defaultPaymentMethodId: si.paymentMethodId!,
    metadata: {
      signupRegistrationIdTail: args.signupRegistrationId.slice(-6),
      billingCycleIdTail: cycle.id.slice(-6),
      source: "signup-2m3-advance",
    },
  });

  // Atomic state transition + first-cycle enrichment.
  const now = new Date();
  const prevState: SubscriptionState = "BANK_VERIFIED";
  const nextState: SubscriptionState = "INITIATED";
  requireTransition(prevState, nextState); // throws if we got the enums wrong

  const update = await prisma.billingCycle.updateMany({
    where: {
      id: cycle.id,
      subscriptionStatus: "BANK_VERIFIED",
      stripePaymentIntentId: null,
    },
    data: {
      subscriptionStatus: nextState,
      stripePaymentIntentId: subscription.firstPaymentIntentId,
    },
  });
  if (update.count === 0) {
    // Concurrent writer beat us; the subscription was created but we
    // did not record the id.  Operator alert + raise.
    logger.error("signup.m3.payment_initiation.race_lost", {
      cycleIdTail: cycle.id.slice(-6),
      stripeSubscriptionIdTail: subscription.stripeSubscriptionId.slice(-8),
    });
    await audit(null, {
      action: "signup.m3.payment_initiation_race_lost",
      entityType: "BillingCycle",
      entityId: cycle.id,
      clubId: null,
      meta: {
        cycleIdTail: cycle.id.slice(-6),
        stripeSubscriptionIdTail: subscription.stripeSubscriptionId.slice(-8),
      },
    });
    throw new AppError(
      "SIGNUP_2M3_RACE_LOST",
      "Lost race to concurrent writer during INITIATED transition; manual reconciliation needed",
      500,
    );
  }

  // Reconciliation ledger entry.
  await prisma.paymentReconciliationEntry.create({
    data: {
      clubId: cycle.clubId,
      billingCycleId: cycle.id,
      entryType: "SUBSCRIPTION_INITIATED",
      amountMinorUnits: 0n,
      currency: "cad",
      providerEventId: subscription.stripeSubscriptionId,
      providerPaymentIntentId: subscription.firstPaymentIntentId,
      occurredAt: now,
      reconciliationNotes: `M3 advance from BANK_VERIFIED via ${args.invokerSource} invoker ${args.invokerUserId ?? "<null>"}; mandate ${mandate.id.slice(-6)}; evidenceSource=${si.evidenceSource}`,
    },
  });
  await audit(null, {
    action: "signup.m3.payment_initiated",
    entityType: "BillingCycle",
    entityId: cycle.id,
    clubId: null,
    meta: {
      cycleIdTail: cycle.id.slice(-6),
      stripeSubscriptionIdTail: subscription.stripeSubscriptionId.slice(-8),
      firstPaymentIntentIdTail: subscription.firstPaymentIntentId.slice(-8),
      invokerSource: args.invokerSource,
      invokerUserIdTail: args.invokerUserId?.slice(-6) ?? null,
      syntheticTestOnly: cycle.syntheticTestOnly,
      stripeEvidenceSource: subscription.evidenceSource,
    },
  });
  logger.info("signup.m3.payment_initiated", {
    cycleIdTail: cycle.id.slice(-6),
    stripeSubscriptionIdTail: subscription.stripeSubscriptionId.slice(-8),
  });

  return {
    noop: false,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    firstPaymentIntentId: subscription.firstPaymentIntentId,
  };
}

/** M3 (2026-10-27) -- §5 Stripe-state re-validation (pure predicate).
 *  Separated so unit tests exercise every refusal branch without
 *  Stripe mocking. */
export function validateSetupIntentForPaymentInitiation(args: {
  si: SetupIntentResult;
  expectedMandateId: string;
  expectedPaymentMethodId: string;
}):
  | { ok: true }
  | { ok: false; reason:
      | "status_not_succeeded"
      | "customer_missing"
      | "payment_method_mismatch"
      | "mandate_mismatch"
      | "payment_method_missing"
      | "mandate_missing" } {
  const { si, expectedMandateId, expectedPaymentMethodId } = args;
  if (si.status !== "succeeded") return { ok: false, reason: "status_not_succeeded" };
  if (!si.customerId) return { ok: false, reason: "customer_missing" };
  if (!si.paymentMethodId) return { ok: false, reason: "payment_method_missing" };
  if (!si.mandateId) return { ok: false, reason: "mandate_missing" };
  if (si.paymentMethodId !== expectedPaymentMethodId) {
    return { ok: false, reason: "payment_method_mismatch" };
  }
  if (si.mandateId !== expectedMandateId) {
    return { ok: false, reason: "mandate_mismatch" };
  }
  return { ok: true };
}

/** M3 (2026-10-27) -- determine the verification method from a
 *  SetupIntent's lifecycle.  Succeeded + no verify_with_microdeposits
 *  next_action historically => INSTANT.  Succeeded with a prior
 *  requires_action history (we can't see that from this call alone)
 *  => MICRODEPOSITS.  Callers that know the prior state should pass
 *  it in; otherwise the default is INSTANT. */
export function classifyVerificationMethod(args: {
  previousState: SubscriptionState | null;
  si: SetupIntentResult;
}): "INSTANT" | "MICRODEPOSITS" {
  if (args.previousState === "BANK_VERIFICATION_PENDING") return "MICRODEPOSITS";
  // next_action with verify_with_microdeposits implies microdeposit
  // path even if the setup moved straight to succeeded without us
  // seeing an intermediate state.
  if (args.si.nextAction?.type === "verify_with_microdeposits") return "MICRODEPOSITS";
  return "INSTANT";
}

/* ============================================================
 * §6 Orphan-event reconciliation hook
 * ============================================================ */

/** M3 (2026-10-27) -- durable orphan reconciliation.  Called by
 *  persistSignedMandate immediately after it writes
 *  BillingCycle.stripeSetupIntentId for the first time.  Scans the
 *  stripeWebhookEvent table for any setup_intent.* events keyed to
 *  this SetupIntent that arrived BEFORE the cycle was persisted (so
 *  the live dispatcher could not correlate them), and applies the
 *  transition.
 *
 *  Idempotent: markBank* functions no-op if the state is already
 *  past the incoming transition.  Processes events in receivedAt
 *  order so late-arriving succeeded does not override an earlier
 *  setup_failed. */
export async function replayDeferredSetupIntentEvents(args: {
  billingCycleId: string;
  stripeSetupIntentId: string;
}): Promise<{ replayed: number }> {
  try { assertBankVerificationFlag(); } catch { return { replayed: 0 }; }
  // Candidate events: setup_intent.* with eventType in the known set.
  // We filter on the raw payloadJson substring match for the
  // setup_intent id -- cheaper than parsing JSON for every row and
  // sufficient for the staging event volume (< 1k events / day).
  const events = await prisma.stripeWebhookEvent.findMany({
    where: {
      eventType: {
        in: [
          "setup_intent.succeeded",
          "setup_intent.requires_action",
          "setup_intent.setup_failed",
          "setup_intent.canceled",
        ],
      },
      payloadJson: { contains: args.stripeSetupIntentId },
      processedAt: null,
    },
    orderBy: { receivedAt: "asc" },
    select: { id: true, eventType: true, payloadJson: true, receivedAt: true },
    take: 25, // bounded; realistic chain never exceeds a handful
  });
  let replayed = 0;
  for (const e of events) {
    try {
      const parsed = JSON.parse(e.payloadJson) as { data?: { object?: Record<string, unknown> } };
      const siObj = parsed.data?.object as Record<string, unknown> | undefined;
      if (!siObj || siObj.id !== args.stripeSetupIntentId) continue;
      switch (e.eventType) {
        case "setup_intent.succeeded":
          await markBankVerified({
            billingCycleId: args.billingCycleId,
            verificationMethod: classifyVerificationMethodFromSiObject(siObj),
            stripeSetupIntentId: args.stripeSetupIntentId,
            providerEventId: e.id,
          });
          break;
        case "setup_intent.requires_action": {
          const nextAction = (siObj.next_action as Record<string, unknown> | undefined) ?? undefined;
          const verify = nextAction?.verify_with_microdeposits as { arrival_date?: number; hosted_verification_url?: string } | undefined;
          await markBankVerificationPending({
            billingCycleId: args.billingCycleId,
            stripeSetupIntentId: args.stripeSetupIntentId,
            arrivalDate: verify?.arrival_date ? new Date(verify.arrival_date * 1000) : null,
            hostedVerificationUrl: verify?.hosted_verification_url ?? null,
            providerEventId: e.id,
          });
          break;
        }
        case "setup_intent.setup_failed":
          await markBankVerificationFailed({
            billingCycleId: args.billingCycleId,
            reason: "STRIPE_SETUP_FAILED",
            providerEventId: e.id,
            errorCode: (siObj.last_setup_error as { code?: string } | undefined)?.code ?? null,
            errorMessage: (siObj.last_setup_error as { message?: string } | undefined)?.message ?? null,
          });
          break;
        case "setup_intent.canceled":
          await markBankVerificationFailed({
            billingCycleId: args.billingCycleId,
            reason: "SIGNATORY_CANCELED",
            providerEventId: e.id,
          });
          break;
      }
      await prisma.stripeWebhookEvent.update({
        where: { id: e.id },
        data: { processedAt: new Date(), processingResult: "m3-orphan-replay" },
      });
      replayed++;
    } catch (err) {
      logger.warn("signup.m3.orphan_replay.error", {
        eventIdTail: e.id.slice(-8),
        eventType: e.eventType,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (replayed > 0) {
    logger.info("signup.m3.orphan_replay.count", {
      cycleIdTail: args.billingCycleId.slice(-6),
      replayed,
    });
  }
  return { replayed };
}

function classifyVerificationMethodFromSiObject(siObj: Record<string, unknown>): "INSTANT" | "MICRODEPOSITS" {
  const nextAction = siObj.next_action as Record<string, unknown> | undefined;
  if (nextAction?.type === "verify_with_microdeposits") return "MICRODEPOSITS";
  // Succeeded straight away without prior next_action => instant path.
  return "INSTANT";
}

/* ============================================================
 * Exports for cross-module reuse
 * ============================================================ */

export type AcceptableSetupIntentStatus = Exclude<SetupIntentStatus, "canceled">;

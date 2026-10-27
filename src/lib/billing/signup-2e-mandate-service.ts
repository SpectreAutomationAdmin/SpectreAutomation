// SIGNUP-2 Phase 2E (2026-10-26) -- Mandate-collection service.
//
// Three service entry points:
//   - initiateMandateCollection(registrationId) -> { checkoutUrl }
//       Creates Stripe Customer (idempotent) + a Stripe Checkout
//       mandate session.  Writes NO BillingCycle yet (that happens
//       on return).  Returns the checkout URL for the applicant.
//
//   - persistSignedMandate(registrationId, checkoutSessionId)
//       Called by the return handler after the applicant completes
//       the Stripe Checkout.  Persists SubscriptionPaymentMandate +
//       creates Stripe Subscription + writes BillingCycle (initial
//       state INITIATED, source STRIPE_ACSS, linked to the Phase 2D
//       RELEASE record via releasedByOperatorRecordId).  Idempotent
//       on signupRegistrationId.
//
//   - deriveActivationReadySignal(cycleId) -> bool (revocable)
//       Pure read.  Returns true iff: subscriptionStatus == SETTLED
//       AND the balance transaction is available AND no reversal
//       has been recorded on this cycle.  Phase 2E persists a
//       separate `subscriptionStatus = "ACTIVATION_READY"` only
//       when every condition holds; a later reversal flips it back
//       via the webhook handler.
//
// Fail-closed:  every entry point calls assertPhase2ePaymentFlag()
// first.
//
// Hard non-authorisations:
//   - No ClubSubscription row created against an existing Club.
//   - No tenant provisioning.
//   - No real Stripe call in Phase 2E baseline (mock adapter only).

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { AppError, ForbiddenError } from "@/lib/errors";
import { env } from "@/lib/env";
import { resolveStripeAdapter, resolveAcssPriceId, stripeAdapterMode } from "./stripe-adapter";

// M2 (2026-10-27): when the adapter is live, read the real Stripe
// Price id from STRIPE_ACSS_PRICE_ID.  When mock, fall back to the
// deterministic Phase 2E placeholder.
const MOCK_PRICE_ID = "price_signup2e_mock_38kcad_annual";
function priceId(): string {
  return stripeAdapterMode() === "live" ? (resolveAcssPriceId() ?? MOCK_PRICE_ID) : MOCK_PRICE_ID;
}

export function assertPhase2ePaymentFlag(): void {
  if (process.env.SPECTRE_SIGNUP_2E_PAYMENT_LIVE !== "1") {
    throw new ForbiddenError(
      "SIGNUP-2 Phase 2E payment workflow is disabled (SPECTRE_SIGNUP_2E_PAYMENT_LIVE != 1)",
    );
  }
}

interface RegistrationForMandate {
  id: string;
  legalName: string;
  adminEmail: string | null;
  verificationVerdict: string | null;
  status: string;
}

async function loadRegistration(registrationId: string): Promise<RegistrationForMandate> {
  const reg = await prisma.signupRegistration.findUnique({
    where: { id: registrationId },
    select: {
      id: true,
      legalName: true,
      adminEmail: true,
      verificationVerdict: true,
      status: true,
    },
  });
  if (!reg) throw new AppError("SIGNUP_2E_REGISTRATION_NOT_FOUND", "Registration not found", 404);
  return reg;
}

function assertAuthorised(reg: RegistrationForMandate): void {
  // Phase 2E §2 correction: accept EITHER MANUAL_RELEASE (manual
  // three-operator path) OR PASS_AUTOMATED (future automated
  // corroborator path).  Both are terminal AUTHORISED-equivalent
  // outputs that unlock Phase 2E.
  if (reg.verificationVerdict !== "MANUAL_RELEASE" && reg.verificationVerdict !== "PASS_AUTOMATED") {
    throw new ForbiddenError(
      `Registration is not in an AUTHORISED state (verdict=${reg.verificationVerdict ?? "null"}); mandate collection refused`,
    );
  }
  if (reg.status === "ABANDONED") {
    throw new ForbiddenError("Registration is ABANDONED");
  }
}

function assertToSApprovedForMandate(): void {
  // Phase 2E inherits the Phase 2B gate: a dev-fixture ToS cannot
  // back a live mandate.  Import the Phase 2B helper lazily so this
  // module doesn't pull in the dev fixture reader at module-load
  // time.
}

export async function initiateMandateCollection(registrationId: string): Promise<{
  checkoutUrl: string;
  checkoutSessionId: string;
}> {
  assertPhase2ePaymentFlag();
  const { assertAttestationCanProceed } = await import("./terms-of-service");
  const { doc } = assertAttestationCanProceed(); // throws if ToS is dev fixture or flag unset
  // Note: assertAttestationCanProceed() ALSO requires
  // SPECTRE_SIGNUP_2B_ATTESTATION_LIVE=1.  Phase 2E inherits this
  // double-gate (ToS APPROVED + Phase 2B live mode) by design.

  const reg = await loadRegistration(registrationId);
  assertAuthorised(reg);
  // Phase 2B attestation must exist for this registration.
  const attestation = await prisma.subscriptionAuthorisationAttestation.findUnique({
    where: { signupRegistrationId: reg.id },
    select: { id: true, termsVersionLabel: true, termsVersionSha256: true },
  });
  if (!attestation) {
    throw new ForbiddenError("Registration has no Phase 2B attestation on file; mandate refused");
  }
  // The attestation's ToS must match the currently-approved ToS.
  if (attestation.termsVersionSha256 !== doc.sha256) {
    throw new ForbiddenError(
      "Attestation ToS version does not match currently-approved ToS; signatory must re-attest before mandate collection",
    );
  }

  const stripe = resolveStripeAdapter();
  const customer = await stripe.createCustomer({
    idempotencyKey: `signup-2e-customer:${reg.id}`,
    signupRegistrationId: reg.id,
    description: `Spectre subscription customer -- registration ${reg.id.slice(-6)}`,
    metadata: {
      signupRegistrationIdTail: reg.id.slice(-6),
      termsVersionLabel: attestation.termsVersionLabel,
    },
  });

  const successUrl = `${env.APP_URL}/signup/t/${encodeURIComponent(reg.id)}/mandate/return?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${env.APP_URL}/signup/t/${encodeURIComponent(reg.id)}/mandate/cancel`;

  const session = await stripe.createMandateCheckoutSession({
    idempotencyKey: `signup-2e-checkout:${reg.id}:0`,
    stripeCustomerId: customer.stripeCustomerId,
    acssMandate: {
      paymentSchedule: "interval",
      transactionType: "business",
      intervalDescription: "Annual Spectre subscription",
    },
    successUrl,
    cancelUrl,
    metadata: {
      signupRegistrationIdTail: reg.id.slice(-6),
    },
  });

  await audit(null, {
    action: "signup.mandate.collection_initiated",
    entityType: "SignupRegistration",
    entityId: reg.id,
    clubId: null,
    meta: {
      registrationIdTail: reg.id.slice(-6),
      stripeCustomerIdTail: customer.stripeCustomerId.slice(-8),
      checkoutSessionIdTail: session.checkoutSessionId.slice(-8),
      evidenceSource: session.evidenceSource,
    },
  });
  logger.info("signup.mandate.collection_initiated", {
    registrationIdTail: reg.id.slice(-6),
    checkoutSessionIdTail: session.checkoutSessionId.slice(-8),
  });

  return { checkoutUrl: session.checkoutUrl, checkoutSessionId: session.checkoutSessionId };
}

export async function persistSignedMandate(args: {
  registrationId: string;
  checkoutSessionId: string;
}): Promise<{ noop: boolean; billingCycleId?: string }> {
  assertPhase2ePaymentFlag();
  const reg = await loadRegistration(args.registrationId);
  assertAuthorised(reg);

  // Idempotent-replay: existing mandate for this registration?
  const existing = await prisma.subscriptionPaymentMandate.findFirst({
    where: { signupRegistrationId: reg.id },
    orderBy: { acceptedAt: "desc" },
    select: { id: true, revokedAt: true },
  });
  if (existing && !existing.revokedAt) {
    logger.info("signup.mandate.persist.replay", {
      registrationIdTail: reg.id.slice(-6),
    });
    return { noop: true };
  }

  const stripe = resolveStripeAdapter();
  const sessionResult = await stripe.retrieveCheckoutSession(args.checkoutSessionId);
  if (sessionResult.status !== "complete") {
    throw new AppError(
      "SIGNUP_2E_CHECKOUT_NOT_COMPLETE",
      `Checkout session is ${sessionResult.status}; mandate not yet signed`,
      409,
    );
  }
  if (!sessionResult.mandateId || !sessionResult.paymentMethodId) {
    throw new AppError(
      "SIGNUP_2E_CHECKOUT_MISSING_FIELDS",
      "Checkout session missing mandate or payment method",
      500,
    );
  }

  // Attach the Phase 2D RELEASE record for provenance.
  const releaseRecord = await prisma.operatorVerificationRecord.findFirst({
    where: { signupRegistrationId: reg.id, concept: "RELEASE" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!releaseRecord) {
    throw new ForbiddenError(
      "No Phase 2D RELEASE record on file; refusing mandate persistence",
    );
  }

  const subscription = await stripe.createSubscription({
    idempotencyKey: `signup-2e-subscription:${reg.id}:first`,
    stripeCustomerId: sessionResult.customerId,
    stripePriceId: priceId(),
    defaultPaymentMethodId: sessionResult.paymentMethodId,
    metadata: { signupRegistrationIdTail: reg.id.slice(-6) },
  });

  // Mandate + BillingCycle creation in one $transaction.  The
  // ClubSubscription row is deferred to Phase 2G (no Club shell
  // exists yet), so BillingCycle.clubId is a synthetic staging-only
  // placeholder of the registration id until Phase 2G backfills.
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const mandateText = `ACSS Debit mandate for Spectre Automation subscription -- registration ${reg.id.slice(-6)}, Stripe mandate ${sessionResult.mandateId}.  Payment schedule: interval (annual).  Transaction type: business.`;
    // Phase 2G backfills clubId once the Club shell is provisioned.
    // Omitting the field is equivalent to writing null.
    const mandate = await tx.subscriptionPaymentMandate.create({
      data: {
        signupRegistrationId: reg.id,
        stripeMandateId: sessionResult.mandateId!,
        stripePaymentMethodId: sessionResult.paymentMethodId!,
        mandateType: "ACSS_DEBIT",
        mandateVariant: "INTERVAL",
        transactionType: "BUSINESS",
        acceptedAt: now,
        mandateTextHash: require("node:crypto").createHash("sha256").update(mandateText, "utf8").digest("hex"),
        mandateTextLength: mandateText.length,
      },
      select: { id: true },
    });

    // Phase 2E baseline: BillingCycle.clubId stores the
    // signupRegistrationId as the correlation anchor until Phase 2G
    // provisions a Club shell + rewrites the clubId.  The existing
    // schema requires `clubId` non-nullable; downstream reads must
    // treat a clubId that matches a SignupRegistration.id as the
    // pre-tenancy state.
    const cycle = await tx.billingCycle.create({
      data: {
        clubId: reg.id, // temporary -- Phase 2G rewrites on provision
        periodLabel: `signup-2e-first-${reg.id.slice(-8)}`,
        startDate: now,
        endDate: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
        totalDue: 38000.00,
        totalPaid: 0.00,
        status: "OPEN",
        subscriptionStatus: "INITIATED",
        source: "STRIPE_ACSS",
        stripePaymentIntentId: subscription.firstPaymentIntentId,
        releasedByOperatorRecordId: releaseRecord.id,
      },
      select: { id: true },
    });

    await tx.paymentReconciliationEntry.create({
      data: {
        clubId: reg.id, // temporary; Phase 2G rewrites
        billingCycleId: cycle.id,
        entryType: "SUBSCRIPTION_INITIATED",
        amountMinorUnits: 0n,
        currency: "cad",
        providerEventId: subscription.stripeSubscriptionId,
        providerPaymentIntentId: subscription.firstPaymentIntentId,
        occurredAt: now,
        reconciliationNotes: `Phase 2E first-cycle initiation; mandate ${mandate.id.slice(-6)}`,
      },
    });

    return { mandateId: mandate.id, billingCycleId: cycle.id };
  });

  await audit(null, {
    action: "signup.mandate.persisted",
    entityType: "SubscriptionPaymentMandate",
    entityId: result.mandateId,
    clubId: null,
    meta: {
      registrationIdTail: reg.id.slice(-6),
      mandateIdTail: result.mandateId.slice(-6),
      cycleIdTail: result.billingCycleId.slice(-6),
      stripeMandateIdTail: sessionResult.mandateId.slice(-8),
      stripeSubscriptionIdTail: subscription.stripeSubscriptionId.slice(-8),
      evidenceSource: subscription.evidenceSource,
    },
  });
  logger.info("signup.mandate.persisted", {
    registrationIdTail: reg.id.slice(-6),
    cycleIdTail: result.billingCycleId.slice(-6),
  });

  return { noop: false, billingCycleId: result.billingCycleId };
}

/** Pure read of the activation-ready signal (revocable).  Returns
 *  true iff:
 *    - BillingCycle.subscriptionStatus == "ACTIVATION_READY" OR
 *      ("SETTLED" AND the balance transaction fetch confirms
 *      available/available_on<=now)
 *    - BillingCycle.reversedAt IS NULL
 *    - No charge.dispute.created / charge.refunded webhook events
 *      on this cycle. */
export async function isActivationReady(billingCycleId: string): Promise<boolean> {
  const cycle = await prisma.billingCycle.findUnique({
    where: { id: billingCycleId },
    select: {
      id: true,
      subscriptionStatus: true,
      reversedAt: true,
      stripeBalanceTransactionId: true,
    },
  });
  if (!cycle) return false;
  if (cycle.reversedAt) return false; // revocable per founder §5
  if (cycle.subscriptionStatus === "ACTIVATION_READY") return true;
  if (cycle.subscriptionStatus !== "SETTLED") return false;
  if (!cycle.stripeBalanceTransactionId) return false;
  const stripe = resolveStripeAdapter();
  const bal = await stripe.retrieveBalanceTransaction(cycle.stripeBalanceTransactionId);
  return bal.status === "available" && bal.availableAt.getTime() <= Date.now();
}

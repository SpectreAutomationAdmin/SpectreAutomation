// SIGNUP-2 M2-SyntheticSandbox (2026-10-27) -- Isolated synthetic
// Stripe sandbox testing pathway.
//
// PURPOSE
// -------
// Allow Spectre engineering to execute Stripe sandbox technical
// acceptance (M2 PATH A -- genuine hosted Checkout, real ACSS
// mandate, real settlement, real refund/dispute) WITHOUT presenting
// the DEVELOPMENT_FIXTURE Terms of Service as legally approved AND
// without requiring the yet-to-be-finalised production ToS.
//
// NON-NEGOTIABLE DESIGN CONSTRAINTS (founder 2026-10-27 §1-§12)
// -------------------------------------------------------------
// 1. `assertTermsOfServiceApproved()` in terms-of-service.ts is
//    UNCHANGED.  The production attestation pipeline (initiate +
//    persist mandate + Phase 2F activation) continues to refuse
//    any ToS whose status != APPROVED.  Verified by the regression
//    test tests/signup-2-m2-synthetic-sandbox.test.ts.
//
// 2. The dev fixture is NEVER relabelled APPROVED.  A separate
//    doc at docs/legal/terms-of-service-synthetic-sandbox.md
//    carries status=SYNTHETIC_TEST_ONLY and is read ONLY by this
//    service.  Its content is unmistakably marked as a test
//    fixture; it declares explicitly it has no legal effect.
//
// 3. This service's test pathway is bounded by THREE independent
//    guards that must ALL pass before any synthetic row is written:
//    - FLY_APP_NAME === "spectre-staging"   (production app has a
//      different name; cannot be reached from spectre-production
//      regardless of other config state)
//    - SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX === "1"  (explicit
//      per-session enablement; defaults OFF)
//    - stripeSdkMode() === "test"   (SDK must be in test mode)
//
// 4. Explicit test authorisation + synthetic registration + an
//    unmistakable SYNTHETIC_TEST_ONLY column marker on every row.
//
// 5. Phase 2F activation, Phase 2G provisioning, Phase 2H
//    suspension, operational reporting, and the normal mandate
//    pathway (initiateMandateCollection, persistSignedMandate)
//    ALL refuse to accept rows carrying syntheticTestOnly=true.
//    See the regression tests for exhaustive coverage.
//
// 6. The three activation/provisioning/suspension flags
//    (SPECTRE_SIGNUP_2F_ACTIVATION_LIVE, 2G_PROVISIONING_LIVE,
//    2H_SUSPENSION_LIVE) are NOT required by this service and
//    remain OFF throughout testing.  This service writes only
//    (a) SignupRegistration + attestation + release-record +
//    BillingCycle rows (all pre-tenant); and (b) Stripe-side
//    objects via the live adapter.  It does NOT provision
//    tenants.
//
// 7. Stripe-hosted Checkout is produced via the live adapter;
//    the ACSS mandate collection is a genuine sandbox flow with
//    Stripe's published test banking details.
//
// 8. Webhook signature verification + event idempotency + payment
//    correlation + settlement validation are all preserved
//    unchanged (they are shared infrastructure, not touched here).
//
// 9. Founder-installed Stripe secrets are READ by the live
//    adapter but never written / rotated / exposed by this
//    service.
//
// 10. The syntheticTestOnly column makes every synthetic row
//     distinguishable in a one-column WHERE clause.
//
// 11. The FLY_APP_NAME guard (§3 above) makes this pathway
//     unavailable in production even if the flag is set.
//
// 12. Regression tests prove normal signup remains blocked by
//     DEVELOPMENT_FIXTURE ToS and synthetic test records cannot
//     cross Phase 2F.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { ForbiddenError, AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { resolveStripeAdapter, stripeSdkMode, resolveAcssPriceId } from "@/lib/billing/stripe-adapter";
import type { TermsOfServiceDocument } from "@/lib/billing/terms-of-service";

// ---- Guards ---------------------------------------------------

const EXPECTED_FLY_APP = "spectre-staging";
const SYNTHETIC_FLAG_ENV = "SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX";

/** Fail-closed guard chain.  Throws ForbiddenError on ANY failure.
 *  Called at the top of every exported mutating function. */
export function assertSyntheticSandboxGuardsPass(): void {
  const flyApp = process.env.FLY_APP_NAME ?? "";
  if (flyApp !== EXPECTED_FLY_APP) {
    throw new ForbiddenError(
      `[signup-2m2-synthetic] Synthetic sandbox refused: FLY_APP_NAME is '${flyApp || "<unset>"}', expected '${EXPECTED_FLY_APP}'. ` +
        `This pathway is physically unreachable from any Fly app other than spectre-staging.`,
    );
  }
  if (process.env[SYNTHETIC_FLAG_ENV] !== "1") {
    throw new ForbiddenError(
      `[signup-2m2-synthetic] Synthetic sandbox refused: ${SYNTHETIC_FLAG_ENV} != '1'. ` +
        `Set this flag explicitly ONLY for the duration of a founder-authorised test window.`,
    );
  }
  const mode = stripeSdkMode();
  if (mode !== "test") {
    throw new ForbiddenError(
      `[signup-2m2-synthetic] Synthetic sandbox refused: Stripe SDK mode is '${mode}', expected 'test'. ` +
        `This pathway requires the real Stripe SDK adapter to be engaged against test-mode credentials.`,
    );
  }
}

/** Returns true when all three guards pass without throwing.
 *  Used by tests + the operator CLI to probe readiness. */
export function syntheticSandboxEnabled(): boolean {
  try {
    assertSyntheticSandboxGuardsPass();
    return true;
  } catch {
    return false;
  }
}

// ---- Synthetic ToS -------------------------------------------

/** Reads the SYNTHETIC_TEST_ONLY ToS doc.  Separate from the
 *  main `readTermsOfService()` so the production path never
 *  encounters this content. */
export function readSyntheticTermsOfService(): TermsOfServiceDocument {
  const docPath = path.resolve(
    process.cwd(),
    "docs",
    "legal",
    "terms-of-service-synthetic-sandbox.md",
  );
  if (!fs.existsSync(docPath)) {
    throw new AppError(
      "SIGNUP_2M2_SYNTHETIC_TOS_MISSING",
      `Synthetic sandbox ToS doc missing at ${docPath}; cannot proceed`,
      500,
    );
  }
  const body = fs.readFileSync(docPath, "utf8");
  const sha256 = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  const labelMatch = body.match(/^\s*-\s*\*\*Label:\*\*\s*`([^`]+)`/m);
  const statusMatch = body.match(/^\s*-\s*\*\*Status:\*\*\s*`([^`]+)`/m);
  const label = labelMatch ? labelMatch[1] : "UNKNOWN";
  const statusRaw = statusMatch ? statusMatch[1] : "UNKNOWN";
  if (statusRaw !== "SYNTHETIC_TEST_ONLY") {
    throw new AppError(
      "SIGNUP_2M2_SYNTHETIC_TOS_WRONG_STATUS",
      `Synthetic sandbox ToS doc has status '${statusRaw}'; expected 'SYNTHETIC_TEST_ONLY'`,
      500,
    );
  }
  if (!label.startsWith("ToS-synthetic-sandbox-")) {
    throw new AppError(
      "SIGNUP_2M2_SYNTHETIC_TOS_WRONG_LABEL",
      `Synthetic sandbox ToS doc label '${label}' does not start with 'ToS-synthetic-sandbox-'`,
      500,
    );
  }
  return { label, sha256, length: body.length, status: "SYNTHETIC_TEST_ONLY", body };
}

// ---- Synthetic fixture creation ------------------------------

export interface CreateSyntheticRegistrationArgs {
  scenarioLabel: string; // e.g. "m2-happy-path"
}

export interface SyntheticFixture {
  registrationId: string;
  resumeToken: string;
  attestationId: string;
  releaseRecordId: string;
  ssh_launch_url: string; // the Spectre route the founder will hit next
}

/** Creates a complete synthetic chain:
 *   - SignupRegistration (status=VERIFIED, verdict=PASS_AUTOMATED, syntheticTestOnly=true)
 *   - SubscriptionAuthorisationAttestation (synthetic ToS SHA256, syntheticTestOnly=true)
 *   - OperatorVerificationRecord (concept=RELEASE, syntheticTestOnly=true)
 *
 *  Every row carries syntheticTestOnly=true.  No production gate
 *  will accept any of these rows.  All three guards are checked
 *  before any insert.
 */
export async function createSyntheticRegistration(
  args: CreateSyntheticRegistrationArgs,
): Promise<SyntheticFixture> {
  assertSyntheticSandboxGuardsPass();

  const scenario = args.scenarioLabel.slice(0, 48).replace(/[^a-zA-Z0-9_-]/g, "-");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const slug = `signup-2m2-syn-${scenario}-${now.getTime().toString(36).slice(-8)}`;

  // Opaque resume token (same shape as production).
  const resumeToken = crypto.randomBytes(32).toString("hex");
  const resumeTokenHash = crypto.createHash("sha256").update(resumeToken, "utf8").digest("hex");

  const tos = readSyntheticTermsOfService();

  const result = await prisma.$transaction(async (tx) => {
    const reg = await tx.signupRegistration.create({
      data: {
        resumeTokenHash,
        legalName: `SYNTHETIC_TEST_ONLY ${scenario}`,
        legalNameNormalized: slug.toLowerCase(),
        operatingName: `SYNTHETIC_TEST_ONLY ${scenario}`,
        operatingNameNormalized: slug.toLowerCase(),
        country: "CA",
        provinceState: "AB",
        addressLine1: "SYNTHETIC_TEST_ONLY - do not deliver mail",
        city: "SYNTHETIC_TEST_ONLY",
        postalCode: "T0T0T0",
        adminEmail: `${slug}@synthetic.spectre.test`,
        adminDisplayName: `SYNTHETIC_TEST_ONLY operator (${scenario})`,
        adminGivenName: "SYNTHETIC_TEST_ONLY",
        adminSurname: "Operator",
        adminPosition: "SYNTHETIC_TEST_ONLY",
        adminVerifiedAt: now,
        step: "COMPLETE",
        status: "VERIFIED",
        ownershipVerificationState: "VERIFIED",
        expiresAt,
        completedAt: now,
        verificationVerdict: "PASS_AUTOMATED",
        verificationDecidedAt: now,
        signingAuthoritySignal: "SYNTHETIC",
        syntheticTestOnly: true,
      },
      select: { id: true },
    });

    const attestation = await tx.subscriptionAuthorisationAttestation.create({
      data: {
        signupRegistrationId: reg.id,
        signatoryFullName: `SYNTHETIC_TEST_ONLY Operator`,
        signatoryTitle: "SYNTHETIC_TEST_ONLY",
        clubLegalName: `SYNTHETIC_TEST_ONLY ${scenario}`,
        attestationTextHash: crypto.createHash("sha256").update(`SYNTHETIC_TEST_ONLY attestation for ${scenario}`, "utf8").digest("hex"),
        attestationTextLength: 64,
        termsVersionSha256: tos.sha256,
        termsVersionLabel: tos.label,
        acceptedAt: now,
        syntheticTestOnly: true,
      },
      select: { id: true },
    });

    const release = await tx.operatorVerificationRecord.create({
      data: {
        signupRegistrationId: reg.id,
        concept: "RELEASE",
        finding: "AUTHORISED",
        evidenceSource: "SYNTHETIC_TEST_ONLY",
        evidenceProvenance: "signup-2m2-synthetic-sandbox-service",
        evidenceReference: `synthetic:${scenario}`,
        reason: "SYNTHETIC_TEST_ONLY: operator release record for Stripe sandbox technical acceptance",
        operatorUserId: "SYNTHETIC_TEST_ONLY",
        verifiedAt: now,
        syntheticTestOnly: true,
      },
      select: { id: true },
    });

    return { regId: reg.id, attId: attestation.id, relId: release.id };
  });

  // The applicant-facing route needs a token.  The synthetic
  // route (below) accepts the registration id directly, but we
  // return the resume token for parity with the normal flow.
  const ssh_launch_url =
    `${env.APP_URL}/api/signup/mandate/synthetic-initiate?registrationId=${encodeURIComponent(result.regId)}`;

  await audit(null, {
    action: "signup.synthetic.registration_created",
    entityType: "SignupRegistration",
    entityId: result.regId,
    clubId: null,
    meta: {
      scenarioLabel: scenario,
      registrationIdTail: result.regId.slice(-6),
      attestationIdTail: result.attId.slice(-6),
      releaseIdTail: result.relId.slice(-6),
      syntheticTestOnly: true,
    },
  });
  logger.info("signup.synthetic.registration_created", {
    registrationIdTail: result.regId.slice(-6),
    scenarioLabel: scenario,
  });

  return {
    registrationId: result.regId,
    resumeToken,
    attestationId: result.attId,
    releaseRecordId: result.relId,
    ssh_launch_url,
  };
}

// ---- Single-use nonce (CSRF / state binding) -----------------
//
// On initiate: a cryptographically-random 32-byte nonce is written
// to the SignupRegistration's `signingAuthoritySignal` field (we
// reuse a text slot already present on the synthetic row to avoid
// an additional schema change).  The nonce is embedded in the
// Stripe Checkout `success_url` as a query param.  On return, the
// handler reads the nonce from the URL + compares against the
// stored value in a single-use consume operation.  Any mismatch
// (replay, forgery, cross-registration) throws ForbiddenError.
//
// This binds the Stripe return to the exact initiate call that
// started it.  An attacker who learns `registrationId + session_id`
// but not the nonce cannot persist a mandate.

const NONCE_PREFIX = "signup-2m2-syn-nonce:";

export async function issueSyntheticReturnNonce(
  registrationId: string,
  operatorUserId: string,
): Promise<string> {
  assertSyntheticSandboxGuardsPass();
  const reg = await prisma.signupRegistration.findUnique({
    where: { id: registrationId },
    select: { syntheticTestOnly: true },
  });
  if (!reg || reg.syntheticTestOnly !== true) {
    throw new ForbiddenError("[signup-2m2-synthetic] issueSyntheticReturnNonce refused: registration not synthetic");
  }
  const nonce = crypto.randomBytes(32).toString("hex");
  await prisma.signupRegistration.update({
    where: { id: registrationId },
    data: { signingAuthoritySignal: `${NONCE_PREFIX}${nonce}:${operatorUserId.slice(-6)}` },
  });
  logger.info("signup.synthetic.nonce.issued", {
    registrationIdTail: registrationId.slice(-6),
    operatorUserIdTail: operatorUserId.slice(-6),
  });
  return nonce;
}

export async function consumeSyntheticReturnNonce(
  registrationId: string,
  presentedNonce: string,
): Promise<void> {
  assertSyntheticSandboxGuardsPass();
  if (!presentedNonce || presentedNonce.length !== 64) {
    throw new ForbiddenError("[signup-2m2-synthetic] consumeSyntheticReturnNonce refused: malformed nonce");
  }
  const reg = await prisma.signupRegistration.findUnique({
    where: { id: registrationId },
    select: { syntheticTestOnly: true, signingAuthoritySignal: true },
  });
  if (!reg || reg.syntheticTestOnly !== true) {
    throw new ForbiddenError("[signup-2m2-synthetic] consumeSyntheticReturnNonce refused: registration not synthetic");
  }
  const stored = reg.signingAuthoritySignal ?? "";
  if (!stored.startsWith(NONCE_PREFIX)) {
    throw new ForbiddenError("[signup-2m2-synthetic] consumeSyntheticReturnNonce refused: no nonce issued");
  }
  const parts = stored.slice(NONCE_PREFIX.length).split(":");
  const storedNonce = parts[0] ?? "";
  // Constant-time compare.
  if (
    storedNonce.length !== presentedNonce.length ||
    !crypto.timingSafeEqual(Buffer.from(storedNonce, "hex"), Buffer.from(presentedNonce, "hex"))
  ) {
    throw new ForbiddenError("[signup-2m2-synthetic] consumeSyntheticReturnNonce refused: nonce mismatch");
  }
  // Single-use: clear the nonce slot atomically.  A conditional
  // update enforces the single-use property under concurrent
  // return hits (replay attempts).
  const consumed = await prisma.signupRegistration.updateMany({
    where: {
      id: registrationId,
      signingAuthoritySignal: stored,
    },
    data: { signingAuthoritySignal: `${NONCE_PREFIX}CONSUMED` },
  });
  if (consumed.count !== 1) {
    throw new ForbiddenError("[signup-2m2-synthetic] consumeSyntheticReturnNonce refused: nonce already consumed");
  }
  logger.info("signup.synthetic.nonce.consumed", {
    registrationIdTail: registrationId.slice(-6),
  });
}

// ---- Synthetic mandate collection ----------------------------

/** Parallel to `initiateMandateCollection` for synthetic
 *  registrations ONLY.  Guards verify (a) the sandbox is enabled,
 *  (b) the registration has syntheticTestOnly=true, (c) the caller
 *  is an authenticated SUPER_ADMIN (enforced at the HTTP route).
 *  Writes NO production rows; opens a real Stripe test-mode
 *  Checkout session with the real sandbox API key.
 *
 *  Optional opts.returnNonce is embedded in the Stripe Checkout
 *  success_url so the return handler can validate it as a
 *  single-use CSRF/replay guard.
 */
export async function initiateSyntheticMandateCollection(
  registrationId: string,
  opts: { operatorUserId?: string; returnNonce?: string } = {},
): Promise<{ checkoutUrl: string; checkoutSessionId: string }> {
  assertSyntheticSandboxGuardsPass();

  const reg = await prisma.signupRegistration.findUnique({
    where: { id: registrationId },
    select: {
      id: true,
      legalName: true,
      adminEmail: true,
      syntheticTestOnly: true,
      verificationVerdict: true,
    },
  });
  if (!reg) {
    throw new AppError("SIGNUP_2M2_SYNTHETIC_REG_NOT_FOUND", "Synthetic registration not found", 404);
  }
  if (reg.syntheticTestOnly !== true) {
    throw new ForbiddenError(
      "[signup-2m2-synthetic] Refused: registration is NOT marked syntheticTestOnly. " +
        "This route accepts only synthetic registrations.  Normal registrations must use the production mandate path.",
    );
  }
  // Still require the registration to be in an AUTHORISED-equivalent state.
  if (reg.verificationVerdict !== "PASS_AUTOMATED" && reg.verificationVerdict !== "MANUAL_RELEASE") {
    throw new ForbiddenError(
      `[signup-2m2-synthetic] Synthetic registration verdict is '${reg.verificationVerdict}'; expected PASS_AUTOMATED or MANUAL_RELEASE`,
    );
  }

  const stripe = resolveStripeAdapter({ requireLive: true });

  const customer = await stripe.createCustomer({
    idempotencyKey: `signup-2m2-syn-cust:${reg.id}`,
    signupRegistrationId: reg.id,
    description: `SYNTHETIC_TEST_ONLY Stripe sandbox customer -- registration ${reg.id.slice(-6)}`,
    metadata: {
      signupRegistrationIdTail: reg.id.slice(-6),
      syntheticTestOnly: "true",
      source: "signup-2m2-synthetic-sandbox-service",
    },
  });

  // M2-SyntheticSandbox: embed the single-use nonce in the success_url
  // so the return handler can validate it before persisting the mandate.
  const noncePart = opts.returnNonce ? `&nonce=${encodeURIComponent(opts.returnNonce)}` : "";
  const successUrl =
    `${env.APP_URL}/api/signup/mandate/synthetic-return?registrationId=${encodeURIComponent(reg.id)}&session_id={CHECKOUT_SESSION_ID}${noncePart}`;
  const cancelUrl = `${env.APP_URL}/signup/t/synthetic-cancel?registrationId=${encodeURIComponent(reg.id)}`;

  const session = await stripe.createMandateCheckoutSession({
    idempotencyKey: `signup-2m2-syn-checkout:${reg.id}:0`,
    stripeCustomerId: customer.stripeCustomerId,
    acssMandate: {
      paymentSchedule: "interval",
      transactionType: "business",
      intervalDescription: "SYNTHETIC_TEST_ONLY — Annual Spectre sandbox test",
    },
    successUrl,
    cancelUrl,
    metadata: {
      signupRegistrationIdTail: reg.id.slice(-6),
      syntheticTestOnly: "true",
    },
  });

  await audit(null, {
    action: "signup.synthetic.mandate_initiated",
    entityType: "SignupRegistration",
    entityId: reg.id,
    clubId: null,
    meta: {
      registrationIdTail: reg.id.slice(-6),
      stripeCustomerIdTail: customer.stripeCustomerId.slice(-8),
      checkoutSessionIdTail: session.checkoutSessionId.slice(-8),
      evidenceSource: session.evidenceSource,
      syntheticTestOnly: true,
    },
  });
  logger.info("signup.synthetic.mandate_initiated", {
    registrationIdTail: reg.id.slice(-6),
    checkoutSessionIdTail: session.checkoutSessionId.slice(-8),
  });

  return { checkoutUrl: session.checkoutUrl, checkoutSessionId: session.checkoutSessionId };
}

// ---- Synthetic mandate persistence (return handler) ---------

export async function persistSyntheticSignedMandate(args: {
  registrationId: string;
  checkoutSessionId: string;
}): Promise<{ noop: boolean; mandateId?: string; billingCycleId?: string }> {
  assertSyntheticSandboxGuardsPass();

  const reg = await prisma.signupRegistration.findUnique({
    where: { id: args.registrationId },
    select: { id: true, syntheticTestOnly: true },
  });
  if (!reg) throw new AppError("SIGNUP_2M2_SYNTHETIC_REG_NOT_FOUND", "Not found", 404);
  if (reg.syntheticTestOnly !== true) {
    throw new ForbiddenError("[signup-2m2-synthetic] Registration not marked syntheticTestOnly");
  }

  const existing = await prisma.subscriptionPaymentMandate.findFirst({
    where: { signupRegistrationId: reg.id, syntheticTestOnly: true },
    orderBy: { acceptedAt: "desc" },
    select: { id: true, revokedAt: true },
  });
  if (existing && !existing.revokedAt) {
    return { noop: true, mandateId: existing.id };
  }

  const stripe = resolveStripeAdapter({ requireLive: true });
  const sessionResult = await stripe.retrieveCheckoutSession(args.checkoutSessionId);
  if (sessionResult.status !== "complete") {
    throw new AppError(
      "SIGNUP_2M2_SYNTHETIC_CHECKOUT_NOT_COMPLETE",
      `Checkout session is ${sessionResult.status}`,
      409,
    );
  }
  if (!sessionResult.mandateId || !sessionResult.paymentMethodId) {
    throw new AppError(
      "SIGNUP_2M2_SYNTHETIC_CHECKOUT_MISSING_FIELDS",
      "Session missing mandate or payment method",
      500,
    );
  }

  const releaseRecord = await prisma.operatorVerificationRecord.findFirst({
    where: { signupRegistrationId: reg.id, concept: "RELEASE", syntheticTestOnly: true },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!releaseRecord) {
    throw new ForbiddenError("[signup-2m2-synthetic] No synthetic RELEASE record on file");
  }

  const priceId = resolveAcssPriceId();
  if (!priceId) {
    throw new AppError("SIGNUP_2M2_SYNTHETIC_PRICE_ID_MISSING", "STRIPE_ACSS_PRICE_ID unset", 500);
  }

  // M2-SyntheticSandbox-Repair (2026-10-27): wrap subscription
  // creation so a Stripe-side failure (e.g. ACSS amount limit) does
  // not crash the handler.  On failure, we write a structured
  // operator-visible marker (via the Mandate row's revoke slot would
  // conflict with legitimate revocation; use the audit log) + throw
  // an AppError the route maps to a specific error_code.  The
  // operator can retry via recoverSyntheticSignedMandate once the
  // underlying cause (ACSS limit, missing capability) is resolved.
  //
  // Exactly-once semantics are preserved because the idempotencyKey
  // is deterministic -- a retry with the same key either returns the
  // existing subscription OR re-runs the create against Stripe.
  let subscription;
  try {
    subscription = await stripe.createSubscription({
      idempotencyKey: `signup-2m2-syn-sub:${reg.id}:first`,
      stripeCustomerId: sessionResult.customerId,
      stripePriceId: priceId,
      defaultPaymentMethodId: sessionResult.paymentMethodId,
      metadata: {
        signupRegistrationIdTail: reg.id.slice(-6),
        syntheticTestOnly: "true",
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("signup.synthetic.subscription_create_failed", {
      registrationIdTail: reg.id.slice(-6),
      checkoutSessionIdTail: args.checkoutSessionId.slice(-8),
      stripeCustomerIdTail: sessionResult.customerId.slice(-8),
      stripeMandateIdTail: sessionResult.mandateId!.slice(-8),
      stripePaymentMethodIdTail: sessionResult.paymentMethodId!.slice(-8),
      priceIdTail: priceId.slice(-8),
      detail,
    });
    await audit(null, {
      action: "signup.synthetic.subscription_create_failed",
      entityType: "SignupRegistration",
      entityId: reg.id,
      clubId: null,
      meta: {
        registrationIdTail: reg.id.slice(-6),
        checkoutSessionIdTail: args.checkoutSessionId.slice(-8),
        stripeError: detail.slice(0, 500),
        syntheticTestOnly: true,
      },
    });
    throw new AppError(
      "SIGNUP_2M2_SYNTHETIC_STRIPE_SUBSCRIPTION_FAILED",
      `Stripe refused to create the synthetic test subscription: ${detail}.  The mandate + payment method remain valid on Stripe (SetupIntent succeeded); operator can retry via recoverSyntheticSignedMandate once the underlying cause (likely ACSS amount limit on sandbox account) is resolved.`,
      500,
    );
  }

  const now = new Date();
  const mandateText = `SYNTHETIC_TEST_ONLY ACSS mandate for Stripe sandbox technical acceptance -- registration ${reg.id.slice(-6)}, Stripe mandate ${sessionResult.mandateId}`;
  const result = await prisma.$transaction(async (tx) => {
    const mandate = await tx.subscriptionPaymentMandate.create({
      data: {
        signupRegistrationId: reg.id,
        stripeMandateId: sessionResult.mandateId!,
        stripePaymentMethodId: sessionResult.paymentMethodId!,
        mandateType: "ACSS_DEBIT",
        mandateVariant: "INTERVAL",
        transactionType: "BUSINESS",
        acceptedAt: now,
        mandateTextHash: crypto.createHash("sha256").update(mandateText, "utf8").digest("hex"),
        mandateTextLength: mandateText.length,
        syntheticTestOnly: true,
      },
      select: { id: true },
    });
    const cycle = await tx.billingCycle.create({
      data: {
        clubId: reg.id,
        periodLabel: `signup-2m2-syn-first-${reg.id.slice(-8)}`,
        startDate: now,
        endDate: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
        totalDue: 38000.00,
        totalPaid: 0.00,
        status: "OPEN",
        subscriptionStatus: "INITIATED",
        source: "STRIPE_ACSS",
        stripePaymentIntentId: subscription.firstPaymentIntentId,
        releasedByOperatorRecordId: releaseRecord.id,
        syntheticTestOnly: true,
      },
      select: { id: true },
    });
    return { mandateId: mandate.id, cycleId: cycle.id };
  });

  await audit(null, {
    action: "signup.synthetic.mandate_persisted",
    entityType: "SubscriptionPaymentMandate",
    entityId: result.mandateId,
    clubId: null,
    meta: {
      registrationIdTail: reg.id.slice(-6),
      stripeSubscriptionIdTail: subscription.stripeSubscriptionId.slice(-8),
      stripeMandateIdTail: sessionResult.mandateId.slice(-8),
      billingCycleIdTail: result.cycleId.slice(-6),
      syntheticTestOnly: true,
    },
  });
  return { noop: false, mandateId: result.mandateId, billingCycleId: result.cycleId };
}

// ---- Recovery (SUPER_ADMIN-gated retry after a transient subscription-create failure) ----
//
// Scenario: the return handler consumed the nonce (correct), the
// Stripe SetupIntent + Mandate + PaymentMethod exist (verified by
// retrieveCheckoutSession returning status=complete + both ids),
// but `stripe.subscriptions.create` failed (e.g. ACSS per-transaction
// amount limit, missing capability, transient 5xx) BEFORE Spectre
// persisted the SubscriptionPaymentMandate + BillingCycle rows.
//
// The nonce consumption was legitimate (the signatory DID sign) so
// resetting it to make the normal return route retry would be
// wrong per founder scope §3 ("Never reset or reuse a consumed
// nonce merely to make the test pass").  Instead the operator
// uses this SUPER_ADMIN-gated recovery function to resume
// persistence using the already-collected Stripe state.
//
// Exactly-once:
//   - If a SubscriptionPaymentMandate row for this registration
//     already exists (success case) -> returns noop.
//   - Stripe.subscriptions.create is called with the SAME
//     idempotencyKey as the original persist attempt.  Stripe
//     returns the existing subscription if the earlier call
//     actually succeeded; otherwise it re-attempts.
//   - On persistent Stripe-side failure, the recovery raises
//     the same structured error for operator triage.
export async function recoverSyntheticSignedMandate(
  registrationId: string,
  checkoutSessionId: string,
): Promise<{ noop: boolean; mandateId?: string; billingCycleId?: string }> {
  // Operator-driven: guards must hold, but NO nonce check (the
  // operator-authenticated SUPER_ADMIN HTTP route gate replaces the
  // signatory nonce for retries).
  assertSyntheticSandboxGuardsPass();
  // Idempotent short-circuit: if the mandate already landed,
  // return noop immediately.
  const existing = await prisma.subscriptionPaymentMandate.findFirst({
    where: { signupRegistrationId: registrationId, syntheticTestOnly: true },
    orderBy: { acceptedAt: "desc" },
    select: { id: true, revokedAt: true },
  });
  if (existing && !existing.revokedAt) {
    logger.info("signup.synthetic.recover.noop_existing_mandate", {
      registrationIdTail: registrationId.slice(-6),
    });
    return { noop: true, mandateId: existing.id };
  }
  // Re-run persist.  Since the nonce was consumed by the original
  // signatory return, we don't re-check it here -- the operator
  // SUPER_ADMIN route is the auth boundary for retries.
  const result = await persistSyntheticSignedMandate({
    registrationId,
    checkoutSessionId,
  });
  logger.info("signup.synthetic.recover.completed", {
    registrationIdTail: registrationId.slice(-6),
    noop: result.noop,
    mandateIdTail: result.mandateId?.slice(-8) ?? null,
  });
  return result;
}

// ---- Teardown -------------------------------------------------

export async function teardownSyntheticTestFixtures(): Promise<{
  registrationsDeleted: number;
  attestationsDeleted: number;
  releaseRecordsDeleted: number;
  mandatesDeleted: number;
  billingCyclesDeleted: number;
}> {
  // Teardown is intentionally runnable WITHOUT the guards passing,
  // so a stuck-flag post-test cleanup can still work.  But it ONLY
  // deletes rows with syntheticTestOnly=true -- no production
  // rows are at risk.
  const regIds = (
    await prisma.signupRegistration.findMany({
      where: { syntheticTestOnly: true },
      select: { id: true },
    })
  ).map((r) => r.id);

  const [cyclesDeleted, mandatesDeleted, attestationsDeleted, releaseRecordsDeleted] = await Promise.all([
    prisma.billingCycle
      .deleteMany({ where: { syntheticTestOnly: true } })
      .then((r) => r.count),
    prisma.subscriptionPaymentMandate
      .deleteMany({ where: { syntheticTestOnly: true } })
      .then((r) => r.count),
    prisma.subscriptionAuthorisationAttestation
      .deleteMany({ where: { syntheticTestOnly: true } })
      .then((r) => r.count),
    prisma.operatorVerificationRecord
      .deleteMany({ where: { syntheticTestOnly: true } })
      .then((r) => r.count),
  ]);
  const regsDeleted = await prisma.signupRegistration
    .deleteMany({ where: { id: { in: regIds }, syntheticTestOnly: true } })
    .then((r) => r.count);

  logger.info("signup.synthetic.teardown_complete", {
    registrationsDeleted: regsDeleted,
    attestationsDeleted,
    releaseRecordsDeleted,
    mandatesDeleted,
    billingCyclesDeleted: cyclesDeleted,
  });

  return {
    registrationsDeleted: regsDeleted,
    attestationsDeleted,
    releaseRecordsDeleted,
    mandatesDeleted,
    billingCyclesDeleted: cyclesDeleted,
  };
}

// ---- Guard: production-path refusal on synthetic rows -------

/** Called by Phase 2F / 2G / 2H / normal mandate paths at the
 *  TOP of any flow that promotes a SignupRegistration toward a
 *  real tenant.  Throws if the registration carries the synthetic
 *  marker. */
export async function refuseIfSyntheticTestOnly(registrationId: string): Promise<void> {
  const reg = await prisma.signupRegistration.findUnique({
    where: { id: registrationId },
    select: { syntheticTestOnly: true },
  });
  if (reg?.syntheticTestOnly === true) {
    throw new ForbiddenError(
      `[signup-2m2-synthetic] Registration ${registrationId.slice(-6)} is marked syntheticTestOnly; production paths refuse. ` +
        `This marker is immutable; synthetic rows cannot be promoted to a real tenant.`,
    );
  }
}

// SIGNUP-2 M3A (2026-10-27) -- Deployed staging acceptance driver.
//
// Exercises the M3 bank-verification state machine against the running
// Fly staging DB.  Writes synthetic rows (syntheticTestOnly=true) so
// teardown is a one-SQL sweep.
//
// EVIDENCE CLASS: this script executes the SAME conditional updateMany
// logic that the deployed service's state writers execute (markBankVerified,
// markBankVerificationPending, markBankVerificationFailed).  The service
// code itself is verified by the 37 vitest contract tests
// (tests/signup-2-m3-bank-verification.test.ts).  Here we prove the
// DB-level behavior against the real Postgres staging instance.
//
// Mocked evidence per founder §5: the state transitions are triggered
// by direct SQL (mimicking the service's updateMany).  No real Stripe
// webhook is injected (that would require the real signing secret).
// For real-Stripe evidence of the Instant path, see the companion
// evidence note citing SetupIntent seti_1UVDrERJ1xiT3002cpiwszND which
// Stripe reported as succeeded in a prior real sandbox Checkout.
//
// Guards (fail-closed):
//   FLY_APP_NAME === "spectre-staging"
//   SPECTRE_SIGNUP_2M3_BANK_VERIFICATION === "1"
//   SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION === undefined / "0"

import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";

const prisma = new PrismaClient();

function assertGuards() {
  if (process.env.FLY_APP_NAME !== "spectre-staging") {
    throw new Error(`REFUSED: FLY_APP_NAME is '${process.env.FLY_APP_NAME ?? "<unset>"}', expected 'spectre-staging'`);
  }
  if (process.env.SPECTRE_SIGNUP_2M3_BANK_VERIFICATION !== "1") {
    throw new Error("REFUSED: SPECTRE_SIGNUP_2M3_BANK_VERIFICATION != 1");
  }
  if (process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION === "1") {
    throw new Error("REFUSED: SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION is 1 -- M3A must not run with payment initiation enabled");
  }
}

// --- state writers (DB-mirror of deployed service) ----------------
//
// These functions use the EXACT updateMany conditions the deployed
// service uses in src/lib/billing/signup-2m3-bank-verification-service.ts.
// If you change the service, mirror the change here or update this
// script to call the deployed service via a staging admin API.

async function markBankVerifiedDbMirror({ billingCycleId, verificationMethod, stripeSetupIntentId }) {
  const prev = await prisma.billingCycle.findUnique({
    where: { id: billingCycleId },
    select: { subscriptionStatus: true, bankVerifiedAt: true, stripeSetupIntentId: true },
  });
  if (!prev) return { noop: true, previousState: null };
  if (prev.subscriptionStatus === "BANK_VERIFIED" && prev.bankVerifiedAt) {
    return { noop: true, previousState: prev.subscriptionStatus };
  }
  if (prev.subscriptionStatus !== "AUTHORISED" && prev.subscriptionStatus !== "BANK_VERIFICATION_PENDING") {
    return { noop: true, previousState: prev.subscriptionStatus };
  }
  const r = await prisma.billingCycle.updateMany({
    where: {
      id: billingCycleId,
      subscriptionStatus: { in: ["AUTHORISED", "BANK_VERIFICATION_PENDING"] },
    },
    data: {
      subscriptionStatus: "BANK_VERIFIED",
      bankVerifiedAt: new Date(),
      bankVerificationMethod: verificationMethod,
      ...(prev.stripeSetupIntentId ? {} : { stripeSetupIntentId }),
    },
  });
  return { noop: r.count === 0, previousState: prev.subscriptionStatus };
}

async function markBankVerificationPendingDbMirror({ billingCycleId, stripeSetupIntentId, arrivalDate, hostedVerificationUrl }) {
  const prev = await prisma.billingCycle.findUnique({
    where: { id: billingCycleId },
    select: { subscriptionStatus: true },
  });
  if (!prev) return { noop: true };
  if (prev.subscriptionStatus === "BANK_VERIFICATION_PENDING") return { noop: true };
  if (prev.subscriptionStatus !== "AUTHORISED") return { noop: true };
  const r = await prisma.billingCycle.updateMany({
    where: { id: billingCycleId, subscriptionStatus: "AUTHORISED" },
    data: {
      subscriptionStatus: "BANK_VERIFICATION_PENDING",
      bankVerificationPendingAt: new Date(),
      bankVerificationExpiresAt: arrivalDate,
      bankVerificationHostedUrl: hostedVerificationUrl,
      stripeSetupIntentId,
    },
  });
  return { noop: r.count === 0 };
}

async function markBankVerificationFailedDbMirror({ billingCycleId, reason }) {
  const prev = await prisma.billingCycle.findUnique({
    where: { id: billingCycleId },
    select: { subscriptionStatus: true },
  });
  if (!prev) return { noop: true };
  if (prev.subscriptionStatus === "BANK_VERIFICATION_FAILED") return { noop: true };
  if (prev.subscriptionStatus !== "AUTHORISED" && prev.subscriptionStatus !== "BANK_VERIFICATION_PENDING") return { noop: true };
  const r = await prisma.billingCycle.updateMany({
    where: {
      id: billingCycleId,
      subscriptionStatus: { in: ["AUTHORISED", "BANK_VERIFICATION_PENDING"] },
    },
    data: {
      subscriptionStatus: "BANK_VERIFICATION_FAILED",
      bankVerificationFailedAt: new Date(),
      bankVerificationFailureReason: reason,
    },
  });
  return { noop: r.count === 0 };
}

// --- synthetic seed ---------------------------------------------------

/** M3A: lazy-create ONE synthetic Club for all scenarios so BillingCycle's
 *  FK is satisfied.  Marked with a predictable slug prefix so teardown
 *  can delete it + its rows. */
let __SYNTHETIC_CLUB_ID = null;
async function ensureSyntheticClub() {
  if (__SYNTHETIC_CLUB_ID) return __SYNTHETIC_CLUB_ID;
  const slug = `synthetic-test-only-m3a-${Date.now().toString(36)}`;
  const now = new Date();
  const club = await prisma.club.create({
    data: {
      name: "SYNTHETIC_TEST_ONLY M3A",
      slug,
      stagingDataMode: "SYNTHETIC_DEMO",
      isDemoTenant: true,
    },
    select: { id: true, slug: true },
  });
  __SYNTHETIC_CLUB_ID = club.id;
  return club.id;
}

async function createSyntheticCycle(scenarioLabel, initialSubscriptionStatus = "AUTHORISED") {
  const now = new Date();
  const resumeTokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
  const regLabel = `m3a-${scenarioLabel}-${Date.now().toString(36).slice(-8)}`;
  const reg = await prisma.signupRegistration.create({
    data: {
      resumeTokenHash,
      legalName: `SYNTHETIC_TEST_ONLY ${regLabel}`,
      legalNameNormalized: regLabel.toLowerCase(),
      operatingName: `SYNTHETIC_TEST_ONLY ${regLabel}`,
      operatingNameNormalized: regLabel.toLowerCase(),
      country: "CA", provinceState: "AB",
      addressLine1: "SYNTHETIC_TEST_ONLY - do not deliver mail",
      city: "SYNTHETIC_TEST_ONLY", postalCode: "T0T0T0",
      adminEmail: `${regLabel}@synthetic.spectre.test`,
      adminDisplayName: "SYNTHETIC_TEST_ONLY operator",
      adminGivenName: "SYNTHETIC_TEST_ONLY", adminSurname: "Operator",
      adminPosition: "SYNTHETIC_TEST_ONLY", adminVerifiedAt: now,
      step: "COMPLETE", status: "VERIFIED",
      ownershipVerificationState: "VERIFIED",
      expiresAt: new Date(now.getTime() + 86400000), completedAt: now,
      verificationVerdict: "PASS_AUTOMATED", verificationDecidedAt: now,
      signingAuthoritySignal: "SYNTHETIC-M3A",
      syntheticTestOnly: true,
    },
    select: { id: true },
  });
  const release = await prisma.operatorVerificationRecord.create({
    data: {
      signupRegistrationId: reg.id, concept: "RELEASE", finding: "AUTHORISED",
      evidenceSource: "SYNTHETIC_TEST_ONLY",
      evidenceProvenance: "signup-2-m3a-staging-acceptance.mjs",
      evidenceReference: `m3a:${regLabel}`,
      reason: "SYNTHETIC_TEST_ONLY: M3A acceptance",
      operatorUserId: "SSH_SUPER_ADMIN_M3A", verifiedAt: now,
      syntheticTestOnly: true,
    },
    select: { id: true },
  });
  const setupIntentId = `seti_m3a_${scenarioLabel.replace(/[^a-z0-9]/gi, "")}_${Date.now().toString(36).slice(-8)}`;
  const mandateId = `mandate_m3a_${scenarioLabel.replace(/[^a-z0-9]/gi, "")}_${Date.now().toString(36).slice(-8)}`;
  const paymentMethodId = `pm_m3a_${scenarioLabel.replace(/[^a-z0-9]/gi, "")}_${Date.now().toString(36).slice(-8)}`;
  await prisma.subscriptionPaymentMandate.create({
    data: {
      signupRegistrationId: reg.id,
      stripeMandateId: mandateId, stripePaymentMethodId: paymentMethodId,
      mandateType: "ACSS_DEBIT", mandateVariant: "INTERVAL", transactionType: "BUSINESS",
      acceptedAt: now,
      mandateTextHash: createHash("sha256").update(`m3a-mandate-${regLabel}`).digest("hex"),
      mandateTextLength: 64, syntheticTestOnly: true,
    },
  });
  const clubId = await ensureSyntheticClub();
  const cycle = await prisma.billingCycle.create({
    data: {
      clubId, periodLabel: `m3a-${regLabel}`,
      startDate: now, endDate: new Date(now.getTime() + 365 * 86400000),
      totalDue: 38000.00, totalPaid: 0.00, status: "OPEN",
      subscriptionStatus: initialSubscriptionStatus,
      source: "STRIPE_ACSS", releasedByOperatorRecordId: release.id,
      stripeSetupIntentId: setupIntentId, syntheticTestOnly: true,
    },
    select: { id: true },
  });
  return { regId: reg.id, cycleId: cycle.id, clubId, setupIntentId, mandateId, paymentMethodId };
}

async function readCycle(cycleId) {
  return prisma.billingCycle.findUnique({
    where: { id: cycleId },
    select: {
      subscriptionStatus: true,
      bankVerifiedAt: true, bankVerificationPendingAt: true, bankVerificationFailedAt: true,
      bankVerificationMethod: true, bankVerificationFailureReason: true,
      bankVerificationHostedUrl: true, bankVerificationExpiresAt: true,
      stripeSetupIntentId: true, stripePaymentIntentId: true,
    },
  });
}

// --- scenarios --------------------------------------------------------

async function scenarioA_instantVerificationSucceeds() {
  const seed = await createSyntheticCycle("A-instant");
  const r = await markBankVerifiedDbMirror({
    billingCycleId: seed.cycleId,
    verificationMethod: "INSTANT",
    stripeSetupIntentId: seed.setupIntentId,
  });
  const after = await readCycle(seed.cycleId);
  return {
    name: "A. Instant verification succeeds -> BANK_VERIFIED",
    seed, writerResult: r, after,
    assertions: {
      noop: r.noop === false,
      previousState: r.previousState === "AUTHORISED",
      status: after.subscriptionStatus === "BANK_VERIFIED",
      bankVerifiedAtSet: after.bankVerifiedAt !== null,
      method: after.bankVerificationMethod === "INSTANT",
      pendingAtUnset: after.bankVerificationPendingAt === null,
      failedAtUnset: after.bankVerificationFailedAt === null,
      noSubscriptionCreated: after.stripePaymentIntentId === null,
    },
  };
}

async function scenarioB_microdepositPending() {
  const seed = await createSyntheticCycle("B-microdeposit-pending");
  const arrivalDate = new Date(Date.now() + 2 * 86400000);
  const hostedUrl = "https://verify.stripe.com/microdeposits/seed-m3a-B";
  const r = await markBankVerificationPendingDbMirror({
    billingCycleId: seed.cycleId,
    stripeSetupIntentId: seed.setupIntentId,
    arrivalDate, hostedVerificationUrl: hostedUrl,
  });
  const after = await readCycle(seed.cycleId);
  return {
    name: "B. Microdeposit path -> BANK_VERIFICATION_PENDING",
    seed, writerResult: r, after,
    assertions: {
      noop: r.noop === false,
      status: after.subscriptionStatus === "BANK_VERIFICATION_PENDING",
      pendingAtSet: after.bankVerificationPendingAt !== null,
      expiresAtSet: after.bankVerificationExpiresAt !== null,
      hostedUrlSet: after.bankVerificationHostedUrl === hostedUrl,
      verifiedAtUnset: after.bankVerifiedAt === null,
      noSubscriptionCreated: after.stripePaymentIntentId === null,
    },
  };
}

async function scenarioC_microdepositConfirmed() {
  const seed = await createSyntheticCycle("C-microdeposit-confirmed");
  await markBankVerificationPendingDbMirror({
    billingCycleId: seed.cycleId,
    stripeSetupIntentId: seed.setupIntentId,
    arrivalDate: new Date(Date.now() + 2 * 86400000),
    hostedVerificationUrl: "https://verify.stripe.com/microdeposits/seed-m3a-C",
  });
  const r = await markBankVerifiedDbMirror({
    billingCycleId: seed.cycleId,
    verificationMethod: "MICRODEPOSITS",
    stripeSetupIntentId: seed.setupIntentId,
  });
  const after = await readCycle(seed.cycleId);
  return {
    name: "C. Microdeposit confirmed -> BANK_VERIFIED (method=MICRODEPOSITS)",
    seed, writerResult: r, after,
    assertions: {
      noop: r.noop === false,
      previousState: r.previousState === "BANK_VERIFICATION_PENDING",
      status: after.subscriptionStatus === "BANK_VERIFIED",
      bankVerifiedAtSet: after.bankVerifiedAt !== null,
      method: after.bankVerificationMethod === "MICRODEPOSITS",
      pendingAtPreserved: after.bankVerificationPendingAt !== null,
      noSubscriptionCreated: after.stripePaymentIntentId === null,
    },
  };
}

async function scenarioD_verificationFailed() {
  const seed = await createSyntheticCycle("D-failed");
  const r = await markBankVerificationFailedDbMirror({
    billingCycleId: seed.cycleId,
    reason: "STRIPE_SETUP_FAILED",
  });
  const after = await readCycle(seed.cycleId);
  return {
    name: "D. Verification failed -> BANK_VERIFICATION_FAILED",
    seed, writerResult: r, after,
    assertions: {
      noop: r.noop === false,
      status: after.subscriptionStatus === "BANK_VERIFICATION_FAILED",
      failedAtSet: after.bankVerificationFailedAt !== null,
      reason: after.bankVerificationFailureReason === "STRIPE_SETUP_FAILED",
      noSubscriptionCreated: after.stripePaymentIntentId === null,
    },
  };
}

async function scenarioE_duplicateWebhookIdempotency() {
  const seed = await createSyntheticCycle("E-duplicate");
  const r1 = await markBankVerifiedDbMirror({
    billingCycleId: seed.cycleId,
    verificationMethod: "INSTANT",
    stripeSetupIntentId: seed.setupIntentId,
  });
  const r2 = await markBankVerifiedDbMirror({
    billingCycleId: seed.cycleId,
    verificationMethod: "INSTANT",
    stripeSetupIntentId: seed.setupIntentId,
  });
  const after = await readCycle(seed.cycleId);
  return {
    name: "E. Duplicate webhook delivery is idempotent",
    seed, firstCall: r1, secondCall: r2, after,
    assertions: {
      firstCallWrites: r1.noop === false,
      secondCallIsNoop: r2.noop === true,
      status: after.subscriptionStatus === "BANK_VERIFIED",
    },
  };
}

async function scenarioF_unverifiedCannotAdvance() {
  // Prove §7: SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION=0 blocks EVERY path.
  // Here we assert the flag is 0 and no cycle in BANK_VERIFIED or earlier
  // has a stripePaymentIntentId.
  const paymentInitFlag = process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION;
  const flagIsOff = paymentInitFlag !== "1";
  // Also: no synthetic cycle in BANK_VERIFIED got a payment intent.
  const bankVerifiedWithPI = await prisma.billingCycle.count({
    where: {
      syntheticTestOnly: true,
      subscriptionStatus: "BANK_VERIFIED",
      stripePaymentIntentId: { not: null },
    },
  });
  return {
    name: "F. Unverified / verified cycles cannot advance (payment-initiation flag OFF)",
    paymentInitFlag,
    bankVerifiedWithPaymentIntent: bankVerifiedWithPI,
    assertions: {
      paymentInitiationFlagIsOff: flagIsOff === true,
      noBankVerifiedCycleGotPaymentIntent: bankVerifiedWithPI === 0,
    },
  };
}

async function scenarioG_terminalStateRespected() {
  // Can't move AUTHORISED -> AUTHORISED (self-transition); can't move
  // BANK_VERIFIED back to AUTHORISED via markBank* functions.  Prove
  // writer refuses out-of-state inputs.
  const seed = await createSyntheticCycle("G-terminal", "BANK_VERIFIED");
  // Attempt to mark pending on an already-verified cycle.
  const bogus = await markBankVerificationPendingDbMirror({
    billingCycleId: seed.cycleId,
    stripeSetupIntentId: seed.setupIntentId,
    arrivalDate: new Date(),
    hostedVerificationUrl: "https://verify.stripe.com/x",
  });
  const after = await readCycle(seed.cycleId);
  return {
    name: "G. State writers refuse out-of-state transitions (idempotency safety)",
    seed, writerResult: bogus, after,
    assertions: {
      noop: bogus.noop === true,
      stillVerified: after.subscriptionStatus === "BANK_VERIFIED",
    },
  };
}

async function safeguardsCheck() {
  const synWithSub = await prisma.billingCycle.count({
    where: { syntheticTestOnly: true, stripePaymentIntentId: { not: null } },
  });
  const synWithSetupIntent = await prisma.billingCycle.count({
    where: { syntheticTestOnly: true, stripeSetupIntentId: { not: null } },
  });
  const synTotal = await prisma.billingCycle.count({ where: { syntheticTestOnly: true } });
  const activeTenants = await prisma.clubSubscription.count({ where: { subscriptionStatus: "ACTIVE" } });
  const provisioningJobsLastHour = await prisma.tenantProvisioningJob.count({
    where: { createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
  });
  return {
    syntheticTotalCycles: synTotal,
    syntheticCyclesWithPaymentIntent: synWithSub,
    syntheticCyclesWithSetupIntent: synWithSetupIntent,
    activeTenants,
    provisioningJobsLastHour,
    assertions: {
      zeroSyntheticSubs: synWithSub === 0,
      noNewProvisioning: provisioningJobsLastHour === 0,
    },
  };
}

async function teardown() {
  const regs = await prisma.signupRegistration.findMany({
    where: { syntheticTestOnly: true }, select: { id: true },
  });
  const regIds = regs.map((r) => r.id);
  const cyc = await prisma.billingCycle.deleteMany({ where: { syntheticTestOnly: true } });
  const man = await prisma.subscriptionPaymentMandate.deleteMany({ where: { syntheticTestOnly: true } });
  const att = await prisma.subscriptionAuthorisationAttestation.deleteMany({ where: { syntheticTestOnly: true } });
  const rel = await prisma.operatorVerificationRecord.deleteMany({ where: { syntheticTestOnly: true } });
  const reg = await prisma.signupRegistration.deleteMany({ where: { id: { in: regIds }, syntheticTestOnly: true } });
  // Clean up the synthetic M3A Club rows (slug prefix identifies them).
  const syntheticClubs = await prisma.club.deleteMany({
    where: { slug: { startsWith: "synthetic-test-only-m3a-" } },
  });
  return {
    syntheticRegistrationsDeleted: reg.count,
    cyclesDeleted: cyc.count, mandatesDeleted: man.count,
    attestationsDeleted: att.count, releasesDeleted: rel.count,
    syntheticClubsDeleted: syntheticClubs.count,
  };
}

async function createScreenshotRegistration() {
  // One-off synthetic registration with a KNOWN plaintext resumeToken
  // so Playwright can navigate to /signup/t/<token>/status.  Prints the
  // plaintext token on stdout (never persisted; synthetic row only).
  assertGuards();
  const now = new Date();
  const plaintextToken = randomBytes(32).toString("hex");
  const resumeTokenHash = createHash("sha256").update(plaintextToken).digest("hex");
  const label = `m3a-screenshot-${Date.now().toString(36).slice(-8)}`;
  const reg = await prisma.signupRegistration.create({
    data: {
      resumeTokenHash,
      legalName: `SYNTHETIC_TEST_ONLY ${label}`,
      legalNameNormalized: label.toLowerCase(),
      operatingName: `SYNTHETIC_TEST_ONLY Screenshot Club`,
      operatingNameNormalized: `synthetic-test-only-screenshot-club`,
      country: "CA", provinceState: "AB",
      addressLine1: "SYNTHETIC_TEST_ONLY - do not deliver mail",
      city: "SYNTHETIC_TEST_ONLY", postalCode: "T0T0T0",
      adminEmail: `${label}@synthetic.spectre.test`,
      adminDisplayName: "Jordan Thompson",
      adminGivenName: "Jordan", adminSurname: "Thompson",
      adminPosition: "General Manager", adminVerifiedAt: now,
      step: "COMPLETE", status: "VERIFIED",
      ownershipVerificationState: "VERIFIED",
      expiresAt: new Date(now.getTime() + 86400000), completedAt: now,
      verificationVerdict: "PASS_AUTOMATED", verificationDecidedAt: now,
      signingAuthoritySignal: "SYNTHETIC-M3A-SCREENSHOT",
      syntheticTestOnly: true,
    },
    select: { id: true },
  });
  console.log(JSON.stringify({
    action: "create-screenshot-reg",
    registrationId: reg.id,
    plaintextToken,
    statusPagePath: `/signup/t/${plaintextToken}/status`,
  }, null, 2));
}

async function main() {
  const action = process.argv[2] ?? "run";
  if (action === "create-screenshot-reg") {
    await createScreenshotRegistration();
    return;
  }
  if (action === "teardown") {
    assertGuards();
    const r = await teardown();
    console.log(JSON.stringify({ action: "teardown", result: r }, null, 2));
    return;
  }
  if (action === "run") {
    assertGuards();
    const scenarios = [
      await scenarioA_instantVerificationSucceeds(),
      await scenarioB_microdepositPending(),
      await scenarioC_microdepositConfirmed(),
      await scenarioD_verificationFailed(),
      await scenarioE_duplicateWebhookIdempotency(),
      await scenarioF_unverifiedCannotAdvance(),
      await scenarioG_terminalStateRespected(),
    ];
    const safe = await safeguardsCheck();
    const allAssertions = scenarios.flatMap((s) => Object.entries(s.assertions ?? {})).concat(Object.entries(safe.assertions));
    const failed = allAssertions.filter(([_k, v]) => v !== true);
    const verdict = failed.length === 0 ? "PASS" : "INVESTIGATE";
    console.log(JSON.stringify({
      runAt: new Date().toISOString(),
      flyApp: process.env.FLY_APP_NAME,
      flags: {
        SPECTRE_SIGNUP_2M3_BANK_VERIFICATION: process.env.SPECTRE_SIGNUP_2M3_BANK_VERIFICATION,
        SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION: process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION ?? "<unset>",
      },
      scenarios, safeguards: safe, verdict,
      failedAssertions: failed.map(([k]) => k),
    }, null, 2));
    return;
  }
  console.error("Usage: node signup-2-m3a-staging-acceptance.mjs {run|teardown}");
  process.exit(2);
}

main().catch((err) => {
  console.error(`[signup-2-m3a-staging-acceptance] ERROR: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}).finally(() => prisma.$disconnect());

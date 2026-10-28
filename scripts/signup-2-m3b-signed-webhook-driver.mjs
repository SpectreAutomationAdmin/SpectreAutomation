// SIGNUP-2 M3B (2026-10-27) -- Signed real-Stripe webhook driver.
//
// Runs INSIDE the staging container.  Reads STRIPE_WEBHOOK_SIGNING_SECRET
// from env (never leaves this process), constructs minimal Stripe
// event payloads, signs them with Stripe's canonical scheme
// (`t=<ts>,v1=<hmac-sha256("<ts>.<body>", secret)>`), POSTs them to
// the deployed /api/webhooks/stripe endpoint on localhost.  The
// deployed webhook route then runs the real Stripe SDK's
// constructEvent for verification + the real dispatcher.
//
// Exercises:
//   succeeded, requires_action, setup_failed, canceled
//   duplicate delivery (dedup via event id)
//   out-of-order delivery (succeeded then requires_action -- older)
//   orphan reconciliation (webhook arrives before cycle persists)
//
// Guards:
//   FLY_APP_NAME === "spectre-staging"
//   SPECTRE_SIGNUP_2M3_BANK_VERIFICATION === "1"
//   SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION !== "1"

import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash, createHmac } from "node:crypto";
import http from "node:http";

const prisma = new PrismaClient();
const WEBHOOK_URL = "http://127.0.0.1:3000/api/webhooks/stripe";

function assertGuards() {
  if (process.env.FLY_APP_NAME !== "spectre-staging") {
    throw new Error(`REFUSED: FLY_APP_NAME is '${process.env.FLY_APP_NAME ?? "<unset>"}'`);
  }
  if (process.env.SPECTRE_SIGNUP_2M3_BANK_VERIFICATION !== "1") {
    throw new Error("REFUSED: SPECTRE_SIGNUP_2M3_BANK_VERIFICATION != 1");
  }
  if (process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION === "1") {
    throw new Error("REFUSED: SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION is 1 -- M3B must not run with payment initiation enabled");
  }
  if (!process.env.STRIPE_WEBHOOK_SIGNING_SECRET) {
    throw new Error("REFUSED: STRIPE_WEBHOOK_SIGNING_SECRET unset");
  }
}

/** Build a minimal Stripe event payload. */
function buildEvent({ type, setupIntentId, eventIdSuffix, extraSi = {} }) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: `evt_m3b_${type.replace(/\./g, "_")}_${eventIdSuffix}`,
    object: "event",
    type,
    api_version: "2026-09-30.endive",
    created: nowSec,
    livemode: false,
    data: {
      object: {
        id: setupIntentId,
        object: "setup_intent",
        status: ({
          "setup_intent.succeeded": "succeeded",
          "setup_intent.requires_action": "requires_action",
          "setup_intent.setup_failed": "requires_payment_method",
          "setup_intent.canceled": "canceled",
        })[type] ?? "processing",
        livemode: false,
        ...extraSi,
      },
    },
  };
}

/** Sign a payload the way Stripe signs its own webhooks:
 *    header: `t=<unix-ts>,v1=<hmac-sha256-hex(ts + "." + body, secret)>` */
function signPayload(rawBody) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const secret = process.env.STRIPE_WEBHOOK_SIGNING_SECRET;
  const v1 = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  return `t=${ts},v1=${v1}`;
}

/** POST a signed event to the deployed webhook route on localhost. */
function postSignedWebhook(eventObj) {
  return new Promise((resolve, reject) => {
    const rawBody = JSON.stringify(eventObj);
    const signature = signPayload(rawBody);
    const req = http.request(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(rawBody).toString(),
        "stripe-signature": signature,
      },
    }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

// --- synthetic seed (reuses M3A pattern) ------------------------------

let __SYNTHETIC_CLUB_ID = null;
async function ensureSyntheticClub() {
  if (__SYNTHETIC_CLUB_ID) return __SYNTHETIC_CLUB_ID;
  const slug = `synthetic-test-only-m3b-${Date.now().toString(36)}`;
  const club = await prisma.club.create({
    data: {
      name: "SYNTHETIC_TEST_ONLY M3B",
      slug, stagingDataMode: "SYNTHETIC_DEMO", isDemoTenant: true,
    },
    select: { id: true },
  });
  __SYNTHETIC_CLUB_ID = club.id;
  return club.id;
}

async function seedCycle(scenarioLabel, setupIntentId, initialSubscriptionStatus = "AUTHORISED") {
  const now = new Date();
  const regLabel = `m3b-${scenarioLabel}-${Date.now().toString(36).slice(-8)}`;
  const resumeTokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
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
      adminDisplayName: "Jordan Thompson",
      adminGivenName: "Jordan", adminSurname: "Thompson",
      adminPosition: "General Manager", adminVerifiedAt: now,
      step: "COMPLETE", status: "VERIFIED",
      ownershipVerificationState: "VERIFIED",
      expiresAt: new Date(now.getTime() + 86400000), completedAt: now,
      verificationVerdict: "PASS_AUTOMATED", verificationDecidedAt: now,
      signingAuthoritySignal: "SYNTHETIC-M3B",
      syntheticTestOnly: true,
    },
    select: { id: true },
  });
  const release = await prisma.operatorVerificationRecord.create({
    data: {
      signupRegistrationId: reg.id, concept: "RELEASE", finding: "AUTHORISED",
      evidenceSource: "SYNTHETIC_TEST_ONLY",
      evidenceProvenance: "signup-2-m3b-signed-webhook-driver.mjs",
      evidenceReference: `m3b:${regLabel}`, reason: "SYNTHETIC_TEST_ONLY: M3B acceptance",
      operatorUserId: "SSH_SUPER_ADMIN_M3B", verifiedAt: now, syntheticTestOnly: true,
    },
    select: { id: true },
  });
  await prisma.subscriptionPaymentMandate.create({
    data: {
      signupRegistrationId: reg.id,
      stripeMandateId: `mandate_m3b_${scenarioLabel}_${Date.now().toString(36).slice(-8)}`,
      stripePaymentMethodId: `pm_m3b_${scenarioLabel}_${Date.now().toString(36).slice(-8)}`,
      mandateType: "ACSS_DEBIT", mandateVariant: "INTERVAL", transactionType: "BUSINESS",
      acceptedAt: now,
      mandateTextHash: createHash("sha256").update(`m3b-mandate-${regLabel}`).digest("hex"),
      mandateTextLength: 64, syntheticTestOnly: true,
    },
  });
  const clubId = await ensureSyntheticClub();
  const cycle = await prisma.billingCycle.create({
    data: {
      clubId, periodLabel: `m3b-${regLabel}`,
      startDate: now, endDate: new Date(now.getTime() + 365 * 86400000),
      totalDue: 38000.00, totalPaid: 0.00, status: "OPEN",
      subscriptionStatus: initialSubscriptionStatus,
      source: "STRIPE_ACSS", releasedByOperatorRecordId: release.id,
      stripeSetupIntentId: setupIntentId, syntheticTestOnly: true,
    },
    select: { id: true },
  });
  return { regId: reg.id, cycleId: cycle.id, clubId, setupIntentId };
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

async function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- scenarios --------------------------------------------------------

async function scenario_succeededInstant() {
  const setupIntentId = `seti_m3b_succ_${randomBytes(6).toString("hex")}`;
  const seed = await seedCycle("succ", setupIntentId);
  const event = buildEvent({ type: "setup_intent.succeeded", setupIntentId, eventIdSuffix: randomBytes(6).toString("hex") });
  const res = await postSignedWebhook(event);
  await wait(500);
  const after = await readCycle(seed.cycleId);
  return {
    name: "I. setup_intent.succeeded (instant path) through SIGNED webhook",
    httpStatus: res.statusCode, httpBody: res.body.slice(0, 80),
    eventIdSent: event.id, after,
    assertions: {
      httpOk: res.statusCode === 200,
      status: after.subscriptionStatus === "BANK_VERIFIED",
      bankVerifiedAtSet: after.bankVerifiedAt !== null,
      methodInstant: after.bankVerificationMethod === "INSTANT",
      noSub: after.stripePaymentIntentId === null,
    },
  };
}

async function scenario_requiresActionMicrodeposit() {
  const setupIntentId = `seti_m3b_pending_${randomBytes(6).toString("hex")}`;
  const seed = await seedCycle("pending", setupIntentId);
  const arrivalDate = Math.floor(Date.now() / 1000) + 2 * 86400;
  const event = buildEvent({
    type: "setup_intent.requires_action",
    setupIntentId,
    eventIdSuffix: randomBytes(6).toString("hex"),
    extraSi: {
      next_action: {
        type: "verify_with_microdeposits",
        verify_with_microdeposits: {
          arrival_date: arrivalDate,
          hosted_verification_url: `https://verify.stripe.com/microdeposits/${setupIntentId}`,
          microdeposit_type: "amounts",
        },
      },
    },
  });
  const res = await postSignedWebhook(event);
  await wait(500);
  const after = await readCycle(seed.cycleId);
  return {
    name: "II. setup_intent.requires_action (microdeposit) through SIGNED webhook",
    httpStatus: res.statusCode, httpBody: res.body.slice(0, 80),
    eventIdSent: event.id, after,
    assertions: {
      httpOk: res.statusCode === 200,
      status: after.subscriptionStatus === "BANK_VERIFICATION_PENDING",
      pendingAtSet: after.bankVerificationPendingAt !== null,
      hostedUrlSet: after.bankVerificationHostedUrl?.includes("verify.stripe.com") ?? false,
      noSub: after.stripePaymentIntentId === null,
    },
  };
}

async function scenario_microdepositThenSucceeded() {
  const setupIntentId = `seti_m3b_mdsucc_${randomBytes(6).toString("hex")}`;
  const seed = await seedCycle("mdsucc", setupIntentId);
  // Step 1: requires_action
  const e1 = buildEvent({
    type: "setup_intent.requires_action", setupIntentId,
    eventIdSuffix: randomBytes(6).toString("hex"),
    extraSi: {
      next_action: {
        type: "verify_with_microdeposits",
        verify_with_microdeposits: {
          arrival_date: Math.floor(Date.now() / 1000) + 2 * 86400,
          hosted_verification_url: `https://verify.stripe.com/microdeposits/${setupIntentId}`,
          microdeposit_type: "amounts",
        },
      },
    },
  });
  const r1 = await postSignedWebhook(e1);
  await wait(500);
  // Step 2: succeeded
  const e2 = buildEvent({ type: "setup_intent.succeeded", setupIntentId, eventIdSuffix: randomBytes(6).toString("hex") });
  const r2 = await postSignedWebhook(e2);
  await wait(500);
  const after = await readCycle(seed.cycleId);
  return {
    name: "III. microdeposit pending -> succeeded (two SIGNED webhooks)",
    firstPostHttp: r1.statusCode, secondPostHttp: r2.statusCode,
    e1: e1.id, e2: e2.id, after,
    assertions: {
      firstOk: r1.statusCode === 200,
      secondOk: r2.statusCode === 200,
      status: after.subscriptionStatus === "BANK_VERIFIED",
      methodMicrodeposit: after.bankVerificationMethod === "MICRODEPOSITS",
      pendingAtPreserved: after.bankVerificationPendingAt !== null,
      noSub: after.stripePaymentIntentId === null,
    },
  };
}

async function scenario_setupFailed() {
  const setupIntentId = `seti_m3b_fail_${randomBytes(6).toString("hex")}`;
  const seed = await seedCycle("fail", setupIntentId);
  const event = buildEvent({
    type: "setup_intent.setup_failed", setupIntentId,
    eventIdSuffix: randomBytes(6).toString("hex"),
    extraSi: {
      last_setup_error: { code: "setup_intent_authentication_failure", message: "SYNTHETIC_TEST_ONLY failure" },
    },
  });
  const res = await postSignedWebhook(event);
  await wait(500);
  const after = await readCycle(seed.cycleId);
  return {
    name: "IV. setup_intent.setup_failed through SIGNED webhook",
    httpStatus: res.statusCode, httpBody: res.body.slice(0, 80),
    eventIdSent: event.id, after,
    assertions: {
      httpOk: res.statusCode === 200,
      status: after.subscriptionStatus === "BANK_VERIFICATION_FAILED",
      failedAtSet: after.bankVerificationFailedAt !== null,
      reasonSetupFailed: after.bankVerificationFailureReason === "STRIPE_SETUP_FAILED",
      noSub: after.stripePaymentIntentId === null,
    },
  };
}

async function scenario_canceled() {
  const setupIntentId = `seti_m3b_cancel_${randomBytes(6).toString("hex")}`;
  const seed = await seedCycle("cancel", setupIntentId);
  const event = buildEvent({ type: "setup_intent.canceled", setupIntentId, eventIdSuffix: randomBytes(6).toString("hex") });
  const res = await postSignedWebhook(event);
  await wait(500);
  const after = await readCycle(seed.cycleId);
  return {
    name: "V. setup_intent.canceled through SIGNED webhook",
    httpStatus: res.statusCode, httpBody: res.body.slice(0, 80),
    eventIdSent: event.id, after,
    assertions: {
      httpOk: res.statusCode === 200,
      status: after.subscriptionStatus === "BANK_VERIFICATION_FAILED",
      reasonCanceled: after.bankVerificationFailureReason === "SIGNATORY_CANCELED",
      noSub: after.stripePaymentIntentId === null,
    },
  };
}

async function scenario_duplicateDelivery() {
  const setupIntentId = `seti_m3b_dup_${randomBytes(6).toString("hex")}`;
  const seed = await seedCycle("dup", setupIntentId);
  const event = buildEvent({ type: "setup_intent.succeeded", setupIntentId, eventIdSuffix: randomBytes(6).toString("hex") });
  const r1 = await postSignedWebhook(event);
  await wait(500);
  // RESEND the SAME event id -- webhook route must dedup via P2002 unique index.
  const r2 = await postSignedWebhook(event);
  await wait(500);
  const after = await readCycle(seed.cycleId);
  const persisted = await prisma.stripeWebhookEvent.count({ where: { id: event.id } });
  return {
    name: "VI. Duplicate delivery -- dedup via unique event id",
    firstPostHttp: r1.statusCode, secondPostHttp: r2.statusCode,
    secondBody: r2.body.slice(0, 60), eventId: event.id, after, persistedCount: persisted,
    assertions: {
      firstOk: r1.statusCode === 200,
      secondOk: r2.statusCode === 200,
      secondIsReplay: r2.body.includes("replay"),
      exactlyOneStoredEvent: persisted === 1,
      noSub: after.stripePaymentIntentId === null,
    },
  };
}

async function scenario_outOfOrderDelivery() {
  // Stripe may deliver succeeded BEFORE requires_action in rare cases.
  // The state machine must not regress BANK_VERIFIED -> BANK_VERIFICATION_PENDING.
  const setupIntentId = `seti_m3b_ooo_${randomBytes(6).toString("hex")}`;
  const seed = await seedCycle("ooo", setupIntentId);
  // Deliver succeeded FIRST
  const eSuc = buildEvent({ type: "setup_intent.succeeded", setupIntentId, eventIdSuffix: randomBytes(6).toString("hex") });
  const r1 = await postSignedWebhook(eSuc);
  await wait(500);
  // Then deliver older requires_action
  const eReq = buildEvent({
    type: "setup_intent.requires_action", setupIntentId,
    eventIdSuffix: randomBytes(6).toString("hex"),
    extraSi: {
      next_action: {
        type: "verify_with_microdeposits",
        verify_with_microdeposits: {
          arrival_date: Math.floor(Date.now() / 1000) + 2 * 86400,
          hosted_verification_url: `https://verify.stripe.com/microdeposits/${setupIntentId}`,
          microdeposit_type: "amounts",
        },
      },
    },
  });
  const r2 = await postSignedWebhook(eReq);
  await wait(500);
  const after = await readCycle(seed.cycleId);
  return {
    name: "VII. Out-of-order delivery (succeeded then older requires_action) does NOT regress state",
    firstPostHttp: r1.statusCode, secondPostHttp: r2.statusCode,
    eSuc: eSuc.id, eReq: eReq.id, after,
    assertions: {
      bothOk: r1.statusCode === 200 && r2.statusCode === 200,
      stillVerified: after.subscriptionStatus === "BANK_VERIFIED",
      noRegression: after.subscriptionStatus !== "BANK_VERIFICATION_PENDING",
      noSub: after.stripePaymentIntentId === null,
    },
  };
}

async function scenario_orphanReconciliation() {
  // Deliver setup_intent.succeeded BEFORE the corresponding cycle exists.
  // The dispatcher must leave processedAt=null (deferred); the cycle's
  // persistSignedMandate (or our test's replayDeferredSetupIntentEvents
  // call) must pick it up on first-cycle creation.
  const setupIntentId = `seti_m3b_orphan_${randomBytes(6).toString("hex")}`;
  const event = buildEvent({ type: "setup_intent.succeeded", setupIntentId, eventIdSuffix: randomBytes(6).toString("hex") });
  const r1 = await postSignedWebhook(event);
  await wait(500);
  // Check that the event WAS persisted but is NOT processed.
  const orphan = await prisma.stripeWebhookEvent.findUnique({
    where: { id: event.id },
    select: { id: true, eventType: true, processedAt: true, processingResult: true },
  });
  // Now create the correlating cycle.
  const seed = await seedCycle("orphan", setupIntentId);
  // Fire a SECOND webhook (same event id, which Stripe would also retry) --
  // the dispatcher now finds the cycle and transitions the state.
  // Dedup is on event id, so we send a DIFFERENT event id to simulate
  // the "later re-arrival" that the orphan reconciliation code is also
  // intended to recover from.
  const retryEvent = buildEvent({ type: "setup_intent.succeeded", setupIntentId, eventIdSuffix: randomBytes(6).toString("hex") });
  const r2 = await postSignedWebhook(retryEvent);
  await wait(500);
  const after = await readCycle(seed.cycleId);
  return {
    name: "VIII. Orphan event: webhook arrives BEFORE cycle persists (deferred + recovered)",
    firstPostHttp: r1.statusCode, orphanRow: orphan,
    secondPostHttp: r2.statusCode, retryEvent: retryEvent.id, after,
    assertions: {
      firstOk: r1.statusCode === 200,
      orphanPersisted: orphan !== null,
      orphanDeferred: orphan?.processedAt === null, // not processed on first delivery
      secondOk: r2.statusCode === 200,
      statusAfter: after.subscriptionStatus === "BANK_VERIFIED",
      noSub: after.stripePaymentIntentId === null,
    },
  };
}

async function safeguardsCheck() {
  const synWithSub = await prisma.billingCycle.count({
    where: { syntheticTestOnly: true, stripePaymentIntentId: { not: null } },
  });
  const activeTenants = await prisma.clubSubscription.count({ where: { subscriptionStatus: "ACTIVE" } });
  const provisioningJobsLastHour = await prisma.tenantProvisioningJob.count({
    where: { createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
  });
  return {
    syntheticCyclesWithPaymentIntent: synWithSub, activeTenants, provisioningJobsLastHour,
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
  const clubs = await prisma.club.deleteMany({ where: { slug: { startsWith: "synthetic-test-only-m3b-" } } });
  // Also clean up m3a leftovers if any.
  const clubsA = await prisma.club.deleteMany({ where: { slug: { startsWith: "synthetic-test-only-m3a-" } } });
  // Clean up m3b/m3a webhook events.
  const evt = await prisma.stripeWebhookEvent.deleteMany({ where: { id: { startsWith: "evt_m3b_" } } });
  return {
    syntheticRegistrationsDeleted: reg.count,
    cyclesDeleted: cyc.count, mandatesDeleted: man.count,
    attestationsDeleted: att.count, releasesDeleted: rel.count,
    syntheticClubsM3BDeleted: clubs.count,
    syntheticClubsM3ADeleted: clubsA.count,
    syntheticWebhookEventsDeleted: evt.count,
  };
}

/** Create one synthetic registration + cycle in each of the four
 *  M3 states (via SIGNED webhooks), returning the plaintext resumeTokens
 *  so Playwright can navigate to the status page. */
async function createScreenshotFixtures() {
  assertGuards();
  const fixtures = [];
  const states = [
    { key: "signed", setupStatus: "AUTHORISED", webhook: null },
    { key: "verified", setupStatus: "AUTHORISED", webhook: "setup_intent.succeeded" },
    { key: "pending", setupStatus: "AUTHORISED", webhook: "setup_intent.requires_action" },
    { key: "failed", setupStatus: "AUTHORISED", webhook: "setup_intent.setup_failed" },
  ];
  for (const s of states) {
    const plaintextToken = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(plaintextToken).digest("hex");
    const setupIntentId = `seti_m3b_shot_${s.key}_${randomBytes(6).toString("hex")}`;
    const now = new Date();
    const regLabel = `m3b-shot-${s.key}-${Date.now().toString(36).slice(-6)}`;
    const reg = await prisma.signupRegistration.create({
      data: {
        resumeTokenHash: hash,
        legalName: `SYNTHETIC_TEST_ONLY ${regLabel}`,
        legalNameNormalized: regLabel.toLowerCase(),
        operatingName: `SYNTHETIC_TEST_ONLY Screenshot Club`,
        operatingNameNormalized: `synthetic-test-only-screenshot-club-${s.key}`,
        country: "CA", provinceState: "AB",
        addressLine1: "SYNTHETIC_TEST_ONLY", city: "SYNTHETIC_TEST_ONLY", postalCode: "T0T0T0",
        adminEmail: `${regLabel}@synthetic.spectre.test`,
        adminDisplayName: "Jordan Thompson", adminGivenName: "Jordan", adminSurname: "Thompson",
        adminPosition: "General Manager", adminVerifiedAt: now,
        step: "COMPLETE", status: "VERIFIED", ownershipVerificationState: "VERIFIED",
        expiresAt: new Date(now.getTime() + 86400000), completedAt: now,
        verificationVerdict: "PASS_AUTOMATED", verificationDecidedAt: now,
        signingAuthoritySignal: "SYNTHETIC-M3B-SHOT",
        syntheticTestOnly: true,
      },
      select: { id: true },
    });
    const release = await prisma.operatorVerificationRecord.create({
      data: {
        signupRegistrationId: reg.id, concept: "RELEASE", finding: "AUTHORISED",
        evidenceSource: "SYNTHETIC_TEST_ONLY", evidenceProvenance: "signup-2-m3b-signed-webhook-driver.mjs",
        evidenceReference: `m3b:shot:${s.key}`, reason: "SYNTHETIC_TEST_ONLY: M3B screenshot",
        operatorUserId: "SSH_SUPER_ADMIN_M3B", verifiedAt: now, syntheticTestOnly: true,
      },
      select: { id: true },
    });
    await prisma.subscriptionPaymentMandate.create({
      data: {
        signupRegistrationId: reg.id,
        stripeMandateId: `mandate_m3b_shot_${s.key}_${randomBytes(4).toString("hex")}`,
        stripePaymentMethodId: `pm_m3b_shot_${s.key}_${randomBytes(4).toString("hex")}`,
        mandateType: "ACSS_DEBIT", mandateVariant: "INTERVAL", transactionType: "BUSINESS",
        acceptedAt: now,
        mandateTextHash: createHash("sha256").update(`m3b-mandate-shot-${s.key}`).digest("hex"),
        mandateTextLength: 64, syntheticTestOnly: true,
      },
    });
    const clubId = await ensureSyntheticClub();
    const cycle = await prisma.billingCycle.create({
      data: {
        clubId, periodLabel: `m3b-shot-${s.key}-${randomBytes(4).toString("hex")}`,
        startDate: now, endDate: new Date(now.getTime() + 365 * 86400000),
        totalDue: 38000.00, totalPaid: 0.00, status: "OPEN",
        subscriptionStatus: s.setupStatus, source: "STRIPE_ACSS",
        releasedByOperatorRecordId: release.id,
        stripeSetupIntentId: setupIntentId, syntheticTestOnly: true,
      },
      select: { id: true },
    });
    // Fire SIGNED webhook to transition into the target state.
    if (s.webhook) {
      const extraSi = s.webhook === "setup_intent.requires_action"
        ? { next_action: { type: "verify_with_microdeposits", verify_with_microdeposits: { arrival_date: Math.floor(Date.now()/1000) + 2*86400, hosted_verification_url: `https://verify.stripe.com/microdeposits/${setupIntentId}`, microdeposit_type: "amounts" } } }
        : s.webhook === "setup_intent.setup_failed"
          ? { last_setup_error: { code: "setup_intent_authentication_failure", message: "SYNTHETIC_TEST_ONLY" } }
          : {};
      const event = buildEvent({ type: s.webhook, setupIntentId, eventIdSuffix: randomBytes(6).toString("hex"), extraSi });
      await postSignedWebhook(event);
      await wait(600);
    }
    const after = await readCycle(cycle.id);
    fixtures.push({
      state: s.key, plaintextToken, registrationId: reg.id, cycleId: cycle.id,
      actualSubscriptionStatus: after.subscriptionStatus,
      actualBankMethod: after.bankVerificationMethod,
      stripePaymentIntentId: after.stripePaymentIntentId,
    });
  }
  return fixtures;
}

async function main() {
  const action = process.argv[2] ?? "run";
  if (action === "teardown") {
    assertGuards();
    const r = await teardown();
    console.log(JSON.stringify({ action: "teardown", result: r }, null, 2));
    return;
  }
  if (action === "screenshot-fixtures") {
    const f = await createScreenshotFixtures();
    console.log(JSON.stringify({ action: "screenshot-fixtures", fixtures: f }, null, 2));
    return;
  }
  if (action === "run") {
    assertGuards();
    const scenarios = [
      await scenario_succeededInstant(),
      await scenario_requiresActionMicrodeposit(),
      await scenario_microdepositThenSucceeded(),
      await scenario_setupFailed(),
      await scenario_canceled(),
      await scenario_duplicateDelivery(),
      await scenario_outOfOrderDelivery(),
      await scenario_orphanReconciliation(),
    ];
    const safe = await safeguardsCheck();
    const allAssertions = scenarios.flatMap((s) => Object.entries(s.assertions ?? {})).concat(Object.entries(safe.assertions));
    const failed = allAssertions.filter(([_k, v]) => v !== true);
    const verdict = failed.length === 0 ? "PASS" : "INVESTIGATE";
    console.log(JSON.stringify({
      runAt: new Date().toISOString(),
      flyApp: process.env.FLY_APP_NAME,
      webhookUrl: WEBHOOK_URL,
      flags: {
        SPECTRE_SIGNUP_2M3_BANK_VERIFICATION: process.env.SPECTRE_SIGNUP_2M3_BANK_VERIFICATION,
        SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION: process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION ?? "<unset>",
        SPECTRE_SIGNUP_2E_PAYMENT_LIVE: process.env.SPECTRE_SIGNUP_2E_PAYMENT_LIVE ?? "<unset>",
        SPECTRE_STRIPE_SDK_MODE: process.env.SPECTRE_STRIPE_SDK_MODE ?? "<unset>",
      },
      scenarios, safeguards: safe, verdict,
      failedAssertions: failed.map(([k]) => k),
    }, null, 2));
    return;
  }
  console.error("Usage: node signup-2-m3b-signed-webhook-driver.mjs {run|screenshot-fixtures|teardown}");
  process.exit(2);
}

main().catch((err) => {
  console.error(`[signup-2-m3b-signed-webhook-driver] ERROR: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}).finally(() => prisma.$disconnect());

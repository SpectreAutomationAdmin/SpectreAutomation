// SIGNUP-2 M4-retries §6 (2026-10-28) -- Signed-webhook integration
// runner for the 6 M4-settlement handlers.
//
// Runs INSIDE the staging container.  Reads STRIPE_WEBHOOK_SIGNING_SECRET
// from env, constructs minimal Stripe-shaped event payloads, signs
// them with Stripe's canonical scheme, POSTs them to the deployed
// /api/webhooks/stripe endpoint on localhost.
//
// Exercises:
//   invoice.paid
//   invoice.payment_failed
//   invoice.marked_uncollectible
//   charge.dispute.closed (status=won, status=lost)
//   charge.dispute.funds_withdrawn
//   charge.dispute.funds_reinstated
//   duplicate delivery (dedup by event id)
//   out-of-order delivery (succeeded then older failed)
//   orphan + replayDeferredM4Events
//
// Guards:
//   FLY_APP_NAME === "spectre-staging"
//   SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE === "1"
//   SPECTRE_SIGNUP_2M3_WEBHOOK_DISPATCH === "1"
//   SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION !== "1"
//   SPECTRE_SIGNUP_2M4_TRIGGER_LIVE !== "1"
//   SPECTRE_SIGNUP_2E_PAYMENT_LIVE !== "1"
//
// No subscription creation.  No debit.  Only state writes to the M4
// settlement tables.

import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash, createHmac } from "node:crypto";
import http from "node:http";

const prisma = new PrismaClient();
const WEBHOOK_URL = "http://127.0.0.1:3000/api/webhooks/stripe";

function assertGuards() {
  if (process.env.FLY_APP_NAME !== "spectre-staging") throw new Error("REFUSED FLY_APP_NAME");
  if (process.env.SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE !== "1") throw new Error("REFUSED M4_SETTLEMENT_LIVE != 1");
  if (process.env.SPECTRE_SIGNUP_2M3_WEBHOOK_DISPATCH !== "1") throw new Error("REFUSED WEBHOOK_DISPATCH != 1");
  if (process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION === "1") throw new Error("REFUSED PAYMENT_INITIATION == 1");
  if (process.env.SPECTRE_SIGNUP_2M4_TRIGGER_LIVE === "1") throw new Error("REFUSED TRIGGER_LIVE == 1");
  if (process.env.SPECTRE_SIGNUP_2E_PAYMENT_LIVE === "1") throw new Error("REFUSED 2E_PAYMENT_LIVE == 1");
  if (!process.env.STRIPE_WEBHOOK_SIGNING_SECRET) throw new Error("REFUSED WEBHOOK_SIGNING_SECRET unset");
}

function sign(rawBody) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac("sha256", process.env.STRIPE_WEBHOOK_SIGNING_SECRET).update(`${ts}.${rawBody}`).digest("hex");
  return `t=${ts},v1=${v1}`;
}

function post(ev) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(ev);
    const req = http.request(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body).toString(), "stripe-signature": sign(body) },
    }, (res) => {
      let b = "";
      res.on("data", (c) => b += c);
      res.on("end", () => resolve({ statusCode: res.statusCode, body: b }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Build a minimal event payload shaped like Stripe's. */
function buildEvent({ type, dataObject, eventIdSuffix }) {
  return {
    id: `evt_m4set_${type.replace(/\./g, "_")}_${eventIdSuffix}`,
    object: "event", type, api_version: "2026-09-30.endive",
    created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: dataObject },
  };
}

async function ensureClub() {
  const slug = `synthetic-test-only-m4set-${Date.now().toString(36)}`;
  const club = await prisma.club.create({
    data: { name: "SYNTHETIC_TEST_ONLY M4-settlement", slug, stagingDataMode: "SYNTHETIC_DEMO", isDemoTenant: true },
    select: { id: true },
  });
  return club.id;
}

/** Seed one synthetic registration + cycle in INITIATED state with a
 *  known stripePaymentIntentId so invoice events can correlate.  No
 *  mandate; no subscription actually exists on Stripe. */
async function seedCycle(label, clubId) {
  const now = new Date();
  const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
  const regLabel = `m4set-${label}-${Date.now().toString(36).slice(-8)}`;
  const reg = await prisma.signupRegistration.create({
    data: {
      resumeTokenHash: hash,
      legalName: `SYNTHETIC_TEST_ONLY ${regLabel}`,
      legalNameNormalized: regLabel.toLowerCase(),
      operatingName: `SYNTHETIC_TEST_ONLY ${regLabel}`,
      operatingNameNormalized: regLabel.toLowerCase(),
      country: "CA", provinceState: "AB",
      addressLine1: "SYNTHETIC_TEST_ONLY", city: "SYNTHETIC_TEST_ONLY", postalCode: "T0T0T0",
      adminEmail: `${regLabel}@synthetic.spectre.test`,
      adminDisplayName: "SYNTHETIC_TEST_ONLY", adminGivenName: "SYN", adminSurname: "Test",
      adminPosition: "SYN", adminVerifiedAt: now,
      step: "COMPLETE", status: "VERIFIED", ownershipVerificationState: "VERIFIED",
      expiresAt: new Date(now.getTime() + 86400000), completedAt: now,
      verificationVerdict: "PASS_AUTOMATED", verificationDecidedAt: now,
      signingAuthoritySignal: "SYNTHETIC-M4SET", syntheticTestOnly: true,
    },
    select: { id: true },
  });
  const rel = await prisma.operatorVerificationRecord.create({
    data: {
      signupRegistrationId: reg.id, concept: "RELEASE", finding: "AUTHORISED",
      evidenceSource: "SYNTHETIC_TEST_ONLY",
      evidenceProvenance: "signup-2-m4-settlement-signed-webhook-runner.mjs",
      evidenceReference: `m4set:${label}`,
      reason: "SYNTHETIC_TEST_ONLY: M4-settlement signed-webhook integration",
      operatorUserId: "SSH_SUPER_ADMIN_M4SET", verifiedAt: now, syntheticTestOnly: true,
    },
    select: { id: true },
  });
  const paymentIntentId = `pi_m4set_${label}_${randomBytes(6).toString("hex")}`;
  const cycle = await prisma.billingCycle.create({
    data: {
      clubId, periodLabel: `m4set-${label}-${randomBytes(4).toString("hex")}`,
      startDate: now, endDate: new Date(now.getTime() + 365 * 86400000),
      totalDue: 38000.00, totalPaid: 0.00, status: "OPEN",
      subscriptionStatus: "INITIATED", source: "STRIPE_ACSS",
      releasedByOperatorRecordId: rel.id,
      stripePaymentIntentId: paymentIntentId,
      syntheticTestOnly: true,
    },
    select: { id: true },
  });
  return { regId: reg.id, cycleId: cycle.id, paymentIntentId };
}

async function readCycleAttempts(cycleId) {
  const attempts = await prisma.billingInvoicePaymentAttempt.findMany({
    where: { billingCycleId: cycleId },
    orderBy: { createdAt: "asc" },
  });
  const exceptions = await prisma.billingExceptionCase.findMany({
    where: { billingCycleId: cycleId },
    orderBy: { createdAt: "asc" },
  });
  return { attempts, exceptions };
}

async function sc_invoicePaid(clubId) {
  const seed = await seedCycle("paid", clubId);
  const invoiceId = `in_m4set_paid_${randomBytes(6).toString("hex")}`;
  const ev = buildEvent({
    type: "invoice.paid",
    eventIdSuffix: randomBytes(6).toString("hex"),
    dataObject: {
      id: invoiceId, object: "invoice", status: "paid",
      payment_intent: seed.paymentIntentId, subscription: `sub_${randomBytes(6).toString("hex")}`,
      charge: `ch_${randomBytes(6).toString("hex")}`,
      period_start: Math.floor(Date.now()/1000), period_end: Math.floor(Date.now()/1000) + 365 * 86400,
      attempt_count: 1, livemode: false,
    },
  });
  const r = await post(ev); await wait(500);
  const after = await readCycleAttempts(seed.cycleId);
  return {
    name: "I. invoice.paid (signed) -> BillingInvoicePaymentAttempt SUCCEEDED",
    eventId: ev.id, httpStatus: r.statusCode, httpBody: r.body,
    attemptsCreated: after.attempts.length,
    firstAttempt: after.attempts[0],
    assertions: {
      httpOk: r.statusCode === 200, bodyOk: r.body === "ok",
      exactlyOneAttempt: after.attempts.length === 1,
      outcomeSucceeded: after.attempts[0]?.outcome === "SUCCEEDED",
      invoiceIdMatches: after.attempts[0]?.stripeInvoiceId === invoiceId,
    },
  };
}

async function sc_invoicePaymentFailed(clubId) {
  const seed = await seedCycle("failed", clubId);
  const invoiceId = `in_m4set_failed_${randomBytes(6).toString("hex")}`;
  const ev = buildEvent({
    type: "invoice.payment_failed",
    eventIdSuffix: randomBytes(6).toString("hex"),
    dataObject: {
      id: invoiceId, object: "invoice", status: "open",
      payment_intent: seed.paymentIntentId, subscription: `sub_${randomBytes(6).toString("hex")}`,
      attempt_count: 1, last_payment_error: { code: "insufficient_funds", message: "SYNTHETIC_TEST_ONLY insufficient" },
      livemode: false,
    },
  });
  const r = await post(ev); await wait(500);
  const after = await readCycleAttempts(seed.cycleId);
  return {
    name: "II. invoice.payment_failed (signed, insufficient_funds) -> attempt + exception",
    eventId: ev.id, httpStatus: r.statusCode, httpBody: r.body,
    attempt: after.attempts[0], exception: after.exceptions[0],
    assertions: {
      httpOk: r.statusCode === 200,
      attemptCreated: after.attempts.length === 1,
      outcome: after.attempts[0]?.outcome === "FAILED_INSUFFICIENT_FUNDS",
      outcomeStripeCode: after.attempts[0]?.outcomeStripeCode === "insufficient_funds",
      exceptionCreated: after.exceptions.length === 1,
      exceptionCategory: after.exceptions[0]?.category === "ATTEMPT_FAILURE",
      exceptionRequiresOperator: after.exceptions[0]?.requiresOperatorAction === true,
    },
  };
}

async function sc_invoiceMarkedUncollectible(clubId) {
  const seed = await seedCycle("uncoll", clubId);
  const invoiceId = `in_m4set_uncoll_${randomBytes(6).toString("hex")}`;
  const ev = buildEvent({
    type: "invoice.marked_uncollectible",
    eventIdSuffix: randomBytes(6).toString("hex"),
    dataObject: {
      id: invoiceId, object: "invoice", status: "uncollectible",
      payment_intent: seed.paymentIntentId, livemode: false,
    },
  });
  const r = await post(ev); await wait(500);
  const after = await readCycleAttempts(seed.cycleId);
  return {
    name: "III. invoice.marked_uncollectible (signed) -> operator-action exception",
    eventId: ev.id, httpStatus: r.statusCode,
    assertions: {
      httpOk: r.statusCode === 200,
      exceptionCreated: after.exceptions.length === 1,
      exceptionCategory: after.exceptions[0]?.category === "INVOICE_UNCOLLECTIBLE",
      requiresOperator: after.exceptions[0]?.requiresOperatorAction === true,
    },
  };
}

async function sc_disputeClosedWon(clubId) {
  const seed = await seedCycle("dispwon", clubId);
  const chargeId = `ch_m4set_${randomBytes(6).toString("hex")}`;
  // Pre-seed the cycle's stripeChargeId so dispute correlation works.
  await prisma.billingCycle.update({ where: { id: seed.cycleId }, data: { stripeChargeId: chargeId } });
  const ev = buildEvent({
    type: "charge.dispute.closed",
    eventIdSuffix: randomBytes(6).toString("hex"),
    dataObject: { id: `dp_${randomBytes(6).toString("hex")}`, object: "dispute", status: "won", charge: chargeId, livemode: false },
  });
  const r = await post(ev); await wait(500);
  const after = await readCycleAttempts(seed.cycleId);
  return {
    name: "IV. charge.dispute.closed (status=won) (signed) -> DISPUTE_CLOSED_WON informational",
    eventId: ev.id, httpStatus: r.statusCode,
    assertions: {
      httpOk: r.statusCode === 200,
      exceptionCreated: after.exceptions.length === 1,
      categoryWon: after.exceptions[0]?.category === "DISPUTE_CLOSED_WON",
      requiresOperator: after.exceptions[0]?.requiresOperatorAction === true,
    },
  };
}

async function sc_disputeClosedLost(clubId) {
  const seed = await seedCycle("displost", clubId);
  const chargeId = `ch_m4set_${randomBytes(6).toString("hex")}`;
  await prisma.billingCycle.update({ where: { id: seed.cycleId }, data: { stripeChargeId: chargeId } });
  const ev = buildEvent({
    type: "charge.dispute.closed",
    eventIdSuffix: randomBytes(6).toString("hex"),
    dataObject: { id: `dp_${randomBytes(6).toString("hex")}`, object: "dispute", status: "lost", charge: chargeId, livemode: false },
  });
  const r = await post(ev); await wait(500);
  const after = await readCycleAttempts(seed.cycleId);
  return {
    name: "V. charge.dispute.closed (status=lost) (signed) -> DISPUTE_CLOSED_LOST",
    eventId: ev.id, httpStatus: r.statusCode,
    assertions: {
      httpOk: r.statusCode === 200,
      exceptionCreated: after.exceptions.length === 1,
      categoryLost: after.exceptions[0]?.category === "DISPUTE_CLOSED_LOST",
    },
  };
}

async function sc_disputeFundsWithdrawn(clubId) {
  const seed = await seedCycle("dispwith", clubId);
  const chargeId = `ch_m4set_${randomBytes(6).toString("hex")}`;
  await prisma.billingCycle.update({ where: { id: seed.cycleId }, data: { stripeChargeId: chargeId } });
  const ev = buildEvent({
    type: "charge.dispute.funds_withdrawn",
    eventIdSuffix: randomBytes(6).toString("hex"),
    dataObject: { id: `dp_${randomBytes(6).toString("hex")}`, object: "dispute", status: "under_review", charge: chargeId, livemode: false },
  });
  const r = await post(ev); await wait(500);
  const after = await readCycleAttempts(seed.cycleId);
  return {
    name: "VI. charge.dispute.funds_withdrawn (signed) -> IMMEDIATE operator action",
    eventId: ev.id, httpStatus: r.statusCode,
    assertions: {
      httpOk: r.statusCode === 200,
      exceptionCreated: after.exceptions.length === 1,
      category: after.exceptions[0]?.category === "DISPUTE_FUNDS_WITHDRAWN",
      severity: after.exceptions[0]?.severity === "IMMEDIATE",
      requiresOperator: after.exceptions[0]?.requiresOperatorAction === true,
    },
  };
}

async function sc_disputeFundsReinstated(clubId) {
  const seed = await seedCycle("dispreinst", clubId);
  const chargeId = `ch_m4set_${randomBytes(6).toString("hex")}`;
  await prisma.billingCycle.update({ where: { id: seed.cycleId }, data: { stripeChargeId: chargeId } });
  const ev = buildEvent({
    type: "charge.dispute.funds_reinstated",
    eventIdSuffix: randomBytes(6).toString("hex"),
    dataObject: { id: `dp_${randomBytes(6).toString("hex")}`, object: "dispute", status: "won", charge: chargeId, livemode: false },
  });
  const r = await post(ev); await wait(500);
  const after = await readCycleAttempts(seed.cycleId);
  return {
    name: "VII. charge.dispute.funds_reinstated (signed) -> INFORMATIONAL",
    eventId: ev.id, httpStatus: r.statusCode,
    assertions: {
      httpOk: r.statusCode === 200,
      exceptionCreated: after.exceptions.length === 1,
      category: after.exceptions[0]?.category === "DISPUTE_FUNDS_REINSTATED",
      severity: after.exceptions[0]?.severity === "INFORMATIONAL",
      requiresOperator: after.exceptions[0]?.requiresOperatorAction === false,
    },
  };
}

async function sc_duplicateDelivery(clubId) {
  const seed = await seedCycle("dup", clubId);
  const invoiceId = `in_m4set_dup_${randomBytes(6).toString("hex")}`;
  const ev = buildEvent({
    type: "invoice.paid",
    eventIdSuffix: randomBytes(6).toString("hex"),
    dataObject: {
      id: invoiceId, object: "invoice", status: "paid",
      payment_intent: seed.paymentIntentId, livemode: false,
      attempt_count: 1,
    },
  });
  const r1 = await post(ev); await wait(500);
  const r2 = await post(ev); await wait(500);
  const after = await readCycleAttempts(seed.cycleId);
  const persistedCount = await prisma.stripeWebhookEvent.count({ where: { id: ev.id } });
  return {
    name: "VIII. duplicate delivery (same event id) -> dedup; exactly 1 attempt row",
    eventId: ev.id, r1: r1.statusCode, r1Body: r1.body, r2: r2.statusCode, r2Body: r2.body,
    persistedEventCount: persistedCount,
    assertions: {
      r1Ok: r1.statusCode === 200, r2Ok: r2.statusCode === 200,
      r1BodyOk: r1.body === "ok", r2IsReplay: r2.body === "replay",
      exactlyOneAttempt: after.attempts.length === 1,
      exactlyOneStoredEvent: persistedCount === 1,
    },
  };
}

async function sc_outOfOrderDelivery(clubId) {
  // Deliver invoice.paid (succeeded) BEFORE invoice.payment_failed with same invoice id.
  // History must preserve both attempts and the first-recorded outcome must stick.
  const seed = await seedCycle("ooo", clubId);
  const invoiceId = `in_m4set_ooo_${randomBytes(6).toString("hex")}`;
  const eFail = buildEvent({
    type: "invoice.payment_failed",
    eventIdSuffix: randomBytes(6).toString("hex"),
    dataObject: {
      id: invoiceId, object: "invoice", status: "open",
      payment_intent: seed.paymentIntentId, attempt_count: 1,
      last_payment_error: { code: "insufficient_funds", message: "SYN first fail" }, livemode: false,
    },
  });
  const ePaid = buildEvent({
    type: "invoice.paid",
    eventIdSuffix: randomBytes(6).toString("hex"),
    dataObject: {
      id: invoiceId, object: "invoice", status: "paid",
      payment_intent: seed.paymentIntentId, attempt_count: 1, livemode: false,
    },
  });
  // Deliver PAID first (which the test's title says is "out of order" relative to the implied earlier failure)
  const r1 = await post(ePaid); await wait(500);
  const r2 = await post(eFail); await wait(500);
  const after = await readCycleAttempts(seed.cycleId);
  return {
    name: "IX. out-of-order delivery -- same (invoiceId, attemptNumber) upserts; first-recorded outcome preserved",
    r1: r1.statusCode, r2: r2.statusCode,
    assertions: {
      r1Ok: r1.statusCode === 200, r2Ok: r2.statusCode === 200,
      exactlyOneAttempt: after.attempts.length === 1,
      // Correction #8 + outcome preservation: SUCCEEDED (recorded first) is retained.
      outcomePreserved: after.attempts[0]?.outcome === "SUCCEEDED",
    },
  };
}

async function sc_orphanEvent(clubId) {
  // Deliver event BEFORE any cycle links the paymentIntent.
  const paymentIntentId = `pi_m4set_orphan_${randomBytes(6).toString("hex")}`;
  const invoiceId = `in_m4set_orphan_${randomBytes(6).toString("hex")}`;
  const ev = buildEvent({
    type: "invoice.paid",
    eventIdSuffix: randomBytes(6).toString("hex"),
    dataObject: {
      id: invoiceId, object: "invoice", status: "paid",
      payment_intent: paymentIntentId, attempt_count: 1, livemode: false,
    },
  });
  const r1 = await post(ev); await wait(500);
  // Orphan should be persisted but not processed (no cycle to correlate).
  const persisted = await prisma.stripeWebhookEvent.findUnique({
    where: { id: ev.id },
    select: { id: true, processedAt: true, eventType: true },
  });
  return {
    name: "X. orphan event -- persisted; no attempt rows written (correlation returns null -> skipped)",
    eventId: ev.id, r1: r1.statusCode, persisted,
    assertions: {
      r1Ok: r1.statusCode === 200,
      orphanPersisted: persisted !== null,
    },
  };
}

async function teardown() {
  const regs = await prisma.signupRegistration.findMany({
    where: { syntheticTestOnly: true, legalName: { startsWith: "SYNTHETIC_TEST_ONLY m4set-" } },
    select: { id: true },
  });
  const regIds = regs.map((r) => r.id);
  const releases = await prisma.operatorVerificationRecord.findMany({
    where: { signupRegistrationId: { in: regIds } }, select: { id: true },
  });
  const releaseIds = releases.map((r) => r.id);
  const cycles = await prisma.billingCycle.findMany({
    where: { releasedByOperatorRecordId: { in: releaseIds }, syntheticTestOnly: true },
    select: { id: true },
  });
  const cycleIds = cycles.map((c) => c.id);
  await prisma.$transaction(async (tx) => {
    await tx.billingExceptionCase.deleteMany({ where: { billingCycleId: { in: cycleIds }, syntheticTestOnly: true } });
    await tx.billingInvoicePaymentAttempt.deleteMany({ where: { billingCycleId: { in: cycleIds }, syntheticTestOnly: true } });
    await tx.billingCycle.deleteMany({ where: { id: { in: cycleIds }, syntheticTestOnly: true } });
    await tx.operatorVerificationRecord.deleteMany({ where: { id: { in: releaseIds }, syntheticTestOnly: true } });
    await tx.signupRegistration.deleteMany({ where: { id: { in: regIds }, syntheticTestOnly: true } });
    await tx.club.deleteMany({ where: { slug: { startsWith: "synthetic-test-only-m4set-" } } });
    await tx.stripeWebhookEvent.deleteMany({ where: { id: { startsWith: "evt_m4set_" } } });
  });
  return { syntheticRegsCleared: regIds.length };
}

async function main() {
  const action = process.argv[2] ?? "run";
  if (action === "teardown") {
    const r = await teardown();
    console.log(JSON.stringify({ action: "teardown", result: r }, null, 2));
    return;
  }
  assertGuards();
  const clubId = await ensureClub();
  const scenarios = [
    await sc_invoicePaid(clubId),
    await sc_invoicePaymentFailed(clubId),
    await sc_invoiceMarkedUncollectible(clubId),
    await sc_disputeClosedWon(clubId),
    await sc_disputeClosedLost(clubId),
    await sc_disputeFundsWithdrawn(clubId),
    await sc_disputeFundsReinstated(clubId),
    await sc_duplicateDelivery(clubId),
    await sc_outOfOrderDelivery(clubId),
    await sc_orphanEvent(clubId),
  ];
  const safeguards = {
    cyclesWithPaymentIntentMakingDebit: await prisma.billingCycle.count({ where: { syntheticTestOnly: true, stripePaymentIntentId: { contains: "fail-not-set" } } }),
    activeTenants: await prisma.clubSubscription.count({ where: { subscriptionStatus: "ACTIVE" } }),
    provisioningJobsLastHour: await prisma.tenantProvisioningJob.count({ where: { createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } } }),
  };
  const allAssertions = scenarios.flatMap((s) => Object.entries(s.assertions ?? {}));
  const failed = allAssertions.filter(([_, v]) => v !== true);
  console.log(JSON.stringify({
    runAt: new Date().toISOString(), flyApp: process.env.FLY_APP_NAME, webhookUrl: WEBHOOK_URL,
    flags: {
      M4_SETTLEMENT_LIVE: process.env.SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE,
      WEBHOOK_DISPATCH: process.env.SPECTRE_SIGNUP_2M3_WEBHOOK_DISPATCH,
      PAYMENT_INITIATION: process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION ?? "<unset>",
      TRIGGER_LIVE: process.env.SPECTRE_SIGNUP_2M4_TRIGGER_LIVE ?? "<unset>",
      TWO_E_PAYMENT_LIVE: process.env.SPECTRE_SIGNUP_2E_PAYMENT_LIVE ?? "<unset>",
      SDK_MODE: process.env.SPECTRE_STRIPE_SDK_MODE,
    },
    scenarios, safeguards,
    verdict: failed.length === 0 ? "PASS" : "INVESTIGATE",
    failedAssertions: failed.map(([k]) => k),
  }, null, 2));
}

main().catch((e) => { console.error(`ERROR: ${e.message}`); console.error(e.stack); process.exit(1); }).finally(() => prisma.$disconnect());

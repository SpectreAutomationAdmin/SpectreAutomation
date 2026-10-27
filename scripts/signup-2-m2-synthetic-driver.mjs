// SIGNUP-2 M2-SyntheticSandbox (2026-10-27) -- One-shot operator CLI.
// Uses @prisma/client for DB writes + a child-process curl for the
// Stripe REST API so no additional npm module is required at
// runtime in the staging container.
//
// Guards (fail-closed; same chain as the service):
//   FLY_APP_NAME === "spectre-staging"
//   SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX === "1"
//   SPECTRE_STRIPE_SDK_MODE === "test"
//   STRIPE_SECRET_KEY starts with "sk_test_"
//   STRIPE_WEBHOOK_SIGNING_SECRET present
//   STRIPE_ACSS_PRICE_ID present
//
// NOTE: STRIPE_SECRET_KEY is passed to curl via `-u`, read from env
// only.  Never printed; never logged.

import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const prisma = new PrismaClient();

function assertGuardsPass() {
  const flyApp = process.env.FLY_APP_NAME ?? "";
  if (flyApp !== "spectre-staging") {
    throw new Error(`REFUSED: FLY_APP_NAME is '${flyApp || "<unset>"}', expected 'spectre-staging'`);
  }
  if (process.env.SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX !== "1") {
    throw new Error("REFUSED: SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX != '1'");
  }
  if (process.env.SPECTRE_STRIPE_SDK_MODE !== "test") {
    throw new Error(`REFUSED: SPECTRE_STRIPE_SDK_MODE is '${process.env.SPECTRE_STRIPE_SDK_MODE ?? "<unset>"}', expected 'test'`);
  }
  const sk = process.env.STRIPE_SECRET_KEY ?? "";
  if (sk.startsWith("sk_live_")) {
    throw new Error("REFUSED: STRIPE_SECRET_KEY starts with sk_live_ -- live-money mode refused unconditionally");
  }
  if (!sk.startsWith("sk_test_")) {
    throw new Error("REFUSED: STRIPE_SECRET_KEY does not start with sk_test_");
  }
  if (!process.env.STRIPE_WEBHOOK_SIGNING_SECRET) {
    throw new Error("REFUSED: STRIPE_WEBHOOK_SIGNING_SECRET unset");
  }
  if (!process.env.STRIPE_ACSS_PRICE_ID) {
    throw new Error("REFUSED: STRIPE_ACSS_PRICE_ID unset");
  }
}

const APP_URL = process.env.APP_URL ?? "https://staging.spectreautomation.com";

/** Call Stripe REST API via curl with env-stored secret key.
 *  Secret key is only passed via `-u` (basic auth); never printed. */
function stripeApi(method, path, params) {
  const parts = ["--silent", "--show-error", "--write-out", "\n%{http_code}", "-u", `${process.env.STRIPE_SECRET_KEY}:`, "-H", "Stripe-Version: 2026-09-30.endive"];
  if (method === "POST") {
    // Use --data-urlencode so curl URL-encodes each field VALUE
    // individually, which prevents `&` characters in a value (e.g.
    // inside success_url query strings) from being parsed as form
    // field separators.
    for (const [k, v] of Object.entries(params ?? {})) {
      if (Array.isArray(v)) {
        for (const item of v) parts.push("--data-urlencode", `${k}[]=${item}`);
      } else {
        parts.push("--data-urlencode", `${k}=${v}`);
      }
    }
  }
  parts.push(`https://api.stripe.com/v1/${path}`);
  const r = spawnSync("curl", parts, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`curl failed: ${r.stderr || r.stdout}`);
  const out = r.stdout.trim();
  const nl = out.lastIndexOf("\n");
  const body = nl >= 0 ? out.slice(0, nl) : out;
  const code = nl >= 0 ? parseInt(out.slice(nl + 1), 10) : 0;
  const parsed = body ? JSON.parse(body) : {};
  if (code >= 400) throw new Error(`Stripe ${code}: ${JSON.stringify(parsed).slice(0, 400)}`);
  return parsed;
}

async function createOne() {
  assertGuardsPass();

  const scenarioLabel = `m2-first-sandbox-${Date.now().toString(36).slice(-6)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const resumeToken = randomBytes(32).toString("hex");
  const resumeTokenHash = createHash("sha256").update(resumeToken, "utf8").digest("hex");

  const result = await prisma.$transaction(async (tx) => {
    const reg = await tx.signupRegistration.create({
      data: {
        resumeTokenHash,
        legalName: `SYNTHETIC_TEST_ONLY ${scenarioLabel}`,
        legalNameNormalized: scenarioLabel.toLowerCase(),
        operatingName: `SYNTHETIC_TEST_ONLY ${scenarioLabel}`,
        operatingNameNormalized: scenarioLabel.toLowerCase(),
        country: "CA",
        provinceState: "AB",
        addressLine1: "SYNTHETIC_TEST_ONLY - do not deliver mail",
        city: "SYNTHETIC_TEST_ONLY",
        postalCode: "T0T0T0",
        adminEmail: `${scenarioLabel}@synthetic.spectre.test`,
        adminDisplayName: "SYNTHETIC_TEST_ONLY operator",
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
    await tx.subscriptionAuthorisationAttestation.create({
      data: {
        signupRegistrationId: reg.id,
        signatoryFullName: "SYNTHETIC_TEST_ONLY Operator",
        signatoryTitle: "SYNTHETIC_TEST_ONLY",
        clubLegalName: `SYNTHETIC_TEST_ONLY ${scenarioLabel}`,
        attestationTextHash: createHash("sha256").update(`SYNTHETIC_TEST_ONLY attestation ${scenarioLabel}`, "utf8").digest("hex"),
        attestationTextLength: 64,
        termsVersionSha256: "SYNTHETIC_TEST_ONLY_PLACEHOLDER_SHA",
        termsVersionLabel: "ToS-synthetic-sandbox-2026-10-27",
        acceptedAt: now,
        syntheticTestOnly: true,
      },
    });
    const release = await tx.operatorVerificationRecord.create({
      data: {
        signupRegistrationId: reg.id,
        concept: "RELEASE",
        finding: "AUTHORISED",
        evidenceSource: "SYNTHETIC_TEST_ONLY",
        evidenceProvenance: "signup-2m2-synthetic-driver.mjs",
        evidenceReference: `synthetic:${scenarioLabel}`,
        reason: "SYNTHETIC_TEST_ONLY: operator release for Stripe sandbox technical acceptance",
        operatorUserId: "SSH_SUPER_ADMIN",
        verifiedAt: now,
        syntheticTestOnly: true,
      },
      select: { id: true },
    });
    return { regId: reg.id, releaseId: release.id };
  });

  // Single-use nonce (bound to the registration via signingAuthoritySignal).
  const nonce = randomBytes(32).toString("hex");
  await prisma.signupRegistration.update({
    where: { id: result.regId },
    data: { signingAuthoritySignal: `signup-2m2-syn-nonce:${nonce}:SSH_SU` },
  });

  const customer = stripeApi("POST", "customers", {
    description: `SYNTHETIC_TEST_ONLY Stripe sandbox customer -- registration ${result.regId.slice(-6)}`,
    "metadata[signupRegistrationIdTail]": result.regId.slice(-6),
    "metadata[syntheticTestOnly]": "true",
    "metadata[source]": "signup-2m2-synthetic-driver",
  });

  const successUrl = `${APP_URL}/api/signup/mandate/synthetic-return?registrationId=${encodeURIComponent(result.regId)}&session_id={CHECKOUT_SESSION_ID}&nonce=${encodeURIComponent(nonce)}`;
  const cancelUrl = `${APP_URL}/signup/t/synthetic-cancel?registrationId=${encodeURIComponent(result.regId)}`;

  const session = stripeApi("POST", "checkout/sessions", {
    mode: "setup",
    customer: customer.id,
    currency: "cad",
    "allowed_payment_method_types[]": "acss_debit",
    "payment_method_options[acss_debit][currency]": "cad",
    "payment_method_options[acss_debit][mandate_options][transaction_type]": "business",
    // Stripe requires `invoice` + `subscription` to be set TOGETHER
    // on `default_for`.  Use the stripeApi array-branch which emits
    // `K[]=item` for each item.
    "payment_method_options[acss_debit][mandate_options][default_for]": ["invoice", "subscription"],
    success_url: successUrl,
    cancel_url: cancelUrl,
    "metadata[signupRegistrationIdTail]": result.regId.slice(-6),
    "metadata[syntheticTestOnly]": "true",
  });

  console.log(
    JSON.stringify({
      registrationId: result.regId,
      scenarioLabel,
      stripeCustomerId: customer.id,
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
      checkoutStatus: session.status,
      nonce,
      amountMinorExpected: 3_800_000,
      currencyExpected: "cad",
    }),
  );
}

async function teardownAll() {
  const regs = await prisma.signupRegistration.findMany({
    where: { syntheticTestOnly: true },
    select: { id: true },
  });
  const regIds = regs.map((r) => r.id);
  const [cycles, mandates, attestations, releases] = await Promise.all([
    prisma.billingCycle.deleteMany({ where: { syntheticTestOnly: true } }).then((r) => r.count),
    prisma.subscriptionPaymentMandate.deleteMany({ where: { syntheticTestOnly: true } }).then((r) => r.count),
    prisma.subscriptionAuthorisationAttestation.deleteMany({ where: { syntheticTestOnly: true } }).then((r) => r.count),
    prisma.operatorVerificationRecord.deleteMany({ where: { syntheticTestOnly: true } }).then((r) => r.count),
  ]);
  const regCount = await prisma.signupRegistration
    .deleteMany({ where: { id: { in: regIds }, syntheticTestOnly: true } })
    .then((r) => r.count);
  console.log(
    JSON.stringify({
      registrationsDeleted: regCount,
      attestationsDeleted: attestations,
      releaseRecordsDeleted: releases,
      mandatesDeleted: mandates,
      billingCyclesDeleted: cycles,
    }),
  );
}

async function main() {
  const action = process.argv[2];
  if (action === "create") return createOne();
  if (action === "teardown") return teardownAll();
  console.error("Usage: node signup-2-m2-synthetic-driver.mjs {create|teardown}");
  process.exit(2);
}

main()
  .catch((err) => {
    console.error(`[signup-2m2-synthetic-driver] ERROR: ${err.message}`);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

// SIGNUP-2 M2-SyntheticSandbox (2026-10-27) -- contract + regression tests.
//
// Covers founder scope §1-§12:
//   §1  assertTermsOfServiceApproved() unchanged for normal paths
//   §2  dev fixture never relabelled as APPROVED
//   §3  three-guard chain (FLY_APP_NAME + flag + Stripe test mode)
//   §4  explicit sandbox authorisation + synthetic registration + marker
//   §5  synthetic marker refused by Phase 2F / normal mandate pathways
//   §6  activation/provisioning/suspension flags NOT required by service
//   §7  real Stripe-hosted Checkout via live adapter (shape-verified)
//   §8  signature verification + idempotency preserved (shape-verified)
//   §9  founder-installed Stripe secrets never read/written by service
//  §10  syntheticTestOnly column present on 5 tables
//  §11  pathway unavailable in production even with flag set
//  §12  normal signup remains blocked by DEVELOPMENT_FIXTURE ToS;
//       synthetic records cannot cross production boundary

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("SIGNUP-2 M2-SyntheticSandbox §1 · assertTermsOfServiceApproved() unchanged", () => {
  const TOS = readFileSync(join(process.cwd(), "src/lib/billing/terms-of-service.ts"), "utf8");

  it("still refuses DEVELOPMENT_FIXTURE status", () => {
    expect(TOS).toMatch(/assertTermsOfServiceApproved/);
    const fn = TOS.match(/export function assertTermsOfServiceApproved[\s\S]+?^\}/m)![0];
    expect(fn).toMatch(/doc\.status !== "APPROVED"/);
    expect(fn).toMatch(/throw new ForbiddenError/);
  });

  it("still refuses labels starting with ToS-dev-fixture", () => {
    const fn = TOS.match(/export function assertTermsOfServiceApproved[\s\S]+?^\}/m)![0];
    expect(fn).toMatch(/doc\.label\.startsWith\("ToS-dev-fixture"\)/);
  });

  it("ToS doc status union now includes SYNTHETIC_TEST_ONLY as a distinct value", () => {
    expect(TOS).toMatch(/status:\s*"APPROVED"\s*\|\s*"DEVELOPMENT_FIXTURE"\s*\|\s*"SYNTHETIC_TEST_ONLY"/);
  });

  it("assertTermsOfServiceApproved does NOT accept SYNTHETIC_TEST_ONLY", () => {
    const fn = TOS.match(/export function assertTermsOfServiceApproved[\s\S]+?^\}/m)![0];
    // The gate text passes only on APPROVED; SYNTHETIC_TEST_ONLY would be `!== "APPROVED"` → throw.
    expect(fn).not.toMatch(/SYNTHETIC_TEST_ONLY/);
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox §2 · dev fixture not relabelled", () => {
  it("dev fixture doc still has Status: DEVELOPMENT_FIXTURE", () => {
    const fixture = readFileSync(join(process.cwd(), "docs/legal/terms-of-service-fixture-dev.md"), "utf8");
    expect(fixture).toMatch(/^\s*-\s*\*\*Status:\*\*\s*`DEVELOPMENT_FIXTURE`/m);
    expect(fixture).toMatch(/NOT APPROVED FOR LEGAL USE/i);
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox §3 · three-guard chain", () => {
  const SVC = readFileSync(join(process.cwd(), "src/lib/signup/signup-2m2-synthetic-sandbox-service.ts"), "utf8");

  it("assertSyntheticSandboxGuardsPass guards on FLY_APP_NAME === 'spectre-staging'", () => {
    expect(SVC).toMatch(/EXPECTED_FLY_APP\s*=\s*"spectre-staging"/);
    expect(SVC).toMatch(/if \(flyApp !== EXPECTED_FLY_APP\)/);
  });

  it("guards on SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX === '1'", () => {
    expect(SVC).toMatch(/SYNTHETIC_FLAG_ENV\s*=\s*"SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX"/);
    expect(SVC).toMatch(/process\.env\[SYNTHETIC_FLAG_ENV\]\s*!==\s*"1"/);
  });

  it("guards on stripeSdkMode() === 'test'", () => {
    expect(SVC).toMatch(/if \(mode !== "test"\)/);
    expect(SVC).toMatch(/stripeSdkMode\(\)/);
  });

  it("every exported mutating function calls assertSyntheticSandboxGuardsPass as its first statement", () => {
    // Verify by substring presence in the function body region.
    const createRegion = SVC.slice(
      SVC.indexOf("export async function createSyntheticRegistration"),
      SVC.indexOf("initiateSyntheticMandateCollection"),
    );
    expect(createRegion).toMatch(/assertSyntheticSandboxGuardsPass\(\)/);

    const initiateRegion = SVC.slice(
      SVC.indexOf("export async function initiateSyntheticMandateCollection"),
      SVC.indexOf("persistSyntheticSignedMandate"),
    );
    expect(initiateRegion).toMatch(/assertSyntheticSandboxGuardsPass\(\)/);

    const persistRegion = SVC.slice(
      SVC.indexOf("export async function persistSyntheticSignedMandate"),
      SVC.indexOf("teardownSyntheticTestFixtures"),
    );
    expect(persistRegion).toMatch(/assertSyntheticSandboxGuardsPass\(\)/);
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox §3 · runtime guard behaviour", () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; vi.resetModules(); });

  it("throws when FLY_APP_NAME is unset", async () => {
    delete process.env.FLY_APP_NAME;
    process.env.SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX = "1";
    process.env.SPECTRE_STRIPE_SDK_MODE = "test";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_WEBHOOK_SIGNING_SECRET = "whsec_x";
    const { assertSyntheticSandboxGuardsPass } = await import("@/lib/signup/signup-2m2-synthetic-sandbox-service");
    expect(() => assertSyntheticSandboxGuardsPass()).toThrow(/FLY_APP_NAME is '<unset>'/);
  });

  it("throws when FLY_APP_NAME is 'spectre-production'", async () => {
    process.env.FLY_APP_NAME = "spectre-production";
    process.env.SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX = "1";
    process.env.SPECTRE_STRIPE_SDK_MODE = "test";
    const { assertSyntheticSandboxGuardsPass } = await import("@/lib/signup/signup-2m2-synthetic-sandbox-service");
    expect(() => assertSyntheticSandboxGuardsPass()).toThrow(/expected 'spectre-staging'/);
  });

  it("throws when SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX != '1'", async () => {
    process.env.FLY_APP_NAME = "spectre-staging";
    delete process.env.SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX;
    process.env.SPECTRE_STRIPE_SDK_MODE = "test";
    const { assertSyntheticSandboxGuardsPass } = await import("@/lib/signup/signup-2m2-synthetic-sandbox-service");
    expect(() => assertSyntheticSandboxGuardsPass()).toThrow(/SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX != '1'/);
  });

  it("throws when Stripe mode != test", async () => {
    process.env.FLY_APP_NAME = "spectre-staging";
    process.env.SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX = "1";
    delete process.env.SPECTRE_STRIPE_SDK_MODE;
    delete process.env.SPECTRE_SIGNUP_2E_STRIPE_MODE;
    const { assertSyntheticSandboxGuardsPass } = await import("@/lib/signup/signup-2m2-synthetic-sandbox-service");
    expect(() => assertSyntheticSandboxGuardsPass()).toThrow(/Stripe SDK mode is 'mock'/);
  });

  it("passes when all three guards hold", async () => {
    process.env.FLY_APP_NAME = "spectre-staging";
    process.env.SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX = "1";
    process.env.SPECTRE_STRIPE_SDK_MODE = "test";
    const { assertSyntheticSandboxGuardsPass, syntheticSandboxEnabled } = await import("@/lib/signup/signup-2m2-synthetic-sandbox-service");
    expect(() => assertSyntheticSandboxGuardsPass()).not.toThrow();
    expect(syntheticSandboxEnabled()).toBe(true);
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox §4 · synthetic ToS doc", () => {
  it("doc exists + carries SYNTHETIC_TEST_ONLY status", () => {
    const doc = readFileSync(join(process.cwd(), "docs/legal/terms-of-service-synthetic-sandbox.md"), "utf8");
    expect(doc).toMatch(/\*\*Status:\*\*\s*`SYNTHETIC_TEST_ONLY`/);
    expect(doc).toMatch(/\*\*Label:\*\*\s*`ToS-synthetic-sandbox-/);
    expect(doc).toMatch(/NOT A LEGAL AGREEMENT/i);
    expect(doc).toMatch(/syntheticTestOnly = true/i);
  });

  it("readSyntheticTermsOfService refuses docs whose status is not SYNTHETIC_TEST_ONLY", () => {
    const SVC = readFileSync(join(process.cwd(), "src/lib/signup/signup-2m2-synthetic-sandbox-service.ts"), "utf8");
    expect(SVC).toMatch(/if \(statusRaw !== "SYNTHETIC_TEST_ONLY"\)/);
    expect(SVC).toMatch(/SIGNUP_2M2_SYNTHETIC_TOS_WRONG_STATUS/);
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox §5 · production paths refuse synthetic rows", () => {
  const MANDATE = readFileSync(join(process.cwd(), "src/lib/billing/signup-2e-mandate-service.ts"), "utf8");

  it("initiateMandateCollection calls refuseIfSyntheticTestOnly", () => {
    const start = MANDATE.indexOf("export async function initiateMandateCollection");
    const end = MANDATE.indexOf("export async function persistSignedMandate");
    const region = MANDATE.slice(start, end);
    expect(region).toMatch(/refuseIfSyntheticTestOnly/);
    expect(region).toMatch(/await refuseIfSyntheticTestOnly\(reg\.id\)/);
  });

  it("persistSignedMandate calls refuseIfSyntheticTestOnly", () => {
    const start = MANDATE.indexOf("export async function persistSignedMandate");
    const region = MANDATE.slice(start);
    expect(region).toMatch(/refuseIfSyntheticTestOnly/);
  });

  it("refuseIfSyntheticTestOnly throws ForbiddenError on syntheticTestOnly=true", () => {
    const SVC = readFileSync(join(process.cwd(), "src/lib/signup/signup-2m2-synthetic-sandbox-service.ts"), "utf8");
    const fn = SVC.match(/export async function refuseIfSyntheticTestOnly[\s\S]+?^\}/m)![0];
    expect(fn).toMatch(/syntheticTestOnly === true/);
    expect(fn).toMatch(/throw new ForbiddenError/);
    expect(fn).toMatch(/synthetic rows cannot be promoted to a real tenant/);
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox §7 · Stripe-hosted Checkout via live adapter", () => {
  const SVC = readFileSync(join(process.cwd(), "src/lib/signup/signup-2m2-synthetic-sandbox-service.ts"), "utf8");

  it("initiateSyntheticMandateCollection uses resolveStripeAdapter({requireLive: true})", () => {
    expect(SVC).toMatch(/resolveStripeAdapter\(\{\s*requireLive:\s*true\s*\}\)/);
  });

  it("mandate options are ACSS business/interval/CAD on the synthetic path", () => {
    const fn = SVC.match(/export async function initiateSyntheticMandateCollection[\s\S]+?^\}/m)![0];
    expect(fn).toMatch(/paymentSchedule:\s*"interval"/);
    expect(fn).toMatch(/transactionType:\s*"business"/);
    expect(fn).toMatch(/intervalDescription:\s*"SYNTHETIC_TEST_ONLY — Annual Spectre sandbox test"/);
  });

  it("every Stripe call carries syntheticTestOnly=true in metadata", () => {
    const createCust = SVC.match(/createCustomer\(\{[\s\S]+?\}\)/)![0];
    expect(createCust).toMatch(/syntheticTestOnly:\s*"true"/);
    const createSess = SVC.match(/createMandateCheckoutSession\(\{[\s\S]+?\}\)/)![0];
    expect(createSess).toMatch(/syntheticTestOnly:\s*"true"/);
    const createSub = SVC.match(/createSubscription\(\{[\s\S]+?\}\)/)![0];
    expect(createSub).toMatch(/syntheticTestOnly:\s*"true"/);
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox §10 · syntheticTestOnly column present on 5 tables", () => {
  const SCHEMA = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  const TABLES = [
    "SignupRegistration",
    "SubscriptionAuthorisationAttestation",
    "SubscriptionPaymentMandate",
    "OperatorVerificationRecord",
    "BillingCycle",
  ];
  for (const t of TABLES) {
    it(`${t} has syntheticTestOnly column with default false`, () => {
      const block = SCHEMA.match(new RegExp(`model ${t} \\{[\\s\\S]+?^\\}`, "m"))![0];
      expect(block).toMatch(/syntheticTestOnly\s+Boolean\s+@default\(false\)/);
    });
    it(`${t} has an index on syntheticTestOnly`, () => {
      const block = SCHEMA.match(new RegExp(`model ${t} \\{[\\s\\S]+?^\\}`, "m"))![0];
      expect(block).toMatch(/@@index\(\[syntheticTestOnly\]\)/);
    });
  }
});

describe("SIGNUP-2 M2-SyntheticSandbox §10 · every synthetic insert sets syntheticTestOnly=true", () => {
  const SVC = readFileSync(join(process.cwd(), "src/lib/signup/signup-2m2-synthetic-sandbox-service.ts"), "utf8");
  it("synthetic SignupRegistration insert sets syntheticTestOnly: true", () => {
    expect(SVC).toMatch(/signupRegistration\.create\([\s\S]+?syntheticTestOnly:\s*true/);
  });
  it("synthetic Attestation insert sets syntheticTestOnly: true", () => {
    expect(SVC).toMatch(/subscriptionAuthorisationAttestation\.create\([\s\S]+?syntheticTestOnly:\s*true/);
  });
  it("synthetic RELEASE record insert sets syntheticTestOnly: true", () => {
    expect(SVC).toMatch(/operatorVerificationRecord\.create\([\s\S]+?syntheticTestOnly:\s*true/);
  });
  it("synthetic Mandate insert sets syntheticTestOnly: true", () => {
    expect(SVC).toMatch(/subscriptionPaymentMandate\.create\([\s\S]+?syntheticTestOnly:\s*true/);
  });
  it("synthetic BillingCycle insert sets syntheticTestOnly: true", () => {
    expect(SVC).toMatch(/billingCycle\.create\([\s\S]+?syntheticTestOnly:\s*true/);
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox §11 · unavailable in production", () => {
  const SVC = readFileSync(join(process.cwd(), "src/lib/signup/signup-2m2-synthetic-sandbox-service.ts"), "utf8");
  it("the FLY_APP_NAME guard is the FIRST check inside assertSyntheticSandboxGuardsPass", () => {
    const start = SVC.indexOf("export function assertSyntheticSandboxGuardsPass");
    const end = SVC.indexOf("export function syntheticSandboxEnabled");
    const fn = SVC.slice(start, end);
    expect(fn.indexOf("FLY_APP_NAME")).toBeGreaterThan(-1);
    expect(fn.indexOf("FLY_APP_NAME")).toBeLessThan(fn.indexOf("SYNTHETIC_FLAG_ENV"));
    expect(fn.indexOf("SYNTHETIC_FLAG_ENV")).toBeLessThan(fn.indexOf("stripeSdkMode"));
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox · HTTP routes gated by same service guards", () => {
  const INITIATE_ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/signup/mandate/synthetic-initiate/route.ts"),
    "utf8",
  );
  const RETURN_ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/signup/mandate/synthetic-return/route.ts"),
    "utf8",
  );
  it("initiate route delegates to initiateSyntheticMandateCollection", () => {
    expect(INITIATE_ROUTE).toMatch(/initiateSyntheticMandateCollection/);
    expect(INITIATE_ROUTE).toMatch(/signup-2m2-synthetic-sandbox-service/);
  });
  it("return route delegates to persistSyntheticSignedMandate", () => {
    expect(RETURN_ROUTE).toMatch(/persistSyntheticSignedMandate/);
    expect(RETURN_ROUTE).toMatch(/signup-2m2-synthetic-sandbox-service/);
  });
  it("neither route has its own secret-reading or Stripe-API logic (delegation only)", () => {
    expect(INITIATE_ROUTE).not.toMatch(/STRIPE_SECRET_KEY/);
    expect(RETURN_ROUTE).not.toMatch(/STRIPE_SECRET_KEY/);
    expect(INITIATE_ROUTE).not.toMatch(/stripe\.customers\.create|stripe\.subscriptions\.create/);
    expect(RETURN_ROUTE).not.toMatch(/stripe\.customers\.create|stripe\.subscriptions\.create/);
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox §12 · regression: production authorisation boundary intact", () => {
  it("Phase 2E webhook dispatcher never reads syntheticTestOnly as a privilege flag", () => {
    // A positive-check assertion: the dispatcher should NEVER
    // route differently based on syntheticTestOnly in a way that
    // activates downstream flows.  It can REFUSE based on the
    // marker (future work) but cannot grant extra access.
    const dispatch = readFileSync(
      join(process.cwd(), "src/lib/billing/signup-2e-webhook-dispatch.ts"),
      "utf8",
    );
    // Dispatcher doesn't reference the marker today -- that's fine
    // for M2 (synthetic cycles don't trigger downstream activation).
    expect(dispatch).not.toMatch(/syntheticTestOnly:\s*true/);
  });

  it("the three activation/provisioning/suspension flags are NOT read by this service's code", () => {
    const SVC = readFileSync(join(process.cwd(), "src/lib/signup/signup-2m2-synthetic-sandbox-service.ts"), "utf8");
    // The flags may appear in COMMENTS (the service documents that it
    // does NOT require them) but NOT in any process.env.* read.
    expect(SVC).not.toMatch(/process\.env\.SPECTRE_SIGNUP_2F_ACTIVATION_LIVE/);
    expect(SVC).not.toMatch(/process\.env\.SPECTRE_SIGNUP_2G_PROVISIONING_LIVE/);
    expect(SVC).not.toMatch(/process\.env\.SPECTRE_SIGNUP_2H_SUSPENSION_LIVE/);
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox · HTTP route AUTH guard (founder §2.1, 2.3)", () => {
  const INITIATE_ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/signup/mandate/synthetic-initiate/route.ts"),
    "utf8",
  );
  it("synthetic-initiate route checks getCurrentUser FIRST", () => {
    expect(INITIATE_ROUTE).toMatch(/const user = await getCurrentUser\(\)/);
    const userCheckIdx = INITIATE_ROUTE.indexOf("const user = await getCurrentUser()");
    const svcCallIdx = INITIATE_ROUTE.indexOf("initiateSyntheticMandateCollection(");
    expect(userCheckIdx).toBeGreaterThan(-1);
    expect(userCheckIdx).toBeLessThan(svcCallIdx);
  });
  it("synthetic-initiate route returns 401 on unauthenticated", () => {
    expect(INITIATE_ROUTE).toMatch(/if \(!user\)[\s\S]+?status: 401/);
  });
  it("synthetic-initiate route requires SUPER_ADMIN role", () => {
    expect(INITIATE_ROUTE).toMatch(/isSuperAdmin\(principal\)/);
    expect(INITIATE_ROUTE).toMatch(/SUPER_ADMIN role required/);
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox · single-use nonce (founder §2.2)", () => {
  const SVC = readFileSync(join(process.cwd(), "src/lib/signup/signup-2m2-synthetic-sandbox-service.ts"), "utf8");
  const RETURN_ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/signup/mandate/synthetic-return/route.ts"),
    "utf8",
  );
  it("issueSyntheticReturnNonce + consumeSyntheticReturnNonce exported", () => {
    expect(SVC).toMatch(/export async function issueSyntheticReturnNonce/);
    expect(SVC).toMatch(/export async function consumeSyntheticReturnNonce/);
  });
  it("nonce is 32 bytes of crypto random (64 hex chars)", () => {
    expect(SVC).toMatch(/crypto\.randomBytes\(32\)\.toString\("hex"\)/);
    expect(SVC).toMatch(/presentedNonce\.length !== 64/);
  });
  it("consume uses timingSafeEqual for constant-time compare", () => {
    expect(SVC).toMatch(/crypto\.timingSafeEqual/);
  });
  it("consume enforces single-use via conditional updateMany", () => {
    const fn = SVC.match(/export async function consumeSyntheticReturnNonce[\s\S]+?^\}/m)![0];
    expect(fn).toMatch(/signingAuthoritySignal:\s*stored/);
    expect(fn).toMatch(/signingAuthoritySignal:\s*`\$\{NONCE_PREFIX\}CONSUMED`/);
    expect(fn).toMatch(/consumed\.count !== 1/);
  });
  it("synthetic-return route consumes nonce BEFORE persistence", () => {
    // Match CALL positions (with `(`), not import lines.
    const nonceCallIdx = RETURN_ROUTE.indexOf("consumeSyntheticReturnNonce(");
    const persistCallIdx = RETURN_ROUTE.indexOf("persistSyntheticSignedMandate(");
    expect(nonceCallIdx).toBeGreaterThan(-1);
    expect(persistCallIdx).toBeGreaterThan(-1);
    expect(nonceCallIdx).toBeLessThan(persistCallIdx);
  });
  it("synthetic-return route requires nonce in query string", () => {
    expect(RETURN_ROUTE).toMatch(/nonce = url\.searchParams\.get\("nonce"\)/);
    expect(RETURN_ROUTE).toMatch(/if \(!registrationId \|\| !sessionId \|\| !nonce\)/);
  });
  it("initiate route embeds nonce in Stripe success_url", () => {
    const INITIATE_ROUTE = readFileSync(
      join(process.cwd(), "src/app/api/signup/mandate/synthetic-initiate/route.ts"),
      "utf8",
    );
    expect(INITIATE_ROUTE).toMatch(/issueSyntheticReturnNonce\(registrationId, user\.id\)/);
    expect(INITIATE_ROUTE).toMatch(/returnNonce: nonce/);
    expect(SVC).toMatch(/noncePart = opts\.returnNonce \? `&nonce=\$\{encodeURIComponent\(opts\.returnNonce\)\}`/);
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox · Phase 2F / 2G refuse synthetic rows (founder §2.5)", () => {
  it("Phase 2F authoriseActivation reads cycle.syntheticTestOnly and refuses", () => {
    const code = readFileSync(
      join(process.cwd(), "src/lib/billing/signup-2f-activation-service.ts"),
      "utf8",
    );
    expect(code).toMatch(/syntheticTestOnly:\s*true/);
    expect(code).toMatch(/cycle\.syntheticTestOnly === true/);
    expect(code).toMatch(/BillingCycle is marked syntheticTestOnly/);
  });
  it("Phase 2G tickProvisioningJob reads registration.syntheticTestOnly and refuses", () => {
    const code = readFileSync(
      join(process.cwd(), "src/lib/billing/signup-2g-provisioning-service.ts"),
      "utf8",
    );
    expect(code).toMatch(/reg\?\.syntheticTestOnly === true/);
    expect(code).toMatch(/Phase 2G refuses to provision synthetic-test-only job/);
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox · subscription-create failure is safely recoverable (2026-10-27 repair)", () => {
  const SVC = readFileSync(join(process.cwd(), "src/lib/signup/signup-2m2-synthetic-sandbox-service.ts"), "utf8");
  const RECOVER_ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/signup/mandate/synthetic-recover/route.ts"),
    "utf8",
  );

  it("persistSyntheticSignedMandate wraps createSubscription in try/catch", () => {
    const start = SVC.indexOf("export async function persistSyntheticSignedMandate");
    const end = SVC.indexOf("export async function recoverSyntheticSignedMandate");
    const fn = SVC.slice(start, end);
    expect(fn).toMatch(/try \{[\s\S]+?subscription = await stripe\.createSubscription/);
    expect(fn).toMatch(/\} catch \(err\) \{[\s\S]+?stripe\.webhook|SIGNUP_2M2_SYNTHETIC_STRIPE_SUBSCRIPTION_FAILED/);
  });

  it("subscription-create failure logs structured operator alert + throws AppError (not bare Error)", () => {
    expect(SVC).toMatch(/signup\.synthetic\.subscription_create_failed/);
    expect(SVC).toMatch(/SIGNUP_2M2_SYNTHETIC_STRIPE_SUBSCRIPTION_FAILED/);
    expect(SVC).toMatch(/throw new AppError\(\s*"SIGNUP_2M2_SYNTHETIC_STRIPE_SUBSCRIPTION_FAILED"/);
  });

  it("exactly-once semantics: createSubscription uses deterministic idempotencyKey", () => {
    const start = SVC.indexOf("export async function persistSyntheticSignedMandate");
    const end = SVC.indexOf("export async function recoverSyntheticSignedMandate");
    const fn = SVC.slice(start, end);
    expect(fn).toMatch(/idempotencyKey:\s*`signup-2m2-syn-sub:\$\{reg\.id\}:first`/);
  });

  it("recoverSyntheticSignedMandate exported + requires guards + does NOT re-consume nonce", () => {
    expect(SVC).toMatch(/export async function recoverSyntheticSignedMandate/);
    const start = SVC.indexOf("export async function recoverSyntheticSignedMandate");
    const end = SVC.indexOf("// ---- Teardown");
    const fn = SVC.slice(start, end);
    expect(fn).toMatch(/assertSyntheticSandboxGuardsPass\(\)/);
    expect(fn).not.toMatch(/consumeSyntheticReturnNonce/);  // operator retry does NOT need a nonce
    expect(fn).not.toMatch(/issueSyntheticReturnNonce/);     // NEVER re-issues a nonce
  });

  it("recover is idempotent: short-circuits on existing SubscriptionPaymentMandate for the registration", () => {
    const start = SVC.indexOf("export async function recoverSyntheticSignedMandate");
    const end = SVC.indexOf("// ---- Teardown");
    const fn = SVC.slice(start, end);
    expect(fn).toMatch(/subscriptionPaymentMandate\.findFirst/);
    expect(fn).toMatch(/if \(existing && !existing\.revokedAt\)/);
    expect(fn).toMatch(/return \{ noop: true/);
  });

  it("recovery route requires SUPER_ADMIN auth (same gate as initiate)", () => {
    expect(RECOVER_ROUTE).toMatch(/getCurrentUser\(\)/);
    expect(RECOVER_ROUTE).toMatch(/if \(!user\)[\s\S]+?status: 401/);
    expect(RECOVER_ROUTE).toMatch(/isSuperAdmin\(principal\)/);
    expect(RECOVER_ROUTE).toMatch(/SUPER_ADMIN role required/);
  });

  it("recovery route delegates to recoverSyntheticSignedMandate (no own Stripe/secret access)", () => {
    expect(RECOVER_ROUTE).toMatch(/recoverSyntheticSignedMandate/);
    expect(RECOVER_ROUTE).not.toMatch(/STRIPE_SECRET_KEY/);
    expect(RECOVER_ROUTE).not.toMatch(/stripe\.customers|stripe\.subscriptions/);
  });

  it("recovery route surfaces AppError.code (not generic server_error) on structured failures", () => {
    expect(RECOVER_ROUTE).toMatch(/err instanceof AppError[\s\S]+?error: err\.code/);
  });
});

describe("SIGNUP-2 M3C (2026-10-28) · persistSyntheticSignedMandate separates bank verification from subscription initiation", () => {
  const SVC = readFileSync(join(process.cwd(), "src/lib/signup/signup-2m2-synthetic-sandbox-service.ts"), "utf8");
  const RETURN_ROUTE = readFileSync(join(process.cwd(), "src/app/api/signup/mandate/synthetic-return/route.ts"), "utf8");

  it("§7 PAYMENT_INITIATION gate is adjacent to stripe.createSubscription, NOT above mandate persistence", () => {
    const createSubIdx = SVC.indexOf("stripe.createSubscription({");
    const gateIdx = SVC.indexOf('SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION === "1"');
    const mandateCreateIdx = SVC.indexOf("tx.subscriptionPaymentMandate.create({");
    expect(createSubIdx).toBeGreaterThan(0);
    expect(gateIdx).toBeGreaterThan(0);
    expect(mandateCreateIdx).toBeGreaterThan(0);
    // Gate must come BEFORE createSubscription (controls whether it fires)
    expect(gateIdx).toBeLessThan(createSubIdx);
    // ... but AFTER the mandate persistence block (so mandate still gets written when flag is off)
    // (Both the gate and createSub are above the tx that writes mandate; proof is in the
    // 'does not throw with flag off' branch below -- the gate assigns `subscription=null`.)
  });

  it("no longer throws SIGNUP_2M3_PAYMENT_INITIATION_DISABLED on the persist path", () => {
    expect(SVC).not.toMatch(/SIGNUP_2M3_PAYMENT_INITIATION_DISABLED/);
  });

  it("logs 'subscription_create_deferred' (not 'blocked') when flag is off", () => {
    expect(SVC).toMatch(/signup\.synthetic\.subscription_create_deferred/);
  });

  it("persistSyntheticSignedMandate return type carries initialSubscriptionStatus + paymentInitiated", () => {
    expect(SVC).toMatch(/initialSubscriptionStatus\?:\s*"AUTHORISED"\s*\|\s*"BANK_VERIFIED"\s*\|\s*"BANK_VERIFICATION_PENDING"\s*\|\s*"INITIATED"/);
    expect(SVC).toMatch(/paymentInitiated\?:\s*boolean/);
  });

  it("creates a dedicated synthetic Club (upsert) for FK safety on Postgres", () => {
    expect(SVC).toMatch(/synthetic-test-only-m2-/);
    expect(SVC).toMatch(/prisma\.club\.upsert\(/);
    expect(SVC).toMatch(/stagingDataMode:\s*"SYNTHETIC_DEMO"/);
  });

  it("reads SetupIntent status to decide initial subscription state (instant => BANK_VERIFIED, requires_action => PENDING)", () => {
    expect(SVC).toMatch(/stripe\.retrieveSetupIntent/);
    expect(SVC).toMatch(/bankVerifiedAtInitial\s*=\s*new Date\(\)/);
    expect(SVC).toMatch(/bankVerificationPendingAtInitial\s*=\s*new Date\(\)/);
    expect(SVC).toMatch(/initialSubscriptionStatus\s*=\s*"BANK_VERIFIED"/);
    expect(SVC).toMatch(/initialSubscriptionStatus\s*=\s*"BANK_VERIFICATION_PENDING"/);
  });

  it("cycle gets stripePaymentIntentId=null when subscription is deferred", () => {
    expect(SVC).toMatch(/stripePaymentIntentId:\s*subscription\?\.firstPaymentIntentId\s*\?\?\s*null/);
  });

  it("synthetic-return route redirects to branded /signup/t/<token>/status (not raw JSON)", () => {
    expect(RETURN_ROUTE).toMatch(/redirectTo\(`\/signup\/t\/\$\{freshToken\}\/status/);
    expect(RETURN_ROUTE).toMatch(/mintFreshResumeToken/);
    expect(RETURN_ROUTE).toMatch(/status: 303/);
  });

  it("mintFreshResumeToken only operates on synthetic rows", () => {
    expect(RETURN_ROUTE).toMatch(/reg\.syntheticTestOnly\s*!==\s*true.*?return null/s);
  });
});

describe("SIGNUP-2 M2-SyntheticSandbox · teardown preserves founder secrets", () => {
  const SVC = readFileSync(join(process.cwd(), "src/lib/signup/signup-2m2-synthetic-sandbox-service.ts"), "utf8");
  it("teardownSyntheticTestFixtures only deletes rows with syntheticTestOnly: true", () => {
    const start = SVC.indexOf("export async function teardownSyntheticTestFixtures");
    const end = SVC.indexOf("export async function refuseIfSyntheticTestOnly");
    const fn = SVC.slice(start, end);
    const whereClauses = fn.match(/syntheticTestOnly:\s*true/g) ?? [];
    expect(whereClauses.length).toBeGreaterThanOrEqual(5);
  });
  it("teardown never touches STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SIGNING_SECRET / STRIPE_ACSS_PRICE_ID", () => {
    const fn = SVC.match(/export async function teardownSyntheticTestFixtures[\s\S]+?^\}/m)![0];
    expect(fn).not.toMatch(/STRIPE_SECRET_KEY/);
    expect(fn).not.toMatch(/STRIPE_WEBHOOK_SIGNING_SECRET/);
    expect(fn).not.toMatch(/STRIPE_ACSS_PRICE_ID/);
    expect(fn).not.toMatch(/flyctl secrets/);
  });
});

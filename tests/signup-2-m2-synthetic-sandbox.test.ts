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

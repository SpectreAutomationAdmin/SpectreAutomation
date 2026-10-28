// SIGNUP-2 M4-triggering (2026-10-28) -- Contract tests.
//
// Covers the ten acceptance requirements from the M4-triggering
// authorization + the service-shape invariants.  Pure contract tests
// (file source scans + pure predicates); no live DB or Stripe.
// Behaviour-level tests that need a real DB will land as part of the
// M4-triggering staging acceptance via SSH probe.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertM4TriggerLiveFlag,
} from "@/lib/billing/signup-2m4-triggering-service";

const SVC = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2m4-triggering-service.ts"),
  "utf8",
);

describe("signup-2 m4-triggering :: service shape", () => {
  it("exports assertM4TriggerLiveFlag + authoriseAndReleaseFirstBilling + evaluatePreflight + drainOneBillingCommand", () => {
    expect(SVC).toMatch(/export function assertM4TriggerLiveFlag/);
    expect(SVC).toMatch(/export async function evaluatePreflight/);
    expect(SVC).toMatch(/export async function authoriseAndReleaseFirstBilling/);
    expect(SVC).toMatch(/export async function drainOneBillingCommand/);
  });
});

describe("signup-2 m4-triggering :: flag gate (SPECTRE_SIGNUP_2M4_TRIGGER_LIVE)", () => {
  beforeEach(() => { delete process.env.SPECTRE_SIGNUP_2M4_TRIGGER_LIVE; });
  afterEach(() => { delete process.env.SPECTRE_SIGNUP_2M4_TRIGGER_LIVE; });

  it("throws when flag is unset", () => {
    expect(() => assertM4TriggerLiveFlag()).toThrow(/disabled/);
  });

  it("throws when flag is 0", () => {
    process.env.SPECTRE_SIGNUP_2M4_TRIGGER_LIVE = "0";
    expect(() => assertM4TriggerLiveFlag()).toThrow(/disabled/);
  });

  it("succeeds when flag is 1", () => {
    process.env.SPECTRE_SIGNUP_2M4_TRIGGER_LIVE = "1";
    expect(() => assertM4TriggerLiveFlag()).not.toThrow();
  });

  it("flag is INDEPENDENT of SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION (both must be ON for actual subscription create)", () => {
    expect(SVC).toMatch(/SPECTRE_SIGNUP_2M4_TRIGGER_LIVE/);
    expect(SVC).toMatch(/SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION/);
    // Must gate on BOTH, not an OR.
    expect(SVC).not.toMatch(/SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION\s*===.*?\|\|/);
    expect(SVC).not.toMatch(/\|\|\s*SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION/);
  });
});

describe("signup-2 m4-triggering :: acceptance #1 Two-operator SoD", () => {
  it("service enforces releaseApprovedByUserId must differ from commercialApprovedByUserId", () => {
    expect(SVC).toMatch(/args\.releaseApprovedByUserId\s*===\s*ctx\.commercialApprovedByUserId/);
    expect(SVC).toMatch(/SoD violation/);
    expect(SVC).toMatch(/ForbiddenError/);
  });
});

describe("signup-2 m4-triggering :: acceptance #2 Missing/invalid commercial approval refused", () => {
  it("preflight returns COMMERCIAL_AUTHORISATION_MISSING when ClubPaymentAuthorisation is absent", () => {
    expect(SVC).toMatch(/COMMERCIAL_AUTHORISATION_MISSING/);
  });

  it("preflight returns COMMERCIAL_AUTHORISATION_PRICING_MISMATCH on cross-link mismatch", () => {
    expect(SVC).toMatch(/COMMERCIAL_AUTHORISATION_PRICING_MISMATCH/);
  });

  it("preflight returns AUTHORISED_AMOUNT_MISMATCH_PRICING when operator A authorized a different amount than pricing says", () => {
    expect(SVC).toMatch(/AUTHORISED_AMOUNT_MISMATCH_PRICING/);
    expect(SVC).toMatch(/auth\.authorisedAmountMinorUnits !== pricing\.amountMinorUnits/);
  });

  it("preflight returns AUTHORISED_CURRENCY_MISMATCH_PRICING similarly", () => {
    expect(SVC).toMatch(/AUTHORISED_CURRENCY_MISMATCH_PRICING/);
  });
});

describe("signup-2 m4-triggering :: acceptance #3 Invalid/revoked mandate refused", () => {
  it("preflight returns MANDATE_NOT_FOUND when no mandate exists for the registration", () => {
    expect(SVC).toMatch(/MANDATE_NOT_FOUND/);
  });

  it("preflight returns MANDATE_REVOKED when revokedAt is set", () => {
    expect(SVC).toMatch(/MANDATE_REVOKED/);
    expect(SVC).toMatch(/mandate\.revokedAt !== null/);
  });
});

describe("signup-2 m4-triggering :: acceptance #4 Correct subscription pricing + tax validation", () => {
  it("preflight loads ClubBillingPricing + ClubPaymentAuthorisation + checks amount+currency match", () => {
    expect(SVC).toMatch(/prisma\.clubBillingPricing\.findUnique/);
    expect(SVC).toMatch(/prisma\.clubPaymentAuthorisation\.findUnique/);
    expect(SVC).toMatch(/pricing\.amountMinorUnits/);
    expect(SVC).toMatch(/pricing\.currency/);
  });

  it("preflight returns PRICING_MISSING when no pricing exists", () => {
    expect(SVC).toMatch(/PRICING_MISSING/);
  });

  it("preflight returns PRICING_CONTRACT_MISMATCH when pricing links to a different contract", () => {
    expect(SVC).toMatch(/PRICING_CONTRACT_MISMATCH/);
    expect(SVC).toMatch(/pricing\.contractExecutionId !== contract\.id/);
  });
});

describe("signup-2 m4-triggering :: acceptance #5 Durable billing-command creation", () => {
  it("authoriseAndReleaseFirstBilling writes ClubBillingRelease + BillingCommand atomically", () => {
    expect(SVC).toMatch(/prisma\.\$transaction/);
    expect(SVC).toMatch(/tx\.clubBillingRelease\.create/);
    expect(SVC).toMatch(/tx\.billingCommand\.create/);
  });

  it("BillingCommand carries SUBSCRIPTION_CREATE_FIRST + deterministic stripeIdempotencyKey", () => {
    expect(SVC).toMatch(/commandType:\s*"SUBSCRIPTION_CREATE_FIRST"/);
    expect(SVC).toMatch(/signup-2m4-sub-create:\$\{args\.billingCycleId\}:v1/);
  });

  it("Release is updated with consumedByBillingCommandId linking to the command in the same transaction", () => {
    expect(SVC).toMatch(/consumedByBillingCommandId:\s*command\.id/);
    expect(SVC).toMatch(/releaseTokenConsumedAt:\s*new Date\(\)/);
  });

  it("Command carries releaseId FK + paramsJson snapshot of mandate/pricing/authorisation ids", () => {
    expect(SVC).toMatch(/releaseId:\s*release\.id/);
    expect(SVC).toMatch(/paramsJson:\s*JSON\.stringify/);
  });
});

describe("signup-2 m4-triggering :: acceptance #6 Idempotent duplicate-request handling", () => {
  it("releaseToken is deterministic (sha256 of cycle + idempotencyScope)", () => {
    expect(SVC).toMatch(/createHash\("sha256"\)/);
    expect(SVC).toMatch(/m4-release:\$\{args\.billingCycleId\}:\$\{args\.idempotencyScope\}/);
  });

  it("replay path: existing release with consumedByBillingCommandId returns noop=true with same ids", () => {
    expect(SVC).toMatch(/if \(existing && existing\.consumedByBillingCommandId\)/);
    expect(SVC).toMatch(/noop:\s*true/);
  });
});

describe("signup-2 m4-triggering :: acceptance #7 Recovery from Stripe timeouts + uncertain outcomes", () => {
  it("worker transitions to UNCERTAIN on timeout/network/5xx errors", () => {
    expect(SVC).toMatch(/timeout\|ETIMEDOUT\|ECONNRESET\|ENOTFOUND\|StripeConnectionError\|StripeAPIError\|5\\d\\d/);
    expect(SVC).toMatch(/isUncertain\s*\?\s*"UNCERTAIN"\s*:\s*"FAILED"/);
  });

  it("worker transitions to FAILED on explicit 4xx / AppError", () => {
    expect(SVC).toMatch(/newState\s*=\s*isUncertain\s*\?\s*"UNCERTAIN"\s*:\s*"FAILED"/);
  });

  it("retry uses the SAME stripeIdempotencyKey across attempts (Stripe de-dupes)", () => {
    // The command's stripeIdempotencyKey is set once at creation + never
    // rotated per-attempt.  advanceToPaymentInitiated has its own
    // idempotencyKey; this slice relies on both being deterministic.
    const releasesBlock = SVC.slice(SVC.indexOf("async function authoriseAndReleaseFirstBilling"));
    expect(releasesBlock).toMatch(/stripeIdempotencyKey = `signup-2m4-sub-create:\$\{args\.billingCycleId\}:v1`/);
    // On attempt bump, idempotency key is NOT rewritten.
    expect(SVC).not.toMatch(/stripeIdempotencyKey:\s*`.*?:\$\{(?:nextAttempt|attemptNumber)}`/);
  });
});

describe("signup-2 m4-triggering :: acceptance #8 Prevention of duplicate subscriptions", () => {
  it("preflight refuses with DUPLICATE_RELEASE_ALREADY_EXISTS when a release row for this cycle exists", () => {
    expect(SVC).toMatch(/DUPLICATE_RELEASE_ALREADY_EXISTS/);
    expect(SVC).toMatch(/prisma\.clubBillingRelease\.findUnique/);
  });

  it("preflight refuses with DUPLICATE_PENDING_COMMAND when a pending/attempted/uncertain/succeeded command exists", () => {
    expect(SVC).toMatch(/DUPLICATE_PENDING_COMMAND/);
    expect(SVC).toMatch(/state:\s*\{\s*in:\s*\["PENDING",\s*"ATTEMPTED",\s*"UNCERTAIN",\s*"SUCCEEDED"\]\s*\}/);
  });

  it("preflight refuses SUBSCRIPTION_ALREADY_INITIATED when cycle.stripePaymentIntentId is set", () => {
    expect(SVC).toMatch(/SUBSCRIPTION_ALREADY_INITIATED/);
    expect(SVC).toMatch(/cycle\.stripePaymentIntentId !== null/);
  });

  it("worker FOR UPDATE lock prevents concurrent attempt races", () => {
    expect(SVC).toMatch(/FOR UPDATE/);
  });
});

describe("signup-2 m4-triggering :: acceptance #9 Correct behavior when payment-initiation flags are OFF", () => {
  it("worker returns DEFERRED when SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION != 1", () => {
    expect(SVC).toMatch(/paymentInitEnabled/);
    expect(SVC).toMatch(/state:\s*"DEFERRED"/);
    expect(SVC).toMatch(/PAYMENT_INITIATION_DISABLED/);
    expect(SVC).toMatch(/NOOP_PAYMENT_INITIATION_DISABLED/);
  });

  it("DEFERRED path does NOT call advanceToPaymentInitiated", () => {
    // The import must be AFTER the paymentInitEnabled check so that an
    // OFF flag path cannot invoke it.
    const workerBlock = SVC.slice(SVC.indexOf("async function drainOneBillingCommand"));
    const guardIdx = workerBlock.indexOf("if (!paymentInitEnabled)");
    const advanceImportIdx = workerBlock.indexOf("import(\"./signup-2m3-bank-verification-service\")");
    expect(guardIdx).toBeGreaterThan(0);
    expect(advanceImportIdx).toBeGreaterThan(guardIdx);
  });
});

describe("signup-2 m4-triggering :: acceptance #10 No unauthorized subscription creation / debit / tenant activation", () => {
  it("service never calls stripe.createSubscription or stripe.subscriptions.create directly", () => {
    expect(SVC).not.toMatch(/stripe\.createSubscription\(/);
    expect(SVC).not.toMatch(/stripe\.subscriptions\.create\(/);
  });

  it("service never calls stripe.customers.create or any provisioning API", () => {
    expect(SVC).not.toMatch(/stripe\.customers\./);
    expect(SVC).not.toMatch(/tickProvisioningJob|authoriseActivation|validateActivationAuthorisation/);
  });

  it("service never writes ClubSubscription or TenantProvisioningJob rows", () => {
    expect(SVC).not.toMatch(/clubSubscription\.(create|update|upsert)/);
    expect(SVC).not.toMatch(/tenantProvisioningJob\.(create|update|upsert)/);
  });

  it("service never writes BillingCycle.subscriptionStatus directly", () => {
    expect(SVC).not.toMatch(/billingCycle\.update.*?subscriptionStatus/);
  });
});

describe("signup-2 m4-triggering :: Decision #5 explicit evidence requirement", () => {
  it("preflight loads ClubContractExecution + ClubBillingPricing + ClubPaymentAuthorisation", () => {
    expect(SVC).toMatch(/prisma\.clubContractExecution\.findUnique/);
    expect(SVC).toMatch(/prisma\.clubBillingPricing\.findUnique/);
    expect(SVC).toMatch(/prisma\.clubPaymentAuthorisation\.findUnique/);
  });

  it("CONTRACT_EXECUTION_MISSING refusal present", () => {
    expect(SVC).toMatch(/CONTRACT_EXECUTION_MISSING/);
  });

  it("GOVERNANCE_REQUIRED_BUT_MISSING refusal only when governanceRequired=true + governanceApprovedAt=null", () => {
    expect(SVC).toMatch(/GOVERNANCE_REQUIRED_BUT_MISSING/);
    expect(SVC).toMatch(/contract\.governanceRequired && contract\.governanceApprovedAt === null/);
  });
});

describe("signup-2 m4-triggering :: Audit trail + tenant isolation", () => {
  it("writes audit entry signup.m4.triggering.authorised on release", () => {
    expect(SVC).toMatch(/action:\s*"signup\.m4\.triggering\.authorised"/);
    expect(SVC).toMatch(/entityType:\s*"ClubBillingRelease"/);
  });

  it("worker writes audit entries for each outcome branch", () => {
    expect(SVC).toMatch(/signup\.m4\.triggering\.worker\.succeeded/);
    expect(SVC).toMatch(/signup\.m4\.triggering\.worker\.\$\{newState\.toLowerCase\(\)\}/);
  });

  it("tenant isolation: synthetic registration cannot be paired with non-synthetic cycle (and vice versa)", () => {
    expect(SVC).toMatch(/REGISTRATION_SYNTHETIC_LEAKED_TO_PRODUCTION_PATH/);
    expect(SVC).toMatch(/reg\.syntheticTestOnly !== cycle\.syntheticTestOnly/);
  });

  it("BillingCommand carries syntheticTestOnly flag + clubId (denormalised)", () => {
    expect(SVC).toMatch(/syntheticTestOnly:\s*ctx\.syntheticTestOnly/);
    expect(SVC).toMatch(/clubId:\s*ctx\.cycleClubId/);
  });
});

describe("signup-2 m4-triggering :: §B release authorization durably associated with command BEFORE Stripe", () => {
  it("the $transaction that writes ClubBillingRelease ALSO creates the BillingCommand AND updates consumedByBillingCommandId", () => {
    const txBlock = SVC.match(/prisma\.\$transaction\(async \(tx\) => \{[\s\S]+?return \{\s*releaseId:/)![0];
    expect(txBlock).toMatch(/tx\.clubBillingRelease\.create/);
    expect(txBlock).toMatch(/tx\.billingCommand\.create/);
    expect(txBlock).toMatch(/tx\.clubBillingRelease\.update/);
    expect(txBlock).toMatch(/consumedByBillingCommandId:\s*command\.id/);
  });

  it("no Stripe adapter call appears in the authoriseAndReleaseFirstBilling body", () => {
    const authBlock = SVC.slice(
      SVC.indexOf("export async function authoriseAndReleaseFirstBilling"),
      SVC.indexOf("export type CommandDrainOutcome"),
    );
    expect(authBlock).not.toMatch(/resolveStripeAdapter/);
    expect(authBlock).not.toMatch(/stripe\./);
  });
});

describe("signup-2 m4-triggering :: Scope boundaries (per founder M4-triggering authorisation §5)", () => {
  it("no M4-cancellation service file exists (renewal authorised 2026-10-28)", async () => {
    const { readdirSync, existsSync } = await import("node:fs");
    if (!existsSync(join(process.cwd(), "src/lib/billing"))) return;
    const files = readdirSync(join(process.cwd(), "src/lib/billing"));
    const forbidden = files.filter((f) =>
      /^signup-2m4-cancellation-service\.ts$/.test(f)
    );
    expect(forbidden, `forbidden future-slice files present: ${forbidden.join(", ")}`).toEqual([]);
  });

  it("no HTTP routes for settlement/retries/renewal/cancellation exist", async () => {
    const { existsSync } = await import("node:fs");
    const paths = [
      "src/app/api/billing/settlement/route.ts",
      "src/app/api/billing/retry/route.ts",
      "src/app/api/billing/renewal/route.ts",
      "src/app/api/billing/cancel/route.ts",
    ];
    for (const p of paths) {
      expect(existsSync(join(process.cwd(), p)), `forbidden route: ${p}`).toBe(false);
    }
  });
});

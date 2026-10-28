// SIGNUP-2 M4-schema (2026-10-28) -- contract tests for the annual
// billing authorization + settlement + durable command queue schema.
//
// Schema-only slice.  No behavior under test.  These tests pin the
// shape of the seven new models + their indexes / unique constraints /
// FK targets, and pin the specific decisions + corrections that
// motivated each column.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PG_SCHEMA = readFileSync(join(process.cwd(), "prisma-postgres/schema.prisma"), "utf8");
const SQLITE_SCHEMA = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
const PG_MIGRATION = readFileSync(
  join(process.cwd(), "prisma-postgres/migrations/20261028_signup_2_m4_schema/migration.sql"),
  "utf8",
);
const SQLITE_MIGRATION = readFileSync(
  join(process.cwd(), "prisma/migrations/20261028_signup_2_m4_schema/migration.sql"),
  "utf8",
);

function modelBlock(schema: string, modelName: string): string {
  const start = schema.indexOf(`model ${modelName} {`);
  if (start < 0) throw new Error(`model ${modelName} not found`);
  const end = schema.indexOf("\n}", start);
  return schema.slice(start, end + 2);
}

describe("SIGNUP-2 M4-schema :: seven new models exist in BOTH schemas", () => {
  const required = [
    "ClubContractExecution",
    "ClubBillingPricing",
    "ClubPaymentAuthorisation",
    "ClubBillingRelease",
    "BillingCommand",
    "BillingInvoicePaymentAttempt",
    "BillingRenewalPreflight",
    "BillingExceptionCase",
  ];
  for (const m of required) {
    it(`${m} exists in prisma-postgres/schema.prisma`, () => {
      expect(PG_SCHEMA.match(new RegExp(`^model ${m} `, "m"))).toBeTruthy();
    });
    it(`${m} exists in prisma/schema.prisma (SQLite dev mirror)`, () => {
      expect(SQLITE_SCHEMA.match(new RegExp(`^model ${m} `, "m"))).toBeTruthy();
    });
    it(`${m} CREATE TABLE in Postgres migration`, () => {
      expect(PG_MIGRATION).toMatch(new RegExp(`CREATE TABLE "${m}"`));
    });
    it(`${m} CREATE TABLE in SQLite migration`, () => {
      expect(SQLITE_MIGRATION).toMatch(new RegExp(`CREATE TABLE "${m}"`));
    });
  }
});

describe("SIGNUP-2 M4-schema :: syntheticTestOnly on every new model (M3/M4 test isolation)", () => {
  const models = [
    "ClubContractExecution", "ClubBillingPricing", "ClubPaymentAuthorisation",
    "ClubBillingRelease", "BillingCommand", "BillingInvoicePaymentAttempt",
    "BillingRenewalPreflight", "BillingExceptionCase",
  ];
  for (const m of models) {
    it(`${m}.syntheticTestOnly present + default false (prisma-postgres)`, () => {
      const block = modelBlock(PG_SCHEMA, m);
      expect(block).toMatch(/syntheticTestOnly\s+Boolean\s+@default\(false\)/);
    });
    it(`${m}.syntheticTestOnly present + default false (SQLite dev)`, () => {
      const block = modelBlock(SQLITE_SCHEMA, m);
      expect(block).toMatch(/syntheticTestOnly\s+Boolean\s+@default\(false\)/);
    });
    it(`${m}.syntheticTestOnly indexed`, () => {
      const block = modelBlock(PG_SCHEMA, m);
      expect(block).toMatch(/@@index\(\[syntheticTestOnly\]\)/);
    });
  }
});

describe("SIGNUP-2 M4-schema :: Decision #1 -- two-operator SoD columns distinct", () => {
  it("ClubPaymentAuthorisation carries commercial operator id (operator A)", () => {
    const block = modelBlock(PG_SCHEMA, "ClubPaymentAuthorisation");
    expect(block).toMatch(/commercialApprovedByUserId\s+String/);
    expect(block).toMatch(/commercialApprovedAt\s+DateTime/);
  });

  it("ClubBillingRelease carries release operator id (operator B)", () => {
    const block = modelBlock(PG_SCHEMA, "ClubBillingRelease");
    expect(block).toMatch(/releaseApprovedByUserId\s+String/);
    expect(block).toMatch(/releaseApprovedAt\s+DateTime/);
  });

  it("Release row links to its authorisation so service can enforce SoD (operator B != operator A)", () => {
    const block = modelBlock(PG_SCHEMA, "ClubBillingRelease");
    expect(block).toMatch(/authorisationId\s+String\s+@unique/);
    expect(block).toMatch(/authorisation\s+ClubPaymentAuthorisation @relation/);
  });
});

describe("SIGNUP-2 M4-schema :: Decision #1 -- governance only when required", () => {
  it("ClubContractExecution governance fields are nullable + gated by governanceRequired", () => {
    const block = modelBlock(PG_SCHEMA, "ClubContractExecution");
    expect(block).toMatch(/governanceRequired\s+Boolean\s+@default\(false\)/);
    expect(block).toMatch(/governanceApprovedByUserId\s+String\?/);
    expect(block).toMatch(/governanceApprovedAt\s+DateTime\?/);
    expect(block).toMatch(/governanceReference\s+String\?/);
  });
});

describe("SIGNUP-2 M4-schema :: Decision #5 -- explicit contract + pricing + authorisation + release models (NOT free-text)", () => {
  it("ClubContractExecution models executed-contract evidence (storage key + sha256 + byte length)", () => {
    const block = modelBlock(PG_SCHEMA, "ClubContractExecution");
    expect(block).toMatch(/contractType\s+String/);
    expect(block).toMatch(/contractVersionSha256\s+String/);
    expect(block).toMatch(/evidenceStorageKey\s+String/);
    expect(block).toMatch(/evidenceSha256\s+String/);
    expect(block).toMatch(/evidenceByteLength\s+Int/);
  });

  it("ClubBillingPricing models stripe price + currency + amount + billingInterval + tax treatment", () => {
    const block = modelBlock(PG_SCHEMA, "ClubBillingPricing");
    expect(block).toMatch(/stripePriceId\s+String/);
    expect(block).toMatch(/currency\s+String/);
    expect(block).toMatch(/amountMinorUnits\s+BigInt/);
    expect(block).toMatch(/billingInterval\s+String/);
    expect(block).toMatch(/taxTreatment\s+String/);
    // Per-tax basis-points fields present for Canadian GST/PST/HST jurisdictions.
    expect(block).toMatch(/gstPercentBps\s+Int\?/);
    expect(block).toMatch(/pstPercentBps\s+Int\?/);
    expect(block).toMatch(/hstPercentBps\s+Int\?/);
  });
});

describe("SIGNUP-2 M4-schema :: Correction #6 -- retries bound to original Stripe invoice id (no duplicate collection)", () => {
  it("BillingInvoicePaymentAttempt carries ORIGINAL stripeInvoiceId + attemptNumber uniqueness", () => {
    const block = modelBlock(PG_SCHEMA, "BillingInvoicePaymentAttempt");
    expect(block).toMatch(/stripeInvoiceId\s+String/);
    expect(block).toMatch(/attemptNumber\s+Int/);
    expect(block).toMatch(/@@unique\(\[stripeInvoiceId, attemptNumber\]\)/);
  });

  it("retryChain self-relation links a retry attempt to its originator", () => {
    const block = modelBlock(PG_SCHEMA, "BillingInvoicePaymentAttempt");
    expect(block).toMatch(/originatingAttemptId\s+String\?/);
    expect(block).toMatch(/originatingAttempt\s+BillingInvoicePaymentAttempt\?\s+@relation\("retryChain"/);
    expect(block).toMatch(/retries\s+BillingInvoicePaymentAttempt\[\]\s+@relation\("retryChain"\)/);
  });
});

describe("SIGNUP-2 M4-schema :: Decision #2 -- club notified BEFORE retry + mandate validity gate", () => {
  it("BillingInvoicePaymentAttempt carries club-notification timestamp + WI id + mandateValidAtAttemptTime", () => {
    const block = modelBlock(PG_SCHEMA, "BillingInvoicePaymentAttempt");
    expect(block).toMatch(/clubNotifiedAt\s+DateTime\?/);
    expect(block).toMatch(/clubNotificationWorkIntakeId\s+String\?/);
    expect(block).toMatch(/mandateValidAtAttemptTime\s+Boolean\?/);
  });
});

describe("SIGNUP-2 M4-schema :: Correction #10 -- durable idempotent BillingCommand queue", () => {
  it("BillingCommand carries stripeIdempotencyKey (unique) + state machine columns", () => {
    const block = modelBlock(PG_SCHEMA, "BillingCommand");
    expect(block).toMatch(/stripeIdempotencyKey\s+String\s+@unique/);
    expect(block).toMatch(/state\s+String\s+@default\("PENDING"\)/);
    expect(block).toMatch(/attemptNumber\s+Int\s+@default\(0\)/);
    expect(block).toMatch(/maxAttempts\s+Int\s+@default\(1\)/);
    expect(block).toMatch(/nextAttemptAt\s+DateTime/);
    expect(block).toMatch(/succeededAt\s+DateTime\?/);
    expect(block).toMatch(/terminalAt\s+DateTime\?/);
  });

  it("BillingCommand links to both BillingCycle (scope) and Club (tenant isolation denormalised)", () => {
    const block = modelBlock(PG_SCHEMA, "BillingCommand");
    expect(block).toMatch(/billingCycleId\s+String\s*\n/);
    expect(block).toMatch(/billingCycle\s+BillingCycle @relation/);
    expect(block).toMatch(/clubId\s+String\s*\n/);
    expect(block).toMatch(/club\s+Club\s+@relation/);
  });

  it("BillingCommand workers scan via (state, nextAttemptAt) index", () => {
    const block = modelBlock(PG_SCHEMA, "BillingCommand");
    expect(block).toMatch(/@@index\(\[state, nextAttemptAt\]\)/);
  });
});

describe("SIGNUP-2 M4-schema :: Correction #10 -- Release does NOT itself call Stripe; emits a BillingCommand", () => {
  it("ClubBillingRelease has releaseToken + consumedByBillingCommandId linking consume to a durable command", () => {
    const block = modelBlock(PG_SCHEMA, "ClubBillingRelease");
    expect(block).toMatch(/releaseToken\s+String\s+@unique/);
    expect(block).toMatch(/releaseTokenConsumedAt\s+DateTime\?/);
    expect(block).toMatch(/consumedByBillingCommandId\s+String\?\s+@unique/);
  });
});

describe("SIGNUP-2 M4-schema :: Correction #8 -- Stripe-reported identifiers for safe reconciliation (no event-ordering)", () => {
  it("BillingInvoicePaymentAttempt carries stripeSubscriptionId + period_start/end from Stripe", () => {
    const block = modelBlock(PG_SCHEMA, "BillingInvoicePaymentAttempt");
    expect(block).toMatch(/stripeSubscriptionId\s+String\?/);
    expect(block).toMatch(/stripeInvoicePeriodStart\s+DateTime\?/);
    expect(block).toMatch(/stripeInvoicePeriodEnd\s+DateTime\?/);
  });
});

describe("SIGNUP-2 M4-schema :: Correction #9 -- no hardcoded dispute windows; record actual balance_transaction", () => {
  it("BillingExceptionCase carries stripeBalanceTransactionId + balanceAvailableAt (actual, not assumed)", () => {
    const block = modelBlock(PG_SCHEMA, "BillingExceptionCase");
    expect(block).toMatch(/stripeBalanceTransactionId\s+String\?/);
    expect(block).toMatch(/balanceEffectAmountMinor\s+BigInt\?/);
    expect(block).toMatch(/balanceEffectCurrency\s+String\?/);
    expect(block).toMatch(/balanceAvailableAt\s+DateTime\?/);
  });
});

describe("SIGNUP-2 M4-schema :: Decision #3 -- renewal preflight has T-45 + a second check", () => {
  it("BillingRenewalPreflight uniqued by (cycle, checkpointLabel) so both T_MINUS_45 + T_MINUS_7 fit", () => {
    const block = modelBlock(PG_SCHEMA, "BillingRenewalPreflight");
    expect(block).toMatch(/checkpointLabel\s+String/);
    expect(block).toMatch(/@@unique\(\[billingCycleId, checkpointLabel\]\)/);
  });

  it("Preflight snapshot carries mandate validity + price drift detection (correction #11)", () => {
    const block = modelBlock(PG_SCHEMA, "BillingRenewalPreflight");
    expect(block).toMatch(/mandateStillValid\s+Boolean\?/);
    expect(block).toMatch(/renewalPriceId\s+String\?/);
    expect(block).toMatch(/renewalAmountMinorUnits\s+BigInt\?/);
    expect(block).toMatch(/renewalTaxTreatment\s+String\?/);
    expect(block).toMatch(/renewalPricingDriftDetected\s+Boolean\s+@default\(false\)/);
  });
});

describe("SIGNUP-2 M4-schema :: Decision #4 -- auto-record Stripe events + require operator action for consequential moves", () => {
  it("BillingExceptionCase has auto-record fields + requiresOperatorAction + operator ack/resolution fields", () => {
    const block = modelBlock(PG_SCHEMA, "BillingExceptionCase");
    expect(block).toMatch(/autoRecordedAt\s+DateTime\?/);
    expect(block).toMatch(/autoRecordedPayloadJson\s+String\?/);
    expect(block).toMatch(/requiresOperatorAction\s+Boolean\s+@default\(false\)/);
    expect(block).toMatch(/operatorInboxEntryId\s+String\?/);
    expect(block).toMatch(/operatorAcknowledgedByUserId\s+String\?/);
    expect(block).toMatch(/operatorAcknowledgedAt\s+DateTime\?/);
    expect(block).toMatch(/operatorResolution\s+String\?/);
  });
});

describe("SIGNUP-2 M4-schema :: back-relations on parent models (Prisma validity)", () => {
  it("SignupRegistration gains M4 back-refs", () => {
    const block = modelBlock(PG_SCHEMA, "SignupRegistration");
    expect(block).toMatch(/contractExecution\s+ClubContractExecution\?/);
    expect(block).toMatch(/billingPricing\s+ClubBillingPricing\?/);
    expect(block).toMatch(/paymentAuthorisation\s+ClubPaymentAuthorisation\?/);
    expect(block).toMatch(/billingRelease\s+ClubBillingRelease\?/);
  });

  it("BillingCycle gains M4 back-refs", () => {
    const block = modelBlock(PG_SCHEMA, "BillingCycle");
    expect(block).toMatch(/billingRelease\s+ClubBillingRelease\?/);
    expect(block).toMatch(/billingCommands\s+BillingCommand\[\]/);
    expect(block).toMatch(/paymentAttempts\s+BillingInvoicePaymentAttempt\[\]/);
    expect(block).toMatch(/renewalPreflights\s+BillingRenewalPreflight\[\]/);
    expect(block).toMatch(/exceptionCases\s+BillingExceptionCase\[\]/);
  });

  it("Club gains BillingCommand back-ref", () => {
    const block = modelBlock(PG_SCHEMA, "Club");
    expect(block).toMatch(/billingCommands\s+BillingCommand\[\]/);
  });
});

describe("SIGNUP-2 M4-schema :: additive-only + FK targets intact", () => {
  it("Migration ADDs tables, never DROPs columns/tables of existing models", () => {
    // Strip comment lines before scanning so comment prose ("rollback
    // does NOT drop tables") does not false-trigger the regex.
    const stripComments = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    const pgSql = stripComments(PG_MIGRATION);
    const sqliteSql = stripComments(SQLITE_MIGRATION);
    expect(pgSql).not.toMatch(/DROP TABLE/i);
    expect(pgSql).not.toMatch(/DROP COLUMN/i);
    expect(sqliteSql).not.toMatch(/DROP TABLE/i);
    expect(sqliteSql).not.toMatch(/DROP COLUMN/i);
  });

  it("Postgres migration FK target SignupRegistration present", () => {
    expect(PG_MIGRATION).toMatch(/FOREIGN KEY \("signupRegistrationId"\) REFERENCES "SignupRegistration"\("id"\)/);
  });

  it("Postgres migration FK target BillingCycle present (M4 queue + attempts + preflight + exception)", () => {
    expect(PG_MIGRATION).toMatch(/FOREIGN KEY \("billingCycleId"\) REFERENCES "BillingCycle"\("id"\)/);
  });

  it("Postgres migration FK target Club present (M4 BillingCommand tenant isolation)", () => {
    expect(PG_MIGRATION).toMatch(/FOREIGN KEY \("clubId"\) REFERENCES "Club"\("id"\)/);
  });

  it("Postgres migration adds the retry-chain self-FK on BillingInvoicePaymentAttempt", () => {
    expect(PG_MIGRATION).toMatch(/FOREIGN KEY \("originatingAttemptId"\) REFERENCES "BillingInvoicePaymentAttempt"\("id"\)/);
  });
});

describe("SIGNUP-2 M4-schema :: behavior-slice guard (only the authorised slice's service may exist)", () => {
  // Guard evolves with each authorised slice.  M4-triggering + M4-settlement
  // are now authorised (2026-10-28).  Retries, renewal, cancellation remain
  // unauthorised.
  it("only authorised M4 slice files may exist (triggering + settlement); other M4 slice files are forbidden", async () => {
    const { readdirSync, existsSync } = await import("node:fs");
    if (!existsSync(join(process.cwd(), "src/lib/billing"))) return;
    const files = readdirSync(join(process.cwd(), "src/lib/billing"));
    const permitted = new Set([
      "signup-2m4-triggering-service.ts", // authorised 2026-10-28
      "signup-2m4-settlement-service.ts", // authorised 2026-10-28
    ]);
    const forbidden = files.filter((f) =>
      /^signup-2m4-.*-service\.ts$/.test(f) && !permitted.has(f),
    );
    expect(forbidden, `unauthorised M4 slice files leaked: ${forbidden.join(", ")}`).toEqual([]);
  });

  it("no HTTP routes for settlement/retries/renewal/cancellation exist (M4-triggering has no HTTP route yet either)", async () => {
    const { existsSync } = await import("node:fs");
    const paths = [
      "src/app/api/billing/subscription-create/route.ts",
      "src/app/api/billing/invoice-retry/route.ts",
      "src/app/api/billing/renewal-preflight/route.ts",
      "src/app/api/billing/cancel/route.ts",
    ];
    for (const p of paths) {
      expect(existsSync(join(process.cwd(), p)), `forbidden future-slice route: ${p}`).toBe(false);
    }
  });
});

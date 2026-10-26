// SIGNUP-2 Phase 2E (2026-10-26) -- Schema contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SQLITE = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
const PG = readFileSync(join(ROOT, "prisma-postgres/schema.prisma"), "utf8");
const SQLITE_MIG = readFileSync(
  join(ROOT, "prisma/migrations/20261026_signup_2e_billing_cycle_release_fk/migration.sql"),
  "utf8",
);
const PG_MIG = readFileSync(
  join(ROOT, "prisma-postgres/migrations/20261026_signup_2e_billing_cycle_release_fk/migration.sql"),
  "utf8",
);

describe("SIGNUP-2 Phase 2E · BillingCycle.releasedByOperatorRecordId FK", () => {
  for (const [label, schema] of [
    ["sqlite", SQLITE],
    ["postgres", PG],
  ] as const) {
    it(`${label}: releasedByOperatorRecordId column + relation present`, () => {
      expect(schema).toMatch(/releasedByOperatorRecordId\s+String\?/);
      expect(schema).toMatch(/releasedByOperatorRecord\s+OperatorVerificationRecord\?/);
      expect(schema).toMatch(/@@index\(\[releasedByOperatorRecordId\]\)/);
    });

    it(`${label}: OperatorVerificationRecord gains back-relation`, () => {
      expect(schema).toMatch(/cycles\s+BillingCycle\[\]/);
    });
  }
});

describe("SIGNUP-2 Phase 2E · SubscriptionPaymentMandate.clubId relaxed to nullable", () => {
  for (const [label, schema] of [
    ["sqlite", SQLITE],
    ["postgres", PG],
  ] as const) {
    it(`${label}: clubId is nullable`, () => {
      const block = schema.match(/model SubscriptionPaymentMandate[\s\S]+?^}/m)!;
      expect(block[0]).toMatch(/clubId\s+String\?/);
      expect(block[0]).toMatch(/clubSubscription\s+ClubSubscription\?/);
    });
  }
});

describe("SIGNUP-2 Phase 2E · migrations are additive-only", () => {
  it("SQLite migration adds BillingCycle column + index (SQLite does not alter mandate.clubId at DDL)", () => {
    expect(SQLITE_MIG).toMatch(/ALTER TABLE "BillingCycle" ADD COLUMN "releasedByOperatorRecordId" TEXT/);
    expect(SQLITE_MIG).toMatch(/CREATE INDEX "BillingCycle_releasedByOperatorRecordId_idx"/);
  });

  it("Postgres migration adds the FK + relaxes mandate.clubId NOT NULL", () => {
    expect(PG_MIG).toMatch(/ALTER TABLE "BillingCycle" ADD COLUMN "releasedByOperatorRecordId" TEXT/);
    expect(PG_MIG).toMatch(/REFERENCES "OperatorVerificationRecord"\("id"\)/);
    expect(PG_MIG).toMatch(/ALTER TABLE "SubscriptionPaymentMandate" ALTER COLUMN "clubId" DROP NOT NULL/);
  });

  it("neither migration drops a table or renames a column", () => {
    for (const sql of [SQLITE_MIG, PG_MIG]) {
      expect(sql).not.toMatch(/DROP TABLE/i);
      expect(sql).not.toMatch(/RENAME COLUMN/i);
    }
  });
});

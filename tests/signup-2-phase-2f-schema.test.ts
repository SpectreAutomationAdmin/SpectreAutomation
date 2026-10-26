// SIGNUP-2 Phase 2F (2026-10-26) -- Schema extension contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SQLITE = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
const PG = readFileSync(join(ROOT, "prisma-postgres/schema.prisma"), "utf8");
const SQLITE_MIG = readFileSync(
  join(ROOT, "prisma/migrations/20261026_signup_2f_activation_authorisation/migration.sql"),
  "utf8",
);
const PG_MIG = readFileSync(
  join(ROOT, "prisma-postgres/migrations/20261026_signup_2f_activation_authorisation/migration.sql"),
  "utf8",
);

describe("SIGNUP-2 Phase 2F · TenantProvisioningJob adds 4 nullable columns", () => {
  for (const [label, schema] of [
    ["sqlite", SQLITE],
    ["postgres", PG],
  ] as const) {
    it(`${label}: authorisationEvidenceSource / authorisationExpiresAt / invalidatedAt / invalidatedReason present`, () => {
      const block = schema.match(/model TenantProvisioningJob[\s\S]+?^}/m)![0];
      expect(block).toMatch(/authorisationEvidenceSource\s+String\?/);
      expect(block).toMatch(/authorisationExpiresAt\s+DateTime\?/);
      expect(block).toMatch(/invalidatedAt\s+DateTime\?/);
      expect(block).toMatch(/invalidatedReason\s+String\?/);
    });

    it(`${label}: adds hot-path indexes`, () => {
      const block = schema.match(/model TenantProvisioningJob[\s\S]+?^}/m)![0];
      expect(block).toMatch(/@@index\(\[authorisationEvidenceSource\]\)/);
      expect(block).toMatch(/@@index\(\[invalidatedAt\]\)/);
    });

    it(`${label}: clubSubscriptionClubId relaxed to nullable (Phase 2F pre-tenancy)`, () => {
      const block = schema.match(/model TenantProvisioningJob[\s\S]+?^}/m)![0];
      expect(block).toMatch(/clubSubscriptionClubId\s+String\?/);
      expect(block).toMatch(/clubSubscription\s+ClubSubscription\?/);
    });
  }
});

describe("SIGNUP-2 Phase 2F · migrations are additive-only", () => {
  for (const [label, sql] of [
    ["sqlite", SQLITE_MIG],
    ["postgres", PG_MIG],
  ] as const) {
    it(`${label}: adds 4 ADD COLUMN + 2 CREATE INDEX`, () => {
      expect((sql.match(/ADD COLUMN "authorisation/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect(sql).toMatch(/ADD COLUMN "invalidatedAt"/);
      expect(sql).toMatch(/ADD COLUMN "invalidatedReason"/);
      expect(sql).toMatch(/CREATE INDEX "TenantProvisioningJob_authorisationEvidenceSource_idx"/);
      expect(sql).toMatch(/CREATE INDEX "TenantProvisioningJob_invalidatedAt_idx"/);
    });

    it(`${label}: never drops a table or renames a column`, () => {
      expect(sql).not.toMatch(/DROP TABLE/i);
      expect(sql).not.toMatch(/RENAME COLUMN/i);
    });
  }

  it("Postgres migration relaxes clubSubscriptionClubId to nullable", () => {
    expect(PG_MIG).toMatch(/ALTER TABLE "TenantProvisioningJob" ALTER COLUMN "clubSubscriptionClubId" DROP NOT NULL/);
  });
});

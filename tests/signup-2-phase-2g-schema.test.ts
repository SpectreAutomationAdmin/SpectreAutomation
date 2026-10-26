// SIGNUP-2 Phase 2G (2026-10-26) -- Schema contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SQLITE = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
const PG = readFileSync(join(ROOT, "prisma-postgres/schema.prisma"), "utf8");
const SQLITE_MIG = readFileSync(
  join(ROOT, "prisma/migrations/20261026_signup_2g_provisioning_cancelled_at/migration.sql"),
  "utf8",
);
const PG_MIG = readFileSync(
  join(ROOT, "prisma-postgres/migrations/20261026_signup_2g_provisioning_cancelled_at/migration.sql"),
  "utf8",
);

describe("SIGNUP-2 Phase 2G · provisioningCancelledAt sentinel columns", () => {
  for (const [label, schema] of [
    ["sqlite", SQLITE],
    ["postgres", PG],
  ] as const) {
    it(`${label}: User gets provisioningCancelledAt`, () => {
      const block = schema.match(/model User\s*\{[\s\S]+?^}/m)![0];
      expect(block).toMatch(/provisioningCancelledAt\s+DateTime\?/);
    });

    it(`${label}: Club gets provisioningCancelledAt`, () => {
      const block = schema.match(/model Club\s*\{[\s\S]+?^}/m)![0];
      expect(block).toMatch(/provisioningCancelledAt\s+DateTime\?/);
    });

    it(`${label}: ClubSubscription gets provisioningCancelledAt`, () => {
      const block = schema.match(/model ClubSubscription\s*\{[\s\S]+?^}/m)![0];
      expect(block).toMatch(/provisioningCancelledAt\s+DateTime\?/);
    });
  }
});

describe("SIGNUP-2 Phase 2G · migration file is additive-only", () => {
  it("SQLite migration adds the three columns and does not drop or rename anything", () => {
    expect(SQLITE_MIG).toMatch(/ALTER TABLE "User"\s+ADD COLUMN "provisioningCancelledAt"/);
    expect(SQLITE_MIG).toMatch(/ALTER TABLE "Club"\s+ADD COLUMN "provisioningCancelledAt"/);
    expect(SQLITE_MIG).toMatch(/ALTER TABLE "ClubSubscription"\s+ADD COLUMN "provisioningCancelledAt"/);
    expect(SQLITE_MIG).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    expect(SQLITE_MIG).not.toMatch(/RENAME/i);
  });

  it("Postgres migration adds the three columns + indexes, additive-only", () => {
    expect(PG_MIG).toMatch(/ALTER TABLE "User"\s+ADD COLUMN "provisioningCancelledAt"\s+TIMESTAMP/);
    expect(PG_MIG).toMatch(/ALTER TABLE "Club"\s+ADD COLUMN "provisioningCancelledAt"\s+TIMESTAMP/);
    expect(PG_MIG).toMatch(/ALTER TABLE "ClubSubscription"\s+ADD COLUMN "provisioningCancelledAt"\s+TIMESTAMP/);
    expect(PG_MIG).toMatch(/CREATE INDEX "User_provisioningCancelledAt_idx"/);
    expect(PG_MIG).toMatch(/CREATE INDEX "Club_provisioningCancelledAt_idx"/);
    expect(PG_MIG).toMatch(/CREATE INDEX "ClubSubscription_provisioningCancelledAt_idx"/);
    expect(PG_MIG).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    expect(PG_MIG).not.toMatch(/RENAME/i);
  });
});

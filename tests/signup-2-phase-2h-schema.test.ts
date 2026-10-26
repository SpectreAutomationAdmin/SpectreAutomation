// SIGNUP-2 Phase 2H (2026-10-26) -- Schema contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SQLITE = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
const PG = readFileSync(join(ROOT, "prisma-postgres/schema.prisma"), "utf8");
const SQLITE_MIG = readFileSync(
  join(ROOT, "prisma/migrations/20261026_signup_2h_tenant_lifecycle_transition/migration.sql"),
  "utf8",
);
const PG_MIG = readFileSync(
  join(ROOT, "prisma-postgres/migrations/20261026_signup_2h_tenant_lifecycle_transition/migration.sql"),
  "utf8",
);

describe("SIGNUP-2 Phase 2H · TenantLifecycleTransition model", () => {
  for (const [label, schema] of [
    ["sqlite", SQLITE],
    ["postgres", PG],
  ] as const) {
    it(`${label}: declares model with required fields`, () => {
      const block = schema.match(/model TenantLifecycleTransition\s*\{[\s\S]+?^}/m)![0];
      for (const field of [
        "clubId",
        "previousStatus",
        "newStatus",
        "previousAccessTier",
        "newAccessTier",
        "trigger",
        "operatorUserId",
        "authoriserUserId",
        "reasonCode",
        "effectiveAt",
      ]) {
        expect(block).toContain(field);
      }
    });
    it(`${label}: hot-path indexes present`, () => {
      const block = schema.match(/model TenantLifecycleTransition\s*\{[\s\S]+?^}/m)![0];
      expect(block).toMatch(/@@index\(\[clubId,\s*effectiveAt\]\)/);
      expect(block).toMatch(/@@index\(\[newStatus,\s*effectiveAt\]\)/);
      expect(block).toMatch(/@@index\(\[trigger,\s*effectiveAt\]\)/);
      expect(block).toMatch(/@@index\(\[operatorUserId,\s*effectiveAt\]\)/);
    });
    it(`${label}: Club back-relation declared`, () => {
      const clubBlock = schema.match(/model Club\s*\{[\s\S]+?^}/m)![0];
      expect(clubBlock).toMatch(/lifecycleTransitions\s+TenantLifecycleTransition\[\]/);
    });
  }
});

describe("SIGNUP-2 Phase 2H · migration is additive-only", () => {
  it("SQLite migration creates the table + indexes, no drops", () => {
    expect(SQLITE_MIG).toMatch(/CREATE TABLE "TenantLifecycleTransition"/);
    expect(SQLITE_MIG).toMatch(/CREATE INDEX "TenantLifecycleTransition_clubId_effectiveAt_idx"/);
    expect(SQLITE_MIG).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)/i);
  });
  it("Postgres migration mirrors + adds FK + indexes, no drops", () => {
    expect(PG_MIG).toMatch(/CREATE TABLE "TenantLifecycleTransition"/);
    expect(PG_MIG).toMatch(/CONSTRAINT "TenantLifecycleTransition_clubId_fkey"/);
    expect(PG_MIG).toMatch(/CREATE INDEX "TenantLifecycleTransition_clubId_effectiveAt_idx"/);
    expect(PG_MIG).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)/i);
  });
});

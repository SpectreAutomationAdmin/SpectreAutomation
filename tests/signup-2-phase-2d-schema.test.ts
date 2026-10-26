// SIGNUP-2 Phase 2D (2026-10-25) -- OperatorVerificationRecord
// schema contract.
//
// Pins the model's shape in both Prisma schemas + the dual migration
// files.  Phase 2D is strictly additive: one new model, no existing
// column altered, no existing index removed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SQLITE_SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
const PG_SCHEMA = readFileSync(join(ROOT, "prisma-postgres/schema.prisma"), "utf8");
const SQLITE_MIGRATION = readFileSync(
  join(ROOT, "prisma/migrations/20261025_signup_2d_operator_verification/migration.sql"),
  "utf8",
);
const PG_MIGRATION = readFileSync(
  join(ROOT, "prisma-postgres/migrations/20261025_signup_2d_operator_verification/migration.sql"),
  "utf8",
);

describe("SIGNUP-2 Phase 2D · OperatorVerificationRecord model present in both schemas", () => {
  for (const [label, schema] of [
    ["sqlite", SQLITE_SCHEMA],
    ["postgres", PG_SCHEMA],
  ] as const) {
    it(`${label}: model OperatorVerificationRecord declared`, () => {
      expect(schema).toMatch(/model OperatorVerificationRecord \{/);
    });

    it(`${label}: carries every founder §3B field`, () => {
      expect(schema).toMatch(/concept\s+String/);
      expect(schema).toMatch(/finding\s+String/);
      expect(schema).toMatch(/evidenceSource\s+String\?/);
      expect(schema).toMatch(/evidenceProvenance\s+String\?/);
      expect(schema).toMatch(/evidenceReference\s+String\?/);
      expect(schema).toMatch(/reason\s+String\?/);
      expect(schema).toMatch(/operatorUserId\s+String/);
      expect(schema).toMatch(/verifiedAt\s+DateTime/);
      expect(schema).toMatch(/expiresAt\s+DateTime\?/);
    });

    it(`${label}: cascades on SignupRegistration delete + hot-path indexes present`, () => {
      expect(schema).toMatch(/signupRegistration\s+SignupRegistration @relation\(fields:\s*\[signupRegistrationId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);
      expect(schema).toMatch(/@@index\(\[signupRegistrationId, createdAt\]\)/);
      expect(schema).toMatch(/@@index\(\[operatorUserId, createdAt\]\)/);
      expect(schema).toMatch(/@@index\(\[concept, createdAt\]\)/);
      expect(schema).toMatch(/@@index\(\[expiresAt\]\)/);
    });

    it(`${label}: SignupRegistration gains back-relation operatorVerificationRecords`, () => {
      expect(schema).toMatch(/operatorVerificationRecords OperatorVerificationRecord\[\]/);
    });
  }
});

describe("SIGNUP-2 Phase 2D · migrations are additive-only", () => {
  for (const [label, sql] of [
    ["sqlite", SQLITE_MIGRATION],
    ["postgres", PG_MIGRATION],
  ] as const) {
    it(`${label}: adds exactly one CREATE TABLE OperatorVerificationRecord`, () => {
      const matches = sql.match(/CREATE TABLE "OperatorVerificationRecord"/g) ?? [];
      expect(matches.length).toBe(1);
    });

    it(`${label}: does NOT alter any existing table`, () => {
      expect(sql).not.toMatch(/ALTER TABLE/i);
      expect(sql).not.toMatch(/DROP TABLE/i);
    });

    it(`${label}: FK cascades on SignupRegistration delete`, () => {
      // Allow a line-wrap between the REFERENCES clause and the
      // ON DELETE CASCADE action (Postgres mirror wraps for readability).
      expect(sql).toMatch(/REFERENCES "SignupRegistration"\("id"\)[\s\S]*?ON DELETE CASCADE/);
    });
  }
});

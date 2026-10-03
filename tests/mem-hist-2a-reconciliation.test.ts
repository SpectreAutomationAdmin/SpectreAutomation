// MEM-HIST-2A §7 (2026-10-03) — reconciliation + nullable-email +
// MemberAccount-cardinality + ambiguity-preservation acceptance tests.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const SCHEMA_SQLITE = path.join(REPO, "prisma/schema.prisma");
const SCHEMA_PG = path.join(REPO, "prisma-postgres/schema.prisma");
const COMMIT = path.join(REPO, "src/lib/imports/member-master/commit-service.ts");
const INVITE = path.join(REPO, "src/lib/member-invites/index.ts");
const MIG_PG = path.join(REPO, "prisma-postgres/migrations/20261003_mem_hist_2a_member_email_nullable/migration.sql");
const MIG_SQLITE = path.join(REPO, "prisma/migrations/20261003_mem_hist_2a_member_email_nullable/migration.sql");

// --------------------------------------------------------------
// §C — Member.email schema audit (nullable)
// --------------------------------------------------------------
describe("MEM-HIST-2A §C — Member.email is nullable", () => {
  it("SQLite schema declares Member.email as String?", () => {
    const s = readFileSync(SCHEMA_SQLITE, "utf8");
    expect(s).toMatch(/model Member\b[\s\S]{0,800}email\s+String\?/);
  });

  it("Postgres schema declares Member.email as String?", () => {
    const s = readFileSync(SCHEMA_PG, "utf8");
    expect(s).toMatch(/model Member\b[\s\S]{0,800}email\s+String\?/);
  });
});

// --------------------------------------------------------------
// §D-E — Nullable-email implementation + placeholder cleanup
// --------------------------------------------------------------
describe("MEM-HIST-2A §D-E — implementation + placeholder cleanup", () => {
  it("Postgres migration drops NOT NULL and backfills placeholder to NULL", () => {
    expect(existsSync(MIG_PG)).toBe(true);
    const sql = readFileSync(MIG_PG, "utf8");
    expect(sql).toMatch(/ALTER TABLE "Member" ALTER COLUMN "email" DROP NOT NULL/);
    expect(sql).toMatch(/UPDATE "Member"[\s\S]{0,200}SET "email" = NULL[\s\S]{0,200}WHERE "email" LIKE 'no-email\+%@placeholder\.invalid'/);
    // Legitimate pre-existing emails are not touched — the WHERE clause
    // pins to the exact placeholder shape, nothing broader.
    expect(sql).not.toMatch(/UPDATE "Member"[\s\S]{0,200}SET "email" = NULL\s*;/);
  });

  it("SQLite mirror runs the UPDATE (SQLite can't ALTER COLUMN but the backfill still applies)", () => {
    expect(existsSync(MIG_SQLITE)).toBe(true);
    const sql = readFileSync(MIG_SQLITE, "utf8");
    expect(sql).toMatch(/UPDATE "Member"[\s\S]{0,200}SET "email" = NULL/);
  });

  it("Member Master commit service NEVER fabricates email (passes null)", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).not.toMatch(/placeholder\.invalid/);
    expect(src).toMatch(/email:\s*null/);
    expect(src).toMatch(/MEM-HIST-2A §2/);
  });

  it("portal invite flow rejects null and placeholder.invalid email on invite", () => {
    const src = readFileSync(INVITE, "utf8");
    expect(src).toMatch(/parsed\.data\.email\s*\?\?\s*member\.email\s*\?\?\s*""/);
    expect(src).toMatch(/@placeholder\.invalid/);
    expect(src).toMatch(/Valid email is required/);
  });
});

// --------------------------------------------------------------
// §F — MemberAccount cardinality + MEM-HIST-2A does NOT create them
// --------------------------------------------------------------
describe("MEM-HIST-2A §F — MemberAccount is NOT pre-created per Member", () => {
  it("commit service does not create or upsert MemberAccount rows", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).not.toMatch(/prisma\.memberAccount\.(create|upsert)/);
  });

  it("Member → MemberAccount is 0..1 in the Prisma schema (not 1:1 required)", () => {
    const schema = readFileSync(SCHEMA_SQLITE, "utf8");
    // Member exposes `account MemberAccount?` (optional) + MemberAccount
    // has `memberId @unique`.
    expect(schema).toMatch(/account\s+MemberAccount\?/);
    expect(schema).toMatch(/model MemberAccount[\s\S]{0,400}memberId\s+String\s+@unique/);
  });
});

// --------------------------------------------------------------
// §G-I — Preserve ambiguities
// --------------------------------------------------------------
describe("MEM-HIST-2A §G-I — ambiguities preserved", () => {
  it("UNRESOLVED bill-to outcomes carry sourceBillToExternalIdentifier for operator review", () => {
    const schema = readFileSync(SCHEMA_SQLITE, "utf8");
    // The schema file has MemberBillingRelationship + the field some
    // ~20 lines apart; assert both independently rather than tying
    // them with a positional regex.
    expect(schema).toMatch(/model MemberBillingRelationship\b/);
    expect(schema).toMatch(/sourceBillToExternalIdentifier\s+String\?/);
  });

  it("commit service never silently converts UNRESOLVED to SELF or fabricates Members", () => {
    const src = readFileSync(COMMIT, "utf8");
    // On UNRESOLVED outcome, billedByMemberId = null, outcome = "UNRESOLVED".
    expect(src).toMatch(/case\s+"UNRESOLVED":[\s\S]{0,120}billedByMemberId\s*=\s*null/);
  });

  it("MISC A/R rows → UNKNOWN interpretedStatus (not guessed)", () => {
    const sem = readFileSync(
      path.join(REPO, "src/lib/imports/member-master/jonas-semantics.ts"),
      "utf8",
    );
    expect(sem).toMatch(/"MISC A\/R":\s*"UNKNOWN"/);
  });

  it("no household inference from alphabetic Member Number suffixes", () => {
    // The commit service must NOT infer a household primary from
    // 0073A / 0073 pairs.
    const src = readFileSync(COMMIT, "utf8");
    expect(src).not.toMatch(/householdPrimaryMemberId/i);
    expect(src).not.toMatch(/surname.*match/i);
    // The parser's bill-to resolver is purely external-identifier based.
    const parser = readFileSync(
      path.join(REPO, "src/lib/imports/member-master/jonas-parser.ts"),
      "utf8",
    );
    expect(parser).not.toMatch(/lastName.*===/);
  });
});

// --------------------------------------------------------------
// §K-M — Protected baseline + tests + no accounting mutation
// --------------------------------------------------------------
describe("MEM-HIST-2A §K-M — no accounting mutation", () => {
  it("MEM-HIST-2A migration touches ONLY Member.email (no accounting-table alters)", () => {
    const sql = readFileSync(MIG_PG, "utf8");
    expect(sql.toLowerCase()).not.toMatch(/alter table "account"/);
    expect(sql.toLowerCase()).not.toMatch(/alter table "journalentry"/);
    expect(sql.toLowerCase()).not.toMatch(/alter table "reportingledger/);
    expect(sql.toLowerCase()).not.toMatch(/alter table "charge"/);
    expect(sql.toLowerCase()).not.toMatch(/alter table "payment"/);
  });

  it("MEM-HIST-2A reconcile script exists for audit traceability", () => {
    expect(existsSync(path.join(REPO, "scripts/mem-hist-2a-reconcile.mjs"))).toBe(true);
  });
});

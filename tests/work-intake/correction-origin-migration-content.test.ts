// Payroll-3D-3B Slice 1 (2026-09-06) — Postgres migration content
// assertion. SQLite integration tests can prove the DDL BEHAVES
// correctly, but they cannot prove the Postgres migration on disk is
// the one that will actually run against staging/production.
//
// Founder directive: "Do not weaken the DB invariant merely to
// accommodate SQLite. Add the appropriate Postgres-targeted migration
// assertion / schema test rather than pretending SQLite proves it."
//
// This suite reads the raw SQL and asserts:
//   - the migration folder exists at the expected path
//   - the pre-check DO block is present (fails migration if any
//     duplicate tuple exists for either kind)
//   - the CREATE UNIQUE INDEX names the canonical index string
//   - the index is filtered by role='PRIMARY' AND kind IN (both)
//   - the constraint applies ONLY to the two correction kinds
//     (no other kind is named)

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORRECTION_REVIEW_ORIGIN_INDEX_NAME } from "@/lib/work-intake/origin-conflict";

const POSTGRES_MIGRATION_PATH = join(
  process.cwd(),
  "prisma-postgres",
  "migrations",
  "20260911_payroll_3d3b_correction_review_partial_unique",
  "migration.sql",
);
const SQLITE_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260911_payroll_3d3b_correction_review_partial_unique",
  "migration.sql",
);

describe("Payroll-3D-3B Slice 1 · Postgres migration content", () => {
  const sql = readFileSync(POSTGRES_MIGRATION_PATH, "utf8");

  it("declares the canonical index name", () => {
    expect(sql).toMatch(new RegExp(`"${CORRECTION_REVIEW_ORIGIN_INDEX_NAME}"`));
  });

  it("declares CREATE UNIQUE INDEX (not a plain index)", () => {
    expect(sql).toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
  });

  it("targets the WorkIntakeOrigin table + correct columns in the index-key order", () => {
    // The index key is (clubId, kind, referenceId) — order matters for
    // Postgres index lookups. Assert exact substring.
    expect(sql).toMatch(/ON\s+"WorkIntakeOrigin"\s*\(\s*"clubId"\s*,\s*"kind"\s*,\s*"referenceId"\s*\)/i);
  });

  it("filters by role='PRIMARY' AND the two correction kinds only", () => {
    // Filter must include both correction kinds and no others.
    expect(sql).toMatch(/WHERE[\s\S]*"role"\s*=\s*'PRIMARY'/i);
    expect(sql).toMatch(/"kind"\s+IN\s*\([\s\S]*'TIMECLOCK_CORRECTION_REVIEW'[\s\S]*'TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP'[\s\S]*\)/);
  });

  it("names ONLY the two correction kinds — no other kind is constrained by this migration", () => {
    // Guardrail: if a future edit accidentally broadens the filter to
    // additional kinds, this test fails. Deferred kinds
    // (INGESTED_DOCUMENT, MEMBER_ACCOUNT, PAYROLL_TIMESHEET_APPROVAL,
    // etc.) MUST NOT appear here.
    const forbiddenKinds = [
      "INGESTED_DOCUMENT",
      "AP_INVOICE",
      "MEMBER_ACCOUNT",
      "MEMBER",
      "COLLECTION_NOTICE",
      "MEMBER_TRANSACTION",
      "PAYROLL_TIMESHEET_APPROVAL",
      "PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP",
      "PAYROLL_DEPARTMENT_APPROVAL",
      "PAYROLL_ADMIN_PROCESSING",
      "PAYROLL_REVIEW",
      "PAYROLL_FINAL_APPROVAL",
      "PAYROLL_OPENING_BALANCE_REVIEW",
    ];
    for (const k of forbiddenKinds) {
      expect(sql.includes(`'${k}'`)).toBe(false);
    }
  });

  it("carries a pre-check DO block that aborts on any existing duplicate tuple", () => {
    // The pre-check MUST run before the CREATE UNIQUE INDEX and MUST
    // raise if any duplicate exists — never silently dedupe.
    expect(sql).toMatch(/DO\s+\$\$[\s\S]*RAISE\s+EXCEPTION[\s\S]*\$\$/i);
    // The RAISE must appear before the CREATE UNIQUE INDEX line.
    const raiseIdx = sql.search(/RAISE\s+EXCEPTION/i);
    const createIdx = sql.search(/CREATE\s+UNIQUE\s+INDEX/i);
    expect(raiseIdx).toBeGreaterThan(0);
    expect(createIdx).toBeGreaterThan(raiseIdx);
  });

  it("pre-check scopes the duplicate audit to the two correction kinds only", () => {
    // Extract the DO block and verify its own IN filter matches.
    const doBlock = sql.match(/DO\s+\$\$[\s\S]*?\$\$/i)?.[0] ?? "";
    expect(doBlock).toMatch(/'TIMECLOCK_CORRECTION_REVIEW'/);
    expect(doBlock).toMatch(/'TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP'/);
  });
});

describe("Payroll-3D-3B Slice 1 · SQLite parity migration content", () => {
  const sql = readFileSync(SQLITE_MIGRATION_PATH, "utf8");

  it("declares the same canonical index name", () => {
    expect(sql).toMatch(new RegExp(`"${CORRECTION_REVIEW_ORIGIN_INDEX_NAME}"`));
  });

  it("targets the same table + columns + filter as the Postgres migration", () => {
    expect(sql).toMatch(/ON\s+"WorkIntakeOrigin"\s*\(\s*"clubId"\s*,\s*"kind"\s*,\s*"referenceId"\s*\)/i);
    expect(sql).toMatch(/WHERE[\s\S]*"role"\s*=\s*'PRIMARY'/i);
    expect(sql).toMatch(/"kind"\s+IN\s*\([\s\S]*'TIMECLOCK_CORRECTION_REVIEW'[\s\S]*'TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP'[\s\S]*\)/);
  });
});

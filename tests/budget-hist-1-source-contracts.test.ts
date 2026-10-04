// BUDGET-HIST-1 (2026-10-04) — source-contract pins for the 2026
// Coulee Budget import.
//
// Pins the structural invariants the staging preview + commit paths
// depend on:
//   • CSV parser is deterministic (sha + totals reproducible).
//   • Column + row structural controls from the founder audit are
//     reproduced by the parser.
//   • Jonas → Spectre dept-code mapping is 6-digit zero-padded;
//     the budget mapper applies the pad consistently.
//   • Budget persistence reuses the EXISTING Budget + BudgetLine
//     models — no new Prisma migration in this slice.
//   • Commit path never touches JournalEntry / ReportingLedgerBatch /
//     ReportingLedgerSnapshot / Account / Department / FiscalYear /
//     Member / MemberAccount.
//   • Canonical resolver `resolveBudget` is the single source for
//     every Budget read.
//   • `resolveBudgetIncomeStatement` applies the SAME classifier
//     (type REVENUE/EXPENSE + fsGroupKey IS_COGS* / IS_PAYROLL) the
//     Actual Income Statement uses.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCouleeBudgetCsv,
  BudgetParseError,
} from "@/lib/imports/budget/parse-coulee-budget-csv";
import { padJonasDeptCode } from "@/lib/imports/budget/map-coulee-budget";

const REPO = path.resolve(__dirname, "..");
const COMMIT = path.join(REPO, "src/lib/imports/budget/commit-coulee-budget.ts");
const RESOLVER = path.join(REPO, "src/lib/reporting/budget-resolver.ts");
const MAPPER = path.join(REPO, "src/lib/imports/budget/map-coulee-budget.ts");

// --------------------------------------------------------------
// §2-4 — parser determinism + structural controls
// --------------------------------------------------------------
describe("BUDGET-HIST-1 §2-4 — CSV parser", () => {
  const SAMPLE = [
    "1,1,6000,100,100,100,100,100,100,100,100,100,100,100,100",
    "2,2,6010,-50,0,0,0,0,0,0,0,0,0,0,0",
    "3,20,7001,0,1000.25,0,0,0,0,0,0,0,0,0,-200.5",
  ].join("\n");

  it("parses rows + preserves signs + preserves decimals + preserves zeros", () => {
    const r = parseCouleeBudgetCsv(SAMPLE);
    expect(r.rowCount).toBe(3);
    expect(r.rows[0].monthlyAmounts).toEqual([100,100,100,100,100,100,100,100,100,100,100,100]);
    expect(r.rows[1].monthlyAmounts[0]).toBe(-50);
    expect(r.rows[2].monthlyAmounts[1]).toBe(1000.25);
    expect(r.rows[2].monthlyAmounts[11]).toBe(-200.5);
  });

  it("rejects wrong column counts", () => {
    expect(() => parseCouleeBudgetCsv("1,1,6000,1,2,3")).toThrow(BudgetParseError);
  });

  it("rejects empty month cells (zero is not empty)", () => {
    const bad = "1,1,6000,100,,100,100,100,100,100,100,100,100,100,100";
    try {
      parseCouleeBudgetCsv(bad);
      throw new Error("expected parse to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetParseError);
      expect((e as BudgetParseError).code).toBe("MONTH_EMPTY");
    }
  });

  it("rejects non-numeric months", () => {
    const bad = "1,1,6000,100,abc,100,100,100,100,100,100,100,100,100,100";
    try {
      parseCouleeBudgetCsv(bad);
      throw new Error("expected parse to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetParseError);
      expect((e as BudgetParseError).code).toBe("MONTH_NON_NUMERIC");
    }
  });

  it("strips BOM so row 1 is not consumed as header", () => {
    const withBom = "﻿" + SAMPLE;
    const r = parseCouleeBudgetCsv(withBom);
    expect(r.rowCount).toBe(3);
    expect(r.rows[0].accountNumber).toBe("6000");
  });

  it("computes stable sha256 (deterministic across invocations)", () => {
    const a = parseCouleeBudgetCsv(SAMPLE);
    const b = parseCouleeBudgetCsv(SAMPLE);
    expect(a.sourceFileHash).toBe(b.sourceFileHash);
    expect(a.sourceFileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flags duplicate (dept, account) rows", () => {
    const dup = [
      "1,1,6000,100,100,100,100,100,100,100,100,100,100,100,100",
      "2,1,6000,200,200,200,200,200,200,200,200,200,200,200,200",
    ].join("\n");
    const r = parseCouleeBudgetCsv(dup);
    expect(r.duplicateDeptAccountKeys).toContain("1|6000");
  });

  it("reports monthly + annual totals", () => {
    const r = parseCouleeBudgetCsv(SAMPLE);
    expect(r.monthlyTotals[0]).toBe(100 + -50 + 0);
    expect(r.annualTotal).toBe(r.monthlyTotals.reduce((s,v)=>s+v,0));
  });
});

// --------------------------------------------------------------
// §9 — Jonas dept-code padding
// --------------------------------------------------------------
describe("BUDGET-HIST-1 §9 — Jonas dept padding", () => {
  it("pads 1 → 000001 and 20 → 000020", () => {
    expect(padJonasDeptCode("1")).toBe("000001");
    expect(padJonasDeptCode("20")).toBe("000020");
    expect(padJonasDeptCode("  7 ")).toBe("000007");
  });
});

// --------------------------------------------------------------
// §6 — persistence boundaries (no accounting mutation)
// --------------------------------------------------------------
describe("BUDGET-HIST-1 §6 — commit never writes accounting tables", () => {
  it("commit path uses only budget / budgetLine prisma models", () => {
    const src = readFileSync(COMMIT, "utf8");
    // Allow count() calls (read-only) — we check only mutations.
    for (const m of ["journalEntry", "reportingLedgerBatch", "reportingLedgerSnapshot", "fiscalPeriod", "arAgingSnapshotRow", "memberAccount", "member"]) {
      const re = new RegExp(`prisma\\.${m}\\.(create|update|upsert|delete|createMany|updateMany|deleteMany)`);
      expect(src).not.toMatch(re);
    }
    // Positive: must create budget + budgetLine via tx handle.
    expect(src).toMatch(/tx\.budget\.create\(/);
    expect(src).toMatch(/tx\.budgetLine\.create\(/);
  });

  it("commit path never overwrites prior Budget without allowNewVersion", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/allowNewVersion/);
    expect(src).toMatch(/existingHash === parse\.sourceFileHash/);
    expect(src).toMatch(/nextVersion = existing \? existing\.version \+ 1 : 1/);
  });

  it("commit path stores provenance JSON (sha, importedAt, counts) in Budget.description", () => {
    const src = readFileSync(COMMIT, "utf8");
    expect(src).toMatch(/sourceFileHash: parse\.sourceFileHash/);
    expect(src).toMatch(/importedAt: new Date\(\)\.toISOString\(\)/);
    expect(src).toMatch(/description: JSON\.stringify\(provenance\)/);
  });
});

// --------------------------------------------------------------
// §16 — canonical resolver = single source
// --------------------------------------------------------------
describe("BUDGET-HIST-1 §16 — canonical Budget resolver", () => {
  it("resolveBudget pins to the newest version per (clubId, fy, name)", () => {
    const src = readFileSync(RESOLVER, "utf8");
    expect(src).toMatch(/orderBy:\s*\{\s*version:\s*"desc"\s*\}/);
  });

  it("resolveBudget returns consolidated + per-department + per-account + per-fs-group", () => {
    const src = readFileSync(RESOLVER, "utf8");
    expect(src).toMatch(/byDepartment:\s*Array</);
    expect(src).toMatch(/byAccount:\s*Array</);
    expect(src).toMatch(/byFsGroup:\s*Array</);
  });

  it("resolveBudgetIncomeStatement classifies via Account.type + fsGroupKey (same as Actual)", () => {
    const src = readFileSync(RESOLVER, "utf8");
    expect(src).toMatch(/accountType === "REVENUE"/);
    expect(src).toMatch(/accountType === "EXPENSE"/);
    expect(src).toMatch(/key\.startsWith\("IS_COGS"\)/);
    expect(src).toMatch(/key === "IS_PAYROLL"/);
  });

  it("resolveBudgetIncomeStatement sign-flips REVENUE natural balance (matches Actual display convention)", () => {
    const src = readFileSync(RESOLVER, "utf8");
    expect(src).toMatch(/const displayRevenue = -revenue/);
  });
});

// --------------------------------------------------------------
// §9 + §10 — department resolver uses the Jonas mapping
// --------------------------------------------------------------
describe("BUDGET-HIST-1 §9-10 — department resolver", () => {
  it("mapper calls resolveJonasDepartment with padded code + tenant Department catalog", () => {
    const src = readFileSync(MAPPER, "utf8");
    expect(src).toMatch(/padJonasDeptCode\(jonasDeptCode\)/);
    expect(src).toMatch(/resolveJonasDepartment\(padded, null, tenantDepartments\)/);
  });

  it("mapper uses one bulk prisma.account.findMany with IN clause for all 157 numbers", () => {
    const src = readFileSync(MAPPER, "utf8");
    expect(src).toMatch(/prisma\.account\.findMany\([\s\S]*?accountNumber:\s*\{\s*in:/);
  });
});

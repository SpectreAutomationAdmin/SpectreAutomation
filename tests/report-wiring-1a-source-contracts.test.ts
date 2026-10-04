// REPORT-WIRING-1A (2026-10-04) — source-contract pins for the
// canonical Operating-Fund classifier. Pins that every financial-
// reporting path now filters REVENUE / EXPENSE accounts by
// `Account.fundApplicability` including "OPERATING" so a CAPITAL-
// tagged account (e.g. LRP Capital Improvement Dues, Initiation Fee)
// is excluded from Operating Revenue + Operating NOI everywhere.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isOperatingFundTag } from "@/lib/reporting/budget-resolver";

const REPO = path.resolve(__dirname, "..");
const RATIO = path.join(REPO, "src/lib/reporting/ratio-registry.ts");
const BUDGET = path.join(REPO, "src/lib/reporting/budget-resolver.ts");
const OPRES = path.join(REPO, "src/lib/reporting/operating-results.ts");
const DEPTPL = path.join(REPO, "src/lib/accounting/dept-pl-from-snapshot.ts");

describe("REPORT-WIRING-1A §7 — isOperatingFundTag canonical helper", () => {
  it("returns true when 'OPERATING' is present (comma-separated or standalone)", () => {
    expect(isOperatingFundTag("OPERATING")).toBe(true);
    expect(isOperatingFundTag("OPERATING,CAPITAL")).toBe(true);
    expect(isOperatingFundTag("CAPITAL,OPERATING")).toBe(true);
    expect(isOperatingFundTag(" operating , capital ")).toBe(true);
  });

  it("returns false for CAPITAL-only accounts (the 4 Coulee delta accounts' tag)", () => {
    expect(isOperatingFundTag("CAPITAL")).toBe(false);
  });

  it("returns false for null / empty (unmapped-fund diagnostic)", () => {
    expect(isOperatingFundTag(null)).toBe(false);
    expect(isOperatingFundTag("")).toBe(false);
    expect(isOperatingFundTag(undefined)).toBe(false);
  });
});

describe("REPORT-WIRING-1A §10-11 — every consumer applies the operating-fund filter", () => {
  it("ratio-registry filters by isOperatingFund before accumulating revenue / cogs / opex / payroll", () => {
    const src = readFileSync(RATIO, "utf8");
    expect(src).toMatch(/isOperatingFund/);
    // The filter is applied at the top of the per-balance loop so
    // every subsequent accumulation respects it.
    expect(src).toMatch(/const operating = isOperatingFund\(b\.fundApplicability\)/);
    expect(src).toMatch(/if \(operating\) revenue = revenue\.plus/);
  });

  it("budget-resolver.resolveBudgetMonthlyIncomeStatement + resolveBudgetIncomeStatement filter via isOperatingFundTag", () => {
    const src = readFileSync(BUDGET, "utf8");
    expect(src).toMatch(/export function isOperatingFundTag/);
    const count = (src.match(/isOperatingFundTag\(a\.fundApplicability\)/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("budget-resolver `byAccount` carries fundApplicability so downstream consumers can filter", () => {
    const src = readFileSync(BUDGET, "utf8");
    expect(src).toMatch(/fundApplicability:\s*string\s*\|\s*null/);
    // Prisma account select pulls fundApplicability.
    expect(src).toMatch(/fundApplicability:\s*true/);
  });

  it("operating-results snapshot resolver filters by isOperatingFundTag", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/isOperatingFundTag/);
    expect(src).toMatch(/if \(!isOperatingFundTag\(b\.fundApplicability\)\) continue/);
  });

  it("dept-pl-from-snapshot filters both the per-dept loop AND the reconciliation loop", () => {
    const src = readFileSync(DEPTPL, "utf8");
    const guards = src.match(/if \(!isOperatingFundTag\(b\.fundApplicability\)\) continue/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });
});

describe("REPORT-WIRING-1A §15 — architectural contract: all paths read the same classifier helper", () => {
  it("isOperatingFundTag is exported from one single place (budget-resolver.ts) + imported elsewhere", () => {
    const bud = readFileSync(BUDGET, "utf8");
    expect(bud).toMatch(/export function isOperatingFundTag/);
    for (const file of [OPRES, DEPTPL]) {
      const src = readFileSync(file, "utf8");
      // Accept both static and dynamic import patterns.
      const matched = /isOperatingFundTag.*from.*budget-resolver/.test(src)
        || /import\([^)]*budget-resolver[^)]*\)/.test(src);
      expect(matched).toBe(true);
    }
  });
});

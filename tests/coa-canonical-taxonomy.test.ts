// Spectre canonical accounting taxonomy — source-of-truth contract.
//
// Founder rule 2026-07-19: the COA template defines Spectre's
// PERMANENT accounting framework. Every Category + FS Group +
// Department key, name, and count is pinned here so an
// accidental change to coa-template.ts shows up as a test
// failure, not as silent reporting drift.

import { describe, it, expect } from "vitest";

import {
  DEFAULT_CATEGORIES,
  DEFAULT_FS_GROUPS,
  DEFAULT_DEPARTMENTS,
  FUTURE_DEPARTMENT_CODES,
  LEGACY_CATEGORY_MIGRATION,
  LEGACY_FS_GROUP_MIGRATION,
  RETIRED_FS_GROUP_KEYS,
} from "@/lib/accounting/coa-template";

describe("Canonical Category taxonomy (24 entries)", () => {
  it("DEFAULT_CATEGORIES has exactly 24 entries", () => {
    expect(DEFAULT_CATEGORIES).toHaveLength(24);
  });

  it("contains the canonical Category names spot-checked across all 5 account types", () => {
    const names = new Set(DEFAULT_CATEGORIES.map((c) => c.name));
    for (const expected of [
      // Assets
      "Current Assets",
      "Capital Assets",
      // Liabilities
      "Current Liabilities",
      // Equity
      "Equity",
      // Revenue
      "Membership Revenue",
      "Golf Operations Revenue",
      // Expenses
      "Payroll & Benefits",
      "Cost of Sales",
      "Other Expenses",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it("every Category has a non-empty key + name + valid type", () => {
    for (const c of DEFAULT_CATEGORIES) {
      expect(c.key.length).toBeGreaterThan(0);
      expect(c.name.length).toBeGreaterThan(0);
      expect(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]).toContain(c.type);
    }
  });

  it("Category keys are unique", () => {
    const keys = DEFAULT_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("Canonical FS Group taxonomy (~77 entries: 74 BS+IS + 3 CF)", () => {
  it("DEFAULT_FS_GROUPS has exactly 77 entries (27 BS + 47 IS + 3 CF)", () => {
    expect(DEFAULT_FS_GROUPS).toHaveLength(77);
  });

  it("FS Groups split across the three statements as expected", () => {
    const bs = DEFAULT_FS_GROUPS.filter((g) => g.statement === "BALANCE_SHEET");
    const is = DEFAULT_FS_GROUPS.filter((g) => g.statement === "INCOME_STATEMENT");
    const cf = DEFAULT_FS_GROUPS.filter((g) => g.statement === "CASH_FLOW");
    expect(cf).toHaveLength(3);
    expect(bs.length + is.length).toBe(74);
  });

  it("contains the canonical FS Group names spot-checked across BS / IS / equity", () => {
    const names = new Set(DEFAULT_FS_GROUPS.map((g) => g.name));
    for (const expected of [
      // Balance Sheet — assets
      "Cash & Cash Equivalents",
      "Member Receivables",
      "Capital Assets",
      // Balance Sheet — liabilities + equity
      "Member Deposits",
      "Retained Earnings",
      // Income Statement — expense buckets
      "Income Tax Expense",
      "Property Tax Expense",
      "Depreciation & Amortization",
      "Other Expenses",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it("FS Group keys are unique + namespaced (BS_ / IS_ / CF_)", () => {
    const keys = DEFAULT_FS_GROUPS.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) {
      expect(k).toMatch(/^(BS_|IS_|CF_)/);
    }
  });
});

describe("Legacy migration maps", () => {
  it("LEGACY_FS_GROUP_MIGRATION contains entries", () => {
    const entries = Object.keys(LEGACY_FS_GROUP_MIGRATION);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("LEGACY_CATEGORY_MIGRATION contains entries", () => {
    const entries = Object.keys(LEGACY_CATEGORY_MIGRATION);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("every LEGACY_FS_GROUP_MIGRATION target points at a real canonical FS Group + Category", () => {
    const canonicalFsKeys = new Set(DEFAULT_FS_GROUPS.map((g) => g.key));
    const canonicalCatKeys = new Set(DEFAULT_CATEGORIES.map((c) => c.key));
    for (const [legacyKey, target] of Object.entries(LEGACY_FS_GROUP_MIGRATION)) {
      expect(
        canonicalFsKeys.has(target.newFsGroupKey),
        `${legacyKey} → ${target.newFsGroupKey} is not in DEFAULT_FS_GROUPS`,
      ).toBe(true);
      expect(
        canonicalCatKeys.has(target.newCategoryKey),
        `${legacyKey} → ${target.newCategoryKey} is not in DEFAULT_CATEGORIES`,
      ).toBe(true);
    }
  });

  it("every LEGACY_CATEGORY_MIGRATION target points at a real canonical Category", () => {
    const canonicalCatKeys = new Set(DEFAULT_CATEGORIES.map((c) => c.key));
    for (const [legacyKey, target] of Object.entries(LEGACY_CATEGORY_MIGRATION)) {
      expect(
        canonicalCatKeys.has(target),
        `${legacyKey} → ${target} is not in DEFAULT_CATEGORIES`,
      ).toBe(true);
    }
  });

  it("RETIRED_FS_GROUP_KEYS includes the legacy bucket keys", () => {
    const retired = new Set<string>(RETIRED_FS_GROUP_KEYS);
    for (const legacyKey of [
      "BS_CURRENT_ASSETS",
      "BS_FIXED_ASSETS",
      "BS_CURRENT_LIABILITIES",
      "BS_LONG_TERM_LIABILITIES",
      "BS_EQUITY",
      "IS_REVENUE_MEMBERSHIP",
      "IS_REVENUE_FB",
      "IS_REVENUE_PROSHOP",
      "IS_COGS",
      "IS_OPEX_WAGES",
      "IS_OPEX_RM",
      "IS_OPEX_OFFICE",
      "IS_OPEX_OTHER",
    ]) {
      expect(retired.has(legacyKey)).toBe(true);
    }
  });

  it("RETIRED_FS_GROUP_KEYS does not include any current canonical key", () => {
    const canonical = new Set(DEFAULT_FS_GROUPS.map((g) => g.key));
    for (const retired of RETIRED_FS_GROUP_KEYS) {
      expect(canonical.has(retired)).toBe(false);
    }
  });
});

describe("Canonical Department taxonomy", () => {
  it("contains exactly the 6 canonical Department codes", () => {
    const codes = DEFAULT_DEPARTMENTS.map((d) => d.code).sort();
    expect(codes).toEqual(["ADMIN", "CLUBHOUSE", "EVENTS", "F&B", "GROUNDS", "PROSHOP"]);
  });

  it("Department display names match the canonical labels", () => {
    const byCode = new Map(DEFAULT_DEPARTMENTS.map((d) => [d.code, d.name]));
    expect(byCode.get("ADMIN")).toBe("Administration");
    expect(byCode.get("PROSHOP")).toBe("Pro Shop");
    expect(byCode.get("GROUNDS")).toBe("Grounds");
    expect(byCode.get("CLUBHOUSE")).toBe("Clubhouse");
    expect(byCode.get("F&B")).toBe("Food & Beverage");
    expect(byCode.get("EVENTS")).toBe("Events");
  });

  it("FUTURE_DEPARTMENT_CODES reserves exactly the 8 expansion codes", () => {
    expect([...FUTURE_DEPARTMENT_CODES].sort()).toEqual([
      "AQUATICS",
      "CURLING",
      "FITNESS",
      "HOTEL",
      "MARINA",
      "RACQUETS",
      "SKI_HILL",
      "SPA",
    ]);
  });
});

// COA-UX-2b (2026-09-29) — Classification hierarchy helpers.
//
// Locks in Section 7-11 semantics:
//   * TYPE → CATEGORY (already enforced by AccountCategory.type)
//   * CATEGORY → FS_GROUP driven by the predictor's authoritative
//     FS_GROUP_TO_CATEGORY constant, INVERTED
//   * Cascade rules on Type / Category change
//   * Mixed-type detection for the bulk Classification menu

import { describe, expect, it } from "vitest";
import {
  CATEGORY_TO_FS_GROUPS,
  KNOWN_FS_GROUP_KEYS,
  getCategoryForFsGroup,
  isFsGroupValidForCategory,
  filterFsGroupOptionsByCategory,
  filterCategoryOptionsByType,
  categoryStillValidUnderType,
  commonAccountType,
  commonCategoryKey,
} from "../../src/lib/imports/classification-hierarchy";
import { FS_GROUP_TO_CATEGORY } from "../../src/lib/imports/coa-predictor";

const FS_GROUP_CATALOG = [
  { key: "BS_CASH_EQUIVALENTS", name: "Cash & Cash Equivalents", statement: "BALANCE_SHEET" },
  { key: "BS_AR", name: "Accounts Receivable", statement: "BALANCE_SHEET" },
  { key: "BS_CAPITAL_ASSETS", name: "Capital Assets", statement: "BALANCE_SHEET" },
  { key: "BS_CIP", name: "Construction in Progress", statement: "BALANCE_SHEET" },
  { key: "IS_FOOD_SALES", name: "Food Sales", statement: "INCOME_STATEMENT" },
  { key: "IS_PAYROLL", name: "Payroll", statement: "INCOME_STATEMENT" },
  { key: "IS_REPAIRS_MAINTENANCE", name: "Repairs & Maintenance", statement: "INCOME_STATEMENT" },
];

const CATEGORY_CATALOG = [
  { key: "CURRENT_ASSETS", name: "Current Assets", accountType: "ASSET" },
  { key: "CAPITAL_ASSETS", name: "Capital Assets", accountType: "ASSET" },
  { key: "INVESTMENTS", name: "Investments", accountType: "ASSET" },
  { key: "CURRENT_LIABILITIES", name: "Current Liabilities", accountType: "LIABILITY" },
  { key: "LONG_TERM_LIABILITIES", name: "Long-Term Liabilities", accountType: "LIABILITY" },
  { key: "EQUITY", name: "Equity", accountType: "EQUITY" },
  { key: "FB_REVENUE", name: "F&B Revenue", accountType: "REVENUE" },
  { key: "GOLF_OPS_REVENUE", name: "Golf Ops Revenue", accountType: "REVENUE" },
  { key: "PAYROLL_BENEFITS", name: "Payroll & Benefits", accountType: "EXPENSE" },
  { key: "REPAIRS_MAINTENANCE", name: "Repairs & Maintenance", accountType: "EXPENSE" },
];

describe("COA-UX-2b · CATEGORY_TO_FS_GROUPS inverse map", () => {
  it("inverts every entry of FS_GROUP_TO_CATEGORY (no loss)", () => {
    let total = 0;
    for (const arr of Object.values(CATEGORY_TO_FS_GROUPS)) total += arr.length;
    expect(total).toBe(Object.keys(FS_GROUP_TO_CATEGORY).length);
  });

  it("groups Capital-Assets FS Groups together (§8 example)", () => {
    const capital = CATEGORY_TO_FS_GROUPS.CAPITAL_ASSETS;
    expect(capital).toEqual(expect.arrayContaining(["BS_CAPITAL_ASSETS", "BS_CIP", "BS_ROU_ASSETS", "BS_INTANGIBLES"]));
    expect(capital).not.toContain("BS_CASH_EQUIVALENTS");
    expect(capital).not.toContain("BS_AR");
  });

  it("KNOWN_FS_GROUP_KEYS matches FS_GROUP_TO_CATEGORY key set", () => {
    expect(KNOWN_FS_GROUP_KEYS.size).toBe(Object.keys(FS_GROUP_TO_CATEGORY).length);
    for (const k of Object.keys(FS_GROUP_TO_CATEGORY)) expect(KNOWN_FS_GROUP_KEYS.has(k)).toBe(true);
  });
});

describe("COA-UX-2b · isFsGroupValidForCategory / getCategoryForFsGroup", () => {
  it("returns true for matching pair", () => {
    expect(isFsGroupValidForCategory("BS_CAPITAL_ASSETS", "CAPITAL_ASSETS")).toBe(true);
  });

  it("returns false for canonical mismatch (BS_CASH_EQUIVALENTS is CURRENT_ASSETS, not CAPITAL_ASSETS)", () => {
    expect(isFsGroupValidForCategory("BS_CASH_EQUIVALENTS", "CAPITAL_ASSETS")).toBe(false);
  });

  it("permissive for unclassified (unknown fsGroupKey allowed under any Category)", () => {
    expect(isFsGroupValidForCategory("CUSTOM_TENANT_GROUP", "CAPITAL_ASSETS")).toBe(true);
  });

  it("permissive when Category is empty (operator hasn't picked one yet)", () => {
    expect(isFsGroupValidForCategory("BS_CAPITAL_ASSETS", null)).toBe(true);
    expect(isFsGroupValidForCategory("BS_CAPITAL_ASSETS", "")).toBe(true);
  });

  it("permissive when fsGroupKey is empty", () => {
    expect(isFsGroupValidForCategory(null, "CAPITAL_ASSETS")).toBe(true);
  });

  it("getCategoryForFsGroup returns the canonical mapping", () => {
    expect(getCategoryForFsGroup("IS_FOOD_SALES")).toBe("FB_REVENUE");
    expect(getCategoryForFsGroup("IS_PAYROLL")).toBe("PAYROLL_BENEFITS");
    expect(getCategoryForFsGroup("CUSTOM_UNKNOWN")).toBeNull();
    expect(getCategoryForFsGroup(null)).toBeNull();
  });
});

describe("COA-UX-2b · filterFsGroupOptionsByCategory (§8 UI filter)", () => {
  it("ASSET + Capital Assets → only Capital-Asset FS Groups", () => {
    const filtered = filterFsGroupOptionsByCategory(FS_GROUP_CATALOG, "CAPITAL_ASSETS");
    expect(filtered.map((o) => o.key).sort()).toEqual(["BS_CAPITAL_ASSETS", "BS_CIP"]);
    expect(filtered.map((o) => o.key)).not.toContain("BS_CASH_EQUIVALENTS");
    expect(filtered.map((o) => o.key)).not.toContain("BS_AR");
  });

  it("EXPENSE + Repairs & Maintenance → only Repairs FS Groups (from catalog)", () => {
    const filtered = filterFsGroupOptionsByCategory(FS_GROUP_CATALOG, "REPAIRS_MAINTENANCE");
    expect(filtered.map((o) => o.key)).toEqual(["IS_REPAIRS_MAINTENANCE"]);
  });

  it("REVENUE + F&B Revenue → only F&B FS Groups", () => {
    const filtered = filterFsGroupOptionsByCategory(FS_GROUP_CATALOG, "FB_REVENUE");
    expect(filtered.map((o) => o.key)).toEqual(["IS_FOOD_SALES"]);
  });

  it("no Category selected → returns input unchanged (permissive)", () => {
    expect(filterFsGroupOptionsByCategory(FS_GROUP_CATALOG, null)).toHaveLength(FS_GROUP_CATALOG.length);
    expect(filterFsGroupOptionsByCategory(FS_GROUP_CATALOG, "")).toHaveLength(FS_GROUP_CATALOG.length);
  });
});

describe("COA-UX-2b · filterCategoryOptionsByType (§7 Type→Category, extracted)", () => {
  it("ASSET → only asset categories", () => {
    const filtered = filterCategoryOptionsByType(CATEGORY_CATALOG, "ASSET");
    expect(filtered.map((c) => c.key)).toEqual(["CURRENT_ASSETS", "CAPITAL_ASSETS", "INVESTMENTS"]);
  });

  it("LIABILITY → only liability categories", () => {
    const filtered = filterCategoryOptionsByType(CATEGORY_CATALOG, "LIABILITY");
    expect(filtered.map((c) => c.key)).toEqual(["CURRENT_LIABILITIES", "LONG_TERM_LIABILITIES"]);
  });

  it("EXPENSE → only expense categories", () => {
    const filtered = filterCategoryOptionsByType(CATEGORY_CATALOG, "EXPENSE");
    expect(filtered.map((c) => c.key)).toEqual(["PAYROLL_BENEFITS", "REPAIRS_MAINTENANCE"]);
  });
});

describe("COA-UX-2b · categoryStillValidUnderType (§10 cascade helper)", () => {
  it("returns true when the Category still matches the new Type", () => {
    expect(categoryStillValidUnderType("CURRENT_ASSETS", "ASSET", CATEGORY_CATALOG)).toBe(true);
  });

  it("returns false when Type flips to something incompatible", () => {
    expect(categoryStillValidUnderType("CURRENT_ASSETS", "LIABILITY", CATEGORY_CATALOG)).toBe(false);
    expect(categoryStillValidUnderType("PAYROLL_BENEFITS", "ASSET", CATEGORY_CATALOG)).toBe(false);
  });

  it("returns true when no current Category / no next Type / unknown Category (permissive)", () => {
    expect(categoryStillValidUnderType(null, "ASSET", CATEGORY_CATALOG)).toBe(true);
    expect(categoryStillValidUnderType("CURRENT_ASSETS", null, CATEGORY_CATALOG)).toBe(true);
    expect(categoryStillValidUnderType("CUSTOM_UNKNOWN", "ASSET", CATEGORY_CATALOG)).toBe(true);
  });
});

describe("COA-UX-2b · commonAccountType / commonCategoryKey (§6 mixed-selection guard)", () => {
  it("commonAccountType returns the shared type when all rows agree", () => {
    expect(commonAccountType([{ type: "ASSET" }, { type: "ASSET" }])).toBe("ASSET");
  });

  it("commonAccountType returns null when the selection spans multiple types", () => {
    expect(commonAccountType([{ type: "ASSET" }, { type: "LIABILITY" }, { type: "EXPENSE" }])).toBeNull();
  });

  it("commonAccountType returns null for empty selection", () => {
    expect(commonAccountType([])).toBeNull();
  });

  it("commonCategoryKey returns the shared category when uniform", () => {
    expect(commonCategoryKey([{ categoryKey: "CURRENT_ASSETS" }, { categoryKey: "CURRENT_ASSETS" }])).toBe("CURRENT_ASSETS");
  });

  it("commonCategoryKey returns null when the selection spans multiple categories", () => {
    expect(commonCategoryKey([{ categoryKey: "CURRENT_ASSETS" }, { categoryKey: "CAPITAL_ASSETS" }])).toBeNull();
  });
});

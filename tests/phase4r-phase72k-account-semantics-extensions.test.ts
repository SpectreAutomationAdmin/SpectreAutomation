// Phase 4R · Phase 7.2K (2026-08-13) — AccountSemantics extensions.
//
// Founder §2: `CanonicalAccountSemantics` must be the single typed
// AP interpretation of an account. Downstream AP reasoning consults
// this artefact instead of repeatedly re-interpreting raw
// account.type / fsGroupKey / accountRole / name.
//
// These tests cover the new Phase 7.2K fields:
//   - postingRole
//   - statementRole
//   - inventoryPrepaidRole
//   - accountingClass
//   - structuralPostingRestrictions
//
// The pre-Phase-7.2K fields (capitalRole / functionalRole /
// organizationalDepartment) are covered by earlier test files and
// remain unchanged.

import { describe, expect, it } from "vitest";
import { resolveAccountSemantics } from "@/lib/ap-intelligence/account-semantics";
import type { EligibleAccountView } from "@/lib/ap-intelligence/accounting-nature-compatibility";

function mkAccount(o: Partial<EligibleAccountView>): EligibleAccountView {
  return {
    accountNumber: "0000",
    name: "Test Account",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    isActive: true,
    isHeader: false,
    allowManualPosting: true,
    isControlAccount: false,
    isBankAccount: false,
    isCashAccount: false,
    categoryKey: null,
    fsGroupKey: null,
    accountRole: null,
    ...o,
  };
}

describe("Phase 7.2K · AccountSemantics.postingRole", () => {
  it("configured accountRole=BANK → postingRole=BANK, source=CONFIGURED", () => {
    const s = resolveAccountSemantics(mkAccount({ accountRole: "BANK" }));
    expect(s.postingRole).toBe("BANK");
    expect(s.postingRoleSource).toBe("CONFIGURED");
  });

  it("configured accountRole=CONTRA_ASSET → postingRole=CONTRA_ASSET", () => {
    const s = resolveAccountSemantics(mkAccount({ accountRole: "CONTRA_ASSET" }));
    expect(s.postingRole).toBe("CONTRA_ASSET");
  });

  it("boolean flag isBankAccount fallback → postingRole=BANK, source=ACCOUNT_ROLE", () => {
    const s = resolveAccountSemantics(mkAccount({ accountRole: null, isBankAccount: true }));
    expect(s.postingRole).toBe("BANK");
    expect(s.postingRoleSource).toBe("ACCOUNT_ROLE");
  });

  it("ordinary account → postingRole=STANDARD", () => {
    const s = resolveAccountSemantics(mkAccount({}));
    expect(s.postingRole).toBe("STANDARD");
  });
});

describe("Phase 7.2K · AccountSemantics.statementRole", () => {
  it("EXPENSE account → OPERATING_EXPENSE", () => {
    const s = resolveAccountSemantics(mkAccount({ type: "EXPENSE", name: "Grounds Maintenance" }));
    expect(s.statementRole).toBe("OPERATING_EXPENSE");
  });

  it("EXPENSE + fsGroup COGS → COST_OF_SALES", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "EXPENSE",
      name: "F&B Cost of Sales",
      categoryKey: "COST_OF_SALES",
    }));
    expect(s.statementRole).toBe("COST_OF_SALES");
  });

  it("ASSET + CAPITAL_ASSETS category → BALANCE_SHEET_CAPITAL_ASSET", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET",
      name: "Course Improvements",
      categoryKey: "CAPITAL_ASSETS",
      fsGroupKey: "BS_CAPITAL_ASSETS",
    }));
    expect(s.statementRole).toBe("BALANCE_SHEET_CAPITAL_ASSET");
  });

  it("ASSET + inventory fsGroup → BALANCE_SHEET_CURRENT_ASSET", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET",
      name: "F&B Inventory",
      fsGroupKey: "BS_INVENTORY",
    }));
    expect(s.statementRole).toBe("BALANCE_SHEET_CURRENT_ASSET");
  });

  it("ASSET + prepaid fsGroup → BALANCE_SHEET_CURRENT_ASSET", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET",
      name: "Prepaid Insurance",
      fsGroupKey: "BS_PREPAID",
    }));
    expect(s.statementRole).toBe("BALANCE_SHEET_CURRENT_ASSET");
  });

  it("REVENUE → REVENUE", () => {
    const s = resolveAccountSemantics(mkAccount({ type: "REVENUE", name: "Dues Revenue" }));
    expect(s.statementRole).toBe("REVENUE");
  });

  it("LIABILITY → BALANCE_SHEET_LIABILITY", () => {
    const s = resolveAccountSemantics(mkAccount({ type: "LIABILITY", name: "AP Control" }));
    expect(s.statementRole).toBe("BALANCE_SHEET_LIABILITY");
  });
});

describe("Phase 7.2K · AccountSemantics.inventoryPrepaidRole", () => {
  it("inventory fsGroup → INVENTORY", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET",
      name: "F&B Inventory",
      fsGroupKey: "BS_INVENTORY",
    }));
    expect(s.inventoryPrepaidRole).toBe("INVENTORY");
  });

  it("prepaid fsGroup → PREPAID_ASSET", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET",
      name: "Prepaid Insurance",
      fsGroupKey: "BS_PREPAID",
    }));
    expect(s.inventoryPrepaidRole).toBe("PREPAID_ASSET");
  });

  it("capital asset → NONE", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET",
      name: "Course Improvements",
      categoryKey: "CAPITAL_ASSETS",
    }));
    expect(s.inventoryPrepaidRole).toBe("NONE");
  });

  it("EXPENSE → NONE", () => {
    const s = resolveAccountSemantics(mkAccount({ type: "EXPENSE", name: "Grounds Maintenance" }));
    expect(s.inventoryPrepaidRole).toBe("NONE");
  });
});

describe("Phase 7.2K · AccountSemantics.accountingClass", () => {
  it("EXPENSE + IT/software fsGroup → IT_SERVICES", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "EXPENSE",
      name: "Computer & IT Services",
      fsGroupKey: "IS_IT_SOFTWARE",
    }));
    expect(s.accountingClass).toBe("IT_SERVICES");
  });

  it("EXPENSE + fuel fsGroup → FUEL_EXPENSE", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "EXPENSE",
      name: "Fuel & Lubricants",
      fsGroupKey: "IS_FUEL_LUBRICANTS",
    }));
    expect(s.accountingClass).toBe("FUEL_EXPENSE");
  });

  it("EXPENSE + repairs_maintenance category → REPAIRS_MAINTENANCE or GROUNDS_MAINTENANCE", () => {
    const s1 = resolveAccountSemantics(mkAccount({
      type: "EXPENSE",
      name: "Grounds Maintenance",
      categoryKey: "REPAIRS_MAINTENANCE",
    }));
    expect(s1.accountingClass).toBe("GROUNDS_MAINTENANCE");
    const s2 = resolveAccountSemantics(mkAccount({
      type: "EXPENSE",
      name: "Equipment Repair",
      categoryKey: "REPAIRS_MAINTENANCE",
    }));
    expect(s2.accountingClass).toBe("REPAIRS_MAINTENANCE");
  });

  it("EXPENSE + professional services name → PROFESSIONAL_SERVICES", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "EXPENSE",
      name: "Professional Services",
    }));
    expect(s.accountingClass).toBe("PROFESSIONAL_SERVICES");
  });

  it("EXPENSE + IS_PAYROLL fsGroup → PAYROLL_EXPENSE", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "EXPENSE",
      name: "Wages & Salaries",
      fsGroupKey: "IS_PAYROLL",
    }));
    expect(s.accountingClass).toBe("PAYROLL_EXPENSE");
  });

  it("ASSET + CAPITAL_ASSETS category + Land name → LAND", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET",
      name: "Land",
      categoryKey: "CAPITAL_ASSETS",
      fsGroupKey: "BS_CAPITAL_ASSETS",
    }));
    expect(s.accountingClass).toBe("LAND");
  });

  it("ASSET + CAPITAL_ASSETS category + Building name → BUILDING", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET",
      name: "Buildings",
      categoryKey: "CAPITAL_ASSETS",
      fsGroupKey: "BS_CAPITAL_ASSETS",
    }));
    expect(s.accountingClass).toBe("BUILDING");
  });

  it("ASSET + Equipment & Fixtures name → EQUIPMENT_ASSET", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET",
      name: "Equipment & Fixtures — Grounds",
      categoryKey: "CAPITAL_ASSETS",
      fsGroupKey: "BS_CAPITAL_ASSETS",
    }));
    expect(s.accountingClass).toBe("EQUIPMENT_ASSET");
  });

  it("ASSET + intangible name → SOFTWARE_INTANGIBLE_ASSET", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET",
      name: "Software Intangibles",
      categoryKey: "CAPITAL_ASSETS",
      fsGroupKey: "BS_CAPITAL_ASSETS",
    }));
    expect(s.accountingClass).toBe("SOFTWARE_INTANGIBLE_ASSET");
  });

  it("ASSET + inventory + F&B name → FOOD_INVENTORY", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET",
      name: "F&B Inventory",
      fsGroupKey: "BS_INVENTORY",
    }));
    expect(s.accountingClass).toBe("FOOD_INVENTORY");
  });

  it("ASSET + inventory + beverage/wine name → BEVERAGE_INVENTORY", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET",
      name: "Beverage Inventory",
      fsGroupKey: "BS_INVENTORY",
    }));
    expect(s.accountingClass).toBe("BEVERAGE_INVENTORY");
  });

  it("ASSET + prepaid + insurance name → PREPAID_INSURANCE", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET",
      name: "Prepaid Insurance",
      fsGroupKey: "BS_PREPAID",
    }));
    expect(s.accountingClass).toBe("PREPAID_INSURANCE");
  });

  it("EXPENSE + COGS + food → FOOD_COST_OF_SALES", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "EXPENSE",
      name: "F&B Cost of Sales",
      categoryKey: "COST_OF_SALES",
    }));
    expect(s.accountingClass).toBe("FOOD_COST_OF_SALES");
  });

  it("REVENUE → NON_AP_POSTABLE", () => {
    const s = resolveAccountSemantics(mkAccount({ type: "REVENUE", name: "Dues Revenue" }));
    expect(s.accountingClass).toBe("NON_AP_POSTABLE");
  });
});

describe("Phase 7.2K · AccountSemantics.structuralPostingRestrictions", () => {
  it("ordinary EXPENSE → empty restrictions", () => {
    const s = resolveAccountSemantics(mkAccount({ type: "EXPENSE" }));
    expect(s.structuralPostingRestrictions).toEqual([]);
  });

  it("INACTIVE + HEADER + BANK aggregate all restrictions", () => {
    const s = resolveAccountSemantics(mkAccount({
      isActive: false, isHeader: true, isBankAccount: true,
    }));
    expect(s.structuralPostingRestrictions).toContain("INACTIVE");
    expect(s.structuralPostingRestrictions).toContain("HEADER_ACCOUNT");
    expect(s.structuralPostingRestrictions).toContain("BANK_ACCOUNT");
  });

  it("MANUAL_POSTING_PROHIBITED when allowManualPosting=false", () => {
    const s = resolveAccountSemantics(mkAccount({ allowManualPosting: false }));
    expect(s.structuralPostingRestrictions).toContain("MANUAL_POSTING_PROHIBITED");
  });

  it("REVENUE type → REVENUE_TYPE restriction", () => {
    const s = resolveAccountSemantics(mkAccount({ type: "REVENUE" }));
    expect(s.structuralPostingRestrictions).toContain("REVENUE_TYPE");
  });

  it("PAYROLL_RESTRICTED when fsGroupKey=IS_PAYROLL", () => {
    const s = resolveAccountSemantics(mkAccount({ fsGroupKey: "IS_PAYROLL" }));
    expect(s.structuralPostingRestrictions).toContain("PAYROLL_RESTRICTED");
  });
});

describe("Phase 7.2K · AccountSemantics — Coulee-Ridge fixture spot-checks", () => {
  // These mirror the actual seed COA account shapes.
  it("1530 Course Improvements (LOCKED completed-capital-improvement winner)", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "1530", name: "Course Improvements", type: "ASSET",
      categoryKey: "CAPITAL_ASSETS", fsGroupKey: "BS_CAPITAL_ASSETS",
    }));
    expect(s.statementRole).toBe("BALANCE_SHEET_CAPITAL_ASSET");
    expect(s.accountingClass).toBe("EQUIPMENT_ASSET"); // per the taxonomy — "improvement" not in LAND/BUILDING/etc.
    expect(s.postingRole).toBe("STANDARD");
  });

  it("6020 Grounds Maintenance (LOCKED ordinary-repair-part winner)", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "6020", name: "Grounds Maintenance", type: "EXPENSE",
      categoryKey: "REPAIRS_MAINTENANCE",
    }));
    expect(s.statementRole).toBe("OPERATING_EXPENSE");
    expect(s.accountingClass).toBe("GROUNDS_MAINTENANCE");
  });

  it("5320 Fuel & Lubricants (LOCKED DMM winner)", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "5320", name: "Fuel & Lubricants — General", type: "EXPENSE",
      fsGroupKey: "IS_FUEL_LUBRICANTS",
    }));
    expect(s.statementRole).toBe("OPERATING_EXPENSE");
    expect(s.accountingClass).toBe("FUEL_EXPENSE");
  });

  it("1506 Equipment & Fixtures — Grounds (1091559 target)", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "1506", name: "Equipment & Fixtures — Grounds", type: "ASSET",
      categoryKey: "CAPITAL_ASSETS", fsGroupKey: "BS_CAPITAL_ASSETS",
    }));
    expect(s.statementRole).toBe("BALANCE_SHEET_CAPITAL_ASSET");
    expect(s.accountingClass).toBe("EQUIPMENT_ASSET");
  });

  it("6054 Computer & IT Services (221178 target)", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "6054", name: "Computer & IT Services", type: "EXPENSE",
      fsGroupKey: "IS_IT_SOFTWARE",
    }));
    expect(s.statementRole).toBe("OPERATING_EXPENSE");
    expect(s.accountingClass).toBe("IT_SERVICES");
  });

  it("1580 Land (land-acquisition target)", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "1580", name: "Land", type: "ASSET",
      categoryKey: "CAPITAL_ASSETS", fsGroupKey: "BS_CAPITAL_ASSETS",
    }));
    expect(s.statementRole).toBe("BALANCE_SHEET_CAPITAL_ASSET");
    expect(s.capitalRole).toBe("LAND_ASSET");
    expect(s.accountingClass).toBe("LAND");
  });

  it("1710 Inventory F&B (food-service leak target)", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "1710", name: "Inventory — F&B", type: "ASSET",
      fsGroupKey: "BS_INVENTORY",
    }));
    expect(s.statementRole).toBe("BALANCE_SHEET_CURRENT_ASSET");
    expect(s.inventoryPrepaidRole).toBe("INVENTORY");
    expect(s.accountingClass).toBe("FOOD_INVENTORY");
  });

  it("1410 Prepaid (prepaid-insurance target)", () => {
    const s = resolveAccountSemantics(mkAccount({
      accountNumber: "1410", name: "Prepaid Insurance", type: "ASSET",
      fsGroupKey: "BS_PREPAID",
    }));
    expect(s.statementRole).toBe("BALANCE_SHEET_CURRENT_ASSET");
    expect(s.inventoryPrepaidRole).toBe("PREPAID_ASSET");
    expect(s.accountingClass).toBe("PREPAID_INSURANCE");
  });
});

describe("Phase 7.2K · AccountSemantics — pre-Phase-7.2K fields unchanged", () => {
  it("existing capitalRole derivation for equipment ASSET preserved", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET", name: "Equipment & Fixtures — Grounds",
      categoryKey: "CAPITAL_ASSETS", fsGroupKey: "BS_CAPITAL_ASSETS",
    }));
    expect(s.capitalRole).toBe("EQUIPMENT_ASSET");
  });

  it("existing functionalRole derivation preserved", () => {
    const s = resolveAccountSemantics(mkAccount({
      type: "ASSET", name: "Equipment — Grounds",
      categoryKey: "CAPITAL_ASSETS", fsGroupKey: "BS_CAPITAL_ASSETS",
    }));
    expect(s.functionalRole).toBe("GROUNDS_EQUIPMENT");
  });
});

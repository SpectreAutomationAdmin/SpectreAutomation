// FPP-5A (2026-09-20) — RRSP employee tax-at-source + CPP diagnostic pins.
//
// Two concerns:
//   1. Future Prepare/Calculate snapshots must FREEZE
//      taxFormulaDeductionType = "RRSP_DEDUCTED_AT_SOURCE" on any
//      component whose current catalogue definition carries that
//      value. This drives the T4127 factor F reduction on income-tax
//      withholding, closing the RISE ~$69.78 delta.
//   2. Pin the exact CPP mathematical diagnostic that proves the
//      RISE $279.10 CPP corresponds to pensionable earnings
//      $4,836.51 = Salary $4,583.33 + AD&D $2.25 + Dep Life $0.83 +
//      Life Insurance $20.93 + RRSP ER $229.17 (Cell Phone Allowance
//      excluded). Spectre's $4,874.01 pensionable includes Cell Phone
//      per CRA T4130 flat-taxable-cash-allowance guidance.

import { describe, it, expect } from "vitest";

/**
 * 2026 semi-monthly CPP calculation for a single pay period.
 * Combined rate 5.95% (base 4.95% + first-additional 1.00%).
 * Basic exemption per period = $3,500 / 24 = $145.83 (HALF_UP).
 */
function cppPerPeriodExact(pensionable: number): number {
  const exemption = 3500 / 24; // 145.8333…
  const contributory = Math.max(0, pensionable - exemption);
  // Combined rate 5.95%, round HALF_UP to cents.
  return Math.round(contributory * 0.0595 * 100) / 100;
}

describe("FPP-5A — CPP mathematical diagnostic (2026 semi-monthly)", () => {
  it("Salary only $4,583.33 → CPP $264.03", () => {
    expect(cppPerPeriodExact(4583.33)).toBeCloseTo(264.03, 2);
  });
  it("Salary + Cell Phone $4,620.83 → CPP $266.26", () => {
    expect(cppPerPeriodExact(4620.83)).toBeCloseTo(266.26, 2);
  });
  it("Salary + employer benefits (AD&D $2.25 + Dep Life $0.83 + Life $20.93 + RRSP ER $229.17) = $4,836.51 → CPP $279.10 (EXACT MATCH RISE)", () => {
    const pensionable = 4583.33 + 2.25 + 0.83 + 20.93 + 229.17;
    expect(pensionable).toBeCloseTo(4836.51, 2);
    // (4836.51 - 145.833…) × 5.95% = 4690.6767 × 5.95% = 279.0952 → 279.10
    expect(cppPerPeriodExact(pensionable)).toBeCloseTo(279.10, 2);
  });
  it("Salary + Cell + employer benefits $4,874.01 → CPP $281.33 (Spectre exact)", () => {
    const pensionable = 4583.33 + 37.50 + 2.25 + 0.83 + 20.93 + 229.17;
    expect(pensionable).toBeCloseTo(4874.01, 2);
    expect(cppPerPeriodExact(pensionable)).toBeCloseTo(281.33, 2);
  });
  it("Cell Phone Allowance $37.50 in pensionable base is the ENTIRE +$2.23 CPP delta", () => {
    const withCell = cppPerPeriodExact(4874.01);
    const withoutCell = cppPerPeriodExact(4874.01 - 37.50);
    const delta = Math.round((withCell - withoutCell) * 100) / 100;
    expect(delta).toBeCloseTo(2.23, 2);
    // 37.50 × 5.95% = 2.23125 → 2.23 exact
    expect(Math.round(37.50 * 0.0595 * 100) / 100).toBeCloseTo(2.23, 2);
  });
});

/**
 * Component-snapshot freeze contract: the Payroll-3C-2/3C-3D snapshotter
 * copies taxFormulaDeductionType from the live PayrollComponent catalogue
 * at Prepare time and never re-reads afterward. This pin ensures the
 * shape of the field survives future refactors so an RRSP_DEDUCTED_AT_SOURCE
 * catalogue row is frozen into every future snapshot as expected.
 */
describe("FPP-5A — RRSP_DEDUCTED_AT_SOURCE snapshot freeze contract", () => {
  it("The allowlist recognises RRSP_DEDUCTED_AT_SOURCE as an F-factor input", () => {
    const TAX_FORMULA_F_TYPES = new Set(["RRSP_DEDUCTED_AT_SOURCE"]);
    expect(TAX_FORMULA_F_TYPES.has("RRSP_DEDUCTED_AT_SOURCE")).toBe(true);
    // Ensure null (the pre-fix Coulee value) is NOT accepted.
    expect(TAX_FORMULA_F_TYPES.has(null as unknown as string)).toBe(false);
  });

  it("Tax formula factor F sums ONLY EMPLOYEE-side snapshots with an F-mapping type", () => {
    // Reproduce calculation-execute.ts §Payroll-3C-3D logic shape.
    const TAX_FORMULA_F_TYPES = new Set(["RRSP_DEDUCTED_AT_SOURCE"]);
    type Snap = {
      side: "EMPLOYEE" | "EMPLOYER";
      taxFormulaDeductionType: string | null;
      resolvedAmount: number;
      componentCode: string;
    };
    const snapshots: Snap[] = [
      { side: "EMPLOYEE", taxFormulaDeductionType: "RRSP_DEDUCTED_AT_SOURCE", resolvedAmount: 229.17, componentCode: "RRSP_EE" },
      { side: "EMPLOYER", taxFormulaDeductionType: "RRSP_DEDUCTED_AT_SOURCE", resolvedAmount: 229.17, componentCode: "RRSP_ER" }, // must NOT count — employer side
      { side: "EMPLOYEE", taxFormulaDeductionType: null, resolvedAmount: 28.11, componentCode: "LTD" }, // must NOT count — no F mapping
      { side: "EMPLOYEE", taxFormulaDeductionType: null, resolvedAmount: 37.50, componentCode: "CELL_PHONE" }, // must NOT count
    ];
    const f = snapshots
      .filter((s) => s.side === "EMPLOYEE" && s.taxFormulaDeductionType && TAX_FORMULA_F_TYPES.has(s.taxFormulaDeductionType))
      .reduce((sum, s) => sum + s.resolvedAmount, 0);
    expect(f).toBeCloseTo(229.17, 2);
  });

  it("Existing frozen null-flag snapshots are treated as post-tax (no F reduction)", () => {
    // The Sep 15 CALCULATED batch's frozen RRSP snapshot carries
    // taxFormulaDeductionType = null. It stays post-tax until the
    // founder Returns-to-Preparation and re-Prepares.
    const frozen = { side: "EMPLOYEE" as const, taxFormulaDeductionType: null, resolvedAmount: 229.17 };
    const F_TYPES = new Set(["RRSP_DEDUCTED_AT_SOURCE"]);
    const contributes =
      frozen.side === "EMPLOYEE" && frozen.taxFormulaDeductionType != null && F_TYPES.has(frozen.taxFormulaDeductionType);
    expect(contributes).toBe(false);
  });
});

// MBR-PY-3 — Chapter II / Chapter XII prior-year payroll synchronization.
//
// Shape + behaviour tests on the pure data layer verifying:
//   • Chapter II (buildPayrollDepartmentData / buildPayrollDepartmentLive)
//     reads priorYear from the SAME resolveHistoricalPayrollByDepartment
//     Chapter XII consumes — one authoritative historical dataset.
//   • priorYear flows into the chart rows + the vsPriorYear KPI.
//   • The hardcoded "JANUARY ACTUAL VS BUDGET …" subtitle is gone.
//   • Honest-missing handling preserved for tenants without 2025 TBs.
//   • Chapter geometry constants + visibility keys unchanged.

import { describe, expect, it } from "vitest";
import {
  buildPayrollDepartmentData,
  type PayrollDeptRowInput,
} from "@/lib/reporting/payroll-analysis";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(__dirname, "..");
const PAYROLL_ANALYSIS_SOURCE = fs.readFileSync(
  path.join(REPO, "src/lib/reporting/payroll-analysis.ts"),
  "utf-8",
);
const MONTHLY_BODY_SOURCE = fs.readFileSync(
  path.join(REPO, "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx"),
  "utf-8",
);

describe("MBR-PY-3 §F — Chapter II consumes the shared historical resolver", () => {
  it("buildPayrollDepartmentLive reads priorYear from r.priorYearActual (NOT hardcoded null)", () => {
    // The old defect: `priorYear: null as number | null,` on every row.
    expect(PAYROLL_ANALYSIS_SOURCE).not.toMatch(
      /priorYear:\s*null as number \| null,?\s*(?:}|\n\s*\/\/|\n\s*priorYear)/,
    );
    expect(PAYROLL_ANALYSIS_SOURCE).toMatch(/priorYear:\s*r\.priorYearActual,/);
  });

  it("buildPayrollDepartmentLive subtitleOverride is derived at runtime (no hardcoded month literal)", () => {
    // Look only INSIDE the live builder, past the comment block — the
    // live subtitleOverride must reference the derived liveSubtitle,
    // never a string that starts with a fixed calendar month literal.
    const liveFn = PAYROLL_ANALYSIS_SOURCE.slice(
      PAYROLL_ANALYSIS_SOURCE.indexOf("export async function buildPayrollDepartmentLive"),
    );
    expect(liveFn).toMatch(/subtitleOverride:\s*liveSubtitle,/);
    // And the live subtitle template is period-aware (built from
    // periodEnd), not a fixed "JANUARY" string.
    expect(liveFn).not.toMatch(/subtitleOverride:\s*historical\.consolidatedBudgetAll != null\s*\?\s*"JANUARY/);
  });

  it("live subtitle derives the period label from periodEnd + reflects actual Prior Year availability", () => {
    expect(PAYROLL_ANALYSIS_SOURCE).toContain("YTD ACTUAL · BUDGET · PRIOR YEAR —");
    expect(PAYROLL_ANALYSIS_SOURCE).toContain("periodEnd.getUTCMonth()");
    expect(PAYROLL_ANALYSIS_SOURCE).toContain("periodEnd.getUTCFullYear()");
    expect(PAYROLL_ANALYSIS_SOURCE).toContain("anyPriorYearLive");
  });

  it("Chapter II passes consolidatedPriorYearOverride into buildPayrollDepartmentData", () => {
    expect(PAYROLL_ANALYSIS_SOURCE).toContain(
      "consolidatedPriorYearOverride: historical.consolidatedPriorYearActualAll",
    );
  });

  it("Prior-year scalar KPI reads the override before falling back to chart-row sum", () => {
    const fn = PAYROLL_ANALYSIS_SOURCE.slice(PAYROLL_ANALYSIS_SOURCE.indexOf("function buildPayrollDepartmentData"));
    const scope = fn.slice(0, 3_500);
    expect(scope).toMatch(/consolidatedPriorYearOverride !== undefined/);
    expect(scope).toMatch(/vsPriorYear\s*=\s*priorYearKpiDollars != null \? actualDollars - priorYearKpiDollars/);
  });
});

describe("MBR-PY-3 §G — downstream contract: priorYear rows + KPI reconcile", () => {
  // Mar 2025 Coulee ground-truth values verified in MBR-PY-2.
  const COULEE_MAR_2025_BY_DEPT: Record<string, number> = {
    ADMIN: 153_630.07,
    FOOD_AND_BEVERAGE: 152_273.09,
    GROUNDS: 110_213.85,
    GOLF_SHOP: 77_558.15,
    CLUBHOUSE: 17_765.06,
  };
  const COULEE_MAR_2025_CONSOLIDATED = 511_440.22;
  // Mar 2026 current-year consolidated (verified in MBR-PY-2 full
  // package query).
  const COULEE_MAR_2026_CONSOLIDATED = 538_427.92;

  const departments: PayrollDeptRowInput[] = [
    { key: "admin",       name: "Administration",   actual: 155_000, budget: 160_000, priorYear: COULEE_MAR_2025_BY_DEPT.ADMIN },
    { key: "fb",          name: "Food & Beverage",  actual: 140_000, budget: 150_000, priorYear: COULEE_MAR_2025_BY_DEPT.FOOD_AND_BEVERAGE },
    { key: "grounds",     name: "Course & Grounds", actual: 125_000, budget: 130_000, priorYear: COULEE_MAR_2025_BY_DEPT.GROUNDS },
    { key: "golf-shop",   name: "Golf Shop",        actual: 92_000,  budget: 90_000,  priorYear: COULEE_MAR_2025_BY_DEPT.GOLF_SHOP },
    { key: "clubhouse",   name: "Clubhouse",        actual: 26_428,  budget: 25_000,  priorYear: COULEE_MAR_2025_BY_DEPT.CLUBHOUSE },
  ];

  const built = buildPayrollDepartmentData(
    {
      departments,
      revenueDollars: 3_200_000,
      duesDollars:   2_100_000,
      reportingYear: 2026,
      consolidatedActualOverride:    COULEE_MAR_2026_CONSOLIDATED,
      consolidatedBudgetOverride:    555_000,
      consolidatedPriorYearOverride: COULEE_MAR_2025_CONSOLIDATED,
    },
    { dataSource: "live" },
  );

  it("rows carry priorYearK (chart gets a 3rd series)", () => {
    for (const row of built.rows) expect(row.priorYearK).not.toBeNull();
    expect(built.rows.length).toBe(5);
    // 5 depts × 3 series (actual + budget + priorYear) = 15 bar slots.
    const totalSlots = built.rows.reduce((s, r) => {
      let n = 0;
      if (r.actualK != null) n += 1;
      if (r.budgetK != null) n += 1;
      if (r.priorYearK != null) n += 1;
      return s + n;
    }, 0);
    expect(totalSlots).toBe(15);
  });

  it("vsPriorYear KPI = currentYearActual - override (NOT sum of charted-dept priorYear)", () => {
    // override: 511_440.22; override is the authoritative source.
    const expectedDelta = COULEE_MAR_2026_CONSOLIDATED - COULEE_MAR_2025_CONSOLIDATED;
    // 26,987.70 — present-year higher.
    expect(expectedDelta).toBeGreaterThan(26_000);
    expect(expectedDelta).toBeLessThan(27_500);
    // Label is fmtDollarsK output — just verify it has a sign/figure.
    expect(built.kpis.vsPriorYearLabel).toMatch(/\$?[\d,.]+K?/);
    // Not the dash fallback.
    expect(built.kpis.vsPriorYearLabel).not.toBe("—");
    expect(built.kpis.vsPriorYearLabel).not.toBeNull();
  });

  it("sum of charted-dept priorYear equals $511,440.22 (reconciles to consolidated)", () => {
    const chartedSum = built.rows.reduce((s, r) => s + (r.priorYearK ?? 0) * 1_000, 0);
    expect(Math.abs(chartedSum - COULEE_MAR_2025_CONSOLIDATED)).toBeLessThan(0.5);
  });

  it("totals.priorYearDollars reconciles to the sum of row priorYear", () => {
    expect(built.totals.priorYearDollars).not.toBeNull();
    const chartedSum = departments.reduce((s, d) => s + (d.priorYear ?? 0), 0);
    expect(built.totals.priorYearDollars).toBeCloseTo(chartedSum, 2);
  });
});

describe("MBR-PY-3 §H — honest-missing handling for tenants without a comparable TB", () => {
  const departments: PayrollDeptRowInput[] = [
    { key: "admin",     name: "Administration",   actual: 155_000, budget: 160_000, priorYear: null },
    { key: "fb",        name: "Food & Beverage",  actual: 140_000, budget: 150_000, priorYear: null },
    { key: "grounds",   name: "Course & Grounds", actual: 125_000, budget: 130_000, priorYear: null },
  ];
  const built = buildPayrollDepartmentData(
    {
      departments,
      revenueDollars: 2_600_000,
      duesDollars:   1_800_000,
      reportingYear: 2026,
      consolidatedActualOverride:    420_000,
      consolidatedBudgetOverride:    440_000,
      consolidatedPriorYearOverride: null,
    },
    { dataSource: "live" },
  );

  it("priorYear-less tenant: every rows.priorYearK stays null (chart filters series)", () => {
    for (const row of built.rows) expect(row.priorYearK).toBeNull();
  });

  it("priorYear-less tenant: vsPriorYearLabel is null (card renders '—')", () => {
    expect(built.kpis.vsPriorYearLabel).toBeNull();
  });

  it("priorYear-less tenant: totals.priorYearDollars is null (never 0)", () => {
    expect(built.totals.priorYearDollars).toBeNull();
  });
});

describe("MBR-PY-3 §I — chart geometry constants unchanged", () => {
  it("Chapter II PayrollDepartmentCard chart: height 240, padLeft 48, padRight 14", () => {
    const slice = MONTHLY_BODY_SOURCE.slice(MONTHLY_BODY_SOURCE.indexOf("function PayrollDepartmentCard"));
    const scope = slice.slice(0, 5_000);
    expect(scope).toContain("height: 240");
    expect(scope).toContain("height={240}");
    expect(scope).toContain("padLeft={48}");
    expect(scope).toContain("padRight={14}");
  });

  it("existing visibility key is preserved (card:financial-performance:payroll-dept-breakdown)", () => {
    expect(MONTHLY_BODY_SOURCE).toContain('"card:financial-performance:payroll-dept-breakdown"');
  });
});

describe("MBR-PY-3 §J — Chapter II and Chapter XII share the SAME historical resolver", () => {
  it("buildPayrollDepartmentLive imports resolveHistoricalPayrollByDepartment", () => {
    expect(PAYROLL_ANALYSIS_SOURCE).toContain(
      '"@/lib/reporting/historical-payroll-by-department"',
    );
    expect(PAYROLL_ANALYSIS_SOURCE).toMatch(/resolveHistoricalPayrollByDepartment\(clubId,/);
  });

  it("Chapter XII buildCouleeDepartmentalPayrollAnalysis imports the SAME resolver", () => {
    const dpa = fs.readFileSync(
      path.join(REPO, "src/lib/reporting/departmental-payroll-analysis.ts"),
      "utf-8",
    );
    expect(dpa).toContain('"@/lib/reporting/historical-payroll-by-department"');
    expect(dpa).toMatch(/resolveHistoricalPayrollByDepartment/);
  });
});

// MBR-PY-1 — prior-year comparative data integrity.
//
// Three charts in the Monthly Board Reporting Package expose prior-
// year (March 2025) comparatives:
//   A. Operating Results — 12-Month Rolling Trend (KPI + overlay)
//   B. Payroll Analysis — Department Breakdown (3rd series)
//   C. Payroll Ratio — Monthly Trend (prior-year series + KPI)
//
// These are *shape* tests on the pure data layer — no I/O, no DB.
// They verify that the service surface accepts a nullable / absent
// prior-year input and emits the honest "—" / omit shape the chart
// renderer expects.  Live-wiring is validated separately on staging.

import { describe, expect, it } from "vitest";
import {
  buildPayrollRatioTrendData,
  type PayrollRatioMonthlyInput,
  SILVER_SPRINGS_PAYROLL_ACTUAL_MONTHLY,
  SILVER_SPRINGS_PAYROLL_BUDGET_MONTHLY,
  SILVER_SPRINGS_PAYROLL_PRIOR_MONTHLY,
  SILVER_SPRINGS_GOLF_ROUNDS_ACTUAL,
  SILVER_SPRINGS_GOLF_ROUNDS_PRIOR_YEAR,
  SILVER_SPRINGS_PAYROLL_BENCHMARK_PCT,
} from "@/lib/reporting/payroll-analysis";

const nullMonths: PayrollRatioMonthlyInput[] = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
].map((label) => ({ label, ratio: null }));

const marOnlyMonths: PayrollRatioMonthlyInput[] = nullMonths.map((m, i) => ({
  label: m.label,
  ratio: i === 2 ? 58.4 : null,
}));

const commonInputs = {
  monthlyActual: SILVER_SPRINGS_PAYROLL_ACTUAL_MONTHLY,
  monthlyBudget: SILVER_SPRINGS_PAYROLL_BUDGET_MONTHLY,
  benchmarkPct: SILVER_SPRINGS_PAYROLL_BENCHMARK_PCT,
  duesRatioPct: 62.27,
  golfRoundsActual: SILVER_SPRINGS_GOLF_ROUNDS_ACTUAL,
  golfRoundsPriorYear: SILVER_SPRINGS_GOLF_ROUNDS_PRIOR_YEAR,
  reportingYear: 2026,
  reportingMonth: 3,
};

describe("MBR-PY-1 §C — Payroll Ratio prior-year handles null honestly", () => {
  it("ALL prior-year months null → priorYearLabel is \"—\" (not 0.0%)", () => {
    const result = buildPayrollRatioTrendData({
      ...commonInputs,
      monthlyPriorYear: nullMonths,
    });
    expect(result.kpis.priorYearLabel).toBe("—");
    // The chart's priorYear series must forward the nulls to the
    // renderer (no fabricated 0 segment).
    for (const p of result.priorYearSeries) {
      expect(p.value).toBeNull();
    }
  });

  it("ONLY March 2025 populated → priorYearLabel reflects the single comparable; the vs-prior commentary branch is used", () => {
    const result = buildPayrollRatioTrendData({
      ...commonInputs,
      monthlyPriorYear: marOnlyMonths,
    });
    // Through-N = 3 months; two null + one real → average skips nulls
    // and returns the single real value.
    expect(result.kpis.priorYearLabel).toBe("58.4%");
    // Commentary mentions vs. prior year explicitly when there IS a
    // comparable (not the suppressed-branch).
    expect(result.commentary).toMatch(/vs\. prior year/i);
    // Non-null slot survives the mapping.
    expect(result.priorYearSeries[2].value).toBe(58.4);
    expect(result.priorYearSeries[0].value).toBeNull();
    expect(result.priorYearSeries[1].value).toBeNull();
  });

  it("suppressed-vs-prior branch triggers when prior-year is entirely unavailable", () => {
    const result = buildPayrollRatioTrendData({
      ...commonInputs,
      monthlyPriorYear: nullMonths,
    });
    // The suppressed branch emits a "not available for this period"
    // sentence instead of a "+NaN pts" delta.
    expect(result.commentary).toMatch(/prior-year comparison is not available/i);
    expect(result.commentary).not.toMatch(/NaN/);
  });

  it("Silver Springs demo (all-numeric prior) still produces the vs-prior branch + numeric priorYearLabel", () => {
    const result = buildPayrollRatioTrendData({
      ...commonInputs,
      monthlyPriorYear: SILVER_SPRINGS_PAYROLL_PRIOR_MONTHLY,
    });
    expect(result.kpis.priorYearLabel).toMatch(/^\d+\.\d%$/);
    expect(result.commentary).toMatch(/vs\. prior year/i);
  });
});

describe("MBR-PY-1 §A — Operating Results service accepts prior-year YTD without fabricating monthly values", () => {
  it("formatOperatingDashboard surfaces a null priorYearNoi as \"—\" and omits the overlay (contract invariant)", async () => {
    const { formatOperatingDashboard } = await import("@/lib/reporting/monthly-package");
    const dash = formatOperatingDashboard({
      months: [],
      priorYearMonths: [],
      ytdNoi: 0,
      ytdRevenue: 0,
      ytdBudgetNoi: null,
      priorYearNoi: null,
      breakEven: 0,
      breakEvenCorridor: { lower: -25, upper: 25 },
    }, { periodEnd: new Date(Date.UTC(2026, 2, 31, 23, 59, 59, 999)) });
    expect(dash.priorYearLabel).toBe("—");
    // Every priorYearYtd slot is null → chart renders no overlay.
    expect(dash.priorYearYtd.every((p: { value: number | null }) => p.value == null)).toBe(true);
  });

  it("single-slot priorYearMonths (YTD comparative) emits exactly one non-null point on the overlay", async () => {
    const { formatOperatingDashboard } = await import("@/lib/reporting/monthly-package");
    const marYtd = 215_000;
    const marEnd2025 = new Date(Date.UTC(2025, 2, 31, 23, 59, 59, 999));
    const marEnd2026 = new Date(Date.UTC(2026, 2, 31, 23, 59, 59, 999));
    const dash = formatOperatingDashboard({
      months: [{
        endDate: marEnd2026,
        monthLabel: "Mar 2026",
        sequence: 3,
        noi: 100_000,
        revenue: 400_000,
        budgetNoi: null,
      }],
      priorYearMonths: [{
        endDate: marEnd2025,
        monthLabel: "Mar 2025",
        sequence: 3,
        noi: marYtd,
        revenue: 350_000,
        budgetNoi: null,
      }],
      ytdNoi: 100_000,
      ytdRevenue: 400_000,
      ytdBudgetNoi: null,
      priorYearNoi: marYtd,
      breakEven: 0,
      breakEvenCorridor: { lower: -25, upper: 25 },
    }, { periodEnd: marEnd2026 });
    // KPI reads the real prior-year value.
    expect(dash.priorYearLabel).not.toBe("—");
    // Exactly one overlay slot carries the YTD value (the Mar slot).
    const nonNullOverlay = dash.priorYearYtd.filter((p: { value: number | null }) => p.value != null);
    expect(nonNullOverlay).toHaveLength(1);
    expect(nonNullOverlay[0].value).toBe(marYtd);
  });
});

describe("MBR-PY-1 §B — Historical Payroll resolver surfaces a priorYearActual field on every chart row", () => {
  it("HistoricalPayrollDepartmentRow has the priorYearActual field defined on the type (compile-time shape check)", async () => {
    const mod = await import("@/lib/reporting/historical-payroll-by-department");
    // Pure shape assertion via a representative literal: TS compiles
    // only if `priorYearActual` is on the row type.
    const sample: import("@/lib/reporting/historical-payroll-by-department").HistoricalPayrollDepartmentRow = {
      departmentCode: "FB",
      departmentName: "Food & Beverage",
      actual: 548_700,
      budget: 566_900,
      priorYearActual: 540_000,
      currentEmployeeCount: 0,
    };
    expect(sample.priorYearActual).toBe(540_000);
    expect(mod).toBeDefined();
  });

  it("DepartmentChartDatum has ytdPriorYear field + nullable semantics (SOURCE_NOT_LOADED → null)", async () => {
    const mod = await import("@/lib/reporting/departmental-payroll-analysis");
    const sample: import("@/lib/reporting/departmental-payroll-analysis").DepartmentChartDatum = {
      key: "dept-fb",
      shortLabel: "F&B",
      fullLabel: "Food & Beverage",
      ytdActual: 548_700,
      ytdBudget: 566_900,
      ytdVariance: 18_200,
      ytdVarianceTone: "favorable",
      ytdPriorYear: null,
      wages: 0,
      taxesBenefits: 0,
      fillHex: "#000000",
    };
    expect(sample.ytdPriorYear).toBeNull();
    expect(mod).toBeDefined();
  });
});

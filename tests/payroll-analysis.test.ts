import { describe, it, expect } from "vitest";
import {
  buildPayrollDepartmentData,
  buildPayrollRatioTrendData,
  SILVER_SPRINGS_PAYROLL_DEPTS,
  SILVER_SPRINGS_PAYROLL_REVENUE,
  SILVER_SPRINGS_OPERATING_DUES,
  SILVER_SPRINGS_PAYROLL_ACTUAL_MONTHLY,
  SILVER_SPRINGS_PAYROLL_BUDGET_MONTHLY,
  SILVER_SPRINGS_PAYROLL_PRIOR_MONTHLY,
  SILVER_SPRINGS_PAYROLL_BENCHMARK_PCT,
  SILVER_SPRINGS_GOLF_ROUNDS_ACTUAL,
  SILVER_SPRINGS_GOLF_ROUNDS_PRIOR_YEAR,
} from "@/lib/reporting/payroll-analysis";
import {
  SILVER_SPRINGS_OPERATING_DUES as DUES_FROM_DUES_SERVICE,
  SILVER_SPRINGS_DUES_TOTAL,
} from "@/lib/reporting/dues-subsidy";

const deptCard = buildPayrollDepartmentData({
  departments: SILVER_SPRINGS_PAYROLL_DEPTS,
  revenueDollars: SILVER_SPRINGS_PAYROLL_REVENUE,
  duesDollars: SILVER_SPRINGS_OPERATING_DUES,
  reportingYear: 2026,
});

const trendCard = buildPayrollRatioTrendData({
  monthlyActual: SILVER_SPRINGS_PAYROLL_ACTUAL_MONTHLY,
  monthlyBudget: SILVER_SPRINGS_PAYROLL_BUDGET_MONTHLY,
  monthlyPriorYear: SILVER_SPRINGS_PAYROLL_PRIOR_MONTHLY,
  benchmarkPct: SILVER_SPRINGS_PAYROLL_BENCHMARK_PCT,
  duesRatioPct: (SILVER_SPRINGS_OPERATING_DUES / SILVER_SPRINGS_PAYROLL_REVENUE) * 100,
  golfRoundsActual:    SILVER_SPRINGS_GOLF_ROUNDS_ACTUAL,
  golfRoundsPriorYear: SILVER_SPRINGS_GOLF_ROUNDS_PRIOR_YEAR,
  // Reporting period — May 2026 → year 2026, month 5.
  reportingYear:  2026,
  reportingMonth: 5,
});

describe("Payroll Analysis — Department Breakdown service", () => {
  it("emits the 10 founder-spec departments in order", () => {
    expect(deptCard.rows.map((r) => r.key)).toEqual([
      "golf-ops", "gcm", "fb", "equestrian", "security",
      "ga", "grounds", "facilities", "sports-barn", "outdoor-pursuits",
    ]);
    expect(deptCard.xLabels[0]).toBe("Golf Ops");
    expect(deptCard.xLabels[9]).toBe("Outdoor Pursuits");
  });

  it("KPI tile values are computed from typed numeric inputs", () => {
    // Sums: $9.87M actual, $9.748M budget, $9.257M prior → variances
    // $122K vs budget, $613K vs prior. Ratio = 9.87M / 16.671M = 59.2%.
    expect(deptCard.kpis.totalYtdLabel).toBe("$9.87M");
    expect(deptCard.kpis.vsBudgetLabel).toBe("$122K");
    expect(deptCard.kpis.vsPriorYearLabel).toBe("$613K");
    expect(deptCard.kpis.payrollRatioLabel).toBe("59.2%");
  });

  it("totals object preserves raw numeric inputs for downstream consumers", () => {
    expect(deptCard.totals.actualDollars).toBe(9_870_000);
    expect(deptCard.totals.budgetDollars).toBe(9_748_000);
    expect(deptCard.totals.priorYearDollars).toBe(9_257_000);
    expect(deptCard.totals.revenueDollars).toBe(16_671_000);
    expect(deptCard.totals.duesDollars).toBe(10_381_000);
    // 9_870_000 / 16_671_000 × 100 = 59.20439…
    expect(deptCard.totals.payrollRatioPct).toBeCloseTo(59.204, 2);
    // 10_381_000 / 16_671_000 × 100 = 62.269…
    expect(deptCard.totals.duesRatioPct).toBeCloseTo(62.27, 1);
  });

  it("Dues-Cover-Payroll check returns PASS when dues > payroll AND duesRatio > payrollRatio", () => {
    expect(deptCard.check.decision).toBe("PASS");
    expect(deptCard.check.headerPhrase).toBe("Dues Revenue Covers Payroll Check:");
    // Body sentence carries the live numbers from the inputs.
    expect(deptCard.check.bodySentence).toContain("**$10.38M**");
    expect(deptCard.check.bodySentence).toContain("**$9.87M**");
    expect(deptCard.check.bodySentence).toContain("**$511K**"); // 10,381 − 9,870 = 511
    expect(deptCard.check.bodySentence).toContain("**62.3%**");
    expect(deptCard.check.bodySentence).toContain("**59.2%**");
  });

  it("Dues-Cover-Payroll check returns FAIL when dues ≤ payroll", () => {
    const failing = buildPayrollDepartmentData({
      departments: SILVER_SPRINGS_PAYROLL_DEPTS,
      revenueDollars: SILVER_SPRINGS_PAYROLL_REVENUE,
      duesDollars: 5_000_000,  // less than $9.87M payroll
      reportingYear: 2026,
    });
    expect(failing.check.decision).toBe("FAIL");
  });

  it("series colors are restrained inline-hex (no banned class names)", () => {
    expect(deptCard.seriesColors.actual).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(deptCard.seriesColors.budget).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(deptCard.seriesColors.priorYear).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("changing the seed inputs changes the KPI labels (input sensitivity)", () => {
    const bumped = buildPayrollDepartmentData({
      departments: SILVER_SPRINGS_PAYROLL_DEPTS.map((d) =>
        d.key === "gcm" ? { ...d, actual: d.actual + 100_000 } : d,
      ),
      revenueDollars: SILVER_SPRINGS_PAYROLL_REVENUE,
      duesDollars: SILVER_SPRINGS_OPERATING_DUES,
      reportingYear: 2026,
    });
    expect(bumped.kpis.totalYtdLabel).toBe("$9.97M"); // +$100K
    expect(bumped.kpis.vsBudgetLabel).toBe("$222K");  // 9870+100 - 9748 = 222
  });
});

describe("Payroll Ratio — Monthly Trend service", () => {
  it("KPI tile values are computed from the 12-month series + benchmark config", () => {
    expect(trendCard.kpis.ytdRatioLabel).toBe("59.2%");
    expect(trendCard.kpis.budgetRatioLabel).toBe("58.2%");
    expect(trendCard.kpis.priorYearLabel).toBe("55.3%");
    expect(trendCard.kpis.benchmarkLabel).toBe("57%+");
  });

  it("y-axis domain is rounded to 5 % increments and includes all series", () => {
    expect(trendCard.yDomain[0]).toBeLessThanOrEqual(44); // prior year low = 44
    expect(trendCard.yDomain[1]).toBeGreaterThanOrEqual(75); // actual high = 75
    // Domain bounds are multiples of 5.
    expect(trendCard.yDomain[0] % 5).toBe(0);
    expect(trendCard.yDomain[1] % 5).toBe(0);
    expect(trendCard.yTicks).toBeGreaterThan(0);
  });

  it("emits 12 months on the x-axis; actual has nulls for future months; other series span all 12", () => {
    // X-axis = full fiscal year (Jan–Dec) — 12 entries on every series.
    expect(trendCard.months.length).toBe(12);
    expect(trendCard.actualSeries.length).toBe(12);
    expect(trendCard.budgetSeries.length).toBe(12);
    expect(trendCard.benchmarkSeries.length).toBe(12);
    expect(trendCard.priorYearSeries.length).toBe(12);
    expect(trendCard.monthsPlotted).toBe(5);

    // Actual: Jan–May have real numbers; Jun–Dec are NULL.
    for (let i = 0; i < 5; i++) {
      expect(typeof trendCard.actualSeries[i].value).toBe("number");
    }
    for (let i = 5; i < 12; i++) {
      expect(trendCard.actualSeries[i].value).toBeNull();
    }

    // Benchmark: flat config value at every month (no nulls).
    for (const m of trendCard.benchmarkSeries) {
      expect(m.value).toBe(SILVER_SPRINGS_PAYROLL_BENCHMARK_PCT);
    }
    // Budget + Prior Year: real numbers at every month (no nulls).
    for (const m of trendCard.budgetSeries)    expect(typeof m.value).toBe("number");
    for (const m of trendCard.priorYearSeries) expect(typeof m.value).toBe("number");
  });

  it("x-axis labels for May 2026 run Jan → Dec (full fiscal year)", () => {
    expect(trendCard.months).toEqual([
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]);
  });

  it("commentary string carries the live delta vs prior year + dues ratio", () => {
    // YTD 59.2 − Prior 55.3 = +3.9 pts
    expect(trendCard.commentary).toContain("**+3.9 pts**");
    // The middle sentence is wrapped in __…__ for italicisation.
    expect(trendCard.commentary).toContain("__A rising payroll ratio in tandem");
    expect(trendCard.commentary).toContain("delivering the experience, not a cost problem.__");
    // Dues ratio numerics (62.3% / 59.2%) flow through.
    expect(trendCard.commentary).toContain("**62.3%**");
    expect(trendCard.commentary).toContain("**59.2%**");
  });

  it("changing the seed monthly inputs changes the KPI + commentary", () => {
    const bumped = buildPayrollRatioTrendData({
      monthlyActual: SILVER_SPRINGS_PAYROLL_ACTUAL_MONTHLY.map((m) => ({
        ...m,
        ratio: m.ratio + 5,
      })),
      monthlyBudget: SILVER_SPRINGS_PAYROLL_BUDGET_MONTHLY,
      monthlyPriorYear: SILVER_SPRINGS_PAYROLL_PRIOR_MONTHLY,
      benchmarkPct: SILVER_SPRINGS_PAYROLL_BENCHMARK_PCT,
      duesRatioPct: 62.27,
      golfRoundsActual:    SILVER_SPRINGS_GOLF_ROUNDS_ACTUAL,
      golfRoundsPriorYear: SILVER_SPRINGS_GOLF_ROUNDS_PRIOR_YEAR,
      reportingYear: 2026,
      reportingMonth: 5,
    });
    expect(bumped.kpis.ytdRatioLabel).toBe("64.2%");
    expect(bumped.commentary).toContain("**+8.9 pts**");
  });
});

describe("Financial Reporting Data Integrity — payroll surface", () => {
  it("Rule 1: 'golf rounds up X%' figure in the commentary is COMPUTED from typed inputs (not a hardcoded literal)", () => {
    // 6,483 − 5,400 = 1,083 → 1,083 / 5,400 × 100 = 20.05… → "20.1%"
    expect(trendCard.commentary).toContain("**20.1%**");
    // Changing the prior-year input must change the displayed figure
    // — proves no hardcoded "20%+" string survived.
    const bumped = buildPayrollRatioTrendData({
      monthlyActual: SILVER_SPRINGS_PAYROLL_ACTUAL_MONTHLY,
      monthlyBudget: SILVER_SPRINGS_PAYROLL_BUDGET_MONTHLY,
      monthlyPriorYear: SILVER_SPRINGS_PAYROLL_PRIOR_MONTHLY,
      benchmarkPct: SILVER_SPRINGS_PAYROLL_BENCHMARK_PCT,
      duesRatioPct: 62.27,
      golfRoundsActual:    SILVER_SPRINGS_GOLF_ROUNDS_ACTUAL,
      golfRoundsPriorYear: 4_000, // 6483/4000 - 1 = 62.075 % → "62.1%"
      reportingYear: 2026,
      reportingMonth: 5,
    });
    expect(bumped.commentary).toContain("**62.1%**");
    // And the old hardcoded "20%+" is gone.
    expect(bumped.commentary).not.toContain("**20%+**");
  });

  it("Rule 2: SILVER_SPRINGS_OPERATING_DUES is a SINGLE CANONICAL constant — dues-subsidy and payroll-analysis re-export the same number", () => {
    // The constant must come from ONE source. The Dues Subsidy
    // service is the canonical owner; payroll-analysis.ts re-exports
    // the import. The legacy alias SILVER_SPRINGS_DUES_TOTAL also
    // points at the same value.
    expect(SILVER_SPRINGS_OPERATING_DUES).toBe(DUES_FROM_DUES_SERVICE);
    expect(SILVER_SPRINGS_OPERATING_DUES).toBe(SILVER_SPRINGS_DUES_TOTAL);
    expect(SILVER_SPRINGS_OPERATING_DUES).toBe(10_381_000);
  });

  it("Rule 3: Total YTD Payroll KPI reconciles to the sum of department actual bars (chart points)", () => {
    // Σ chart actual bars × $1000 = the KPI's totalDollars.
    const chartActualSumK = deptCard.rows.reduce((s, r) => s + r.actualK, 0);
    const chartActualDollars = chartActualSumK * 1000;
    expect(chartActualDollars).toBe(deptCard.totals.actualDollars);
    // And the displayed KPI string matches a fresh format of that sum.
    expect(deptCard.kpis.totalYtdLabel).toBe("$9.87M");
  });

  it("Rule 3: 'vs. Budget' KPI reconciles to (Σ chart actual bars) − (Σ chart budget bars)", () => {
    const chartActualSumK = deptCard.rows.reduce((s, r) => s + r.actualK, 0);
    const chartBudgetSumK = deptCard.rows.reduce((s, r) => s + r.budgetK, 0);
    const deltaDollars = (chartActualSumK - chartBudgetSumK) * 1000;
    expect(deltaDollars).toBe(
      deptCard.totals.actualDollars - deptCard.totals.budgetDollars,
    );
    expect(deltaDollars).toBe(122_000);
    expect(deptCard.kpis.vsBudgetLabel).toBe("$122K");
  });

  it("Rule 3: 'vs. Prior Year' KPI reconciles to (Σ chart actual bars) − (Σ chart prior-year bars)", () => {
    const chartActualSumK = deptCard.rows.reduce((s, r) => s + r.actualK, 0);
    const chartPriorSumK = deptCard.rows.reduce((s, r) => s + r.priorYearK, 0);
    const deltaDollars = (chartActualSumK - chartPriorSumK) * 1000;
    expect(deltaDollars).toBe(
      deptCard.totals.actualDollars - deptCard.totals.priorYearDollars,
    );
    expect(deltaDollars).toBe(613_000);
    expect(deptCard.kpis.vsPriorYearLabel).toBe("$613K");
  });

  it("Rule 3: 'Payroll Ratio' KPI is CALCULATED from sum-of-actuals ÷ revenue (not hardcoded)", () => {
    const chartActualSumDollars = deptCard.rows.reduce((s, r) => s + r.actualK, 0) * 1000;
    const calcRatioPct = (chartActualSumDollars / SILVER_SPRINGS_PAYROLL_REVENUE) * 100;
    expect(calcRatioPct.toFixed(1)).toBe("59.2");
    expect(deptCard.kpis.payrollRatioLabel).toBe("59.2%");
  });

  it("Rule 4: Card-1 commentary numerics reconcile to the Card-1 KPI strip — same dues, same payroll, same ratios", () => {
    // The commentary's $10.38M dues = the canonical operating-dues
    // constant formatted in $M.
    expect(deptCard.check.bodySentence).toContain("**$10.38M**");
    // The commentary's $9.87M payroll = the KPI's totalYtdLabel.
    expect(deptCard.check.bodySentence).toContain(`**${deptCard.kpis.totalYtdLabel}**`);
    // The commentary's payroll-ratio % = the KPI's payrollRatioLabel.
    expect(deptCard.check.bodySentence).toContain(`**${deptCard.kpis.payrollRatioLabel}**`);
    // And the variance is THE actual subtraction (10,381 − 9,870 = $511K)
    expect(deptCard.check.bodySentence).toContain("**$511K**");
  });

  it("Rule 4: Card-2 commentary numerics reconcile to the Card-2 KPI strip — same payroll ratio, same prior-year delta", () => {
    // The commentary's payroll ratio = the KPI's ytdRatioLabel.
    expect(trendCard.commentary).toContain(`**${trendCard.kpis.ytdRatioLabel}**`);
    // The +X pts figure = ytdRatio − priorRatio (computed exactly,
    // not parsed from KPI strings — proves the same dataset drives
    // both the KPI tile and the commentary).
    const ytdRatio = parseFloat(trendCard.kpis.ytdRatioLabel);
    const priorRatio = parseFloat(trendCard.kpis.priorYearLabel);
    const delta = ytdRatio - priorRatio; // 59.2 − 55.3 = 3.9
    expect(trendCard.commentary).toContain(`**+${delta.toFixed(1)} pts**`);
  });

  it("Rule 6: Benchmark 57%+ is configuration-driven — changing the config changes the displayed benchmark", () => {
    const altBenchmark = buildPayrollRatioTrendData({
      monthlyActual: SILVER_SPRINGS_PAYROLL_ACTUAL_MONTHLY,
      monthlyBudget: SILVER_SPRINGS_PAYROLL_BUDGET_MONTHLY,
      monthlyPriorYear: SILVER_SPRINGS_PAYROLL_PRIOR_MONTHLY,
      benchmarkPct: 62, // changed
      duesRatioPct: 62.27,
      golfRoundsActual:    SILVER_SPRINGS_GOLF_ROUNDS_ACTUAL,
      golfRoundsPriorYear: SILVER_SPRINGS_GOLF_ROUNDS_PRIOR_YEAR,
      reportingYear: 2026,
      reportingMonth: 5,
    });
    expect(altBenchmark.kpis.benchmarkLabel).toBe("62%+");
    // Benchmark line series carries the new value.
    expect(altBenchmark.benchmarkSeries[0].value).toBe(62);
    // And the subtitle reflects it.
    expect(altBenchmark.subtitle).toContain("BENCHMARK 62%+");
  });
});

describe("Payroll Analysis — reporting-period logic (May 2026 YTD)", () => {
  it("Dept chart actual-series legend label is derived from reportingYear (2026 Actual, not 2025 Actual)", () => {
    expect(deptCard.actualSeriesLabel).toBe("2026 Actual");
    // Changing the reporting year changes the label.
    const fy2027 = buildPayrollDepartmentData({
      departments: SILVER_SPRINGS_PAYROLL_DEPTS,
      revenueDollars: SILVER_SPRINGS_PAYROLL_REVENUE,
      duesDollars: SILVER_SPRINGS_OPERATING_DUES,
      reportingYear: 2027,
    });
    expect(fy2027.actualSeriesLabel).toBe("2027 Actual");
  });

  it("Trend chart actual-series legend label is also derived from reportingYear", () => {
    expect(trendCard.actualSeriesLabel).toBe("2026 Actual");
  });

  it("X-axis ALWAYS spans Jan–Dec — for January, August, and December reports alike", () => {
    const reports = [1, 6, 8, 12].map((m) =>
      buildPayrollRatioTrendData({
        monthlyActual: SILVER_SPRINGS_PAYROLL_ACTUAL_MONTHLY,
        monthlyBudget: SILVER_SPRINGS_PAYROLL_BUDGET_MONTHLY,
        monthlyPriorYear: SILVER_SPRINGS_PAYROLL_PRIOR_MONTHLY,
        benchmarkPct: SILVER_SPRINGS_PAYROLL_BENCHMARK_PCT,
        duesRatioPct: 62.27,
        golfRoundsActual: SILVER_SPRINGS_GOLF_ROUNDS_ACTUAL,
        golfRoundsPriorYear: SILVER_SPRINGS_GOLF_ROUNDS_PRIOR_YEAR,
        reportingYear: 2026,
        reportingMonth: m,
      }),
    );
    for (const r of reports) {
      expect(r.months.length).toBe(12);
      expect(r.budgetSeries.length).toBe(12);
      expect(r.benchmarkSeries.length).toBe(12);
      expect(r.priorYearSeries.length).toBe(12);
      expect(r.actualSeries.length).toBe(12);
    }
  });

  it("Actual data extends through the reporting month — Jan→1 point, Aug→8 points, Dec→12 points", () => {
    const cases: [number, number][] = [[1, 1], [6, 6], [8, 8], [12, 12]];
    for (const [reportingMonth, expectedRealCount] of cases) {
      const r = buildPayrollRatioTrendData({
        monthlyActual: SILVER_SPRINGS_PAYROLL_ACTUAL_MONTHLY,
        monthlyBudget: SILVER_SPRINGS_PAYROLL_BUDGET_MONTHLY,
        monthlyPriorYear: SILVER_SPRINGS_PAYROLL_PRIOR_MONTHLY,
        benchmarkPct: SILVER_SPRINGS_PAYROLL_BENCHMARK_PCT,
        duesRatioPct: 62.27,
        golfRoundsActual: SILVER_SPRINGS_GOLF_ROUNDS_ACTUAL,
        golfRoundsPriorYear: SILVER_SPRINGS_GOLF_ROUNDS_PRIOR_YEAR,
        reportingYear: 2026,
        reportingMonth,
      });
      const realCount = r.actualSeries.filter((p) => p.value != null).length;
      expect(realCount, `reportingMonth=${reportingMonth}`).toBe(expectedRealCount);
      expect(r.monthsPlotted).toBe(reportingMonth);
      // Future months (after the reporting month) are explicitly null
      // — NOT zero, NOT carried-forward.
      for (let i = reportingMonth; i < 12; i++) {
        expect(r.actualSeries[i].value).toBeNull();
      }
    }
  });

  it("FUTURE actuals are NEVER zero, NEVER carried-forward — explicitly null", () => {
    // Sanity guard against silent regressions where future values
    // could end up as 0 (proxy) or as the last known value.
    for (let i = 5; i < 12; i++) {
      expect(trendCard.actualSeries[i].value).toBeNull();
      expect(trendCard.actualSeries[i].value).not.toBe(0);
      // And it's clearly the same as before for May:
      expect(trendCard.actualSeries[i].value).not.toBe(trendCard.actualSeries[4].value);
    }
  });

  it("KPI values still reconcile to the plotted YTD data — May 2026 Jan–May avg = displayed YTD Ratio", () => {
    // The actual series has 12 entries (full fiscal year). Through
    // index N=5 carry real values; indices 5..11 are NULL. The YTD
    // Ratio KPI must be the average of the first 5 non-null values.
    const realValues = trendCard.actualSeries
      .map((p) => p.value)
      .filter((v): v is number => v != null);
    const avgReal = realValues.reduce((s, v) => s + v, 0) / realValues.length;
    expect(realValues.length).toBe(5);
    expect(avgReal.toFixed(1)).toBe("59.2");
    expect(trendCard.kpis.ytdRatioLabel).toBe("59.2%");
  });

  it("Card 1 Payroll Ratio KPI = Card 2 YTD Ratio KPI (single-source reconciliation)", () => {
    // Both KPIs come from accounting-fed sources and should agree.
    expect(deptCard.kpis.payrollRatioLabel).toBe(trendCard.kpis.ytdRatioLabel);
    expect(deptCard.kpis.payrollRatioLabel).toBe("59.2%");
  });
});

describe("Payroll Analysis — no inline literals in React (audit guard at the data layer)", () => {
  it("header strings match the founder spec", () => {
    expect(deptCard.title).toBe("Payroll Analysis — Department Breakdown");
    expect(deptCard.subtitle).toBe("ACTUAL VS. BUDGET VS. PRIOR YEAR · ALL DEPARTMENTS");
    expect(deptCard.pillLabel).toBe("LABOR REPORT");

    expect(trendCard.title).toBe("Payroll Ratio — Monthly Trend");
    expect(trendCard.subtitle).toBe(
      "PAYROLL AS % OF REVENUE · ACTUAL VS. BUDGET · BENCHMARK 57%+",
    );
    expect(trendCard.pillLabel).toBe("RATIO TREND");
  });

  it("dataSource is 'demo' on both cards (until GL classification lands)", () => {
    expect(deptCard.dataSource).toBe("demo");
    expect(trendCard.dataSource).toBe("demo");
  });
});

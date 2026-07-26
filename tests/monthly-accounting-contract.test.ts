// Tests for the canonical Monthly Accounting Contract.
//
// These tests prove the contract:
//   1. Accepts mocked Jonas-style accounting input and returns a
//      complete `MonthlyAccountingReport`.
//   2. Carries the 4-value data-source taxonomy ("accounting" /
//      "operational" / "demo" / "derived") through every block.
//   3. Derives NOI / variance / variance% / tone / capital-fund
//      net-change / balance-sheet totals / AR aging current% from
//      its inputs — never from literal seeds.
//   4. Reacts to changed inputs (a mutated revenue figure changes
//      the output everywhere it appears — proves it is not a static
//      object).
//   5. Pre-formats every money amount + every variance label so
//      React components render strings only.
//
// These tests intentionally exercise the contract with *mocked
// accounting-backed input*, not the demo helper, so we know future
// Jonas-import wiring services (which produce the same input shape)
// will flow through correctly.

import { describe, it, expect } from "vitest";

import { buildReportingPeriod } from "@/lib/reporting/reporting-period";
import {
  buildMonthlyAccountingReport,
  buildDemoMonthlyAccountingInput,
  buildDemoMonthlyAccountingReport,
  buildActualVsBudget,
  buildMoneyAmount,
  classifyVarianceTone,
  formatMoneyFull,
  formatMoneyShort,
  formatVariancePct,
  toLegacyDataSource,
  type MonthlyAccountingReportInput,
  type MonthlyAccountingDataSource,
} from "@/lib/reporting/monthly-accounting-contract";

// A fixed period — May 2026 — so every assertion is deterministic.
const PERIOD = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31, 23, 59, 59)));
const CLUB_ID = "club_test_001";

describe("monthly-accounting-contract — money + variance primitives", () => {
  it("formatMoneyFull renders positives, negatives, and zero", () => {
    expect(formatMoneyFull(1_234_567)).toBe("$1,234,567");
    expect(formatMoneyFull(-1_234_567)).toBe("($1,234,567)");
    expect(formatMoneyFull(0)).toBe("$0");
  });

  it("formatMoneyShort compacts to M / K / dollar", () => {
    expect(formatMoneyShort(3_180_000)).toBe("$3.18M");
    expect(formatMoneyShort(245_000)).toBe("$245K");
    expect(formatMoneyShort(245)).toBe("$245");
    expect(formatMoneyShort(0)).toBe("$0");
    expect(formatMoneyShort(-193_000)).toBe("($193K)");
  });

  it("formatVariancePct signs the result and uses parens for negatives", () => {
    expect(formatVariancePct(0.032)).toBe("+3.2%");
    expect(formatVariancePct(-0.014)).toBe("(1.4%)");
    expect(formatVariancePct(0)).toBe("0.0%");
  });

  it("buildMoneyAmount round-trips amount + both labels", () => {
    const m = buildMoneyAmount(3_180_000);
    expect(m.amount).toBe(3_180_000);
    expect(m.label).toBe("$3,180,000");
    expect(m.shortLabel).toBe("$3.18M");
  });

  it("classifyVarianceTone uses the neutral band for tiny variances", () => {
    expect(classifyVarianceTone(0.0)).toBe("neutral");
    expect(classifyVarianceTone(0.001)).toBe("neutral");
    expect(classifyVarianceTone(0.01)).toBe("favorable");
    expect(classifyVarianceTone(-0.01)).toBe("unfavorable");
  });

  it("classifyVarianceTone flips when higherIsFavorable=false (expenses)", () => {
    // For expenses, positive variance (actual > budget) is BAD.
    expect(classifyVarianceTone(0.01, { higherIsFavorable: false })).toBe(
      "unfavorable",
    );
    expect(classifyVarianceTone(-0.01, { higherIsFavorable: false })).toBe(
      "favorable",
    );
  });

  it("buildActualVsBudget computes variance, variance %, and tone", () => {
    const block = buildActualVsBudget({
      actual: 1_050_000,
      budget: 1_000_000,
      priorYear: 980_000,
      higherIsFavorable: true,
    });
    expect(block.actual.amount).toBe(1_050_000);
    expect(block.varianceVsBudget.amount).toBe(50_000);
    expect(block.varianceVsBudgetPct).toBeCloseTo(0.05, 5);
    expect(block.varianceVsBudgetPctLabel).toBe("+5.0%");
    expect(block.varianceVsPriorYear.amount).toBe(70_000);
    expect(block.varianceTone).toBe("favorable");
  });

  it("buildActualVsBudget returns variancePct=0 when budget is zero (no div-by-zero crash)", () => {
    const block = buildActualVsBudget({
      actual: 500,
      budget: 0,
      priorYear: 0,
    });
    expect(block.varianceVsBudgetPct).toBe(0);
    expect(block.varianceTone).toBe("neutral");
  });
});

describe("monthly-accounting-contract — toLegacyDataSource", () => {
  it("maps accounting / operational / derived to live; only demo to demo", () => {
    expect(toLegacyDataSource("accounting")).toBe("live");
    expect(toLegacyDataSource("operational")).toBe("live");
    expect(toLegacyDataSource("derived")).toBe("live");
    expect(toLegacyDataSource("demo")).toBe("demo");
  });
});

describe("monthly-accounting-contract — buildMonthlyAccountingReport from mocked accounting input", () => {
  // A minimal but realistic mocked-accounting input — what a future
  // Jonas-import wiring service (e.g. `getGLAccountTotals()` +
  // `getBalanceSheet()`) will produce. Every block carries
  // `dataSource: "accounting"` (or `"operational"` for AR) so the
  // legacy rollup should be "live".
  function makeMockedAccountingInput(
    overrides: Partial<MonthlyAccountingReportInput> = {},
  ): MonthlyAccountingReportInput {
    return {
      period: PERIOD,
      clubId: CLUB_ID,
      operatingRevenueRaw: [
        {
          categoryKey: "OPERATING_DUES",
          label: "Operating Dues",
          currentMonthActual: 900_000,
          currentMonthBudget: 900_000,
          currentMonthPriorYear: 880_000,
          ytdActual: 4_500_000,
          ytdBudget: 4_500_000,
          ytdPriorYear: 4_400_000,
          dataSource: "accounting",
        },
        {
          categoryKey: "INITIATION_FEES",
          label: "Initiation Fees",
          currentMonthActual: 100_000,
          currentMonthBudget: 100_000,
          currentMonthPriorYear: 80_000,
          ytdActual: 500_000,
          ytdBudget: 500_000,
          ytdPriorYear: 400_000,
          dataSource: "accounting",
        },
      ],
      operatingExpensesRaw: [
        {
          categoryKey: "PAYROLL_BENEFITS",
          label: "Payroll & Benefits",
          currentMonthActual: 600_000,
          currentMonthBudget: 600_000,
          currentMonthPriorYear: 580_000,
          ytdActual: 3_000_000,
          ytdBudget: 3_000_000,
          ytdPriorYear: 2_900_000,
          higherIsFavorable: false,
          dataSource: "accounting",
        },
      ],
      capitalFundRaw: {
        sources: [
          {
            categoryKey: "CAPITAL_DUES",
            label: "Capital Dues",
            currentMonthActual: 96_000,
            currentMonthBudget: 96_000,
            currentMonthPriorYear: 92_000,
            ytdActual: 480_000,
            ytdBudget: 480_000,
            ytdPriorYear: 460_000,
            dataSource: "accounting",
          },
        ],
        deployed: [
          {
            categoryKey: "RESERVE_REPLACEMENTS",
            label: "Replacements",
            currentMonthActual: 80_000,
            currentMonthBudget: 100_000,
            currentMonthPriorYear: 70_000,
            ytdActual: 400_000,
            ytdBudget: 500_000,
            ytdPriorYear: 350_000,
            higherIsFavorable: false,
            dataSource: "accounting",
          },
        ],
        reserveFundBalance: 5_000_000,
        totalAssetReplacementCost: 10_000_000,
        dataSource: "accounting",
      },
      balanceSheetRaw: {
        asOf: PERIOD.periodEnd,
        accounts: [
          // Assets: 2M + 5M + 23M = 30M
          {
            accountKey: "CASH",
            label: "Cash",
            category: "CURRENT_ASSET",
            amount: 2_000_000,
            dataSource: "accounting",
          },
          {
            accountKey: "RESERVE_FUND",
            label: "Reserve Fund",
            category: "CAPITAL_FUND_ASSET",
            amount: 5_000_000,
            dataSource: "accounting",
          },
          {
            accountKey: "PPE_NET",
            label: "PP&E (Net)",
            category: "PROPERTY_PLANT_EQUIPMENT",
            amount: 23_000_000,
            dataSource: "accounting",
          },
          // Liabilities: 0.5M + 1.5M = 2M
          {
            accountKey: "AP",
            label: "Accounts Payable",
            category: "CURRENT_LIABILITY",
            amount: 500_000,
            dataSource: "accounting",
          },
          {
            accountKey: "LTD",
            label: "Long-Term Debt",
            category: "LONG_TERM_LIABILITY",
            amount: 1_500_000,
            dataSource: "accounting",
          },
          // Equity: 30M − 2M = 28M
          {
            accountKey: "EQUITY",
            label: "Members' Equity",
            category: "EQUITY",
            amount: 28_000_000,
            dataSource: "accounting",
          },
        ],
        dataSource: "accounting",
      },
      departmentsRaw: [
        {
          departmentId: "GOLF",
          name: "Golf Operations",
          ytdRevenueActual: 720_000,
          ytdRevenueBudget: 700_000,
          ytdRevenuePriorYear: 640_000,
          ytdExpenseActual: 540_000,
          ytdExpenseBudget: 530_000,
          ytdExpensePriorYear: 500_000,
          dataSource: "accounting",
        },
      ],
      arAgingRaw: {
        asOf: PERIOD.periodEnd,
        byCategory: [
          {
            categoryKey: "DUES",
            label: "Membership Dues",
            current: 900_000,
            thirtyToSixty: 0,
            sixtyOneToNinety: 0,
            overNinety: 100_000,
            dataSource: "operational",
          },
        ],
        dataSource: "operational",
      },
      builtAt: new Date(Date.UTC(2026, 5, 5, 12, 0, 0)),
      ...overrides,
    };
  }

  it("returns a complete report given mocked accounting input", () => {
    const input = makeMockedAccountingInput();
    const report = buildMonthlyAccountingReport(input);

    // Period flows through verbatim — no re-derivation.
    expect(report.period).toBe(PERIOD);
    expect(report.period.periodLabel).toBe("May 2026");
    expect(report.clubId).toBe(CLUB_ID);

    // Operating revenue + expense arrays preserve order & inputs.
    expect(report.operatingRevenue).toHaveLength(2);
    expect(report.operatingExpenses).toHaveLength(1);
    expect(report.operatingRevenue[0].categoryKey).toBe("OPERATING_DUES");
    expect(report.operatingRevenue[0].ytd.actual.amount).toBe(4_500_000);
    expect(report.operatingRevenue[0].ytd.actual.label).toBe("$4,500,000");
    expect(report.operatingRevenue[0].ytd.actual.shortLabel).toBe("$4.50M");

    // Capital fund passed through and shaped.
    expect(report.capitalFund.sources).toHaveLength(1);
    expect(report.capitalFund.deployed).toHaveLength(1);
    expect(report.capitalFund.reserveCoverageRatio).toBeCloseTo(0.5, 5);

    // Balance sheet — 6 accounts in, 6 out.
    expect(report.balanceSheet.accounts).toHaveLength(6);
    expect(report.balanceSheet.totalAssets.amount).toBe(30_000_000);
    expect(report.balanceSheet.totalLiabilities.amount).toBe(2_000_000);
    expect(report.balanceSheet.totalEquity.amount).toBe(28_000_000);
    expect(report.balanceSheet.totalLiabilitiesAndEquity.amount).toBe(
      30_000_000,
    );
    expect(report.balanceSheet.isReconciled).toBe(true);

    // Departments + AR pass through.
    expect(report.departments).toHaveLength(1);
    expect(report.arAging.byCategory).toHaveLength(1);

    // Metadata reflects supplied builtAt.
    expect(report.metadata.builtAt).toEqual(
      new Date(Date.UTC(2026, 5, 5, 12, 0, 0)),
    );
  });

  it("derives NOI from revenue − expense at both current-month and YTD level", () => {
    const input = makeMockedAccountingInput();
    const report = buildMonthlyAccountingReport(input);

    // Current-month actual NOI = (900 + 100) − 600 = 400K
    expect(report.noi.currentMonth.actual.amount).toBe(400_000);
    // Current-month budget NOI = (900 + 100) − 600 = 400K
    expect(report.noi.currentMonth.budget.amount).toBe(400_000);
    // YTD actual NOI = (4_500 + 500) − 3_000 = 2_000K
    expect(report.noi.ytd.actual.amount).toBe(2_000_000);
    // YTD prior-year NOI = (4_400 + 400) − 2_900 = 1_900K
    expect(report.noi.ytd.priorYear.amount).toBe(1_900_000);
    // NOI is always derived — never `accounting`.
    expect(report.noi.dataSource).toBe("derived");
  });

  it("flips legacyDataSource to 'demo' the moment any input is demo", () => {
    const input = makeMockedAccountingInput();
    // All accounting → legacy = live
    expect(buildMonthlyAccountingReport(input).metadata.legacyDataSource).toBe(
      "live",
    );
    // Mark one revenue line demo → legacy = demo
    const dirtied: MonthlyAccountingReportInput = {
      ...input,
      operatingRevenueRaw: [
        { ...input.operatingRevenueRaw[0], dataSource: "demo" },
        ...input.operatingRevenueRaw.slice(1),
      ],
    };
    expect(buildMonthlyAccountingReport(dirtied).metadata.legacyDataSource).toBe(
      "demo",
    );
  });

  it("tallies all 4 data-source classes into sourceSummary", () => {
    const input = makeMockedAccountingInput();
    const summary = buildMonthlyAccountingReport(input).metadata.sourceSummary;
    // accounting comes from revenue (2) + expense (1) + capital
    // fund header (1) + sources (1) + deployed (1) + balance sheet
    // header (1) + 6 BS accounts + 1 department = 14
    expect(summary.accounting).toBe(14);
    // operational from AR header + 1 AR category = 2
    expect(summary.operational).toBe(2);
    // derived: NOI = 1
    expect(summary.derived).toBe(1);
    expect(summary.demo).toBe(0);
  });

  it("balance sheet flags isReconciled=false when assets do not equal liab + equity", () => {
    const input = makeMockedAccountingInput({
      balanceSheetRaw: {
        asOf: PERIOD.periodEnd,
        accounts: [
          {
            accountKey: "CASH",
            label: "Cash",
            category: "CURRENT_ASSET",
            amount: 1_000_000, // assets total 1M
            dataSource: "accounting",
          },
          {
            accountKey: "AP",
            label: "AP",
            category: "CURRENT_LIABILITY",
            amount: 100_000,
            dataSource: "accounting",
          },
          {
            accountKey: "EQUITY",
            label: "Equity",
            category: "EQUITY",
            amount: 800_000, // L + E = 900K  ≠  1_000_000
            dataSource: "accounting",
          },
        ],
        dataSource: "accounting",
      },
    });
    expect(
      buildMonthlyAccountingReport(input).balanceSheet.isReconciled,
    ).toBe(false);
  });

  it("AR aging current% and over-90% derive from input buckets", () => {
    const input = makeMockedAccountingInput();
    const report = buildMonthlyAccountingReport(input);
    // 1M total: 900K current, 100K over-90 → 90% current, 10% over-90
    expect(report.arAging.totalAR.amount).toBe(1_000_000);
    expect(report.arAging.currentPct).toBeCloseTo(0.9, 5);
    expect(report.arAging.over90Pct).toBeCloseTo(0.1, 5);
  });

  it("mutating a revenue input changes NOI, totals, and tone (contract is not a constant)", () => {
    const base = makeMockedAccountingInput();
    const baseReport = buildMonthlyAccountingReport(base);
    const baseNoiYtd = baseReport.noi.ytd.actual.amount;

    // Bump operating dues YTD actual by $500K. NOI should rise by
    // exactly $500K. This is the canonical "input-sensitivity" check
    // the audit doc §7 T1 calls for.
    const lifted: MonthlyAccountingReportInput = {
      ...base,
      operatingRevenueRaw: [
        {
          ...base.operatingRevenueRaw[0],
          ytdActual: base.operatingRevenueRaw[0].ytdActual + 500_000,
        },
        ...base.operatingRevenueRaw.slice(1),
      ],
    };
    const liftedReport = buildMonthlyAccountingReport(lifted);
    expect(liftedReport.noi.ytd.actual.amount).toBe(baseNoiYtd + 500_000);

    // And the revenue-line variance flips favorable (was 0% on plan).
    expect(liftedReport.operatingRevenue[0].ytd.varianceTone).toBe("favorable");
    expect(liftedReport.operatingRevenue[0].ytd.varianceVsBudget.amount).toBe(
      500_000,
    );
  });

  it("expense lines default to higherIsFavorable=false (tone flips correctly)", () => {
    const input = makeMockedAccountingInput({
      operatingExpensesRaw: [
        {
          categoryKey: "PAYROLL_BENEFITS",
          label: "Payroll",
          currentMonthActual: 700_000, // 100K OVER budget — UNFAVORABLE
          currentMonthBudget: 600_000,
          currentMonthPriorYear: 580_000,
          ytdActual: 3_500_000,
          ytdBudget: 3_000_000,
          ytdPriorYear: 2_900_000,
          dataSource: "accounting",
          // higherIsFavorable: false — inferred since this is in
          // operatingExpensesRaw and we don't override.
        },
      ],
    });
    const report = buildMonthlyAccountingReport(input);
    // Expense over budget is UNFAVORABLE.
    expect(report.operatingExpenses[0].currentMonth.varianceTone).toBe(
      "unfavorable",
    );
    expect(report.operatingExpenses[0].currentMonth.varianceVsBudget.amount).toBe(
      100_000,
    );
  });
});

describe("monthly-accounting-contract — demo factory", () => {
  it("buildDemoMonthlyAccountingInput returns a complete input with every block tagged demo or operational", () => {
    const input = buildDemoMonthlyAccountingInput({ period: PERIOD, clubId: CLUB_ID });
    // Every revenue + expense + capital + balance-sheet block is
    // explicitly "demo". AR is "operational" (subledger semantics).
    input.operatingRevenueRaw.forEach((r) => expect(r.dataSource).toBe("demo"));
    input.operatingExpensesRaw.forEach((r) => expect(r.dataSource).toBe("demo"));
    expect(input.capitalFundRaw.dataSource).toBe("demo");
    expect(input.balanceSheetRaw.dataSource).toBe("demo");
    input.departmentsRaw.forEach((d) => expect(d.dataSource).toBe("demo"));
    expect(input.arAgingRaw.dataSource).toBe("operational");
  });

  it("buildDemoMonthlyAccountingReport reconciles the demo balance sheet", () => {
    const report = buildDemoMonthlyAccountingReport({
      period: PERIOD,
      clubId: CLUB_ID,
    });
    expect(report.balanceSheet.isReconciled).toBe(true);
    // Legacy data source falls to "demo" because of the demo tags.
    expect(report.metadata.legacyDataSource).toBe("demo");
    // sourceSummary has both demo and operational entries.
    const s = report.metadata.sourceSummary;
    expect(s.demo).toBeGreaterThan(0);
    expect(s.operational).toBeGreaterThan(0);
    expect(s.accounting).toBe(0);
  });
});

describe("monthly-accounting-contract — pre-formatted strings (React renders only)", () => {
  it("every money amount carries .label and .shortLabel ready to render", () => {
    const report = buildDemoMonthlyAccountingReport({
      period: PERIOD,
      clubId: CLUB_ID,
    });
    // Pick a representative deeply-nested money amount and check it
    // carries both label forms — no React-side formatting required.
    const dues = report.operatingRevenue[0];
    expect(dues.ytd.actual.label).toMatch(/^\$/);
    expect(dues.ytd.actual.shortLabel).toMatch(/^\$/);
    expect(dues.ytd.varianceVsBudgetPctLabel).toMatch(/%$/);

    // Same for the deeply-nested balance sheet account.
    expect(report.balanceSheet.totalAssets.label).toMatch(/^\$/);
    expect(report.balanceSheet.totalAssets.shortLabel).toMatch(/^\$/);
  });

  it("varianceTone is pre-classified so React renders the tone class directly", () => {
    const report = buildDemoMonthlyAccountingReport({
      period: PERIOD,
      clubId: CLUB_ID,
    });
    // Every GL aggregate's current-month + YTD blocks have a tone.
    report.operatingRevenue.forEach((r) => {
      expect(["favorable", "unfavorable", "neutral"]).toContain(
        r.ytd.varianceTone,
      );
    });
    report.operatingExpenses.forEach((r) => {
      expect(["favorable", "unfavorable", "neutral"]).toContain(
        r.ytd.varianceTone,
      );
    });
  });
});

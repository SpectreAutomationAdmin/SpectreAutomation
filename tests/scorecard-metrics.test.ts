import { describe, it, expect } from "vitest";
import {
  buildOperatingScorecardData,
  buildCapitalScorecardData,
  SILVER_SPRINGS_OPERATING_INPUTS,
  SILVER_SPRINGS_CAPITAL_INPUTS,
  type OperatingScorecardInputs,
  type CapitalScorecardInputs,
} from "@/lib/reporting/scorecard-metrics";

// Unit tests for the Stewardship Scorecard reporting service. Every
// row's actual / budget / status flows from numeric inputs — these
// tests prove the computations are correct AND that changing an
// input changes the output (Rule 7 / Rule 8 in the founder spec).

const OPS_LABELS = {
  ytdNoiLabel: "$45K",
  budgetGoalLabel: "$0",
  noiPctRevenueLabel: "0.3%",
};

const EQ_LABELS = {
  actualCagrLabel: "7.4%",
  bestInClassCagrLabel: "5.5%",
};

describe("buildOperatingScorecardData — Silver Springs inputs", () => {
  const card = buildOperatingScorecardData(SILVER_SPRINGS_OPERATING_INPUTS, OPS_LABELS);
  const row = (key: string) => card.rows.find((r) => r.key === key)!;

  it("emits all 8 rows in the founder-approved order", () => {
    expect(card.rows.map((r) => r.key)).toEqual([
      "dues-to-revenue",
      "initiation-fee-subsidy",
      "payroll-benefits-ratio",
      "noi-variance-to-budget",
      "noi-pct-revenue",
      "fb-subsidy-pct-dues",
      "golf-rounds-vs-budget",
      "fb-covers-vs-budget",
    ]);
  });

  it("Dues-to-Revenue Ratio — actual / budget COMPUTED from dues ÷ revenue", () => {
    // 9,885,000 / 15,000,000 = 0.659 → "65.9%"
    expect(row("dues-to-revenue").actual).toBe("65.9%");
    expect(row("dues-to-revenue").budget).toBe("67.2%");
    expect(row("dues-to-revenue").benchmark).toBe("≥60%");
    expect(row("dues-to-revenue").status).toBe("on-track"); // 65.9% > 60% threshold
  });

  it("Initiation Fee Operating Subsidy — formatted $X.XXM; status reflects the policy violation", () => {
    expect(row("initiation-fee-subsidy").actual).toBe("$1.07M");
    expect(row("initiation-fee-subsidy").budget).toBe("$1.04M");
    expect(row("initiation-fee-subsidy").benchmark).toBe("$0");
    // $1.07M > $100K → status = "action" (policy violation).
    expect(row("initiation-fee-subsidy").status).toBe("action");
  });

  it("Payroll & Benefits Ratio — actual / budget computed; status reflects payroll < dues rule", () => {
    expect(row("payroll-benefits-ratio").actual).toBe("59.2%");
    expect(row("payroll-benefits-ratio").budget).toBe("58.2%");
    // payroll 59.2 % is more than 3 % below dues 65.9 % → "on-track"
    // (the rule: on-track when payroll < dues by ≥ 3 %; monitor when
    // payroll < dues but within 3 %; action when payroll >= dues).
    expect(row("payroll-benefits-ratio").status).toBe("on-track");
  });

  it("Payroll & Benefits Ratio — STATUS FLIPS when payroll edges within 3% of dues", () => {
    // Verify the status branches by inputting payroll = dues − 1%.
    const tight = buildOperatingScorecardData(
      {
        ...SILVER_SPRINGS_OPERATING_INPUTS,
        // dues remains 65.9 %; bump payroll to ~64.9 % → within 3 %
        payrollBenefitsExpense: 9_735_000, // 64.9 % of 15M
      },
      OPS_LABELS,
    );
    expect(tight.rows.find((r) => r.key === "payroll-benefits-ratio")!.status).toBe("monitor");

    const broken = buildOperatingScorecardData(
      {
        ...SILVER_SPRINGS_OPERATING_INPUTS,
        // payroll >= dues
        payrollBenefitsExpense: 10_000_000, // 66.7 %
      },
      OPS_LABELS,
    );
    expect(broken.rows.find((r) => r.key === "payroll-benefits-ratio")!.status).toBe("action");
  });

  it("NOI Variance + NOI % rows pull DIRECTLY from operating-results dashboard labels", () => {
    expect(row("noi-variance-to-budget").actual).toBe("$45K fav.");
    expect(row("noi-variance-to-budget").budget).toBe("$0");
    expect(row("noi-pct-revenue").actual).toBe("0.3%");
    // Both rows are marked live.
    expect(row("noi-variance-to-budget").dataSource).toBe("live");
    expect(row("noi-pct-revenue").dataSource).toBe("live");
  });

  it("F&B Subsidy % of Dues shows '—' when fbSubsidy input is null (TODO state)", () => {
    expect(row("fb-subsidy-pct-dues").actual).toBe("—");
  });

  it("Golf Rounds vs. Budget — variance computed from actual − budget; trend follows the delta", () => {
    expect(row("golf-rounds-vs-budget").actual).toBe("6,483");
    expect(row("golf-rounds-vs-budget").budget).toBe("5,455");
    expect(row("golf-rounds-vs-budget").benchmark).toBe("+1,028"); // computed variance
    expect(row("golf-rounds-vs-budget").status).toBe("on-track");
    expect(row("golf-rounds-vs-budget").trend).toBe("up");
  });

  it("F&B Covers vs. Budget — variance with U+2212 minus; status action on negative delta", () => {
    expect(row("fb-covers-vs-budget").actual).toBe("24,207");
    expect(row("fb-covers-vs-budget").budget).toBe("29,310");
    expect(row("fb-covers-vs-budget").benchmark).toBe("−5,103"); // U+2212
    expect(row("fb-covers-vs-budget").status).toBe("action");
    expect(row("fb-covers-vs-budget").trend).toBe("down");
  });
});

describe("buildCapitalScorecardData — Silver Springs inputs", () => {
  const card = buildCapitalScorecardData(SILVER_SPRINGS_CAPITAL_INPUTS, EQ_LABELS);
  const row = (key: string) => card.rows.find((r) => r.key === key)!;

  it("emits all 8 rows in the founder-approved order", () => {
    expect(card.rows.map((r) => r.key)).toEqual([
      "equity-cagr",
      "equity-to-assets",
      "capital-reserve-pct",
      "net-available-capital",
      "net-capital-vs-depreciation",
      "long-term-debt-equity",
      "net-ppe-to-gross-ppe",
      "total-capital-income-vs-budget",
    ]);
  });

  it("Equity Growth CAGR — pulls from equity dashboard labels", () => {
    expect(row("equity-cagr").actual).toBe("7.4%");
    expect(row("equity-cagr").benchmark).toBe("5.5%+");
    expect(row("equity-cagr").dataSource).toBe("live");
  });

  it("Equity-to-Assets Ratio — actual COMPUTED from equity ÷ assets", () => {
    // 31,000,000 / 40,155,000 = 0.7720 → "77.2%"
    expect(row("equity-to-assets").actual).toBe("77.2%");
    expect(row("equity-to-assets").budget).toBe("77.0%"); // configured goal
    expect(row("equity-to-assets").benchmark).toBe("66%+");
    expect(row("equity-to-assets").status).toBe("on-track");
  });

  it("Capital Reserve % of Assets — actual COMPUTED; status from threshold", () => {
    // 4,698,000 / 40,155,000 = 0.1170 → "11.7%"
    expect(row("capital-reserve-pct").actual).toBe("11.7%");
    expect(row("capital-reserve-pct").budget).toBe("14.0%");
    // 11.7 % < 14 % but within 3 % monitor slack → "monitor"
    expect(row("capital-reserve-pct").status).toBe("monitor");
  });

  it("Net Available Capital — actual COMPUTED from net-available ÷ operating revenue", () => {
    expect(row("net-available-capital").actual).toBe("26.2%");
    expect(row("net-available-capital").budget).toBe("34.7%");
    expect(row("net-available-capital").status).toBe("on-track"); // 26.2 % > 20 %
  });

  it("Net Capital > Depreciation? — actual is YES/NO computed from the comparison", () => {
    // 4,700,000 > 4,200,000 → "YES"
    expect(row("net-capital-vs-depreciation").actual).toBe("YES");
    expect(row("net-capital-vs-depreciation").status).toBe("on-track");
  });

  it("Long-Term Debt-to-Equity shows '—' when input is null (TODO state)", () => {
    expect(row("long-term-debt-equity").actual).toBe("—");
  });

  it("Net PPE / Gross PPE — actual COMPUTED; status action when below threshold", () => {
    // 8,060,000 / 26,000,000 = 0.31 → "31%"
    expect(row("net-ppe-to-gross-ppe").actual).toBe("31%");
    expect(row("net-ppe-to-gross-ppe").budget).toBe("35%");
    expect(row("net-ppe-to-gross-ppe").status).toBe("action"); // 31 % < 40 % - 5 %
    expect(row("net-ppe-to-gross-ppe").trend).toBe("down");
  });

  it("Total Capital Income vs. Budget — variance dollar formatted with U+2212 minus", () => {
    expect(row("total-capital-income-vs-budget").actual).toBe("$4.44M");
    expect(row("total-capital-income-vs-budget").budget).toBe("$6.03M");
    expect(row("total-capital-income-vs-budget").benchmark).toBe("−$1.59M");
    expect(row("total-capital-income-vs-budget").status).toBe("monitor");
    expect(row("total-capital-income-vs-budget").trend).toBe("down");
  });
});

describe("Scorecard input sensitivity — changing seed changes output", () => {
  it("doubling dues revenue changes the displayed Dues-to-Revenue ratio (Rule 7)", () => {
    const baseline = buildOperatingScorecardData(SILVER_SPRINGS_OPERATING_INPUTS, OPS_LABELS);
    const doubled = buildOperatingScorecardData(
      { ...SILVER_SPRINGS_OPERATING_INPUTS, duesRevenue: SILVER_SPRINGS_OPERATING_INPUTS.duesRevenue * 2 },
      OPS_LABELS,
    );
    const baselineActual = baseline.rows.find((r) => r.key === "dues-to-revenue")!.actual;
    const doubledActual  = doubled.rows.find((r) => r.key === "dues-to-revenue")!.actual;
    expect(baselineActual).toBe("65.9%");
    expect(doubledActual).not.toBe(baselineActual);
    expect(doubledActual).toBe("131.8%");
  });

  it("changing operating-budget revenue changes the displayed Budget column (Rule 8)", () => {
    const baseline = buildOperatingScorecardData(SILVER_SPRINGS_OPERATING_INPUTS, OPS_LABELS);
    const bumped = buildOperatingScorecardData(
      { ...SILVER_SPRINGS_OPERATING_INPUTS, duesRevenueBudget: 12_000_000 },
      OPS_LABELS,
    );
    expect(baseline.rows.find((r) => r.key === "dues-to-revenue")!.budget).toBe("67.2%");
    expect(bumped.rows.find((r) => r.key === "dues-to-revenue")!.budget).toBe("80.0%");
  });

  it("changing capital reserve balance flips the Capital Reserve status", () => {
    // Raise reserves so the ratio exceeds the threshold.
    const baseline = buildCapitalScorecardData(SILVER_SPRINGS_CAPITAL_INPUTS, EQ_LABELS);
    expect(baseline.rows.find((r) => r.key === "capital-reserve-pct")!.status).toBe("monitor");
    const lifted = buildCapitalScorecardData(
      { ...SILVER_SPRINGS_CAPITAL_INPUTS, capitalReserveBalance: 6_500_000 }, // ~16.2 % of assets
      EQ_LABELS,
    );
    expect(lifted.rows.find((r) => r.key === "capital-reserve-pct")!.status).toBe("on-track");
  });

  it("Net Capital > Depreciation flips actual + status when depreciation exceeds net capital", () => {
    const flipped: CapitalScorecardInputs = {
      ...SILVER_SPRINGS_CAPITAL_INPUTS,
      netCapital: 3_000_000,
      depreciation: 5_000_000,
    };
    const card = buildCapitalScorecardData(flipped, EQ_LABELS);
    const row = card.rows.find((r) => r.key === "net-capital-vs-depreciation")!;
    expect(row.actual).toBe("NO");
    expect(row.status).toBe("action");
  });
});

describe("Scorecard generator typography", () => {
  it("variance strings use the U+2212 minus sign, not ASCII hyphen", () => {
    const inputs: OperatingScorecardInputs = {
      ...SILVER_SPRINGS_OPERATING_INPUTS,
      fbCoversActual: 100,
      fbCoversBudget: 500,
    };
    const card = buildOperatingScorecardData(inputs, OPS_LABELS);
    const row = card.rows.find((r) => r.key === "fb-covers-vs-budget")!;
    expect(row.benchmark).toContain("−"); // U+2212
    expect(row.benchmark).not.toContain("-400");
    expect(row.benchmark).toBe("−400");
  });

  it("never produces a hardcoded 'pillar' reference", () => {
    const opCard = buildOperatingScorecardData(SILVER_SPRINGS_OPERATING_INPUTS, OPS_LABELS);
    const capCard = buildCapitalScorecardData(SILVER_SPRINGS_CAPITAL_INPUTS, EQ_LABELS);
    for (const card of [opCard, capCard]) {
      for (const row of card.rows) {
        const text = `${row.metric}\n${row.description}\n${row.actual}\n${row.budget}\n${row.benchmark}`;
        expect(text.toLowerCase()).not.toContain("pillar");
      }
    }
  });
});

// Capital Fund Statement service tests — shape + reactive stress
// test + period sensitivity. Per CLAUDE.md the React surface
// renders only; this suite proves the service owns all numerics,
// tone classification, and stress-test commentary.

import { describe, it, expect } from "vitest";

import {
  buildSilverSpringsCapitalFundStatement,
  buildCapitalStressTestCommentary,
  type CapitalStressTestInputs,
} from "@/lib/reporting/capital-fund-statement";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
const SILVER_SPRINGS = "Silver Springs Golf & Country Club";

const STRESS_BASE: CapitalStressTestInputs = {
  initiationFeesAnnual: 2_160_000,
  capitalDuesAnnual:    1_920_000,
  initiationFeeDeclinePct: 0.50,
  requiredAnnualReserveContribution: 480_000,
  annualDebtService:    216_000,
};

describe("buildCapitalStressTestCommentary — reactive stress narrative", () => {
  it("names the decline %, the resulting income decrease, and the dues coverage check", () => {
    const out = buildCapitalStressTestCommentary(STRESS_BASE);
    // Eyebrow encodes the stress scenario.
    expect(out.eyebrow).toBe("Capital Stress Test — 50% Initiation Fee Decline");
    // Body quotes the magnitude of the projected income decrease.
    // 50% of $2.16M = $1.08M
    expect(out.body).toMatch(/decrease by approximately \$1\.08M/);
    // Body quotes the current capital dues figure.
    expect(out.body).toMatch(/capital dues levels of \$1\.92M/);
    // Pass branch — dues cover the combined reserve + debt obligation.
    expect(out.body).toMatch(/club passes this stress test/);
    expect(out.body).toMatch(/structurally funded capital model/);
  });

  it("FAILS the stress test when dues fall below the combined reserve + debt obligation", () => {
    const out = buildCapitalStressTestCommentary({
      ...STRESS_BASE,
      capitalDuesAnnual: 500_000, // below $480K reserve + $216K debt = $696K
    });
    expect(out.body).toMatch(/structural shortfall/);
    expect(out.body).not.toMatch(/passes this stress test/);
    // Combined obligation should be quoted in the body.
    expect(out.body).toMatch(/\$696,000/);
  });

  it("reacts to a different decline % input", () => {
    const out = buildCapitalStressTestCommentary({ ...STRESS_BASE, initiationFeeDeclinePct: 0.30 });
    expect(out.eyebrow).toBe("Capital Stress Test — 30% Initiation Fee Decline");
    // 30% of $2.16M = $648K → $0.65M
    expect(out.body).toMatch(/decrease by approximately \$0\.65M/);
  });
});

describe("buildSilverSpringsCapitalFundStatement — service contract", () => {
  it("ships the full Saguaro header chrome — period flows from ReportingPeriod (NO hardcoded Q1/March)", () => {
    const cf = buildSilverSpringsCapitalFundStatement({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(cf.eyebrow).toBe("Silver Springs Golf & Country Club · Capital Fund");
    expect(cf.title).toBe("Capital Fund Statement");
    expect(cf.periodLabel).toBe("May 2026 · For the period ended May 31, 2026 · Year to Date");
    expect(cf.periodLabel).not.toMatch(/Q1/);
    expect(cf.periodLabel).not.toMatch(/March/);
    expect(cf.statementNumber).toBe("Statement 05 of 14");
    expect(cf.documentChip).toBe("Capital Fund");
    expect(cf.preparedFor).toBe("Finance Committee");
    expect(cf.introNote).toMatch(/Where capital comes from/);
  });

  it("annual-budget column header is derived from period.year (May 2026 → '2026 Budget')", () => {
    const cf = buildSilverSpringsCapitalFundStatement({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(cf.columnHeaders.annualBudget).toBe("2026 Budget");
    expect(cf.columnHeaders.ytdActual).toBe("YTD Actual");
    expect(cf.columnHeaders.remaining).toBe("Remaining");
  });

  it("REGRESSION: column header flips when the reporting period changes to a different year", () => {
    const DEC_2027 = buildReportingPeriod(new Date(Date.UTC(2027, 11, 31)));
    const cf = buildSilverSpringsCapitalFundStatement({ clubName: SILVER_SPRINGS, period: DEC_2027 });
    expect(cf.columnHeaders.annualBudget).toBe("2027 Budget");
    expect(cf.periodLabel).toBe("December 2027 · For the period ended December 31, 2027 · Year to Date");
  });

  it("ships every section the founder named (Sources / Deployed / Summary / Analysis)", () => {
    const cf = buildSilverSpringsCapitalFundStatement({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const kinds = cf.rows.map((r) => `${r.kind}:${r.key}`);
    expect(kinds).toContain("section-band:band-sources");
    expect(kinds).toContain("subtotal:total-sources");
    expect(kinds).toContain("section-band:band-deployed");
    expect(kinds).toContain("subtotal:total-deployed");
    expect(kinds).toContain("summary-band:net-position");
    expect(kinds).toContain("analysis-band:band-analysis");
    expect(kinds).toContain("net-line:analysis-net-income");
  });

  it("seeds the Saguaro reference numerics verbatim (Sources, Deployed, Net Position)", () => {
    const cf = buildSilverSpringsCapitalFundStatement({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const dues = cf.rows.find((r) => r.key === "capital-dues")!.values!;
    expect(dues.annualBudget).toBe(1_920_000);
    expect(dues.ytdActual).toBe(480_000);
    expect(dues.remaining).toBe(1_440_000);

    const initiation = cf.rows.find((r) => r.key === "initiation-fees")!.values!;
    expect(initiation.annualBudget).toBe(2_160_000);

    const totalSources = cf.rows.find((r) => r.key === "total-sources")!.values!;
    expect(totalSources.annualBudget).toBe(4_255_000);
    expect(totalSources.ytdActual).toBe(1_006_200);
    expect(totalSources.remaining).toBe(3_248_800);

    const totalDeployed = cf.rows.find((r) => r.key === "total-deployed")!.values!;
    expect(totalDeployed.annualBudget).toBe(2_856_000);
    expect(totalDeployed.ytdActual).toBe(674_000);

    const netPosition = cf.rows.find((r) => r.key === "net-position")!.values!;
    expect(netPosition.annualBudget).toBe(1_399_000);
    expect(netPosition.ytdActual).toBe(332_200);

    const netIncome = cf.rows.find((r) => r.key === "analysis-net-income")!.values!;
    expect(netIncome.annualBudget).toBe(4_039_000);
    expect(netIncome.ytdActual).toBe(952_200);
  });

  it("Transfer from Operations seeds null values — renders as em-dash at the surface", () => {
    const cf = buildSilverSpringsCapitalFundStatement({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const transfer = cf.rows.find((r) => r.key === "transfer-from-ops")!.values!;
    expect(transfer.annualBudget).toBeNull();
    expect(transfer.ytdActual).toBeNull();
    expect(transfer.remaining).toBeNull();
  });

  it("Less: Debt Service seeds negative values — renders in parens at the surface", () => {
    const cf = buildSilverSpringsCapitalFundStatement({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const less = cf.rows.find((r) => r.key === "analysis-less-debt")!.values!;
    expect(less.annualBudget).toBe(-216_000);
    expect(less.ytdActual).toBe(-54_000);
  });

  it("reserve coverage card: current pct + label + markers", () => {
    const cf = buildSilverSpringsCapitalFundStatement({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(cf.reserveCoverage.currentPct).toBeCloseTo(0.61, 2);
    expect(cf.reserveCoverage.currentPctLabel).toBe("61%");
    expect(cf.reserveCoverage.facBenchmarkLabel).toMatch(/60%\+/);
    expect(cf.reserveCoverage.threeYearGoalLabel).toMatch(/75%/);
    expect(cf.reserveCoverage.reserveBalanceLabel).toMatch(/\$4\.82M/);
    expect(cf.reserveCoverage.markers).toHaveLength(5);
    expect(cf.reserveCoverage.markers[2].label).toMatch(/60% ← target/);
  });

  it("reserve adequacy detail: every founder-named row with correct tone classification", () => {
    const cf = buildSilverSpringsCapitalFundStatement({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const tones = Object.fromEntries(cf.reserveAdequacy.map((r) => [r.key, r.tone]));
    expect(tones["reserve-balance"]).toBe("neutral");
    expect(tones["asset-replacement-cost"]).toBe("neutral");
    expect(tones["coverage-ratio"]).toBe("neutral");
    // Deferred capital + Net-to-Gross PP&E are risk signals — rust/red.
    expect(tones["deferred-capital"]).toBe("risk");
    expect(tones["net-to-gross-ppe"]).toBe("risk");
    expect(tones["annual-contribution"]).toBe("neutral");
    // YTD Contribution on plan → favorable + checkmark.
    expect(tones["ytd-contribution"]).toBe("favorable");
    const ytd = cf.reserveAdequacy.find((r) => r.key === "ytd-contribution")!;
    expect(ytd.checkmark).toBe(true);
  });

  it("stress test is REACTIVE — eyebrow + body flow from buildCapitalStressTestCommentary", () => {
    const cf = buildSilverSpringsCapitalFundStatement({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(cf.stressTest.eyebrow).toBe("Capital Stress Test — 50% Initiation Fee Decline");
    expect(cf.stressTest.body).toMatch(/passes this stress test/);
    expect(cf.stressTest.body).toMatch(/structurally funded capital model/);
  });

  it("inline commentary rows: initiation fees commentary present", () => {
    const cf = buildSilverSpringsCapitalFundStatement({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const comm = cf.rows.find((r) => r.key === "initiation-fees-comment");
    expect(comm?.kind).toBe("commentary");
    expect(comm?.text).toMatch(/7 memberships Q1/);
  });
});

// Food & Beverage Statistics service tests — shape + reactive
// chart data + period sensitivity.

import { describe, it, expect } from "vitest";

import { buildSilverSpringsFoodBeverageStatistics } from "@/lib/reporting/food-beverage-statistics";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
const MAR_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 2, 31)));
const SILVER_SPRINGS = "Silver Springs Golf & Country Club";

describe("buildSilverSpringsFoodBeverageStatistics — service contract", () => {
  it("ships the Saguaro header chrome — period derived from ReportingPeriod (no Q1/March hardcodes for May)", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(fbs.eyebrow).toBe("Silver Springs Golf & Country Club · F&B Performance");
    expect(fbs.title).toBe("Food & Beverage Statistics");
    expect(fbs.periodLabel).toMatch(/May 2026/);
    expect(fbs.periodLabel).not.toMatch(/\bQ1\b/);
    expect(fbs.periodLabel).not.toMatch(/\bMarch\b/);
    expect(fbs.statementNumber).toBe("Statement 13 of 14");
    expect(fbs.documentChip).toBe("F&B Performance");
    expect(fbs.preparedFor).toBe("F&B Committee Level");
    expect(fbs.introNote).toMatch(/Revenue, cost, cover counts, and margin analysis/);
  });

  it("4 KPI cards in canonical order with correct treatments", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(fbs.kpiCards).toHaveLength(4);
    expect(fbs.kpiCards.map((k) => k.key)).toEqual([
      "total-revenue", "cost-pct", "total-covers", "gross-margin",
    ]);
    expect(fbs.kpiCards[0].treatment).toBe("primary");
    // Cost % (37.8% on the seed) is BELOW the 38.4% budget target →
    // favorable, not watch.
    expect(fbs.kpiCards[1].treatment).toBe("favorable");
    expect(fbs.kpiCards[2].treatment).toBe("neutral");
    expect(fbs.kpiCards[3].treatment).toBe("favorable");
  });

  it("KPI 1 (Total Revenue) renders YTD millions (Jan–May 5-month seed sums to $2.486M)", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const rev = fbs.kpiCards.find((k) => k.key === "total-revenue")!;
    expect(rev.valueLabel).toBe("$2.486M");
    expect(rev.label).toBe("Total F&B Revenue YTD");
    expect(rev.subLabel).toMatch(/vs\. budget/);
    expect(rev.subLabel).toMatch(/vs\. prior year YTD/);
  });

  it("KPI 2 (Cost %) renders one decimal + budget + prior year benchmarks", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const cost = fbs.kpiCards.find((k) => k.key === "cost-pct")!;
    expect(cost.valueLabel).toMatch(/^\d{2}\.\d%$/);
    expect(cost.label).toBe("F&B Cost % YTD");
    expect(cost.subLabel).toMatch(/Budget 38\.4%/);
    expect(cost.subLabel).toMatch(/Prior year 38\.7%/);
  });

  it("KPI 3 (Total Covers) renders integer + budget delta + avg check per cover", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const covers = fbs.kpiCards.find((k) => k.key === "total-covers")!;
    // Seed: 5,100 + 5,500 + 6,700 + 7,100 + 7,400 = 31,800 covers.
    expect(covers.valueLabel).toBe("31,800");
    expect(covers.label).toBe("Total Covers YTD");
    expect(covers.subLabel).toMatch(/vs\. budget/);
    expect(covers.subLabel).toMatch(/Avg \$\d+\.\d{2} per cover/);
  });

  it("KPI 4 (Gross Margin) renders thousands + margin % verdict", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const margin = fbs.kpiCards.find((k) => k.key === "gross-margin")!;
    // Revenue 2,486K − cost 940K = 1,546K → "$1,546K".
    expect(margin.valueLabel).toBe("$1,546K");
    expect(margin.label).toBe("F&B Gross Margin YTD");
    expect(margin.subLabel).toMatch(/^\d{2}\.\d% margin/);
  });

  it("Monthly chart datasets are sliced to the YTD window — May 2026 → 5 monthly entries Jan…May", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(fbs.charts.monthlyRevenueCost).toHaveLength(5);
    expect(fbs.charts.monthlyRevenueCost.map((m) => m.monthLabel)).toEqual([
      "January", "February", "March", "April", "May",
    ]);
    expect(fbs.charts.monthlyCoverCounts).toHaveLength(5);
    expect(fbs.charts.foodCostTrend.points).toHaveLength(5);
  });

  it("Donut shares (5 categories) sum to 1.0 and amounts reflect the YTD revenue total", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(fbs.charts.revenueByCategory).toHaveLength(5);
    expect(fbs.charts.revenueByCategory.map((s) => s.key)).toEqual([
      "food", "wine", "liquor", "beer", "other",
    ]);
    const totalShare = fbs.charts.revenueByCategory.reduce((s, x) => s + x.share, 0);
    expect(totalShare).toBeCloseTo(1, 5);
    // Brand-palette fills (no chart-library defaults).
    for (const s of fbs.charts.revenueByCategory) {
      expect(s.fillHex).toMatch(/^#[0-9a-f]{6}$/i);
    }
    // Sum of slice amounts equals YTD revenue (rounded).
    const sumAmounts = fbs.charts.revenueByCategory.reduce((s, x) => s + x.amount, 0);
    expect(sumAmounts).toBeCloseTo(2_486_000, -3);
  });

  it("Food cost trend points carry the budget target line (38.4%) + monthly cost % from the seed", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(fbs.charts.foodCostTrend.budgetTargetPct).toBe(38.4);
    const jan = fbs.charts.foodCostTrend.points.find((p) => p.monthLabel === "January")!;
    // 153 / 380 = 40.26…%
    expect(jan.costPct).toBeGreaterThan(40);
    expect(jan.costPct).toBeLessThan(41);
  });

  it("Chart subtitles are period-aware (no hardcoded Q1, no January–March)", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(fbs.charts.subtitles.monthlyRevenueCost).toBe("January – May 2026");
    expect(fbs.charts.subtitles.revenueByCategory).toBe("Food · Wine · Liquor · Beer · YTD 2026");
    expect(fbs.charts.subtitles.monthlyCoverCounts).toBe("YTD 2026 vs. Budget vs. Prior Year YTD");
    expect(fbs.charts.subtitles.foodCostTrend).toBe("YTD vs. 38.4% Budget Target");
    // No stale period leak.
    for (const v of Object.values(fbs.charts.subtitles)) {
      expect(v).not.toMatch(/\bQ1\b/);
      expect(v).not.toMatch(/January – March/);
    }
  });

  it("Cover counts callout names the strongest month + the prior-year avg-check delta", () => {
    // Founder rule 2026-07-05 v15.10 — callouts consolidated
    // into `charts.callouts.{monthlyRevenueCost | revenueByCategory
    // | monthlyCoverCounts | foodCostTrend}` so every chart in
    // the grid carries one executive commentary.
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const c = fbs.charts.callouts.monthlyCoverCounts.text;
    expect(c).toMatch(/cover surge/);
    expect(c).toMatch(/Average check/);
    expect(c).toMatch(/spring tournament week/);
  });

  it("Food cost callout names the worst + best months + the next-quarter follow-up date", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const c = fbs.charts.callouts.foodCostTrend.text;
    expect(c).toMatch(/cost % elevated at/);
    expect(c).toMatch(/improved to/);
    expect(c).toMatch(/Purchasing controls and portioning review/);
    // Next-quarter follow-up label is period-derived. For May 2026
    // (Q2) → next quarter is Q3 2026.
    expect(c).toMatch(/Q3 2026/);
  });

  it("no reference-attribution footer text (Saguaro / Financially Astute / hypothetical)", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const surface = JSON.stringify(fbs);
    expect(surface).not.toMatch(/Saguaro/i);
    expect(surface).not.toMatch(/Financially Astute/i);
    expect(surface).not.toMatch(/Hypothetical Illustration/i);
    expect(surface).not.toMatch(/financiallyastuteclubs/);
  });

  // ---- Secondary KPI row (aligned column-for-column to primary). ----

  it("Secondary KPI row — 4 cards in the documented column order (Revenue/Server, Member Sat, Avg Check, Monthly Gratuities)", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(fbs.secondaryKpiCards).toHaveLength(4);
    expect(fbs.secondaryKpiCards.map((k) => k.key)).toEqual([
      "revenue-per-server",
      "member-satisfaction",
      "average-check",
      "monthly-gratuities",
    ]);
  });

  it("Secondary row aligns column-for-column with primary (Avg Check sits beneath Total Covers)", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    // Both rows are 4 cards each; same index column-aligns visually.
    expect(fbs.kpiCards).toHaveLength(4);
    expect(fbs.secondaryKpiCards).toHaveLength(4);
    expect(fbs.kpiCards[0].key).toBe("total-revenue");
    expect(fbs.secondaryKpiCards[0].key).toBe("revenue-per-server");
    expect(fbs.kpiCards[1].key).toBe("cost-pct");
    expect(fbs.secondaryKpiCards[1].key).toBe("member-satisfaction");
    // Average Check is column-aligned to Total Covers.
    expect(fbs.kpiCards[2].key).toBe("total-covers");
    expect(fbs.secondaryKpiCards[2].key).toBe("average-check");
    expect(fbs.kpiCards[3].key).toBe("gross-margin");
    expect(fbs.secondaryKpiCards[3].key).toBe("monthly-gratuities");
  });

  it("Revenue per Server is service-derived (Revenue YTD ÷ avg server FTEs) and tracks the primary revenue figure", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const rps = fbs.secondaryKpiCards.find((c) => c.key === "revenue-per-server")!;
    // Seeded avg server FTEs = 6.4. May YTD revenue = $2.486M.
    // 2,486,000 / 6.4 = 388,437.5 → "$388K".
    expect(rps.valueLabel).toBe("$388K");
    expect(rps.label).toBe("Revenue per Server");
    expect(rps.subLabel).toMatch(/vs\. prior year/);
    expect(rps.subLabel).toMatch(/vs\. budget/);
    // March 2026 → smaller YTD revenue → smaller Revenue per Server.
    const fbsMar = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAR_2026 });
    const rpsMar = fbsMar.secondaryKpiCards.find((c) => c.key === "revenue-per-server")!;
    expect(rpsMar.valueLabel).not.toBe(rps.valueLabel);
  });

  it("Member Satisfaction renders the rolling 90-day score + the target benchmark", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const sat = fbs.secondaryKpiCards.find((c) => c.key === "member-satisfaction")!;
    expect(sat.valueLabel).toMatch(/^\d{2}%$/);
    expect(sat.label).toBe("Member Satisfaction");
    expect(sat.subLabel).toMatch(/pts vs\. prior period/);
    expect(sat.subLabel).toMatch(/Target ≥ 85%/);
  });

  it("Average Check on the secondary row matches the per-cover figure carried on the primary Covers card", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const ac = fbs.secondaryKpiCards.find((c) => c.key === "average-check")!;
    const covers = fbs.kpiCards.find((c) => c.key === "total-covers")!;
    expect(ac.label).toBe("Average Check");
    // Both surfaces quote the YTD avg check; the value formats as
    // currency with cents and matches what the Covers sub-line shows.
    expect(ac.valueLabel).toMatch(/^\$\d+\.\d{2}$/);
    expect(covers.subLabel).toContain(ac.valueLabel);
    expect(ac.subLabel).toMatch(/vs\. prior year/);
    expect(ac.subLabel).toMatch(/vs\. budget/);
  });

  it("Monthly Gratuities pulls from the LATEST month only (period-aware, not YTD)", () => {
    const fbsMay = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const gMay = fbsMay.secondaryKpiCards.find((c) => c.key === "monthly-gratuities")!;
    // May revenue = $616K. 17.5% gratuity rate → $107.8K → "$108K".
    expect(gMay.valueLabel).toBe("$108K");
    expect(gMay.label).toBe("Monthly Gratuities");
    expect(gMay.subLabel).toMatch(/vs\. prior year/);
    expect(gMay.subLabel).toMatch(/avg per cover/);

    // March 2026 → uses March's revenue ($510K) not May's. The label
    // must therefore differ.
    const fbsMar = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAR_2026 });
    const gMar = fbsMar.secondaryKpiCards.find((c) => c.key === "monthly-gratuities")!;
    expect(gMar.valueLabel).not.toBe(gMay.valueLabel);
  });

  it("Secondary KPI sub-lines never leak hardcoded period labels (Q1 / March in May report)", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    for (const card of fbs.secondaryKpiCards) {
      expect(card.subLabel ?? "").not.toMatch(/\bQ1\b/);
      expect(card.subLabel ?? "").not.toMatch(/\bMarch\b/);
    }
  });

  it("REGRESSION: March 2026 period slices the monthly arrays to 3 entries", () => {
    const fbs = buildSilverSpringsFoodBeverageStatistics({ clubName: SILVER_SPRINGS, period: MAR_2026 });
    expect(fbs.charts.monthlyRevenueCost).toHaveLength(3);
    expect(fbs.charts.monthlyRevenueCost.map((m) => m.monthLabel)).toEqual([
      "January", "February", "March",
    ]);
    expect(fbs.charts.subtitles.monthlyRevenueCost).toBe("January – March 2026");
    // YTD revenue collapses to the 3-month total: 380K + 425K + 510K = $1.315M.
    expect(fbs.kpiCards.find((k) => k.key === "total-revenue")!.valueLabel).toBe("$1.315M");
    // Food cost callout follow-up date flows to Q2 2026 (March's next
    // quarter), NOT Q3.
    expect(fbs.charts.callouts.foodCostTrend.text).toMatch(/Q2 2026/);
  });
});

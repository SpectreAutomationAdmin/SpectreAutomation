// Inventory Analysis service tests — shape + reactive callouts +
// period sensitivity.

import { describe, it, expect } from "vitest";

import { buildSilverSpringsInventoryAnalysis } from "@/lib/reporting/inventory-analysis";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
const MAR_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 2, 31)));
const DEC_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 11, 31)));
const SILVER_SPRINGS = "Silver Springs Golf & Country Club";

describe("buildSilverSpringsInventoryAnalysis — service contract", () => {
  it("ships the Saguaro header chrome — period derived from ReportingPeriod (no Q1/March hardcodes for May)", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(inv.eyebrow).toBe("Silver Springs Golf & Country Club · Inventory & Purchasing");
    expect(inv.title).toBe("Inventory Analysis");
    expect(inv.periodLabel).toMatch(/May 2026/);
    expect(inv.periodLabel).not.toMatch(/\bQ1\b/);
    expect(inv.periodLabel).not.toMatch(/\bMarch\b/);
    expect(inv.statementNumber).toBe("Statement 14 of 14");
    expect(inv.documentChip).toBe("Inventory & Purchasing");
    expect(inv.preparedFor).toBe("F&B Committee Level");
    expect(inv.introNote).toMatch(/Inventory turnover ratios/);
  });

  it("4 KPI cards in canonical order with correct treatments", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(inv.kpiCards).toHaveLength(4);
    expect(inv.kpiCards.map((k) => k.key)).toEqual([
      "food-turns", "liquor-turns", "soft-goods-turns", "avg-food-balance",
    ]);
    expect(inv.kpiCards[0].treatment).toBe("primary");
    // Liquor turns 2.2x vs 2.8x → declining → watch.
    expect(inv.kpiCards[1].treatment).toBe("watch");
    // Soft goods 2.5x vs 2.1x → improving → favorable.
    expect(inv.kpiCards[2].treatment).toBe("favorable");
    expect(inv.kpiCards[3].treatment).toBe("neutral");
  });

  it("KPI 1 (Food Inventory Turns) renders '11.4x' with the 'improving' sub-line", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const food = inv.kpiCards.find((k) => k.key === "food-turns")!;
    expect(food.valueLabel).toBe("11.4x");
    expect(food.label).toBe("Food Inventory Turns");
    expect(food.subLabel).toMatch(/vs\. 10\.4x prior year/);
    expect(food.subLabel).toMatch(/improving/);
  });

  it("KPI 2 (Liquor Inventory Turns) renders the 'Declining' sub-line + review SKUs", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const liquor = inv.kpiCards.find((k) => k.key === "liquor-turns")!;
    expect(liquor.valueLabel).toBe("2.2x");
    expect(liquor.label).toBe("Liquor Inventory Turns");
    expect(liquor.subLabel).toMatch(/Declining vs\. 2\.8x/);
    expect(liquor.subLabel).toMatch(/review SKUs/);
  });

  it("KPI 3 (Pro Shop Soft Goods) renders 'strong improvement' when ratio gap is >= 0.3", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const softGoods = inv.kpiCards.find((k) => k.key === "soft-goods-turns")!;
    expect(softGoods.valueLabel).toBe("2.5x");
    expect(softGoods.label).toBe("Pro Shop Soft Goods Turns");
    expect(softGoods.subLabel).toMatch(/strong improvement/);
  });

  it("KPI 4 (Avg Food Inventory Balance) renders the YTD average + latest-month context", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const balance = inv.kpiCards.find((k) => k.key === "avg-food-balance")!;
    // Seed Jan-May food balances: 44.2 + 45.5 + 52.4 + 48.1 + 46.9 = 237.1 / 5 = 47.4
    expect(balance.valueLabel).toBe("$47.4K");
    expect(balance.label).toBe("Avg Food Inventory Balance");
    expect(balance.subLabel).toMatch(/May ending \$46\.9K/);
  });

  it("Turnover by category — 6 categories with Saguaro reference values", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(inv.charts.turnoverByCategory).toHaveLength(6);
    expect(inv.charts.turnoverByCategory.map((t) => t.key)).toEqual([
      "food", "wine", "beer", "liquor", "soft-goods", "hard-goods",
    ]);
    const food = inv.charts.turnoverByCategory.find((t) => t.key === "food")!;
    expect(food.currentYear).toBe(11.4);
    expect(food.priorYear).toBe(10.4);
    const liquor = inv.charts.turnoverByCategory.find((t) => t.key === "liquor")!;
    expect(liquor.currentYear).toBe(2.2);
    expect(liquor.priorYear).toBe(2.8);
  });

  it("Monthly balances are sliced to the YTD window — May 2026 → 5 monthly entries Jan…May", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(inv.charts.monthlyBalances).toHaveLength(5);
    expect(inv.charts.monthlyBalances.map((m) => m.monthLabel)).toEqual([
      "January", "February", "March", "April", "May",
    ]);
    const jan = inv.charts.monthlyBalances[0];
    expect(jan.foodBalance).toBe(44_200);
    expect(jan.wineBalance).toBe(45_100);
    expect(jan.liquorBalance).toBe(28_400);
  });

  it("Chart subtitles are period-aware (no hardcoded Q1, no January–March)", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(inv.charts.titles.turnoverByCategory.subtitle).toBe("YTD 2026 vs. Prior Year Comparison");
    expect(inv.charts.titles.monthlyBalances.subtitle).toBe(
      "Food · Wine · Liquor · Average Balance by Month · January – May 2026",
    );
    for (const t of Object.values(inv.charts.titles)) {
      expect(t.subtitle).not.toMatch(/\bQ1\b/);
      expect(t.subtitle).not.toMatch(/January – March/);
    }
  });

  it("Turnover callout names food / wine / liquor / soft goods / beer with the right directional verbs", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const c = inv.charts.callouts.turnoverByCategory.text;
    expect(c).toMatch(/Food turns improving/);
    expect(c).toMatch(/declining/);
    expect(c).toMatch(/Pro shop soft goods/);
    expect(c).toMatch(/Beer volume/);
  });

  it("v15.11 — every chart has a chipLabel + a non-trivial callout entry", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(inv.charts.chipLabels.turnoverByCategory.length).toBeGreaterThan(0);
    expect(inv.charts.chipLabels.monthlyBalances.length).toBeGreaterThan(0);
    expect(inv.charts.callouts.turnoverByCategory.text.length).toBeGreaterThan(80);
    expect(inv.charts.callouts.monthlyBalances.text.length).toBeGreaterThan(80);
  });

  it("v15.11 — Balances callout summarises YTD averages + directional movement across food / wine / liquor", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const b = inv.charts.callouts.monthlyBalances.text;
    // Every series named + at least one directional verb.
    expect(b).toMatch(/food/i);
    expect(b).toMatch(/wine/i);
    expect(b).toMatch(/liquor/i);
    expect(b).toMatch(/built up|drew down|held flat/);
    // Reactivity: the balances callout re-reads the seed rather than
    // pinning a hardcoded May-specific dollar figure.
    expect(b).toMatch(/\$\d+(\.\d+)?K/);
  });

  it("Action table — 5 rows with the documented priorities (action / watch / positive)", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    expect(inv.actionTable.rows).toHaveLength(5);
    expect(inv.actionTable.rows.map((r) => r.priority)).toEqual([
      "action", "action", "watch", "positive", "positive",
    ]);
    expect(inv.actionTable.rows.map((r) => r.category)).toEqual([
      "Liquor", "Food Cost", "Beer", "Soft Goods", "Food Turns",
    ]);
  });

  it("Action timelines are period-derived — May 2026 → next quarter Q3 2026 + next month June 2026", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const liquorAction = inv.actionTable.rows.find((r) => r.key === "liquor-slow-skus")!;
    expect(liquorAction.timeline).toBe("Q3 2026");
    const foodCostAction = inv.actionTable.rows.find((r) => r.key === "food-cost-audit")!;
    expect(foodCostAction.timeline).toBe("June 2026");
    const foodTurnsRow = inv.actionTable.rows.find((r) => r.key === "food-turns-positive")!;
    expect(foodTurnsRow.timeline).toBe("June 2026");
    const softGoodsRow = inv.actionTable.rows.find((r) => r.key === "soft-goods-strong")!;
    expect(softGoodsRow.timeline).toBe("Ongoing");
  });

  it("no reference-attribution footer text (Saguaro / Financially Astute / hypothetical)", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAY_2026 });
    const surface = JSON.stringify(inv);
    expect(surface).not.toMatch(/Saguaro/i);
    expect(surface).not.toMatch(/Financially Astute/i);
    expect(surface).not.toMatch(/Hypothetical Illustration/i);
    expect(surface).not.toMatch(/financiallyastuteclubs/);
  });

  it("REGRESSION: March 2026 period slices to 3 months + action timelines flow to Q2 2026 / April 2026", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: MAR_2026 });
    expect(inv.charts.monthlyBalances).toHaveLength(3);
    expect(inv.charts.titles.monthlyBalances.subtitle).toMatch(/January – March 2026/);
    const liquorAction = inv.actionTable.rows.find((r) => r.key === "liquor-slow-skus")!;
    expect(liquorAction.timeline).toBe("Q2 2026");
    const foodCostAction = inv.actionTable.rows.find((r) => r.key === "food-cost-audit")!;
    expect(foodCostAction.timeline).toBe("April 2026");
  });

  it("REGRESSION: December 2026 → next-month wraps to January 2027 (no year-boundary failure)", () => {
    const inv = buildSilverSpringsInventoryAnalysis({ clubName: SILVER_SPRINGS, period: DEC_2026 });
    const foodCostAction = inv.actionTable.rows.find((r) => r.key === "food-cost-audit")!;
    expect(foodCostAction.timeline).toBe("January 2027");
    const liquorAction = inv.actionTable.rows.find((r) => r.key === "liquor-slow-skus")!;
    // Dec → next quarter is Q1 of the following year.
    expect(liquorAction.timeline).toBe("Q1 2027");
  });
});

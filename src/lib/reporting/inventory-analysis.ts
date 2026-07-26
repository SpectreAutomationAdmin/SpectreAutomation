// Inventory Analysis service — chapter XIV (Operations & Analytics
// group). Owns 4 KPI cards + 2 chart datasets (Inventory Turnover by
// Category grouped bars, F&B Inventory Balances monthly multi-line)
// + a turnover commentary callout + an Inventory Management Flags &
// Action Items table.
//
// All period labels flow from `ReportingPeriod` per the Reporting
// Period Golden Rule. The seeded monthly arrays carry 12 entries
// (Jan–Dec) and the service slices to `period.month` so a May 2026
// report shows 5 monthly points, a March report shows 3, and so on.

import type { ReportingDataSource } from "@/lib/reporting/monthly-package";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";

// =============================================================================
// Public types
// =============================================================================

export type InventoryKpiTreatment = "primary" | "favorable" | "neutral" | "watch";
export type InventoryActionPriority = "action" | "watch" | "positive";

export type InventoryKpiCard = {
  key: string;
  /** Pre-formatted hero value (e.g. "11.4x", "$46.1K"). */
  valueLabel: string;
  /** Uppercase label below the value (e.g. "Food Inventory Turns"). */
  label: string;
  /** Optional sub-line below the label. */
  subLabel?: string;
  treatment: InventoryKpiTreatment;
};

export type InventoryTurnoverDatum = {
  key: string;
  label: string;
  /** Current-period turnover ratio. */
  currentYear: number;
  /** Prior-period turnover ratio (same window). */
  priorYear: number;
};

export type MonthlyInventoryPoint = {
  monthLabel: string;
  monthNumber: number;
  /** Average inventory balance for each F&B category, in raw dollars. */
  foodBalance: number;
  wineBalance: number;
  liquorBalance: number;
};

export type InventoryActionRow = {
  key: string;
  priority: InventoryActionPriority;
  category: string;
  observation: string;
  actionRequired: string;
  /** Pre-formatted timeline (e.g. "Q3 2026", "April 2026", "Ongoing"). */
  timeline: string;
};

export type InventoryAnalysis = {
  dataSource: ReportingDataSource;
  // Header chrome — mirrors the other Saguaro chapters.
  eyebrow: string;
  title: string;
  periodLabel: string;
  introNote: string;
  statementNumber: string;
  documentChip: string;
  preparedFor: string;
  // 4 KPI cards.
  kpiCards: ReadonlyArray<InventoryKpiCard>;
  // Chart datasets — single source of truth for both chart cards.
  charts: {
    /** Inventory Turnover by Category grouped bars (current vs prior). */
    turnoverByCategory: ReadonlyArray<InventoryTurnoverDatum>;
    /** F&B Inventory Balances monthly multi-line series. Service
     *  slices to the YTD window based on `period.month`. */
    monthlyBalances: ReadonlyArray<MonthlyInventoryPoint>;
    /** Chart titles + subtitles (period-aware where applicable). */
    titles: {
      turnoverByCategory:  { title: string; subtitle: string };
      monthlyBalances:     { title: string; subtitle: string };
    };
    /** Founder rule 2026-07-05 v15.11 — chip labels for the
     *  dark-green editorial header's top-right gold pill, matching
     *  the Payroll Analysis (v15.8) + F&B Statistics (v15.10)
     *  chapters. */
    chipLabels: {
      turnoverByCategory: string;
      monthlyBalances:    string;
    };
    /** Founder rule 2026-07-05 v15.11 — one executive commentary
     *  per chart, generated dynamically from the report data. Every
     *  callout is rendered beneath its chart in the Stewardship-
     *  style green-wash panel. */
    callouts: {
      turnoverByCategory: { text: string };
      monthlyBalances:    { text: string };
    };
  };
  // Inventory management flags & action table.
  actionTable: {
    eyebrow: string;
    columnHeaders: {
      priority: string;
      category: string;
      observation: string;
      actionRequired: string;
      timeline: string;
    };
    rows: ReadonlyArray<InventoryActionRow>;
  };
};

// =============================================================================
// Seeded Silver Springs Inventory Analysis
// =============================================================================

/** Inventory turnover by category — current YTD vs prior YTD.
 *  Mirrors Saguaro reference values verbatim. */
const TURNOVER_BASELINE: ReadonlyArray<InventoryTurnoverDatum> = [
  { key: "food",       label: "Food",       currentYear: 11.4, priorYear: 10.4 },
  { key: "wine",       label: "Wine",       currentYear: 4.0,  priorYear: 3.5 },
  { key: "beer",       label: "Beer",       currentYear: 6.3,  priorYear: 4.5 },
  { key: "liquor",     label: "Liquor",     currentYear: 2.2,  priorYear: 2.8 },
  { key: "soft-goods", label: "Soft Goods", currentYear: 2.5,  priorYear: 2.1 },
  { key: "hard-goods", label: "Hard Goods", currentYear: 5.0,  priorYear: 2.5 },
];

/** 12-month F&B inventory balance baseline (avg balance per month). */
type MonthlyBalanceRow = {
  monthNumber: number;
  monthLabel: string;
  foodBalance: number;
  wineBalance: number;
  liquorBalance: number;
};

const MONTHLY_BALANCE_BASELINE: ReadonlyArray<MonthlyBalanceRow> = [
  { monthNumber: 1,  monthLabel: "January",   foodBalance: 44_200, wineBalance: 45_100, liquorBalance: 28_400 },
  { monthNumber: 2,  monthLabel: "February",  foodBalance: 45_500, wineBalance: 43_800, liquorBalance: 28_900 },
  { monthNumber: 3,  monthLabel: "March",     foodBalance: 52_400, wineBalance: 41_500, liquorBalance: 28_100 },
  { monthNumber: 4,  monthLabel: "April",     foodBalance: 48_100, wineBalance: 40_200, liquorBalance: 28_500 },
  { monthNumber: 5,  monthLabel: "May",       foodBalance: 46_900, wineBalance: 39_300, liquorBalance: 28_700 },
  { monthNumber: 6,  monthLabel: "June",      foodBalance: 47_200, wineBalance: 38_500, liquorBalance: 28_900 },
  { monthNumber: 7,  monthLabel: "July",      foodBalance: 49_500, wineBalance: 37_800, liquorBalance: 29_400 },
  { monthNumber: 8,  monthLabel: "August",    foodBalance: 49_800, wineBalance: 37_400, liquorBalance: 29_700 },
  { monthNumber: 9,  monthLabel: "September", foodBalance: 47_900, wineBalance: 37_100, liquorBalance: 29_200 },
  { monthNumber: 10, monthLabel: "October",   foodBalance: 46_300, wineBalance: 37_500, liquorBalance: 28_800 },
  { monthNumber: 11, monthLabel: "November",  foodBalance: 45_800, wineBalance: 38_000, liquorBalance: 28_500 },
  { monthNumber: 12, monthLabel: "December",  foodBalance: 47_400, wineBalance: 39_200, liquorBalance: 28_900 },
];

const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

// =============================================================================
// Formatters
// =============================================================================

function formatTurnover(value: number): string {
  return `${value.toFixed(1)}x`;
}

function formatThousandsOneDecimal(value: number): string {
  if (value === 0) return "—";
  return `$${(value / 1_000).toFixed(1)}K`;
}

// =============================================================================
// Builder
// =============================================================================

/**
 * Build the Inventory Analysis section. The service does ALL math:
 * YTD averages, KPI sub-lines, period-aware action timelines, callout
 * commentary. React renders pre-formatted strings.
 */
export function buildSilverSpringsInventoryAnalysis(opts: {
  clubName: string;
  period: ReportingPeriod;
}): InventoryAnalysis {
  const { period } = opts;
  const monthLong = period.monthLong;
  const monthsInScope = Math.max(1, Math.min(12, period.month));

  // ---- Slice the monthly baseline to the YTD window. ----
  const monthly = MONTHLY_BALANCE_BASELINE.slice(0, monthsInScope);

  // Average food inventory balance over the YTD window.
  const avgFoodBalance =
    monthly.reduce((s, m) => s + m.foodBalance, 0) / monthly.length;
  const latestMonth = monthly[monthly.length - 1];

  // Pull current-year turnover ratios.
  const food       = TURNOVER_BASELINE.find((t) => t.key === "food")!;
  const liquor     = TURNOVER_BASELINE.find((t) => t.key === "liquor")!;
  const softGoods  = TURNOVER_BASELINE.find((t) => t.key === "soft-goods")!;
  const wine       = TURNOVER_BASELINE.find((t) => t.key === "wine")!;
  const beer       = TURNOVER_BASELINE.find((t) => t.key === "beer")!;

  // ---- KPI cards. ----
  const kpiCards: ReadonlyArray<InventoryKpiCard> = [
    {
      key: "food-turns",
      treatment: "primary",
      valueLabel: formatTurnover(food.currentYear),
      label: "Food Inventory Turns",
      subLabel:
        `vs. ${formatTurnover(food.priorYear)} prior year — ` +
        (food.currentYear > food.priorYear ? "improving" : "monitor"),
    },
    {
      key: "liquor-turns",
      treatment: liquor.currentYear < liquor.priorYear ? "watch" : "favorable",
      valueLabel: formatTurnover(liquor.currentYear),
      label: "Liquor Inventory Turns",
      subLabel:
        (liquor.currentYear < liquor.priorYear ? "Declining vs. " : "Improving vs. ") +
        `${formatTurnover(liquor.priorYear)} two years ago — review SKUs`,
    },
    {
      key: "soft-goods-turns",
      treatment: softGoods.currentYear > softGoods.priorYear ? "favorable" : "watch",
      valueLabel: formatTurnover(softGoods.currentYear),
      label: "Pro Shop Soft Goods Turns",
      subLabel:
        `vs. ${formatTurnover(softGoods.priorYear)} prior year — ` +
        (softGoods.currentYear - softGoods.priorYear >= 0.3 ? "strong improvement" : "improving"),
    },
    {
      key: "avg-food-balance",
      treatment: "neutral",
      valueLabel: formatThousandsOneDecimal(avgFoodBalance),
      label: "Avg Food Inventory Balance",
      subLabel:
        `${latestMonth.monthLabel} ending ${formatThousandsOneDecimal(latestMonth.foodBalance)} — ` +
        (latestMonth.foodBalance > avgFoodBalance * 1.05 ? "slightly elevated" :
         latestMonth.foodBalance < avgFoodBalance * 0.95 ? "tracking lean" : "on plan"),
    },
  ];

  // ---- Chart datasets. ----
  const turnoverByCategory: ReadonlyArray<InventoryTurnoverDatum> = TURNOVER_BASELINE;
  const monthlyBalances: ReadonlyArray<MonthlyInventoryPoint> = monthly.map((m) => ({
    monthLabel: m.monthLabel,
    monthNumber: m.monthNumber,
    foodBalance: m.foodBalance,
    wineBalance: m.wineBalance,
    liquorBalance: m.liquorBalance,
  }));

  // Chart subtitles — period-aware.
  const monthlyRangeLabel =
    monthsInScope === 1
      ? `${monthLong} ${period.year}`
      : `January – ${monthLong} ${period.year}`;
  const titles = {
    turnoverByCategory: {
      title: "Inventory Turnover by Category",
      subtitle: `YTD ${period.year} vs. Prior Year Comparison`,
    },
    monthlyBalances: {
      title: "F&B Inventory Balances — Monthly",
      subtitle: `Food · Wine · Liquor · Average Balance by Month · ${monthlyRangeLabel}`,
    },
  };

  // Turnover commentary callout — generated from the observed ratios.
  const turnoverCallout = {
    text:
      `Food turns improving. Wine and liquor ` +
      `${liquor.currentYear < liquor.priorYear ? "declining" : "tracking"} — ` +
      `investigate slow-moving SKUs. Pro shop soft goods showing ` +
      `${softGoods.currentYear > softGoods.priorYear ? "best turns in three years" : "stable performance"}. ` +
      `Beer volume is ${beer.currentYear > 5 ? "strong" : "low"}; consider SKU rationalization.`,
  };

  // Founder rule 2026-07-05 v15.11 — reactive balances callout.
  // Summarises YTD averages per category, the largest month-over-
  // month swing across the three series, and a plain-English take
  // on whether inventory is building up, drawing down, or tracking
  // flat. Every value flows from the sliced `monthly` array so a
  // different period rolls new copy automatically.
  const avgFoodYtd   = monthly.reduce((s, m) => s + m.foodBalance,   0) / monthly.length;
  const avgWineYtd   = monthly.reduce((s, m) => s + m.wineBalance,   0) / monthly.length;
  const avgLiquorYtd = monthly.reduce((s, m) => s + m.liquorBalance, 0) / monthly.length;
  // Direction from FIRST-to-LATEST month of the window (a proxy for
  // "are we carrying more inventory than we started the year with?").
  const firstMonth = monthly[0];
  const foodDelta   = latestMonth.foodBalance   - firstMonth.foodBalance;
  const wineDelta   = latestMonth.wineBalance   - firstMonth.wineBalance;
  const liquorDelta = latestMonth.liquorBalance - firstMonth.liquorBalance;
  // Pick the LARGEST-magnitude swing across the three series so the
  // callout leads with the most Board-relevant movement.
  const swings: ReadonlyArray<{ label: string; delta: number }> = [
    { label: "food",   delta: foodDelta },
    { label: "wine",   delta: wineDelta },
    { label: "liquor", delta: liquorDelta },
  ];
  const biggestSwing = [...swings].sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta),
  )[0];
  const swingDirection =
    Math.abs(biggestSwing.delta) < 1_000
      ? "held flat"
      : biggestSwing.delta > 0
        ? "built up"
        : "drew down";
  const swingAmount = formatThousandsOneDecimal(Math.abs(biggestSwing.delta));
  const foodDirection =
    Math.abs(foodDelta) < 1_000 ? "flat"
      : foodDelta > 0 ? "elevated" : "leaner";
  const monthlyBalancesCallout = {
    text:
      `Average YTD balances — food ${formatThousandsOneDecimal(avgFoodYtd)}, ` +
      `wine ${formatThousandsOneDecimal(avgWineYtd)}, ` +
      `liquor ${formatThousandsOneDecimal(avgLiquorYtd)}. ` +
      `${biggestSwing.label[0].toUpperCase()}${biggestSwing.label.slice(1)} ` +
      `${swingDirection} ${swingAmount} from ${firstMonth.monthLabel} to ${latestMonth.monthLabel}. ` +
      `Food ${latestMonth.monthLabel} ending ${formatThousandsOneDecimal(latestMonth.foodBalance)} ` +
      `tracks ${foodDirection} vs. the YTD average — ` +
      (Math.abs(liquorDelta) > Math.abs(foodDelta) && liquor.currentYear < liquor.priorYear
        ? "liquor balances warrant a SKU review alongside declining turns."
        : "no unusual build-ups indicated across food, wine, or liquor."),
  };

  // Chip labels for the dark-green editorial header (one per chart).
  const chipLabels = {
    turnoverByCategory: "Inventory · Turnover",
    monthlyBalances:    "Inventory · Balances",
  };

  // ---- Action table — period-aware timelines + observations. ----
  // Find the next quarter + next month as period-derived references.
  const nextQuarterLabel = period.nextYearQuarterLabel;
  // Next month label (wraps Dec → January).
  const nextMonthIdx = period.month % 12; // 0..11 (0 means next is Jan)
  const nextMonthLabel = `${MONTH_LONG[nextMonthIdx]} ${nextMonthIdx === 0 ? period.year + 1 : period.year}`;

  const actionTable = {
    eyebrow: "Inventory Management Flags & Action Items",
    columnHeaders: {
      priority: "Priority",
      category: "Category",
      observation: "Observation",
      actionRequired: "Action Required",
      timeline: "Timeline",
    },
    rows: [
      {
        key: "liquor-slow-skus",
        priority: "action" as InventoryActionPriority,
        category: "Liquor",
        observation:
          `Turns declining to ${formatTurnover(liquor.currentYear)} from ${formatTurnover(liquor.priorYear)} two years ago. ` +
          `Average liquor inventory elevated at ${formatThousandsOneDecimal(monthly[monthly.length - 1].liquorBalance)}. ` +
          `Slow-moving premium spirits may be sitting through multiple quarters.`,
        actionRequired: "SKU review with beverage director",
        timeline: nextQuarterLabel,
      },
      {
        key: "food-cost-audit",
        priority: "action" as InventoryActionPriority,
        category: "Food Cost",
        observation:
          `YTD food cost % at 37.8% vs. 38.4% budget. ${monthly[0].monthLabel} spike to 40.3% — ` +
          `low-volume month with fixed purchasing costs. ` +
          `${nextQuarterLabel} purchasing controls and portion audit scheduled.`,
        actionRequired: "Portion audit + receiving review",
        timeline: nextMonthLabel,
      },
      {
        key: "beer-low-volume",
        priority: "watch" as InventoryActionPriority,
        category: "Beer",
        observation:
          `Beer volume is moderate at $${(beer.currentYear * 3).toFixed(1)}K YTD. SKU count may not be ` +
          `justified by volume. Evaluate whether any slow-moving product requires markdown or removal from the menu.`,
        actionRequired: "Review with F&B manager",
        timeline: nextQuarterLabel,
      },
      {
        key: "soft-goods-strong",
        priority: "positive" as InventoryActionPriority,
        category: "Soft Goods",
        observation:
          `Pro shop soft goods turns at ${formatTurnover(softGoods.currentYear)} — best in three years. ` +
          `Gross margin of 46.7% is strong. Spring apparel buy is performing. Continue current buying strategy.`,
        actionRequired: "Maintain current approach",
        timeline: "Ongoing",
      },
      {
        key: "food-turns-positive",
        priority: "positive" as InventoryActionPriority,
        category: "Food Turns",
        observation:
          `Food inventory turnover improving to ${formatTurnover(food.currentYear)} — above the 10x benchmark ` +
          `for well-managed club kitchens. ${latestMonth.monthLabel} ending balance of ` +
          `${formatThousandsOneDecimal(latestMonth.foodBalance)} is slightly elevated but should normalize in ` +
          `${nextMonthLabel} as spring programming ramps.`,
        actionRequired: "Monitor balance resolution",
        timeline: nextMonthLabel,
      },
    ],
  };

  return {
    dataSource: "demo",
    eyebrow: `${opts.clubName} · Inventory & Purchasing`,
    title: "Inventory Analysis",
    periodLabel: period.statementHeaderLabel,
    introNote:
      "Inventory turnover ratios, cost percentages, and category-level analysis — food, beverage, and pro shop.",
    statementNumber: "Statement 14 of 14",
    documentChip: "Inventory & Purchasing",
    preparedFor: "F&B Committee Level",
    kpiCards,
    charts: {
      turnoverByCategory,
      monthlyBalances,
      titles,
      chipLabels,
      callouts: {
        turnoverByCategory: turnoverCallout,
        monthlyBalances:    monthlyBalancesCallout,
      },
    },
    actionTable,
  };
}

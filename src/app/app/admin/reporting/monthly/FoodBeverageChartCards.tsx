"use client";

// Founder rule 2026-07-05 v15.10 — F&B Statistics charts adopt
// the Payroll Analysis v15.8 editorial standard byte-for-byte.
//
// The four F&B charts now render inside cream-body cards with a
// Stewardship-style dark-green editorial header, consume the
// shared editorial primitives (`EditorialGroupedBarChart`,
// `EditorialDonut`, `EditorialLineChart`), and end with an
// executive commentary panel using the same green-wash + 3-px
// accent treatment as Payroll Analysis.
//
// Prior implementation was 679 lines of bespoke SVG with inline
// hex colors, a duplicated tooltip, a hand-rolled donut, and
// one-off legends. v15.10 delegates every SVG to the shared
// primitives so all axis typography, gridlines, tooltip
// behaviour, and geometry flow from `chart-theme.ts` — matching
// the Editorial Reporting Design System rule in CLAUDE.md.

import type { FoodBeverageStatistics } from "@/lib/reporting/food-beverage-statistics";
import { EditorialGroupedBarChart } from "@/components/reporting/EditorialGroupedBarChart";
import { EditorialLineChart } from "@/components/reporting/EditorialLineChart";
import { EditorialDonut, type DonutSlice } from "@/components/reporting/EditorialDonut";
import { EditorialChartReveal } from "@/components/reporting/EditorialChartReveal";

type ChartData = FoodBeverageStatistics["charts"];

// ---------------------------------------------------------------------------
// Card chrome — cream body + Stewardship-style dark-green header slab
// (identical byte-for-byte to Payroll Analysis).
// ---------------------------------------------------------------------------
const cardClass =
  "relative flex w-full flex-col overflow-hidden rounded-md border border-club-green-800/10 bg-club-cream";

const commentaryStyle: React.CSSProperties = {
  padding: "10px 14px",
  fontSize: "13px",
  lineHeight: 1.45,
  backgroundColor: "rgba(63, 112, 66, 0.10)",
  borderLeft: "3px solid rgba(63, 112, 66, 0.55)",
};

/**
 * Dark green editorial header — same shared implementation as the
 * Payroll cards (chapter XII). Consumers pass title, subtitle,
 * and chip label; the header renders the 76-px slab with the
 * cream serif title, uppercase cream/70 subtitle, and gold pill.
 */
function ChartHeader({
  title,
  subtitle,
  chipLabel,
  testidPrefix,
}: {
  title: string;
  subtitle: string;
  chipLabel: string;
  testidPrefix: string;
}) {
  return (
    <header
      data-testid={`${testidPrefix}-header`}
      className="flex items-start justify-between bg-club-green-900"
      style={{ height: 76, paddingTop: 12, paddingBottom: 12, paddingLeft: 18, paddingRight: 18 }}
    >
      <div className="min-w-0 flex-1 pr-3">
        <h3
          data-testid={`${testidPrefix}-title`}
          className="font-serif text-club-cream"
          style={{ fontSize: "17px", fontWeight: 600, lineHeight: 1.2 }}
        >
          {title}
        </h3>
        <p
          data-testid={`${testidPrefix}-subtitle`}
          className="mt-1 uppercase text-club-cream/70"
          style={{ fontSize: "10.5px", letterSpacing: "0.7px", lineHeight: 1.35 }}
        >
          {subtitle}
        </p>
      </div>
      <span
        data-testid={`${testidPrefix}-chip`}
        className="inline-flex shrink-0 items-center rounded-full border border-club-gold/30 px-2.5 py-1 uppercase text-club-gold"
        style={{ fontSize: "9px", letterSpacing: "1px", fontWeight: 500 }}
      >
        {chipLabel}
      </span>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Chart 1 — Monthly F&B Revenue vs Cost (grouped bars)
// ---------------------------------------------------------------------------

function MonthlyRevenueCostChart({
  data,
}: {
  data: ChartData["monthlyRevenueCost"];
}) {
  const xLabels = data.map((d) => d.monthLabel.slice(0, 3));
  const revenue = data.map((d) => d.revenue);
  const cost = data.map((d) => d.cost);
  const rawMax = Math.max(...revenue, ...cost);
  const yHi = Math.ceil(rawMax / 100_000) * 100_000;
  const yTicks = Math.max(2, yHi / 100_000);
  return (
    <div data-testid="fb-monthly-revenue-cost-chart">
      <EditorialChartReveal testid="fb-monthly-revenue-cost-chart-reveal">
        <EditorialGroupedBarChart
          xLabels={xLabels}
          // v15.8/v15.10 — canonical Tailwind palette: editorial
          // green + editorial gold, matching Operating Results and
          // Payroll charts byte-for-byte.
          series={[
            { name: "Revenue", values: revenue, color: "fill-club-green-500" },
            { name: "Cost",    values: cost,    color: "fill-club-gold" },
          ]}
          height={245}
          formatY="dollars-compact"
          yDomain={[0, yHi]}
          yTicks={yTicks}
          padLeft={44}
          padRight={14}
        />
      </EditorialChartReveal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart 2 — Revenue by Category (donut + legend)
// ---------------------------------------------------------------------------

function CategoryDonut({ slices }: { slices: ChartData["revenueByCategory"] }) {
  const donutSlices: DonutSlice[] = slices.map((s) => ({
    key: s.key,
    label: s.label,
    fillHex: s.fillHex,
    fraction: s.share,
  }));
  return (
    <EditorialChartReveal testid="fb-category-donut-reveal">
      <EditorialDonut
        slices={donutSlices}
        ariaLabel="Revenue by F&B category"
        testidPrefix="fb-category-donut"
        buildTooltip={(slice) => {
          const source = slices.find((s) => s.key === slice.key);
          if (!source) return { label: slice.label, rows: [] };
          const amount = `$${Math.round(source.amount / 1_000).toLocaleString("en-US")}K YTD`;
          const share = `${(source.share * 100).toFixed(1)}% of F&B revenue`;
          return {
            label: source.label,
            rows: [
              { key: "amount", text: amount },
              { key: "share",  text: share },
            ],
          };
        }}
      />
    </EditorialChartReveal>
  );
}

function CategoryLegend({ slices }: { slices: ChartData["revenueByCategory"] }) {
  return (
    <ul
      data-testid="fb-category-legend"
      className="flex flex-col gap-1 font-serif text-club-green-900/85"
      style={{ fontSize: "9.5px", letterSpacing: "0px" }}
    >
      {slices.map((slice) => (
        <li key={slice.key} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: slice.fillHex }}
          />
          <span>
            {slice.label} — {`$${Math.round(slice.amount / 1_000).toLocaleString("en-US")}K`}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Chart 3 — Monthly Cover Counts (Actual / Budget / Prior Year grouped bars)
// ---------------------------------------------------------------------------

function MonthlyCoversChart({
  data,
}: {
  data: ChartData["monthlyCoverCounts"];
}) {
  const xLabels = data.map((d) => d.monthLabel.slice(0, 3));
  const actual = data.map((d) => d.coversActual);
  const budget = data.map((d) => d.coversBudget);
  const priorYear = data.map((d) => d.coversPriorYear);
  const rawMax = Math.max(...actual, ...budget, ...priorYear);
  const yHi = Math.ceil(rawMax / 1_000) * 1_000;
  const yTicks = Math.max(2, yHi / 1_000);
  return (
    <div data-testid="fb-monthly-covers-chart">
      <EditorialChartReveal testid="fb-monthly-covers-chart-reveal">
        <EditorialGroupedBarChart
          xLabels={xLabels}
          series={[
            { name: "Actual",      values: actual,    color: "fill-club-green-500" },
            { name: "Budget",      values: budget,    color: "fill-club-gold" },
            // Prior Year — the muted-sage from the shared chart
            // theme (`CHART_COLORS.priorYear` = "#9aa697"), matching
            // Financial Performance's prior-year overlay convention.
            { name: "Prior Year",  values: priorYear, color: "#9aa697" },
          ]}
          height={245}
          formatY="raw"
          yDomain={[0, yHi]}
          yTicks={yTicks}
          padLeft={44}
          padRight={14}
        />
      </EditorialChartReveal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart 4 — Food Cost % by Month (line + dashed budget target)
// ---------------------------------------------------------------------------

function FoodCostLineChart({
  trend,
  periodYear,
}: {
  trend: ChartData["foodCostTrend"];
  periodYear: number;
}) {
  const xLabels = trend.points.map((p) => p.monthLabel.slice(0, 3));
  const costs = trend.points.map((p) => p.costPct);
  const budget = trend.points.map(() => trend.budgetTargetPct);
  // Symmetric range around the observed cost + budget values.
  const rawMin = Math.min(...costs, trend.budgetTargetPct);
  const rawMax = Math.max(...costs, trend.budgetTargetPct);
  const pad = Math.max(1, (rawMax - rawMin) * 0.15);
  const yLo = Math.floor((rawMin - pad) * 10) / 10;
  const yHi = Math.ceil((rawMax + pad) * 10) / 10;
  return (
    <div data-testid="fb-food-cost-line-chart">
      <EditorialChartReveal testid="fb-food-cost-line-chart-reveal">
      <EditorialLineChart
        xLabels={xLabels}
        // Founder rule 2026-07-05 v15.12 — shared editorial hover.
        // Tooltip snaps to the nearest month and surfaces ONLY the
        // Food Cost row — the dashed budget target is a reference
        // line, not a value the reader needs at hover time. Value
        // formatter is the shared "percent" descriptor — no closure
        // crosses the RSC boundary.
        tooltip={{
          xHeaders: trend.points.map((p) => `${p.monthLabel} ${periodYear}`),
          // Two lines: [0] Budget target (dashed gold — omit),
          // [1] Food Cost % (solid green with markers — surface).
          lineLabels: [null, "Food Cost"],
          valueFormat: "percent",
        }}
        // Chart-dominant band matching Equity + Operating.
        height={245}
        padLeft={44}
        padRight={14}
        formatY="percent"
        yDomain={[yLo, yHi]}
        yTicks={4}
        lines={[
          // Budget target — dashed gold benchmark line.
          {
            values: budget,
            stroke: "stroke-club-gold",
            width: 1.4,
            dasharray: "6 4",
            opacity: 0.65,
          },
          // Food cost % — solid editorial green primary series
          // with data markers, matching the Equity chart's
          // solid-primary-with-markers convention.
          {
            values: costs,
            stroke: "stroke-club-green-500",
            width: 2.4,
            markers: true,
            markerFill: "fill-club-green-500",
            areaFill: "fill-club-green-500/10",
          },
        ]}
        legend={[
          {
            label: "F&B Cost %",
            stroke: "stroke-club-green-500",
            strokeWidth: 2.4,
            showMarker: true,
            markerFill: "fill-club-green-500",
          },
          {
            label: `Budget ${trend.budgetTargetPct.toFixed(1)}%`,
            stroke: "stroke-club-gold",
            strokeWidth: 1.4,
            dasharray: "6 4",
            opacity: 0.65,
          },
        ]}
      />
      </EditorialChartReveal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component — 2×2 grid the F&B panel renders.
// ---------------------------------------------------------------------------

export function FoodBeverageChartCards({
  charts,
}: {
  charts: ChartData;
}) {
  // Founder rule 2026-07-05 v15.12 — the shared line-chart tooltip
  // renders each x-slot's period header as "Month YYYY". The
  // reporting service already threads the year into every subtitle
  // (e.g. "January – May 2026" / "YTD 2026 vs. Budget…"), so we
  // extract it from the subtitle string here rather than adding a
  // duplicated `periodYear` field to the service payload. Falls back
  // to the current calendar year if the subtitle is missing.
  const periodYear =
    Number(charts.subtitles.monthlyRevenueCost.match(/\b(\d{4})\b/)?.[1]) ||
    Number(charts.subtitles.revenueByCategory.match(/\b(\d{4})\b/)?.[1]) ||
    new Date().getUTCFullYear();
  return (
    <div
      data-testid="fb-charts-grid"
      className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2"
    >
      {/* Chart 1 — Monthly F&B Revenue vs Cost */}
      <article data-testid="fb-monthly-card" className={cardClass}>
        <ChartHeader
          title="Monthly F&B Revenue vs. Cost"
          subtitle={charts.subtitles.monthlyRevenueCost}
          chipLabel={charts.chipLabels.monthlyRevenueCost}
          testidPrefix="fb-monthly"
        />
        <div className="px-6 py-5">
          <MonthlyRevenueCostChart data={charts.monthlyRevenueCost} />
          <p
            data-testid="fb-monthly-callout"
            className="mt-4 font-sans italic text-club-green-900"
            style={commentaryStyle}
          >
            {charts.callouts.monthlyRevenueCost.text}
          </p>
        </div>
      </article>

      {/* Chart 2 — Revenue by Category donut */}
      <article data-testid="fb-category-card" className={cardClass}>
        <ChartHeader
          title="Revenue by Category"
          subtitle={charts.subtitles.revenueByCategory}
          chipLabel={charts.chipLabels.revenueByCategory}
          testidPrefix="fb-category"
        />
        <div className="px-6 py-5">
          <div className="flex flex-row items-center justify-center gap-8">
            <CategoryDonut slices={charts.revenueByCategory} />
            <CategoryLegend slices={charts.revenueByCategory} />
          </div>
          <p
            data-testid="fb-category-callout"
            className="mt-4 font-sans italic text-club-green-900"
            style={commentaryStyle}
          >
            {charts.callouts.revenueByCategory.text}
          </p>
        </div>
      </article>

      {/* Chart 3 — Monthly Cover Counts */}
      <article data-testid="fb-covers-card" className={cardClass}>
        <ChartHeader
          title="Monthly Cover Counts"
          subtitle={charts.subtitles.monthlyCoverCounts}
          chipLabel={charts.chipLabels.monthlyCoverCounts}
          testidPrefix="fb-covers"
        />
        <div className="px-6 py-5">
          <MonthlyCoversChart data={charts.monthlyCoverCounts} />
          <p
            data-testid="fb-covers-callout"
            className="mt-4 font-sans italic text-club-green-900"
            style={commentaryStyle}
          >
            {charts.callouts.monthlyCoverCounts.text}
          </p>
        </div>
      </article>

      {/* Chart 4 — Food Cost % by Month */}
      <article data-testid="fb-food-cost-card" className={cardClass}>
        <ChartHeader
          title="Food Cost % by Month"
          subtitle={charts.subtitles.foodCostTrend}
          chipLabel={charts.chipLabels.foodCostTrend}
          testidPrefix="fb-food-cost"
        />
        <div className="px-6 py-5">
          <FoodCostLineChart trend={charts.foodCostTrend} periodYear={periodYear} />
          <p
            data-testid="fb-food-cost-callout"
            className="mt-4 font-sans italic text-club-green-900"
            style={commentaryStyle}
          >
            {charts.callouts.foodCostTrend.text}
          </p>
        </div>
      </article>
    </div>
  );
}

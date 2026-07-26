"use client";

// Founder rule 2026-07-05 v15.11 — Inventory Analysis charts adopt
// the Payroll Analysis v15.8 + F&B Statistics v15.10 editorial
// standard byte-for-byte.
//
// The two Inventory charts now render inside cream-body cards with
// a Stewardship-style dark-green editorial header, consume the
// shared editorial primitives (`EditorialGroupedBarChart`,
// `EditorialLineChart`), and each end with an executive commentary
// panel using the same green-wash + 3-px accent treatment as
// Payroll + F&B.
//
// Prior implementation was 412 lines of bespoke SVG with inline
// hex colors, a duplicated tooltip, a hand-rolled multi-line chart,
// and one-off axis typography. v15.11 delegates every SVG to the
// shared primitives so all axis typography, gridlines, tooltip
// behaviour, and geometry flow from `chart-theme.ts` — matching
// the Editorial Reporting Design System rule in CLAUDE.md.

import type { InventoryAnalysis } from "@/lib/reporting/inventory-analysis";
import { EditorialGroupedBarChart } from "@/components/reporting/EditorialGroupedBarChart";
import { EditorialLineChart } from "@/components/reporting/EditorialLineChart";
import { EditorialChartReveal } from "@/components/reporting/EditorialChartReveal";

type ChartData = InventoryAnalysis["charts"];

// ---------------------------------------------------------------------------
// Card chrome — cream body + Stewardship-style dark-green header slab
// (identical byte-for-byte to Payroll Analysis + F&B Statistics).
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
 * Payroll (chapter XII) + F&B (chapter XIII) cards. Consumers pass
 * title, subtitle, and chip label; the header renders the 76-px slab
 * with the cream serif title, uppercase cream/70 subtitle, and gold
 * pill.
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
// Chart 1 — Inventory Turnover by Category (grouped bars)
// ---------------------------------------------------------------------------

function TurnoverBarChart({
  data,
}: {
  data: ChartData["turnoverByCategory"];
}) {
  const xLabels = data.map((d) => d.label);
  const current = data.map((d) => d.currentYear);
  const prior   = data.map((d) => d.priorYear);
  const rawMax  = Math.max(...current, ...prior);
  // Round to nearest 2x so ticks read as 0x / 2x / 4x / ... / 12x.
  const yHi = Math.ceil(rawMax / 2) * 2;
  const yTicks = Math.max(2, yHi / 2);
  return (
    <div data-testid="inv-turnover-chart">
      <EditorialChartReveal testid="inv-turnover-chart-reveal">
        <EditorialGroupedBarChart
          xLabels={xLabels}
          // v15.8/v15.10/v15.11 — canonical Tailwind palette: editorial
          // green + editorial gold, matching Operating Results, Payroll,
          // and F&B charts byte-for-byte.
          series={[
            { name: "Current Year", values: current, color: "fill-club-green-500" },
            { name: "Prior Year",   values: prior,   color: "fill-club-gold" },
          ]}
          height={245}
          formatY="turnover-x"
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
// Chart 2 — F&B Inventory Balances (multi-line — Food / Wine / Liquor)
// ---------------------------------------------------------------------------

// Preserve the F&B chapter's category branding — editorial green
// (Food) + editorial gold (Wine) + slate-blue arbitrary token
// (Liquor). Literal Tailwind class strings so the JIT scanner
// compiles them at build time (interpolated template literals would
// silently drop).
function BalancesLineChart({
  data,
  periodYear,
}: {
  data: ChartData["monthlyBalances"];
  periodYear: number;
}) {
  const xLabels = data.map((d) => d.monthLabel.slice(0, 3));
  const food    = data.map((d) => d.foodBalance);
  const wine    = data.map((d) => d.wineBalance);
  const liquor  = data.map((d) => d.liquorBalance);
  // Symmetric range around the observed balances so the three
  // series read cleanly without cramping the top or bottom.
  const allValues = [...food, ...wine, ...liquor];
  const rawMax = Math.max(...allValues);
  const rawMin = Math.min(...allValues);
  const yLo = Math.floor(rawMin / 5_000) * 5_000;
  const yHi = Math.ceil(rawMax / 5_000) * 5_000;
  const yTicks = Math.max(2, Math.round((yHi - yLo) / 5_000));
  return (
    <div data-testid="inv-balances-chart">
      <EditorialChartReveal testid="inv-balances-chart-reveal">
      <EditorialLineChart
        xLabels={xLabels}
        // Chart-dominant band matching Equity + Operating + Payroll + F&B.
        height={245}
        padLeft={44}
        padRight={14}
        formatY="dollars-compact"
        yDomain={[yLo, yHi]}
        yTicks={yTicks}
        // Founder rule 2026-07-05 v15.12 — shared editorial hover.
        // Multi-series tooltip: every hovered month surfaces ALL
        // THREE inventory categories (Food / Wine / Liquor) aligned
        // to the same x-slot, matching the founder's acceptance
        // criterion: "For charts with multiple series, the tooltip
        // should display every series for the selected month."
        // Balances are raw dollars, rendered with `.1` precision
        // via the shared `dollars-compact-1d` descriptor so a
        // hovered "$52.3K" reads at the same precision as the KPI
        // ribbon above the chart — no closure crosses the RSC
        // boundary.
        tooltip={{
          xHeaders: data.map((d) => `${d.monthLabel} ${periodYear}`),
          lineLabels: ["Food Inventory", "Wine Inventory", "Liquor Inventory"],
          valueFormat: "dollars-compact-1d",
        }}
        lines={[
          {
            values: food,
            stroke: "stroke-club-green-500",
            width: 2.2,
            markers: true,
            markerFill: "fill-club-green-500",
          },
          {
            values: wine,
            stroke: "stroke-club-gold",
            width: 2.2,
            markers: true,
            markerFill: "fill-club-gold",
          },
          {
            values: liquor,
            stroke: "stroke-[#7d96b0]",
            width: 2.2,
            markers: true,
            markerFill: "fill-[#7d96b0]",
          },
        ]}
        legend={[
          {
            label: "Food Inventory",
            stroke: "stroke-club-green-500",
            strokeWidth: 2.2,
            showMarker: true,
            markerFill: "fill-club-green-500",
          },
          {
            label: "Wine Inventory",
            stroke: "stroke-club-gold",
            strokeWidth: 2.2,
            showMarker: true,
            markerFill: "fill-club-gold",
          },
          {
            label: "Liquor Inventory",
            stroke: "stroke-[#7d96b0]",
            strokeWidth: 2.2,
            showMarker: true,
            markerFill: "fill-[#7d96b0]",
          },
        ]}
      />
      </EditorialChartReveal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component — 2-up grid the Inventory panel renders.
// ---------------------------------------------------------------------------

export function InventoryChartCards({
  charts,
}: {
  charts: ChartData;
}) {
  // Founder rule 2026-07-05 v15.12 — the shared line-chart tooltip
  // renders each x-slot's period header as "Month YYYY". The
  // reporting service threads the year into the balances subtitle
  // (e.g. "Food · Wine · Liquor · Average Balance by Month · January
  // – May 2026"), so we regex-extract it here rather than duplicate
  // it as a top-level chart field. Falls back to the current
  // calendar year if the subtitle is missing.
  const periodYear =
    Number(
      charts.titles.monthlyBalances.subtitle.match(/\b(\d{4})\b/)?.[1],
    ) || new Date().getUTCFullYear();
  return (
    <div
      data-testid="inv-charts-grid"
      className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2"
    >
      {/* Chart 1 — Inventory Turnover by Category */}
      <article data-testid="inv-turnover-card" className={cardClass}>
        <ChartHeader
          title={charts.titles.turnoverByCategory.title}
          subtitle={charts.titles.turnoverByCategory.subtitle}
          chipLabel={charts.chipLabels.turnoverByCategory}
          testidPrefix="inv-turnover"
        />
        <div className="px-6 py-5">
          <TurnoverBarChart data={charts.turnoverByCategory} />
          <p
            data-testid="inv-turnover-callout"
            className="mt-4 font-sans italic text-club-green-900"
            style={commentaryStyle}
          >
            {charts.callouts.turnoverByCategory.text}
          </p>
        </div>
      </article>

      {/* Chart 2 — F&B Inventory Balances Monthly */}
      <article data-testid="inv-balances-card" className={cardClass}>
        <ChartHeader
          title={charts.titles.monthlyBalances.title}
          subtitle={charts.titles.monthlyBalances.subtitle}
          chipLabel={charts.chipLabels.monthlyBalances}
          testidPrefix="inv-balances"
        />
        <div className="px-6 py-5">
          <BalancesLineChart data={charts.monthlyBalances} periodYear={periodYear} />
          <p
            data-testid="inv-balances-callout"
            className="mt-4 font-sans italic text-club-green-900"
            style={commentaryStyle}
          >
            {charts.callouts.monthlyBalances.text}
          </p>
        </div>
      </article>
    </div>
  );
}

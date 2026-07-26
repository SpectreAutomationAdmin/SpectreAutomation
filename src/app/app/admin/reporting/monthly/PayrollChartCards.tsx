"use client";

// Founder rule 2026-07-05 v15.8 — Payroll Analysis charts adopt
// the Stewardship-style editorial header + commentary treatment
// used by the Financial Performance chapter (Chapter II).
//
// Every chart card in the 2×2 grid renders three bands:
//   1. Dark green editorial header — 76 px slab with a serif
//      title, uppercase cream/70 subtitle, and a gold pill on
//      the right carrying the chart's chip label.
//   2. The chart canvas (bar / donut) bound to a shared editorial
//      primitive so axes, gridlines, legend, and tooltip all flow
//      from `chart-theme.ts`.
//   3. Executive commentary — a green-wash panel with a 3-px
//      left-accent border. Every chart's commentary is generated
//      dynamically from the report data by the reporting service.
//
// The bar palette is now the canonical two-tone pair used by
// Operating Results — `fill-club-green-500` for Actual /
// primary series, `fill-club-gold` for Budget / secondary
// series. This replaces the earlier interpolated
// `fill-[${CHART_COLORS.actual}]` string which Tailwind's JIT
// scanner could not compile at build time, producing black bars.

import type {
  DepartmentalPayrollAnalysis,
} from "@/lib/reporting/departmental-payroll-analysis";
import { EditorialBarChart } from "@/components/reporting/EditorialBarChart";
import { EditorialGroupedBarChart } from "@/components/reporting/EditorialGroupedBarChart";
import { EditorialDonut, type DonutSlice } from "@/components/reporting/EditorialDonut";
import { EditorialChartReveal } from "@/components/reporting/EditorialChartReveal";

type ChartData = DepartmentalPayrollAnalysis["charts"];

// ---------------------------------------------------------------------------
// Card chrome — cream body + Stewardship-style dark-green header slab.
// ---------------------------------------------------------------------------
const cardClass =
  "relative flex w-full flex-col overflow-hidden rounded-md border border-club-green-800/10 bg-club-cream";

// Body-copy commentary block — reproduces the StewardshipCard
// `insetCommentary` treatment byte-for-byte (green wash + 3-px
// deep-green left accent + serif italic 13 px body).
const commentaryStyle: React.CSSProperties = {
  padding: "10px 14px",
  fontSize: "13px",
  lineHeight: 1.45,
  backgroundColor: "rgba(63, 112, 66, 0.10)",
  borderLeft: "3px solid rgba(63, 112, 66, 0.55)",
};

/**
 * Dark green editorial header — mirrors the Stewardship card
 * header slab byte-for-byte (bg-club-green-900, 76 px, 12/18/12/18
 * padding, 17 px serif cream title, uppercase 10.5 px 0.7 px
 * letter-spacing cream/70 subtitle, gold pill on the right).
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
// Grouped bars — YTD Actual vs Budget by Department
// ---------------------------------------------------------------------------

function GroupedActualBudgetChart({ data }: { data: ChartData["byDepartment"] }) {
  const xLabels = data.map((d) => d.shortLabel);
  const actualValues = data.map((d) => d.ytdActual);
  const budgetValues = data.map((d) => d.ytdBudget);
  const rawMax = Math.max(...actualValues, ...budgetValues);
  const yHi = Math.ceil(rawMax / 100_000) * 100_000;
  const yTicks = Math.max(2, yHi / 100_000);
  return (
    <div data-testid="payroll-grouped-bar-chart">
      <EditorialChartReveal testid="payroll-grouped-bar-chart-reveal">
        <EditorialGroupedBarChart
          xLabels={xLabels}
          // v15.8 — canonical Tailwind palette. `fill-club-green-500`
          // (Actual) + `fill-club-gold` (Budget) match the Operating
          // Results primary/secondary bar pair byte-for-byte. Prior
          // interpolated `fill-[${hex}]` strings were unreachable by
          // Tailwind's JIT scanner and rendered as black bars.
          series={[
            { name: "YTD Actual", values: actualValues, color: "fill-club-green-500" },
            { name: "YTD Budget", values: budgetValues, color: "fill-club-gold" },
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
// Diverging bars — YTD Variance by Department
// ---------------------------------------------------------------------------

function VarianceDivergingChart({ data }: { data: ChartData["byDepartment"] }) {
  const xLabels = data.map((d) => d.shortLabel);
  const values = data.map((d) => d.ytdVariance);
  const maxAbs = Math.max(...values.map(Math.abs));
  const yAbs = Math.max(30_000, Math.ceil(maxAbs / 5_000) * 5_000);
  const yTicks = Math.max(2, Math.round((yAbs * 2) / 5_000));
  return (
    <div data-testid="payroll-variance-bar-chart">
      <EditorialChartReveal testid="payroll-variance-bar-chart-reveal">
        <EditorialBarChart
          xLabels={xLabels}
          height={245}
          formatY="dollars-compact"
          yDomain={[-yAbs, yAbs]}
          yTicks={yTicks}
          padLeft={44}
          padRight={14}
          primary={{
            values,
            positiveFill: "fill-club-green-500",
            negativeFill: "fill-[#8b3520]",
          }}
        />
      </EditorialChartReveal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Donut — Payroll Distribution
// ---------------------------------------------------------------------------

function PayrollDistributionDonut({ slices }: { slices: ChartData["donutSlices"] }) {
  const donutSlices: DonutSlice[] = slices.map((s) => ({
    key: s.key,
    label: s.label,
    fillHex: s.fillHex,
    fraction: s.share,
  }));
  return (
    <EditorialChartReveal testid="payroll-distribution-donut-reveal">
      <EditorialDonut
        slices={donutSlices}
        ariaLabel="Payroll distribution by department"
        testidPrefix="payroll-distribution-donut"
        buildTooltip={(slice) => {
          const source = slices.find((s) => s.key === slice.key);
          if (!source) return { label: slice.label, rows: [] };
          const share = `${(source.share * 100).toFixed(1)}% of payroll`;
          const amount = `$${Math.round(source.amount / 1_000).toLocaleString("en-US")}K YTD`;
          return {
            label: source.label,
            rows: [
              { key: "amount", text: amount },
              { key: "share", text: share },
            ],
          };
        }}
      />
    </EditorialChartReveal>
  );
}

function DonutLegend({ slices }: { slices: ChartData["donutSlices"] }) {
  return (
    <ul
      data-testid="payroll-distribution-legend"
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
          <span>{slice.label.replace(/^\d+ — /, "")}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Grouped bars — Wages vs Taxes & Benefits
// ---------------------------------------------------------------------------

function WagesVsTaxesChart({ data }: { data: ChartData["byDepartment"] }) {
  const xLabels = data.map((d) => d.shortLabel);
  const wages = data.map((d) => d.wages);
  const taxes = data.map((d) => d.taxesBenefits);
  const rawMax = Math.max(...wages, ...taxes);
  const yHi = Math.ceil(rawMax / 100_000) * 100_000;
  const yTicks = Math.max(2, yHi / 100_000);
  return (
    <div data-testid="payroll-stacked-bar-chart">
      <EditorialChartReveal testid="payroll-stacked-bar-chart-reveal">
        <EditorialGroupedBarChart
          xLabels={xLabels}
          // v15.8 — canonical Tailwind palette (see above).
          series={[
            { name: "Wages", values: wages, color: "fill-club-green-500" },
            { name: "Taxes & Benefits", values: taxes, color: "fill-club-gold" },
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
// Public component — the 2×2 grid the Payroll panel renders.
// ---------------------------------------------------------------------------

export function PayrollChartCards({
  charts,
}: {
  charts: ChartData;
}) {
  return (
    <div
      data-testid="payroll-charts-grid"
      className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2"
    >
      {/* Chart 1 — YTD Actual vs Budget grouped */}
      <article data-testid="payroll-grouped-card" className={cardClass}>
        <ChartHeader
          title={charts.titles.byDeptActualVsBudget.title}
          subtitle={charts.titles.byDeptActualVsBudget.subtitle}
          chipLabel={charts.titles.byDeptActualVsBudget.chipLabel}
          testidPrefix="payroll-grouped"
        />
        <div className="px-6 py-5">
          <GroupedActualBudgetChart data={charts.byDepartment} />
          <p
            data-testid="payroll-grouped-callout"
            className="mt-4 font-sans italic text-club-green-900"
            style={commentaryStyle}
          >
            {charts.callouts.breakdown.text}
          </p>
        </div>
      </article>

      {/* Chart 2 — YTD Variance diverging */}
      <article data-testid="payroll-variance-card" className={cardClass}>
        <ChartHeader
          title={charts.titles.ytdVariance.title}
          subtitle={charts.titles.ytdVariance.subtitle}
          chipLabel={charts.titles.ytdVariance.chipLabel}
          testidPrefix="payroll-variance"
        />
        <div className="px-6 py-5">
          <VarianceDivergingChart data={charts.byDepartment} />
          <p
            data-testid="payroll-variance-callout"
            className="mt-4 font-sans italic text-club-green-900"
            style={commentaryStyle}
          >
            {charts.callouts.variance.text}
          </p>
        </div>
      </article>

      {/* Chart 3 — Payroll Distribution donut */}
      <article data-testid="payroll-distribution-card" className={cardClass}>
        <ChartHeader
          title={charts.titles.payrollDistribution.title}
          subtitle={charts.titles.payrollDistribution.subtitle}
          chipLabel={charts.titles.payrollDistribution.chipLabel}
          testidPrefix="payroll-distribution"
        />
        <div className="px-6 py-5">
          <div className="flex flex-row items-center justify-center gap-8">
            <PayrollDistributionDonut slices={charts.donutSlices} />
            <DonutLegend slices={charts.donutSlices} />
          </div>
          <p
            data-testid="payroll-distribution-callout"
            className="mt-4 font-sans italic text-club-green-900"
            style={commentaryStyle}
          >
            {charts.callouts.distribution.text}
          </p>
        </div>
      </article>

      {/* Chart 4 — Wages vs Taxes & Benefits grouped */}
      <article data-testid="payroll-stacked-card" className={cardClass}>
        <ChartHeader
          title={charts.titles.wagesVsTaxes.title}
          subtitle={charts.titles.wagesVsTaxes.subtitle}
          chipLabel={charts.titles.wagesVsTaxes.chipLabel}
          testidPrefix="payroll-stacked"
        />
        <div className="px-6 py-5">
          <WagesVsTaxesChart data={charts.byDepartment} />
          <p
            data-testid="payroll-stacked-callout"
            className="mt-4 font-sans italic text-club-green-900"
            style={commentaryStyle}
          >
            {charts.callouts.wagesVsTaxes.text}
          </p>
        </div>
      </article>
    </div>
  );
}

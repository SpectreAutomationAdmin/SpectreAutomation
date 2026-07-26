"use client";

// Interactive Weather Charts — chapter XI client island.
//
// 2026-06-19 (v2) — adopted the Financial Performance card chrome
// (dark-green header band + KPI ribbon + chart body + inset
// commentary band) so the Weather charts read as the same product
// family as the FP chapter's OperatingResultsCard / DuesSubsidy
// donut. The shared chart primitives (`EditorialDonut`,
// `EditorialInteractiveBarChart`, `ChartTooltip`) own the chart
// geometry + hover + tooltip; the card CHROME is composed inline
// here, mirroring StewardshipCard in `page.tsx`. When chapters
// XII–XIV migrate we'll factor a shared `ReportingChartCard`
// component out of this pattern.
//
// Color remap: weather-condition `fillHex` values from the service
// are mapped to the Financial Performance palette tokens
// (`CHART_COLORS`) so the donut + bars read with the same green /
// gold / sand / clay family as the FP charts — not generic
// weather-themed yellow/blue/grey.

import type {
  MonthlyWeatherSummary,
} from "@/lib/reporting/monthly-weather-summary";

import { EditorialDonut } from "@/components/reporting/EditorialDonut";
import { EditorialInteractiveBarChart } from "@/components/reporting/EditorialInteractiveBarChart";
import { EditorialChartReveal } from "@/components/reporting/EditorialChartReveal";
import { CHART_COLORS } from "@/components/reporting/chart-theme";

type PatternCard = MonthlyWeatherSummary["patternCard"];
type RoundsCard  = MonthlyWeatherSummary["roundsCard"];

/**
 * Map a weather-condition slice/bar key to the Financial Performance
 * palette so the chart reads with the same color family as the FP
 * chapter charts. The mapping is intentional:
 *   - sunny-clear   → CHART_COLORS.actual    (dominant FP green)
 *   - partly-cloudy → CHART_COLORS.neutral   (muted sand)
 *   - rain-storm(s) → CHART_COLORS.negative  (clay — unfavorable)
 *   - high-wind     → CHART_COLORS.budget    (muted gold — caution)
 * Falls back to the actual green for any unmapped key so a future
 * weather category doesn't break visual cohesion.
 */
function fpColorForWeatherKey(key: string): string {
  if (key === "sunny-clear") return CHART_COLORS.actual;
  if (key === "partly-cloudy") return CHART_COLORS.neutral;
  if (key === "rain-storms" || key === "rain-storm") return CHART_COLORS.negative;
  if (key === "high-wind") return CHART_COLORS.budget;
  return CHART_COLORS.actual;
}

export function WeatherChartCards({
  pattern, rounds,
}: {
  pattern: PatternCard;
  rounds: RoundsCard;
}) {
  // Period-average round count for the bar tooltip's variance line.
  const periodAverage =
    rounds.bars.reduce((s, b) => s + b.averageRounds, 0) / rounds.bars.length;

  // Pattern card KPIs — synthesized from the slice data so the
  // ribbon reads parallel to the FP cards' KPI strip. Sunny-share /
  // rain-days / wind-days / total-days are the board-relevant
  // headline numbers a chair would quote at the top of a weather
  // conversation.
  const sunny = pattern.slices.find((s) => s.key === "sunny-clear")?.days ?? 0;
  const rainy = pattern.slices.find((s) => s.key === "rain-storms" || s.key === "rain-storm")?.days ?? 0;
  const windy = pattern.slices.find((s) => s.key === "high-wind")?.days ?? 0;
  const sunnyPct = pattern.totalDays > 0
    ? `${Math.round((sunny / pattern.totalDays) * 100)}%`
    : "—";

  // Rounds card KPIs — pull the highest / lowest bars + period
  // average so the ribbon previews the chart's distribution.
  const sortedBars = [...rounds.bars].sort((a, b) => b.averageRounds - a.averageRounds);
  const bestBar = sortedBars[0];
  const worstBar = sortedBars[sortedBars.length - 1];

  // Y-axis: cap to ≤ 6 ticks so the bar chart reads cleanly (the
  // older 10-rd-per-tick rendering produced 16 labels). FP's
  // OperatingResults bar chart uses 4 ticks.
  const maxRoundsRaw = Math.max(...rounds.bars.map((b) => b.averageRounds));
  const yMaxRounded = Math.ceil(maxRoundsRaw / 50) * 50;

  return (
    <div
      data-testid="mws-charts-grid"
      className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2"
    >
      <FpChartCard
        testid="mws-pattern-card"
        title={pattern.title}
        subtitle={pattern.subtitle}
        pillLabel="WEATHER PATTERN"
        kpis={[
          { label: "Total days",    value: String(pattern.totalDays) },
          { label: "Sunny share",   value: sunnyPct },
          { label: "Rain days",     value: String(rainy) },
          { label: "Windy days",    value: String(windy) },
        ]}
        commentary={null}
      >
        {/* Body: donut LEFT (200 px column) + vertical legend RIGHT.
            Grid template + items-center match the Dues Subsidy
            Analysis card. The chart body wrapper (above) applies
            the vertical centring; this grid only sets the two-
            column composition.

            §9 Large-Monitor Responsive Validation: the grid is
            capped at a fixed `maxWidth` and centred with `mx-auto`
            so the donut+legend composition is IDENTICAL at every
            viewport. Without the cap, the legend's `1fr` column
            would stretch to fill any extra card width — the donut
            stays pinned at the 200-px left column while the
            percentages snap to the card's right edge, leaving a
            long dot-leader corridor down the middle and making
            the chart visually LEFT-ANCHORED at 1600 / 1920 / 2560.
            With the cap, the composition stays the same and only
            the surrounding card gutters scale.

            `maxWidth: 640` (incl. px-4 padding = 32) → grid inner
            content 608 px = 200 (donut) + 32 (gap) + 376 (legend).
            This puts the group at ≥ 80 % of card width at 1920+
            (founder's §13 minimum) while still creating ~57 px of
            centring gutter so the donut is no longer pinned to the
            card's left edge. At 1366 (card 517) the cap is
            inactive; at 1440-1600 the cap kicks in lightly; at
            1920-2560 the cap is fully active with the centring
            margin that fixes the original left-anchor bias. */}
        <div
          className="mx-auto grid items-center gap-8 px-4 py-4"
          style={{
            gridTemplateColumns: "200px minmax(0, 1fr)",
            maxWidth: 640,
            width: "100%",
          }}
        >
          <EditorialChartReveal testid="mws-pattern-reveal">
            <EditorialDonut
              slices={pattern.slices.map((s) => ({
                key: s.key,
                label: s.label,
                fillHex: fpColorForWeatherKey(s.key),
                fraction:
                  pattern.totalDays > 0 ? s.days / pattern.totalDays : 0,
              }))}
              ariaLabel="Weather pattern distribution"
              testidPrefix="mws-pattern"
              buildTooltip={({ key, label }) => {
                const slice = pattern.slices.find((s) => s.key === key);
                if (!slice) return null;
                const pct =
                  pattern.totalDays > 0
                    ? (slice.days / pattern.totalDays) * 100
                    : 0;
                return {
                  label,
                  rows: [
                    { key: "days", text: `${slice.days} day${slice.days === 1 ? "" : "s"}` },
                    { key: "percent", text: `${pct.toFixed(1)}% of period` },
                  ],
                };
              }}
            />
          </EditorialChartReveal>

          {/* Vertical legend list. Founder direction 2026-06-20:
              label + percent must read as ONE row, not two
              disconnected columns. We use dot-leaders (a left-
              dotted underline on the label span) so the eye
              connects "Sunny / Clear ............... 55%" the way
              a print TOC does. The leader effect comes from a
              repeating linear-gradient on the label's flex track. */}
          <div
            data-testid="mws-pattern-legend"
            className="flex flex-col gap-2.5"
          >
            {pattern.slices.map((slice) => {
              const pct = pattern.totalDays > 0
                ? Math.round((slice.days / pattern.totalDays) * 100)
                : 0;
              return (
                <div
                  key={slice.key}
                  data-testid={`mws-pattern-legend-${slice.key}`}
                  className="flex items-baseline gap-2"
                >
                  <span
                    aria-hidden="true"
                    className="shrink-0"
                    style={{
                      width: "12px",
                      height: "12px",
                      backgroundColor: fpColorForWeatherKey(slice.key),
                      display: "inline-block",
                      transform: "translateY(2px)",
                    }}
                  />
                  <span
                    className="font-serif text-club-green-900 whitespace-nowrap shrink-0"
                    style={{ fontSize: "14px", lineHeight: 1.4 }}
                  >
                    {slice.label}
                  </span>
                  {/* Dot leader between label and value. Pure CSS:
                      a repeating radial-gradient draws dots along
                      the flex-grow span between the label and
                      percent. */}
                  <span
                    aria-hidden="true"
                    className="grow self-end mb-1"
                    style={{
                      height: "1px",
                      backgroundImage:
                        "radial-gradient(circle, rgba(63,112,66,0.45) 0.6px, transparent 0.8px)",
                      backgroundSize: "5px 1px",
                      backgroundRepeat: "repeat-x",
                      backgroundPosition: "0 100%",
                    }}
                  />
                  <span
                    className="font-serif text-club-green-900 text-right tabular-nums shrink-0"
                    style={{ fontSize: "14px", lineHeight: 1.4, fontWeight: 600, minWidth: "2.4rem" }}
                  >
                    {pct}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </FpChartCard>

      <FpChartCard
        testid="mws-rounds-card"
        title={rounds.title}
        subtitle={rounds.subtitle}
        pillLabel="ROUNDS BY CONDITION"
        kpis={[
          { label: "Period avg",    value: `${Math.round(periodAverage)} rds` },
          { label: "Best condition", value: bestBar ? `${bestBar.averageRounds} rds` : "—" },
          { label: "Worst condition", value: worstBar ? `${worstBar.averageRounds} rds` : "—" },
          { label: "Total days",    value: String(pattern.totalDays) },
        ]}
        commentary={rounds.insight}
      >
        {/* Chart fills the card body edge-to-edge — NO horizontal
            padding on this wrapper. This mirrors the FP Operating
            Results card pattern (StewardshipCard renders its chart
            in a `<div className="bg-club-cream">` with no px-_).
            The chart's INTERNAL padLeft / padRight (44 / 14, matching
            FP exactly) is what positions the plot area so its right
            edge aligns with the KPI ribbon's right edge (both inset
            by 14 px = px-3.5). The previous `px-4` wrapper here
            double-inset the chart and broke the KPI-vs-plot alignment. */}
        <div className="py-4" style={{ height: 260 }}>
          <EditorialChartReveal testid="mws-rounds-reveal">
          <EditorialInteractiveBarChart
            bars={rounds.bars.map((b) => ({
              key: b.key,
              label: b.label,
              value: b.averageRounds,
              fillHex: fpColorForWeatherKey(b.key),
            }))}
            height={260}
            yMax={yMaxRounded}
            tickCount={5}
            // Bare numerals on the y-axis ("150", not "150 rds").
            // With the 2026-06-22 bump to 12 px y-axis labels, the
            // "rds" unit suffix would push the longest label past
            // the padLeft=44 gutter. The unit is already named in
            // the card's subtitle ("AVERAGE DAILY ROUNDS BY
            // WEATHER CONDITION") and the KPI ribbon ("88 rds
            // Period avg"), so the axis can carry bare values.
            yTickSuffix=""
            // FP Operating Results geometry. padLeft=44 / padRight=14
            // align the plot's right edge with the KPI ribbon's
            // right edge (both at px-3.5 = 14 px inset from the
            // card edge).
            padLeft={44}
            padRight={14}
            padTop={12}
            // Bumped 32 → 40 to give the taller x-axis labels
            // (13 px serif / weight 500, per the §9 Axis Typography
            // Standard) more breathing room beneath the bars.
            padBottom={40}
            // Axis labels inherit the shared CHART_AXES sizes
            // (12 px y / 13 px x at weight 500) — the §9 Axis
            // Typography Standard. The primitive uses CSS `px`
            // (not viewBox units), so labels render at their stated
            // CSS size on every viewport, matching FP Operating
            // Results and Payroll Department Breakdown after the
            // same chart-theme bump.
            // Bars at ~4.8 % of plot width to match FP Operating
            // primary bars (~22 px @1440, ~32 px @1920). At N=4
            // this means R ≈ 0.15 — BELOW FP's `primaryWidthRatio`
            // of 0.55, because matching the RATIO at few categories
            // produces blocky bars. The §9 cap (≤ 0.60) protects
            // against the inverse failure.
            barWidthRatio={0.15}
            // Even distribution with breathing room from the plot
            // edges — categories sit centred in their natural bands,
            // not anchored to the chart boundaries. 0.3 gives the
            // editorial "Payroll Analysis" feel: bars distributed
            // across the plot with intentional outer margins.
            outerPaddingRatio={0.3}
            ariaLabel="Average daily rounds by weather condition"
            testidPrefix="mws-rounds"
            buildTooltip={(bar) => {
              const variance = bar.value - periodAverage;
              const variancePct =
                periodAverage > 0 ? (variance / periodAverage) * 100 : 0;
              const sign = variance >= 0 ? "+" : "−";
              return {
                label: bar.label,
                rows: [
                  { key: "rounds", text: `${bar.value} avg rounds/day` },
                  {
                    key: "variance",
                    text: `${sign}${Math.abs(Math.round(variance))} vs. period avg (${sign}${Math.abs(variancePct).toFixed(0)}%)`,
                  },
                ],
              };
            }}
          />
          </EditorialChartReveal>
        </div>
      </FpChartCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FpChartCard — inline replication of the Financial Performance
// StewardshipCard chrome (page.tsx → StewardshipCard at line 1855).
// Header band + 4-KPI ribbon + chart body + inset commentary band.
// When chapters XII–XIV migrate we'll factor this into a shared
// `ReportingChartCard` in src/components/reporting/.
// ---------------------------------------------------------------------------
function FpChartCard({
  testid,
  title,
  subtitle,
  pillLabel,
  kpis,
  commentary,
  children,
}: {
  testid: string;
  title: string;
  subtitle: string;
  pillLabel: string;
  kpis: ReadonlyArray<{ label: string; value: string }>;
  commentary: string | null;
  children: React.ReactNode;
}) {
  return (
    <article
      data-testid={testid}
      data-chart-card="true"
      className="flex w-full flex-1 flex-col overflow-hidden rounded-md border border-club-green-800/10 bg-club-cream"
    >
      {/* Header band — matches StewardshipCard: dark green, 76 px tall,
          cream serif title + smallcaps subtitle + gold pill on right. */}
      <header
        className="flex items-start justify-between bg-club-green-900"
        style={{
          height: 76,
          paddingTop: 12,
          paddingBottom: 12,
          paddingLeft: 18,
          paddingRight: 18,
        }}
      >
        <div className="min-w-0 flex-1 pr-3">
          <h3
            data-testid={`${testid}-title`}
            className="font-serif text-club-cream"
            style={{ fontSize: "17px", fontWeight: 600, lineHeight: 1.2 }}
          >
            {title}
          </h3>
          <p
            data-testid={`${testid}-subtitle`}
            className="mt-1 uppercase text-club-cream/70"
            style={{ fontSize: "10.5px", letterSpacing: "0.7px", lineHeight: 1.35 }}
          >
            {subtitle}
          </p>
        </div>
        <span
          data-testid={`${testid}-pill`}
          className="inline-flex shrink-0 items-center rounded-full border border-club-gold/30 px-2.5 py-1 uppercase text-club-gold"
          style={{ fontSize: "9px", letterSpacing: "1px", fontWeight: 500 }}
        >
          {pillLabel}
        </span>
      </header>

      {/* KPI ribbon — 4-up grid, matches StewardshipCard. */}
      <div
        data-testid={`${testid}-kpis`}
        className="grid grid-cols-4 gap-1.5 px-3.5"
        style={{ height: 77, marginTop: 16 }}
      >
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className="flex flex-col items-center justify-center rounded border border-club-green-800/10 bg-club-cream/60 px-2"
          >
            <div
              className="font-serif tabular-nums text-club-green-900"
              style={{ fontSize: "18px", fontWeight: 600, lineHeight: 1.1 }}
            >
              {kpi.value}
            </div>
            <div
              className="mt-1 uppercase text-club-green-800/70 text-center"
              style={{ fontSize: "9.5px", letterSpacing: "0.8px", lineHeight: 1.2 }}
            >
              {kpi.label}
            </div>
          </div>
        ))}
      </div>

      {/* Chart body — children fill this band (cream background).
          `flex flex-col justify-center` vertically centres the body
          contents inside the available chart-band height. Without
          this, a short-content body (e.g. the Weather Pattern card's
          200 × 200 donut + 4-row legend, total ~200 px tall) sits at
          the TOP of a much taller chart band, leaving large empty
          space below. With centring, the donut/legend group sits at
          the visual midpoint of the body — matching the Dues Subsidy
          Analysis card's composition. The bar-chart card (which sets
          its own explicit chart height) is unaffected: a 260-px-tall
          chart in a 340-px-tall body simply gets ~40 px of breathing
          room above + below. */}
      <div
        className="bg-club-cream flex flex-col justify-center"
        style={{ marginTop: 10, flex: 1 }}
      >
        {children}
      </div>

      {/* Inset commentary band — matches StewardshipCard's
          insetCommentary variant: px-3.5 gutter, green-tinted block,
          3-px deep-green left accent. Only renders when commentary
          is non-null (the donut card omits it). */}
      {commentary ? (
        <div className="px-3.5" style={{ marginTop: 8, paddingBottom: 14 }}>
          <p
            data-testid={`${testid}-commentary`}
            className="font-sans italic text-club-green-900"
            style={{
              padding: "10px 14px",
              fontSize: "13px",
              lineHeight: 1.45,
              backgroundColor: "rgba(63, 112, 66, 0.10)",
              borderLeft: "3px solid rgba(63, 112, 66, 0.55)",
            }}
          >
            {commentary}
          </p>
        </div>
      ) : null}
    </article>
  );
}

"use client";

// Canonical interactive bar chart — the single bar primitive every
// Monthly Board Reporting Package chapter renders when per-bar hover
// is required. Sibling to the static `EditorialBarChart` (which the
// Financial Performance OperatingResultsCard uses without hover).
//
// Capabilities (locked 2026-06-19 per founder direction):
//   - Single-series bars, each with its own fill (per-bar coloring
//     from service `fillHex`).
//   - Per-bar hover: stroke thickens 0.5→2.4 px, no lift, no
//     y/height change. Card chrome NEVER changes.
//   - Tooltip floats above the cursor via the shared `ChartTooltip`.
//   - Card chrome and y-axis labels styled from the shared
//     `chart-theme.ts` tokens (CHART_AXES, CHART_STROKES).
//
// Geometry contract:
//   - Configurable padL/padR/padT/padB.
//   - Bar width = slotW × BAR_GEOMETRY.primaryWidthRatio.
//   - Y-axis ticks computed from `yMax` and `tickStep` (or auto).
//   - Optional y-tick label suffix (e.g. " rds", "x", "%", "$K").
//
// Future extensions (additive only — must preserve chapter II
// OperatingResultsCard / locked Equity card):
//   - `groupedSeries` for 2- or 3-series grouped bars (chapter XII,
//     XIII, XIV).
//   - `stackedSeries` for stacked bars (chapter XII payroll wages /
//     taxes & benefits).
//   - `signedBars` for diverging-around-zero (chapter XII variance).

import { useEffect, useRef, useState } from "react";

import {
  BAR_GEOMETRY,
  CHART_AXES,
  CHART_STROKES,
} from "@/components/reporting/chart-theme";
import {
  ChartTooltip,
  type ChartTooltipModel,
} from "@/components/reporting/ChartTooltip";

export type InteractiveBar = {
  /** Stable key for React + per-bar testid. */
  key: string;
  /** X-axis label rendered beneath the bar. */
  label: string;
  /** Numeric value (the bar's height). */
  value: number;
  /** Per-bar fill color (typically a hex from the reporting
   *  service). When all bars share a tone, pass the same color
   *  for every entry. */
  fillHex: string;
};

export type EditorialInteractiveBarChartProps = {
  bars: ReadonlyArray<InteractiveBar>;
  /** Chart width in viewBox units. When omitted (default), the chart
   *  is CONTAINER-RESPONSIVE — the viewBox width tracks the parent
   *  width via ResizeObserver so the plot area always fills the
   *  available card width (matches `EditorialBarChart` and the
   *  Financial Performance chart system). Pass an explicit width
   *  only for the rare case where a fixed viewBox is required. */
  width?: number;
  /** Chart height in viewBox units. */
  height?: number;
  /** Y-axis maximum (computed by the service when domain matters,
   *  e.g. tick rounding to a "nice" number). */
  yMax?: number;
  /** Number of y-axis ticks (the chart draws tickCount + 1 gridlines
   *  including 0). */
  tickCount?: number;
  /** Suffix appended to each y-tick label (e.g. " rds"). */
  yTickSuffix?: string;
  /** Optional left padding override. Default 48 (matches
   *  FP OperatingResultsCard). */
  padLeft?: number;
  /** Optional right padding override. Default 8. */
  padRight?: number;
  /** Optional top padding override. Default 12. */
  padTop?: number;
  /** Optional bottom padding override. Default 32. */
  padBottom?: number;
  /** Optional per-bar width ratio override (`barWidth / step`).
   *  Defaults to `BAR_GEOMETRY.primaryWidthRatio` (0.55) — the FP-
   *  canonical ratio. **Do not raise this to inflate bars on
   *  few-category charts** — the §9 standard requires the FP
   *  bar-width ratio. Use `outerPaddingRatio` instead to push the
   *  first / last bar closer to the plot boundaries. */
  barWidthRatio?: number;
  /** Y-axis tick label font size in CSS pixels. Defaults to the
   *  shared `CHART_AXES.axisLabelFontSize` (matches FP). Charts
   *  with few categories (and therefore more breathing room around
   *  the labels) can raise this for board-package readability. */
  yLabelFontSizePx?: number;
  /** X-axis category label font size in CSS pixels. Defaults to the
   *  shared `CHART_AXES.xLabelFontSize`. */
  xLabelFontSizePx?: number;
  /** Outer padding (per side) as a fraction of the band step.
   *  Defaults to `(1 - barWidthRatio) / 2`, which reproduces the
   *  legacy slot-centred layout (each bar gets a 1/N-th-of-plot
   *  slot and is centred within it). Set to 0 to make the first
   *  bar's left edge touch the plot's left boundary and the last
   *  bar's right edge touch the plot's right boundary — the
   *  scaleBand-style "evenly distributed across the plot"
   *  behaviour required by §9 for few-category charts. Small
   *  positive values (0.05–0.15) give a clean "evenly distributed
   *  with a hair of breathing-room at the edges" feel. */
  outerPaddingRatio?: number;
  /** Aria-label on the SVG root. */
  ariaLabel: string;
  /** Data-testid prefix. The SVG gets `${testidPrefix}-svg`; each
   *  bar gets `${testidPrefix}-bar-${key}`; the tooltip gets
   *  `${testidPrefix}-tooltip`. */
  testidPrefix: string;
  /** Build the tooltip model for the hovered bar. */
  buildTooltip: (bar: InteractiveBar) => {
    label: string;
    rows: ChartTooltipModel["rows"];
  };
  /** Optional className for the SVG root (sizing / responsive). */
  svgClassName?: string;
};

const SSR_DEFAULT_WIDTH = 552;

export function EditorialInteractiveBarChart({
  bars,
  width,
  height = 220,
  yMax,
  tickCount,
  yTickSuffix = "",
  padLeft = 48,
  padRight = 16,
  padTop = 12,
  padBottom = 32,
  barWidthRatio,
  outerPaddingRatio,
  yLabelFontSizePx,
  xLabelFontSizePx,
  ariaLabel,
  testidPrefix,
  buildTooltip,
  svgClassName = "block h-full w-full overflow-visible",
}: EditorialInteractiveBarChartProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  // CONTAINER-RESPONSIVE WIDTH (matches EditorialBarChart pattern).
  // When the caller omits `width`, we measure the container via
  // ResizeObserver so the chart's viewBox width tracks the actual
  // pixel width of its parent — making the chart fill the card width
  // at every viewport, the way FP's OperatingResults bar chart does.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number>(SSR_DEFAULT_WIDTH);
  useEffect(() => {
    if (width !== undefined) return; // explicit width wins
    const el = containerRef.current;
    if (!el) return;
    const initial = el.getBoundingClientRect().width;
    if (initial && Math.abs(initial - measuredWidth) > 0.5) {
      setMeasuredWidth(Math.round(initial));
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w && w > 0) setMeasuredWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);
  const resolvedWidth = width ?? Math.max(200, measuredWidth);

  const plotW = Math.max(0, resolvedWidth - padLeft - padRight);
  const plotH = Math.max(0, height - padTop - padBottom);

  // Compute y-domain + tick spacing.
  const maxRaw = Math.max(...bars.map((b) => b.value), 0);
  const resolvedYMax = yMax ?? niceCeil(maxRaw);
  const resolvedTickCount =
    tickCount ?? Math.max(2, Math.min(10, Math.round(resolvedYMax / niceStep(resolvedYMax))));
  const tickStep = resolvedYMax / resolvedTickCount;

  // scaleBand-style positioning. The plot is divided into N bands
  // of width `stepW`, each containing one bar of width
  // `stepW * barWidthRatio`. Outer padding (per side, in step-units)
  // controls how close the first / last bar sit to the plot edges.
  //   step × (N - paddingInner + 2 × outerPad) = plotW
  // where paddingInner = 1 - barWidthRatio.
  //
  // Default outerPad = paddingInner / 2 reproduces the legacy
  // slot-centred layout (slotW = plotW / N, bar centred in slot).
  // outerPad = 0 → bars span edge-to-edge of the plot, distributed
  // evenly (the §9 standard for few-category charts).
  const resolvedBarWidthRatio = barWidthRatio ?? BAR_GEOMETRY.primaryWidthRatio;
  const paddingInner = 1 - resolvedBarWidthRatio;
  const resolvedOuterPad = outerPaddingRatio ?? paddingInner / 2;
  const stepDenom = bars.length - paddingInner + 2 * resolvedOuterPad;
  const stepW = stepDenom > 0 ? plotW / stepDenom : plotW;
  const barW = stepW * resolvedBarWidthRatio;

  function handleBarHover(key: string, ev: React.MouseEvent<SVGElement>) {
    // VIEWPORT-RELATIVE cursor coords — the portal-rendered tooltip
    // positions itself with `position: fixed` and flips when near
    // viewport edges.
    setMousePos({ x: ev.clientX, y: ev.clientY });
    setActiveKey(key);
  }
  function clear() {
    setActiveKey(null);
    setMousePos(null);
  }

  const activeBar = activeKey ? bars.find((b) => b.key === activeKey) : undefined;
  const tooltipBody = activeBar && mousePos ? buildTooltip(activeBar) : null;

  return (
    <div
      ref={containerRef}
      className="relative block h-full w-full"
      onMouseLeave={clear}
    >
      <svg
        data-testid={`${testidPrefix}-svg`}
        viewBox={`0 0 ${resolvedWidth} ${height}`}
        role="img"
        aria-label={ariaLabel}
        className={svgClassName}
        style={{ shapeRendering: "geometricPrecision", textRendering: "geometricPrecision" }}
      >
        {/* Y-axis gridlines + labels. The first gridline carries a
            `plot-area` testid so the §9 plot-utilization regression
            spec can measure the actual plot-area width in screen px
            (gridlines span `padLeft → resolvedWidth - padRight`,
            which IS the plot area). */}
        {Array.from({ length: resolvedTickCount + 1 }, (_, i) => {
          const v = i * tickStep;
          const y = padTop + plotH - (v / resolvedYMax) * plotH;
          return (
            <g key={`tick-${i}`}>
              <line
                x1={padLeft}
                x2={resolvedWidth - padRight}
                y1={y}
                y2={y}
                stroke={CHART_AXES.gridlineColor}
                strokeWidth={CHART_AXES.gridlineWidth}
                data-testid={i === 0 ? `${testidPrefix}-plot-area` : undefined}
              />
              {/* Y-axis tick label. Uses CSS `px` (string with unit)
                  rather than the SVG-attribute number form (viewBox
                  units), so the label renders at its stated CSS
                  pixel size regardless of the SVG's letterbox scale
                  factor. Matches `EditorialBarChart` (FP Operating
                  Results) which has always used CSS `9px`. The
                  numeric-form fontSize was rendering at ~7.9 CSS px
                  at 1920 due to the 0.877 vertical letterbox. */}
              <text
                x={padLeft - 6}
                y={y + 3}
                textAnchor="end"
                className="font-serif fill-club-green-800/70"
                style={{
                  fontSize: `${yLabelFontSizePx ?? CHART_AXES.axisLabelFontSize}px`,
                }}
              >
                {formatYTick(v, yTickSuffix)}
              </text>
            </g>
          );
        })}

        {/* Bars + x-axis labels. Founder rule 2026-07-13 v15.13.2 —
            shared reveal gate. `EditorialInteractiveBarChart` is a
            bespoke non-diverging bar primitive (bars are always
            positive-valued — round counts, day counts, etc.); the
            `chart-anim-bar-up` class gives every bar the same "grow
            from the zero baseline upward" reveal as the shared
            `EditorialBarChart` / `EditorialGroupedBarChart`. Sub-
            slot stagger of 100 ms per bar keeps this primitive
            visually consistent with the grouped-bar primitive's
            editorial stagger. */}
        {bars.map((bar, i) => {
          const x = padLeft + stepW * (i + resolvedOuterPad);
          const h = (bar.value / resolvedYMax) * plotH;
          const y = padTop + plotH - h;
          const isActive = bar.key === activeKey;
          // 100 ms per bar sits inside the founder's 75–125 ms
          // editorial stagger window and matches the shared
          // `EditorialGroupedBarChart` per-series stagger.
          const delayMs = i * 100;
          return (
            <g key={bar.key} data-testid={`${testidPrefix}-bar-${bar.key}`}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                fill={bar.fillHex}
                stroke={isActive ? CHART_STROKES.active : CHART_STROKES.rest}
                strokeWidth={isActive ? BAR_GEOMETRY.activeStrokeWidth : BAR_GEOMETRY.restStrokeWidth}
                data-active={isActive ? "true" : "false"}
                className="cursor-pointer transition-[stroke-width,stroke] duration-150 chart-anim-bar-up"
                style={{ animationDelay: `${delayMs}ms` }}
                onMouseEnter={(e) => handleBarHover(bar.key, e)}
                onMouseMove={(e) => handleBarHover(bar.key, e)}
              />
              {/* X-axis category label. CSS `px` (see y-axis note
                  above). FP color class for parity with the FP
                  Operating Results x-axis labels. */}
              <text
                x={x + barW / 2}
                y={padTop + plotH + 14}
                textAnchor="middle"
                className="font-serif fill-club-green-800/85"
                style={{
                  fontSize: `${xLabelFontSizePx ?? CHART_AXES.xLabelFontSize}px`,
                  fontWeight: CHART_AXES.xLabelFontWeight,
                }}
              >
                {bar.label}
              </text>
            </g>
          );
        })}
      </svg>

      {tooltipBody && mousePos ? (
        <ChartTooltip
          tooltip={{ x: mousePos.x, y: mousePos.y, label: tooltipBody.label, rows: tooltipBody.rows }}
          testidPrefix={testidPrefix}
        />
      ) : null}
    </div>
  );
}

function formatYTick(value: number, suffix: string): string {
  return suffix ? `${Math.round(value)}${suffix}` : String(Math.round(value));
}

function niceCeil(v: number): number {
  if (v <= 0) return 10;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const norm = v / base;
  if (norm <= 1) return base;
  if (norm <= 2) return 2 * base;
  if (norm <= 5) return 5 * base;
  return 10 * base;
}

function niceStep(yMax: number): number {
  if (yMax <= 10) return 1;
  if (yMax <= 50) return 5;
  if (yMax <= 100) return 10;
  if (yMax <= 500) return 50;
  if (yMax <= 1000) return 100;
  return 500;
}

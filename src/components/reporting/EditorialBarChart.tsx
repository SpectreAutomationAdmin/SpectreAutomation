"use client";

// Responsive editorial diverging bar chart with optional secondary bars
// and a dotted overlay line. Mirrors the Saguaro Operating Results
// panel measured in docs/spectre-stewardship-rebuild-spec.md, refactored
// from the in-page server-rendered version into a client component so
// it can track its container width via ResizeObserver and update the
// SVG viewBox dynamically — same fix the line chart applied to
// eliminate the cream-gutter bug at viewports ≥ 1600 px.
//
// Geometry contract:
//   - padL / padR are CONFIGURABLE PROPS (see Equity card's alignment
//     rules in docs/equity-value-over-time-card-spec.md). Default 48 / 16.
//   - padT = 10, padB = 54 (with legend) / 30 (without)
//   - viewBox height = max(220, props.height); viewBox WIDTH = measured
//     container width (so 1 vb unit == 1 viewport px at scale 1.0 and
//     no horizontal letterbox at any viewport)
//   - preserveAspectRatio defaults to "xMidYMid meet" — UNIFORM SCALE.
//     NEVER preserveAspectRatio="none" (which is the equity card's
//     Rule 6 forbidden pattern).
//   - shapeRendering / textRendering = geometricPrecision
//
// Legend convention: each entry is a small visual sample matching its
// actual chart glyph (bar swatch for bars, dashed line sample for the
// overlay line), grouped tight and centred under the plot. NOT the
// generic edge-to-edge filled rectangles the old server-rendered
// version used.

import { useEffect, useRef, useState } from "react";

import { CHART_AXES } from "@/components/reporting/chart-theme";

export type BarLegendEntry = {
  label: string;
  /** What kind of glyph this legend item represents.
   *
   *  - "bar"       → a small filled rectangle. Use for single-tone bar
   *                  series. The `swatch` Tailwind class drives the
   *                  colour.
   *  - "split-bar" → a small square diagonally split top-left ↘
   *                  bottom-right. The lower-left triangle uses
   *                  `negativeSwatch`; the upper-right triangle uses
   *                  `positiveSwatch`. Use when the series being
   *                  legended is diverging (positive AND negative
   *                  values) so the legend communicates "results can
   *                  be either positive or negative" without forcing
   *                  the reader to inspect the bars themselves.
   *  - "line"      → a short stroked line segment. Use for overlay
   *                  lines (e.g. prior-year dotted). Reads `stroke`,
   *                  `strokeWidth`, `dasharray`, `opacity` — same
   *                  fields the chart line uses. */
  shape: "bar" | "split-bar" | "line";
  /** For shape="bar": Tailwind fill class. */
  swatch?: string;
  /** For shape="split-bar": Tailwind fill class for the upper-right
   *  triangle (positive half). Should match the chart's positive
   *  fill exactly so the legend previews what's actually drawn. */
  positiveSwatch?: string;
  /** For shape="split-bar": Tailwind fill class for the lower-left
   *  triangle (negative half). Should match the chart's negative
   *  fill exactly. */
  negativeSwatch?: string;
  /** For shape="line": Tailwind stroke class. */
  stroke?: string;
  strokeWidth?: number;
  dasharray?: string;
  opacity?: number;
};

export type FormatYSpec =
  | "dollars-thousands"  // 245 → "$245K" (caller pre-scales to thousands)
  | "dollars-millions"   // 31 → "$31M" (caller pre-scales to millions)
  // Founder rule 2026-07-05 v15.9 — auto-scaling compact currency.
  // Caller passes RAW DOLLARS; formatter picks the unit per tick:
  //   0        → "$0K"
  //   100_000  → "$100K"
  //   900_000  → "$900K"
  //   1_200_000 → "$1.2M"
  // Prevents the "900000K" duplicated-suffix bug that came from
  // passing raw dollars to `dollars-thousands`.
  | "dollars-compact"
  | "raw";

function applyFormatY(spec: FormatYSpec | undefined, v: number): string {
  switch (spec) {
    case "dollars-thousands": return `$${Math.round(v)}K`;
    case "dollars-millions":  return `$${Math.round(v)}M`;
    case "dollars-compact": {
      const sign = v < 0 ? "-" : "";
      const abs = Math.abs(v);
      if (abs >= 1_000_000) {
        // $1.2M — one decimal, strip trailing zero for whole-M values.
        const label = (abs / 1_000_000).toFixed(1).replace(/\.0$/, "");
        return `${sign}$${label}M`;
      }
      // Under $1M — always $NK (including $0K at v=0), matching the
      // canonical Financial Performance charts.
      return `${sign}$${Math.round(abs / 1_000)}K`;
    }
    case "raw":
    default:                  return String(Math.round(v));
  }
}

export type EditorialBarChartProps = {
  xLabels: string[];
  /** Primary monthly values — drawn as the dominant diverging bars. */
  primary: { values: number[]; positiveFill: string; negativeFill: string };
  /** Optional secondary series — drawn as narrower bars behind. */
  secondary?: { values: number[]; fill: string; opacity?: number };
  /** Optional dotted overlay line — Saguaro uses this for prior year. */
  overlay?: { values: number[]; stroke: string; width: number; dasharray: string; opacity?: number };
  height: number;
  yTicks?: number;
  formatY?: FormatYSpec;
  yDomain?: [number, number];
  legend?: BarLegendEntry[];
  /** Left padding in viewBox px. Default 48. The Operating Results
   *  card passes a smaller value to align the y-axis label column
   *  with the YTD NOI KPI tile (parallel to the equity card's
   *  padLeft=44 rule). */
  padLeft?: number;
  /** Right padding in viewBox px. Default 16. The Operating card
   *  passes a smaller value to push the rightmost bar slot to the
   *  Prior Year KPI tile's right edge. */
  padRight?: number;
};

const SSR_DEFAULT_WIDTH = 552;

export function EditorialBarChart({
  xLabels, primary, secondary, overlay, height,
  yTicks = 4, formatY, yDomain, legend,
  padLeft, padRight,
}: EditorialBarChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(SSR_DEFAULT_WIDTH);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const initial = el.getBoundingClientRect().width;
    if (initial && Math.abs(initial - containerWidth) > 0.5) {
      setContainerWidth(Math.round(initial));
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w && w > 0) setContainerWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const padL = padLeft ?? 48;
  const padR = padRight ?? 16;
  const padT = 10;
  const padB = legend && legend.length ? 54 : 30;
  const width = Math.max(200, containerWidth);
  const vbH = Math.max(220, height);
  const innerW = Math.max(0, width - padL - padR);
  const innerH = Math.max(0, vbH - padT - padB);

  let yLo: number;
  let yHi: number;
  if (yDomain) {
    [yLo, yHi] = yDomain;
  } else {
    const all = [...primary.values, ...(secondary?.values ?? []), ...(overlay?.values ?? [])];
    const yMin = Math.min(...all, 0);
    const yMax = Math.max(...all, 0);
    const span = yMax - yMin || 1;
    yLo = yMin - span * 0.08;
    yHi = yMax + span * 0.08;
  }

  const n = Math.max(1, xLabels.length);
  const slotW = innerW / n;
  const xAt = (i: number) => padL + slotW * (i + 0.5);
  const yAt = (v: number) => padT + innerH * (1 - (v - yLo) / (yHi - yLo));
  const y0 = yAt(0);

  const yTicksArr = Array.from({ length: yTicks + 1 }, (_, i) => yLo + (yHi - yLo) * (i / yTicks));

  const barW = slotW * 0.55;
  const secW = slotW * 0.3;

  const overlayPath = overlay
    ? overlay.values
        .map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(2)} ${yAt(v).toFixed(2)}`)
        .join(" ")
    : null;

  return (
    <div ref={containerRef} className="block h-full w-full">
      <svg
        viewBox={`0 0 ${width} ${vbH}`}
        role="img"
        aria-label="Operating Results bar chart"
        className="block h-full w-full"
        style={{ shapeRendering: "geometricPrecision", textRendering: "geometricPrecision" }}
      >
        {/* Y-axis hairlines. */}
        {yTicksArr.map((t, i) => (
          <line
            key={`yt-${i}`}
            x1={padL} x2={width - padR}
            y1={yAt(t)} y2={yAt(t)}
            className="stroke-club-sand"
            strokeWidth={0.6}
          />
        ))}
        {yTicksArr.map((t, i) => (
          <text
            key={`yl-${i}`}
            x={padL - 8}
            y={yAt(t) + 3}
            textAnchor="end"
            className="fill-club-green-800/70"
            style={{ fontSize: `${CHART_AXES.axisLabelFontSize}px` }}
          >
            {applyFormatY(formatY, t)}
          </text>
        ))}

        {/* Zero baseline — slightly heavier than the gridlines. */}
        <line
          x1={padL} x2={width - padR}
          y1={y0} y2={y0}
          className="stroke-club-green-800/40"
          strokeWidth={0.9}
        />

        {/* Secondary bars (e.g. budget). Founder rule 2026-07-13
            v15.13 — reveal animation: `chart-anim-bar-up` or
            `chart-anim-bar-down` depending on the sign of the value,
            so the bar grows from the correct zero baseline. Values
            greater-than-or-equal-to zero grow upward (transform-origin:
            bottom); negative values grow downward (transform-origin:
            top). See globals.css for the shared keyframes. */}
        {secondary
          ? secondary.values.map((v, i) => {
              const top = Math.min(yAt(v), y0);
              const h = Math.abs(yAt(v) - y0);
              const animClass = v >= 0 ? "chart-anim-bar-up" : "chart-anim-bar-down";
              return (
                <rect
                  key={`sb-${i}`}
                  x={xAt(i) - secW / 2}
                  y={top}
                  width={secW}
                  height={Math.max(1, h)}
                  className={`${secondary.fill} ${animClass}`}
                  opacity={secondary.opacity ?? 0.5}
                />
              );
            })
          : null}

        {/* Primary bars — diverging colour by sign. */}
        {primary.values.map((v, i) => {
          const top = Math.min(yAt(v), y0);
          const h = Math.abs(yAt(v) - y0);
          const fill = v >= 0 ? primary.positiveFill : primary.negativeFill;
          const animClass = v >= 0 ? "chart-anim-bar-up" : "chart-anim-bar-down";
          return (
            <rect
              key={`pb-${i}`}
              x={xAt(i) - barW / 2}
              y={top}
              width={barW}
              height={Math.max(1, h)}
              className={`${fill} ${animClass}`}
            />
          );
        })}

        {/* Optional dotted overlay line — dashed benchmark lines
            reveal via opacity fade (chart-anim-area) rather than
            stroke-dashoffset so the dash pattern stays crisp. */}
        {overlay && overlayPath ? (
          <path
            d={overlayPath}
            fill="none"
            className={`${overlay.stroke} chart-anim-area`}
            strokeWidth={overlay.width}
            strokeDasharray={overlay.dasharray}
            opacity={overlay.opacity ?? 0.7}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}

        {/* X-axis labels. Founder rule 2026-07-05 v15.5 — the
            uppercase + 0.6 px letter-spacing decoration was
            bar-chart-only styling from the 2026-06-22 "boardroom
            bump" and created a visible mismatch with the Equity
            Value Over Time card. v15.5 drops both so the bar
            chart's month labels render identically to the line
            chart's (mixed-case, normal weight, no tracking). */}
        {xLabels.map((label, i) => (
          <text
            key={`xl-${i}`}
            x={xAt(i)}
            y={vbH - padB + 14}
            textAnchor="middle"
            className="fill-club-green-800/70"
            style={{
              fontSize: `${CHART_AXES.xLabelFontSize}px`,
              fontWeight: CHART_AXES.xLabelFontWeight,
            }}
          >
            {label}
          </text>
        ))}

        {/* Legend — Saguaro-tight, centred under the plot, each item
            previews the ACTUAL glyph of its series (bar swatch for bars,
            stroked line sample for the overlay line). Same layout
            strategy as the line chart: estimate item widths, sum, place
            group with midpoint on the plot's mid-X. */}
        {legend && legend.length
          ? (() => {
              const PREVIEW_W = 22;
              const PREVIEW_TO_LABEL_GAP = 5;
              const ITEM_SPACING = 20;
              // v15.5 — legend font size sourced from the shared
              // CHART_AXES token so line + bar charts share one value.
              const FONT_SIZE = CHART_AXES.legendFontSize;
              const CHAR_W = 4.6;
              const itemWidths = legend.map(
                (e) => PREVIEW_W + PREVIEW_TO_LABEL_GAP + e.label.length * CHAR_W,
              );
              const totalWidth =
                itemWidths.reduce((s, w) => s + w, 0) +
                (legend.length - 1) * ITEM_SPACING;
              const chartCenterX = padL + innerW / 2;
              const groupStartX = chartCenterX - totalWidth / 2;
              const yLegend = vbH - padB + 34;
              const yLineY = yLegend - 3.5;

              const xStarts: number[] = [];
              let cursor = groupStartX;
              for (let i = 0; i < legend.length; i++) {
                xStarts.push(cursor);
                cursor += itemWidths[i] + ITEM_SPACING;
              }

              return (
                <g>
                  {legend.map((e, i) => {
                    const lineLeftX = xStarts[i];
                    const lineRightX = lineLeftX + PREVIEW_W;
                    const labelX = lineRightX + PREVIEW_TO_LABEL_GAP;
                    if (e.shape === "bar") {
                      // Bar swatch: a small filled rect ≈ proportional
                      // to the actual primary bar width on the chart.
                      const swH = 8;
                      const swY = yLineY - swH / 2;
                      return (
                        <g key={`lg-${i}`}>
                          <rect
                            x={lineLeftX}
                            y={swY}
                            width={PREVIEW_W}
                            height={swH}
                            className={e.swatch ?? "fill-club-green-500"}
                            opacity={e.opacity ?? 1}
                          />
                          <text
                            x={labelX}
                            y={yLegend - 0.5}
                            textAnchor="start"
                            className="fill-club-green-800/70"
                            style={{ fontSize: `${FONT_SIZE}px` }}
                          >
                            {e.label}
                          </text>
                        </g>
                      );
                    }
                    if (e.shape === "split-bar") {
                      // Diagonally split RECTANGLE preview. Outer
                      // dimensions match the "bar" preview EXACTLY
                      // (PREVIEW_W × 8) so the Actual, Budget, and
                      // Prior Year legend markers share one
                      // rectangular footprint — the split swatch
                      // never dominates the legend or breaks the
                      // horizontal rhythm. The diagonal runs from
                      // the top-left corner to the bottom-right
                      // corner, splitting the rectangle into:
                      //   - upper-right triangle → positive fill
                      //   - lower-left triangle  → negative fill
                      // A thin cream divider on the diagonal keeps
                      // the two halves visually crisp on cream paper.
                      // Communicates "Actual results may be favorable
                      // or unfavorable" without forcing the reader to
                      // inspect individual chart bars.
                      const swW = PREVIEW_W;
                      const swH = 8;
                      const swX = lineLeftX;
                      const swY = yLineY - swH / 2;
                      const upperRightPoints =
                        `${swX},${swY} ${swX + swW},${swY} ${swX + swW},${swY + swH}`;
                      const lowerLeftPoints =
                        `${swX},${swY} ${swX + swW},${swY + swH} ${swX},${swY + swH}`;
                      return (
                        <g key={`lg-${i}`}>
                          {/* Upper-right triangle — positive fill */}
                          <polygon
                            data-tone="positive"
                            points={upperRightPoints}
                            className={e.positiveSwatch ?? "fill-club-green-500"}
                            opacity={e.opacity ?? 1}
                          />
                          {/* Lower-left triangle — negative fill */}
                          <polygon
                            data-tone="negative"
                            points={lowerLeftPoints}
                            className={e.negativeSwatch ?? "fill-[#8b3520]"}
                            opacity={e.opacity ?? 1}
                          />
                          {/* Thin cream divider on the diagonal so the
                              two halves stay visually distinct on
                              cream paper. */}
                          <line
                            x1={swX}
                            y1={swY}
                            x2={swX + swW}
                            y2={swY + swH}
                            className="stroke-club-cream"
                            strokeWidth={0.6}
                          />
                          <text
                            x={labelX}
                            y={yLegend - 0.5}
                            textAnchor="start"
                            className="fill-club-green-800/70"
                            style={{ fontSize: `${FONT_SIZE}px` }}
                          >
                            {e.label}
                          </text>
                        </g>
                      );
                    }
                    // shape === "line" — stroked sample matching the
                    // overlay line's own style.
                    return (
                      <g key={`lg-${i}`}>
                        <line
                          x1={lineLeftX}
                          x2={lineRightX}
                          y1={yLineY}
                          y2={yLineY}
                          className={e.stroke ?? "stroke-club-green-800"}
                          strokeWidth={e.strokeWidth ?? 1.3}
                          strokeDasharray={e.dasharray}
                          opacity={e.opacity ?? 1}
                          fill="none"
                          strokeLinecap={e.dasharray ? "butt" : "round"}
                        />
                        <text
                          x={labelX}
                          y={yLegend - 0.5}
                          textAnchor="start"
                          className="fill-club-green-800/70"
                          style={{ fontSize: `${FONT_SIZE}px` }}
                        >
                          {e.label}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })()
          : null}
      </svg>
    </div>
  );
}

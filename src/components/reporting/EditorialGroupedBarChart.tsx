"use client";

// Responsive editorial grouped bar chart — 3 bars per category slot.
// Used for the Payroll Analysis — Department Breakdown card.
//
// Geometry mirrors the existing EditorialBarChart so the two cards
// read as a typographic pair:
//   - dynamic viewBox WIDTH = measured container width (ResizeObserver)
//   - viewBox HEIGHT = props.height
//   - preserveAspectRatio default "xMidYMid meet" (uniform scale,
//     NEVER preserveAspectRatio="none")
//   - shapeRendering / textRendering = geometricPrecision
//   - padL / padR configurable, default 48 / 16
//   - padB widens when a legend is rendered
//
// Each x-slot is split into 3 narrower sub-slot bars (one per series).
// The legend uses the line-preview-style filled-rectangle samples
// because the chart's glyphs ARE filled rectangles.

import { useEffect, useRef, useState } from "react";

import { CHART_AXES } from "@/components/reporting/chart-theme";

export type GroupedSeries = {
  /** Display label. */
  name: string;
  /** Per-category values, indexed by xLabels[i]. */
  values: number[];
  /** Tailwind fill class OR inline hex (#RRGGBB). */
  color: string;
};

export type FormatYSpec =
  | "dollars-thousands"  // 245 → "$245K" (caller pre-scales to thousands)
  | "dollars-millions"   // 31 → "$31M" (caller pre-scales to millions)
  // Founder rule 2026-07-05 v15.9 — auto-scaling compact currency.
  // Caller passes RAW DOLLARS; formatter picks K / M per tick.
  // See EditorialBarChart for the canonical spec + rationale.
  | "dollars-compact"
  // Founder rule 2026-07-05 v15.11 — inventory-turnover multiples.
  // Renders integer ticks with an "x" suffix (0 → "0x", 2 → "2x",
  // 12 → "12x"). Consumed by the Inventory Analysis chapter's
  // Turnover-by-Category grouped bars.
  | "turnover-x"
  | "raw";

function applyFormatY(spec: FormatYSpec | undefined, v: number): string {
  switch (spec) {
    case "dollars-thousands": return `$${Math.round(v)}K`;
    case "dollars-millions":  return `$${Math.round(v)}M`;
    case "dollars-compact": {
      const sign = v < 0 ? "-" : "";
      const abs = Math.abs(v);
      if (abs >= 1_000_000) {
        const label = (abs / 1_000_000).toFixed(1).replace(/\.0$/, "");
        return `${sign}$${label}M`;
      }
      return `${sign}$${Math.round(abs / 1_000)}K`;
    }
    case "turnover-x":        return `${Math.round(v)}x`;
    case "raw":
    default:                  return String(Math.round(v));
  }
}

export type EditorialGroupedBarChartProps = {
  xLabels: string[];
  series: GroupedSeries[];
  height: number;
  yTicks?: number;
  formatY?: FormatYSpec;
  yDomain?: [number, number];
  padLeft?: number;
  padRight?: number;
};

const SSR_DEFAULT_WIDTH = 552;

export function EditorialGroupedBarChart({
  xLabels, series, height,
  yTicks = 4, formatY, yDomain,
  padLeft, padRight,
}: EditorialGroupedBarChartProps) {
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
  const padB = 54; // room for x-labels + legend
  const width = Math.max(200, containerWidth);
  const vbH = Math.max(220, height);
  const innerW = Math.max(0, width - padL - padR);
  const innerH = Math.max(0, vbH - padT - padB);

  let yLo: number;
  let yHi: number;
  if (yDomain) {
    [yLo, yHi] = yDomain;
  } else {
    const all = series.flatMap((s) => s.values);
    const yMin = Math.min(...all, 0);
    const yMax = Math.max(...all, 0);
    const span = yMax - yMin || 1;
    yLo = yMin - span * 0.05;
    yHi = yMax + span * 0.10;
  }

  const n = Math.max(1, xLabels.length);
  const slotW = innerW / n;
  const xAt = (i: number) => padL + slotW * (i + 0.5);
  const yAt = (v: number) => padT + innerH * (1 - (v - yLo) / (yHi - yLo));
  const y0 = yAt(0);
  const yTicksArr = Array.from({ length: yTicks + 1 }, (_, i) => yLo + (yHi - yLo) * (i / yTicks));

  // Sub-slot allocation — 3 bars across roughly 70 % of the slot width
  // so the slot still reads as a group.
  const groupWidth = slotW * 0.74;
  const subSlotW = groupWidth / series.length;
  const barW = subSlotW * 0.78;

  return (
    <div ref={containerRef} className="block h-full w-full">
      <svg
        viewBox={`0 0 ${width} ${vbH}`}
        role="img"
        aria-label="Payroll by department grouped bar chart"
        className="block h-full w-full"
        style={{ shapeRendering: "geometricPrecision", textRendering: "geometricPrecision" }}
      >
        {/* Y-axis gridlines + labels */}
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

        {/* Zero baseline */}
        <line
          x1={padL} x2={width - padR}
          y1={y0} y2={y0}
          className="stroke-club-green-800/40"
          strokeWidth={0.9}
        />

        {/* Bars — one set per series, one per category. Founder rule
            2026-07-13 v15.13 — reveal animation: positive bars grow
            upward from the zero baseline (`chart-anim-bar-up`,
            transform-origin bottom); negative bars grow downward
            (`chart-anim-bar-down`, transform-origin top). Series
            share the reveal window and stagger by a small per-
            series delay so the group reads as a coordinated sequence
            rather than a simultaneous pop. */}
        {series.map((s, sIdx) =>
          s.values.map((v, i) => {
            // Centre of the group, then offset by sub-slot index.
            const groupCentre = xAt(i);
            const subOffset = (sIdx - (series.length - 1) / 2) * subSlotW;
            const bx = groupCentre + subOffset - barW / 2;
            const top = Math.min(yAt(v), y0);
            const h = Math.abs(yAt(v) - y0);
            // Support either Tailwind class (e.g. "fill-club-green-500")
            // or inline hex (e.g. "#3f7042").
            const isHex = s.color.startsWith("#");
            const animClass = v >= 0 ? "chart-anim-bar-up" : "chart-anim-bar-down";
            // Sub-slot stagger — founder rule 2026-07-13 v15.13.1
            // "keep any series stagger subtle, approximately 75–125 ms".
            // 100 ms per series lands squarely in the founder's window:
            // 3-series groups (Actual / Budget / Prior Year) get 0 /
            // 100 / 200 ms lead-in — perceptible as coordinated
            // rather than simultaneous, without dragging the reveal.
            const delayMs = sIdx * 100;
            const baseClass = isHex ? "" : s.color;
            return (
              <rect
                key={`b-${sIdx}-${i}`}
                x={bx}
                y={top}
                width={barW}
                height={Math.max(1, h)}
                className={`${baseClass} ${animClass}`.trim()}
                {...(isHex ? { fill: s.color } : {})}
                style={{ animationDelay: `${delayMs}ms` }}
              />
            );
          }),
        )}

        {/* X-axis category labels. v15.5 — letterSpacing removed
            so the grouped bar chart's category labels match the
            Equity Value Over Time canonical typography exactly.
            Font size + weight already flow from CHART_AXES. */}
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

        {/* Legend — centred filled-rect samples that mirror the bar
            colours, packed tight like the line chart's legend. */}
        {(() => {
          const PREVIEW_W = 16;
          const PREVIEW_TO_LABEL_GAP = 5;
          const ITEM_SPACING = 22;
          // v15.5 — legend font size sourced from the shared
          // CHART_AXES token so grouped-bar / bar / line charts
          // share one value.
          const FONT_SIZE = CHART_AXES.legendFontSize;
          const CHAR_W = 4.8;
          const itemWidths = series.map(
            (s) => PREVIEW_W + PREVIEW_TO_LABEL_GAP + s.name.length * CHAR_W,
          );
          const totalWidth =
            itemWidths.reduce((s, w) => s + w, 0) +
            (series.length - 1) * ITEM_SPACING;
          const chartCentreX = padL + innerW / 2;
          const groupStartX = chartCentreX - totalWidth / 2;
          const yLegend = vbH - padB + 34;
          const xStarts: number[] = [];
          let cursor = groupStartX;
          for (let i = 0; i < series.length; i++) {
            xStarts.push(cursor);
            cursor += itemWidths[i] + ITEM_SPACING;
          }
          return (
            <g>
              {series.map((s, i) => {
                const isHex = s.color.startsWith("#");
                const xLeft = xStarts[i];
                return (
                  <g key={`lg-${i}`}>
                    <rect
                      x={xLeft}
                      y={yLegend - 8}
                      width={PREVIEW_W}
                      height={9}
                      {...(isHex
                        ? { fill: s.color }
                        : { className: s.color })}
                    />
                    <text
                      x={xLeft + PREVIEW_W + PREVIEW_TO_LABEL_GAP}
                      y={yLegend - 0.5}
                      textAnchor="start"
                      className="fill-club-green-800/70"
                      style={{ fontSize: `${FONT_SIZE}px` }}
                    >
                      {s.name}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

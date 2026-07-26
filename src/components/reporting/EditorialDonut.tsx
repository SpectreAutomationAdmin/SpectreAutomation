"use client";

// Canonical donut chart — the SINGLE donut every Monthly Board
// Reporting Package chapter renders. Generalized from the Financial
// Performance chapter's `DuesSubsidyDonut` (which is preserved as a
// thin wrapper) to support Chapters XI–XIV donuts (weather pattern,
// payroll distribution, F&B category mix) without duplication.
//
// Geometry (locked, matches FP):
//   - viewBox 200 × 200
//   - radius 80, restStrokeWidth 36, activeStrokeWidth 44
//   - GAP_DEG 0.8° (cream sliver between arcs)
//   - All values are exported from `chart-theme.ts` (DONUT_GEOMETRY).
//
// Hover model:
//   - Per-slice hover ONLY — never the chart card.
//   - Hovered slice: stroke thickens 36→44 + drop-shadow.
//   - All other slices + the card container stay exactly as they
//     render at rest.
//   - Two hover detection modes:
//     * 'geometry' — wrapper-level polar-angle lookup (the FP
//       DuesSubsidyDonut original). Robust to Playwright .hover()
//       which targets bbox centre.
//     * 'per-slice' — per-arc mouseEnter/mouseMove handlers (the
//       Weather/Payroll/F&B current implementations). Each slice is
//       its own hit target.
//   - The choice is API-level: pass `arcAngles` to opt into geometry
//     mode; omit it for per-slice mode. Both produce the same visual
//     result; per-slice is simpler when the chart already computes
//     arcs as percentages.

import { useState } from "react";

import {
  ACTIVE_SHADOW_FILTER_ID,
  DONUT_GEOMETRY,
} from "@/components/reporting/chart-theme";
import {
  ChartTooltip,
  type ChartTooltipModel,
} from "@/components/reporting/ChartTooltip";

/** Geometry-mode slice — angles drive the polar-lookup hit detection. */
export type DonutArcAngles = {
  /** Stable slice key (used for React list + per-slice testid). */
  key: string;
  /** Display label (shown in tooltip + optional legend). */
  label: string;
  /** Fill color — kebab-case Tailwind class OR hex. */
  color: string;
  /** Slice start angle in degrees, 0° = 12 o'clock, increasing CW. */
  arcStartAngle: number;
  /** Slice end angle in degrees. Must exceed arcStartAngle. */
  arcEndAngle: number;
};

/** Per-slice mode slice — percentage drives the arc length. */
export type DonutSlice = {
  key: string;
  label: string;
  /** Fill color — typically a hex from the reporting service. */
  fillHex: string;
  /** Slice fraction (e.g. 0.4 = 40 %). Sum across slices should
   *  approach 1; this primitive does not validate. */
  fraction: number;
};

export type EditorialDonutProps = {
  /** Slices to render. Use `slices` OR `arcAngles`, not both —
   *  see the hover-mode discussion above. */
  slices?: ReadonlyArray<DonutSlice>;
  arcAngles?: ReadonlyArray<DonutArcAngles>;
  /** Background ring color (for the "rest of the dial" hairline
   *  beneath the slices). Defaults to the FP cream. */
  trackColor?: string;
  /** Aria-label on the SVG root. */
  ariaLabel: string;
  /** Data-testid prefix. The SVG gets `${testidPrefix}-svg`; each
   *  slice gets `${testidPrefix}-slice-${key}`; the tooltip gets
   *  `${testidPrefix}-tooltip`. */
  testidPrefix: string;
  /** Build the tooltip model for the hovered slice. Returning null
   *  suppresses the tooltip (e.g. when there is no value to show). */
  buildTooltip: (slice: { key: string; label: string }) => {
    label: string;
    rows: ChartTooltipModel["rows"];
  } | null;
};

export function EditorialDonut({
  slices,
  arcAngles,
  trackColor = "#e6dcc4",
  ariaLabel,
  testidPrefix,
  buildTooltip,
}: EditorialDonutProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  const { viewBox, center, radius, restStrokeWidth, activeStrokeWidth, gapDeg } =
    DONUT_GEOMETRY;
  const circumference = 2 * Math.PI * radius;

  function handleSliceMouseMove(
    key: string,
    label: string,
    ev: React.MouseEvent<SVGElement>,
  ) {
    // VIEWPORT-RELATIVE cursor coords — the portal-rendered tooltip
    // positions itself with `position: fixed` so it can escape any
    // ancestor `overflow: hidden` and flip when near viewport edges.
    setMousePos({ x: ev.clientX, y: ev.clientY });
    setActiveKey(key);
    void label;
  }

  function clear() {
    setActiveKey(null);
    setMousePos(null);
  }

  // Tooltip resolution: look up the active slice + its build result.
  const activeSlice =
    activeKey != null
      ? (arcAngles?.find((s) => s.key === activeKey) as DonutArcAngles | undefined) ??
        (slices?.find((s) => s.key === activeKey) as DonutSlice | undefined)
      : undefined;
  const tooltipBody =
    activeSlice && mousePos
      ? buildTooltip({ key: activeSlice.key, label: activeSlice.label })
      : null;

  return (
    <div
      data-testid={`${testidPrefix}-wrap`}
      onMouseLeave={clear}
    >
      <svg
        data-testid={`${testidPrefix}-svg`}
        viewBox={`0 0 ${viewBox} ${viewBox}`}
        role="img"
        aria-label={ariaLabel}
        // overflow-visible so the wider activeStroke + drop-shadow
        // on the hovered slice are not clipped by the SVG edge.
        className="block h-[200px] w-[200px] overflow-visible"
        style={{ shapeRendering: "geometricPrecision" }}
      >
        <defs>
          {/* Premium drop shadow for the active slice. Filter defs
              are scoped to the containing <svg>; the id is shared
              via `ACTIVE_SHADOW_FILTER_ID` so every chart uses the
              same filter (DRY enforcement). */}
          <filter
            id={ACTIVE_SHADOW_FILTER_ID}
            x="-20%"
            y="-20%"
            width="140%"
            height="140%"
          >
            <feDropShadow
              dx="0"
              dy="0.6"
              stdDeviation="1.8"
              floodColor="#1c2f1c"
              floodOpacity="0.35"
            />
          </filter>
        </defs>

        {/* Background ring hairline (the cream "rest of dial"). */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={trackColor}
          strokeWidth={restStrokeWidth}
        />

        {/* Founder rule 2026-07-13 v15.13 — reveal group. The whole
            donut sweeps into place from a consistent starting angle
            (a small counter-clockwise rotation) combined with a
            gentle opacity fade, so every segment reveals as a single
            editorial gesture rather than a per-slice cascade. The
            transform-origin is pinned to the SVG centre in globals.css
            so the sweep rotates around the donut hub, not the SVG
            corner. Wrapping BOTH render modes (per-slice + arcAngles)
            in the same group ensures no matter which mode a chapter
            uses, the reveal behaviour is identical. */}
        <g className="chart-anim-donut">
          {/* Render mode A: per-slice fraction → stroke-dasharray.
              Each slice arc is SHORTENED by `gapDeg/2` on each side
              (just like arcAngles mode) so a cream sliver shows
              between adjacent slices. This matches the Financial
              Performance DuesSubsidyDonut treatment exactly. The
              arc length in pixels equals `circumference × gapDeg /
              360 / 2` per side. */}
          {slices
            ? (() => {
                const gapPx = (gapDeg / 360) * circumference;
                let accumulated = 0;
                return slices.map((slice) => {
                  const fullDash = slice.fraction * circumference;
                  // Shrink dash by gapPx (half on each end) — but
                  // never go negative for very small slices.
                  const dash = Math.max(0.5, fullDash - gapPx);
                  const gap = circumference - dash;
                  // Shift the dashoffset by half a gap so the
                  // shortened arc is centred where the full arc
                  // would have been.
                  const offset = -(accumulated * circumference + gapPx / 2);
                  accumulated += slice.fraction;
                  const isActive = slice.key === activeKey;
                  return (
                    <circle
                      key={slice.key}
                      data-testid={`${testidPrefix}-slice-${slice.key}`}
                      data-active={isActive ? "true" : "false"}
                      cx={center}
                      cy={center}
                      r={radius}
                      fill="none"
                      stroke={slice.fillHex}
                      strokeWidth={isActive ? activeStrokeWidth : restStrokeWidth}
                      strokeDasharray={`${dash} ${gap}`}
                      strokeDashoffset={offset}
                      transform={`rotate(-90 ${center} ${center})`}
                      filter={isActive ? `url(#${ACTIVE_SHADOW_FILTER_ID})` : undefined}
                      className="cursor-pointer transition-[stroke-width] duration-150"
                      onMouseEnter={(e) => handleSliceMouseMove(slice.key, slice.label, e)}
                      onMouseMove={(e) => handleSliceMouseMove(slice.key, slice.label, e)}
                    />
                  );
                });
              })()
            : null}

          {/* Render mode B: explicit arc start/end angles. */}
          {arcAngles
            ? arcAngles.map((arc) => {
                const adjStart = arc.arcStartAngle + gapDeg / 2;
                const adjEnd = arc.arcEndAngle - gapDeg / 2;
                const isActive = arc.key === activeKey;
                return (
                  <path
                    key={arc.key}
                    data-testid={`${testidPrefix}-slice-${arc.key}`}
                    data-active={isActive ? "true" : "false"}
                    d={describeArc(center, center, radius, adjStart, adjEnd)}
                    stroke={arc.color}
                    strokeWidth={isActive ? activeStrokeWidth : restStrokeWidth}
                    fill="none"
                    strokeLinecap="butt"
                    filter={isActive ? `url(#${ACTIVE_SHADOW_FILTER_ID})` : undefined}
                    className="cursor-pointer transition-[stroke-width] duration-150"
                    onMouseEnter={(e) => handleSliceMouseMove(arc.key, arc.label, e)}
                    onMouseMove={(e) => handleSliceMouseMove(arc.key, arc.label, e)}
                  />
                );
              })
            : null}
        </g>
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

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

function describeArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

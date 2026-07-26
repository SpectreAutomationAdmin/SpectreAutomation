"use client";

// Canonical chart tooltip — the SINGLE tooltip every reporting-
// package chart renders. Consumed by `EditorialDonut`,
// `EditorialBarChart`, `EditorialLineChart` and any future chart
// primitive.
//
// Visual contract (locked 2026-06-19 per founder direction):
//   - Dark club green background at 85% opacity (translucent — the
//     hovered slice / bar must remain perceivable through the panel)
//   - Subtle ring + lifted shadow → floating-glass feel
//   - NO backdrop-blur (blurring the chart defeats the "visible
//     beneath the tooltip" intent)
//   - Cream typography fully opaque (high contrast on the translucent
//     bg)
//   - Small-caps label (eyebrow) above tabular-nums value rows
//
// Positioning + clipping (locked 2026-06-20 per founder direction):
//   - Tooltip is rendered through a React PORTAL into document.body
//     so it can never be clipped by an ancestor's overflow/border.
//   - Position is VIEWPORT-RELATIVE (`position: fixed`); we receive
//     the cursor's client-x/client-y from the chart's mouse handler.
//   - Default offset is +12 px X / −12 px Y (right of + slightly
//     above the cursor) so the cursor is never under the tooltip.
//   - EDGE FLIP: after the tooltip mounts, we measure its bounding
//     rect and the viewport size; if the tooltip would overflow
//     right/bottom we flip its position to left/above the cursor.
//     The cursor stays "anchored" to the tooltip — it never has to
//     leave the screen.
//
// The tooltip is `pointer-events: none` so it never intercepts the
// mouse — the parent chart's hover handlers continue to receive
// events as the cursor moves over the tooltip's footprint.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { TOOLTIP_STYLE } from "@/components/reporting/chart-theme";

export type ChartTooltipRow = {
  /** Stable row key for the React list + per-row testid. */
  key: string;
  /** Display text — typically a numeric value with a unit label
   *  ("245 avg rounds/day", "+$120K vs. plan"). */
  text: string;
};

export type ChartTooltipModel = {
  /** VIEWPORT-RELATIVE cursor x (i.e. event.clientX). */
  x: number;
  /** VIEWPORT-RELATIVE cursor y (i.e. event.clientY). */
  y: number;
  /** Eyebrow label — the category / series name (e.g. "Sunny",
   *  "F&B Revenue", "Front of House"). */
  label: string;
  /** Body rows — typically 1-3 lines of values + context. */
  rows: ReadonlyArray<ChartTooltipRow>;
};

const OFFSET_X = 12;
const OFFSET_Y = 12;
/** Min gap between the tooltip and any viewport edge. */
const VIEWPORT_PAD = 8;
/** Conservative dimension estimates used to compute the initial
 *  flipped placement during render — BEFORE the tooltip mounts and
 *  the layout-effect can measure actual dimensions. The first paint
 *  lands the tooltip in the correct flipped position so the founder
 *  never sees a frame where the tooltip is clipped at the right /
 *  bottom edges. The layout-effect then refines using actual rect
 *  for sub-pixel correctness. */
const ESTIMATED_WIDTH = 220;
const ESTIMATED_HEIGHT = 64;

/** Compute the tooltip's viewport-relative placement given cursor
 *  coords + the tooltip's measured (or estimated) dimensions. Flips
 *  the tooltip when it would clip the right or top viewport edge
 *  and clamps inside the viewport in pathological cases. Used both
 *  in the initial render (with estimated dims) and in the post-mount
 *  layout-effect (with measured dims). */
function computePlacement(
  cursorX: number,
  cursorY: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  let left = cursorX + OFFSET_X;
  let top = cursorY - OFFSET_Y - height;

  // Flip horizontally if the tooltip would overflow the right edge.
  if (left + width + VIEWPORT_PAD > viewportWidth) {
    left = cursorX - OFFSET_X - width;
  }
  // Pathological clamp (narrow viewport).
  if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
  if (left + width > viewportWidth - VIEWPORT_PAD) {
    left = Math.max(VIEWPORT_PAD, viewportWidth - VIEWPORT_PAD - width);
  }

  // Flip vertically if the tooltip would overflow the top edge.
  if (top < VIEWPORT_PAD) {
    top = cursorY + OFFSET_Y;
  }
  // Clamp if it would overflow the bottom edge.
  if (top + height + VIEWPORT_PAD > viewportHeight) {
    top = Math.max(VIEWPORT_PAD, viewportHeight - VIEWPORT_PAD - height);
  }
  return { left, top };
}

export function ChartTooltip({
  tooltip,
  testidPrefix = "chart",
}: {
  tooltip: ChartTooltipModel;
  /** Override the data-testid prefix. Defaults to "chart" so the
   *  tooltip data-testid is "chart-tooltip" and rows are
   *  "chart-tooltip-row-{key}". Per-chapter charts can pass their
   *  own prefix (e.g. "weather-chart", "payroll-chart") if existing
   *  tests select by that prefix. */
  testidPrefix?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Compute the initial placement DURING render using estimated
  // dimensions, so the first paint already has the flipped position
  // when the cursor is near a viewport edge. The layout-effect below
  // refines with measured dimensions for sub-pixel correctness.
  const initialVw =
    typeof window !== "undefined" ? window.innerWidth : 1440;
  const initialVh =
    typeof window !== "undefined" ? window.innerHeight : 900;
  const [placement, setPlacement] = useState<{ left: number; top: number }>(
    () =>
      computePlacement(
        tooltip.x,
        tooltip.y,
        ESTIMATED_WIDTH,
        ESTIMATED_HEIGHT,
        initialVw,
        initialVh,
      ),
  );

  // Portal target — `document.body`. Resolved lazily on the client.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof document !== "undefined") setPortalTarget(document.body);
  }, []);

  // After every render, re-measure the tooltip and refine the
  // placement using the actual rect (the initial render used
  // estimated dimensions). useLayoutEffect runs synchronously before
  // paint, so the refined position lands on the visible frame if the
  // estimate was off.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const refined = computePlacement(
      tooltip.x,
      tooltip.y,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight,
    );
    setPlacement((prev) => {
      if (
        Math.abs(prev.left - refined.left) < 0.5 &&
        Math.abs(prev.top - refined.top) < 0.5
      ) {
        return prev;
      }
      return refined;
    });
  }, [tooltip.x, tooltip.y, tooltip.label, tooltip.rows]);

  const node = (
    <div
      ref={ref}
      data-testid={`${testidPrefix}-tooltip`}
      className={
        "pointer-events-none fixed z-[60] " +
        `${TOOLTIP_STYLE.radiusClass} ${TOOLTIP_STYLE.backgroundClass} ` +
        `${TOOLTIP_STYLE.paddingClass} ${TOOLTIP_STYLE.shadowClass} ` +
        `${TOOLTIP_STYLE.ringClass}`
      }
      style={{
        left: placement.left,
        top: placement.top,
      }}
    >
      <p
        data-testid={`${testidPrefix}-tooltip-label`}
        className={`${TOOLTIP_STYLE.labelClass} ${TOOLTIP_STYLE.labelColorClass}`}
      >
        {tooltip.label}
      </p>
      <div className="mt-1 space-y-0.5">
        {tooltip.rows.map((row) => (
          <p
            key={row.key}
            data-testid={`${testidPrefix}-tooltip-row-${row.key}`}
            className={`${TOOLTIP_STYLE.bodyClass} ${TOOLTIP_STYLE.bodyColorClass}`}
          >
            {row.text}
          </p>
        ))}
      </div>
    </div>
  );

  if (!portalTarget) return null;
  return createPortal(node, portalTarget);
}

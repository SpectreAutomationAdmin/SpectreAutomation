"use client";

// Saguaro-style donut chart for the Dues Subsidy Analysis card.
// Extracted from the server-rendered version in page.tsx into a client
// component so it can own:
//
//   1. Hover state for the per-slice tooltip (Saguaro convention:
//      restrained dark-green slab pointing at the hovered slice with
//      category name + percentage).
//   2. Cream-coloured separator slivers between arcs (achieved by
//      shortening each arc by a half-gap on each side; small slices
//      stay visible because the gap is a FIXED degree value, not a
//      percent of the slice).
//
// Geometry contract:
//   - viewBox 200 × 200 (square, uniform scale)
//   - centre (100, 100), arc radius 80, stroke-width 28 → donut ring
//   - GAP_DEG = 0.8 → 0.4° of cream sliver on each side of each arc
//   - Tooltip is absolute-positioned over the donut wrapper; offset
//     by 12 / −36 px from the cursor so it doesn't sit under the
//     mouse pointer.

import { useState, type ReactNode } from "react";

import { DONUT_GEOMETRY } from "@/components/reporting/chart-theme";

export type DuesArc = {
  key: string;
  label: string;
  pct: number;
  color: string;
  arcStartAngle: number;
  arcEndAngle: number;
};

// 2026-06-20 — geometry constants now flow from the canonical
// chart-theme.ts so the Weather donut (EditorialDonut) and the FP
// DuesSubsidy donut share one source of truth. Bumping the theme
// updates BOTH charts in lockstep, satisfying the founder's "same
// design system, same product family" rule.
const VIEWBOX = DONUT_GEOMETRY.viewBox;
const CX = DONUT_GEOMETRY.center;
const CY = DONUT_GEOMETRY.center;
const R = DONUT_GEOMETRY.radius;
const STROKE_WIDTH = DONUT_GEOMETRY.restStrokeWidth;
const GAP_DEG = DONUT_GEOMETRY.gapDeg;

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

/** Convert mouse position (in viewBox coords) to polar angle.
 *  Returns degrees with 0° at 12 o'clock and increasing clockwise —
 *  matching the angle convention the dues-subsidy service uses to
 *  emit arcStartAngle / arcEndAngle. */
function angleFromCenter(vbX: number, vbY: number): number {
  const dx = vbX - CX;
  const dy = vbY - CY;
  // atan2(dx, -dy) puts 0° at 12 o'clock and rotates clockwise.
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Look up which slice the given polar angle falls into. */
function findSliceAt(angle: number, categories: DuesArc[]): DuesArc | null {
  for (const c of categories) {
    if (angle >= c.arcStartAngle && angle <= c.arcEndAngle) return c;
  }
  return null;
}

export function DuesSubsidyDonut({ categories }: { categories: DuesArc[] }): ReactNode {
  const [hovered, setHovered] = useState<DuesArc | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  /** Detect hover by GEOMETRY rather than per-path events.
   *
   *  Why not just rely on SVG <path>'s mouse events? With fill="none",
   *  the path is only hoverable along its stroked pixels. The bounding
   *  box of a thin arc is large (an angular sector) but most of it is
   *  the empty hole + outside, so cursors that drift through the donut
   *  ring's "filled" wedge area but not on the stroked pixel column
   *  never fire the path's onMouseEnter. Playwright's .hover() is
   *  especially exposed because it targets the bbox centre which often
   *  sits in the hole.
   *
   *  Instead, the wrapper captures mouse position, converts to viewBox
   *  coordinates, checks the distance from centre (only fire when the
   *  cursor is in the donut ring), then computes the polar angle and
   *  looks up the slice. This makes the entire ring's wedge area a
   *  valid hit target.
   */
  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const wrap = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - wrap.left;
    const y = e.clientY - wrap.top;
    setMousePos({ x, y });

    // Convert wrapper-relative px → viewBox px (wrapper width may
    // differ from the 200 vb units; the SVG fills it).
    const vbX = (x / wrap.width) * VIEWBOX;
    const vbY = (y / wrap.height) * VIEWBOX;
    const dist = Math.hypot(vbX - CX, vbY - CY);

    // Donut ring sits at radius R ± STROKE_WIDTH/2 = 80 ± 14 = [66, 94].
    const innerR = R - STROKE_WIDTH / 2;
    const outerR = R + STROKE_WIDTH / 2;
    if (dist < innerR || dist > outerR) {
      setHovered(null);
      return;
    }
    const angle = angleFromCenter(vbX, vbY);
    setHovered(findSliceAt(angle, categories));
  }

  return (
    <div
      data-testid="dues-subsidy-donut"
      className="relative"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHovered(null)}
    >
      <svg
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
        role="img"
        aria-label="Dues allocation donut"
        className="block h-auto w-full"
        style={{ shapeRendering: "geometricPrecision" }}
      >
        {/* Founder rule 2026-07-13 v15.13.2 — shared reveal gate.
            `DuesSubsidyDonut` is a bespoke donut (not the shared
            `EditorialDonut`) so a wrapping `EditorialChartReveal`
            can't animate it without a shared class hook. Wrapping
            BOTH the arcs in `<g className="chart-anim-donut">` gives
            this donut the same sweep-into-place reveal as the
            shared `EditorialDonut` while preserving the geometry-
            hover model + tooltip below. Outside a reveal wrapper
            the class is inert — the CSS selector requires the
            ancestor `data-editorial-chart-revealed` attribute. */}
        <g className="chart-anim-donut">
          {categories.map((c) => {
            // Shorten each arc by GAP_DEG / 2 on each side so cream
            // shows through between adjacent arcs. The visual sliver is
            // ~0.4° wide which is small enough that 1 %-slices (3.6°)
            // still render visibly.
            const adjStart = c.arcStartAngle + GAP_DEG / 2;
            const adjEnd = c.arcEndAngle - GAP_DEG / 2;
            return (
              <path
                key={c.key}
                d={describeArc(CX, CY, R, adjStart, adjEnd)}
                stroke={c.color}
                strokeWidth={STROKE_WIDTH}
                fill="none"
                strokeLinecap="butt"
                data-testid={`dues-arc-${c.key}`}
                data-gap-deg={GAP_DEG}
                style={{ cursor: "pointer", pointerEvents: "none" }}
              />
            );
          })}
        </g>
      </svg>

      {/* Saguaro-style tooltip — restrained dark-green slab, cream
          text, follows the cursor with a 12 / −36 px offset so it
          doesn't sit under the pointer. */}
      {hovered ? (
        <div
          role="tooltip"
          data-testid="dues-subsidy-tooltip"
          style={{
            position: "absolute",
            left: (mousePos?.x ?? 0) + 12,
            top: (mousePos?.y ?? 0) - 36,
            backgroundColor: "rgba(42, 61, 37, 0.96)",
            color: "rgb(248, 245, 239)",
            padding: "6px 10px",
            fontSize: "11px",
            lineHeight: 1.35,
            pointerEvents: "none",
            borderRadius: "3px",
            whiteSpace: "nowrap",
            boxShadow: "0 1px 4px rgba(0, 0, 0, 0.20)",
            zIndex: 5,
            fontFamily: "var(--font-serif), Georgia, serif",
          }}
        >
          <div style={{ fontWeight: 600 }}>{hovered.label}</div>
          <div style={{ opacity: 0.85 }}>
            {hovered.label}: {hovered.pct}%
          </div>
        </div>
      ) : null}
    </div>
  );
}

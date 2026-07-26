"use client";

// Responsive editorial line chart for the Equity Value Over Time
// stewardship panel. Extracted from
// src/app/app/admin/reporting/monthly/page.tsx as a client component
// so it can track its container width via ResizeObserver and update
// the SVG viewBox dynamically. This is the fix for the bug observed
// at viewports ≥ 1600 px: with a fixed viewBox of 600×200 and
// preserveAspectRatio="xMidYMid meet", the SVG capped at its viewBox
// aspect and left cream gutters totalling 221 px at 1920+. With the
// viewBox width slaved to the measured container width, the SVG
// always renders at uniform scale 1.0 with no horizontal letterbox,
// and the plot region grows with the card.
//
// Geometry contract preserved from the server-rendered version:
//   - padL = 66, padR = 31 (viewBox units, now == rendered px at scale 1.0)
//   - padT = 6, padB = 36 (with legend) / 20 (without)
//   - viewBox height = max(200, props.height); viewBox width = measured container width
//   - preserveAspectRatio default ("xMidYMid meet") — UNIFORM scale,
//     NEVER preserveAspectRatio="none"
//   - shapeRendering / textRendering = geometricPrecision

import { useEffect, useRef, useState } from "react";

import { CHART_AXES } from "@/components/reporting/chart-theme";
import { ChartTooltip } from "@/components/reporting/ChartTooltip";

// Founder rule 2026-07-05 v15.5 — this primitive now READS from
// `CHART_AXES` (single source of truth). The prior version
// hardcoded 9 / 9 / 9.5 px because the "boardroom bump"
// (2026-06-22) had pushed the shared tokens to 12 / 13 px and
// would have broken the Equity Value Over Time card's y-label →
// KPI tile alignment invariant. v15.5 collapses that split by
// re-canonicalising the tokens to the Equity chart's values
// (9 / 9 / 9.5), so every editorial chart — line, bar, grouped,
// interactive — now reads identical axis typography.

export type LineSpec = {
  /** Per-x-slot values. A `null` value SKIPS that slot — no marker,
   *  no line segment touches it. Used to represent "no data yet" on
   *  YTD trend charts where the x-axis covers a full fiscal year but
   *  the actual series only extends through the reporting month. */
  values: (number | null)[];
  /** Tailwind stroke colour class — e.g. "stroke-club-green-500". */
  stroke: string;
  /** Stroke width in px. */
  width: number;
  /** SVG dash-array; omit for solid line. */
  dasharray?: string;
  /** Optional opacity 0..1. */
  opacity?: number;
  /** If true, draw circular point markers at every NON-null data point. */
  markers?: boolean;
  /** Tailwind fill class for the markers. Defaults to the line's
   *  stroke colour. */
  markerFill?: string;
  /** Tailwind fill class for the veiled area beneath the line — e.g.
   *  "fill-club-green-500/10". The area fills only the continuous
   *  run of non-null values starting from index 0; the moment a null
   *  is encountered, the area ends. */
  areaFill?: string;
};

/** Legend entry for a line chart. The legend's visual "preview" is
 *  drawn from the SAME styling that drives the actual chart line —
 *  short stroke segment + optional centred marker — so the legend
 *  always previews what is on screen. (Bar charts use a different
 *  filled-swatch shape; that legend type lives inline alongside
 *  EditorialBarChart in page.tsx.) */
export type LegendEntry = {
  label: string;
  /** Tailwind stroke class — must match the chart line. */
  stroke: string;
  /** Stroke width in px — must match the chart line. */
  strokeWidth: number;
  /** Dash pattern — must match the chart line. Omit for solid. */
  dasharray?: string;
  /** Opacity 0..1 — must match the chart line. */
  opacity?: number;
  /** Draw a circular point marker centred on the preview segment.
   *  Used for the "Club Equity" series which carries data-point
   *  markers on the chart itself. */
  showMarker?: boolean;
  /** Tailwind fill class for the marker. Defaults to deriving from
   *  the stroke class (e.g. stroke-club-green-500 → fill-club-green-500). */
  markerFill?: string;
};

/** Serialisable y-axis tick format spec — passed across the server →
 *  client component boundary. The client component reconstructs the
 *  formatter inline, since React Server Components cannot serialise
 *  closures. */
export type FormatYSpec =
  | "dollars-millions"     // 28 → "$28M" (caller pre-scales to millions)
  | "dollars-millions-1d"  // 28.5 → "$28.5M"
  | "dollars-thousands"    // 245 → "$245K" (caller pre-scales to thousands)
  // Founder rule 2026-07-05 v15.9 — auto-scaling compact currency.
  // Caller passes RAW DOLLARS; formatter picks K / M per tick.
  // See EditorialBarChart for the canonical spec + rationale.
  | "dollars-compact"
  // Founder rule 2026-07-05 v15.12.1 — one-decimal auto-scaling
  // compact currency. Same "raw dollars in, K/M out" semantics as
  // `dollars-compact` but with a one-decimal `.X` precision under
  // $1M (48_200 → "$48.2K") and a one-decimal `.X` precision at or
  // above $1M (1_250_000 → "$1.3M"). Consumed by the F&B Inventory
  // Balances tooltip so hovered values read at the same precision
  // as the KPI ribbon above the chart. Introduced when replacing
  // the per-call-site closure formatter (which was violating the
  // RSC serialisation boundary) with this shared, JSON-safe
  // descriptor.
  | "dollars-compact-1d"
  | "percent"              // 21.7 → "21.7%"
  | "raw";                 // 18 → "18"

/** Founder rule 2026-07-05 v15.12 — shared editorial line-chart
 *  interaction. Every Spectre line chart snaps to the nearest x-slot
 *  under the cursor, draws a subtle vertical guide line, enlarges
 *  the active marker(s), and renders the canonical `ChartTooltip`
 *  with the period header + one row per surfaced line.
 *
 *  The tooltip spec is declarative — a chart opts in by passing an
 *  `xHeaders` string (one per x-slot, e.g. "May 2026" or "2024") +
 *  a `lineLabels` array (one entry per `lines`, `null` to omit that
 *  line from the tooltip body — the standard treatment for
 *  benchmark / budget / prior-year overlays that clutter the
 *  callout with values the reader doesn't need at hover time).
 *
 *  Design principle: the Bank of Canada exchange-rate chart is the
 *  interaction-quality reference, not the visual reference. Spectre
 *  keeps its own editorial tooltip (portal-based `ChartTooltip` with
 *  the club-green translucent panel + cream serif label) — only the
 *  hover behaviour is upgraded.
 *
 *  RSC SERIALISATION CONTRACT (v15.12.1) — this type is passed from
 *  Server Components (`MonthlyReportingPackageBody`, the
 *  `FoodBeverageChartCards` / `InventoryChartCards` islands' page
 *  wrappers) into the CLIENT Component below. Every field MUST be
 *  JSON-serialisable — strings, numbers, primitives, or arrays of
 *  those. FUNCTIONS ARE FORBIDDEN: Next.js will throw
 *  "Functions cannot be passed directly to Client Components…" at
 *  runtime the moment a caller re-introduces one. This is why the
 *  value formatter is a `FormatYSpec` descriptor (a string union)
 *  and NOT a `(v: number) => string` closure. */
export type LineChartTooltipSpec = {
  /** Pre-formatted period header displayed in the tooltip's small-
   *  caps eyebrow — one string per x-slot. Length MUST equal
   *  `xLabels.length`. Examples:
   *    - "May 2026" for a monthly trend chart
   *    - "2024" for the Equity Value Over Time fiscal-year chart */
  xHeaders: string[];
  /** One entry per `lines` (same order). Non-null entries become
   *  tooltip rows (e.g. "Payroll Ratio", "Food Inventory"); a `null`
   *  omits that line entirely — the standard treatment for the
   *  dashed benchmark / budget / prior-year overlays that shouldn't
   *  appear in the hover callout. */
  lineLabels: (string | null)[];
  /** Serialisable formatter descriptor for the numeric value shown
   *  next to each surfaced line label. The client-side chart looks
   *  the formatter up internally via `applyFormatY`. Defaults to
   *  the chart's `formatY` spec when omitted — a chart whose y-axis
   *  already reads in the right precision (e.g. Payroll Ratio at
   *  `formatY="percent"`) can omit this. Charts whose tooltip
   *  precision differs from the y-axis (e.g. Equity, where the
   *  y-axis rounds to whole $M but the tooltip should read "$28.9M")
   *  pass an override such as `"dollars-millions-1d"`. */
  valueFormat?: FormatYSpec;
};

export type EditorialLineChartProps = {
  xLabels: string[];
  lines: LineSpec[];
  height: number;
  yTicks?: number;
  formatY?: FormatYSpec;
  yDomain?: [number, number];
  legend?: LegendEntry[];
  /** Founder rule 2026-07-05 v15.12 — opt-in tooltip + interaction
   *  spec. When present, the chart runs the shared hover model
   *  (nearest x-snap, vertical guide, active-marker emphasis,
   *  ChartTooltip). When omitted, the chart falls back to its
   *  pre-v15.12 read-only rendering. */
  tooltip?: LineChartTooltipSpec;
  /** Left padding in viewBox px — the gutter between the SVG left
   *  edge and the start of the plot region. Y-axis tick labels live
   *  in this band, right-anchored at (padLeft − 8).
   *
   *  Default 66 matches the original Saguaro-tier reference (a generous
   *  axis band). Reporting surfaces that need the y-axis label column
   *  to visually align with an adjacent column of content (e.g. the
   *  Actual CAGR KPI tile sitting directly above the chart band) pass
   *  a smaller value — for the Equity Value Over Time card, 44 lands
   *  the y-text LEFT edge within ~1 px of the KPI tile LEFT edge. */
  padLeft?: number;
  /** Right padding in viewBox px — the gutter between the rightmost
   *  plotted point and the SVG right edge. Default 31 is the original
   *  Saguaro-tier reference. Surfaces that align the rightmost data
   *  point with an adjacent column (e.g. the right edge of the
   *  Current Equity KPI tile) pass a smaller value — for the Equity
   *  Value Over Time card, 14 lands the FY2025 marker within ~1 px of
   *  the Current Equity tile RIGHT edge. */
  padRight?: number;
  /** X-axis label density. Omit to use the default auto-step
   *  (`n > 8 ? ceil(n/6) : 1`). Pass `1` to FORCE every label to
   *  render — used by the Payroll Ratio Monthly Trend chart which is
   *  an executive board-report surface where all 12 month labels
   *  must remain visible regardless of density. */
  xLabelStep?: number;
};

function applyFormatY(spec: FormatYSpec | undefined, v: number): string {
  switch (spec) {
    case "dollars-millions":    return `$${Math.round(v)}M`;
    case "dollars-millions-1d": return `$${v.toFixed(1)}M`;
    case "dollars-thousands":   return `$${Math.round(v)}K`;
    case "dollars-compact": {
      const sign = v < 0 ? "-" : "";
      const abs = Math.abs(v);
      if (abs >= 1_000_000) {
        const label = (abs / 1_000_000).toFixed(1).replace(/\.0$/, "");
        return `${sign}$${label}M`;
      }
      return `${sign}$${Math.round(abs / 1_000)}K`;
    }
    case "dollars-compact-1d": {
      const sign = v < 0 ? "-" : "";
      const abs = Math.abs(v);
      if (abs >= 1_000_000) {
        return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
      }
      return `${sign}$${(abs / 1_000).toFixed(1)}K`;
    }
    case "percent":             return `${v.toFixed(1)}%`;
    case "raw":
    default:                    return String(Math.round(v));
  }
}

// SSR-safe default width — matches the legacy viewBox so the
// pre-hydration render looks correct on the typical laptop viewport.
// ResizeObserver overrides on mount.
const SSR_DEFAULT_WIDTH = 600;

export function EditorialLineChart({
  xLabels, lines, height, yTicks = 4, formatY, yDomain, legend, padLeft, padRight, xLabelStep,
  tooltip,
}: EditorialLineChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(SSR_DEFAULT_WIDTH);
  // Founder rule 2026-07-13 v15.13 — animation gating lives in CSS
  // via the parent `EditorialChartReveal` wrapper's
  // `data-editorial-chart-revealed` attribute. This chart primitive
  // simply emits the `chart-anim-*` classes on its animated SVG
  // elements; the wrapper's ancestor selector activates them. Outside
  // the wrapper, the classes have no default styling and the chart
  // renders exactly as it did pre-v15.13. */
  // Founder rule 2026-07-05 v15.12 — nearest-x hover state. Null
  // when the pointer is outside the plot region; otherwise the
  // currently-snapped x-slot index + viewport-relative cursor coords
  // for the shared ChartTooltip.
  const [hover, setHover] = useState<{
    index: number;
    clientX: number;
    clientY: number;
  } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Set the initial width from the real layout immediately on mount
    // so the first paint after hydration is correct, not the SSR
    // default.
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
    // The effect should run once; we deliberately ignore containerWidth
    // in the dep array to avoid a tight re-observe loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Padding and viewBox geometry.
  const padL = padLeft ?? 66;
  const padR = padRight ?? 31;
  const padT = 6;
  const padB = legend && legend.length ? 36 : 20;
  // viewBox width = measured container width (in CSS px). Because
  // CSS px == viewBox units here, the SVG renders at uniform scale 1.0
  // with no horizontal letterbox at any viewport size.
  const width = Math.max(200, containerWidth);
  const vbH = Math.max(200, height);
  const innerW = Math.max(0, width - padL - padR);
  const innerH = Math.max(0, vbH - padT - padB);

  // Y domain
  let yLo: number;
  let yHi: number;
  if (yDomain) {
    [yLo, yHi] = yDomain;
  } else {
    // Skip nulls so the auto-domain isn't blown out by NaN from
    // Math.min(null) / Math.max(null).
    const allValues = lines.flatMap((l) => l.values).filter((v): v is number => v != null);
    const yMin = allValues.length > 0 ? Math.min(...allValues) : 0;
    const yMax = allValues.length > 0 ? Math.max(...allValues) : 1;
    const span = yMax - yMin || 1;
    yLo = yMin - span * 0.06;
    yHi = yMax + span * 0.06;
  }

  const n = Math.max(1, xLabels.length);
  const xAt = (i: number) => padL + (innerW * i) / (n - 1 || 1);
  const yAt = (v: number) => padT + innerH * (1 - (v - yLo) / (yHi - yLo));
  const yTicksArr = Array.from({ length: yTicks + 1 }, (_, i) => yLo + (yHi - yLo) * (i / yTicks));

  /** Build an SVG path from a values array that may contain nulls.
   *  Null entries are gaps — the path issues a fresh `M` move on
   *  the next non-null index instead of an `L` line-to. This is the
   *  primitive that lets a 12-month chart plot an "actual" series
   *  through only the first N months: indices N..11 are null →
   *  no line segment is drawn there. */
  const linePath = (values: (number | null)[]) => {
    let path = "";
    let pendingMove = true;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) { pendingMove = true; continue; }
      const cmd = pendingMove ? "M" : "L";
      path += `${cmd} ${xAt(i).toFixed(2)} ${yAt(v).toFixed(2)} `;
      pendingMove = false;
    }
    return path.trim();
  };

  /** Founder rule 2026-07-13 v15.13 — deterministic path length used
   *  to seed the reveal animation's `stroke-dashoffset` variable.
   *  Sum of the Euclidean distances between consecutive PLOTTED
   *  (non-null) points, matching the geometry the `linePath` helper
   *  above emits. Purely straight-segment paths, so the sum is exact
   *  and no `getTotalLength()` DOM measurement is needed. */
  const lineLength = (values: (number | null)[]): number => {
    let total = 0;
    let prev: { x: number; y: number } | null = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) { prev = null; continue; }
      const p = { x: xAt(i), y: yAt(v) };
      if (prev) {
        const dx = p.x - prev.x;
        const dy = p.y - prev.y;
        total += Math.sqrt(dx * dx + dy * dy);
      }
      prev = p;
    }
    // Guard: an all-null (or single-point) series yields 0. Keep the
    // dash-array positive so the CSS animation still targets a valid
    // number rather than dividing by zero implicitly.
    return Math.max(1, Math.round(total));
  };

  // X-label density. xLabelStep takes precedence (use 1 to FORCE
  // every label); otherwise apply the default auto-step.
  const xStep = xLabelStep ?? (n > 8 ? Math.ceil(n / 6) : 1);

  // Founder rule 2026-07-05 v15.12 — shared interaction. Compute
  // nearest x-slot from the pointer position in SVG-viewBox space
  // (which equals CSS pixels because viewBox width == container width,
  // per the geometry contract above). The chart only responds while
  // the pointer is inside the plot region horizontally — outside the
  // plot band the tooltip clears, so hovering over the y-axis labels
  // or the legend doesn't lock the guide at an off-screen slot.
  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!tooltip) return;
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    const svgX = ((event.clientX - rect.left) / rect.width) * width;
    if (svgX < padL || svgX > width - padR) {
      if (hover !== null) setHover(null);
      return;
    }
    // Nearest x-slot via inverse-map of the same xAt() spacing.
    const slot = innerW > 0 ? (svgX - padL) / (innerW / Math.max(1, n - 1)) : 0;
    const rawIndex = Math.round(slot);
    const clamped = Math.max(0, Math.min(n - 1, rawIndex));
    setHover({ index: clamped, clientX: event.clientX, clientY: event.clientY });
  };
  const handlePointerLeave = () => {
    if (hover !== null) setHover(null);
  };

  // Build the tooltip model when the hover state + tooltip spec are
  // both present. The eyebrow label comes from `xHeaders[index]`;
  // rows are computed by walking `lines` and skipping any whose
  // `lineLabels[i]` is null (the benchmark / budget / prior-year
  // treatment) or whose value at that index is null (no-data slots).
  //
  // Founder rule 2026-07-05 v15.12 — every surfaced series produces
  // TWO tooltip rows: a `label` row (e.g. "Club Equity", "Food
  // Inventory") sitting above a `value` row (e.g. "$28.9M",
  // "$52.3K"). This stacked treatment matches the founder-approved
  // Bank-of-Canada-inspired reading pattern while keeping the
  // canonical Spectre editorial tooltip styling — the shared
  // ChartTooltip primitive renders rows uniformly, so the visual
  // rhythm is:  eyebrow (period) → label → value → label → value.
  const tooltipModel = (() => {
    if (!tooltip || !hover) return null;
    const idx = hover.index;
    const eyebrow = tooltip.xHeaders[idx] ?? xLabels[idx] ?? "";
    // The client-side chart resolves the formatter from the
    // serialisable descriptor here — no function crosses the RSC
    // boundary. `valueFormat` (tooltip override) beats `formatY`
    // (chart-wide default) when supplied.
    const activeFormat: FormatYSpec | undefined =
      tooltip.valueFormat ?? formatY;
    const rows: { key: string; text: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const label = tooltip.lineLabels[i];
      if (label == null) continue;
      const value = lines[i].values[idx];
      if (value == null) continue;
      rows.push({ key: `label-${i}`, text: label });
      rows.push({ key: `value-${i}`, text: applyFormatY(activeFormat, value) });
    }
    if (rows.length === 0) return null;
    return {
      x: hover.clientX,
      y: hover.clientY,
      label: eyebrow,
      rows,
    };
  })();

  return (
    <div ref={containerRef} className="relative block h-full w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${vbH}`}
        role="img"
        aria-label="Stewardship trend chart"
        className="block h-full w-full"
        style={{ shapeRendering: "geometricPrecision", textRendering: "geometricPrecision" }}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
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

        {lines.map((line, idx) => {
          if (!line.areaFill) return null;
          // The area fill spans the CONTINUOUS initial run of non-null
          // values starting at index 0. The moment a null is hit, the
          // run ends and the area closes back to the floor. For series
          // with no nulls (e.g. equity, where every fiscal year is
          // closed) this is the entire series — preserves the locked
          // baseline behaviour. For an actuals-only-through-May trend,
          // the area would end at May; but the payroll trend doesn't
          // use areaFill, so this remains aesthetic future-proofing.
          const floorY = vbH - padB;
          const firstNullIdx = line.values.findIndex((v) => v == null);
          const runLast = firstNullIdx === -1 ? line.values.length - 1 : firstNullIdx - 1;
          if (runLast < 0) return null;
          const segments: string[] = [];
          for (let i = 0; i <= runLast; i++) {
            const v = line.values[i];
            if (v == null) break;
            segments.push(`L ${xAt(i).toFixed(2)} ${yAt(v).toFixed(2)}`);
          }
          const head = line.values[0];
          if (head == null) return null;
          const d =
            `M ${xAt(0).toFixed(2)} ${floorY.toFixed(2)} ` +
            `L ${xAt(0).toFixed(2)} ${yAt(head).toFixed(2)} ` +
            `${segments.join(" ")} ` +
            `L ${xAt(runLast).toFixed(2)} ${floorY.toFixed(2)} Z`;
          return (
            <path
              key={`area-${idx}`}
              d={d}
              // Founder rule 2026-07-13 v15.13 — area fills reveal
              // via a plain opacity fade coordinated with the primary
              // line's draw so the two visuals feel like a single
              // gesture. Kept separate from the line's L→R draw so
              // the area doesn't create a distracting "sweep"
              // secondary motion.
              className={`${line.areaFill} chart-anim-area`}
              stroke="none"
            />
          );
        })}

        {lines.map((line, idx) => {
          // Founder rule 2026-07-13 v15.13 — animation class per
          // line. Solid lines draw progressively from left to right
          // via a stroke-dashoffset trick (`chart-anim-line`).
          // Dashed reference lines (benchmark / budget / prior-year)
          // instead fade in via opacity (`chart-anim-area`) so their
          // existing dash pattern is preserved — animating
          // stroke-dashoffset on top of a dashed line produces a
          // distracting "marching dashes" effect the founder's
          // "restrained editorial timing" spec forbids.
          const isDashed = Boolean(line.dasharray);
          const dashClass = isDashed ? "chart-anim-area" : "chart-anim-line";
          const length = isDashed ? 0 : lineLength(line.values);
          const inlineStyle: React.CSSProperties = isDashed
            ? {}
            : {
                strokeDasharray: length,
                // The `--editorial-line-length` custom property is
                // consumed by the `editorial-chart-line-draw`
                // keyframes in globals.css. Path-length-aware so the
                // draw covers the full geometry regardless of chart
                // width.
                ["--editorial-line-length" as string]: length,
              };
          return (
            <path
              key={`ln-${idx}`}
              d={linePath(line.values)}
              fill="none"
              className={`${line.stroke} ${dashClass}`}
              strokeWidth={line.width}
              strokeLinejoin="round"
              strokeLinecap="round"
              // Dashed reference lines keep their existing dasharray;
              // solid lines have their dasharray replaced by the
              // path-length constant so the draw animation can hide
              // the entire path via strokeDashoffset then reveal it.
              strokeDasharray={isDashed ? line.dasharray : undefined}
              opacity={line.opacity ?? 1}
              style={inlineStyle}
            />
          );
        })}

        {lines.map((line, idx) =>
          line.markers
            ? (() => {
                // Precompute the plotted (non-null) count so per-
                // marker delays can spread the reveal across the
                // same window as the line-draw animation without
                // overshooting the animation duration. Founder rule
                // 2026-07-13 v15.13.1 — line-draw is now ~1600 ms
                // (up from 850 ms). The marker window widens
                // accordingly so markers "appear as the line reaches
                // each point" instead of all lighting up in the
                // first third of the draw. Approx 75 % of the shared
                // duration keeps the last marker landing just before
                // the line finishes.
                const plotted = line.values.filter((v) => v != null).length;
                const stagger = plotted > 0 ? 1200 / plotted : 0;
                let plottedIdx = 0;
                return line.values.map((v, i) => {
                  // Skip nulls — no marker for "no-data" slots so
                  // the 5-month actual on a 12-month axis ends
                  // cleanly at May without trailing zero-dots at
                  // Jun–Dec.
                  if (v == null) return null;
                  const delayMs = Math.round(plottedIdx * stagger);
                  plottedIdx++;
                  return (
                    <circle
                      key={`mk-${idx}-${i}`}
                      cx={xAt(i)}
                      cy={yAt(v)}
                      // v15.12 — active marker enlarged from r=3 to
                      // r=5 so the currently-hovered point reads as
                      // a slightly emphasised dot without becoming
                      // flashy. Inactive markers keep their normal
                      // r=3, honouring the "elegant, not animated
                      // excessively" acceptance criterion.
                      r={hover?.index === i ? 5 : 3}
                      className={`${line.markerFill ?? line.stroke.replace("stroke-", "fill-")} chart-anim-marker`}
                      opacity={line.opacity ?? 1}
                      // Per-marker delay so markers appear as the
                      // line reaches them, matching the founder's
                      // spec ("markers should appear as the line
                      // reaches each point").
                      style={{ animationDelay: `${delayMs}ms` }}
                    />
                  );
                });
              })()
            : null,
        )}

        {/* v15.12 — subtle vertical guide line at the active x-slot.
             Rendered LAST so it draws over the plotted lines. Uses
             the Spectre neutral palette (club-green-900 at low
             opacity) so it reads as a quiet reference stroke, not a
             hard cursor. Disappears the moment the pointer leaves
             the plot region (hover === null). */}
        {tooltip && hover ? (
          <line
            data-testid="editorial-line-chart-guide"
            x1={xAt(hover.index)}
            x2={xAt(hover.index)}
            y1={padT}
            y2={vbH - padB}
            className="stroke-club-green-900"
            strokeWidth={0.9}
            opacity={0.22}
            pointerEvents="none"
          />
        ) : null}

        {xLabels.map((label, i) =>
          i % xStep === 0 || i === n - 1 ? (
            <text
              key={`xl-${i}`}
              x={xAt(i)}
              y={vbH - padB + 14}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              className="fill-club-green-800/70"
              style={{
                fontSize: `${CHART_AXES.xLabelFontSize}px`,
                fontWeight: CHART_AXES.xLabelFontWeight,
              }}
            >
              {label}
            </text>
          ) : null,
        )}

        {legend && legend.length
          ? (() => {
              // Center-grouped legend, Saguaro-style.
              //
              // The legend reads as a single tight unit centred on the
              // chart's plot region (not the SVG, not the card — the
              // chart). Each item is a short line preview that mirrors
              // the actual chart line's style (stroke colour + width +
              // dasharray + opacity), optionally with a centred
              // circular marker. The legend therefore visually
              // previews what's on the chart instead of using a
              // generic filled box.
              //
              // Layout strategy:
              //   1. Estimate each item's width = preview + gap + label.
              //   2. Sum widths + (n-1) × inter-item spacing.
              //   3. Centre the group's mid-X on the plot region's mid-X.
              const PREVIEW_LINE_W = 24;
              const PREVIEW_TO_LABEL_GAP = 5;
              const ITEM_SPACING = 20;
              // Legend font size sourced from the shared CHART_AXES
              // token (v15.5) so line + bar charts share ONE value.
              const FONT_SIZE = CHART_AXES.legendFontSize;
              // Average char width at 9.5 px sans, calibrated against
              // measured "Club Equity" / "Best-in-Class" / "Min. Required"
              // label widths (49.0 / 55.0 / 58.8 px → avg 4.4 px/char).
              // Held a hair above that average (4.6) so multi-line
              // labels never collide, and the visual group centre sits
              // within ~1 px of the chart's plot centre.
              const CHAR_W = 4.6;

              const itemWidths = legend.map(
                (e) => PREVIEW_LINE_W + PREVIEW_TO_LABEL_GAP + e.label.length * CHAR_W,
              );
              const totalWidth =
                itemWidths.reduce((s, w) => s + w, 0) +
                (legend.length - 1) * ITEM_SPACING;

              // Centre the legend on the plot region, not the SVG.
              // (Y-axis labels live in the left padding band; without
              // this, the legend visually drifts left toward the SVG
              // edge instead of sitting under the chart's data span.)
              const chartCenterX = padL + innerW / 2;
              const groupStartX = chartCenterX - totalWidth / 2;
              const yLegend = vbH - padB + 32;
              // Line preview is drawn slightly above the text baseline
              // so the eye reads "line, then label" — same convention
              // as Saguaro.
              const yLineY = yLegend - 3.5;

              // Pre-compute each item's left edge so the JSX map
              // doesn't carry mutable cursor state.
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
                    const lineRightX = lineLeftX + PREVIEW_LINE_W;
                    const lineCenterX = (lineLeftX + lineRightX) / 2;
                    const labelX = lineRightX + PREVIEW_TO_LABEL_GAP;
                    const fillClass = e.markerFill ?? e.stroke.replace("stroke-", "fill-");
                    return (
                      <g key={`lg-${i}`}>
                        <line
                          x1={lineLeftX}
                          x2={lineRightX}
                          y1={yLineY}
                          y2={yLineY}
                          className={e.stroke}
                          strokeWidth={e.strokeWidth}
                          strokeDasharray={e.dasharray}
                          strokeLinecap={e.dasharray ? "butt" : "round"}
                          opacity={e.opacity ?? 1}
                          fill="none"
                        />
                        {e.showMarker ? (
                          <circle
                            cx={lineCenterX}
                            cy={yLineY}
                            r={3}
                            className={fillClass}
                            opacity={e.opacity ?? 1}
                          />
                        ) : null}
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

      {/* v15.12 — canonical ChartTooltip. Same portal-based,
          viewport-aware, editorial-styled tooltip every other
          reporting chart uses. Only mounts while a hover state +
          non-empty row set exist, so charts without a `tooltip`
          prop pay zero interaction cost. */}
      {tooltipModel ? (
        <ChartTooltip tooltip={tooltipModel} testidPrefix="editorial-line-chart" />
      ) : null}
    </div>
  );
}

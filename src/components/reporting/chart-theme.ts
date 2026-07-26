// Canonical chart theme — the SINGLE source of truth for every chart
// rendered inside the Monthly Board Reporting Package.
//
// This file is the "Financial Performance chart system" the founder
// approved 2026-06-19. Every chart primitive (`EditorialDonut`,
// `EditorialBarChart`, `EditorialLineChart`, `ChartTooltip`,
// `ChartLegend`) reads from these tokens. Chapters XI–XIV chart
// implementations must consume the primitives — not hand-roll new
// colors / geometry / tooltips.
//
// Rules:
//   - Adding a new chart type → extend an existing primitive
//     additively; do not introduce a new chart-color file.
//   - Adding a new color tone → add it HERE; never hex-literal in a
//     page component.
//   - Adjusting tooltip / legend styling → adjust HERE; every chart
//     picks up the change automatically.
//
// Maintained for `docs/reporting-chart-system.md`.

/** Chart series colors. Use these — do not introduce inline hexes. */
export const CHART_COLORS = {
  /** Primary actual result — the Saguaro dark club green from the
   *  Financial Performance chapter. Used for Actuals, Revenue,
   *  Wages, Member-positive outcomes. */
  actual: "#3f7042",
  /** Budget / plan / target — muted gold from the FP palette. */
  budget: "#b08a4a",
  /** Prior-year comparison — muted sage from the FP palette
   *  (slightly cooler than budget). Used as a dashed-line overlay. */
  priorYear: "#9aa697",
  /** Positive performance signal — same green as `actual` but
   *  applied via tone classification rather than series identity. */
  positive: "#3f7042",
  /** Negative performance signal — the FP clay tone reserved for
   *  divergence below zero or below benchmark. */
  negative: "#8b3520",
  /** Neutral / informational — muted sand for legend / context. */
  neutral: "#b8a276",
  /** Cost % line accent (F&B, payroll-as-revenue-share) — same
   *  clay as `negative` since cost overruns are unfavorable. */
  costLine: "#8b3520",
} as const;

/** Bar stroke colors — used for the per-bar / per-slice hover
 *  emphasis. `rest` is the muted brown at-rest stroke; `active` is
 *  the dark green hover stroke. Both pulled from the FP token set. */
export const CHART_STROKES = {
  /** Stroke applied at rest — muted brown, sits below the eye and
   *  reads as part of the chart's quiet chrome. */
  rest: "#6b5028",
  /** Stroke applied to the hovered datum — dark editorial green
   *  matching `club-green-900`. */
  active: "#1c2f1c",
} as const;

/** Donut geometry — the Financial Performance canonical donut. */
export const DONUT_GEOMETRY = {
  /** viewBox is square; this is its side in viewBox units. */
  viewBox: 200,
  /** Center coords (cx, cy) — both equal viewBox / 2. */
  center: 100,
  /** Arc radius. */
  radius: 80,
  /** Ring thickness at rest. */
  restStrokeWidth: 36,
  /** Ring thickness when hovered (per-slice emphasis). */
  activeStrokeWidth: 44,
  /** Cream-sliver gap between adjacent arcs in degrees. The arc is
   *  shortened by `gapDeg / 2` on each side so the gap stays a
   *  constant angular width regardless of slice size — 1%-slices
   *  (3.6°) remain visible. 2026-06-20: bumped 0.8 → 1.5 so the
   *  cream separators read as deliberate dividers at boardroom
   *  distance rather than as anti-aliasing artifacts. */
  gapDeg: 1.5,
} as const;

/** Bar geometry — primary bars + secondary (e.g. budget) bars. */
export const BAR_GEOMETRY = {
  /** Primary bar width as a fraction of the slot width. The FP
   *  Operating Results card uses 0.55. */
  primaryWidthRatio: 0.55,
  /** Secondary bar width as a fraction of slot width. Narrower so
   *  it doesn't dominate the primary series. */
  secondaryWidthRatio: 0.3,
  /** Grouped-bar width as a fraction of the slot width per bar
   *  when 2 series are grouped side-by-side. */
  groupedTwoWidthRatio: 0.32,
  /** Grouped-bar width as a fraction of the slot width per bar
   *  when 3 series are grouped (e.g. Actual/Budget/Prior). */
  groupedThreeWidthRatio: 0.22,
  /** Stroke width applied to a bar at rest (hover-able charts only). */
  restStrokeWidth: 0.5,
  /** Stroke width applied to the hovered bar. Same value used for
   *  donut active-stroke EMPHASIS, but bars use it as their stroke
   *  weight (donuts use it as the bar fill stroke). */
  activeStrokeWidth: 2.4,
} as const;

/** Line geometry — primary line + benchmark / budget overlays. */
export const LINE_GEOMETRY = {
  /** Primary series stroke weight (e.g. F&B cost % line). */
  primaryStrokeWidth: 2,
  /** Secondary / benchmark stroke weight (dashed, narrower). */
  secondaryStrokeWidth: 1.3,
  /** Marker radius at rest. */
  markerRadius: 3,
  /** Marker radius when hovered. */
  markerRadiusActive: 5,
  /** Dash pattern for a benchmark / budget target line. */
  benchmarkDash: "6 4",
  /** Dash pattern for a prior-year overlay line. */
  priorYearDash: "2 4",
} as const;

/** Gridline + axis label styling.
 *
 *  Founder rule 2026-07-05 v15.5 — the Equity Value Over Time card
 *  is the CANONICAL editorial-chart standard. Every axis-typography
 *  token below now matches the LineChart's Equity-Value-Over-Time
 *  values so every editorial chart (line, bar, grouped bar,
 *  interactive bar) renders identical axis styling by default.
 *
 *  Prior state (2026-06-22 "boardroom display" bump):
 *    axisLabelFontSize = 12, xLabelFontSize = 13,
 *    xLabelFontWeight = 500, x-labels uppercase + 0.6 px tracking.
 *  Prior values clipped Y-axis tick labels on Operating Results
 *  (where negative-dollar labels like "($200K)" are 7-8 chars
 *  wide and overflow padLeft=44) AND created a visible
 *  typography mismatch between the Equity line chart (9 / 9.5 px)
 *  and every bar chart (12 / 13 px uppercase).
 *
 *  Current canonical values match the Equity chart exactly:
 *    axisLabelFontSize = 9  (y-axis tick labels)
 *    xLabelFontSize    = 9  (x-axis category labels)
 *    xLabelFontWeight  = 400 (normal — no medium weight)
 *    legendFontSize    = 9.5 (legend labels)
 *  No `text-transform: uppercase`, no letter-spacing on x-labels.
 */
export const CHART_AXES = {
  /** Hairline gridline color — pale cream matching FP. */
  gridlineColor: "#e6dcc4",
  /** Gridline stroke width. */
  gridlineWidth: 0.8,
  /** Zero-baseline / dominant axis stroke (slightly heavier). */
  zeroBaselineWidth: 0.9,
  /** Axis label color. */
  axisLabelColor: "#5b6c5a",
  /** Y-axis tick label font size in CSS pixels. Equity Value
   *  Over Time canonical value. */
  axisLabelFontSize: 9,
  /** X-axis label color (slightly darker than y-axis labels for
   *  the visible time/category dimension). */
  xLabelColor: "#3a4b3a",
  /** X-axis category label font size in CSS pixels. Equity Value
   *  Over Time canonical value — matches y-axis tick size so the
   *  two axes read as a single typographic system. */
  xLabelFontSize: 9,
  /** X-axis label font weight. Normal (400) — the editorial
   *  canonical style. Medium weight was previously applied to
   *  bar-chart x-labels but broke visual consistency with the
   *  Equity line chart. */
  xLabelFontWeight: 400 as const,
  /** Legend label font size in CSS pixels. Slightly larger than
   *  axis ticks so the legend reads with a hair more weight —
   *  matches the Equity chart legend byte-for-byte. */
  legendFontSize: 9.5,
} as const;

/** Tooltip styling — the FP canonical tooltip (dark-green glass
 *  overlay, cream text, soft shadow). */
export const TOOLTIP_STYLE = {
  /** Background — translucent dark green so the underlying chart
   *  datum the reader is inspecting stays visible through the
   *  tooltip. The founder explicitly requires "slight transparency
   *  (allow chart beneath to remain visible)". */
  backgroundClass: "bg-club-green-900/85",
  /** Ring (1-px subtle outline) for the glass effect. */
  ringClass: "ring-1 ring-club-green-900/40",
  /** Shadow (lifted floating effect). */
  shadowClass: "shadow-lg",
  /** Border radius. */
  radiusClass: "rounded-md",
  /** Padding. */
  paddingClass: "px-3 py-2",
  /** Label color (above the value rows). */
  labelColorClass: "text-club-cream/80",
  /** Body / row color. */
  bodyColorClass: "text-club-cream",
  /** Label font: small-caps eyebrow. */
  labelClass:
    "font-serif text-[10px] uppercase tracking-[0.18em]",
  /** Row body font: serif, tabular nums for numeric alignment. */
  bodyClass: "font-serif text-[12px] tabular-nums whitespace-nowrap",
} as const;

/** Drop-shadow SVG filter id used for active donut slices. The
 *  filter must be defined inside each SVG that uses it (SVG filter
 *  defs are scoped to their containing <svg>). The id below is the
 *  standard naming — register it via `<ChartActiveShadowDef />`. */
export const ACTIVE_SHADOW_FILTER_ID = "spectre-chart-active-shadow";

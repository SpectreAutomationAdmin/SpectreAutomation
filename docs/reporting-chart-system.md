# Spectre Reporting Chart System

**Status:** Approved 2026-06-19 by founder. Canonical for the Monthly Board Reporting Package and every future reporting surface.

**Rule of one chart language.** Every chart in the reporting package must consume the shared primitives in this document. Hand-rolling a one-off SVG chart in a chapter file is forbidden. If a new chapter needs a chart variant that doesn't exist, **extend the primitive additively** — do not create a parallel implementation.

---

## Origin

The canonical visual standard is the Financial Performance chapter (chapter II) — the locked Equity Value Over Time card, OperatingResultsCard, and DuesSubsidyDonut. Chapters XI–XIV historically hand-rolled their own charts with subtly different colors, geometry, tooltips, and hover behavior; the founder identified this as a branding-drift problem 2026-06-19 and directed a permanent refactor to a single chart system.

The pilot migration was Chapter XI (Weather & Utilization). Chapters XII–XIV migrate to the same primitives in subsequent sessions.

---

## Architecture

### Files
| Path | Purpose |
|---|---|
| [`src/components/reporting/chart-theme.ts`](../src/components/reporting/chart-theme.ts) | Single source of truth for chart colors, typography, geometry, tooltip + axis styling. |
| [`src/components/reporting/ChartTooltip.tsx`](../src/components/reporting/ChartTooltip.tsx) | Shared tooltip primitive. Dark-green-glass overlay, cream typography, no backdrop-blur. |
| [`src/components/reporting/EditorialDonut.tsx`](../src/components/reporting/EditorialDonut.tsx) | Shared donut primitive. radius=80, restStroke=36, activeStroke=44, gap=0.8°. Two render modes (per-slice fraction or explicit arc angles). Per-slice hover with stroke thickening + drop shadow. |
| [`src/components/reporting/EditorialInteractiveBarChart.tsx`](../src/components/reporting/EditorialInteractiveBarChart.tsx) | Shared bar primitive with per-bar fills + per-bar hover. Hover outlines the bar (stroke 0.5→2.4 px) without changing y/height. Uses ChartTooltip. |
| [`src/components/reporting/EditorialBarChart.tsx`](../src/components/reporting/EditorialBarChart.tsx) | Pre-existing FP static bar chart (no hover) — kept for OperatingResultsCard. Will be unified with `EditorialInteractiveBarChart` in a future pass. |
| [`src/components/reporting/EditorialLineChart.tsx`](../src/components/reporting/EditorialLineChart.tsx) | Pre-existing FP line chart — feeds the LOCKED Equity Value card. Untouched. Will gain multi-line + per-point hover + area-fill props additively when chapter XIII / XIV migrate. |
| [`src/components/reporting/DuesSubsidyDonut.tsx`](../src/components/reporting/DuesSubsidyDonut.tsx) | Pre-existing FP donut. Will become a thin wrapper around `EditorialDonut` in a future pass. |

### Token reference

All chart primitives MUST consume tokens from `chart-theme.ts`. Inline hexes / Tailwind tokens for chart colors are forbidden.

| Token | Value | Used for |
|---|---|---|
| `CHART_COLORS.actual` | `#3f7042` | Primary actual / revenue / wages |
| `CHART_COLORS.budget` | `#b08a4a` | Budget / plan / target |
| `CHART_COLORS.priorYear` | `#9aa697` | Prior-year overlay (dashed line) |
| `CHART_COLORS.positive` | `#3f7042` | Favorable performance signal |
| `CHART_COLORS.negative` | `#8b3520` | Unfavorable / cost overrun |
| `CHART_COLORS.neutral` | `#b8a276` | Informational / context |
| `CHART_COLORS.costLine` | `#8b3520` | F&B / payroll cost % line |
| `CHART_STROKES.rest` | `#6b5028` | Per-bar stroke at rest |
| `CHART_STROKES.active` | `#1c2f1c` | Per-bar stroke when hovered |
| `DONUT_GEOMETRY.radius` | `80` | All donuts |
| `DONUT_GEOMETRY.restStrokeWidth` | `36` | Donut ring at rest |
| `DONUT_GEOMETRY.activeStrokeWidth` | `44` | Donut ring when slice hovered |
| `DONUT_GEOMETRY.gapDeg` | `0.8` | Cream sliver between arcs |
| `BAR_GEOMETRY.primaryWidthRatio` | `0.55` | Primary bar width / slot width |
| `BAR_GEOMETRY.secondaryWidthRatio` | `0.3` | Secondary (budget) bar width / slot width |
| `BAR_GEOMETRY.groupedTwoWidthRatio` | `0.32` | 2-series grouped bar width / slot width |
| `BAR_GEOMETRY.groupedThreeWidthRatio` | `0.22` | 3-series grouped bar width / slot width |
| `BAR_GEOMETRY.restStrokeWidth` | `0.5` | Bar stroke at rest |
| `BAR_GEOMETRY.activeStrokeWidth` | `2.4` | Bar stroke when hovered |
| `LINE_GEOMETRY.primaryStrokeWidth` | `2` | Primary line series stroke |
| `LINE_GEOMETRY.secondaryStrokeWidth` | `1.3` | Benchmark / budget line stroke |
| `LINE_GEOMETRY.benchmarkDash` | `"6 4"` | Budget target dash pattern |
| `LINE_GEOMETRY.priorYearDash` | `"2 4"` | Prior-year overlay dash pattern |
| `CHART_AXES.gridlineColor` | `#e6dcc4` | Gridline hairlines |
| `CHART_AXES.axisLabelColor` | `#5b6c5a` | Y-axis tick label color |
| `CHART_AXES.xLabelColor` | `#3a4b3a` | X-axis category label color |
| `TOOLTIP_STYLE.backgroundClass` | `bg-club-green-900/85` | Tooltip background |
| `TOOLTIP_STYLE.ringClass` | `ring-1 ring-club-green-900/40` | Tooltip ring |
| `TOOLTIP_STYLE.shadowClass` | `shadow-lg` | Tooltip shadow |
| `TOOLTIP_STYLE.bodyColorClass` | `text-club-cream` | Tooltip body text |

### Hover behavior (locked)

- **Donut slices.** On hover: thicker stroke (36 → 44 px) + drop-shadow filter on the active slice only. Card chrome unchanged. Tooltip floats above cursor.
- **Bars.** On hover: outline stroke thickens (0.5 → 2.4 px), stroke color shifts (`#6b5028` → `#1c2f1c`). **NO bar lift, NO scale, NO geometry change.** Card chrome unchanged. Tooltip floats above cursor.
- **Lines** (future). On hover: nearest point's marker enlarges (r 3 → 5), stroke unchanged. Card chrome unchanged.
- **Card chrome.** Static at every hover state. No outline change, no shadow change, no lift, no scale.

### Tooltip styling (locked)

- Dark-green-glass overlay (`bg-club-green-900/85`) — translucent so the hovered datum stays perceivable beneath.
- **No `backdrop-blur`** — would defeat the "datum visible beneath tooltip" intent.
- Subtle ring (`ring-1 ring-club-green-900/40`) for the floating-glass edge.
- Cream typography fully opaque (`text-club-cream`).
- Eyebrow label: `font-serif text-[10px] uppercase tracking-[0.18em] text-club-cream/80`.
- Body rows: `font-serif text-[12px] tabular-nums text-club-cream whitespace-nowrap`.
- `pointer-events: none` so the underlying chart's hover handlers continue receiving events.

---

## Author guide

### Adding a chart to a new chapter

1. **Read the data.** The reporting service produces typed cards with display strings, fillHexes, and any tooltip context. Chart components RENDER ONLY.
2. **Pick a primitive.** Donut → `EditorialDonut`. Single-series bars with per-bar colors + hover → `EditorialInteractiveBarChart`. Static diverging bars without hover → `EditorialBarChart` (FP OperatingResultsCard pattern). Line chart → `EditorialLineChart`.
3. **Pass a `testidPrefix`** unique to the chart (e.g. `"mws-pattern"`, `"payroll-distribution"`). The primitive derives all child testids (`{prefix}-svg`, `{prefix}-slice-{key}`, `{prefix}-bar-{key}`, `{prefix}-tooltip`, `{prefix}-tooltip-row-{key}`).
4. **Build the tooltip body via a `buildTooltip` callback.** The callback receives the active slice / bar and returns `{ label, rows: [{key, text}] }`. Chapter-specific copy lives in the callback; the tooltip CHROME lives in the primitive.
5. **Card chrome.** Wrap the chart in a static `<article>` with `data-chart-card="true"` (the primitive uses this attribute to scope tooltip coordinates to the card). Never apply hover-driven classes to the card.

### Adding a new chart variant

If your chapter needs a chart shape that doesn't exist (e.g. stacked bars, 3-series grouped bars, multi-line with area fill):
- **EXTEND** an existing primitive additively — add a new optional prop, default behavior unchanged.
- **NEVER** copy an existing primitive into a chapter file and modify it inline.
- Update this doc + `tests/reporting-chart-system.test.ts` with the new contract.

### Adding a new theme token

- Add the token to `chart-theme.ts` only.
- Add an assertion in `tests/reporting-chart-system.test.ts` pinning its value.
- Reference it from primitives, never inline.

---

## Migration status

| Chapter | Status | Charts | Migrated to |
|---|---|---|---|
| II Financial Performance | Canonical | EquityValue (LOCKED), OperatingResults, DuesSubsidy donut, DeptNetPerf, Scorecard | Pre-existing FP primitives. Will fold into shared primitives in a future cleanup once XI–XIV are stable. |
| XI Weather & Utilization | **Migrated 2026-06-19 (pilot)** | PatternDonut, RoundsBarChart | `EditorialDonut`, `EditorialInteractiveBarChart` |
| XII Payroll Analysis | **Scheduled** | GroupedBars, VarianceBars, PayrollDonut, StackedBars | TBD (primitives need: grouped-2, variance-tone-classified diverging, stacked) |
| XIII F&B Statistics | **Scheduled** | RevCostGrouped, CategoryDonut, Covers3Series, FoodCostLine+Area+Overlay | TBD (primitives need: grouped-3, multi-line with area + benchmark overlay + per-point hover) |
| XIV Inventory Analysis | **Scheduled** | TurnoverGrouped, BalancesMultiLine | TBD (primitives need: multi-line) |

---

## Test contracts

- **[tests/reporting-chart-system.test.ts](../tests/reporting-chart-system.test.ts)** — pins token values, primitive APIs, and the "no inline hexes" rule. Runs on every commit.
- **[tests/monthly-reporting-package.test.ts](../tests/monthly-reporting-package.test.ts)** — chapter XI source-contract test asserts WeatherChartCards consumes `EditorialDonut` + `EditorialInteractiveBarChart` (no `<svg>` in the wrapper, no local `ChartTooltip`, no inline geometry constants).
- **[tests/e2e/monthly-weather-summary-multi-viewport.spec.ts](../tests/e2e/monthly-weather-summary-multi-viewport.spec.ts)** — visual + interaction validation at 5 viewports.
- **[tests/e2e/equity-multi-viewport.spec.ts](../tests/e2e/equity-multi-viewport.spec.ts)** + the other equity guards — locked Equity Value card geometry stays intact.

When migrating a new chapter, add a parallel "uses the shared chart primitives" assertion to `tests/monthly-reporting-package.test.ts` mirroring the chapter XI pattern.

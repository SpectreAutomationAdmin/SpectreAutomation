# Monthly Reporting Chart Governance

**Status:** Approved 2026-06-21 by founder. Permanent. Required reading for any chart work in the Monthly Board Reporting Package.

**Core rule.** A chart is **not complete** simply because it uses the shared primitives or passes the test suite. A chart is complete only when it **visually matches the Financial Performance chart system** at every supported viewport.

> **Shared primitives are necessary but not sufficient. A chart is only approved when it visually matches the Financial Performance reference charts.**

This document is the permanent governance layer above [docs/reporting-chart-system.md](reporting-chart-system.md) (the architecture / API reference). The chart-system doc tells you WHAT the primitives are; this doc tells you what visual outcome you must achieve.

---

## 1. Chart System Principles

Every chart in the Monthly Board Reporting Package must look like it belongs to the **same product, the same report, and the same design system**. A board member should be unable to tell which chapter a chart came from based on visual styling alone.

That means:
- Same card chrome (dark-green header band, smallcaps subtitle, gold pill, KPI ribbon, chart body, inset commentary).
- Same color palette (the Financial Performance green / gold / sand / clay family).
- Same typography hierarchy (serif title at 17 px, smallcaps subtitle, tabular numerics).
- Same geometry (donut radius / stroke / gap, bar widths, line stroke weights, gridline color).
- Same tooltip (dark-green-glass overlay, cream text, soft shadow, never clipped).
- Same hover behavior (per-datum emphasis only, card chrome static).

This is the **visual identity contract**. Honor it before reaching for one-off styling.

---

## 2. Approved Reference Charts

The Financial Performance chapter (chapter II) is the **canonical visual standard**. Every new bar, donut, or line chart must be visually compared against these reference charts before approval:

| Reference chart | Type | Lives in |
|---|---|---|
| **Equity Value Over Time** | Line (3 series + area fill + dashed benchmark) | [page.tsx → `EquityValueCard`](../src/app/app/admin/reporting/monthly/page.tsx) — **LOCKED**, do not modify |
| **Operating Results — 12-Month Rolling Trend** | Diverging bars + secondary budget bars + dashed prior-year overlay | [page.tsx → `OperatingResultsCard`](../src/app/app/admin/reporting/monthly/page.tsx) |
| **Dues Subsidy Analysis** | Donut with per-slice hover | [page.tsx → `DuesSubsidyAnalysisCard`](../src/app/app/admin/reporting/monthly/page.tsx) |
| **Department Net Performance** | Inline trend bars in table rows | [page.tsx → `DepartmentNetPerformanceCard`](../src/app/app/admin/reporting/monthly/page.tsx) |
| **Stewardship Scorecards** | Status-dotted table | [page.tsx → `StewardshipScorecardCard`](../src/app/app/admin/reporting/monthly/page.tsx) |

When proposing a new chart, capture screenshots of your chart and the matching reference chart side-by-side. If a board member would notice they came from different design systems, the work is not done.

---

## 3. Donut Chart Standard

The **Dues Subsidy Analysis donut** is the canonical donut. All donuts must match it.

**Geometry (locked in [chart-theme.ts](../src/components/reporting/chart-theme.ts)):**
- `viewBox` 200 × 200
- `radius` 80, `restStrokeWidth` 36, `activeStrokeWidth` 44
- `gapDeg` 1.5° — produces a visible cream sliver between adjacent slices

**Required behavior:**
- Match the Dues Subsidy Analysis donut visual weight, ring thickness, inner radius, outer radius, and chart-to-card proportions.
- **Visible white (cream) dividers between donut segments.** No continuous unbroken ring.
- Donut sits on the LEFT (200 px column); vertical legend list sits on the RIGHT.
- Legend rows: **color swatch | label | percent on the same row**. Percent is never detached on the far side of the card.
- Tooltip appears adjacent to the cursor.
- Tooltip is never clipped by the chart card or viewport edges.
- Tooltip uses the shared semi-transparent dark-green style.
- Only the hovered slice is emphasized (stroke thickens 36 → 44, drop shadow applied).
- Card chrome itself never lifts, outlines, scales, or animates on hover.

**Implementation rule:** use `<EditorialDonut>` from `src/components/reporting/EditorialDonut.tsx`. Do not hand-roll SVG arcs in a chapter file.

---

## 4. Bar Chart Standard

The **Operating Results 12-Month Rolling Trend** is the canonical bar chart.

**Required colors (from [chart-theme.ts](../src/components/reporting/chart-theme.ts) `CHART_COLORS`):**
- **Actuals** use club green (`actual: #3f7042`)
- **Budget** uses muted gold/sand (`budget: #b08a4a`)
- **Prior year** uses a muted dashed treatment (`priorYear: #9aa697`, dash `2 4`)
- **Negative / unfavourable** values use rust/clay (`negative: #8b3520`)
- **Neutral / informational** uses muted sand (`neutral: #b8a276`)

**Required behavior:**
- Match Financial Performance bar widths, corner radius, spacing, gridline color, axis label color, and typography exactly.
- **Hover outlines only the hovered bar** — stroke thickens (0.5 → 2.4 px), stroke color shifts (`#6b5028` → `#1c2f1c`).
- Hover **must not** raise, translate, scale, or visually distort bar height. The data-height the chart communicates is sacred.
- Tooltip follows the shared tooltip standard (§6).
- **Chart uses the available card space.** A chart floating as a tiny island in a large empty card is a failure. The plot area must expand to fill the card's width (use the responsive `<EditorialInteractiveBarChart>` or `<EditorialBarChart>` primitives, both of which observe their container via `ResizeObserver`).

**Implementation rule:** use `<EditorialBarChart>` (static, no per-bar hover) or `<EditorialInteractiveBarChart>` (with per-bar hover + tooltip). Do not hand-roll SVG bars in a chapter file.

---

## 5. Line Chart Standard

The **Equity Value Over Time** chart (LOCKED) is the canonical line chart.

**Required (from [chart-theme.ts](../src/components/reporting/chart-theme.ts) `LINE_GEOMETRY`):**
- **Line weight:** primary series stroke `2 px`; secondary / benchmark stroke `1.3 px`.
- **Marker size:** at rest `r=3`; when hovered `r=5`.
- **Benchmark / budget dash pattern:** `"6 4"`.
- **Prior-year overlay dash pattern:** `"2 4"`.
- **Gridlines:** color `#e6dcc4`, weight 0.8 px (from `CHART_AXES.gridlineColor`).
- **Axis labels:** y-axis color `#5b6c5a`, font size 9 px; x-axis color `#3a4b3a`, font size 9.5 px.
- **Tooltip:** the shared tooltip standard (§6).
- **Legend:** stroked line preview + small text label; positioned beneath the chart band.
- **Area fill:** when applicable, use `actual` green at 10 % opacity (the Equity card's pattern).

**Implementation rule:** use `<EditorialLineChart>` from `src/components/reporting/EditorialLineChart.tsx`. Do not hand-roll SVG paths in a chapter file.

---

## 6. Tooltip Standard

Tooltip behavior is **non-negotiable**.

- Render through a `React.createPortal` into `document.body` so the tooltip can never be clipped by an ancestor's `overflow`.
- Position **adjacent to the cursor** — default offset `+12 X / −12 Y`.
- Follow cursor while hovering (rebuild on every `mousemove`).
- Never clip. **Reposition automatically near viewport edges:**
  - Right edge → flip to LEFT of cursor.
  - Top edge → flip to BELOW cursor.
  - Left + bottom → clamp inside viewport with an 8-px pad.
- The flip MUST be computed during render (using estimated dimensions) so the flipped position lands on the **first paint** — no flash of clipped tooltip on the first frame.
- Semi-transparent dark-green background (`bg-club-green-900/85` — translucent so the underlying datum stays perceivable).
- Subtle ring (`ring-1 ring-club-green-900/40`) + soft shadow (`shadow-lg`).
- Cream/white typography (`text-club-cream`, fully opaque).
- Consistent padding (`px-3 py-2`), radius (`rounded-md`), shadow.
- `pointer-events: none` — never intercept the mouse.
- **Forbidden:** browser-default `<title>` tooltips on SVG elements, opaque black boxes, `backdrop-blur` (would defeat the "datum visible beneath tooltip" rule), chart-library default tooltips.

**Implementation rule:** use `<ChartTooltip>` from `src/components/reporting/ChartTooltip.tsx`. Do not implement a local tooltip in a chapter file.

---

## 7. Legend Standard

- Legend lives **close to the chart** — typically to the right of the donut, or beneath the bar chart band. Never floats far from its chart.
- Legend values stay visually associated with labels. **Color swatch, label, and value/percentage belong on the same row.**
- No detached values on the far side of the card unless the reference chart does the same (Dues Subsidy uses a 3-column grid per row; that's allowed).
- For short labels (e.g. "Sunny / Clear") + a 4-row legend in a wide card, use a **dot-leader** between label and value so they read as one row (Weather Pattern donut pattern).
- Typography matches Financial Performance: serif 14 px label, 14 px / 600 weight tabular-nums percent.
- Constrain the legend's `max-width` so it doesn't stretch across the entire card body when labels are short.

---

## 8. Chart Card Layout Standard

Every chart card uses the Financial Performance card chrome.

**Required anatomy (top to bottom):**
1. **Header band** — dark green (`bg-club-green-900`), 76 px tall, padding `12 / 18 / 12 / 18`. Cream serif title (17 px / 600), smallcaps subtitle (`text-club-cream/70`, 10.5 px / 0.7 px tracking), optional gold pill chip on the right (9 px uppercase / 1 px tracking, club-gold).
2. **Optional KPI ribbon** — 4-up grid of stat tiles (each tile: serif 18 px / 600 value, smallcaps 9.5 px / 0.8 px tracking label). Height 77 px (default) or 60 px (chart-dominant). Cream border + tinted background.
3. **Chart area** — fills the body. The plot area must expand to use the card's width.
4. **Legend** — beneath or beside the chart per §7.
5. **Inset commentary** — green-tinted block (`rgba(63,112,66,0.10)`) with 3-px deep-green left accent. Italic serif text, 13 px / 1.45 line-height. Always inset 14 px from card edges (`px-3.5` outer + 10 px / 14 px inner padding).

**Required spacing rhythm (chart-dominant layout):**
- header → KPI ribbon: `mt-12`
- KPI ribbon → chart: `mt-10`
- chart → commentary: `mt-8`

**Minimum plot utilization:** the chart must occupy at least the full inner card width minus the padding. The full standard is in §9 below.

**Implementation rule:** when chapters XII–XIV migrate, factor the inline `FpChartCard` wrapper from `WeatherChartCards.tsx` into a shared `src/components/reporting/ReportingChartCard.tsx`. Every chapter then consumes the SAME card shell.

---

## 9. Plot Utilization Standard

One of the hardest-fought design wins in the Financial Performance chapter was getting charts to use the **full horizontal plotting space** inside their cards. Charts must not float as small graphics inside oversized cards. This standard makes that non-negotiable for every chart in the reporting package.

> **Definition (read this first).** Plot utilization means the **actual rendered data marks** (bars, line points, donut + legend group, etc.) must use the available plotting area, **not** merely that the SVG or chart container is full-width. A full-width SVG with bars clustered in the centre still fails the standard. We measure the **data span** (first-bar-left → last-bar-right, first-line-point → last-line-point, donut-left → legend-right), not the container.

**Rules:**
- Every chart must use the **full horizontal plotting space** available inside its card.
- The **rendered data marks** must visibly span that plotting space. Bars must not float as thin rectangles centred in oversized slots; line points must not cluster in the middle of a wide SVG; the donut + legend group must not sit as a small island in a large card.
- Charts must NOT appear centered as a small graphic inside a large empty card.
- Plot width must **expand with the card width** at all supported viewport sizes (responsive — observed via `ResizeObserver`, see the existing pattern in `EditorialBarChart` and `EditorialInteractiveBarChart`).
- Legends, KPI ribbons, and commentary blocks may occupy vertical space, but must NOT unnecessarily constrain chart width.
- The chart's SVG / canvas / responsive container must be `width: 100%` of its parent slot.
- **Avoid fixed pixel chart widths** unless explicitly required by the approved Financial Performance reference. Pass `width` to a primitive only when matching a measured FP reference; otherwise omit it and let the primitive's `ResizeObserver` measure the container.
- Card padding should match the Financial Performance chart cards (`px-4 py-4` for chart bodies, `px-3.5` for the inset commentary gutter), but the plot area inside that padding should be **fully used**.
- **For bar charts:** the standard is **visual parity with the Financial Performance + Payroll bar charts** — bars look like they were drawn by the same designer in the same report. The visual properties that define that:
  1. **Bar absolute pixel width matches FP Operating's primary bars** (~4.8 % of plot width — ~32 px at 1920 viewport, ~22 px at 1440). Matching only the *ratio* (e.g. `BAR_GEOMETRY.primaryWidthRatio = 0.55`) produces correct widths for ~12-bar charts but blocky 90+ px bars for 4-bar charts — those FAIL the visual parity standard even if the ratio is correct.
  2. **bar-to-step ratio MUST NOT exceed `BAR_GEOMETRY.primaryWidthRatio = 0.55`** (cap 0.60 with rounding tolerance). Inflating the ratio above FP standard is the canonical §13 failure.
  3. **For few-category charts**, the correct bar-width ratio is *lower* than 0.55 — solve `barW / plot = 0.048` from the scaleBand formula `barW = plot × R / (N − 1 + R)` (at outerPad=0). For N=4, that gives R ≈ 0.15.
  4. Reduce `padLeft` / `padRight` so the plot itself grows.
  5. Pass `outerPaddingRatio={0}` so bars distribute across the plot edge-to-edge. scaleBand positioning: bar `i` sits at `padLeft + step × (i + outerPad)`, with `step × (N − paddingInner + 2 × outerPad) = plotW`.
- **Plot utilization is achieved through layout, scale, margins, and (for few-category charts) a lower bar-width ratio — NEVER through bars that exceed FP's 0.55 ratio.**
- **Approval is based on visual parity with the Financial Performance + Payroll reference charts, not on mathematical utilization metrics in isolation.** The metric thresholds are necessary but not sufficient — a chart that satisfies all thresholds while reading visually different from FP / Payroll is still a §13 failure.

### Large-Monitor Responsive Validation — mandatory

Every chart MUST be validated by **visually inspecting screenshots** at all five supported viewports:

| Viewport | Width × Height |
|---|---|
| 1366 × 768 | laptop |
| 1440 × 900 | laptop |
| 1600 × 900 | mid-monitor |
| 1920 × 1080 | desktop |
| 2560 × 1440 | large monitor |

**A passing automated test is NOT sufficient.** Claude must open each viewport's screenshot and read it against the fail-conditions list below.

**Automatic fail conditions** — a chart fails at any viewport where any of these is true:

1. **Large unused whitespace** develops inside the card.
2. **The chart is visually anchored to one side** of the card (left, right, top, bottom).
3. **A donut + legend group occupies less than ~80 %** of the available visual width.
4. **A chart that appears centred at 1440 becomes left-biased or right-biased at 1920 or 2560.**
5. **The visual balance differs materially** between laptop and large-monitor views.

**Responsive design requirement.** Charts must scale their **layout**, not just their components. The composition must remain visually centred and balanced at every viewport.

| ❌ Unacceptable | ✅ Acceptable |
|---|---|
| Wider bars at 2560 | Rebalanced column widths |
| Larger donut at 2560 | Responsive gutters |
| Larger text at 2560 | Responsive legend positioning |
| | Responsive chart-container sizing |
| | Responsive grid allocation |

The reference regression spec for this rule is the per-chapter multi-viewport evidence spec (e.g. [tests/e2e/weather-pattern-evidence.spec.ts](../tests/e2e/weather-pattern-evidence.spec.ts)) — every chapter MUST add itself to a multi-viewport evidence spec, captured at all five widths.

### Axis Typography Standard — mandatory

Axis labels must be **readable from a boardroom display**. Squinty axis labels are a §13 failure even when every other rule passes.

**Rules:**
- X-axis and Y-axis labels MUST scale proportionally with chart size and MUST remain legible at every viewport (1366, 1440, 1600, 1920, 2560).
- Axis labels MUST come from the shared `CHART_AXES` tokens in [src/components/reporting/chart-theme.ts](../src/components/reporting/chart-theme.ts), not hardcoded in chart primitives. Hardcoded `fontSize: "9px"` strings are forbidden — every primitive consumes `CHART_AXES.axisLabelFontSize` (Y) and `CHART_AXES.xLabelFontSize` (X).
- Font sizes are specified in CSS `px` (not viewBox units), so they render at their stated size regardless of the SVG's letterbox scale factor.
- X-axis category labels carry `CHART_AXES.xLabelFontWeight` (medium / 500) — categories are PRIMARY chart data and must read with more visual weight than secondary y-axis ticks.
- Y-axis labels carry the default weight (400) — they're supporting ticks, not primary data.
- Unit suffixes on axis labels are OPTIONAL. If the unit is named in the card subtitle or KPI ribbon, the axis can carry bare numerals (e.g. `150`, not `150 rds`) so the labels fit comfortably in the y-axis gutter at the larger sizes.

**Canonical values (2026-06-22):**

| Token | Value | Notes |
|---|---|---|
| `CHART_AXES.axisLabelFontSize` | **12 px** | Y-axis tick labels |
| `CHART_AXES.xLabelFontSize` | **13 px** | X-axis category labels |
| `CHART_AXES.xLabelFontWeight` | **500** | Medium weight on x-axis |
| `CHART_AXES.axisLabelColor` | `#5b6c5a` | Y-axis label color (muted sage) |
| `CHART_AXES.xLabelColor` | `#3a4b3a` | X-axis label color (slightly darker) |

**Failure conditions:**

A chart automatically fails if any of the following are true at any of the five required viewports:

- ❌ Axis labels appear materially smaller than commentary text.
- ❌ Axis labels require zooming to read.
- ❌ Axis labels become difficult to read on a 1920 px or 2560 px display.
- ❌ Axis typography differs materially from the Financial Performance chapter baseline (the `CHART_AXES` tokens are the baseline — chapter charts MUST consume them, not override).
- ❌ A chart primitive hardcodes an axis-label font size instead of reading `CHART_AXES.axisLabelFontSize` / `CHART_AXES.xLabelFontSize` / `CHART_AXES.xLabelFontWeight`.
- The visual standard is: the chart should feel intentionally composed, not like it is floating in unused space.

**Failure conditions:**
- ❌ Bar chart **container** uses < 85 % of card inner width.
- ❌ Bar chart **data span** (first-bar-left → last-bar-right) uses < 75 % of the plot area, OR < 65 % of the card inner width — **even if the SVG is full-width**. A full-width SVG with bars clustered in the centre is still a failure.
- ❌ Bar chart **bar-width-to-step ratio** (`medianBarWidth / medianStep`) exceeds the FP standard (0.55) by more than rounding tolerance (cap: 0.60). Bars MUST NOT be widened beyond the FP standard to satisfy plot utilization. The correct fix is to reduce edge padding and use `outerPaddingRatio` to distribute bars evenly across the plot.
- ❌ Donut/chart layout leaves excessive unused horizontal space compared to the Financial Performance reference.
- ❌ Donut + legend combined visual group < 85 % of card inner width.
- ❌ Chart is fixed-width when the card is responsive.
- ❌ Chart looks **materially smaller** on large monitors (1920, 2560) than at laptop sizes (1366, 1440).
- ❌ Chart does not scale proportionally from 1366 through 2560 widths.

**Testing requirement (mandatory before any chart is approved):**

For each chart card, the regression test must measure both the **container utilization** and the **data-span utilization** and capture screenshots at all five viewport widths.

For **bar charts**, measure each of:
1. **Card inner width** (card `clientWidth` minus the chart-body left/right padding).
2. **SVG / container width** (the bar chart's SVG root in screen px).
3. **Plot area width** — the screen-px width of the inner plotting region, EXCLUDING the y-axis label gutter and the right margin. The primitive exposes the first gridline via `data-testid="${testidPrefix}-plot-area"` for this purpose; gridlines span `padLeft → svgWidth - padRight`, which IS the plot area.
4. **Data span** — `lastBarRight - firstBarLeft` (the bounding box of all rendered bar rects).
5. **Container ratio** = `svgWidth / cardInnerWidth` (the legacy measurement).
6. **Plot ratio** = `dataSpan / plotAreaWidth` (the new primary measurement).
7. **Card ratio** = `dataSpan / cardInnerWidth` (the failsafe — catches cases where someone shrinks the SVG but the bars still cluster).

For **donut + legend groups**, measure the combined donut + legend bounding box vs the card inner width.

Assert each measurement against the documented threshold at **every supported viewport size**:

| Viewport | Bar — container | Bar — data span vs plot | Bar — data span vs card | Donut + legend group |
|---|---|---|---|---|
| 1366 × 768  | ≥ 85 % | ≥ 75 % | ≥ 65 % | ≥ 85 % |
| 1440 × 900  | ≥ 85 % | ≥ 75 % | ≥ 65 % | ≥ 85 % |
| 1600 × 900  | ≥ 85 % | ≥ 75 % | ≥ 65 % | ≥ 85 % |
| 1920 × 1080 | ≥ 85 % | ≥ 75 % | ≥ 65 % | ≥ 85 % |
| 2560 × 1440 | ≥ 85 % | ≥ 75 % | ≥ 65 % | ≥ 85 % |

For donut-plus-legend layouts, the donut alone will not pass the 85 % threshold (it's a 200 px square). The test instead measures the **combined donut + legend visual group width** against the card inner width and asserts that combined group ≥ 85 % of the card.

The thresholds for bar charts are LOWER than the container threshold because some space inside the plot must remain as breathing-room (a 100 % data-span chart with bars touching the axis would look unbalanced). 75 % data-span / 65 % card-span are calibrated to the Financial Performance reference and to the rule "bars must visually fill the plot, not float in the centre."

Capture Playwright screenshots at all five viewport widths so future regression evidence exists.

The reference regression spec for this standard is **[tests/e2e/chart-plot-utilization.spec.ts](../tests/e2e/chart-plot-utilization.spec.ts)**. New chart work MUST add itself to this spec before being considered done. The spec is the load-bearing guard that prevents future charts from shrinking back into the center of oversized cards — **and** prevents charts whose container fills the card while the bars themselves cluster in the centre.

---

## 10. Interaction Standard

Hover behavior must be consistent across all chapters.

- **Only the hovered data element reacts.** Other slices / bars / points stay exactly as they render at rest.
- **Card containers do not animate.** No card-level lift, outline, shadow, scale, or background change on hover. Card chrome is static.
- **Bar hover does not distort data.** No translation, no scale, no y-shift, no height-shift. The data-height the chart communicates is sacred.
- **Donut hover emphasizes only the hovered slice** (stroke 36 → 44 + drop shadow filter).
- **Tooltip behavior is identical across chart types** — same offset, same edge-flip rules, same styling.
- Smooth-scroll click + IntersectionObserver scrollspy behaviors (rail-level) are separate from chart hover and unaffected by this standard.

---

## 11. Data and React Rules

The presentation layer renders only. The reporting service owns the data.

- **React renders only.** Variance math, tone classification, commentary branching, seed numerics — all live in `src/lib/reporting/*.ts`. The chart components consume typed cards from the service.
- **No inline hex colors in chapter files.** Every color must come from `CHART_COLORS` / `CHART_STROKES` / `CHART_AXES` / `TOOLTIP_STYLE` in [chart-theme.ts](../src/components/reporting/chart-theme.ts).
- **No one-off chart styling inside chapter files.** Card chrome, geometry, tooltip placement, legend layout — all defined by primitives and theme tokens.
- **All chart colors, geometry, tooltip styling, and chart behavior must come from shared tokens / primitives.** Adding a new chart variant means extending the shared primitive additively, not creating a parallel implementation in a chapter file.
- **If a new chart requirement is needed, extend the shared primitive.** Adding a new optional prop is acceptable. Hand-rolling a new SVG in a chapter file is forbidden.

---

## 12. Validation Checklist

Before any chart work is considered complete:

- [ ] **Visually compare** against the matching Financial Performance reference chart side-by-side at 1440 × 900.
- [ ] **Color palette matches** — actuals are FP green; budget is FP gold; prior year is muted sage; unfavourable is FP clay; neutral is FP sand. No bright SaaS colors, no library defaults, no rainbow palettes.
- [ ] **Tooltip behavior** — adjacent to cursor (+12 / −12), never clipped, edge-flip works at left / right / top / bottom edges. Run [tests/e2e/chart-tooltip-edge-positions.spec.ts](../tests/e2e/chart-tooltip-edge-positions.spec.ts).
- [ ] **Legend layout** — color swatch + label + value on the same row. No detached values.
- [ ] **Donut separators** — visible cream sliver between every pair of adjacent slices (`gapDeg = 1.5°`).
- [ ] **Bar hover** — outline only (`0.5 → 2.4 px`), no translate, no scale, no geometry change. Card chrome unchanged.
- [ ] **Plot utilization (§9)** — at all five viewports, measure: (a) bar / line chart container ≥ 85 % of card inner width, (b) **data span ≥ 75 % of plot area AND ≥ 65 % of card inner width** (bars / line points distributed across the plot, not clustered in the centre), (c) **bar-width-to-step ratio ≤ 0.60** (bars are NOT widened beyond FP standard to fake plot utilization), (d) donut + legend visual group ≥ 85 % of card inner width. Run [tests/e2e/chart-plot-utilization.spec.ts](../tests/e2e/chart-plot-utilization.spec.ts).
- [ ] **Responsive behavior** — capture Playwright screenshots at **1366 × 768, 1440 × 900, 1600 × 900, 1920 × 1080, 2560 × 1440**. The chart must fill the card at every viewport.
- [ ] **Print mode** — toggle Print Mode on the shell; the chart still reads (no scrollbar appears, no overflow clip).
- [ ] **Vitest** — `npm run typecheck` clean; targeted vitest passes; [tests/reporting-chart-system.test.ts](../tests/reporting-chart-system.test.ts) passes (token + primitive contract pinned).
- [ ] **Locked Equity Value card guards** — run [tests/e2e/equity-multi-viewport.spec.ts](../tests/e2e/equity-multi-viewport.spec.ts) + zoom + alignment specs. They must continue to pass.

Final summary message must list:
- the reference chart compared against,
- the screenshots captured (path list),
- which validation items passed,
- the **plot utilization ratio at each of the five viewports** (`plotWidth / cardInnerWidth`) so future reviewers can confirm the chart isn't shrinking on large monitors.

---

## 13. Failure Conditions

These automatically fail design review — **no further review needed**:

- ❌ **Tooltip clipped by the chart card or viewport edge.**
- ❌ **Tooltip rendered far away from the cursor** (more than ~24 px offset, or anchored to the wrong corner).
- ❌ **Legend values detached from labels** (e.g. percent column floating on the far side of a wide body with no leader / connection).
- ❌ **Donut lacks visible white dividers between slices.**
- ❌ **Bar hover changes bar height, y-position, scale, or translation.**
- ❌ **Plot utilization** fails at any of the five required viewports — either the SVG/container is < 85 % of card inner width, OR the **rendered data span < 75 % of the plot area** (bars cluster in the centre even though the SVG is full-width), OR the donut + legend group < 85 % of card inner width (§9).
- ❌ **Bar chart bars visually cluster** in the centre of their slots with large empty padding on either side, even if the SVG appears full-width. A full-width SVG with thin bars is a canonical §9 failure.
- ❌ **Bar-width inflation to fake plot utilization** — bars widened beyond FP's `BAR_GEOMETRY.primaryWidthRatio = 0.55` (cap: 0.60 with rounding tolerance) to make the plot look full. Plot utilization must be achieved through layout, scale, and margins (e.g. reducing `padLeft` / `padRight`, using `outerPaddingRatio` for scaleBand-style distribution, and for few-category charts using a *lower* bar-width ratio that matches FP's absolute pixel width) — never by oversized bars.
- ❌ **Visual mismatch with the Financial Performance + Payroll reference charts**, even when every numeric utilization threshold passes. Bars that read as "blocky" or "heavy" next to FP / Payroll fail visual parity — the metric checks are a floor, not a ceiling. A chart must look like it belongs in the same report as the FP charts; the eye-test against a side-by-side Playwright crop is the final word.
- ❌ **Large-monitor regression** — a chart that looks centred / balanced at 1366–1440 but becomes **left-biased, right-biased, or develops large unused whitespace** at 1600 / 1920 / 2560. Charts MUST be visually validated at all five viewports; an automated-only pass without screenshot inspection is **not** sufficient.
- ❌ **Donut + legend group occupies less than ~80 % of the available visual width** at any viewport.
- ❌ **The composition scales components instead of layout** — wider bars, larger donut, or larger text at 2560 to "fill the card." The fix MUST be rebalanced column widths / responsive gutters / responsive legend positioning, not component inflation.
- ❌ **Axis typography fails the §9 Axis Typography Standard** — labels materially smaller than commentary text, requiring zooming, or differing from the `CHART_AXES` baseline. A chart primitive hardcoding `fontSize: "9px"` (or any literal font size) instead of consuming `CHART_AXES.axisLabelFontSize` / `xLabelFontSize` / `xLabelFontWeight` is an automatic fail — the shared token IS the standard.
- ❌ **Chart appears materially smaller / lighter than the Financial Performance reference** when viewed side-by-side at the same viewport.
- ❌ **Uses default chart-library colors** (bright blue, rainbow categorical palettes, etc.).
- ❌ **Uses chapter-specific inline styling** (inline hex colors, hand-rolled SVG geometry, local tooltip implementation).
- ❌ **Passes the test suite but does not visually match the reference.** Tests verify mechanics, not visual identity. The eye-test is the final word.

If any failure condition trips, the work is incomplete. Fix before requesting approval.

---

## Companion documents

| Doc | Purpose |
|---|---|
| [docs/reporting-chart-system.md](reporting-chart-system.md) | Architecture / API reference. Lists every primitive, every theme token, the author guide, the migration status table. |
| [src/components/reporting/chart-theme.ts](../src/components/reporting/chart-theme.ts) | The single source of truth for chart colors, typography, geometry, tooltip styling. |
| [tests/reporting-chart-system.test.ts](../tests/reporting-chart-system.test.ts) | Source-contract guard — pins token values + primitive APIs. |
| [tests/e2e/chart-tooltip-edge-positions.spec.ts](../tests/e2e/chart-tooltip-edge-positions.spec.ts) | Behavioral guard — proves the tooltip portal + edge-flip work. |
| [tests/e2e/chart-system-side-by-side.spec.ts](../tests/e2e/chart-system-side-by-side.spec.ts) | Visual-evidence capture — produces the FP-vs-new-chapter side-by-sides referenced in §2's eye-test. |

# Equity Value Over Time card — APPROVED BASELINE (LOCKED)

> **Status:** Locked baseline as of 2026-06-13.
> No further visual or data changes to the Equity Value Over Time card
> are permitted **unless explicitly requested by the founder**.
>
> This document is the **canonical specification** for the card. Any
> change to the card must update this document in the same commit, and
> the regression tests listed in §6 must continue to pass.

The Equity Value Over Time card sits inside the **Stewardship Dashboard**
of Chapter II ("Chair's Dashboard / Visual Summary") of the Monthly
Board Reporting Package. It is the highest-prestige reporting surface
in the product and the visual reference all other reporting cards
should be judged against.

Source locations:

- Card component — [src/app/app/admin/reporting/monthly/page.tsx](../src/app/app/admin/reporting/monthly/page.tsx) (`EquityValueCard`)
- Chart renderer — [src/components/reporting/EditorialLineChart.tsx](../src/components/reporting/EditorialLineChart.tsx)
- Accounting service — [src/lib/reporting/equity-history.ts](../src/lib/reporting/equity-history.ts)
- Display-format service — `formatEquityDashboard` in [src/lib/reporting/monthly-package.ts](../src/lib/reporting/monthly-package.ts)
- Commentary generator — [src/lib/reporting/equity-commentary.ts](../src/lib/reporting/equity-commentary.ts)

---

## 1. Data sourcing rules

| Element | Source | Rule |
|---|---|---|
| **Actual CAGR** (`actualCagrLabel`) | computed from `FiscalYear.closingEquity` time series via `computeCagrBps()` | MUST come from the accounting record. Never a hardcoded percentage in the React tree, never a hand-tuned demo string. |
| **Current Equity** (`currentValueLabel`) | the latest `FiscalYear.closingEquity` (falls back to a live `balanceSheet()` snapshot when an FY closed without `closingEquity`) | MUST come from the accounting record. Never a hardcoded dollar figure in the React tree. |
| **Best-in-class CAGR benchmark** | `ClubProfile.equityBenchmarkBestCagrBps` | MAY be a configuration assumption (board-blessed peer reference). Stored in basis points so it's integer-safe. |
| **Min. required CAGR benchmark** | `ClubProfile.equityBenchmarkMinCagrBps` | MAY be a configuration assumption (inflation-parity floor). Same storage rule. |
| **Equity history series** | `getEquityHistory(clubId, asOf)` | MUST be club-scoped. The page never imports raw data; it consumes the reporting service. |

**Rule 1.** Actual CAGR and Current Equity come from accounting/reporting data, NOT from React-tree literals.
**Rule 2.** Benchmark rates (best-in-class, minimum-required) may be configuration assumptions on `ClubProfile`.

## 2. X-axis (year window)

**Rule 3.** The x-axis displays the **last eight COMPLETED year-end equity values** relative to the reporting period.

- `getEquityHistory` filters `FiscalYear` with `endDate < asOf`, orders by `endDate desc`, takes the most recent eight, and reverses for chronological rendering.
- In-progress / open fiscal years (where `endDate >= asOf`) are excluded.
- Labels are CALENDAR YEARS (e.g. `"2018"`, `"2025"`) — NEVER `"FY2018"` / `"FY25"`.
- `fyShort` strips the `"FY"` prefix from any fiscal-year label before it reaches the chart.

Window rolls over automatically as new fiscal years close — May 2026 reports → `2018 … 2025`; January 2027 reports → `2019 … 2026`.

## 3. Y-axis (domain)

**Rule 4.** `yAxisMin` = `floor(firstActualM / 5) × 5` (nearest $5M increment below the first plotted value).
**Rule 5.** `yAxisMax` = `ceil(highestM / 5) × 5` (nearest $5M increment above the highest plotted **actual or benchmark** value).

- `yAxisTicks` = `max(2, round((yAxisMax − yAxisMin) / 5))`.
- The increment constant `ROUND_INC_M = 5` (millions) is defined in `formatEquityDashboard`.
- The chart consumes `yDomain={[data.yAxisMin, data.yAxisMax]}` and `yTicks={data.yAxisTicks}` — never hardcoded literals.

## 4. SVG / rendering invariants

**Rule 6.** The SVG must render at **uniform scale**. `preserveAspectRatio` must NEVER be set to `"none"`.

- `EditorialLineChart` uses the default `preserveAspectRatio="xMidYMid meet"` (uniform).
- The viewBox WIDTH is dynamic — `ResizeObserver` tracks the container and updates the viewBox width to match. This is what eliminated the cream-gutter bug at viewports ≥ 1600 px.
- `shapeRendering: "geometricPrecision"` and `textRendering: "geometricPrecision"` are required for crisp markers + sharp text.
- Data-point markers are `<circle>` with `r=3` — NEVER `<ellipse>` (which would render oval).

## 5. Alignment & layout invariants

**Rule 7.** The y-axis label column's LEFT edge MUST align with the LEFT edge of the **Actual CAGR** KPI tile. Tolerance: **4 px**.

- Achieved by `padLeft={44}` on `EditorialLineChart` (default 66).
- The widest y-label (`"$35M"`) is right-anchored at `padL − 8` viewBox px; its left edge lands within ~1 px of the KPI tile edge at 1440 × 900.

**Rule 8.** The rightmost plotted point (the FY2025 marker) MUST align with the RIGHT edge of the **Current Equity** KPI tile. Tolerance: **4 px**.

- Achieved by `padRight={14}` on `EditorialLineChart` (default 31).
- The last x-axis label is text-anchor=end at the same x, so its right edge also aligns.

**Rule 9.** The legend MUST use **real line samples** — short stroked segments that mirror each chart line's exact `stroke / strokeWidth / dasharray / opacity`, with an optional centered marker. NEVER use filled-rectangle "swatches" for line-chart legends.

- Centered on the plot region's mid-X (legend group's `chartCenterX = padL + innerW/2`).
- Inter-item spacing ≈ 20 vb units (Saguaro-tight grouping, not edge-to-edge).
- Club Equity carries the round marker that also sits on every data point of the actual line.

## 6. Commentary

**Rule 10.** Commentary is **dynamically generated** from chart results by `buildEquityCommentary()` in `src/lib/reporting/equity-commentary.ts`. It MUST NOT reference "pillars" or any of the framework's stewardship-pillar terminology — Monthly Board Reporting Package commentary speaks the finance-chair's language, not internal product taxonomy.

Four branches, evaluated in order:

1. `actual ≥ best-in-class` → `above-best-in-class`
2. `|actual − min| ≤ 25 bps` → `near-minimum`
3. `actual < min` (and not near) → `below-minimum`
4. otherwise → `between-min-and-best`

Calendar-year string only (`"2018"`, never `"FY2018"`). Percentages are bolded via `**…**` markers parsed by `renderInterpretation`.

**Rule 11.** Commentary shading is **inset** from the card edges (≥ 14 px gutter on left and right) and wraps the text only — does NOT extend to the card bottom edge.

- Outer wrapper: `px-3.5` and fixed band height.
- Inner `<p>` carries the `rgba(63,112,66,0.10)` tint plus a 3 px deep-green `borderLeft` accent — NO `h-full` (sizes to content + 10 px padding).
- Verified by `commentaryLeftInset ≥ 10 px`, `commentaryRightInset ≥ 10 px`, `commentaryBottomGap > 0`, `commentaryToCardBottomGap > 0`.

## 7. Header / typography

**Rule 12.** The subtitle ("question") MUST be **readable** at board-package viewing distance while remaining **subordinate** to the serif title.

Approved values (locked):

| Property | Value |
|---|---|
| `font-size` | **10.5 px** (was 9 px; +17 %) |
| `color` | `text-club-cream/70` → computed `rgba(248, 245, 239, 0.7)` (was /45) |
| `letter-spacing` | **0.7 px** (was 1.1 px; −36 %) |
| case / weight | uppercase smallcaps, regular weight |
| line-height | 1.35 |

NOT bold, NOT oversized, NOT dashboard-like.

## 8. Responsive behaviour

**Rule 13.** Responsive behaviour MUST be validated at multiple viewport widths.

Approved viewports (admin / desktop):

| Width | Required check |
|---|---|
| 1366 | card renders, no horizontal scroll, plot data span fills the card |
| 1440 | exact alignment numbers in §6 hold |
| 1600 | plot data span GROWS with the wider card; no cream gutter |
| 1920 | plot data span GROWS again; no fixed-viewBox cap |
| 2560 | plot data span continues to grow proportionally; gutters do NOT |

The SVG viewBox WIDTH is bound to the container width via `ResizeObserver`, so the data plot grows with the card. Tested by `tests/e2e/equity-multi-viewport.spec.ts`.

---

## 9. Locked-in regression guards

The behaviours that future changes MUST NOT reintroduce, and the test that catches each:

| Regression | Caught by |
|---|---|
| Hardcoded equity KPI values in React (`"7.4%"`, `"$31.0M"`, `"5.5%"`, `"3.5%"`) | `tests/monthly-reporting-package.test.ts` — "Equity Value Over Time card has NO hardcoded equity arrays" |
| Hardcoded chart arrays (`value: 18.83`, `label: "2018"`, etc.) in `page.tsx` or `monthly-package.ts` | same test |
| Stretched SVG text (`preserveAspectRatio="none"`) | `tests/monthly-reporting-package.test.ts` — locked-baseline guard (§ below) |
| Oval markers (`<ellipse` in the chart) | same |
| FY-style x-axis labels (`"FY2018"` etc.) | `tests/equity-commentary.test.ts` + locked-baseline guard |
| Compressed / clipped legend (filled rects instead of line samples) | locked-baseline guard — chart must contain `LegendEntry` with `stroke` / `strokeWidth` / `showMarker` fields, not `swatch` |
| Commentary shading touching card edge / bottom | `tests/e2e/equity-legend-kpi-measure.spec.ts` (now asserts positive insets and bottom gap) |
| Chart gutters growing on large monitors (i.e. SVG viewBox not following container width) | `tests/e2e/equity-multi-viewport.spec.ts` — plot data span MUST grow at 1600 / 1920 / 2560 |
| Operating Results changes while editing Equity card | locked-baseline guard — `OperatingResultsCard` source pin: NOT `layout="chart-dominant"`, NOT `insetCommentary`, NOT `padLeft=` / `padRight=` |

## 10. Geometry contract (the four locked numbers)

These numbers are the alignment invariants. Changing any of them requires founder sign-off:

| Symbol | Value | Why |
|---|---:|---|
| `padLeft` (Equity card) | **44** | Y-axis label column LEFT edge = Actual CAGR tile LEFT edge |
| `padRight` (Equity card) | **14** | Rightmost data marker = Current Equity tile RIGHT edge |
| `chartHeight` (chart-dominant) | **245** | Chart is the hero; ≈ 4× the KPI ribbon |
| `commentaryHeight` (chart-dominant) | **100** | Holds ≈ 95 px of text + padding with a small bottom gap so shading hugs the text |
| `kpiHeight` (chart-dominant) | **60** | Compact score strip; supports the chart |

## 11. Definition of "done" for the Equity card

A change is complete only when ALL of the following hold:

1. `npm run typecheck` clean.
2. `tests/equity-history.test.ts` + `tests/equity-commentary.test.ts` + `tests/monthly-reporting-package.test.ts` all pass.
3. `tests/e2e/equity-legend-kpi-measure.spec.ts` passes (asserts the alignment + commentary deltas).
4. `tests/e2e/equity-multi-viewport.spec.ts` passes at all five admin viewports.
5. This document is consistent with the rendered card.
6. The change list specifies what visual / data behaviour it added, removed, or moved.

---

## 12. Change log

- **2026-06-13** — Card LOCKED as approved baseline. Founder sign-off after right-edge alignment + commentary inset/hugging + subtitle readability bumps. All thirteen rules above codified into source-contract + Playwright-assertion tests.

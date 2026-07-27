# Spectre Automation — Claude Code operating rules

## Product
A multi-tenant SaaS operating system for private golf and country clubs:
member onboarding, AR, collections, financing, AP, accounting, events, POS,
member portal. One shared codebase, isolated per club via `clubId`.

## Stack
- Next.js 14 App Router + TypeScript (strict)
- Prisma ORM (SQLite dev, Postgres-ready)
- iron-session cookies + bcrypt
- Zod for validation
- Vitest for tests

## Architecture rules
- Every club-scoped table carries `clubId`. Every query that returns those
  rows MUST be scoped via `tenantWhere`, `tenantScope`, or an explicit
  `clubId` filter. Reads from `findUnique` MUST be followed by
  `assertTenantOwned`.
- Reads of denormalized balances come from `MemberAccount`; never compute
  balances in the UI or in ad-hoc queries.
- All sensitive writes call `audit()` with action/entityType/entityId.
- Money is `Decimal`. Float math is forbidden in posting paths.

## Posting boundaries (financial)
Every posting / mutation function MUST call `assertPostingAllowed(principal,
clubId, action, entityType, entityId)` from `src/lib/posting-guard`.
This composes the training-mode gate and the support-readonly gate.
Sensitive non-financial admin actions (secret rotation, billing edits) use
`assertSensitiveActionAllowed()`.

## No-placeholder rule
Production code must not contain TODO, "coming soon", "not implemented",
"placeholder", "mock-only", "scaffold only", "future implementation",
or "temporary" without being on the allowlist in
`config/placeholder-allowlist.json`. Run `npm run scan:placeholders`
before declaring work done. If a piece of behaviour is mock-only,
**label it visibly in the UI** — do not let it look real.

## Discoverability rule
Every new user-facing route must be reachable from the existing UI
before the task is complete. A feature is not done if a non-technical
user has to know the URL or file path to access it.

Concretely:
- Top-level workflows go in the persistent sidebar
  (`src/components/Sidebar.tsx`) with the same permission key as the
  page's server-side guard.
- Sub-features go on the relevant hub page as a module card (e.g.
  `/app/admin/hospitality`, `/app/admin/ops`).
- Detail / sub-form routes (`/X/[id]`, `/X/new`) are reachable from
  their parent list page via a row link or "+ New" button.
- Run `npm run nav:audit` before declaring done. Zero URL-only orphans
  is the bar. Genuinely-internal routes are allowlisted in
  `scripts/nav-audit.ts` with a one-line reason.
- See `docs/navigation-audit.md` for the current state.

## UI quality rule
- Every page has a meaningful empty state, a clear error state, and a
  loading state where async work isn't instant.
- Action buttons confirm destructive operations.
- Status badges, table chrome, and form layouts match existing patterns —
  use `Badge`, `card`, `table-base`, `btn-primary/secondary/sm`.
- A feature is not "done" until the golden path AND at least one edge
  case have been clicked through in a browser, not just type-checked.

## Spectre Product Design Standard
Claude is responsible for making sensible UX decisions, not for blindly
satisfying the prompt. UI work optimises for **operational speed,
readability, touch usability, and visual balance** — in that order.

- **Empty whitespace is a defect when meaningful information could be
  shown.** If a card, panel, or grid has dead space, fill it with
  useful content (more rows, a description, a status hint) before
  shipping.
- **POS item tiles must use available tile space intelligently.** A
  card with title, description, and price expands the description
  area before leaving blank space. Every tile in a category renders
  at one fixed `tileHeight` per density tier (160 / 140 / 110 / 90 px
  for descriptive / standard / compact / dense). Uniform rows,
  predictable grid; intentional whitespace inside short-description
  tiles is the accepted cost of a clean menu.
- **Self-review like a product designer, not just a developer.**
  Before declaring done, look at the screen and ask: "Would a server
  on a Friday night reach the action they need in one tap? Is
  information dense without being noisy? Does the eye know where to
  land first?" If the answer is no, fix it.
- **UI work is not done just because tests pass.** Source-contract
  tests confirm the code shape; they do not confirm the rendered
  result. Open the screen, count tiles, measure shapes in DevTools,
  click the workflow.
- **Final summaries for UI work must include**: (a) what was
  improved visually, (b) what was measured in the browser
  (dimensions, columns, font sizes), and (c) the exact click path
  to verify.

For hospitality / POS surfaces specifically, see
[.claude/skills/ui-product-design/SKILL.md](.claude/skills/ui-product-design/SKILL.md).

## Responsive Design Verification — Mandatory

Spectre is a **web-based SaaS product**. It runs in browsers across a
range of monitor sizes from compact laptops to 4K boardroom displays.
No UI change is complete merely because it looks correct at one
viewport. A page that renders well at 1440 × 900 but wastes half its
horizontal real estate at 1920 or 2560 is a defect, not a finished
feature.

Rules:

1. **All visual changes must be checked across multiple viewport
   sizes.** Not the one viewport you happen to be working at.
2. **A passing screenshot at one laptop-sized viewport is not
   enough.** It is the easiest viewport for a layout to look fine
   at; it is also the least informative.
3. **Validate at minimum these admin / desktop viewports:**
   - 1366 × 768
   - 1440 × 900
   - 1600 × 900
   - 1920 × 1080
   - 2560 × 1440
4. **For member-facing or mobile-sensitive workflows, also
   validate:**
   - 390 × 844 (iPhone-class portrait)
   - 768 × 1024 (tablet portrait)
5. **Components must use available space proportionally as screen
   size grows.** Growing the window must grow the content, not just
   add cream gutter.
6. **Charts, tables, cards, dashboards, and reports should not
   remain fixed-width inside larger containers** unless the max-width
   is intentional and documented (e.g. an editorial column cap on a
   long-form prose surface, declared in the component).
7. **Large monitors must not create excessive gutters, dead space,
   or unused horizontal real estate.** A 4K screen with a chart
   floating in a 600-px island of cream is a bug.
8. **For charts, always measure:**
   - container width
   - rendered chart width
   - actual plot area width
   - left gutter (card-content-LEFT → first plotted data point)
   - right gutter (last plotted data point → card-content-RIGHT)
   - plot utilization ratio (data span ÷ container width)
9. **Do not use parent container dimensions as proof that the
   actual rendered content is aligned or responsive.** A 1920-px-wide
   `<div>` does not prove the SVG inside it grew. Measure the SVG, the
   plot region, the data points themselves.
10. **Measure actual rendered elements where relevant:**
    - SVG text (via `SVGTextElement.getBBox()` + `getScreenCTM()`)
    - SVG circles / paths (same)
    - Canvas plot regions (via `Chart.js getDatasetMeta`, or the
      equivalent for whatever renderer)
    - Table boundaries
    - Card content edges
11. **Playwright screenshots are evidence, not proof.** Claude must
    state what was measured at each viewport and why those numbers
    prove the layout is responsive. A pile of screenshots without a
    measurement table is not a verification.
12. **If a layout looks correct at 1440 px but wastes space at
    1920 px or 2560 px, the implementation is incomplete.** The
    multi-viewport audit is part of "done," not an optional follow-up.

### Monthly Board Reporting Package — specific note

Monthly Board Reporting Package pages are premium executive-reporting
surfaces. Charts must scale with available width, remain readable on
larger monitors, avoid excessive gutters, and visually occupy their
intended report area. A chart that appears centered, compressed, or
fixed-width inside a larger card is a defect even if it technically
aligns at one viewport.

Concretely, before declaring any change under
`/app/admin/reporting/**` complete:

- Capture Playwright at 1366, 1440, 1600, 1920, and 2560.
- Measure data span, left/right gutters, and plot utilization at each
  viewport (not just the SVG container — the actual plotted data).
- Confirm that gutters do not balloon and the data span grows with
  the card.
- Add or update a multi-viewport regression spec (see
  `tests/e2e/equity-multi-viewport.spec.ts` as the reference shape)
  so the same bug cannot regress unnoticed.

A chart whose data span caps at any width below the card's available
width is a fixed-viewBox / fixed-canvas bug. Make the renderer
container-aware (e.g. `ResizeObserver` + dynamic viewBox for SVG, or
Chart.js's responsive mode for canvas) and re-measure across all five
admin viewports.

## Financial Reporting Data Integrity — Mandatory

**Spectre is an accounting system first and a reporting system
second.** Every financial reporting output must be generated from the
same underlying reporting dataset as the related KPIs, charts,
commentary, scorecards, dashboards, and exports.

Financial reporting surfaces include:

- KPI cards
- charts
- graphs
- scorecards
- dashboard metrics
- trend lines
- variance tables
- commentary
- board reporting packages
- committee reporting packages
- PDFs
- exports

### Single source of truth — chain

All financial reporting outputs must follow this chain:

`Accounting Records → Reporting Service → KPI Calculations → Visualizations → Commentary`

The following are **prohibited** unless explicitly approved by the
founder and clearly marked as temporary demo-only work:

- hardcoded KPI values
- hardcoded chart arrays
- hardcoded commentary numbers
- visual-only demo values disconnected from accounting records
- separate chart calculations that do not reconcile to KPI cards
- separate commentary calculations that do not reconcile to charts
- React components containing financial result values that should
  come from the reporting service

### Reconciliation requirement

For every financial visualization, Claude must be able to prove that:

- every chart point
- every chart bar
- every KPI card value
- every budget value
- every prior-year value
- every variance
- every commentary figure

comes from the **same** accounting/reporting source — or a clearly
identified benchmark / config source.

Only benchmark, best-in-class, or policy-threshold values may be
configuration-driven. Actual and budget values must come from
accounting, budget, or reporting records (or seeded reporting data
that flows through the reporting service, not React).

### Required audit before any financial reporting change

Before modifying any financial reporting component, Claude must
identify, **in writing** in the response to the user:

1. accounting source
2. budget source
3. reporting service
4. KPI calculation
5. chart calculation
6. commentary calculation
7. benchmark / config source, if applicable

Claude must explicitly state whether KPIs, charts, and commentary
reconcile to the same underlying dataset. If this cannot be proven,
the task is **not complete**.

### Required tests

For any financial reporting change, Claude must add or update tests
proving:

1. KPI values are not hardcoded in React.
2. Chart series are not hardcoded in React.
3. Commentary figures are not hardcoded in React.
4. Actual values come from accounting / reporting data.
5. Budget values come from budget / reporting data.
6. Benchmarks may come from benchmark configuration.
7. KPI values reconcile to chart values.
8. Commentary figures reconcile to KPI / chart values.
9. Changing seeded accounting or budget data changes the output
   (input sensitivity).
10. Existing locked baseline cards, including
    [Equity Value Over Time](docs/equity-value-over-time-card-spec.md),
    are not regressed.

### Required final response format

For any future financial reporting task, Claude must return:

- accounting source
- budget source
- reporting service used
- KPI calculation proof
- chart calculation proof
- commentary calculation proof
- benchmark / config source
- tests run
- explicit confirmation that KPIs, charts, and commentary
  reconcile to the same underlying dataset

The first three rules under this section (single source of truth,
reconciliation, audit) are the **MUST**; the tests and response
format make those rules verifiable. Skipping any of them is a
violation of these operating rules.

## Reactive Commentary for Financial Reporting — Mandatory

**In Spectre, commentary boxes in financial reports are not static
copy.** Every commentary box attached to a graph, chart, KPI card,
scorecard, or variance table must be generated from the same
reporting dataset that produces the related visual and KPI values.

The commentary must explain the actual result being displayed. It
must not remain unchanged when the underlying numbers change.

### Applies to

- Monthly Board Reporting Package commentary
- KPI card commentary
- chart commentary
- graph commentary
- scorecard commentary
- dashboard commentary
- variance explanations
- executive summaries
- board-report narrative blocks
- finance committee packages
- exported PDFs

### Required data chain

All commentary must follow the same source chain as the visual:

`Accounting Records → Reporting Service → KPI / Chart Calculation → Commentary Generator → Display`

Commentary should not bypass the reporting service. The numerals it
displays must be the SAME numerals the chart and KPI tiles display
— produced by the same computation, not parallel hand-written copy.

### Prohibited patterns

The following are **prohibited** unless explicitly approved by the
founder and clearly marked as temporary demo-only work:

- static commentary text containing financial figures
- hardcoded percentages in commentary
- hardcoded dollar values in commentary
- hardcoded favorable / unfavorable language
- commentary that does not change when KPI / chart values change
- commentary that contradicts the graph or KPI cards
- React components containing financial commentary strings directly
- commentary templates that use fixed numbers instead of calculated
  inputs

### Required commentary generator

Every financial commentary box must be produced by a commentary
generator (a reporting-narrative function) — never typed inline in
React. The generator MUST receive calculated inputs such as:

- actual result
- budget result
- prior-year result
- variance
- benchmark
- threshold
- trend direction
- reporting period
- status classification

The generator MUST then select the correct executive narrative
branch based on those inputs.

### Required branching logic

Commentary must react to materially different outcomes. Branches
should distinguish at minimum:

- actual is ahead of budget
- actual is behind budget
- result is within policy range
- result is outside policy range
- prior-year deficit has been recovered
- prior-year deficit has not been recovered
- benchmark is exceeded
- benchmark is missed
- trend is improving
- trend is deteriorating

A single generic paragraph reused for every case is a violation of
this rule.

### Tone requirement

Commentary must remain:

- executive
- concise
- board-report appropriate
- finance-chair tone
- analytical, not promotional
- free of SaaS language
- free of filler
- free of pillar references unless the page specifically requires them

The commentary explains what the result MEANS — it does not merely
restate the KPI numbers verbatim.

### Reconciliation requirement

For any commentary box, Claude must be able to prove that **every
number** in the commentary reconciles to the related chart, KPI, or
reporting service output. Examples:

- If commentary says `$45K`, that number must reconcile to the KPI
  and chart source.
- If commentary says `0.3%`, that percentage must reconcile to the
  calculated ratio.
- If commentary says `prior year's ($193K) deficit`, that amount
  must reconcile to prior-year reporting data.
- If commentary says `+3.9 pts`, that variance must be calculated
  from current and prior-year metrics.

### Required tests

For any financial reporting commentary change, Claude must add or
update tests proving:

1. Commentary is not hardcoded in React.
2. Commentary figures reconcile to KPI values.
3. Commentary figures reconcile to chart values.
4. Commentary changes when the underlying accounting / reporting
   data changes.
5. Commentary changes when budget / prior-year / benchmark inputs
   change.
6. Commentary branch changes when results move from favorable to
   unfavorable (or any cross-threshold transition).
7. Commentary does not contradict the chart or KPI cards.
8. Commentary does not reference unsupported concepts such as
   pillars unless intentionally required.

### Required final response format

For any future financial reporting commentary task, Claude must
return:

- commentary generator location
- input dataset used
- calculation proof for every number in the commentary
- branch logic used
- tests proving commentary reacts to changed inputs
- confirmation that the commentary reconciles to the related
  graph / chart / KPI

This rule is a direct extension of
[Financial Reporting Data Integrity — Mandatory](#financial-reporting-data-integrity--mandatory).
The integrity rule covers the **data**; this rule covers the
**narrative around the data**. Both apply on every reporting change.

## Reporting Period Golden Rule — Mandatory

**Every section in the Monthly Reporting Package must be active and
responsive to the single selected reporting period.** No section may
hardcode `Q1`, `March`, `March 31`, `quarter-to-date`, `year-to-date`,
`January 1 — March 31`, `Mar Budget`, or any other calendar / period
descriptor unless that string is derived from the canonical
`ReportingPeriod` object.

Applies to:

- Section headers + eyebrows + italic period meta lines
- Table column labels (current-month, current-quarter, YTD)
- Chart titles, x-axis labels, legends, trend windows
- Inline commentary that quotes a date range
- Footnotes + footer statement-number lines
- Reactive commentary block eyebrows (e.g. "CFO Commentary — May 2026")
- Export / PDF / print metadata

### Canonical Period Source

There is **one** canonical period source: `src/lib/reporting/reporting-period.ts`.

```ts
export function buildReportingPeriod(periodEnd: Date, opts?: {
  periodStart?: Date;
}): ReportingPeriod;
```

The Monthly Reporting Package builder
([src/lib/reporting/monthly-package.ts](src/lib/reporting/monthly-package.ts))
constructs ONE of these per package build, immediately after
`periodEnd` is resolved, and threads it into every section's data
builder.

### Required behaviour on every reporting change

1. **Every section data builder MUST receive `period: ReportingPeriod`
   as an argument.** Threading it is not optional.
2. **Components render only pre-formatted strings off the period
   object** — no `toLocaleString`, no template literals over `Date`,
   no embedded month names in JSX, no hardcoded "Mar Budget" /
   "Q1 2026" / "March 31, 2026".
3. **Every new section MUST ship a period-regression unit test** that
   flips `periodEnd` to a different month and asserts every
   period-derived label flips with it.
4. **The forbidden-string lint guard
   ([tests/reporting-period-golden-rule.test.ts](tests/reporting-period-golden-rule.test.ts))
   must pass.** When a new period regression class is found, add it
   to the guard's `FORBIDDEN` list.

The full standard, allowed exceptions, and worked examples live in
[docs/reporting-package-period-golden-rule.md](docs/reporting-package-period-golden-rule.md).
Read it before adding any new reporting section.

### Required final response format

For any future reporting-period-affecting change, Claude must return:

- the `ReportingPeriod` field(s) consumed by the new section
- proof the section accepts `period: ReportingPeriod` as an argument
- the period-regression test added (test name + the period flip used)
- confirmation that `npx vitest run tests/reporting-period-golden-rule.test.ts` passes

## Equity Value Over Time card — LOCKED BASELINE

The Equity Value Over Time card (Chapter II · Stewardship Dashboard ·
[src/app/app/admin/reporting/monthly/page.tsx](src/app/app/admin/reporting/monthly/page.tsx)
→ `EquityValueCard`) is **APPROVED as of 2026-06-13** and is the
reference all other reporting cards should be judged against.

**No further visual or data changes to this card are permitted unless
the founder explicitly requests them.**

Before touching the card, the chart, the commentary generator, or the
accounting service that feeds it, read:

- [docs/equity-value-over-time-card-spec.md](docs/equity-value-over-time-card-spec.md) — the canonical 13-rule specification, the four locked geometry numbers (`padLeft=44`, `padRight=14`, `chartHeight=245`, `commentaryHeight=100`), and the named regression guards.

The locked surfaces, in order of "do not edit":

1. `EquityValueCard` — `EditorialLineChart` props (`padLeft`, `padRight`, `height`, legend), KPI tiles, the `insetCommentary` + `layout="chart-dominant"` flags on `StewardshipCard`, and the header subtitle styling.
2. `EditorialLineChart` — the legend rendering, the `padLeft / padRight` prop wiring, and the `ResizeObserver` viewBox-width hook (touching any of these breaks responsive behaviour at ≥ 1600 px viewports).
3. `formatEquityDashboard` in `monthly-package.ts` — y-axis domain math (`$5M` rounding) and the `firstYear` string passed to the commentary generator.
4. `buildEquityCommentary` in `equity-commentary.ts` — the four-branch classifier and the exact sentence templates.
5. `getEquityHistory` in `equity-history.ts` — the "completed-FYs-only" filter (`endDate < asOf`) and the live-balance-sheet fallback.
6. `OperatingResultsCard` — explicitly **untouched** while editing Equity. The locked guard pins that this card does NOT carry `padLeft` / `padRight` / `layout="chart-dominant"` / `insetCommentary`.

Any change that wants to alter these surfaces must:

1. Cite founder approval in the prompt or PR description.
2. Update [docs/equity-value-over-time-card-spec.md](docs/equity-value-over-time-card-spec.md) in the same change.
3. Re-run the regression gates listed in §9 of that doc.

## Reporting work — required reading (framework + design system + first-scroll standard + chart system + chart governance)
Before modifying **any** of the following, Claude MUST read **all five**:

1. [docs/spectre-framework.md](docs/spectre-framework.md) — the
   foundational reporting philosophy: five stewardship pillars
   (Operating, Capital, Balance Sheet, Membership, Experience) and
   the four questions every reporting screen must answer (*what
   happened / why does it matter / is the trend improving or
   deteriorating / does the Board need to take action*).
2. [docs/spectre-executive-reporting-design-system.md](docs/spectre-executive-reporting-design-system.md) —
   the canonical design system: typography hierarchy (5 levels),
   color philosophy (deep green / ivory / muted gold; no SaaS
   colors), layout discipline (whitespace intentional, cards
   minimized, borders reduced), narrative affordances, and the
   delete-on-sight list.
3. [docs/spectre-first-scroll-reporting-standard.md](docs/spectre-first-scroll-reporting-standard.md) —
   the **non-negotiable first-scroll rule**: *"A Board member must
   understand the Club's operating health, financial health, capital
   health, and required actions before the first scroll."* Defines
   the required first-viewport content, anti-patterns, the visual-QA
   four-question audit, and the Playwright screenshot requirement.
4. [docs/reporting-chart-system.md](docs/reporting-chart-system.md) —
   the **canonical chart system** (2026-06-19). Every chart in the
   reporting package MUST consume the shared primitives
   (`EditorialDonut`, `EditorialInteractiveBarChart`,
   `EditorialBarChart`, `EditorialLineChart`, `ChartTooltip`) and
   read tokens from `src/components/reporting/chart-theme.ts`.
   Hand-rolling a new SVG chart in a chapter file is forbidden —
   extend the primitives additively instead.
5. [docs/monthly-reporting-chart-governance.md](docs/monthly-reporting-chart-governance.md) —
   the **permanent chart governance** (2026-06-21). The visual
   parity standard for every chart in the Monthly Board Reporting
   Package. Reference standard is the **Financial Performance
   chapter** (chapter II). Defines donut / bar / line / tooltip /
   legend / card-layout / interaction / data rules, a mandatory
   validation checklist, and a list of automatic failure
   conditions.

## Monthly Reporting Chart Rule — Mandatory

**Before creating, editing, or migrating ANY chart in the Monthly
Board Reporting Package, Claude Code MUST:**

1. Read [docs/monthly-reporting-chart-governance.md](docs/monthly-reporting-chart-governance.md)
   in full.
2. Read [docs/reporting-chart-system.md](docs/reporting-chart-system.md)
   to confirm which shared primitive applies.
3. Capture a side-by-side Playwright screenshot of the matching
   Financial Performance reference chart and the chart being
   worked on, at 1440 × 900.
4. Execute the validation checklist (§12) and confirm zero failure
   conditions (§13) from the governance doc.

**Before approving ANY Monthly Reporting Package chart, Claude
Code MUST verify (per the Plot Utilization Standard, §9 of the
governance doc):**

- The chart uses the full available card width (no tiny chart
  floating in a large empty card).
- **Plot utilization means the ACTUAL RENDERED DATA MARKS use the
  plotting space — not just that the SVG container is full-width.**
  A full-width SVG with bars clustered in the centre still fails
  the standard. Always measure the data span (first-bar-left →
  last-bar-right), not only the container.
- At ALL five supported viewport sizes (1366, 1440, 1600, 1920,
  2560), the chart passes:
  - For bar / line charts: container ratio ≥ **85 %** of card
    inner width, **AND** data-span vs plot area ≥ **75 %**, **AND**
    data-span vs card inner width ≥ **65 %**, **AND**
    bar-width-to-step ratio ≤ **0.60** (FP standard is 0.55 —
    bars MUST NOT be widened beyond FP to inflate plot utilization).
  - For donut + legend layouts: the combined donut+legend visual
    group width ≥ **85 %** of card inner width.
- **The correct way to fill a plot for a few-bar chart is NEVER
  to widen the bars.** Instead:
  1. Reduce `padLeft` / `padRight` so the plot grows.
  2. Pass `outerPaddingRatio={0}` so the first / last bar sit at
     the plot's left / right boundaries.
  3. **Use a LOWER `barWidthRatio` so the absolute bar pixel
     width matches FP Operating's bars (~4.8 % of plot width).**
     FP's `BAR_GEOMETRY.primaryWidthRatio = 0.55` is the CAP, not
     the target — matching only the ratio at N=4 produces 90+ px
     blocky bars that fail visual parity with FP / Payroll. Solve
     `barW / plot = 0.048` from `barW = plot × R / (N − 1 + R)`
     (at outerPad=0) — for N=4 this gives R ≈ 0.15.
- **Approval is based on VISUAL PARITY** with the Financial
  Performance + Payroll bar charts in the same report — not on
  numeric utilization metrics alone. A chart that satisfies all
  thresholds while reading visually different from FP / Payroll
  is still a §13 failure. Always capture a side-by-side Playwright
  crop (FP Operating + Payroll Department Breakdown + the new
  chart) before declaring done.
- **Large-monitor responsive validation is mandatory.** Every
  chart MUST be **visually inspected at all five viewports**
  (1366, 1440, 1600, 1920, 2560) — not just at one or two. A
  passing automated test is NOT sufficient. Claude must open each
  viewport's screenshot and verify NONE of the §13 fail conditions
  trip:
  - large unused whitespace inside the card
  - chart visually anchored to one side
  - donut + legend group < ~80 % of available visual width
  - centred at 1440, biased at 1920 / 2560
  - visual balance differs between laptop and large-monitor views
- **Scale layout, not components.** Wider bars, larger donut, or
  larger text at 2560 to "fill the card" is forbidden. Use
  responsive column widths, gutters, legend positioning, and
  grid allocation instead.
- Screenshots are captured at both **laptop** (1366, 1440) AND
  **large-monitor** (1920, 2560) widths so future review evidence
  exists.
- The plot-utilization regression spec
  [tests/e2e/chart-plot-utilization.spec.ts](tests/e2e/chart-plot-utilization.spec.ts)
  is updated to cover the new chart, and passes.

A chart that scales correctly at 1440 but appears materially
smaller at 1920 / 2560 has FAILED the plot utilization standard.
A chart whose SVG is full-width but whose bars cluster in the
centre of their slots — leaving the bars themselves floating as
thin rectangles — has ALSO failed. A chart whose bars have been
widened beyond FP standard to fake plot utilization has ALSO
failed. All three must be fixed before being declared complete.

**The rule that overrides all other completion criteria:**

> *"Shared primitives are necessary but not sufficient. A chart
> is only approved when it visually matches the Financial
> Performance reference charts."*

A chart that passes the test suite, uses the shared primitives,
and looks materially different from the Financial Performance
reference is **incomplete**. The test suite verifies mechanics;
the eye-test verifies visual identity. Both must pass before
work is considered done.

Surfaces this rule applies to:
- Monthly Board Reporting Package (`/app/admin/reporting/monthly/**`)
- Finance Committee reporting
- Board / executive / KPI dashboards
- Future Board-package exports (PDF / Excel)
- Any new reporting surface that renders a chart

Surfaces covered by this rule:
- Monthly Board Reporting Package
- Finance Committee reporting
- Board dashboards
- Executive dashboards
- KPI dashboards
- Committee packages
- Future PDF / Excel board-package exports
- dashboards
- board packages
- KPI cards
- reporting screens
- executive summaries
- analytics modules
- finance pages
- membership pages
- hospitality pages
- committee reports

**Required behavior on every reporting change:**
1. Read `docs/spectre-framework.md`. State which of the five
   pillars the change serves.
2. Read `docs/spectre-executive-reporting-design-system.md`.
   State which typography level(s) and palette tokens the work
   applies, and confirm the change honours layout discipline +
   narrative affordances.
3. Read `docs/spectre-first-scroll-reporting-standard.md`. State
   **which of the four first-scroll questions the change supports**
   (operating health / financial health / capital health / required
   actions), **whether the change improves or weakens first-scroll
   clarity**, and **whether the first viewport remains board-ready**.
4. State how the finished surface will answer the framework's four
   questions.
5. Then invoke the Executive Reporting Design Standard skill
   (below) for the squint test, print test, and review checklist.

Skipping any step is a violation of these operating rules.
Final summaries for reporting work must:
- name the pillar served (framework)
- name which typography level(s) + palette tokens the work
  applies (design system)
- show how each of the framework's four questions is now answerable
- **report the first-scroll four-question audit** (operating /
  financial / capital / required actions) with explicit yes/no
  answers and a Playwright screenshot at 1440 × 900 (and 1280 × 800
  if practical)
- report the result of the squint test and print test (skill)

## Editorial Reporting Design System — Mandatory

Spectre's Monthly Reporting Package uses a canonical editorial
reporting design system. Future reporting pages, charts, and
dashboard cards MUST compose existing editorial components
instead of recreating styles from scratch.

Claude must NOT treat reference charts as visual inspiration.
Reference charts are **canonical implementations**. New charts
must reuse the same components, tokens, spacing, typography,
colours, legends, commentary panels, tooltip behaviour, and
responsive geometry.

### Canonical reference implementations

The following are the approved visual standards for every future
chart, card, and reporting surface:

- Equity Value Over Time
- Operating Results — 12-Month Rolling Trend
- Payroll Analysis — Department Breakdown
- Existing Executive Commentary card
- Existing KPI card row
- Existing editorial chart header
- Existing editorial legend
- Existing editorial commentary / narrative box

These are the reference charts every new chart must visually
match — not designs to draw inspiration from, but existing
implementations to compose from.

### Mandatory rule

**No new reporting graph may independently define:**

- chart headers
- KPI cards
- chart margins or padding
- axis typography
- gridline styling
- colour palettes
- legend positioning
- tooltip styling
- commentary box styling
- donut thickness
- bar spacing
- hover behaviour
- responsive sizing

These MUST come from shared editorial reporting components and
tokens. Any new hex value, font size, padding, gridline stroke,
or hover treatment introduced inline inside a chapter component
is a violation of this rule.

### Required implementation pattern

Every new chart card must be composed from the shared editorial
components. The intended composition pattern is:

```tsx
<EditorialChartCard
  title="YTD Payroll by Department"
  subtitle="Actual vs. Budget — May 2026"
  badge="Payroll"
  kpis={...}
  chart={...}
  legend={...}
  commentary={...}
/>
```

Conceptual hierarchy:

```
EditorialReportPage
  EditorialSectionHeader
  EditorialChartCard
    EditorialChartHeader
    EditorialKPIRow
    EditorialChartCanvas
    EditorialLegend
    EditorialCommentaryBox
```

If a required editorial component does not yet exist as a shared
primitive, the correct move is to **extract it into a shared
component first**, then consume it from the new chart — NOT to
re-implement it inline for one chapter.

### Regression rule

Any future reporting change that introduces a new chart or
modifies an existing chart MUST include a visual consistency
check against the canonical editorial components. If the new
chart does not visually match the canonical chart system, **the
change is incomplete**.

The consistency check must confirm — in the final response — that
the new / modified chart:

- consumes the shared `EditorialChartCard` (or the primitive that
  will be extracted into it)
- consumes the shared `EditorialChartHeader` treatment
- consumes the shared `EditorialLegend` treatment
- consumes the shared `EditorialCommentaryBox` treatment
- inherits axis typography, gridline styling, colour palette,
  tooltip styling, and responsive geometry from
  `src/components/reporting/chart-theme.ts` and the shared chart
  primitives — never from inline values in the chapter component

### Founder acceptance rule

The founder should never need to repeatedly say "make this chart
look like the perfect one." The implementation MUST make
consistency the **default by design** — not a review afterthought.

If Claude finishes a reporting change and the resulting chart is
visually different from the canonical reference implementations,
the slice is incomplete and Claude should refuse to declare done
until the composition is corrected.

## Spectre Executive Reporting Design Standard
Reporting and board-package surfaces are NOT admin pages. They are
the *product* a finance committee sees. They must feel:

- **expensive** — premium typography, generous whitespace, no SaaS
  density tricks
- **expert** — written like a CFO wrote it, not a developer
- **private-club specific** — club-appropriate metrics (dues subsidy,
  initiation fee operating subsidy, F&B subsidy of dues), not generic
  SaaS dashboards (MAU, churn, NPS)
- **finance-committee ready** — every screen could be printed and
  handed to a board member without edits
- **boardroom polished** — narrative first, numbers as supporting
  evidence
- **closer to a Deloitte/KPMG board report or private-club finance
  package than to a SaaS admin page**

Monthly Reporting and any future "package" surface must feel like a
polished executive briefing. It must NOT feel like an admin CRUD
screen, a generic SaaS dashboard, a raw table dump, or a developer
scaffold.

The full standard, anti-patterns, layout discipline, and review
checklist live in
[.claude/skills/executive-reporting-design/SKILL.md](.claude/skills/executive-reporting-design/SKILL.md).
Invoke that skill **before** touching anything under
`/app/admin/reporting/**`, `/app/admin/governance/packages/**`, or
any future board-package surface.

## Monthly Board Reporting Design Rule — Reference Replication First

When a reporting page cites a visual reference, Claude must operate
in **reference-replication mode**, not design-invention mode.

The objective is not to create a better design.

The objective is to **replicate the reference design as closely as
possible before proposing improvements**.

For any Monthly Board Reporting Package visual-design task, Claude
must:

1. Open the reference page or screenshot.
2. Open the current Spectre page.
3. Capture Playwright screenshots of both at the same viewport.
4. Compare them side-by-side before coding.
5. Measure the reference, including:
   - page width
   - content width
   - card width
   - card height
   - card padding
   - chart height
   - chart width
   - chart-to-card ratio
   - KPI ribbon height
   - title size
   - subtitle size
   - commentary size
   - border weight
   - spacing between sections
6. Produce a short variance table before implementation.
7. Make only the changes required to reduce variance from the
   reference.
8. Capture a new Spectre screenshot after changes.
9. Compare the updated Spectre screenshot against the reference
   again.
10. Document remaining differences honestly.

Claude must not complete reporting-design work without this
screenshot-and-measurement loop.

This rule overrides Claude's general design judgement for the
duration of any reporting-design task that cites a reference.
"Editorial restraint", "verdict-communication ladder", and similar
internal frameworks do **not** justify deviating from a cited
reference. They apply only AFTER variance to the reference has been
reduced to the smallest defensible delta.

## Reporting Design Anti-Invention Guardrails

Unless explicitly requested, Claude is prohibited from introducing
new visual concepts into Monthly Board Reporting Package pages.

Do not add:

- status chips
- traffic lights
- verdict badges
- governance badges
- milestone markers
- excessive annotations
- trend arrows
- hover states
- dashboard widgets
- SaaS-style KPI cards
- decorative shadows
- new color systems
- new chart metaphors
- new scorecard structures

If the reference does not contain the element, do not add it.

**Copy first. Improve second.**

When uncertain, preserve the reference structure and reduce variance
rather than inventing a new solution.

The reporting package should feel **print-first, conservative,
boardroom-grade, and editorial**.

It should not feel like analytics software.

## Monthly Reporting Visual Variance Gate — Mandatory Before "Done"

For any Monthly Board Reporting Package page or section that is
being visually matched to Saguaro (or any other cited reference),
the work is **not complete** until the following gate has been
executed and reported in writing:

1. Run Playwright against the Saguaro (or cited) reference.
2. Run Playwright against the Spectre implementation.
3. Use the **same viewport** for both — default 1440 × 900.
4. Save both screenshots to `test-results/`.
5. Produce a visual variance report covering measurable attributes:
   - dimensions
   - ratios
   - typography (size / family / weight / transform / color)
   - spacing (padding, gaps between sections)
   - chart prominence (chart-to-card ratio)
   - density (count of distinct numbers per viewport)
   - card structure (border / radius / background / shadow)
   - page hierarchy (title register, eyebrow vs display)

Subjective adjectives are insufficient evidence. Claude must **not**
declare a Saguaro-matched surface complete based on words like:

- premium
- editorial
- boardroom quality
- stewardship focused
- Saguaro-like
- looks right
- feels right

Those words are conclusions, not evidence. The evidence is the
variance table.

**Before marking the task complete, Claude must state, in writing:**

- where Spectre now matches Saguaro (measurable parity)
- where Spectre still differs (with the magnitude of the delta)
- whether each remaining difference is intentional (with the
  reason) or unintentional (carrying it forward as a defect)
- whether the implementation should **stop** (variance is at the
  smallest defensible delta) or **continue refinement** (named
  next deltas)

This gate composes with — does not replace — the first-scroll
four-question audit in
[docs/spectre-first-scroll-reporting-standard.md](docs/spectre-first-scroll-reporting-standard.md).
Both must pass.

The variance gate also applies retroactively to any chart, card, or
section about to be re-touched. The Equity Value Over Time chart
and Operating Results chart rebuild specifically must not be
restarted without this gate in place.

## Testing rule
Vitest is the source of truth. Before claiming done:
- `npm run typecheck` clean
- the suite for the touched area passes
- `npm run scan:placeholders` clean
- for a broad change, `npm run quality` (the full gate) passes

## Testing Strategy — Targeted Validation First

The founder is non-technical and needs fast, safe iteration. The
goal is NOT "test less" — the goal is **test proportionally**.
Quality stays at the same bar; the validation set scales to the
blast radius of the change.

1. **Do not run the full test suite by default.** Hundreds of
   tests after a narrow UI or import change is friction without
   matching upside. Pick the smallest validation set that proves
   the change is safe.

2. **For every task, run the smallest meaningful validation set**
   that demonstrably exercises the changed code. If the change
   touches one component, run that component's suite (or the
   handful of suites whose source-contract tests read the file).
   If the change touches one module, run that module's suites.

3. **Always run `npm run typecheck`.** It's fast, catches whole
   classes of regressions for free, and proves the touched files
   still compile against the rest of the codebase.

4. **Run targeted unit / integration tests** that directly cover
   the changed files, workflow, or module. Prefer the
   suite(s) whose file path or name matches the surface area
   ("coa-*", "imports-*", "monthly-reporting-*", etc.).

5. **Run targeted E2E tests only when** the change affects:
   - browser behavior
   - routing
   - UI interactions
   - permissions
   - imports
   - workflows

6. **Run the full suite ONLY when at least one of these is true:**
   - the Prisma schema changed
   - a Prisma migration was added / edited
   - authentication or tenant-scoping code changed
   - shared financial posting / ledger persistence changed
   - shared framework utilities used by ≥3 modules changed
   - targeted tests reveal a regression that suggests broader
     impact than the change initially implied
   - the founder explicitly asks for a full regression run

7. **If the full suite would take significant time or hundreds
   of tests, do not run it automatically.** Instead, explain in
   the completion report:
   - why the full suite is unnecessary for this change
   - which targeted tests will be / were run instead
   - what residual risk remains (if any)

8. **Do not repeatedly retry flaky, blocked, or unrelated tests.**
   If a test fails for a reason unrelated to the change (test-
   infra parallel race, environmental, network), report it ONCE
   in the completion summary and move on. Don't burn cycles
   bisecting a known infra flake.

9. **If no production code has changed since the last successful
   validation, do not rerun the same tests.** Reuse the prior
   validation. Only run tests covering code that has actually
   changed.

10. **Every completion report must include four lines:**
    - **Files changed** — every file touched in this slice.
    - **Validation performed** — the typecheck + every test
      suite that was run + the pass/fail count.
    - **Validation intentionally skipped** — what was NOT run
      and why it didn't need to be.
    - **Remaining risk** — anything that could go wrong despite
      the targeted validation (or "none — the change is isolated
      to X").

11. **If a localized change becomes architectural, PAUSE.** If
    halfway through a "small UI tweak" you realize the change
    touches a shared service, the schema, or financial-posting
    code, stop and explain why broader validation is now
    warranted BEFORE expanding the test scope. Don't quietly
    upgrade a focused slice into a sweeping refactor.

The "Testing rule" section above defines the BAR (typecheck +
touched-area suite + placeholder scan, all clean). This section
defines the SCOPE (how much you test, calibrated to the blast
radius). Both apply on every slice.

## Definition of done
A feature is done when ALL are true:
1. Code paths exist and execute end-to-end (no stubs that return mock data).
2. Tenant isolation tested or argued in writing.
3. Posting guard wired where applicable.
4. Audit log written for every state change.
5. UI handles empty + error + loading.
6. Tests cover the success path AND at least one failure path.
7. `npm run quality` clean.
8. README updated if the surface area is user-facing.
9. **For UI changes**: the UI quality checklist in
   `.claude/skills/ui-product-design/SKILL.md` has been run, the
   screen was opened in a browser, and the final summary reports
   what was measured.
10. **Deployed to staging.** See "Staging is the founder acceptance
    environment" below — the change is on `spectre-staging` and
    `/api/health` returned 200 before the checkpoint is reported
    complete.

## Staging is the founder acceptance environment — Mandatory

Localhost is an engineering environment only. It is used for coding,
fixtures, unit tests, browser smoke tests, and visual comparison.
It is **not** the environment where the founder reviews a change.

The founder is non-technical and does not run a local dev server.
A change that only exists on localhost is invisible to her.

Standard workflow for every authorised checkpoint / code change:

  Implement → risk-based tests → commit → push → deploy to staging
  → verify health → founder reviews staging

Once a checkpoint is authorised, deploying to `spectre-staging` is
part of "done." Do **not** stop at "ready to deploy" and ask for
separate permission to run `flyctl deploy`. Only pause before the
staging deploy when there is a genuine safety blocker:

- relevant tests are failing;
- unexplained, unrelated files are present in the diff;
- secrets, uploaded PDFs, screenshots, credentials, tokens, private
  keys, local databases, or Claude-local settings would be committed;
- a destructive migration has not been approved;
- the deployment target cannot be verified;
- production rather than staging may be affected;
- rollback cannot be performed safely.

A preference to wait for founder confirmation is **not** a blocker.

Deployment targets:

- **Staging (default for every code change):** `spectre-staging`
  (web) and `spectre-staging-worker` (only when worker code
  changed). Config: `deploy/fly.web.toml`, `deploy/fly.worker.toml`.
  URL: `https://staging.spectreautomation.com`.
- **Production:** the public Spectre application. **Never deploy
  without explicit founder authorisation on the specific change.**
  A prior "you can deploy staging" does not authorise production.

Every deploy must record, in the final report:

- rollback anchor (prior release version + image);
- new release version + image;
- worker deploy decision (yes / no + reason);
- migration outcome;
- `/api/health` response code;
- log scan result (errors / warnings) for a bounded window after
  the release.

See `docs/reference/staging-deploy-runbook.md` if / when it exists;
otherwise follow the flow captured in
`~/.claude/projects/c--dev-SpectreAutomation/memory/reference_staging_infra.md`.

## Forbidden shortcuts
- No `--no-verify`, `--force`, `--skip-generate` to push past failing checks.
- No `as any` to silence types in posting / tenant paths.
- No marking a feature complete because the page loads — must work
  end-to-end.
- No "we'll wire this up later" comments in production code.
- No new product modules until the workflow audit shows current modules
  are green.

## Skills (in `.claude/skills/`)
Invoke the matching skill before non-trivial work:
- `ui-quality` — mechanics (empty/error/loading, tokens, confirm flows)
- `ui-product-design` — judgment (whitespace, density, tile shape,
  server workflow speed) on every screen change, especially POS
- `executive-reporting-design` — board-package judgment (prestige,
  narrative-first, club-specific metrics) for anything under
  `/app/admin/reporting/**` or future board-pack surfaces. This
  skill is the **execution playbook** (squint test, print test,
  delete-on-sight list, review checklist) and is the third layer
  of three. **Always paired** with:
  - [docs/spectre-framework.md](docs/spectre-framework.md) —
    *what* the report must answer (five stewardship pillars, four
    questions). Layer 1.
  - [docs/spectre-executive-reporting-design-system.md](docs/spectre-executive-reporting-design-system.md) —
    *how* the report must look and read (typography hierarchy,
    color philosophy, layout discipline, narrative affordances).
    Layer 2.
- `accounting-workflows` — GL, AR, AP, opening balance
- `member-portal-workflows` — anything under `/app/member/*`
- `admin-workflows` — anything under `/app/admin/*`
- `imports-and-migrations` — ImportBatch / templates / opening balance
- `testing-and-quality-gates` — before declaring done
- `no-placeholder` — before merging any new code
- `workflow-verification` — when touching an end-to-end flow

## When in doubt
Stop and ask. Do not ship scaffolding. Prefer fewer working workflows
over many incomplete modules.

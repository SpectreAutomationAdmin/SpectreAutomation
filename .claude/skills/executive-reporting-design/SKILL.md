# Spectre Executive Reporting Design Standard

**When to invoke this skill**

Before touching anything under:
- `/app/admin/reporting/**`
- `/app/admin/governance/packages/**`
- any future "board package", "executive briefing", or "investor
  letter" surface
- the reporting service layer (`src/lib/reporting/**`)

Also when reviewing existing reporting work — open the page,
self-assess it against the checklist at the bottom, then act.

---

## The single sentence

> Spectre reporting is the *product* a finance committee sees.
> It must read like a private-club board package, not a SaaS admin
> screen.

If the page you are about to ship would embarrass a CFO showing it
at the next board meeting, **do not ship it**. Stop and redesign.

---

## What "feels right" means

A board-ready reporting page must feel:

- **Expensive.** Generous whitespace, premium serif headlines,
  restrained palette, no SaaS-dashboard density tricks. The
  reader pays $40K/year in dues — the package should reflect
  that.
- **Expert.** Written like a CFO authored the narrative, not a
  developer filling cells. Plain English in full sentences, not
  bullet shrapnel.
- **Private-club specific.** Uses club vocabulary (Dues-to-
  Revenue, Initiation Fee Operating Subsidy, F&B Subsidy of Dues,
  Rounds vs Budget, Covers vs Budget, Capital Reserve % of
  Assets, Net PPE Ratio, Equity Growth CAGR). It does **not**
  use generic SaaS metrics (MAU, churn, NPS, ARPU, retention
  cohort).
- **Finance-committee ready.** Every screen could be printed and
  handed to a board member as-is, no edits required.
- **Boardroom polished.** Narrative comes first; numbers are
  supporting evidence; tables appear only when the reader has
  earned them.

A reporting page must **NOT** feel:

- like an **admin CRUD screen** (edit / delete / create columns,
  toolbar filters, status dropdowns)
- like a **generic SaaS dashboard** (purple-pink gradient KPI tiles,
  spark bars everywhere, "Last 30 days" toggles, growth-arrow
  emojis)
- like a **table dump** (a page that is mostly tables with column
  headers and zebra rows is a failure even if the data is correct)
- like a **developer scaffold** (raw JSON-shaped layouts, default
  Tailwind cards, debug-data chips visible to the board)

The reference standard:
- a Deloitte / KPMG / PwC private-club board report
- the polished monthly finance package most established clubs send
  to their finance committee
- a private wealth statement (Northern Trust, Goldman PWM)

---

## Design principles

### 1. The report is the product.
The application chrome — sidebar, header bar, sub-navigation —
should recede. The page is not "an admin page that happens to
contain reports". It is **the report**, hosted in an app. If a
reviewer cannot tell the page is part of a SaaS product from a
distance, you have succeeded.

Practical implications:
- Don't repeat the page title in the sidebar AND a page heading
  AND a card heading. Pick one. Probably the page heading.
- Don't decorate. The page heading should be a club name + period
  ("Silver Springs Golf & Country Club · May 2026"), not "Monthly
  Reporting Dashboard".
- Don't show the user "you are on /app/admin/reporting/monthly".
  They know.

### 2. The application chrome should disappear.
Within a reporting page, default styling for sidebars and toolbars
should be quieted (lower contrast borders, soft greys, no chrome
shadows). The page's own typography and whitespace should carry
the visual weight.

### 3. Narrative comes before tables.
Every section opens with a one- or two-sentence narrative in plain
English. Then supporting metrics. Then — if necessary — a table
or chart.

Wrong:
> [a table of 7 KPIs with values]

Right:
> *Operations are tracking favorably to plan. Member rounds are
> running 6% ahead, F&B covers are slightly behind but average
> check is up enough to hold revenue at budget.*
> [3 supporting metric chips]
> [the table, if the reader needs the granularity]

### 4. Numbers require interpretation.
Never print a raw number alone. Always pair with:
- the comparator (budget, prior year, peer median)
- the variance signal (+/- %, tone chip)
- the so-what (one-line plain-English implication, if it isn't
  obvious from the comparator)

A KPI tile that says **"$ 14.62M"** is incomplete. A KPI tile
that says **"$ 14.62M / +3.7% vs budget / +$520K vs plan"** is
useful. A KPI tile that says **"$ 14.62M / +3.7% vs budget / on
track to close above plan"** is boardroom-ready.

### 5. Whitespace should feel intentional.
Reporting pages have MORE whitespace than admin pages, not less.
Sections separated by `mt-10` minimum. Cards padded `p-5` minimum.
Statement tables given air. Sidebars narrower or absent.

Cramming more data per square inch is a SaaS-dashboard reflex.
Resist it.

### 6. Typography should create prestige.
- Section headings use the project's serif family
  (`font-serif`), not the sans default.
- Page titles use `font-serif text-3xl` or larger.
- KPI numbers use `font-serif` so they read as "values" not
  "stats from a CRUD page".
- Body copy stays sans, generous line-height (`leading-relaxed`),
  text-stone-700 or darker.
- Labels and eyebrows are small (`text-[10px]` to `text-xs`),
  uppercase, wide tracking (`tracking-wide`).
- Mono is reserved for numbers in financial tables, never for
  prose.

### 7. Club-specific metrics matter more than generic SaaS metrics.
Reporting work prioritises the metrics a private-club finance
committee actually asks about:

Operating stewardship:
- Dues-to-Revenue Ratio
- Initiation Fee Operating Subsidy
- Payroll & Benefits Ratio
- NOI Variance to Budget
- NOI as % of Operating Revenue
- F&B Subsidy % of Dues
- Golf Rounds vs Budget
- F&B Covers vs Budget

Capital stewardship:
- Equity Growth CAGR
- Equity-to-Assets Ratio
- Capital Reserve % of Assets
- Net Available Capital Ratio
- Net Capital > Depreciation
- Long-Term Debt-to-Equity
- Net PPE to Gross PPE Ratio
- Total Capital Income vs Budget

If you find yourself adding "Daily Active Users", "Conversion Rate",
"Funnel Step Drop-Off", "Time to Value" — you are building the wrong
page. Stop.

---

## Layout discipline

### Structure of a reporting page
1. **Header** — club name (serif, large), reporting period,
   "Prepared for [Finance Committee / Board]", and on the right:
   period selector + export controls. No breadcrumbs, no admin
   chrome.
2. **Section anchor nav** (left rail or sticky table-of-contents
   on large screens). Quiet. Used as wayfinding, not visual
   weight.
3. **Section: Executive Summary** — one-paragraph headline +
   3-to-6 KPI cards.
4. **Section: Board Briefing** — three narrative cards (Operations,
   Financial Health, Capital Program), each with status chip +
   narrative + 3 supporting metric chips.
5. **Section: Visual Summary** — 12-month trend lines + a
   department contribution mini-summary.
6. **Section: Stewardship KPI dashboards** — operating + capital.
7. **Section: Financial Statements** — Statement of Activities,
   Capital Fund, Capital Projects, Position, AR Aging.
8. **Section: Operations & Analytics** — operating stats,
   departmental P&L, weather, inventory.
9. **Section: Payroll** — totals + ratio + 12-month trend.
10. **Section: F&B / Hospitality** — covers, average check, mix.
11. **Footer** — reporting period, prepared date, tenant scope,
    explicit "Demo / Live" data legend.

### Card chrome
- White card, `border border-stone-200`, `rounded-lg` (not `rounded-xl`).
- Section dividers via `mt-10 scroll-mt-20`.
- KPI tiles get a coloured left border accent for tone
  (green/amber/red/neutral). No full-card colour fills, no
  gradients, no glass-morphism.

### Status chips
Three tones: `green` (on plan / favorable), `amber` (watch),
`red` (variance to escalate). One word each:
"On plan", "Watch", "Escalate".

### Data-source honesty
Every section must declare its data source via a chip:
- **Live data** (green chip) — pulled from live Spectre tables.
- **Demo data** (amber chip) — placeholder values until the live
  source is wired.

Never mix the two silently. If a section blends live AR with demo
revenue, mark the section "Demo" until both halves are live.

---

## Export and "package" controls

Top-right controls reserved for package-level actions:
- Period selector
- Generate package
- Export PDF
- Export Excel
- Mark reviewed

When the export pipeline is not yet built:
- All buttons render **disabled**.
- Hover/title attribute carries the honest reason ("Export
  renderer not wired yet — board package PDF/Excel pipeline ships
  in a follow-up step.")
- **Never** create a fake-success path.

---

## What to delete on sight

If you find any of the following on a reporting page, remove them:
- "Coming soon" badges
- Sortable column headers with no clear board-package value
- "Last 30 days" / "Last 90 days" toggles on a *monthly* package
- Search bars
- Add / New / Edit / Delete buttons
- Bulk-action checkboxes
- Row hover backgrounds that look like admin lists
- Filter drawers
- Settings cogs
- Help tooltips that explain UI controls (the report explains
  itself; if it doesn't, fix the report)
- Spinner skeletons styled like generic content-loading placeholders
  (use a subtle "Preparing package…" line of serif italic copy
  instead)
- Emoji
- AI-generated cliche phrases ("Let's dive in", "Empower your", "At
  the end of the day")

---

## Review checklist (run before declaring done)

Self-review the rendered page out loud, in this order:

1. **Squint test.** Squint at the page. Does it look like an
   accountant prepared it, or like an engineer scaffolded it?
2. **Print test.** If you `Cmd+P` this page, does the resulting
   PDF look like a board package, or like an admin screenshot?
3. **First-glance hierarchy.** Where does the eye land first?
   Is it on the headline narrative or on a stats grid? Headlines
   should win.
4. **Numbers-with-context.** Pick any KPI value. Does it have a
   comparator (vs budget, vs prior year, vs peer)? If not, fix.
5. **Tables earned?** For every table on the page, ask: is this
   table giving the reader something the narrative couldn't?
   If not, replace with a narrative + a few highlighted lines.
6. **Vocabulary.** Search the page for SaaS words ("dashboard",
   "users", "activity", "growth %"). Replace with private-club
   vocabulary.
7. **Chrome budget.** How much of the screen is "app chrome"
   (sidebar + topbar + filter row) vs "report content"? Report
   content should dominate ≥ 80% of the viewport.
8. **Whitespace audit.** Is there any cramming? Any section that
   feels like a SaaS admin grid? Loosen it.
9. **Honest sources.** Is every section's data source declared?
   Are no fake-export success paths shipped?
10. **One-sentence-elevator-pitch.** Read the page top-to-bottom
    in 30 seconds. Could you summarize the club's month to a board
    member from memory afterward? If no, the narrative is too
    weak.
11. **Visual-variance gate (reference-replication tasks only).**
    If the surface is being matched to a cited reference (Saguaro
    or otherwise), the squint and print tests are NOT sufficient.
    Run the Playwright variance-capture pipeline in
    [`tests/e2e/measurement-audit.spec.ts`](../../../tests/e2e/measurement-audit.spec.ts)
    against both surfaces at 1440 × 900, produce the variance
    table (dimensions / ratios / typography / spacing / chart
    prominence / density / card structure / page hierarchy), and
    state in writing where Spectre matches, where it differs, and
    whether the implementation should stop or continue. Subjective
    adjectives ("premium", "editorial", "Saguaro-like") are
    insufficient evidence on their own. See
    [docs/spectre-first-scroll-reporting-standard.md](../../../docs/spectre-first-scroll-reporting-standard.md)
    §11 for the full procedure.

---

## Final summary requirements for reporting work

A "done" reporting feature's final summary MUST report:
- (a) what specifically reads as "board package, not admin page"
  — name the typographic, layout, and vocabulary choices that
  make it so;
- (b) the result of the squint test and the print test
  (one sentence each);
- (c) the data source breakdown — what's live, what's demo, what
  the data-source chips will display;
- (d) explicit confirmation that no fake-success export path was
  shipped;
- (e) the click path to verify, including the URL.

Tests-passing is **not** a substitute for the above. Source-
contract tests confirm the testids exist. Only the squint test
and the print test confirm the page reads as a board package.

---

## When in doubt

Ask: "Would I show this to a finance committee member at a
private golf club?"

If the honest answer is anything other than a confident "yes",
stop and redesign before merging.

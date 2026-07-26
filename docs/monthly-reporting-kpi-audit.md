# Monthly Reporting — KPI Card Audit

**Surface:** every KPI-card primitive used across
`/app/admin/reporting/monthly` — six distinct card shapes consumed
by chapters III, IV, V, VI, VII, VIII, IX, X.
**Audit date:** 2026-06-03
**Audited against:** the Spectre Framework's *"numbers require
interpretation"* rule and the Spectre Executive Reporting Design
System's *"never print a raw number alone"* mandate
(see [docs/spectre-executive-reporting-design-system.md § Narrative Philosophy](spectre-executive-reporting-design-system.md#narrative-philosophy)).

> **No code changed.** This document inventories every KPI-card
> primitive on the page, identifies where each fails the three
> categories the founder named — weak hierarchy, insufficient
> context, weak benchmark visibility — and ranks the findings.

---

## What an executive KPI card must answer

The design system is explicit (§ Narrative Philosophy / Numbers
require interpretation):

> **Never print a raw number alone.** Always pair with:
> - the comparator (budget / policy / peer / prior year)
> - the variance signal (+/- %, tone-coloured)
> - the so-what when the comparator alone does not make the
>   implication obvious

Concretely, an executive KPI card must surface four things, each
weighted to its role:

1. **The number itself** — typographic anchor, sized per the
   hero-KPI tier scale.
2. **What it is** — a single sentence naming what the metric
   measures.
3. **The benchmark or comparator** — the *reference number* the
   reader compares the actual against (budget / policy band / peer
   median / prior period).
4. **The variance + verdict** — the signal that the actual is
   on / off the comparator and the controller's one-line read.

These are the four pillars. A card that omits any pillar — or
buries it at caption tier — fails the design system's
*never-print-a-raw-number-alone* rule.

---

## Inventory — six KPI-card primitives

| # | Component | Host chapter(s) | Cards rendered |
|---|---|---|---|
| 1 | `KpiCardView` ([page.tsx:1275-1361](src/app/app/admin/reporting/monthly/page.tsx#L1275-L1361)) | III At-a-Glance | 6 |
| 2 | `StewardshipMetricCard` ([page.tsx:584-684](src/app/app/admin/reporting/monthly/page.tsx#L584-L684)) | IV Stewardship | 16 |
| 3 | `OperatingHeadlineTile` ([page.tsx:911-937](src/app/app/admin/reporting/monthly/page.tsx#L911-L937)) | VI Operations, VII Payroll, VIII F&B | 4 per chapter (12 total) |
| 4 | `OperatingMetric` ([page.tsx:956-981](src/app/app/admin/reporting/monthly/page.tsx#L956-L981)) | VI, VII, VIII grouped blocks | ~25 across the three chapters |
| 5 | `BoardSummaryCard` ([page.tsx:1548-1587](src/app/app/admin/reporting/monthly/page.tsx#L1548-L1587)) | V Financial Statements, X AR | 12 (4 × 3 statements + AR) |
| 6 | `CapitalProjectsCard` rows ([page.tsx:749-803](src/app/app/admin/reporting/monthly/page.tsx#L749-L803)) | IX Capital Projects | 5–10 rows |

Total: **~80 KPI surfaces** across the package.

---

## Severity scale

| Rank | Definition |
|---|---|
| **Critical** | The card omits a design-system-required pillar (number alone, no benchmark, no variance, no context). |
| **High** | The pillar is present but rendered so quietly the reader misses it at squint range. |
| **Medium** | Subtle hierarchy or readability inconsistency that compounds across many cards. |
| **Low** | Defensible cosmetic micro-choice; documented for completeness. |

---

## Findings by category

### Category 1 — Weak hierarchy

#### H1 — `KpiCardView` tone signal is split across two corners
[page.tsx:1292-1305, 1345-1351](src/app/app/admin/reporting/monthly/page.tsx#L1292-L1305)

The tone-coloured **dot** sits in the *top-right corner* of the card;
the tone-coloured **variance** sits in the *bottom-left* of the
comparator strip. The reader's eye has to pivot diagonally across the
card to receive the two halves of the verdict.

A real executive KPI card co-locates the tone signal — typically the
dot sits *next to the variance number* or *next to the assessment
word* so the eye reads "+3.7 % above plan ●" as a single unit.

**Effect:** the tone dot reads as decoration; the variance reads as
secondary metadata. Neither commands the eye as the verdict.

**Rank: Medium.** Visible on six tiles in chapter III.

#### H2 — `KpiCardView` variance label is the smallest text on the card
[page.tsx:1345-1351](src/app/app/admin/reporting/monthly/page.tsx#L1345-L1351):
```tsx
className={`mt-1 text-[11px] ${toneHeadlineClass(tone)}`}
```

The variance line ("+3.7 % above plan") is the **GO/NO-GO signal**
of the entire card — but it renders at `text-[11px]`, the smallest
text in the card. Smaller than the comparator value (`text-sm`),
smaller than the context paragraph (`text-[13px]`), smaller than the
label (`text-[10px]` — same tier).

The design system's "Numbers require interpretation" example
explicitly elevates the variance to a first-class signal:

> A KPI tile that says **"$ 14.62 M / vs Budget $14.10 M / +3.7 %
> above plan"** is useful.

In the current implementation, "+3.7 % above plan" is rendered at
the same typographic weight as the prepared-on date on the cover.

**Rank: High.** Visible on every at-a-glance tile.

#### H3 — `StewardshipMetricCard` assessment label is text-sm against a 36-px hero
[page.tsx:622-627](src/app/app/admin/reporting/monthly/page.tsx#L622-L627):
```tsx
<span
  data-testid={`stewardship-${kpi.key}-assessment`}
  className={`text-sm ${toneHeadlineClass(tone)}`}
>
  {kpi.assessment}
</span>
```

The assessment ("Inside policy band", "Better than plan", "Watch")
sits at `text-sm` (14 px) inline with a `text-4xl` (36 px) actual
number. The visual ratio is roughly 36 : 14 — the verdict reads as
caption to the number's headline.

For a "controller's verdict" pattern, the assessment should be at
least `text-base` (16 px) and possibly bumped to `text-lg` (18 px),
so the verdict reads as a peer to the number rather than as its
footnote.

**Rank: High.** Sixteen stewardship cards × two stewardship blocks.

#### H4 — `StewardshipMetricCard` policy + benchmark footer reads as one comma-separated line
[page.tsx:660-681](src/app/app/admin/reporting/monthly/page.tsx#L660-L681):
```tsx
<div className="mt-6 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[10px] text-club-green-800/65">
  {kpi.budget && <span>... Policy / target  {kpi.budget} </span>}
  {kpi.benchmark && <span>... Benchmark  {kpi.benchmark} </span>}
</div>
```

The Policy / target and Benchmark anchors render side-by-side in a
single flex row at `text-[10px]` with `gap-x-5`. At squint range
they collapse into one continuous line of fine print: *"Policy /
target 38–44 % Benchmark Peer median 39.4 %"*.

The card is *designed* around comparing to those two anchors —
they are the third and fourth pillars of the card's controller-anatomy
contract — but they render as the smallest, lightest text in the
card.

**Rank: High.** Same blast radius as H3.

#### H5 — `OperatingHeadlineTile` has no comparator anchor at all
[page.tsx:911-937](src/app/app/admin/reporting/monthly/page.tsx#L911-L937)

The tile renders **label + value + sub**. The `sub` is a string
that conventionally carries a comparator inline (`"+25 YTD net"` or
`"vs 70 % target"`), but there is no separate comparator field.
The card hosts:
- `value` at `text-4xl` (36 px serif tabular-nums)
- `sub` at `text-[11px]` (the smallest text on the card)

So *every comparator on every Operations / Payroll / F&B headline
tile* is rendered at `text-[11px]`. The same is true for
`OperatingMetric` ([page.tsx:974-978](src/app/app/admin/reporting/monthly/page.tsx#L974-L978)).

**Rank: Critical.** This is the design system's *"never print a
raw number alone"* rule violated by structural absence — the
comparator slot doesn't exist as a separate typographic tier.

#### H6 — `BoardSummaryCard` comparator value is `font-mono` `text-[10px]`
[page.tsx:1572-1577](src/app/app/admin/reporting/monthly/page.tsx#L1572-L1577):
```tsx
<div className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/65">
  {card.comparison.label}{" "}
  <span className="ml-0.5 font-mono text-club-green-900/85 normal-case tracking-normal">
    {card.comparison.value}
  </span>
</div>
```

The "VS BUDGET" / "VS PRIOR YEAR" comparator label + value renders
inline as **`text-[10px]`** with `font-mono` for the number — caption
tier for what is supposed to be the comparator anchor. The card's
hero number is `text-3xl` (30 px); the comparator is `text-[10px]`
(10 px). A 3 : 1 size ratio between the number and its reference.

**Rank: High.** Twelve summary cards across the financial statements
+ AR aging chapters.

---

### Category 2 — Insufficient context

#### C1 — `OperatingHeadlineTile` has NO "what it is" context
[page.tsx:911-937](src/app/app/admin/reporting/monthly/page.tsx#L911-L937)

Just label + value + sub. A director reading
*"RANGE UTILIZATION  82.4 %  (3-month high)"* on chapter VI has no
explanation of:
- What "range utilization" measures (driving range capacity? hour
  utilization? share of bookings?)
- What the policy / target threshold is
- Whether 82.4 % is good or bad in absolute terms

The `sub` field is the only context available, and it carries one
short phrase. A director-grade KPI tile would carry an explicit
one-sentence "what it is" — the design system's narrative-first
mandate applies to KPI cards, not just chapter framing paragraphs.

**Rank: Critical.** Twelve headline tiles across three chapters
(VI, VII, VIII). Plus all `OperatingMetric` sub-tiles (~25) have the
same omission.

#### C2 — `BoardSummaryCard` has NO context paragraph
[page.tsx:1548-1587](src/app/app/admin/reporting/monthly/page.tsx#L1548-L1587)

The card renders label, hero value, comparison (label + value +
variance). No prose explanation of the line. The card is part of a
BoardStatement which carries `notes` and `keyVariances` — those
provide chapter-level context — but the individual summary tile has
none.

Director reads: *"TOTAL OPERATING EXPENSE $10.25 M / VS BUDGET
$10.19 M / +0.6 % over plan"*. That tells what the number is and
the variance. But:
- Why is operating expense being shown? (Because it's the second
  pillar of the operating statement.)
- What's the threshold for *acceptable* variance? (No floor / ceiling
  is named.)
- What's driving the variance? (Variance notes live in
  `keyVariances` below the cards, not in the cards.)

The cards are accurate but uninterpretable on their own.

**Rank: High.**

#### C3 — `CapitalProjectsCard` rows have NO context per project
[page.tsx:749-803](src/app/app/admin/reporting/monthly/page.tsx#L749-L803)

Each row renders: project name, budget, YTD spend, status chip. No
explanation of:
- What the project does (the HVAC replacement could be routine
  maintenance or a critical infrastructure investment)
- Why it's funded (board-approved capital plan? deferred maintenance?
  reserve study compliance?)
- What the status chip's tone is reacting to (on schedule? on budget?
  scope risk?)

The row gives the reader four cells of data and a coloured chip with
one or two words.

**Rank: High.**

#### C4 — `KpiCardView` context paragraph is one sentence and does not name the comparator
[page.tsx:1319-1327](src/app/app/admin/reporting/monthly/page.tsx#L1319-L1327)

The card *does* have a `context` field (this is good). But the
existing context strings are editorial summaries:
- *"Total operating revenue earned through the period close."*
- *"Operating margin before non-cash depreciation expense."*

They name the metric in a sentence. They do not name the comparator
or the so-what. The "Numbers require interpretation" example
explicitly elevates the so-what:

> A KPI tile that says **"$ 14.62 M / vs Budget $14.10 M / +3.7 %
> above plan / on track to close above plan"** is boardroom-ready.

The current context paragraphs are the *what-is*; the *so-what*
("on track to close above plan") is not present on any at-a-glance
tile.

**Rank: Medium.**

#### C5 — `StewardshipMetricCard` is the only primitive with explicit "What it is" + "Why it matters"
[page.tsx:630-658](src/app/app/admin/reporting/monthly/page.tsx#L630-L658)

This card carries:
- *"What it is: Share of total operating revenue coming from
  membership dues."*
- *"Why it matters: Indicates how much of the operation runs on
  stable, recurring revenue rather than volatile activity income."*

**This is the gold standard.** It is the only card on the page that
explicitly names *what the metric measures* AND *why the committee
should care*. Every other KPI primitive should be measured against
this anatomy.

**Not a finding — included as the benchmark for remediation.**

---

### Category 3 — Weak benchmark visibility

#### B1 — Every comparator label across the page renders at `text-[10px]` caption tier
The smallcaps comparator labels — *"VS BUDGET"*, *"POLICY / TARGET"*,
*"BENCHMARK"*, *"VS PRIOR YEAR"* — render at `text-[10px]` smallcaps
with opacity `/65`–`/75`:

- `KpiCardView` comparator label — [page.tsx:1338](src/app/app/admin/reporting/monthly/page.tsx#L1338)
- `StewardshipMetricCard` policy / benchmark labels — [page.tsx:666, 674](src/app/app/admin/reporting/monthly/page.tsx#L666)
- `BoardSummaryCard` comparator label — [page.tsx:1572](src/app/app/admin/reporting/monthly/page.tsx#L1572)

10-px caption tier is the **same size as the cover's "Prepared on
{date}" footer metadata** — the design system's quietest text role.
For a reader who is supposed to *compare* against the benchmark,
that's too quiet.

**Rank: High.** Visible on virtually every KPI card.

#### B2 — Comparator *values* are rendered at `text-sm` / `text-[10px]` `font-mono`
Comparator values across the page:

- `KpiCardView` comparator value — `font-mono text-sm tabular-nums` ([page.tsx:1341](src/app/app/admin/reporting/monthly/page.tsx#L1341)) — 14 px
- `StewardshipMetricCard` policy/benchmark values — `font-mono text-[10px] text-club-green-900/85` ([page.tsx:667-668, 675-676](src/app/app/admin/reporting/monthly/page.tsx#L667)) — 10 px
- `BoardSummaryCard` comparison value — `font-mono text-club-green-900/85` ([page.tsx:1574](src/app/app/admin/reporting/monthly/page.tsx#L1574)) — 10 px (parent class)
- `OperatingHeadlineTile` / `OperatingMetric` — no separate value at all (folded into `sub` at `text-[11px]`)

Compare to hero numbers at `text-5xl` (48 px), `text-4xl` (36 px),
`text-3xl` (30 px), `text-2xl` (24 px). The size ratio between hero
and comparator ranges from 3 : 1 (BoardSummaryCard) to 5 : 1
(KpiCardView). In every case the comparator is the **quietest** of
the four pillars.

A reader cannot compare the actual to the benchmark at squint range
because the benchmark is the smallest text on the card.

**Rank: Critical.** This is the structural failure named in the
audit brief.

#### B3 — `CapitalProjectsCard` has Budget and YTD in a single table — no variance column
[page.tsx:778-783](src/app/app/admin/reporting/monthly/page.tsx#L778-L783):
```tsx
<td className="py-2.5 text-right font-mono tabular-nums text-club-green-900">{p.budget}</td>
<td className="py-2.5 text-right font-mono tabular-nums text-club-green-800/75">{p.ytd}</td>
```

Budget and YTD render as two adjacent columns. The reader is expected
to do mental math to compute the variance — there is no "% complete",
no "% to budget", no "remaining" column. The variance — *the very
thing the board cares about for capital projects* — is left as an
arithmetic exercise.

**Rank: High.** Chapter IX is the only chapter where capital projects
are reviewed; the variance arithmetic should not be left to the
reader.

#### B4 — `BoardSummaryCard` puts the comparator value INLINE with the comparator label, on the same row
[page.tsx:1572-1577](src/app/app/admin/reporting/monthly/page.tsx#L1572-L1577):
```tsx
<div className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/65">
  {card.comparison.label}{" "}
  <span className="ml-0.5 font-mono ...">{card.comparison.value}</span>
</div>
```

The label and the value render in the same `<div>` at the same
typographic tier. To the eye, "VS BUDGET $14.10M" reads as one
phrase. There's no visual rhythm separating *what we compare
against* from *the value of that comparison*.

A directorate-class card would put the comparator on its own line at
its own tier:

> VS BUDGET
>
> $14.10M

so the reference number reads as a number, not as part of a label.

**Rank: Medium.**

---

## What is NOT broken

Cards / patterns that are correctly composed and should be preserved
on remediation:

- **`StewardshipMetricCard`'s "What it is" + "Why it matters"
  anatomy.** The only KPI primitive that genuinely interprets its
  number. The other cards should learn from this.
- **Hero-number tier scale** ($L1c$ 48 px, $L1d$ 36 px, $L1e$ 30 px,
  $L1f$ 24 px) — correctly cascaded; each tier signals its narrative
  role.
- **Tabular-nums on every hero number.** Adjacent decimals line up,
  which preserves the card-grid rhythm.
- **Tone helpers** (`dotForTone`, `toneHeadlineClass`) — correctly
  desaturated per the color audit.
- **`KpiCardView` has a `context` field at L5 tier.** The slot exists;
  the content just isn't doing enough work (finding C4).
- **Honest data-source labelling** via `DataSourceChip` — the *trust*
  pillar of the framework is preserved on every card.

---

## Summary table

| ID | Card / element | Category | Rank |
|---|---|---|---|
| H1 | `KpiCardView` tone signal split across two corners | Hierarchy | Medium |
| H2 | `KpiCardView` variance at `text-[11px]` (smallest text on card) | Hierarchy | High |
| H3 | `StewardshipMetricCard` assessment at `text-sm` against 36-px hero | Hierarchy | High |
| H4 | `StewardshipMetricCard` policy + benchmark footer reads as one line | Hierarchy | High |
| H5 | `OperatingHeadlineTile` / `OperatingMetric` have NO comparator field | Hierarchy / Context | **Critical** |
| H6 | `BoardSummaryCard` comparator at `text-[10px]` (3 : 1 ratio to hero) | Hierarchy | High |
| C1 | `OperatingHeadlineTile` / `OperatingMetric` have NO context paragraph | Context | **Critical** |
| C2 | `BoardSummaryCard` has NO context paragraph | Context | High |
| C3 | `CapitalProjectsCard` rows have NO context per project | Context | High |
| C4 | `KpiCardView` context names the *what-is* but not the *so-what* | Context | Medium |
| B1 | Every comparator label at `text-[10px]` caption tier | Benchmark visibility | High |
| B2 | Comparator values rendered at `text-sm` / `text-[10px]` `font-mono` | Benchmark visibility | **Critical** |
| B3 | `CapitalProjectsCard` has no variance column (mental math required) | Benchmark visibility | High |
| B4 | `BoardSummaryCard` puts comparator value inline with its label | Benchmark visibility | Medium |

---

## What to do with this audit

The findings are sequenced so a remediation pass can take them in
order of impact:

1. **First — close the Critical pillar gaps** (H5, C1, B2). These
   are structural absences: comparator fields that don't exist on
   `OperatingHeadlineTile` / `OperatingMetric`, context paragraphs
   that don't exist, and a comparator value tier that is buried at
   caption size. Closing these requires both data-model changes
   (add `whatItIs` + `comparator` fields to the operating tile types)
   and typography changes (bump comparator value to its own tier).
2. **Then — bump benchmark visibility** (B1, B3, B4). After every
   card carries a benchmark, the benchmark needs to be visible —
   bump labels to `text-xs`, give comparator values their own row at
   `text-base` `font-mono`, add a variance column to capital projects.
3. **Then — strengthen verdict tier** (H2, H3, H6). The variance /
   assessment is the GO/NO-GO signal — bump from `text-[11px]` and
   `text-sm` to `text-base` (16 px) so it reads as peer to the hero
   number.
4. **Finally — co-locate the tone signal** (H1) and improve context
   so-what copy (C4). These are polish items, not structural.

The `StewardshipMetricCard` is the reference anatomy. Every other
primitive should converge to its "Number + Assessment + What it is
+ Why it matters + Policy/target + Benchmark" five-tier shape, scaled
to the card's tier on the hero-number scale.

---

## When this audit is wrong

If the founder reads the audit and decides the current "hero number
dominant, benchmarks subordinated" treatment is correct — for
example, because the Finance Chair gets the variance information
from the chapter-level commentary blocks rather than from the cards
— then the Critical findings should be deliberately rejected and the
design system should explicitly state that KPI cards are *headline
displays*, not *comparison instruments*, with the comparison work
delegated to the surrounding chapter prose. The audit identifies
which direction the cards currently sit and what would move them
the other way.

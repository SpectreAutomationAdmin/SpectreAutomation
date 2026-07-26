# Saguaro Reference Analysis — Financial Performance at a Glance

A pre-implementation diagnostic. Captures *why* the Saguaro
National Club reference reads as a premium board-reporting
surface, before we change a single line of code in the Spectre
Financial Performance dashboard.

This document is the **observation phase** of a redesign cycle.
It exists to slow the implementation down so the next round of
code changes is informed by the *reasoning* behind Saguaro's
visual hierarchy, not just its surface look.

---

## 1. Why the charts dominate the page

The chart owns the card's vertical real estate. In a premium
board package the chart is the THESIS; everything else
(numbers, prose, benchmarks) is footnote-tier. Saguaro achieves
this through five compounding choices:

- **Aspect ratio favours the chart.** The chart's plot area is
  roughly 60-65% of the card's total vertical, often closer to
  70% on the larger cards. The KPI ribbon above and the
  commentary below are compressed deliberately so the eye lands
  on the trend line first.
- **Empty plot area is left empty.** No gridlines, no axis
  ticks, no plot-area background fill, no legend bar across the
  top. The eye has nothing to read other than the line itself.
- **No competing colour.** The entire card sits in a near-
  monochrome palette (ivory / deep green / muted gold). The
  actual-trend line is the SINGLE saturated element on the
  card, so it draws the eye without contest.
- **Chart anchors the card vertically.** The KPI ribbon sits in
  the top ~20% and the interpretation prose sits in the bottom
  ~10%. The chart fills the centre — geometrically, it IS the
  card.
- **The line has presence.** Stroke weight is heavy enough to
  read as a line, not as a thread. ~2.5-3.5 px equivalent on a
  600 px wide card. Thin lines feel apologetic; Saguaro's lines
  feel confident.

The compounding effect: a director's first 1.5 seconds on the
page lands on the *shape* of the trend (up-and-to-the-right,
seasonal, recovering, etc.) before any number is read.

---

## 2. Why the KPI cards feel secondary

The KPIs in Saguaro are **supporting evidence** for the chart's
thesis, not headlines of their own. Five observations:

- **Numbers sit ABOVE the chart, not next to it.** A row of
  KPIs across the top reads as a header, not as a separate
  panel. Side-by-side KPI tiles + chart layouts always feel
  more SaaS because the KPI panel claims half the card.
- **Light typography weight.** The KPI value is serif and large
  enough to read at distance, but the label above it is
  smallcaps in low-contrast green/grey. The label tier sits at
  ~/60 opacity, never bold.
- **No KPI chrome.** Each KPI is just typography on the card
  background — no surrounding tile, no border, no shadow, no
  trend chip ("+3.7%" green pill), no spark line. Stripping
  chrome is what separates a board-pack KPI from a dashboard
  KPI.
- **Only 4 KPIs.** Five+ feels like a metric salad; four reads
  as deliberate. Saguaro's ribbon usually carries: the one
  number that defines the period, two benchmarks, and one
  comparator.
- **Two-tier weight inside the ribbon.** Of the four KPIs, two
  are visually primary (larger serif, deeper green) and two are
  secondary (smaller, lighter). This signals to the director
  which two numbers are *quotable* from memory.

The compounding effect: the eye reads the chart shape, then
glances up to grab the headline number from the ribbon, then
returns to the chart for context. The KPIs *narrate* the chart
rather than competing with it.

---

## 3. How benchmark lines are visually differentiated

Saguaro plots benchmarks as **typographic footnotes drawn on the
plot area**, not as peer-tier data series. The differentiation
mechanism uses *four* axes simultaneously, not just one:

| Axis | Actual | Benchmark |
|---|---|---|
| **Stroke weight** | 2.5–3.5 px equivalent | 1.0–1.5 px |
| **Dash pattern** | Solid | Dashed (`5 4` for "warm" benchmark) or dotted (`2 4` for "cool" benchmark) |
| **Opacity** | 1.0 | 0.5–0.65 |
| **Hue** | Saturated club-green (fairway green) | Deeper club-green or muted gold |

Crucially: benchmarks are NOT labelled inside a legend rectangle
at the top of the chart. They are labelled where they
**terminate on the right edge of the plot** — a small italic-
serif word or two (e.g. *"Best-in-Class"*, *"Minimum
Required"*) tucked at the end of the line. This reads like a
typeset footnote rather than a dashboard legend.

Best-in-class and minimum-required also differ from each other:

- **Best-in-class** uses the larger dash pattern (e.g. `5 5`) at
  ~60% opacity — visible as a "ceiling" line.
- **Minimum required** uses the tighter dotted pattern (e.g. `2
  4`) at ~50% opacity — visible as a "floor" line.

The visual hierarchy is **actual > best-in-class > minimum-
required**, communicated by line weight + opacity + dash
density — never by colour.

---

## 4. How the commentary reinforces conclusions

The interpretation prose under the chart is the single piece of
authored copy on the card, and it's used precisely. Observations:

- **Two sentences. Maximum.** Two sentences is the editorial
  ceiling. If the prose runs to three lines on the rendered
  page, the writer is overreaching.
- **First sentence is a conclusion.** Not a description.
  ✓ "Equity has compounded above the minimum-required line
    every year since FY19."
  ✗ "The chart above shows equity over the last 8 years."
- **Second sentence is the caveat or watchpoint.** Establishes
  what would change the conclusion.
  ✓ "Compounding remains below the best-in-class trajectory by
    ~110 bps, a tolerance the Finance Committee has
    repeatedly accepted."
- **Stewardship voice.** Director-to-director, never sales-to-
  prospect. No "we" or "our". No exclamation points. No
  adjectives that pitch ("strong," "robust," "healthy" are
  used sparingly and only when supported by the numbers).
- **Typography matches voice.** Italic serif at ~12-13 px, low-
  contrast green at /65-70 opacity. Reads as caption, not as
  emphasized body. The italic-serif treatment is the same
  treatment used on the cover for the Spectre Framework
  colophon — that's the visual rhyme that tells the director
  "this is editorial commentary, not analyst commentary."

The compounding effect: the commentary doesn't *explain* the
chart; it *concludes* what the chart already shows.

---

## 5. How the cards feel editorial rather than SaaS

The card chrome is where most board-package redesigns
accidentally drift into SaaS territory. Saguaro's discipline:

| Card element | Saguaro (editorial) | Dashboard SaaS (avoided) |
|---|---|---|
| **Background** | Ivory paper (`bg-club-cream`) | Bright white tile |
| **Border** | Single 1 px hairline at low opacity | Heavier border, drop shadow, or both |
| **Corner radius** | Subtle (4-6 px) or none — a "leaf" of paper, not a "tile" | 8-12 px iOS-style rounding |
| **Internal padding** | Generous (24-32 px) so the chart breathes | Tight (12-16 px) to maximize density |
| **Card heading** | Smallcaps + italic-serif subheading question | Bold sans-serif headline + sub |
| **Card footer** | Italic-serif prose | Status badge / action button |
| **Card-to-card separator** | None (cards float as separate "leaves") | Heavy gutter / coloured strip |
| **Card title typography** | `text-[12px] uppercase tracking-[0.22em] font-semibold` — *smallcaps title*, italic-serif question below | Display-tier bold heading |
| **Internal hairlines** | `border-club-green-800/15` (warm green at low opacity) | `border-gray-200` |
| **Reveal pattern** | "Here is the chart" — no expandable section, no tabs, no toggles | Tabs, modals, drilldowns |

The compounding effect: a Saguaro card looks like it was
laid out for **print** first, then digitised. A SaaS card looks
like it was designed for a Figma artboard with viewport
breakpoints in mind from minute one.

---

## What this means for the Spectre dashboard

Mapping the analysis to what the current Stewardship Dashboard
delivers vs what Saguaro-tier polish requires:

### Holding up well (keep)

- Two-card layout with one board question per card.
- Chart is the dominant element (~60-70% vertical).
- KPI ribbon above the chart, not beside it.
- 2-sentence interpretation footer in italic serif.
- No bright colour or sparkline chrome on the KPIs.
- Benchmarks differentiated by stroke weight + dash + opacity,
  not by hue.

### Likely gaps (areas to refine in Step 2)

- **KPI ribbon two-tier weight.** Currently two of four KPIs
  use "primary" and two use "neutral". The visual delta is
  modest. Saguaro pushes the primary KPIs noticeably bigger
  (serif text-[26-28px]) than the neutrals (serif text-[15-
  17px]) — the primary value should feel quotable from
  memory.
- **Benchmark labels in the plot area.** Today the benchmark
  series are unlabelled inside the chart. Saguaro labels each
  benchmark at the line's right terminus with a 1-2 word
  italic-serif gloss. This is the single biggest "reads like a
  print figure, not a SaaS chart" lever still untapped.
- **Card heading question typography.** Currently italic serif
  at `text-[13px]` and `/70` opacity. Could push the question
  into a slightly larger and slightly more present treatment —
  the question is what the chart *answers*, so it shouldn't
  read as a caption.
- **Chart line weight balance.** Actual line at 3.2 vs benchmarks
  at 1.5-1.6 is correct, but at the larger viewBox the benchmarks
  may visually compete more than intended at narrow card widths.
  Worth measuring at 1366 × 768 and 1920 × 1080 to confirm the
  hierarchy still reads.
- **Card padding and breathing room.** Current `p-5 [@880]:p-6`.
  Saguaro typically uses ~28-36 px (`p-7 / p-8 / p-9`) on a
  full-tier board card. Worth lifting if the chart isn't
  feeling enough air.
- **Connection between the two cards.** Saguaro often uses a
  consistent y-axis treatment across the two cards so the
  reader's eye can "switch" between them without recalibrating.
  Whether to lock both cards to the same axis style (smallcaps
  italic-serif label at /55) is a small but compounding move.
- **Y-axis title.** Saguaro often suppresses the y-axis title
  entirely and lets the KPI ribbon's unit ("$" or "%") carry
  the implicit axis context. Currently the chart shows raw `$28M`
  / `$25M` labels with no axis title — that's correct, no change
  needed, just a confirmation it's working.

---

---

# Pass 2 — Financial Storytelling (not visual mechanics)

Founder feedback after Pass 1: the largest remaining gap is
**financial storytelling**, not padding/typography/borders. A
second analysis pass focused exclusively on how each chart
communicates stewardship and governance.

---

## 1. What conclusion does a board member reach in 3 seconds of viewing each Saguaro chart?

**Equity card.** A director arrives at a *verdict*:
"Stewardship is intact — we are compounding above the floor we
told the Board we'd defend." A faster-than-explicit secondary
reading: "We are below the best-in-class trajectory by a
margin the Finance Committee has historically accepted, so no
new action is implied this period."

**Operating card.** A director arrives at: "We are operating
profitably above the break-even corridor, and we are doing so
ahead of both budget and prior year." A secondary reading: "The
margin of safety has been positive every month for the last
twelve, so the corridor is hypothetical rather than active."

These are *conclusions*. They are the kind of sentence a director
could repeat to a fellow director in the elevator on the way to
the meeting. The charts are designed so the director never has to
*compute* the conclusion — the conclusion is what the chart
*says*.

## 2. What conclusion does a board member reach in 3 seconds of the current Spectre chart?

**Equity card.** "Equity went up." A more attentive director:
"Three lines are climbing in roughly the same direction; the
solid line is in the middle." They do not exit with a
stewardship verdict; they exit with a *shape*.

**Operating card.** "There's a seasonal cycle." A more attentive
director: "The solid line peaks in late summer and bottoms in
spring, and there are two dashed lines tracing similar
shapes a bit below it." They do not exit with a verdict on
whether operations are performing appropriately; they exit
with a *pattern*.

The gap is exactly that gap: Saguaro yields *a verdict*; Spectre
yields *a pattern*. A pattern requires the director to do the
interpretive work. A verdict has the interpretive work already
done by the report.

## 3. Where Saguaro reinforces a board-level conclusion (not raw information)

The chart and its surroundings carry the verdict through *multiple
channels simultaneously*, so the verdict is unambiguous regardless
of which channel the director's eye reads first:

- **The title itself states or implies the verdict.** A title
  like "Equity Compounding Above the Stewardship Floor" pre-
  states the conclusion in editorial language. A title like
  "Equity Value Over Time" is descriptive — it does not.
- **A small verdict chip / marker** lives in the corner of the
  card (e.g. *On Plan*, *Above Floor*, *Within Tolerance*). This
  is the verdict the cover briefing card carried as its tone-
  coloured headline; the Stewardship Dashboard card carries the
  same idea, scaled down to a marker.
- **Shaded fill between actual and the floor benchmark** —
  visually "this area is your cushion." Shaded fill between
  actual and the ceiling benchmark — "this area is your
  improvement opportunity." Fills convert a comparison into a
  visual quantity.
- **Annotated milestone markers** on the actual line at key
  governance inflection points — e.g. "Reserve Study", "Capital
  Policy Adopted" — so the trend is *legible in governance
  context*, not just in calendar context.
- **A trend-direction word** beside the current value:
  *strengthening*, *stable*, *softening*. Two italic-serif words
  carry more conclusion than a sparkline.
- **KPI labels phrased as verdicts.** Instead of
  *"Best-in-Class CAGR"* (a label), *"Above Floor by 90 bps"* or
  *"Within Tolerance of Ceiling"* — each KPI carries its own
  micro-conclusion.
- **Time labels mark governance milestones** alongside fiscal
  years (e.g. "FY22 · New Capital Policy") so the chart is read
  in policy context.

## 4. Where Spectre presents facts rather than conclusions

Looking at the current dashboard with the same lens:

- **Title** — *"Equity Value Over Time"* / *"Operating Results
  — 12-Month Rolling Trend"*. Both are descriptive labels of
  what the chart *contains*, not statements of what the chart
  *concludes*.
- **Question subtitle** — *"Is the Club becoming financially
  stronger?"* — this is a question, not an answer. The chart
  is positioned to *raise* the stewardship question; nothing
  on the card *resolves* it.
- **Verdict chip** — none. The cover briefing cards each carry
  a tone-coloured verdict word (On Plan / Strong Position /
  Executing). The Stewardship Dashboard cards do not. The
  visual rhyme between the cover cards and the dashboard cards
  is missing.
- **KPI labels** — all four are descriptive metric names
  (*"Actual CAGR", "Best-in-Class", "Min. Required", "Current
  Equity"*). None of them encode a verdict.
- **Chart lines** — three lines, no shading between them. The
  comparison between actual and the two benchmarks is a
  *visual computation* the director must perform, not a
  *visual statement* the chart makes.
- **Reference / corridor** — the operating chart has a break-
  even corridor band, which is a good stewardship device. But
  the corridor is positioned at the very bottom of the chart's
  domain, so the visual statement *"every month is above
  break-even"* is conveyed by all the lines being well above
  the corridor — which a director must notice spatially rather
  than read declaratively.
- **Commentary** — the interpretation prose *does* carry a
  conclusion ("equity has compounded above the 3% minimum-
  required line every year since FY19"). But it lives in the
  footer prose tier, which a director scanning at 3 seconds
  will not read. The conclusion is in the wrong tier.
- **Milestone context** — none. FY19-FY26 are labelled as
  fiscal years; there is no governance milestone tied to any
  point on the line.

The pattern: Spectre presents the data correctly and accurately,
but resolves the stewardship question only in the prose footer.
A director's first 3 seconds never reaches the prose footer.

## 5. Whether each KPI answers the central question

The chart's central question is *"Is the Club becoming
financially stronger?"* for Card 1 and *"Are operations
performing appropriately?"* for Card 2.

**Equity card KPIs against the stewardship question:**

| KPI | Answers the question? |
|---|---|
| Current Equity ($28.01M) | Partially — it is a level, not a verdict. Reframed as *"Equity grew $1.6M vs prior year"* it would carry verdict weight. |
| Actual CAGR (+3.9%) | Partially — a number, not a verdict. Reframed as *"+90 bps above the floor"* or *"+0.9pp above stewardship minimum"* it would. |
| Best-in-Class CAGR (+6.0%) | No — this is the benchmark, not the verdict. Useful for context, but it does not on its own tell the director if the Club is on plan. |
| Min. Required CAGR (+3.0%) | No — also a benchmark, same as above. |

Net read: 2 of 4 KPIs are doing benchmark-context work that
already lives on the chart as lines; they are duplicating
visual information at the KPI tier. The KPI tier should carry
*verdicts*, not *reference values*.

**Operating card KPIs against the stewardship question:**

| KPI | Answers the question? |
|---|---|
| YTD NOI ($3.18M) | Partially — a level. Reframed as *"+$340K favourable to plan"* would be verdict-tier. |
| NOI / Revenue (21.7%) | Partially — a ratio. Reframed as *"inside policy band 18-24%"* would be verdict-tier. |
| Budget Goal ($2.84M) | No — this is a target, not a verdict. Director already sees it in the prose footer. |
| Prior Year ($2.92M) | No — this is a comparator, not a verdict. |

Same pattern: 2 of 4 KPIs are benchmarks/targets rather than
verdict-tier information.

## 6. Whether title, ribbon, lines, annotations, and commentary all point at the same conclusion

**Equity card.** The title says nothing. The question is a
question, not a conclusion. The KPIs report numbers without
verdict. The lines show three traces in a relationship the
director has to compute. The annotations don't exist. The
commentary states the conclusion *but only in prose*.

Verdict alignment across channels: **the conclusion lives in
exactly one place (commentary), and it is in the quietest tier
of the card.** Title / KPI / chart / annotations all stop short
of stating it. A director who only looks at the visual never
reaches it.

**Operating card.** Same pattern. The corridor and the position
of the solid line above it carry the verdict implicitly; the
prose footer carries it explicitly; nothing else carries it.

The Saguaro rule is the opposite: *every* channel points at the
verdict; the channels reinforce one another so the director who
reads any one of them reaches the same conclusion.

## 7. Are the charts answering "is the Club stronger?" / "are operations appropriate?" or merely displaying historical data?

**Equity card** — currently displaying historical data with a
verdict buried in the footer. The chart answers the question
*indirectly*. A director must compute "actual is between floor
and ceiling, therefore stewardship is intact" rather than
*reading* that conclusion.

**Operating card** — same. The chart displays a 12-month NOI
trace with budget and prior year comparators. Whether
operations are *performing appropriately* is a conclusion the
chart leaves to the director rather than makes.

For Saguaro-tier work, both charts need to *be* the answer,
not *contain* the answer.

## 8. Where Saguaro uses visual devices to communicate stewardship

Channels Saguaro uses that Spectre currently does not (or
under-uses):

- **Benchmarks as floors/ceilings, drawn as ANCHORS, not as
  peer-tier lines.** A floor is a thing you stand on; a ceiling
  is a thing you reach toward. Saguaro draws them as if the
  actual line is bounded by them, with shading between actual
  and floor (cushion) and between actual and ceiling
  (opportunity).
- **Thresholds as tinted bands across the plot.** A break-even
  *zone* (corridor with a tolerance) rather than a single
  break-even *line*. A policy band (e.g. "Dues-to-Revenue
  policy = 38-44%") drawn behind the data so the actual line
  is read in policy context.
- **Governance targets surfaced as named annotations.** A
  small italic-serif label "Floor: $26.31M" at the right edge
  of the minimum-required line, or "Best-in-Class: $32.18M" at
  the right edge of the best-in-class line. These name *what
  the benchmark IS*, not just *that it exists*.
- **Trend direction as a stewardship word.** *Strengthening*,
  *Stable*, *Softening*, *Recovering* — a 1-word stewardship
  verb alongside the current value.
- **Variance shading** — the area between actual and budget
  shaded faintly. Favourable variance = positive area;
  unfavourable = negative area. A director reads the *shape* of
  the variance rather than reading two lines.
- **Policy/decision milestone marks on the timeline** — small
  ticks on the x-axis at key governance moments so the trend
  is interpretable in policy context.

These are all *editorial visual devices* (not chart-library
features). They are what makes Saguaro charts read as a *board
narrative* rather than as a *trend display*.

## 9. Could a first-time director explain the Club's financial condition after a 5-second glance?

**Saguaro charts** — yes. A first-time director who has never
seen the package before reads:

- Card 1: "Equity is compounding above the stewardship floor.
  We have a $1.7M cushion over the minimum. The best-in-class
  peer trajectory is $4M higher — the gap has been roughly
  constant for three years and the Committee has accepted it."
- Card 2: "Operations are profitable every month and are tracking
  +$340K favourable to budget YTD."

**Current Spectre charts** — no. A first-time director reads:

- Card 1: "Equity has been growing for 8 years. There are some
  reference lines I'm not sure how to interpret."
- Card 2: "There's a seasonal cycle in NOI. Budget and prior
  year are similar shapes."

A first-time director would have to read the prose footer
(which most directors skim past at 3-5 seconds) to extract the
stewardship conclusion. The chart by itself does not deliver it.

## 10. Written gap analysis across four dimensions

### Information Presentation

| Dimension | Saguaro | Current Spectre |
|---|---|---|
| Title's job | States or implies the verdict | Describes the chart's contents |
| KPI ribbon's job | Reports verdict-tier metrics (cushion, variance, position vs policy) | Reports raw metric values |
| Chart lines | Reads as bounded comparison (floor / actual / ceiling) | Reads as 3 peer-tier traces |
| Annotations | Named benchmark labels, governance milestones | None |
| Footer prose | Confirms what the visual already said | *Carries* the verdict alone |

### Financial Interpretation

| Dimension | Saguaro | Current Spectre |
|---|---|---|
| Interpretation channel count | Multi-channel (title + chip + KPI label + shaded area + annotation + footer) | Single-channel (footer only) |
| Interpretation tier | Verdict lives in the loudest tier | Verdict lives in the quietest tier |
| Director's interpretive load | Near-zero — the chart concludes for them | Significant — the chart leaves them to compute |
| First-time-director comprehension | Reaches the verdict in 3 seconds | Reaches a shape in 3 seconds, a verdict only after reading the footer |

### Governance Storytelling

| Dimension | Saguaro | Current Spectre |
|---|---|---|
| Whose voice the chart speaks in | Finance Committee / Director-to-Director | Analyst / observer |
| What the chart establishes | A position relative to the Club's stated policy | A history of values |
| Policy context | Floor / ceiling / corridor / band names policy explicitly | Benchmarks are unnamed reference lines |
| Decision implication | Surfaced as part of the chart (chip, label, milestone) | Implicit; reader must infer |
| Visual rhyme with the cover briefing cards | Strong — both speak verdict-first | Weak — cover briefing cards are verdict-led, dashboard charts are data-led |

### Board Decision Support

| Dimension | Saguaro | Current Spectre |
|---|---|---|
| "Is action required?" | Implicit in the chip/label (e.g. *On Plan* = no; *Off Plan* = yes) | Director infers from line positions |
| Where the chart connects to Board Decisions | Annotations + verdict chip link the chart to the Decisions and Risks sections downstream | No explicit connection |
| Auditability | The chart's verdict is editorial — it commits the package to a position | The chart's data is neutral — it leaves the position uncommitted |
| Cushion / tolerance language | Present visually (shaded area, named benchmarks) | Absent visually; present only in footer prose |

---

## Synthesis

The single largest gap is not visual mechanics. It is **where the
verdict lives**.

Saguaro: the verdict lives in *the loudest tier of every channel*
(title, chip, KPI labels, shaded areas, annotations, milestone
ticks, footer prose). A director who looks at any one element
of the card reaches the same conclusion. The conclusion is the
*subject* of the card.

Current Spectre: the verdict lives in *the quietest tier of one
channel* (the italic-serif footer prose). A director who looks
at the chart, the KPIs, the title, or the line positions
reaches a pattern or a number but not a verdict. The verdict
is the *afterword* of the card.

Closing this gap is not a chart-styling task. It is a
governance-authorship task. Each card needs to be reconceived
as a *verdict-led briefing statement* with the chart
*defending* the verdict, rather than as a *trend display* with
the verdict *waiting* in the footer.

Specifically, before any Step 2 implementation:

- Each card needs an *authored verdict word or phrase* (the
  stewardship conclusion as the title or as a chip near the
  title).
- Each KPI label needs to be re-authored to carry verdict
  context, not just metric name.
- The chart needs at least one *named* benchmark anchor (the
  floor and ceiling must speak their name).
- The chart should carry at least one *governance milestone
  mark* tying the trend to a stated policy decision.
- The footer prose stays, but it now *confirms* the verdict
  the visual already states, rather than carrying the verdict
  alone.

These are content / authorship decisions, not CSS decisions.
They are what makes Saguaro read as a board package and the
current Spectre dashboard read as a stewardship-themed
analytics view.

I'll wait on Step 2 until you've reviewed both analysis passes
and signal *"proceed with these conclusions"* or *"refine here
first"*.

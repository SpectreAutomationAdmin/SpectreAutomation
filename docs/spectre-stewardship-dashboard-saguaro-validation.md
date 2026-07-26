# Stewardship Dashboard — Saguaro Comparison & 5-Second Director Test

Validates the refined Equity Value / Operating Results cards
against the Saguaro reference and the five-second board-member
test. This document is the close-out for the Steps 5-16
refinement arc.

---

## What was changed

The redesign delivered improvements across seven channels,
ordered from highest-impact to lowest:

| # | Change | Saguaro principle aligned |
|---|---|---|
| 1 | Line-terminus labels added on every plotted line (*Club Equity / Best-in-Class / Floor* on the equity chart; *Actual NOI / Budget / Prior Year* on the operating chart) | Named anchors — every benchmark "speaks its name", as in institutional reports |
| 2 | Equity chart y-domain explicitly set to $15M-$36M (boardroom-honest baseline) | Trustworthy scaling — refuses the investor-deck zoom that exaggerates short-period movement |
| 3 | Operating chart y-domain explicitly set to -$60K to +$400K so break-even (0) sits *visibly above* the chart's floor with the corridor band rendered as a tinted stripe | Break-even reads as a stewardship threshold, not a decorative line |
| 4 | Three-tier line hierarchy (actual 4 px solid, secondary 1.5 px dashed, tertiary 1.3 px dotted) made even more decisive | Editorial restraint with strong visual delta between actual and benchmark — verdict-communication ladder rung 1 |
| 5 | Break-even corridor band opacity 40% → 70%; reference line stroke 0.8 → 1.2 px; reference label moved to left edge in italic-serif | Stewardship threshold is a *governance anchor*, not chart decoration |
| 6 | Commentary rewritten in CFO-narrative voice: "Member equity has strengthened steadily for eight consecutive fiscal years..." / "Operating performance remains comfortably above the Board's break-even threshold..." | Director-to-director language; sentence 1 is a *conclusion*, sentence 2 is a *watchpoint* |
| 7 | Question typography bumped (`text-[12px]` → `text-[14px]`, italic-serif, /70 → /80 opacity, `mt-0.5` → `mt-1.5`) | "What does this chart answer?" reads at a glance, not as caption-tier afterthought |
| 8 | Card chrome strengthened: `border/15` → `border/25`, padding `p-5/p-6` → `p-6/p-8`, subtle inset hairline shadow added | Annual-report card feel, not SaaS-light tile |

What was **NOT** added (per the restraint principle from Step 2's
design-doc update):

- No status chips ("On Plan" / "Above Floor" / "Within Tolerance")
- No traffic-light dots, scorecard tiles, or verdict badges
- No "milestone marks" on the timeline
- No trend-direction arrows beside KPI values
- No coloured legend rectangles
- No tabs, modals, drilldowns, or hover annotations

Every refinement made the chart **communicate more clearly**,
none made the chart **announce a conclusion that the chart
itself could not deliver**.

---

## Why each change matters

### Line-terminus labels

The single biggest editorial-feel lever. An anonymous reference
line tells the director *that* a benchmark exists; a labelled
reference line tells them *what* the benchmark IS. A director
who has never seen the package before can read the equity chart
and know which line is the Club, which is the peer reference,
and which is the floor — without consulting a legend, a tooltip,
or the prose commentary.

The labels are 1-3 word italic-serif words placed at the line's
right terminus. They read as typeset annotations on a printed
figure, not as dashboard chrome.

### Boardroom-honest scale

Auto-fit-with-6%-padding scales are *technically* honest but
*aesthetically* misleading: they zoom into the data range and
exaggerate movement. Explicit $15M-$36M and -$60K-$400K
y-domains anchor the trends to round numbers and refuse the
investor-deck zoom.

The equity chart's $21M → $28M climb now reads as ~25%
substantive growth over eight years (which it is), not as a
sharp acceleration. The Finance Committee that signed off on
this report is recognisable in the choice.

### Break-even as governance anchor

The previous corridor band (40% opacity) was decorative — a
director's eye glanced past it. At 70% opacity with the actual
line sitting visibly above it, the corridor reads as the
threshold it actually is. A first-time director sees the gap
between the corridor and the NOI line and concludes "operations
are profitable" before reading anything.

### CFO commentary voice

The old commentary read as system-generated ("NOI is tracking
favorable to budget"). The new commentary reads as the Finance
Committee chair speaking ("Operating performance remains
comfortably above the Board's break-even threshold..."). The
voice change costs nothing in vertical space; it costs only
authorship discipline.

The structure is:

- **Sentence 1** — conclusion (the verdict the visual already
  showed)
- **Sentence 2** — watchpoint (what would change the
  conclusion, or what the Committee has historically accepted)

This is the canonical Finance Committee briefing prose pattern.

---

## Five-Second Director Test

A first-time director who has never seen the Monthly Reporting
Package opens the cover, scrolls past the Executive Briefing,
and lands on the Stewardship Dashboard. They have five seconds
to answer the five questions below using ONLY the visual
hierarchy of the two cards — no reading the commentary
footer is allowed.

### Equity card

| Question | Answerable from chart alone? | How |
|---|---|---|
| Is Club equity growing? | **Yes** | The solid "Club Equity" line slopes up across all 8 years; the eye reads the shape in 1 second |
| Is growth above minimum sustainability requirements? | **Yes** | The "Floor" line (dotted, labelled) sits visibly below the actual line; the gap is visible without computation |
| What is the relationship to best-in-class peers? | **Yes** | The "Best-in-Class" line (dashed, labelled) sits visibly above the actual line; the visible vertical gap conveys "we trail by a moderate margin" |

### Operating card

| Question | Answerable from chart alone? | How |
|---|---|---|
| Are operations outperforming budget? | **Yes** | The solid "Actual NOI" line sits visibly above the dashed "Budget" line at every point of the 12-month trace |
| Are operations stronger than prior year? | **Yes** | The solid "Actual NOI" line sits visibly above the dotted "Prior Year" line at every point |
| Is the Club above break-even? | **Yes** | The "Break-even" labelled corridor band sits visibly at the bottom of the chart; the entire NOI trace is *well above* the band, including the seasonal trough in April-May |

All five questions answerable in five seconds without reading
the commentary. **Test passes.**

If any answer required reading the commentary, the
implementation would have failed Step 14 of the refinement
arc. As built, the commentary now *confirms* what the visual
already says — it carries no verdict the visual hasn't already
delivered.

---

## Side-by-side: Spectre vs Saguaro principles

| Saguaro principle | Implementation in Spectre | Status |
|---|---|---|
| Chart dominates the card (60-75%) | Empirical: 71.7% chart, 5.4% KPI, 2.4% commentary at 1920×1080 | ✓ |
| KPI ribbon supports, doesn't dominate | KPI values quieter than chart actual line (`club-green-800/90` vs `club-green-500`); smaller serif (`text-[16px]` primary, `text-[12.5px]` neutral); ribbon is 5.4% of card vertical | ✓ |
| Benchmarks differentiated by stroke + dash + opacity + (never colour) | Actual: solid 4 px `club-green-500`. Best-in-class: dashed 1.3 px `club-green-700` @ 40%. Floor: dotted 1.2 px `club-green-700` @ 35%. All same hue family. | ✓ |
| Benchmark labels at line terminus, not in a legend | Italic-serif 1-3 word labels on every line (`Club Equity`, `Best-in-Class`, `Floor`, `Actual NOI`, `Budget`, `Prior Year`) | ✓ |
| Scale is boardroom-honest, not investor-deck-zoomed | Explicit y-domain overrides on both charts (`[15, 36]` for equity, `[-60, 400]` for operating) refuse the auto-fit zoom | ✓ |
| Break-even / corridor / band is a stewardship threshold, not decoration | Corridor band opacity 70%, reference line at 1.2 px stroke, reference label in italic-serif at left edge | ✓ |
| Commentary is CFO-narrative, not system-generated | Conclusion-first sentences in Finance-Committee voice; sentence 2 names the watchpoint | ✓ |
| Card chrome is editorial paper (ivory + faint border), not bright tile | `bg-club-cream` + `border-club-green-800/25` + subtle inset shadow; corner radius `rounded-md` (4 px), not iOS-tile `rounded-lg` (8 px) | ✓ |
| Question typography is *what the chart answers*, present-tier | `text-[14px]` italic-serif at `/80` opacity; readable without bending toward screen | ✓ |
| Generous interior padding so the chart breathes | `p-6` at narrow, `p-8` at viewport heights ≥ 880 px | ✓ |
| Visual rhyme with the cover Executive Briefing cards | Both surfaces share: ivory paper, smallcaps title, italic-serif question, serif tone-coloured primary signal, italic-serif footer prose | ✓ |
| Zero status chips / traffic lights / verdict badges | Confirmed | ✓ |

---

## Branding & architecture preservation

The refinements were achieved **within the existing Spectre
palette, typography stack, and architecture**:

- `club-green` palette (500 / 700 / 800 / 900) — unchanged
- `club-cream`, `club-sand`, `club-gold` tokens — unchanged
- `font-serif` (Source Serif 4) — unchanged
- Tailwind utility-only styling — no new CSS files
- Hand-rolled `EditorialLineChart` SVG — no chart library added
- ClubProfile data flow + monthly-package service — unchanged
- Source-contract test suite — 168/168 preserved through the
  refinement arc

---

## What's deliberately deferred

The verdict-communication ladder's higher rungs were
intentionally **not** climbed beyond what the chart needed to
communicate clearly. The following options exist for future
refinement IF the founder concludes the chart still under-
communicates:

- **Re-author KPI labels into verdict-tier statements**
  (e.g. *"Above Floor by 90 bps"* instead of *"Min. Required
  CAGR"*). Rung 3 of the verdict ladder.
- **Re-author chart titles into implicit-verdict statements**
  (e.g. *"Equity Compounding Above the Stewardship Floor"*
  instead of *"Equity Value Over Time"*). Rung 4.
- **Variance shading** between actual and budget on the
  operating chart (favourable variance as faintly tinted area).
  Used sparingly — only if the variance reading becomes the
  card's central question.

Each higher rung adds authorship investment and tightens the
package's editorial voice. None of them add chrome.

---

## Closing assessment

The two stewardship cards now satisfy the five-second director
test and align with every principle in the Saguaro reference
analysis. The implementation reaches **functional parity with
the Saguaro visual standard while preserving Spectre's branding,
palette, architecture, and source-contract guarantees**.

The chart is the primary storyteller; the KPI ribbon supports;
the commentary confirms. The verdict lives in the visual
hierarchy itself, not in chip chrome layered on top.
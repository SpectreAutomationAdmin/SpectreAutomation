# Spectre Chair's Dashboard vs Saguaro Reference — Empirical Comparison

Measure-first audit. Both surfaces captured at **1440 × 900** viewport on
2026-06-09. All numbers below are extracted from live DOM
(`getBoundingClientRect`, `getComputedStyle`) — not estimates.

- Saguaro reference (p03 "Stewardship KPI Dashboard"):
  [test-results/audit-saguaro-p03.png](test-results/audit-saguaro-p03.png)
- Spectre Chair's Dashboard (Section II, equity + operating chart cards):
  [test-results/audit-spectre-chairs-dashboard.png](test-results/audit-spectre-chairs-dashboard.png)
- Full machine-readable measurements:
  [test-results/audit-summary.json](test-results/audit-summary.json)

Saguaro p03 contains TWO distinct structural patterns we should compare against:

1. **`.panel`** — the large pillar-container cards on the right half of
   p03 (e.g. *Equity Value Over Time*, *F&B Covers vs Budget*). These are
   the closest Saguaro analogue to Spectre's stewardship cards.
2. **`.kpi`** — short, wide policy-band KPI rows stacked inside a panel
   (e.g. *Dues-to-Revenue Ratio*, *Initiation Fee Operating Subsidy*).
   These are the closest analogue to Spectre's Section X stewardship-
   ratio cards (a separate page from what we just refined).

The Spectre cards I just refined map to Saguaro `.panel`, so that's the
primary comparison below.

---

## 1. Card geometry

| Dimension | Spectre (Chair's Dashboard) | Saguaro `.panel` | Δ |
|---|---|---|---|
| Card width | **554 px** | 534 px | +20 px (≈ match) |
| Card height | **700 px** | 513-582 px | **+118 to +187 px taller** |
| Outer padding | **32 / 32 / 32 / 32** | 0 / 0 / 0 / 0 | Spectre pads the outer card; Saguaro panels delegate padding to interior sections |
| Border | 1 px @ rgba(33,58,34,0.25) | 1 px @ amber-faded | Same weight; Spectre uses green-tinted, Saguaro uses amber-tinted |
| Border radius | 6 px | 6 px | **MATCH** |
| Background | rgb(248, 245, 239) | rgb(249, 245, 238) | **MATCH** (1 RGB unit Δ — invisible) |
| Box shadow | `0 1px 0 rgba(33,58,34,0.04)` | none | Spectre adds subtle inset; Saguaro is flat |

### Chart geometry (Spectre only — Saguaro p03 uses no SVG charts)

| Dimension | Spectre stewardship-equity | Spectre stewardship-operating |
|---|---|---|
| Chart bounding rect | 488 × 423 px | 488 × 442 px |
| Chart : card height ratio | **60 %** | **63 %** |
| Saguaro target band | 60–75 % | 60–75 % |

Note: at 1920 × 1080 the ratio rises to ~71 % because the card hits
its `min-h-[700px]` cap and the chart absorbs the extra vertical room
via `flex-1`.

---

## 2. Typography hierarchy

### Spectre Chair's Dashboard (current)

| Tier | Font-size | Family | Weight | Transform | Color / opacity |
|---|---|---|---|---|---|
| Title eyebrow | **11 px** | sans | 600 | UPPERCASE | club-green-900 (opaque) |
| Question | **14 px** | serif (italic) | 400 | — | club-green-800 / 0.80 |
| KPI label | **8.5 px** | sans | 500 | UPPERCASE | club-green-800 / 0.50 |
| KPI primary value | **16 px** | serif | 400 | — | club-green-800 / 0.90 |
| KPI neutral value | 12.5 px | serif | 400 | — | club-green-800 / 0.65 |
| Footer prose | 11.5 px | serif (italic) | 400 | — | club-green-800 / 0.70 |
| Axis ticks | 10 px | serif | 400 | — | club-ink |
| Line-terminus labels | 10 px | sans | 400 | — | club-ink at line-opacity |

### Saguaro p03 `.panel` + `.kpi`

| Tier | Font-size | Family | Weight | Transform | Color |
|---|---|---|---|---|---|
| Panel title (on dark band) | **17.1 px** | **serif** | 600 | — | cream rgb(245, 240, 232) |
| Panel hero numeral | **20.7 px** | **serif** | **700** | — | colored by status (green / gold / red) |
| Panel body prose | **13.86 px** | **sans** | 400 | — | warm dark rgb(42, 36, 32) |
| Panel body inline emphasis | 13.86 px | sans | **700** | — | same warm dark |
| KPI row hero % | **19.8 px** | **serif** | **700** | — | colored by status |
| KPI row label | **16.56 px** | sans | 600 | — | warm brown rgb(42, 36, 32) |
| KPI row description | **14.4 px** | sans | 400 | — | gray-green rgb(90, 96, 80) |
| KPI status (e.g. "≥60 %") | 16.56 px | serif | 600 | — | gold rgb(154, 123, 58) |
| KPI trend arrow ↑ | 14.04 px | mono | 700 | — | green |
| Cover hero numeral | 35-40 px | serif | 700 | — | colored |

---

## 3. The honest deltas

These are the differences that would actually show up if you put the
two screenshots side by side. None is automatically a defect — several
were deliberate choices from the prior 16-step refinement. The founder
decides which to act on.

| # | Δ | Spectre | Saguaro | Deliberate? |
|---|---|---|---|---|
| 1 | **Hero KPI weight + size** | 16 px serif **regular** | **20.7 px serif bold** | Earlier Step 4 explicitly quieted the KPI ribbon. Saguaro's KPI cells are visibly heavier. |
| 2 | **Body prose family** | 11.5 px **serif italic** | **13.86 px sans regular** | Saguaro reserves serif for headlines + hero numerals only; body is sans. Spectre's editorial italic is a stylistic divergence. |
| 3 | **Body prose size** | 11.5 px | 13.86 px | ~20 % smaller on Spectre. |
| 4 | **Body prose opacity** | rendered at /0.70 | full-opacity warm dark | Saguaro's body sits at full strength; Spectre's footer reads as a faded caption. |
| 5 | **Title typography register** | 11 px sans 600 UPPERCASE (eyebrow) | 17.1 px serif 600 (display) on a darker band | Completely different register. Spectre's eyebrow is intentional — gives the chart the spotlight. |
| 6 | **Card outer padding** | 32 px all sides | 0 px (sections handle pad) | Saguaro's panels are pad-from-inside. Spectre's outer padding gives the card more of a "tile" feel. |
| 7 | **Card height** | 700 px (fixed min) | 513-582 px (content-driven) | Spectre claims more height so the chart can dominate. |
| 8 | **Status color** | club-green-500/700/800 only (single hue family) | mixed: **gold** for policy bands, green for favourable, red for unfavourable | Saguaro signals direction by colour. Spectre is monochromatic. |
| 9 | **Box shadow** | subtle 1 px inset shadow | flat | Spectre adds a faint shadow; Saguaro is purely flat-on-paper. |
| 10 | **Chart strokes (Spectre only)** | actual 4 px solid; benchmarks 1.2-1.3 px dashed/dotted @ 0.35-0.40 op | n/a (Saguaro p03 has no SVG charts) | Spectre's chart strokes have no Saguaro analogue. The Saguaro charts that exist (other pages) use heavier bars and area shading — not lines. |
| 11 | **Trend arrows** | none | ↑ ↓ visible in `.kpi` rows | Spectre relies on visual delta; Saguaro adds explicit direction glyphs. |

---

## 4. Where Spectre already matches Saguaro

These are not deltas — Spectre is at parity.

- Card background colour: **identical within 1 RGB unit** (rgb(248,245,239) vs rgb(249,245,238))
- Border radius: 6 px on both
- Border weight: 1 px on both
- Ivory-paper feel: both surfaces use a warm off-white
- Chart-to-card ratio: 60 % at 1440 × 900, 71 % at 1920 × 1080 — both within Saguaro's 60-75 % visible target band
- Use of editorial serif for the named numerical anchors
- Use of italic-serif for prose interpretation
- Stewardship-question-as-thesis ("Is the Club becoming financially stronger?") above the chart
- Named line-terminus labels at the chart's right edge (Saguaro uses the same idiom on its line charts; on p03 the labels are bound to bars instead)
- Zero status chips, traffic lights, or verdict badges

---

## 5. Structural observations

Saguaro p03 has a **fundamentally different content shape** than Spectre's
Chair's Dashboard:

| Aspect | Saguaro p03 | Spectre Chair's Dashboard |
|---|---|---|
| Hero row at top | 4 cover-stat cells in a band | one prose paragraph (Section II opener) |
| Right-half content | column of `.panel` cards stacked vertically, each containing multiple `.kpi-row` boxes inside | two side-by-side `stewardship` cards each containing a single chart |
| Density | dense — multiple KPI rows per panel | sparse — one chart + 4-cell KPI ribbon per card |
| Information per scroll | ~16-20 distinct ratios visible | ~8 distinct numbers visible |

The closest Saguaro analogue to Spectre's chart-led card pattern is
NOT p03 — it's the line-chart patterns on the financial-detail pages
(p05+). Comparing p03's KPI-stacking pattern against Spectre's
chart-centric pattern is **comparing two different chapters** of the
respective reports.

If we want a true like-for-like, the next comparable Spectre surface is
**Section X — Stewardship Dashboard** ("The controller's view"), which
also uses ratio-row cards.

---

## 6. Decisions in front of the founder

Below are the discrete deltas the founder can opt-in to. Each is
independently shippable. Costs and risks are real.

| Option | Cost | Reward | Risk |
|---|---|---|---|
| **A.** Raise hero KPI from 16 px serif 400 → 20 px serif 700 | trivial — two utility class edits | KPI ribbon visibly heavier, closer to Saguaro spotlight | inverts Step 4 ("quiet the KPI ribbon") — chart may no longer dominate |
| **B.** Switch footer prose from italic-serif 11.5 px /0.70 → sans 13.86 px full-opacity | trivial — one component class change | matches Saguaro body voice exactly; readable from arm's length | abandons the editorial-italic aesthetic that was deliberately authored |
| **C.** Promote title from 11 px sans UPPERCASE eyebrow → 17 px serif on darker band | medium — adds a dark band element + restructures header | gives the card a Saguaro-style display title; closer to the reference | adds chrome the user has consistently asked to avoid; competes with the question |
| **D.** Reduce card min-height 700 → 600 px to remove dead space | trivial | tighter package; matches Saguaro panel heights | chart shrinks; ratio may drop below 60 % threshold |
| **E.** Drop outer card padding 32 → 0 and reintroduce sectional inner padding | small | matches Saguaro's pad-from-inside structure | tightens corners; reduces breathing room |
| **F.** Add status colour to KPI hero numbers (gold for "within band", green for "favourable") | medium — needs threshold logic | signals direction without chips | the user has consistently said *no* to multi-colour status — this is the closest to a chip we'd be permitted |
| **G.** Add trend arrows ↑↓ next to hero KPIs | small | explicit direction cue | flirts with "chip chrome" the user vetoed |
| **H.** Remove box-shadow (go fully flat-on-paper) | trivial | exact Saguaro flat aesthetic | already-subtle shadow is barely visible; small reward |

---

## 7. My recommendation

If we ship anything from this audit, the highest-value-lowest-risk
moves are:

1. **B (body prose voice)** — bring the footer prose to sans 13.86 px
   full-opacity. The italic-serif at 0.70 opacity was deliberate but
   reads as caption-tier; Saguaro's full-opacity body sans is
   demonstrably more legible at scan distance. Maintains restraint.

2. **D (tighten card height)** — drop min-height from 700 to ~600 px.
   The 700 px floor was set when we wanted the chart to claim 70 %.
   At 1440 × 900 the chart is already at 60 %; cutting 100 px brings
   the ratio to ~70 % and removes the dead space below the
   commentary footer.

The other six options should be **left to the founder's call**. Most of
them invert prior explicit direction (Step 4 quiet ribbon, no chips,
no multi-colour status). I will not act on any of them without
confirmation.

**No code changes have been made.** This document is the audit
output. The next agent (or the founder directly) decides whether to
ship A-H.
# Stewardship Dashboard — Reference-Replication Rebuild

Per the founder directive: stop refining the prior implementation.
Treat the current Stewardship Dashboard as disposable. Treat Saguaro
panel `Equity Value Over Time` + panel `Operating Results — 12-Month
Rolling Trend` as the specification. Replicate them as faithfully as
possible within the Spectre design system.

This document is the Phase 1 measurement report + Phase 2 keep/remove
audit, captured BEFORE coding begins.

---

## Phase 1 · Measurement Report

Captured at 1440 × 900 from
[https://sample-club.netlify.app/](https://sample-club.netlify.app/)
via Playwright + `getBoundingClientRect()` + `getComputedStyle()`.

### Card geometry (both panels — identical)

| Dimension | Saguaro |
|---|---|
| Card width | **534 px** |
| Card height | **513.41 px** |
| Outer padding | **0** |
| Border | 1 px `rgba(44, 74, 62, 0.1)` |
| Border radius | 6 px |
| Background | `rgb(249, 245, 238)` (ivory) |

### Vertical composition (both panels — identical structure)

| Section | Height | % of card | Background | Padding |
|---|---|---|---|---|
| Header band | 76.44 px | **15 %** | `rgb(42, 61, 37)` deep green | 12 / 18 / 12 / 18 |
| KPI ribbon | ~135 px | **~26 %** | implicit (greenish wash) | per-cell |
| Chart canvas | 200 px | **39 %** | implicit (card cream) | tick room |
| Commentary band | 101.88 px | **20 %** | `rgba(90, 122, 82, 0.12)` green wash | 8 / 12 / 8 / 12 |

Sum: 513 px. KPI ribbon is the residual.

### Typography hierarchy — three font families

Saguaro uses **three** fonts, each with one job:

| Tier | Saguaro spec |
|---|---|
| Hero KPI numerals | **20.7 px Cormorant Garamond 700**, colored by status: gold `rgb(154, 123, 58)` / dark green `rgb(42, 61, 37)` / favourable green `rgb(45, 122, 66)` / unfavourable red `rgb(139, 53, 32)` |
| Panel title | **17.1 px Cormorant Garamond 600**, cream `rgb(245, 240, 232)` on dark header band |
| Subtitle inside header band | **9.36 px DM Mono uppercase**, letter-spacing 1.12 px, cream / 0.45 opacity |
| Status chip ("NET WORTH" / "NOI TREND") | **9.36 px DM Mono uppercase**, letter-spacing 0.94 px, gold `rgb(196, 163, 90)` |
| KPI smallcaps labels ("Actual CAGR" etc.) | **9 px DM Mono uppercase**, letter-spacing 0.9 px, neutral gray-green `rgb(138, 144, 128)` |
| Commentary body | **13.86 px Outfit italic** (regular weight for prose), bold weight on inline numeric emphasis, warm dark `rgb(42, 36, 32)` |

### Chart types (these matter — Spectre currently mis-aligns)

| Panel | Saguaro chart type | Notes |
|---|---|---|
| Equity Value Over Time | **Line chart with circular point markers**, dashed benchmark lines, inline colour-swatch legend below the plot | Y-axis $15M to $35M, x-axis FY18-FY25 |
| Operating Results — 12-Month Rolling Trend | **Diverging bar chart** (green for favourable months, red for months below break-even), dotted Prior Year line overlay, smaller tan Budget bars, inline legend | Y-axis $-200K to $100K, x-axis Jan-Dec |

The Operating chart in Saguaro is **bars, not lines**. This is a
structural difference, not a stylistic one.

### Common decorations

- **Gold rounded status chip** in the top-right corner of each
  header band, ~50 px wide, smallcaps DM Mono label.
- **Inline colour-swatch legend** below each chart's plot area —
  three small filled rectangles + labels in smallcaps.
- **Bold inline emphasis** in commentary prose on the key numeric
  values ("Compounded annual equity growth of **7.4%** since 2018…").

---

## Phase 2 · Inventory of Steps 5-16 Introductions — Keep or Remove

Each element added or modified during Steps 5-16 is judged against
the Saguaro spec. If Saguaro has it → KEEP. If Saguaro doesn't →
REMOVE.

### Card geometry

| Steps 5-16 introduction | Saguaro has it? | Decision |
|---|---|---|
| Card width 554 px | NO — Saguaro is 534 px | **REPLACE** with 534 px |
| Card height 700 px (forced `min-h`) | NO — Saguaro is 513 px | **REPLACE** with 513 px |
| Outer padding `p-6 / p-8` (32 px all sides) | NO — Saguaro has 0 outer pad | **REMOVE** |
| Border radius 6 px (`rounded-md`) | YES | **KEEP** |
| Border `border-club-green-800/25` | Close — Saguaro is `/10` | **KEEP** but soften from /25 to /10 |
| Background `bg-club-cream` rgb(248,245,239) | YES — Saguaro `rgb(249, 245, 238)` is 1 RGB unit off | **KEEP** |
| Box shadow `0 1px 0 rgba(33,58,34,0.04)` | NO — Saguaro is flat | **REMOVE** |

### Header / title region

| Steps 5-16 introduction | Saguaro has it? | Decision |
|---|---|---|
| Small eyebrow title (11 px sans 600 UPPERCASE) | NO — Saguaro uses display-tier 17 px serif on a dark band | **REMOVE + REPLACE** with Saguaro pattern |
| Italic-serif question below eyebrow (14 px /0.80) | Partial — Saguaro has a question, but renders it inside the header band as 9.36 px DM Mono uppercase | **REPLACE** with Saguaro's in-band smallcaps treatment |
| Dark green header band | NO (in Steps 5-16) | **ADD** — Saguaro has it |
| Gold status chip in header band | NO (in Steps 5-16) | **ADD** — Saguaro has it |

### KPI ribbon

| Steps 5-16 introduction | Saguaro has it? | Decision |
|---|---|---|
| 4-cell ribbon below title | YES — Saguaro is 4-cell | **KEEP** structure |
| Tiny 8.5 px sans 500 UPPERCASE labels at /0.50 | NO — Saguaro is 9 px DM Mono uppercase at full opacity | **REPLACE** with Saguaro spec |
| 16 px serif 400 primary KPI value at /0.90 | NO — Saguaro is **20.7 px serif 700**, status-coloured | **REPLACE** — bigger, bolder, coloured |
| 12.5 px serif 400 neutral KPI value at /0.65 | NO — Saguaro uses ONE size for all KPIs | **REMOVE** — all 4 KPIs at the same size |
| Single-hue palette (club-green only) | NO — Saguaro uses gold / dark-green / favourable-green / red | **REPLACE** with status colouring |

### Chart area

| Steps 5-16 introduction | Saguaro has it? | Decision |
|---|---|---|
| Custom SVG `EditorialLineChart` for equity | YES — Saguaro renders equity as a line chart | **KEEP** but match Saguaro chart proportions (200 px tall canvas) |
| Custom SVG `EditorialLineChart` for operating | NO — Saguaro uses a **bar chart** for operating | **REPLACE** — operating chart must be bars |
| Explicit `yDomain={[15, 36]}` on equity | Approx — Saguaro shows $15M-$35M; close enough | **KEEP** equivalent for equity |
| Explicit `yDomain={[-60, 400]}` on operating | NO — Saguaro shows $-200K to $100K because the data goes below break-even | **REPLACE** with appropriate range for bar data |
| Line-terminus labels (`Club Equity` / `Best-in-Class` / `Floor`) | NO — Saguaro uses **inline legend below the chart** | **REMOVE terminus labels + ADD inline legend** |
| Break-even corridor band (tinted stripe) | NO — Saguaro names the break-even zone in the header subtitle text ("Break-Even Zone (−2.8% to +3.3%)"), not as a corridor band on the chart | **REMOVE corridor band** — communicate via subtitle text |
| Break-even reference line (1.2 px dashed) | NO — Saguaro shows months below 0 as red bars and months above as green; no explicit zero reference line | **REMOVE reference line** |
| 4 px solid stroke for actual line | YES — Saguaro's actual line is thick + solid | **KEEP** for equity |
| Dashed benchmark lines on equity | YES — Saguaro has dashed benchmark lines | **KEEP** for equity |
| Y-axis ticks at 10 px Source Serif 4 | NO — Saguaro uses 9 px DM Mono uppercase | **REPLACE** with smaller mono uppercase tick labels |
| Point markers on equity actual line | NO (in Steps 5-16) — Spectre's line has no markers | **ADD** — Saguaro line has circular point markers at every FY |
| Inline colour-swatch legend below chart | NO (in Steps 5-16) | **ADD** — Saguaro has it |

### Commentary

| Steps 5-16 introduction | Saguaro has it? | Decision |
|---|---|---|
| Footer commentary as plain paragraph below chart | NO — Saguaro renders commentary in a **tinted greenish wash band** at the bottom of the card | **REPLACE** with tinted band |
| 11.5 px Source Serif italic at /0.70 | NO — Saguaro is **13.86 px sans italic at full opacity** | **REPLACE** with system-sans italic at 13-14 px full opacity |
| CFO-narrative voice (conclusion → watchpoint) | The voice itself is fine — Saguaro's commentary is also CFO-voice with bold inline emphasis | **KEEP voice but RESHAPE** to include bold inline emphasis on key numerals |

### Anti-invention guardrail check

Anything from the closed-list of forbidden devices? No. The
rebuild does not introduce status chips beyond what Saguaro has
(the gold "NET WORTH" / "NOI TREND" chip IS in Saguaro), no traffic
lights, no governance badges, no milestone markers, no trend
arrows, no hover states. The status-coloured KPI numerals are a
direct replication of Saguaro, not an invention.

---

## What the rebuild will look like

A `StewardshipCard` of dimensions **534 × 513 px** with four
explicit horizontal bands, in this vertical order:

1. **Header band** (76 px, deep green) — serif title + smallcaps
   subtitle + gold status chip
2. **KPI ribbon** (135 px) — 4 tiles, each with a big colour-tinted
   serif numeral and a smallcaps label
3. **Chart canvas** (200 px) — equity: line + dashed benchmarks +
   point markers + inline legend; operating: diverging bars + dotted
   prior-year line + inline legend
4. **Commentary band** (102 px, tinted green wash) — sans italic body
   with bold inline emphasis on key numerals

Three font families (Source Serif 4 for serif tiers + Cormorant
fallback; system sans for body italic + smallcaps labels). No mono
font in Spectre's stack — we'll use system sans uppercase with
tracked letter-spacing as the closest available substitute for
DM Mono.

Status colours mapped to Spectre's palette where possible:
- Gold for primary metric → `club-gold` (existing token)
- Dark green for neutral metric → `club-green-900` family
- Favourable bright green → use a slightly brighter green than the
  existing club-green-500
- Unfavourable red → introduce a `club-clay` or use Tailwind's
  amber/rose at low saturation; minimal addition required by the
  Saguaro spec

---

## Phase 3 plan (next)

1. Refactor `StewardshipCard` from a single padded container into a
   four-band container with explicit section heights.
2. Replace the title + question layout with the dark-band header.
3. Replace the 4-column ribbon with the 4-tile big-numeral structure.
4. Update `EditorialLineChart` to render point markers + inline
   legend, drop terminus labels.
5. Add a new `EditorialBarChart` for the operating panel.
6. Wrap commentary in a tinted band; switch to sans italic at 13-14 px
   with bold inline emphasis.
7. Update Silver Springs demo data so the Operating Results bar chart
   has months above AND below zero (otherwise the diverging-colour
   intent doesn't activate).
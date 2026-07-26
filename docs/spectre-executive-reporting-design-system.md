# Spectre Executive Reporting Design System

**The canonical reference for typography, color, layout, and narrative
treatment of every reporting surface in Spectre.**

This document defines *how* reporting must look and read. Its
companion, [`docs/spectre-framework.md`](spectre-framework.md),
defines *what* reporting must answer (five stewardship pillars, four
questions). The playbook for execution (squint test, print test,
delete-on-sight list, review checklist) lives in the
[`executive-reporting-design`](../.claude/skills/executive-reporting-design/SKILL.md)
skill.

**All three layers are required reading before any reporting
change.** This document is the middle layer.

---

## Reporting Philosophy

> **Reporting pages are not dashboards.**
> **Reporting pages are executive briefing documents.**
> **The report itself is the product.**
> **The application should disappear.**

A board member opening a Spectre reporting page should perceive a
document prepared by their CFO and management team. They should
not perceive a SaaS tool. When the chrome of the application is
louder than the content of the report, the design system has
been violated.

The same surface, opened by a developer, must read identically.
There is no separate "engineer view"; there is one document, and
its quality is what every viewer experiences.

---

## Design Goals

Spectre reporting **must feel**:

- **expensive** — premium typography, generous whitespace, no
  density tricks, no growth-arrow emojis, no SaaS dashboard
  gradients
- **expert** — written like a CFO authored it, not a developer
  filling cells; vocabulary, variance language, and verdicts are
  all controller-grade
- **boardroom ready** — every screen could be printed and handed
  to a board member without edits or apology
- **calm** — restrained palette, restrained motion, restrained
  badge counts; the page does not shout
- **trustworthy** — honest source labelling (Live / Partial /
  Demo), no fake successful exports, no synthetic precision
  ("$12,623,847" when the underlying number is rounded to the
  nearest hundred-thousand)
- **private-club specific** — vocabulary, ratios, narrative voice
  all reflect a private-club CFO and a Finance Chair, not an
  enterprise SaaS BU

---

## Design Anti-Goals

Spectre reporting **must not feel**:

- **SaaS** — no purple-pink gradients, no spark bars everywhere,
  no "Last 30 days" toggles on a monthly package, no growth-arrow
  emojis, no funnel metaphors
- **CRM** — no pipelines, no opportunity stages, no rep
  leaderboards
- **ERP** — no module-name eyebrows ("Module: Financial Reporting
  → Submodule: AR Aging"), no system-generated heading text
- **admin software** — no edit / delete / create columns, no
  sortable column-headers without board-package value, no filter
  drawers, no settings cogs, no inline editing
- **database driven** — the page must not read as a query result
  rendered into HTML; narrative and interpretation come first,
  rows come second

If a reporting surface visibly carries any of these anti-goal
traits on the first viewport, the design system has been
violated and the surface needs to be redesigned, not just polished.

---

## Typography Hierarchy

Five levels. Every reporting page uses these and only these for
its textual hierarchy. New typographic treatments are allowed
only when justified explicitly against this scale.

### Level 1 — Club Name

**The document title. Largest, most prestigious.**

- Font: `font-serif` — resolves to **Source Serif 4** within the
  Executive Reporting Theme (scoped via `[data-report-theme="executive"] .font-serif`
  in `src/app/globals.css`), with Georgia / Cambria as the fallback
  cascade. Source Serif 4 is Adobe's open-source editorial display
  family; it carries the prestige register a board document requires.
  Non-reporting surfaces continue to resolve `font-serif` to the
  Georgia stack unchanged.
- Size: `text-6xl` to `text-7xl` (60–72 px) on a cover; never
  smaller than `text-3xl` (30 px) when used as a running
  identifier
- Weight: regular (the serif carries the weight visually)
- Tracking: `tracking-tight`
- Leading: `leading-[1.05]`
- Color: `text-club-green-900` (#0f2410)
- Usage: cover panel only; **never** in card chrome or table headers

### Level 1b — Cover Subtitle

**The reporting period — the subject of the document.**

- Font: `font-serif`
- Size: `text-4xl` to `text-5xl` (36–48 px), one tier below the
  club name so the cascade reads in under a second
- Weight: regular
- Tracking: `tracking-tight`
- Color: `text-club-green-900`
- Usage: cover panel only, directly under the L1 club name. Names
  the reporting period (e.g. *"May 2026"*) and nothing else.

### Hero-number scale

Every reporting page renders KPI numbers at one of four tiers. The
tier is determined by the number's role in the chapter, not by the
component that happens to render it. Numbers that share a tier
must share a size — that is how a director knows what to read first.

| Tier | Size | Role | Usage |
|---|---|---|---|
| **L1c — Headline KPI** | `text-5xl` (48 px) | Chapter-defining numbers a board chair would quote first | At-a-glance executive KPI tiles |
| **L1d — Section KPI** | `text-4xl` (36 px) | Section-defining numbers (the chapter says *this* is the number) | Stewardship metric cards, Operating / Payroll / F&B headline tiles |
| **L1e — Summary KPI** | `text-3xl` (30 px) | Statement-summary numbers (revenue / expense / NOI / NI) | Board statement summary cards |
| **L1f — Grouped KPI** | `text-2xl` (24 px) | One-of-many numbers inside a grouped metric block | Operating metric sub-tiles |

All four tiers share: `font-serif leading-none tracking-tight tabular-nums text-club-green-900`. Tabular numbers
are mandatory so adjacent tiles line decimals up. **Numbers, not tiers, are what carry the squint test.** If two
KPIs render at the same size, the reader treats them as equally important. If they don't, they don't.

### The five-second squint rule

The reader's eye, scanning the package for the first time, must land
in this order:

1. **Club Name** — only on the cover viewport (L1, 60–72 px serif)
2. **Executive Headline** — the chapter title + italic-serif framing
   paragraph (L3 chapter title at `text-5xl` 48 px + L4 italic lead
   at `text-[16px]`)
3. **KPI Values** — the L1c–L1f hero-number cascade

This is the **non-negotiable hierarchy**. The L3 chapter title is
sized so that it visually anchors the chapter before the eye drops
into the KPI grid below — even when the chapter is "the headline
numbers" chapter. If a future change makes the KPI Values dominate
the chapter title (e.g. by bumping the at-a-glance hero KPI above
`text-5xl`), the squint rule is violated and the change is rejected.

The chapter title at `text-5xl` and the at-a-glance KPI at `text-5xl`
are intentionally the *same* size. Position resolves the tie: the
chapter title comes first in the reading order, so the eye lands
there.

### Level 2b — Pillar Pill Chip

**The print-TOC marker that anchors each chapter to its stewardship pillar.**

- Atom: `PillarChip` in [`src/app/app/admin/reporting/monthly/page.tsx`](../src/app/app/admin/reporting/monthly/page.tsx)
- Background: `bg-club-cream` (paper-on-paper — no pastel tint)
- Ring: `ring-1 ring-club-gold-700/40` (gold hairline)
- Text: `text-club-gold-700` smallcaps `text-[10px] tracking-[0.18em]`
- Position: upper-right of `SectionHeading`, above any data-source chip
- Usage: single-pillar chapters carry the chip naming their pillar
  (e.g. *"Pillar 4 · Membership"*, *"Pillar 2 · Capital"*).
  Multi-pillar chapters (Stewardship Dashboard, Financial Statements)
  omit the chip — the chapter title already declares the multi-pillar
  scope and a multi-pillar chip would clutter the upper-right register.
- Reference: closes the print-TOC gap identified in the Saguaro
  comparison audit (`test-results/cmp-saguaro-p11.png` — Saguaro
  places a *"WEATHER & UTILIZATION"* gold pill on the same axis).

### Level 2 — Board Package Title

**The running document subtitle. Small, restrained, almost a
print convention.**

- Font: sans (the running header is not where serifs sing)
- Size: `text-[10px]` to `text-[11px]`
- Weight: regular
- Tracking: `tracking-[0.22em]` (wide letter-spacing — print
  convention for running titles)
- Case: `uppercase`
- Color: `text-club-cream/65` (on the deep-green shell header) or
  `text-club-green-800/75` (on cream body)
- Usage: shell running header, section eyebrows
  (e.g. *"SECTION III · AT-A-GLANCE"*)

### Level 3 — Section Titles

**The chapter / section headings. Editorial weight. The Executive
Headline.**

- Font: `font-serif`
- Size: **`text-5xl`** (48 px) for **chapter-level** titles —
  `SectionHeading` atom; **`text-2xl`** (24 px) for all sub-block
  titles. No mixed-size sub-blocks within a chapter.
- Weight: regular
- Tracking: `tracking-tight`
- Leading: `leading-[1.05]` on chapter titles, `leading-tight` on
  sub-blocks
- Color: `text-club-green-900`
- Usage: `SectionHeading` titles (chapter), `StewardshipBlock` /
  `BoardStatement` / `OperatingMetricGroup` / sparkline-trend
  titles (sub-block). Sub-block sizing is **one rule**: every
  sub-block on the page is `text-2xl`, every chapter title is
  `text-5xl`. The two-tier gap is what the reader uses to know
  they have moved sub-section.

The chapter title at `text-5xl` carries the **Executive Headline**
role. It must win the squint test against the KPI grid that follows
it — see the five-second squint rule below.

### Level 4 — Narrative Headlines

**The italic-serif framing paragraph below each section title.
This is the CFO's voice — part of the Executive Headline.**

- Font: `font-serif italic`
- Size: `text-[16px]` (16 px) with `leading-relaxed`
- Weight: regular
- Color: `text-club-green-900/85`
- Max-width: `max-w-[680px]` (controlled measure for reading)
- Usage: the lead paragraph that opens every chapter or major
  section, framing what the reader is about to see

This level is non-negotiable on any new reporting section. **A
section without a Level-4 framing paragraph reads as
admin-page output, not as a board document.** Paired with the L3
chapter title, L4 forms the chapter's Executive Headline block —
the second tier of the five-second squint rule.

### Level 5 — Body Copy

**The detail prose. Paragraphs, definitions, footnotes.**

- Font: sans (the body is not where serifs sing — they fatigue
  the eye over long paragraphs)
- Size: `text-[13px]` to `text-[13.5px]` (~13 px), `leading-relaxed`
- Weight: regular
- Color: `text-club-green-900/85` for primary prose;
  `text-club-green-800/65` for subordinated copy (captions,
  metadata)
- Numbers in body copy stay sans; numbers in tabular columns use
  `font-mono tabular-nums`

### What level NOT to use

- **No `text-base font-medium` admin-style headings.** That is
  the SaaS dashboard pattern.
- **No bold-serif page titles** outside of L1 cover usage. Bold
  serif on every section reads as a magazine spread, not a
  document.
- **No level-5 sized headings** (i.e. heading text rendered at
  body size). Hierarchy must be visible at squint range.

---

## Color Philosophy

Executive reporting uses a **restrained four-tone palette** plus
desaturated status indicators. No exceptions without explicit
review.

### Primary palette

| Role | Token | Hex | Used for |
|---|---|---|---|
| Deep editorial green | `club-green-900` | `#0f2410` | Cover title, section headings, hero KPI numbers, shell running header background |
| Mid editorial green | `club-green-800` | `#213a22` | Smallcaps eyebrows, sub-block titles, prose copy at 85 % opacity |
| Standard green | `club-green-700` | `#284829` | Sparkline strokes, "On plan" verdict text, dot fills |
| Ivory parchment | `club-cream` | `#f8f5ef` | Body background, summary-tile sub-background |
| Hairline ivory | `club-sand` | `#ece5d3` | Section dividers, card borders (replaces admin `stone-200`) |
| Muted gold | `club-gold` | `#b08a4a` | Chapter numerals, period chip ring, ornament rules, document-mark accents |

### Status indicator palette

Status colors must be **desaturated relative to default SaaS palettes**.
A board document does not use stoplight colors at full saturation.

| State | Token | Hex | Usage |
|---|---|---|---|
| Live / favorable / on plan | `club-green-800` | `#213a22` | Variance text, "Live data" chip, status dot fills |
| Partial / watch | `club-gold` | `#b08a4a` | "Partial" chip ring, ornament accents |
| Demo / under watch | `amber-700` to `amber-800` | `#b45309` to `#92400e` | "Demo data" chip text, soft amber tone stripes on briefing memos |
| Escalate (reserved) | `red-700` | `#b91c1c` | True escalation only; reserved sparingly |

### Banned colors

- Purple / violet / pink (any shade) — reads as SaaS
- Neon green, neon blue, neon orange — reads as alert system
- Gradient fills on tiles or backgrounds — reads as marketing site
- Pure `black` (`#000000`) and pure `white` (`#ffffff`) as text colors
  on the report body — use `club-green-900` and `club-cream` instead;
  the warmth is part of the prestige

### Background discipline

- Body / canvas background: `club-cream` (`#f8f5ef`) — warm
  parchment, never default white
- Tile / card backgrounds: white (`#ffffff`) for foreground tiles;
  `club-cream/40` for sub-tiles inside grouped blocks
- **No tinted card backgrounds** (no `bg-blue-50`, no
  `bg-amber-50`) on report content. The card is paper. Paper is
  white-on-cream.

---

## The Executive Reporting Theme

The five-tier palette + status indicators + background discipline,
applied as a single scoped theme, is the **Executive Reporting
Theme**. It is the visual language of every reporting surface in
Spectre.

### Scope

The theme applies **only** to routes under `/app/admin/reporting/**`.
Operational screens — the admin sidebar, the POS, the member portal,
member dining, and every non-reporting admin route — continue to ship
the original operational palette (`stone-50/100/200` neutrals, the
default `btn` / `card` / `Badge` primitives, the existing operational
green). Touching those tokens would break operator workflows and is
explicitly out of scope for this theme.

The scope guarantee is enforced architecturally:
- `AdminShell` detects `/app/admin/reporting` and strips its own
  chrome, rendering the `ReportingShell` instead.
- The reporting helpers (`dotForTone`, `toneHeadlineClass`,
  `ToneChip`, `DataSourceChip`, `SparkCard`) are defined locally in
  the monthly page; they do not export to operational components.
- The `club-gold-700` accent token is purely additive — no
  operational code path consumes it.

### Theme tokens at a glance

| Tier | Token | Usage |
|---|---|---|
| **Deep green** | `club-green-900` (`#0f2410`) | Cover club name, chapter titles, hero KPI numbers, shell header bg |
| | `club-green-800` (`#213a22`) | Prose body, L2 eyebrows at full opacity, "live" status text |
| | `club-green-700` (`#284829`) | Sparkline strokes, "on plan" status dot fills |
| **Ivory** | `club-cream` (`#f8f5ef`) | Body canvas, paper-on-paper chip background, sub-tile bg at /40 |
| | `club-sand` (`#ece5d3`) | Hairline dividers, card borders, chip rings, neutral status dot |
| **Muted gold** | `club-gold` (`#b08a4a`) — DEFAULT | Chapter numerals, period chip on deep-green header, ornament rules, partial chip ring |
| | `club-gold-700` (`#6b5028`) | Partial chip text on cream — AA-compliant variant (DEFAULT measures 2.9 : 1 on cream and fails) |

Status indicators (desaturated relative to default SaaS palettes):

| State | Text | Dot fill |
|---|---|---|
| Live / favorable | `text-club-green-800` | `bg-club-green-700` |
| Partial / watch | `text-club-gold-700` (on cream) / `text-club-gold` (on deep green) | `bg-club-gold` |
| Demo / under watch | `text-amber-700` | `bg-amber-700` |
| Escalate (reserved) | `text-red-700` | `bg-red-700` |
| Neutral / not applicable | `text-club-green-800/80` | `bg-club-sand` |

### Accessibility

Every text / background pairing in the theme is verified against
**WCAG 2.1 AA** (4.5 : 1 for normal text, 3 : 1 for large text +
non-text graphics):

| Pairing | Measured contrast | AA |
|---|---|---|
| `text-club-green-900` on `club-cream` | ≈ 12.5 : 1 | AAA |
| `text-club-green-800` on `club-cream` | ≈ 11.5 : 1 | AAA |
| `text-club-green-800/85` (prose) on `club-cream` | ≈ 9.8 : 1 | AAA |
| `text-club-green-800/65` (caption) on `club-cream` | ≈ 7.5 : 1 | AAA |
| `text-amber-700` on `club-cream` | ≈ 4.7 : 1 | AA |
| `text-red-700` on `club-cream` | ≈ 5.9 : 1 | AA |
| `text-club-gold-700` on `club-cream` | ≈ 7.1 : 1 | AAA |
| `text-club-gold` on `club-cream` | ≈ 2.9 : 1 | **FAIL — forbidden as text on cream** |
| `text-club-cream` on `club-green-900` (shell header) | ≈ 11.2 : 1 | AAA |
| `text-club-cream/65` on `club-green-900` | ≈ 6.8 : 1 | AA |
| `text-club-gold` on `club-green-900` (period chip) | ≈ 5.8 : 1 | AA |
| `bg-club-green-700` dot on white tile | ≈ 9.4 : 1 (non-text 3 : 1) | passes |
| `bg-amber-700` dot on white tile | ≈ 4.7 : 1 (non-text 3 : 1) | passes |
| `bg-red-700` dot on white tile | ≈ 5.9 : 1 (non-text 3 : 1) | passes |
| `bg-club-sand` dot on white tile | ≈ 1.1 : 1 | **subtle by design — neutral signals "no tone"** |

**Two rules** follow from this:

1. `text-club-gold` (DEFAULT) is **forbidden as report-body text on
   cream**. It is only used where the surrounding background lifts
   the contrast: on the deep-green shell header, on the chapter rail
   roman numerals (large + at-a-glance), or as a non-text accent
   (chip ring, ornament rule).
2. Any new tone-coloured text on cream must use the named
   AA-compliant tier (`club-green-800`, `club-gold-700`, `amber-700`,
   `red-700`) — never the `-500` or DEFAULT-only step.

### What this theme replaces

The Executive Reporting Theme replaces every SaaS color leak named in
the [color audit](monthly-reporting-color-audit.md) — pastel chip
backgrounds, stoplight status dots, the burnt-orange sparkline stroke,
and the last `bg-stone-300` neutral token. After the theme ships, the
reporting surface contains **zero `-500`-tier saturated tokens, zero
pastel-tinted chip backgrounds, zero stone tokens, and zero
hex-literal strokes outside the named palette.**

---

## Layout Philosophy

### Whitespace is intentional

- Section gaps: `mt-10` minimum between chapters, `mt-12` for major
  visual breaks
- Card padding: `p-6` minimum on tiles, `p-7` to `p-8` on hero
  blocks (cover, board briefing memos, statement headers)
- Reading column: `max-w-[680px]` on prose lines so the eye does
  not have to track 1280 px of text
- Group internal gap: `gap-5` to `gap-7` between grid tiles —
  cards must feel like separate documents on a desk, not a SaaS
  card row

**Cramming more data per square inch is a SaaS reflex. Resist
it.** Generous whitespace is not waste; it is the difference
between *document* and *interface*.

### Cards should be minimized

- Use cards **only** when the data inside truly needs the
  enclosure (a financial statement; a memo; a KPI hero). For
  every other section, let typography and hairlines carry the
  structure.
- **No card-in-card chrome.** A summary card inside a board
  statement is acceptable; a sub-section card inside that summary
  card is not.
- **No shadow stacks.** Cards have a hairline border and at most
  one subtle ambient shadow. No SaaS elevation tricks.

### Typography should create structure

- Hairline dividers + heading hierarchy replace heavy card chrome
  wherever possible.
- A section break is a serif `text-2xl` heading over a thin
  `border-club-sand` rule — that is enough. It does not need
  background fills or boxes.
- Smallcaps eyebrows (`text-[10px] uppercase tracking-[0.22em]`)
  carry section identity without consuming the visual weight that
  a real heading would.

### Borders should be reduced

- Replace `border-stone-200` (admin chrome) with `border-club-sand`
  (ivory hairline) on every reporting surface.
- Reduce border opacity to `border-club-sand/70` for internal
  dividers (within a card) so they read as part of the page
  texture, not as frame walls.
- **No double borders.** A card has a single hairline border. Its
  internal dividers are 1-px hairlines or `space-y-N`, not nested
  bordered containers.

### Grid discipline

- 2-column grids for memo-style blocks (briefing cards,
  stewardship cards).
- 3-column grids for tile rows (executive KPIs, headline tiles).
- 4-column grids only when each tile carries a single number and
  one comparator — never for content-heavy cards.
- Within a grid, every tile is the same height. Where content
  varies (definitions, sub-tile counts), pad the shorter tile;
  do not let the grid look ragged.

### Data density caps

- No more than **6 hero tiles** in one row on a 1440 px viewport.
- No more than **9 grouped tiles** in one block; if the data set is
  larger, split into two named groups separated by a hairline.
- No table on the first viewport of any section. Tables live below
  the summary cards + key variances + narrative notes, under a
  *"Full statement detail"* eyebrow.

---

## Narrative Philosophy

**Every section must answer four questions** (as defined in
[`docs/spectre-framework.md`](spectre-framework.md)):

1. **What happened?**
2. **Why does it matter?**
3. **Is it improving or deteriorating?**
4. **Does the Board need to act?**

The design system enforces this through two affordances:

### Affordance 1 — Level-4 framing paragraph

Every section opens with an italic-serif Level-4 paragraph that
answers Q1 and Q2 in two or three sentences. Without it the
section reads as data dump, not as a CFO's brief.

### Affordance 2 — Executive Commentary block

Every chapter that does not already carry built-in narrative
closes with an Executive Commentary aside whose four labelled
rows answer the four questions verbatim:

- *What happened*
- *What it means*
- *What needs attention*
- *Board decision required*

The Board-decision-required row always prints something
(falling back to *"None this month."*) so the question is never
silently dropped.

### Numbers require interpretation

**Never print a raw number alone.** Always pair with:

- the comparator (budget / policy / peer / prior year)
- the variance signal (+/- %, tone-coloured)
- the so-what when the comparator alone does not make the
  implication obvious

A KPI tile that says **"$ 14.62M"** is incomplete. A KPI tile
that says **"$ 14.62M / vs Budget $14.10M / +3.7% above plan"** is
useful. A KPI tile that says **"$ 14.62M / vs Budget $14.10M /
+3.7% above plan / on track to close above plan"** is
boardroom-ready.

---

## Honest Data Source Labelling

Mandatory on every reporting surface. Three states render through
a single `DataSourceChip` component:

| State | Chip | When |
|---|---|---|
| **Live data** | green | every input wired to a production source |
| **Partial data** | gold | mostly live, ≥ 1 input still placeholder |
| **Demo data** | amber | every input still placeholder |

**Trust is the only product Spectre delivers. Mislabelling
destroys it.** A board package that silently mixes live and
placeholder data is worse than one that ships with demo data
clearly marked.

---

## What to delete on sight

If you find any of the following on a reporting page during a
polish pass, remove them:

- "Coming soon" badges
- Sortable column headers with no board-package value
- "Last 30 days" / "Last 90 days" toggles on a *monthly*
  package
- Search bars
- Add / New / Edit / Delete buttons
- Bulk-action checkboxes
- Row hover backgrounds that look like admin lists
- Filter drawers
- Settings cogs
- Help tooltips that explain UI controls (the report explains
  itself; if it doesn't, fix the report)
- Loading spinners styled like generic SaaS content-loading
  placeholders (use a serif italic "Preparing package…" line
  instead)
- Emoji
- AI-generated cliché phrases ("Let's dive in", "Empower your",
  "At the end of the day")

---

## How this composes with the other standards

There are three layered standards governing reporting work. They
**compose**; they do not compete. All three are mandatory.

| Layer | Document | Governs | Question it answers |
|---|---|---|---|
| 1 | [`docs/spectre-framework.md`](spectre-framework.md) | The philosophy — five stewardship pillars + four questions | *What must the report answer?* |
| 2 | **This document** | The design system — typography, color, layout, narrative affordances | *How must the report look and read?* |
| 3 | [`.claude/skills/executive-reporting-design/SKILL.md`](../.claude/skills/executive-reporting-design/SKILL.md) | The playbook — squint test, print test, delete-on-sight list, review checklist | *How do I review and ship it?* |

**The order on any reporting change is**:

1. Open the framework (layer 1) — name the pillar(s) served,
   confirm the four questions will be answerable.
2. Open this design system (layer 2) — apply typography hierarchy,
   color palette, layout discipline, narrative affordances.
3. Open the skill (layer 3) — run the squint test, print test,
   and review checklist.

Skipping any layer is a violation of the operating rules.

---

## Implementation notes

The design system is already encoded in:

- **Palette tokens** in [`tailwind.config.ts`](../tailwind.config.ts) —
  `club.green.{50–900}`, `club.cream`, `club.sand`, `club.gold`,
  `club.ink`
- **Shared `DataSourceChip`** in
  [`src/app/app/admin/reporting/monthly/page.tsx`](../src/app/app/admin/reporting/monthly/page.tsx) —
  the unified Live / Partial / Demo treatment
- **Reporting shell** in
  [`src/components/reporting/ReportingShell.tsx`](../src/components/reporting/ReportingShell.tsx) —
  the deep-green header + cream body + gold-accent chapter rail
  + Print Mode toggle
- **Print CSS** in [`src/app/globals.css`](../src/app/globals.css) —
  `[data-print-mode="true"]` + `@media print` page-break and
  color-fidelity rules

New reporting surfaces should consume these existing primitives,
not reinvent them. Reinventing tokens is the fastest way to
violate the color philosophy.

---

## Required behavior

**Before Claude modifies any:**

- dashboard
- board package
- reporting screen
- KPI card
- committee report
- executive summary
- analytics module
- finance page
- membership page
- hospitality page

**it must:**

1. Read [`docs/spectre-framework.md`](spectre-framework.md) and
   name the pillar(s) the change serves.
2. Read **this document** and confirm the change honours typography
   hierarchy, color palette, layout discipline, and narrative
   affordances.
3. Then invoke the
   [`executive-reporting-design`](../.claude/skills/executive-reporting-design/SKILL.md)
   skill for review-checklist execution.

Final summaries for reporting work must:

- name the pillar served (layer 1)
- name which typography level(s) and palette tokens the work
  applies (layer 2)
- report the result of the squint test and print test (layer 3)

Skipping any layer is a violation of CLAUDE.md.

---

## Editorial Reporting Principle

Board reporting pages follow EDITORIAL hierarchy, not DASHBOARD
hierarchy. An annual report or investor-presentation cover is the
mental model — not a SaaS admin screen.

### Priority order for any reporting surface

1. **Report identity** — the primary anchor (club name, report
   title). Carries the dominant L1 / L1f serif treatment.
2. **Report context** — the secondary heading (period date,
   fiscal year, package name). One tier below identity; reads as
   the subordinate but readable subtitle.
3. **Conclusions** — the verdict (status statements, headlines).
   Tone-coloured serif, but sized so it ranks BELOW context lines
   and ABOVE narrative.
4. **Supporting analysis** — narrative, charts, supporting
   metrics. Body-copy tier.
5. **Metadata** — addressee, prepared-for, location, established
   year, framework colophon, confidentiality notes. The quietest
   tier: small uppercase or italic-serif, lower opacity, generous
   whitespace ABOVE so it reads as footer material, never as
   competing copy.

### Avoid

- **Stacked labels** — multiple eyebrows stacked in series with no
  hierarchy between them.
- **Excessive headings** — every line styled as if it were the
  next priority.
- **Multiple competing focal points** — three serif-text-2xl
  lines next to each other all demanding attention simultaneously.
- **Form-like layouts** — every field on its own line at the same
  visual weight, as though the page were a database form.

### Prefer

- **Whitespace** — generous `mt-6` / `mt-8` / `mt-10` between
  blocks to separate hierarchy tiers from each other.
- **Grouping** — tight `mt-1` inside a group, large `mt-N`
  between groups. A header and its supporting eyebrow read as
  one block.
- **Progressive disclosure** — the most important reading lands
  first; supporting information is below, smaller, quieter.
- **Annual-report style presentation** — the cover should feel
  like the opening page of a Deloitte/KPMG board package or a
  private-club annual report, not like a SaaS admin form.

### Multiple-field rule

When multiple requested fields must appear on a page, do not
place them all on separate lines at the same visual weight.

Decide which information is:

- **primary** — gets the title tier
- **secondary** — gets the subtitle tier
- **metadata** — gets the small uppercase / italic-serif tier
  with generous whitespace above it

Then design accordingly. Adding three fields to a cover does NOT
mean adding three new headline-tier lines.

### Decoration must justify itself

Decorative elements (aldus-leaf ornaments, hair rules, section
ornaments) are permitted only when they perform an editorial
function — separating chapters, marking a transition, anchoring
a prestige moment. **A decoration that no longer serves a
function is removed**, not preserved out of habit. Whitespace
alone is the preferred separator within the identity column;
ornaments are reserved for chapter transitions where the reader
benefits from a clear punctuation mark.

---

## Visual-First Reporting

Board-package sections that answer a board question follow the
**visual-first** rule: a director should understand the answer in
**5 seconds without reading paragraphs**. Charts dominate;
KPI ribbons support; commentary is footer-tier.

### Visual weight allocation

Within any visual stewardship section (the Chair's Dashboard
opener, future board-question dashboards, etc.):

- **70% — Chart** (the dominant element; multi-line, benchmark
  references, light editorial typography)
- **20% — KPI ribbon** (4 quoted-from-memory numbers above the
  chart)
- **10% — Interpretation prose** (max 2 sentences, hand-authored
  stewardship voice, italic-serif footer tier)

If your section reads as 60% prose and 10% chart, it is INVERTED.
Refactor toward the 70 / 20 / 10 split.

### What makes a chart "editorial" vs "dashboard"

| Editorial (preferred) | Dashboard (avoid) |
|---|---|
| Light tick hairlines (`stroke-club-sand`) | Heavy gridlines |
| No boxed plot area | Bordered chart area |
| Tiny axis labels in italic serif | Bold uppercase labels |
| 1-3 lines max (actual + ≤2 benchmarks) | 5+ series with a legend |
| Dashed/dotted benchmarks at low opacity | Solid coloured benchmarks |
| Solid actual line at higher chroma | Same line weight for all series |
| Reference line for break-even or target | Threshold area fill |
| Demo: Saguaro National annual report | Demo: SaaS analytics product |

### Two-question rule

Every visual stewardship section answers **at most two** board
questions, presented as side-by-side cards (stacked on narrow
viewports). The first card answers a long-term stewardship
question (multi-year trend); the second answers a current
operating question (rolling-12-month trend). Adding a third card
dilutes attention.

For the Chair's Dashboard, the two questions are:

1. Is the Club becoming financially stronger? (equity over time)
2. Are operations performing appropriately? (NOI rolling)

### Removing prose to make room

When converting a prose-heavy section to visual-first, the
existing paragraphs are NOT preserved as a precaution. They are
**removed** — the chart now communicates what the paragraph
previously described. If a stewardship reading needs to remain,
it is rewritten as the 2-sentence interpretation footer beneath
the chart, never restored as a separate paragraph block.

---

## The Three-Tier Communication Rule

This is the most-violated principle in reporting redesigns,
including by Claude. It is therefore the most important rule
to keep explicit.

> **Charts communicate conclusions.**
> **KPIs support conclusions.**
> **Commentary explains conclusions.**

Every reporting section that carries a stewardship reading
must respect this hierarchy. The chart is the primary
storyteller; the KPI ribbon is the second voice in chorus;
the commentary is the closing line. Each tier does ONE job;
none of them substitute for one of the others.

### Make the answer OBVIOUS — do not ANNOUNCE the answer

A board-pack designer's instinct, when a chart is failing to
communicate, is to add a label. Then a chip. Then a status
badge. Then a verdict callout. Then a milestone annotation.
Each addition feels like clarification; each addition is
actually a confession that the chart isn't communicating.

The discipline is the opposite: when the chart is failing,
make the **chart** carry the verdict, not the chrome around
it. The director should arrive at the conclusion naturally
from the visual hierarchy of the chart itself.

When deciding between:

1. **Adding** another label, annotation, chip, badge, or callout
2. **Making the chart communicate more clearly**

ALWAYS choose option 2.

### Good vs bad — the same target, different routes

Both columns below try to communicate the same stewardship
verdict. The left column reaches the verdict by improving the
chart's visual logic. The right column reaches the verdict by
piling chrome on top of an under-communicating chart.

| Editorial — chart carries the verdict | SaaS — chrome announces the verdict |
|---|---|
| Actual line **visibly** above the minimum-required line | Large *On Plan* status chip in the corner |
| Benchmark labels written **at the line terminus** in italic serif (`Floor`, `Best-in-Class`) | Coloured legend rectangle / traffic-light dot in a header |
| Cushion area between actual and floor shaded faintly | "+90 bps above floor" badge stuck to the title |
| KPI ribbon's primary values **visibly larger** than its benchmark values | Trend-arrow chips beside every KPI value |
| Commentary confirms what the chart already said | Commentary repeats what the badges already said |
| Break-even corridor as a tinted band the actual line sits cleanly above | Break-even line + green ✓ / red ✗ verdict marker |
| Actual line wins by stroke weight + chroma + opacity | Multiple status badges + scorecards + verdict chips |
| One verdict, communicated through chart geometry | Multiple verdicts, communicated through tile chrome |

The left column reads as a *premium annual report prepared by a
Finance Committee*. The right column reads as a *SaaS KPI
dashboard*. The two surfaces share data; they do not share
authorship voice.

### The verdict-communication ladder

When a chart isn't communicating a verdict, climb the ladder
in this order. Stop at the lowest rung that solves the
problem; do not pile rungs on top of each other.

1. **Improve the visual delta between actual and benchmark.**
   Is the comparison VISIBLE without the director computing it?
   If not, the chart needs more contrast between actual and
   benchmark — through line weight, chroma, opacity, or by
   shading the area between them.
2. **Name what the benchmark IS at the line's terminus.**
   "Floor: $26.31M" or "Best-in-Class: $32.18M" — a 1-3 word
   italic-serif label where the line ends. This converts an
   anonymous reference line into a named anchor. It is the
   single most editorial way to tell the director what they're
   looking at.
3. **Re-author the KPI labels to carry verdict context.**
   *"+90 bps above floor"* replaces *"Min. Required CAGR"*.
   *"+$340K favourable to plan"* replaces *"Budget Goal"*. The
   KPI tier becomes the second voice in the chorus.
4. **Re-author the card title or subtitle to imply the verdict.**
   Not a chip; not a badge. The TITLE itself, in editorial
   language. *"Equity Compounding Above the Stewardship Floor"*
   instead of *"Equity Value Over Time"*. The title is the
   first thing the director reads; it should not be neutral.
5. **Confirm with the commentary footer.** Two sentences max.
   The first sentence states the verdict the visual already
   said; the second names the watchpoint.

Climb rung 1 first. If it solves the problem, stop. Only climb
to rung 2 if rung 1 is insufficient. Each higher rung adds
authorship investment — at no point does any rung add a chip,
badge, traffic light, scorecard, or verdict callout.

### When NOT to add a chart device

These devices have specific use cases. Adding them outside
those use cases makes the surface read SaaS:

- **Milestone marks on the timeline.** Reserve only for charts
  whose conclusion depends on a SPECIFIC policy moment ("Reserve
  Study Adopted FY24"). Not on every chart. Not as decoration.
- **Tinted policy bands.** Reserve for metrics with a STATED
  policy corridor (Dues-to-Revenue 38-44%, break-even
  corridor). Not as a generic shaded "healthy range."
- **Variance shading between actual and budget.** Reserve for
  charts where favourable/unfavourable variance is the central
  reading. Adding it to every line chart turns the page into
  noise.
- **Direction-of-trend words** (*strengthening / stable /
  softening*). Reserve for KPIs where direction is the chart's
  verdict. Most KPIs do not need them.

The default is the absence of these devices. They are added
ONLY when the chart's central question genuinely depends on
them.

### Restraint as the final test

Before adding anything to a stewardship chart, ask:

> *"Would a Finance Committee that issued this report have
> wanted this element?"*

A Finance Committee that has spent a career reading institutional
investment reports, annual reports, and board packages has a
trained allergy to chrome. They want **the chart**. They want
**the number**. They want **two sentences**. They do not want
a status chip explaining what they can already see, and they
do not want a traffic light insulting their literacy.

The reporting surface is for them. If the addition feels like
helping a novice reader, it does not belong.

---

## When this design system is wrong

This is a living document. When a reporting requirement does not
fit the typography hierarchy, color palette, or layout discipline,
do not force-fit it. Flag the gap to the user and ask whether
(a) the requirement belongs elsewhere, (b) an exception is
warranted, or (c) the design system needs an amendment. The
design system exists to give reporting work a shared visual
foundation; it does not exist to constrain honest governance
needs that the founder identifies later.

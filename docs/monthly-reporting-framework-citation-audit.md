# Monthly Reporting — Framework Citation Audit

**Surface:** the Monthly Board Reporting Package at
`/app/admin/reporting/monthly`.
**Audit date:** 2026-06-04
**Audited against:** [docs/spectre-framework.md](spectre-framework.md) —
the Spectre Framework's **five stewardship pillars** and **four
questions every reporting screen must answer**.

> **No code changed.** This document inventories where the package
> currently cites the Spectre Framework, identifies gaps where the
> framework *should* be cited but isn't, and recommends placements.

---

## What the framework requires

[docs/spectre-framework.md](spectre-framework.md) establishes the
package as the implementation of two governance instruments:

### The five stewardship pillars

| # | Pillar | Question it asks |
|---|---|---|
| 1 | **Operating Stewardship** | *Can the Club sustainably fund and operate itself?* |
| 2 | **Capital Stewardship** | *Is the Club responsibly reinvesting in its facilities?* |
| 3 | **Balance Sheet Stewardship** | *How resilient is the Club financially?* |
| 4 | **Membership Stewardship** | *Is membership healthy and sustainable?* |
| 5 | **Experience Stewardship** | *Are members receiving value from the Club?* |

### The four questions

Every reporting screen must answer:

1. *What happened?*
2. *Why does it matter?*
3. *Is the trend improving or deteriorating?*
4. *Does the Board need to take action?*

### What "referencing the framework" means

A framework reference can take three forms:

- **Prose** — narrative text names a pillar (*"Pillar 1 Operating
  Stewardship is intact"*).
- **Structured** — a labelled UI element (chip, tag, badge, header
  field) names a pillar with a data attribute / testid.
- **Colophon** — the document itself names the framework as the
  governance instrument it implements.

The current package has substantial **prose** references (the
narrative-rewrite pass added 33 inline pillar citations across the
page + service). It has **zero structured** references — no
pillar-tagged UI element exists today. It has **zero colophon**
references — the cover does not name the framework anywhere.

This audit measures gaps in those last two categories.

---

## What's already cited (preserve)

The narrative-rewrite pass left the page with **33 inline prose
citations** of the framework's pillars:

| Surface | Pillars cited | Style |
|---|---|---|
| ExecutiveSummary headline (ch III) | 1, 2, 3 | prose, in copy |
| Stewardship lead (ch IV) | 1, 2, 3 | prose, in copy |
| Stewardship block titles | "Operating Stewardship" / "Capital Stewardship" | structured h3 headings |
| Financial Statements lead (ch V) | 1, 2, 3 | prose, in copy |
| Operations lead (ch VI) | 4, 5 | prose, in copy |
| Payroll lead (ch VII) | 1 | prose, in copy |
| F&B lead (ch VIII) | 1, 5 | prose, in copy |
| Briefing memo narratives (ch II × 3) | 1, 3, 4, 5 | prose, signed by author |
| Statement notes (×4) | 1, 2, 3 | prose, in controller's voice |
| Executive Commentary blocks (×8) "What it means" rows | various pillars | prose, in copy |

**These citations should be preserved.** The audit identifies where
the package needs *additional* references — both as **structured**
UI fields (so a director can scan pillar coverage without reading
every paragraph) and as **colophon** references (so the document
identifies the framework it implements).

---

## Methodology

I walked every surface of the package and asked three questions:

1. **Does this surface serve one or more stewardship pillars?**
   (Most do; some — the cover masthead, the chapter rail TOC — are
   document chrome rather than content.)
2. **Does the surface currently cite which pillar(s) it serves?**
   (Either in prose, as a structured tag, or in a colophon.)
3. **Would a Finance Chair scanning the surface be able to identify
   the pillar without reading every paragraph?**

A surface that serves a pillar but doesn't make that mapping
visible is a finding. Severity is ranked by how visible the surface
is and how important the citation is to a Finance Chair's
governance work.

---

## Severity scale

| Rank | Definition |
|---|---|
| **Critical** | High-visibility surface (cover, chapter title row, KPI hero) with no structured framework reference. A director reading only this surface cannot tell which pillar is being served. |
| **High** | Mid-visibility surface where adding a structured reference would dramatically improve scannability. |
| **Medium** | Defensible omission (the prose already cites pillars) but a structured reference would compound the value. |
| **Low** | Optional / cosmetic. Documented for completeness. |

---

## Findings

### Critical

#### C1 — Cover has no framework colophon
[page.tsx:181–272](src/app/app/admin/reporting/monthly/page.tsx#L181-L272)

The cover currently has three registers — masthead (*"Monthly Board
Reporting Package"*), hero (club name + period), colophon
(*"Prepared for The Finance Committee · Board of Directors"* + date).
The colophon names the **audience** but not the **governance
instrument**. A real board package's colophon traditionally cites
the framework, by-laws, or policy instrument the document
implements:

> *Prepared per the Spectre Framework (five stewardship pillars
> and four questions), the FY24 Reserve Study, and the FY23
> Collections Policy.*

A board reader opening the cover should be able to tell, in one
glance, that this is a Framework-conformant document. A
new committee chair or auditor reading the package five years from
now should be able to identify the governance instrument the
document was structured around.

**Recommended placement:** A small italic-serif colophon line at the
bottom of the cover, below the *"Prepared on May 31, 2026"* metadata.
Print-mode-only would also be defensible — the colophon survives the
artifact but stays quiet on screen.

**Rank: Critical.** The cover is the document's masthead; the
framework citation belongs here.

---

#### C2 — At-a-Glance KPI tiles do not carry a pillar tag
[page.tsx — `KpiCardView`](src/app/app/admin/reporting/monthly/page.tsx)

The six at-a-glance KPI tiles (chapter III) each carry a label,
hero value, interpretation, comparator, and tone dot. None carries
a structured pillar tag, even though each tile maps cleanly to a
pillar:

| Tile | Serves |
|---|---|
| YTD Revenue | Pillar 1 |
| NOI Before Depreciation | Pillar 1 |
| Capital Income | Pillar 2 |
| Reserve Coverage | Pillar 2 |
| Working Capital | Pillar 3 |
| AR Current % | Pillar 1 |

The Executive Headline above the grid says *"Pillar 1 Operating,
Pillar 2 Capital, and Pillar 3 Balance Sheet Stewardship are all
favorable"* — but the reader has to mentally map the chip text to
the individual tiles. A small Pillar badge on each tile would
remove the mental step.

**Recommended placement:** A small smallcaps eyebrow above the tile
label, e.g. *"PILLAR 1 · OPERATING"*. Or a tone-coloured pillar
mark in the corner alongside the existing tone dot.

**Rank: Critical.** The at-a-glance grid is the chapter the
Finance Chair reads first; the pillar coverage of those six tiles
is the chapter's whole point.

---

#### C3 — Stewardship Dashboard cards do not carry a pillar tag
[page.tsx — `StewardshipMetricCard`](src/app/app/admin/reporting/monthly/page.tsx#L590-L686)

The 16 Stewardship cards (chapter IV) are organized into two parent
blocks — "Operating Stewardship" (Pillar 1) and "Capital
Stewardship" (Pillar 2). The block title implies the pillar but
individual cards do not name it. A reader scanning a single card
out of context cannot tell which pillar it serves.

More acutely: some cards in the Operating block actually serve
**multiple** pillars (e.g. *F&B Subsidy %* serves Pillar 1 AND
informs Pillar 5 Experience). Some Capital block cards serve Pillar
3 Balance Sheet as well as Pillar 2 Capital. The block-title
heuristic is approximate.

**Recommended placement:** A small smallcaps badge in the card
header alongside the metric name, e.g. *"PILLAR 1"* or *"PILLAR 1, 5"*
for multi-pillar metrics. Structured as a data attribute so DOM
walkers can filter by pillar.

**Rank: Critical.** This is the framework's named chapter; every
card here is a framework artifact and should be tagged as one.

---

### High

#### H1 — Chapter rail (TOC) does not carry pillar labels
[ReportingShell.tsx — chapter list](src/components/reporting/ReportingShell.tsx)

The left-side chapter rail lists the 10 chapters by roman numeral
and name. A reader looking at the rail cannot tell which chapter
serves which pillar without opening it. A small pillar mark next
to each chapter title would let a Finance Chair scan the rail
and find the pillar-relevant chapter in one glance.

| Chapter | Serves |
|---|---|
| I Executive Opening | (cover) |
| II Board Financial Briefing | 1, 2, 3, 4, 5 (whole-package summary) |
| III At-a-Glance KPIs | 1, 2, 3 |
| IV Stewardship Dashboard | 1, 2, 3 |
| V Financial Statements | 1, 2, 3 |
| VI Operations & Analytics | 4, 5 |
| VII Payroll | 1 |
| VIII F&B / Hospitality | 1, 5 |
| IX Capital / Projects | 2 |
| X AR / Collections | 1 |

**Recommended placement:** A small smallcaps line under each
chapter title in the rail (*"PILLAR 1"* / *"PILLARS 4, 5"*), or a
tone-coloured pillar dot prefix.

**Rank: High.** The rail is the document's table of contents;
mapping pillars to chapters there makes the framework navigable.

---

#### H2 — BoardStatement headers do not carry a pillar tag
[page.tsx — `BoardStatement`](src/app/app/admin/reporting/monthly/page.tsx#L1521-L1640)

Each `BoardStatement` (4 instances: Statement of Activities,
Capital Fund, Statement of Financial Position, AR Aging) ships a
header with eyebrow + serif title + Board Consideration chip +
Data Source chip. The header does not name which pillar the
statement sustains, even though each one maps cleanly:

| Statement | Sustains |
|---|---|
| Statement of Activities | Pillar 1 |
| Capital Fund | Pillar 2 |
| Statement of Financial Position | Pillar 3 |
| AR Aging | Pillar 1 (with Pillar 4 implications) |

The Executive Headline of chapter V says *"sustain Pillar 1
Operating, Pillar 2 Capital, and Pillar 3 Balance Sheet
Stewardship"* — but the individual statements don't say which one
they personally serve.

**Recommended placement:** A small pillar tag in the BoardStatement
header, next to the eyebrow.

**Rank: High.** The financial-statement chapter is the document's
core; statement-to-pillar mapping should be structured.

---

#### H3 — Executive Commentary rows do not name the four framework questions
[page.tsx — `ExecutiveCommentary`](src/app/app/admin/reporting/monthly/page.tsx#L1382-L1455)

The Executive Commentary block renders four labeled rows:

| Current label | Framework question | Match quality |
|---|---|---|
| *"What happened"* | Q1 *"What happened?"* | ✓ exact |
| *"What it means"* | Q2 *"Why does it matter?"* | ≈ paraphrase |
| *"What needs attention"* | Q3 *"Is the trend improving or deteriorating?"* | ✗ different concept (exceptions vs trend) |
| *"Board decision required"* | Q4 *"Does the Board need to take action?"* | ✓ matches in intent |

The framework names four specific questions. Three of the four
ExecutiveCommentary labels are either off-target (Q3) or
paraphrased (Q2). A board reader reading the framework and then
reading the package shouldn't have to mentally translate.

**Recommended placement:** Either (a) rename the rows to literally
match the four framework questions, or (b) add a footnote at the
top of every commentary block saying *"this block answers the
four framework questions"* and provide a mapping.

The trade-off is that *"What needs attention"* is arguably more
useful operationally than the framework's literal Q3 *"Is the trend
improving"*. A pragmatic resolution: keep the current useful labels
but add a small structured tag under each row mapping it to the
framework question. *"What needs attention · Q3 trend"*.

**Rank: High.** This is the four-questions answer; the framework
mapping should be explicit.

---

### Medium

#### M1 — Capital Projects chapter IX lead does not name Pillar 2
[page.tsx:115–119](src/app/app/admin/reporting/monthly/page.tsx)

The chapter IX lead currently reads *"Approved capital plan"*. There
is no framing paragraph in italic-serif L4 form, and no pillar
citation. Chapter IX serves Pillar 2 Capital Stewardship; the lead
should name it.

**Recommended placement:** Add an L4 italic-serif framing paragraph
that cites Pillar 2 Capital Stewardship + the FY24 Reserve Study.

**Rank: Medium.** Other chapters carry L4 framing leads; chapter IX
should match.

---

#### M2 — AR Collections chapter X lead does not name pillars
[page.tsx:128](src/app/app/admin/reporting/monthly/page.tsx)

Chapter X uses the standard `SectionHeading` ("Member accounts and
aging") + the chapter-X commentary block. No L4 italic-serif
framing paragraph at the top of the chapter, and no Pillar 1 / 4
citation in a lead position.

**Recommended placement:** Add an L4 italic-serif framing paragraph
naming Pillar 1 Operating Stewardship (the AR cycle) and Pillar 4
Membership Stewardship (the member-account dimension).

**Rank: Medium.** Same gap as M1.

---

#### M3 — Reporting shell header has no Spectre Framework mark
[ReportingShell.tsx — header](src/components/reporting/ReportingShell.tsx)

The shell header carries the club name, the document title (*"Monthly
Board Reporting Package"*), the period chip, the Print Mode toggle,
and the close glyph. There is no small mark identifying the
governance framework.

For a board package that is read across multiple years by multiple
committees, the shell header is the document spine — a small
*"per the Spectre Framework"* mark in print mode (or in a footer
strip) would persist across every page of the printed artifact.

**Recommended placement:** A small italic-serif print-mode-only
footer line, or a tiny smallcaps mark in the shell-header's
identity stack.

**Rank: Medium.** Useful for print artifacts; less critical for
on-screen reading.

---

#### M4 — Briefing memo "Re:" lines do not name pillars
[page.tsx — BoardBriefing](src/app/app/admin/reporting/monthly/page.tsx)

Each briefing memo's `Re:` field currently reads *"Operations
performance, May 2026"* / *"Financial health, May 2026"* / *"Capital
program, May 2026"*. The framework pillar each memo addresses is
implicit (Operations → 4, 5; Financial Health → 1, 3; Capital
Program → 2). A structured pillar tag in the letterhead would make
this explicit.

**Recommended placement:** A small smallcaps line under the *"Re:"*
field, e.g. *"PILLARS 4, 5"* or *"PILLAR 2"*.

**Rank: Medium.** The prose already names pillars; the structured
tag would be additive.

---

### Low

#### L1 — Print-mode page footer has no framework citation
The package's print-mode CSS (in [globals.css](src/app/globals.css))
strips chrome and gives the artifact `@page` margins. It doesn't add
a print-only running footer. A traditional board package has a
print footer naming the framework, the page number, and the date.

**Recommended placement:** `@page { @bottom-center { content: ... }}`
print rule citing the framework.

**Rank: Low.** Affects only the print artifact.

---

#### L2 — Service types do not carry a `pillar` field on KPI cards
[lib/reporting/monthly-package.ts](src/lib/reporting/monthly-package.ts)

The service exposes `StewardshipKpi`, `KpiCard`, `StatementSummaryCard`,
and other KPI surfaces. None carries a `pillar` field. Adding one
would let downstream consumers (a future Pillar-by-Pillar
dashboard, an audit-trail export, a print artifact) filter and
group by pillar without rebuilding the mapping.

**Recommended placement:** Optional `pillar?: 1 | 2 | 3 | 4 | 5 |
ReadonlyArray<1 | 2 | 3 | 4 | 5>` field on the relevant types.

**Rank: Low.** Service-layer infrastructure; downstream value but
no immediate UI impact.

---

## Summary table

| ID | Element | Where | Rank |
|---|---|---|---|
| C1 | Cover has no framework colophon | [page.tsx:181-272](src/app/app/admin/reporting/monthly/page.tsx#L181-L272) | **Critical** |
| C2 | At-a-Glance KPI tiles carry no pillar tag | KpiCardView (6 tiles) | **Critical** |
| C3 | Stewardship Dashboard cards carry no pillar tag | StewardshipMetricCard (16 cards) | **Critical** |
| H1 | Chapter rail (TOC) carries no pillar labels | [ReportingShell.tsx](src/components/reporting/ReportingShell.tsx) | High |
| H2 | BoardStatement headers carry no pillar tag | 4 statement headers | High |
| H3 | Executive Commentary rows do not literally name the four framework questions | [page.tsx:1382-1455](src/app/app/admin/reporting/monthly/page.tsx#L1382-L1455) | High |
| M1 | Capital Projects chapter IX lead does not cite Pillar 2 | [page.tsx:115-119](src/app/app/admin/reporting/monthly/page.tsx) | Medium |
| M2 | AR Collections chapter X lead does not cite pillars | [page.tsx:128](src/app/app/admin/reporting/monthly/page.tsx) | Medium |
| M3 | Reporting shell header has no framework mark | [ReportingShell.tsx](src/components/reporting/ReportingShell.tsx) | Medium |
| M4 | Briefing memo Re: lines do not name pillars | BoardBriefing | Medium |
| L1 | Print-mode page footer has no framework citation | [globals.css](src/app/globals.css) | Low |
| L2 | Service types do not carry a structured `pillar` field | service types | Low |

---

## Recommended remediation sequence

If the founder authorizes a remediation pass, the highest-leverage
ordering is:

1. **C3 — pillar tag on every Stewardship card.** This is the
   framework's named chapter; tagging the 16 cards is the single
   most-load-bearing change. One small smallcaps tag per card.
2. **C2 — pillar tag on every at-a-glance KPI tile.** Same atom;
   six tiles instead of sixteen.
3. **H2 — pillar tag in each BoardStatement header.** Same atom
   pattern; four statements.
4. **H1 — pillar labels in the chapter rail.** TOC navigation
   becomes pillar-navigable.
5. **C1 — framework colophon on the cover.** A single italic-serif
   line in the cover's bottom register.
6. **M1, M2 — L4 framing leads for chapter IX and X.** Two missing
   leads brought up to chapter-VI/VIII parity.
7. **H3 — explicit four-questions mapping in Executive Commentary.**
   Either rename rows OR add structured Q1/Q2/Q3/Q4 tags.
8. **M3, M4, L1, L2 — colophon / shell mark / service field**
   additions. Optional polish.

Items 1–3 are mechanical (one atom edit, applied across N call
sites). Item 4 is a small ReportingShell change. Items 5–8 are
each small additions. The bulk of the audit's findings can be
closed in a single coherent pass.

---

## What is NOT a finding

These surfaces serve framework purposes but do not need additional
references:

- **KPI card `interpretation` paragraphs** — already do the work of
  pillars in plain English; adding a structured pillar tag would be
  redundant with the existing context strings.
- **Statement detail tables (line-by-line)** — controller's audit
  trail; pillar tags would clutter the line-by-line view.
- **The Briefing memo body paragraphs** — already cite pillars in
  prose; structured tags in the body would be duplicative.
- **The Print Mode toggle, the close glyph, the chapter ornament,
  the data-source chip** — document chrome, not content.
- **The `BoardConsiderationChip` itself** — answers Q4 directly
  through its four-state enum; adding a framework citation on top
  would over-engineer.

The framework reference belongs on **content surfaces**, not on
chrome surfaces. The audit's findings are scoped accordingly.

---

## Open question for the founder

A single high-leverage decision determines the implementation
shape: **should pillar coverage be carried as a structured data
field on each KPI / statement / card, or only rendered as a
smallcaps UI tag?**

- **Structured field** (option A): every KPI type gains an optional
  `pillar?: number | number[]` field; the UI renders the tag from
  that field. Reusable downstream (Pillar-by-Pillar dashboard,
  audit export, future analytics).
- **UI tag only** (option B): the pillar mapping lives in the
  rendering code, hard-coded per tile / per card. Faster to ship;
  less reusable.

I recommend **option A** for C2, C3, H2 (the high-volume tagging
surfaces) and **option B** for H1 (chapter rail), C1 (cover), M1,
M2 (chapter leads) — the chapter-level rail / cover / lead
mappings change rarely and don't need data-model support.

---

## When this audit is wrong

If the founder decides the prose-only framework references already
in the package are sufficient, the structured-tag findings (C2, C3,
H2) should be deliberately rejected and the design system should
record that pillar coverage is communicated via prose, not via
structured UI tags. The audit identifies which direction the
package currently sits and what would move it the other way.

For a Finance Chair using the package today, the prose citations
are probably enough. For a Finance Chair using the package after a
committee turnover — or for an auditor reviewing the package five
years from now — the structured tags would be substantially more
navigable. The decision turns on whether the package is read once
per period or referenced as a longitudinal record.

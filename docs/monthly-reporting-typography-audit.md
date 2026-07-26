# Monthly Reporting — Typography Audit

**Surface:** `/app/admin/reporting/monthly`
**Audit date:** 2026-06-03
**Audited against:** [Spectre Executive Reporting Design System §
Typography Hierarchy](spectre-executive-reporting-design-system.md#typography-hierarchy)

> **No code changed.** This document is the source-of-truth list for a
> follow-up remediation pass. Each finding cites file + line. The
> audit also surfaces gaps in the design system itself — places where
> the page is doing something defensible that the spec does not name.

---

## What the design system requires

Five levels, regular weight throughout, all on the club-green palette.

| Level | Role | Spec |
|---|---|---|
| **L1** | Club name (cover only) | `font-serif text-5xl`–`text-6xl tracking-tight leading-[1.1] text-club-green-900` |
| **L2** | Running header / section eyebrows | sans `text-[10px]`–`text-[11px] uppercase tracking-[0.22em]` — `text-club-cream/65` on green OR `text-club-green-800/75` on cream |
| **L3** | Section titles | `font-serif text-2xl tracking-tight leading-tight text-club-green-900` (sub-block uses `text-xl`) |
| **L4** | Narrative headline (CFO's voice) | `font-serif italic text-[15px] leading-relaxed text-club-green-900/85 max-w-[680px]` |
| **L5** | Body copy | sans `text-[13px]`–`text-[13.5px] leading-relaxed text-club-green-900/85` (captions `text-club-green-800/65`); tabular numbers `font-mono tabular-nums` |

The spec also requires:
- **Regular weight everywhere.** Hierarchy is built from *typeface*, *size*, *case*, *color* — not from `font-medium` / `font-semibold`.
- **Only three opacity tiers** are named: `/65` (captions / chip eyebrows), `/75` (L2 cream-body eyebrows), `/85` (L4 + L5 prose).

---

## Severity scale

| Rank | Definition |
|---|---|
| **Critical** | Fails the squint test. A board director glancing at the screen would perceive the wrong hierarchy or feel "this was built by two different hands". |
| **High** | Visible on every chapter and contradicts the documented hierarchy, but not enough to confuse a glance. |
| **Medium** | Subtle proliferation that compounds across chapters (opacity drift, tracking variants, undocumented sub-block sizes). |
| **Low** | Defensible cosmetic micro-choice. Document for completeness; reject if challenged. |

---

## Per-level findings

### L1 — Club name (cover)

**Conformant:**
- Cover club-name `<h1>` at [monthly/page.tsx:200](src/app/app/admin/reporting/monthly/page.tsx#L200) — `font-serif text-5xl leading-[1.1] tracking-tight text-club-green-900 sm:text-6xl` ✓

**Failure:**

#### F1 — Hero KPI tiles use L1-tier serif (text-5xl)
[KpiCardView at monthly/page.tsx:1154](src/app/app/admin/reporting/monthly/page.tsx#L1154)

```tsx
<div className="mt-6 font-serif text-5xl leading-none tracking-tight tabular-nums text-club-green-900">
```

The at-a-glance KPI tiles render their hero number at **`text-5xl`** (60 px). The system reserves L1 for the cover only — the spec literally says *"Usage: cover panel only; **never** in card chrome or table headers"*.

**Effect:** On the at-a-glance chapter the six KPI tiles all read as visually equal to the cover's club-name title. The director's eye cannot tell at squint range whether they are still on the cover or three chapters in.

**Rank: Critical.** The spec is unambiguous; the page is violating it.

---

### L2 — Running header / section eyebrows

**Conformant:**
- Most smallcaps eyebrows in the page use `text-[10px] uppercase tracking-[0.22em]` with `text-club-green-800/75`. See SectionHeading at [monthly/page.tsx:1095](src/app/app/admin/reporting/monthly/page.tsx#L1095), KpiCardView label at [monthly/page.tsx:1139](src/app/app/admin/reporting/monthly/page.tsx#L1139), BoardStatement eyebrow at [monthly/page.tsx:1318](src/app/app/admin/reporting/monthly/page.tsx#L1318), Stewardship card name at [monthly/page.tsx:465](src/app/app/admin/reporting/monthly/page.tsx#L465).

**Failures:**

#### F2 — Smallcaps tracking is split between 0.22em and 0.18em
The system says `tracking-[0.22em]`. Roughly half the smallcaps eyebrows are at the spec; the other half use a tighter `tracking-[0.18em]`. Examples at spec-level **`0.22em`**:
- SectionHeading eyebrow [page.tsx:1095](src/app/app/admin/reporting/monthly/page.tsx#L1095)
- Stewardship card name [page.tsx:465](src/app/app/admin/reporting/monthly/page.tsx#L465)
- BoardStatement eyebrow [page.tsx:1318](src/app/app/admin/reporting/monthly/page.tsx#L1318)
- KpiCardView label [page.tsx:1139](src/app/app/admin/reporting/monthly/page.tsx#L1139)
- Executive Commentary eyebrow [page.tsx:1235](src/app/app/admin/reporting/monthly/page.tsx#L1235)

Off-spec at **`0.18em`**:
- KpiCardView comparator label [page.tsx:1176](src/app/app/admin/reporting/monthly/page.tsx#L1176)
- BoardSummaryCard label [page.tsx:1394](src/app/app/admin/reporting/monthly/page.tsx#L1394)
- Stewardship "What it is" / "Why it matters" `<dt>` [page.tsx:1253, 498, 509](src/app/app/admin/reporting/monthly/page.tsx#L498)
- OperatingMetric label [page.tsx:816](src/app/app/admin/reporting/monthly/page.tsx#L816)
- Executive Commentary row dt [page.tsx:1253](src/app/app/admin/reporting/monthly/page.tsx#L1253)
- Period chip in shell header [ReportingShell.tsx:110](src/components/reporting/ReportingShell.tsx#L110)

Also seen at `tracking-[0.14em]` on statement-detail and capital-projects column headers [page.tsx:619–622, 1425–1428](src/app/app/admin/reporting/monthly/page.tsx#L619) and at `tracking-[0.3em]` on the cover "Monthly Reporting Package" eyebrow [page.tsx:188](src/app/app/admin/reporting/monthly/page.tsx#L188).

**Effect:** Identical-looking smallcaps eyebrows track at three different rates. When two such labels appear in the same card (e.g., the BoardStatement eyebrow at 0.22em sitting above the BoardSummaryCard label at 0.18em), the inconsistency reads as carelessness.

**Rank: High.** Visible on most chapters; the design system is unambiguous; the page has drifted.

#### F3 — Cover eyebrow at tracking-[0.3em] is even wider
[page.tsx:188](src/app/app/admin/reporting/monthly/page.tsx#L188): `text-[10px] uppercase tracking-[0.3em] text-club-gold`.

The cover running label "MONTHLY REPORTING PACKAGE" tracks at 0.3em — even wider than the spec. The wider tracking is defensible as a cover convention but it has no name in the design system. Either declare a "Cover eyebrow" tier or collapse to L2's 0.22em.

**Rank: Low / spec gap.**

#### F4 — L2 color drift on cream backgrounds
The spec names two L2 colors: `text-club-cream/65` on the green shell header, `text-club-green-800/75` on cream body. The page also uses:

- `text-club-green-700/80` for the cover "Prepared for" eyebrow [page.tsx:230](src/app/app/admin/reporting/monthly/page.tsx#L230)
- `text-club-green-800/55` for the cover "Prepared on" footer [page.tsx:244](src/app/app/admin/reporting/monthly/page.tsx#L244)
- `text-club-gold/85` for the StewardshipBlock "8 ratios" counter [page.tsx:434](src/app/app/admin/reporting/monthly/page.tsx#L434)
- `text-club-green-800/65` for SectionHeading eyebrow (added in body polish) [page.tsx:1095](src/app/app/admin/reporting/monthly/page.tsx#L1095)
- `text-club-green-800/70` for BoardStatement variance eyebrow [page.tsx:1339](src/app/app/admin/reporting/monthly/page.tsx#L1339), Capital projects eyebrow [page.tsx:611](src/app/app/admin/reporting/monthly/page.tsx#L611), briefing memo supporting-metric label [page.tsx:374](src/app/app/admin/reporting/monthly/page.tsx#L374), OperatingMetric label [page.tsx:816](src/app/app/admin/reporting/monthly/page.tsx#L816), BoardSummaryCard label [page.tsx:1394](src/app/app/admin/reporting/monthly/page.tsx#L1394)
- `text-club-cream` (no opacity) for shell running club name [ReportingShell.tsx:97](src/components/reporting/ReportingShell.tsx#L97) — spec says `cream/65`

Six distinct L2 colors against the two the spec names.

**Rank: High.** Compounds with F5 (opacity proliferation).

---

### L3 — Section titles

**Spec: `font-serif text-2xl tracking-tight leading-tight text-club-green-900`.**

**Failures:**

#### F5 — SectionHeading atom uses text-3xl (one tier above spec)
[SectionHeading at monthly/page.tsx:1098](src/app/app/admin/reporting/monthly/page.tsx#L1098):
```tsx
<h2 className="mt-2 font-serif text-3xl tracking-tight text-club-green-900">
```

The atom that paints every chapter heading (II–X) was bumped to `text-3xl` (30 px) during the body-polish pass, intentionally for "prestige weight". The spec says `text-2xl` (24 px) for primary section titles.

This is a **deliberate deviation** for hero impact. Two options:
- **Collapse** to `text-2xl` per spec — the page becomes more uniform but chapter titles lose visual presence.
- **Amend** the spec to allow `text-2xl`–`text-3xl` for L3 primary, distinguishing chapter-level titles (text-3xl) from sub-section titles (text-2xl).

I lean toward the amendment, because the chapter titles at text-2xl would feel undersized given the cover club-name at text-6xl — there's a 36-pixel gap that the chapter-rail numerals don't fill.

**Rank: High.** Deliberate, visible on every chapter, but resolvable by either path.

#### F6 — Sub-block headers come in three sizes
The spec says sub-block titles use **`text-xl`** (20 px). Actually:
- StewardshipBlock title ("Operating Stewardship") — `text-2xl` ([page.tsx:433](src/app/app/admin/reporting/monthly/page.tsx#L433)) — L3 *primary* size on a sub-block role.
- BoardStatement title ("Statement of Activities") — `text-2xl` ([page.tsx:1322](src/app/app/admin/reporting/monthly/page.tsx#L1322)) — same.
- 12-month-trend titles ("Course utilization trend", "Payroll ratio trend", "F&B subsidy trend") — `text-xl` ([page.tsx:748, 937, 1062](src/app/app/admin/reporting/monthly/page.tsx#L748)) — matches L3 sub-block spec ✓.
- OperatingMetricGroup title ("Membership & waitlist") — **`text-lg`** ([page.tsx:799](src/app/app/admin/reporting/monthly/page.tsx#L799)) — **18 px, undocumented**.

So sub-blocks render at 18, 20, OR 24 px depending on which component built them. A reader scrolling through chapter VI sees "Operations & analytics" (24 px) → "Active members" headline (sub-tile) → "Membership & waitlist" group (18 px) → "Course activity" group (18 px) → "Course utilization trend" (20 px). The hierarchy is not legible.

**Rank: Critical.** The squint test fails — sub-block weight does not correspond to sub-block role.

#### F7 — Briefing memo verdict at text-3xl is undefined-tier
[page.tsx:344](src/app/app/admin/reporting/monthly/page.tsx#L344):
```tsx
<h3 className={`mt-5 font-serif text-3xl leading-tight tracking-tight ${toneHeadlineClass(row.b.status)}`}>
```

The briefing memo's status verdict ("On plan", "Strong", "Watch") renders at `text-3xl` (30 px) with a tone-coloured class. This is the memo's hero element by design.

It sits at the same tier as the new SectionHeading (F5). Both work for hero impact, but neither is in the spec.

**Rank: Medium / spec gap.** Defensible if the spec adds an L3-hero tier; broken otherwise.

#### F8 — Cover "Period" subtitle has no defined level
[page.tsx:208](src/app/app/admin/reporting/monthly/page.tsx#L208):
```tsx
<div className="mt-6 font-serif text-3xl tracking-wide text-club-green-900/85 sm:text-4xl">
  {pkg.period.label}
</div>
```

The cover Period subtitle ("May 2026") renders at `text-3xl`–`text-4xl`. This is a 30–36 px serif title sitting between L1 (cover club name, 60 px) and L3 (section title, 24 px).

The spec has no documented "Cover subtitle" tier. The page repeatedly reaches into this between-L1-and-L3 gap (F5, F7, F8). **The spec is incomplete; the page is honestly trying to fill the gap.**

**Rank: High / spec gap.**

---

### L4 — Narrative headline (CFO's voice)

**Spec: `font-serif italic text-[15px] leading-relaxed text-club-green-900/85 max-w-[680px]`.**

**Conformant:**
- ExecutiveSummary headline [page.tsx:330](src/app/app/admin/reporting/monthly/page.tsx#L330)
- Stewardship lead [page.tsx:58](src/app/app/admin/reporting/monthly/page.tsx#L58)
- FinancialStatements lead [page.tsx:645](src/app/app/admin/reporting/monthly/page.tsx#L645)
- Operations lead [page.tsx:750](src/app/app/admin/reporting/monthly/page.tsx#L750)
- Payroll lead [page.tsx:932](src/app/app/admin/reporting/monthly/page.tsx#L932)
- F&B lead [page.tsx:1057](src/app/app/admin/reporting/monthly/page.tsx#L1057)

Six chapters carry the spec-conformant Level-4 framing paragraph. This is genuinely excellent — the CFO's voice is consistent across the major chapters.

**Failures:**

#### F9 — Board Briefing chapter has NO L4 framing paragraph
[BoardBriefing at page.tsx:372](src/app/app/admin/reporting/monthly/page.tsx#L372):
```tsx
<p className="mt-3 max-w-[680px] text-sm leading-relaxed text-club-green-900/75">
  The chair&rsquo;s briefing &mdash; what is on plan, what is healthy, what to watch.
  Each memo gives the headline first, the narrative second, and supporting numbers last.
</p>
```

The chapter II lead paragraph is `text-sm` (14 px) sans **non-italic** at opacity /75. The spec is unambiguous: *"This level is non-negotiable on any new reporting section. A section without a Level-4 framing paragraph reads as admin-page output, not as a board document."*

Chapter II — the very chapter the design system uses as its example of narrative-first — fails its own affordance.

**Rank: Critical.** This is the worst typography violation on the page given that the spec explicitly names it as non-negotiable.

#### F10 — StewardshipBlock description fails L4 similarly
[page.tsx:436](src/app/app/admin/reporting/monthly/page.tsx#L436):
```tsx
<p className="mt-3 max-w-[680px] text-sm leading-relaxed text-club-green-900/75">
  {description}
</p>
```

The descriptions under "Operating Stewardship" and "Capital Stewardship" subheads ("How management is running the operation against board-approved policy bands…" and "Balance-sheet strength, reserve discipline…") use the same non-italic sans `text-sm` treatment as F9.

**Rank: High.**

#### F11 — Briefing memo narrative is text-sm sans
[page.tsx:354](src/app/app/admin/reporting/monthly/page.tsx#L354):
```tsx
<p className="mt-4 text-sm leading-relaxed text-club-green-900/85">
  {row.b.narrative}
</p>
```

The body of each briefing memo ("Member rounds are running 6 % ahead of plan year-to-date…") is `text-sm` (14 px) sans. This is rich prose — the memo's narrative paragraph. It is neither L4 (no italic serif) nor L5 (above the 13 px ceiling).

This carries the design-system gap: **the spec has no defined level for short non-italic prose paragraphs**. They sit between L4 and L5 and the page is using an undefined "text-sm" tier.

**Rank: High / spec gap.**

#### F12 — BoardStatement notes use max-w-[760px] not L4's 680px
[page.tsx:1366](src/app/app/admin/reporting/monthly/page.tsx#L1366):
```tsx
<p className="mt-6 max-w-[760px] text-[13.5px] leading-relaxed text-club-green-900/85">
  {notes}
</p>
```

The plain-English notes paragraph in each board statement uses `text-[13.5px]` (L5-range) but at `max-w-[760px]` — 80 px wider than L4's controlled measure of 680 px.

Similarly, Executive Commentary rows render their `<dd>` body at `text-[13.5px] max-w-[760px]` ([page.tsx:1268](src/app/app/admin/reporting/monthly/page.tsx#L1268)).

**Rank: Medium.** Reading-column drift; not catastrophic at 80 px but breaks the spec's measure rule.

---

### L5 — Body copy

**Spec: sans `text-[13px]`–`text-[13.5px] leading-relaxed text-club-green-900/85` primary; `text-club-green-800/65` for captions. Tabular numbers `font-mono tabular-nums`.**

**Conformant:**
- Stewardship card `<dd>` for "What it is" / "Why it matters" — `text-[13px] leading-relaxed text-club-green-900/85` ✓ ([page.tsx:502](src/app/app/admin/reporting/monthly/page.tsx#L502))
- Executive Commentary `<dd>` — `text-[13.5px] leading-relaxed text-club-green-900/85` ✓ ([page.tsx:1268](src/app/app/admin/reporting/monthly/page.tsx#L1268))
- BoardStatement variance row label — `text-[13px] text-club-green-900/90` (close — opacity drift)

**Failures:**

#### F13 — KpiCardView context paragraph at text-[13px] but opacity /75
[page.tsx:1166](src/app/app/admin/reporting/monthly/page.tsx#L1166):
```tsx
<p className="mt-4 text-[13px] leading-relaxed text-club-green-900/75">
  {kpi.context}
</p>
```

The plain-English context line under each KPI tile is on-size but at `/75` opacity rather than spec's `/85`. The text reads visibly lighter than the stewardship card's "What it is" definition even though both are body prose.

**Rank: Medium.**

#### F14 — Footer "Prepared on" at text-club-green-800/55
[page.tsx:244](src/app/app/admin/reporting/monthly/page.tsx#L244):
```tsx
<div className="mt-16 text-[10px] uppercase tracking-[0.22em] text-club-green-800/55">
  Prepared on {preparedDate}
</div>
```

Cover footer metadata at opacity `/55` — three steps below the L2 spec's `/75` and L5 caption spec's `/65`.

**Rank: Low.**

---

### Cross-cutting findings

#### F15 — Opacity tiers proliferate from 3 named to 8 used
Across [monthly/page.tsx](src/app/app/admin/reporting/monthly/page.tsx), opacity suffixes on `text-club-green-*` colors appear **70 times** in **eight distinct tiers**: `/55`, `/60`, `/65`, `/70`, `/75`, `/80`, `/85`, `/90`.

The design system names exactly three: `/65` (captions), `/75` (L2 eyebrows), `/85` (L4 + L5 prose).

| Opacity | System purpose | Page also uses for |
|---|---|---|
| `/55` | — | Operations axis labels, cover "Prepared on" footer |
| `/60` | — | Stewardship dt labels, Executive Commentary dt labels, BoardSummaryCard comparison label |
| `/65` | L5 captions | SectionHeading eyebrow (post-polish), BoardStatement "Full statement detail" eyebrow, sparkline axis text, KpiCardView comparator label |
| `/70` | — | BoardSummaryCard label, OperatingMetric label, briefing supporting-metric label, BoardStatement variance eyebrow, Capital eyebrow |
| `/75` | L2 eyebrows | SectionHeading eyebrow (pre-polish), KpiCardView label, Stewardship card name, BoardStatement eyebrow, briefing eyebrow, OperatingHeadlineTile label, Executive Commentary eyebrow |
| `/80` | — | ChapterRail label, ToneChip neutral text |
| `/85` | L4 + L5 prose | Most rich prose |
| `/90` | — | BoardStatement variance row label, KpiCardView comparator value |

**Effect:** A "soft stair" of grey-greens pulls the reader's eye without intention. The page reads as carefully composed when viewed individually but inconsistent when compared scroll-to-scroll. Worst case (F14, F15 combined) the cover's "Prepared on" line is rendered five tiers lighter than the L2 spec.

**Rank: High.** Every chapter contributes.

#### F16 — font-medium / font-semibold appear despite the regular-weight rule
The spec is explicit: every level is **regular weight**; hierarchy is built from typeface, size, case, and color. Weight is reserved.

Actually appearing:
- `font-medium` × 6 — KpiCardView variance label ([page.tsx:1186](src/app/app/admin/reporting/monthly/page.tsx#L1186)), Stewardship assessment ([page.tsx:486](src/app/app/admin/reporting/monthly/page.tsx#L486)), OperatingHeadlineTile sub ([page.tsx:786](src/app/app/admin/reporting/monthly/page.tsx#L786)), OperatingMetric sub ([page.tsx:823](src/app/app/admin/reporting/monthly/page.tsx#L823)), BoardStatement variance ([page.tsx:1352](src/app/app/admin/reporting/monthly/page.tsx#L1352)), BoardSummaryCard variance ([page.tsx:1409](src/app/app/admin/reporting/monthly/page.tsx#L1409))
- `font-semibold` × 2 — briefing supporting-metric value ([page.tsx:377](src/app/app/admin/reporting/monthly/page.tsx#L377)), KpiCardView comparator value ([page.tsx:1179](src/app/app/admin/reporting/monthly/page.tsx#L1179))
- `font-semibold` once on StatementDetailTable total rows ([page.tsx:1435](src/app/app/admin/reporting/monthly/page.tsx#L1435)) — defensible for accounting totals

**Effect:** Tone-coloured `font-medium` labels next to neutral copy is the SaaS dashboard idiom. The spec wants the *color* to do the work, not the weight.

**Rank: High.** Easy to fix (drop the `font-medium`); changes feel materially in every chapter.

#### F17 — Tracking-[0.14em] is used on dense tabular columns but is undocumented
[StatementDetailTable thead at page.tsx:1425–1428](src/app/app/admin/reporting/monthly/page.tsx#L1425):
```tsx
<th className="px-1 py-2 text-left font-medium uppercase tracking-[0.14em]">Line</th>
```

Plus four occurrences on CapitalProjectsCard thead ([page.tsx:619–622](src/app/app/admin/reporting/monthly/page.tsx#L619)) and one on ArAgingDetailTable.

Tight column-header tracking is a legitimate typographic convention for dense tabular content; squeezing labels to `0.14em` keeps them from running into adjacent columns. But the design system doesn't name a "tabular-column eyebrow" tier.

**Rank: Low / spec gap.** Either codify `tracking-[0.14em]` as the table-column-header convention, or collapse to `0.22em` and accept tighter columns.

---

## Summary table

| ID | Finding | Level / Cross-cut | File:line | Rank |
|---|---|---|---|---|
| F1 | At-a-glance KPI hero numbers at `text-5xl` (L1 territory) | L1 | [page.tsx:1154](src/app/app/admin/reporting/monthly/page.tsx#L1154) | **Critical** |
| F2 | Smallcaps tracking split between `0.22em` / `0.18em` | L2 | many | High |
| F3 | Cover eyebrow at `tracking-[0.3em]` (undefined) | L2 | [page.tsx:188](src/app/app/admin/reporting/monthly/page.tsx#L188) | Low / spec gap |
| F4 | L2 color drift — 6 colors against spec's 2 | L2 | many | High |
| F5 | SectionHeading at `text-3xl` (spec says `text-2xl`) | L3 | [page.tsx:1098](src/app/app/admin/reporting/monthly/page.tsx#L1098) | High |
| F6 | Sub-block headers render at 18, 20, OR 24 px | L3 | [page.tsx:433, 799, 748, 1322](src/app/app/admin/reporting/monthly/page.tsx#L799) | **Critical** |
| F7 | Briefing verdict at `text-3xl` (undefined hero tier) | L3 | [page.tsx:344](src/app/app/admin/reporting/monthly/page.tsx#L344) | Medium / spec gap |
| F8 | Cover period subtitle at `text-3xl`–`text-4xl` (undefined) | L3 | [page.tsx:208](src/app/app/admin/reporting/monthly/page.tsx#L208) | High / spec gap |
| F9 | Board Briefing chapter lacks an L4 framing paragraph | L4 | [page.tsx:372](src/app/app/admin/reporting/monthly/page.tsx#L372) | **Critical** |
| F10 | StewardshipBlock descriptions fail L4 the same way | L4 | [page.tsx:436](src/app/app/admin/reporting/monthly/page.tsx#L436) | High |
| F11 | Briefing memo narrative is `text-sm` sans (undefined tier) | L4 / L5 | [page.tsx:354](src/app/app/admin/reporting/monthly/page.tsx#L354) | High / spec gap |
| F12 | BoardStatement notes at `max-w-[760px]` not 680 | L4 | [page.tsx:1366](src/app/app/admin/reporting/monthly/page.tsx#L1366) | Medium |
| F13 | KPI context paragraph at L5 size but `/75` opacity | L5 | [page.tsx:1166](src/app/app/admin/reporting/monthly/page.tsx#L1166) | Medium |
| F14 | Cover "Prepared on" at `/55` opacity | L5 | [page.tsx:244](src/app/app/admin/reporting/monthly/page.tsx#L244) | Low |
| F15 | Opacity tiers proliferate from 3 named to 8 used | cross-cut | 70 occurrences | High |
| F16 | `font-medium` / `font-semibold` against the regular-weight rule | cross-cut | 8 occurrences | High |
| F17 | `tracking-[0.14em]` undocumented tabular-column tier | cross-cut | StatementDetailTable, CapitalProjectsCard, ArAgingDetailTable | Low / spec gap |

---

## Open questions the founder should answer before remediation

This audit revealed three places where the **page is defensibly doing something the design system does not name**. The spec is incomplete, not just the page. Each needs a founder decision:

### Q1 — Hero KPI tier (between L1 and L3)
The page repeatedly uses `text-3xl`–`text-5xl` serif tabular-num for hero KPI moments (F1, F7, F8) and the spec only defines those sizes for cover-only use. Either:

- **(a) Amend the design system** to add an "L1b — Hero KPI / Cover subtitle" tier covering `text-3xl`–`text-5xl` serif tabular-nums, OR
- **(b) Collapse every hero KPI to L3** (`text-2xl`) so the hierarchy stays strict and the cover stays unique.

**Recommendation:** (a). The page's hero numbers are doing real narrative work; shrinking them to 24 px would weaken the squint test. The amendment should also tie the tier specifically to numbers + cover subtitle, so it cannot leak into card titles.

### Q2 — Sub-block sizes (text-lg vs text-xl vs text-2xl)
F6 is the most damaging finding. The fix needs one rule:

- **(a) Sub-block titles are always `text-xl`** (20 px) — collapses `OperatingMetricGroup` up from `text-lg` and `StewardshipBlock` / `BoardStatement` down from `text-2xl`, OR
- **(b) Two named sub-block tiers** — `text-2xl` for "named statement / pillar block" (StewardshipBlock, BoardStatement) and `text-xl` for "grouped metrics" (OperatingMetricGroup, sparkline titles).

**Recommendation:** (b). The two tiers reflect a real distinction — a financial statement is heavier than a grouped metric block.

### Q3 — Non-italic short prose tier (between L4 and L5)
F9, F10, F11 all use `text-sm` sans for short paragraphs that aren't quite the chapter's italic-serif framing. Either:

- **(a) Promote these to L4** (italic-serif `text-[15px]`) — most narrative-focused, but the briefing memo would have *two* italic-serif paragraphs (chapter lead + memo body), which may feel heavy, OR
- **(b) Collapse to L5** (`text-[13px]` sans `/85`) — works but the memo body and the stewardship `What it is` definition would read the same, blurring the distinction, OR
- **(c) Codify an L4.5 tier** — sans `text-sm` (14 px) `leading-relaxed` `text-club-green-900/85` for "structural prose that isn't italic-serif framing".

**Recommendation:** (a) for the Board Briefing chapter lead specifically (it must be the CFO's voice; nothing less qualifies). For the memo bodies — (c), codified as "Body prose – structural" so the page has a documented home.

---

## Recommended remediation order (after Q1–Q3 are answered)

If the founder authorizes a remediation pass:

1. **F9 (Critical)** — add an L4 italic-serif framing paragraph to Board Briefing. Reword the existing copy if needed.
2. **F6 (Critical)** — collapse sub-block titles to one rule per Q2 answer.
3. **F1 (Critical)** — resolve hero KPI tier per Q1 answer.
4. **F15 (High)** — consolidate opacity tiers to the three named in the spec (plus whatever is added by Q1–Q3 amendments). Mechanical find-and-replace.
5. **F16 (High)** — drop every `font-medium` and `font-semibold` outside of the StatementDetailTable totals. ~8 occurrences.
6. **F2 + F4 (High)** — consolidate smallcaps tracking to `0.22em` and L2 color to one of the two spec values. Mechanical pass.
7. **F5 (High)** — either collapse SectionHeading to `text-2xl` per spec, or amend spec to allow `text-3xl` chapter / `text-2xl` sub.
8. **F10, F11, F12, F13** — mop-up. Tied to whatever Q3 resolves.
9. **F3, F7, F8, F14, F17** — Low or spec-gap items. Codify in the design-system doc rather than chasing the page.

---

## What this audit is not

- This audit does not propose new typography. It only measures what is on the page against what the design system says.
- This audit does not assess content quality (whether the right things are being said) — that is the framework's job.
- This audit does not measure rendered pixel sizes in the browser. The squint test and DevTools measurement belong to the
  [`executive-reporting-design`](../.claude/skills/executive-reporting-design/SKILL.md) skill and should be run after any
  remediation pass.

---

## What to do with the spec-gap findings

The design system is a living document (see its own *When this design system is wrong* clause). Any finding ranked "**spec gap**" above is a flag that the spec is incomplete, not that the page is wrong. The Q1–Q3 answers will determine whether the spec is amended or the page is collapsed to fit it.

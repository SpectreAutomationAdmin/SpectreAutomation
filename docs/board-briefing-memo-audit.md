# Board Briefing — Memo-vs-Widget Audit

**Surface:** chapter II of `/app/admin/reporting/monthly` — the three
"Board Financial Briefing" cards.
**Audit date:** 2026-06-03
**Audited against:** the Spectre Framework's *executive briefing
document* premise and the Spectre Executive Reporting Design System's
*the report is the product; the application disappears* mandate.

> **No code changed.** This document is the source-of-truth list for
> a follow-up remediation. Each finding cites the file + line so the
> fix can be scoped tightly.

---

## What this audit is measuring

The chapter II cards are *named* "memos" — the chapter heading reads
**"Three memos for the Finance Committee"** and each card opens with
the smallcaps label **MEMO · OPERATIONS**. Yet they currently render
as three identical bordered widgets arranged in a 3-column grid, with
a tone-coloured top stripe and a labelled KPI table at the bottom.

The audit measures the gap between two reference forms:

| | Executive memorandum | SaaS dashboard widget |
|---|---|---|
| **Form** | A letter, written by one person, for a stated reader | A standardized cell in a grid of cells |
| **Header** | TO / FROM / DATE / RE | A status chip + a metric title |
| **Body** | Prose paragraphs, quoting numbers inline | A KPI list with extracted values |
| **Verdict** | Embedded in the prose | A status word, often colour-coded |
| **Footer** | Signature / sign-off | A row of right-aligned metric values |
| **Visual mass** | Letterhead → body → signature (top-heavy or balanced) | Uniformly grid-tiled |
| **Authorship** | Attributed to a person or role | Anonymous / system-generated |

Findings below are ranked by how clearly each element pulls the card
toward the right-hand column.

---

## Severity scale

| Rank | Definition |
|---|---|
| **Critical** | Defining feature of dashboard widgets that cannot exist on a real memo. The element by itself collapses the memo illusion. |
| **High** | Strong widget tell that no executive memo would contain, but the absence of which alone wouldn't fix the card. |
| **Medium** | Subtle widget pattern that compounds with the Critical/High findings. |
| **Low** | Defensible cosmetic choice; included for completeness. |

---

## Findings

### Critical

#### C1 — Three identical cards in a 3-column grid
[monthly/page.tsx:337](src/app/app/admin/reporting/monthly/page.tsx#L337):
```tsx
<div className="mt-7 grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-7">
```

The chapter renders three same-width, same-height memos side-by-side
in a 3-column grid. Real memorandums are *letters*; they exist
sequentially, one after another, each as long as its author needs.
A 3-column grid of memo-shaped cells is the Trello / Asana / Jira
visual idiom — the universal Kanban-card pattern.

**Why it is dashboard-tier:** uniform shape + uniform height +
parallel layout signal "these are three cells of the same template".
A board reader does not perceive three letters; they perceive a
status-tracker.

#### C2 — Top tone stripe (4 px coloured bar)
[monthly/page.tsx:345-350](src/app/app/admin/reporting/monthly/page.tsx#L345-L350):
```tsx
<div
  data-testid={`briefing-${row.key}-stripe`}
  className={`h-1 ${toneStripeClass(row.b.status)}`}
  aria-hidden="true"
/>
```

Each card opens with a 4-px coloured bar at the very top —
`bg-club-green-700` for "On plan", `bg-amber-500` for "Watch", etc.

This stripe is the *defining* visual element of project-management
card chrome (Trello/Linear/Asana cards all use it). No printed memo
has ever had a colour-coded title-bar stripe.

**Why it is dashboard-tier:** the stripe exists to give the card a
status colour visible at scrolling distance — a workflow affordance.
A memo's status is not communicated by a colour band; it is
communicated by the writing.

#### C3 — Status word used as the headline
[monthly/page.tsx:365-370](src/app/app/admin/reporting/monthly/page.tsx#L365-L370):
```tsx
<h3
  data-testid={`briefing-${row.key}-status`}
  className={`mt-5 font-serif text-4xl leading-tight tracking-tight ${toneHeadlineClass(row.b.status)}`}
>
  {row.b.statusLabel}
</h3>
```

The card's largest serif element renders the *status* — "On plan",
"Strong", "Watch" — at `text-4xl` (36 px) in a tone-coloured serif.

This is a status badge inflated to typography. A real memo headline
would be a *subject line* — a phrase or sentence that names the
topic, e.g. *"Operations: on plan through period eleven"* or
*"Capital program: HVAC replacement deferred to FY27 quotes"*. The
single tone-coloured word is the same content a Kanban card carries
in its top-right corner badge, only enlarged.

**Why it is dashboard-tier:** the headline tells the reader the
*status* before it tells them the *subject*. A memo announces its
subject first; the reader infers the status from the prose. Leading
with a coloured status word is the workflow-tool reflex.

#### C4 — "Key data points" divider + 3-row KPI table at the bottom
[monthly/page.tsx:385-416](src/app/app/admin/reporting/monthly/page.tsx#L385-L416):
```tsx
<div className="mt-7 flex items-center gap-3">
  <span className="h-px flex-1 bg-club-sand" aria-hidden="true" />
  <span className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/55">
    Key data points
  </span>
  <span className="h-px flex-1 bg-club-sand" aria-hidden="true" />
</div>
<dl className="mt-4 divide-y divide-club-sand/70">
  {row.b.chips.map((c, i) => (
    <div ...>
      <dt className="text-[10px] uppercase tracking-[0.22em] ...">{c.label}</dt>
      <dd className="font-mono text-base tabular-nums ...">{c.value}</dd>
      {c.subtitle && <div>{c.subtitle}</div>}
    </div>
  ))}
</dl>
```

The bottom half of every card is a KPI table — three rows of
`label / value / subtitle` with right-aligned monospace numbers,
divided by hairlines, introduced by a `KEY DATA POINTS` smallcaps
banner with horizontal rules either side.

**This is the single most damning element on the card.** A memo
quotes its numbers *inside* the prose ("Member rounds are running
6.0 % ahead of plan year-to-date; F&B covers are tracking just
behind plan but average check is up 4.1 %, holding total F&B
revenue at budget"). Extracting the same numbers into a
`label / value / subtitle` dl with right-aligned mono values is the
SaaS dashboard reflex — *make the metrics scannable in a sidebar*.

No memo extracts its numbers into a footer KPI table. The current
treatment carries the prose narrative *and* the KPI table, which
reads as "memo above, dashboard widget below stapled together".

---

### High

#### H1 — "MEMO · OPERATIONS" smallcaps eyebrow as the card opener
[monthly/page.tsx:354-359](src/app/app/admin/reporting/monthly/page.tsx#L354-L359):
```tsx
<div className="text-[10px] uppercase tracking-[0.22em] text-club-green-800/75">
  Memo &middot; {row.title}
</div>
```

The card opens with a smallcaps eyebrow that literally says
"MEMO · OPERATIONS". A real memo's opening fields are *TO*, *FROM*,
*DATE*, *RE* — the printed letterhead anatomy. A label that
*announces* "this is a memo" is the developer's invocation of memo,
not a memo itself.

**Why it lands at High:** the label is doing the job of a printed
header (RE: Operations) but in the wrong vocabulary. Compare:

```
MEMO · OPERATIONS               vs.    RE  Operations performance, May 2026
```

The first is admin-label chrome; the second is letterhead.

#### H2 — No FROM line / no author / no attribution
The chapter is named "Three memos for the Finance Committee" but the
memos are unsigned. There is no GM, no Controller, no Capital
Committee Chair attributed.

A memo is *from someone* — the attribution is part of how the reader
weights the content. Unsigned memos read as system-generated reports,
not as one person communicating with another. The current treatment
is anonymous by construction.

#### H3 — No DATE field
Memos have a date stamp. The cover names May 2026 as the reporting
period, but each individual memo card carries no date. A reader
extracting a single memo (printing it, screenshot, etc.) loses the
temporal context entirely.

#### H4 — Outer card border + uniform card height
[monthly/page.tsx:343](src/app/app/admin/reporting/monthly/page.tsx#L343):
```tsx
className="flex flex-col overflow-hidden rounded-lg border border-club-sand bg-white"
```

The card carries an outer hairline border on all four sides plus
`overflow-hidden` and `flex flex-col` so it stretches to grid-equal
height with its siblings. Real letters don't have four-sided borders
and don't conform to grid-equal heights — they end when the writer
stops writing.

The combination of border + `flex-1` (line 352) + grid layout (C1)
forces the three memos to occupy three same-sized rectangles even
when the operations memo has different content density than the
capital memo. The card frame *is* the visual container, not the
prose.

#### H5 — Tone-coloured headline plus tone-coloured stripe is redundant
The card carries the status twice: once as the top stripe (C2) and
once as the tone-coloured headline word (C3). Two redundant tone
signals on the same card is a dashboard reflex — *make the status
unmissable at scrolling distance*. A memo conveys status by writing,
not by repeating the colour cue.

---

### Medium

#### M1 — Smallcaps "KEY DATA POINTS" divider with horizontal rules
Part of C4's anatomy but worth naming separately:
[monthly/page.tsx:385-391](src/app/app/admin/reporting/monthly/page.tsx#L385-L391).

A smallcaps eyebrow flanked by two hairlines is the section-divider
pattern of every SaaS dashboard ever shipped. Even if the KPI dl
beneath it were removed, the divider itself reads as widget chrome.

#### M2 — Right-aligned font-mono values in the KPI dl
[monthly/page.tsx:405](src/app/app/admin/reporting/monthly/page.tsx#L405):
```tsx
<dd className="font-mono text-base tabular-nums text-club-green-900">
  {c.value}
</dd>
```

The KPI values are right-aligned `font-mono tabular-nums`. This is
correct typography *for a table column*. But putting a table column
inside what is supposed to be a memo is the underlying problem; the
font-mono right-alignment makes it visually unmistakable that the
bottom of the card is a small table.

#### M3 — Narrative is one paragraph
[monthly/page.tsx:375-380](src/app/app/admin/reporting/monthly/page.tsx#L375-L380):
```tsx
<p ...>
  {row.b.narrative}
</p>
```

The narrative renders as a single 60–80-word paragraph. Real memos
have at least an *opening claim → development → close* structure,
usually two or three short paragraphs.

The single-paragraph treatment makes the narrative read as a card
description (one-sentence summary) rather than as memo body.

#### M4 — No subject line / no RE: field
Building on H1 — even if the "MEMO · OPERATIONS" eyebrow were kept,
the card has no subject line that names what the memo is *about*.
The status word ("On plan") is doing the job of both subject and
verdict.

A memo's subject line is a sentence ("Operations performance,
period eleven of twelve"). A status word is a verdict. Conflating
them is part of why the card reads as a status panel.

#### M5 — No closing signature line / no sign-off
A memo's bottom is its sign-off — `— A. Martinez, COO`. The
current card ends in the KPI table footer. Even if the KPI table
(C4) were removed, the card would still end abruptly because there
is no signature line.

---

### Low

#### L1 — `data-tone` attribute on the article carries the verdict colour through CSS, not through prose
[monthly/page.tsx:342](src/app/app/admin/reporting/monthly/page.tsx#L342):
```tsx
data-tone={row.b.status}
```

The article advertises its tone via a `data-` attribute so styles can
hook off it. Defensible (used for the dot indicators on stewardship
cards too) but worth flagging: memos do not advertise their status as
a machine-readable attribute. This is a tell of the workflow-card
origin of the component.

#### L2 — `data-testid` ladder identifies card as `briefing-{key}-*`
The testid namespace renames the card as `briefing-{key}-stripe`,
`briefing-{key}-status`, `briefing-{key}-narrative`,
`briefing-{key}-metrics`, etc. The vocabulary of testids ("status",
"stripe", "metrics") is the dashboard-card vocabulary leaking into
the engineering surface. Cosmetic; not user-visible.

#### L3 — Lead paragraph says "Each memo gives the headline first, the narrative second, and the supporting numbers last"
[monthly/page.tsx:333-336](src/app/app/admin/reporting/monthly/page.tsx#L333-L336):
The chapter's L4 framing paragraph announces the anatomy of the
memo cards. A reader of a memo does not need the chapter to *explain*
what shape a memo will take. The explanation is the reflex of a
designer who knows the card is unusual and is over-compensating.

---

## Summary table

| ID | Element | Where | Rank |
|---|---|---|---|
| C1 | 3-column grid of identical-shape cards | [page.tsx:337](src/app/app/admin/reporting/monthly/page.tsx#L337) | **Critical** |
| C2 | 4-px coloured tone stripe at top of each card | [page.tsx:345-350](src/app/app/admin/reporting/monthly/page.tsx#L345-L350) | **Critical** |
| C3 | Status word ("On plan" / "Strong" / "Watch") used as the headline | [page.tsx:365-370](src/app/app/admin/reporting/monthly/page.tsx#L365-L370) | **Critical** |
| C4 | "Key data points" divider + 3-row KPI dl in the card footer | [page.tsx:385-416](src/app/app/admin/reporting/monthly/page.tsx#L385-L416) | **Critical** |
| H1 | "MEMO · {title}" smallcaps eyebrow announces the card type | [page.tsx:354-359](src/app/app/admin/reporting/monthly/page.tsx#L354-L359) | High |
| H2 | No FROM / no author / no attribution | data model + render | High |
| H3 | No DATE on each memo | data model + render | High |
| H4 | Outer card border + grid-equal height | [page.tsx:343, 352](src/app/app/admin/reporting/monthly/page.tsx#L343) | High |
| H5 | Tone signal applied twice (stripe + headline colour) | [page.tsx:345-370](src/app/app/admin/reporting/monthly/page.tsx#L345-L370) | High |
| M1 | Smallcaps "Key data points" divider with hairlines | [page.tsx:385-391](src/app/app/admin/reporting/monthly/page.tsx#L385-L391) | Medium |
| M2 | Right-aligned font-mono values in the KPI dl | [page.tsx:405](src/app/app/admin/reporting/monthly/page.tsx#L405) | Medium |
| M3 | Narrative is a single paragraph | [page.tsx:375-380](src/app/app/admin/reporting/monthly/page.tsx#L375-L380) | Medium |
| M4 | No subject line / no RE: field | data model + render | Medium |
| M5 | No closing signature line | data model + render | Medium |
| L1 | `data-tone` attribute advertises status | [page.tsx:342](src/app/app/admin/reporting/monthly/page.tsx#L342) | Low |
| L2 | testid vocabulary uses "stripe / status / metrics" | testid namespace | Low |
| L3 | Lead paragraph *explains* the memo anatomy | [page.tsx:333-336](src/app/app/admin/reporting/monthly/page.tsx#L333-L336) | Low |

---

## What is NOT broken (preserve on remediation)

These elements are correctly composed and should survive a memo
rebuild:

- The **chapter-level Executive Headline** ("Three memos for the
  Finance Committee" at L3 48 px serif) — section-opener typography
  is on-spec.
- The **L4 italic-serif framing paragraph** is present (audit F9 was
  resolved in the typography pass).
- **`DataSourceChip`** placement on each section is honest labelling.
- The **narrative content** itself — sentence quality is appropriate
  for executive prose; the writing reads like a CFO. The problem is
  the *frame*, not the words.
- The numbers in the data model are correct; the problem is the
  *presentation* of those numbers (extraction into a footer table
  rather than inline in prose).

---

## Why two of the findings (H2, H3, M4, M5) require data-model changes

Several findings — FROM line, DATE, subject line, signature — are
not just CSS edits. The current `pkg.boardBriefing.{operations,
financialHealth, capitalProgram}` shape has fields for
`statusLabel`, `narrative`, and `chips`, but no fields for `from`,
`date`, `subject`, or `signature`.

A memo-faithful rebuild would have to extend the type:

```ts
type MemoBlock = {
  from: string;       // "A. Martinez, General Manager"
  date: string;       // "May 31, 2026"
  re: string;         // "Operations performance, period eleven"
  body: string[];     // paragraphs, not a single string
  closing?: string;   // sign-off line
  // status / chips kept only if the rebuild keeps a verdict tier
}
```

The audit notes this so the founder can decide whether to:
- **(a)** rebuild the data model to support real memo anatomy, or
- **(b)** rebuild the visual treatment but synthesize FROM/DATE/RE
  from existing fields (e.g. derive RE from `statusLabel`,
  hard-code FROM to a club role per section), or
- **(c)** accept that the cards are status-panels and rename the
  chapter — "Three briefings" rather than "Three memos" — so the
  language no longer over-promises.

Option (c) is the smallest change but the largest concession. It
admits the section is not a memorandum and gives up the framing.

---

## What this audit is not

- This audit does not propose a redesign. It only names the elements
  pulling the cards toward the dashboard-widget pole.
- This audit does not assess the *content quality* of the briefings.
  The narrative writing is good; the problem is the frame.
- This audit does not measure pixel rendering — the
  [`executive-reporting-design`](../.claude/skills/executive-reporting-design/SKILL.md)
  skill's squint test and DevTools measurement belong to a separate
  pass.

---

## When this audit is wrong

If the founder reads the audit and decides the current treatment is
*correct as a briefing-panel*, the path forward is to rename chapter
II (option (c) above) and update the Spectre Framework to recognize
"briefing panel" as a documented chapter form. The audit exists to
expose the gap between the *name* ("memos") and the *form*
(dashboard widgets); resolving the gap by amending either side is
acceptable.

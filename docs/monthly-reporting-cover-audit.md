# Monthly Reporting — Cover Page Audit

**Surface:** the opening section (chapter I — Executive Opening) of
`/app/admin/reporting/monthly`. Implementation in
[`PackageHeader` at src/app/app/admin/reporting/monthly/page.tsx:181-272](src/app/app/admin/reporting/monthly/page.tsx#L181-L272).
**Audit date:** 2026-06-03
**Compared against:** the Saguaro-style executive board package
reference — the family of editorial covers used by high-end private
club annual reports, KPMG / Deloitte board packages, and Town-&-Country-class
periodical covers.

> **No code changed.** This document lists every cover element
> currently rendered, compares it against report-cover anatomy, and
> identifies what prevents the opening from reading as a *cover page*
> rather than a *centered hero block*.

---

## What a board-package cover page contains

A printed report cover is **not** a single centered hero column. It
is a three-register publication layout — masthead at top, hero zone
in the middle, colophon at the bottom — separated by typographic and
spatial rhythm.

### Top register — masthead

- Issuer mark (who is publishing the report, e.g. *"Office of the
  Controller"*, *"Silver Springs Golf & Country Club"*)
- Document type / series name (*"Monthly Reporting Package"*)
- Edition / volume / issue mark (*"Vol. III · No. 11"*)
- Sometimes a confidentiality stamp (*"For Committee distribution only"*)
- Usually a horizontal rule beneath that defines the band

### Hero zone — title

- Series subject (the club / period being reported on)
- Subtitle (the period or focus)
- Sometimes a brief epigraph or motto in italic serif

### Bottom register — colophon

- *"Prepared for / by"* block
- Date stamp
- Preparer attribution
- Distribution / contact line
- A printer's ornament or small editorial mark that signs the cover off
- Often a club crest or organizational seal

The three registers are visually distinct — each anchored to its
position (top / center / bottom of the page), not stacked in a
floating column. The reader's eye lands on the hero first, but the
masthead and colophon frame the page as a *cover*, not a marketing
splash.

---

## What the current cover delivers

The cover renders nine elements stacked in **one centered column**
from the vertical middle of the viewport ([page.tsx:188-269](src/app/app/admin/reporting/monthly/page.tsx#L188-L269)):

1. **Document type label** *"MONTHLY REPORTING PACKAGE"* — smallcaps, centered, mid-column
2. **Thin gold rule** — 64 px wide, centered, beneath the type label
3. **Club name** — *"Silver Springs Golf & Country Club"* at 72 px serif, centered
4. **Period** — *"May 2026"* at 48 px serif, centered
5. **FY context** — *"FY2026 (JUL-JUN) · PERIOD ELEVEN OF TWELVE"* in smallcaps, centered
6. **Aldus-leaf ornament** — between hair rules, centered, mid-column
7. **"Prepared for"** smallcaps label
8. **"The Finance Committee"** — 24 px serif, centered
9. **"Board of Directors"** — italic serif sub-line, centered
10. **"Prepared on May 31, 2026"** — smallcaps at /45 opacity, centered

All ten elements share the same centered axis. The cover panel is
`min-h-[78vh] max-w-[760px]` with `items-center justify-center`, so
the entire stack lives in the **vertical center** of the viewport —
the masthead and colophon registers do not exist as separate spatial
zones.

---

## Severity scale

| Rank | Definition |
|---|---|
| **Critical** | Defining feature of a report cover that the page does not render at all. The opening cannot read as a *cover* without this. |
| **High** | Strong report-cover convention the page omits or weakens. Each High finding moves the page from "cover" toward "splash". |
| **Medium** | Editorial nuance that compounds with Critical/High. |
| **Low** | Defensible micro-choice; documented for completeness. |

---

## Findings

### Critical

#### C1 — No three-register cover architecture

[page.tsx:188-191](src/app/app/admin/reporting/monthly/page.tsx#L188-L191):
```tsx
<div
  data-testid="monthly-cover"
  className="mx-auto flex min-h-[78vh] max-w-[760px] flex-col items-center justify-center px-6 py-20 text-center"
>
```

The cover is a single `flex flex-col items-center justify-center`
column that floats in the vertical middle of the viewport. There is
no top band, no middle zone, no bottom colophon — the masthead
elements ("Monthly Reporting Package" label), the hero (club name +
period), and the colophon elements (prepared-for, date) are all
stacked on the same axis and drift together.

A real report cover uses **`flex flex-col justify-between`** (or a
3-row grid) so the masthead anchors to the top, the hero zone holds
the middle, and the colophon anchors to the bottom. The cover panel
itself takes 78 vh of viewport height; the current layout wastes
that vertical real estate by clumping everything in the middle and
leaving large empty zones above and below the cluster.

**Why this prevents "cover" feel:** the reader perceives a *centered
title card* (akin to a slide deck title slide), not a *publication
cover*. There is no top-of-page anatomy and no bottom-of-page
anatomy; just a floating hero. Magazine covers, board pack covers,
annual report covers — none of them work this way.

**Rank: Critical.** This is the single largest gap. Every other
finding compounds on top of this one.

---

#### C2 — No masthead band at the top of the cover

The "Monthly Reporting Package" label is the document-type designator
([page.tsx:193-198](src/app/app/admin/reporting/monthly/page.tsx#L193-L198)):

```tsx
<div
  data-testid="monthly-cover-package-label"
  className="text-[10px] uppercase tracking-[0.3em] text-club-gold"
>
  Monthly Reporting Package
</div>
```

On a report cover the document-type designator sits in a **masthead
band at the top of the page**, often with a horizontal rule beneath
that defines the band. It identifies what the reader is holding —
"this is the Monthly Reporting Package, an instrument of the
controller's office, vol III, no 11".

The current treatment renders this label as a centered text element
in the middle of the viewport, with no horizontal rule, no edition
mark, no issuer, and no anchoring to the top of the cover panel. It
reads as a *subtitle eyebrow* over the hero, not as a *masthead*.

**Why this prevents "cover" feel:** without a masthead band, the
cover does not announce itself as a *published instrument*. It looks
like a hero text block, not a document.

**Rank: Critical.**

---

#### C3 — No bottom colophon band

The colophon — *"Prepared for / The Finance Committee / Board of
Governors / Prepared on May 31 2026"* — currently sits centered in
the lower portion of the column with no horizontal rule, no flush
alignment, no spatial separation from the hero zone above it
([page.tsx:246-267](src/app/app/admin/reporting/monthly/page.tsx#L246-L267)).

The "Prepared on" date is at `text-club-green-800/45` opacity (the
quietest text on the page) — so quiet it visually drops out
([page.tsx:263](src/app/app/admin/reporting/monthly/page.tsx#L263)).

A real report cover has a **bottom band**, often flush-left or
divided into two columns (preparer attribution on the left, date on
the right), separated from the hero zone by a horizontal rule or
significant whitespace.

**Why this prevents "cover" feel:** the colophon is part of the
publication anatomy — it tells the reader *who* prepared the
document and *when*. Centered in a floating column with low-opacity
text, it reads as "small print" rather than "publication colophon".

**Rank: Critical.**

---

### High

#### H1 — No issuer mark

A report's masthead names the issuer. Examples:

> **OFFICE OF THE CONTROLLER**
> *Silver Springs Golf & Country Club*

> **PREPARED BY MANAGEMENT**
> *Reviewed by the Finance Committee*

The current cover has no issuer mark at all. The reader is told
*what* the document is ("Monthly Reporting Package") and *for whom*
it was prepared ("The Finance Committee"), but not *who* produced
it. A board reader receiving the package wants to know whether
they're reading the General Manager's report, the Controller's
report, or a committee-aggregated report — that determines how to
weight the contents.

**Rank: High.** A real cover never omits authorship.

#### H2 — No edition / volume / issue mark

The cover identifies "PERIOD ELEVEN OF TWELVE" inline with the FY
context line ([page.tsx:233](src/app/app/admin/reporting/monthly/page.tsx#L233)).
But "period eleven of twelve" is a *progress indicator*, not an
*edition mark*. A real publication cover carries an edition mark
that anchors the document in the series:

> **VOL. III · NO. 11**

This is the kind of mark that goes in the **top-right** of the
masthead band (opposite the issuer mark in the top-left), and it
gives the document its identity as one issue of a continuing series.

The current cover doesn't have a volume / issue / edition mark
anywhere. The Monthly Reporting Package is by definition a *series*
(the same document, issued monthly), so the absence of a series
indicator is a real editorial gap.

**Rank: High.**

#### H3 — No confidentiality / distribution mark

Board packages carry a confidentiality or distribution stamp,
typically in the masthead or as a small note in the colophon:

> **CONFIDENTIAL — For distribution to the Finance Committee only**

Without this, the document doesn't signal the trust level of its
contents. A Committee member receiving the package should be able to
tell at a glance that it is not meant for general circulation.

**Rank: High.** Standard convention on every board pack.

#### H4 — Aldus-leaf ornament is misplaced

The ornament sits *between* the FY context and the prepared-for
block ([page.tsx:236-241](src/app/app/admin/reporting/monthly/page.tsx#L236-L241)),
interrupting the cover anatomy instead of punctuating it.

A report cover ornament typically appears in one of two positions:

- **At the very bottom** of the colophon as a closing device (the
  printer's mark / sign-off)
- **Below the masthead band** as a separator between masthead and
  hero zone

Mid-cover between context lines, it reads as decoration rather than
as a structural element. (The chapter ornaments added in the
previous pass play this role correctly *between* chapters — but on
the cover, the device should mark the cover's own anatomy, not the
chapter transitions.)

**Rank: High.**

#### H5 — No club crest / organizational seal

Private clubs always carry a crest. So do banks, law firms,
universities, every issuer of a formal document. The cover currently
has no visual mark identifying the club beyond the typeset name. The
shell header carries the club name in smallcaps but not a crest.

A real club's cover would have a single-color shield or seal mark in
muted gold or deep green, typically in the **top-center** of the
masthead band or in the **bottom-center** of the colophon as a
closing seal.

**Rank: High.** This is what makes a private-club document feel
private-club, not just editorial.

---

### Medium

#### M1 — Period is spelled out where numerical would read more like an edition mark

[page.tsx:233](src/app/app/admin/reporting/monthly/page.tsx#L233):
```tsx
{pkg.period.fiscalYearLabel} · Period {ordinalWord(pkg.period.ytdMonthsElapsed)} of Twelve
```

Renders as *"FY2026 (JUL-JUN) · PERIOD ELEVEN OF TWELVE"*. Spelled-out
ordinals work in narrative prose; on a publication cover, the
edition mark traditionally uses numerals + a Latin abbreviation:

> **Vol. FY2026 · No. 11**

This is also tighter visually (fits the smallcaps tracking better)
and aligns with the convention of the chapter rail's roman numerals
(I–X) — the cover would speak the same series-mark language.

**Rank: Medium.**

#### M2 — "Prepared on" at `/45` opacity is too quiet for a cover colophon

[page.tsx:263](src/app/app/admin/reporting/monthly/page.tsx#L263):
```tsx
className="mt-16 text-[10px] uppercase tracking-[0.22em] text-club-green-800/45"
```

The prepared-on date drops to `/45` opacity (the quietest text on
the page) so it sits as background metadata. But on a report cover,
the preparation date is **part of the colophon** — it should be
legible enough that someone glancing at the cover can read the date
without leaning in. `/75` would be more typical of a cover colophon
(matches the L2 eyebrow standard); `/85` if the colophon block is
intended as a full register.

**Rank: Medium.**

#### M3 — No page count / no table-of-contents reference on the cover

A bound deliverable's cover often notes its scope:

> **80 pages · 10 chapters · Distributed in print and PDF**

The package has 10 chapters (visible in the chapter rail) but the
cover does not name that scope. A reader holding the package wants
to know how thick the document is before they open it.

**Rank: Medium.**

#### M4 — No "Reporting Period" header anywhere on the cover

The cover names "May 2026" as a 48-px serif element but does not
label it as the *reporting period*. A reader who is unfamiliar with
the series convention would not necessarily know what the date
represents (is May 2026 when the document was issued? when it
covers? both?). A real cover would carry an explicit "Reporting
Period: May 2026" or "Period Ending: May 31, 2026" line either as
an eyebrow above the date or as a separate colophon line.

**Rank: Medium.**

---

### Low

#### L1 — No textured paper feel beyond `bg-club-cream`

The cream background is `#f8f5ef` — a uniform color fill, no
texture. A premium cover often uses a subtle paper texture (a CSS
noise / grain pattern, or a faint linen weave) to suggest paper
weight. This is a stylistic choice rather than a structural one;
defensible at "no" but mentioned for completeness.

**Rank: Low.**

#### L2 — No printer's mark / no editorial mark at bottom

A traditional cover ends with the printer's mark (a small device
indicating publisher / typographer / printer). Modern editions skip
this, so the absence is defensible — but if the founder wants a
maximally heritage feel, a small "Spectre · Office of the
Controller" mark in the bottom colophon would land it.

**Rank: Low.**

---

## Summary table

| ID | Element | Where (or absent) | Rank |
|---|---|---|---|
| C1 | No three-register architecture (top / middle / bottom) | [page.tsx:190](src/app/app/admin/reporting/monthly/page.tsx#L190) — `justify-center` collapses all three registers into a centered column | **Critical** |
| C2 | No masthead band at top — document type sits mid-column | [page.tsx:193-198](src/app/app/admin/reporting/monthly/page.tsx#L193-L198) | **Critical** |
| C3 | No bottom colophon band — prepared-for + date sit centered, low opacity | [page.tsx:246-267](src/app/app/admin/reporting/monthly/page.tsx#L246-L267) | **Critical** |
| H1 | No issuer mark — document does not name its author/preparer office | absent | High |
| H2 | No edition / volume / issue mark — series anchor is missing | absent | High |
| H3 | No confidentiality / distribution stamp | absent | High |
| H4 | Aldus-leaf ornament mid-anatomy instead of closing the cover | [page.tsx:236-241](src/app/app/admin/reporting/monthly/page.tsx#L236-L241) | High |
| H5 | No club crest / organizational seal anywhere | absent | High |
| M1 | "Period eleven of twelve" spelled out where numerical would land as edition mark | [page.tsx:233](src/app/app/admin/reporting/monthly/page.tsx#L233) | Medium |
| M2 | "Prepared on" at `/45` opacity — too quiet for a cover colophon | [page.tsx:263](src/app/app/admin/reporting/monthly/page.tsx#L263) | Medium |
| M3 | No page count / chapter count on the cover | absent | Medium |
| M4 | No explicit "Reporting Period" label on the date | absent | Medium |
| L1 | No paper texture beyond uniform cream | [page.tsx:190 (background)](src/app/app/admin/reporting/monthly/page.tsx#L190) | Low |
| L2 | No printer's mark / colophon attribution | absent | Low |

---

## Proposed replacement anatomy

If remediation is authorized, the cover should be restructured into
three registers within the existing 78-vh panel:

### Top register — masthead band

A `border-b border-club-sand` band anchored to the top of the cover
panel, flush from left edge to right edge of the `max-w-[760px]`
column. Contents arranged in a 2-column flex:

- **Left column:** issuer mark — *"SILVER SPRINGS GOLF & COUNTRY CLUB"*
  smallcaps eyebrow above *"Office of the Controller"* in italic
  serif text-sm.
- **Right column:** edition mark — *"VOL. FY2026 · NO. 11"* in
  smallcaps, font-mono for the numerical components.
- **(Optional center)** a small club crest / seal in muted gold.

Below this band, a discreet *"Confidential — For Finance Committee
distribution"* line in italic-serif text-xs.

### Middle register — hero zone

The current hero block — club name at 72 px serif, period subtitle
at 48 px serif. Stays centered. Uses `flex-1` to claim the middle
vertical real estate.

### Bottom register — colophon

A second `border-t border-club-sand` band anchored to the bottom of
the cover panel. Contents in 2-column flex:

- **Left column:** *"PREPARED FOR"* eyebrow above *"The Finance
  Committee"* serif text-2xl above *"Board of Directors"* italic
  serif sub-line — same content as today, just flush left.
- **Right column:** *"REPORTING PERIOD"* eyebrow above *"May 31,
  2026"* serif text-base above *"10 chapters · ~80 pages"* italic
  serif sub-line.

Below the band, the aldus-leaf ornament centered as a closing
device, then the *"Prepared on {date}"* line at `/75` opacity.

### Visual rhythm

```
┌─────────────────────────────────────────────────────────┐
│ SILVER SPRINGS GOLF & COUNTRY CLUB    VOL. FY2026 · NO. 11│  ← masthead
│ Office of the Controller                                 │
│ ────────────────────────────────────────────────────── │
│ Confidential — For Finance Committee distribution         │
│                                                         │
│                                                         │
│                                                         │
│        Silver Springs Golf & Country Club              │  ← hero
│                                                         │
│                     May 2026                            │
│                                                         │
│                                                         │
│                                                         │
│ ────────────────────────────────────────────────────── │
│ PREPARED FOR              REPORTING PERIOD             │  ← colophon
│ The Finance Committee     May 31, 2026                  │
│ Board of Directors        10 chapters · ~80 pages       │
│                                                         │
│                          ✦                              │
│                                                         │
│         Prepared on May 31 2026                         │
└─────────────────────────────────────────────────────────┘
```

This is the anatomy of a publication cover. The masthead identifies
the document; the hero names its subject; the colophon names its
audience and scope; the ornament signs off.

---

## What this audit is not

- This audit does not prescribe a specific Saguaro typeface, color
  variant, or layout precisely — it identifies the structural
  conventions a Saguaro-class executive board package cover uses
  that the current opening section omits.
- This audit does not assess the cover *content quality* (whether
  the prepared-for text is correct, whether the date is right) — it
  measures form against the report-cover reference.
- This audit does not measure DevTools-level pixel rendering. The
  squint test + measurement responsibilities belong to the
  [`executive-reporting-design`](../.claude/skills/executive-reporting-design/SKILL.md)
  skill and should be run after remediation.

---

## When this audit is wrong

If the founder reads the audit and decides the current single-column
centered hero treatment is the desired aesthetic — for example,
because a more spare, modernist cover is preferred over the
classical three-register publication cover — then the audit's
Critical findings should be deliberately rejected and the design
system should add an explicit *"modernist hero cover"* variant
alongside the publication-cover variant. The gap exists; whether to
close it depends on whether the founder wants the document to read
as a *publication* or as a *title card*. The audit identifies which
direction the current cover sits and what would move it the other
way.

# Spectre First-Scroll Reporting Standard

**The non-negotiable rule for the first viewport of every executive
reporting surface in Spectre.**

This document sits **on top of**
[`docs/spectre-framework.md`](spectre-framework.md) (the five
stewardship pillars + four questions) and
[`docs/spectre-executive-reporting-design-system.md`](spectre-executive-reporting-design-system.md)
(the canonical typography, color, layout, and narrative system). Those
two documents govern *what* the report must answer and *how* it must
look and read. **This document governs what must be visible on the
first screen before the user scrolls.**

All three documents are required reading before any change to a
reporting surface.

---

## Applies to

- Monthly Board Reporting Package
- Finance Committee reporting
- Board dashboards
- Executive dashboards
- KPI dashboards
- Committee packages
- Future PDF / Excel board-package exports

If a surface is consumed by a Board member, a Finance Committee, or any
governance body, this standard applies.

---

## 1 · Purpose

Spectre reporting **must not begin with a ceremonial cover page that
contains only identity and period information.** A page whose first
viewport carries only the club name, the period, and a "Prepared for"
block fails the purpose of an executive briefing — it tells the reader
*what document this is* and *who it is for*, but nothing about the
Club's condition.

**The first viewport must function as an executive briefing.** It
must answer the same questions a Finance Chair would otherwise ask
in the first thirty seconds of the meeting.

A ceremonial cover is acceptable for a printed deliverable's first
page. It is **not** acceptable as a screen-first surface where every
moment the reader spends scrolling to find the headline is a moment
the reporting product has failed.

---

## 2 · Non-Negotiable First-Scroll Rule

> **A Board member must understand the Club's operating health,
> financial health, capital health, and required actions before the
> first scroll.**

Before the user scrolls, they must understand:

- **Operating health**
- **Financial health**
- **Capital health**
- **Required actions / board attention**

**If a reporting page does not answer those four questions before the
first scroll, it fails the Spectre reporting standard.**

This rule is non-negotiable. It applies to every reporting surface
covered by this standard, on every supported viewport, on every
deployment, without exception. A surface that violates this rule is
not finished and must not be marked complete.

---

## 3 · First-Scroll Required Content

Every executive reporting surface must, above the first scroll,
include at least the following:

### Operating Health
- revenue
- NOI or operating surplus
- dues-to-revenue
- payroll ratio or operating margin

### Financial Health
- working capital
- reserve coverage
- current ratio
- AR current %

### Capital Health
- active capital projects
- capital spend YTD
- reserve contributions
- project status / execution status

### Required Actions
The chapter or block must declare one of the four governance states
adopted across the package:

- **no action required**
- **monitor**
- **committee review recommended**
- **board decision required**

The four states are the same Board Consideration cascade defined in
[`docs/executive-narrative-style-guide.md`](executive-narrative-style-guide.md)
and rendered package-wide by the `BoardConsiderationChip` atom.

A surface may include more than the minimum content above the fold,
but it must never include less.

---

## 4 · Design Philosophy

The first screen **should feel like**:

- an **executive briefing**
- a **finance chair dashboard**
- a **CFO memo**
- a **board package opening page**

The first screen **must not feel like**:

- a blank cover page
- a generic SaaS dashboard
- a decorative title page
- a report table of contents

A "blank cover page" is the most common failure mode. A ceremonial
title block has its place, but it cannot occupy the screen alone. If
the first viewport contains only the club identity, the period, and
the prepared-for line, the surface fails this standard regardless of
how beautiful the typography is.

---

## 5 · Information Hierarchy

The first viewport must prioritize, in this order:

1. **status headlines** — the one- or two-word verdict per area
   (*On plan / Strong / Watch / Review*)
2. **key numbers** — the metrics named in §3 with their comparators
3. **concise interpretation** — one or two sentences per status block
   that explain what the number means
4. **board action status** — the required-action cascade per block
5. **package identity / branding** — club name, period, prepared-for

**Branding is important, but it must not consume the space needed
to explain the Club's condition.** This is the single most common
violation in practice: an attractive cover dominates the first
viewport and the briefing content gets pushed to the second screen.

The first viewport should be designed with branding and briefing
sharing the space — typically a left-column identity stack and a
right-column briefing area — never branding alone above the fold.

---

## 6 · Narrative Standard

Every first-scroll briefing card must include:

- **a status headline** — tone-coloured (green / amber / red /
  neutral) verdict with a status dot
- **one or two concise sentences** — the headline of the underlying
  memo or commentary; existing CFO-authored copy preferred over new
  scaffolding
- **2–4 supporting metrics** — the controllers' key numbers, with
  comparator and variance
- **a Board Consideration status** — the four-state cascade chip

Prose is not optional. A briefing card that shows numbers alone fails
the framework's *"reports must interpret data, not display data"* rule.
A briefing card that shows a status chip without the supporting metric
fails this standard.

---

## 7 · Anti-Patterns

The following are explicitly forbidden on any reporting first viewport:

- ❌ **First screen with only club name, period, and prepared-for text.**
  A ceremonial cover that occupies the full first viewport is the
  primary failure mode this standard exists to eliminate.
- ❌ **First screen dominated by software controls.** Toolbars, filter
  drawers, settings cogs, sort selectors, "Export" buttons, or any
  other application chrome that crowds the briefing content out of
  the first viewport.
- ❌ **Hiding key financial condition below the first scroll.** The
  metrics named in §3 belong above the fold. Pushing them to chapter
  III or later violates this standard, even if those chapters are
  excellent.
- ❌ **Requiring a Board member to read 12 sections to understand the
  month.** The briefing should be conclusive at the first viewport.
  Detailed chapters exist for the reader who wants the full memo —
  not as the only path to the headline.
- ❌ **Presenting numbers without interpretation.** A first-screen tile
  that reads *"$14.62M"* with no comparator, no variance, and no
  verdict fails the design system *"never print a raw number alone"*
  rule and fails this standard.

---

## 8 · Visual QA Requirement

Any future change to an executive reporting page must include a
Playwright screenshot at:

- **1440 × 900** (the board-room laptop viewport)
- **1280 × 800** if practical (secondary verification)

Before declaring the change complete, Claude must answer all four of
the following questions in writing:

- Can **operating health** be understood before scrolling?
- Can **financial health** be understood before scrolling?
- Can **capital health** be understood before scrolling?
- Are **required actions** visible before scrolling?

**If any answer is no, the design is not complete.** The screenshot
and the four-question audit must appear in the final summary for any
work that touches a covered surface.

Where possible, codify this requirement as a Playwright assertion (as
[`tests/e2e/cover-briefing.spec.ts`](../tests/e2e/cover-briefing.spec.ts)
does for the Monthly Reporting cover — it asserts every briefing
card's `getBoundingClientRect().bottom ≤ viewport.height + 4`).

---

## 9 · Relationship to Other Documents

There are now three layered standards governing reporting work in
Spectre. They **compose** — they do not compete. All three are
mandatory.

| Layer | Document | Governs | Question it answers |
|---|---|---|---|
| 1 | [`docs/spectre-framework.md`](spectre-framework.md) | The philosophy — five stewardship pillars + four questions | *What must the report answer?* |
| 2 | [`docs/spectre-executive-reporting-design-system.md`](spectre-executive-reporting-design-system.md) | The design system — typography, color, layout, narrative affordances | *How must the report look and read?* |
| **3** | **This document** | **The first-scroll executive briefing rule** | ***What must be visible before the user scrolls?*** |

The execution playbook (squint test, print test, delete-on-sight list,
review checklist) lives in
[`.claude/skills/executive-reporting-design/SKILL.md`](../.claude/skills/executive-reporting-design/SKILL.md).

This document **adds** the first-scroll executive briefing rule on
top of the framework and design system. It does not replace them. A
reporting surface that satisfies the framework and design system but
violates the first-scroll rule is incomplete; a reporting surface
that satisfies the first-scroll rule but violates the framework or
design system is also incomplete.

The order on any reporting change:
1. Open the framework (layer 1) — name the pillar(s) served, confirm
   the four questions will be answerable.
2. Open the design system (layer 2) — apply typography hierarchy,
   color palette, layout discipline, narrative affordances.
3. **Open this document (layer 3) — confirm the first viewport will
   answer the four first-scroll questions.**
4. Open the executive-reporting-design skill — run the squint test,
   print test, and review checklist.

Skipping any layer is a violation of the operating rules in CLAUDE.md.

---

## 10 · Required Claude Behavior

**Before modifying any reporting package, Claude Code must state, in
its plan or response:**

1. **Which four first-scroll questions the change supports.** Name
   them: operating health / financial health / capital health /
   required actions. Identify which question(s) the change is
   intended to advance.
2. **Whether the change improves or weakens first-scroll clarity.**
   A change that adds content above the fold without removing
   essential information improves clarity. A change that pushes
   essential information below the fold or replaces a briefing
   element with branding weakens clarity and must be flagged.
3. **Whether the first viewport remains board-ready** after the
   change. Run the four-question audit from §8 against the modified
   surface and report each answer.

**Final summaries for reporting work must:**

- Cite this document as a reviewed standard alongside the framework
  and the design system.
- Report the four-question audit from §8 with explicit yes / no
  answers and supporting evidence.
- Include the Playwright screenshot at 1440 × 900 (and 1280 × 800 if
  practical) so the founder can verify the first-scroll claim
  visually.
- If any of the four first-scroll questions answers no, the work is
  not complete and must be flagged as such rather than marked done.

Skipping any of these steps is a violation of the operating rules in
CLAUDE.md.

---

## 11 · Visual Variance Gate (Reference-Replication Tasks)

The first-scroll audit in §8 governs **what must be visible** on
the first viewport of a reporting surface. This section governs
**how closely Spectre must match a cited visual reference** before
a Saguaro-tier (or other reference-matched) page or section can be
marked complete.

This gate exists because subjective adjectives like *premium*,
*editorial*, *boardroom-quality*, *stewardship-focused*, and
*Saguaro-like* are conclusions, not evidence. They can be applied
to two screens that diverge on every measurable dimension. The
evidence is the variance table.

### 11.1 · Applies to

Any Monthly Board Reporting Package page or section that is being
visually matched to a cited reference. This includes — but is not
limited to — the Equity Value Over Time chart and the Operating
Results chart on the Chair's Dashboard (Section II).

### 11.2 · Procedure

1. **Capture both surfaces at the same viewport.** Default
   viewport is **1440 × 900**. Use Playwright. Save to
   `test-results/`.
2. **Run Playwright against the reference** (Saguaro page URL,
   reference HTML, or static screenshot rendered in a comparable
   container).
3. **Run Playwright against the Spectre implementation** at the
   target URL with a logged-in session.
4. **Measure both surfaces.** Use
   `getBoundingClientRect()` + `getComputedStyle()` to extract:
   - page width
   - content width
   - card width / card height
   - card padding (all four sides)
   - card border (width / colour / radius)
   - card background colour
   - chart width / chart height / chart-to-card height ratio
   - KPI ribbon height
   - typography per tier: font-size, font-family, font-weight,
     text-transform, colour, opacity, letter-spacing, line-height
   - spacing between sections (header → KPI ribbon → chart →
     commentary)
5. **Produce a variance table** with three columns: Dimension /
   Spectre / Saguaro. A four-column variant adds Δ (signed
   delta).
6. **Make only the changes required to reduce variance.** Do not
   add elements that are not in the reference (see *Reporting
   Design Anti-Invention Guardrails* in CLAUDE.md).
7. **Re-capture** Spectre after the changes.
8. **Re-compare** the updated Spectre screenshot against the
   reference.
9. **Document the remaining differences honestly.** State which
   are intentional (with reason) and which are unintentional
   (carried as defect).

### 11.3 · Required Written Closeout

Before marking the task complete, the final summary must state, in
writing:

- **Where Spectre matches the reference** (measurable parity —
  cite the matching dimensions).
- **Where Spectre still differs** (cite the magnitude of each
  delta — e.g. *"hero KPI is 16 px serif 400 vs Saguaro's 20.7 px
  serif 700 — Δ 4.7 px size + 300 weight"*).
- **Whether each remaining difference is intentional or
  unintentional.** Intentional differences require a one-line
  reason (e.g. *"deliberate single-hue palette per founder
  direction"*). Unintentional differences are defects.
- **Whether the implementation should stop or continue.** Stop
  when variance is at the smallest defensible delta given the
  founder's explicit direction. Continue when there are
  unintentional deltas that have not been addressed.

### 11.4 · What this gate forbids

- Marking work complete based on subjective adjectives alone.
- Marking work complete based only on a passing source-contract
  test suite (source-contract confirms code shape, not visual
  parity).
- Adding visual elements not present in the reference, on the
  grounds that they "communicate the verdict more clearly". That
  is design invention; this rule requires replication first.
- Re-touching the Equity Value Over Time chart or Operating
  Results chart on the Chair's Dashboard (Section II) without
  running this gate first.

### 11.5 · Reference implementation of the gate

The measurement tooling already exists. The Playwright spec at
[`tests/e2e/measurement-audit.spec.ts`](../tests/e2e/measurement-audit.spec.ts)
captures both Saguaro and Spectre surfaces, extracts DOM geometry +
typography via `getBoundingClientRect()` + `getComputedStyle()`,
and writes machine-readable JSON to `test-results/`. The Node
summariser at
[`scripts/summarize-audit.mjs`](../scripts/summarize-audit.mjs)
collapses the JSONs into the variance table.

The output of this tooling is exactly the artefact §11.3 requires.

Future reporting-design work should extend `measurement-audit.spec.ts`
with the specific reference + Spectre selectors for the surface
being matched, then run the summariser, then write the variance
table into the final summary.

---

## Reference implementation

The Monthly Board Reporting Package cover at
[`/app/admin/reporting/monthly`](../src/app/app/admin/reporting/monthly/page.tsx)
is the reference implementation of this standard. Its `PackageHeader`
component renders a two-column first viewport:

- **Left column** — identity stack (club name at trimmed L1 size,
  period, FY context, committee, prepared date, framework colophon)
- **Right column** — Executive Briefing area with three medium-density
  cards (Operations / Financial Health / Capital Program), each
  carrying status headline + concise narrative + 2-row mini KPI dl +
  Board Consideration chip, plus a subtle *"Read full memos →"*
  anchor to the full Board Briefing chapter

The Playwright spec at
[`tests/e2e/cover-briefing.spec.ts`](../tests/e2e/cover-briefing.spec.ts)
codifies the first-scroll requirement as an automated assertion.

Future reporting surfaces (board dashboards, KPI dashboards, committee
packages, PDF / Excel exports) should mirror this pattern unless an
explicit exception is documented and signed off.

---

## When this standard is wrong

This is a living document. If a reporting requirement genuinely cannot
satisfy the first-scroll rule on a particular viewport (e.g. a
single-screen mobile briefing where four areas cannot all fit), do not
force-fit it. Flag the gap to the user and ask whether (a) the
viewport constraint warrants an explicit, documented exception, or
(b) the standard needs an amendment. The standard exists to give
reporting work a shared first-impression discipline; it does not exist
to constrain honest design needs that the founder identifies later.

Until such an amendment is made, the rule in §2 holds.

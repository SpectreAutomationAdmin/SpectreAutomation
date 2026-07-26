# The Spectre Framework

**Foundational reporting philosophy for Spectre Automation.**

This document governs the design and content of every reporting
surface in Spectre: dashboards, board packages, KPI cards,
committee reports, executive summaries, analytics modules,
finance pages, membership pages, hospitality pages.

It is required reading before any change is made to any of the
above. The companion design execution guide
([`.claude/skills/executive-reporting-design/SKILL.md`](../.claude/skills/executive-reporting-design/SKILL.md))
governs *how* the work looks; this document governs *what the work
must answer*.

---

## What Spectre Is

Spectre is **not** a generic SaaS dashboard.

Spectre is:

- a **private club operating system**
- a **controller-grade financial platform**
- a **board governance platform**
- an **executive decision-making platform**
- a **stewardship reporting platform**

Every reporting screen exists to support one or more of those
roles. If a screen does not, it does not belong.

---

## The Four Questions

Every reporting screen in Spectre must answer:

1. **What happened?**
2. **Why does it matter?**
3. **Is the trend improving or deteriorating?**
4. **Does the Board need to take action?**

If a screen displays data but does not answer the four questions,
it is incomplete.

**Reports must not simply display data. Reports must interpret data.**

That distinction is the difference between a SaaS dashboard and a
controller-grade reporting platform. A SaaS dashboard shows you
a number and stops. A controller-grade report tells you what the
number means, where it is heading, and what to do about it.

---

## The Five Pillars

The framework is organized around five stewardship pillars. Every
reporting module must serve at least one. Most serve more than one.
Before any reporting change, name which pillar(s) the change
advances.

### Pillar 1 — Operating Stewardship

> *Can the Club sustainably fund and operate itself?*

**Focus areas:**
- operating performance
- dues dependency
- payroll efficiency
- F&B subsidy
- cash generation
- member receivables

**Example metrics:**
- Dues-to-Revenue Ratio
- Payroll Ratio
- NOI %
- F&B Subsidy %
- Current AR %
- Cash Coverage

**Every metric must include:**
- actual
- benchmark (budget / policy band / peer median)
- status (green / amber / red)
- interpretation (one-line plain-English verdict)

---

### Pillar 2 — Capital Stewardship

> *Is the Club responsibly reinvesting in its facilities?*

**Focus areas:**
- reserve funding
- capital reinvestment
- reserve study compliance
- project execution
- infrastructure sustainability

**Example metrics:**
- Reserve Coverage
- Capital Spend vs Depreciation
- Capital Fund Balance
- Capital Income
- Reserve Study Compliance
- Net Available Capital

**Every metric must answer:**
- are we investing enough?
- are we investing too little?
- is future infrastructure at risk?

---

### Pillar 3 — Balance Sheet Stewardship

> *How resilient is the Club financially?*

**Focus areas:**
- liquidity
- leverage
- solvency
- working capital
- member equity

**Example metrics:**
- Working Capital
- Current Ratio
- Debt-to-Equity
- Equity-to-Assets
- Cash Reserves
- Liquidity Coverage

**Reports should explain risk, not merely display balances.**
A balance sheet line item without an interpretation is a number.
A balance sheet line item with "this is the cushion the club has
before drawing on the line of credit" is governance.

---

### Pillar 4 — Membership Stewardship

> *Is membership healthy and sustainable?*

**Focus areas:**
- growth
- retention
- attrition
- waitlist strength
- entrance fee health
- member value

**Example metrics:**
- Active Members
- Net Member Growth
- Attrition Rate
- Waitlist Size
- Entrance Fee Revenue
- Average Member Tenure

**Reports should identify long-term membership trends.**
A single-month snapshot is rarely actionable; a twelve-month trend
with seasonality framing is.

---

### Pillar 5 — Experience Stewardship

> *Are members receiving value from the Club?*

**Focus areas:**
- golf utilization
- hospitality utilization
- satisfaction
- engagement
- spending patterns

**Example metrics:**
- Rounds Played
- Covers Served
- Average Check
- Spend Per Member
- Satisfaction Scores
- Utilization %

**Reports should connect operational activity to member experience.**
A revenue number disconnected from rounds played and average check
is incomplete. Pillar 5 reports always tie *what members did* to
*what the Club earned*.

---

## Reporting Standards

Every reporting module must:

- **prioritize narrative before tables**
- **prioritize interpretation before detail**
- **surface exceptions** — variances, watch items, escalations
- **identify trends** — twelve-month context wherever possible
- **identify risks** — what could go wrong next
- **identify opportunities** — what could improve next

### Bad example

> Revenue = $5,000,000

### Good example

> Revenue of $5,000,000 is 4.2% ahead of budget driven by stronger
> member spending and increased golf utilization.

The number is identical; the second version answers *what happened*,
*why it matters*, and (with one more sentence) *is the trend
improving*. The first is admin-page output. The second is what
the Finance Chair reads before the meeting.

---

## Board Package Standards

Board packages must feel:

- **executive**
- **expensive**
- **polished**
- **governance-focused**
- **private-club specific**

Board packages must **not** feel:

- transactional
- administrative
- generic SaaS
- database-driven

**The report itself should be the product. The software should
disappear.**

A board member receiving the package should perceive a document
prepared by their CFO and management team. They should not perceive
"a screen from a SaaS tool". When the chrome of the application is
louder than the content of the report, the framework has been
violated.

---

## Spectre Design Philosophy

Reporting pages should feel closer to:

- a **Deloitte board package**
- a **KPMG committee report**
- a **private club annual report**

than to:

- a CRM dashboard
- an ERP screen
- a data table

**Whitespace is intentional.**
Generous spacing is not waste. It is the difference between
"document" and "interface".

**Typography creates hierarchy.**
Serif headlines, smallcaps eyebrows, tabular-figure number columns,
italic editorial paragraphs. Each typographic choice signals to the
reader where they are in the document.

**Narrative drives understanding.**
Prose is not optional. A report without narrative is a
spreadsheet. Spectre is not a spreadsheet.

**Data supports narrative.**
Tables and tiles are evidence for sentences. They are not the
point of the page.

---

## Honest Data Source Labelling

Every reporting surface must honestly label which inputs are:

- **Live** — value comes from a wired production source
- **Partial** — section is mostly live but at least one input is
  still placeholder
- **Demo** — entire section is placeholder pending data wiring

This labelling is non-negotiable. A board package that silently
mixes live and placeholder data is worse than one that ships with
demo data clearly marked. Trust is the only product Spectre
delivers; mislabelling destroys it.

The three states render through a single `DataSourceChip`
component so the visual treatment is uniform across the package.
See the chip's implementation in
[`src/app/app/admin/reporting/monthly/page.tsx`](../src/app/app/admin/reporting/monthly/page.tsx).

---

## How This Framework Composes With Other Standards

There are three layered standards governing reporting work in
Spectre. They compose, they do not compete:

1. **The Spectre Framework** (this document) — *what reports must answer*.
   Five pillars, four questions, narrative-first discipline.
2. **The Spectre Executive Reporting Design System**
   ([`docs/spectre-executive-reporting-design-system.md`](spectre-executive-reporting-design-system.md))
   — *how reports must look and read*. Typography hierarchy
   (5 levels), color philosophy (deep green / ivory / muted gold),
   layout discipline (whitespace intentional, cards minimized,
   borders reduced), narrative affordances.
3. **The Executive Reporting Design Standard skill**
   ([`.claude/skills/executive-reporting-design/SKILL.md`](../.claude/skills/executive-reporting-design/SKILL.md))
   — *how to review and ship it*. Squint test, print test,
   delete-on-sight list, review checklist.
4. **The Spectre Product Design Standard** (in CLAUDE.md) —
   *how every screen must behave*. Density, whitespace as defect,
   self-review, browser verification.

The order to apply them on any reporting change:
1. First — open this framework. Name the pillar(s) the change
   serves. Confirm the change is narrative-first. Confirm the four
   questions will be answerable on the finished surface.
2. Then — open the design system. Apply typography hierarchy,
   color palette, layout discipline, and narrative affordances.
3. Then — open the design-standard skill. Run the squint test,
   print test, and review checklist.
4. Finally — apply the general Product Design Standard for
   anything not specific to reporting.

If any step fails, stop. Do not ship a reporting change that
violates the framework even if the design execution is clean.

---

## Required Future Behavior

**Before Claude modifies any:**
- dashboard
- board package
- KPI card
- reporting screen
- executive summary
- analytics module
- finance page
- membership page
- hospitality page
- committee report

**it must:**
1. Read this document (`docs/spectre-framework.md`).
2. State explicitly, in its plan or response, **which of the five
   stewardship pillars** the proposed change serves.
3. State explicitly **how the change will let the surface answer
   the four questions** (what happened / why does it matter / is the
   trend improving / does the Board need to act).
4. Then invoke the Executive Reporting Design Standard skill for
   visual execution.

**Skipping any of those steps is a violation of these operating rules.**

Final summaries for reporting work must close the loop by naming
the pillar served and showing how each of the four questions is
now answerable on the finished surface.

---

## When This Framework Is Wrong

This is a living document. When a reporting requirement does not
fit any of the five pillars, do not force-fit it. Flag the gap to
the user and ask whether (a) the requirement belongs elsewhere or
(b) a sixth pillar is warranted. The framework exists to give
reporting work a shared foundation; it does not exist to constrain
honest governance needs that the founder identifies later.

---

## Summary

| Layer | Document | Question it answers |
|---|---|---|
| 1 | **This document** | *What must the report answer?* |
| 2 | [Executive Reporting Design System](spectre-executive-reporting-design-system.md) | *How should the report look and read?* |
| 3 | [Executive Reporting Design Standard skill](../.claude/skills/executive-reporting-design/SKILL.md) | *How do I review and ship it?* |
| 4 | CLAUDE.md (Product Design Standard) | *How should the screen behave?* |

Every reporting change starts at layer 1 and works down.

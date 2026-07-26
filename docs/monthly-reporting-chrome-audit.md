# Monthly Reporting — Admin-Chrome Audit

**Surface:** `/app/admin/reporting/monthly`
**Audit date:** 2026-06-03
**Audited against:** [Spectre Framework](spectre-framework.md) +
[Spectre Executive Reporting Design System](spectre-executive-reporting-design-system.md)

> **No code changed.** This document is the source list for a follow-up
> remediation pass. Each finding cites its file and line range so the
> fix can be scoped tightly.

---

## Why this audit exists

The Monthly Reporting Package is the *product* a Finance Committee
sees. The design system says it must feel like "a Deloitte board
package or a private-club annual report — not a SaaS admin screen".
This audit names every element on the current screen that reminds the
reader they are inside an admin application.

Three categories of leak qualify as findings:

1. **Workflow chrome** — controls, buttons, dropdowns, banners that
   belong in an operating tool, not in a document
2. **Admin palette leak** — `stone-50/100/200/500/700/900` and other
   neutral greys where the design system mandates
   `club-cream`/`club-sand`/`club-green-*`/`club-gold`/`club-ink`
3. **Database vocabulary** — language that exposes the underlying
   application ("tenant scope", "admin", "data is wired up",
   "Mark reviewed") to a board reader

---

## Severity scale

| Rank | Definition |
|---|---|
| **Critical** | Breaks the board-package illusion the moment the page paints. A board director would immediately perceive "this is a screen from a SaaS tool". Must be removed or restyled before the package is shown to a real committee. |
| **High** | Visible on every chapter and degrades the document feel even though it does not, by itself, scream "admin". Restyle to the design-system palette / replace with the documented primitive. |
| **Medium** | Noticeable on close inspection. Acceptable in a working-draft state but should be cleaned before the package is treated as boardroom-ready. |
| **Low** | Defensible as a working affordance or a security requirement. Listed for completeness so the founder can confirm the trade-off, not because removal is required. |

---

## Findings — Critical

### C1. Export controls strip directly under the cover
[src/app/app/admin/reporting/monthly/page.tsx:255-311](../src/app/app/admin/reporting/monthly/page.tsx#L255-L311)

Below the ceremonial cover sits a horizontal utility strip containing:
- a smallcaps "Package controls" label
- a **disabled** `<select>` reporting-period dropdown (single option, no behaviour)
- four buttons using admin button tokens (`btn btn-primary btn-sm` / `btn btn-secondary btn-sm`):
  - **Generate package**, **Export PDF**, **Export Excel** (all disabled)
  - **Mark reviewed** (workflow primitive, not a board primitive)

**Why it reads as admin:**
- A bound board package does not ship with non-functional buttons under the cover.
- `disabled:opacity-50 disabled:cursor-not-allowed` is the SaaS feature-flag dialect.
- "Mark reviewed" is an operator-workflow verb; a director does not "mark" a board package "reviewed" — they receive it, read it, and discuss it.
- The dropdown implies the surface is a configurable report-builder rather than *the package for May 2026*.

**Recommendation:** Remove the entire strip. Move any genuine export action to a single quiet "Save as PDF" link in the shell header (or rely on browser print, which already produces a clean artifact in print mode). The cover must transition directly into the Board Financial Briefing.

---

### C2. Disclaimer footer with "Tenant scope" + admin-neutral palette
[src/app/app/admin/reporting/monthly/page.tsx:144-148](../src/app/app/admin/reporting/monthly/page.tsx#L144-L148)

```
Reporting period: May 2026 · Prepared 2026-06-03 ·
Tenant scope: Silver Springs Golf & Country Club.
Sections marked [Demo data] are presenting demonstration values
while live source data is wired up.
```

**Why it reads as admin:**
- `border-stone-200 bg-stone-50 text-stone-600` — three banned admin tokens in one element.
- **"Tenant scope"** is a multi-tenant database concept. No board reader knows or wants to know that Spectre is a multi-tenant SaaS.
- "live source data is wired up" is developer language — it tells the reader "this is software under construction".
- The footer reads as a developer disclaimer, not a board-package colophon.

**Recommendation:** Delete. The cover already names the club and the period. The `DataSourceChip` already labels each section's data honestly. A board package does not need a footer disclaimer.

---

### C3. Capital Projects table renders as a generic admin data table
[src/app/app/admin/reporting/monthly/page.tsx:690-723](../src/app/app/admin/reporting/monthly/page.tsx#L690-L723)

Capital Projects is the entire IX chapter, yet it is rendered as a CRM-style data table:
- outer: `border-stone-200 bg-white`
- header band: `border-stone-200`
- table head: `bg-stone-50 text-stone-500`
- row dividers: `border-stone-100`
- cells: `text-stone-800`, `text-stone-900`, `text-stone-700`

Every other major section in chapters V–X uses the `BoardStatement` primitive (summary cards → key variances → notes → subordinated detail). Capital Projects skips it.

**Why it reads as admin:**
- Every neutral in the component is a banned token from the design system's color philosophy.
- The shape (header bar + plain `<table>`) is the universal SaaS data-grid silhouette.
- Inconsistent with chapters V, VI, VII, VIII, X which all open with a `BoardStatement`.

**Recommendation:** Rebuild the chapter to follow the documented `BoardStatement` anatomy — Capital plan summary cards (Total approved / YTD spend / Remaining commitment / Variance to plan), the 3–5 projects that moved the period as key-variance rows, plain-English notes, and the project-by-project table subordinated under "Full project detail".

---

### C4. "Back to admin" link in the running shell header
[src/components/reporting/ReportingShell.tsx:96-107](../src/components/reporting/ReportingShell.tsx#L96-L107)

The deep-green sticky header opens with a chevron + the literal text **"Back to admin"**.

**Why it reads as admin:**
- The word **"admin"** is the single most damning leak on the page. Every chapter scrolls beneath this link.
- A board package has no "admin" to go back to — it is its own artifact.
- Even framed as a working tool, the language belongs to operators, not directors.

**Recommendation:** Rename to neutral, document-shaped language — "Close report", "Return to library", or just the chevron with an aria-label and no visible text. If the package is intended to be opened from a member/board portal, the link could read "Done" or be removed entirely.

---

### C5. `SectionHeading` atom uses the admin stone palette
[src/app/app/admin/reporting/monthly/page.tsx:1168-1180](../src/app/app/admin/reporting/monthly/page.tsx#L1168-L1180)

```tsx
<div className="text-[10px] uppercase tracking-wide text-stone-500">{eyebrow}</div>
<h2 className="font-serif text-2xl text-stone-900">{title}</h2>
```

This atom renders **every section title in the package** — III At-a-Glance, IV Stewardship, V Financial Statements, VI Operations, VII Payroll, VIII F&B, IX Capital, X AR.

**Why it reads as admin:**
- `text-stone-500` (eyebrows) and `text-stone-900` (titles) are admin-tier neutrals.
- The rest of the page uses `text-club-green-800/75` and `text-club-green-900` for the same Level-3 typography role.
- The chapter titles are therefore the *lightest, greyest, least-club-coloured text on the page* — the opposite of how a board package should weight its hierarchy.
- This is one ~15-line atom, but its blast radius is every chapter.

**Recommendation:** Replace `text-stone-500` with `text-club-green-800/75` and `text-stone-900` with `text-club-green-900`. This single edit upgrades the typography of eight section openings to design-system compliance.

---

## Findings — High

### H1. `SparkCard` (chart cards) on admin neutrals
[src/app/app/admin/reporting/monthly/page.tsx:1560-1598](../src/app/app/admin/reporting/monthly/page.tsx#L1560-L1598)

Used by:
- Operations · Course utilization trend
- Payroll · Payroll ratio trend
- F&B · Subsidy trend
- (Visual Summary equity / NOI / dues trends — dead code, see M2)

Class set: `rounded-lg border border-stone-200 bg-white p-4` + `text-stone-900` / `text-stone-700` / `text-stone-500` axis labels.

**Why it reads as admin:**
- Every neutral is a banned token.
- The 12-month trend charts close three chapters — they are the last thing the director sees before turning to the next chapter, so the admin chrome here disproportionately taints the reading experience.

**Recommendation:** Restyle to the design-system palette — `border border-club-sand bg-white`, `text-club-green-900` for the title, `text-club-green-800/65` for axis labels. Keep the stroke color tokens as-is (`#284829`, `#a85a1f`) — they are deep green / muted ochre and are on-standard.

---

### H2. `ToneChip` neutral state uses stone
[src/app/app/admin/reporting/monthly/page.tsx:1600-1608](../src/app/app/admin/reporting/monthly/page.tsx#L1600-L1608)

The neutral variant: `bg-stone-100 text-stone-700 ring-1 ring-stone-200`.

Currently used inside the Capital Projects table (C3). When C3 is rebuilt to use `BoardStatement`, this atom likely becomes unused — but until then, the chip is rendered on every project row.

**Recommendation:** Either delete the atom when C3 is fixed, or repaint the neutral variant in `bg-club-cream text-club-green-800/85 ring-club-sand`.

---

## Findings — Medium

### M1. Print Mode toggle pill
[src/components/reporting/ReportingShell.tsx:187-227](../src/components/reporting/ReportingShell.tsx#L187-L227)

A fixed top-right pill labelled "Print mode" / "Exit print". The pill itself is hidden during `@media print`, so it does not appear in the actual artifact.

**Why it lands at Medium, not Critical:**
- The pill is restrained, palette-compliant (`bg-club-green-900 text-club-gold` / `bg-club-gold text-club-green-900` when active).
- It serves a real document-quality function — letting a director preview the printable layout without invoking the OS print dialog.
- But: it IS a button welded to a fixed corner of the page. A board reader does not expect "Print mode" as a screen affordance — they print from the browser.

**Recommendation:** Consider demoting to a small "Preview print layout" link in the shell header next to (or replacing) the "Back to admin" link (C4). Alternative: keep it, but verify it disappears under `@media print` so the printed PDF is clean.

---

### M2. Dead `VisualSummary` component in the page module
[src/app/app/admin/reporting/monthly/page.tsx:460-488](../src/app/app/admin/reporting/monthly/page.tsx#L460-L488)

The `VisualSummary` function is defined and uses banned admin tokens (`border-stone-200 bg-white`, `text-stone-900`, `text-stone-500`, `text-stone-700`) but is **never invoked** from the page render tree (chapters reorganized; equity / NOI / dues trends were removed from the document order).

**Why it matters:**
- Dead admin-palette code in the reporting module is a future regression hazard — a copy-paste from this dead component will spread the leak to a live chapter.
- The `CLAUDE.md` "no-placeholder rule" forbids stubs in production code; dead components on the wrong palette are the same risk.

**Recommendation:** Delete `VisualSummary` (and its dependent `SparkCard` "Department Contribution YTD" card on lines 473–485) entirely. If a visual summary chapter is reintroduced, build it fresh against the design system.

---

### M3. Dead `Stat` atom
[src/app/app/admin/reporting/monthly/page.tsx:1550-1558](../src/app/app/admin/reporting/monthly/page.tsx#L1550-L1558)

```tsx
<div className="rounded-md bg-stone-50 px-3 py-2">
  <div className="text-[10px] uppercase tracking-wide text-stone-500">{label}</div>
  <div className="mt-0.5 font-mono text-base font-semibold text-stone-900">{value}</div>
```

Defined but not used. Same risk as M2.

**Recommendation:** Delete.

---

### M4. URL exposes `/app/admin/...` in the browser address bar
URL: `/app/admin/reporting/monthly`

**Why it reads as admin:**
- The URL is the one piece of chrome the design system cannot fully control via the document body. The path segment `/admin/` is visible whenever a director copies the link, shares it, or simply glances at the address bar.
- A board package surface ideally lives at `/reports/monthly`, `/board/may-2026`, or `/package/...` — outside the admin application namespace.

**Recommendation:** Consider mounting the public-facing board surfaces under a separate URL prefix (`/reports/...` or `/board/...`) and keeping `/app/admin/reporting/...` as the operator route that *prepares* and *previews* the package. This is a routing change, not a UI change, but it has visible impact on the document feel.

---

### M5. `BoardStatement` "Full statement detail" tables
[src/app/app/admin/reporting/monthly/page.tsx:1492-1548](../src/app/app/admin/reporting/monthly/page.tsx#L1492-L1548)

The `StatementDetailTable` and `ArAgingDetailTable` atoms are *almost* on-palette — they use `border-club-sand` and `text-club-green-*` correctly — but the visual rhythm is still very "table inside an app".

**Why it lands at Medium:**
- The board-package primitive already correctly subordinates these tables under a smallcaps "Full statement detail" eyebrow.
- The cell styling is restrained.
- But the directors only ever look at the summary cards + variances + notes; the detail tables sit there as the controller's audit trail. They are necessary, just visually heavy.

**Recommendation:** Reduce row density (more line-height), drop the `[0.14em]` letter-spacing on the column heads (already faint), and ensure the table never appears above the fold of the summary cards. No urgent change.

---

### M6. Disclaimer footer language — "live source data is wired up"
Same line as C2. Even if the rest of C2 is removed, if any footer remains, the phrase **"while live source data is wired up"** is developer dialect that does not belong in a board package.

**Recommendation:** Use the `DataSourceChip` (already present on every section) and remove the explanatory sentence entirely. The chip is self-evident; an explanation is what an admin tool would write.

---

## Findings — Low

### L1. Period chip in the shell header
[src/components/reporting/ReportingShell.tsx:125-132](../src/components/reporting/ReportingShell.tsx#L125-L132)

A small `MAY 2026` chip in the top-right of the running header. Palette-compliant. Slightly redundant with the 36-px serif period on the cover, but useful as the reader scrolls through later chapters.

**Verdict:** Defensible. Document-spine treatment. No change required.

---

### L2. Chapter rail labelled "In this package"
[src/components/reporting/ReportingShell.tsx:141-169](../src/components/reporting/ReportingShell.tsx#L141-L169)

The 220-px left rail is the closest thing on the page to a SaaS sidebar, but it is styled as a print TOC:
- serif chapter labels
- gold roman-numeral markers
- "In this package" eyebrow (correct document language)
- italic editorial "Prepared for the Finance Committee" footer

**Verdict:** Reads as a TOC, not a sidebar. No change required.

---

### L3. Sticky deep-green header on every chapter
[src/components/reporting/ReportingShell.tsx:84-135](../src/components/reporting/ReportingShell.tsx#L84-L135)

The header stays pinned as the reader scrolls. Palette-compliant (deep club green + ivory + gold pinstripe), reads as a bound-document spine.

**Verdict:** Defensible — it is the only persistent identity element once the reader leaves the cover. A board-document spine *is* the correct metaphor. No change required.

---

### L4. Support-impersonation banner can render inside reporting mode
[src/components/admin/AdminShell.tsx:60-74](../src/components/admin/AdminShell.tsx#L60-L74)

When an Anthropic support user is impersonating, the `supportBanner` renders inside the reporting-mode shell.

**Verdict:** This is a security requirement (impersonation must always be visible). Not a real chrome leak — the banner only renders during support sessions, never during a board reading session. No change.

---

### L5. `toast` notifications can render inside reporting mode
[src/components/admin/AdminShell.tsx:71](../src/components/admin/AdminShell.tsx#L71)

The toast slot is rendered in reporting mode. Default state is empty.

**Verdict:** Inert until something fires; if a toast does fire during a board reading session, that is the real bug (something shouldn't be firing). No change to the shell — verify no reporting code paths emit a toast.

---

## Summary table

| ID | Element | Where | Rank |
|---|---|---|---|
| C1 | Export-controls strip under cover (disabled select + 4 admin buttons) | `monthly/page.tsx:255-311` | **Critical** |
| C2 | "Tenant scope" disclaimer footer on `stone-50` | `monthly/page.tsx:144-148` | **Critical** |
| C3 | Capital Projects rendered as generic admin data table | `monthly/page.tsx:690-723` | **Critical** |
| C4 | "Back to admin" link in the shell header | `ReportingShell.tsx:96-107` | **Critical** |
| C5 | `SectionHeading` atom uses `text-stone-500/900` | `monthly/page.tsx:1168-1180` | **Critical** |
| H1 | `SparkCard` chart cards on admin neutrals | `monthly/page.tsx:1560-1598` | High |
| H2 | `ToneChip` neutral variant uses stone | `monthly/page.tsx:1600-1608` | High |
| M1 | Print Mode fixed pill | `ReportingShell.tsx:187-227` | Medium |
| M2 | Dead `VisualSummary` component | `monthly/page.tsx:460-488` | Medium |
| M3 | Dead `Stat` atom | `monthly/page.tsx:1550-1558` | Medium |
| M4 | URL exposes `/app/admin/...` | route | Medium |
| M5 | "Full statement detail" table density | `monthly/page.tsx:1492-1548` | Medium |
| M6 | "live source data is wired up" footer language | `monthly/page.tsx:144-148` | Medium |
| L1 | Shell-header period chip | `ReportingShell.tsx:125-132` | Low |
| L2 | "In this package" chapter rail | `ReportingShell.tsx:141-169` | Low |
| L3 | Sticky deep-green header | `ReportingShell.tsx:84-135` | Low |
| L4 | Support-impersonation banner | `AdminShell.tsx:60-74` | Low |
| L5 | Toast slot in reporting mode | `AdminShell.tsx:71` | Low |

---

## Recommended remediation order

If the founder authorizes a remediation pass, the highest leverage-per-edit ordering is:

1. **C5** — one atom edit, repaints every section title in the package (~15 lines)
2. **C4** — rename / replace one link (~10 lines), removes the most damning word on the screen
3. **C2 + M6** — delete the disclaimer footer (~5 lines)
4. **C1** — delete the export-controls strip and the disabled controls beneath the cover (~40 lines)
5. **H1** — restyle `SparkCard` to the design-system palette (~10 lines)
6. **M2 + M3** — delete the dead `VisualSummary` and `Stat` components (~50 lines net deletion)
7. **C3** — the only structural rebuild: Capital Projects chapter restyled through `BoardStatement` (largest task)
8. **H2** — restyle `ToneChip` neutral variant (may become unused after C3)
9. **M1, M4, M5** — strategic decisions that warrant founder input before changing

Items 1–6 are small mechanical edits with disproportionate visual return; item 7 is the only one requiring genuine design work.

---

## What this audit is not

- This audit does not propose a redesign of the document narrative — the
  framework, design system, and skill already define the document
  shape. This audit only flags what is currently visible that
  contradicts that shape.
- This audit does not assess content quality (whether the right
  KPIs are present, whether the commentary is good, whether the
  pillar coverage is correct). That is the Spectre Framework's
  responsibility and is reviewed separately.
- This audit does not measure pixel-level typography or responsive
  behaviour. Those are the
  [`executive-reporting-design`](../.claude/skills/executive-reporting-design/SKILL.md)
  skill's squint-test and print-test responsibilities.

---

## When the founder should reject a finding

The Low-tier findings (L1–L5) are listed for completeness. If the
founder reads a Medium-tier finding (especially M1 or M4) and judges
that the working affordance is more valuable than the document feel,
record the decision in [CLAUDE.md](../CLAUDE.md) so future Claude
sessions do not reopen the same audit.

# Spectre Product Language

**Version 1.0**

This document governs **how Spectre organizes information and behaves**. The companion document [Spectre Design Language.md](./Spectre%20Design%20Language.md) governs how Spectre **looks** — tokens, typography, spacing, radius, shadow, motion, iconography, theme system. The two documents are independent authorities; this one does not restate any value defined there. When a rule below references motion, colour, or type, it references those definitions by name and does not duplicate them.

The Monthly Reporting Package is a **protected surface** and is not governed by this document. Every rule that references "administrative screen," "workspace," or "the Administration application" excludes the Monthly Reporting Package and its adjacent surfaces (`/app/admin/reporting/**`, `/app/admin/governance/monthly-package/**`, `/app/admin/governance/packages/**`). The Member Portal and the POS lounge are also out of scope for this document.

---

## 1. Product Role

Spectre is an **operational system for running a private club**. Every administrative screen exists so a controller, general manager, department head, or committee chair can identify what changed, take the correct action with the evidence needed to justify it, and confirm the result was applied — without leaving the tool.

**Governing statement.** *Every Spectre administrative screen must let the user (a) recognize what changed or requires attention, (b) take the correct next action with the evidence needed to justify it, and (c) confirm the result was applied.*

If a proposed screen fails any of the three tests (recognize / act / confirm), the screen is not ready to ship.

**What Spectre is not.**

- Not a publication. Screens do not open with a masthead, a section number, or an editorial paragraph. That vocabulary belongs to the Monthly Reporting Package.
- Not a generic analytics dashboard. Numbers appear because someone decides against them, not because someone might glance at them.
- Not a collection of disconnected administrative forms. Every configuration, every list, every detail page inherits the same information grammar defined below.

---

## 2. Core Product Principles

Ten principles. Each principle names an interface behaviour, states the rule, defines what the rule requires and what it prohibits, and gives one worked example and one failed example.

### P1 — Software first

**Rule.** Every administrative screen must read as a tool a user operates, not as a document they consume.

**Requires.** Task-oriented headings; visible interactive affordances; keyboard operability; direct verbs.
**Prohibits.** Editorial mastheads. Long prose paragraphs above the fold. Roman-numeral section labels. Serif display type. "Volume XVIII", "Reading No.", "As of", "Statement of…" phrasing.

- Good: `Applications · 2 awaiting review · Approve 2 →`
- Bad: `Statement of Membership · Volume XVIII · The queue is quiet otherwise; two applications await your decision by Friday.`

### P2 — Attention before information volume

**Rule.** The most urgent state on a screen appears first, occupies the largest visual weight, and carries its action inline. Everything else follows.

**Requires.** A single dominant focal point per viewport. A visible primary action tied to that focal point. Non-urgent context beneath or beside, at lower visual weight.
**Prohibits.** Grids of equal-weight KPI tiles when priorities differ. Manufactured "highlights" when nothing needs the user's attention today.

- Good: A queue page whose top card summarises the two overdue items with a Send notices button, followed by the aged-AR table.
- Bad: Eight identical KPI tiles arranged in a 4-column grid where two contain warnings and six do not.

### P3 — Action before decoration

**Rule.** For every state a user can be shown, the corresponding action must be reachable within one interaction from that state.

**Requires.** Buttons named with verbs and objects. Row-level actions on the same row as the record. Inline links from evidence to source.
**Prohibits.** Buttons labelled `Manage`, `Proceed`, `Enter`, `Continue`, `Go`, `Open`. Read-only visual charts that state a problem without linking to the responsive workflow.

- Good: `AR over 60 days · $2,880 · Send 3 notices →` on the same card.
- Bad: `AR over 60 days · $2,880` with a `Manage` button that opens an unrelated overview page.

### P4 — Clarity before density

**Rule.** Prefer fewer high-value fields over more low-value fields on any single screen.

**Requires.** Column choices that support the decision the user came to make. Table columns priced by the user's action, not by data availability.
**Prohibits.** Every possible column on by default. Charts with more than five series when three would answer the question.

- Good: A collections queue showing Member · Balance · Days overdue · Last notice sent · Send notice.
- Bad: The same queue showing 14 columns because "the data is there."

### P5 — Context before controls

**Rule.** Before showing an input, show the user what the input will affect and what its current value is.

**Requires.** Every editable value renders alongside the currently-applied value. Every configuration screen states what changes when you save. Every batch action tells the user how many records are targeted and which.
**Prohibits.** Bare form fields with no accompanying state. Save buttons that do not preview scope.

- Good: `Grace period · Currently 15 days · Applies to new accounts only`.
- Bad: `Grace period: [15]` with no clarification of scope.

### P6 — Evidence near decisions

**Rule.** Every recommended action must render adjacent to the evidence that supports it. The user should not have to navigate to another page to understand why Spectre is showing them something, unless the evidence is genuinely extensive.

**Requires.** Timestamp, source, and traceable calculation adjacent to any figure a user is asked to act on. Aged AR balances beside collection actions. Application age beside review actions. Reconciliation variance beside reconcile actions.
**Prohibits.** AI-style narrative that summarises without linking. Numbers a user cannot trace to a source. "Recommendations" without evidence trails.

- Good: `Send $2,880 to collections · Over 60 days since 2026-06-01 · 3 members · Based on aged-AR report generated 2026-07-14 06:41 EDT`.
- Bad: `Recommended: send 3 accounts to collections` with no trail.

### P7 — Progressive disclosure

**Rule.** Show the state, the primary action, the material exception, and the key evidence immediately. Everything else appears on request.

**Requires.** Expandable rows / drawers / detail pages for full audit trails and technical metadata. Advanced filters hidden behind a Filters button.
**Prohibits.** Hover-only reveal of essential evidence. Modals that hide required decision information behind a second interaction. "Advanced" toggles that hide a critical field.

- Good: A row that shows `Marie DuPont · Under review · Jul 6 · Review →`, expands to reveal household composition and sponsorship on click.
- Bad: A row that hides the days-open figure behind a mouseover tooltip.

### P8 — Consistency without sameness

**Rule.** Every module inherits the same hierarchy, action grammar, status vocabulary, and navigation model. Only the domain data and workflow steps vary between modules.

**Requires.** Common page titles, common action placement, common status naming, common table behaviour.
**Prohibits.** Two modules using different words for the same state ("Under review" vs "Pending review" vs "In progress" for one workflow stage). Two modules using different action patterns for the same intent.

- Good: Membership and AR queues both use `Review N →` for their primary action.
- Bad: Membership uses `Review 2 →` and AR uses `Open queue →` for the equivalent intent.

### P9 — Trust through traceability

**Rule.** Every material figure a user acts on must resolve to a source record, a timestamp, and (where relevant) an audit event.

**Requires.** Values sourced from the accounting system state their source. Values derived from an import batch state the batch. Values changed by a user record which user and when.
**Prohibits.** Figures presented without provenance. Actions that mutate data without an audit record. Narrative that asserts what the numbers "mean" without linking to the calculation.

- Good: `Reconciled · 06:41 EDT · Batch import-3427 · Zero variance · 63 lines`.
- Bad: `The batch reconciled` with no timestamp, batch reference, or line count.

### P10 — Tenant colour, Spectre chrome

**Rule.** The tenant's brand contributes accent colour, logo, and name. The application's structure, layout, typography, and behaviour do not change per tenant.

**Requires.** The club's `primaryColor` drives `--spectre-accent` per request. The club's logo appears where identity is expected (top of the sidebar, top-bar identity slot).
**Prohibits.** Recolouring status colours per tenant. Using tenant branding to change semantic meaning. Hardcoding Silver Springs (or any tenant) values into reusable components.

- Good: A club whose accent is navy sees navy on the active nav bar, focus ring, and primary CTA — nothing else changes.
- Bad: A club whose accent is red sees red on the "Success" badge.

---

## 3. Spectre Information Grammar

Administrative screens compose from five concepts, in a defined order:

1. **Context** — where the user is: module, page, scope (period, tenant filter), why this screen exists.
2. **Attention** — what needs the user's action right now, or the fact that nothing does.
3. **Action** — the affordance that resolves the attention state, named with a verb and object.
4. **Evidence** — the data supporting the action: current values, source, timestamp, calculation.
5. **History** — prior activity: audit records, related events, recent transitions.

Each surface type has a required section list and a required ordering. A section that does not apply may be omitted; a section that applies may not be reordered.

### A. Operational workspace

An operational workspace is a top-level module home (e.g. Finance, Membership, Hospitality).

**Required sections, in order.**

1. Context — module name, scope (fiscal period, club, filter).
2. Attention — the most urgent one, two, or three items open in this module.
3. Primary actions — inline with attention items.
4. Current status / evidence — the small set of figures that tell the user "the module is on plan / off plan / mid-transition."
5. Supporting detail — tables or lists of records for review.
6. Recent history — the last few audit events or activity items relevant to this module.

**Optional sections.** Filters, saved views, cross-module links.

**Prohibited orderings.**

- History before attention.
- Evidence before the attention it supports.
- Primary actions in a separate footer.

**Common failure modes.**

- Placing eight equal-weight KPI tiles at the top before any attention item.
- Splitting evidence from the action it supports across two panels.
- Filling the module home with a "featured" module link (Governance links to Governance is not a feature).

### B. Record-detail page

A record-detail page is the canonical view of one record (a member, an applicant, an invoice, a package).

**Required sections, in order.**

1. Identity — record type, primary name, permanent identifier.
2. Current state — which workflow stage the record is in, when it entered.
3. Available actions — the state-appropriate action set (Approve / Reject / Return / Escalate for an application under review).
4. Key evidence — the smallest set of facts that let the user decide.
5. Related records — sponsor, household members, invoices, sessions.
6. Audit history — an append-only trail of what changed, by whom, when.

**Optional sections.** Notes, attachments, cross-module references.

**Prohibited orderings.**

- Actions before state.
- Audit history above key evidence.
- Related records above actions.

**Common failure modes.**

- Rendering the record's identity as a page title without also stating the current state (user has to hunt).
- Presenting an "edit form" that requires re-entering values already shown on the record.

### C. Configuration page

A configuration page is where a user changes system-level settings (fiscal year, dues policy, notification preferences).

**Required sections, in order.**

1. Purpose — what this configuration controls, in one sentence.
2. Current configuration — the applied value(s).
3. Editable controls — the input(s) that change the value.
4. Impact / consequences — what changes for whom when the user saves.
5. Save state — whether changes are pending, saved, or failed.
6. Change history — who changed this configuration and when.

**Prohibited orderings.**

- Editable controls before purpose or current configuration.
- Save state before controls.

**Common failure modes.**

- A form with no summary of "what happens when I save this."
- No change history — user cannot verify who last changed the setting.

### D. Queue or worklist

A queue is a prioritized list of records that require the user's action.

**Required sections, in order.**

1. Queue purpose — what these items are and why they wait.
2. Urgency and filters — the primary sort (oldest? highest balance? most overdue?) and the active filters.
3. Items requiring action — the list itself, sorted so the top item is the most urgent.
4. Bulk actions — the set of actions that apply across selected items.
5. Item evidence — inline with each item.
6. Completion state — how the user knows the queue is empty when it is.

**Prohibited orderings.**

- Item evidence in a separate detail page rather than on the row.
- Bulk actions floating below the fold when the list is long.

**Common failure modes.**

- A queue whose default sort places the most recent at top instead of the most urgent.
- A queue that does not tell the user what to do when it is empty ("No items awaiting action — check back in the morning.").

---

## 4. Attention Model

Every state a user can be shown belongs to one of four attention levels. The level determines placement, styling, and whether an action is required.

### Levels

**L1 — Critical.**

- Meaning. The user cannot proceed with normal work until they act. Money is at risk, compliance is at risk, or an irreversible deadline is imminent (< 24 hours).
- Placement. Top of the workspace, first thing rendered on load.
- Colour treatment. `--spectre-status-error` band or badge. Never the whole surface.
- CTA. Required and specific. `Contact bank about failed batch` beats `Review`.
- Interrupts the user. Yes — critical items are the first thing above the fold.
- Disappears when. The blocking condition resolves.
- Examples. Failed AP batch requires manual intervention. Membership onboarding blocked by legal-review missing document. Ledger imbalance blocking period close.

**L2 — Action required.**

- Meaning. A decision awaits the user; not blocking normal work but has a deadline or accumulates cost.
- Placement. In the "Attention" section of the module home. On the record's detail page.
- Colour treatment. `--spectre-status-warning` badge or thin accent bar. Not the whole surface.
- CTA. Required and specific. `Review 2 applications` / `Send 3 notices` / `Reconcile May`.
- Interrupts the user. No — it appears where the user goes next, not on every screen.
- Disappears when. The item is actioned.
- Examples. Applications awaiting decision. Overdue balances requiring notice. Board decisions requiring a vote.

**L3 — Monitor.**

- Meaning. A trend or condition worth being aware of; no action required today. Approaching a threshold.
- Placement. Inline with the record or metric it relates to, at reduced visual weight.
- Colour treatment. `--spectre-text-muted` prose. No status colour.
- CTA. Optional. If present, `View trend` or `Configure alert` — never a critical verb.
- Interrupts the user. No.
- Disappears when. The condition normalises or crosses a threshold that promotes it to L2.
- Examples. AR ageing at 42 days — inside the 60-day policy. Kitchen prep 15% ahead of schedule.

**L4 — Healthy / informational.**

- Meaning. A confirmation that a system, batch, or period is fine.
- Placement. Beside or beneath the related metric. Never above L1 / L2 items.
- Colour treatment. `--spectre-status-success` where a confirmation adds meaning; otherwise unstyled prose.
- CTA. None.
- Interrupts the user. No.
- Disappears when. It becomes an L3 or L2 event.
- Examples. Reconciled. Batch closed. Tee sheet on schedule.

### Focal-point rule

**A page may have only one dominant attention area unless the workflow genuinely contains two independent critical states.**

If two independent critical states coexist, the dominant one is chosen by financial impact first, compliance impact second, deadline proximity third. The other appears as a full-width bar above the dominant area, not as a competing card.

### Explicit prohibitions

- Do not paint every metric urgent. Manufactured urgency destroys the user's ability to prioritize.
- Do not use colour without semantic meaning. `--spectre-status-error` on a non-error is a bug.
- Do not rely on red / amber / green alone; every status colour must appear beside a text label or icon so colourblind users can read state without hue.
- Do not display decorative "health indicators" (dials, gauges, sparklines) that are not driven by real data.
- Do not fabricate attention items on quiet days. If nothing needs the user's attention, say so.

---

## 5. Action Grammar

Actions are how the user resolves a state. Every action carries a verb and an object.

### Categories

**Primary action.** The single expected action for the current attention state. One per section maximum. Filled button (Design Language `spectre-btn--primary`). Verb + object. Placement: adjacent to the attention state.

**Secondary action.** An alternate that does not resolve the attention state but is legitimately expected (Skip, Escalate, Send to review). Ghost or outline button. Placement: adjacent to primary.

**Destructive action.** Deletes, voids, revokes, cancels irreversibly, or notifies third parties. Danger tone. Placement: within a menu, drawer, or footer — never on the same row as the primary. Requires an explicit confirmation dialog naming what will be affected.

**Contextual row action.** An action on a specific record within a list or table. Placement: the row itself, right-aligned. Verb + object where space permits; icon-only where not, with `aria-label`.

**Bulk action.** An action applied to multiple selected rows. Placement: above the table, appearing only when at least one row is selected. States the count (e.g. `Send 3 notices`).

**Passive navigation.** Text links that move the user to a related context without changing state. Placement: inline with the reference. Same underline convention across the product.

**Asynchronous action.** An action whose result appears after a background operation (imports, sends, publications). Requires a loading state, a completion notification (`Toast`), and a way to see the result (audit history or the affected record).

**Confirmation.** Any destructive or externally visible action requires a modal that:
- Names the record(s) or scope being affected.
- Names the reversibility (`This cannot be undone` if true; otherwise say what "undo" looks like).
- Names any external effects (`This will email 3 committee chairs`).

**Undo.** Reversible actions should surface an undo affordance in the success toast for at least 8 seconds where the platform supports it.

**Disabled state.** A disabled action must state why. `disabled` alone is never sufficient — tooltip, helper text, or an adjacent status line names the missing prerequisite.

### Label rules

**Every action label uses a verb and an object.**

- Good: `Review 2 applications`, `Send 3 notices`, `Reconcile May`, `Publish package`, `Revoke access`, `Approve · Reject · Return`.
- Bad: `Enter`, `Go`, `Proceed`, `Manage`, `Open`, `View`, `Submit` (when a more specific verb applies), `Continue`.

**Counts appear in the label when the action operates on a set.**

- Good: `Approve 2 applications`, `Delete 5 records`.
- Bad: `Approve` when the count is known.

**Time and scope appear in the label when they materially change the operation.**

- Good: `Reconcile May 2026`, `Publish May Board Package`.
- Bad: `Reconcile`, `Publish` when a period or scope is required.

### Element choice

| Intent | Element |
|---|---|
| Resolve the primary attention state | Filled button (`spectre-btn--primary`) |
| Alternate to primary | Outline button (`spectre-btn--secondary`) |
| Tertiary or exit | Ghost button (`spectre-btn--ghost`) |
| Delete / void / revoke | Danger button, inside menu or dialog |
| Move to a related context | Text link (inline underline on hover) |
| Row action (small target) | Icon-only button with `aria-label` |
| Choose one of ≤ 5 options | Segmented control |
| Choose one of > 5 options | Select |
| Toggle a boolean | Toggle (Design Language `.spectre-toggle`) |
| Confirm a boolean commitment | Checkbox with label |
| Bulk action from a table | Button above the table, count in label |

---

## 6. Evidence Grammar

Every actionable state requires evidence adjacent to the action.

### Hierarchy

Every evidence block ranks its content in this order:

1. **Decision** — the recommended action or the state requiring one.
2. **Supporting evidence** — the small number of facts a user needs to accept the decision (usually two to four figures).
3. **Source** — the system, batch, or report the evidence comes from.
4. **Timestamp** — when the evidence was captured.
5. **History** — the prior evidence in this workflow (linked or expandable).

### Adjacency rule

A user should not need to navigate away from the action to understand why it is being recommended, unless the evidence is genuinely extensive (a full reconciliation report, a legal document, an image gallery). In those cases, the summary appears inline and a `See full evidence` link opens the extensive artifact.

Adjacency examples:

- Overdue balance rendered on the same row as the `Send notice` action.
- Application age rendered on the applicant's card, adjacent to `Review`.
- Policy threshold rendered on the KPI card that indicates the exception.
- Last reconciliation time rendered beside the current variance figure.
- Source system + effective date rendered beside every imported figure.

### Prohibitions

- No "AI-narrative" claims that summarise data without linking to it. A recommendation that cannot be traced is not evidence.
- No figures without provenance in workflows where a user acts on them.
- No "See details" buttons that carry the only remaining evidence — enough evidence to justify the action must be on the current view.

---

## 7. Workspace Architecture

Every administrative screen composes from four zones.

### Zone 1 — Global shell (governed by Design Language)

- Product navigation (sidebar, per Design Language §Sidebar).
- Club context (identity block at top of sidebar).
- Search (top of sidebar and top-right of top bar).
- Notifications.
- Theme toggle.
- User controls (identity + settings + sign out).

The global shell does not change per module.

### Zone 2 — Page context

- **Breadcrumb** — when the page is more than one step deep from the module home, or when the user is looking at a specific record within a queue. Otherwise omitted.
- **Page title** — the concise name of the page. Not a sentence. `Applications`, not `The Applications Queue for Silver Springs`.
- **One-sentence purpose** — appears beneath the title only when the page's purpose is not obvious from the title. Prohibited on module-home pages (redundant with the module name).
- **Current scope or period** — where the page is scoped to a period, tenant, or filter, the scope is stated inline (`Applications · Silver Springs · Fiscal year 2026`).
- **Page-level actions** — any action that applies to the page's scope (Export, Print, Filters) sits at page top-right. The primary attention action sits inside Zone 3, not here.

### Zone 3 — Working area

- **Primary task or attention state** — occupies the largest visual weight on the page. Owns the primary action.
- **Supporting status** — one row (or one column) of related figures. No more than three or four in this row.
- **Records, controls, or evidence** — the table, list, form, or detail view that the user came to work with.

### Zone 4 — Secondary context

- **Recent activity** — the audit / activity feed relevant to what the user is looking at, if any.
- **Related items** — cross-references.
- **Help or guidance** — links to the relevant policy, spec, or reference doc.

Zone 4 is optional. It appears in a right rail on wide viewports, in a collapsed drawer on narrow ones, or beneath Zone 3 for small pages.

### When to use each container

| Container | Use for |
|---|---|
| **Table** | Comparing many records with the same schema |
| **List** | Sequence, activity feed, ordered priorities |
| **Card** | Genuine containment of one independent module of information |
| **Panel** | Grouped configuration or filter controls |
| **Drawer** | A short focused task that must stay in context |
| **Modal** | A required decision that must interrupt the user |
| **Popover** | A menu, filter, or lightweight secondary control |
| **Tooltip** | A single sentence of clarifying help |

**Explicitly prohibited: defaulting every section into a card.** A card carries visual and semantic weight. Wrapping every list, every configuration, every metric in a card destroys hierarchy.

---

## 8. Layout Rules

Concrete, style-independent rules governing composition. These rules are testable by inspecting the finished screen.

- **One clear focal point per viewport.** The most urgent state is rendered largest, first, and with the primary action attached.
- **No more than one primary CTA per section.** If two actions compete for primacy, the section is doing two jobs; split it.
- **Related controls are grouped.** A form's amount, currency, and effective-date fields belong on the same visual row. Save + Cancel belong on the same row as each other, right-aligned.
- **Labels remain close to values.** Never break the label-to-value adjacency across a column boundary or scroll boundary.
- **Actions remain close to the records they affect.** A row's actions belong on the row, not in a floating "Actions" panel at page bottom.
- **Tables for comparison. Lists for sequence.** Use tables when the user compares records against the same fields. Use lists when the sequence itself matters (activity, chronological history, ranked priorities).
- **Cards only for genuine containment.** A card wraps a self-contained module of information (one KPI, one summary, one editable configuration group). Cards do not wrap headings, tables, or long text.
- **Side rails only for secondary context.** The right rail carries related information (activity, audit, cross-links). If a piece of information is on the critical path to the decision, it belongs in Zone 3, not the rail.
- **Equal-weight grids only for equal-weight items.** A 4-column KPI grid is appropriate when all four KPIs are equally relevant to the user's next action. If they are not equally relevant, break the grid.
- **No hero areas without functional purpose.** Empty banners, decorative headers, and centred illustrations that do not carry information waste the user's attention budget.

### Density by surface type

| Surface | Density |
|---|---|
| Module home | Comfortable — comprehension over compactness |
| Queue / worklist | Comfortable-to-dense — user works through a list |
| Detail page | Comfortable — one record, ample space |
| Form | Comfortable — labels + inputs + help + save state |
| Analytics page | Comfortable — small number of comparisons |
| Settings / configuration | Dense — configuration is comparative and repetitive |

"Dense" here refers to information density, not visual style. It never means small text or reduced padding below the values in the Design Language.

---

## 9. Navigation Grammar

Every screen must answer four questions:

1. **Where am I?** — The page title (Zone 2).
2. **What area am I in?** — The active sidebar item.
3. **What can I do next?** — Zone 3 (the primary action) and Zone 2 (page-level actions).
4. **How do I return?** — The breadcrumb (if present) and browser back.

### Role of each navigation element

| Element | Role | Not for |
|---|---|---|
| **Sidebar** | Move between top-level modules and sub-sections. | Deep navigation into records. Configuration switching. |
| **Page title** | Name the current page unambiguously. | Restating the module. Editorial description. |
| **Breadcrumb** | Show the path from module home to the current view when the depth > 1. | Redundant with page title. Restating the sidebar's active item. |
| **Tabs** | Switch between views of the same object (record's Details / Activity / Related). | Switching between different objects. Switching between different modules. |
| **Back navigation** | Return to the previous context. | Substitute for a proper "Save & continue" flow. |
| **Deep links** | Land the user on any specific record or filter directly. | (Deep links are always allowed; this row exists to note they are supported.) |
| **Contextual navigation** | Move the user to a related record within the same workflow (member → household → invoice). | Cross-module navigation that skips the sidebar. |
| **Cross-module links** | Jump from one module to a related item in another (invoice → member profile). | Substituting for the sidebar. |

### Prohibited redundancy

- The breadcrumb, page title, and sidebar active state must not all say the same word chain. `Admin › Finance › Finance · Finance` is a bug.
- If the breadcrumb's last segment matches the page title exactly, omit the last breadcrumb segment.
- Tabs do not repeat the page title. If a page's tabs are `Overview / Details / Activity`, the page title is the record name, not `Overview`.

### Naming stability

Module names appear consistently across the product:

- Sidebar item, page title, breadcrumb, and cross-module links use the same casing and word choice for the same module.
- Renaming a module renames it in every reference simultaneously.

---

## 10. Content and Voice

### Voice

Spectre's application voice is:

- **Direct.** Say what the user needs to do or know without preamble.
- **Calm.** No exclamation points. No urgency where the situation does not warrant it.
- **Specific.** Use numbers, names, and dates over generalities. `2 applications since Jul 6` beats `A few applications recently.`
- **Professional.** Full sentences where sentences are needed. No slang.
- **Concise.** One idea per line. If the sentence is under 12 words, say it in 8.
- **Operational.** Written for someone who works here, not someone visiting.

Spectre's voice is not:

- Editorial. No mastheads, no `Volume XVIII`, no italic-serif conditions, no `As of…` document phrasing.
- Promotional. No superlatives ("premium", "world-class", "exceptional").
- Theatrical. No exclamations. No `Congratulations!`. No emoji.
- Cute. No metaphors. No first-person ("Let me…"). No apology.
- Vague. No `some`, `a few`, `several`, `recently` when a number or date is known.
- Overly formal. `Please confirm your intent to publish` is worse than `Publish package?`.
- Metaphorical. No `command centre`, `headquarters`, `morning brief`, `council table`, `situation wall`, `living club`, or any variant.

### Category rules

**Headings.**

- Verb-object or noun. Never a sentence.
- Good: `Applications`, `Reconcile May`, `Board decisions`.
- Bad: `Here are your applications`, `Time to reconcile May`.

**Helper text.**

- One sentence, ≤ 15 words. States the effect or requirement, not the mechanism.
- Good: `Applies to new accounts only.`
- Bad: `Once this is saved, the system will use this value going forward when new accounts are created.`

**Empty states.**

- State that the collection is empty and what the user might do next. Never an illustration alone.
- Good: `No applications waiting. New submissions appear here.`
- Bad: `Nothing here yet!` (with a smiley).

**Warnings.**

- State what will happen and how the user can proceed.
- Good: `Two applications will be waitlisted rather than approved because the fiscal-year cap is met.`
- Bad: `Warning: some applications may not be processed as expected.`

**Confirmations.**

- Name the action, the affected records, and any external effects.
- Good: `Publish May Board Package? · Sends to 5 committee chairs · Cannot be undone from this dialog.`
- Bad: `Are you sure you want to proceed?`

**Errors.**

- State what went wrong, and what the user can do.
- Good: `Batch halted at line 42 — missing account code 4200. Correct the CSV and re-upload.`
- Bad: `An error occurred.`

**Activity feed entries.**

- Actor · verb · object · timestamp. No editorial descriptors.
- Good: `Patricia Bell published May Board Package · 08:14 EDT`.
- Bad: `Patricia has published the wonderful May Board Package!`.

**Status labels.**

- Canonical set (§11). One word or short phrase. Never a sentence.
- Good: `Under review`, `Approved`, `Rejected`.
- Bad: `Is currently under review by the committee`.

**Tooltips.**

- One sentence, ≤ 12 words. Clarify a label; do not restate the label.
- Good: `Applies only to full memberships (not associates).`
- Bad: `This is the dues policy setting.`

---

## 11. Status and State Language

Spectre uses a single canonical vocabulary across every module. Modules do not invent new words for the same state.

### Canonical states

| State | Meaning | Example use |
|---|---|---|
| **Draft** | Created but not submitted; only its author sees it. | Board package before Publish. Manual journal before Post. |
| **Pending** | Submitted, awaiting the next actor. | Import batch awaiting Commit. Notice awaiting Send. |
| **Under review** | Being evaluated by a reviewer. | Application. Applicant document. Change request. |
| **Approved** | Reviewer accepted. Downstream workflow may proceed. | Application. Refund request. |
| **Rejected** | Reviewer declined; record remains for audit. | Application. Refund request. |
| **Published** | Externally visible or distributed. | Board package. Event. |
| **Archived** | Retired but retained; read-only. | Prior fiscal year. Old event. |
| **Reconciled** | Ledger closed against a source; variance is zero (or within tolerance). | Import batch. Bank statement match. |
| **Failed** | System attempted and could not complete. | Payment. Import. Send. |
| **Overdue** | Past a policy deadline. | AR balance. Notice response. |
| **Incomplete** | Missing required data. | Application. Configuration. |
| **Attention required** | The user must act; no more specific label applies. | Any queue item without a workflow-specific label. |
| **No action required** | Explicit confirmation that this state is expected. | Reconciled batches. Approved applications on onboarding hold. |

### Naming rules

- **Never invent a synonym.** If a module needs a new state, either it truly is new (add it to this list) or the intended state already exists.
- **Tense.** All states are present tense. Not `Approved on 2026-07-06` (that is history); the state is `Approved`.
- **Capitalization.** Sentence case in prose and labels (`Under review`). Uppercase in code (`APPROVED`).
- **Badges.** Every state renders in a badge with the label and a semantic colour (Design Language `--spectre-status-*` where applicable). The badge never carries the record identifier.
- **Status history.** Every state transition is recorded with actor, timestamp, and prior state. History renders in reverse chronological order.
- **Effective dates.** When a state has an effective date distinct from its transition date, the effective date appears beside the state (`Under review · Since Jul 6, 2026`).
- **Empty states.** A queue whose state is "no items" states so explicitly (`No applications under review.`).
- **Transitional states.** A record mid-transition (e.g. `Reconciling`) may render in the same badge with a spinner glyph. This is temporary and disappears within seconds; if it persists beyond a threshold, it becomes `Failed`.

### Cross-module prohibition

- **No two modules use different words for the same state.** If Membership uses `Under review` and AR uses `In progress` for the equivalent state, one is wrong.

---

## 12. Interaction Grammar

Defines what happens when the user does something.

### Behaviours

**Opening a record.** Click the primary column (name / number) in a table or list opens the record's detail page. Ctrl / ⌘-click opens in a new tab.

**Editing.** Click an edit affordance (pencil icon, `Edit` button) puts the field or record into edit mode. The current value remains visible until the user commits.

**Saving.** Explicit `Save` button by default. Save renders a loading state and, on success, a toast + a persisted change indicator on the field.

**Autosave.** Only used where saving on every keystroke is expected (notes, comments). Autosave surfaces its state (`Saving…` / `Saved 08:14`) inline. Never used for actions with policy or financial impact.

**Submitting.** For workflows where a state transitions on submit (application submit, refund submit), the button is named for the transition (`Submit application`, not `Save`).

**Publishing.** For records that become externally visible (board packages, events, notices), publish is a distinct action from save, requires confirmation, and records an audit event.

**Deleting.** Requires a modal. Modal states what is deleted, whether it can be undone, and which records reference it.

**Archiving.** Where deletion is disallowed (audit rules), Archive is the equivalent. Archived records remain visible in a `Show archived` filter.

**Restoring.** Every archive is reversible. Restore returns the record to its prior state and records an audit event.

**Filtering.** Filter affordance appears above the collection. Applied filters render as chips beneath the affordance. Every applied filter is dismissible by clicking its chip.

**Sorting.** Column headers indicate sortable columns. Click toggles ascending / descending / (optionally) unsorted. The current sort renders in the header.

**Searching.** Global search opens from the top bar and the sidebar. In-collection search is inline. Results carry the source label (which module / collection they belong to).

**Selecting multiple records.** Row-level checkboxes. Header checkbox toggles all-visible. A persistent bar appears above the table stating the count and offering bulk actions.

**Loading.** Any operation > 300 ms surfaces a loading indicator. For synchronous operations (< 300 ms), no indicator is needed. For asynchronous operations (import, publish, batch), a persistent status renders in the target record and a completion toast fires when the operation resolves.

**Success.** Completes with a toast (top-right, dismissible, auto-hides after 6 s). Toast names the successful action and offers undo where reversible.

**Failure.** Renders an inline error where the failure originated (input field, table row, form). Toast appears if the failure is unattached to a specific control. Error copy follows §10.

**Retrying.** Any failed action offers `Try again` where retry is possible. The retry preserves the user's input.

### Persistence

- Every mutation is persisted before the user is told it succeeded.
- Every mutation is auditable — actor, timestamp, prior state, new state.
- Undo, where offered, is atomic — either the full undo succeeds or nothing changes.

### Confirmation

**Destructive and externally-visible actions require stronger confirmation than reversible internal changes.** Concretely:

- Reversible internal change (change a note, edit an unpublished draft): no confirmation.
- Reversible externally-visible change (rename a published event): confirmation dialog.
- Irreversible action (delete a record where allowed, void a batch): confirmation dialog + user must type or check an explicit acknowledgement.
- Actions that notify third parties (send notices, publish, email): confirmation dialog + count of recipients + a note that this is irreversible from the dialog.

### Contextual retention

- Filter state persists across a session for the same user on the same collection.
- Sort state persists across a session.
- Selection state clears when the user navigates away.
- Search terms do not persist across navigations.

---

## 13. Progressive Disclosure

Every screen renders in two tiers.

### Immediately visible

- Current state.
- Primary action.
- Material exception (if any).
- Key evidence (the two to four figures supporting the primary action).
- Scope (period, tenant, filter).

### On demand

- Full audit trails.
- Technical metadata (record IDs, source system references, raw JSON payloads).
- Secondary settings and preferences.
- Advanced filters.
- Rarely used actions.
- Detailed calculations (e.g. how a rolled-up figure was derived).

### Element choice

| Element | Use for |
|---|---|
| **Expandable row** | Detail of one record within a list, when the summary is enough to triage. |
| **Drawer** | A focused task in the context of another (edit a record without leaving the queue). |
| **Modal** | A required decision that must interrupt (confirmations, blocking errors). |
| **Popover** | A menu, a filter, or a lightweight secondary control. |
| **Dedicated detail page** | Full record content when the user needs the entire record and the whole audit trail. |

### Prohibitions

- Essential evidence must not live behind a hover-only reveal. Hover works for supplementary detail; the decision-critical evidence renders on the primary surface.
- Modals must not carry the only remaining evidence for a decision. If a user has to open a modal to see what they are deciding, the summary belongs on the primary surface.
- Drawers must not carry actions that would benefit from full-page context. If the user needs to see multiple related records to complete the task, use a detail page.

---

## 14. Module Consistency Rules

Modules — Membership, Finance, Operations, Governance, Hospitality, Analytics, Data, Configuration — share structural language and diverge only in domain content.

### Consistent across every module

- **Page hierarchy.** Zone 1 → Zone 2 → Zone 3 → Zone 4 (§7).
- **Action placement.** Primary action attached to the attention state. Page-level actions in Zone 2 top-right.
- **Status treatment.** Canonical states (§11), badge treatment (Design Language), semantic colour (Design Language `--spectre-status-*`).
- **Table behaviour.** Sortable columns, selection checkbox, hover state, primary-column-opens-detail.
- **Feedback.** Loading / success / failure follow §12.
- **Navigation.** Sidebar / breadcrumb / page title (§9).
- **Terminology.** Canonical states (§11), verb-object action labels (§5).
- **Accessibility.** Keyboard operability, focus rings (Design Language `--spectre-shadow-focus`), semantic HTML.

### Allowed to vary between modules

- **Domain data.** The columns of an AR table differ from a Membership queue.
- **Workflow steps.** Board decisions have different states than payment reconciliation.
- **Density.** A settings page for the Chart of Accounts is denser than a Governance module home.
- **Visualizations.** Analytics uses chart primitives; Membership does not.
- **Domain accent.** A module may adopt a subordinate accent (§15 tenant colour is separate). A domain accent applies only to iconography and micro-labels within that module; it never overrides Spectre chrome.
- **Specialized controls.** A tee-sheet grid, a floor-plan editor, a chart-of-accounts tree — each is domain-specific.

**Modules feel related, not identical.** A user who has worked in Membership recognises how to work in Finance because the grammar is the same, not because the layout is the same.

---

## 15. Tenant Branding Rules

### Administration

- Spectre is the product identity. The sidebar identity block reads `Spectre` above the club name.
- Tenant branding contributes: club logo (top of identity block), club name, and `Club.primaryColor` (via `--spectre-accent`).
- Tenant branding never determines: layout, structure, information order, navigation grammar, action grammar, status vocabulary, semantic status colours, or motion.

### Member Portal

- The member surface is club-first. The Spectre wordmark is minimized or hidden per the existing member-brand-shielding rule (see [CLAUDE.md](../../CLAUDE.md)).
- The Member Portal is **out of scope** for this document. Product Language rules apply to Administration only.

### Prohibitions

- Recolouring every component with the club colour. The accent is used on primary CTAs, active nav bars, and focus rings — not on card backgrounds, borders, or supporting chrome.
- Using tenant colours to determine semantic status. Success never becomes red because the club's accent is red.
- Hardcoding tenant identifiers into reusable components. `SpectreClubIdentityPanel` reads the club name from `getActiveBranding()`; it does not carry `Silver Springs` as a literal.

---

## 16. Light and Dark Mode Behaviour

### Light mode

- The primary default.
- Clean and crisp. High clarity. Neutral surfaces (Design Language §2.1).
- Restrained club-accent use. Accent appears on the active nav bar, primary CTAs, and focus rings — nowhere else by default.

### Dark mode

- User-selectable via the top-bar theme toggle.
- Designed independently — not an inverted light theme. Surface deltas, shadow ink, and status colours are defined in Design Language §2.2.
- Graphite rather than pure black. `#0f1012` canvas — not `#000000`.
- Not the defining Spectre identity. A screenshot in dark mode looks like a variant of the same product, not a different product.
- Identical information hierarchy and functionality. The dark theme does not add, remove, or reorder any element.

### Theme rule

**Theme changes appearance only.** It does not change:

- Semantic meaning (a state's colour convention holds).
- Information priority (the same item is the focal point).
- Layout (positions do not shift).
- Density (padding, spacing, and type scale are the same).

A user switching themes mid-task is not surprised by any structural or informational change.

---

## 17. Motion Rules

Motion is functional feedback. It reinforces the meaning of an interaction and never exists to decorate.

### Allowed uses

- **State change.** A row's state transitioning from `Under review` to `Approved` fades between states.
- **Opening / closing.** Drawers, dialogs, popovers, menus, expandable rows.
- **Hierarchy transition.** Focus moves from one control to another; the focus ring appears.
- **Loading.** Skeleton pulse (Design Language `--spectre-motion-*`). Spinner rotation.
- **Reordering.** A list item moved by drag animates to its new position.
- **Focus movement.** The focus ring appears on `:focus-visible`.

### Prohibited uses

- Decorative ambient pulsing (a "live" glow on the shell, a slow gradient rotation).
- Constant shell animation (breathing sidebar, animated logo).
- Motion that delays work (a 400 ms `enter` on a dropdown the user needs immediately).
- Animation that implies real-time activity where none exists.
- Chart or number animation that obscures value accuracy. Numbers snap to their new value; they do not "count up" from zero on every render.

### Durations and easing

Durations and easing are defined by the Design Language (`--spectre-motion-fast` / `--spectre-motion-base` / `--spectre-motion-slow` and `--spectre-ease`). This document does not restate them.

**Reduced motion.** The Design Language scopes `prefers-reduced-motion: reduce` to `[class*="spectre-"]`. This document defers to that rule.

---

## 18. Dashboard Rules

**This section defines rules only. It does not propose a layout or a mockup.**

The Admin Dashboard, when built, must answer in this order:

1. **What requires my attention?** (L1 / L2 items with primary actions.)
2. **What is currently healthy or stable?** (L4 confirmations, current-state summary.)
3. **What changed recently?** (Activity feed relevant to the user's role.)
4. **Where should I go next?** (Passive navigation to modules or specific queues.)

### Requirements

- Attention items must be real and actionable. A dashboard tile that says `Requires attention` without a real record behind it is a bug.
- No decorative narrative. No `Good morning`, no "morning brief", no editorial paragraph.
- No fabricated live activity. The activity feed reflects real audit events. Where the audit stream is empty, say so.
- No equal-weight KPI grid by default. Equal-weight grids are reserved for cases where all KPIs are genuinely equal in priority to the user's next decision.
- No report-like masthead, no `Volume XVIII`, no `Statement of…`, no Roman numeral sections, no long editorial prose. Those belong to the Monthly Reporting Package.
- No imitation of the Monthly Reporting Package's visual or informational language.
- Metrics support decisions. A metric that has no corresponding action or trend has no reason to occupy the dashboard.
- Recent activity requires a real data contract — actor, verb, object, timestamp, link to source.
- Empty states remain useful when no urgent items exist. The dashboard shows the healthy summary and links to the next place the user might want to check.

The dashboard is a Zone 3 workspace (§7) at the module-home scale. Every rule from §7 applies.

---

## 19. Decision Rules for Future Claude Work

When a future UI prompt is incomplete, Claude must follow this decision procedure before proposing an interface.

### Decision tree

1. **What is the user trying to do?** Understand a situation? Make a decision? Take an action? Configure a system? Review after the fact?
2. **What is the primary object or workflow?** A member? An application? A batch? A fiscal period? A configuration?
3. **What requires attention on this screen?** Is there a specific L1 or L2 state, or is the screen a Monitor / Healthy view?
4. **What is the primary action?** State it as `Verb + object` (§5). If it is not obvious, this is a signal that the prompt is under-specified.
5. **What evidence supports the action?** Which two to four facts justify the recommendation?
6. **What history or secondary detail is needed?** Audit? Related records? Change log?
7. **Which existing pattern applies?** Check §20 (Pattern Selection Matrix) before inventing.
8. **Is a new pattern genuinely required?** A new pattern requires a written justification — what makes the existing patterns inadequate for this workflow?

### Rule: prefer a targeted question over invention

When any step above returns "unknown," Claude must ask a targeted question before writing code, wireframe, or mockup. The question must be specific — `What is the primary action on this queue?` beats `How should this look?`.

### Explicit prohibitions on invention

Claude may not invent any of the following without an explicit founder directive naming the invention:

- **New data.** No fabricated figures, no simulated feeds, no "example" data that is not in the actual repository.
- **New workflow steps.** No new states between `Draft` and `Published` unless a state machine already exists.
- **New status logic.** No new colour treatments, no new state names.
- **AI narrative.** No system-generated prose that summarises data without a source citation.
- **Real-time feeds.** No `Live · Refreshes every 30 seconds` label unless the underlying stream is real.
- **Decorative health scores.** No composite gauges, no wellness dials that reduce data to a single number without a documented formula.
- **Domain taxonomies.** No new categories, no new tags, no reclassification of existing records.
- **Editorial metaphors.** No `masthead`, `council table`, `situation wall`, `morning brief`, `command centre`, `living club`, or any variant.

---

## 20. Pattern Selection Matrix

For each user intent, one pattern is preferred. Alternatives are listed only as fallbacks with named conditions.

| User intent | Primary pattern | Anti-pattern |
|---|---|---|
| Review many comparable records | Table | Grid of cards. |
| Work through prioritized items | Queue (list, top-to-bottom) | Kanban board when the workflow is linear. |
| Inspect one record | Detail page | Modal that hides half the record. |
| Change a setting | Form / configuration panel | Inline-editable table for policy-impact settings. |
| Compare trends | Chart with supporting table | Chart alone; user cannot read the exact values. |
| See recent events | Activity list (reverse chronological) | Cards floating in a grid. |
| Complete a short focused task | Modal or drawer | Full-page context switch for a two-field task. |
| Complete a complex workflow | Dedicated page | Modal that forces scroll. |
| Choose one of ≤ 5 mutually-exclusive options | Segmented control or radio group | Select dropdown for 3 options. |
| Choose one of > 5 mutually-exclusive options | Select | Long radio group. |
| Toggle a boolean | Toggle | Checkbox when the effect is immediate. |
| Confirm a boolean commitment | Checkbox with label | Toggle for `I agree to the terms`. |
| Navigate related subareas of one object | Tabs | Sidebar sub-nesting. |
| Navigate major modules | Sidebar | Tabs at the top of every page. |
| Show one figure with one action | Card | Full-width section. |
| Show one figure without an action | Inline text | Card. |

---

## 21. Acceptance Checklist

Every new administrative screen passes the following checklist before implementation is considered complete. Answers are yes/no; a `no` blocks acceptance until resolved.

**Purpose and scope.**
- [ ] The page's purpose is clear from the title and (if present) the one-sentence purpose line.
- [ ] The page's current scope (period, filter, tenant) is stated on the page.

**Focal point.**
- [ ] The page has one dominant focal point per viewport.
- [ ] The primary action is obvious and stated with a verb + object.

**Status and evidence.**
- [ ] Status is legible without colour (accompanied by a text label).
- [ ] Evidence supporting each action is adjacent to that action.
- [ ] Terminology matches the canonical states (§11).

**Layout hygiene.**
- [ ] No unnecessary cards. (Every card wraps a genuinely self-contained module.)
- [ ] No duplicated navigation. (Breadcrumb ≠ page title ≠ sidebar item ≠ tab.)
- [ ] No unsupported narrative. (Every claim traces to a source.)
- [ ] No hardcoded tenant data in reusable components.

**Theme.**
- [ ] The page renders correctly in both light and dark themes.
- [ ] Theme change alters appearance only, not layout or information.

**Accessibility.**
- [ ] Every interactive element is reachable and operable by keyboard.
- [ ] Every icon-only button carries an `aria-label`.
- [ ] Every focus target renders a visible focus ring.
- [ ] Every colour-encoded state also carries a text label or icon.

**Responsive behaviour.**
- [ ] The page adapts to narrow viewports without hiding critical evidence.
- [ ] The primary action remains reachable at every supported viewport.

**Protected surfaces.**
- [ ] The Monthly Reporting Package, POS lounge, Member Portal, and Governance Monthly Package launcher/archive routes remain pixel-identical to baseline.

**Persistence and audit.**
- [ ] Every mutation is persisted before success is announced.
- [ ] Every mutation records an audit event (actor, timestamp, prior state, new state).
- [ ] Reversible actions surface an undo affordance.
- [ ] Irreversible actions require confirmation with named scope.

---

## 22. Worked Examples

Four worked examples using existing Spectre domains. Each example illustrates §1 – §21 without proposing final visual composition — the Design Language governs appearance.

### Example A — Membership application review queue

**User intent.** Work through applications that require a decision.

**Information grammar.** Queue (§3.D).
- Context: `Applications · Silver Springs · Fiscal year 2026`.
- Attention: The count of decisions due (e.g. `2 awaiting review · oldest 6 days`).
- Primary actions: `Review 2 applications` at the top; per-row `Review` links.
- Evidence: For each row — applicant name, household size, sponsorship, days waiting, sponsor.
- History: A drawer or detail-page audit trail per applicant.

**Attention hierarchy.**
- L2 for each awaiting application.
- L1 promotion when an application has been open past the policy threshold (e.g. 10 days).

**Primary action.** `Review N →` on the header. Row action: `Review`.

**Secondary actions.** Bulk `Approve · Reject` after selection. `Filters` (top-right).

**Evidence.** Household composition, sponsorship reference, submission date, days waiting rendered on the row.

**History.** Audit trail per applicant on the detail page.

**Recommended pattern.** Queue with row-level actions (§20).

**Anti-patterns.** Kanban with columns for `Submitted / Under review / Decided` — the user works linearly, not by dragging. Grid of applicant cards — a table compares better.

**Sample copy.**
- Page title: `Applications`.
- Empty state: `No applications waiting. New submissions appear here.`
- Row primary action: `Review`.
- Row secondary label: `Under review · 6 days`.
- Bulk action (2 selected): `Approve 2 · Reject 2`.

### Example B — Accounts receivable collections queue

**User intent.** Send notices to members whose balances have aged past policy.

**Information grammar.** Queue (§3.D) with an aggregate attention statement.
- Context: `Collections · Silver Springs · As of Jul 14, 2026`.
- Attention: `3 accounts require notices · $2,880 over 60 days`.
- Primary actions: `Send 3 notices` on the aggregate header; per-row `Send notice`.
- Evidence: Per row — member name, current balance, days overdue, last notice sent, aged bucket.
- History: The notice history per member on the detail page.

**Attention hierarchy.**
- L2 for each account past 60 days without a recent notice.
- L1 for any account past 120 days.

**Primary action.** `Send N notices`. Per row: `Send notice`.

**Secondary actions.** Filter by aged bucket, days overdue, member. Bulk select rows to send a subset.

**Evidence.** Aged bucket, days overdue, last notice sent, current balance — all on the row.

**History.** Notice audit trail per member.

**Recommended pattern.** Queue with row actions + aggregate primary action (§20).

**Anti-patterns.** A KPI chart of `Total AR` without linkage to the actual accounts. A `Manage collections` button that opens an overview page without listing accounts.

**Sample copy.**
- Page title: `Collections`.
- Aggregate line: `3 accounts require notices · $2,880 over 60 days`.
- Row: `Marie DuPont · $340 · 68 days overdue · Last notice Jun 20 · Send notice →`.
- Empty state: `No accounts past policy. AR is inside band.`

### Example C — Governance board-package publication workflow

**User intent.** Publish the May Board Package to committee chairs.

**Information grammar.** Configuration + confirmation (§3.C with a destructive-visible action).
- Context: `Monthly Package · May 2026 · Silver Springs`.
- Attention: The package is `Draft` and reconciles; the user's next action is `Publish`.
- Primary actions: `Publish package`.
- Evidence: Reconciliation state (`Balanced · Total Assets = Total Liabilities + Equity within $1`), variance detail, sign-off status of each chapter.
- History: Prior publications of packages for other periods.

**Attention hierarchy.**
- L2 while the package is draft.
- L1 if the package fails reconciliation.
- L4 once published.

**Primary action.** `Publish May Board Package`.

**Secondary actions.** `Preview` opens the Monthly Reporting Package view. `Revoke publication` (destructive) once published.

**Evidence.** Reconciliation state, chapter completeness, prior-publication history.

**History.** Prior publications rendered as a table beneath the current one.

**Recommended pattern.** Detail page (§20) — the workflow is complex enough to warrant a page.

**Anti-patterns.** A drawer or modal for the publication itself — the user needs the full reconciliation summary in view.

**Sample copy.**
- Page title: `Monthly Package · May 2026`.
- State line: `Draft · Balanced · Ready to publish`.
- Primary action: `Publish May Board Package`.
- Confirmation modal: `Publish May Board Package? · Sends to 5 committee chairs · Cannot be undone from this dialog.`

**Note.** The **Monthly Reporting Package document itself** is out of scope for this Product Language. This example concerns only the Administration surface that manages the package's lifecycle (draft → published → sent).

### Example D — Chart of Accounts import and mapping workflow

**User intent.** Import a Chart of Accounts from a CSV and map incoming account codes to the internal chart.

**Information grammar.** Configuration + queue hybrid (§3.C + §3.D).
- Context: `Chart of Accounts · Import batch 3427 · Uploaded Jul 14, 06:41`.
- Attention: `47 accounts require mapping · 12 conflicts`.
- Primary actions: `Map 47 accounts` (opens the mapping table). `Resolve 12 conflicts` (opens a filtered mapping view).
- Evidence: Per unmapped account — incoming code, name, type; suggested match; confidence.
- History: Prior imports and their outcome.

**Attention hierarchy.**
- L1 for the conflicts (blocking commit).
- L2 for the unmapped accounts (must resolve before commit).
- L4 once every row is mapped and the batch is ready to commit.

**Primary action.** `Commit import` (after conflicts and unmapped rows resolve). Before that: `Map 47 accounts` and `Resolve 12 conflicts` are the primary actions in sequence.

**Secondary actions.** `Cancel import`, `Download unmatched CSV`, `Undo mapping`.

**Evidence.** For each row — incoming code, incoming name, incoming type, suggested internal match, confidence. Per conflict — which two internal accounts collide, why.

**History.** Prior imports for this club, whether they committed cleanly, who reviewed.

**Recommended pattern.** Table with inline row actions + bulk actions (§20). A separate dedicated page for the batch summary (§20 — complex workflow).

**Anti-patterns.** A wizard that hides the account list behind pagination without letting the user see the shape of the mapping task. A modal-per-row approach — too many context switches.

**Sample copy.**
- Page title: `Chart of Accounts · Import batch 3427`.
- Aggregate line: `47 accounts require mapping · 12 conflicts`.
- Row: `4200 Membership dues (Revenue) → suggested match: 4200 Dues revenue · 92% · Accept · Change`.
- Empty state (after mapping): `All accounts mapped. Ready to commit.`

---

## Reconciliation with the Design Language

This document and [Spectre Design Language.md](./Spectre%20Design%20Language.md) are complementary and non-overlapping.

- The Design Language governs **appearance**: tokens, colour, typography, spacing, radius, shadow, motion, iconography, theme system, component authoring.
- The Product Language governs **information**: what appears, in what order, at what priority, with what action, backed by what evidence, in what state vocabulary.

**Direct conflicts identified.** None. The two documents refer to each other but do not restate each other's rules.

**Deferrals.** When this document refers to a value defined in the Design Language (motion duration, focus ring, status colour), it names the token and does not restate the value. Consumers reference tokens through the Design Language's Tailwind aliases or CSS variables.

**Isolation of the Monthly Reporting Package.** Every rule in this document explicitly excludes the Monthly Reporting Package and its adjacent surfaces. The editorial vocabulary that belongs to those surfaces (mastheads, Roman numerals, italic-serif conditions, long-form executive prose) is prohibited elsewhere.

## Open Questions (require founder decisions)

1. **Domain accents.** §14 permits a subordinate domain accent within each module. The specific palette (or the decision to skip domain accents entirely and rely only on the tenant accent) is not defined here and needs a founder call. Recommendation: skip domain accents for Phase 1; revisit once three or more modules are migrated and consistency has been proven.
2. **Notification channel.** §12 refers to a top-bar notification affordance already present in the shell. The data contract (what qualifies as a notification, retention rules, read/unread state) is not defined here.
3. **Global search.** §9 places search on the sidebar and the top bar. The scope of the search — records only, or records + configuration + help — is not defined here.
4. **Audit event contract.** §12 requires every mutation to record an audit event. The canonical shape (actor, timestamp, prior state, new state, source) is implied here but not formally documented; recommend a companion `docs/design/Audit Event Contract.md` before dashboard work begins.
5. **Empty-state pattern.** §10 requires empty states to be useful. Whether they render as prose only, or prose + a small illustrative glyph, is not defined here. Recommendation: prose only for Phase 1.

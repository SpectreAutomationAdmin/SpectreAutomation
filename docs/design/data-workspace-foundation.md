# Data Workspace Foundation Specification

**Status:** ✅ **Locked 2026-07-18**
**Concept:** `public/design-concepts/data-workspace/chart-of-accounts.html`
**Production component:** `src/components/data-workspace/ChartOfAccountsClient.tsx`
**Production styles:** `src/app/globals.css` — `.spectre-dw-*` `@layer components` block
**First production surface:** `/app/admin/coa` (Chart of Accounts)
**Extends:** the locked **Mission Control Foundation v1.0**
**Composes with:** the token layer in `src/app/globals.css` (unchanged)

The Data Workspace foundation is the shared architecture underneath every
Chart-of-Accounts-shaped page in Spectre: **Trial Balance, Vendors, Members,
Employees, Fixed Assets, Inventory, Budgeting, Journal Entries**. It shipped
in two phases (A · shell + read-only inspector; B · inline editing + saved
views + bulk archive + modal retirement). Every future data-centric module
inherits the primitives below.

## Final production wiring

The concept prescribed a component tree
(`DataWorkspaceHeader / DataWorkspaceToolbar / …`). Production shipped a
consolidated single-file client component
(`ChartOfAccountsClient.tsx`) that inlines every primitive. Each
primitive lives under a stable class name so extraction into shared TS
files can happen incrementally in the second Data Workspace surface
(Trial Balance, Vendors, …) without touching production CoA:

| Class | Primitive |
|---|---|
| `.spectre-dw-header` | Header block (title, meta line, actions) |
| `.spectre-dw-toolbar` | Search + saved-view chip + filter chips + density segment |
| `.spectre-dw-progress` | Fund-applicability progress ribbon (view-conditional) |
| `.spectre-dw-selection` | Selection bar with hidden-count semantics |
| `.spectre-dw-table` | Grouped table with sortable headers, sticky top row |
| `.spectre-dw-group-header` / `.spectre-dw-sub-header` | Type + Category/FS Group headers |
| `.spectre-dw-pill` / `.spectre-dw-val-badge` | Lifecycle pill + validation badge (Active · Inactive · Archived · Warning · Blocked · Control) |
| `.spectre-dw-fund-chip` | Fund applicability chip (Operating · Capital · Both · Unmapped · N/A) |
| `.spectre-dw-row-actions` | Row overflow menu (Edit · Archive · Delete) |
| `.spectre-dw-inspector` | Persistent right-side inspector |
| `.spectre-dw-inspector-banner` | Inspector-level banners (saved · validation · permission) |
| `.spectre-dw-inspector-foot` | Inspector action bar (state-aware Discard / Save / Edit) |
| `.spectre-dw-inspector-empty` | Inspector empty state with keyboard hints |
| `.spectre-dw-view-menu` | Saved-view dropdown |
| `.spectre-dw-input` | Inspector edit input (matches existing `.input` weight but scoped to `.spectre-dw-*`) |
| `.spectre-dw-empty` | View-aware empty states |

Preserved verbatim from the legacy CoA:
- `SectionSelectAllCheckbox` (`src/app/app/admin/coa/SectionSelectAllCheckbox.tsx`) — the per-FS-group select-all in fund mode.
- The Prisma read model: `account.findMany` + `clubProfile.findUnique` + `accountCategory.findMany` + `financialStatementGroup.findMany` + `department.findMany`.
- Every existing `data-testid` on the DOM shape the e2e suite queries.

## Server actions

Phase B added two new server actions to `src/app/app/admin/coa/_actions.ts`;
the four legacy actions are unchanged.

| Action | Shape | Used by |
|---|---|---|
| `createAccountAction` | `(formData) → redirect` | `?modal=new` create-modal form |
| `updateAccountAction` | `(formData) → redirect` | Legacy compatibility — still exported, still redirects. No production caller reaches this on the CoA page today; kept because external forms and tests may submit directly. |
| `archiveAccountAction` | `(formData) → redirect` | Row overflow menu (single-row archive) |
| `reactivateAccountAction` | `(formData) → redirect` | Row overflow menu (single-row reactivate) |
| `deleteAccountAction` | `(formData) → redirect` | `?delete=<id>` DeleteModal confirm |
| `bulkSetFundApplicabilityAction` | `(formData) → redirect` | `?mode=fund` bulk fund form |
| **`updateAccountInspectorAction`** (Phase B) | `(formData) → discriminated result` | Inspector inline save. Delegates to the same `updateAccount(...)` service so every business rule fires identically. Returns `{ status: "saved" \| "validation-error" \| "permission-denied" \| "server-error" }`. |
| **`bulkArchiveAccountsAction`** (Phase B) | `(formData) → redirect` | Selection-bar bulk archive. Loops over selected IDs delegating each to `archiveAccount(...)`; per-row failures aggregated into the warning banner. |

The two new actions are thin adapters — every business rule (validation,
tenant scoping, audit log, posting guard) still lives in
`@/lib/accounting/coa`. There is one and only one production write path
per business operation.

## Saved views (final)

Six views ship. Every one has a stable URL alias.

| View | Filter | URL | Where predicate runs |
|------|--------|-----|-----|
| All active | `isActive = true` | (default) | Server (query) |
| Needs attention | `fundValidation !== "ok"` | `?view=needs-attention` | Client (workspace) |
| Unassigned FS group | `fsGroupKey === "__no_fs_group__"` | `?view=unassigned-fs` | Client (workspace) |
| Fund applicability | `type IN {REVENUE, EXPENSE}` | `?mode=fund` (preserved alias) | Server (query) |
| Inactive accounts | `isActive = false` | `?showInactive=1` (preserved alias) | Server (query) |
| Recently changed | `updatedAt >= now() - 7 days` | `?view=recently-changed` | Client (workspace) |

## URL grammar

Every legacy URL preserved unchanged; three added.

| URL | Behaviour |
|-----|-----------|
| `?modal=new` | Legacy — opens `<AccountModal>` in create mode |
| `?edit=<id>` | Phase B — opens the inspector in edit mode (was: opened the legacy modal) |
| `?delete=<id>` | Legacy — opens `<DeleteModal>` with safety preflight |
| `?mode=fund` | Legacy — enters Fund Applicability saved view |
| `?showInactive=1` | Legacy — enables the Inactive accounts saved view |
| `?fund=OPERATING\|CAPITAL\|BOTH\|NONE` | Legacy — fund chip filter |
| `?ok=<verb>&num=<n>` | Legacy — success banner after redirect |
| `?warning=<msg>` | Legacy — amber banner |
| `?error=<msg>` | Legacy — red banner |
| `?select=<id>` | Phase A — opens the inspector in viewing mode |
| `?view=needs-attention` | Phase B — Needs attention saved view |
| `?view=unassigned-fs` | Phase B — Unassigned FS group saved view |
| `?view=recently-changed` | Phase B — Recently changed saved view |

## Save contract

Explicit save, no autosave.

1. User clicks a row → inspector opens in `viewing` mode (`?select=<id>`).
2. User clicks Edit → inspector transitions to `editing` (`?edit=<id>`).
3. User modifies any field → transitions to `editing` (dirty).
4. User clicks Save changes:
   - Client calls `updateAccountInspectorAction(fd)` inside a `useTransition`.
   - Server enforces every business rule via `updateAccount(...)` in the service.
   - On success: inspector transitions to `saved`; `router.refresh()` re-runs the RSC to pick up fresh row data; the inspector stays open on the same row; the group headers / progress ribbon update automatically.
   - On validation error: inspector transitions to `validation`; the banner shows the server's `safeMessage`; Save is disabled until the operator edits a field (which returns them to editing).
   - On permission denied: inspector transitions to `permission-denied`; the banner shows the standard disabled-tooltip copy.
5. Discard: prompts the operator if dirty; clears the baseline; returns to `viewing`.

## Keyboard model

- `⌘F` / `/` focus workspace search.
- Row click opens the inspector in viewing mode.
- Edit / Discard buttons drive the inspector state machine.
- `Esc` closes the inspector, with a discard-confirmation guard when dirty.

## Extension checklist for the next Data Workspace surface

Every new surface (Trial Balance / Vendors / Members / Employees / Fixed
Assets / Inventory / Budgeting / Journal Entries) should:

1. Reuse the `.spectre-dw-*` CSS layer verbatim — no new tokens.
2. Serialise its rows into a shape analogous to `DwAccountRow` and pass them into a workspace-specific client component modelled on `ChartOfAccountsClient.tsx`.
3. Preserve every existing URL param the current production page recognises.
4. Preserve every existing `data-testid` the e2e suite queries.
5. Add an inspector-shaped server action (analogous to `updateAccountInspectorAction`) that delegates to the surface's existing service layer.
6. If the surface has a New / Delete modal today, keep them on their existing URL entries during the integration; retire them only after inspector parity is proven.
7. Extract shared primitives (`DataWorkspaceHeader`, `DataWorkspaceTable`, `DataWorkspaceInspector`) into `src/components/data-workspace/` only when the second consumer actually needs them. Do not pre-abstract.

This is an implementation reference, not a philosophy. Every section defines
a reusable primitive that will underpin **Trial Balance · Vendors · Members
· Employees · Fixed Assets · Inventory · Budgeting · Journal Entries**. The
concept demonstrates the primitives against Chart of Accounts — the pattern
generalises.

## 1 · Layout skeleton

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Sidebar (232 px)  │  Top bar                                           │
│                    ├───────────────────────────────────────────────────┤
│                    │  Save toast (transient, per-URL-param)             │
│                    │  Header line     (title, contextual meta, actions) │
│                    │  Toolbar         (search, view, filters, density)  │
│                    │  Progress ribbon (view-conditional)                │
│                    │  Selection bar   (contextual)                      │
│                    ├─────────────────────────────┬────────────────────┤
│                    │  Data table                 │  Inspector panel   │
│                    │  (scrollable)               │  (400 px)          │
│                    │                             │                    │
│                    │                             │                    │
│                    ├─────────────────────────────┴────────────────────┤
│                    │  Pattern reference (dev-visible via URL only)     │
└────────────────────┴───────────────────────────────────────────────────┘
```

**Column widths.** Sidebar 232 px, inspector 400 px, table grows. Inspector
is not a modal — it is part of the grid.

**Vertical padding.** Header block 18 / 32 / 14 / 32. Toolbar 10 / 32.
Selection bar 8 / 32. Table body density-driven (see §7).

## 2 · Workspace header

Every workspace shows the same six things in the same shape:

1. **Crumbs eyebrow** — one line, muted, `Finance · General Ledger`.
2. **Title** — 22 px semibold. This is the largest text on the page.
3. **Meta line** — the operational context: `<schema-hint> · <n> records, <m> active · Last updated <when> by <who> · <period-hint>`. Every value in `<b>` tabular numerals.
4. **Secondary actions** — Import / Export (no dropdown menus; if you want them, use two buttons).
5. **Primary action** — one filled green button with a keyboard-shortcut kbd hint appended (e.g. `+ New account [N]`).
6. **No hero banner, no illustration, no marketing copy.**

## 3 · Toolbar

Six controls, always left-to-right in this order:

| Order | Control | Behaviour |
|------:|---------|-----------|
| 1 | **Search** | 300 px input with pre-blob (§5). `⌘F` and `/` focus it. Debounced 120 ms. Non-empty state shows an ✕ clear affordance. |
| 2 | **Saved view** | Icon + `View:` label + active view name + chevron. Persists across sessions per user. |
| 3 | **Type filter** | `Type: All ▾`. One filter per commonly-scoped field. |
| 4 | **Fund filter** | `Fund: All ▾` (CoA-specific example; on Vendors this would be `Vendor group`, etc.) |
| 5 | **Department filter** | `Department: Any ▾` |
| — | (grow) | pushes the density control right |
| 6 | **Density** | Segmented control: `Comfy · Standard · Compact`. |
| 7 | **Columns** | Chip with an icon; opens a picker (deferred to phase 2 of integration). |

**Rules.**

- The toolbar is not a ribbon. If a control needs more than one row, it belongs somewhere else (the header, the inspector, or a saved view).
- Filters use a single `Key: Value ▾` chip pattern. Never inline sliders, date pickers, or multi-value tag inputs directly on the toolbar.
- Active filters compose with the selection state (§8) — a selection persists when filters change.

## 4 · Saved views

Six views ship with the Chart-of-Accounts implementation. Each has a stable
URL alias so bookmarks and deep-links keep working.

| View | Filter definition | URL alias | Shows |
|------|-------------------|-----------|-------|
| All active | `isActive = true` | (default) | Default operating view |
| Needs attention | `validation.state ∈ {warning, blocked}` | `?view=needs-attention` | Rows the operator must look at before month-end |
| Unassigned FS group | `fsGroupId IS NULL` | `?view=unassigned-fs` | Setup / migration completeness |
| Fund applicability | `type ∈ {REVENUE, EXPENSE}` | `?mode=fund` (preserved alias) | Bulk fund-assignment workflow |
| Inactive accounts | `isActive = false` | `?showInactive=1` (preserved alias) | Archive review |
| Recently changed | `updatedAt >= now() - 7d` | `?view=recently-changed` | Audit / handover |

When a saved view is active:
- The view chip shows the view's name.
- The URL reflects the view.
- Filters can still be added on top (they compose).
- The `Type` / `Fund` / `Department` chips remain interactive and stack with the view's filter.

## 5 · Search

Client-side, `contains`, case-insensitive, over a pre-computed per-row blob:

```
data-search-blob="<number> <name> <type> <category> <fs-group> <department> <fund>"
```

For CoA (approximately 200 rows at scale), no server search is needed. When a
future workspace exceeds ~5,000 client-side rows, this pattern promotes to a
server-side `?q=` param with the same blob, indexed at write time.

- `⌘F` and `/` focus the input.
- Search state lives in `?q=<text>` — refresh preserves.
- Empty-results state (§14) triggers when 0 rows match a non-empty query.
- Search does **not** clear selection (§8).

## 6 · Table

The table is the surface every workspace uses. It uses one CSS class family
(`.dw` on the table, `.dw-group-header` / `.dw-subgroup-header` on rows) and
composes with the token layer.

### 6.1 · Columns (Chart of Accounts default view)

Nine columns; every one earns its place. Additional columns via the Columns
picker (phase 2).

| Column | Purpose | Notes |
|--------|---------|-------|
| Select | Bulk-action affordance | 40 px, always column 1. Indeterminate root check. |
| Assign (fund view only) | Op / Cap checkbox pair | Only visible when `?view=fund-applicability` |
| Number | Primary identifier | 76 px, mono, semibold |
| Name | Human label + secondary caption | Flexible; caption inherits density from §7 |
| FS group | Reporting classification | 152 px |
| Fund | Fund applicability | 108 px, uses chip vocabulary (Op / Cap / Both / N/A / Unmapped) |
| Balance | Numeric | 120 px, right-aligned, cents desaturated |
| Status | Lifecycle + validation | 140 px, two-part cell (§10) |
| Actions | Row overflow | 40 px, three-dot menu |

### 6.2 · Header row

- Sticky at scroll (`position: sticky; top: 0`).
- 10.5 px letter-spaced label styling.
- Sortable columns show a chevron (visual in concept; wire in phase 2 of integration).

### 6.3 · Frozen columns

**Do not enable by default.** The nine-column default view fits every
supported viewport with no horizontal scroll. If a future workspace (e.g.
Trial Balance with 12 columns × 12 months = 24 columns) genuinely needs
horizontal navigation, freeze the leftmost identifying column only. Never
freeze for decoration.

## 7 · Density

Three modes, one CSS variable set per mode. Standard is default.

| Mode | Row height | Padding-y | Name font | Subtitle |
|------|-----------:|----------:|----------:|:---------|
| Comfortable | 48 px | 12 px | 14 px | visible |
| **Standard (default)** | **36 px** | **8 px** | **13 px** | **visible** |
| Compact | 28 px | 4 px | 12.5 px | hidden |

- Standard prioritises scan speed over row count — a Controller on a 1440 × 900
  laptop should see roughly 15 rows at once, not 30.
- Compact mode is the only mode that hides the row subtitle. If the subtitle
  is load-bearing for the current workspace (e.g. Trial Balance with account
  descriptions), Compact still shows it — configurable per workspace.

## 8 · Selection

**Rule:** selected records persist when filters, search, or saved views change,
unless the operator explicitly clears the selection.

### 8.1 · Selection bar

Appears above the table when `selectedIds.size > 0`.

```
Normal:                   3 accounts selected                          Assign fund…  Assign department…  Archive  Clear selection
Some hidden by filters:   5 accounts selected · 2 hidden by current filters   Show selected  Clear hidden  Clear all
```

- **Normal state** — green tint (`--spectre-status-success-bg`), left-tinted border.
- **Hidden state** — amber tint (`--spectre-status-warning-bg`), same shape.
- Amber is used because it is an observation the operator must be aware of, not a problem.

### 8.2 · Actions

- **Show selected** — clears the current filter/view and switches to a virtual view of just the selected records.
- **Clear hidden** — deselects records that are not currently visible; keeps visible selections intact.
- **Clear selection / Clear all** — deselects everything.
- **Bulk action button (e.g. Assign fund…)** — must show the full selected count in its confirm dialog, even when some are hidden. Never bulk-act on visible-only silently.

### 8.3 · Selection contract

- Selection lives client-side; not URL-persisted (too easy to compose an
  unshareable-length URL).
- **Never silently clear selection** when a filter or view changes.
- Never apply a bulk action without displaying the full selected-record count.

## 9 · Hierarchy (grouping)

Two-level grouping is the default:

```
Group header    →   Account Type (Assets / Liabilities / Equity / Revenue / Expenses)
Sub-group       →   Category or FS Group (e.g. "Current · Cash & equivalents")
Row             →   Individual account
```

- **Group header** — 30 px tall, `--canvas` background, uppercase label, count meta, validation badge (when present), running total right-aligned. Clickable to collapse; collapsed state persists per session.
- **Sub-group header** — 24 px tall, `--surface` background, dashed bottom border, muted uppercase label + running total right-aligned. Not collapsible.
- **Row** — density-driven; every row inside a group inherits its collapse state.

Group headers must never be ornamental. They exist to (a) let the operator jump/collapse, (b) show validation counts, (c) show subtotals.

## 10 · Status vocabulary

Three orthogonal state families. Never mix.

### 10.1 · Lifecycle status (mandatory)

Every row shows exactly one lifecycle pill:

| Pill | Meaning | Colour |
|------|---------|--------|
| `Active` | Row participates in the ledger | Green |
| `Inactive` | Row is soft-deleted; hidden from default filters | Muted grey |
| `Archived` | Row is retained for audit; will never participate again | Muted grey with hollow dot |

### 10.2 · Validation state (optional)

Coexists with lifecycle. Appears **next to** the lifecycle pill.

| Badge | Meaning | Colour |
|-------|---------|--------|
| — | Row is valid (no badge shown) | — |
| `Warning` (△) | Row can still post but the operator should look before month-end | Amber |
| `Blocked` (⦸) | Row cannot post entries until the operator fixes something | Red |

Every validation state combines colour with an icon **and** a text label —
never colour alone. Combined with a left-edge row stripe (§10.4).

### 10.3 · Workflow status (workspace-specific, optional)

Only shown when the workspace has a distinct workflow lifecycle (e.g. Journal
Entries: Draft / Pending review / Approved). For Chart of Accounts, workflow
status is not shown because every account is either operating in the ledger
or archived.

### 10.4 · Row-level left stripe

Complements the pill/badge combination. Consumes 3 px of the row's left
padding.

| Stripe | Meaning |
|--------|---------|
| Transparent | Valid |
| Amber | Row has a Warning validation |
| Red | Row has a Blocked validation |

Combining stripe + badge + prose (in the row's description slot) gives three
signals for the same fact — legible at any density, works for colour-blind
operators, survives print.

## 11 · Inspector

The inspector is a persistent right-side panel, not a modal. It is part of the
grid.

### 11.1 · States

The inspector has six mutually exclusive states, driven by URL:

| State | URL | Body |
|-------|-----|------|
| `empty` | (no `?edit` / `?select`) | Illustrated empty state with keyboard hints; primary "+ New account" button |
| `reader` | `?select=<id>` | Read-only detail view; footer has an **Edit** button |
| `editing` | `?edit=<id>` | Fields editable; footer has **Discard** (tertiary) + **Save changes** (disabled) |
| `unsaved` | `?edit=<id>&dirty=1` | Amber "You have unsaved changes" indicator; **Save changes** enabled |
| `validation` | `?edit=<id>&err=1` | Red banner + per-field help.err; **Save changes** disabled |
| `saved` | `?edit=<id>&saved=1` | Green "Saved" banner at top; fields return to editing mode; toast auto-dismisses at 5 s (in production; static in concept) |

### 11.2 · Header

- Eyebrow: `Account · selected from Chart of Accounts` + × close button.
- Title: mono number + serif-weight name (both large).
- Meta: lifecycle pill + `Modified <when> by <who>`.

### 11.3 · Tabs

Four tabs, in order: **Details · Rules · Activity · Audit**.

- **Details** — the field set (see §11.5).
- **Rules** — posting rules, close-out behaviour, journal templates.
- **Activity** — last N journal entries touching this account.
- **Audit** — the change history for the record itself.

### 11.4 · Body layout

Field grid: 120 px label column + 1 fr value column. Every field row has a
dashed bottom border for structural rhythm. Field grouping via `.field-group`
when two selects belong together (e.g. Operating / Capital fund pair).

Field help copy: 11 px muted; validation-error help is red with an icon.

### 11.5 · Field set (Chart of Accounts)

Every production field is preserved (see parity matrix). Order:

1. Number
2. Name
3. Description
4. Type
5. Category
6. FS Group
7. Fund applicability (paired selects)
8. Department
9. Parent account
10. Flags (Reconcilable, Allow manual posting, Control account, Tax-relevant)

### 11.6 · Footer

Persistent action bar: status text on the left, action cluster on the right.

- **Reader state** — status "Read only — press Edit to modify". Action: **Edit**.
- **Editing state** — status "Editing — no changes yet". Actions: **Discard** (tertiary), **Save changes** (disabled).
- **Unsaved state** — status "You have unsaved changes" (amber dot). Actions: **Discard**, **Save changes** (primary).
- **Validation state** — status "1 field needs attention" (red dot). Actions: **Discard**, **Save changes** (disabled).
- **Saved state** — status "Saved at 08:14 EDT" (green dot). Same actions as editing.

## 12 · URL state

The workspace URL is the source of truth for every visible piece of context.
Refresh preserves state. Browser Back is well-defined.

| Concern | URL param |
|---------|-----------|
| Selected account (reader) | `?select=<id>` |
| Selected account (editing) | `?edit=<id>` |
| Dirty edit state | `?edit=<id>&dirty=1` |
| Validation error | `?edit=<id>&err=1` |
| Save success toast | `?edit=<id>&saved=1` |
| Saved view | `?view=<name>` |
| Fund mode (aliased view) | `?mode=fund` |
| Show inactive (aliased view) | `?showInactive=1` |
| Fund chip filter | `?fund=OPERATING\|CAPITAL\|BOTH\|NONE` |
| Search text | `?q=<text>` |
| Success banner | `?ok=<verb>[&num=<n>]` |
| Warning banner | `?warning=<msg>` |
| Error banner | `?error=<msg>` |
| Density | `?density=<mode>` (persisted per user; URL only when explicitly set) |
| New account modal (legacy) | `?modal=new` (redirects to `?edit=new` internally) |
| Delete confirmation (legacy) | `?delete=<id>` (opens inspector confirm-delete) |

The concept uses `#` hash instead of `?` query params because it renders as a
static HTML file. The production integration must use `?` query params (they
already exist and must be preserved).

## 13 · Save contract

**No autosave.** Accounting master data changes require deliberate confirmation.

The save contract:

1. Operator opens an account. Inspector renders in `reader` state.
2. Operator clicks **Edit**. Inspector switches to `editing`.
3. Operator changes any field. Inspector switches to `unsaved`.
4. Operator can:
   - Click **Save changes** — validation runs first; on success, `saved` state; on failure, `validation` state with per-field errors.
   - Click **Discard** — confirm modal only if there are unsaved changes; otherwise close inspector.
   - Close the inspector (× button, Esc key, click a different row) — confirm modal if unsaved changes.
5. On successful save:
   - Server action `updateAccountAction` is called with the full form payload including the `_fundApplicabilityForm` sentinel.
   - Server redirects to `?edit=<id>&ok=updated`, which renders the `saved` state.
   - Toast at the workspace top displays for 5 s, then dismisses.
   - Inspector remains open in `editing` state so the operator can continue.

**Never save on field blur. Never save on inspector close. Never save on
route change.** Every save is an explicit action.

## 14 · Empty states

Every workspace has three empty states.

### 14.1 · No data (workspace has zero records ever)

> **Excellent. Nothing to review here yet.**
>
> This is the first time you're seeing the Chart of Accounts. Start by
> creating an operating checking account or importing from your prior
> system.
>
> [+ New account]  [Import from CSV]

### 14.2 · No results (search or filter yields zero)

> **No accounts match your search.**
>
> Try adjusting the search text, changing the saved view to **All active**,
> or clearing filters. Chart of Accounts is scoped to the Silver Springs
> GAAP fund structure — accounts you can see here are the ones your role
> has permission to view.
>
> [Clear search]  [Show all active]  [Create a new account]

### 14.3 · Inspector empty (no row selected)

> **Select an account to inspect.**
>
> Pick a row on the left to see its details, posting rules, activity, and
> audit history. Editing happens inside this panel — the URL always
> reflects the selected account, so refreshing or sharing the link opens
> the same view.
>
> → Press **/** or **⌘F** to search
> → Press **N** for a new account
> → Use **↑ ↓** to move the highlight, **Enter** to open
> → Press **Esc** to close the inspector

**Rule:** Never write `"No records."`, `"No results."`, or `"Nothing here."`.
Every empty state explains why, what to do next, and what Spectre can help
with.

## 15 · Keyboard model

Every workspace supports this interaction model out of the box.

| Key | Context | Action |
|-----|---------|--------|
| `⌘F` / `Ctrl+F` | Anywhere | Focus workspace search |
| `/` | Not inside a form field | Focus workspace search |
| `↑` / `↓` | Table has focus | Move row highlight |
| `Enter` | Row is highlighted | Open inspector for that row |
| `Esc` | Inspector open, unsaved changes | Prompt to save / discard |
| `Esc` | Inspector open, no unsaved changes | Close inspector (return to `empty`) |
| `Esc` | Inspector already closed | Nothing (never override browser default) |
| `N` | Not inside a form field, no inspector open | Open inspector in create mode |

The browser's own shortcuts are preserved. `⌘F` overrides browser find
because a Chart of Accounts search is more useful than the browser's DOM
find on this page. All other shortcuts route through the window keydown
listener and check `!inField` before firing.

## 16 · Illustrative AI recommendations

The concept demonstrates the visual language for AI recommendations, in a
labelled reference block at the bottom of the workspace. It is **not shipped
as live functionality**.

An AI recommendation must:

1. Live in a distinct visual band with an `Illustrative recommendation` or
   equivalent eyebrow.
2. Explain the evidence in short bullet form.
3. Offer at least one non-destructive action (Review, Investigate, …) and one
   dismiss action.
4. Never suggest an irreversible action from the row itself. Any irreversible
   action must be executed by the operator through the inspector.
5. Carry a footer disclaimer when it is not backed by a live service.

The reference example in the concept:

> **Illustrative recommendation**
> Consider retiring account 1020 · Money market
>
> This account has had **no activity for 26 months** and appears to overlap
> with account **1000 · Operating checking** (same institution, same fund).
>
> · Last posted transaction: 2024-05-14
> · Same fund (Operating), same tax region
> · Zero balance activity since 2024-05-14
>
> [Review activity]  [Dismiss]
>
> *Pattern reference only · not connected to a live recommendation service.*

**When a production AI service exists**, the disclaimer is removed and the
recommendation is placed inline with the affected row (with the same visual
band and the same evidence + action requirements).

## 17 · Composition across the other workspaces

The same primitives compose across every Data Workspace target:

| Workspace | What changes | What stays the same |
|-----------|--------------|---------------------|
| Trial Balance | Columns = period buckets. No inspector edit (read-only). | Header, toolbar, saved views, search, status vocabulary, keyboard model |
| Vendors | Grouping by vendor group (or none). Different Flags. Inspector has an "Invoices" tab. | Every other primitive |
| Members | Rich header (photo?), grouping by category. Inspector has "Statements", "Access", "Notes" tabs. | Every other primitive |
| Employees | Grouping by department. Inspector has "Timesheet" tab. | Every other primitive |
| Fixed Assets | Adds "Depreciation" tab. Balance column becomes NBV. | Every other primitive |
| Inventory | Adds "Reorder" tab, "Location" grouping. | Every other primitive |
| Budgeting | Read-mostly; a distinct "Adjust" mode. | Every other primitive |
| Journal Entries | Workflow status (Draft / Pending / Approved) becomes the primary state. | Every other primitive |

Every extension is an additive tab, an additive column, or an additive saved
view. No workspace should re-invent the header, the toolbar, the status
vocabulary, or the keyboard model.

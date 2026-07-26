# Data Workspace — Chart of Accounts Functional Parity Matrix

**Status:** Concept sprint · 2026-07-18
**Concept:** `public/design-concepts/data-workspace/chart-of-accounts.html`
**Production:** `src/app/app/admin/coa/page.tsx` — **do not modify during this sprint**

This matrix is the source of truth for the future integration. Every row is a
capability the production page has today. The concept column records how (or
whether) the capability is expressed. The integration-requirement column
records what must be true before the concept can safely replace the production
page.

Legend: **✅** covered · **✏️** covered with a change · **➡️** deferred to a
later sprint · **❌** intentionally removed (documented reason).

## Read model & navigation

| Capability | Production today | Concept | Future integration requirement |
|---|---|---|---|
| Route | `/app/admin/coa` (`page.tsx:35`) | Same route (concept is a mockup at `public/design-concepts/data-workspace/chart-of-accounts.html`) | Replace `page.tsx` body; keep the route unchanged |
| Read permission | `coa:read` gate; redirect to `/app/admin` on failure (`page.tsx:107`) | ✅ Not shown (mockup renders as authorised viewer) | Preserve `coa:read` guard in the new page RSC |
| Write permission | `coa:write` gate; controls stay visible but disabled with `DISABLED_TOOLTIP` (`page.tsx:55, 785`) | ✅ Not shown (mockup renders as authorised editor) | Preserve the same-shape disabled state on inspector controls, chips, primary button |
| Tenancy | `getActiveClubId` + tenant-scoped Prisma queries (`page.tsx:38, 132-142`) | N/A (static seed data) | Preserve tenant scoping unchanged |
| Prisma read model | `Promise.all` of 5 queries — accounts (with `category`, `fsGroup`, `defaultDepartment`, `parent`), `ClubProfile` for control-account FKs, categories, FS groups, departments (`page.tsx:132-142`) | ✅ Represented via seed rows | Reuse the exact query shape; no schema changes |
| Sort order | Fixed `accountNumber asc`, then `TYPE_ORDER` → `category.sortOrder` → `fsGroup.sortOrder` (`page.tsx:45, 235-244`) | ✏️ Default sort by number; header exposes sort affordance on Number / Name / Balance (visual only in concept) | Server-side sort switching. Ship with fixed `accountNumber asc` in phase 1 |
| Hidden group buckets | Empty type buckets are not rendered (`page.tsx:516`) | ✅ Concept only ships types with data | Preserve empty-bucket skipping |

## URL surface

| Capability | Production today | Concept | Future integration requirement |
|---|---|---|---|
| `?modal=new` opens New Account form | `AccountModal mode="new"` overlay (`page.tsx:251, 738`) | ✏️ Inspector opens in create mode; URL becomes `?new=1` | Support both — accept legacy `?modal=new` and redirect to `?new=1` (or vice-versa) during transition |
| `?edit=<id>` opens Edit form | `AccountModal mode="edit"` overlay (`page.tsx:252-256, 747`) | ✅ Same param, opens inspector in editing mode | Preserve `?edit=<id>` verbatim so bookmarks and deep-links continue to work |
| `?delete=<id>` opens delete confirmation | `DeleteModal` with preflight safety check (`page.tsx:253, 757`) | ✏️ Not surfaced in the default concept; delete moves to a per-row action inside the inspector footer overflow menu | Preserve `?delete=<id>` as a URL entry point that opens the inspector's confirm-delete affordance |
| `?showInactive=1` | Filter toggle (`page.tsx:109-110`) | ✅ Represented via saved view "Inactive accounts" + a global toggle in the toolbar's density row | Preserve `?showInactive=1` as an aliased URL for the "Inactive accounts" saved view |
| `?fund=OPERATING\|CAPITAL\|BOTH\|NONE` | In-memory filter chip (`page.tsx:114-118, 155-172`) | ✅ Fund chip in toolbar accepts the same value set | Preserve `?fund=…` verbatim |
| `?mode=fund` | Fund-applicability assignment mode (`page.tsx:124, 161`) | ✅ Saved view "Fund applicability" — same behaviour, better presentation | Preserve `?mode=fund` as an aliased URL for the saved view; keep the sentinel column and per-row checkbox for parity |
| `?ok=` success banner | Six values: `created \| updated \| archived \| reactivated \| deleted \| bulk-fund` (`page.tsx:267-282`) | ✅ Green save toast at top of workspace; also shown as inspector-header banner for edit/save flow | Preserve `?ok=` for the redirect-post-action pattern; render the toast for 5 seconds then dismiss |
| `?warning=<msg>` amber banner | Co-render with success or standalone (`page.tsx:276-290`) | ✅ Amber inline banner directly above the header row | Preserve; keep the warning distinct from validation state |
| `?error=<msg>` red banner | Server error surface (`page.tsx:291-298`) | ✅ Red inline banner directly above the header row | Preserve; keep distinct from row-level validation |
| `?num=<n>` companion to `?ok=bulk-fund` | Count of accounts affected (`page.tsx:1163-1172`) | ✅ Same param drives "5 accounts assigned" in the success toast | Preserve |

## Filter, view, and toolbar controls

| Capability | Production today | Concept | Future integration requirement |
|---|---|---|---|
| Show/Hide inactive link | Header link toggling `?showInactive=1` (`page.tsx:365-371`) | ✏️ Moved into the saved view "Inactive accounts" + a persistent chip when active | Add saved view; keep the URL alias |
| Fund mode enter / exit | Header buttons switching `?mode=fund` (`page.tsx:376-392`) | ✏️ Saved view chip; also a link/button in the header title meta | Preserve the URL alias |
| Fund filter chips (5) | All / Operating / Capital / Both / Unmapped (`page.tsx:419-460`) | ✅ Same five values; presented in a single "Fund: X" chip that opens a dropdown | Preserve URL contract |
| Sort control | None (fixed `accountNumber asc`) | ✏️ Header adds sortable Number / Name / Balance (visual only in concept) | Ship non-sortable in phase 1; add real sort switching in a later slice |
| Column order / visibility | None | ✏️ Toolbar "Columns" chip (visual only in concept) | Deferred → phase 2 of workspace foundation |
| Density | None | ✅ Segmented control (Comfortable / Standard / Compact) writes `#density=<mode>` | Persist per user via localStorage; no URL contract needed |
| Saved views | None | ✅ Six views: All active · Needs attention · Unassigned FS group · Fund applicability · Inactive accounts · Recently changed | Ship "All active" + "Fund applicability" + "Inactive accounts" in phase 1; the other three in phase 2 |
| Global search | None | ✅ Debounced client-side `contains` over `data-search-blob` per row | Phase 1: client-side `contains` over pre-computed search text. Phase 2 (only if we need it): server-side |

## Row-level actions

| Capability | Production today | Concept | Future integration requirement |
|---|---|---|---|
| Name → account ledger | Link to `/app/admin/gl/account/{id}` (`page.tsx:624-629`) | ✅ Preserved as the row's aux-open target; also available from the inspector "Activity" tab | Preserve the link |
| Edit action | `?edit=<id>` (`page.tsx:686-692`) | ✅ Opens inspector in editing mode | Preserve URL contract |
| Archive action | Form POST to `archiveAccountAction` (`page.tsx:693-698`) | ✏️ Moved into per-row overflow menu (⋯) and inspector-footer overflow | Preserve the server action; wire the overflow menu to it |
| Reactivate action | Form POST to `reactivateAccountAction` (`page.tsx:699-705`) | ✏️ Same as Archive — surfaces when lifecycle = Inactive | Preserve the server action |
| Delete action | `?delete=<id>` (`page.tsx:706-712`) | ✏️ Overflow-menu entry with delete-safety preflight | Preserve URL contract; preserve `checkAccountDeletionSafety` fall-through to Archive |
| Row-action disable when `!canEdit` | Same `data-testid`, span rendered as disabled (`page.tsx:785-796`) | ➡️ Not shown in the concept | Preserve exact `data-testid` set for e2e regression |

## Bulk / fund-applicability workflow

| Capability | Production today | Concept | Future integration requirement |
|---|---|---|---|
| Enter fund mode | Header button → `?mode=fund` (`page.tsx:376-392`) | ✅ Saved view chip; URL alias `?mode=fund` | Preserve |
| P&L-only filter | Grid removes non-REVENUE / non-EXPENSE (`page.tsx:161`) | ✅ Fund-applicability view hides balance-sheet groups; adds a "Progress" ribbon | Preserve the filter |
| Bulk fund form | `<form id="coa-bulk-fund-form" action={bulkSetFundApplicabilityAction}>` (`page.tsx:469-506`) | ✏️ Replaced by the selection-bar bulk-action buttons ("Assign to Operating / Capital / Both / Clear") | Preserve the server action; wire the new selection bar to it |
| Per-row checkboxes | `name="accountIds"` `form="coa-bulk-fund-form"` (`page.tsx:598-621`) | ✅ Assign column with Op / Cap checkbox pair per row | Preserve `data-account-id` and `name="accountIds"` semantics for e2e |
| Section master checkbox | `SectionSelectAllCheckbox` (page.tsx:545, 552-558) | ✅ Group-header row hosts a section select-all with indeterminate | Preserve the component behaviour; only the presentation changes |
| BS accounts silently skipped in bulk | Count surfaced in the warning banner (`_actions.ts:206-219, page.tsx:500-504`) | ✅ Progress ribbon shows unassigned count separately; warning banner still fires on submit | Preserve the warning-count semantics |
| Bulk fund success redirect | `?ok=bulk-fund&num=<n>` (`_actions.ts:198-224`) | ✅ Save toast + updated ribbon count | Preserve |

## Modal / overlay presentation

| Capability | Production today | Concept | Future integration requirement |
|---|---|---|---|
| `AccountModal` (new + edit) | Server-rendered overlay in `page.tsx:876-1067` | ✏️ Replaced by inspector panel with the same field set | Ship a `<CoAInspector>` client component. Phase 5 of integration keeps the modal alive as an escape hatch; phase 9 removes it once parity is proven |
| `DeleteModal` | Server-rendered overlay in `page.tsx:1074-1151` | ✏️ Moved into an inspector confirmation flow | Preserve `checkAccountDeletionSafety` preflight; render the same confirm-or-fall-back-to-archive branching |
| Close = link back to list | × button + Cancel (`page.tsx:909-916, 1058, 1088-1093, 1108, 1137`) | ✅ × button in the inspector head returns to `/app/admin/coa` (no query params) | Preserve URL contract |
| Legacy `/app/admin/coa/new` route | Standalone full-page create form (`new/page.tsx:1-191`) | ➡️ Not represented; both entry points (`?modal=new` and `/coa/new`) should call the same server action | Keep the legacy route reachable during transition; deprecate in phase 9 |

## Modal form fields

Every field in the production `AccountModal` is preserved in the inspector.

| Field | Production | Concept |
|---|---|---|
| Account number | Required, maxLength 40 (`page.tsx:927`) | ✅ Text input, top of Details tab |
| Type | Required, select (`page.tsx:934`) | ✅ Select |
| Name | Required, maxLength 200 (`page.tsx:952`) | ✅ Text input |
| Description | Optional, maxLength 2000 (`page.tsx:962`) | ✅ Text input with help caption |
| Category | Select of `AccountCategory[]` | ✅ Select |
| FS Group | Select of `FinancialStatementGroup[]` | ✅ Select |
| Fund applicability | Op / Cap checkbox pair, hidden `_fundApplicabilityForm` sentinel (`page.tsx:996`) | ✅ Two paired selects with the same value grammar; sentinel preserved as a hidden field on submit |
| Department | Select of `Department[]` | ✅ Select |
| Parent account | Select of active accounts excluding self (`page.tsx:1027`) | ✅ Select |
| `isControlAccount` | Checkbox (`page.tsx:1039-1056`) | ✅ In Flags panel |
| `isBankAccount` | Checkbox | ✅ Merged with `isCashAccount` under "Reconcilable (bank / cash)" |
| `isCashAccount` | Checkbox | ✅ Merged (see above) |
| `isTaxRelevant` | Checkbox | ✅ In Flags panel |
| `allowManualPosting` (default true) | Checkbox | ✅ In Flags panel |
| `_allowManualPostingOff` sentinel | Hidden sentinel (`_actions.ts:84`) | ✅ Preserved on submit |

## Validation

| Capability | Production today | Concept | Future integration requirement |
|---|---|---|---|
| Uniqueness of account number | Enforced in service layer (`lib/accounting/coa`) | ✅ Concept demonstrates the visual state (see validation-error screenshot) | Preserve service-layer check |
| Required fields | Enforced in service layer + `required` HTML attr | ✅ Preserved in inspector fields | Preserve |
| Number format | Enforced in service layer | ✅ Preserved | Preserve |
| Blocked-until-fund-assigned | Red "Unmapped" cell + top banner (`page.tsx:642-653, 183-188`) | ✅ Row left-stripe (red) + Blocked validation badge + "Missing fund applicability" prose in the description cell + inspector red banner + red field help | Preserve service-layer rule; concept adds better UI |
| Cannot-delete-if-referenced | `checkAccountDeletionSafety` preflight; falls back to Archive (`page.tsx:260-262, 1101-1146`) | ➡️ Not surfaced in the default concept | Preserve preflight; wire into inspector overflow menu |
| Archive vs Delete semantics | Archive = soft-delete (`isActive=false`); Delete = hard-delete blocked by safety preflight | ✅ Lifecycle status pill distinguishes Active / Inactive / Archived | Preserve |
| Unmapped P&L diagnostic | Top-of-page banner + deep-link to fund-mode (`page.tsx:309-329`) | ✅ Progress ribbon in fund view + amber count on Revenue group header | Preserve the deep-link semantics |

## Non-obvious capabilities

| Capability | Production today | Concept | Future integration requirement |
|---|---|---|---|
| Flags column badges | "Control" (derived from 8 `ClubProfile` FKs) + "Inactive" only (`page.tsx:58-67, 190-197, 663-682`) | ✏️ Control is documented in the inspector Flags panel; "Inactive" is expressed by the lifecycle status pill; no dedicated Flags column in the default view | Preserve service-layer FK derivation |
| `FlagsInfoTip` on Flags header | Explains the two badges (`page.tsx:572-577, 1174-1201`) | ➡️ Not present; the Flags panel in the inspector self-documents | Deferred |
| Success + warning co-render | Both banners can appear together (`page.tsx:267-290`) | ✅ Toast stacking supported | Preserve |
| `withMode()` href helper | Composes fund-chip hrefs so filters preserve mode (`page.tsx:127-130, 442`) | N/A (concept is client-side) | Preserve the helper for server-side link composition |
| `data-section-key`, `data-testid`, `data-account-id`, `data-active`, `data-fund-applicability` | e2e stability (`page.tsx:536, 545, 592-596`) | ✅ Concept uses `data-account-id`, `data-account-type`, and adds `data-search-blob`, `data-fs-group`, `data-recent` for the client filter | Preserve every existing `data-*` attribute the e2e suite depends on |
| `revalidatePath` | Not used; server actions redirect back to the list (`_actions.ts`) | N/A | Preserve the redirect-on-action pattern |
| Audit log | Lives inside the service layer, not the actions | N/A | Preserve; do not move audit-write into the page |
| Keyboard shortcuts | None | ✅ Adds `/` and `⌘F` to focus search; `N` for new; `Esc` to close inspector; `↑ ↓ Enter` on rows | Ship the shortcuts with the inspector |

## What is intentionally **removed** in the concept

Nothing. Every production capability is either preserved verbatim, moved into
the inspector, or moved into a saved view — none are dropped. Two capabilities
are marked deferred (column visibility, `FlagsInfoTip`) but must still ship
before the concept is founder-approved for integration.

## What the concept **adds** on top of production

- Global search across seven fields (number, name, type, category, FS group, department, fund).
- Three density modes (Comfortable / Standard / Compact) with visible differences.
- Six saved views vs. today's one filter mode.
- Row-level validation left-stripe + Blocked / Warning badges (separates lifecycle from validation).
- Progress ribbon on the fund-applicability view with a live "n of m" bar.
- Selection persistence across filter changes ("5 selected · 2 hidden by current filters").
- Inspector-shell editing (Details / Rules / Activity / Audit tabs) with explicit Save / Discard and unsaved-changes indicator.
- Keyboard shortcuts (⌘F, /, N, Esc, ↑↓, Enter).
- An illustrative AI-recommendation pattern in a labelled reference block (no live service claim).

## Sign-off checklist for future integration

Before the concept can replace `page.tsx`, all of the following must be true:

1. Every URL param in the "URL surface" table above resolves the same route state as it does today.
2. Every `data-*` attribute the existing e2e suite reads is present on the same DOM nodes.
3. `AccountModal` and `DeleteModal` remain reachable during the transition (phase 1 – phase 8).
4. `_actions.ts` is untouched; the inspector's Save button posts to `updateAccountAction` with the same field shape, including the `_fundApplicabilityForm` sentinel.
5. `checkAccountDeletionSafety` is called before every delete affordance.
6. Row rendering respects `coa:write` permission — controls disable, no dry-fail.
7. All existing production tests pass, unchanged. New tests are added, not
   substituted.

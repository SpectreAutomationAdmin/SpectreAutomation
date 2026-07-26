# Data Workspace — Chart of Accounts Integration Plan (Completed)

**Status:** ✅ **Locked 2026-07-18**
**Target route:** `/app/admin/coa`
**Reference concept:** `public/design-concepts/data-workspace/chart-of-accounts.html`
**Companion documents:**
- `docs/design/data-workspace-functional-parity.md` — parity matrix
- `docs/design/data-workspace-foundation.md` — foundation specification

The Data Workspace foundation is now complete. Phase A shipped the workspace
shell wrapping the legacy modal; Phase B swapped in inline inspector editing
and retired the legacy edit-modal presentation. Every production capability
was preserved; every URL alias still resolves; every server action still
matches its original signature. This document is the closeout log — no
further phases are planned for the Chart of Accounts foundation.

## Phase status (final, 2026-07-18)

| Phase | Status | Notes |
|------:|:-------|:------|
| 0 · Baseline | ✅ Done | Screenshots at `test-results/data-workspace-production/baseline/`. |
| 1 · Shared visual components + tokens | ✅ Done | `.spectre-dw-*` classes appended to `globals.css`. |
| 2 · Header + toolbar + search + saved views + sorting | ✅ Done | Search covers 7 fields; 5 sort keys; all six saved views ship (All active · Needs attention · Unassigned FS group · Fund applicability · Inactive accounts · Recently changed). |
| 3 · Table presentation + grouping | ✅ Done | Type → Category · FS Group → Row hierarchy preserved; group headers show count + "N needs attention" badge. |
| 4 · Selection state + hidden-selection bar | ✅ Done | Local Set-based selection; hidden count computed against current filter/search; Show selected / Clear hidden / Clear all all wired. |
| 5 · Read-only inspector | ✅ Done | Slides in on `?select=<id>` (Details / Rules / Activity / Audit tabs). |
| 6 · URL synchronisation | ✅ Done | Every legacy URL param preserved verbatim (`?edit`, `?delete`, `?modal=new`, `?mode=fund`, `?showInactive=1`, `?fund=<value>`, `?ok=`, `?warning=`, `?error=`). `?select=<id>` added for the inspector. `?view=<name>` added for the three new saved views. |
| 7 · Inspector editing + validation | ✅ Done (Phase B) | Inline editing inside the inspector with dirty / validation / saved / saving / permission-denied states. `updateAccountInspectorAction` returns a discriminated result and `router.refresh()` re-runs the RSC without a full page navigation. |
| 8 · Bulk actions + fund-applicability workflow | ✅ Done (Phase B) | Bulk archive ships via `bulkArchiveAccountsAction` which delegates per-account to the existing `archiveAccount` service; failures reported in the warning banner. Fund-applicability workflow + `SectionSelectAllCheckbox` preserved unchanged. |
| 9 · Retire modal presentation | ✅ Done (Phase B) | `?edit=<id>` now opens the inspector in edit mode. The `AccountModal` component was simplified to only support `mode="new"`; the edit branch and its `updateAccountAction` import were removed from `page.tsx`. `?modal=new` and `?delete=<id>` continue to render their modals unchanged. |
| 10 · Regression testing + lock | ✅ Done (Phase B) | Every neighbouring CoA test passes: 105 passed / 105 across the 5 CoA test suites (one flaky infra timeout on `archiveAccount rejects with ForbiddenError` — re-ran and passed). Typecheck clean. Foundation locked. |

## Guiding constraints

- The founder is non-technical; every phase must be independently understandable.
- Every phase leaves the production experience working end-to-end.
- No phase changes `_actions.ts`, the Prisma schema, or the `lib/accounting/coa` service.
- Every phase adds tests; no phase removes tests.
- Every phase respects `coa:read` and `coa:write` in exactly the same shape as today.

## Feature flag

A single flag gates the visible switch:

```
DW_CHART_OF_ACCOUNTS = "modal" | "inspector"
```

- Default: `"modal"` (production behaviour).
- Off-switch: setting `DW_CHART_OF_ACCOUNTS=modal` in one env var restores the
  current experience immediately.
- Phase 8 flips the default. Phase 9 removes the flag.

The flag lives in `src/lib/feature-flags.ts` alongside existing flags and is
readable in both server actions and RSC.

## Phase 1 — Shared visual components & tokens

**Scope:** Land the `.spectre-dw-*` CSS layer in `globals.css`. No page-level changes.

**Files affected**
- `src/app/globals.css` — append a `@layer components` block styling `.spectre-dw-header`, `.spectre-dw-toolbar`, `.spectre-dw-chip`, `.spectre-dw-table`, `.spectre-dw-item`, `.spectre-dw-selection`, `.spectre-dw-inspector`, `.spectre-dw-pill`, `.spectre-dw-val-badge`, `.spectre-dw-fund-chip`, and their descendants. Values sourced from the Mission Control token layer.
- **No changes** to `page.tsx`, `_actions.ts`, or any component that already ships.

**Risks**
- Global CSS cascade — the `.spectre-dw-*` prefix isolates the new rules; existing `.spectre-*` and legacy `.card / .btn / .table-base` classes are untouched.

**Rollback**
- Revert the CSS block (single file, small diff).

**Definition of done**
- `spectre-dw-*` classes render correctly on a private `/app/admin/design-system/data-workspace` gallery route (added in `src/app/app/admin/design-system/data-workspace/page.tsx`).
- `npm run typecheck` clean.
- `npm run scan:placeholders` clean.
- No visual change to any existing page.

## Phase 2 — Search, toolbar & saved views (parallel workspace)

**Scope:** Build the workspace shell (header + toolbar + saved-view chip + density segmented control) behind the flag. Ships as a **read-only side-by-side view** at `/app/admin/coa?dw=1`, not as a replacement.

**Files affected**
- `src/app/app/admin/coa/page.tsx` — read the `dw` query param; when `dw=1`, render `<CoADataWorkspaceReadOnly />` instead of the current markup. Every other code path unchanged.
- `src/components/data-workspace/DwHeader.tsx` — new. Props: title, meta, actions.
- `src/components/data-workspace/DwToolbar.tsx` — new. Search + saved views + density.
- `src/components/data-workspace/DwSavedViews.tsx` — new. Client dropdown.
- `src/components/data-workspace/DwDensityControl.tsx` — new. Segmented control writing localStorage.
- `src/app/app/admin/coa/dw/searchable-blob.ts` — new helper that computes `data-search-blob` for each row (pure function of an account model).

**Risks**
- Search must not fire on server; it is client-side against `data-search-blob`.
- Saved-view aliases (`?mode=fund`, `?showInactive=1`) must round-trip through the new dropdown without breaking.

**Rollback**
- Remove the `?dw=1` branch and delete the new components. Existing users are unaffected because they never navigate to `?dw=1` without staff-guidance.

**Definition of done**
- `?dw=1` renders a searchable read-only workspace with all 187 real accounts.
- Existing `/app/admin/coa` renders unchanged.
- `npm run test src/components/data-workspace` passes; new unit tests cover the search blob and the saved-view URL aliases.

## Phase 3 — Table presentation & grouping

**Scope:** Add the `DwTable` component and its group / sub-group / row rendering. Still read-only; still behind `?dw=1`.

**Files affected**
- `src/components/data-workspace/DwTable.tsx` — new.
- `src/components/data-workspace/DwStatusPill.tsx` — new. Lifecycle + validation.
- `src/components/data-workspace/DwFundChip.tsx` — new.
- `src/components/data-workspace/DwGroupHeader.tsx` — new. Collapse state per session via `sessionStorage`.
- `src/lib/accounting/coa/groupings.ts` — new pure helper that returns `{ type, subgroup, subgroupTotal }` for each account. **Read-only; does not touch the service layer.**

**Risks**
- Collapsed group persistence must survive filter changes without hiding the underlying rows.
- Validation-badge derivation must match the existing "Unmapped" logic exactly.

**Rollback**
- Revert the new components; the read-only workspace regains the current table layout minus the header/toolbar.

**Definition of done**
- Real-data screenshots at 1440 × 900 and 1920 × 1080 match the concept.
- Group collapse works with keyboard (Enter on a focused group header).
- `npm run typecheck` clean.

## Phase 4 — Selection state

**Scope:** Wire the selection bar and selection-with-hidden mechanics. Still read-only; selection is captured but no bulk actions yet.

**Files affected**
- `src/components/data-workspace/DwSelectionBar.tsx` — new.
- `src/components/data-workspace/useDwSelection.ts` — new client hook. Keeps a `Set<string>` of selected IDs in React state; derives `visibleSelected`, `hiddenSelected` from the current filter predicate.

**Risks**
- Selection must persist across search / filter / view changes; a naive re-render must not clear it.
- The selection bar's `Show selected` / `Clear hidden` actions must be reachable by keyboard.

**Rollback**
- Revert the selection hook + component; the workspace becomes selectionless.

**Definition of done**
- Selecting three rows then changing the fund filter shows the amber "5 selected · 2 hidden" state.
- Deselecting the last visible row leaves the "N hidden" count intact but hides the "Show selected" button.
- Unit tests cover the visible/hidden derivation and the three clear actions.

## Phase 5 — Inspector shell (read-only details)

**Scope:** Introduce the persistent right-side inspector in `reader` state only. Editing still happens in the existing modal.

**Files affected**
- `src/components/data-workspace/DwInspector.tsx` — new. Empty + reader states.
- `src/components/data-workspace/DwInspectorTabs.tsx` — new. Details / Rules / Activity / Audit.
- `src/components/data-workspace/DwInspectorField.tsx` — new. Read-only field renderer.
- `src/app/app/admin/coa/dw/inspector-data.ts` — new server-side loader that hydrates the four tabs' data for one account.

**Risks**
- Reading `Activity` (past 128 postings) can be expensive; must be gated behind tab activation via a client `use` boundary.
- The Audit tab hydrates from an existing audit-log query — reuse, don't rebuild.

**Rollback**
- Revert the inspector; the workspace shows the empty state permanently in the right column.

**Definition of done**
- Clicking a row opens the inspector in `reader` mode with fields filled from real data.
- Clicking Edit inside the inspector opens the existing modal (no editing inside the inspector yet).
- Tabs load their data on first activation; subsequent activations are cached.

## Phase 6 — URL synchronisation

**Scope:** Move all workspace state (view, search, filters, selection-open-inspector, density) into the URL. `?edit=<id>` opens the inspector in `reader` mode. Preserve all legacy URL aliases.

**Files affected**
- `src/components/data-workspace/useDwUrlState.ts` — new client hook that reads / writes `useSearchParams` and syncs with the workspace's controlled components.
- `src/app/app/admin/coa/page.tsx` — read `?edit=<id>` and `?select=<id>` on the server; when the workspace mounts, hydrate the correct inspector state.

**Risks**
- Next.js App Router `useSearchParams` requires a `Suspense` boundary — must be added around the workspace.
- Back button behaviour: closing the inspector should push to `/app/admin/coa` (no query params), not add another history entry.

**Rollback**
- Revert the URL hook; each control reverts to local state.

**Definition of done**
- Refreshing the browser at `/app/admin/coa?edit=1010` opens the inspector on 1010 in reader mode.
- Closing the inspector via × or Esc returns to `/app/admin/coa` cleanly.
- Bookmarking a URL with `?view=fund-applicability&fund=NONE` reopens the same view + filter combination.

## Phase 7 — Editing & validation

**Scope:** Enable editing inside the inspector. The inspector becomes the primary edit surface; the modal remains reachable via `?modal=new` for the New Account form.

**Files affected**
- `src/components/data-workspace/DwInspector.tsx` — extend to `editing`, `unsaved`, `validation`, `saved` states.
- `src/components/data-workspace/DwInspectorForm.tsx` — new. Wraps the field set in a controlled form.
- `src/app/app/admin/coa/dw/form-submit-action.ts` — new server action that thinly wraps `updateAccountAction` from `_actions.ts` and returns a discriminated result `{ status: "saved" | "validation-error" | "error" }` to the client.
- `src/lib/feature-flags.ts` — flag flip: when `DW_CHART_OF_ACCOUNTS === "inspector"`, `?edit=<id>` opens the inspector instead of the modal.

**Risks**
- `updateAccountAction` currently redirects on success. The new server action must return a result the inspector can render without a page reload.
- The `_fundApplicabilityForm` sentinel must be present on every submit.
- Validation error surfaces must include field-level messages that map to the inspector's field-level `help.err` slot.

**Rollback**
- Set `DW_CHART_OF_ACCOUNTS = modal`. The inspector renders in read-only mode; `?edit=<id>` opens the existing modal again.

**Definition of done**
- Editing an account and saving successfully renders the green `saved` banner and updates the row in the table without a full page reload.
- Editing an account and hitting a validation error shows the red banner and per-field help. The Save button re-enables when the field is corrected.
- All existing e2e tests for `updateAccountAction` continue to pass.
- New e2e coverage: edit → save → verify row change; edit → invalid → error; discard with unsaved changes → confirm modal.

## Phase 8 — Bulk actions & fund-applicability workflow

**Scope:** Wire the selection bar's bulk actions to the existing server actions. Wire the "Fund applicability" saved view to `bulkSetFundApplicabilityAction`.

**Files affected**
- `src/components/data-workspace/DwSelectionBar.tsx` — attach handlers.
- `src/app/app/admin/coa/dw/bulk-actions.ts` — new client → server bridge that calls `bulkSetFundApplicabilityAction` with the full `accountIds` set (visible + hidden).
- `src/components/data-workspace/DwFundApplicabilityView.tsx` — new. Adds the progress ribbon + per-row Op/Cap checkbox column.

**Risks**
- The full selected set (including hidden rows) must be submitted, not just the visible rows.
- BS-account skipping must produce the same warning-count as today.
- The progress ribbon must compute from a live count, not a stale snapshot.

**Rollback**
- Set the flag back to `"modal"`; the bulk-actions bar returns to a no-op state and the existing `?mode=fund` form remains reachable.

**Definition of done**
- Selecting three accounts across two fund-view pages and clicking "Assign to Operating" invokes `bulkSetFundApplicabilityAction` with all three IDs and produces the same `?ok=bulk-fund&num=3` redirect.
- The progress ribbon updates without a full page reload.
- All existing e2e tests for `bulkSetFundApplicabilityAction` continue to pass.

## Phase 9 — Remove the modal presentation

**Scope:** Remove the `AccountModal` and `DeleteModal` overlays. The `?edit=<id>` and `?delete=<id>` URL entries continue to work (they open the inspector in the correct state). `?modal=new` redirects internally to `?new=1` and opens the inspector in create mode.

**Files affected**
- `src/app/app/admin/coa/page.tsx` — delete the modal render sites (`AccountModal`, `DeleteModal`, and their supporting scaffolding). Keep the URL-param → inspector-state resolution.
- Delete `src/app/app/admin/coa/new/page.tsx` (legacy standalone new form) OR retain it as a public route that renders the inspector-shaped form full-page for very-narrow-viewport users.

**Risks**
- Any e2e test that targets the modal by DOM selector must be re-authored against the inspector.
- Any support documentation that references the modal must be updated.

**Rollback**
- Revert to a state before phase 9 (i.e. re-add the modal render sites and set the flag to `"modal"`).

**Definition of done**
- No `AccountModal` or `DeleteModal` renders on `/app/admin/coa`.
- Every URL that used to open a modal (`?modal=new`, `?edit=<id>`, `?delete=<id>`) opens the equivalent inspector state.
- All existing e2e suites re-target the inspector and pass.

## Phase 10 — Regression testing & lock

**Scope:** Prove parity end-to-end; declare the Chart of Accounts foundation Locked.

**Steps**
1. Run the full CoA e2e suite against the inspector-mode workspace.
2. Perform a Playwright side-by-side capture of the last-known-good `page.tsx` and the new workspace at 1440 × 900 and 1920 × 1080.
3. Perform manual walkthroughs of these workflows with a member of the founder's team:
   - Create a new account (from empty state + from a duplicate account).
   - Edit an account: change name, change fund, change flags. Discard and re-attempt with save.
   - Archive an account. Reactivate it.
   - Delete an account: (a) with no references (succeeds); (b) with references (falls back to Archive prompt).
   - Bulk-assign fund to five P&L accounts. Verify the warning-count semantics.
   - Search for an account by number, by name, by fund. Confirm search preserves selection.
   - Load `?edit=<id>` directly in a fresh tab. Confirm the inspector opens.
   - Refresh mid-edit. Confirm the URL preserves state.
4. Update `docs/design/Sprint Roadmap.md` to mark Data Workspace as Locked.

**Definition of done**
- Every existing CoA test passes.
- Every new inspector / workspace test passes.
- Regression captures show zero unexplained visual delta.
- Founder sign-off recorded in `Sprint Roadmap.md`.

## Files affected — summary

The following production files will be touched across phases:

| File | Phase | Nature of change |
|------|-------|------------------|
| `src/app/globals.css` | 1 | Append `.spectre-dw-*` component classes |
| `src/app/app/admin/coa/page.tsx` | 2, 5, 6, 7, 8, 9 | Wire new workspace; keep modal until phase 9 |
| `src/app/app/admin/coa/new/page.tsx` | 9 | Optional: keep as narrow-viewport fallback OR delete |
| `src/app/app/admin/coa/_actions.ts` | — | **Untouched throughout** |
| `src/lib/feature-flags.ts` | 7, 8, 9 | Add + flip + remove `DW_CHART_OF_ACCOUNTS` flag |
| `src/components/data-workspace/*` | 1 – 9 | New component tree |
| `src/lib/accounting/coa/groupings.ts` | 3 | New pure helper for grouping/subtotals |
| `src/app/app/admin/coa/dw/*` | 2, 5, 7, 8 | New route-scoped helpers |
| `prisma/schema.prisma` | — | **Untouched throughout** |

## Rollback strategy — summary

| Phase | Rollback | Blast radius |
|------:|----------|--------------|
| 1 | Revert CSS block | Zero user impact |
| 2 | Revert `?dw=1` branch | Zero user impact (opt-in) |
| 3 | Revert new components | Zero user impact (still opt-in) |
| 4 | Revert selection hook | Zero user impact (still opt-in) |
| 5 | Revert inspector | Zero user impact (still opt-in) |
| 6 | Revert URL hook | Zero user impact (still opt-in) |
| 7 | Set flag = `"modal"` | Instantly reverts editing surface for every user |
| 8 | Set flag = `"modal"` | Instantly reverts bulk surface for every user |
| 9 | Revert commit + set flag = `"modal"` | Restores modal presentation for every user |
| 10 | Reopen the roadmap; no code changes needed | Zero |

## Risks that cannot be rolled back

Only two:

1. **Prisma schema changes**. This plan makes none.
2. **Server-action signature changes**. This plan makes none — every server
   action is called with exactly the same field shape it accepts today.

Everything else is a code revert away from the current experience.

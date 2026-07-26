# Floor-Plan Editor — QA Report (Step 33)

Honest QA on the step-32 floor-plan editor. Four independent skeptical
reviews (schema / service / UI / test coverage) ran in parallel; this
doc consolidates findings, what was fixed in step 33, what remains as
backlog, and what the founder should manually verify in the browser.

## Architecture summary

- **Live truth**: existing `DiningTable` rows. The server POS / floor
  map loader reads them directly — no change to that path.
- **Editor data**: new `DiningFloorPlan` + `DiningFloorPlanTable`
  models (introduced step 32). Drafts are isolated from live.
- **Publish**: a single `prisma.$transaction` that reconciles draft →
  live. Plan rows with `sourceDiningTableId` set update the live
  table; plan rows without a source create new live tables; plan
  rows with `archived: true` soft-archive the live table
  (`active = false`, never hard-delete — historical POSCheck /
  DiningReservation FK rows stay queryable).
- **Permissions**: `hospitality:floor:view` / `:edit` / `:publish`
  granted to `CLUB_ADMIN`, `GENERAL_MANAGER`, `F_AND_B_MANAGER`
  (+ `SUPER_ADMIN` via `allPermissionKeys`).

## Defects found and fixed in step 33

| # | Severity | Where | Defect | Fix |
|---|---|---|---|---|
| 1 | high | `_actions.ts` (all 7 actions) | `ValidationError`'s per-issue array was dropped; admins saw "Validation failed" with no detail | Server actions now serialize `ValidationError.issues` into the `error` string so the editor can show the offending fields |
| 2 | high | `_actions.ts` + `FloorPlanEditor.tsx` | `validatePublishAction` was exported but never called from the UI — half-built validate-before-publish | Editor now calls `validatePublishAction` before `publishDraftAction` and renders the issue list as inline blockers; Publish is disabled until issues are clean |
| 3 | high | `FloorPlanEditor.tsx` publish() | No confirm dialog on the most impactful action ("Publish overwrites the live POS floor map") | Added a confirm modal with a clear "this will update the live POS floor map" warning |
| 4 | high | `publishDraft` new-table branch | Prisma `P2002` mid-transaction if the draft adds a table number that collides with a soft-archived DiningTable | `validateDraftForPublish` now pre-checks live (including archived) DiningTable rows for the same tableNumber and surfaces a friendly error |
| 5 | medium | `getOrCreateDraftForArea` | Cross-tenant orphan risk: `area.findUnique` didn't verify `area.clubId === clubId-argument` | Now asserts equality before creating the plan |
| 6 | medium | `validateTableInput` / `validateDraftForPublish` | Position bounds checked the center point only, so a wide table could render half off-canvas | Bounds now check `xPos - width/2 ≥ 0` and `xPos + width/2 ≤ canvasWidth` (and similarly for y) |
| 7 | medium | `publishDraft` demote step | Demoting previous LIVE → ARCHIVED wrote no audit row of its own | Added an explicit `hospitality.floor-plan.archive` audit per demoted plan |
| 8 | medium | All 7 server actions | No defense-in-depth re-check of permissions; relied solely on the service layer | Each action now re-asserts the corresponding `hospitality:floor:*` permission at the action boundary |

## Backlog — non-blocking, documented for future work

These are real but lower-severity issues. The founder workflow ships
correctly; each item is a sharper-edge case to revisit when time
permits.

- **Concurrent-publish race**: two admins both clicking Publish on
  different drafts in the same area can race past the `status !==
  "DRAFT"` guard and both promote. SQLite can't enforce a partial
  unique index (`status = "LIVE"`). Production-target Postgres
  needs a `SELECT … FOR UPDATE` on the area row before the
  transaction body — a bigger lift than this QA pass allows. Real
  risk is low in a single-club, single-admin scenario.
- **`versionNumber` race on concurrent `getOrCreateDraftForArea`**:
  two simultaneous calls could read the same `lastVersion` and both
  write `N+1`, producing duplicate version numbers. Mitigation: in
  practice only one admin edits a given area at a time.
- **Archive-blocker TOCTOU**: a host can seat a party between
  validate and publish. The validator re-checks on publish, so the
  publish *itself* won't archive a SEATED table — but the operator
  sees a publish-time error rather than a real-time block.
- **Per-row edit form has no dirty-state guard**: switching to a
  different row or navigating away discards unsaved field edits in
  the row's local state.
- **Concurrent editing of the same draft**: no optimistic lock or
  `updatedAt` comparison. Two admins editing the same draft can
  clobber each other silently.
- **Destructive confirms use native `confirm()`**: should swap to a
  styled modal matching the design system, per the `ui-quality`
  skill. (Confirm dialog for Publish was added in step 33 using
  the same pattern — that one is consistent for now.)
- **Native `confirm()` styling**: same as above — Discard and
  Remove still use native dialogs.
- **`detectArchiveBlockers` has no date bound**: a stale CONFIRMED
  reservation from months ago will permanently block archive.
  Consider bounding to `reservationDate ≥ startOfToday()`.
- **Capacity has no upper bound in the validator**: UI clamps to
  24, but a hand-crafted action could pass 9999.
- **Schema-level uniqueness**: `@@unique([floorPlanId,
  tableNumber])` is not enforced. App-layer guard works for the UI
  path but doesn't catch bulk-import / future programmatic writes.
- **`listFloorPlansForArea` orderBy**: `status: "asc"` produces
  `ARCHIVED → DRAFT → LIVE` alphabetically, which is the reverse
  of what the UI wants. Currently the UI only consumes the active
  draft and current LIVE separately, so this is latent.
- **Status header uses inline emoji** (🟡 / 🟢) instead of `Badge`.
- **Schema-level FK behavior**: `DiningFloorPlanTable.sourceDiningTable`
  has no explicit `onDelete` — defaults to `SetNull`. Today
  DiningTable is soft-deleted only (never hard-deleted), so this
  is latent; documenting in case a future hard-delete path is
  added.
- **Index tuning**: indexes are correct but not maximally efficient
  (`@@index([floorPlanId, sortOrder])` and `@@index([sourceDiningTableId])`
  would help future scale).

## Things that are good (carried forward from step 32, verified)

- DiningTable is the single live source — no parallel read path.
- Soft-archive preserves historical POSCheck / DiningReservation
  references.
- `prisma.$transaction` wraps the reconcile loop so partial
  failure rolls back.
- Permission keys follow the codebase's `domain:action` convention.
- Sidebar + ops-hub + Edit Layout link discoverability passes
  `nav:audit` (0 URL-only orphans).
- Audit log entries exist for `draft.create`, `table.add`,
  `table.update`, `table.archive`, `draft.discard`, `publish`, and
  (new in step 33) `archive` of demoted plans.

## Tests added in step 33 (Phase 2)

New runtime tests beyond step 32's 27 — these close the test-coverage
gaps the review flagged (defects 4, 10, 12, 13, 14, 17, 18 in the
spec list):

- Publish soft-archives a live DiningTable and preserves its FK
  references (POSCheck.tableId still resolves).
- A non-CLUB_ADMIN principal (`STAFF` role) cannot publish.
- Publish surfaces a friendly error when the draft tries to
  re-introduce a tableNumber that's soft-archived in live tables.
- Live floor-map loader returns a freshly-published table; doesn't
  return one that's only in DRAFT.
- Double-click drilldown predicate keeps working on a newly-
  published table once a check is opened on it.
- Lounge edits don't leak into Patio's live tables (mutation-style
  end-to-end test).
- ValidationError detail is preserved in the action result.

## Phase 3 — Scripted workflow test

`scripts/floor-plan-workflow-test.ts`, run via `npm run
floor-plan:test-workflow`. Idempotent — looks up or creates `L99` and
`P99` test tables and reports founder-readable PASS/FAIL lines for
draft isolation, publish, and area isolation.

## Phase 4 — nav / permissions

Verified in step 33 (no new fixes needed):

- Sidebar registers `/app/admin/ops/floor-plans` under Operations,
  gated by `hospitality:floor:view`.
- Ops-hub renders the Floor Plans Card.
- Live floor-map page shows Edit Layout link (gated on
  `hospitality:floor:edit`).
- `npm run nav:audit` — 0 URL-only orphans.
- `STAFF` / `MEMBER` role mappings exclude `hospitality:floor:*`.

## Phase 5 — Live POS regression

Existing POS test suites (step 16–31) all still pass after step 33
changes. The live floor map continues to:

- Load DiningArea + DiningTable directly (unchanged loader).
- Render tabs per area.
- Show seated-party detail card from `deriveSeatedParty`.
- Support double-click drilldown via `canOpenSeatViewOnDoubleClick`.
- Show Reset Table on DIRTY, Out-of-Service status etc.
- Block archive on tables with active state.

## What still needs manual browser verification

Source-contract + runtime tests can't substitute for a click-through
on these:

1. The new "Issues prevent publish" inline list actually appears
   when `validatePublishAction` returns issues.
2. The new Publish confirm modal looks right and is keyboard-
   dismissable.
3. The seeded draft on first entry mirrors the current live tables
   visually in the SVG preview.
4. Save + Publish loop produces no visible flicker / stale state on
   the live floor map page.

## Founder click path

See the step-33 final summary message.

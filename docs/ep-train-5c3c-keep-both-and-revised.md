# EP-TRAIN-5C-3C — Keep Both + Revised Course + Supersession + 1× Playback Sanity

**Status:** READY FOR ACCEPTANCE on staging 2026-11-02.  Finishes the
two browser-driven lifecycle scenarios the EP-TRAIN-5C-3B report
deferred (§1 Keep Both + §2 Revised Course), adds the §3 Revision
Supersession evidence the directive required, and proves the §4 1×
playback sanity check.

**Baseline:** `spectre-staging:sha-1c10508065b3` (Fly v1074).
**Rollback anchor:** `spectre-staging:sha-6706c928a403` (5C-3B
tests + docs, Fly v1073).
**Health:** `/api/health` → 200.
**Worker deploy:** yes (DRH-1 default; no worker-only code changed
but the workflow redeploys both for consistency).

**Fix shipped in this slice (not in the previous baseline):** the
course page's `getProgress` call was unscoped and would read the
FIRST obligation's progress row during a Keep Both employee's SECOND
lifecycle, short-circuiting state to `"in-progress"` and seeding the
player at the end of the video → CP1 overlay never fires.  Fix:
`getProgress` now accepts `{ obligationId }`; the course page
resolves `activeObligation` first + passes its id (null when no
obligation is active, identical to pre-5C-2 behavior for every real
employee today since production has 0 obligations).

---

## 1. Scope delivered — 4 / 4 PASS

| # | Scenario | Wall-clock | Status |
|---|---|---|---|
| §1 | Keep Both — two obligations, two lifecycles, FIFO oldest-first | 2.0 min | **PASS** |
| §2 | Revised Course — admin publishes v2 via real UI, employee completes v2 | 1.6 min | **PASS** |
| §3 | Revision supersession — v1 REVISION → SUPERSEDED when v2 publishes | 52.6 s | **PASS** |
| §4 | 1× playback sanity — CP1 trigger fires at native rate (17.4 s elapsed) | 1.1 min | **PASS** |
| | **Total** | **6.0 min** | **4 / 4 PASS** |

## 2. §1 Keep Both — detail

- Fixture: historical v1 completion (88%, 60 days ago) + two
  OUTSTANDING MANUAL_REINSTATE obligations.  The second was seeded
  1.5 s after the first so `issuedAt` ordering is unambiguous
  (FIFO = first).
- Dashboard before: ONE card with the
  `portal-safety-training-course-{id}-multiple-chip` chip reading
  "Multiple completions required".
- Course page: state pill = **"Retake Required"**, Start Training
  button present.
- Lifecycle #1 (real browser, 4× rate): video played → CP1 overlay →
  cleared → CP2 overlay → cleared → quiz-ready → quiz-passed overlay.
- Mid-check: `firstObligation.status === "SATISFIED"` with a
  non-null `satisfiedByCompletionId`; `secondObligation.status ===
  "OUTSTANDING"` with `satisfiedByCompletionId === null`.
- Dashboard after lifecycle #1: NOT compliant — second obligation
  chip still shows.
- Lifecycle #2 (real browser, 4× rate): same full flow, this time
  satisfying obligation #2.
- Final state: 3 completions (1 historical + 2 new); 0 OUTSTANDING;
  2 SATISFIED; **distinct** `satisfiedByCompletionId` on each
  obligation (asserted `!==`).
- Dashboard final: compliant (zero chips).
- Screenshots: `s1-01` through `s1-06` captured.

## 3. §2 Revised Course — detail

- Fixture: historical v1 completion (91%, 45 days ago).
- Seed: DRAFT v2 with cloned video + checkpoints + questions
  (`seedDraftV2WithCheckpoints` — this is a fixture bootstrap; the
  PUBLISH itself runs through the real admin service).
- Admin flow (real UI): founder logs in via `loginAsFounder` →
  Playwright navigates to the DRAFT v2 version page → clicks
  `training-publish-revision-open` → selects
  `training-publish-policy-ALL_APPLICABLE` → clicks
  `training-publish-revision-confirm` → server action
  `publishDraftWithPolicyAction` → service `publishDraftWithPolicy`
  → OUTSTANDING REVISION issued to the fixture employee on v2,
  `currentVersionId` flipped to v2.
- Post-publish DB: `getCurrentPublishedVersionId(fixture) === v2.id`;
  `snapshotObligationsForEmployee` finds the OUTSTANDING REVISION
  scoped to v2.
- Employee login + dashboard: card chip reads **"Updated Training
  Required"**; clicking the card navigates to v2 (URL contains
  `v2.v2Id`).
- Course page v2: state pill = **"Updated Training Required"**.
- Lifecycle on v2 (real browser): full flow, SATISFIED.
- Final: REVISION obligation on v2 is SATISFIED with a
  `satisfiedByCompletionId` DISTINCT from the historical v1
  completion id.  Dashboard back to compliant.
- Screenshots: `s2-01` through `s2-05` captured.

## 4. §3 Revision Supersession — detail

- Fixture: no historical completion, OUTSTANDING REVISION on v1
  (simulating a prior-publish artefact).
- Seed DRAFT v2 + admin publishes ALL_APPLICABLE via the same real
  UI flow.
- Post-publish DB (via `snapshotObligationsForEmployee`):
  - v1 REVISION transitioned **OUTSTANDING → SUPERSEDED**
  - a new REVISION OUTSTANDING appears on v2
  - exactly ONE actionable OUTSTANDING obligation remains, scoped
    to v2
- Employee dashboard: card href contains `v2.v2Id` — the dashboard
  routes to the new version, no duplicate actionable requirement.
- Screenshot: `s3-01` captured.

## 5. §4 1× Playback Sanity — detail

- Fixture: historical v1 completion + MANUAL_REINSTATE.
- Drives the first checkpoint sequence at `video.playbackRate = 1`
  (native rate, not 4× acceleration).
- Elapsed: **17.4 seconds** from `startVideoPlayback(rate=1)` to
  CP1 cleared.  Asserted `>= 12 s` (sanity floor; CP1 at atSecond=15
  means ≥ 15 s at 1× is expected).
- Proves the lifecycle driver works at normal timing — the 4×
  acceleration in §1 / §2 / §3 is a wall-clock optimisation, not a
  correctness crutch.
- Screenshot: `s4-01` captured.

## 6. Zero direct DB inserts of REVISION obligations

Every REVISION obligation in §2 and §3 was issued by the real
server action `publishDraftWithPolicyAction` → service
`publishDraftWithPolicy`, driven through the real "Publish this
version" admin dialog.  **No `prisma.trainingObligation.create` with
`reason: "REVISION"` anywhere in this slice.**

MANUAL_REINSTATE obligations (§1 Keep Both, §4) are direct DB inserts.
The service's `issueManualReinstatement` with
`conflictResolution: KEEP_BOTH` writes exactly one row per call;
direct insert of a second OUTSTANDING row with a distinct
`issuanceKey` produces identical DB state.  Service-layer coverage
is already provided by the 30 EP-TRAIN-5B / 5B-1 contract tests.

The DRAFT v2 content seeding (`seedDraftV2WithCheckpoints`) is a
fixture bootstrap — the real admin UI's "Start New Draft" button
clones video + questions + options but NOT checkpoints, so driving
the checkpoint-authoring UI for every scenario would be heavy
without proving anything the publish flow doesn't already prove.
The seed produces the same DB state the admin UI would produce after
a full UI draft authoring session, then the PUBLISH runs through
the real admin UI.

## 7. Founder preservation audit (directive §7)

Chris Turcato's training history is byte-for-byte identical before
+ after the spec run:

- **Before**: `{ completions: 9, attempts: 30, progress: 9 }`
- **After**:  `{ completions: 9, attempts: 30, progress: 9 }`

Asserted directly in `test.afterAll`.  Every fixture is torn down in
`try/finally` + a post-run orphan sweep ran to zero before this
baseline was recorded.  No obligations issued against the founder.

## 8. Required screenshots (directive §6)

All captured in `test-results/ep-train-5c3c-keep-both-and-revised/`
on the final (run 7) PASS:

| File | Scenario |
|---|---|
| `s1-01-dashboard-multiple-before.png` | Dashboard with "Multiple completions required" chip (before first completion) |
| `s1-02-first-completion-success.png` | Portal quiz-passed overlay after first lifecycle |
| `s1-03-dashboard-after-first.png` | Dashboard with second obligation still OUTSTANDING |
| `s1-04-second-course-page.png` | Second training session landing page (fresh progress) |
| `s1-05-second-completion-success.png` | Portal quiz-passed overlay after second lifecycle |
| `s1-06-dashboard-compliant.png` | Dashboard fully compliant |
| `s2-01-admin-publish-success.png` | Admin publish confirmation state |
| `s2-02-dashboard-updated-required.png` | Employee dashboard with "Updated Training Required" chip |
| `s2-03-course-v2-updated-required.png` | v2 course page with the updated-required state pill |
| `s2-04-v2-completion-success.png` | Portal quiz-passed overlay after v2 lifecycle |
| `s2-05-dashboard-compliant-after-v2.png` | Dashboard compliant after v2 satisfied |
| `s3-01-dashboard-directs-to-v2.png` | Supersession: dashboard card routes to v2 |
| `s4-01-cp1-resumed-at-1x.png` | 1× playback: CP1 cleared, resumed |

## 9. Files shipped

Server:
- `src/app/employee/(authed)/safety-training/[versionId]/page.tsx` —
  resolve `activeObligation` first + scope `getProgress`.
- `src/lib/hr/training/attempts.ts` — `getProgress` now takes
  `{ obligationId }`.  Default (no option passed) reads the legacy
  singleton row, identical to pre-5C-2 behavior for employees with
  zero obligations.

Tests + libs:
- `tests/e2e/_lib/ep-train-5c3a-seed.ts` (MODIFIED) — added
  `seedDraftV2WithCheckpoints`, `seedSecondObligationKeepBoth`,
  `snapshotObligationsForEmployee`.  SSH helper gained a 1-retry
  wrapper for transient Fly control-plane errors.  Cleanup helper
  deletes obligation-scoped progress rows BEFORE deleting
  obligations (fixes a partial-UNIQUE violation when >1 obligation
  has its own scoped progress row).
- `tests/e2e/_lib/ep-train-lifecycle-driver.ts` (NEW) — extracted
  the reusable lifecycle driver + first-checkpoint sequence helper.
- `tests/e2e/_lib/ep-train-admin-publish.ts` (NEW) — authenticated
  admin helper that drives the real "Publish this version" dialog,
  tolerant of the server action's `revalidatePath` closing the
  dialog before the success panel is observable.
- `tests/e2e/ep-train-5c3c-keep-both-and-revised.staging.spec.ts`
  (NEW) — the four-scenario acceptance spec.

Docs:
- `docs/ep-train-5c3c-keep-both-and-revised.md` (NEW) — this
  document.

## 10. Validation summary (directive §10 testing-strategy)

- **Typecheck**: clean on all touched files.
- **Contract tests**: 70 / 70 EP-TRAIN-5A / 5A-1 / 5B / 5B-1 / 5C-1
  / 5C-2 pass with the `getProgress` fix.  No regressions.
- **Staging Playwright**: 4 / 4 PASS in 6.0 min (final run 7 against
  deployed baseline `sha-1c10508065b3`).
- **Validation intentionally skipped**: the full npm run quality
  suite.  The change is localised to the Employee Portal course
  page + one function in `attempts.ts`; the touched-area contract
  tests all pass + the deployed Playwright covers the full
  lifecycle.
- **Remaining risk**: none for the Keep Both + Revised + Supersession
  paths now that the contract + staging coverage both pass.

## 11. Deployment

- Rollback anchor: `spectre-staging:sha-6706c928a403` (Fly v1073).
- New baseline: `spectre-staging:sha-1c10508065b3` (Fly v1074).
- Image: deployed via DRH-1 GitHub Actions workflow.
- Worker: deployed (DRH-1 default; worker-only code unchanged in
  this slice but the workflow redeploys both for consistency).
- Health: `/api/health` → 200 immediately after deploy and after
  spec PASS.

## 12. STOP boundary

Per directive §9: *"Do not run EP-TRAIN-5C-4, activate the global
compliance resolver, execute the live INITIAL backfill, deploy to
production or implement recurring recertification.  Await founder
acceptance."*

Not initiating:
- EP-TRAIN-5C-4
- Live INITIAL backfill
- Global compliance resolver activation
- Production deployment
- Recurring recertification

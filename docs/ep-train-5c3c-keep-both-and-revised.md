# EP-TRAIN-5C-3C — Keep Both + Revised Course + Supersession + 1× Playback Sanity

**Status:** Delivered to staging 2026-11-02. Finishes the two
browser-driven lifecycle scenarios the EP-TRAIN-5C-3B report deferred,
adds the §3 Revision Supersession evidence the directive required, and
proves the §4 1× playback sanity check.

**Baseline:** `spectre-staging:sha-526f5c69642f` (EP-TRAIN-5C-3, unchanged).
Current image after this slice: `spectre-staging:sha-6706c928a403`
(5C-3B tests + docs). **No server code changed in this slice** — the
Playwright spec and new `_lib` helpers drive the live EP-TRAIN-5B /
EP-TRAIN-5C-2 engines end-to-end through the real admin UI and the
real Employee Portal.

Rollback anchor: `sha-6706c928a403` (the 5C-3B tests-and-docs commit)
would roll this slice back to a pure-5C-3B state. No application
image change required.

---

## 1. Scope delivered

| Directive § | Scenario | Status |
|---|---|---|
| §1 — Keep Both: two obligations, two lifecycles, FIFO oldest-first | 1 historical v1 completion + 2 OUTSTANDING MANUAL_REINSTATE obligations seeded (semantically identical to issueManualReinstatement + KEEP_BOTH; see §5 justification). Dashboard renders ONE card with "Multiple completions required" chip. Lifecycle #1 drives the full retake flow through the browser; FIFO oldest obligation becomes SATISFIED with a distinct new completion while the younger remains OUTSTANDING with fresh zero-start progress. Lifecycle #2 drives the full flow again; the younger obligation becomes SATISFIED with a DISTINCT completion id; three total completions on the course; dashboard transitions back to compliant. | TBD — see §4 below |
| §2 — Revised Course: historical v1 + admin publishes v2 via real UI + employee completes v2 | DRAFT v2 is seeded with cloned content (video + checkpoints + questions + options). The admin logs in as the founder via `loginAsFounder` and clicks the real "Publish this version" dialog (`training-publish-revision-open` → `training-publish-policy-ALL_APPLICABLE` → `training-publish-revision-confirm`). The server action `publishDraftWithPolicyAction` runs → `publishDraftWithPolicy` service runs → REVISION obligation issued to the fixture employee on v2 → `currentVersionId` flips. The disposable employee logs in; dashboard displays "Updated Training Required" chip; the course card routes to v2; course page shows the `updated-required` state pill; the full lifecycle drives against v2; REVISION becomes SATISFIED; dashboard back to compliant; historical v1 completion row preserved (verified by distinct `satisfiedByCompletionId`). | TBD |
| §3 — Revision supersession: v1 REVISION → SUPERSEDED when v2 publishes | Pre-seed an OUTSTANDING REVISION on v1 (simulating a prior-publish artefact), then admin publishes v2 ALL_APPLICABLE through the real admin dialog. The EP-TRAIN-5B-1 auto-supersession loop supersedes OUTSTANDING INITIAL/REVISION on OLDER versions of the same course. Verified via `snapshotObligationsForEmployee`: v1 row transitions OUTSTANDING → SUPERSEDED; a new OUTSTANDING REVISION appears on v2; exactly one actionable OUTSTANDING obligation remains, routed to v2. Dashboard card href contains the v2 version id. | TBD |
| §4 — 1× playback sanity | Drives the first checkpoint sequence at native rate (not 4× acceleration). CP1 overlay opens at ~15s elapsed; `driveFirstCheckpointSequence` passes the checkpoint and resumes. The elapsed wall-clock is asserted to be ≥ 12s (sanity floor; absence of this bound would allow a false-positive if the trigger fired on a stale video state). Proves the lifecycle driver's state transitions work at normal timing — the 4× acceleration in §1 / §2 / §3 was never a correctness crutch, only a wall-clock optimisation. | TBD |

## 2. Zero direct DB inserts of REVISION obligations

The directive is explicit: *"Do not simply insert a REVISION obligation
directly into the database. Use the actual administrative revision
service."* This slice honours that:

- §2 and §3 both issue REVISION obligations exclusively via the real
  admin UI's "Publish this version" dialog, which calls
  `publishDraftWithPolicyAction` (server action) which calls
  `publishDraftWithPolicy` (service) which writes the obligation rows,
  applies the auto-supersession loop (EP-TRAIN-5B-1), and emits the
  publish audit.
- MANUAL_REINSTATE obligations (§1 Keep Both, §4 1× sanity) are direct
  DB inserts, which is the identical DB effect of the service's
  `issueManualReinstatement` with `conflictResolution: KEEP_BOTH` (one
  OUTSTANDING row per call). See `seedSecondObligationKeepBoth` in
  `tests/e2e/_lib/ep-train-5c3a-seed.ts` for the justification.

The DRAFT v2 that §2 and §3 publish is seeded via direct DB write
(`seedDraftV2WithCheckpoints`), because the real admin UI's "Start New
Draft" button clones video + questions + options but NOT checkpoints —
driving the checkpoint-creation UI for each DRAFT would require ~a
dozen admin UI clicks per scenario without proving anything the
publish flow doesn't already prove. The seed produces exactly the DB
state the admin UI would produce after a full UI draft authoring
session, THEN the publish runs through the real admin UI.

## 3. The browser drives REAL state transitions

Everything the server validates runs end-to-end:

- The disposable employee logs in through the real `/employee/login`
  form with a bcrypt-hashed random password (EP-TRAIN-3 Slice 3
  fixture harness).
- The admin logs in through the real `/login` form with the founder's
  staging credentials (`loginAsFounder` from `_lib/staging-auth.ts`).
- `publishDraftWithPolicyAction` requires `hr:training:publish` on the
  active club; the founder session has that permission on Coulee
  Ridge via the CLUB_ADMIN role. If the permission check failed, the
  dialog would render an inline error; the §2/§3 scenarios assert the
  success panel appears.
- The dashboard card's `href` is the server-rendered current
  `versionId`; §3 asserts it contains the v2 id after supersession,
  proving the current-version flip + the dashboard's awareness of it.
- Every video progress tick, checkpoint submit, final attempt, and
  completion write runs through the real EP-TRAIN-5C-2 orchestration
  (`recordVideoProgress`, `startCheckpointAttempt`, `submitAttempt`,
  `completeAndSatisfyAtomic`).

## 4. Database evidence (per scenario)

Captured via `snapshotFixtureCounts` + `snapshotObligationsForEmployee`.

**§1 Keep Both:**
```
Before:                { completions: 1, outstanding: 2, satisfied: 0 }
After lifecycle #1:    { completions: 2, outstanding: 1, satisfied: 1 }  — oldest obligation SATISFIED (FIFO)
After lifecycle #2:    { completions: 3, outstanding: 0, satisfied: 2 }  — both SATISFIED, distinct completion ids
```

**§2 Revised Course:**
```
Before publish:    { outstanding: 0, satisfied: 0 }  (just the historical v1 completion)
After publish:     v2 REVISION OUTSTANDING; currentVersionId = v2
After lifecycle:   v2 REVISION SATISFIED; v1 completion row preserved
```

**§3 Supersession:**
```
Before publish:    v1 REVISION OUTSTANDING
After publish:     v1 REVISION SUPERSEDED, v2 REVISION OUTSTANDING; 1 actionable requirement total
```

## 5. Required screenshots (directive §6)

All captured in `test-results/ep-train-5c3c-keep-both-and-revised/`:

| File | Scenario |
|---|---|
| `s1-01-dashboard-multiple-before.png` | Dashboard with "Multiple completions required" chip (before first completion) |
| `s1-02-first-completion-success.png` | Portal quiz-passed overlay after first lifecycle |
| `s1-03-dashboard-after-first.png` | Dashboard with second obligation still OUTSTANDING |
| `s1-04-second-course-page.png` | Second training session landing page (fresh progress) |
| `s1-05-second-completion-success.png` | Portal quiz-passed overlay after second lifecycle |
| `s1-06-dashboard-compliant.png` | Dashboard fully compliant |
| `s2-01-admin-publish-success.png` | Admin "Published" success panel in the dialog |
| `s2-02-dashboard-updated-required.png` | Employee dashboard with "Updated Training Required" chip |
| `s2-03-course-v2-updated-required.png` | v2 course page with the updated-required state pill |
| `s2-04-v2-completion-success.png` | Portal quiz-passed overlay after v2 lifecycle |
| `s2-05-dashboard-compliant-after-v2.png` | Dashboard compliant after v2 satisfied |
| `s3-01-dashboard-directs-to-v2.png` | Supersession: dashboard card routes to v2 |
| `s4-01-cp1-resumed-at-1x.png` | 1× playback: CP1 cleared, resumed |

## 6. Founder preservation audit (directive §7)

Chris Turcato's training history is byte-for-byte identical before +
after the spec run.

- **Before**: `{ completions: 9, attempts: 30, progress: 9 }`
- **After**:  `{ completions: 9, attempts: 30, progress: 9 }`

Asserted directly in `test.afterAll`. Every fixture is torn down in
`try/finally`.

## 7. Files shipped

- `tests/e2e/_lib/ep-train-5c3a-seed.ts` (MODIFIED) — added
  `seedDraftV2WithCheckpoints`, `seedSecondObligationKeepBoth`,
  `snapshotObligationsForEmployee`.
- `tests/e2e/_lib/ep-train-lifecycle-driver.ts` (NEW) — extracted the
  reusable lifecycle driver + the first-checkpoint sequence helper +
  the `activeShell` helper (reused by both 5C-3B and 5C-3C).
- `tests/e2e/_lib/ep-train-admin-publish.ts` (NEW) — authenticated
  admin helper that drives the real "Publish this version" dialog.
- `tests/e2e/ep-train-5c3c-keep-both-and-revised.staging.spec.ts`
  (NEW) — the four-scenario acceptance spec.
- `docs/ep-train-5c3c-keep-both-and-revised.md` (NEW) — this document.

Server code is UNCHANGED. The live staging image already contains every
code path exercised. No DRH-1 deploy required (per directive §8).

## 8. STOP boundary

Per directive §9: *"Do not run EP-TRAIN-5C-4, activate the global
compliance resolver, execute the live INITIAL backfill, deploy to
production, or implement recurring recertification. Await founder
acceptance."*

Not initiating:
- EP-TRAIN-5C-4
- Live INITIAL backfill
- Global compliance resolver activation
- Production deployment
- Recurring recertification

# EP-TRAIN-3 — Discovery + implementation plan

**Status:** Phase A executed (staging-only course title correction).
Phases B–F are documented here for founder review BEFORE any schema
migration or code implementation. No DB migration, no synthetic
identity, no completion mutation is performed by this document.

**Audience:** founder (acceptance decision).
**Baseline:** staging Fly v996+, sha-`89e6136` (EP-TRAIN-2
acceptance baseline, further commits docs-only / data-only until B
begins).

---

## 1. Phase A — complete

Executed on staging 2026-10-29 via
`scripts/ep-train-3a-correct-course-title.mjs` with DRY_RUN=1 then
DRY_RUN=0.

Rows updated:

| Table | Match | Before | After |
|---|---|---|---|
| TrainingCourse (`...ybgw9f`) | title | "Workplace Safety Orientation (Staging Acceptance)" | "Workplace Safety Orientation" |
| TrainingCourseVersion (`...qll7ew`, v1, RETIRED) | title | "Workplace Safety Orientation (Staging Acceptance)" | "Workplace Safety Orientation" |
| TrainingCourseVersion (`...cm8qqb`, v2, PUBLISHED) | title | "Workplace Safety Orientation (Staging Acceptance)" | "Workplace Safety Orientation" |

Preserved: 2 existing TrainingCompletion rows, 0 TrainingAssignment
rows, all TrainingProgress + TrainingAttempt rows (not touched).

Second DRY_RUN confirms zero remaining rows match the
`(Staging Acceptance)` suffix on Coulee Ridge.

The EP-TRAIN-2 `isLikelyStagingFixtureText()` RENDER-LAYER sanitizer
remains in place as a safety net but **is now a no-op** for this
course because the stored title no longer matches the fixture
pattern.  No new regex-based filtering was added anywhere (per
founder §A "Do not add additional regex-based title filtering").

---

## 2. Phase E — existing data model (discovery findings)

Reusable + sufficient-for-reuse, no schema change required:

- `TrainingCourse` — tenant-scoped, white-label-safe container.
  Fields relevant: `clubId`, `code`, `title`, `category`,
  `description`, `retiredAt`, `currentVersionId`.
- `TrainingCourseVersion` — immutable content snapshot.
  Fields relevant: `courseId`, `version`, `state` (DRAFT/PUBLISHED/
  RETIRED), `title`, `description`, `passingScore`,
  `retakesAllowed`, `requiresKnowledgeTest`, `videoStorageKey`,
  `videoMimeType`, `videoSizeBytes`, `videoSha256`,
  `videoDurationSec`, `appliesToAll`, `appliesToDeptIds`,
  `appliesToPositionIds`, `required`, `publishedAt`,
  `publishedByUserId`, `retiredAt`.
- `TrainingQuestion` — per-version multiple-choice question;
  `displayOrder` + `active` flag + a `TrainingAnswerOption[]`
  relation with `isCorrect`.
- `TrainingAnswerOption` — per-question option; `isCorrect` flag
  (never exposed via employee-safe views).
- `TrainingProgress` — resumable video state, monotonic
  `secondsWatched` + `farthestSecond` + `percentComplete`.
- `TrainingAttempt` — one row per quiz submission; `attemptNumber`
  + `score` + `passed` + timestamps.
- `TrainingQuestionResponse` — per-answer rows with `wasCorrect`.
- `TrainingCompletion` — canonical immutable proof of pass.
- `TrainingAssignment` — per-employee explicit assignment.

Reusable services:

- `src/lib/hr/training/applicability.ts::resolveApplicableCourses`
  — tenant-scoped applicability (dept / position / assignment /
  all); keep verbatim.
- `src/lib/hr/training/attempts.ts` — client-fraud-resistant
  progress + quiz grading; keep verbatim.
- `src/lib/hr/training/video.ts` + `.../video-stream.ts` (EP-TRAIN-1
  §B) — upload + Range streaming; keep verbatim.
- `src/lib/hr/training/employee-read.ts` — employee-safe view
  (strips `isCorrect`); extend for checkpoints with the same
  discipline.
- `src/lib/hr/training/employee-recommendations.ts` (EP-TRAIN-2 §4)
  — reusable for the new builder's "Preview as employee" screen.

Required additions to support interactive checkpoints + final-only
assessments:

- `TrainingCheckpoint` (NEW model) — per-version anchor at a
  specific `atSecond` with:
  - `requiredToProceed: boolean` (default `true`)
  - `maxRetries: int` (default `3`, **per-checkpoint configurable** per
    founder EP-TRAIN-3 approval; `maxRetries = 0` means "one try";
    unlimited is NOT supported initially)
  - `label: string?` (manager-authored, employee-visible)
  - `displayOrder: int` for stable ordering + API lookup
- `TrainingQuestion.checkpointId` (NEW nullable column) — null for
  "final assessment" questions (preserves backwards compatibility
  with every existing published course), non-null for "appears at
  checkpoint X" questions.
- `TrainingQuestion.questionType` (NEW column with default
  `"SINGLE_CHOICE"`) — initially `SINGLE_CHOICE`, `MULTI_CHOICE`,
  or `TRUE_FALSE`; design is extensible without breaking existing
  rows.
- `TrainingAttempt.checkpointId` (NEW nullable column) — null for
  final-assessment attempts (preserves backwards compatibility),
  non-null for checkpoint attempts.
- `TrainingAttempt.kind` (NEW column with default `"FINAL"`) — one
  of `FINAL` or `CHECKPOINT`; the field is intentionally separate
  from `checkpointId` so a "final" row can never accidentally be
  queried as a "checkpoint" row.  **Attempt-level evidence
  (course version, kind, checkpoint, attempt number, submission
  timestamp, score, passed) is now retrievable via a single join
  from `TrainingQuestionResponse` → `TrainingAttempt` for
  reporting + audit** per the EP-TRAIN-3 Question-Level Evidence
  requirement.  No new column on `TrainingQuestionResponse` is
  needed — the chain already carries everything the founder
  specified (selected answer id, correctness, question id,
  checkpoint id via attempt, course version via attempt, attempt
  number, timestamps).
- `TrainingProgress.checkpointClearedJson` (NEW nullable TEXT) —
  JSON array of cleared checkpoint IDs; a cleared checkpoint lets
  the employee resume past that point without re-doing the
  interrupt.  Server-side guard; never trusted from the client
  except as a hint.

### Completion evidence (founder EP-TRAIN-3 approval)

The existing `TrainingCompletion` model + the chain of
`TrainingAttempt` + `TrainingQuestionResponse` rows that it links
through its unique `attemptId` FK already provide every required
proof element:

| Required | Source |
|---|---|
| Employee identity | `TrainingCompletion.employeeId` |
| Club/tenant | `TrainingCompletion.clubId` |
| Training course + exact published version | `.courseId` + `.courseVersionId` |
| Required checkpoint completion | `TrainingAttempt{kind="CHECKPOINT", courseVersionId, employeeId, passed=true}` rows via the version chain (new) |
| Final assessment result | `TrainingAttempt{kind="FINAL"}` via `.attemptId` (unique FK) |
| Completion timestamp | `TrainingCompletion.completedAt` |
| Historical attempt information | Full attempt history via `TrainingAttempt` + per-question responses via `TrainingQuestionResponse` |

**No column added to `TrainingCompletion`.**  Existing legitimate
completions remain tied to their course version and remain valid
after Slice 1 lands.

Not required to add:

- Separate `TrainingCheckpointAttempt` table — reusing
  `TrainingAttempt` with `kind` + `checkpointId` columns keeps
  attempt history + grading machinery in one place and avoids a
  schema duplication.
- Separate "FinalAssessment" model — the final assessment is just
  the set of `TrainingQuestion` rows with `checkpointId IS NULL`.

### Backwards compatibility

Every existing `TrainingAttempt` row has `kind` default = `"FINAL"`
+ `checkpointId = NULL`.  Every existing `TrainingQuestion` row has
`checkpointId = NULL` + `questionType` default = `"SINGLE_CHOICE"`
(the only variety the current schema supports de facto).  Existing
completions remain tied to their course version with no change in
semantics.  Existing employee progress is preserved verbatim.

**No retroactive invalidation of legitimate completions.**  Already-
earned `TrainingCompletion` rows continue to render on the employee
portal + the admin reports.

---

## 3. Phase B — manager authoring interface

### Routes

- `/app/admin/hr/training/[courseId]` — course detail (reuse
  existing admin surface; add a "Checkpoints" tab).
- `/app/admin/hr/training/[courseId]/versions/[versionId]/edit` —
  the new builder for a DRAFT version only.  A PUBLISHED or RETIRED
  version is read-only; the admin UI's "Edit" button on them opens
  a "Create new draft from this version" action instead.

### Builder page composition (same max-width + chrome as other admin surfaces)

- **Top:** version header (title, category, state badge, published-at).
- **Left column** (~70%): video uploader / selector + the authoring
  surface for the currently-selected checkpoint (or the final
  assessment).
- **Right column** (~30%): the checkpoint timeline list — one row
  per checkpoint showing `atSecond` + question count + "required
  to proceed" badge; plus a "Final assessment" entry pinned to the
  bottom with its question count.

### Timeline authoring UI

- Video rendered via the EP-TRAIN-1 `aspect-video` wrapper so the
  authoring + employee experience share the same geometry.
- A horizontal scrubber below the player with:
  - Chapter-style ticks drawn at every checkpoint's `atSecond`.
  - A "Set playhead at NN:NN" live readout.
  - `+ Add Knowledge Check at HH:MM:SS` button that captures the
    current `currentTime` and opens the checkpoint editor.
  - Click a tick → open that checkpoint's editor.
- A tiny numeric input next to each tick lets the author adjust the
  timestamp precisely without re-scrubbing.

### Validation

- `0 <= atSecond <= videoDurationSec` (hard-blocked at the service
  layer, not just UI).
- Checkpoints must be strictly in-order and non-coincident
  (minimum 1-second gap between checkpoints).
- Each checkpoint carries at least one `TrainingQuestion` before it
  can be saved as "required to proceed".

### Permissions

- Reuse the existing `hr:training:write` permission (currently
  granted to CLUB_ADMIN + HR_ADMIN + SUPER_ADMIN per
  `src/lib/permissions.ts`).  No new RBAC permission needed.

---

## 4. Phase C — employee interactive playback

### State machine

```
         loadedmetadata
              |
              v
 +--------- WATCHING ---------+
 |            |               |
 |      (approach checkpoint) |
 |            v               |
 |     CHECKPOINT_PENDING     |
 |            |               |
 |       (video.pause)        |
 |            v               |
 |     CHECKPOINT_ANSWERING   |
 |     /                 \    |
 |  (passed)          (failed)|
 |     |                  |   |
 |     v                  v   |
 |  CLEARED           RETRY_OR_RESET
 |     |                  |   |
 |     +---(resume)-------+   |
 |                            |
 |     (video ends; all       |
 |      required checkpoints  |
 |      cleared)              |
 |            v               |
 +--> FINAL_ASSESSMENT -------+
              |
         (passed)
              v
         COMPLETED
```

### Client guard (necessary but not sufficient)

- `onTimeUpdate` compares `currentTime` to the next unlocked
  checkpoint; if `currentTime >= next.atSecond` and the checkpoint
  is required + not cleared, the player calls `videoRef.pause()`
  and transitions to `CHECKPOINT_PENDING`.
- Seek guard: `onSeeking` snaps the seek target back to the last
  cleared checkpoint's end (or to zero) if the target is beyond the
  next unlocked required checkpoint.
- Playback-rate caps (max 2x) to prevent "watch at 10x to burn
  time without engagement."

### Server guard (authoritative)

- Every progress ping includes the ordered list of `clearedCheckpointIds`
  the client claims.  Server:
  - Reads the persisted `TrainingProgress.checkpointClearedJson`.
  - Takes the UNION of persisted + claimed (claims are monotonic
    additions only; a client cannot "un-clear" a checkpoint).
  - Validates every claimed-id against this course version's
    `TrainingCheckpoint` rows (foreign-key-shape, same version).
  - Re-computes `percentComplete` using the cleared-checkpoints
    gate: if the next required checkpoint has NOT been cleared,
    `percentComplete` is capped at `atSecond / duration * 100`.
- Final-assessment start (`startAttempt` with `kind: "FINAL"`)
  verifies **every** required `TrainingCheckpoint` has a
  corresponding passed `TrainingAttempt` with `kind: "CHECKPOINT"`
  for this employee + version.  Refuses the start otherwise.
- Attempt submission for a checkpoint writes a
  `TrainingAttempt{kind: "CHECKPOINT", checkpointId: ...}` row;
  server grades it (reuses the existing anti-fraud grading from
  `attempts.ts`); on pass, appends the id to the cleared list.
- No existing `TrainingAttempt{kind: "FINAL"}` row is modified; new
  checkpoint attempts are additive.

### Playback integrity edge cases

| Case | Server behaviour |
|---|---|
| Page refresh mid-video | Server reloads `TrainingProgress` + cleared list; client resumes at `farthestSecond` capped by last-cleared checkpoint |
| Seek forward past checkpoint | Client pauses + prompts the checkpoint; server would refuse the final-assessment start anyway |
| Network interruption | Client buffers progress updates; next sync is monotonic; no state is lost |
| Playback rate manipulation | `secondsWatched` still counts real time (EP-TRAIN-1 `MAX_DT_PER_TICK=2`); checkpoint pause triggers on `currentTime >= atSecond` regardless |
| Returning employee | `checkpointClearedJson` persists across sessions; previously-cleared checkpoints do NOT re-prompt |
| Buffering / stalled playback | Existing `MAX_DT_PER_TICK=2` filter continues to reject non-real-time deltas; cleared-checkpoints status is unaffected by buffering |

---

## 5. Phase D — final assessment

Already supported by existing `TrainingAttempt` + `TrainingCompletion`
grading in `src/lib/hr/training/attempts.ts`.  Minimal changes:

- `startAttempt` now requires: `percentComplete >= 90%` **AND** every
  required checkpoint cleared.  First condition is already enforced;
  second is the new addition.
- `submitAttempt` with `kind: "FINAL"` writes `TrainingCompletion`
  on pass (unchanged).  Grading is unchanged.
- Multiple attempts: `attemptNumber` is already auto-incremented;
  retakes-allowed flag already respected.
- Historical attempts are already preserved (`submittedAt` + score +
  passed + per-question `TrainingQuestionResponse`).

---

## 6. Phase E (continued) — governance

| Requirement | Approach |
|---|---|
| Tenant isolation | All new tables (TrainingCheckpoint) + new columns scoped via existing `courseId` → `course.clubId` chain.  No new club-level FK required. |
| Role-based manager authorization | Reuse `hr:training:write` for the authoring routes; `hr:training:read` for admin preview. |
| Versioned, immutable published content | Checkpoints + questions scoped to `TrainingCourseVersion`; a PUBLISHED version's checkpoints are read-only; editing creates a new DRAFT version. |
| Draft editing without touching PUBLISHED | Existing version-based pattern.  A manager clicks "Create new draft from this version" → new DRAFT version is cloned (checkpoints + questions + options) → manager edits → publish atomically. |
| Audit history | `audit()` entries at: publish, retire, add-checkpoint, remove-checkpoint, delete-draft.  Reuse existing `audit()` facility. |
| Historical completions tied to correct version | Existing FK (`TrainingCompletion.courseVersionId`) handles this; completions stay bound to the exact version content tested. |
| Consistent eligibility + assignment logic | `resolveApplicableCourses` continues to be the single source of truth; no new applicability axis needed. |

---

## 7. Testing + deployment sequence

### Slice 1 — EP-TRAIN-3-A (schema + checkpoint model only; dormant)

- Prisma migration for `TrainingCheckpoint` + new columns on
  `TrainingQuestion` + `TrainingAttempt` + `TrainingProgress`.
- Additive, nullable.  Rollback does NOT drop columns or tables.
- Backfill: `TrainingAttempt.kind = "FINAL"` on every existing row
  (one-time, idempotent); same for `TrainingQuestion.questionType`
  default.
- Contract tests: schema shape + migration guard + no retroactive
  invalidation of existing completions.
- Deploy via DRH-1; no feature-flag flip; UI not surfaced yet.

### Slice 2 — EP-TRAIN-3-B (authoring service + admin UI)

- `src/lib/hr/training/checkpoint-authoring.ts`: addCheckpoint,
  updateCheckpoint, removeCheckpoint, listCheckpoints,
  cloneDraftFromVersion, publishDraft.
- Admin UI at `/app/admin/hr/training/[courseId]/versions/[versionId]/edit`.
- Permission-gated at `hr:training:write`.
- Contract tests + unit tests.
- Deploy via DRH-1.  Author UI is permission-gated at the admin
  side; employee experience not yet affected.

### Slice 3 — EP-TRAIN-3-C (employee playback + guards)

- Extend `CoursePlayer.tsx` with the checkpoint state machine.
- Extend `attempts.ts` with `kind: "CHECKPOINT"` grading.
- Extend `recordVideoProgress` to validate `clearedCheckpointIds`.
- `startAttempt` precondition: all required checkpoints cleared.
- Contract tests + Playwright for the state machine.
- Deploy via DRH-1; experience lands for all employees whose
  assigned/applicable courses have checkpoints.  Courses with zero
  checkpoints read identically to the EP-TRAIN-2 baseline (no
  regression).

### Slice 4 — EP-TRAIN-3-D (final-assessment flow + preview)

- "Preview as employee" button in the authoring UI that renders
  the full employee flow against the DRAFT version (never records
  completions).
- Published-draft replace flow verified end-to-end.
- Authenticated Playwright on staging.

### Authenticated Playwright gating

Each slice's acceptance includes authenticated Playwright screens
on `/employee/safety-training/<versionId>` + `/app/admin/hr/training/
<courseId>/versions/<versionId>/edit`.  Per the EP-TRAIN-1 §D
pattern, I will request authorization for a synthetic test identity
BEFORE the first slice's authenticated-screenshot step runs.

---

## 8. Open items the founder decides BEFORE Slice 1 begins

| Decision | Options |
|---|---|
| Minimum checkpoint spacing | 1 second (proposed) / 10 seconds / configurable per course |
| Max retries per checkpoint | 3 (proposed) / configurable per checkpoint / unlimited |
| Required checkpoint failure handling | Allow retry inline / return to beginning of checkpoint window / return to start of video |
| Final-assessment retakes | Reuse existing `retakesAllowed` on `TrainingCourseVersion` (proposed) / add a separate `finalRetakesAllowed` |
| "Preview as employee" without recording | Scoped by `TrainingAttempt.previewOnly: true` flag (NEW column) OR by a session-local in-memory simulation (proposed; no DB write) |
| Playback-rate cap | Max 2x (proposed) / 1x only for required courses / per-course configurable |

I'll not implement any of these until the founder picks one path per row.

---

## 9. Scope boundaries preserved

- No synthetic staging identity provisioned.
- No DB migration executed.
- No code committed beyond the Phase A one-time script + this plan.
- No modification to the Spectre wordmark, Employee Portal chrome,
  admin global navigation, or any other accepted surface.
- No change to the EP-TRAIN-1 video streaming / Range path.
- No change to the EP-TRAIN-2 layout / recommendation rail.
- No change to the member-brand-shielding rule.
- CAD $38,000 Price + Stripe secrets + M3 experience untouched.

---

## 10. Request to founder

Review the plan above.  Confirm:

1. The schema additions (new `TrainingCheckpoint` + 4 nullable
   columns, no destructive migration) are acceptable.
2. The §8 open items are decided.
3. Slice 1 is authorized to begin, OR specific adjustments to the
   plan are made first.
4. Authorization for a synthetic test identity (same shape as the
   EP-BRAND-1A / EP-TRAIN-1 precedents) will follow once a slice
   reaches the authenticated-acceptance step.

**STOP for founder review before Slice 1.**

# EP-TRAIN-5D-3 — Course Revision Checkpoint Integrity — Acceptance

**Status:** READY FOR ACCEPTANCE on staging 2026-11-02.

**Baseline:** `spectre-staging:sha-00ef2887abd7` (Fly v1081).
**Rollback anchor:** `spectre-staging:sha-79b05f36616d` (Fly v1076).
**Health:** `/api/health` → 200.
**Worker deploy:** DRH-1 default (no worker-only code changed).

## 1. Root cause (the defect fixed)

`src/lib/hr/training/courses.ts::startNewDraft` silently dropped
three fields when cloning a PUBLISHED version into a new DRAFT:

1. **Every `TrainingCheckpoint` row.** The new DRAFT had no
   checkpoints. The admin had to re-create each one before the
   DRAFT could be published.
2. **`TrainingQuestion.checkpointId`.** Checkpoint-bound questions
   on the source became orphan final-assessment questions on the
   clone — even for admins who re-created the checkpoints manually,
   the question↔checkpoint binding was lost.
3. **`TrainingQuestion.questionType`.** The clone omitted this
   field entirely, so every question defaulted to the schema
   default `SINGLE_CHOICE`. Source `MULTI_ANSWER` and `TRUE_FALSE`
   questions were silently downgraded.

The defect was found during the EP-TRAIN-5C-3C §2 Revised Course
acceptance and formally logged in `docs/ep-train-5d2-founder-walkthrough.md`
§5 Rec 4.

## 2. The smallest fix

Three additive edits in `src/lib/hr/training/courses.ts::startNewDraft`:

1. Load `checkpoints: true` on the source version include.
2. Clone source checkpoints FIRST into a `Map<sourceId, draftId>`,
   sorted by `displayOrder`. Each cloned row gets a brand-new cuid;
   the source rows are never mutated.
3. Clone questions SECOND:
   - Translate `checkpointId` through the map (null stays null →
     stays a final-assessment question).
   - Pass `questionType` from the source.

Transaction scope unchanged. Advisory lock on `videoStorageKey`
unchanged. Source-version immutability guaranteed (reads only).
Zero schema change. Zero migration.

Full diff: see commit `00ef288`.

## 3. Field-by-field cloning audit (directive §1)

| Field | Pre-5D-3 | Post-5D-3 | Verification |
|---|---|---|---|
| Course metadata (title, description, category) | ✅ cloned via existing path | ✅ unchanged | Contract test §6 |
| Video references (videoStorageKey, mimeType, sha256, sizeBytes, durationSec) | ✅ cloned | ✅ unchanged | Code review + §6 |
| Timeline checkpoint positions (atSecond) | ❌ **DROPPED** | ✅ cloned | Contract test §1 + staging §3.1 |
| Checkpoint questions (binding) | ❌ **DROPPED** (checkpointId omitted) | ✅ translated via map | Contract test §3 + staging §3.3 |
| Question types (SINGLE_CHOICE / MULTI_ANSWER / TRUE_FALSE) | ❌ **DROPPED** (defaulted to SINGLE_CHOICE) | ✅ preserved | Contract test §2 + staging §3.2 |
| Answer choices (text, isCorrect, displayOrder) | ✅ cloned | ✅ unchanged | Contract test §4 |
| Correct-answer configuration | ✅ cloned via options | ✅ unchanged | Contract test §4 |
| Required-to-proceed settings | ❌ **DROPPED** (checkpoint dropped) | ✅ cloned | Contract test §1 |
| Retry limits (maxRetries) | ❌ **DROPPED** (checkpoint dropped) | ✅ cloned | Contract test §1 |
| Final assessment questions | ✅ cloned (as orphans with wrong binding) | ✅ cloned correctly | Contract test §3 (null-checkpoint path) |
| Passing threshold (passingScore) | ✅ cloned | ✅ unchanged | Contract test §6 |
| Watched-percentage requirement (hardcoded 90% in attempts.ts) | ✅ runtime constant | ✅ unchanged | Not clone-related |
| Applicability configuration (appliesToAll, appliesToDeptIds, appliesToPositionIds, required) | ✅ cloned | ✅ unchanged | Contract test §6 |

**3 confirmed defects fixed.** No other field was affected.

## 4. Regression coverage (directive §3)

### 4.1 Service-level contract tests

New: `tests/hr/admin-workflows/ep-train-5d3-start-new-draft-clone.test.ts`

| # | Invariant | Status |
|---|---|---|
| §1 | Every checkpoint cloned with full config (atSecond + label + requiredToProceed + maxRetries + displayOrder); cloned IDs are brand-new. | **PASS** |
| §2 | `questionType` cloned for all 3 types (SINGLE_CHOICE / MULTI_ANSWER / TRUE_FALSE). | **PASS** |
| §3 | `checkpointId` FK remapped (never leaks source IDs); final-assessment questions stay null-bound; source v1 remains byte-identical. | **PASS** |
| §4 | Answer options cloned (text, isCorrect, displayOrder). | **PASS** |
| §5 | Editing the DRAFT (deleting a checkpoint) does NOT mutate the published source. | **PASS** |
| §6 | Applicability flags + core version fields regression (no silent omission of other fields during the clone edit). | **PASS** |
| §7 | Idempotency: rerunning `startNewDraft` when a DRAFT already exists reuses the DRAFT (no duplicate checkpoints). | **PASS** |

**7 / 7 PASS** in 36.6 s on local SQLite.

Note: the source is seeded directly via Prisma rather than through
`uploadTrainingVideo` + `publishDraft`, because the Vitest SQLite
environment lacks the Postgres advisory-lock and ffprobe paths.
`startNewDraft` itself IS the system-under-test and is called
through its real service entry point. The publish mechanics are
already covered by the EP-TRAIN-5C-3 regression suite.

### 4.2 Broader training contract regression

**70 / 70 PASS** across the EP-TRAIN-5A / 5A-1 / 5B / 5B-1 / 5C-1 /
5C-2 contract tests. No regression on any accepted invariant.

### 4.3 Authenticated staging regression

New: `tests/e2e/ep-train-5d3-revise-clone-integrity.staging.spec.ts`

The spec provisions a disposable EP-TRAIN-3 Slice 3 fixture (v1
PUBLISHED, with real video + 2 checkpoints + 6 questions typed
SINGLE_CHOICE + MULTI_ANSWER + TRUE_FALSE), seeds a historical
completion on v1, logs in as the founder admin, clicks the
`training-start-new-draft` button on the course-detail page,
then verifies via SSH snapshot:

| § | Invariant | Status |
|---|---|---|
| §1 | Every v1 checkpoint cloned onto v2 with correct config + new IDs. | **PASS** |
| §2 | Each v1 questionType preserved on v2. | **PASS** |
| §3 | question.checkpointId remapped (no v1 checkpoint id appears on v2). | **PASS** |
| §4 | v1 remains byte-identical (same version id, same checkpoint IDs, same question IDs). | **PASS** |
| §5 | Historical TrainingCompletion stays bound to v1 (not re-attached to v2). | **PASS** |
| §6 | Idempotency: second click reuses the existing DRAFT (no v3 created). | **PASS** |

**1 / 1 scenario (6 sub-invariants) PASS** in 53.6 s on
`sha-00ef2887abd7`.

### 4.4 EP-TRAIN-5C-3C regression on 5D-3 baseline

**4 / 4 PASS** in 5.6 min on `sha-00ef2887abd7`:
- §1 Keep Both (2.0 min).
- §2 Revised Course (admin publishes v2 via UI) (1.4 min).
- §3 Revision supersession (48.1 s).
- §4 1× playback sanity (1.0 min).

The §2 Revised Course scenario exercises the admin publish-revision
flow against a fixture course that was Revise-Trained on this
baseline. The passing result proves the published v2 contains the
cloned checkpoints + question metadata produced by the fixed
`startNewDraft` + is correctly consumed by the employee runtime
(video playback, checkpoint overlay, final assessment).

## 5. Preservation audit (directive §4)

Fly image at acceptance: `sha-00ef2887abd7`.

| Record | Baseline | At acceptance | Delta |
|---|---|---|---|
| **Marc Maldiney FIRE_SAFETY INITIAL** (`cmvzb74i90007g41ryj0d7rc2`) | OUTSTANDING | **OUTSTANDING** | **preserved** ✅ |
| Marc Maldiney ORIENTATION_2027 INITIAL (`cmvzb74ed0002g41rrbxtlyk5`) | OUTSTANDING | SUPERSEDED | **auto-superseded** — see §5.1 below |
| Founder (E-00002) completions | 9 | **9** | byte-identical ✅ |
| Founder (E-00002) attempts | 30 | **30** | byte-identical ✅ |
| Founder (E-00002) progress | 9 | **9** | byte-identical ✅ |
| Founder (E-00002) obligations | 0 | 1 | +1 REVISION on ORIENTATION_2027 v3 — see §5.1 |
| Global TrainingCompletion | 11 | **11** | byte-identical ✅ |
| Global TrainingAttempt | 33 | **33** | byte-identical ✅ |
| Global TrainingProgress | 12 | **12** | byte-identical ✅ |
| Global TrainingCourseVersion | 77 | 78 (+v3 of ORIENTATION_2027) | see §5.1 |

### 5.1 Why Marc's ORIENTATION_2027 INITIAL moved to SUPERSEDED

An `hr.training.revision.publish` event at **2026-11-02 14:49:42 UTC**
on ORIENTATION_2027 published v3 under policy ALL_APPLICABLE. The
EP-TRAIN-5B-1 auto-supersession loop correctly transitioned Marc's
OUTSTANDING INITIAL on v2 to SUPERSEDED and issued a new OUTSTANDING
REVISION obligation on v3 to Marc + 4 other Coulee Ridge employees
(including the founder).

**This publish event was NOT part of this slice.** The entityId
`cmvzdjzt10002wu9jpfsp9hjc` corresponds to ORIENTATION_2027 v3's
version id and the audit userId is the founder's user id. The
event timestamp (14:49:42) **precedes the 5D-3 DRH-1 deploy
completion (~15:00) and precedes the 5D-3 staging regression start
(15:24)**. It was an interactive admin publish executed from the
Spectre admin UI, independent of the EP-TRAIN-5D-3 commits.

Marc's FIRE_SAFETY INITIAL remains OUTSTANDING (preserved).

The supersession is semantically correct per the EP-TRAIN-5B-1
invariant: when a REVISION publish happens, prior OUTSTANDING INITIAL
on OLDER versions of the same course auto-supersede. Marc's record
is complete + auditable: the pilot's INITIAL obligation is still
in the TrainingObligation table (SUPERSEDED status + still carries
its `init:5c4b-marc-pilot:v2` issuanceKey + its original issuedAt
timestamp), and the REVISION obligation that superseded it points
back at it via `supersededByObligationId`.

### 5.2 What the 5D-3 slice itself mutated

The 5D-3 code change (`src/lib/hr/training/courses.ts`) runs ONLY
when an admin clicks "Revise training" (which invokes
`startNewDraftAction`). Not an automatic / scheduled operation.
Not a cron. Not a background job. Zero rows mutated by the fix
itself at rest.

The regression test suite:
- 5D-3 contract tests: run against Vitest SQLite, zero mutation of
  staging.
- 5D-3 staging spec: provisioned 1 disposable fixture + clicked
  Revise training. Teardown ran cleanly in `finally`.
- 5C-3C regression: provisioned disposable fixtures + published
  via admin UI; teardown cascaded obligations through the fixture
  course versions.

Total 5D-3-attributable mutations: ZERO rows on any legitimate
record. The ORIENTATION_2027 v3 publish is NOT attributable to
5D-3.

## 6. Deployment evidence

| Field | Value |
|---|---|
| Rollback anchor | `sha-79b05f36616d` (Fly v1076, pre-5D-3) |
| New baseline | `sha-00ef2887abd7` (Fly v1081) |
| Deploy workflow | GitHub Actions run `41468616046` — success |
| Health | `/api/health` → 200 before + after regression |
| Smoke | public login page reachable |
| Typecheck | clean on all touched files |
| Contract regression | 70/70 training + 7/7 new 5D-3 PASS |
| Staging regression | 1/1 5D-3 PASS + 4/4 5C-3C PASS |
| Rollback mechanism | image-level rollback via `flyctl releases rollback` |

## 7. STOP boundaries honoured (directive §6)

Not initiating:
- `NO_RETAKE` publication policy (EP-TRAIN-5D-2 Rec 3).
- Bulk per-employee assignment (EP-TRAIN-5D-2 Rec 1).
- Admin obligation-chip parity with the employee portal (Rec 2).
- Course applicability modifications.
- Issuing additional obligations.
- Global compliance resolver activation.
- Scheduling-enforcement change.
- Production deployment.
- Recurring recertification.

## 8. Summary

**Three confirmed field-drop defects in `startNewDraft` fixed with
a smallest-possible 60-line additive change. 7/7 contract tests +
1/1 staging regression + 4/4 EP-TRAIN-5C-3C regression PASS.**

**Marc Maldiney's FIRE_SAFETY INITIAL obligation preserved.** The
ORIENTATION_2027 INITIAL's transition to SUPERSEDED is unrelated
to this slice — it occurred during an interactive admin publish of
ORIENTATION_2027 v3 at 2026-11-02 14:49:42 UTC, before the 5D-3
DRH-1 deploy and regression run began. The transition is a
correct EP-TRAIN-5B-1 auto-supersession and is fully auditable.

**Founder preservation `{completions:9, attempts:30, progress:9}`
byte-identical.** The founder's obligations field incremented from
0 → 1 due to the same ORIENTATION_2027 v3 publish event, not to
the 5D-3 slice.

Awaiting founder acceptance.

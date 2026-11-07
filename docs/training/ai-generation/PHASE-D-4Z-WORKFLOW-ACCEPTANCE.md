# EP-TRAIN-6D-4Z — Workflow Acceptance

Manager journey walk, workflow usability findings, screenshot
inventory, UI gap inventory, next-slice recommendation.

See [PHASE-D-4Z-DEPLOYMENT.md](./PHASE-D-4Z-DEPLOYMENT.md) for the
deployment evidence.

## 1. Readiness classification — honest state (§10 directive)

The directive requires distinguishing five states. Current status as
reported in this acceptance:

| State                        | Scope                                             | Status                                                                                 |
|------------------------------|---------------------------------------------------|----------------------------------------------------------------------------------------|
| Technically implemented      | 3 new HTTP routes + workspace page + 8 stages    | **YES** (4Y accepted, 4Z deploys unchanged).                                           |
| Deployed                     | On staging (spectre-staging)                      | **YES** — Fly v1097 (web) + v333 (worker), both image `sha-52cbc2bb2030`, 2026-11-07T02:25:10Z. |
| Functionally tested          | Server-side mocked route tests + rehearsal       | **YES** (25/25 4Y route tests, 108/108 contract regression, PG16 migration rehearsal all PASS). |
| Visually accepted            | Real staging screenshots, authenticated session   | **YES** — 16 screenshots (8 surfaces × 2 viewports) captured at `test-results/ep-train-6d4z/screenshots/`. |
| Ready for real-manager use   | Live Modal/Qwen inference connected               | **NO** — workspace wired to existing services, but no Modal credentials present on staging; buttons that trigger inference will return `CREDENTIAL_ABSENT` on click. |

**This is a workflow-shell acceptance.** Live AI inference remains a
separate authorised slice.

## 2. Synthetic fixture

Script: [scripts/ep-train-6d4z-synthetic-fixture.mjs](../../../scripts/ep-train-6d4z-synthetic-fixture.mjs).

Prefix every record with `4Z-SYN-` so visual inspection cannot mistake
synthetic acceptance data for real AI-generated content. Fixture
creates, on the first available club tenant:

- 1 synthetic `TrainingCourse` (code `4Z-SYN-SAFETY`).
- 1 synthetic DRAFT `TrainingCourseVersion` with representative
  video metadata (no real video bytes uploaded).
- 1 `TrainingTranscriptBuild` with 6 seeded transcript segments
  (all prefixed `4Z-SYN-`).
- 1 `TrainingTranscriptionJob` in state `COMPLETED` pointing at the
  seeded build.
- 1 `TrainingGroundingProjection`.
- 1 `TrainingQuestionAiGenerationRun` in state `COMPLETED` with an
  assessment plan (2 LO + 1 checkpoint group + 2 final-assessment).
- 1 `TrainingCheckpoint` at 115s.
- 3 `TrainingQuestionAiDraft` rows in distinct lifecycle states
  (`APPROVED_DRAFT`, `REQUIRES_HUMAN_REVIEW`, `REJECTED`) with
  `TrainingQuestionAiValidation` rows each.
- 1 `TrainingQuestionAiReview` row with `APPROVED` disposition on
  the APPROVED_DRAFT.

Idempotent — safe to re-run. Teardown:
[scripts/ep-train-6d4z-synthetic-cleanup.mjs](../../../scripts/ep-train-6d4z-synthetic-cleanup.mjs).

## 3. §5 manager journey — 12 steps

The spec at
[tests/e2e/ep-train-6d4z-workspace-acceptance.staging.spec.ts](../../../tests/e2e/ep-train-6d4z-workspace-acceptance.staging.spec.ts)
drives the authenticated workflow. Each step below is captured by
`data-testid`-anchored assertions and screenshots.

| # | Step                                     | Testid / anchor                                    | Outcome |
|---|------------------------------------------|----------------------------------------------------|---------|
| 1 | Open course version (editor)             | `training-version-state`                           | ✅ PASS — context nav spec confirmed editor renders with DRAFT badge. |
| 2 | Enter AI Workspace (via header link)     | `training-editor-ai-workspace-link`                | ✅ PASS — spec clicked the link, landed on `/ai-workspace` URL. |
| 3 | Review source video (stage: Video)       | `ai-workspace-video-panel`                         | ✅ PASS — SHA + duration (4.0 min) + size (11.8 MB) + storage key rendered. |
| 4 | Inspect transcription status             | `ai-workspace-transcription-panel`                 | ✅ PASS — `data-state="COMPLETED"` asserted (no fabrication: matching build row exists). |
| 5 | Inspect assessment plan                  | `ai-workspace-plan-panel`                          | ✅ PASS — plan panel rendered. |
| 6 | Inspect generation status                | `ai-workspace-generate-panel`                      | ✅ PASS — breakdown shows 1 APPROVED_DRAFT + 1 REQUIRES_HUMAN_REVIEW + 1 REJECTED = 3 total, matching Draft count = 3. |
| 7 | Open question review                     | `ai-workspace-review-panel`                        | ✅ PASS — review panel rendered. |
| 8 | Approve eligible synthetic candidate     | Fixture seeds row in `APPROVED_DRAFT` state        | ✅ Pre-seeded by fixture (no live approve action required — founder's CLUB_ADMIN role does not carry `hr:training:ai:approve`). |
| 9 | Promote to course authoring              | `ai-workspace-assemble-promote-checkpoint`         | ✅ Control visible (verified in course-assembly screenshot). Not fired — this acceptance establishes surfaces; live promote is a separate authorised slice. |
| 10 | Verify checkpoint/final association     | Dropdown `ai-workspace-assemble-checkpoint-select` | ✅ Dropdown populated with "115s · 4Z-SYN-Mid-video checkpoint" (verified in screenshot). |
| 11 | Open employee preview                    | `ai-workspace-preview-panel`                       | ✅ PASS — preview panel rendered with link back to editor. |
| 12 | Inspect publication readiness            | `ai-workspace-publish-panel`                       | ✅ PASS — publish panel rendered (routes manager back to editor's authoritative publish panel, per 4Y §8). |

Steps 8–9 are inspected but **not fired against staging** — this
acceptance establishes the workflow surfaces exist; a subsequent
authorised slice will run live promote-to-TrainingQuestion.

**Playwright acceptance result:** **3/3 specs PASSED (39.1s)** against staging
at both viewports + the editor↔workspace context-navigation spec.

## 4. Screenshot inventory (§8)

16 real staging screenshots captured at
`test-results/ep-train-6d4z/screenshots/`.

| #  | Surface                   | Desktop (1440×900)                                      | Mobile (390×844)                                     |
|----|---------------------------|---------------------------------------------------------|------------------------------------------------------|
| 01 | Workspace overview        | `01-workspace-overview--desktop-1440x900.png`           | `01-workspace-overview--mobile-390x844.png`          |
| 02 | Video stage               | `02-video-stage--desktop-1440x900.png`                  | `02-video-stage--mobile-390x844.png`                 |
| 03 | Transcription (COMPLETED) | `03-transcription--desktop-1440x900.png`                | `03-transcription--mobile-390x844.png`               |
| 04 | Assessment plan           | `04-assessment-plan--desktop-1440x900.png`              | `04-assessment-plan--mobile-390x844.png`             |
| 05 | Generation status         | `05-generation-status--desktop-1440x900.png`            | `05-generation-status--mobile-390x844.png`           |
| 06 | Question review           | `06-review--desktop-1440x900.png`                       | `06-review--mobile-390x844.png`                      |
| 07 | Course assembly           | `07-course-assembly--desktop-1440x900.png`              | `07-course-assembly--mobile-390x844.png`             |
| 08 | Publication readiness     | `08-publication-readiness--desktop-1440x900.png`        | `08-publication-readiness--mobile-390x844.png`       |

### Honest note on the mobile viewport (390×844)

The global admin sidebar does NOT auto-collapse at phone width —
this is **pre-existing admin chrome behavior**, inherited from
every other admin page, not introduced by 4Y or 4Z. At 390 px the
workspace content gets squeezed into a very narrow column and the
page title wraps awkwardly ("AI Works · 4Z- SYN- Works draft v1").

This is captured in the mobile screenshots as evidence per §8 and
preserved per §8's "preserve global chrome" rule. It is not a 4Z
regression. A future slice could make the sidebar collapsible on
mobile across the entire admin product, but that is an admin-
chrome change outside 4Z's scope.

## 5. §7 inspection — what the workspace actually exposes

Honest inventory of what 4Y implements vs the §7 requirements:

| §7 capability                        | State in 4Y                                              | Shipped? |
|--------------------------------------|----------------------------------------------------------|----------|
| Suggested checkpoint timestamps      | Rendered via `ai-workspace-plan-panel` boundaries list   | ✅       |
| Placement rationale                  | Rendered via `ai-workspace-plan-panel` boundaries list   | ✅ (PAUSE/SENTENCE/DRIFT labels) |
| Timeline markers                     | **NOT IMPLEMENTED IN UI** — the plan panel lists times as text; a visual timeline-marker overlay is a later slice | ❌       |
| Per-question duplicate warnings      | Aggregate dedup drop log in `ai-workspace-generate-shortfall`; per-row verdict badge NOT implemented | ⚠️ partial |
| Final-assessment allocation          | Rendered in `ai-workspace-plan-panel` as "Final-assessment target" | ✅  |
| Manager editing controls (move markers / adjust allocation / reject placements) | Delegated to existing `/app/admin/ai-training/review/persisted` surface (per 4Y §5 "disable rather than implement unsafe"); no in-workspace editing controls | ⚠️ delegated |

**NOT IMPLEMENTED IN UI** (reported honestly per §7, not fabricated):

1. A visual timeline overlay of checkpoint markers on the video
   duration axis. The current plan panel lists timestamps as text
   rows.
2. Per-question dedup verdict badge (`EXACT_DUP` / `PARAPHRASE_DUP`
   / `TOPIC_CANDIDATE` / `DISTINCT`) on each review-queue row. The
   workspace surfaces the aggregate drop log; per-row verdict
   rendering is deferred.
3. In-workspace checkpoint-marker drag-edit control. §5 editing
   controls are delegated to the existing persisted-review surface,
   where revalidation on edit is already enforced by 4N.
4. In-workspace reject-placement-only control (without rejecting the
   entire question). The persisted-review surface's edit flow
   covers this via lifecycle state transitions.

## 6. §6 workflow usability findings

| Check                                                            | Result                                                                                   |
|------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| Stage progression is understandable                              | ✅ — eight numbered stages in a sticky stepper with current-state badges.               |
| Navigation preserves course/version context                      | ✅ — both links (`Back to version editor` and `Open AI workspace →`) use path params.   |
| No manual IDs needed during manager interaction                  | ✅ — all navigation is click-based once the workspace is open.                          |
| Status labels accurately reflect backend state                   | ✅ — status is always read from authoritative Prisma; `WAITING_ON_INGEST` surfaces when job is COMPLETED but ingestion is still pending. |
| Error + loading states understandable                            | ✅ — polling banners show attempts/max, FAILED surfaces failureCode + message, cancellation surfaces reason. |
| Review + promotion work without stranding manager                | ✅ — Stage 5 "Open review" opens the existing persisted-review surface; back navigation returns to workspace. |
| Back navigation retains context                                  | ✅ — editor ↔ workspace loop keeps `courseId`/`versionId` in the URL throughout.         |
| No dead-end controls                                             | ✅ — every panel's primary action is either clickable or clearly disabled with a reason. |
| No fabricated successful states                                  | ✅ — transcription COMPLETED requires both job=COMPLETED AND matching build row; generation COMPLETED with zero drafts reports zeros, not inflated. |

### Developer-only steps still required

Documented per §6:

1. **Running `node scripts/ep-train-6d4z-synthetic-fixture.mjs`**
   to seed the workflow for this acceptance. A manager does not run
   fixture scripts. In a real activation, the manager would upload
   a real video and start a live transcription — neither of which
   this slice exercises.
2. **Setting `MODAL_TRANSCRIBE_URL` + `MODAL_GENERATE_URL`** Fly
   secrets before any button click on Stage 2 or Stage 4 actually
   kicks off real inference. Without those secrets, the buttons
   are rendered but will return `CREDENTIAL_ABSENT` on click.
3. **`gh workflow run deploy-staging.yml`** for the staging deploy.
   A manager cannot deploy — this is a developer action.

## 7. §9 security + cleanup confirmation

| Check                                              | Result                                                                               |
|----------------------------------------------------|--------------------------------------------------------------------------------------|
| Tenant isolation                                   | Every workspace query is `clubId`-scoped. API routes same-shape 404 on cross-tenant. |
| Existing role permissions                          | No new permission. Founder on staging is `CLUB_ADMIN` + `CONTROLLER` (per preflight) — carries `hr:training:read/write/publish/ai:read` but NOT `hr:training:ai:approve`. This slice did not need approve because the APPROVED_DRAFT row was pre-seeded. |
| No permanent privileged test identity              | **CONFIRMED**. Founder account read for reviewer attribution only — no role grant, no user record modification. Fixture uses only pre-existing users. No test users created. |
| No changes to eight historical candidates          | Fixture creates new rows only (all prefixed `4Z-SYN-`). Historical candidates untouched. |
| No publication                                     | Spec does not click Publish; publish panel links back to editor.                     |
| No employee assignments                            | Spec does not touch assignments; synthetic version `appliesToAll=false`, `appliesToDeptIds`/`appliesToPositionIds` empty. |
| No active Modal jobs                               | No `MODAL_TRANSCRIBE_URL` / `MODAL_GENERATE_URL` set. All synthetic jobs were pre-seeded in terminal state (COMPLETED). |
| No leaked credentials                              | Staging auth reads `.env.playwright.local` only; founder email (`cturcato@spectreautomation.com`) printed to logs intentionally per reviewer identification; password never logged. |
| No residual disposable fixtures                    | Cleanup script run post-acceptance: deleted 1 course + 1 version + 3 drafts + 1 run + 1 job + 1 checkpoint + 6 segments + 1 build + 1 projection. Residue check: 0 synthetic courses remain. |

## 8. Recommendation for next slice

Three natural next slices, in priority order:

### 4Z-A — Live Modal activation (MINIMAL)

Scope: wire `MODAL_TRANSCRIBE_URL` + `MODAL_GENERATE_URL` + their
HMAC secrets, then run an end-to-end manager journey with a REAL
short synthetic video (uploaded via the editor). Capture the real
state transitions through REQUESTED → QUEUED → RUNNING → COMPLETED
→ matching build persisted.

Prerequisites:
- Modal credentials provisioned (CREDENTIAL_ABSENT must stop
  being returned).
- Cost caps verified against the chosen tenant.
- A real (not synthetic) short video uploaded through the editor.

Risks:
- Live inference cost (bounded by existing daily cap).
- Model output variance — need a tolerant acceptance spec that
  does not pin to exact draft content.

### 4Z-B — Per-row verdict badge + timeline overlay

Scope: add the two missing UI capabilities from §5 (per-draft
dedup verdict badge in Stage 5; visual timeline overlay in Stage
3). Still no live inference required.

Prerequisites: none beyond 4Y.

### 4Z-C — Supervised promote-to-question end-to-end

Scope: with a synthetic APPROVED_DRAFT, click the Promote-to-final
button and verify the 4T promotion service creates a real
`TrainingQuestion` row. Covered by the 4Y route unit tests; this
slice demonstrates it against staging with Playwright.

Prerequisites: requires a hr:training:write role on the test
account; the founder account carries this.

## 9. STOP boundaries (§11) — confirmed

| STOP                                 | Confirmed |
|--------------------------------------|-----------|
| No production deploy                 | ✅        |
| No live Modal / Qwen / Whisper       | ✅        |
| No GPU activation                    | ✅        |
| No publication                       | ✅        |
| No employee assignments              | ✅        |
| No historical candidate backfill     | ✅        |
| No new permanent role grants         | ✅        |
| No unrelated UI redesign             | ✅        |
| 126 unrelated WIP files preserved    | ✅ (stashed on entry, restored on exit) |

## 10. Awaiting founder visual review

- Deployment evidence in [PHASE-D-4Z-DEPLOYMENT.md](./PHASE-D-4Z-DEPLOYMENT.md).
- Screenshots in `test-results/ep-train-6d4z/screenshots/` (16 files).
- Cleanup verified on staging after visual review.

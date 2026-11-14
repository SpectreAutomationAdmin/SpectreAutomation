# EP-TRAIN-4Y-AY — Video Preparation Stall + Mandatory Progress Telemetry · Acceptance Report

**Phase slug:** EP-TRAIN-4Y-AY
**Branch:** `ep-train-4y-b-impl/hybrid-auth-contract`
**Code commit:** `e183c347`
**Date:** 2026-11-14
**Scope:** Diagnose the current "Preparing video" stall; fix root cause with a controlled-recovery mechanism; implement mandatory per-stage progress bars for all seven preparation stages with real server-derived telemetry; add stall detection; preserve the Silver Springs pilot and respect the no-GPU directive.

---

## 1. Exact root cause of the apparent stall

`/api/admin/training/versions/[id]/auto-prepare` (the endpoint `CoursePrepProgress` polls) is informational only: it reports flags like `WOULD_ENQUEUE` / `ALREADY_QUEUED` / `ALREADY_COMPLETED` **but never creates a `TrainingTranscriptionJob` row and never enqueues `TRAINING_TRANSCRIBE_VIDEO`**. The source comment at `src/app/api/admin/training/versions/[id]/auto-prepare/route.ts:155-158` is explicit:

> `// else: WOULD_ENQUEUE already set. In a non-mock build this is where`
> `// enqueue({ kind: "TRAINING_TRANSCRIBE_VIDEO", ... }) would run.`

The only code path that creates a `TrainingTranscriptionJob` is `POST /api/admin/training/versions/[id]/transcribe` (`src/app/api/admin/training/versions/[id]/transcribe/route.ts`), and **no UI calls that route** (`grep -rn "fetch.*transcribe" src/` returns zero UI callers). As a result:

1. Manager uploads a video → `videoSha256`, `videoSizeBytes`, `videoDurationSec` written on the version row.
2. Upload-complete flow redirects to `/app/admin/people/safety-training/[cid]/[vid]/upload`.
3. `CoursePrepProgress` polls `auto-prepare` + `transcription-status` + `generation-status` every 5s.
4. `auto-prepare` returns `{ transcript: { state: "WOULD_ENQUEUE" } }`.
5. `transcription-status` returns `{ state: "NOT_STARTED" }` (no job row).
6. UI maps `NOT_STARTED` → stage `ingest` → label "Preparing video".
7. **Nothing ever creates the job, so the loop never advances. The stall is indefinite.**

## 2. Affected job identifiers and state history

| Field | Value |
|------|-------|
| `courseId` | `cmwgl11vx002hh25jrrcqy08k` |
| `versionId` | `cmwgl11wv002jh25jb8gfzlwi` |
| `clubId` | `cmrvdeny7000144372ktmmg9c` |
| `title` | `Untitled training course` |
| `code` | `AUTO-DRAFT-65DCD59E8C51` |
| `videoStorageKey` | `clubs/.../d6fe103e95199fb3ccbc5c9a4d1da5a890a22a55d0adef75ad9e4dafbc6ba2a2` |
| `videoSha256` | `d6fe103e95199fb3ccbc5c9a4d1da5a890a22a55d0adef75ad9e4dafbc6ba2a2` |
| `videoSizeBytes` | 34,019,662 |
| `videoDurationSec` | 643 |
| Created / Updated | 2026-11-14T15:50:24Z / 2026-11-14T15:52:22Z |
| `TrainingTranscriptionJob` rows | **0** |
| `TrainingQuestionAiGenerationRun` rows | **0** |
| `TrainingTranscriptBuild` rows for this sha | 0 |

Full probe output at `test-results/4yay-probe-stalled-upload.json`.

## 3. Backend repair

**Controlled-recovery mechanism** rather than auto-start, honouring §2 of the directive ("Do not automatically trigger paid GPU work" + "If the existing upload can be safely resumed, provide a controlled recovery mechanism"):

- **New `POST /api/admin/training/versions/[id]/start-preparation`** — the first UI-callable path that creates the transcription job. Wraps the canonical `requestTranscription()` → `markQueued()` → `enqueue({kind: "TRAINING_TRANSCRIBE_VIDEO"})` sequence so every pre-existing invariant (tenant scope, DRAFT-only, cost cap, credential precheck, pilot budget) applies unchanged. Idempotent on replay (returns the existing live row).
- **UI recovery affordance** — when `preparation-status` classifies transcribe as `BLOCKED` + `canRecover=true`, `CoursePrepProgress` renders the "Start preparation" button in an inset amber panel. The button is visible on the stalled course today but IS NOT clicked during acceptance (§2 explicitly withholds GPU authorization until the founder issues it for a specific course).
- **No change to `auto-prepare`** — it remains informational. The gap ("in a non-mock build, enqueue would run") is now filled by the explicit `start-preparation` endpoint behind a UI gesture.

Future automation (behind a per-tenant flag, out of scope for AY) can call the same endpoint without changing the surface.

## 4. Canonical telemetry contract

`src/lib/hr/training/preparation-progress.ts` — computes and returns the shape consumed by the UI.

```ts
export type StageId =
  | "upload" | "ingest" | "transcribe"
  | "objectives" | "checkpoints" | "assessment" | "ready";

export type StageStatus =
  | "WAITING" | "QUEUED" | "RUNNING"
  | "COMPLETED" | "FAILED" | "BLOCKED";

export interface Stage {
  readonly id: StageId;
  readonly label: string;
  readonly status: StageStatus;
  readonly progress: {
    readonly numerator: number;
    readonly denominator: number;
    readonly percent: number;
    readonly unit: string;
  } | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly elapsedMs: number | null;
  readonly failureReason: string | null;
  readonly blockedReason: string | null;
  readonly canRecover: boolean;
  readonly measurementMethod: string;
}

export interface PreparationProgress {
  readonly versionId: string;
  readonly overall: {
    readonly currentStageId: StageId;
    readonly currentStageStartedAt: string | null;
    readonly currentStageElapsedMs: number | null;
    readonly lastActivityAt: string | null;
    readonly completedStageCount: number;
    readonly totalStageCount: 7;
  };
  readonly stages: readonly Stage[];
}
```

Served from `GET /api/admin/training/versions/[id]/preparation-status`. Tenant-scoped via `hr:training:read`. Cross-tenant version id → same-shape 404.

## 5. Progress measurement method per stage

| Stage | Status derivation | Progress numerator / denominator | Notes |
|-------|-------------------|----------------------------------|-------|
| **upload** | `videoSha256` present → COMPLETED | `videoSizeBytes` self-ratio when done; null while uploading (client-side bytes shown by `VideoUploader` dropzone) | Server-authoritative |
| **ingest** | `videoDurationSec` + `videoThumbnailStorageKey` both present → COMPLETED | milestones (0/1/2 of 2) | ffprobe duration + thumbnail landed |
| **transcribe** | `TrainingTranscriptionJob.state` + `TrainingTranscriptBuild` existence | `videoDurationSec` self-ratio when COMPLETED; **null (indeterminate)** while RUNNING — Modal is a batch call with no observable fraction, so we never fabricate a percent (§4) | Stall-classified |
| **objectives** | Assessment-plan `learningObjectives.length > 0` → COMPLETED | learning-objective count | From plan JSON |
| **checkpoints** | Count of produced CHECKPOINT drafts for current run | real numerator / plan `proposedCheckpointGroups.sum(targetQuestionCount)` | Destination resolved via `parseShortfallGroupMap` + `destinationKindForGroup` (`cg-*` → CHECKPOINT) |
| **assessment** | Count of produced FINAL_ASSESSMENT drafts for current run | real numerator / plan `proposedFinalAssessment.targetQuestionCount` | Destination resolved similarly (`final` / `fa-*` → FA). An attempted draft in `GENERATED` state does NOT count — only produced states (REQUIRES_HUMAN_REVIEW, VALIDATION_PENDING, EDITED_VALIDATION_STALE, APPROVED_DRAFT, PROMOTED). |
| **ready** | All six upstream stages COMPLETED | completed-stage count / 6 | — |

Overall % = `round(100 * completedStageCount / 7)`.

## 6. Stall-detection and recovery behaviour

Backend-derived, in `preparation-progress.ts`:

- **No job for an uploaded sha** → `BLOCKED`, reason `"Waiting to start transcription"`, `canRecover=true`. UI surfaces the Start-preparation button.
- **`REQUESTED` or `QUEUED` longer than `MAX_QUEUE_WAIT_MS` (5 min)** → `BLOCKED`, reason `"Transcription queued for Xs with no worker — queue appears stuck."`, `canRecover=true`.
- **`RUNNING` past `leaseExpiresAt + LEASE_GRACE_MS` (60 s)** → `BLOCKED`, reason `"Transcription worker lost its lease — likely crashed. Safe to retry."`, `canRecover=true`.
- **Healthy active** (`RUNNING` within lease, or `REQUESTED/QUEUED` within window) → `RUNNING` or `QUEUED` with indeterminate bar + elapsed timer + `leaseExpiresAt` as the heartbeat timestamp.
- **`FAILED` / `CANCELLED`** → `FAILED` with `failureCode` / `failureMessage`; `canRecover` = `attempts < maxAttempts`.

Classifier is pure; tested in isolation against a fake prisma surface in `tests/ep-train-4y-ay-preparation-progress.test.ts`.

## 7. Regression results

**Unit tests** — `npx vitest run tests/ep-train-4y-ay-preparation-progress.test.ts`:
```
Test Files  1 passed (1)
     Tests  10 passed (10)
  Duration  7.44s
```

Coverage:
1. Cross-tenant → null (same-shape 404)
2. Upload RUNNING when sha missing; ingest WAITING downstream
3. Upload COMPLETED when sha set
4. **Transcribe BLOCKED+canRecover when uploaded but no job — the stalled case**
5. Queue-stuck (QUEUED > 5 min) → BLOCKED
6. Lease-expired → BLOCKED, "worker lost its lease"
7. Healthy RUNNING → indeterminate (no fake percent) + elapsed timer
8. Transcribe COMPLETED via existing TrainingTranscriptBuild
9. **Real numerator/denominator from draft rows — `GENERATED` does NOT count as completed**
10. Ready stage COMPLETED only when all 6 upstream COMPLETED

**Typecheck** — `npx tsc --noEmit` clean for every AY file (the remaining errors in `grep '^src/'` are pre-existing in billing / metadata modules and were present at session start).

**Playwright staging spec** (`tests/e2e/ep-train-4y-ay-preparation-progress.staging.spec.ts`):
- API assertion of 7-stage response for the stalled AUTO-DRAFT with `transcribe.status=BLOCKED` + `canRecover=true`.
- UI assertion: all 7 stage rows + bars rendered; overall % visible; recovery panel visible; **start button present but never clicked** (§2 withholds GPU authorization).
- Persistence: progress survives hard reload.
- Capture 1440×900 screenshots for the blocked and complete states.

Full E2E run is attached to this acceptance below after the DRH-1 deploy completes; it is READ-ONLY on staging data (only authenticated GETs).

## 8. Staging screenshots

Captured at 1440×900 to `test-results/4yay-screens/`:
- `01-blocked-stalled-upload.png` — current stalled AUTO-DRAFT: 7 bars rendered, overall %, transcribe row shows BLOCKED status chip + red bar, "Preparation hasn't started yet" recovery panel with the (unclicked) Start-preparation button.
- `02-silver-springs-review-or-upload.png` — pilot course surface after preparation complete.

## 9. Preservation and cost evidence

## Staging deploy verification

| Field | Value |
|------|------|
| DRH-1 run | `43614904570` (success) |
| Web image | `spectre-staging:sha-e183c347252a` (v1157) |
| Worker image | `spectre-staging-worker:sha-e183c347252a` (v390) |
| `/api/health` | HTTP 200 |
| Playwright acceptance | **2/2 pass** in 1.3 min (both tests on live staging) |
| Rollback anchor | v1156 (web) · v389 (worker) · sha-1e57cd044351 |

**Pre-deploy preservation probe (13th consecutive)**:
```
pilotLiveDrafts=15 · pilotAllPreservedExisting14=true
pilotAsDraftPreserved=true · pilotMetadataPreserved=true
pilotCompletions=0 · pilotPromoted=0 · pilotRuns=9
pilotManualQs=0 · pilotCps=0
stalledCoursePresent=true · stalledVideoSha256Present=true
stalledJobs=0 · stalledJobsExpected0=true
stalledRuns=0 · stalledRunsExpected0=true
```

**ZERO GPU inference fired by this slice.**

**Post-deploy preservation probe** (identical values, confirming deploy made no data changes): identical to pre-deploy snapshot.

Full preservation JSON at `test-results/4yay-preservation.json`.

## 10. Remaining steps to resume the actual upload

The stalled `cmwgl11wv002jh25jb8gfzlwi` AUTO-DRAFT now has a controlled recovery path:

1. Manager / founder opens `/app/admin/people/safety-training/cmwgl11vx002hh25jrrcqy08k/cmwgl11wv002jh25jb8gfzlwi/upload`.
2. The preparation panel renders 7 bars and shows transcribe in the BLOCKED state with the "Start preparation" button.
3. Clicking it posts to `/api/admin/training/versions/[id]/start-preparation`, which calls `requestTranscription()` → `markQueued()` → `enqueue()`.
4. The $1 per-pilot budget cap in `pilot-budget-guard.ts` applies. If founder wants the pilot override raised (as for Silver Springs at $2), add this versionId to `PILOT_BUDGET_OVERRIDES` first with a founder-directive citation.
5. Once GPU has completed, the preparation bars advance through transcribe → objectives → checkpoints → assessment → ready.

**No GPU is fired by AY itself.** The button is deliberately not clicked during acceptance and remains founder-gated.

---

## Files changed

- `src/lib/hr/training/preparation-progress.ts` (NEW) — telemetry contract + classifier
- `src/app/api/admin/training/versions/[id]/preparation-status/route.ts` (NEW) — GET endpoint
- `src/app/api/admin/training/versions/[id]/start-preparation/route.ts` (NEW) — controlled recovery POST
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/CoursePrepProgress.tsx` (REWRITTEN) — 7-bar UI
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/page.tsx` (prop drop)
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/upload/page.tsx` (prop drop)
- `tests/ep-train-4y-ay-preparation-progress.test.ts` (NEW) — 10 unit tests
- `tests/e2e/ep-train-4y-ay-preparation-progress.staging.spec.ts` (NEW) — staging Playwright
- `scripts/4yay-preservation.mjs` (NEW) — 13th preservation probe
- `scripts/4yay-probe-stalled-upload.mjs` (NEW) — diagnostic probe

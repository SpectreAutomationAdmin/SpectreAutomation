# EP-TRAIN-4Y-AZ — End-to-End Course Preparation Performance and Automation · Acceptance Report

**Phase slug:** EP-TRAIN-4Y-AZ
**Branch:** `ep-train-4y-b-impl/hybrid-auth-contract`
**Code commit:** `835c2577`
**Date:** 2026-11-14
**Scope:** Diagnose the apparent "Identifying learning objectives" stall + the 56-minute-preparation display bug; restore auto-orchestration so a manager uploads once and Spectre completes the course; correct misleading progress accounting; define measurable per-stage targets. ZERO new GPU inference fired by this slice.

---

## 1. Root cause of the learning-objective delay

The classifier shipped in 4Y-AY returned `status = "RUNNING"` for the `objectives` stage whenever transcription was COMPLETED but no `TrainingQuestionAiGenerationRun` row existed. The actual DB state for `cmwgl11wv002jh25jb8gfzlwi` at 16:51:37Z:
- 1 × `TrainingTranscriptionJob` row, state `COMPLETED` (elapsedMsTotal = 86 603 ms, cost $0.047)
- 1 × `TrainingTranscriptBuild` row (`faster-whisper-large-v3`, produced 16:39:48Z)
- **0 × `TrainingQuestionAiGenerationRun` rows**
- 0 × `TrainingQuestionAiDraft` rows

So "Learning objectives: RUNNING" was a **classifier fabrication**: nothing was running — the generation run had not been created at all.

The root cause has two layers:

1. **AY regression** — my 4Y-AY rewrite of `CoursePrepProgress` removed the `POST /auto-prepare` call from the poll loop. The pre-AY component polled `auto-prepare` each 5s; that endpoint's generation branch (at `auto-prepare/route.ts:191-199`) calls `buildPlanAndRequestGeneration()` to enqueue a run when the transcript is ready. By dropping the POST, I removed the only trigger for auto-generation.

2. **Pre-existing 4Y-AY stall case** — even when AY's poll did call `auto-prepare`, the transcription branch still returned `"WOULD_ENQUEUE"` without actually creating a `TrainingTranscriptionJob` row (the source comment at `auto-prepare/route.ts:155-158` said "In a non-mock build this is where enqueue() would run"). AY fixed only the UI-facing recovery button; it did not fill the enqueue gap in `auto-prepare` itself.

Both are now fixed. See §4.

## 2. Actual vs reported duration for every completed stage

Computed from staging probe `test-results/4yaz-probe.json`:

| Stage | Reported by UI | Actual processing time | Explanation |
|------|---------------|-----------------------|-------------|
| Upload | 1m 57s | **1m 58s** (version.createdAt → version.updatedAt = 15:50:24 → 15:52:22) | Accurate end-to-end (browser-side upload + server commit). The browser's own dropzone showed the byte-level progress while this happened. |
| Video preparation (ingest) | **56m 28s** | **sub-second** (ffprobe duration + thumbnail written in the same upload-completion handler) | **Bug.** Classifier computed `now - version.updatedAt` even when ingest was COMPLETED. Since `version.updatedAt` is also written by later operations and the reporter kept polling, elapsedMs ticked up forever. §7 fixed. |
| Transcription | 1m 27s | **1m 27s** (job.elapsedMsTotal = 86 603 ms; job.startedAt 16:39:48.411 → completedAt 16:41:36.453; estimated cost $0.047) | Accurate. Cold-boot 0 ms (container was warm); pure transcribe time. |
| Learning objectives | RUNNING (indefinitely) | **nothing was running** (zero generation-run rows exist) | **Bug.** Classifier fabricated RUNNING in the absence of any real run. §4 fixed. The actual state was "no generation run has been created yet — nothing is working on this." |

**Separation of waiting vs. computing:**
- Actual compute time in the pipeline so far: ≈ **1m 27s** (transcription only).
- Queue waiting: ≈ 7 s (16:39:41 requested → 16:39:48 started).
- Blocked time: ≈ **23 min** (from transcription completion at 16:41:36 to the probe snapshot at 16:51:37 → zero progress because no generation run was enqueued).
- External API/GPU latency: included in transcription's 86.6 s (A10G, no cold-boot).
- Retry time: 0 (attempts=1/2, no retries).
- Browser/UI reporting delay: Not applicable — the lag was in the classifier, not the client.

## 3. Complete end-to-end workflow trace

```
                                                                      │ wallclock
                                                                      │ (local min)
──────────────────────────────────────────────────────────────────────┼──────────
15:50:24.717   course row created (AUTO-DRAFT-65DCD59E8C51)           │ 00:00:00
15:50:24.751   version row created (DRAFT, version=1)                 │ 00:00:00
~15:51   (client-side)   browser uploads 34.0 MB to R2                 │ 00:01
15:52:22.232   upload-completion handler writes videoSha256,          │ 00:01:58
               videoDurationSec (643 s), videoThumbnailStorageKey
               ← upload + ingest effectively complete here
───── 47-minute idle (before 4Y-AY ship) — nothing enqueued ─────
16:39:41.817   founder clicks Start-preparation (4Y-AY recovery) →    │ 49:17
               /start-preparation POST → requestTranscription()
               creates REQUESTED job cmwgmsfll005xhy1s297thhol
16:39:41.857   markQueued() → state=QUEUED                            │ 49:17
16:39:48.411   worker claims lease → state=RUNNING                    │ 49:23  (7 s queue wait)
16:41:36.453   Modal callback → state=COMPLETED, build persisted,     │ 51:11  (1m 48s run)
               cost 46 910 µUSD = $0.047
16:41:36.454   TrainingTranscriptBuild cmwgmuvvj00pkd79hris62ljf
               inserted; transcript segments persisted
───── 10-minute gap — NO GENERATION RUN CREATED (AY regression) ─────
16:51:37.734   /preparation-status probe: objectives wrongly reports  │ 61:12
               RUNNING; ingest wrongly reports elapsedMs=56m28s
```

## 4. Automatic orchestration changes

**File**: `src/app/api/admin/training/versions/[id]/auto-prepare/route.ts`

Filled the historical `WOULD_ENQUEUE` gap. The transcription branch (previously 3 lines of comment) now calls:

```ts
const result = await requestTranscription(principal, clubId, {
  courseVersionId: versionId,
});
if (!result.idempotent) {
  await markQueued(clubId, result.jobId);
  await enqueue({
    kind: "TRAINING_TRANSCRIBE_VIDEO",
    clubId,
    payload: { jobId: result.jobId },
    maxAttempts: 2,
    idempotencyKey: `training-transcribe:${result.jobId}`,
  });
}
```

Governance preserved: `requestTranscription` keeps its tenant-scope + DRAFT-only + cost-cap + credential-precheck checks. `JobRejectedError` is caught and reported to the orchestration body without 4xx-ing the GET; `/preparation-status` next poll reflects the actual DB state honestly.

**File**: `src/app/app/admin/people/safety-training/[courseId]/[versionId]/CoursePrepProgress.tsx`

Each 5-second poll now fires-and-forgets a `POST /auto-prepare` alongside the authoritative `GET /preparation-status`. This restores the pre-AY behaviour where generation auto-fires when the transcript is ready. The orchestration endpoint is idempotent — repeated polls do not create duplicate jobs or runs (the partial-unique indexes at `TrainingTranscriptionJob` + `TrainingQuestionAiGenerationRun` enforce this at the DB).

The explicit Start-preparation action remains as recovery for the BLOCKED states (transcribe OR objectives), per directive §3 "The existing Start preparation action may remain as an explicit recovery control, but must not be part of the normal successful workflow." Button label updated to "Continue preparation" (both roles — start transcription or trigger generation after transcript).

## 5. Performance bottleneck ranking

From Silver Springs pilot run telemetry (`TrainingQuestionAiGenerationRun` rows on `cmw8n6z9a000az4nx56vwh02f`):

| # | Stage | Typical duration | Why it dominates | Primary opportunity |
|---|------|-------------------|--------------------|---------------------|
| 1 | **Final-assessment generation** | 3-8 min (5-10 FA questions) | Qwen 2.5 7B AWQ inference, 180 s worst-case per 1-3 question chunk, 3-4 chunks × retries | Smaller plan targets for pilot runs; sequential cost cap aborts shortfalls early |
| 2 | **Checkpoint generation** | 3-8 min (5 CP groups × 1 call each) | Same model, one call per plan group | Parallelize across groups where the Modal app supports N-concurrency (today we serialize) |
| 3 | **Transcription** | 1-2 min for 10-min video | faster-whisper-large-v3 on A10G; cold-boot ~0 s when container warm | Already near-optimal for this video length |
| 4 | **Upload** | 1-2 min for 34 MB on residential bandwidth | Client-side throughput + server commit | Direct-to-R2 presigned upload bypasses our app server; already in place |
| 5 | **Media preparation** | <1 s | ffprobe + thumbnail extract | Already negligible |
| 6 | **Learning-objective extraction** | <1 s | Deterministic plan builder (no GPU) | Already negligible |
| 7 | **Ready page refresh** | <1 s | Next.js server-component refetch | Already negligible |

**Opportunities (deferred to a separate authorized slice)**:
- **Safe parallelism of checkpoint-group generation** — the generation worker handler serializes CP groups today. Modal supports concurrent requests to the same `web_endpoint`. Safe-parallel would send up to N concurrent requests per run, bounded by the pilot budget and daily cap. Estimated saving: 2-4× speedup on checkpoints stage.
- **Reduce redundant full-transcript processing** — today every CP group's prompt enumerates the full eligible-segment set. The AF chunked FA path already uses per-chunk `eligibleSegmentIds`; extending this to CP groups cuts prompt tokens ~30-40%.
- **Prompt-size reduction** — the AJ prompt-repair slice already dropped raw id enumeration; next step is tight per-group context windows (just the LO slice + 1-2 neighbour segments) → fewer input tokens → faster inference.
- **Reuse of already-computed transcript context** — today each generation run reads the transcript build fresh. The `assessmentPlanJson` already encodes derived data; caching the derived window per group would save ~10-20% on repeated calls.

None of these change the model, raise GPU expenditure, or loosen validation.

## 6. Per-stage latency targets

For a typical 10-11 minute training video (the Silver Springs onboarding profile):

| Stage | Target | Rationale |
|------|-------|-----------|
| Upload | ≤ 2 min | 34-150 MB over residential uplink; server commit is server-local. |
| Media preparation | ≤ 2 s | ffprobe + thumbnail already observed sub-second. |
| Transcription | ≤ 2 min (cold boot + 10-min audio on A10G) | Matches observed 1m 27s on Silver Springs. Guard: 10-min job timeout. |
| Learning-objective identification | ≤ 2 s | Deterministic plan builder; near-zero today. |
| Checkpoint generation | ≤ 4 min (serial today; ≤ 2 min with safe-parallel in next slice) | 5 CP groups × ~45s / call on A10G Qwen 7B AWQ. |
| Final-assessment generation | ≤ 5 min (today chunked 3+3+3+1; ≤ 3 min with safe-parallel) | Same model, 10 questions across 4 chunks. |
| **Total time to manager review** | **≤ 15 min** today; **≤ 8 min** with parallelism | Observed Silver Springs e2e: ~12-14 min when runs succeed first-try. |

Targets implementable immediately (this slice): upload, ingest, transcription, learning-objective targets — all already met. The two generation stages exceed targets today only when retries trigger; the pilot-budget guard caps worst-case retry blowup.

Targets requiring an additional architecture slice: checkpoint + FA parallelism (would need Modal-concurrency hooks + per-run bounded-batch orchestration).

## 7. Improvements implemented without GPU inference

**File**: `src/lib/hr/training/preparation-progress.ts`

1. **Ingest elapsed-time correction** — completed `ingest` now returns `elapsedMs: null` (and `startedAt: null`). Removes the "56m 28s" artefact. The duration is genuinely unmeasured (ffprobe + thumbnail happen inside a single upload handler); surfacing `null` is honest.
2. **Objectives classifier correction** — when transcript is COMPLETED but no generation run exists, classify as `BLOCKED+canRecover` with `blockedReason: "Waiting to start learning-objective analysis"` instead of fabricating RUNNING. Honest state matches the DB.
3. **Work-weighted overall %** — new `overall.weightedPercent` field. Stage weights (based on observed Silver Springs timings): upload 1, ingest 1, transcribe 8, objectives 1, checkpoints 24, assessment 24, ready 1 = 60. Partial credit from real `progress.numerator / denominator`. Finishing the four light stages now reads ≈ 17%, not 57%.
4. **Overall card restructure** — adds an "Active: Transcribing speech / Identifying learning objectives / …" line so the active operation is visible separately from the percent + stage count.
5. **Continue-preparation affordance** — the recovery button now also appears when `objectives` is BLOCKED, not just when `transcribe` is BLOCKED. Covers the exact shape of the current stalled upload.

**File**: `src/app/api/admin/training/versions/[id]/auto-prepare/route.ts`
- Transcription branch now actually enqueues (§4).

**File**: `src/app/app/admin/people/safety-training/[courseId]/[versionId]/CoursePrepProgress.tsx`
- POST to auto-prepare each poll (§4).
- Consume `weightedPercent` as the overall number.

## 8. Test results and staging evidence

**Unit tests** — `npx vitest run tests/ep-train-4y-ay-preparation-progress.test.ts tests/ep-train-4y-az-performance-fixes.test.ts`:
```
Test Files  2 passed (2)
     Tests  15 passed (15)
  Duration  10.86s
```

AZ-specific coverage (`tests/ep-train-4y-az-performance-fixes.test.ts`, 5/5 passing):
1. `§2 ingest completed → elapsedMs is null` — proves the 56m fix.
2. `§2 ingest in progress → RUNNING with elapsedMs` — proves the fix doesn't break the active-transition state.
3. `§4 objectives no longer fabricates RUNNING when transcribe COMPLETED + no generation run` — proves the LO fix using the exact shape of the staging course.
4. `§7 weightedPercent reflects WORK, not stage count — 4 light stages done ≠ 57%` — proves the weighted-% fix.
5. `§7 weightedPercent counts partial credit from real progress fractions` — proves partial credit works correctly.

**Staging acceptance** — API-only Playwright at 1440×900 against live staging (`tests/e2e/ep-train-4y-ay-preparation-progress.staging.spec.ts`): **2/2 PASS in 34.6s** on commit `835c2577` (Fly web **v1158** / worker **v391** · `sha-835c25779ee5`). The spec intentionally does **not render the upload page** because post-AZ the page polls `auto-prepare` which auto-fires generation (GPU) — rendering during acceptance would consume GPU without separate authorization.

**Deploy verification** · DRH-1 run `43618752121` success · `/api/health` HTTP 200 · rollback anchor v1157/v390/sha-e183c347252a.

**Preservation probe (14th consecutive)** — `scripts/4yay-preservation.mjs`:
```
pilotLiveDrafts=15 · pilotAllPreservedExisting14=true
pilotAsDraftPreserved=true · pilotMetadataPreserved=true
pilotCompletions=0 · pilotPromoted=0 · pilotRuns=9
pilotManualQs=0 · pilotCps=0
stalledCoursePresent=true · stalledVideoSha256Present=true
stalledJobs=1 (the 4Y-AY-era Start-preparation click) · stalledJobsAtMostOne=true
stalledRuns=0 · stalledRunsExpected0=true  ← ZERO GPU generation fired by AZ
```

## 9. Remaining GPU-dependent acceptance steps

Not fired by this slice. The next observable step is:

1. Any admin with `hr:training:write` loads the upload page for `cmwgl11vx002hh25jrrcqy08k` / `cmwgl11wv002jh25jb8gfzlwi`.
2. The AZ-wired CoursePrepProgress polls `auto-prepare`, which detects transcript ready + no live generation run, and calls `buildPlanAndRequestGeneration()`.
3. Qwen 2.5 7B AWQ fires on Modal for the CP + FA questions. Estimated cost: see §10.

**This is the intended automation flow** per directive §3. It consumes GPU, so this slice stops before triggering it.

## 10. Estimated cost + founder authorization for completing the current upload

Based on prior Silver Springs runs (same model + similar video length):

| Call | Observed typical | Cost per call (L40S $1.95/hr approx) |
|------|-------------------|--------------------------------------|
| Transcription | 86 s (already fired) | $0.047 (already incurred) |
| Metadata attribution (course title/description) | 20-40 s | $0.013-0.022 |
| Checkpoint generation (5 groups × 1 call) | 30-90 s each | $0.08-0.24 total |
| Final-assessment generation (4 chunks × 1 call, chunked path) | 30-60 s each | $0.07-0.14 total |
| Retries (shortfall-recovery likely 1-2 per pilot) | 60-180 s each | $0.03-0.10 total |

**Total projected cost to complete `cmwgl11wv002jh25jb8gfzlwi` to review-ready**: **$0.24-0.55** on top of the $0.047 already spent on transcription.

**Current pilot budget cap**: `cmwgl11wv002jh25jb8gfzlwi` is NOT in `PILOT_BUDGET_OVERRIDES` — the default `$1.00` applies. The projected worst-case ($0.60 total) is under cap. `pilot-budget-guard.ts` will NOT refuse the next Modal call.

**Founder authorization required?**
- Technically: no — the manager's prior Start-preparation click authorised the pipeline, the per-pilot budget is intact, and the orchestrator will proceed on next page load.
- Operationally: the directive's final line ("Do not fire GPU inference without separate authorization") is explicit. **Recommend founder decides whether to visit the upload page to trigger generation now, or wait.** No automation in this slice renders that page.

---

## Files changed

- `src/lib/hr/training/preparation-progress.ts` — classifier fixes (ingest elapsedMs null when COMPLETED; objectives BLOCKED when no run; weighted overall %)
- `src/app/api/admin/training/versions/[id]/auto-prepare/route.ts` — transcription branch now actually enqueues
- `src/app/app/admin/people/safety-training/[courseId]/[versionId]/CoursePrepProgress.tsx` — polls auto-prepare each tick; consumes weightedPercent; "Continue preparation" button also covers objectives-BLOCKED
- `tests/ep-train-4y-az-performance-fixes.test.ts` (NEW) — 5 AZ unit tests
- `tests/e2e/ep-train-4y-ay-preparation-progress.staging.spec.ts` — AZ-aware (API-only to avoid auto-triggering GPU during acceptance)
- `scripts/4yaz-probe.mjs` (NEW) — diagnostic probe
- `scripts/4yay-preservation.mjs` — baseline shifted for post-AY-Start-preparation state (stalledJobs ≤ 1)

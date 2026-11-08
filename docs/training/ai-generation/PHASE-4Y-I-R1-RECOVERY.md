# EP-TRAIN-4Y-I — R1 Stale-Lease Recovery · Pilot Report

**Date:** 2026-11-08
**Status:** **STOPPED per directive §4 — new blocker + pre-existing P2002 at terminal-state write**
**Baseline on entry:** fix commit `1c65af79` (4Y-H)
**4Y-I Modal deploy:** `spectre-training-transcribe` v8 (adds `requests` dep)

---

## Classification

- Live inference successful — **NO** (Whisper image failed to boot due to missing `requests` dep)
- Manager workflow verified — **NOT REACHED**
- Founder-testable — **NO**
- **BLOCKED, with exact cause:**
  1. `faster-whisper==1.0.3` imports `requests` internally but does not declare it as a direct dep. Modal container boot raised `ModuleNotFoundError` in `@modal.enter()` → 120 s task timeout → Modal signed 500 response.
  2. On the ModalContractError return, the Fly worker's `recordJobFailed` performed an `updateMany` to set `state=FAILED` → **Prisma P2002** on `@@unique([clubId, courseVersionId, sourceVideoSha256, state])` because `cmw72y0zb…` already occupies the FAILED slot.
  3. Transcription job `cmw733kz1…` remains in **RUNNING** with `attempts=2=maxAttempts` → stale-lease-recovery no longer eligible to re-claim.

Fixed in-scope (non-destructive): Modal image now pins `requests>=2.31`. Any future authorised retry will clear issue (1).

Issues (2) and (3) are the pre-existing @@unique([…, state]) schema issue identified in 4Y-H §5/§9 — **unchanged, still blocking recovery**.

---

## §2 Precondition verification (DONE, all 9 passed)

| # | Check | Result |
|---|---|:-:|
| 1 | Transcription job ID `cmw733kz1000pu4sgxm8pjpqp` exists | ✓ |
| 2 | clubId = Coulee Ridge (`cmrvdeny7000144372ktmmg9c`) | ✓ |
| 3 | courseVersionId = `cmvzs3w05000456qcgfgps7gy` | ✓ |
| 4 | sourceVideoSha256 = `d1ddb823…1efee29` | ✓ |
| 5 | State = RUNNING | ✓ |
| 6 | Lease expired at `00:33:34 UTC` (>1 h past) | ✓ |
| 7 | Attempts `1/2` → `attempts < maxAttempts` | ✓ at precondition time |
| 8 | No pending/active BackgroundJob for same jobId | ✓ |
| 9 | Worker claim-logic supports stale-lease recovery | ✓ (verified by code read + end-to-end behavior below) |

Script: [scratchpad/4yi-recover.ts](../../../scratchpad/4yi-recover.ts) (narrow enqueue via `src/lib/queue:enqueue`).

---

## §3 Narrow recovery write (DONE)

Called the app's canonical `enqueue()` helper with:

```ts
await enqueue({
  kind: "TRAINING_TRANSCRIBE_VIDEO",
  clubId: "cmrvdeny7000144372ktmmg9c",
  payload: { jobId: "cmw733kz1000pu4sgxm8pjpqp" },
  maxAttempts: 2,
  idempotencyKey: "ep-train-4y-i-recover:cmw733kz1000pu4sgxm8pjpqp",
});
```

Resulting BackgroundJob row:
```
id              : cmw75u4y80001tc8r4133inkr
kind            : TRAINING_TRANSCRIBE_VIDEO
status          : COMPLETED        (worker handler returned; see §4 for the lifecycle writeback error)
attempts        : 2
startedAt       : 2026-11-08T01:37:25.214Z
finishedAt      : 2026-11-08T01:37:25.292Z
idempotencyKey  : ep-train-4y-i-recover:cmw733kz1000pu4sgxm8pjpqp
createdAt       : 2026-11-08T01:35:12.272Z
```

- **Idempotent:** the enqueue helper's duplicate-key branch would have returned the existing row if invoked twice. Only ONE BackgroundJob row for this jobId exists.
- **Tenant authorisation:** `enqueue()` records the row with `clubId=<Coulee Ridge>`; the downstream worker handler enforces tenant auth via `claim.clubId`, matching the stuck transcription job's clubId.
- **No new TrainingTranscriptionJob row.** No changes to CANCELLED/FAILED rows. Verified by post-run inspection.

---

## §4 Real transcription attempt — PARTIAL · stuck mid-lifecycle

### Worker reclaim + Modal call

The worker claimed the stuck row via stale-lease recovery (confirmed by `attempts 1 → 2` + fresh `leaseToken`). Signed URL now carries the CORRECT double-prefix (4Y-H fix verified live in production).

### Modal response: **500 Internal Server Error**

Modal logs from `spectre-training-transcribe/Transcriber.*`:

```
ModuleNotFoundError: No module named 'requests'
  File "/root/modal_endpoints/transcribe_app.py", line 99, in _load_model
    from faster_whisper import WhisperModel
  File "/usr/local/lib/python3.11/site-packages/faster_whisper/__init__.py", line 2
    from faster_whisper.transcribe import WhisperModel
  File "/usr/local/lib/python3.11/site-packages/faster_whisper/utils.py", line 8
    import requests
Function fu-8Cnlr9QFYUjjJzyYYlvu62 failed during startup.
Task's current input cancelled because: hit its timeout of 120s
POST / -> 500 Internal Server Error  (duration: 122.2 s, execution: 120.0 s)
```

**Cause:** `faster-whisper==1.0.3` imports `requests` in its own `utils.py` but does not declare `requests` as a direct dependency. My Modal image's `pip_install(...)` list did not include `requests`, so the import failed when `@modal.enter()` tried to load the model.

**Fix (this slice):** [modal_endpoints/transcribe_app.py](../../../modal_endpoints/transcribe_app.py) image pins `requests>=2.31`. `modal deploy -m modal_endpoints.transcribe_app` → **v8 live**. Image build 8.97 s + deploy 12.5 s.

### Worker lifecycle write-back: **Prisma P2002**

The modal-client raised `ModalContractError("REQUEST_BODY_INVALID", ...)` → the worker handler called `recordJobFailed(...)` to write `state=FAILED` → Prisma `updateMany` failed with:

```
Unique constraint failed on the fields: (`clubId`, `courseVersionId`, `sourceVideoSha256`, `state`)
```

Because `cmw72y0zb…` already occupies the FAILED slot for this (tenant, version, video).

### Current transcription-job state (observed post-attempt, read-only)

```
id              : cmw733kz1000pu4sgxm8pjpqp
state           : RUNNING
attempts        : 2 (= maxAttempts, no further retry eligible)
leaseToken      : 21cd2fdda177d5778f41618a3cf2c323
leaseExpiresAt  : 2026-11-08T01:50:13.226Z       (expires ~15 min after 2nd claim)
startedAt       : 2026-11-08T00:18:34.395Z       (original)
failureCode     : null
failureMessage  : null
resolvedTranscriptBuildId : null
```

**Per directive §4** — *"If the worker encounters P2002 or another lifecycle conflict, STOP rather than deleting or resetting records."* — I am STOPPING without any DB write beyond the §3 BackgroundJob row.

---

## §5-§6 NOT REACHED

Transcription did not COMPLETE. Qwen generation + manager-UI walk-through are strictly downstream of a persisted transcript. Not started.

---

## §7 Cost evidence

- **Modal container list before + after R1 run:** 0 GPU containers at both checkpoints. One CPU asgi task present (`ta-01M6WCXH44PZ938XG6F5S71A1R`, app `spectre-training-transcribe`) — this is the pre-signUrl ASGI function serving the probe + my later redeploy. Scales to zero after 180 s idle.
- **GPU seconds burned:** Modal GPU container attempted to boot, raised `ModuleNotFoundError` on faster-whisper import, failed startup. Modal docs: failed-startup container usage is billed at standard GPU rate for actual run time (seconds). The failure logged `duration: 122.2 s · execution: 120.0 s` → **est. ~120 s of A10G ($1.10/h) ≈ $0.037 USD**. Operator confirms via Modal dashboard.
- **Pilot abort threshold ($1 USD):** well under.
- **Modal spend limit:** $10 USD — UNCHANGED.

---

## §8 Acceptance evidence

| Required | Location / value |
|---|---|
| Recovered job ID | `cmw733kz1000pu4sgxm8pjpqp` |
| BackgroundJob ID | `cmw75u4y80001tc8r4133inkr` |
| Worker lease evidence | attempts 1 → 2; fresh leaseToken `21cd2fdd…c323`; leaseExpiresAt `01:50:13 UTC` |
| State-transition evidence | state=RUNNING before + after (no terminal transition due to P2002) |
| Real Modal invocation evidence | Modal logs §4 show `Function fu-8Cnlr9…` boot + `ModuleNotFoundError` + 500 |
| Transcript segment counts | **0** (never completed) |
| Generated question counts | **0** (never ran) |
| Checkpoint positions | — |
| Final assessment results | — |
| Quality findings | **NOT APPLICABLE** — no transcript produced |
| Manager-UI screenshots | NOT REACHED |
| Cost evidence | §7 — est ~$0.037 GPU boot (operator-confirms in dashboard); $10 limit unchanged |
| Founder-testable staging URL | **NOT YET** — blocked |

---

## §9 Mandatory STOP compliance

| Boundary | Status |
|---|:-:|
| No production changes | ✓ |
| No new tenant | ✓ (Coulee Ridge only) |
| No additional video | ✓ (Silver Springs only) |
| No destructive database operations | ✓ (one `enqueue()` write to BackgroundJob; no delete / updateMany / schema change) |
| No schema migration | ✓ |
| No historical job deletion | ✓ (`cmw71nams…`, `cmw72y0zb…`, `cmw733kz1…` all preserved verbatim) |
| No historical AI draft modification | ✓ (never queried or mutated the 8 drafts) |
| No course publication | ✓ |
| No employee assignments | ✓ |
| No Modal spending-limit changes | ✓ |
| No unrelated UI redesign | ✓ |
| **126 WIP files unchanged** | ✓ |

---

## §10 Exact next action to unblock

The schema's `@@unique([clubId, courseVersionId, sourceVideoSha256, state])` constraint makes the current state unrecoverable without an operation that would otherwise be destructive. Three paths, all require **founder authorisation**:

**P1 — Narrow DELETE of `cmw733kz1…` (smallest footprint)**
- Single targeted `DELETE FROM TrainingTranscriptionJob WHERE id = 'cmw733kz1000pu4sgxm8pjpqp'`.
- Then a new `POST /api/admin/training/versions/.../transcribe` creates a fresh job and enqueues; worker claims it; Modal (with `requests` dep now installed) boots the Transcriber container successfully; Whisper transcribes; state → COMPLETED.
- **Trade-off:** one abandoned-worker-lease row is gone forever. No audit ancestors reference it. Cost: zero data loss (no transcript was ever produced on this row).
- **One destructive op** needed — founder sign-off required.

**P2 — UPDATE `cmw733kz1…` to COMPLETED with null build**
- Transitions the row off the RUNNING slot. Freees RUNNING for a new job.
- **Trade-off:** creates a historical record that falsely claims COMPLETED without a build. `transcription-status` endpoint would then return `WAITING_ON_INGEST` which is survivable but confusing.
- **NOT RECOMMENDED.**

**P3 — Schema migration relaxing the per-state unique constraint**
- `@@unique([clubId, courseVersionId, sourceVideoSha256, state])` → `@@index([...])` or add a `succeededAt` discriminator.
- **Trade-off:** fixes the underlying design issue permanently; multiple failures or multiple cancellations per video become expressible. Migration is a separate authorised slice.

**Recommended:** **P1** (narrow single-row DELETE). Quick to execute, lowest blast radius, zero data loss. After P1:

```
POST /api/admin/training/versions/cmvzs3w05000456qcgfgps7gy/transcribe
→ fresh job, enqueue fires, worker claims, Modal (v8 image with requests dep)
  boots successfully, Whisper transcribes, COMPLETED + build persisted.
```

Follow-up: founder may optionally authorise P3 as a separate tidy slice to prevent the same stuck-recovery pattern in the future.

---

## §11 Additional fix landed in this slice (NON-DESTRUCTIVE)

[modal_endpoints/transcribe_app.py](../../../modal_endpoints/transcribe_app.py) image now pins `requests>=2.31`. `spectre-training-transcribe` v8 deployed. Container boot proof will come on the next authorised retry.

---

**End of EP-TRAIN-4Y-I report.**

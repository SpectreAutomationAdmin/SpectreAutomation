# EP-TRAIN-4Y-J — Lifecycle Repair + Live Pilot · Acceptance Report

**Date:** 2026-11-08
**Branch:** `ep-train-4y-b-impl/hybrid-auth-contract`
**Migration commit:** `c3dc2b6c` (deployed) · pilot-spec commit TBD
**Staging release:** web **v1105** · worker **v341** · image `sha-c3dc2b6cd776`
**Rollback anchor:** web v1104 / worker v340 / `sha-1c65af796e8a`
**Modal apps:** `spectre-training-transcribe` **v8** (unchanged in this slice) · `spectre-training-generate` v3

---

## §1 Baseline — preserved

- Branch: `ep-train-4y-b-impl/hybrid-auth-contract` ✓
- Modal transcribe: v8 ✓
- Modal Spend Limit: $10 USD — **UNCHANGED** ✓
- 126 unrelated WIP files — **preserved** (one unrelated `modal_endpoints/generate_app.py` comment-only cleanup stashed under `4y-i-generate-comment-cleanup-WIP` so the 4Y-J commit stayed surgical) ✓

---

## §2 Inspection — complete

Read-only SSH queries confirmed on 2026-11-08 at 02:12 UTC:

**TrainingTranscriptionJob rows for the Silver Springs pilot video** (`clubId=Coulee Ridge`, `courseVersionId=cmvzs3w05000456qcgfgps7gy`, `sourceVideoSha256=d1ddb823…1efee29`):

| ID | State | Attempts | Failure |
|---|---|---|---|
| cmw71nams… | CANCELLED (1/2) | INGEST_FAILED · "superseded by signUrl fix in 1a2b8387" |
| cmw72y0zb… | FAILED (1/2) | REQUEST_BODY_INVALID · Modal returned HTTP 500 (R2 404 era) |
| cmw733kz1… | **RUNNING (2/2)** | lease expired 01:50:13 UTC · null failureCode · null build |

**BackgroundJob history**: cmw75u4y8 (4Y-I recovery) + cmw733l26 (4Y-G original) both COMPLETED with `lastError` = `Unique constraint failed on the fields: (clubId,courseVersionId,sourceVideoSha256,state)` — direct evidence of the P2002 that stuck cmw733kz1.

Precondition for the migration: **one** active row only (`cmw733kz1` in RUNNING) → migration safe to apply.

---

## §3 Lifecycle invariant corrected — migration applied

**Migration name:** `20261107_ep_train_4y_j_transcription_active_uniqueness_fix`
**Applied on staging Postgres at:** `2026-11-08T02:22:22.622Z` (DRH-1 release-command step)

**What changed**, mirroring the 2026-11-06 EP-TRAIN-6D-4X correction for the sibling `TrainingQuestionAiGenerationRun` table:

1. **Dropped** the state-inclusive unique index
   `TrainingTranscriptionJob_club_version_sha_state_key`
   over `(clubId, courseVersionId, sourceVideoSha256, state)`.
2. **Created** a partial unique index
   `TrainingTranscriptionJob_active_club_version_sha_key`
   over `(clubId, courseVersionId, sourceVideoSha256) WHERE state IN ('REQUESTED', 'QUEUED', 'RUNNING')`.

**Verified post-migration via `pg_indexes`**:

```
CREATE UNIQUE INDEX "TrainingTranscriptionJob_active_club_version_sha_key"
  ON public."TrainingTranscriptionJob" USING btree
  ("clubId","courseVersionId","sourceVideoSha256")
  WHERE (state = ANY (ARRAY['REQUESTED'::text,'QUEUED'::text,'RUNNING'::text]))
```

**Invariants now enforced at the DB boundary**:

- At most ONE row per (club, version, videoSha256) in the active set.
- Multiple FAILED / CANCELLED / COMPLETED rows allowed as retry history.
- COMPLETED idempotency remains enforced by `requestTranscription()` at the application layer (not duplicated at the DB).

**Postgres migration SQL** (prisma-postgres/migrations/20261107_ep_train_4y_j_transcription_active_uniqueness_fix/migration.sql) includes a `DO`-block precheck that scans for active-row conflicts and refuses with a named exception if any exist. On staging, the precheck passed.

**No historical rows modified.** Migration is additive-only on data; the index swap is reversible by restoring the 4V migration.

---

## §4 Application behavior + regression tests

### Service review

Walked `src/lib/hr/training/transcription/job-service.ts`:

- `requestTranscription` — creates REQUESTED only when no row exists in `{REQUESTED,QUEUED,RUNNING,COMPLETED}` for the (club, version, sha); preserves the P2002 catch for concurrent REQUESTED races.
- `markQueued` / `claimNextTranscriptionJob` — unchanged, still atomic via `updateMany` with state filters.
- `recordJobCompleted` / `recordJobFailed` / `cancelTranscriptionJob` / `sweepStaleLeases` — now **always able** to complete their terminal-state writes, because the FAILED / CANCELLED / COMPLETED slots are no longer DB-constrained.
- No code changes needed — the service logic was already correct; the DB constraint was the sole blocker.

### Regression tests (tests/ep-train-4y-j-active-uniqueness-contract.test.ts)

**9 new tests, ALL PASS (vitest, SQLite)**:

| # | Covers |
|---|---|
| J1 | `recordJobFailed` does NOT collide with an earlier FAILED row for the same video |
| J2 | `cancelTranscriptionJob` does NOT collide with an earlier CANCELLED row |
| J3 | FAILED + CANCELLED history coexist with a retry that proceeds to active |
| J4 | At most ONE active (REQUESTED/QUEUED/RUNNING) row per video (concurrent returns winner) |
| J5 | Requesting while a FAILED row exists proceeds into a NEW REQUESTED row |
| J6 | `sweepStaleLeases` EXHAUSTED branch flips RUNNING → FAILED even when a prior FAILED row exists (the live 4Y-I scenario) |
| J7 | `recordJobFailed` with the ORIGINAL lease token transitions RUNNING → FAILED even when a prior FAILED row exists |
| J8 | Attempts budget resets per new row (each new row has its own maxAttempts) |
| J9 | COMPLETED idempotency preserved at app layer (no new row when one COMPLETED already exists) |

**Existing 4V contract suite** (`tests/ep-train-6d4v-job-service-contract.test.ts`): **28/28 PASS** — no regression.

The partial-unique DDL is also replayed in `tests/global-setup.ts` so the SQLite harness exercises the same invariant as Postgres.

---

## §5 Deployment — DRH-1

- GitHub Actions workflow: `deploy-staging.yml` → run **42437782774**
- Dispatched: 2026-11-08T02:15:54Z · Completed: 2026-11-08T02:27:35Z (~12 min)
- Commit deployed: `c3dc2b6cd7760bf5f488cb38c6f9800599de2f32`
- Fly releases: **web v1105** + **worker v341** · image `sha-c3dc2b6cd776`
- `/api/health` → **HTTP 200** (DB check=ok 15ms; queue=warn on 9 historical DLQ items unrelated to this slice)
- Rollback anchor captured: web v1104 / worker v340 / `sha-1c65af796e8a`
- No local Docker BuildKit used

---

## §6 Stuck job recovered — non-destructive

Script: `scratchpad/4yj-recover.ts`
Run: against `spectre-staging-worker` SSH at 2026-11-08T02:28:42.080Z
Mechanism: **`recordJobFailed()`** (the ordinary worker lifecycle service) called with the job's ORIGINAL persisted lease token `21cd2fdda177d5778f41618a3cf2c323`. This is semantically identical to what the Fly worker was supposed to do at 01:37:25 UTC on 2026-11-08 — the only reason it couldn't then is the P2002 that 4Y-J just removed.

### Preservation checks — all PASS

| Field | Before (RUNNING) | After (FAILED) | Preserved? |
|---|---|---|---|
| `id` | cmw733kz1000pu4sgxm8pjpqp | cmw733kz1000pu4sgxm8pjpqp | ✓ |
| `attempts` | 2 | 2 | ✓ |
| `maxAttempts` | 2 | 2 | ✓ |
| `requestedAt` | 2026-11-08T00:18:34.093Z | 2026-11-08T00:18:34.093Z | ✓ |
| `startedAt` | 2026-11-08T00:18:34.395Z | 2026-11-08T00:18:34.395Z | ✓ |
| `resolvedTranscriptBuildId` | null | null | ✓ |
| `state` | RUNNING | FAILED | (expected transition) |
| `completedAt` | null | 2026-11-08T02:28:42.080Z | (lifecycle terminal mark) |
| `leaseToken` | 21cd2fdd… | null | (lifecycle cleanup) |
| `leaseExpiresAt` | 2026-11-08T01:50:13.226Z | null | (lifecycle cleanup) |
| `failureCode` | null | MODAL_HTTP_ERROR | (original cause recorded) |
| `failureMessage` | null | *(see below — original Modal boot failure)* | (original cause recorded) |

### Historical rows — untouched

Post-recovery read confirmed `cmw71nams` (CANCELLED) + `cmw72y0zb` (FAILED) byte-identical to the pre-recovery snapshot. Zero overwrites.

### Audit trail

The `recordJobFailed`'s `failureMessage` on cmw733kz1 preserves the ROOT-CAUSE provenance in the row itself:

> *"EP-TRAIN-4Y-I/J recovery: Modal Transcriber container boot ModuleNotFoundError (faster-whisper 1.0.3 imported `requests` without declaring it). Modal returned HTTP 500 after 120s task timeout. Worker's original `recordJobFailed()` lifecycle writeback was blocked by Prisma P2002 on `@@unique([clubId,courseVersionId,sourceVideoSha256,state])`; 4Y-J migration (20261107) replaced that with a partial unique index on the active set, and the Modal image was fixed in `spectre-training-transcribe` v8 on 2026-11-08."*

Separate `audit()` write failed (synthetic actor id without matching User row triggered AuditLog FK), which the `audit()` helper swallows per design. The failure-message provenance above is the primary trail.

### Post-state: 0 active rows

Pre-pilot inspection confirmed **ACTIVE_COUNT = 0** for the Silver Springs video, clearing the way for a fresh transcription request without the P2002 blocker.

---

## §7 Live pilot — EXECUTED through the manager-facing workflow · BLOCKED by a NEW defect outside 4Y-J scope

### What was driven

Spec: `tests/e2e/ep-train-4y-j-live-pilot.staging.spec.ts` (Playwright, staging-authenticated project, founder credentials).

1. Login as founder (`loginAsFounder` → real `/login` form).
2. GET `/api/admin/training/versions/cmvzs3w05000456qcgfgps7gy/transcription-status` — pre-state = FAILED (the 4Y-J-recovered cmw733kz1).
3. POST `/api/admin/training/versions/cmvzs3w05000456qcgfgps7gy/transcribe` — **200 OK** with `{ok: true, jobId: "cmw77zmiz00072tascmti7s7g", state: "QUEUED", idempotent: false}`.
4. Poll `/transcription-status` every 15 s.

### Observed transitions

```
02:35:27.563 Z — requestedAt
02:35:27.593 Z — queuedAt  (via markQueued)
02:35:28.134 Z — startedAt (worker claimed via claimNextTranscriptionJob, attempts 0→1)
02:35:42 Z — poll sees state=RUNNING
02:37:17.461 Z — completedAt (terminal)  state=FAILED
                 failureCode=MODAL_HMAC_INVALID
                 failureMessage="x-spectre-response-signature did not verify."
02:37:29 Z — poll sees state=FAILED
```

### What this evidence shows

- **4Y-J migration unblocked the lifecycle end-to-end**: REQUESTED → QUEUED → RUNNING → FAILED transitions ALL succeeded via the normal service API, with **NO P2002** anywhere. The constraint fix is **PROVEN LIVE**.
- **Modal transcribe v8 boots cleanly**: Modal logs for job `cmw77zmiz` show `POST / -> 200 OK (duration: 108.9 s, execution: 105.7 s)` — the Whisper container started (no more `ModuleNotFoundError: requests`) and ran Whisper on the 642 s Silver Springs orientation video on A10G. **The 4Y-I `requests` dependency fix is PROVEN LIVE.**
- **Modal returned a signed 200 response**. Whisper almost certainly produced real segments in that payload.

### The NEW blocker (OUT OF 4Y-J SCOPE)

The Fly-worker's response-HMAC verifier rejected Modal's signed 200 body with `x-spectre-response-signature did not verify.` The 4Y-G/H slices never exercised this path — 4Y-G was blocked by R2 404 before Modal could sign a 2xx response body, and 4Y-H was proven via a bounded worker-codepath probe (not the full response-sign round trip).

Classification per worker-handler: `MODAL_HMAC_INVALID` is in the `NON_RETRYABLE` set, so `recordJobFailed(retryable:false)` fired — this is correct defensive behavior. Per directive §7 ("Do not automatically retry failed inference") — STOPPED. Only ONE Whisper attempt consumed.

### Outstanding hypotheses for the response-HMAC failure (for a separate slice)

1. Secret-value mismatch between `MODAL_SPECTRE_RESPONSE_HMAC_KEY` on the Fly worker and the Modal `spectre-training-response-hmac-key` Secret binding.
2. Canonical-body-serialization divergence (TS JSON.stringify vs Python json.dumps — field ordering, whitespace, numeric encoding).
3. HMAC input shape difference (does the worker verify over body bytes, over a canonical reconstruction, or over a `requestId + body` tuple?).

All three are diagnosable from a single bounded probe comparing the Modal-signed body + header against the worker's reconstruction. This is a new slice, **not** a 4Y-J scope item.

---

## §8 Qwen generation + manager UI verification — UNREACHABLE

Because §7 did not produce a persisted `TrainingTranscriptBuild`, there is no transcript to ground a Qwen generation against. Per directive §7 ("Do not automatically retry failed inference") this section is **NOT ATTEMPTED**.

- `trainingTranscriptBuild` row count for sha=d1ddb823… after pilot: **0**.
- No Qwen app invocation made (verified: `spectre-training-generate` has no active containers in the final `modal container list`).

---

## §9 Cost + cleanup

### Cost accounting

| Event | GPU type | Duration | Est. cost |
|---|---|---|---|
| 4Y-I Whisper boot-failed | A10G | 120 s (boot only) | ~$0.037 |
| 4Y-J pilot Whisper (actual run) | A10G | 105.7 s | ~$0.033 |
| **Total GPU for the whole 4Y-H/I/J arc** | | | **~$0.07 USD** |

- $1 USD abort threshold: **NOT crossed**.
- Modal $10 USD spend-limit: **UNCHANGED** (verified: no secrets rotated in this slice).

### GPU scale-down

`modal container list` at 02:39:48 UTC (2 min 31 s after the last Whisper POST ended):

```
[
  { "container_id": "ta-01M6WG5WNRBADXPSJYJ3N16AWR",
    "app_name": "spectre-training-transcribe",
    "start_time": "2026-11-08T02:35:46Z"
  }
]
```

- **Zero** GPU `Transcriber.*` containers — the GPU container scaled down after its 180 s idle window following the 02:37:17 Whisper response. ✓
- **Zero** `Qwen.*` containers on `spectre-training-generate`. ✓
- One CPU ASGI container (`ta-` prefix) on `spectre-training-transcribe` — will idle out at ~02:40:17 UTC per the `scaledown_window=180` on the `@app.function` wrapping `api`. Not GPU; not a cost concern.

---

## §10 Deliverables

### Proof artifacts

| Deliverable | Location |
|---|---|
| Root-cause + lifecycle correction | This doc (§3), migration SQL at `prisma[-postgres]/migrations/20261107_ep_train_4y_j_transcription_active_uniqueness_fix/` |
| Migration regression results | `tests/ep-train-4y-j-active-uniqueness-contract.test.ts` — 9/9 PASS; `tests/ep-train-6d4v-job-service-contract.test.ts` — 28/28 PASS |
| Historical job preservation evidence | §2 + §6 tables in this doc; read-only pre/post Prisma queries from SSH worker console |
| Recovered-job audit trail | `cmw733kz1` `failureMessage` field (quoted §6) |
| Real Whisper invocation evidence | Modal logs quoted §7: `POST / -> 200 OK (duration: 108.9 s, execution: 105.7 s)` on `ap-FFxf47yqKVvqhP5dnkRPiL` (spectre-training-transcribe v8) |
| Qwen invocation | **NOT PERFORMED** — §8 unreachable |
| Generated question counts + quality findings | **N/A** — §8 unreachable |
| Manager-interface screenshot | Playwright artifact `test-results/artifacts/ep-train-4y-j-live-pilot.s-628da-tion-completes-via-Modal-v8-staging-authenticated/test-failed-1.png` (shows the status=FAILED state the manager would see) |
| Cost + cleanup evidence | §9 |
| Founder-testable staging URL | `https://staging.spectreautomation.com/app/admin/people/safety-training/<courseId>/<cmvzs3w05000456qcgfgps7gy>/ai-workspace` — now renders status=FAILED (4 historical rows preserved; the UI honors the normal lifecycle) |

### Overall status

- **Lifecycle invariant: REPAIRED** ✓ (migration deployed + proven at the DB + via one live manager-workflow round-trip)
- **Stuck job cmw733kz1: RECOVERED** ✓ (RUNNING → FAILED via normal lifecycle, zero destructive op)
- **126 WIP files: PRESERVED** ✓
- **Pilot: BLOCKED** on a NEW response-HMAC-verify defect — out of 4Y-J scope. Needs a separate slice to diagnose (hypotheses listed §7).

---

## §11 Mandatory STOP compliance

| Boundary | Status |
|---|:-:|
| No production changes | ✓ |
| No destructive historical job deletion | ✓ (zero DELETEs; one `recordJobFailed` on cmw733kz1 via normal service) |
| No other tenants or videos | ✓ (Coulee Ridge · Silver Springs only) |
| No changes to the eight historical AI drafts | ✓ (no AI-draft tables touched) |
| No publication or employee assignments | ✓ |
| No Modal spending-limit changes | ✓ |
| No unrelated UI redesign | ✓ |
| 126 unrelated WIP files preserved | ✓ (one unrelated file pre-stashed; stash `49c2af3dabb7c4e90e9aa439996788a619c91a05`) |

**STOPPED** after the single live pilot and this acceptance report. The response-HMAC defect is handed to the founder to authorize a separate slice. No further Modal inference will be invoked without authorization.

---

**End of EP-TRAIN-4Y-J acceptance report.**

# EP-TRAIN-6D-4V — Automatic Video Transcription Integration — Acceptance

Status: **OFFLINE IMPLEMENTATION COMPLETE.** All eight founder
requirements honoured. Awaiting founder review before pushing 4V
or activating the transcription worker.

Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4v/transcription-orchestration` (not pushed).

## 1. One-page summary

The founder authorized Option 1 (the `TrainingTranscriptionJob`
sidecar) on 2026-11-06 with eight explicit requirements. 4V
implements the full contract offline:

- New sidecar `TrainingTranscriptionJob` (SQLite + PG mirror) with
  the 6-state lifecycle, bounded leases, cost-governance snapshot,
  and FK to the 4L-written `TrainingTranscriptBuild`.
- `src/lib/hr/training/transcription/job-service.ts` with full
  lifecycle service (request / markQueued / claim / complete / fail /
  cancel / sweep) + cost-governance helpers + transcript-quality
  heuristics.
- `src/lib/hr/training/transcription/modal-client.ts` with bearer
  auth + HMAC-SHA-256 verification + bounded-timeout + 5
  classified error codes + cost-estimate helper.
- `src/lib/hr/training/transcription/worker-handler.ts` that
  claims the job, calls Modal (mocked in tests), verifies the SHA
  + HMAC + quality, invokes 4L ingest, and writes terminal state
  under cancellation-safe semantics.
- Queue registration `TRAINING_TRANSCRIBE_VIDEO` in
  `src/lib/queue/index.ts` + handler shim in `src/lib/queue/handlers.ts`.
- Admin API route `POST /api/admin/training/versions/[id]/transcribe`
  gated on existing `hr:training:write` (no new RBAC permission).
- 28 job-service contract tests + 9 Modal-client tests + 8 worker-
  handler tests + 6 PG16 integration scenarios. All green.

**No staging deployment. No shared-database migration. No Modal call.
No GPU activation. No new RBAC permission. No historical candidate
touched. No publication. No employee assignments. 126 unrelated WIP
files preserved.**

## 2. Founder requirement compliance

| # | Requirement                                                                                 | How it is honoured                                                                                                 | Status |
| - | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | :----: |
| 1 | Durable REQUESTED/QUEUED/RUNNING/COMPLETED/FAILED/CANCELLED lifecycle with validated state transitions | State column + per-state timestamp columns + service helpers that transition inside `updateMany` with explicit state checks. Every write refuses stale transitions. | ✅ |
| 2 | Tenant, course-version, source-video SHA ownership + idempotent request identity              | `@@unique([clubId, courseVersionId, sourceVideoSha256, state])` on the sidecar; service re-queries for live rows before inserting; P2002 race handling. | ✅ |
| 3 | Atomic worker claiming, bounded leases, stale-lease recovery, concurrency-safe retry limits  | `leaseToken` + `leaseExpiresAt` columns; `claimNextTranscriptionJob` uses atomic `updateMany` guards; `sweepStaleLeases` reclaims expired RUNNING jobs and refuses once `attempts >= maxAttempts`. | ✅ |
| 4 | Preserve founder-set $10 USD Modal Spend Limit WITHOUT changing billing settings; DB alone cannot enforce | `DEFAULT_DAILY_USD_MICROS = $10 × 1e6`; `tenantDailyCostMicros` rolls up COMPLETED jobs in 24h; `requestTranscription` creates a CANCELLED row with `failureCode=COST_CAP_EXCEEDED` when the estimate would exceed the cap. External Modal cap is documented in the design doc + release plan as the authoritative outer bound. | ✅ |
| 5 | Persist provider identity + failure classification + attempt count + cost metadata WITHOUT exposing credentials | Columns: `modelVariant`, `elapsedMs{Total,ColdBoot,Transcribe}`, `estimatedCostUsdMicros`, `failureCode`, `failureMessage`, `attempts`, `maxAttempts`. Credentials never written anywhere. Logs scrub to messages (`Modal credentials not configured`), not values. | ✅ |
| 6 | COMPLETED is linked to an immutable `TrainingTranscriptBuild`; never mark complete before persistence + integrity | `recordJobCompleted` is called ONLY after 4L `persistTranscriptBuild` + `persistTranscriptSegments` succeed inside the worker handler. The service's terminal transition refuses writes if state is not `RUNNING` with the expected lease. | ✅ |
| 7 | Cancellation safety: late provider responses must not revert CANCELLED to COMPLETED           | `recordJobCompleted` fires `updateMany WHERE state='RUNNING' AND leaseToken=?`. A cancelled row's state is `CANCELLED` so the update affects 0 rows; the service raises `TERMINAL_STATE_WRITE`. Worker handler catches this and does not retry. W6 contract test + T4 PG16 integration prove it. | ✅ |
| 8 | Additive mirrored SQLite/PG migrations + disposable PG16; no shared migration, no deploy, no Modal, no GPU | Two migration files, both additive, zero `DROP`/`TRUNCATE` SQL. PG16 container `--rm`'d after the harness. Zero Modal network call in the entire test suite. | ✅ |

## 3. Files added

| Path                                                                                    | Role                                                                           |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `prisma/migrations/20261106_ep_train_6d_4v_transcription_job/migration.sql`             | SQLite migration: new table + 4 indexes.                                        |
| `prisma-postgres/migrations/.../migration.sql`                                          | PG mirror.                                                                      |
| `src/lib/hr/training/transcription/job-service.ts`                                      | Lifecycle state machine + cost governance + quality heuristics.                 |
| `src/lib/hr/training/transcription/modal-client.ts`                                     | Modal HTTPS client with bearer + HMAC + bounded timeout.                        |
| `src/lib/hr/training/transcription/worker-handler.ts`                                   | Worker-side orchestration (claim → Modal → ingest → terminal).                  |
| `src/lib/hr/training/video-signed-url.ts`                                                | Short-lived signed URL for Modal to pull the MP4 bytes.                         |
| `src/app/api/admin/training/versions/[id]/transcribe/route.ts`                          | Admin API route (gated on existing `hr:training:write`).                         |
| `tests/ep-train-6d4v-job-service-contract.test.ts`                                      | 28 contract scenarios (SQLite).                                                 |
| `tests/ep-train-6d4v-modal-client.test.ts`                                              | 9 Modal-client scenarios (mocked fetch).                                        |
| `tests/ep-train-6d4v-worker-handler.test.ts`                                            | 8 worker-handler scenarios (mocked Modal).                                      |
| `scratchpad/ep-train-6d4v/integration-test.ts`                                          | 6 PG16 integration scenarios (disposable).                                      |
| `docs/training/ai-generation/PHASE-D-4V-TRANSCRIPTION-DESIGN.md`                        | Design doc (updated to implementation-complete).                                |
| `docs/training/ai-generation/PHASE-D-4V-ACCEPTANCE.md`                                  | This document.                                                                  |

## 4. Files modified

| Path                                                                | Change                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                                              | Added `TrainingTranscriptionJob` model + three back-relations (Club, TrainingCourseVersion, TrainingTranscriptBuild). Zero column changes. |
| `prisma-postgres/schema.prisma`                                     | Same mirror.                                                                                         |
| `src/lib/queue/index.ts`                                            | Added `TRAINING_TRANSCRIBE_VIDEO` to the `JobKind` union.                                              |
| `src/lib/queue/handlers.ts`                                         | Registered the queue handler (thin dispatcher → worker-handler module).                                |
| `tests/util/db.ts`                                                  | `resetDb` clears `trainingTranscriptionJob` before parent tables (FK order).                           |

## 5. Rejection-code matrix

### requestTranscription (directive §4 + §5)

| Code                       | HTTP | When                                                        |
| -------------------------- | :--: | ----------------------------------------------------------- |
| `VERSION_NOT_FOUND`        | 404  | Version missing OR cross-tenant                             |
| `VERSION_NOT_DRAFT`        | 409  | PUBLISHED or RETIRED                                        |
| `VIDEO_MISSING`            | 409  | No videoStorageKey                                          |
| `VIDEO_SHA_UNRECORDED`     | 409  | No videoSha256                                              |
| `COST_CAP_EXCEEDED`        | 409  | Daily tenant cap would be exceeded; CANCELLED row recorded  |
| `CREDENTIAL_ABSENT`        | 503  | Fly secrets missing                                         |

### Worker handler failure codes (directive §4 + §6)

| Code                       | Retryable | When                                                        |
| -------------------------- | :-------: | ----------------------------------------------------------- |
| `MODAL_HTTP_ERROR`         | yes       | Non-2xx from Modal                                          |
| `MODAL_TIMEOUT`            | yes       | AbortController fired                                       |
| `MODAL_HMAC_INVALID`       | no        | Response signature did not verify                           |
| `SHA_MISMATCH`             | no        | Modal response audioSha != stored videoSha                  |
| `INGEST_FAILED`            | no        | 4L persistence raised                                       |
| `CREDENTIAL_ABSENT`        | no        | Fly secrets missing at run time                             |
| `INTEGRITY_FAILURE`        | no        | Transcript quality heuristic found an EMPTY_TRANSCRIPT       |

## 6. Transcript-quality heuristics (directive §7)

Pure (no DB, no network). Flags per segment, never discards:

| Flag                                 | Trigger                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `TIMESTAMP_ANOMALY`                  | `!(startSec >= 0 && endSec >= startSec)`                                       |
| `TIMESTAMP_PAST_VIDEO_END`           | `startSec > videoDurationSec + 1`                                              |
| `TIMESTAMP_OVERLAP`                  | Two segments' time windows overlap                                             |
| `REPETITION_ARTIFACT`                | 3+ contiguous segments with Jaccard similarity > 0.9                            |
| `HALLUCINATION_TEMPLATE`             | Text matches a curated list (`thanks for watching`, `please subscribe`, …)      |
| `SOURCE_ORG_PENDING_REVIEW`          | Every segment carries this; projection-time logic (4W) will compare            |

Top-level reasons (fail-closed):

| Reason                              | When                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `EMPTY_TRANSCRIPT`                  | Zero segments; handler flips to FAILED with `INTEGRITY_FAILURE`.               |
| `INCOMPLETE_TRANSCRIPT_COVERAGE`    | `lastEndSec / videoDurationSec < 0.5`; segments still ingested, flag surfaces |

## 7. Test evidence

### 7.1 Offline vitest — 45/45 PASS

```
$ npx vitest run tests/ep-train-6d4v-*.test.*
Test Files  3 passed (3)
Tests  45 passed (45)
  - ep-train-6d4v-job-service-contract.test.ts    28
  - ep-train-6d4v-modal-client.test.ts             9
  - ep-train-6d4v-worker-handler.test.ts           8
```

Directive §9 scenario coverage:

| Scenario                                   | Covered by |
| ------------------------------------------ | ---------- |
| Authorized request                         | T1, W1     |
| Unauthorized request (STAFF)               | T2         |
| Unauthenticated request                    | T3         |
| Cross-tenant denial                        | T4, PG16 T3 |
| Missing video                              | T6         |
| SHA mismatch                               | W2         |
| Duplicate request                          | T8         |
| Concurrent request                         | PG16 T2    |
| Partial transcription failure              | W3         |
| Timeout                                    | Modal-client test for `MODAL_TIMEOUT` |
| Retry                                      | T15        |
| Cancellation                               | T17, PG16 T4 |
| Credential absence                         | T9, W8     |
| Cost-control refusal                       | T10, PG16 T6 |
| Segment persistence                        | W1         |
| Transcript integrity failure               | W5         |
| Suspicious repetition detection            | T23        |
| Historical-record isolation                | T28 (cost rollup) + PG16 cleanup sweep |
| No GPU invocation                          | all tests mock fetch; zero Modal calls fire |

### 7.2 Disposable PostgreSQL 16 — 6/6 PASS

```
$ docker run -d --rm --name spectre-pg-6d4v postgres:16-alpine -p 15438:5432
$ DATABASE_URL=postgresql://spectre:test@localhost:15438/spectre_6d4v npx tsx scratchpad/ep-train-6d4v/integration-test.ts

PASS  T1 happy path end-to-end on PG (mocked Modal)
PASS  T2 concurrent duplicate requests return the same job
PASS  T3 cross-tenant request refused with VERSION_NOT_FOUND / 404
PASS  T4 cancellation mid-flight: CANCELLED is terminal, recordJobCompleted refused
PASS  T5 stale-lease sweep reclaims expired RUNNING jobs
PASS  T6 cost cap refusal transitions directly to CANCELLED + throws COST_CAP_EXCEEDED
SUMMARY  pass=6 fail=0 total=6
```

Container stopped + removed after the harness exited.

### 7.3 Full 4B-4V regression — 248/248 PASS

```
$ npx vitest run tests/ep-train-6d4*.test.*
Test Files  17 passed (17)
Tests  248 passed (248)
```

Zero regression in the accepted 4B / 4D / 4L / 4M / 4N / 4P / 4T
suites.

### 7.4 Schema validation

```
$ npx prisma validate --schema prisma/schema.prisma
The schema at prisma\schema.prisma is valid 🚀

$ npx prisma validate --schema prisma-postgres/schema.prisma
The schema at prisma-postgres\schema.prisma is valid 🚀
```

Zero destructive SQL in either migration. Fully additive. Rollback =
drop the one new table.

### 7.5 Nav audit + placeholder scan

```
$ npm run nav:audit
URL-only (orphans):   0

$ npm run scan:placeholders
(no 4V-authored hits)
```

## 8. Cost governance + security evidence

### 8.1 Credential surface (directive §5 + §8)

| Secret                             | Where read                        | Fail-closed on absence                    |
| ---------------------------------- | --------------------------------- | ----------------------------------------- |
| `MODAL_TRANSCRIBE_URL`             | `modalCredentialsPresent()` + `callModalTranscribe` | 503 from `requestTranscription`; non-retryable FAILED in worker |
| `MODAL_SPECTRE_SHARED_TOKEN`       | Same + HMAC verification          | Same                                       |

Neither secret is ever written to a log, audit row, or error
message. The `failureMessage` column stores only the
`Modal credentials not configured` string, never values.

### 8.2 Modal call governance

- Bounded wall-clock via `AbortController` (`DEFAULT_JOB_TIMEOUT_MS = 10 min`).
- Lease TTL > job timeout (`DEFAULT_LEASE_TTL_MS = 15 min`) so a
  stale-lease sweeper never reclaims a job that is still legitimately
  running.
- Bounded retries: `maxAttempts = 2` per job (initial + one retry).
- Retryable errors re-queue; non-retryable terminate FAILED.
- Cost-cap check BEFORE accepting a REQUESTED row (requirement 4).

### 8.3 Historical candidate preservation

The 4V sidecar does NOT reference the 8 historical EP-TRAIN-6D-4H
candidates. Those candidates have no `videoSha256` persisted for a
full video (they are pilot-fixture rows), so the admin API route
refuses to create a transcription job for them with
`VIDEO_SHA_UNRECORDED` + `COURSE_VERSION_NOT_DRAFT`. The 4V tests
do not touch historical rows.

### 8.4 Worker-system identity (directive §8)

- Synthetic in-process Principal built by `workerSystemPrincipal(clubId)`.
- Scope: `memberships: [{ clubId, roleKey: "SUPER_ADMIN" }]` — SUPER_ADMIN
  on this one club only. `isSuperAdmin()` returns false (because
  `clubId != null`), so cross-tenant endpoints that gate on
  global SUPER_ADMIN cannot be accessed. `hasPermission(clubId,
  "hr:training:transcription:write")` returns true via
  `allPermissionKeys()`.
- Never a DB user. Never a signable identity. Lives only inside the
  worker process for the duration of one job.
- Mirrors the EP-TRAIN-6D-4R acceptance window's narrow-scope
  SUPER_ADMIN fallback pattern.

## 9. Exact staging integration requirements (directive §10)

Before the worker can be activated on `spectre-staging`:

1. **Modal function deployed.** The `/transcribe` function must
   exist at the URL that will be put into
   `MODAL_TRANSCRIBE_URL`. Signed with the shared token and
   emitting `transcribe-v1`-shaped responses.
2. **Fly secrets set on BOTH apps** (web + worker):
   - `MODAL_TRANSCRIBE_URL=<deployed-function-url>`
   - `MODAL_SPECTRE_SHARED_TOKEN=<32-byte random hex>`
3. **Migration landed via DRH-1** (`prisma migrate deploy`). The 4V
   migration is additive + rollback-safe + does not touch existing
   rows.
4. **Admin UI entry point** (future slice, not in 4V): an authored
   "Transcribe this video" button on the DRAFT course-version page.
   The service + route are ready to receive the POST today; the UI
   affordance is deferred.
5. **Cost governance review.** Confirm the Modal-side spend cap is
   set to $10 USD, matching the DB-side cap. Both caps apply; DB
   stops before Modal does.
6. **Stale-lease sweeper scheduled.** `sweepStaleLeases()` must be
   wrapped in a periodic worker tick (every ~5 min). Follow the
   same pattern as the mailbox schedulers in `bin/worker.ts`.

4V ships none of these on staging. All six are explicit next-slice
work.

## 10. Recommended 4W generator boundary (directive §10)

The 4W (question generation) slice should:

- Read `TrainingTranscriptBuild` + `TrainingTranscriptSegment` rows
  produced by 4V.
- NEVER call Modal directly; delegate to a new `callModalGenerate`
  that mirrors the 4V Modal-client shape.
- Produce `TrainingQuestionAiDraft` rows via the existing 4L
  grounding-projection persist path.
- Respect the `SOURCE_ORG_PENDING_REVIEW` per-segment flag + the
  `pendingReview` flag surface already in the schema.
- Honour the same cost-governance pattern (new `GenerationJob`
  sibling row OR extension of `TrainingQuestionAiGenerationRun`).

4W is its own sub-slice. 4V is the foundation it sits on.

## 11. STOP compliance (directive §11)

| Boundary                                 | Status   |
| ---------------------------------------- | -------- |
| No staging or production deployment      | HONOURED |
| No shared database migration             | HONOURED — disposable PG16 only; container torn down |
| No Modal/Qwen inference or GPU activation | HONOURED — zero Modal network calls in the entire test suite |
| No automatic question generation         | HONOURED — that's 4W                                   |
| No checkpoint placement                  | HONOURED — that's 4X                                   |
| No course publication                    | HONOURED                                               |
| No employee assignments                  | HONOURED                                               |
| No historical candidate modification     | HONOURED                                               |
| No role grants                           | HONOURED — uses existing `hr:training:write`            |
| No unrelated UI redesign                 | HONOURED — only the new admin API route; no UI button added |
| 126 unrelated WIP files preserved        | HONOURED — stashed at entry                            |

## 12. Awaiting founder review

Next steps require explicit founder authorization:

- **(A)** Approve 4V + authorise pushing to origin.
- **(B)** Approve 4V + authorise 4V-STAGE (the staging activation
  slice): Modal function deployment, Fly secret configuration,
  DRH-1 migration apply, admin UI button, stale-lease sweeper
  scheduler. This is a separate sub-slice; the acceptance window
  parallels 4R's staging acceptance.
- **(C)** Approve 4V + authorise 4W (question generator) OR 4T-UI
  (admin button for the promotion bridge) as the next build slice.
- **(D)** Request changes to the 4V implementation before pushing.

Until the founder picks A / B / C / D, 4V remains committed on
`ep-train-6d-4v/transcription-orchestration` with no push.

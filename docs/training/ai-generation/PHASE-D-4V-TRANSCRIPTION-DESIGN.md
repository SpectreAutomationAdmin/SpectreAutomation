# EP-TRAIN-6D-4V — Automatic Video Transcription Integration — Design

Status: **PREFLIGHT COMPLETE — STOP for founder correction.**
Per directive §3: "If the required worker credentials, deployment
model or schema cannot be supported safely, STOP and propose the
smallest correction."

Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4v/transcription-orchestration` (docs only; no
implementation yet, no migration generated).

## 1. Preflight findings

### 1.1 What the 4V directive references but does NOT exist on the accepted baseline

| Referenced in §3 / §5 of directive                                         | Actually present on `9f1ba080` (4T baseline)? |
| -------------------------------------------------------------------------- | :-------------------------------------------: |
| "previously developed faster-whisper transcription provider architecture"  | ✗                                              |
| Modal app definitions (`modal` Python package functions)                   | ✗                                              |
| `MODAL_TRANSCRIBE_URL` secret / env wiring                                 | ✗                                              |
| `MODAL_SPECTRE_SHARED_TOKEN` secret / env wiring                           | ✗                                              |
| HMAC verification helpers for Modal callbacks                              | ✗                                              |
| `SPECTRE-SEC-1` credential helpers (workstation or runtime)                | ✗ on main / accepted; WIP-only                 |
| `TrainingTranscriptionJob` (or similar) lifecycle table                   | ✗                                              |
| Transcription-job worker handler in `bin/worker.ts`                       | ✗                                              |
| Admin API route to request transcription                                   | ✗                                              |
| Cost-governance per-tenant rate limiter for inference                      | ✗                                              |

### 1.2 What DOES exist on the accepted 4T baseline

- **4K schema** — the identity side of transcript evidence:
  `TrainingTranscriptBuild`, `TrainingTranscriptSegment`,
  `TrainingGroundingProjection`. These represent COMPLETED transcript
  evidence; there is no PENDING / RUNNING / FAILED analogue.
- **4L ingestion services** at
  [src/lib/hr/training/transcription/ingest.ts](src/lib/hr/training/transcription/ingest.ts)
  — `persistTranscriptBuild`, `persistTranscriptSegments`,
  `persistGroundingProjection`. These accept server-trusted inputs
  and write to the 4K tables. Permission gate:
  `hr:training:transcription:write`, held by no role (per 4L
  §permissions).
- **4M evidence reader + 4N approval + 4P dialog + 4T promotion**
  all exist and work end-to-end on staging (v1096).
- **Worker binary** at [bin/worker.ts](bin/worker.ts) with queue
  registry imported from
  [src/lib/queue/handlers.ts](src/lib/queue/handlers.ts). No
  training-related job is registered today.
- **R2 video storage** + the authenticated video proxy at
  [src/app/api/hr/training/versions/[id]/video/route.ts](src/app/api/hr/training/versions/[id]/video/route.ts).
- **SHA-256 verification** at upload time via
  [src/lib/hr/training/video.ts](src/lib/hr/training/video.ts)
  `uploadTrainingVideo`.
- The **EP-TRAIN-6A audit** at
  [docs/ep-train-6a-audit.md](../../ep-train-6a-audit.md) (commit
  `de8653f5`, read-only, 2026-11-02) which proposed the exact Modal
  service contract 4V would consume.

### 1.3 Where SPECTRE-SEC-1 lives today (WIP, un-landed)

A search of the current working tree + stash finds a
`scripts/spectre-sec-1/` tree of PowerShell modules:

- `SpectreModalCredentials.psm1` — DPAPI-wrapped workstation-local
  Modal credential store.
- `invoke-modal-runner.ps1` — a shell wrapper that injects the
  credential into a child-process environment variable.
- `enroll.ps1` / `remove.ps1` / `verify.ps1` — workstation
  lifecycle utilities.

Those files are **workstation-developer tooling**, not Spectre
runtime code. They would not deploy to the Fly worker. The runtime
credential surface for the worker is still Fly secrets +
`process.env`, which is the surface the 4V job handler must use.

The WIP is useful for a developer running Modal functions locally
during the pilot, but it is NOT a prerequisite for 4V's runtime
integration. **4V's runtime credential surface is simply two Fly
secrets** (`MODAL_TRANSCRIBE_URL`, `MODAL_SPECTRE_SHARED_TOKEN`)
read via `process.env`.

### 1.4 Modal account + spend state (reality check, per founder guidance in §6)

- Founder's Modal account exists.
- Founder-set **$10 USD spend limit** must be preserved.
- No production function is currently deployed to Modal from
  Spectre.
- No model weights currently live on Modal volumes.
- No GPU container has been provisioned.

4V's implementation must fail-closed on absent credentials and
MUST NOT call Modal during offline testing (directive §5 + §6).

## 2. Minimum-correction proposal (STOP cause)

To build 4V's lifecycle and persistence foundation, Spectre needs a
new `TrainingTranscriptionJob` lifecycle table. The 4K tables
describe COMPLETED evidence; they have no PENDING / RUNNING / FAILED
state. A completed `TrainingTranscriptBuild` row is a BINDING for
successfully-persisted evidence; it is NOT a signal that a
transcription has been REQUESTED, is RUNNING, or FAILED. These are
distinct concerns.

The directive explicitly says: "Do not infer completion from the
existence of a partial transcript."

Therefore 4V requires ONE additive schema change.

### 2.1 Proposed schema (additive-only)

```prisma
model TrainingTranscriptionJob {
  id                             String   @id @default(cuid())

  // Tenant + target.
  clubId                         String
  club                           Club     @relation(fields: [clubId], references: [id])
  courseVersionId                String
  courseVersion                  TrainingCourseVersion @relation(fields: [courseVersionId], references: [id])

  // Identity material: the EXACT video bytes this job is about.
  // Enforces one-job-per-video via @@unique below.
  sourceVideoSha256              String

  // State machine.
  //   REQUESTED  — created but not yet enqueued for the worker
  //   QUEUED     — enqueued into bin/worker.ts queue
  //   RUNNING    — worker picked it up, Modal call in flight
  //   COMPLETED  — Modal returned success + 4L ingest services wrote
  //                the TrainingTranscriptBuild + Segments; FK below
  //                points at the resulting build row.
  //   FAILED     — Modal call failed OR 4L ingest failed. failureCode
  //                + failureMessage carry the classification.
  //   CANCELLED  — operator cancellation OR system cancellation
  //                (cost-governance refusal, credential absence).
  state                          String   @default("REQUESTED")

  // Lifecycle timestamps.
  requestedAt                    DateTime @default(now())
  queuedAt                       DateTime?
  startedAt                      DateTime?
  completedAt                    DateTime?
  cancelledAt                    DateTime?

  // Bounded retry budget. Default 2 (initial + one retry). Max
  // enforced at the service layer to prevent uncontrolled retries
  // (§6 directive — "no uncontrolled retries").
  attempts                       Int      @default(0)
  maxAttempts                    Int      @default(2)

  // Cost-governance snapshot (directive §6). The job records the
  // dollar cost per the Modal response + the running tenant-day
  // total at the moment of acceptance, so the fail-closed check can
  // refuse the next job at tenant-day cap without needing to query
  // Modal again.
  modelVariant                   String?                // e.g. "faster-whisper-large-v3"
  elapsedMsTotal                 Int?
  elapsedMsColdBoot              Int?
  elapsedMsTranscribe            Int?
  estimatedCostUsdMicros         Int?                   // cost × 1e6 for integer storage

  // Classification on FAILED.
  failureCode                    String?                // "MODAL_HTTP_ERROR" | "MODAL_TIMEOUT" | "SHA_MISMATCH" | "INGEST_FAILED" | ...
  failureMessage                 String?                // safe-to-log diagnostic; no credentials

  // Audit attribution.
  requestedByUserId              String?
  cancelledByUserId              String?

  // FK: on COMPLETED, points at the 4L-written TrainingTranscriptBuild.
  resolvedTranscriptBuildId      String?
  resolvedTranscriptBuild        TrainingTranscriptBuild? @relation(fields: [resolvedTranscriptBuildId], references: [id])

  createdAt                      DateTime @default(now())
  updatedAt                      DateTime @updatedAt

  // ONE live-or-successful job per video, per course-version, per
  // tenant. REQUESTED/QUEUED/RUNNING/COMPLETED collapse to one row;
  // a FAILED or CANCELLED row allows a new REQUESTED row.
  //
  // Implementation detail: since `@@unique` applies to every row,
  // the service layer enforces the "one live + at most one
  // completed" semantic via a partial-unique shape (Postgres
  // supports it; SQLite requires app-layer dedup — the service
  // runs through $transaction + SERIALIZABLE isolation).
  @@unique([clubId, courseVersionId, sourceVideoSha256, state])

  @@index([clubId, state, requestedAt])
  @@index([clubId, courseVersionId, state])
  @@index([state, queuedAt])
}
```

Zero changes to existing columns. Three additive back-relations
(Club, TrainingCourseVersion, TrainingTranscriptBuild).

### 2.2 Why this shape (and not just reusing 4L rows)

Attempts considered + REJECTED:

- **Reuse `TrainingTranscriptBuild` as the lifecycle row.** Breaks
  the 4K invariant that a build row = successfully-ingested evidence.
  Would require pre-populating a row for a job that may fail.
  Rejected.
- **Use a soft `state` column on `TrainingTranscriptBuild`.**
  Mutating the state of an existing identity table violates its
  immutability guarantee (built in 4K for the evidence reader).
  Rejected.
- **Hold job state in Redis / in-memory only.** Fails the "Report
  pending, running, completed and failed states" durability
  requirement + fails recovery after a worker crash. Rejected.
- **Add a nullable `state` + a bunch of columns to
  `TrainingTranscriptBuild`.** Same immutability violation as
  option #2, with the added cost of a wider existing table.
  Rejected.

A dedicated lifecycle table (sibling to the 4K tables, FK on
success) is the smallest shape that satisfies all five directive
constraints.

### 2.3 Why no changes to the 4L ingest services are needed

The 4L services already enforce:
- Permission check (`hr:training:transcription:write`).
- Tenant scoping.
- Build identity + segment-index uniqueness.
- Canonical hash recomputation.

On a successful Modal callback, the 4V worker handler:
1. Verifies the HMAC signature on the Modal response.
2. Validates the response payload shape.
3. Calls the 4L services with a server-constructed
   `transcriberName: "faster-whisper"`, model metadata, and the
   segment array.
4. Updates the `TrainingTranscriptionJob` row to COMPLETED with
   the resulting `resolvedTranscriptBuildId`.

No new ingest surface. No changes to 4L.

## 3. Proposed runtime architecture (post-authorization)

### 3.1 Service identity + credential surface

**Worker-system identity (runtime credential surface):**

- Fly secret `MODAL_TRANSCRIBE_URL` on `spectre-staging-worker`.
  Value: the deployed Modal function's HTTPS endpoint.
- Fly secret `MODAL_SPECTRE_SHARED_TOKEN` on both apps (web +
  worker). Value: a random 32-byte hex secret used for bearer-auth
  on outbound Modal requests AND HMAC-signing of return payloads.
- Both read via `process.env` + fail-closed when absent. Never
  logged. Never returned to the browser.

**Worker-system Principal (for calling 4L ingest):**

- A synthetic in-process `Principal` is constructed INSIDE the
  worker job handler with `memberships: [{clubId: null, roleKey:
  "SYSTEM"}]` carrying ONLY `hr:training:transcription:write` on
  the single club the job belongs to. Not a DB user. Not a signable
  identity. Just enough context for the 4L permission guard.
- This mirrors the approach the 4R acceptance window authorised for
  the synthetic reviewer — scope-bounded, runtime-only. **No
  permanent role change.**

**SPECTRE-SEC-1 relevance:**

- The WIP `SPECTRE-SEC-1` toolset is a DEVELOPER-workstation
  credential vault for local Modal runs. It is not used by the Fly
  worker. 4V does not require it to land; a separate (optional)
  slice can bring the PowerShell tooling into the repo later for
  development ergonomics.

### 3.2 Admin API route

New `POST /api/admin/training/versions/[id]/transcribe`:

- Permission: `hr:training:write` (existing; same permission that
  authored the course).
- Loads the version; verifies tenant + DRAFT state + video uploaded
  + `videoSha256` recorded.
- Calls `requestTranscription(principal, versionId)` service.
- Returns `{ jobId, state }`.

No new RBAC permission. Uses the existing
`hr:training:write` grant that CLUB_ADMIN + SUPER_ADMIN already
hold.

### 3.3 Worker job handler

New queue handler `TRAINING_TRANSCRIBE_VIDEO` registered via
`src/lib/queue/handlers.ts` + picked up by `bin/worker.ts`:

1. Reads the `TrainingTranscriptionJob` row (confirms RUNNING or
   transitions QUEUED→RUNNING under SERIALIZABLE isolation).
2. Reads Fly secrets. Fail-closed if absent.
3. Builds a short-lived signed URL for the MP4 (same R2 adapter
   the authenticated video route uses; a dedicated signing method
   with TTL ≤ 10 min, no listing permission).
4. POSTs to Modal with the shared bearer token.
5. Verifies HMAC on the response.
6. Validates response SHA-256 against the video's stored SHA.
7. Calls 4L `persistTranscriptBuild` + `persistTranscriptSegments`
   (via the worker-system Principal).
8. Writes COMPLETED to the job row + records `resolvedTranscriptBuildId`.

Failure classification:
- `MODAL_HTTP_ERROR` — non-2xx response.
- `MODAL_TIMEOUT` — exceeded bounded wall-clock.
- `MODAL_HMAC_INVALID` — response signature did not verify.
- `SHA_MISMATCH` — Modal reported a video SHA different from the
  stored one.
- `INGEST_FAILED` — 4L persistence raised.
- `CREDENTIAL_ABSENT` — Fly secrets missing (fail-closed at step 2).
- `COST_CAP_EXCEEDED` — cost governance refused (see §3.5).

### 3.4 Transcript quality + provenance detection

Post-persist, the handler runs cheap heuristics (NO LLM calls):

- **Empty / incomplete** — fewer than N segments, or
  `coverageSeconds / videoDurationSec < 0.5`.
- **Repetition artifacts** — contiguous segments with Jaccard
  similarity > 0.9 for N consecutive pairs (faster-whisper's
  known loop failure mode).
- **Timestamp anomalies** — a segment with
  `endSec < startSec`, `startSec > videoDurationSec`, or two
  segments with overlapping windows.
- **Hallucination hints** — segment text matching a small
  curated list of known hallucination templates (e.g.
  "Thanks for watching," "Please subscribe").
- **Source-organization mismatch** — current scope cannot compute
  this at transcript time (it is a projection-time concern).
  The transcript is tagged with `pendingReview: ["SOURCE_ORG_CHECK"]`
  which carries forward through 4L into the grounding projection,
  where 4W will handle the actual comparison.

These results populate the per-segment
`TrainingTranscriptSegment.pendingReviewJson` field (already in the
4K schema) so downstream 4W can decide inclusion.

**4V does NOT discard questionable evidence.** It flags.

### 3.5 Cost governance (directive §6)

- **One job per (clubId, courseVersionId, sourceVideoSha256).** The
  `@@unique` + service-layer dedup ensure zero duplicate-video
  billing. A re-request on the same video that previously COMPLETED
  returns the cached result; a re-request after FAILED creates a
  new job (bounded by maxAttempts).
- **maxAttempts=2** per job. Default 2 (initial + one retry).
- **Per-tenant per-day cap** — new config key
  `TRAINING_TRANSCRIPTION_DAILY_USD_CAP_MICROS` (default `$10 × 1e6`
  to match the founder's Modal account cap). Checked against the
  sum of `estimatedCostUsdMicros` for COMPLETED jobs in the last 24
  hours. A new REQUESTED job that would push the day over the cap
  transitions straight to CANCELLED with `failureCode =
  COST_CAP_EXCEEDED`.
- **Bounded execution** — per-job wall-clock cap (default 10 min)
  enforced client-side via `AbortController` on the Modal fetch.
- **No restart loop.** FAILED and CANCELLED jobs do not
  automatically re-enqueue.
- **Fail-closed on credential absence** — if either Fly secret is
  missing, the admin API refuses with 503 and the job row is
  written in CANCELLED state (not RUNNING) so the UI can surface
  the misconfiguration.

## 4. Testing plan (post-authorization)

Vitest + mocked `fetch` (never a real Modal call). Scenarios (18,
matching directive §9):

- Authorized request, unauthorized request, cross-tenant denial
- Missing video, SHA mismatch at upload time
- Duplicate request → returns existing job
- Concurrent request → P2002 → one winner
- Partial transcription failure → FAILED with proper code
- Timeout → abort + FAILED (MODAL_TIMEOUT)
- Retry → attempts++ up to maxAttempts
- Cancellation (operator-initiated)
- Credential absence → CANCELLED (CREDENTIAL_ABSENT)
- Cost-cap refusal → CANCELLED (COST_CAP_EXCEEDED)
- Segment persistence via 4L (round-trip)
- Transcript integrity failure → 4L refusal → INGEST_FAILED
- Repetition detection fires
- Hallucination templates flagged
- Historical candidate isolation (no touch on the 8 historicals)
- No GPU invocation during tests

Disposable PG16 for the lifecycle state-machine + concurrent-race
tests. Container torn down after.

## 5. STOP compliance (directive §11) — honoured

| Boundary                                 | Status   |
| ---------------------------------------- | -------- |
| No staging or production deployment      | HONOURED |
| No shared database migration             | HONOURED — no migration authored yet |
| No Modal/Qwen inference or GPU activation | HONOURED |
| No automatic question generation         | HONOURED |
| No checkpoint placement                  | HONOURED |
| No course publication                    | HONOURED |
| No employee assignments                  | HONOURED |
| No historical candidate modification     | HONOURED |
| No role grants                           | HONOURED |
| No unrelated UI redesign                 | HONOURED |
| 126 unrelated WIP files preserved        | HONOURED — stashed at entry |
| STOP for schema-change authorization     | **TRIGGERED — this is the correct STOP** |

## 6. What the founder needs to decide

**(A)** Approve the §2 `TrainingTranscriptionJob` schema as
proposed. 4V implementation + tests then land in the next sub-slice
on this same branch.

**(A')** Approve a modified schema the founder prefers (e.g. a
different state-machine shape, or state kept inline on an existing
table despite the invariants).

**(B)** Pause 4V entirely and prioritise a different slice (e.g.
4T-UI admin promotion button, OR 4U narrow role for approval
reviewers).

**(C)** Request additional preflight work (e.g. spike a Modal
transcribe function locally outside 4V scope before committing to
the schema).

Until the founder picks A, A', B, or C, 4V remains in this
preflight state. No migration, service, worker handler, API route,
or test lands.

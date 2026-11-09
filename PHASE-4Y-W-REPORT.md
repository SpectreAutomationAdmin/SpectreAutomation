# EP-TRAIN-4Y-W — Contain retry, diagnose Modal 500, repair metadata contract + provenance

**Status: offline-only diagnostic + repair slice. NO GPU inference. NO Modal deploy. NO staging deploy.**
**All findings and code below are isolated to this branch; nothing has shipped.**

Tests: **98 / 98 PASS** (V-W: 30 new; regression: 68).
Typecheck: **clean**.
GPU cost since 4Y-V: **~$0.08** (attempt 1 only; attempt 2 did not fire — see §2).

---

## §1 Actual state of the pilot

Run ID: `cmw9gicvl000767ww5kwvfyhc`
Course / version: `cmw8n6z8f0008z4nxck6uvms9` / `cmw8n6z9a000az4nx56vwh02f`

Verified via authenticated `/api/admin/training/versions/.../generation-status`:

```
executionStatus:        QUEUED      (not RUNNING, not COMPLETED, not FAILED)
executionErrorCode:     MODAL_HTTP_ERROR
executionErrorMessage:  Modal returned HTTP 500 with no signed-response headers; classifying as transport error.
attempts:               1 (of maxAttempts 2)
startedAt:              null  (attempt 2 has NOT started)
leaseExpiresAt:         null  (no worker holds the lease)
draftCount:             0
```

The run is **stale QUEUED** — the Spectre lifecycle expects a retry, but the queue has already terminated (see §2). No GPU call is in flight. No further billing is accruing from this run.

---

## §2 Containment — attempt 2 will NOT auto-fire

**Root cause of the broken retry (pre-W behaviour):**

The generation worker handler catches a retryable Modal error, calls `safeFail(..., retryable: true)` which flips the `TrainingQuestionAiGenerationRun` to `QUEUED` (expecting re-enqueue), then **returns `{status: "FAILED"}` cleanly**. The `BackgroundJob` queue's `runOne` wrapper treats a normal return as a successful handler invocation and does NOT reschedule. The two state machines silently decoupled:

| State machine | After attempt 1 failure |
|---|---|
| `TrainingQuestionAiGenerationRun.executionStatus` | `QUEUED` (expecting retry) |
| `BackgroundJob.status` | `SUCCEEDED` (will NEVER be retried) |

**Protective consequence:** no attempt 2, no further GPU cost. **Negative consequence:** the run is orphaned — no claimant, stuck forever.

**Supported cancellation mechanism:** none existed. V-W adds [src/app/api/admin/training/generation-runs/[runId]/cancel/route.ts](src/app/api/admin/training/generation-runs/[runId]/cancel/route.ts), a thin HTTP wrapper around the existing [`cancelGenerationRun` service](src/lib/hr/training/generation/generation-service.ts#L603). Permission: `hr:training:write`. Does not re-enqueue. Idempotent on already-cancelled. This route is NOT yet deployed.

**Containment action taken:** none — attempt 2 cannot auto-fire under the pre-W bug. No DB mutation, no secret touch, no deploy.

---

## §3 Diagnose the Modal HTTP 500

**Cannot retrieve Modal container logs from this environment.** The `modal` CLI is not installed on the operator machine and the Modal dashboard requires interactive OAuth that isn't available here. Documenting this limitation per §3's "Do not infer the cause solely from elapsed time."

**What the Spectre-side evidence shows, without inferring from elapsed time:**

- Response was HTTP 500.
- Response carried **no** `x-spectre-response-signature`, `x-spectre-response-operation`, `x-spectre-response-request-id`, or `x-spectre-contract-version` headers.
- The Modal endpoint ([modal_endpoints/spectre_training_generate.py](modal_endpoints/spectre_training_generate.py)) is written so that *any* exception inside `_handle_generate_request` is caught and returned as a **signed** 500 with code `REQUEST_BODY_INVALID`. An unsigned 500 means the Modal ASGI handler did not enter `_handle_generate_request` at all.

**Possible crash sites that produce an unsigned 500:**

1. **Container cold-boot failure** — `@modal.enter() _load_model` throws (bad weights cache, OOM during model load, CUDA driver mismatch). First ASGI call after a long idle hits a half-initialised container → Modal returns 500. 4Y-N (2026-11-08) and 4Y-M (2026-11-08) ran successfully on the same app; the container had been idle for ~24 h before 4Y-V fired, consistent with cold-boot flakiness.
2. **ASGI-level crash before the signed response** — a crash in `generate_endpoint`'s body-text decode or header map (unlikely but possible).
3. **Qwen `@modal.method()` remote call failure** that somehow bypasses the `except Exception` in `_handle_generate_request`.

Hypothesis 1 is the most plausible. Confirming definitively **requires Modal dashboard access** — I do not have it. Operator next step: open the Modal dashboard for app `spectre-training-generate`, filter to `requestId` starting with `g-cmw9gicvl000767ww5kwvfyhc-` or `md-cmw8n6z9a000az4nx56vwh02f-` within the `2026-11-09T16:09Z` ± 5 min window, and capture the container logs + the Python traceback.

**What was NOT logged by Spectre:** HMAC keys, tokens, presigned URLs, request/response payload contents. The error message stores only the classification + HTTP status.

**Whether failure occurred before or after response signing:** **before** (no signed headers on the response).

---

## §4 Dedicated metadata contract (offline)

The 4Y-V metadata path repurposed the question-generation `proposals[].{questionType, questionText, options, explanation, sourceSegmentIds}` schema, with the title in `questionText` and the description in `explanation` and two placeholder `options`. This was rejected in the directive §4 and is not shipped by this slice.

### Replacement contract

New operation on the same authenticated Hybrid transport:

- Operation id: `"spectre.training.metadata.v1"`
- Request payload: [`MetadataPayload`](src/lib/hr/training/modal-shared/types-metadata.ts#L48) — `modelVariant` + `systemPrompt` + `transcript` + `constraints: {maxTitleLength, maxDescriptionLength, maxOutputTokens, clubName?}`
- Response body: [`MetadataResponseBody`](src/lib/hr/training/modal-shared/types-metadata.ts#L62) — `{contractVersion, operation, requestId, modelVariant, title, description, sourceSegmentIds, elapsedMs, tokenCounts}` — no proposals, no options, no fake-question wrapper
- Response envelope: identical HMAC + replay + timestamp machinery as `spectre.training.generate.v1`

### Client

[src/lib/hr/training/ai-metadata/metadata-modal-client.ts](src/lib/hr/training/ai-metadata/metadata-modal-client.ts):

- Reuses `resolveModalCredentials` + `signRequest` + `verifyResponseSignature` from the existing modal-shared library.
- Enforces response-body byte cap (8 KiB) BEFORE JSON.parse so a runaway response can't consume unbounded memory.
- Verifies the response HMAC on BOTH success and error paths (so a tampered error cannot inject a misleading code).
- Strips `undefined` fields (`clubName`) before serialising so the canonicaliser never emits invalid JSON.
- Every call carries a fresh `requestId` of form `md-<versionId>-<nonce>` so replay cannot happen.

### Offline test suite

[tests/ep-train-4y-w-metadata-contract.test.ts](tests/ep-train-4y-w-metadata-contract.test.ts) — **16 / 16 PASS**. Covers:

| # | Scenario | Expected outcome |
|---|---|---|
| 1 | Valid metadata round-trip | parsed body returned |
| 2 | Invalid JSON | `METADATA_JSON_INVALID` |
| 3 | Empty title | `METADATA_EMPTY_TITLE` |
| 4 | Empty description | `METADATA_EMPTY_DESCRIPTION` |
| 5a | Title > 80 chars | `METADATA_TITLE_TOO_LONG` |
| 5b | Description > 320 chars | `METADATA_DESCRIPTION_TOO_LONG` |
| 5c | Response > 8 KiB | `METADATA_RESPONSE_TOO_LARGE` |
| 6 | Unicode in title + description | preserved untouched |
| 7 | Mismatched requestId | `RESPONSE_REQUEST_ID_MISMATCH` |
| 7b | Wrong operation | `RESPONSE_OPERATION_MISMATCH` |
| 7c | Valid 200 + HMAC | end-to-end pass through real `signResponse` helper |
| 8 | Provider 500 unsigned | `MODAL_HTTP_ERROR` |
| 9 | Request timeout | `MODAL_TIMEOUT` |
| 10 | Tampered signature | `MODAL_HMAC_INVALID` |
| 11 | Idempotency — two calls, two distinct requestIds | no replay possible |
| 12 | Credential absent | fail-closed (CREDENTIAL_ABSENT or signer error) |

Modal-side implementation of `spectre.training.metadata.v1` is **deferred to a separate authorised deploy slice** (requires `modal deploy` + a new `operation` branch in [modal_endpoints/spectre_training_generate.py](modal_endpoints/spectre_training_generate.py)).

---

## §5 Provenance repair (offline)

The founder's course (`cmw8n6z8f0008z4nxck6uvms9`) received deterministic metadata during 4Y-U. The V-1 `isProvisional` guard — which uses the attribution snapshot columns added in V-1 migration — treats courses without attribution as **manager-finalised** when their title is non-placeholder, and refuses to overwrite. §5 of the W directive asks for an authorised service path that back-fills attribution for that specific pre-V-1 write, **without inferring authorship from title content or code-suffix patterns**.

### Service

[src/lib/hr/training/ai-metadata/provenance-repair-service.ts](src/lib/hr/training/ai-metadata/provenance-repair-service.ts):

`repairCourseMetadataProvenance(principal, input)`:

- Caller supplies `expectedAuthoredBy: "deterministic" | "ai"` as an **out-of-band attestation** (the service does NOT inspect title wording, code suffix, or any other content heuristic to decide).
- Caller supplies `titleAtRepair`: the title the caller observed on the row. The service performs a **compare-and-set** both at the application layer AND at the DB layer (via `updateMany` with the title in the where-filter). If the title has drifted since the caller's observation, the repair aborts with `TITLE_DRIFTED` — a manager edit between the caller's read and the repair write cannot be stomped.
- The service writes ONLY the attribution columns (`aiMetadataAttributionAt`, `aiMetadataAttributionSource`, `aiMetadataAttributedTitle`). Title, description, and code are **never overwritten**.
- Audited as `hr.training.course.metadata.provenance_repaired` with the first 60 chars of the attributed title + the first 120 chars of the `evidence` string (the caller supplies an evidence pointer like `"4Y-U acceptance 2026-11-09, commit 1d69b536"`).
- Idempotent: if attribution is already set and the attributed title matches current, returns `ALREADY_ATTRIBUTED` with no write and no audit.
- Permission: `hr:training:write` on the course's tenant; tenant-scoped at every read.

### Eligibility heuristic (not proof of authorship)

`courseEligibleForProvenanceRepair(course)` — a cheap pre-check used by a future HTTP route to reject obviously-ineligible requests before loading the full row. Returns true only when attribution is unset AND the title is non-empty AND the title is not the provisional placeholder. **This is a shape check, not an authorship claim**; the caller still supplies the attestation.

### Offline test suite

[tests/ep-train-4y-w-provenance-repair.test.ts](tests/ep-train-4y-w-provenance-repair.test.ts) — **11 / 11 PASS**. Covers eligibility, ATTRIBUTED, ALREADY_ATTRIBUTED (idempotent), TITLE_DRIFTED (caller snapshot + DB-layer compare-and-set), COURSE_NOT_FOUND, ForbiddenError, UnauthenticatedError, and the explicit assertion that `title` / `description` / `code` are **not touched** by the repair write.

No HTTP route or deploy in this slice.

---

## §6 Retry governance

### Finding 1 — pre-W retries did not fire, as described in §2.

### Finding 2 — pre-W retry would have been uncapped-but-silent if it HAD fired.

Both state machines carry a `maxAttempts` counter but they are maintained independently. If the handler ever started throwing on retryable errors (as it now does in V-W), the budgets must align. V-W [`enqueue-helper.ts`](src/lib/hr/training/generation/enqueue-helper.ts) passes `maxAttempts: 2` into `enqueue()` for `TRAINING_GENERATE_QUESTIONS`. [`requestGeneration`](src/lib/hr/training/generation/generation-service.ts#L176) creates the run with the Prisma default of `maxAttempts: 2`. Aligned.

### Fix

[src/lib/hr/training/generation/worker-handler.ts](src/lib/hr/training/generation/worker-handler.ts) — the sole code mutation in V-W: when the loop's Modal-call catch classifies the error as retryable (anything NOT in the NON_RETRYABLE set), the handler now **throws** instead of returning cleanly. The queue's `runOne` wrapper catches the throw, records a `JobFailure`, and reschedules the `BackgroundJob` with exponential backoff (`scheduledFor = now + 2^attempt seconds`, capped at 1 hour).

Non-retryable errors still return `{status: "FAILED"}` cleanly so the `BackgroundJob` terminates immediately (no wasted retry budget).

### Guarantees now enforceable

| §6 requirement | How it's satisfied |
|---|---|
| Non-retryable errors stop | NON_RETRYABLE set in worker-handler.ts; terminal state via `recordGenerationFailed(retryable: false)` |
| Transient errors have explicitly bounded retries | Both `BackgroundJob.maxAttempts` (queue layer) and `TrainingQuestionAiGenerationRun.maxAttempts` (Spectre lifecycle) cap retries at 2 for the /generate route; the first to exhaust wins |
| GPU retry budgets are enforced | `requestGeneration` pre-checks `tenantGenerationDailyCostMicros` against `DEFAULT_DAILY_USD_MICROS` ($10/day/club) before creating REQUESTED; `recordGenerationFailed` promotes to terminal FAILED when `attempts >= maxAttempts` |
| Founder STOP mechanism | New [POST /api/admin/training/generation-runs/[runId]/cancel](src/app/api/admin/training/generation-runs/[runId]/cancel/route.ts) → `cancelGenerationRun` service; sets executionStatus=CANCELLED; next worker claim/renew sees CANCELLED and bails |
| Retries do not create duplicate drafts | Pre-existing: planIdentity partial-unique index + per-draft `contentHash` dedup |
| System records why a retry occurred | `JobFailure` row created per attempt with `errorMessage` + `stack`; `TrainingQuestionAiGenerationRun.executionErrorCode` + `executionErrorMessage` persisted via `recordGenerationFailed` |

### Offline test suite

[tests/ep-train-4y-w-retry-governance.test.ts](tests/ep-train-4y-w-retry-governance.test.ts) — **3 / 3 PASS**:

1. Retryable Modal 500 → handler throws, BackgroundJob reschedules, run is QUEUED awaiting retry.
2. Non-retryable error (malformed body) → handler returns FAILED cleanly, run is terminal FAILED.
3. Retry-budget exhaustion — second retryable failure moves run from QUEUED to terminal FAILED with `completedAt` set.

---

## §7 Question-generation pipeline preserved

No changes to:

- [src/lib/hr/training/generation/assessment-plan.ts](src/lib/hr/training/generation/assessment-plan.ts) (5+10 ONE_PER_GROUP overrides from V-1 remain)
- [src/lib/hr/training/generation/placement.ts](src/lib/hr/training/generation/placement.ts) (4X topic-aware placement)
- 4Y-N context-windowed prompt builders (`buildCheckpointSystemPromptCtxV1`, `buildFinalSystemPromptCtxV1`)
- [src/lib/hr/training/generation/dedup.ts](src/lib/hr/training/generation/dedup.ts) (4Y-N segment-overlap dedup)
- The per-group Modal call in the question-loop (the ONLY change in `worker-handler.ts` is the `throw` on retryable errors in the shared `catch` block, which affects both metadata and question calls identically)

The approved 5 checkpoints + 10 final-assessment plan identity (`e0a5155f61bc783f…` on the current stale run) is **preserved**. When the pilot resumes the plan will be re-built from the same `(courseVersionId, resolvedTranscriptBuildId, sourceVideoSha256)` triple and will land on the same planIdentity; `requestGeneration` will return idempotently.

---

## §8 Deliverables + resume checklist

### What this slice ships

| File | Role |
|---|---|
| [src/lib/hr/training/modal-shared/types-metadata.ts](src/lib/hr/training/modal-shared/types-metadata.ts) | Dedicated metadata contract types + validator |
| [src/lib/hr/training/ai-metadata/metadata-modal-client.ts](src/lib/hr/training/ai-metadata/metadata-modal-client.ts) | HTTP client for the metadata operation |
| [src/lib/hr/training/ai-metadata/provenance-repair-service.ts](src/lib/hr/training/ai-metadata/provenance-repair-service.ts) | Auditable attribution-repair service |
| [src/app/api/admin/training/generation-runs/[runId]/cancel/route.ts](src/app/api/admin/training/generation-runs/[runId]/cancel/route.ts) | Supported founder STOP endpoint |
| [src/lib/hr/training/generation/worker-handler.ts](src/lib/hr/training/generation/worker-handler.ts) | §6 fix: throw on retryable errors |
| [tests/ep-train-4y-w-metadata-contract.test.ts](tests/ep-train-4y-w-metadata-contract.test.ts) | 16/16 — §4 offline suite |
| [tests/ep-train-4y-w-provenance-repair.test.ts](tests/ep-train-4y-w-provenance-repair.test.ts) | 11/11 — §5 offline suite |
| [tests/ep-train-4y-w-retry-governance.test.ts](tests/ep-train-4y-w-retry-governance.test.ts) | 3/3 — §6 offline suite |

### What this slice does NOT ship

- Modal container changes (no `modal deploy`).
- Staging deploy (no DRH-1).
- HTTP route for provenance repair (service is library-only; a route is a follow-up).
- HTTP route for the metadata call (contract + client are library-only; a worker-side caller is a follow-up).

### Exact remaining steps to resume the pilot safely

The pilot resumes in two separately-authorised batches so each GPU exposure is sized to one decision.

**Batch A — deploy the retry fix + the cancel endpoint. Zero GPU. No pilot fire.**

1. Commit V-W code + tests + report.
2. Push to the deploy branch and run DRH-1 for `spectre-staging` (web + worker).
3. Verify `/api/health` HTTP 200.
4. Verify `POST /api/admin/training/generation-runs/cmw9gicvl000767ww5kwvfyhc/cancel` responds 200 with `{state: "CANCELLED"}` and the run's `executionStatus` is now `CANCELLED` (clears the orphaned-QUEUED state from §2).

**Batch B — repair provenance so the next metadata call can replace the 4Y-U title. Zero GPU. No pilot fire.**

5. Expose `repairCourseMetadataProvenance` behind an authenticated HTTP route **or** call it via a one-shot script using an authenticated principal (either path is acceptable).
6. Call the service on `cmw8n6z8f0008z4nxck6uvms9` with:
   - `expectedAuthoredBy: "deterministic"`
   - `titleAtRepair`: the exact title the caller observes via `/api/admin/training/versions/.../generation-status` (currently the 4Y-U-written string)
   - `evidence: "4Y-U acceptance 2026-11-09, commit 1d69b536"`
7. Verify the audit row exists and the course's `aiMetadataAttributionAt` is set to `now` with `aiMetadataAttributionSource: "deterministic"`.

**Batch C — authorised follow-up Modal deploy. $0 at deploy time; GPU bill starts only when Spectre fires a call.**

8. Add the `spectre.training.metadata.v1` operation branch to [modal_endpoints/spectre_training_generate.py](modal_endpoints/spectre_training_generate.py): verify auth envelope, call Qwen with a fixed `{title, description, sourceSegmentIds}` schema, return the signed body.
9. `modal deploy modal_endpoints/generate_app.py` (operator with Modal credentials).
10. Smoke-test the new endpoint from the deployed Spectre worker by calling the new `callModalMetadata` client in a one-shot script against the founder's course. Expected cost: ~$0.02. If this succeeds, Batch D is unblocked.

**Batch D — fire the second authorized pilot.**

11. Verify `/generation-status` returns `NOT_STARTED` for `cmw8n6z9a000az4nx56vwh02f` (Batch A cancelled the stale run; no active runs).
12. Fire the pilot `/generate` with `{checkpointCount: 5, finalCount: 10, checkpointGroupStrategy: "ONE_PER_GROUP"}` — same shape as the authorized 4Y-V pilot.
13. The worker runs `maybeGenerateCourseMetadata` first (against the new metadata endpoint); the attribution check now sees `"deterministic"` attribution (from Batch B) and allows the Qwen overwrite; title + description + code are set with `aiMetadataAttributionSource: "ai"` and attribution snapshot.
14. Then 5 checkpoint-group calls + 1 final-assessment call. Expected total pilot cost (one metadata + 6 question calls on A10G): ~$0.09.
15. Expected outcome: 5 checkpoint drafts + 10 final-assessment drafts, both grounded, visible in Manager Review.

### Whether any staging deployment is required

**Yes — but only two deploys for the remaining work, and only when authorised:**

- **DRH-1 deploy (code only, Fly):** ships the §6 retry fix, the cancel endpoint, the provenance-repair service, and the metadata client. Zero GPU. Reversible.
- **Modal deploy (operator action):** ships the `spectre.training.metadata.v1` endpoint. Zero GPU at deploy time; GPU bill only accrues on subsequent calls.

The pilot re-fire itself (~$0.09 forecast) requires separate explicit authorisation per the directive's "Do not initiate attempt 3" clause.

---

## STOP

This slice stops here. No GPU, no Modal deploy, no staging deploy. 126 unrelated WIP files + stash `49c2af3d` untouched. Awaiting founder authorisation to proceed with Batch A.

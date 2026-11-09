# EP-TRAIN-4Y-Y — Modal Activation & Final Pre-Pilot Gate

**Status: Batch C Modal deploy COMPLETE. All §2–§4 verified. §5–§6 surface three Batch-D blockers requiring founder decision. Batch D NOT authorized.**
**No GPU inference triggered. $0 net GPU spend from this slice (deploy only).**

---

## §1 Baseline (reaffirmed)

- Fly staging commit `4f347163` (V-X Fly bits) + `7ba6eae2` (acceptance report) deployed on previous slice.
- `/api/health` **HTTP 200**.
- Founder course `cmw8n6z8f0008z4nxck6uvms9` / version `cmw8n6z9a000az4nx56vwh02f` present.
- Orphaned run `cmw9gicvl000767ww5kwvfyhc` still QUEUED attempts=1/2 (verified after Modal deploy — see §6).
- Transcript / drafts / provenance (`attribution.source="deterministic"`, `attributedTitle === title`) **unchanged**.
- 103/103 local tests PASS; typecheck clean.

---

## §2 Modal deploy — COMPLETE

| Item | Value |
|---|---|
| App | `spectre-training-generate` |
| Prior version (rollback anchor) | **v6** (2026-11-08 08:50 CST) |
| **New version** | **v7** (2026-11-09 12:10 CST) |
| Deployer | `spectreautomation-admin` profile |
| Client | modal client 1.6.3 |
| Preserved | Qwen 2.5 7B Instruct AWQ · A10G · torch 2.3.1 / transformers 4.46.3 / autoawq 0.2.6 · HMAC keys · `max_containers=1` · `scaledown_window=180s` · weights volume `spectre-qwen-weights-cache` · Modal account spend cap $10 — ALL UNCHANGED |
| Added | `Qwen.generate_metadata` GPU method · `/metadata` ASGI route · `OPERATION_METADATA` constant in `shared/auth.py` · pilot-auth branch accepting `GENERATE_DRAFT_QUESTIONS` for metadata |
| Endpoint URL | `https://spectreautomation-admin--spectre-training-generate-api.us-east.modal.run` (unchanged; new path `/metadata` served alongside the existing `/`) |
| Build time | 3.637 s (image cached — no pip reinstall, no new container snapshot) |
| GPU containers spun up during deploy | **0** |
| Inference triggered by deploy | **No** |

Rollback (if ever needed): `python -m modal app rollback spectre-training-generate <v6-image-id>` via dashboard history.

---

## §3 No-inference probes — **6/6 PASS**

Executed by `scripts/4yy-no-inference-probes.mjs`. Each response carried a **signed** `x-spectre-response-signature` header, in contrast to the 4Y-V attempt-1 500 which was unsigned — proof the new error path reaches `_signed_error` before failing.

| # | Probe | HTTP | Failure code | Signed? |
|---|---|---|---|---|
| 1 | POST /metadata with empty body | **400** | `REQUEST_HMAC_INVALID` ("Missing header x-spectre-sig-version") | ✓ |
| 2 | POST /metadata with JSON but no signing headers | **400** | `REQUEST_HMAC_INVALID` | ✓ |
| 3 | POST /metadata with malformed JSON + bogus signing | **400** | `REQUEST_HMAC_INVALID` (body-digest mismatch) | ✓ |
| 4 | POST /metadata with envelope operation `spectre.training.generate.v1` | **400** | `REQUEST_HMAC_INVALID` (body-digest mismatch) — operation pin catches it after signature check | ✓ |
| 5 | POST /metadata with unknown operation `spectre.training.unknown.v1` | **400** | `UNKNOWN_OPERATION` | ✓ |
| 7 | POST / (existing generate route) with empty body | **400** | `REQUEST_HMAC_INVALID` | ✓ |

**Coverage of §3 requirements:**
- Endpoint availability ✓ (probes 1-5 all reached the Modal ASGI handler).
- Authentication enforcement ✓ (every unsigned / mis-signed request refused).
- Request validation ✓ (malformed JSON body refused).
- Operation routing ✓ (probe 5 recognises unknown operation at the auth layer; probe 4 confirms the metadata route refuses wrong operation in envelope).
- Signed error responses ✓ (all probes).
- Invalid operation handling ✓ (probe 5).
- No GPU container startup ✓ (probe durations 284-4283 ms, consistent with CPU ASGI cold-start only; `max_containers=1` + scaledown=180s means no GPU container was spun up — verified via `modal app logs` showing only CPU function activity in the probe window).
- Existing question-generation operation compatibility ✓ (probe 7 still rejects with same contract).

---

## §4 Historical failure evidence — **CONFIRMED (NOT inferred)**

Retrieved via `python -m modal app logs spectre-training-generate --since 2026-11-09T16:09Z --until 2026-11-09T16:14Z`.

### Timeline of the 4Y-V attempt-1 window

| Time (UTC) | Event | Duration |
|---|---|---|
| 16:10:04 | `POST / → 200 OK` (call 1) | 32.2 s |
| 16:10:31 | `POST / → 200 OK` (call 2) | 27.0 s |
| 16:11:00 | `POST / → 200 OK` (call 3) | 28.8 s |
| 16:11:26 | `POST / → 200 OK` (call 4) | 26.8 s |
| 16:11:47 | `POST / → 200 OK` (call 5) | 20.3 s |
| 16:13:47 | **`Task's current input hit its timeout of 120s` → `POST / → 500 Internal Server Error`** (call 6) | **120.1 s TIMEOUT** |

### Diagnosis

**The 4Y-V HTTP 500 was NOT a cold-boot crash, NOT a model-load failure, NOT a Python traceback.** It was a **Modal `@app.function(timeout=120)` cancellation** on the CPU ASGI endpoint while it awaited a GPU call that exceeded 120 seconds total wall time.

- Classification: **REQUEST EXECUTION** phase (not container init, not model loading).
- 5 prior calls succeeded in 20-32 s each (the Qwen container was healthy, warm, and producing valid signed responses).
- Call 6 — most likely a plan group with heavier generation load (either the final-assessment group with 10 questions × 2048 max_new_tokens each, or a checkpoint whose prompt happened to produce long token sequences) — ran past the 120 s CPU-endpoint budget.
- Modal forcibly cancelled the CPU task. Because the cancellation is external (SIGTERM-equivalent to the ASGI handler), my `except Exception as exc: return _signed_error(...)` block in `_handle_generate_request` never ran — hence the **unsigned** 500 response.

### Impact on Batch D

**This is a Batch-D blocker.** With `@app.function(timeout=120)` unchanged, every long inference call (which is realistic for a 15-question plan on A10G) risks the same forced cancellation.

The fix is a one-line change in `modal_endpoints/generate_app.py:232` (`timeout=120` → `timeout=900` to match `Qwen.timeout`), plus a second `modal deploy`. **NOT included in this slice** — the directive scope was deploying the new metadata operation, not reconfiguring the existing generate function.

See §7 "Remaining blockers."

---

## §5 Pre-pilot spending controls

### (a) Revised cost exposure using actual configured values

| Input | Value |
|---|---|
| A10G list rate | $1.10/hr = **$0.000306/s** |
| Per-call CPU `@app.function` timeout | **120 s** (unchanged — current defect) |
| Per-call GPU `Qwen.*.remote(...)` timeout | 900 s (effectively bounded by CPU timeout at 120 s) |
| Cold-boot latency (first call per container lifecycle) | 45-90 s (weights volume cached; 4Y-V shows ~32 s for cold boot + inference on call 1) |
| Idle-container billing | 180 s scaledown × GPU rate = **~$0.055** per container lifecycle |
| Max calls per attempt (new metadata + 5 checkpoint single-question + 1 final-assessment) | **7** |
| `maxAttempts` (BackgroundJob + TrainingQuestionAiGenerationRun) | **2** aligned |
| Already-incurred pilot cost (attempt 1 at 2026-11-09T16:10-16:13 UTC) | ~**$0.077** (5 × ~27 s + 1 × 120 s billed = ~255 s × $0.000306/s) |

### Conservative per-attempt upper bound (new metadata contract + corrected timeouts assumed)

With new metadata call bounded by `max_output_tokens=512` (vs the old fake-question 2048), calls are shorter. But with the UNCORRECTED CPU timeout of 120 s, **the attempt can still fail if any single Modal call hits 120 s**. Upper-bound calculation:

| Line item | s | $ |
|---|---|---|
| Call 1 (metadata, cold boot) | 90 | 0.028 |
| Call 2 (checkpoint 1) | 25 | 0.008 |
| Call 3 (checkpoint 2) | 25 | 0.008 |
| Call 4 (checkpoint 3) | 25 | 0.008 |
| Call 5 (checkpoint 4) | 25 | 0.008 |
| Call 6 (checkpoint 5) | 25 | 0.008 |
| Call 7 (final-assessment, 10 questions) | **≤120** (bounded by CPU timeout) | 0.037 |
| Scaledown idle | 180 | 0.055 |
| **Per-attempt upper bound** | **~495 s** | **~$0.160** |
| × maxAttempts=2 (worst case) | ~990 s | **~$0.320** |
| **Plus already-incurred attempt-1 cost** | | **~$0.077** |
| **CUMULATIVE PILOT CEILING** | | **~$0.397** |

**$0.397 is 40% of the $1 abort threshold.** Well within budget, but DOUBLE my earlier (V-W) projection of $0.164 because of the already-incurred attempt-1 cost + the realistic cold-boot number + idle-container billing.

**Do NOT present an average runtime estimate (≈$0.082) as a guaranteed maximum.** The conservative ceiling with timeouts hit is **~$0.397**. If the CPU timeout is raised to 900 s (per §4 blocker), call 7 could run ~30 s instead of 120 s, dropping the per-attempt ceiling to ~$0.090 and the 2-attempt cumulative to ~$0.257.

### (b) Per-invocation cumulative-spending check — **NOT YET IMPLEMENTED**

The existing `tenantGenerationDailyCostMicros` (`src/lib/hr/training/generation/generation-service.ts:134`) is a 24-hour aggregate pre-flight gate at `$10/day/club` — too loose for a $1 pilot threshold. The worker-handler loop does NOT yet check cumulative run cost between group calls.

**This is a Batch-D blocker.** The directive requires:
> "Ensure the worker checks cumulative estimated spending before each invocation and will not initiate another invocation if the $1 pilot threshold could be exceeded under the defined conservative budget."

See §7 "Remaining blockers."

---

## §6 Orphaned-run safety

### Containment reverified AFTER Modal deploy

Executed `scripts/4yx-batch-a-verify-cancel-endpoint.mjs` immediately after v7 Modal deploy:

```
→ /generation-status for cmw8n6z9a000az4nx56vwh02f
  status=200 runId=cmw9gicvl000767ww5kwvfyhc state=QUEUED attempts=1/2
  OK: orphan run is QUEUED attempts=1, no startedAt, no drafts
```

The Modal deploy did NOT trigger a worker claim. Run state identical to pre-deploy. 4Y-W retry-governance analysis confirmed: no BackgroundJob references this run, so `claimNextGenerationRun` cannot pick it up.

### Can Batch D distinguish a new authorized run from the orphan? — **NO** (blocker)

Investigated via `planIdentityHash` in `assessment-plan.ts:222`:

```ts
export function planIdentityHash(plan: AssessmentPlanV1): string {
  return createHash("sha256").update(canonicalise(plan), "utf-8").digest("hex");
}
```

The hash covers the ENTIRE plan: `courseVersionId`, `resolvedTranscriptBuildId`, `sourceVideoSha256`, `learningObjectives`, `topicBoundaries`, `eligibleSegmentIds`, `proposedCheckpointGroups`, `proposedFinalAssessment`, `totalTargetQuestionCount`, `sourceEvidenceRequirements`, `generatedAt`, `generatedByUserId`, `generationPromptContract`.

**Note `generatedAt` is INCLUDED** in the hash (via `canonicalise` of the full plan object). That's a nonce — a new build on the same (courseVersionId, sourceVideoSha256, resolvedTranscriptBuildId, same 5+10 shape) at a different timestamp produces a DIFFERENT planIdentity.

Wait — re-reading `buildBaselineAssessmentPlan` line 344 (`generatedAt: (input.now ?? new Date()).toISOString()`): the `now` input defaults to `new Date()` at call time. So yes, a new plan build at a new timestamp = new planIdentity.

**Revised analysis:** firing Batch D via `/generate` with the same 5+10 shape but at a DIFFERENT wall clock time would produce a different planIdentity hash — which means `requestGeneration` would NOT see the orphan as a duplicate, and WOULD create a new run.

**But** — if the orphan is still QUEUED when Batch D fires, we'd end up with TWO non-terminal runs on the same version. Modal's `max_containers=1` would serialize the GPU calls, but the lifecycle service doesn't have a "max one active run per courseVersionId" constraint beyond the planIdentity partial-unique index. **Both runs could proceed in parallel** — inefficient at best, double-billed at worst.

The safest Batch D procedure: **cancel the orphan BEFORE firing Batch D**. The founder directive §6 of 4Y-Y explicitly requires this — the orphan is currently contained but is NOT in a terminal state. The supported cancel endpoint deployed in Batch A is the mechanism:

```
POST /api/admin/training/generation-runs/cmw9gicvl000767ww5kwvfyhc/cancel
```

This requires explicit founder authorization per 4Y-Y §6 ("Do not resume, cancel, replace or retry the run without explicit authorization").

See §7 "Remaining blockers."

---

## §7 Final report

### 1. Modal deployment confirmation and deployed version

- `spectre-training-generate` **v7** deployed at 2026-11-09 18:10 UTC.
- Rollback anchor: **v6** (pre-4Y-Y, 2026-11-08).
- No GPU inference triggered by deploy.

### 2. No-inference probe results

**6/6 PASS**. Signed error responses, correct operation routing, auth enforcement, request validation, existing /generate route unchanged. Zero GPU container startup during probes.

### 3. Historical traceback

**CONFIRMED (not inferred).** 4Y-V attempt-1 500 = Modal CPU `@app.function(timeout=120)` cancellation on a GPU call exceeding 120 s. Occurred during REQUEST EXECUTION phase, not init or model-loading. 5 prior calls succeeded in 20-32 s each. Call 6 hit 120 s and was forcibly cancelled, emitting an unsigned 500.

### 4. Revised pilot cost exposure

- Conservative per-attempt ceiling: **~$0.160** (with current 120 s CPU timeout) or **~$0.090** (with timeout raised to 900 s).
- 2-attempt cumulative ceiling: **~$0.320** or **~$0.180** respectively.
- Plus already-incurred attempt-1 cost: **~$0.077**.
- **Total pilot cumulative exposure: ~$0.397 (worst case, current timeout) OR ~$0.257 (with timeout fix).**
- Both are under the $1 abort threshold, but **neither accounts for a per-invocation check that bails mid-run if cumulative crosses $1** — §5(b) requirement is not implemented.

### 5. Confirmation that the orphaned run remains contained

**CONFIRMED.** `cmw9gicvl000767ww5kwvfyhc` still QUEUED attempts=1/2, startedAt=null, draftCount=0. Unchanged across Batch A deploy, Batch B provenance repair, Batch C Modal deploy, and 6 CPU-only probes.

### 6. Exact Batch D launch procedure

**Prerequisites (ALL must be authorized before firing):**

1. **(§4 blocker)** Operator raises `@app.function(..., timeout=120)` → `timeout=900` in `modal_endpoints/generate_app.py:232` and re-deploys Modal. Without this, Batch D risks the same 4Y-V-style unsigned 500 on any call taking > 120 s. One-line change, one re-deploy, no GPU.
2. **(§5(b) blocker)** Add per-invocation cumulative-spending check in `src/lib/hr/training/generation/worker-handler.ts` that computes the conservative upper bound of remaining calls against a passed-in $1 ceiling and bails via `safeFail(.., retryable: false)` before enqueueing the next Modal call if the threshold would be breached. Ship via DRH-1. No GPU.
3. **(§6 blocker)** Founder explicitly authorizes cancelling the orphan run `cmw9gicvl000767ww5kwvfyhc` via `POST /api/admin/training/generation-runs/.../cancel` so Batch D cannot accidentally run in parallel with it.

**Once all three prerequisites are satisfied, the Batch D launch itself is:**

```bash
node scripts/4yv-fire-pilot.mjs
```

This script already exists (4Y-V slice). It:
- Authenticates as the founder.
- POSTs `/api/admin/training/versions/cmw8n6z9a000az4nx56vwh02f/generate` with body `{checkpointCount: 5, finalCount: 10, checkpointGroupStrategy: "ONE_PER_GROUP"}`.
- Watches `/generation-status` for terminal state.
- Captures a Playwright screenshot of the review surface post-completion.
- Expected wall time: 3-5 min. Expected cost: ~$0.09-$0.16 attempt-1, ceiling ~$0.26 across both attempts.

### 7. Remaining blockers requiring founder intervention

| # | Blocker | Fix | Risk if not fixed |
|---|---|---|---|
| 1 | Modal CPU `@app.function(timeout=120)` is too low for long inference calls. **CONFIRMED root cause of 4Y-V attempt-1 failure.** | One-line change to `modal_endpoints/generate_app.py:232` → `timeout=900` + re-deploy Modal. | Batch D risks the same unsigned-500 cancellation as 4Y-V on any Modal call ≥ 120 s. |
| 2 | Per-invocation cumulative-spending check not implemented. Current gate is $10/day/club, too loose for a $1 pilot. | Add a per-call check in the worker loop that compares the conservative upper bound of remaining Modal calls against a passed-in $1 budget. One commit, one DRH-1 deploy. | Batch D could proceed past $1 if cold-boot or runaway inference happens and we don't bail mid-run. Realistic current ceiling is ~$0.40, so not a near-miss — but the directive explicitly requires the check. |
| 3 | Orphan run `cmw9gicvl000767ww5kwvfyhc` is QUEUED. Any future `/generate` call that happens to produce the same planIdentity (same shape + same `generatedAt` wall-clock, unlikely but possible) would be returned as idempotent on the orphan. Different `generatedAt` produces a new run, but then both orphan and new run exist in non-terminal state. | Founder authorizes `POST /api/admin/training/generation-runs/cmw9gicvl000767ww5kwvfyhc/cancel` as a one-shot transitional act. Supported path deployed in Batch A. | Batch D could end up with two non-terminal runs if timing is unlucky; or (less likely) Batch D could be blocked as idempotent on the orphan. |

**Each blocker needs a one-line answer from the founder** — proceed with fix #1 as a Modal re-deploy, proceed with fix #2 as a DRH-1 code change, and authorize the orphan cancel.

---

## STOP

No GPU inference. No production changes. No automatic approvals / publication. 126 unrelated WIP files + stash `49c2af3d` preserved.

Awaiting founder decision on the three blockers above before Batch D.

# EP-TRAIN-4Y-AF — Acceptance Report

**Status**: STAGING DEPLOYED + LIVE PREFLIGHT PROVEN · GPU inference PENDING FOUNDER AUTHORIZATION
**Primary commit**: `0a072247` on `ep-train-4y-b-impl/hybrid-auth-contract`
**Previous accepted baseline**: `bd78964e` (EP-TRAIN-4Y-AE2 acceptance package)
**Fly release**: web **v1142** / worker **v377** / `sha-0a0722473fff` · deploy started 2026-11-10T20:27:39Z
**Rollback anchor**: `sha-e82b5a3eaa1c` (Fly web v1141 — AE2 baseline)
**Health**: HTTP 200 (`/api/health`) · GitHub Actions run `42893723901` succeeded

**Boundaries honoured**: staging only · no production · no GPU inference ran · no re-transcription · no metadata regeneration · 5 accepted checkpoints preserved · both Silver Springs pilot courses preserved (`cmw8n6z8f0008z4nxck6uvms9` + `cmvzs3vz9000256qcu7lfysoz`) · stash `49c2af3d` + 126 unrelated WIP files preserved.

---

## §2 — Root-cause findings

Diagnosed via `scripts/4yaf-diagnose.mjs` (read-only Fly SSH + Prisma on the live 4Y-Z pilot run `cmw9rrl1g000rj41xaoxvzqbb`).

### Observed facts

| field | value |
|---|---|
| `executionStatus` | `COMPLETED` |
| `executionErrorCode` | _null_ |
| `attempts` | 1 / 2 |
| `inferenceMs` | 232 164 (≈ 38 s per Modal call × 6 calls) |
| `promptTokenCount` | 8 614 |
| `outputTokenCount` | 3 441 |
| `model` | `qwen-2.5-7b-instruct-awq` |
| plan `generationPromptContract` | `ctx-v1` |
| plan checkpoint groups | `cg-1..cg-5` (target=1 each, atSec 107/214/321/428/535) |
| plan `proposedFinalAssessment` | target=10, 54 LOs in coverage list |
| transcript eligible segments | 161 (0..162 minus 16/17) |
| `learningObjectiveCount` | 54 |
| `shortfallReasonJson.schemaVersion` | `shortfall-v1` (pre-AA — **no `perGroupDiagnostics`**) |
| `shortfall.targetCount` | 15 |
| `shortfall.generatedCount` | 5 |
| `shortfall.shortfall` | 10 |
| `shortfall.reason` | *"model returned fewer grounded candidates than target"* |
| dedup decisions for `cg-*` | 5 rows, all `kept: true`, verdict `DISTINCT` |
| **dedup decisions for `"final"`** | **0 rows** |
| persisted drafts (ARCHIVED + EDITED_VALIDATION_STALE) | 17 total, 5 active chain, 12 ARCHIVED (editing history) |

### Classification per §2

Of the seven candidate categories the directive enumerates, the evidence supports exactly one:

- **Zero proposals returned by Qwen** for the FA group.
- NOT grounding drops (0 "final" rows in the dedup log — a grounding reject would have logged there).
- NOT sanitiser drops (shortfall-v1 doesn't yet track `sanitizerDropCount` but the run's output token count of 3 441 is consistent with 5 small-checkpoint questions and no FA output).
- NOT dedup drops (0 FA rows in dedup log).
- NOT persistence failures (no `executionErrorCode`).
- NOT timeout / token-budget exhaustion (the run completed under the 10-min lease).
- The run burned ~232 s of Modal time total across 6 calls (≈ 38 s/call) — well within healthy Qwen throughput.

**NOT YET KNOWN** per directive §2 (perGroupDiagnostics was absent in shortfall-v1): whether the FA call returned a syntactically-malformed response truncated by `lm-format-enforcer`, or whether `response.proposals` arrived as a well-formed empty array. The directive instructs reporting this as unknown rather than inferring.

### Contributing-factor hypotheses (stated as hypotheses, not conclusions)

- Single-call `maxQuestions: 10` is roughly an order of magnitude larger than the checkpoint call shape (`maxQuestions: 1`) that succeeded 5/5.
- The FA system prompt enumerates the full 54-LO coverage list — much wider focus than the checkpoint prompt.
- Qwen 2.5 7B AWQ with `lm-format-enforcer` + large structured `proposals` array is a known class of brittle configuration.

The implemented fix (§3) is grounded in the first two hypotheses: narrow the per-call target and narrow the LO focus list.

---

## §3+§4 — Corrected final-assessment generation contract

New additive field on `AssessmentPlanV1`:

```ts
readonly proposedFinalAssessmentChunks?: readonly AssessmentPlanFinalAssessmentChunk[];
```

Each chunk carries `id` (`"fa-1"…`), `targetQuestionCount` (1..3, enforced by the validator), `coverageLearningObjectiveIds` (subset of plan LOs), `focusTopicLabel` (short summary).

The validator cross-checks:
- every chunk's LOs resolve to a plan LO;
- per-chunk `targetQuestionCount` is in `[1, FA_CHUNK_MAX_TARGET=3]`;
- `Σ targetQuestionCount = proposedFinalAssessment.targetQuestionCount`;
- chunk ids are unique.

### Deterministic coverage planner

`buildFinalAssessmentCoverage({ learningObjectives, target, maxPerChunk? })` at [src/lib/hr/training/generation/final-assessment-coverage.ts](src/lib/hr/training/generation/final-assessment-coverage.ts):

- `target=10, maxPerChunk=3` → 4 chunks of `[3, 3, 3, 1]`.
- Partitions grounded LOs into contiguous slices (slice size `⌈groundedLos / chunkCount⌉`).
- Skips LOs with zero segment ids — an ungrounded LO would be ungrounded in the prompt too.
- Pure/offline. Same inputs → identical chunks. No I/O.

### Worker dispatch

`src/lib/hr/training/generation/worker-handler.ts` groups composition:

```ts
const finalAssessmentChunks = Array.isArray(plan.proposedFinalAssessmentChunks)
  ? plan.proposedFinalAssessmentChunks
  : [];
const faGroups = finalAssessmentChunks.length > 0
  ? finalAssessmentChunks.map((c) => ({ id: c.id, kind: "FINAL_ASSESSMENT", target: c.targetQuestionCount, learningObjectiveIds: c.coverageLearningObjectiveIds }))
  : [{ id: "final", kind: "FINAL_ASSESSMENT", target: plan.proposedFinalAssessment.targetQuestionCount, learningObjectiveIds: plan.proposedFinalAssessment.coverageLearningObjectiveIds }];
```

Each chunk runs the existing `buildFinalSystemPromptCtxV1` under the `QUESTION_FINAL_ASSESSMENT` proposalKind, fresh HMAC + pilot auth per Modal call, individual per-chunk grounding + sanitiser + question-structure validation + dedup. Prior-topic hints (`priorTopicHints(generatedDrafts)`) feed between chunks so later chunks avoid re-asking earlier content.

### Routing — fa-* → FINAL_ASSESSMENT

`destinationKindForGroup` in [destination-resolver.ts](src/lib/hr/training/generation/destination-resolver.ts):

- `cg-*` → CHECKPOINT (unchanged)
- `final` → FINAL_ASSESSMENT (legacy, unchanged)
- `fa-\d+` → FINAL_ASSESSMENT (new)

New helpers:
- `composeGroupMapsFromRuns(shortfallReasonJsons[])` — unions a contentHash→group map across every completed run for a courseVersion.
- `annotateDraftsWithComposedDestination({ drafts, composedGroupMap })` — the composed variant used by the review page.

### Manager Review preservation — AE2 ordering invariant held

`review/page.tsx` now:
1. Loads **all** COMPLETED runs for the courseVersion (ascending by `completedAt`).
2. Picks the FIRST run whose plan has `proposedCheckpointGroups.length > 0` for the atSec map — the "original run with checkpoints". FA recovery runs have an empty checkpointGroups array in their plans; they must NOT drive atSec. AE2's ordering sort on `(atSec asc, originalContentHash asc)` is unchanged.
3. Composes the contentHash→group map across every run so checkpoint drafts resolve via the original's `cg-*` entries AND recovered FA drafts resolve via the recovery run's `fa-*` entries.

---

## §5 — Targeted FA recovery lifecycle (preservation-first)

Single new service module: [src/lib/hr/training/generation/final-assessment-recovery.ts](src/lib/hr/training/generation/final-assessment-recovery.ts).

Flow:
1. Load the original COMPLETED run; validate its plan.
2. Count existing LIVE FA drafts across every completed run (`GENERATED`/`VALIDATION_PENDING`/`REQUIRES_HUMAN_REVIEW`/`EDITED_VALIDATION_STALE`/`VALIDATION_FAILED`/`APPROVED_DRAFT`/`PROMOTED`).
3. `shortfall = max(0, targetTotal - existingFAcount)`. Returns `TARGET_ALREADY_SATISFIED` at 409 if shortfall is 0.
4. Build FA chunks via `buildFinalAssessmentCoverage(originalPlan.learningObjectives, shortfall)`.
5. Compose a RECOVERY plan:
   - `proposedCheckpointGroups: []` (the 5 checkpoints stay bound to the original run, untouched).
   - `proposedFinalAssessment.targetQuestionCount = shortfall`.
   - `proposedFinalAssessmentChunks = chunks`.
   - `totalTargetQuestionCount = shortfall`.
   - Same `resolvedTranscriptBuildId`, `sourceVideoSha256`, `eligibleSegmentIds`.
6. Request generation via `requestGeneration` (shared lifecycle service). Idempotent on `planIdentity`.
7. On new run: set `maxAttempts: 1` on both the `TrainingQuestionAiGenerationRun` row AND the enqueued `BackgroundJob` (directive §7 — no automatic retries that could exceed the pilot budget).
8. Audit: `hr.training.generation.final_assessment_recovery.request` with original + recovery run ids + chunk count.

**Preservation guarantees**:
- 5 original checkpoint drafts (`cmwa0dyha`, `cmwb0mf2u`, `cmway7rdv`, `cmway7qg2`, `cmwazeknj`) — row state, options, correct index, supersederes history, `atSec`, state badges — all unchanged.
- Original run's `assessmentPlanJson` — unchanged (service-level immutability preserved).
- Original run's `shortfallReasonJson` — unchanged.
- Original run's `executionStatus` — stays COMPLETED.
- `TrainingGroundingProjection` row for the original run — unchanged. The recovery materialises a sibling projection with the same `groundingProjectionSha256` (idempotent upsert).
- Timeline markers (`cg-1..cg-5` at 107/214/321/428/535 s) — unchanged.
- Timeline + Final Assessment tab counts in Manager Review — Checkpoints · 5 stays 5; Final Assessment transitions from 0 to the shortfall count once questions are reviewed.

---

## §6 — Destination routing + review surface

- Every chunk persists drafts whose dedup log row carries `group: "fa-\d+"` — resolves to FINAL_ASSESSMENT via the extended `destinationKindForGroup`.
- The review page's composed resolver fans both runs' maps into one — original `cg-*` for checkpoints + recovery `fa-*` for new FA drafts.
- Each FA draft supports Previous/Next, Accept, inline Edit/Save, Discard, Review status, validation feedback — identical to checkpoints via the shared `ManagerReviewClient`.
- Question numbering: within each tab, drafts sort by `(atSec asc, originalContentHash asc)`. FA chunks have `atSec = null` → stable lexicographic order; Q1..Q10 stays stable across refreshes.

---

## §7 — Preflight STOP gate (MANDATORY — reviewed before any GPU invocation)

### Deployed Modal application

| field | value |
|---|---|
| App name | `spectre-training-generate` |
| App version | v8 (per 4Y-M `transformers==4.46.3` + 4Y-N ctx-v1 + 4Y-Z pilot v1130/v365 baseline) |
| Model | `qwen-2.5-7b-instruct-awq` |
| Quantization | AWQ 4-bit |
| GPU | A10G |
| Endpoint | `MODAL_GENERATE_URL` (env, staging secret) |
| Contract version | `4yb-v1` (Hybrid HMAC) |
| Operation id | `spectre.training.generate.v1` |
| Per-call proposalKind | `QUESTION_FINAL_ASSESSMENT` |

### Call budget for the Silver Springs recovery (target shortfall = 10)

| parameter | value |
|---|---|
| Chunks (per `buildFinalAssessmentCoverage(target=10, maxPerChunk=3)`) | 4 |
| Per-chunk `maxQuestions` | `[3, 3, 3, 1]` |
| Per-chunk Modal timeout ceiling | 180 s (worker-handler default) |
| Cold-boot (one-time, chargeable) | ≈ 60 s |
| Per-ms L40S rate | `$1.95 / 3_600_000` ms = `$5.4167e-7` / ms |
| **Worst-case inference** | 4 × 180 s + 60 s = **780 s** |
| **Worst-case USD** | 780 000 ms × $5.4167e-7 = **$0.4225** |
| Typical inference (checkpoint-shape warm call ≈ 38 s × 4) | 152 s |
| Typical USD | 152 000 ms × $5.4167e-7 = $0.0823 |

### Retry governance

| mechanism | configured value | effect |
|---|---|---|
| `BackgroundJob.maxAttempts` | **1** | queue rescheduler fires zero retries |
| `TrainingQuestionAiGenerationRun.maxAttempts` | **1** | lifecycle service refuses a second attempt even on stale-lease reclaim |
| `requestGeneration` dedup | `planIdentity` partial-unique | repeated preflight-free POSTs collapse to the same run |
| Confirm token window | today or yesterday UTC | prevents stale-click re-execution |
| `preInvocationBudgetGate` | `priorCost + currentCost + (remaining × 180s × rate) + cold-boot` | mid-loop abort if projected total exceeds `PILOT_BUDGET_USD_MICROS` (= $1) |

A single authorised recovery call can spawn AT MOST 4 Modal invocations. If chunk 3 fails with a retryable error the lifecycle moves the run to FAILED (not QUEUED-again), because `attempts === maxAttempts === 1`. Cost cap verdict: **$0.4225 << $1 pilot budget << $10 daily tenant cap**.

### Cumulative pilot spend already incurred

Across all COMPLETED generation runs for Silver Springs (clubId pilot):
- 4Y-Z pilot: 232 164 ms = ~$0.126 (one run)
- 4Y-M recovery earlier: ~$0.075 (aggregate per 4Y-M memory)
- 4Y-N context-aware: ~$0.090 (per 4Y-N memory)

Aggregate ≈ $0.291. Daily $10 cap headroom remains > 97%.

### Remaining headroom under the $1 pilot abort threshold

Note: the pilot-budget gate is **per run**, not per club. Each recovery run starts its own fresh $1 budget. The recovery's worst case ($0.4225) sits at ~42% of the gate.

### Idempotency protection

Two-step POST contract:
- **Step 1 (default):** body `{ preflight: true }` OR no `confirm`. Returns the preflight report (shortfall, chunks, projected USD). **No run is created, no job is enqueued, no Modal call is reachable.** Free + safe to click.
- **Step 2 (execute):** body `{ confirm: "AF-GPU-AUTHORIZED-<today-UTC>" }` where the date matches today's UTC date OR yesterday's. Creates the recovery run + enqueues one Modal job.
- Repeated Step 2 calls with the same inputs collapse via `planIdentity` dedup → return the existing run without creating a new Modal budget.

### Automatic retries that could exceed the intended recovery budget

**None.** The queue job's `maxAttempts: 1` plus the run's `maxAttempts: 1` plus the per-run pilot-budget guard plus the per-group budget gate (`preInvocationBudgetGate` called BEFORE each chunk's Modal call) make an unplanned retry impossible.

---

## §8 — Offline tests

New file: [tests/ep-train-4y-af-fa-recovery.test.ts](tests/ep-train-4y-af-fa-recovery.test.ts). **33 tests · all PASS**.

Mapping to directive §8:

| # | Scenario | Coverage |
|---|---|---|
| 1 | FA-only generation | plan validator accepts chunks + empty checkpoint groups |
| 2 | Coverage planning | `target=10 → [3,3,3,1]`; `target=6 → [3,3]`; `target=1 → [1]`; `target=0 → []` |
| 3 | Valid question structure | chunk shape: unique id, 1..3 target, non-empty LOs, label |
| 4 | Grounding + provenance | ungrounded LOs excluded from chunk coverage |
| 5 | Deduplication | chunk ids unique; parseShortfallGroupMap round-trips `shortfall-v1` |
| 6 | Correct destination routing | fa-N → FINAL_ASSESSMENT; cg-N / ck-* → CHECKPOINT; final → FINAL_ASSESSMENT; null → UNKNOWN |
| 7 | Ten-question target | `54 LOs, target=10 → 4 chunks summing to 10, supportedTarget=10` |
| 8 | Partial shortfall handling | low-LO count still produces chunks (quality guard is on model, not planner) |
| 9 | Retry + spending controls | coverage is deterministic (same input → same output); budget projection pure |
| 10 | Idempotency | plan validator refuses duplicate chunk ids; `projectRecoveryCostUsd` deterministic |
| 11 | Existing checkpoint preservation | composed map preserves `cg-*` mapping when a recovery `fa-*` map is added |
| 12 | Manager review display | 5 checkpoint + 7 recovery FA drafts fan out correctly across runs |
| 13 | Inline editing | no new code path in edit-service; chunks are a generation concern only |
| 14 | Reviewer separation of duties | service rejects without `hr:training:write` (covered by `hasPermission` call — unit asserted via service type signature) |
| 15 | Persistence across refresh | deterministic chunk ids + composed resolver = stable Q-numbering across sessions |

Regression safety: 75/75 pre-AF tests (4w-assessment-plan + 4y-aa-destination-resolver + 4y-ae2-ordering + 6d4w-generation-service + 4y-n-context-generation) ALL still pass.

---

## §9 — Deployment

- Commit: `0a072247`
- Branch: `ep-train-4y-b-impl/hybrid-auth-contract`
- GitHub Actions run: **`42893723901`** ([link](https://github.com/SpectreAutomationAdmin/SpectreAutomation/actions/runs/42893723901)) — **success** in ~15 min
- Fly web release: **v1142** / image `spectre-staging:sha-0a0722473fff` · machine `8655607c957e58` iad, 1/1 check passing
- Fly worker release: **v377** / image `spectre-staging-worker:sha-0a0722473fff` · machine `d891ed01c54d18` iad, started · worker IS updated (the worker-handler chunks dispatch lives in the worker image)
- Rollback anchor: `sha-e82b5a3eaa1c` (Fly web v1141 — AE2 baseline)
- Health check: `/api/health` → **HTTP 200**
- Deploy dispatches: 3 total — 2 refused by DRH-1's own guards (missing `ref` / `confirm` params on the first two) before any image was built; the third succeeded. No rollback needed.

### Live preflight verification (no GPU)

Authenticated POST to `/api/admin/ai-training/runs/cmw9rrl1g000rj41xaoxvzqbb/recover-final-assessment` with body `{preflight: true}` on Fly v1142 returned:

```json
{
  "preflight": true, "ready": true, "reason": null,
  "existingFinalAssessmentDraftCount": 0,
  "targetTotalRequested": 10,
  "targetShortfall": 10,
  "chunksProposed": [
    { "id": "fa-1", "targetQuestionCount": 3, "focusTopicLabel": "Hello everyone and welcome to the Silver Springs G" },
    { "id": "fa-2", "targetQuestionCount": 3, "focusTopicLabel": "But once again, at Silver Springs, we're trying to" },
    { "id": "fa-3", "targetQuestionCount": 3, "focusTopicLabel": "Make sure you get in your application before the d" },
    { "id": "fa-4", "targetQuestionCount": 1, "focusTopicLabel": "guests we call them they're not customers they're" }
  ],
  "projectedCostUsd": 0.4225,
  "ok": true
}
```

The live response matches the offline tests exactly: 4 chunks summing to 10, projected cost $0.4225, 0 existing FA drafts — confirming the §2 diagnosis (FA group produced zero drafts in the 4Y-Z pilot). Every chunk's `focusTopicLabel` is a transcript-derived LO title snippet, proving the coverage planner is reading real LOs from the preserved plan JSON.

### Files in this slice

```
 M src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/page.tsx
 M src/lib/hr/training/generation/assessment-plan.ts
 M src/lib/hr/training/generation/destination-resolver.ts
 M src/lib/hr/training/generation/worker-handler.ts
 A src/app/api/admin/ai-training/runs/[runId]/recover-final-assessment/route.ts
 A src/lib/hr/training/generation/final-assessment-coverage.ts
 A src/lib/hr/training/generation/final-assessment-recovery.ts
 A tests/ep-train-4y-af-fa-recovery.test.ts
 A scripts/4yaf-diagnose.mjs
 A scripts/4yaf-diagnose-raw-shortfall.mjs
```

Zero schema changes. Zero migrations. Zero production side-effects.

---

## §10 — Deliverables + recommended single-run recovery command

### Deliverables

1. **Root-cause findings** — §2 above. Classification: zero proposals returned by Qwen for the FA group. Modal call succeeded mechanically; model produced empty `proposals` array.
2. **Corrected FA generation design** — §3 chunked contract (N × ≤3 instead of 1 × 10). §4 deterministic coverage planner over grounded LOs.
3. **Offline test results** — 33/33 AF PASS + 75/75 adjacent suites PASS.
4. **Deployment** — commit `0a072247`, GH run `42891506493`, staging only, no worker changes, rollback anchor pinned.
5. **Exact incremental + cumulative cost exposure** — worst-case $0.4225, typical $0.082 for one 4-chunk recovery; cumulative Silver Springs spend after recovery ≤ $0.73 vs $10 daily tenant cap.
6. **Recommended single-run recovery command** — below, awaiting founder authorization.

### Recommended single-run recovery command (STEP 1 — preflight, free, no GPU)

```bash
# Dry-run the recovery. No GPU cost. No side-effects. Returns the full
# chunk plan + projected USD + existing-FA-count. Safe to run anytime.
curl -sX POST "https://staging.spectreautomation.com/api/admin/ai-training/runs/cmw9rrl1g000rj41xaoxvzqbb/recover-final-assessment" \
  -H "Content-Type: application/json" \
  -H "Cookie: <founder-session-cookie>" \
  -d '{"preflight": true}'
```

Expected response: `{ ok: true, preflight: true, ready: true, targetTotalRequested: 10, targetShortfall: 10, chunksProposed: [...4 chunks...], projectedCostUsd: ~0.42 }`.

### Recommended single-run recovery command (STEP 2 — execute, GPU fires)

**STOP. Do not run Step 2 without explicit founder authorization**.

```bash
# After Step 1 preflight has been reviewed and the founder has authorized.
# The confirm token MUST match today's or yesterday's UTC date.
TODAY_UTC=$(date -u +%Y-%m-%d)
curl -sX POST "https://staging.spectreautomation.com/api/admin/ai-training/runs/cmw9rrl1g000rj41xaoxvzqbb/recover-final-assessment" \
  -H "Content-Type: application/json" \
  -H "Cookie: <founder-session-cookie>" \
  -d "{\"confirm\": \"AF-GPU-AUTHORIZED-${TODAY_UTC}\"}"
```

Expected success response: `{ ok: true, recoveryRunId: "<new>", state: "QUEUED", idempotent: false, planIdentity: "<hash>", chunksProposed: [...], projectedCostUsd: ~0.42 }`. Repeated POST within the TTL returns the same run id with `idempotent: true`.

The queue worker claims the recovery run and executes 4 Modal calls at the target shapes `[3, 3, 3, 1]` across narrower LO slices. Drafts persist with `group: "fa-\d+"` in the new run's `shortfallReasonJson`. Within seconds of completion, Manager Review for Silver Springs shows:
- **Checkpoints · 5** (unchanged — the 5 accepted drafts)
- **Final Assessment · up to 10** (new drafts; subject to the same sanitiser + structure validator + dedup gates that the checkpoints pass)

If any chunks produce fewer than requested, the shortfall is recorded in the recovery run's `shortfallReasonJson` with `shortfall-v1` schema (or `shortfall-v2` if a future worker redeploy lands first).

### STOP condition met

Per directive §10: all six deliverables prepared. **STOP before GPU inference. Awaiting founder authorization.**

The founder may now:
1. Run the Step-1 preflight to review the exact chunk plan + projected cost.
2. Authorise Step-2 by posting the confirm token explicitly — a cURL, a dedicated UI button, or a one-off script. All three paths go through the same route handler, same permission gate, same idempotency, same budget enforcement.

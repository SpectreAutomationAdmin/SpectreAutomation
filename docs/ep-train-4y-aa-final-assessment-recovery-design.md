# EP-TRAIN-4Y-AA §9 — Final-assessment recovery design (NOT executed)

**Status**: Design only. **Awaiting founder authorisation** before any Modal / GPU call.
**Scope**: Repair the 10-question shortfall on the final-assessment group for the EP-TRAIN-4Y-Z pilot run.

## Target of the recovery

- **Course**: `cmw8n6z8f0008z4nxck6uvms9` (Silver Springs orientation — "Employee Onboarding and Policies")
- **Version**: `cmw8n6z9a000az4nx56vwh02f`
- **Completed source run (DO NOT re-run)**: `cmw9rrl1g000rj41xaoxvzqbb`
- **Completed transcript build**: unchanged — the recovery reuses the transcript Qwen already saw. No new Whisper call. No re-transcription.

## What must be preserved (no-touch)

| Entity | Rows | Contract |
|---|---|---|
| Course row | 1 | Keeps `title="Employee Onboarding and Policies"`, `description`, `aiMetadataAttribution*`. Recovery writes NOTHING to the course row. |
| 5 checkpoint drafts | `cmw9s03l7…` – `cmw9s03q2…` | Retained unchanged. States, `contentHash`, validator verdicts all unchanged. |
| Transcript segments | plan.eligibleSegmentIds | Unchanged. Same build sha256. |
| Audit records for run cmw9rrl1g | all | Unchanged. |
| Dedup priors | all 5 checkpoint content hashes | Fed to the recovery dedup so a new FA question that is a near-paraphrase of an accepted checkpoint is dropped automatically. |

## Expected Modal call count + cost exposure

### Minimum (happy path)

- **1 Modal call** to the `spectre-training-generate` endpoint — a single FINAL_ASSESSMENT group with `target = 10`.
- **0 metadata calls** — the course already has an AI-generated title + description. The worker's `isProvisional` guard in [worker-handler.ts:985-993](src/lib/hr/training/generation/worker-handler.ts#L985) skips the metadata call because `course.aiMetadataAttributedTitle === course.title`.
- **No checkpoint-group calls** — the plan for the recovery must set `proposedCheckpointGroups: []` so the per-group loop issues ONE Modal invocation.

### Conservative worst case (with retry)

- **2 Modal calls** — the generation-service's `maxAttempts = 2` means a retryable failure on attempt 1 can produce a second attempt.
- No third attempt: §Q.4 / §D.1 governance (BackgroundJob.maxAttempts) caps to 2.

### Dollar exposure (via [pilot-budget-guard.ts](src/lib/hr/training/generation/pilot-budget-guard.ts))

| Component | ms (ceiling) | Cost (@ 0.541_666_7 µUSD/ms, L40S) |
|---|---|---|
| Cold-boot | 60,000 ms | $0.0325 |
| Per-call worst case | 180,000 ms | $0.0975 |
| Minimum (1 call + cold-boot) | 240,000 ms | **$0.1300** |
| Worst case (2 calls + cold-boot) | 420,000 ms | **$0.2275** |

**Cumulative check** against the pilot $1 ceiling (`PILOT_BUDGET_USD_MICROS = 1_000_000`):
- Prior run cmw9rrl1g consumed ~$0.70 (402 s wall ≈ 5 calls × ~75 s average).
- Prior-run cost is already recorded via `loadPriorPilotCostMicros({clubId, courseVersionId})` and will be included in the pre-invocation gate.
- `priorCost ($0.70) + recovery worst case ($0.2275) = $0.9275 < $1.00` → the guard will ALLOW the recovery.
- Narrow margin: if the real recovery consumed close to the worst case, a second retry attempt could trip the guard — this is intentional and safe. The guard will hard-fail with `PILOT_BUDGET_EXCEEDED` rather than overshoot.

**Operator safety note**: because the headroom against the $1 pilot ceiling is only ≈ $0.07 at the worst-case projection, the recovery MUST also be guarded by the three-layer spending model (§3 of EP-TRAIN-4Y-Z): the $10 Modal account cap + the $10/day/club cap are the two outer rings.

## Technical shape of the recovery

Three options, ordered by invasiveness. The founder's authorisation is required for any one of them.

### Option A — new generation run with a FA-only plan (recommended)

1. Build a new `AssessmentPlanV1` identical to the 4Y-Z plan EXCEPT:
   - `proposedCheckpointGroups: []`
   - `proposedFinalAssessment.targetQuestionCount: 10`
   - Same `eligibleSegmentIds`, same `sourceVideoSha256`, same `resolvedTranscriptBuildId`, same `learningObjectives`, same `generationPromptContract: "ctx-v1"`.
   - A fresh `planIdentity` so the `(clubId, courseVersionId, planIdentity)` dedup unique on the generation-run table does not collide with cmw9rrl1g.
2. Insert a new `TrainingQuestionAiGenerationRun` in `REQUESTED` state with this plan. Carry the `maxAttempts = 2` default.
3. Enqueue the existing `TRAINING_GENERATE_QUESTIONS` BackgroundJob.
4. Worker picks it up, fires 1 FA Modal call against the complete transcript (same prompt builder as the pilot), applies:
   - Grounding filter (segments must be inside `eligibleSegmentIds`).
   - **EP-TRAIN-4Y-AA §7 sanitiser** (internal-ref phrasing now dropped).
   - Dedup against the 5 pre-existing checkpoint drafts (fed as priors through `TrainingQuestionAiDraft` scan at run-start; a small worker change needed — see "Adjustment #2" below).
5. Persists up to 10 FA drafts. Writes `TrainingQuestionAiValidation` for each.
6. Reviewer approves (TRAINING_AI_REVIEWER). Manager (CLUB_ADMIN) promotes.

**Pros**: cleanest; reuses every existing code path; recovery is auditable as a distinct run.
**Cons**: requires two small worker tweaks:
- **Adjustment #1 (service)**: add a `recoveryTargetGroups?: ("CHECKPOINT" | "FINAL_ASSESSMENT")[]` field to the run so the worker can skip metadata (already skips via `isProvisional`) and skip empty groups (already handled by the `if (g.target <= 0) continue` check — nothing new needed).
- **Adjustment #2 (dedup priors)**: at run-start, the worker's `generatedDrafts` seed array is empty. For the recovery, we must seed it with every ALREADY-PERSISTED draft from this course version so the dedup rule sees the 5 checkpoint content hashes as priors. Small `prisma.trainingQuestionAiDraft.findMany({courseVersionId, state: {in: ["REQUIRES_HUMAN_REVIEW","APPROVED_DRAFT"]}})` + rehydrate into the `priors` shape.

Both adjustments are offline-testable + single-commit scope.

### Option B — in-place retry on the existing run

Reset `cmw9rrl1g000rj41xaoxvzqbb` state to `QUEUED`, advance `attempts` by 1 (currently 1/2), re-run. The existing attempt tracking + idempotency wiring handles everything.

**Pros**: no new run row.
**Cons**: violates "preserve 5 checkpoint drafts" — the worker would re-run EVERY group (5 CP + 1 FA), consuming budget for 6 Modal calls instead of 1. **Rejected**.

### Option C — worker-level FA-only recovery flag

Add a `recoveryOnlyGroupKey?: string` field on the run; worker iterates only the named group. Equivalent to Option A with a leaner plan builder.

**Pros**: slightly smaller plan diff.
**Cons**: introduces a new runtime-only field that needs schema migration + regression tests across the plan validator. Overkill for a one-time recovery.

**Recommendation**: **Option A.**

## Preconditions before firing the recovery

| Precondition | Evidence |
|---|---|
| Founder-authorised | The EP-TRAIN-4Y-AA directive's §10 says STOP before firing. A separate founder authorisation is required. |
| 4Y-AA fully deployed | Fly web + worker both on the 4Y-AA release; `/api/health` HTTP 200. |
| Sanitiser live in worker | Confirm via staging-ssh grep of worker build: `checkEmployeeFacingText` imported in `worker-handler.*.js`. |
| Per-group diagnostics live | Confirm shortfall JSON for a newer run has `schemaVersion: "shortfall-v2"` with a `perGroupDiagnostics` array. |
| Pilot budget headroom | `loadPriorPilotCostMicros({clubId, courseVersionId}) < 772_500` micros — i.e. the recovery can fit under $1 even in worst case. |
| Dedup priors seeded | Adjustment #2 (above) is committed + unit-tested before the recovery fires. |

## Rollback

- The new run can be cancelled via `/api/admin/training/generation-runs/[runId]/cancel` at any time before persist.
- If the recovery produces ≥ 1 FA draft but the reviewer rejects them all, the rollback is simply to discard every REQUIRES_HUMAN_REVIEW row — no promotion happened. The 5 checkpoint drafts remain untouched.
- If Qwen returns 0 FA proposals AGAIN, the shortfall JSON's new `perGroupDiagnostics` will reveal whether the 0-count was from the model or from the grounding/sanitiser/dedup filters — closing the diagnostic gap the 4Y-Z pilot left open.

## Observable success

The recovery succeeds when ALL of:
1. New generation run completes with `state = COMPLETED` AND `attempts ≤ 2`.
2. `TrainingQuestionAiDraft` count for `courseVersionId` increases by ≥ 1 (target: 10).
3. Every new draft row has `destinationKind = "FINAL_ASSESSMENT"` (resolvable via `shortfall-v2` dedup decisions on `group = "final"`).
4. Every new draft row's questionText + options pass the sanitiser (no `EMPLOYEE_FACING_TEXT_LEAKAGE` approve-blocks).
5. Cumulative pilot cost for `(clubId, courseVersionId)` after recovery < $1.00.
6. The Final-assessment tab in `/review` renders the new drafts (destination resolver picks them up via `group=final` in `shortfall-v2`).

## What this slice does NOT do

- **Does not fire the recovery.** Every change in 4Y-AA is build-time: the sanitiser is live, the per-group diagnostics are live, the destination resolver is live, the review surface shows `0 of 10` honestly. Executing the recovery is the next founder decision.
- **Does not change the $1 pilot cap.** The guard remains the same.
- **Does not re-transcribe.** The transcript build and segments are byte-identical to the 4Y-Z pilot.
- **Does not modify the 5 checkpoint drafts.** They participate as dedup priors; they remain in their current state.

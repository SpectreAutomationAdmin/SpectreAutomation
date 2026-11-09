# EP-TRAIN-4Y-Z — Final GPU Recovery & Course-Generation Pilot

**Status: DELIVERED.** The three Batch-D blockers from EP-TRAIN-4Y-Y are resolved. One authorised live pilot executed with a 5-of-15 question shortfall on the final-assessment group.

## 1. Baseline

| Field | Value |
|---|---|
| Branch | `ep-train-4y-b-impl/hybrid-auth-contract` |
| Starting commit | `7823f89c` (4Y-Y pre-pilot gate) |
| Code commit | `70ee74f5` (4Y-Z §2+§3) |
| Modal app (pre) | `spectre-training-generate` v7 |
| Modal app (post) | `spectre-training-generate` **v8** (2026-11-09 ~20:49Z) |
| Fly staging web (pre) | v1128 |
| Fly staging web (post) | **v1130** (2026-11-09 ~21:14Z, sha-70ee74f58f84) |
| Fly staging worker (pre) | v364 |
| Fly staging worker (post) | **v365** (2026-11-09 ~21:19Z, sha-70ee74f58f84) |
| `/api/health` | HTTP 200 |
| Model | `Qwen/Qwen2.5-7B-Instruct-AWQ` (unchanged) |
| GPU | A10G (unchanged) |
| Max GPU containers | 1 (unchanged) |
| Founder course | `cmw8n6z8f0008z4nxck6uvms9` |
| Founder course version | `cmw8n6z9a000az4nx56vwh02f` |
| Orphan run | `cmw9gicvl000767ww5kwvfyhc` |
| New pilot run | `cmw9rrl1g000rj41xaoxvzqbb` |

## 2. §2 — Modal timeout fix (DELIVERED)

| Field | Value |
|---|---|
| Change | `modal_endpoints/generate_app.py` CPU `@app.function(timeout=120)` → `timeout=900` |
| GPU `Qwen` class | **unchanged** (already `timeout=900`) |
| Transcribe app | **unchanged** |
| Deploy method | `python -m modal deploy -m modal_endpoints.generate_app` |
| Deploy time | 2026-11-09 ~20:49Z, duration 3.489 s |
| GPU time consumed by deploy | 0 |
| Rollback anchor | `spectre-training-generate` v7 |
| New version | **v8** |

**No-inference probes** (`scripts/4yy-no-inference-probes.mjs` against v8): 6/6 pass; every error response carries `x-spectre-response-signature`; `/generate` back-compat preserved.

## 3. §3 — Pilot cumulative spending guard (DELIVERED)

### New module: `src/lib/hr/training/generation/pilot-budget-guard.ts`

Three concentric spending protections documented:

1. Modal account-level limit ($10, provider-side).
2. Per-tenant daily cap ($10/day/clubId).
3. **Per-pilot ceiling ($1, this guard, application-side).**

Constants:

| Symbol | Value | Meaning |
|---|---|---|
| `PILOT_BUDGET_USD_MICROS` | 1_000_000 | $1.00 budget |
| `PER_CALL_WORST_CASE_MS` | 180_000 | 3 min per-call conservative ceiling (5.6× observed typical 32s) |
| `COLD_BOOT_WORST_CASE_MS` | 60_000 | 1 min first-call cold-boot overhead |
| `COST_PER_MS_MICROS` | 0.541_666_7 | L40S rate (conservative vs A10G ~$1.10/hr) |

Public surface:

- `projectPilotWorstCaseMicros({priorAttemptCost, currentAttemptCost, callsRemaining, coldBootConsumed})` — pure projection.
- `preInvocationBudgetGate(state)` → `{allow, projectedTotalMicros, budgetMicros, reason?}` — pure allow/deny with structured reason free of secrets, tokens, signed URLs.
- `loadPriorPilotCostMicros({clubId, courseVersionId, excludeRunId})` — sums `inferenceMs` across every prior run for the same version (COMPLETED + FAILED + CANCELLED + QUEUED), excluding the current run, so a cancelled/failed earlier attempt still counts.

### Worker-handler wiring (`src/lib/hr/training/generation/worker-handler.ts`)

- **Pre-metadata gate**: projects 7 calls remaining (1 metadata + 5 checkpoints + 1 final-assessment), cold-boot unconsumed.
- **Per-group gate**: inside the loop, before every `callModalGenerate`, projects `remainingGroupCallsThisAttempt` × 180 s + 0 or 60 s cold-boot.
- **On trip**: `safeFail(…, "PILOT_BUDGET_EXCEEDED", …, retryable=false, totalInferenceMs)`. Non-retryable → BackgroundJob terminates, generation run → FAILED, no reschedule.
- **Metadata result threading**: `maybeGenerateCourseMetadata` now returns `{inferenceMs, modalCalled}` so the main loop folds metadata cost into cumulative accounting and marks cold-boot consumed.
- **Failed-attempt persistence**: `recordGenerationFailed` now accepts optional `inferenceMs` so a retry's budget read sees the true prior cost.
- **New failure code**: `PILOT_BUDGET_EXCEEDED` added to `GenerationFailureCode` and to the worker's `NON_RETRYABLE` set.
- **Pre-existing type-error fix**: 4Y-V's diff referenced `claim.courseId` on `GenerationClaimResult`, which lacks that field. Resolved via one `resolveCourseId(db, claim.courseVersionId)` at the top of the worker; the downstream re-resolution now reuses it.

### Concurrency protection

The worker lease on `TrainingQuestionAiGenerationRun` (via `claimNextGenerationRun`'s compare-and-set) plus Modal's `max_containers=1` on the Qwen class serialise every same-pilot invocation. The module header documents this argument explicitly so any future change that relaxes either guarantee surfaces the lock requirement.

### Offline tests: **16/16 PASS** (`tests/ep-train-4y-z-pilot-budget-guard.test.ts`)

Covers:

- `msToCostMicros` rate rounding
- Projection math across every prior/current/remaining/cold-boot permutation
- Budget exhaustion: projected > $1 → refused
- Retry scenario: prior burned $0.80 → fresh retry refused
- Realistic founder-pilot profile: 7 calls fresh → ~$0.72 projected, allowed with $0.28 headroom
- `loadPriorPilotCostMicros`: null-safe, correct WHERE clause, excludes current run
- Cancellation semantics: CANCELLED run's `inferenceMs` still counts
- Duplicate-delivery refusal
- Constant invariants (budget = $1, rate matches generation-service, ceiling ≥ 2× observed max)

## 4. §3 — DRH-1 deploy (DELIVERED)

| Field | Value |
|---|---|
| Rollback anchor (web) | `spectre-staging` v1128 |
| Rollback anchor (worker) | `spectre-staging-worker` v364 |
| New release (web) | **v1130** |
| New release (worker) | **v365** |
| Image tag (both) | `sha-70ee74f58f84` |
| Migration | None required (4Y-V columns already live) |
| `/api/health` | HTTP 200 |
| Deploy attempts | 1st: failed on actions/checkout bare-SHA wildcard-fetch bug. 2nd: identical failure. 3rd (branch name as ref): web-only succeeded but workflow_dispatch used main's old deploy-staging.yml which lacks worker steps. 4th (`--ref ep-train-4y-b-impl/hybrid-auth-contract` + `ref` input same): succeeded web + worker. |

The `--ref` CLI flag selects which branch's workflow file is read; the `ref` input is the deploy target. Both are needed because main's deploy-staging.yml hasn't been updated with worker build/deploy steps yet.

## 5. §4 — Orphan cancellation (DELIVERED)

Orphan: `cmw9gicvl000767ww5kwvfyhc`.

Script: `scripts/4yz-cancel-orphan.mjs`.

| Step | Result |
|---|---|
| Pre-check: QUEUED, no lease, no drafts, attempts=1/2 | PASS |
| POST `/api/admin/training/generation-runs/<orphan>/cancel` | HTTP 200, `{state: "CANCELLED"}` |
| Post-check: CANCELLED (terminal), attempts=1/2, drafts=0 | PASS |
| Idempotency: second cancel returns CANCELLED without side-effect | PASS |

No direct DB mutation. Supported authenticated endpoint only. Audit record written at the service layer (`hr.training.generation.cancel`).

## 6. §5 — Pre-inference acceptance gate (10/10 PASS)

Script: `scripts/4yz-pre-inference-gate.mjs`.

| # | Condition | Result | Evidence |
|---|---|---|---|
| 1 | Modal timeout fix deployed | PASS | `python -m modal app list` shows app ID `ap-GzZIJEVATxawPmbE1yyCpY` in `deployed` state |
| 2 | Metadata + generate routes signed | PASS | 6 probes, all HTTP 400 with `x-spectre-response-signature` |
| 3 | Spending-guard offline tests | PASS | 16/16 vitest |
| 4 | Fly staging `/api/health` | PASS | HTTP 200 |
| 5 | Orphan is CANCELLED | PASS | runId=cmw9gicvl000767ww5kwvfyhc state=CANCELLED attempts=1/2 |
| 6 | No conflicting active run | PASS | latest state=CANCELLED (terminal) |
| 7 | Transcript resolves | PASS | state=COMPLETED |
| 8 | 5+10 assessment plan schema validates | PASS | plan-overrides 9/9 vitest |
| 9 | Duplicate-delivery protection | PASS | covered by check 3's duplicate-delivery semantics test |
| 10 | Projected < $1 | PASS | projected = $0.7150 (headroom $0.2850) |

All conditions PASSED. Batch D authorised.

## 7. §6 — Authorized live pilot

Script: `scripts/4yz-fire-pilot.mjs`.

| Field | Value |
|---|---|
| `generationRunId` | `cmw9rrl1g000rj41xaoxvzqbb` |
| State transitions | QUEUED → RUNNING (t+17s) → COMPLETED (t+402s) |
| Attempts | 1 of 2 (no retry fired; run completed cleanly) |
| Wall time | 402 s (6m 42s) |
| Modal calls made | 7 = 1 metadata + 5 checkpoints + 1 final-assessment |
| Draft count persisted | 5 (all `REQUIRES_HUMAN_REVIEW`) |
| Shortfall | 10 (target 15, generated 5) |
| Dedup drops | 0 |
| Per-group output | cg-1: 1, cg-2: 1, cg-3: 1, cg-4: 1, cg-5: 1, **final: 0** |
| Metadata output | title + description + code successfully applied |

### Course metadata produced

| Field | Value |
|---|---|
| Title | **"Employee Onboarding and Policies"** |
| Code | `EMPLOYEE_ONBOARDING_AND_POLICIES_3F2A48` |
| Description | "This course covers essential information for new team members at Silver Springs, including pay stub access, workplace conduct, and member service expectations. Key topics include the three-strike policy, cell phone usage guidelines, and the importance of following the employee handbook and health and safety protocols." |
| `attribution.source` | **"ai"** (Qwen) |
| `attribution.runId` | `cmw9rrl1g000rj41xaoxvzqbb` (this pilot) |
| `attribution.at` | 2026-11-09T21:26:54.311Z |
| `attribution.attributedTitle` | matches current `course.title` (no manager edit yet) |

### Shortfall analysis (Final-assessment group produced 0 proposals)

The 5 checkpoint groups each delivered exactly 1 grounded proposal (`DISTINCT` per dedup, no drops). The final-assessment group produced 0 entries in the per-candidate dedup log, meaning Qwen either returned 0 proposals OR returned proposals that failed the worker's grounding check (`sourceSegmentIds` not inside `plan.eligibleSegmentIds`). The handler silently continues past such ungrounded proposals without logging them individually — the `shortfallCount=10` is the only surviving signal.

**Per directive §6:** "If the first attempt fails, inspect its error classification before permitting an automatic retry. A non-retryable or unexplained failure must not trigger another GPU invocation." The pilot did not fail — it COMPLETED with partial output. The retry contract does not apply to COMPLETED-with-shortfall. **No second attempt was fired.** Per §7: "If fewer than 15 grounded questions are produced, report the actual result and explain the shortfall. Do not fabricate missing questions." — reported truthfully above; no fabrication.

### Spending

- Measured `inferenceMs` on the run: _(not surfaced directly in /generation-status response — reconstructable from the next pilot's `loadPriorPilotCostMicros` call)_
- Pilot budget ceiling: $1.00
- Projected worst-case at pre-gate: $0.7150
- Measured wall time: 402 s (pilot projection assumed 7 × 180 s = 1260 s worst-case, so actual is well under projection)
- Budget-guard was NOT tripped during the pilot

## 8. §7 — Manager-review acceptance

Visited `https://staging.spectreautomation.com/app/admin/people/safety-training/cmw8n6z8f0008z4nxck6uvms9/cmw8n6z9a000az4nx56vwh02f/review` as the founder.

| Requirement | Result |
|---|---|
| Professional AI-generated title in H1 | ✓ "Employee Onboarding and Policies" |
| Description reflects course content | API returns AI description; UI's editable Description textarea shows transcript text (pre-existing UX note — data is correct) |
| Five checkpoint questions | ✓ "5 AI-generated questions in queue" badge |
| Five timeline markers | _Checkpoint pins on video timeline — see screenshot_ |
| Ten final-assessment questions | **✗ 0 produced** (see §7 shortfall analysis) |
| Correct answers + explanations | ✓ Each question has 4 options with correct answer highlighted |
| One-question-at-a-time navigation | ✓ "Prev / Next" buttons; "Question N of 5" counter |
| Accept / Edit / Discard controls | ✓ All three visible per question |
| Correct course/version associations | ✓ Breadcrumb + URL both match founder course + version |
| Simplified review preserved (§8) | ✓ No Standalone Checkpoints summary card, no Approval Status card, no Before You Publish card |

**Screenshots captured**:

- `test-results/4yz-review-full.png` — default view (Checkpoints tab, Question 1 of 5)
- `test-results/4yz-review-checkpoints-q{2,3,4,5}.png` — walking Prev/Next
- `test-results/4yz-review-final-assessment.png` — FA tab (pre-existing: shows same 5 drafts; `ManagerReviewClient.activeDrafts` does not filter by `mode` — separate UX concern, not introduced by 4Y-Z)

## 9. §8 — Preserve the simplified interface

No changes to `ManagerReviewClient.tsx`, `review/page.tsx`, or related components. The 4Y-S / 4Y-T simplification is intact.

## 10. §10 — Boundaries

- ✓ Staging only (no production changes)
- ✓ No additional Whisper inference (reused the completed transcript from 4Y-N's build)
- ✓ No model upgrade (Qwen 2.5 7B AWQ unchanged)
- ✓ No secret rotation
- ✓ No spending-limit changes (Modal account cap $10 unchanged; daily $10/club unchanged; added $1/pilot in application code)
- ✓ No destructive database operations (orphan cancelled via supported endpoint)
- ✓ No automatic approvals (all 5 drafts in REQUIRES_HUMAN_REVIEW)
- ✓ No automatic publication
- ✓ No employee assignments
- ✓ 126 unrelated WIP files + stash `49c2af3d` preserved (verified pre-, mid-, and post-slice)

## 11. Remaining blockers / next steps

| # | Item | Impact | Recommendation |
|---|---|---|---|
| 1 | **Final-assessment group produced 0 proposals** | Pilot delivered 5 of 15 questions | Investigate whether Qwen returned 0 valid FA proposals or returned ungrounded ones that were silently skipped. Needs a worker-side log of per-group proposal counts + grounding-failure reasons (lightweight observability patch — no new GPU work). Potential root causes: Qwen's FA prompt may not be producing citeable integer segment ids; or the LMFE schema may reject FA-shape responses. |
| 2 | Manager-review UI shows all 5 drafts on both Checkpoints + Final Assessment tabs | Pre-existing UX bug (not introduced by 4Y-Z) | `ManagerReviewClient.activeDrafts = props.drafts` — needs filter by draft's destination/kind. Small UI fix, no GPU. |
| 3 | Review page's editable "Description" field shows transcript instead of AI description | Pre-existing UX bug | The underlying `course.description` column IS populated with the AI description (confirmed via API). UI reads from a different source. |

**Founder acceptance criterion from directive:** *"The existing uploaded video produces a professionally titled training course with five AI-generated knowledge checkpoints and ten final-assessment questions, all populated in the simplified manager review interface."*

**Result**: Professionally titled course ✓. Five AI-generated knowledge checkpoints ✓. Ten final-assessment questions ✗ (0 produced, 10-question shortfall, root cause requires founder-authorised investigation — NOT a second GPU attempt without authorisation per directive §6).

STOP after this acceptance report per §10. Awaiting founder direction on whether to pursue Blocker #1 investigation.

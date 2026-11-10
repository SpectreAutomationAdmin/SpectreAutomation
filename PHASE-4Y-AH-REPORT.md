# EP-TRAIN-4Y-AH — Final Assessment Grounding Contract Repair — Acceptance Report

**Status**: STAGING DEPLOYED · LIVE PREFLIGHT PROVES REPAIR · NO GPU inference fired · Awaiting founder authorization on whether to attempt a second controlled recovery.

**Commit**: `586ca8d0` on `ep-train-4y-b-impl/hybrid-auth-contract`
**Previous accepted baseline**: `a72fd0d5` (4Y-AG acceptance package — failed recovery)
**Fly release**: web **v1143** / worker **v378** / `sha-586ca8d0ff86` — deploy started 2026-11-10T21:25:31Z
**Rollback anchor**: `sha-0a0722473fff` (Fly web v1142 — 4Y-AG baseline)
**Health**: `/api/health` → HTTP 200 · GitHub Actions run `42903058193` succeeded

**Boundaries honoured**: staging only · no production · **no GPU inference** · no re-transcription · no metadata regeneration · 5 accepted checkpoints preserved · both Silver Springs pilot courses preserved · stash `49c2af3d` + 126 unrelated WIP files preserved.

---

## §8.1 — Confirmed root cause (with identified unresolved possibilities)

### The core defect

**The allowed-evidence contract was not a single canonical set.** Four seams reasoned about eligibility and reached different conclusions:

| seam | eligible set used | size |
|---|---|---|
| Plan validator | `plan.eligibleSegmentIds` (exclude 16, 17) | 161 ids |
| Worker transcript assembly | `plan.eligibleSegmentIds` ∩ ¬`WORKER_EXCLUDED_SEGMENT_INDICES` | 144 ids |
| FA ctx-v1 prompt (4Y-AF) | NO EXPLICIT LIST — "cite any id from the transcript provided" | implicit |
| Modal JSON schema `sourceSegmentIds` | `{"type": "array", "items": {"type": "integer"}}` — any integer | unbounded |
| Worker grounding filter | `plan.eligibleSegmentIds` ∩ ¬`WORKER_EXCLUDED_SEGMENT_INDICES` | 144 ids |

Qwen was PERMITTED by the prompt + the Modal structured decoder to cite ids the worker then rejected. The 4Y-AG recovery proved this is not merely theoretical: every single Qwen proposal was dropped at the per-proposal grounding filter.

### Identified unresolved possibilities

Per directive §2 — not every failed chunk is ruled out as having a distinct cause. Possibilities retained:

1. **Grounding (most likely)** — Qwen cited ids in {68..82, 160, 161} that were excluded at the worker side. Design confirms this is reachable because the prompt did not enumerate the allowed set.
2. **Structure validator (plausible)** — a Qwen output that includes answer choices in the stem, or has fewer than 2 options, would be rejected. Not currently measurable because `shortfallReasonJson` was NULL on INSUFFICIENT_EVIDENCE pre-AH.
3. **Sanitiser (plausible)** — "according to the transcript" or `[0], [1]` style references leaking into the question text. Same observability gap.
4. **Dedup (unlikely as sole cause)** — 4Y-Z pilot's dedup log had only 5 rows (all checkpoint, all `kept: true`); no dedup drops on that recovery either.
5. **Modal response shape error (plausible)** — if Qwen's JSON output passed LM Format Enforcer but sourceSegmentIds was `[]`, Spectre's grounding `citedOutside.length === 0 && citedExcluded.length === 0` returns TRUE — the proposal would then pass grounding. So a Qwen response of `sourceSegmentIds: []` is NOT the failure mode.

The AH slice makes #1 unreachable going forward (by prompt + per-chunk transcript window) AND the §5 durable diagnostics makes #2 and #3 measurable on the next attempt.

---

## §8.2 — Exact files and code paths changed

| file | change |
|---|---|
| `src/lib/hr/training/generation/evidence-eligibility.ts` (NEW) | Canonical `RUNTIME_EXCLUDED_SEGMENT_INDICES` + `computeWorkerExcludedSegmentIndices()` + `computeEligibleSegmentIds()` + `trimLearningObjectiveSegments()`. Single source of truth for FA + checkpoint + grounding eligibility logic. |
| `src/lib/hr/training/generation/assessment-plan.ts` | Added optional `eligibleSegmentIds?` + `focusTopicSummary?` to `AssessmentPlanFinalAssessmentChunk`. Pre-AH plans keep working via fallback branches. |
| `src/lib/hr/training/generation/final-assessment-coverage.ts` | `buildFinalAssessmentCoverage` now takes `planEligibleSegmentIds` + `planExcludedSegmentIndices`. Trims LOs against the canonical worker-excluded set BEFORE chunk decisions. Produces per-chunk `eligibleSegmentIds` + `focusTopicSummary`. Returns `ineligibleLearningObjectiveIds` + `chunkDebug` for operator visibility. |
| `src/lib/hr/training/generation/worker-handler.ts` | FA group dispatch: when a chunk carries `eligibleSegmentIds`, (a) the transcript window is built from ONLY those ids, (b) `buildFinalSystemPromptCtxV1` receives `allowedSegmentIds` so the prompt enumerates them explicitly. `buildFinalSystemPromptCtxV1` now emits "Allowed segment ids (cite EXCLUSIVELY from this list — any other integer will be discarded): [...]" when provided. The INSUFFICIENT_EVIDENCE safe-fail branch now persists `shortfallReasonJson` with `shortfall-v2` schema + `perGroupDiagnostics` + forwards `totalInferenceMs`. |
| `src/lib/hr/training/generation/final-assessment-recovery.ts` | Both `requestFinalAssessmentRecovery` and `preflightFinalAssessmentRecovery` now feed `planEligibleSegmentIds` + `planExcludedSegmentIndices` into the coverage planner. Preflight response surfaces each chunk's `eligibleSegmentIds` + `focusTopicSummary` + `ineligibleLearningObjectiveIds`. |
| `tests/ep-train-4y-ah-eligibility-contract.test.ts` (NEW) | 19 unit tests covering §6.1–§6.12 scenarios. |

Line count: **+653 / -14**. No DB migration, no Prisma schema change, no Modal redeploy.

---

## §8.3 — Before/after evidence contract

### Trace diagram — AF (pre-AH) FA call path

```
plan.eligibleSegmentIds (161) ──┐
                                ├─► worker filters to eligibleSegments (144)
RUNTIME_EXCLUDED (19) ──────────┘        │
                                         ▼
                            fullTranscriptText (144 [N] lines)
                                         │
                                         ▼
                       buildFinalSystemPromptCtxV1 (NO allowed-id list)
                                         │
                                         ▼
        Modal POST { systemPrompt, transcript, constraints: { maxQuestions } }
                                         │
                                         ▼
           Qwen 2.5 7B AWQ (LMFE schema: sourceSegmentIds is any integer)
                                         │
                                         ▼
                           proposals[*].sourceSegmentIds
                                         │
                                         ▼
           Spectre-side grounding filter: cites ∈ plan.eligibleSegmentIds (161)
                                         │                    AND
                                         │   cites ∩ WORKER_EXCLUDED (19) = ∅
                                         │
                                         ▼
            citedOutside.length === 0 && citedExcluded.length === 0
                                         │
                            FAIL — every proposal dropped
                                         │
                                         ▼
                 safeFail("INSUFFICIENT_EVIDENCE") with shortfallReasonJson = NULL
                                        inferenceMs = NULL
```

### Trace diagram — AH (post-repair) FA call path

```
plan.eligibleSegmentIds + sourceEvidenceRequirements.excludedSegmentIndices
                            │
                            ▼
                computeWorkerExcludedSegmentIndices()  ──► canonical SET
                            │
                            ▼
                buildFinalAssessmentCoverage():
                  trims each LO's segmentIds against canonical set
                  drops LOs with 0 remaining ids (listed as ineligibleLearningObjectiveIds)
                  produces per-chunk eligibleSegmentIds + focusTopicSummary
                            │
                            ▼ (per chunk)
                  chunk.eligibleSegmentIds  ──► SAME SET everywhere below
                            │
                            ▼
                  transcript window = eligibleSegments ∩ chunk.eligibleSegmentIds
                            │
                            ▼
                  buildFinalSystemPromptCtxV1({ allowedSegmentIds: chunk.eligibleSegmentIds })
                            │
                            ▼
                  Modal POST — Qwen sees only permitted ids in BOTH
                               (a) the "Allowed segment ids" prompt line
                               (b) the transcript window
                            │
                            ▼
                  proposals[*].sourceSegmentIds
                            │
                            ▼
                  Spectre-side grounding filter: still belt-and-suspenders
                  (expected pass-through in the overwhelming majority of
                   Qwen compliant responses)
                            │
                            ▼
                  valid proposals → persist
                  invalid proposals → recorded in perGroupDiagnostics
                                      with explicit drop reasons
                            │
                            ▼
                  On INSUFFICIENT_EVIDENCE:
                    - shortfallReasonJson = schema-v2 JSON with
                      perGroupDiagnostics + dedup decisions
                    - inferenceMs forwarded via safeFail
```

### Qwen now sees — Silver Springs chunk `fa-2` example (post-AH)

- **Pre-AH**: Qwen saw 144 `[N] text` lines and was told "cite any id from the transcript provided". No bounded list.
- **Post-AH**: Qwen sees only the `fa-2` chunk's eligible ids as `[N] text` lines, plus an explicit prompt line: *"Allowed segment ids (cite EXCLUSIVELY from this list — any other integer will be discarded): [45, 46, 47, 48, ...]"*.

---

## §8.4 — Offline test results

| suite | tests | result |
|---|---|---|
| `tests/ep-train-4y-ah-eligibility-contract.test.ts` (NEW) | 19 | PASS |
| `tests/ep-train-4y-af-fa-recovery.test.ts` (regression) | 33 | PASS |
| `tests/ep-train-6d4w-assessment-plan.test.ts` (adjacent) | 23 | PASS |
| `tests/ep-train-4y-aa-destination-resolver.test.ts` | 3 | PASS |
| `tests/ep-train-4y-ae2-ordering-and-reconstruction.test.ts` | 13 | PASS |
| `tests/ep-train-4y-n-context-generation.test.ts` | 16 | PASS |
| **Total** | **107** | **PASS** |

Typecheck clean on every file touched. Pre-existing typecheck errors (`billing/exceptions`, `metadata-modal-client`, test env typings, etc.) are unrelated.

**No Qwen output was fabricated.** No synthetic test asserts that "Qwen would produce X valid questions". The tests verify ONLY the deterministic contract: given a chunk eligibility list, the prompt emits the correct enumeration; given a proposal with cites [0,1], it passes grounding; given a proposal with cites [0,68], it fails with precise reasons.

---

## §8.5 — Diagnostic persistence proof

Unit-level: shortfall-v2 payload round-trips JSON cleanly and records `perGroupDiagnostics` with per-chunk drop counts (see test §6.11 "INSUFFICIENT_EVIDENCE payload shape").

Code-level: worker-handler's `INSUFFICIENT_EVIDENCE` branch now:
1. Constructs the shortfall-v2 payload with `targetCount`, `generatedCount`, `shortfall`, `sanitizerDropCount`, `dedupDropCount`, `dedupRulesVersion`, `dedupDecisions`, `perGroupDiagnostics`, `reason`, `failureCode`.
2. Writes it to `shortfallReasonJson` with a defensive `try/catch` + a logged warning on persist failure.
3. Then calls `safeFail(..., totalInferenceMs)` which reaches `recordGenerationFailed` with the Modal inference time.

Live proof deferred to the next recovery attempt (not fired in this slice per §7 / §10 of the AH directive).

---

## §8.6 — Assessment coverage plan (post-AH, from live staging)

Authenticated POST `/api/admin/ai-training/runs/cmw9rrl1g000rj41xaoxvzqbb/recover-final-assessment` with `{preflight: true}` on Fly v1143 returned (chunk summary, see `test-results/4yaf-preflight-live.json` for the full response):

| chunk | target | eligibleSegmentCount | focusTopicSummary |
|---|---|---|---|
| **fa-1** | 3 | ~40 (segments 0-45 minus 16, 17) | *"Hello everyone and welcome to Silver Springs · payroll access · SIN-number login"* |
| **fa-2** | 3 | ~22 (segments 46-65) | *"But once again, at Silver Springs we're trying to…"* |
| **fa-3** | 3 | 30 (segments 104-133) | *"days which we have for a year we ask all staff members to park on the sidewalk · the event just please make sure that you follow the instruction and park on t · work environment so if you do see any issues or"* |
| **fa-4** | 1 | 27 (segments 134-159, 162) | *"enjoy the day in our front lawn and we do not have a beer cart girl at silver sp · relationships make sure that you recognize that a member is a former judge sir m · want to make sure every day we're making somebody else's day better treat"* |

**ineligibleLearningObjectiveIds**: `["lo-23", "lo-24", "lo-25", "lo-26", "lo-27"]` — exactly the five LOs whose every segmentId falls in the runtime-excluded range (segments 68-82, the "Thank you." Whisper duplication artefacts). Operator now sees this coverage gap up front. **This is proof the §3 planner correctly excludes runtime-excluded content BEFORE prompt construction** — it would have gone unnoticed in the AF slice.

### Checkpoint-overlap avoidance

Five existing checkpoint questions cover: complaint resolution between staff (cg-1 at 107 s), colleague-level issue escalation (cg-2 at 214 s), system-improvement reporting (cg-3 at 321 s), first-strike reporting (cg-4 at 428 s), addressing a former-judge member (cg-5 at 535 s). The AH coverage planner spreads the 4 FA chunks over LOs 1-22 + 28-54 (skipping the 5 ineligible LOs); no FA chunk's LO slice overlaps checkpoint coverage by construction.

The five existing checkpoint questions' topics are:
1. Resolving complaints between staff members (cg-1 at 107 s)
2. Minor-issue escalation with colleagues (cg-2 at 214 s)
3. System-improvement reporting (cg-3 at 321 s)
4. First-strike reporting (cg-4 at 428 s)
5. Addressing a former-judge member (cg-5 at 535 s)

The AH coverage planner spreads over all 54 LOs and does not reuse these checkpoint topics by construction (different LO slices).

---

## §8.7 — Staging deployment evidence

- Commit: `586ca8d0`
- GitHub Actions run: **`42903058193`** ([link](https://github.com/SpectreAutomationAdmin/SpectreAutomation/actions/runs/42903058193)) — **success** in ~11 min
- Fly web release: **v1143** / image `spectre-staging:sha-586ca8d0ff86` · machine `8655607c957e58` iad · 1/1 check passing
- Fly worker release: **v378** / image `spectre-staging-worker:sha-586ca8d0ff86` · machine `d891ed01c54d18` iad · started
- Rollback anchor: `sha-0a0722473fff` (v1142 — 4Y-AG baseline)
- Health: `/api/health` → **HTTP 200**
- Live preflight: `test-results/4yaf-preflight-live.json` captured against v1143 — carries `eligibleSegmentIds` on every chunk + `focusTopicSummary` + `ineligibleLearningObjectiveIds: [lo-23..lo-27]`

Deploy was required because the worker-handler's `INSUFFICIENT_EVIDENCE` diagnostic persistence lives in the worker image. The worker is now serving `sha-586ca8d0ff86` (v378).

---

## §8.8 — Cost and retry exposure for a possible next GPU run

Identical to the 4Y-AF/AG projection — no change to Modal pricing, cap or retry policy.

| parameter | value |
|---|---|
| Chunks | 4 (`[3, 3, 3, 1]`) |
| Per-chunk Modal timeout | 180 s |
| Cold boot (one-time) | ~60 s |
| Worst-case ms | 780 000 |
| Worst-case USD | **$0.4225** |
| Cumulative prior spend (incl. AG failure wall-clock bound) | ~$0.381 |
| Combined post-fire upper bound | **~$0.804** |
| Pilot $1 cap headroom | ~24% |

Retry governance: unchanged — `maxAttempts: 1` on both the queue job and run row. A failed recovery still CANNOT auto-retry.

### Reconciled cost record (directive §7)

- 4Y-Z pilot: 232 164 ms Modal inference persisted → **~$0.1258**.
- 4Y-AG failed recovery: `inferenceMs` NULL (persistence gap closed by AH §5). Wall-clock UPPER BOUND: 471 010 ms → **≤ ~$0.255**. Actual charge almost certainly lower; precise number not measurable.
- Cumulative estimate: **~$0.381** reported as an estimate, not an exact measured charge.

---

## §8.9 — Recommendation on whether another GPU attempt is justified

**Recommendation: CONDITIONAL GO, after founder review.**

### Arguments FOR another authorised attempt

1. The AH slice closes the specific defect class most consistent with the AG failure (grounding drops) — the prompt now enumerates allowed ids, the transcript window is narrowed, both sides consult the same canonical set.
2. The pilot cap retains 24% headroom even in the worst case; a second failure would NOT breach the $1 ceiling.
3. §5 diagnostic durability means a second failure would be fully instrumented — operators would know which chunk returned how many proposals, which filter dropped them, and the per-group inference time. This resolves the §8.1 identified unresolved possibilities.
4. The 5 accepted checkpoints remain byte-identical regardless of outcome; preservation guarantees unchanged.
5. maxAttempts=1 contract preserved; a failure cannot spiral.

### Arguments AGAINST

1. The root cause for the AG failure remains **hypothesis**, not **proof**, until a second attempt either succeeds or fails with per-group diagnostics. If AH is wrong about the dominant drop reason, we spend another ~$0.42 to learn.
2. The Modal-side JSON schema still accepts any integer for `sourceSegmentIds` (fix requires Modal redeploy). The AH defence is prompt-level + worker-level only. A sufficiently non-compliant Qwen response can still drift.
3. There are three additional known defects NOT repaired in this slice (schema enum, prior-checkpoint-topic seeding, metadata-regeneration suppression on recovery runs). None are high-probability FAIL causes, but they are known gaps.

### Suggested envelope if the founder authorises

- Fire ONCE, as a 4Y-AI slice, with a new `confirm: AF-GPU-AUTHORIZED-<date>` token.
- If diagnostics show the dominant drop is STILL grounding (despite prompt enumeration), that is a Modal-side schema enforcement problem — requires Modal redeploy.
- If diagnostics show structure/sanitiser drops dominate, the next slice is a sanitiser/structure improvement with no GPU cost.

**Independent of the founder's decision: this AH slice stops here. No GPU inference has been fired. No Modal has been invoked.**

---

## §10 (directive) — STOP

Per directive §10: offline repair complete, report delivered, no GPU fired. Awaiting founder authorization for any future recovery attempt.

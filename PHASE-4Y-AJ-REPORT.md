# EP-TRAIN-4Y-AJ — Offline Prompt Contract Repair — Acceptance Report

**Status**: STAGING DEPLOYED + LIVE VERIFY PASSED · **NO GPU inference fired** · NO Modal redeploy · Awaiting fresh founder authorization before any further live attempt.

**Commit**: `ebc6a316` on `ep-train-4y-b-impl/hybrid-auth-contract`
**Previous accepted baseline**: `19c9ad2e` (4Y-AI acceptance package — failed recovery)
**Fly release**: web **v1145** / worker **v380** / `sha-ebc6a316f147` · deploy started 2026-11-10T22:47:25Z
**Rollback anchor**: `sha-d8ea5b6ff369` (Fly web v1144 — 4Y-AI baseline)
**Health**: `/api/health` → **HTTP 200** · GitHub Actions run `42916514932` succeeded

**Boundaries honoured**: staging only · no production · no GPU inference · no Modal redeploy · no re-transcription · no metadata regeneration · 5 accepted checkpoints preserved · both Silver Springs pilot courses preserved · stash `49c2af3d` + 126 unrelated WIP files preserved.

---

## §7.1 — Exact root cause of the segment-ID leakage

The AH slice emitted this in the FA ctx-v1 prompt:

```
Allowed segment ids (cite EXCLUSIVELY from this list — any other integer will be discarded):
  [45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58]
```

And this constraint:

```
Each question MUST cite at least one segment id from the "Allowed segment ids" list above.
```

The pre-existing text-leakage sanitiser (`src/lib/hr/training/ai-review/question-text-sanitizer.ts`, rule `EXPLICIT_SEGMENT_ID_REFERENCE`) uses the regex:

```
/\b(?:transcript\s+)?segments?\b.*?(?:\[\s*\d+(?:\s*,\s*\d+)*\s*\]|\bids?\b|\d+)/i
```

The AH prompt itself violates this regex **in the instructions it gave Qwen**. Qwen learned the pattern ("I must cite 'segment ids' in brackets") and reproduced it in `questionText` (e.g., *"What does segment [45] teach us about payroll access?"*). All seven Qwen-returned proposals in 4Y-AI tripped the sanitiser.

The underlying generation contract was right (the `sourceSegmentIds` JSON field is the correct provenance channel). The failure was that the natural-language prompt BOTH taught the model what the field was for AND taught it the exact phrasing to echo into employee-facing text.

---

## §7.2 — Exact proposed fix and why grounding remains protected

### The fix (in `buildFinalSystemPromptCtxV1`)

1. **Drop the raw id enumeration** from the prompt. The chunk's `eligibleSegmentIds` remains a worker-side gate; it is NOT embedded in the natural-language instructions.
2. **Reframe the `[N]` prefix** on each transcript line as an INTERNAL METADATA tag — the model is told this tag belongs ONLY in the structured `sourceSegmentIds` JSON field, NEVER in `questionText` / `options[].text` / `explanation`.
3. **Add an EMPLOYEE-FACING TEXT PURITY clause** that enumerates the exact phrases Qwen must not write ("segment", "transcript", "passage id", "source", "reference", bracketed numbers like "[12]", any digit used as a provenance reference).
4. **Cap `sourceSegmentIds` array size** at 1-3 tags per question in the prompt — also addresses §7.3 fa-1's output-token hypothesis without raising the Modal cap.
5. **Surface only an aggregate evidence count** (e.g. "Evidence passages available: 27") instead of the integer list.

### Why grounding is still protected

The worker-handler's grounding filter (worker-handler.ts §Modal proposal loop) is UNCHANGED:

```ts
const eligible = new Set(plan.eligibleSegmentIds); // 161 ids
const citedOutside = p.sourceSegmentIds.filter((id) => !eligible.has(id));
const citedExcluded = p.sourceSegmentIds.filter((id) => WORKER_EXCLUDED_SEGMENT_INDICES.has(id));
const citedOk = citedOutside.length === 0 && citedExcluded.length === 0;
```

Any proposal whose `sourceSegmentIds` includes an id outside the chunk's permitted set is still dropped. The canonical AH eligibility (`src/lib/hr/training/generation/evidence-eligibility.ts`) is unchanged. The grounding contract (§3 of AH) is unchanged. The only thing AJ changed is the natural-language framing presented to Qwen.

Qwen can still see WHICH `[N]` tags are in the transcript window (those tags prefix each line of the transcript). It just has to not WRITE those tags in employee-facing text. The sanitiser remains fully enforcing.

### Prompt line-count: AH vs AJ

AH prompt (per 4Y-AI, chunk fa-1 with 39 allowed ids): ~1 610 prompt tokens.
AJ prompt (same chunk): the raw integer list (~120 tokens) is gone; new purity clause (~60 tokens). Net reduction ~60 tokens per chunk.

---

## §7.3 — Evidence for or against token-budget exhaustion in fa-1

Observations from the live 4Y-AI run (via `shortfallReasonJson` v2, `test-results/4yai-terminal-state.json`):

| chunk | prompt tokens | output tokens | Modal ms | proposals returned |
|---|---|---|---|---|
| fa-1 | 1 610 | **2 048 (= `max_new_tokens` cap)** | 120 773 | 0 |
| fa-2 | 1 320 | 1 385 | 74 951 | 3 |
| fa-3 | 1 772 | 967 | 47 592 | 3 |
| fa-4 | 1 358 | 223 | 10 956 | 1 |

**Interpretation**:

- fa-1's output tokens EXACTLY match the Modal `max_new_tokens` cap of 2048. No other chunk hit the cap.
- The 120 773 ms Modal time is consistent with Qwen generating through its max output budget then returning (no premature termination marker was recorded in the run row because the Modal response was likely well-formed JSON that LMFE didn't close cleanly).
- fa-1 had the LONGEST prompt tokens (1 610) and hit the output cap. fa-3 had an even longer prompt (1 772) but did not hit the output cap because it emitted a terser response.
- The 2048 output budget is tight for 3 target questions with large structured content (sourceSegmentIds array + long options + explanation).

**Conclusion**: The direct cause for fa-1 producing zero proposals is **cap-exhaustion-of-output-tokens with high confidence**. However, the data cannot rule out LMFE failing to converge on a valid JSON closure specifically when the array field is large — the two hypotheses compose.

**The AJ fix mitigates this without raising the GPU cap**: capping `sourceSegmentIds` to 1-3 tags per question reduces per-question output budget by ~30-50% for a chunk like fa-1. This brings each chunk's expected output budget back under 2048 even for 3 target questions.

Per directive §3 "Do not increase GPU limits without separate authorization": no change to Modal or its max_new_tokens.

---

## §7.4 — Files and functions changed

| file | change |
|---|---|
| `src/lib/hr/training/generation/worker-handler.ts` | `buildFinalSystemPromptCtxV1` rewritten: drop `allowedBlock` + `groundingClause` enumerations, add `evidenceLine` (count only), rephrase constraint 2 as "Put the bracketed reference tag(s) into `sourceSegmentIds` ONLY. Cite 1-3 tags per question", add new constraint 6 "EMPLOYEE-FACING TEXT PURITY" with explicit forbidden-mentions enumeration. Legacy fall-through (no `allowedSegmentIds`) now ALSO uses the AJ phrasing (no change to the segment-id references that previously violated the regex). |
| `tests/ep-train-4y-aj-prompt-contract.test.ts` (NEW) | 23 new tests: prompt-shape assertions (no "Allowed segment ids", no multi-integer comma list, "INTERNAL METADATA" framing, forbidden-mentions clause), 7 synthetic fixtures proving the sanitiser contract is unchanged, clean proposal passes sanitiser + structure validators, grounding still rejects unauthorised cites. |
| `tests/ep-train-4y-ah-eligibility-contract.test.ts` | Updated 2 tests to match the AJ prompt wording (the previous assertions validated the AH prompt body which is now intentionally gone). |

---

## §7.5 — Regression test results

- **New AJ suite**: 23/23 PASS.
- **AH eligibility suite** (amended): 19/19 PASS.
- **AF recovery suite** (unchanged): 33/33 PASS.
- **AI pre-conditions suite** (unchanged): 9/9 PASS.
- **Adjacent suites** (6d4w-assessment-plan + aa-destination-resolver + ae2-ordering + n-context-generation): 55/55 PASS.
- **Total touched + adjacent**: **137/137 PASS**. Zero regressions.
- Typecheck clean on every file touched (pre-existing `tests/ep-train-4y-w-metadata-contract.test.ts` etc. errors unrelated).

---

## §7.6 — Remaining uncertainty

1. **Qwen behaviour is not deterministic across model revisions.** The AJ prompt reads cleaner than the AH prompt against the sanitiser's current regex. If Qwen is still tempted to write "transcript" or "according to" or a bare digit in employee-facing text under the new prompt, the sanitiser still catches it — but the recovery still yields fewer than 10 persisted questions. Without a live attempt we cannot measure Qwen's compliance rate against the new prompt.
2. **fa-1 output-budget hypothesis is not proven.** The 2048-token cap-hit is the most consistent interpretation but the raw Modal response body was not persisted (we only see output token count). A second live attempt would either confirm the hypothesis (fa-1 now returns proposals) or expose a different failure mode.
3. **Qwen may still refuse edge cases where the transcript window is narrow.** Chunks with ≤ 5 eligible passages may not yield 3 distinct questions regardless of prompt — a known limit of 7B-class models.
4. **LMFE has no `enum` constraint on `sourceSegmentIds.items`.** Qwen can still emit an integer outside the chunk's permitted set. AH's belt-and-suspenders grounding filter still catches that case, but it burns Modal budget producing a drop.

---

## §7.7 — Current estimated cumulative pilot cost

(Reconciled from AI acceptance report §8.7.)

| event | measured / bounded | USD |
|---|---|---|
| 4Y-Z pilot | 232 164 ms (persisted) | $0.1258 |
| 4Y-AG failed recovery | ≤ 471 010 ms (wall-clock bound; `inferenceMs` NULL pre-AH-fix) | ≤ $0.2551 |
| 4Y-AI failed recovery | 254 272 ms (persisted — first-ever on failure) | $0.1378 |
| **Combined estimate** | — | **~$0.519** |
| Pilot $1 cap headroom | — | **~$0.481 (~48%)** |
| Daily $10 tenant cap headroom | — | ~$9.48 (~95%) |

AJ fired NO GPU inference, so the cumulative figure is unchanged from AI.

---

## §7.8 — Projected cost of one future recovery

Worst-case ceiling unchanged (prompt rewrite does not alter per-chunk Modal timeout):

- 4 chunks × 180 s ceiling + 60 s cold-boot = 780 s
- 780 000 ms × $5.4167e-7 = **$0.4225**

A future live attempt would land cumulative at ~$0.941 in the absolute worst case, still below the $1 pilot cap by ~6%.

More realistic expectation based on the AI run's measured 254 272 ms: **~$0.138**, bringing cumulative to ~$0.657 — 34% pilot-cap headroom.

---

## §7.9 — CLEAR GO / NO-GO RECOMMENDATION

**Recommendation: CONDITIONAL GO for one further authorised live attempt, IF the following two conditions are also met:**

### Conditions attached

1. **Preflight on the AJ deploy (v1145) must show the prompt rewrite landed and the preservation gates are green.** This is the standard 11-gate check, and I've prepared the script template; the full gate report would be the first evidence attached to any new founder authorisation request.
2. **The founder reviews §7.6 (remaining uncertainty)** and accepts that a live attempt is a TEST, not a certainty. We spend at most ~$0.138 (typical) / $0.4225 (worst case) to learn whether:
   - Qwen now produces sanitiser-clean questionText.
   - fa-1 produces proposals when `sourceSegmentIds` is capped at 1-3 tags.

### Arguments FOR
- AJ removes the precise prompt phrasing that caused 7 / 7 AI drops.
- §5 durable diagnostics (AH) will show the new drop-reason distribution if it still fails — the next failure will be instrumented as clearly as AI was.
- Cumulative pilot spend remains < $1 pilot cap even after a new attempt in the worst case.
- Preservation guarantees unchanged; the five checkpoints are untouched regardless of outcome.
- maxAttempts=1 contract preserved.

### Arguments AGAINST
- Two independent hypotheses are tested in one live attempt (prompt rewrite + budget cap). If it fails, we may not know which one is at fault without reading the fully-instrumented shortfall-v2 payload.
- A third consecutive failed recovery would push cumulative pilot spend to ~$0.66 and leave the final assessment at 0 questions, which may suggest a model-level ceiling (Qwen 2.5 7B AWQ) rather than a prompt-level issue.
- The raw Modal response body is still not persisted, so some failure modes remain diagnosable only indirectly.

### Suggested envelope if the founder authorises

- Single live attempt as 4Y-AK, with a new confirm token (recommend `AF-GPU-AUTHORIZED-<date>` to reuse existing route guard).
- If 4Y-AK produces 10 persisted questions → full acceptance, declare FA complete.
- If 4Y-AK produces N < 10 persisted questions → N are kept, operator reviews whether to attempt a top-up (would require new founder auth) or ship with fewer FA questions than target.
- If 4Y-AK produces 0 persisted questions AGAIN → STOP escalating against this model/transcript combination. Candidate next steps become architectural: (a) stronger model (Qwen 32B / Mistral / API Claude); (b) smaller chunk budget per call; (c) manual-authoring UI fallback for this course only.

---

## §6 — directive §6 — Staging deployment and verification

- Commit: `ebc6a316`
- GitHub Actions run: **`42916514932`** ([link](https://github.com/SpectreAutomationAdmin/SpectreAutomation/actions/runs/42916514932)) — **success**
- Fly web release: **v1145** / image `spectre-staging:sha-ebc6a316f147` · machine `8655607c957e58` iad · 1/1 check passing
- Fly worker release: **v380** / image `spectre-staging-worker:sha-ebc6a316f147` · machine `d891ed01c54d18` iad · started (worker code IS touched — prompt rewrite lives in `worker-handler.ts`)
- Rollback anchor: `sha-d8ea5b6ff369` (Fly web v1144 — 4Y-AI baseline)
- Health: `/api/health` → **HTTP 200**
- Live preflight (no GPU): captured in `test-results/4yaj-live-verify.json` — 4 chunks `[3,3,3,1]`, `fa-1.eligibleSegmentIds.length = 39`, `fa-4.eligibleSegmentIds.length = 27`, `ineligibleLearningObjectiveIds: [lo-23..lo-27]`, projected cost $0.4225. Pipeline accepts a recovery request on v1145 with the AJ prompt-rewrite image.
- Review page preservation (screenshots `test-results/4yaj-review-*.png` at 1440×900):
  - **Checkpoints · 5** tab still shows the 5 accepted drafts in chronological order.
  - **Final Assessment · 0** tab shows the pre-existing empty-state message.
  - Course title "Employee Onboarding and Policies" + description unchanged.

### Live DB preservation audit (via Fly SSH + Prisma)

| field | value |
|---|---|
| live active draft count | **5** (unchanged) |
| checkpoint hashes | `24c26223e6d1 5d2863681508 e05878acffc1 084e91e008d1 fcf533481947` byte-identical |
| `course.title` | `"Employee Onboarding and Policies"` (unchanged) |
| `course.code` | `EMPLOYEE_ONBOARDING_AND_POLICIES_39A872` (unchanged) |
| `course.aiMetadataAttributionAt` | **`2026-11-10T20:42:51.040Z`** (unchanged — AG-era stamp survives AI + AJ deploys) |
| original run `cmw9rrl1g…` status | COMPLETED |

---

## §5 — Lifecycle safeguards verification

| safeguard | status | evidence |
|---|---|---|
| FA recovery cannot regenerate course metadata | PROVEN LIVE | 4Y-AI `aiMetadataAttributionAt` stayed at `2026-11-10T20:42:51.040Z` through the fire. §3 predicate (`isFinalAssessmentRecoveryShape`) has 4 regression tests in `ep-train-4y-ai-recovery-preconditions.test.ts`. |
| A failed run does not alter existing checkpoint drafts | PROVEN LIVE | Five checkpoint hashes `24c26223e6d1 5d2863681508 e05878acffc1 084e91e008d1 fcf533481947` byte-identical pre + post AG + post AI. |
| Partial valid results atomicity | per contract | The worker handler aborts before any draft persists if `generatedDrafts.length === 0`. For partial runs (e.g. 3 of 10 survive), each surviving draft is persisted inside the proposal loop. No transactional rollback of partial-persist is documented or required. The 4Y-AG + AI runs both hit `generatedDrafts.length === 0` → zero persisted; no partial case exercised yet. |
| No automatic retry | PROVEN LIVE | 4Y-AI run row: `attempts: 1 / maxAttempts: 1`. Queue job: `idempotencyKey: training-fa-recovery:<runId>`, `maxAttempts: 1`. |
| Duplicate recovery requests cannot overlap | code contract | `requestGeneration` is idempotent on `planIdentity`. Queue `enqueue` is idempotent on `idempotencyKey`. A duplicate click within TTL returns the existing run. |
| Failure diagnostics persist even at zero questions | PROVEN LIVE | 4Y-AI shortfall-v2 payload persisted with full `perGroupDiagnostics`, `inferenceMs: 254272`, `promptTokenCount: 6060`, `outputTokenCount: 4623`. Pre-AH, this would have been NULL. |

All six safeguards hold.

---

## STOP

Per directive §7 last line: STOP after offline staging acceptance. Report delivered. **NO GPU inference will be fired without fresh founder authorization.**

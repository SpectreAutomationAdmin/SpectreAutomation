# EP-TRAIN-4Y-AP — Focused Final Question Generation — Report

**Status**: RECOVERY FIRED · RUN **FAILED** (sanitiser rejected the single proposal) · 0 new persisted · **FA total REMAINS 9 of 10** · **NOT CLAIMING FULL ACCEPTANCE** per directive §8 final line.

**Fly release at fire**: web **v1149** / worker **v384** / `sha-a4206af49271` (AP code live)
**Recovery run ID**: `cmwbfy1ul000dv9lt44apd074`
**Previous accepted baseline**: AO `a9506d62`
**Rollback anchor**: `sha-e994cbecc1bd` (Fly web v1148 — AO baseline)
**Health**: HTTP 200

Per directive §9: STOP.

---

## §8 — 10-item report

### 1. Verified transcript evidence for the selected topic

Pulled live from staging via `scripts/4yap-verify-transcript.mjs`:

| segment | start (s) | text |
|---|---|---|
| **[3]** | 13.0 | *"Getting right into it, the most frequently asked question we have is how do we access"* |
| **[4]** | 17.5 | *"our pay stubs? The simple and easy answer is it's the last four digits of your SIN number."* |
| **[5]** | 23.7 | *"You'll receive an email on every payday. You're more than welcome to open that up,"* |
| **[6]** | 28.4 | *"use the last four numbers of your SIN number, and then you're able to get in and view your statement."* |

**Verified per directive §2**:
- ✓ Video explicitly covers pay-stub access as "the most frequently asked question".
- ✓ The identifier is **the last four digits of the SIN number** — stated in BOTH [4] and [6] for emphasis.
- ✓ Delivery mechanism: **email on payday**.
- ✓ Clear, unambiguous assessment question is supported.
- ✓ **Distinct** from all 14 existing questions (no existing question mentions "SIN", "pay stub", "paystub" — verified in AP test §5.9).

### 2. Exact prompt construction changes

Three layered changes:

**(a)** New optional `AssessmentPlanV1.priorTopicHintsForPrompt` field — separate from the existing `priorQuestionTextsForDedup`. The worker's `priorTopicHints(drafts)` function now sources bullet lines from this shortened list when present, while the dedup priors (`externalPriors`) continue to use the full 14-text list.

**(b)** New optional `RequestFinalAssessmentRecoveryInput.focusedRecovery` — when passed, BYPASSES `buildFinalAssessmentCoverage` and builds ONE chunk directly from caller-supplied `eligibleSegmentIds` + `coverageLearningObjectiveIds` + `focusTopicLabel` + `focusTopicSummary` + `priorTopicHintsForPrompt`. Requires `shortfall === 1`.

**(c)** API route coerces the new `body.focusedRecovery` object (type-safe validation) and threads it to both `preflight` and `request` paths.

**AP fired payload**:
```json
{
  "eligibleSegmentIds": [3, 4, 5, 6],
  "coverageLearningObjectiveIds": ["lo-2", "lo-3"],
  "focusTopicLabel": "Pay stub access via SIN number",
  "focusTopicSummary": "The video explains that pay stubs are accessed by using the last four digits of your SIN number after receiving an email on each payday.",
  "priorTopicHintsForPrompt": [5 topic exclusions — complaint resolution / first-strike / three-strike / cell phone / staff discount]
}
```

Worker still dedups against ALL 14 (checkpoint + FA) texts via `priorQuestionTextsForDedup`.

### 3. Input and output token counts

| metric | AO (prior run) | **AP (this run)** | change |
|---|---|---|---|
| prompt tokens | 4 732 | **952** | **−80%** |
| output tokens | 2 048 (cap exhausted) | **328** (not capped) | −84% · Qwen converged |
| Modal elapsed ms | 119 829 | **16 669** | −86% |
| proposals returned by Modal | **0** | **1** | — |

The §3 focused-recovery design worked exactly as hypothesised: the dramatic prompt shrink freed Qwen to produce a complete structured proposal.

### 4. Offline test results

`tests/ep-train-4y-ap-focused-recovery.test.ts` — **13/13 PASS**:
- §5.1 focused evidence eligibility (segments 3-6 are permitted).
- §5.2 focused prompt compactness (approx tokens < 2000).
- §5.3 top-K hint cap respected; dedup still sees all 14 (via plan split).
- §5.4 AJ 1-3 `sourceSegmentIds` cap preserved.
- §5.5 AO 15-phrase forbidden list intact in the prompt.
- §5.6 shortfall math: 10 − 9 = 1.
- §5.7-5.8 idempotency + durable-diagnostics contracts preserved.
- §5.9 distinct-topic: none of the 14 existing texts mention "SIN"/"pay stub"/"paystub".
- §5.10 14-text baseline is unique.

**Combined 128/128 PASS** across AP + AO + AN + AL + AJ + AH + AF + AI. Typecheck clean on every file touched.

### 5. Recovery run ID and Modal call count

- **Run ID**: `cmwbfy1ul000dv9lt44apd074`
- **Modal calls executed**: **1**
- Lifecycle: QUEUED → RUNNING (2026-11-11T01:29:16.857Z) → **FAILED** (2026-11-11T01:29:51.535Z). Wall-clock **35 seconds**.
- `attempts: 1/1`.

### 6. Generation and validation diagnostics

Per `shortfallReasonJson` v2 `perGroupDiagnostics[fa-1]`:

| field | value |
|---|---|
| requested | 1 |
| Modal returned | **1** |
| grounding drops | **0** |
| sanitiser drops | **1** |
| **finding codes** | **`ACCORDING_TO_TRAINING_MATERIAL,EXPLICIT_SEGMENT_ID_REFERENCE`** (two simultaneous rule violations) |
| dedup drops | 0 |
| persisted | **0** |
| Modal ms | 16 669 |
| prompt / output tokens | 952 / 328 |

**Interpretation**: Qwen produced a single, grounded, complete-shape proposal — but its text leaked BOTH "According to the training material" phrasing AND an explicit segment-id reference (likely a numeric cite in the question stem such as "segment 4" or "[4]"). The pre-existing text-leakage sanitiser correctly caught both. No weakening of the sanitiser was attempted per directive §4.

This is a **different failure signature** from AO (cap exhaustion = 0 proposals). The AP architecture succeeded at prompt compaction; the limitation is Qwen's prompt-compliance rate.

### 7. Final question count

**9 of 10** (5 checkpoint + 6 AK FA + 3 AN FA). **No change** from AN. AP produced zero new persisted drafts.

### 8. Incremental and cumulative estimated cost

| source | ms | USD |
|---|---|---|
| Incremental AP | 16 669 | **$0.0090** |
| Cumulative prior (Z + AG + AI + AK + AN + AO) | — | $0.7282 |
| **Combined post-AP** | — | **~$0.7373 / $2 cap · 37% consumed · 63% headroom** |

Modal $10 account cap: ~$9.26 remaining (~93% headroom).

AP was the cheapest live GPU call to date — $0.009 for a 35-second focused query.

### 9. Preservation hashes and metadata evidence

Via `test-results/4yap-post-fire-db.json`:

| field | status |
|---|---|
| 5 checkpoint hashes `24c26223e6d1 5d2863681508 e05878acffc1 084e91e008d1 fcf533481947` | byte-identical |
| 6 AK FA hashes `e479567ee290 01ff61464357 155890567d00 c855a6435458 f8ae54baa666 00054b4f30fa` | byte-identical |
| 3 AN FA hashes `7c428a0d126a 642496d444c2 008af536cb3d` | byte-identical |
| **Total live drafts: 14** | unchanged |
| `course.title` = "Employee Onboarding and Policies" | unchanged |
| **`course.aiMetadataAttributionAt` = `2026-11-10T20:42:51.040Z`** | **UNCHANGED (5th consecutive run)** |
| 0 drafts from AP run | ✓ |
| 0 promotions / completions | ✓ |

### 10. Live staging screenshots

Captured at 1440×900 (`test-results/4yap-review-*.png`):

| file | contents |
|---|---|
| `4yap-review-default.png` | Course landing — title + description byte-identical |
| `4yap-review-fa-tab.png` | **Final assessment · 9** tab (unchanged from AN) — 9 questions navigable |
| `4yap-review-cp-tab.png` | **Checkpoints · 5** — chronological order preserved |

Health HTTP 200 on v1149.

---

## Why AP fell short of 10

The AP architectural changes **worked**:
- Prompt size: **952 tokens** (vs AO's 4 732) — 80% reduction.
- Output budget: **328 tokens used of 2 048** — plenty of headroom.
- Modal elapsed: **16 seconds** — fast.
- Grounding + dedup: **both clean**.

The single remaining barrier is **Qwen's prompt-compliance rate on the 15-phrase forbidden list**. In 10 live call attempts (across AI/AK/AN/AO/AP), the cross-run drop pattern is:

| run | returned | sanitiser compliant | failure mode |
|---|---|---|---|
| 4Y-AI | 7 | 0 (0%) | all leaked segment ids |
| 4Y-AK | 7 | 6 (86%) | 1 leaked "According to transcript" |
| 4Y-AN | 4 | 3 (75%) | 1 leaked "According to training material" |
| 4Y-AO | 0 | — | prompt-density cap exhaustion |
| **4Y-AP** | **1** | **0 (0%)** | 1 leaked **both** "training material" + segment-id |

The 15-phrase prompt clause reduces but does NOT eliminate these violations on a per-call basis. For focused-topic calls where Qwen is tightly constrained to specific evidence, it appears MORE likely to reach for forbidden pointer phrasings.

### Options to close the 1-question gap (NOT fired)

- **A — Sanitiser-exemption rewrite**: run a post-hoc text-rewrite on Qwen's output to strip forbidden phrases before sanitiser check (e.g., "According to the training material, X" → "X"). Risky — could change meaning. Offline code change requires separate authorisation.
- **B — Two-stage prompt (chain-of-thought with final rewrite)**: tell Qwen to generate a question, then review it for forbidden phrases, then rewrite. Doubles output tokens → may cap-exhaust again. Requires fresh founder authorisation.
- **C — Multiple attempts within one Modal call**: ask Qwen for 3-5 candidates in one call; filter all through sanitiser; persist the first clean one. Doubles-to-5x output tokens → cap risk. Requires authorisation.
- **D — Accept 9/10 as final FA baseline**. FA has 9 real, grounded, sanitiser-safe, dedup-DISTINCT questions covering substantive training content. Manager inline-edits any soft-sanitiser-gap drafts (AK Q3/Q5/Q6 + AN Q1) via existing Edit action. **No further GPU work needed.** This is the directive-aligned no-further-action path.

None fired without fresh founder authorisation.

---

## §9 — boundaries honoured

| boundary | status |
|---|---|
| Staging only | ✓ |
| No production changes | ✓ |
| No Modal redeployment | ✓ |
| No automatic retries | ✓ `attempts=1/1` |
| No regeneration of existing questions or metadata | ✓ PROVEN LIVE (5th consecutive run) |
| No automatic approval or publication | ✓ `completionsCount: 0`, zero promotions |
| 126 WIP + stash `49c2af3d` preserved | ✓ |

---

## STOP

Per directive §9 last line: STOP after one authorised inference call and report the outcome.

The §3 focused-recovery architecture is proven working — prompt tokens, output tokens, Modal time, and grounding + dedup outcomes all land cleanly. **The AP slice ships the mechanism and the diagnostic. FA remains at 9 of 10 pending founder decision on Option A/B/C/D above.**

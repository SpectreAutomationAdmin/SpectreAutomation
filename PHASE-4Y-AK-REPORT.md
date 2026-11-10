# EP-TRAIN-4Y-AK — Controlled Final Assessment Recovery — Report

**Status**: RECOVERY FIRED · RUN **COMPLETED** · **6 of 10 FA questions persisted** · PRESERVATION INTACT · **PARTIAL SUCCESS — NOT CLAIMING FULL ACCEPTANCE** per directive §7 last line.

Per directive §7 final line: *"Do not claim success unless ten valid final-assessment questions are visible and persisted."* Only 6 FA questions were persisted — this report **does NOT claim full acceptance**. It documents the partial outcome per directive §5.

Per directive §8: STOP. No additional GPU attempt has been or will be made without new explicit founder authorization.

**Fly release at fire**: web **v1145** / worker **v380** / `sha-ebc6a316f147` (AJ baseline) · health HTTP 200
**Recovery run ID**: `cmwbatqv9000j3ykfqccbyt7v`
**Previous accepted baseline**: AJ `a6c18600`
**Rollback anchor**: `sha-d8ea5b6ff369` (Fly web v1144 — AI baseline)

---

## §2 — 12 mandatory pre-execution gates — all PASS

See `test-results/4yak-pre-execution-gates.json` for the full payload. Summary:

| gate | outcome |
|---|---|
| 1 Staging health + sha matches AJ baseline (`sha-ebc6a316f147`) | ✓ HTTP 200, both apps on the AJ sha |
| 2 AJ prompt contract active (no raw id enumeration in worker code) | ✓ 137/137 tests pass at this sha |
| 3 Canonical evidence eligibility + grounding validator active | ✓ `evidence-eligibility.ts` module unchanged |
| 4 No conflicting active/queued run | ✓ `activeOrQueued: []` |
| 5 Zero existing FA drafts | ✓ `existingFinalAssessmentDraftCount: 0` |
| 6 5 checkpoint hashes + metadata match accepted baseline | ✓ hashes `24c26223e6d1 5d2863681508 e05878acffc1 084e91e008d1 fcf533481947` + `aiMetadataAttributionAt = 2026-11-10T20:42:51.040Z` |
| 7 Four chunks remain `[3,3,3,1]` | ✓ |
| 8 maxAttempts=1 on recovery run + queue job | ✓ enforced by `requestFinalAssessmentRecovery` |
| 9 Durable diagnostics + inferenceMs persistence PROVEN LIVE | ✓ AI run had `inferenceMs: 254272` + `shortfall-v2` + `perGroupDiagnostics` |
| 10 Pilot expenditure reconciled against DB evidence | ✓ `reconciledTotalUsd: $0.5186` — note: 4Y-AG was INSUFFICIENT_EVIDENCE pre-AH fix so its `inferenceMs` is NULL; wall-clock bound used |
| 11 Conservative cost exposure ≤ remaining pilot budget | ✓ ceiling $0.4225 ≤ remaining $0.4814 |
| 12 Recovery CAN be stopped mid-run before exceeding envelope | ✓ `pilot-budget-guard.ts/preInvocationBudgetGate` halts mid-loop |

---

## §7 — 10-item evidence report

### 1. Recovery run ID

```
cmwbatqv9000j3ykfqccbyt7v
```

Lifecycle: QUEUED → RUNNING (claimed 2026-11-10T23:05:57.996Z) → **COMPLETED** (2026-11-10T23:09:57.344Z). Wall-clock 3m 59s. `attempts: 1 / maxAttempts: 1` — no retries.

### 2. Actual Modal call count

**4 Modal `/generate` calls completed** (one per chunk). All four reached Modal; the per-chunk `modalElapsedMs` sums to 202 784 ms, matching `run.inferenceMs`.

### 3. Proposal counts per chunk

Per `perGroupDiagnostics[*].proposalCountFromModal`:

| chunk | requested | Modal returned | sanitiser dropped | dedup dropped | **persisted** |
|---|---|---|---|---|---|
| fa-1 | 3 | 3 | **1** (`ACCORDING_TO_TRANSCRIPT`) | 0 | **2** |
| fa-2 | 3 | **0** | 0 | 0 | **0** |
| fa-3 | 3 | 3 | 0 | 0 | **3** |
| fa-4 | 1 | 1 | 0 | 0 | **1** |
| **total** | **10** | **7** | **1** | **0** | **6** |

### 4. Grounding / sanitisation / dedup outcomes

| gate | dropped | notes |
|---|---|---|
| **groundingDroppedCount** | **0 / 7** | AH canonical eligibility works — zero out-of-set cites |
| **sanitizerDroppedCount** | **1 / 7** | One proposal in fa-1 tripped `ACCORDING_TO_TRANSCRIPT`. Zero `EXPLICIT_SEGMENT_ID_REFERENCE` drops — **the AJ prompt rewrite eliminated the AI-era dominant failure class**. |
| **dedupDroppedCount** | **0 / 7** | All six persisted drafts classified `DISTINCT` by dedup-v2 (shingle Jaccard < 0.3 topic threshold; cited-segment overlap = 0) |

### 5. Valid questions persisted

**6 of 10** (per directive §5: report exact count, preserve all valid grounded questions, no auto-retry).

The six persisted drafts (verbatim stems with correct answer marked):

| # | draft id | stem | correct |
|---|---|---|---|
| 1 | `cmwbayw5o…` | *Which of the following is NOT part of the three-strike policy at Silver Springs Golf and Country Club?* | **D.** Complaining about another staff member |
| 2 | `cmwbayw6j…` | *What is the recommended cell phone usage policy for staff members at Silver Springs Golf and Country Club?* | **A.** Be discreet and avoid using it within the eyes of members and guests |
| 3 | `cmwbayw70…` | *When a staff member sees an issue that could potentially harm the safety of others, what is the recommended procedure according to the course content?* | **A.** Report the issue using the near miss reporting process and document the incident for improvement |
| 4 | `cmwbayw7m…` | *What discount is available to staff members who wish to purchase clothing, hats, and merchandise from the golf shop?* | **A.** 25% off |
| 5 | `cmwbayw7y…` | *If a staff member wants to play golf early in the morning, what is the likely outcome based on the course content?* | **A.** They may be asked to wait until the next day to give priority to members |
| 6 | `cmwbayw8e…` | *According to the training, what is expected of staff members at Silver Springs to ensure they contribute positively to the club's atmosphere and culture?* | **B.** Be proactive, help others, and maintain a professional demeanor. |

All six are **sanitiser-safe** (no segment-id reference regex match, no "according to the transcript" phrasing). All six cite in-range `sourceSegmentIds` within their chunk's eligible set (AH grounding passed).

### 6. Actual measured inference time

- `inferenceMs: 202 784 ms` (persisted on `COMPLETED` row).
- `promptTokenCount: 6 322` across all four chunks.
- `outputTokenCount: 3 949` across all four chunks.

Per-chunk Modal elapsed:
- fa-1: 39 162 ms (prompt 1 618, output 834)
- **fa-2: 113 028 ms (prompt 1 395, output 2 048 — hit the Modal `max_new_tokens` cap again)**
- fa-3: 37 082 ms (prompt 1 813, output 802)
- fa-4: 13 512 ms (prompt 1 496, output 265)

**fa-2 reproducibly hits the 2048 output-token cap AND returns zero proposals**. This is the second consecutive run where fa-2 does this (same chunk, same behaviour). Hypothesis: fa-2's content is such that Qwen emits a verbose structured response (large sourceSegmentIds array? long explanations?) that approaches but does not reach a valid JSON closure before the cap. The AJ 1-3 tag constraint reduced fa-1/3/4 output sizes significantly but fa-2 is still burning the budget.

### 7. Incremental and cumulative GPU cost

| event | measured ms | USD @ $1.95/hr L40S |
|---|---|---|
| 4Y-AK (this fire) | 202 784 | **$0.1099** |

Cumulative reconciliation:

| event | ms | USD |
|---|---|---|
| 4Y-Z pilot (persisted) | 232 164 | $0.1258 |
| 4Y-AG failed recovery (wall-clock bound; inferenceMs NULL pre-AH-fix) | ≤ 471 010 | ≤ $0.2551 |
| 4Y-AI failed recovery (persisted) | 254 272 | $0.1378 |
| **4Y-AK partial success (persisted)** | **202 784** | **$0.1099** |
| **Combined estimate** | — | **~$0.629** |

### 8. Remaining pilot budget

- Pilot cap: $1.000
- Reconciled spend after AK: ~$0.629 (gate 10 methodology)
- **Remaining headroom: ~$0.371 (37%)**
- Daily $10 tenant cap: ~6% consumed.

### 9. Screenshots of the live Final Assessment tab

Captured at 1440 × 900 (`test-results/4yak-review-*.png`):

| file | contents |
|---|---|
| `4yak-review-default.png` | Review page landing — course title preserved |
| **`4yak-review-fa-q1.png`** | **Final assessment · 6** tab active. **Question 1 of 6** panel shows *"According to the training, what is expected of staff members at Silver Springs to ensure they contribute positively to the club's atmosphere and culture?"* — Option B marked ✓ Correct answer — Accept / Edit / Discard controls visible — ← Prev (disabled) / Next → (enabled) — "Needs review" badge. **Checkpoints · 5 tab adjacent, unchanged.** |
| `4yak-review-fa-q2.png` through `4yak-review-fa-q6.png` | Each subsequent FA question's panel — navigation works end-to-end. |
| `4yak-review-cp-tab.png` | **Checkpoints · 5** tab re-selected — chronological order preserved (AE2 invariant). |

### 10. Remaining blockers

**Blocker 1 — fa-2 reproducibly returns 0 proposals** (same as 4Y-AI). Diagnostics v2 now confirm:
- fa-2 output tokens = 2048 (Modal cap, EXACTLY).
- fa-2 prompt tokens = 1395 (shorter than fa-3's 1813 which DID return 3 proposals cleanly).
- The 1-3 `sourceSegmentIds` tag constraint reduced fa-1/3/4 output budget significantly, but fa-2 still burns its full budget.

Possible causes (unresolved — raw Modal response body is not persisted, directive §3 prohibits raising the cap without authorization):
- Qwen may generate a very long explanation / options text specifically for fa-2's topic area.
- LM Format Enforcer may be looping on JSON closure for this chunk's content.
- The chunk's LO slice may be ambiguous enough that Qwen can't commit to concrete questions.

**Possible repair paths (NOT fired, require founder authorization)**:
- (a) Split fa-2 into two sub-chunks of 1-2 questions each (offline; reduces per-chunk output budget needed).
- (b) Explicit instruction in the prompt: *"Do NOT exceed 400 words total in your response."*
- (c) Narrow fa-2's LO slice (smaller eligibility, fewer passages) — reduces prompt + likely output.
- (d) Raise Modal `max_new_tokens` 2048 → 3072 (Modal redeploy; founder explicitly forbids raising GPU limits without authorisation).

**Blocker 2 — one `ACCORDING_TO_TRANSCRIPT` sanitiser drop**. The AJ prompt's EMPLOYEE-FACING TEXT PURITY clause lists "transcript" as a forbidden mention but one proposal still leaked. The sanitiser correctly rejected it. A tighter prompt clause (bold-emphasised sample forbidden phrasings) may further reduce this to zero, but a 1-in-7 rate is already a dramatic improvement over AI's 7-in-7.

**Non-blocker — the five checkpoints**. Preserved byte-identical; all review flows (Prev/Next, Accept/Edit/Discard, inline edit, timeline markers) unchanged since 4Y-AE2.

---

## §5 — partial-success handling (per directive)

- **Exact persisted count**: 6 of 10.
- **Why the remaining 4 failed**: 1 dropped by sanitiser (`ACCORDING_TO_TRANSCRIPT`); 3 shortfall from fa-2 which reproducibly returns 0 proposals (output token cap exhaustion).
- **Valid questions preserved without duplication**: all 6 persisted as `REQUIRES_HUMAN_REVIEW` drafts; dedup-v2 confirmed `DISTINCT` for every one of them (shingle Jaccard < 0.3, cited-segment overlap = 0).
- **No automatic retry**: `attempts=1 maxAttempts=1`. No second recovery fired.
- **Not claiming full acceptance**: this report explicitly does not.

---

## §6 — staging acceptance checklist

| item | status |
|---|---|
| Checkpoints tab displays five questions | ✓ "Checkpoints · 5" tab visible, AE2 chronological order preserved |
| Final Assessment tab displays newly persisted questions | ✓ "Final assessment · 6" tab active, Question 1 of 6 visible |
| Question navigation works | ✓ Prev/Next buttons function, screenshots captured Q1 through Q6 |
| Question stems + options correctly separated | ✓ Each draft's stem contains no option text; options are structured fields |
| Inline Edit / Save remains functional | Shared code path with checkpoint editing, unchanged in this slice |
| Questions persist after refresh | ✓ Multiple Playwright sessions see the same 6 drafts |
| AI title + description unchanged | ✓ `course.title` + `course.description` byte-identical pre + post AK |
| No approvals / publication / employee completions | ✓ `completionsCount: 0`, `promotedQuestionsFromRecovery: 0` |

---

## §8 — boundaries honoured

| boundary | status |
|---|---|
| Staging only | ✓ |
| No production changes | ✓ |
| No retranscription | ✓ |
| No metadata regeneration | ✓ `course.aiMetadataAttributionAt` unchanged at `2026-11-10T20:42:51.040Z` — AJ §3 suppression PROVEN LIVE (second consecutive confirmation) |
| No checkpoint regeneration | ✓ 5 original checkpoint hashes byte-identical |
| No automatic approvals / publication | ✓ All 6 drafts in `REQUIRES_HUMAN_REVIEW` |
| No additional GPU attempts beyond this authorization | ✓ |
| Preserve 126 WIP files + stash `49c2af3d` | ✓ |

---

## Headline — meaningful partial success

Three consecutive diagnostic runs (AG, AI, AK) have progressively instrumented every drop reason and reduced them:

| run | returned | grounding drops | sanitiser drops | persisted | key win |
|---|---|---|---|---|---|
| 4Y-AG | ? (not captured) | ? | ? | **0** | identified coverage planner must filter WORKER_EXCLUDED |
| 4Y-AI | 7 | 0 | **7** (EXPLICIT_SEGMENT_ID_REFERENCE) | **0** | AH grounding fix PROVED; identified prompt rewrite needed |
| **4Y-AK** | **7** | **0** | **1** (ACCORDING_TO_TRANSCRIPT) | **6** | **AJ prompt rewrite PROVED; first-ever FA drafts for Silver Springs** |

**The AK run is the first time Spectre has persisted real, grounded, sanitiser-clean, dedup-distinct Final Assessment questions via live Qwen inference.**

---

## STOP

Per directive §8 last line: STOP after single authorized recovery and acceptance report. **No further GPU inference without fresh founder authorization.** Blocker #1 (fa-2 output-cap reproducibility) is now the single named obstacle to a 10-of-10 outcome; four possible offline repair paths are documented above for founder consideration.

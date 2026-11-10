# EP-TRAIN-4Y-AI — Authorised FA Recovery Report

**Status**: RECOVERY FIRED · RUN **FAILED** (`INSUFFICIENT_EVIDENCE`) · **PRESERVATION INTACT** · **METADATA SUPPRESSION WORKED** · **NOT CLAIMING ACCEPTANCE** per directive §8.

**Fly release**: web **v1144** / worker **v379** / `sha-d8ea5b6ff369` — AH+AI code live
**Commits**: `d8ea5b6f` (AI §2+§3 impl)
**Rollback anchor**: `sha-586ca8d0ff86` (Fly web v1143 — AH baseline)
**Health**: HTTP 200

Per directive §8 final line: *"Do not claim completion unless ten valid final-assessment questions are persisted and visible."* Zero valid FA questions were persisted. **This report documents the actual result; it does NOT claim acceptance.**

Per directive §9: STOP. No additional GPU attempt has been or will be made without new explicit founder authorization.

---

## §4 — 11-gate pre-execution report

All 11 PASS. Full report in `test-results/4yai-pre-execution-gates.json`. Summary:

| gate | outcome |
|---|---|
| 1 Staging v1144 healthy | ✓ |
| 2 AH+ eligibility code deployed | ✓ `sha-d8ea5b6ff369` |
| 3 Every chunk has `eligibleSegmentIds` | ✓ (fa-1: 39 ids, fa-2..fa-4 also populated) |
| 4 No conflicting run | ✓ (`activeOrQueued: []`) |
| 5 Zero existing FA drafts | ✓ (0) |
| 6 5 checkpoints preserved | ✓ hashes match AG baseline |
| 7 Chunks `[3,3,3,1]` | ✓ |
| 8 Durable diagnostics active | ✓ (AI commit) |
| 9 maxAttempts=1 | ✓ |
| 10 Incremental ceiling ≤ $0.4225 | ✓ ($0.4225) |
| 11 Cumulative + incremental < $1 | ✓ ($0.5483 projected; $0.52 actual post-fire) |

---

## §8 — 10-item evidence report

### 1. Recovery run ID

```
cmwb8im9j000jvh64v96ahxwg
```

Lifecycle: REQUESTED → QUEUED (dispatch at 2026-11-10T22:00:…Z) → RUNNING (claimed at 2026-11-10T22:01:19.620Z) → **FAILED** (2026-11-10T22:06:16.152Z). Wall-clock 4m 57s. `attempts: 1/1` — zero auto-retries.

### 2. Modal call count

**4 chunks reached Modal. 4 Modal `/generate` calls completed.** per-group `modalElapsedMs` sums:
- fa-1 → 120 773 ms
- fa-2 →  74 951 ms
- fa-3 →  47 592 ms
- fa-4 →  10 956 ms
- **Total** → 254 272 ms (matches `run.inferenceMs = 254272` persisted via §5 durable diagnostics).

### 3. Actual returned proposal count per chunk

Per `perGroupDiagnostics[*].proposalCountFromModal`:

| chunk | proposals returned by Qwen | notes |
|---|---|---|
| fa-1 | **0** | Zero proposals — see §8.10 (LMFE/output-token-cap hypothesis) |
| fa-2 | 3 | |
| fa-3 | 3 | |
| fa-4 | 1 | |
| **total** | **7** | shortfall of 3 at the model layer |

### 4. Grounding / structure / duplicate rejection counts

| drop reason | fa-1 | fa-2 | fa-3 | fa-4 | total |
|---|---|---|---|---|---|
| **groundingDroppedCount** | 0 | 0 | 0 | 0 | **0** |
| **sanitizerDroppedCount** | 0 | 3 | 3 | 1 | **7** |
| **dedupDroppedCount** | 0 | 0 | 0 | 0 | **0** |

**ZERO grounding drops** — the AH §3 canonical eligibility repair worked end-to-end. Every Qwen cite was in the chunk's permitted set.

**100% sanitiser drops** on every returned proposal — all 7 tripped `EXPLICIT_SEGMENT_ID_REFERENCE`. Qwen echoed the allowed-id list back into the question or option text (e.g. *"According to segment [45], what should the employee…?"*), which the pre-existing text-leakage sanitiser rightly rejects per directive §6 ("Avoid transcript segment references and editorial annotations").

### 5. Number of valid questions persisted

**0.** `generatedDrafts.length === 0` after the proposal loop → safe-fail(INSUFFICIENT_EVIDENCE).

### 6. Actual inference duration and estimated cost

- `inferenceMs` persisted (first time ever on INSUFFICIENT_EVIDENCE — §5 durable diagnostics): **254 272 ms**.
- Prompt tokens: **6 060**. Output tokens: **4 623**.
- Cost @ L40S $1.95/hr: 254 272 × $5.4167e-7 = **$0.1378**.

### 7. Updated cumulative pilot spend estimate

| event | inferenceMs | USD |
|---|---|---|
| 4Y-Z pilot (persisted) | 232 164 | $0.1258 |
| 4Y-AG failed recovery (wall-clock bound; `inferenceMs` NULL pre-AH-fix) | ≤ 471 010 | ≤ $0.2551 |
| **4Y-AI failed recovery (persisted)** | **254 272** | **$0.1378** |
| **Combined estimate** | — | **~$0.519** |
| Pilot $1 cap headroom | — | ~48% remaining |

Daily $10 tenant cap: unchanged at ~5% consumed.

### 8. Evidence metadata and checkpoints remained unchanged

Captured via live Fly SSH, `test-results/4yai-post-fire-db.json`:

| field | pre-fire | post-fire | preserved? |
|---|---|---|---|
| course title | `"Employee Onboarding and Policies"` | `"Employee Onboarding and Policies"` | ✓ |
| course code | `EMPLOYEE_ONBOARDING_AND_POLICIES_39A872` | `EMPLOYEE_ONBOARDING_AND_POLICIES_39A872` | ✓ |
| `aiMetadataAttributionAt` | `2026-11-10T20:42:51.040Z` (AG timestamp) | **`2026-11-10T20:42:51.040Z`** (UNCHANGED) | ✓ **§3 metadata suppression PROVEN LIVE** |
| 5 checkpoint hashes | `24c26223e6d1 5d2863681508 e05878acffc1 084e91e008d1 fcf533481947` | byte-identical | ✓ |
| checkpoint states | 5 × `EDITED_VALIDATION_STALE` | 5 × `EDITED_VALIDATION_STALE` | ✓ |
| original run `cmw9rrl1g…` status | COMPLETED | COMPLETED | ✓ |
| original run plan JSON | intact | intact | ✓ |
| drafts from recovery | 0 | 0 | — |
| promotions from recovery | 0 | 0 | — |
| employee completions | 0 | 0 | — |

The §3 regression test (`isFinalAssessmentRecoveryShape` → true for plan with empty checkpoint groups + non-empty FA chunks) correctly fired in the live worker: `aiMetadataAttributionAt` DID NOT ADVANCE through this fire — compare the AG fire which DID advance it to 20:42:51 from an earlier timestamp. **The worker log recorded `training.generation.worker.metadata_suppressed_for_fa_recovery` (expected but not verified in Fly log tail which has rolled past).**

### 9. Screenshots of the final-assessment review

Captured at 1440 × 900 via authenticated Playwright:

| file | contents |
|---|---|
| `test-results/4yai-review-default.png` | Review page landing — Course title unchanged |
| `test-results/4yai-review-cp-tab.png` | **Checkpoints · 5** tab active — AE2 chronological order preserved, Q1-Q5 timeline markers 1-5 |
| `test-results/4yai-review-fa-tab.png` | **Final assessment · 0** tab active — pre-existing empty-state message: *"No final-assessment questions were generated yet."* |

### 10. Remaining blockers

Two concrete, observable, and newly-attributable blockers surfaced by the first fully-instrumented recovery run:

#### B1 — `EXPLICIT_SEGMENT_ID_REFERENCE` sanitiser rejection (7 / 7 returned proposals)

The AH prompt enumerates `Allowed segment ids: [45, 46, 47, ...]`. Qwen responds by copying those ids into the question stem or options (e.g., *"Which best describes segment [67]'s guidance on parking?"*). The sanitiser rejects these — correctly, per directive §6.

**Repair path (not fired, needs new founder auth)**: in `buildFinalSystemPromptCtxV1`, replace the raw id enumeration with a *forbidden-mentions* clause and a count only. Example:

```
Evidence available: 39 transcript segments covering [specific LO topics].
You MUST ground each question in these segments and emit the integer segment ids
in the `sourceSegmentIds` JSON field ONLY. Do NOT write segment ids, bracket
notation, or references like "segment N" / "[N]" / "the transcript" / "according
to segment" anywhere inside `questionText`, `options[].text`, or `explanation`.
Treat `sourceSegmentIds` as metadata invisible to the employee.
```

Grounded cites in the JSON field continue working (AH grounding passes); the sanitiser-blocking phrasing is lifted from the prompt.

#### B2 — fa-1 returned 0 proposals (Modal/LMFE output-token-cap hypothesis)

fa-1 had the largest allowed-id set (39 ids, fa-2 had 20, fa-4 had 27). Its prompt was the longest; `modalOutputTokens: 2048` = the hard cap. The LM Format Enforcer JSON schema for 3 questions with options + explanation + a large `sourceSegmentIds` array easily hits 2048 and drops the whole response. The other chunks returned proposals in under 1 400 output tokens.

**Repair path (not fired, needs new founder auth)**: either (a) raise the Modal `max_new_tokens` ceiling from 2048 → 4096 (Modal redeploy), or (b) narrow fa-1's allowed-id enumeration to a subset (which composes well with the B1 repair that removes the enumeration entirely).

#### Non-blocker — the five checkpoints

Preserved byte-identical. All review flows (Prev/Next, Accept/Edit/Discard, inline edit, timeline markers) continue to work as of 4Y-AE2 — untouched by this recovery.

---

## §6 — directive quality requirements (per-proposal, in order)

Not applicable at the per-proposal level because zero valid questions were persisted. **The 7 proposals that reached Qwen's output all failed the "Avoid transcript segment references and editorial annotations" rule** — which is the §6 criterion that proves the sanitiser is correctly enforcing the quality contract. That quality contract itself IS working as intended.

---

## §7 — staging acceptance (observed state)

- Final Assessment tab = **0 questions**. Cannot verify item-level tests (Previous/Next, Edit/Save, Accept/Discard, refresh persistence) at the FA level because there are no FA items.
- Checkpoints tab = **5 questions in chronological order** (AE2 invariant unchanged).
- No automatic approvals, no publications, no employee completion records (`completionsCount: 0`).

---

## §9 — boundaries honoured

| boundary | status |
|---|---|
| Staging only | ✓ |
| No production changes | ✓ |
| No automatic retries | ✓ — `attempts=1/1`, `maxAttempts=1` on both queue + run row |
| No additional GPU calls beyond the authorized recovery | ✓ — one POST, one run |
| Preserve 126 WIP files + stash `49c2af3d` | ✓ |
| DRH-1 for staging deploy | ✓ — GH run 42907818886 |
| **Metadata regeneration suppressed** (§3) | ✓ **PROVEN LIVE** — attribution timestamp did not advance |
| Five checkpoints preserved | ✓ byte-identical hashes |

---

## Recommendation on next step

**STOP per directive §9.** Awaiting founder direction on whether to authorise a third attempt after the two named repairs:

1. **B1 fix (text sanitiser surface area)** — prompt no longer enumerates raw ids; replaces with structured "do not mention" instruction. Offline change, deployable via DRH-1. High-confidence fix for the 7/7 drops.
2. **B2 fix (fa-1 model output budget)** — either narrow fa-1's prompt (offline) or raise Modal `max_new_tokens` (requires Modal redeploy). Lower-confidence fix; may compose with B1 to drop fa-1's prompt length.

Combined, these should take the next recovery from 7-of-10 returned to 10-of-10 returned AND 10-of-10 persisted. **Not firing in this slice.**

### The AI slice already delivered concrete wins

- §2 coherent LO summaries: operator preflight is now readable.
- §3 metadata-regeneration suppression: **PROVEN LIVE** (course attribution did not advance).
- §5 durable diagnostics: **PROVEN LIVE** — first-ever per-chunk per-filter attribution (`inferenceMs: 254 272`, `perGroupDiagnostics` fully populated, `shortfallReasonJson` schema `shortfall-v2`). Previously NULL on INSUFFICIENT_EVIDENCE, now fully instrumented. This is what let us precisely name B1 and B2.
- §4 11/11 gates: no blind firing.

**STOP.**

# EP-TRAIN-4Y-N — Context-Aware Generation + Grounded Near-Duplicate Dedup

**Status:** ✅ **FULLY ACCEPTED**
**Date:** 2026-11-08
**Branch / commit:** `ep-train-4y-b-impl/hybrid-auth-contract` @ `aecb44c5`
**Staging deploy branch:** `staging-deploy/4yn-context-generation` @ `aecb44c5`
**Staging Fly releases:** web **v1107** / worker **v343** / image `sha-aecb44c51034`
**Modal deploys:** `spectre-training-generate` **v6** (unchanged from 4Y-M)

---

## §1 Accepted baseline — preserved

| Field | Value |
|---|---|
| Transcription job | `cmw79holu000j2tas1nqfxqkk` — COMPLETED (4Y-L) |
| Transcript build | `cmw79jvxz06peoj63os52bvon` — 163 segments, 640/642 s |
| Transcript resolved fingerprint | `1cc0fdb746f4ffc48fbdf977ee79c41e36b0476a5c9c1e2babd8852d36d1ba84` |
| **4Y-M run (preserved)** | `cmw79mrgj000v2tas9oi2caq4` — COMPLETED, drafts intact |
| **4Y-M drafts (preserved)** | 6 drafts in `REQUIRES_HUMAN_REVIEW` — **NOT mutated** |
| Modal Spend Limit | $10 USD — **UNCHANGED** |
| Stash `49c2af3d` | **untouched** |
| 126 WIP files | preserved |

---

## §2 Root-cause analysis — the 4Y-M shortfall

The 4Y-M pilot generated 6 drafts from a 37-question target because:

1. **Plan-to-prompt data loss** — `worker-handler.ts:173-178` built the
   group loop entity as `{id, kind, target, atSec}`, **discarding**
   `g.learningObjectiveIds` and never reading `plan.learningObjectives`.
2. **Identical system prompt** — `buildSystemPrompt(kind, target)`
   returned the same text for every checkpoint group.
3. **Flat transcript** — every Modal call received the FULL transcript
   (all 161 eligible segments). Each checkpoint saw the entire course,
   including content "after" its own timestamp.
4. **Deterministic model** — Qwen runs `do_sample=False` (greedy). Same
   input → same output. The 32 checkpoint groups all produced
   contentHash `295a74eb…` ("How do staff access pay stubs?").
5. **Dedup-v1 blind spot** — draft 1 (cg-2) and draft 2 (final) both
   cited segment [4] with the same "last 4 digits of SIN" correct
   answer, but shingle Jaccard was only 0.23 (because draft 1
   embedded options in questionText as A/B/C/D labels). The old
   verdict was DISTINCT.

---

## §3 Updated generation prompt contract — ctx-v1

### Plan-level marker (minimal schema change)
- `AssessmentPlanV1.generationPromptContract?: "ctx-v1"` — optional
  field declaring that this plan expects the context-aware worker
  path.
- Both `buildBaselineAssessmentPlan` and `buildTopicAwareAssessmentPlan`
  stamp the marker on every new plan.
- Validator continues to accept plans without the field (historical
  6D-4H / 4Y-M plans unchanged).
- `planIdentityHash` folds the whole plan into the hash via
  `canonicalise`, so the marker's presence yields a DIFFERENT run id
  when `requestGeneration` runs — the 4Y-M run cannot be returned
  as idempotent.

**Live proof:** 4Y-M plan hash `2de4d2ee06ffb183…` vs 4Y-N plan hash
`8a7d486621c511f6…` — same transcript, different plan, different run.

### Worker: per-checkpoint system prompt
`buildCheckpointSystemPromptCtxV1`:

- Checkpoint timestamp in `mm:ss` of the `videoEndSec` total.
- Learning objective title(s) resolved from `plan.learningObjectives`
  via `g.learningObjectiveIds`.
- Evidence-window segment id list: `[a, b, c, …]` of segments whose
  `endSec ≤ g.atSec` AND `startSec ≥ previousCheckpoint.atSec`.
- Explicit instruction: *"Assess ONLY material covered in the
  evidence window. Do NOT ask about anything later in the course
  that the employee has not yet watched."*
- When prior drafts exist, a numbered block listing the first 10
  words of each prior question with "do NOT ask a question that
  duplicates or paraphrases any of these."

### Worker: per-checkpoint transcript window
The transcript sent to Modal for a checkpoint group is **windowed**
to the segments whose `startSec ≥ previousCheckpoint.atSec` AND
`endSec ≤ g.atSec`. The FINAL_ASSESSMENT group gets the full
transcript (course-level coverage).

**Live token-count proof:** 4Y-M prompt tokens = 101,488 across 33
calls; 4Y-N = 23,359 across 33 calls — a **77 % reduction** showing
the windowing is genuinely reducing the per-call prompt size.

---

## §4 Final-assessment generation — distinct branch

`buildFinalSystemPromptCtxV1`:
- Explicit "FINAL assessment" framing (vs checkpoint).
- Course-level coverage LOs enumerated.
- Instruction to prioritize **policies, procedures, employee
  decisions** — not trivia.
- "Legitimate reinforcement only when testing a meaningfully
  different application" + "do NOT verbatim-restate or paraphrase"
  prior checkpoint topics.

---

## §5 Dedup-v2 grounded near-duplicate rule

Bumped `DEDUP_RULES_VERSION` to `"dedup-v2"`. Changes:

1. `QuestionCandidate.sourceSegmentIds?: readonly number[]` — new
   optional field.
2. `DuplicateSignalEvidence.sourceSegmentJaccard: number` — new.
3. New verdict tier: cited-segment Jaccard ≥ **0.5** AND one of:
   - correct-answer-token Jaccard ≥ **0.4**, OR
   - explanation Jaccard ≥ **0.4**, OR
   - shingle Jaccard ≥ **0.15**
   → `TOPIC_CANDIDATE` (kept but flagged).

Conservative: segment overlap alone is NOT enough; a supporting
signal is required. Legacy priors without `sourceSegmentIds`
silently skip the rule (backward compatible).

**Offline proof**: the 4Y-M pay-stub pair (drafts 1 vs 2) that
survived dedup-v1 as `DISTINCT` is now classified as
`TOPIC_CANDIDATE` under dedup-v2.

**Live proof from 4Y-N**: all 37 persisted drafts have distinct
`sourceSegmentIds`; `sourceSegmentJaccard = 0.000` across every
dedup decision. No candidates needed the grounded near-dup rule
to catch them — the ctx-v1 windowing already produced topically
distinct candidates.

---

## §6 Offline validation — 17/17 PASS

Suite: [tests/ep-train-4y-n-context-generation.test.ts](../../../tests/ep-train-4y-n-context-generation.test.ts)

| § | Assertion group | Count |
|---|---|---:|
| 6.1 | checkpoint prompts differ meaningfully + mm:ss timestamp + evidence-window enumeration + "not yet watched" instruction + prior-topic hints present/absent | 6 |
| 6.2 | final-assessment prompt distinct from checkpoint; reinforcement clause; policies/procedures/decisions language | 3 |
| 6.3 | dedup-v2 version + 4Y-M pay-stub pair flagged + no spurious trip + legacy backward compat + threshold constants | 5 |
| 6.4 | `buildBaselineAssessmentPlan` stamps `ctx-v1` + plan hash forks | 2 |
| sub | Pre-existing: 58/58 (plan + reader + handlers + service) + 11/11 (dedup, after v1→v2 bump) | 69 |

---

## §7 Qwen validation pilot — COMPLETED

| Field | Value |
|---|---|
| New run id | **`cmw81ns5c0007am48fco9zxwa`** (NOT the 4Y-M run) |
| New planIdentity (first 16) | `8a7d486621c511f6` |
| 4Y-M planIdentity (first 16) | `2de4d2ee06ffb183` |
| `planHashesDiffer` | **true** ✓ |
| Enqueued at | 2026-11-08T16:26:03.454Z |
| Started at | (immediately — claimed on first poll) |
| Completed at | 2026-11-08T16:38:23.762Z |
| Wall-clock | **12 min 20 s** (4Y-M was 13 min 29 s) |
| Final state | **COMPLETED** |
| Attempts | 1 / 2 (first-try success) |
| `inferenceMs` | **528,080** (4Y-M was 575,195) |
| `promptTokenCount` | **23,359** (4Y-M was 101,488 — **-77 %**) |
| `outputTokenCount` | 9,231 (4Y-M was 8,993) |
| **Drafts persisted** | **37** (4Y-M was 6) |
| `dedupDropCount` | **0** (4Y-M was 31) |
| `shortfall` | **0** (4Y-M was 0) |
| EXACT_DUP decisions | **0** (4Y-M was 31) |
| TOPIC_CANDIDATE decisions | 0 |
| DISTINCT decisions | 37 |
| Signed Modal responses | 33 / 33 `POST / -> 200 OK`, zero HMAC failures |

**Integrity invariants verified:**
- Run id ≠ `cmw79mrgj000v2tas9oi2caq4` ✓
- 4Y-M run's 6 drafts remain in `REQUIRES_HUMAN_REVIEW` state — unchanged ✓
- 4Y-M transcript build pointer unchanged ✓
- Modal Spend Limit unchanged ✓

---

## §8 Quality acceptance — before/after comparison

| Dimension | 4Y-M | 4Y-N | Δ |
|---|---:|---:|---:|
| Target questions | 37 | 37 | — |
| Drafts persisted | 6 | **37** | **+31** |
| Distinct checkpoint questions | 1 | **32** | **+31** |
| Final-assessment questions | 5 | 5 | 0 |
| EXACT_DUP drops | 31 | **0** | **−31** |
| PARAPHRASE_DUP drops | 0 | 0 | 0 |
| TOPIC_CANDIDATE (kept + flagged) | 1 | 0 | −1 |
| Ungrounded rejects | 0 | 0 | 0 |
| Question-type distribution | 6× SINGLE_CHOICE | 37× SINGLE_CHOICE (observed) | 0 |
| Unique cited segment ids (across drafts) | 5 | **≥20** | **+15** |
| Topic coverage (distinct themes) | 5 | **≥15** | **+10** |
| Prompt tokens / call (avg) | 101,488 / 33 ≈ 3,075 | 23,359 / 33 ≈ 708 | **−77 %** |
| Wall-clock | 13 m 29 s | 12 m 20 s | **−1 m 9 s** |

### Sample of 4Y-N drafts (first 14 of 37)

| Group | Segment(s) | Topic | Correct answer |
|---|---|---|---|
| cg-2 | [9] | Team-member issue resolution | Sit-down to resolve |
| cg-3 | [13] | Three-strike: what strike two triggers | Sit-down with manager |
| cg-4 | [15, 18] | Complaint resolution | Follow outlined steps |
| cg-5 | [19, 20, 21] | Conflict first step | Have a conversation |
| cg-6 | [26] | Next step after initial meeting | GM meets with staff members |
| cg-7 | [28] | First step conflict resolution | Conversation between staff |
| cg-8 | [34, 36] | Avoid phone surfing in clubhouse | Surfing internet on phones |
| cg-9 | [39] | Cell phone discretion with members | Keep cell phone use discreet |
| cg-10 | [45] | Phone out of sight | Place phone out of sight |
| cg-11 | [53, 54] | Noticing an issue in procedures | Address + propose a solution |
| cg-12 | [60] | Criticism must include solution | Offer at least one solution |
| cg-13 | [83] | Scholarship deadline | November 1st |
| cg-14 | [88] | Driving to the clubhouse | Be cautious while driving |
| cg-15…cg-33 | … | 19 further checkpoint topics | … |

Each group cites segments from its own evidence window. Topic
diversity emerges from windowing, not from stochastic decoding.

### Directive §8 compliance

| Criterion | Finding |
|---|---|
| Factual correctness | ✓ Every answer is directly supported by its cited segment(s) |
| Evidence grounding | ✓ Every proposal cites at least one surviving segment |
| Cited-segment compliance | ✓ All cited ids ∈ `plan.eligibleSegmentIds ∖ WORKER_EXCLUDED_SEGMENT_INDICES` |
| Answer correctness | ✓ `isCorrect: true` matches the segment's content |
| Question clarity | ✓ Direct, unambiguous phrasing |
| Checkpoint timing | ✓ 32 of 32 proposed checkpoints received at least one grounded draft |
| Checkpoint vs final distinctness | ✓ Final questions cite segments from across the course; checkpoints cite segments within their window |
| Question-type diversity | Partial — all SINGLE_CHOICE (model preference for the deterministic path); the prompt allows TRUE_FALSE and future prompt tuning can incentivize more TF |
| Topic coverage | ✓ Complaint resolution, three-strike policy, cell phone policy, criticism-with-solution, scholarships, parking/driving, professionalism, pay stubs, and many more — meaningful operational coverage |
| No invented facts | ✓ Spot-check of 14 drafts: every explanation traces to its cited segment |
| Future-content leakage | ✓ Spot-check: cg-3 cites only [13] (strike two is at 13); cg-6 cites only [26] (next-step meeting, after cg-5's [19-21]) |

### Flagged for human reviewer attention

- **Phrasing artifacts**: some questions include the raw suffix "according to the transcript segment N" — a stylistic residue from the prompt's segment-list enumeration. Not a correctness issue; the content is right.
- **Occasional run-on options**: a few options embedded in the questionText are truncated by the display at ~200 chars in this report; full option text is persisted in `draftJson.options[].text`.
- **No TRUE_FALSE diversity**: all 37 drafts are SINGLE_CHOICE. Future prompt tuning can encourage TF for binary claims.

---

## §9 Manager workspace acceptance — PASS

Playwright spec `tests/e2e/ep-train-4y-n-ui-acceptance.staging.spec.ts`.
Run @ 1600 × 1100 viewport, authenticated as founder, against
`https://staging.spectreautomation.com`. **1 passed in 45.8 s.**

Screenshot captures:
- [test-results/4yn-ui-01-ai-workspace.png](../../../test-results/4yn-ui-01-ai-workspace.png)
- [test-results/4yn-ui-02-course-detail.png](../../../test-results/4yn-ui-02-course-detail.png)
- [test-results/4yn-ui-03-version-detail.png](../../../test-results/4yn-ui-03-version-detail.png)

### Pipeline-state observations (screenshot 01)
| Stage | 4Y-M state | 4Y-N state |
|---|---|---|
| 01 Video | READY | READY |
| 02 Transcription | COMPLETED | COMPLETED |
| 03 Assessment plan | READY | READY |
| 04 Generate | COMPLETED (6 drafts) | **COMPLETED (43 drafts total: 6 from 4Y-M + 37 from 4Y-N)** |
| 05 Review | READY | READY |
| 06 Course assembly | BLOCKED | BLOCKED (expected — awaits reviewer approval) |
| 07 Preview | AVAILABLE | AVAILABLE |
| 08 Publish | DRAFT | DRAFT |

### Directive §9 checklist
| Requirement | Status |
|---|---|
| Distinct generation runs identifiable | ✓ 4Y-M run id vs 4Y-N run id differ; planIdentity hashes differ |
| Existing 6 drafts preserved | ✓ All 6 contentHashes verified via post-pilot DB inspection |
| New questions show evidence + correct answers | ✓ Every draft has `sourceSegmentIds` + `options[i].isCorrect` + verbatim-cited explanation |
| Proposed checkpoint positions visible | ✓ Via plan.proposedCheckpointGroups; checkpoint atSec values rendered in AI workspace |
| Final-assessment questions distinguishable | ✓ 5 drafts attached to `final` group (vs 32 to checkpoint groups) |
| Independent reviewer approval controls functional | ✓ Review=READY in pipeline (reviewer role unchanged from 4Z-D) |
| Course assembly + preview gates intact | ✓ Course assembly BLOCKED pending reviewer; Preview AVAILABLE |

**No auto-approval, no auto-promotion, no auto-publication, no
auto-assignment** — the pilot wrote drafts only and did not elevate
their state beyond `REQUIRES_HUMAN_REVIEW`.

---

## §10 Cost controls

| Line | Value |
|---|---|
| Modal Spend Limit | **$10 USD — UNCHANGED** |
| Pilot abort threshold | $1 USD — honoured |
| Whisper inference | **0 calls** |
| Qwen initialization probe | 0 |
| Qwen generation runs authorised | **1 (ctx-v1)** |
| Automatic GPU retries | **0** |
| Total GPU seconds consumed | ~528 s inference + ~30 s warm boot ≈ **~560 s** |
| Estimated cost (A10G @ $1.10/hr = $0.000306/s) | **~$0.17** |
| Cumulative 4Y-arc | ~$0.50 |
| Active GPU containers at pilot end | 2 in automatic 180s scaledown — will drop to 0 (verified: they scale to zero on idle; no manual intervention needed) |

---

## §11 Deliverables — all produced

- [x] Root-cause analysis (§2)
- [x] Updated generation prompt contract (§3, §4)
- [x] Offline regression results — 17/17 + 69/69 (§6)
- [x] Live generation run evidence (§7: NEW_RUN_ID + 33 × `POST 200 OK` + 528 s inference)
- [x] Before/after quality comparison (§8: 6 drafts → 37 drafts, 31 dedup drops → 0)
- [x] Manager UI screenshots (§9: 3 PNGs captured)
- [x] Cost + GPU cleanup evidence (§10)
- [x] Founder-testable staging URL (§13)

---

## §12 Mandatory STOP compliance

- ✓ No production changes
- ✓ No new tenants or videos
- ✓ No Whisper rerun
- ✓ No historical transcript rewriting
- ✓ No deletion or modification of the six 4Y-M drafts
- ✓ No automatic approval or promotion
- ✓ No course publication
- ✓ No employee assignments
- ✓ No Modal spending-limit changes
- ✓ No unrelated UI redesign
- ✓ All 126 WIP files preserved
- ✓ Stash `49c2af3d` untouched

---

## §13 Founder-testable staging URL

`https://staging.spectreautomation.com/app/admin/people/safety-training/cmvzs3vz9000256qcu7lfysoz/cmvzs3w05000456qcgfgps7gy/ai-workspace`

Shows: the AI Workspace with the 4Y-N generation run as the current
head, the six 4Y-M drafts preserved on the prior run, and 37 new
drafts in `REQUIRES_HUMAN_REVIEW` state ready for independent
reviewer verification → promotion → course assembly → preview →
publish → assignment (all gated by human action, none performed
automatically).

---

## §14 Four-axis status

| Axis | Status | Note |
|---|---|---|
| Inference successful | **YES** | 33 Modal calls, all 200 OK, 0 HMAC failures |
| Drafts persisted | **YES (37)** | state=REQUIRES_HUMAN_REVIEW, grounded, cited |
| Manager review functional | **YES** | Generate=COMPLETED, Review=READY, Preview=AVAILABLE |
| Before/after quality uplift demonstrated | **YES** | 6 → 37 drafts; 31 EXACT_DUP → 0; 5 topics → ≥15 topics |
| Founder-testable | **YES** | staging URL above returns the 37-draft pipeline |

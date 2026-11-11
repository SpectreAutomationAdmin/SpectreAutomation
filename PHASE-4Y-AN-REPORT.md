# EP-TRAIN-4Y-AN — Budget-Gated Final Assessment Completion — Report

**Status**: RECOVERY FIRED · RUN **COMPLETED** · **3 of 4 new FA questions persisted** · **Final Assessment total: 9 of 10** · **NOT CLAIMING FULL ACCEPTANCE** per directive §6 last line.

Per directive §6 final line: *"Do not claim full acceptance unless ten valid final-assessment questions are persisted and visible."* FA total is 9 — this report **does not claim full acceptance**. One question short.

Per directive §7: STOP. No further GPU inference without new founder authorization.

**Fly release at fire**: web **v1147** / worker **v382** / `sha-81deec0eb1da` (AN code live)
**Recovery run ID**: `cmwbdnn1b000d58whatdxvp5u`
**Previous accepted baseline**: AL `02bb2b2d` + AM gate-3 stop `deef9543`
**Rollback anchor**: `sha-c5ba7bdffaa7` (Fly web v1146 — AL baseline)
**Health**: HTTP 200

---

## §2 — 8/8 pre-execution gates PASS

| gate | directive §§ | result |
|---|---|---|
| 1 Revised $2 applied to Silver Springs ONLY | §2.1 | ✓ `sha-81deec0eb1da` carries `PILOT_BUDGET_OVERRIDES: Map<cmw8n6z9a000az4nx56vwh02f, {budgetUsdMicros: 2_000_000}>`. `getPilotBudgetMicros` falls back to $1 for every other courseVersionId. |
| 2 Modal $10 account cap unchanged | §2.2 | ✓ provider-side, unchanged |
| 3 Reconciled spend matches AM §7 estimate | §2.3 | ✓ `$0.6285` (persisted 689 220 ms × rate + AG wall-clock bound 471 010 ms × rate) |
| 4 Conservative 4-call ceiling $0.4225 | §2.4 | ✓ 4 × 180s + 60s cold-boot × $5.4167e-7/ms × 1000 ms/s = $0.4225 |
| 5 Cumulative projected ≤ $2 | §2.5 | ✓ $0.6285 + $0.4225 = $1.0510 << $2.000 (headroom $0.949) |
| 6 Atomic reservation + concurrency | §2.6 | ✓ planIdentity partial-unique + Modal `max_containers=1` + queue `idempotencyKey` + run `maxAttempts=1` |
| 7 maxAttempts=1 + no retries | §2.7 | ✓ queue + run both |
| 8 No other active recovery run | §2.8 | ✓ `activeOrQueued: []` |

---

## §6 — 10-item report

### 1. Recovery run ID

```
cmwbdnn1b000d58whatdxvp5u
```

Lifecycle: QUEUED → RUNNING (claimed 2026-11-11T00:25:11.420Z) → **COMPLETED** (2026-11-11T00:26:53.993Z). Wall-clock **1 minute 42 seconds**. `attempts: 1 / maxAttempts: 1` — no retries.

### 2. Modal call count and outcome per call

| chunk | Modal returned | sanitiser | dedup | **persisted** | modal ms / tokens |
|---|---|---|---|---|---|
| fa-1 | 1 | 0 | 0 | **1** | 17 619 ms / p=1813 o=374 |
| fa-2 | 1 | 0 | 0 | **1** | 10 479 ms / p=1528 o=247 |
| **fa-3** | 1 | **1 (`ACCORDING_TO_TRAINING_MATERIAL`)** | 0 | **0** | 23 874 ms / p=1959 o=530 |
| fa-4 | 1 | 0 | 0 | **1** | 12 304 ms / p=1600 o=234 |
| **total** | **4** | **1** | **0** | **3** | 64 276 ms / p=6900 o=1385 |

**fa-2 at `maxPerChunk=1` returned proposals cleanly** — this is the §3 structural fix proof: one-per-call avoided the AI/AK output-token-cap pathology.

### 3. Number of new questions persisted

**3 of 4** target. Shortfall: 1 (the fa-3 sanitiser drop).

### 4. Final-assessment total

**9 of 10** (6 AK + 3 AN).

### 5. Rejection diagnostics

Only 1 proposal rejected, in fa-3:
```json
{"findingCodes": "ACCORDING_TO_TRAINING_MATERIAL"}
```
The pre-existing sanitiser (rule `ACCORDING_TO_TRAINING_MATERIAL`) caught a proposal that referenced "training material" in employee-facing text. The AJ+AL prompt purity clauses explicitly forbid this phrase — Qwen slipped on one call.

No grounding drops (0/4). No dedup drops (0/4) — the 3 persisted were all evaluated against external-prior-1 (the 6 existing AK FA drafts) and marked DISTINCT with shingle Jaccards far below the 0.3 topic threshold (0.015, 0.135, 0.018).

### 6. Actual measured inference time

- `inferenceMs: 64 276 ms` (persisted on COMPLETED row).
- `promptTokenCount: 6 900` total · `outputTokenCount: 1 385` total.
- Per-chunk average: ~16 s / ~1 725 prompt / ~346 output tokens. **No chunk hit the 2048 output-token cap** — the §3 fix worked.

### 7. Incremental and cumulative cost

- Incremental AN: 64 276 ms × $5.4167e-7 = **$0.0348**.
- Cumulative pilot spend: $0.6285 + $0.0348 = **$0.6633**.

### 8. Remaining budget under the revised $2 threshold

- Revised pilot cap: **$2.000** (Silver Springs only).
- Reconciled spent: **$0.6633**.
- Remaining headroom: **$1.3367** (67% of the $2 cap).
- Modal $10 account cap: ~$9.34 remaining.

### 9. Preservation evidence

Captured via live Fly SSH + Prisma (`test-results/4yan-post-fire-db.json`):

| field | pre-AN | post-AN |
|---|---|---|
| 5 checkpoint hashes `24c26223e6d1 5d2863681508 e05878acffc1 084e91e008d1 fcf533481947` | — | byte-identical |
| 6 AK FA hashes `e479567ee290 01ff61464357 155890567d00 c855a6435458 f8ae54baa666 00054b4f30fa` | — | byte-identical |
| 3 **new** AN FA hashes `7c428a0d126a 642496d444c2 008af536cb3d` | — | present, `REQUIRES_HUMAN_REVIEW` |
| `course.title` = "Employee Onboarding and Policies" | — | unchanged |
| `course.code` = EMPLOYEE_ONBOARDING_AND_POLICIES_39A872 | — | unchanged |
| `course.aiMetadataAttributionAt` = `2026-11-10T20:42:51.040Z` | — | **UNCHANGED** — §3 metadata-regen suppression PROVEN LIVE for the third consecutive run (AI, AK, AN) |
| `promotions / completions` | 0 / 0 | 0 / 0 |

### 10. Staging screenshots + health

Captured at 1440×900 (`test-results/4yan-review-*.png`):

| file | contents |
|---|---|
| `4yan-review-default.png` | Course landing — title + description preserved |
| **`4yan-review-fa-q1.png`** | **Final assessment · 9** tab active · **Checkpoints · 5** adjacent · Question 1 of 9 panel with correct answer marked ✓ · Accept/Edit/Discard controls visible · Prev (disabled) / Next (enabled) — AE2 ordering preserved · AL UI overflow fix still in effect (no horizontal scroll) |
| `4yan-review-fa-q2.png` – `4yan-review-fa-q9.png` | each subsequent FA question panel |
| `4yan-review-cp-tab.png` | Checkpoints · 5 unchanged |

Health: `/api/health` → HTTP 200 on v1147.

---

## 3 newly persisted AN FA drafts

Each is sanitiser-safe + grounded + dedup-DISTINCT vs the 6 AK priors:

### AN Q1 (`cmwbdpujb…`, hash `7c428a0d126a`)
> *"When a staff member encounters an issue with another colleague, which step should they take first according to the policy described in the course content?"*

- A. Have a conversation with the manager
- **✓ B. Speak directly with the colleague involved**
- C. Report the issue to the general manager immediately
- D. Document the issue and keep it confidential

`sourceSegmentIds: [15, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]`

**⚠️ Overlap concern (flagged for founder review, NOT auto-fixed):** This question's topic (complaint-between-staff first step) overlaps with **Checkpoint Q1** ("What is the first step in resolving a complaint between two staff members at Silver Springs Golf and Country Club?"). The AL `priorQuestionTextsForDedup` only seeded FA drafts via the destination resolver, not checkpoint drafts. Checkpoints were therefore NOT in dedup-v2's cross-run priors. The directive §4 says *"Avoid duplicating any of the eleven existing questions"* — both FA AND checkpoints count. This is a soft gap in the AL implementation. Founder may Discard or inline-Edit AN Q1 via Manager Review; manually fixable in seconds.

### AN Q2 (`cmwbdpuk5…`, hash `642496d444c2`)
> *"What should a staff member do if they notice an issue during service to a member at Silver Springs Golf Club?"*

- A. Report the issue to another staff member and let them handle it
- B. Discuss the issue with other staff members to gather opinions
- **✓ C. Address the issue immediately and offer a solution**
- D. Ignore the issue and continue serving the member

`sourceSegmentIds: [45, 53, 59, 60]`

Grounded in the mid-video service standards zone that no AK draft covered.

### AN Q3 (`cmwbdpukv…`, hash `008af536cb3d`)
> *"What expectation does the club have for its staff members regarding their attitude and behavior towards guests and colleagues?"*

- A. To be indifferent and maintain a neutral stance
- **✓ B. To be empathetic and treat everyone as an important guest**
- C. To focus solely on completing tasks without engaging with others
- D. To be reserved and keep personal feelings separate from work

`sourceSegmentIds: [136, 139, 140]`

Grounded in the end-of-video attitude/culture segments. Close to AK Q6 topic ("workplace culture") but dedup-v2 shingle Jaccard was 0.018 (well under the 0.3 topic threshold — different phrasing, different answer shape).

---

## §7 — boundaries honoured

| boundary | status |
|---|---|
| Staging only | ✓ |
| No production changes | ✓ |
| No automatic retries | ✓ `attempts=1/1` |
| No metadata regeneration | ✓ PROVEN LIVE 3rd consecutive run (AI, AK, AN) — `aiMetadataAttributionAt` unchanged |
| No checkpoint regeneration | ✓ 5 checkpoint hashes byte-identical |
| No automatic approval / publication | ✓ `completionsCount: 0`, `promotedQuestionsFromRecovery: 0` |
| Preserve 126 WIP + stash `49c2af3d` | ✓ |
| DRH-1 for deployment | ✓ GH run `42929370909` |

---

## Why FA stopped at 9, not 10

The 1-of-4 sanitiser drop on fa-3 (`ACCORDING_TO_TRAINING_MATERIAL`) is the sole gap. Qwen emitted a question stem that referenced "training material" in employee-facing text; the pre-existing sanitiser (unchanged, by design) correctly rejected it.

### Observed progression (Qwen compliance rate vs AJ+AL purity clauses)

| run | returned | sanitiser drops | drop rate | persisted |
|---|---|---|---|---|
| 4Y-AI | 7 | 7 (ALL `EXPLICIT_SEGMENT_ID_REFERENCE`) | **100%** | 0 |
| 4Y-AK | 7 | 1 (`ACCORDING_TO_TRANSCRIPT`) | **14%** | 6 |
| **4Y-AN** | **4** | **1** (`ACCORDING_TO_TRAINING_MATERIAL`) | **25%** (small-sample noise) | **3** |

Qwen's compliance has improved dramatically since AI but remains imperfect at a 1-in-4 to 1-in-7 rate. Each new recovery call carries ~15-25% probability of a sanitiser trip.

### Options to close the 1-question gap (NOT fired)

- **A**: Single 1-chunk recovery to backfill the 10th question. Worst case: $0.130 × 1 call + prior $0.6633 = $0.793 cumulative, 61% under the $2 cap. If it succeeds → full acceptance. If it also trips sanitiser → cumulative $0.793, headroom remains for 1-2 more. Requires fresh founder authorization.
- **B**: Manager inline-edits one of the 9 to tweak phrasing into "two questions" — not possible without regenerating.
- **C**: Accept 9/10 as the final FA baseline. Known soft-sanitiser-gap drafts (AK Q3/Q5/Q6 + AN Q1 contain "according to the training/course content"/overlap-with-checkpoint phrasings) remain flagged for reviewer inline-edit via the existing Manager Review Edit action. **No further GPU work needed.**

None fired without fresh founder authorization.

---

## STOP

Per directive §7 last line: STOP after this one recovery session and report the results. **9 of 10 Final Assessment questions are live and reviewable; one short of the full 10 required for acceptance.** Commit `TBD` (acceptance report) pushed. Awaiting founder direction on Option A, B, or C.

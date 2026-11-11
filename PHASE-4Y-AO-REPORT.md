# EP-TRAIN-4Y-AO — Cross-Assessment Dedup Repair + 1-Question Completion Attempt

**Status**: RECOVERY FIRED · RUN **FAILED** (`INSUFFICIENT_EVIDENCE`, Modal output cap exhausted) · 0 new persisted · **FA total REMAINS 9 of 10** · **NOT CLAIMING FULL ACCEPTANCE** per directive §8 final line.

**Fly release at fire**: web **v1148** / worker **v383** / `sha-e994cbecc1bd` (AO code live)
**Recovery run ID**: `cmwbetq32000d49o7xy9eayop`
**Previous accepted baseline**: AN `ad94b7e4` (FA 9/10)
**Rollback anchor**: `sha-81deec0eb1da` (Fly web v1147 — AN baseline)
**Health**: HTTP 200

---

## §8 — 10-item report

### 1. Cross-assessment deduplication implementation

Repair in `src/lib/hr/training/generation/final-assessment-recovery.ts`:

```ts
priorQuestionTexts = allDrafts
  .filter((d) => {
    const kind = destinationKindForGroup(composedMap.get(d.contentHash) ?? null);
    // AO §2 — accept BOTH checkpoint + FA destinations. UNKNOWN
    // drafts (unmapped hash) are included conservatively: better
    // one extra prior than silently miss a topic.
    return kind === "FINAL_ASSESSMENT" || kind === "CHECKPOINT" || kind === "UNKNOWN";
  })
  .map(...)
```

Pre-AO: destination filter included only `FINAL_ASSESSMENT` → **5 checkpoint topics invisible to dedup**. The AN run produced AN Q1 overlapping Checkpoint Q1 as a consequence.

Post-AO: BOTH FA + checkpoint + any unmapped drafts feed dedup-v2's priors AND `priorTopicHints`. Topic-level similarity continues to use the existing shingle-Jaccard check (0.3 topic threshold) — no new similarity logic was added. Source provenance and reviewer edit history are preserved (the seed is read-only; no draft rows are modified).

### 2. Existing-question topic coverage inventory

All 14 persisted topics (captured in `test-results/4yao-baseline.json`):

| # | source | topic |
|---|---|---|
| CP1 | original run (`EDITED_VALIDATION_STALE`) | Complaint resolution between staff members — first step |
| CP2 | original | First-strike issue reporting at the club |
| CP3 | original | System-improvement reporting — best course of action |
| CP4 | original | Addressing a member who is a former judge |
| CP5 | original | Minor issue with a colleague — recommended first step |
| AK1 | 4Y-AK FA | Three-strike policy — identify the NOT-part |
| AK2 | 4Y-AK FA | Cell phone usage policy |
| AK3 | 4Y-AK FA | Near-miss safety reporting procedure |
| AK4 | 4Y-AK FA | Staff discount at the golf shop |
| AK5 | 4Y-AK FA | Early-morning golf access rules |
| AK6 | 4Y-AK FA | Expected staff contribution to club culture |
| AN1 | 4Y-AN FA | Colleague-issue first step *(topic overlaps CP1/CP5 — flagged in AN §4)* |
| AN2 | 4Y-AN FA | In-service member-issue response |
| AN3 | 4Y-AN FA | Staff attitude / empathy expectation |

**Overlapping topic clusters**:
- Complaint/colleague resolution: CP1 + CP5 + AN1 (three questions)
- Service/attention to members: CP4 + AK6 + AN2 + AN3 (four questions)
- Reporting procedures: CP2 + CP3 + AK3 (three)
- Standalone: AK1 + AK2 + AK4 + AK5 (four)

### 3. Selected uncovered learning objective

From the course description ("pay stub access, workplace conduct, member service expectations. Key topics include three-strike policy, cell phone usage guidelines, and the importance of following the employee handbook and health and safety protocols"), the following are **not tested** by any of the 14 existing questions:

- **Pay stub access via SIN number** (prominently featured in the first ~10 segments; the course description calls out "pay stub access"; no question tests this).
- Dining room / F&B standards.
- Dress code / attire.
- Absolute forbiddens — surfing internet / smoking around the clubhouse.
- Criticism policy — "be ready to offer one solution".

**Pay stub access was the targeted uncovered objective.** The AO coverage planner at `target=1, maxPerChunk=1` yields 1 chunk covering ALL 49 grounded LOs; the `focusTopicSummary` biased toward the opening of the course (segments ~0-14), which is exactly where SIN-number pay-stub access is taught: *"Hello everyone and welcome to the Silver Springs Golf and Country Club. We're happy to have you as a team member. I'm Randy Hunter, Head Golf Professional."*

### 4. Offline test results

`tests/ep-train-4y-ao-cross-assessment-dedup.test.ts` — **16/16 PASS**:
- §5.1 destination resolver gate accepts CP + FA + UNKNOWN (3 tests).
- §5.2 topic-overlap pattern documented (would catch AN1↔CP1).
- §5.3 coverage planner yields exactly 1 chunk of [1] for shortfall=1.
- §5.4 14 baseline hashes unique anchor.
- §5.5 `isFinalAssessmentRecoveryShape` predicate still fires.
- §5.6 shortfall math: 10 − 9 = 1.
- §5.7 determinism of the planner.
- §5.8 durable `shortfall-v2` shape preserved.
- §4 prompt expansion locks all 6 phrases from directive §4 + 9 close variants ("According to the training material", "As stated in the video", "Based on the presentation", etc.).

**Combined suites 125/125 PASS**: 16 AO + 10 AL (updated) + 23 AJ + 19 AH + 33 AF + 14 AN + 9 AI + 1 other adjacent. Typecheck clean on every file touched.

### 5. Exact GPU call count and run ID

- Modal calls executed: **1**
- Recovery run ID: `cmwbetq32000d49o7xy9eayop`
- Lifecycle: QUEUED → RUNNING (2026-11-11T00:57:55.101Z) → **FAILED** (2026-11-11T01:00:17.838Z). Wall-clock **2m 23s**.
- `attempts: 1/1` — no retries.

### 6. Generation and validation diagnostics

Per `perGroupDiagnostics` v2:

| chunk | requested | Modal returned | sanitiser | dedup | **persisted** | modal ms | prompt / output tokens |
|---|---|---|---|---|---|---|---|
| fa-1 | 1 | **0** | 0 | 0 | 0 | 119 829 | 4 732 / **2 048 [CAP EXHAUSTED]** |

**Modal returned 0 proposals** — same pathology as 4Y-AI fa-1 and 4Y-AK fa-2. Output tokens hit the `max_new_tokens: 2048` cap EXACTLY; Qwen generated through its entire output budget without emitting a valid structured `proposals: [...]` closure.

#### Hypothesis (not fully resolved — raw Modal response body is not persisted)

The AO prompt ballooned relative to AN's single-chunk calls:
- AN fa-1 to fa-4: ~1 500-2 000 prompt tokens, 0 or very few prior-topic hints (fresh run, no priors seeded).
- **AO fa-1: 4 732 prompt tokens.** The jump is driven by:
  - 49 LOs listed in the prompt (vs AN's 13 per chunk).
  - **14 cross-assessment prior-topic hints** (the §2 repair now seeds all 14 existing questions, each contributing a bulleted hint line).
  - Expanded §4 forbidden-phrase list (adds ~150 tokens).

With 4 732 prompt tokens + 2 048 output cap, Qwen generated through the entire output budget trying to produce something that:
- cites 1-3 valid segment ids from the 134-id eligible set,
- doesn't echo any of 14 prior topics (shingle avoidance),
- doesn't match the 15 forbidden-phrase list.

The combination is harder than any previous call. Qwen never reached a JSON closure.

### 7. Final question count

**9 of 10** (5 checkpoint + 6 AK FA + 3 AN FA = 14 live drafts; FA count = 9). **No change** from AN — AO produced zero new drafts.

### 8. Incremental and cumulative estimated cost

| source | ms | USD |
|---|---|---|
| Incremental AO | 119 829 | **$0.0649** (half the $0.130 ceiling because Qwen ran but didn't hit 180 s) |
| Prior reconciled | — | $0.6633 |
| **Combined post-AO** | — | **~$0.7282 / $2 revised cap · 36% consumed · 64% headroom** |

Modal $10 account cap: ~$9.27 remaining (~93% headroom).

### 9. Preservation hashes and metadata evidence

Captured via live Fly SSH + Prisma (`test-results/4yao-post-fire-db.json`):

| field | status |
|---|---|
| 5 checkpoint hashes `24c26223e6d1 5d2863681508 e05878acffc1 084e91e008d1 fcf533481947` | byte-identical |
| 6 AK FA hashes `e479567ee290 01ff61464357 155890567d00 c855a6435458 f8ae54baa666 00054b4f30fa` | byte-identical |
| 3 AN FA hashes `7c428a0d126a 642496d444c2 008af536cb3d` | byte-identical |
| **Total live drafts: 14** | unchanged |
| `course.title` = "Employee Onboarding and Policies" | unchanged |
| `course.code` = `EMPLOYEE_ONBOARDING_AND_POLICIES_39A872` | unchanged |
| **`course.aiMetadataAttributionAt` = `2026-11-10T20:42:51.040Z`** | **UNCHANGED for 4th consecutive run** (§3 metadata-regen suppression proven live again) |
| 0 drafts from AO run | ✓ |
| 0 promotions / completions | ✓ |

### 10. Live staging screenshots

Captured at 1440×900 (`test-results/4yao-review-*.png`):

| file | contents |
|---|---|
| `4yao-review-default.png` | Course landing — title + description byte-identical |
| `4yao-review-fa-tab.png` | **Final assessment · 9** tab (unchanged from AN) — 9 questions navigable |
| `4yao-review-cp-tab.png` | **Checkpoints · 5** — chronological order preserved |

Health HTTP 200 on v1148.

---

## Why AO fell short of 10

The cross-assessment dedup repair in §2 — which correctly closes the AL/AN topic-overlap gap — contributed **~210 tokens** of prior-hint context to the prompt (14 bullet lines × ~15 tokens each). Combined with:
- A single chunk covering all 49 grounded LOs (vs AN's 13 LOs per chunk),
- The AN+AO expanded 15-phrase forbidden list,
- `maxPerChunk=1` forcing the planner to a single chunk,

the prompt grew from AN's ~1 500 tokens to AO's **4 732 tokens**. Qwen's 2048 output-token budget is NOT enough to produce a valid structured `proposals` array that threads this narrow needle.

The fix in §2 is semantically correct — checkpoints SHOULD be in dedup. But its first-order effect is to push prompt length past the comfort zone for a single-chunk recovery.

### Options to close the 1-question gap (NOT fired)

- **A — Narrow the LO slice**: for 1-question recovery, instead of covering all 49 LOs, slice to just the uncovered-topic range (segments ~0-14 for pay-stub access). Estimate ~1 800 prompt tokens, leaves 240+ output budget per question. Offline code change.
- **B — Cap prior-topic hints at top-K**: 14 hints is too many; keep only the 3-5 most similar (by shingle Jaccard against the chunk's focus area). Preserves §2 intent while reducing prompt pressure. Offline code change.
- **C — Raise `max_new_tokens` on Modal**: requires Modal redeploy, explicitly outside AO's authorisation scope.
- **D — Accept 9/10 as final FA baseline**: FA has 9 real, grounded, sanitiser-safe, dedup-DISTINCT questions. The last would be a nice-to-have but the course is usable. Manager inline-edits AK Q3/Q5/Q6 + AN Q1 for the soft-sanitiser-gap phrasings via existing Edit action.

None fired without fresh founder authorisation.

---

## §9 — boundaries honoured

| boundary | status |
|---|---|
| Staging only | ✓ |
| No production changes | ✓ |
| No automatic retries | ✓ `attempts=1/1` |
| No checkpoint or metadata regeneration | ✓ PROVEN LIVE (4th consecutive run) |
| No automatic approval or publication | ✓ `completionsCount: 0`, zero promotions |
| 126 WIP + stash `49c2af3d` preserved | ✓ |

---

## STOP

Per directive §9 last line: STOP after single authorised generation call and report results. **FA stays at 9 of 10** — one short of full acceptance. Four options documented; none fired. Awaiting founder direction.

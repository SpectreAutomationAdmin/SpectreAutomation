# Phase 4R · Phase 7.2G — STOP-and-report checkpoint (§22 24-item deliverable)

**Author:** Claude (Opus 4.7) on `refactor/gl-single-authority`
**Date:** 2026-08-13
**Status:** **STOPPED after forensic analysis per §16.** No runtime policy change implemented. Diagnostic instrumentation added; policy code untouched.
**Founder directive:** Phase 7.2G — forensically determine whether the "correct-winner-but-abstained" cases are policy defects; implement ONE bounded policy correction ONLY if a principled systemic defect is found AND all §17 preconditions met.

---

## §22 24-item deliverable

### 1. Raw canonical Top-1

`10 / 42` — canonical `candidates[0]` matches an acceptable account.

### 2. Committed Top-1

`8 / 42` — recommendation policy allowed the correct canonical winner to surface AND the winner is acceptable.

(Note: the harness's aggregate "GL Top-1 = 13" from Phase 7.2F counts committed-correct + warranted-abstain PASSes together. Splitting: 8 committed-correct + 5 warranted-abstain = 13.)

### 3. Exact correct-winner-but-abstained count

**2 cases.** Not `~5` as speculated in the Phase 7.2E-b/F checkpoints (which conflated "correct in Top-3" with "correct canonical winner but abstained"). The corrected count is definitive from the extended snapshot.

### 4. Exact case IDs

1. `jonas-convention-accum-depr` — winner 5320 (acceptable ∈ [5310, 5311, 5320])
2. `adversarial-capital-warranty-boilerplate` — winner 1506 (acceptable ∈ [1506, 1540])

### 5. Forensic trace per case

**`jonas-convention-accum-depr`:**
- canonicalWinnerAccountNumber: 5320 ✓
- canonicalWinnerScore: **5** (well below `COMMIT_MIN_SCORE = 30`)
- runnerUpScore: null (no scored runner-up)
- marginToRunnerUp: null
- isDeterministicTieBreak: false
- genuineCompetitorCount: **0**
- canonicalConfidenceLevel: REVIEW_REQUIRED
- recommendationStatus: ABSTAIN_AMBIGUITY
- abstentionReasons: `["policy_abstain_ambiguity"]`
- **Trigger:** `winner.score = 5 < COMMIT_MIN_SCORE = 30` in `rankCanonical` (canonical-ranker.ts:1233). Recommendation policy propagates the canonical ABSTAIN as ABSTAIN_AMBIGUITY (recommendation-policy.ts:121).

**`adversarial-capital-warranty-boilerplate`:**
- canonicalWinnerAccountNumber: 1506 ✓
- canonicalWinnerScore: **28** (below COMMIT_MIN_SCORE = 30)
- runnerUpScore: null
- isDeterministicTieBreak: **true**
- genuineCompetitorCount: **0**
- canonicalConfidenceLevel: REVIEW_REQUIRED
- recommendationStatus: ABSTAIN_AMBIGUITY
- abstentionReasons: `["policy_abstain_ambiguity"]`
- **Trigger:** Same — `winner.score = 28 < 30`. Plus a deterministic tie-break with a same-score runner-up.

### 6. Competitor A/B/C/D classification

**N/A.** BOTH correct-winner-abstained cases have `genuineCompetitorCount = 0`. There is no competitor to classify. The founder's §3-4 hypothesis (that competitor qualification is the defect) is empirically DISPROVEN. The systemic defect lives elsewhere.

### 7. Genuine-competitor audit

`qualifyGenuineCompetitors` at [canonical-confidence.ts:118](../src/lib/ap-intelligence/canonical-confidence.ts#L118) is functioning correctly. Both correct-winner-abstained cases have zero qualified competitors — nothing spurious is being called a "genuine competitor". The qualifier's five criteria (distinct identity, ≥ COMMIT_MIN_SCORE, ≥60% of winner, ≥1 DECISION evidence, contradictions don't dominate) are behaving as designed.

### 8. Score-bucket analysis (§10)

| Bucket | Cases | Correct winner | Recommended |
|--------|:---:|:---:|:---:|
| < 20 | 3 | 1 | 0 |
| 20-29 | 4 | 1 | 0 |
| 30-39 | 4 | 3 | 4 |
| 40-49 | 6 | 2 | 6 |
| 50-59 | 2 | 1 | 2 |
| 60+ | 4 | 2 | 4 |

**Empirical answer to founder §10** ("Are obvious correct invoices systematically scoring below 30?"): **YES — 2 correct winners score below the commit floor.** Winner-score distribution reveals:
- 100% of cases with winner ≥ 30 result in RECOMMEND. The commit floor is working as designed above it.
- Below 30: 7 cases total, of which 2 have the CORRECT winner. Lowering the floor would rescue those 2 but risk incorrect commits from the 5 wrong-winner cases below.
- Correct-winner rate above floor: 8/16 = 50%. Correct-winner rate below floor: 2/7 = 29%. The floor's discriminative power is modest — the score signal itself is a poor discriminator of correctness in the current calibration.

### 9. Margin-bucket analysis (§11)

Both correct-winner-abstained cases have `runnerUpScore = null` and `marginToRunnerUp = null` (no scored runner-up because winner is the only viable candidate above 0). Margin-bucket is uninformative for the correct-winner-abstain question — margin does NOT trigger abstention on these cases; the commit-floor does.

### 10. Whether score predicts correctness

Modestly. Above the floor (≥ 30) → 50% correct-winner rate. Below floor → 29%. The commit floor filters out ~half of the noise cases but also captures 2 legitimate wins. Not a clean discriminator.

### 11. Whether margin predicts correctness

Not measurable from this data — both correct-winner-abstained cases have no scored runner-up.

### 12. Is MODERATE improperly coupled to abstention?

**NO.** Empirical evidence from confidence-level × recommendation-status distribution across 42 cases:

| level : status | count |
|----------------|:---:|
| HIGH:RECOMMEND | 8 |
| **MODERATE:RECOMMEND** | **9** |
| REVIEW_REQUIRED:ABSTAIN_AMBIGUITY | 14 |
| REVIEW_REQUIRED:ABSTAIN_NO_CANDIDATES | 7 |
| null:ABSTAIN_NO_CANDIDATES | 4 |

**MODERATE:RECOMMEND fires 9 times** — MODERATE is a fully valid recommend state. The founder's original pre-refactor concern ("MODERATE = review") is NOT present in the current codebase. **§13 concern dismissed.**

### 13. 221178 trace/result

Not on the sealed benchmark (staging fixture only). Would require staging inspection — not performed per §21 ("Do not stage"). Behavior on staging: unchanged since Phase 7.1 checkpoint (three clusters converging on 6054, overall ABSTAIN_AMBIGUITY because cluster count > 1). Phase 7.2E-b projection semantics may have improved this — not re-inspected.

### 14. 1091559 trace/result

Via benchmark proxy `vague-body-invoice-attachment`:
- canonicalWinnerAccountNumber: **null**
- recommendationStatus: ABSTAIN_NO_CANDIDATES
- abstentionCategory: NO_CANDIDATES
- abstentionReasons: `["canonical_no_eligible_candidates"]`

**Category C: missing candidate/evidence.** Not category A (correct winner + bad abstention) as speculated in earlier phases. The cluster produces no candidate scoring above zero. This is a discovery / canonical-scoring gap, not a policy gap.

### 15. DMM result

`dmm-energy-fuel`: winner **5320 Fuel & Lubricants**, score 33, RECOMMEND ✓. Preserved. Regression guard MET.

### 16. Capital safety result

`completed-capital-improvement`: winner **1530 Course Improvements**, score 39, RECOMMEND ✓ (Phase 7.2F recovery preserved). Unsafe = 0 across corpus. Capital safety MET.

### 17. Statement safety result

`statement-of-account`: winner 1506, score **26** (below floor), ABSTAIN_AMBIGUITY. Correct abstain per fixture (`expectedAbstention: true`). Preserved. Statement safety MET.

### 18. Any systemic policy defect found

**NO.** The two correct-winner-abstained cases are BOTH triggered by `winner.score < COMMIT_MIN_SCORE = 30` at `canonical-ranker.ts:1233`. This is a **canonical-scoring / commit-floor issue**, NOT a policy issue.

The recommendation policy at [recommendation-policy.ts:122-131](../src/lib/ap-intelligence/recommendation-policy.ts#L122) is a pure propagation of canonical status — when `canonicalStatus === "ABSTAIN"`, it emits ABSTAIN_AMBIGUITY. There is no policy logic to correct here.

Root cause enumeration:
- **NOT** competitor qualification (`genuineCompetitorCount = 0` in both cases)
- **NOT** MODERATE-coupled abstain (MODERATE:RECOMMEND fires 9 times in the corpus)
- **NOT** margin threshold (both cases have null margin)
- **NOT** confidence policy (canonicalConfidenceLevel just reflects the ABSTAIN reasonably as REVIEW_REQUIRED)
- **IS** canonical scoring: `winner.score = 5` (jonas) and `winner.score = 28` (adversarial) are both below `COMMIT_MIN_SCORE = 30`

### 19. Exact policy change, if justified

**None implemented.** Per §17 preconditions, ANY change to lower COMMIT_MIN_SCORE is explicitly forbidden (precondition 6). Since the systemic defect is BELOW the commit floor, no bounded policy correction satisfying all §17 preconditions exists.

Per §16: **STOPPED after forensic analysis. Awaiting founder review.**

### 20. Post-change benchmark

**No policy change made.** Benchmark unchanged from Phase 7.2F baseline: pass=13, fail=25, unsafe=0.

Instrumentation-only change (extended snapshot) — no runtime behavior effect. Verified: `pass=13, fail=25, unsafe=0` identical to Phase 7.2F.

### 21. Unsafe count

**0** ✅ preserved. Capital-safety antiTerms (7.2D) + statement-of-account safety intact.

### 22. Remaining correct-winner abstains

**2** — same 2 cases. No change from pre-7.2G state.

### 23. Architecture / anti-overfitting guards

- All single-authority guards green.
- Zero literals introduced. Instrumentation-only changes added `canonicalWinnerAccountNumber`, `recommendationStatus`, and 8 diagnostic fields to `AnalyserSnapshot` + `CaseRunResult.extract`. No vendor/invoice/account patterns anywhere.
- 89 / 89 targeted tests green. Typecheck clean.

### 24. Recommendation for Phase 7.2H

**Do NOT stage. Do NOT merge Phase 7.2G as-is** — no runtime behavior change to stage. Instrumentation IS valuable and should stay on the branch (permanent diagnostic surface).

**Full failure decomposition** (42 cases):

| Category | Count | Cases |
|----------|:---:|-------|
| Committed correct | 8 | dmm, keyword-trap-computer, completed-capital-improvement, ordinary-repair-part, adversarial-operating-with-model-numbers, low-price-durable-equipment, mixed-tax-invoice, professional-membership |
| Warranted abstain | 5 | vague-body, html-newsletter, unreadable-empty, statement-of-account, pathological-vendor-default-contra |
| Other dimension (fixture doesn't test top-1) | 6 | supplier-vs-recipient, table-heading, canadian-usd, duplicate-gst, statement-plus-account-number, credit-memo, po-without-invoice-number |
| **Correct winner but abstained (winner < 30)** | **2** | jonas-convention-accum-depr (score=5), adversarial-capital-warranty-boilerplate (score=28) |
| Wrong canonical winner | 8 | capital-irrigation, operating-maintenance, cip-construction-progress-clear, cip-weak-project-evidence, image-only-narrative-service, food-service-invoice, land-acquisition, ocr-visible-table |
| No canonical winner (empty pool or all score 0) | 12 | adversarial-capital-with-accumdepr, complete-equipment-serialized, financed-equipment-affirmative, replacement-component-serialized, expensive-consumable-price-not-capital, software-intangible, prepaid-insurance, inventory-fnb-restock, 3× multi-alloc, building-acquisition |

**The dominant remaining boundaries are:**

1. **No canonical winner (12 cases, 28.5%)** — every candidate scored 0 or the pool is empty. Root causes:
   - **Multi-cluster harness limitation (3 cases):** per-cluster canonical actually resolves (post-7.2E-b projection), but the harness's flat gl-top1 comparator doesn't understand MULTIPLE_RESOLVED. NOT a classifier defect.
   - **Discovery gap (~9 cases):** cluster produces no candidate with any evidence. Some of these were previously PASS on v206 (financed-equipment-affirmative, inventory-fnb-restock, etc.) — v206's discovery mechanisms surfaced the right account; Phase 7.2B legacy-direct discovery didn't fully replicate that.

2. **Wrong canonical winner (8 cases)** — canonical scored a wrong account higher than the correct one. Root causes vary — some are ranking-signal balance issues (operating-maintenance: 6065 vs 6020), some are token-thin invoices where inventory accounts win by default (image-only-narrative, food-service).

3. **Correct winner but abstained (2 cases)** — canonical picked the right account but scored it below the commit floor. Direct calibration question.

**Recommendation-policy is NOT the primary lever.** MODERATE:RECOMMEND fires 9 times. Competitor qualification is functioning correctly (0 genuine competitors in both abstained cases). The bottleneck is upstream — canonical scoring produces low scores for legitimate transactions, and discovery leaves some clusters empty.

**Suggested Phase 7.2H options (any require separate authorization):**

**Option A — Canonical scoring investigation for correct-but-under-floor cases.**
Investigate why `jonas-convention-accum-depr` scores its correct winner at 5 (the semantic bridge should fire; something in the scoring pipeline is dropping evidence). Not a threshold change — a scoring pipeline audit. Analogous to Phase 7.2C's wiring-fix discovery.

**Option B — Discovery gap investigation for `NO_CANDIDATE` cases.**
Approximately 9 cases produce no scored candidate. Compare to v206 discovery pass-throughs. Some of these are correctable via extending Phase 7.2B legacy-direct discovery to additional evidence signals.

**Option C — Multi-cluster harness comparator upgrade.**
The gl-top1 comparator doesn't understand MULTIPLE_RESOLVED. Recognizing `gl.candidates[]` as valid per-allocation coding for multi-cluster invoices would restore 2-3 top-1 credits without any runtime change. Pure benchmark-comparator fix.

**Option D — Founder-approved lowering of `COMMIT_MIN_SCORE`.**
Explicitly against §17 precondition 6. Only viable with explicit founder authorization to revisit the threshold, given Phase 7.2G empirical data showing 2 correct winners fall below.

**Alternative — accept Phase 7.2F state, stage/staging-decision for founder.**
Phase 7.2F is safe to leave on the branch. 8 committed-correct + 5 warranted-abstain + capital safety = the current stable state. If the goal is to reach 17/42 v206 floor, Options A/B/D combined would likely get there but each requires separate authorization.

**Do NOT stage. Do NOT merge. Do NOT deploy production.**

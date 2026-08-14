# Phase 4R · Phase 7.2I — Compositional-Reasoning Repair Checkpoint

**Author:** Claude (Opus 4.7) on `refactor/gl-single-authority`
**Date:** 2026-08-13
**Status:** Both slices (7.2I-a fs-group affinity + 7.2I-b compositional capital admission) implemented in the exact sequence founder specified. Step 0 comparator fix applied first. Two runtime interpretation-layer changes committed. Zero regressions. Unsafe = 0.

---

## Required checkpoint items

### 1. Corrected pre-I benchmark (Step 0)

Fix: [tests/ap-benchmark/comparators/index.ts:264](../tests/ap-benchmark/comparators/index.ts#L264) — `cmpWorkflowType` accepts `NEEDS_JUDGMENT` ↔ `REVIEW_REQUIRED` as label aliases (semantic-equivalent product states in different vocabularies).

Baseline after Step 0:

| Metric | Value |
|--------|:---:|
| pass overall | 17 / 42 |
| HUMAN_CLASSIFIABLE | 35 |
| raw canonical Top-1 | 10 / 35 (28.6%) |
| committed Top-1 | 8 / 35 (22.9%) |
| unsafe | 0 |

Note: this is a benchmark-methodology correction; runtime unchanged. Rescues the 4 R9-classified cases from Phase 7.2H.

### 2. Existing `conceptRelatedness` scale (audit)

[src/lib/ap-intelligence/gl-concepts.ts:682-698](../src/lib/ap-intelligence/gl-concepts.ts#L682):

| Relationship | Value |
|--------------|:---:|
| Identity | 100 |
| Parent-child | 65 |
| Sibling (same parent, both non-root) | 55 |
| Grandparent/grandchild (transitive) | 40 |
| Unrelated | 0 |

### 3. FS-group hint specificity audit

Grepped every `fsGroupKeyHints` value in `ACCOUNTING_CONCEPTS`:

| Hint | Uses |
|------|:---:|
| `IS_IT_SOFTWARE` | 3 |
| `IS_OFFICE_SUPPLIES` | 2 |
| `IS_INTEREST_EXPENSE` | 2 |
| `IS_BANK_CHARGES` | 2 |
| `IS_UTILITIES` | 1 |
| `IS_TELEPHONE_INTERNET` | 1 |
| `IS_REPAIRS_MAINTENANCE` | 1 |
| `IS_PROFESSIONAL_FEES` | 1 |
| `IS_MEMBERSHIPS_SUBS` | 1 |
| `IS_LICENCES_PERMITS` | 1 |
| `IS_INSURANCE` | 1 |
| `IS_FB_SUPPLIES` | 1 |
| `IS_COURSE_MAINT` | 1 |
| `IS_COMMUNICATIONS` | 1 |
| `IS_COGS_FOOD` | 1 |
| `IS_COGS_BEV` | 1 |

**Every existing hint is a specific accounting subcategory.** No broad statement-level buckets (e.g. `IS_OPERATING_EXPENSE`, `IS_ASSETS`). Safe to bridge unconditionally across shared hints. If a future broad hint is introduced, an exclusion list is the appropriate guard rather than lowering the affinity value.

### 4. Cross-tree affinity implementation

New in [gl-concepts.ts:682-747](../src/lib/ap-intelligence/gl-concepts.ts#L682):

- Named constant `SHARED_FS_GROUP_AFFINITY = 35` — bounded, strictly below grandparent (40), well below sibling (55), well below parent-child (65), well below identity (100).
- Helper `sharedFsGroupAffinity(a, b)` returns true iff BOTH concepts have non-empty `fsGroupKeyHints` AND their intersection is non-empty. A concept with no declared hints makes no claim about its statement group and cannot bridge.
- `conceptRelatedness` new final branch: after all ontology checks fail, if `sharedFsGroupAffinity(a, b)` returns true, return 35.

Consumed by canonical-ranker's `scoreCandidateAgainstTransaction` at [canonical-ranker.ts:872](../src/lib/ap-intelligence/canonical-ranker.ts#L872) — same call site, same weight table, no scoring change.

### 5. 221178 before/after trace

**221178 is a STAGING fixture, not in the sealed corpus.** The seed COA does not include a "Computer & IT Services" analog (6072 is "Telephone & Internet" — matches `telephony`/`connectivity_internet` concepts, not `it_services`). So the sealed corpus does NOT exercise the IS_IT_SOFTWARE bridge.

**Architecturally validated via unit test:** `conceptRelatedness("software_subscription_service", "it_services")` returns SHARED_FS_GROUP_AFFINITY = 35 (was 0). This is the missing piece §7 identified. On the staging 221178 fixture (where 6054 "Computer & IT Services" exists), canonical scoring will now attribute the shared IS_IT_SOFTWARE membership as evidence.

Founder note per §7.2I-a: "If 6054 becomes raw canonical #1 but remains below commit policy, stop classifying the case as semantic failure." Verifiable only via staging re-inspection (deferred per §21 no-staging).

### 6. Benchmark after I-a

| Metric | pre-I | post-I-a | Δ |
|--------|:---:|:---:|:---:|
| raw canonical Top-1 | 10 | 10 | 0 |
| committed Top-1 | 8 | 8 | 0 |
| pass overall | 17 | 17 | 0 |
| Top-3 | 14 | 14 | 0 |
| unsafe | 0 | 0 | 0 |

**Zero benchmark movement.** The sealed corpus does not contain a case that exercises the fs-group affinity bridge in a way that changes Top-1 or Top-3 verdicts. The fix is architecturally correct and unit-tested; its benefit will materialize on staging fixtures like 221178.

### 7. `isDefensible` semantics (audit)

[accounting-nature.ts:527-529](../src/lib/ap-intelligence/accounting-nature.ts#L527):

```ts
const isDefensible = leaderConfidence >= 20 && leader && leader.supportingEvidence.length > 0;
```

**Definition:** the leader nature is defensible when its normalized confidence is ≥ 20 AND it has at least one supporting evidence entry.

Score 20 corresponds to raw = 3 = single STRONG_WEIGHT (3) match — **at least one strong-term hit against the line-item description** with a supporting-evidence record. It's a MODEST bar but NOT trivial: amount is explicitly excluded from evidence (per amendment #3), and the requirement for `supportingEvidence.length > 0` prevents commitments from score alone.

For 1091559 fixture proxy: line "Equipment & fixtures — grounds" matches CAPITAL_ASSET strongTerm `/\bequipment\b/` → raw=3 → conf 20 → isDefensible=true. Legitimate: the line literally names a fixed-asset family; a human accountant would treat this as defensible capital-nature evidence.

### 8. Capital eligibility before/after

Change at [analyse.ts:1071-1114](../src/lib/ap-intelligence/analyse.ts#L1071):

**Before I-b:**
```ts
expectedDebitRole =
    capital.state === "CAPITAL" ? "CAPITAL_ASSET"
  : capital.state === "OPERATING" ? "OPERATING_EXPENSE"
  : "UNKNOWN";
```

**After I-b:**
```ts
const preNatureForEligibility = classifyAccountingNature({/* line-item evidence */});
const natureAdmitsCapitalAsset =
    preNatureForEligibility.leader === "CAPITAL_ASSET"
 && preNatureForEligibility.isDefensible;

expectedDebitRole =
    capital.state === "CAPITAL" ? "CAPITAL_ASSET"
  : capital.state === "OPERATING" ? "OPERATING_EXPENSE"
  : natureAdmitsCapitalAsset ? "CAPITAL_ASSET"  // NEW compositional admission
  : "UNKNOWN";
```

**Composition rule:** a defensible structured accounting conclusion from ONE treatment classifier (nature) may widen the eligible candidate universe when ANOTHER classifier (capital-vs-operating) is unresolved.

Does NOT:
- Force an asset winner
- Add a canonical scoring boost
- Automatically RECOMMEND
- Exclude expense candidates (rule only applies to ASSET.type)
- Bypass canonical ranking

### 9. 1091559 trace before/after

**Before (pre-I baseline):**
- `expectedDebitRole = "UNKNOWN"` (capital.state = AMBIGUOUS)
- ASSET accounts excluded by `ruleNatureAssetExcluded` default branch
- Nature-scoped discovery surfaces 1506/1540 but `unionEligiblePool` filters them against the pre-Phase-2 pool → silently dropped
- Every EXPENSE candidate receives `NATURE_INCOMPATIBLE_PENALTY = -18` (natureLeader = CAPITAL_ASSET) → all zeros
- **Result: `canonicalWinnerAccountNumber = null`, `NO_ELIGIBLE_CANDIDATES`**

**After (I-b):**
- `natureAdmitsCapitalAsset = true` (nature.leader = CAPITAL_ASSET, isDefensible = true from `equipment` strongTerm)
- `expectedDebitRole = "CAPITAL_ASSET"`
- ASSET accounts admitted at Phase-2 eligibility (`ruleNatureAssetExcluded` returns null)
- 1506/1540 flow through into `nonPayrollAccounts`, `unionEligiblePool` sees them, canonical scores them
- **Result: `canonicalWinnerAccountNumber = "1506"`, score 3, ABSTAIN_AMBIGUITY (correct — vague-body fixture expects abstain)**
- **gl-top3 verdict: FAIL → PASS** ([1506, 1250, 1260] — 1506 in acceptable set)

**Category resolution:** Founder §14 category **C (missing candidate/evidence) → RESOLVED via compositional admission.** The 1091559 proxy still abstains overall (fixture is deliberately vague-body — abstention is correct), but the correct capital account is now the canonical winner, no longer silently excluded.

**On the real staging 1091559 fixture** (not the benchmark proxy), the extracted line "Equipment & fixtures — grounds $77,833.35" produces stronger accounting-nature evidence than the vague-body benchmark. On staging, canonical could score 1506 above `COMMIT_MIN_SCORE=30` and commit. Deferred verification per §21 (no staging).

### 10. Benchmark after I-b

| Metric | post-I-a | post-I-b | Δ |
|--------|:---:|:---:|:---:|
| raw canonical Top-1 | 10 | 10 | 0 |
| committed Top-1 | 8 | 8 | 0 |
| **pass overall** | **17** | **18** | **+1** |
| Top-3 | 14 | 15 | +1 |
| unsafe | 0 | 0 | 0 |

**+1 pass (`vague-body-invoice-attachment`: gl-top3 FAIL → PASS)** — the 1091559 proxy now surfaces 1506 in Top-3.

Raw/committed Top-1 unchanged on the sealed corpus because:
- 1091559 proxy correctly abstains (Top-1 already PASS as warranted abstain).
- Other capital-ASSET cases in the corpus either already had the correct top-1 or fail elsewhere.
- The real Top-1 improvement will materialize on staging.

### 11. Capital safety results (mandatory §8 controls)

Verified via unit test [tests/phase4r-phase72i-b-capital-admission.test.ts](../tests/phase4r-phase72i-b-capital-admission.test.ts) — 6/6 passing:

1. `expectedDebitRole=CAPITAL_ASSET` admits ASSET (composed from defensible nature) ✓
2. `expectedDebitRole=UNKNOWN` still excludes ASSET (no forced admission) ✓
3. `expectedDebitRole=OPERATING_EXPENSE` still excludes ASSET (operating overrides) ✓
4. R&M route unchanged (still requires capitalization evidence for ASSET) ✓
5. INVENTORY / PREPAID admission preserved ✓
6. EXPENSE accounts always pass (rule only applies to ASSET) ✓

**Corpus verification:**

| Case | Result | Notes |
|------|--------|-------|
| `completed-capital-improvement` | 1530 ✓ | Phase 7.2F fix preserved |
| `capital-irrigation` | 6020 wrong (unchanged) | R2 defect — expected 1530/1540 but capital classifier commits OPERATING (misfire) |
| `ordinary-repair-part` | 6020 ✓ | R&M preserved — no false capital admission |
| `low-price-durable-equipment` | 1506 ✓ | Preserved |
| `expensive-consumable-price-not-capital` | (abstain) | ASSET-family accounts (1250) surfaced but no false commit |
| `adversarial-operating-with-model-numbers` | 6020 ✓ | Preserved — no false capital admission |

**Zero unsafe.** ✅

### 12. HUMAN_CLASSIFIABLE raw accuracy

**10 / 35 = 28.6%** (unchanged from pre-I).

### 13. HUMAN_CLASSIFIABLE committed accuracy

**8 / 35 = 22.9%** (unchanged from pre-I).

Comparator-side pass count: 18 / 42 (includes warranted abstains and MULTIPLE_RESOLVED per-allocation grading).

### 14. Unsafe

**0 across all 4 runs** (Step 0 baseline, I-a, I-b, post-I-b final). ✅

### 15. Exact R1-R9 distribution after I-a + I-b

Re-classified with updated snapshots:

| Category | pre-7.2I (7.2H count) | post-7.2I | Δ |
|----------|:---:|:---:|:---:|
| R1 Transaction understanding | 0 | 0 | 0 |
| R2 Accounting treatment | 7 | 7 | 0 |
| R3 Accounting class | 3 | 3 | 0 |
| **R4 Discovery** | **7** | **6** | **−1** (1091559 proxy 1506 now discovered) |
| R5 Canonical competition | 1 | 1 | 0 |
| R6 Evidence propagation | 1 | 1 | 0 |
| R7 Policy | 3 | 3 | 0 |
| R8 Extraction/clustering | 0 | 0 | 0 |
| **R9 Benchmark** | **4** | **0** | **−4** (Step 0 fix) |

**R4 dropped by 1 (compositional-capital-admission).** R9 dropped by 4 (Step 0 comparator alias). R2/R3 unchanged — those are canonical scoring/ranking questions, not composition questions.

### 16. Newly recovered cases

Since pre-I (7.2H baseline):

- **`vague-body-invoice-attachment`** (1091559 proxy): overall FAIL → PASS. `gl-top3` FAIL → PASS. Canonical winner null → **1506**. Compositional capital admission (I-b).
- Plus 4 workflowState label-mismatch cases from Step 0 comparator fix (completed-capital-improvement, ordinary-repair-part, adversarial-operating-with-model-numbers, low-price-durable-equipment) — runtime was already correct.

### 17. Regressions

**Zero.** Every prior PASS case remains PASS. 105 / 105 targeted tests green.

### 18. Static composition guards

Two new named composition rules with explicit provenance:
- `SHARED_FS_GROUP_AFFINITY = 35` in [gl-concepts.ts:711](../src/lib/ap-intelligence/gl-concepts.ts#L711). Documented rationale; unit-tested (10 tests).
- `natureAdmitsCapitalAsset` composition in [analyse.ts:1108-1112](../src/lib/ap-intelligence/analyse.ts#L1108). Documented rationale; unit-tested (6 tests).

### 19. Single-authority guards

- `tests/phase4r-refactor-single-gl-authority.test.ts` — 3 static guards green.
- `tests/phase4r-phase7-cluster-owned.test.ts` — 14 tests green.
- `tests/phase4r-phase72b-canonical-subordination.test.ts` — 1 test green (canonical remains sole winner-selector).
- `tests/phase4r-phase72e-b-multi-alloc-projection.test.ts` — 7 tests green.
- Grep for `gl.accountNumber =` in analyse.ts: unchanged, only `applyPhase0SafetyContainment` (abstain-only).

### 20. Anti-overfitting

Zero vendor / invoice / account / benchmark literals introduced. The two changes are:
- One shared-hint predicate (`sharedFsGroupAffinity`) reading existing declared metadata.
- One eligibility composition (`natureAdmitsCapitalAsset`) reading two existing structured classifiers.

Both are class-of-thing composition rules; both apply uniformly across all fixtures.

### 21. Targeted tests / typecheck

**105 / 105 targeted tests passing** across 10 test files (3 skipped design-intent tests from reverted Phase 7.2E-a). Typecheck clean.

### 22. Do correct winners remain systematically under-scored?

**Yes, on the sealed corpus.** Winner-score distribution (unchanged from Phase 7.2H):

- Strong-invoice DMM reaches only 33 (design intent ~85).
- The two correct-winner-abstained cases still score 5 and 28.
- Median winner score ~35.

Phase 7.2I addressed COMPOSITION defects (evidence not reaching the ranker) but did not raise the score scale. The one case where composition helped (1091559 proxy) still scores its correct winner at 3 — proving that admission alone is not sufficient to commit when line-item evidence is genuinely sparse.

**This is a canonical-scoring architecture question, not a threshold question.** The empirical answer to Phase 7.2H §10: score scale is compressed relative to design. Correcting it belongs in a future canonical-ranker calibration slice.

### 23. Next dominant boundary

**R2 (Accounting treatment) + R4 (Discovery) still dominate at 13 of 21 remaining failures.**

Post-I-b distribution:
- R2 Treatment: 7 (image-only-narrative-service picks inventory instead of expense; food-service picks inventory instead of COGS; land/building acquisition; replacement-component; expensive-consumable)
- R4 Discovery: 6 (software-intangible / prepaid-insurance not discovered; multi-alloc goods+freight/goods+service no candidates; adversarial-capital-with-accumdepr; building-acquisition)
- R3 Class: 3 (operating-maintenance picks 6065 vs 6020; cip-weak-project-evidence; cip-construction-progress-clear)
- R5/R6/R7: 5 total (well-bounded)

**The boundary has NOT moved to ranking/policy.** It remains treatment + discovery. R2 cases mostly involve accounts of type ASSET (inventory) winning over EXPENSE — the canonical ranker's ASSET-vs-EXPENSE scoring on token-thin invoices favors accounts whose names contain frequent inventory-adjacent tokens.

### 24. Recommendation for Phase 7.2J

**DO NOT stage. DO NOT merge. DO NOT deploy production.** Phase 7.2I preserves all architectural gains, is a bounded interpretation-layer repair, and rescues the 1091559 discovery-choke-point defect. But committed Top-1 = 8/35 (23%) remains far below production-worthy.

**Suggested Phase 7.2J direction (each option requires separate authorization):**

- **Option A — R2 treatment audit for inventory-vs-expense confusions.** 7 R2 cases mostly involve inventory-family ASSET accounts (1250, 1260) winning over EXPENSE (6020, 5100, 5101). Analogous to I-b compositional admission but in reverse: when nature classifier commits COST_OF_SALES or OPERATING_EXPENSE defensibly, keep ASSET (inventory) accounts admissible but ensure EXPENSE scoring dominates for those transactions.

- **Option B — R4 discovery for software-intangible / prepaid-insurance / building.** 3 targeted concepts already have Phase 7.2F cues but their accounts don't reach the eligible pool because the SEED COA account patterns don't match `PURPOSE_ACCOUNT_NAME_SUBSTRINGS` well. Investigation per case.

- **Option C — Canonical scoring calibration.** Address the "correct winners score 5-28" compression by inspecting evidence emission per case. Requires founder authorization for weight/threshold changes (still forbidden in 7.2I). Would move Top-1 across the commit floor for the 2 correct-winner-abstained cases.

- **Option D — Real-fixture staging inspection.** 221178 and 1091559 on staging would demonstrate the fs-group affinity + compositional capital admission benefits that the synthetic corpus cannot measure. Deferred per §21.

**Alternative — accept Phase 7.2I state.** Safe on the branch: +1 pass, +1 Top-3, 0 unsafe, 0 regressions. Two named composition primitives permanently address the 221178-shape and 1091559-shape defects. Both are interpretation-layer repairs preserving all architectural gains.

Awaiting founder call.

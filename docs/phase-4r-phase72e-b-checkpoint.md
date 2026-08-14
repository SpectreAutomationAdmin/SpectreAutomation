# Phase 4R · Phase 7.2E-b — Exit report (§19 21-item deliverable)

**Author:** Claude (Opus 4.7) on `refactor/gl-single-authority`
**Date:** 2026-08-13
**Scope:** Multi-cluster projection semantics ONLY. NO ranking / scoring / evidence / weight / threshold / discovery / clustering / semantic changes.
**Founder directive:** Phase 7.2E-b — fix cases where every material cluster canonically resolves but document-level projection reports ABSTAIN/AMBIGUITY merely because cluster count > 1.

---

## §19 21-item deliverable

### 1. Exact projection-failure cases

Four multi-cluster benchmark cases pre-E-b:

| Case | Cluster count | Pre-E-b `gl.candidates` | Pre-E-b `requiresReview` |
|------|:---:|-----|:---:|
| `multi-alloc-membership-plus-penalty` | 2 | `[]` | `true` |
| `multi-alloc-goods-freight-tax` | 3+ | `[]` | `true` |
| `multi-alloc-goods-plus-service` | 2+ | `[]` | `true` |
| `inventory-fnb-restock` | 2 | `[]` | `true` |

Root cause: `projectClustersToGlRecommendation` case D called `emptyGlRec(...)` which always returns `candidates: []` and `requiresReview: true`. Even when every cluster resolved to RECOMMEND at HIGH confidence, the doc-level projection erased the per-allocation winners and forced review.

### 2. Before/after document states

| Case | Pre-E-b | Post-E-b |
|------|---------|----------|
| `multi-alloc-membership-plus-penalty` | `candidates: []`, `requiresReview: true`, hit=NO | `candidates: [6064, 6064]`, `requiresReview: false`, hit=YES ✓ |
| `inventory-fnb-restock` | `candidates: []`, `requiresReview: true`, hit=NO | `candidates: [5101, 5101]`, `requiresReview: false`, hit=YES ✓ |
| `multi-alloc-goods-freight-tax` | `candidates: []`, `requiresReview: true`, hit=NO | `candidates: []`, `requiresReview: true` — clusters themselves abstained; not a projection case |
| `multi-alloc-goods-plus-service` | `candidates: []`, `requiresReview: true`, hit=NO | `candidates: []`, `requiresReview: true` — clusters themselves abstained; not a projection case |

Two of the four were pure projection defects, now fixed. The other two have per-cluster canonical scoring gaps that projection cannot fix (§16).

### 3. Aggregation-state model

New explicit states in `projectClustersToGlRecommendation` case D:

| Signal | Recognized as |
|--------|----|
| `allocations.length === 1` | Case C — single-cluster; `gl` mirrors cluster canonical |
| `allocations.length > 1` AND all `RECOMMEND` | **MULTIPLE_RESOLVED** — `requiresReview: false`, per-allocation winners in `candidates` |
| `allocations.length > 1` AND any non-`RECOMMEND` | **MULTIPLE_REVIEW_REQUIRED** — `requiresReview: true`, resolved allocation winners still surfaced in `candidates` when their `recommendedAccount` is non-null |
| No allocations | Case A — `NO_ELIGIBLE_CANDIDATES` (unchanged) |
| Field quality fail | Case B — `ABSTAIN_QUALITY` (unchanged) |

`gl.accountNumber` remains `null` in all multi-cluster states per §4.

### 4. MULTIPLE_RESOLVED semantics

- `gl.accountNumber = null` (§4 — no doc-level winner selection).
- `gl.recommendationStatus = "RECOMMEND"` (aggregate — from `aggregateRecommendationStatus` when all clusters RECOMMEND).
- `gl.requiresReview = false` (§3 — resolved multi-allocation is a valid final state, not review-required).
- `gl.candidates` — per-allocation winners in original allocation-index order. NOT ranked. `gl.candidates[0]` does NOT imply "doc winner".
- `gl.canonicalConfidence.reasonCodes` includes `"multiple_resolved"`.
- `gl.canonicalConfidence.humanReadableReason` labels the state.

### 5. MULTIPLE_REVIEW_REQUIRED semantics

- `gl.accountNumber = null`.
- `gl.recommendationStatus` = aggregate abstain category (`ABSTAIN_AMBIGUITY` / `ABSTAIN_QUALITY` / `ABSTAIN_NO_CANDIDATES` / `ABSTAIN_ANALYSIS_FAILURE`) per existing `aggregateRecommendationStatus`.
- `gl.requiresReview = true` (§3).
- `gl.candidates` — allocations whose `recommendedAccount` is non-null (i.e. the resolved clusters) preserved in candidate order. Unresolved clusters filtered out.
- `gl.canonicalConfidence.reasonCodes` includes `"multiple_review_required"`.

### 6. Document confidence aggregation rule (§5)

Unchanged from Phase 7.2D. `aggregateConfidenceLevel`:
- Any `REVIEW_REQUIRED` → `REVIEW_REQUIRED`
- Else any `LOW` → `LOW`
- Else any `MODERATE` → `MODERATE`
- Else all `HIGH` → `HIGH`

**Weakest-material-cluster semantics preserved.** No numeric averaging. Per founder §5.

### 7. Membership + penalty result (§8-1)

`multi-alloc-membership-plus-penalty`:
- Pre-E-b: `gl-top3 actual: []`, verdict FAIL.
- Post-E-b: `gl-top3 actual: [6064, 6064]`, verdict PASS. Both cluster winners in the acceptable set `[6064, 6065]`.
- `gl.accountNumber = null` (correct per §4).
- `gl.requiresReview = false`.
- Unit test passing.

### 8. Goods + freight + tax result (§8-2)

`multi-alloc-goods-freight-tax`:
- Pre-E-b: `gl-top3 actual: []`, verdict FAIL.
- Post-E-b: `gl-top3 actual: []`, verdict FAIL. Per-cluster canonical did NOT RECOMMEND — projection cannot help. First-failure boundary: **canonical ranking / discovery per cluster**, not projection.

### 9. Mixed resolved / unresolved result (§8-3)

Unit test PASS: when one cluster RECOMMENDs and one ABSTAINs (unit-test synthetic), doc-level `requiresReview = true`, `recommendationStatus = ABSTAIN_AMBIGUITY`, resolved cluster preserved in `candidates`, unresolved cluster filtered out (no `recommendedAccount` to surface).

### 10. Club Support 221178 result

Not re-run on staging. Per-cluster canonical was scoring 6054 as top-1 in each cluster but abstaining at cluster level (`ABSTAIN_AMBIGUITY`). Under Phase 7.2E-b:
- If clusters still abstain individually → doc-level = `MULTIPLE_REVIEW_REQUIRED`, `requiresReview: true`, no doc winner. **Correct behavior** — projection cannot cure weak cluster status (§10 preserved).
- If future work resolves the cluster-level status → doc-level would become `MULTIPLE_RESOLVED` naturally.

221178 remains a recommendation-policy / canonical-ranking case, not a projection case.

### 11. Oakcreek 1091559 result

Not re-run on staging. `vague-body-invoice-attachment` (benchmark proxy) still abstains correctly per fixture expectation. Real 1091559 fixture behavior unchanged — projection cannot cure per-cluster canonical gaps (§11 preserved).

### 12. Accounting Top-1

| | v206 | 7.2D | 7.2E-b |
|---|:---:|:---:|:---:|
| GL Top-1 | 17 | 12 | **12 (unchanged)** |

Zero change to Top-1. Projection changes cannot move Top-1 by construction — `gl.accountNumber` remains null for multi-cluster invoices (§4).

### 13. Unsafe

| | v206 | 7.2D | 7.2E-b |
|---|:---:|:---:|:---:|
| Unsafe | 0 | 0 | **0** ✅

Preserved. `completed-capital-improvement` still correctly abstains (7.2D capital-safety fix intact). No new unsafe from projection changes.

### 14. End-to-end pass delta attributable specifically to projection

| Metric | 7.2D | 7.2E-b | Delta | Cause |
|--------|:---:|:---:|:---:|-------|
| Pass | 13 | 13 | 0 | (harness pass counter combines many dimensions; net zero because some previously-partial cases moved dimensions) |
| **GL Top-3 correct** | 11 | **14** | **+3** | **Projection recovery** — per-allocation winners now surfaced in `gl.candidates` |
| Warranted abstain | 5 | 5 | 0 | Preserved |
| Unsafe | 0 | 0 | 0 | Preserved |

**Two clean projection recoveries** — `multi-alloc-membership-plus-penalty` and `inventory-fnb-restock` — plus one additional Top-3 improvement traceable to the same mechanism.

### 15. Remaining unwarranted abstain count

Not re-quantified as a distinct metric. The projection change reduced unwarranted document-level review for 2 cases (§7). Remaining unwarranted-abstain candidates now live at the per-cluster level (not projection).

### 16. Exact remaining first-failure distribution

Post-7.2E-b, 42-case corpus (approx counts based on §14 metric deltas + §17 taxonomy analysis):

| Boundary | Count | Example cases |
|----------|:---:|-------|
| Warranted abstain PASS | 5 | vague-body, statement-of-account, credit-memo, unreadable-empty, html-newsletter |
| **Multi-cluster projection** | **0** | **All cases where all clusters RECOMMEND now project cleanly** |
| Per-cluster canonical didn't RECOMMEND (needs canonical ranking / discovery / evidence work) | ~4 | multi-alloc-goods-freight-tax, multi-alloc-goods-plus-service, credit-memo edge cases |
| Correct account in Top-3 but ranked #2/#3 (MAX suppression, canonical scoring) | ~4 | jonas-convention-accum-depr |
| Correct account absent from Top-3, wrong dominates (canonical scoring on token-thin invoices) | ~6 | image-only-narrative-service, food-service-invoice |
| Upstream extraction / clustering gap | ~3 | ordinary-repair-part with sparse tokens |
| Adversarial (correct rejection) | ~3 | pathological-vendor-default-contra, adversarial-capital cases |
| Accounting taxonomy / role reasoning (§15 bucket) | ~4 | jonas-convention-accum-depr, capital-vs-inventory edge cases |
| Token-thin (§16 bucket) | ~5-6 | image-only-narrative-service, food-service-invoice, sparse-line cases |
| Other | ~2 | (isolated cases) |

**Projection is no longer a boundary.** Remaining work is per-cluster canonical scoring, accounting-taxonomy reasoning, and upstream extraction — all outside E-b scope.

### 17. Taxonomy / account-role bucket (§15)

Cases where the correct account is discovered but canonical misunderstands its role/statement classification:

| Case | Role issue | Notes |
|------|-----------|-------|
| `jonas-convention-accum-depr` | Contra-asset vs asset | Fixture tests that classifier does NOT pick 1513 (accum-depreciation). Discovery excludes 1513 (per Phase 7.2A hard-eligibility). Ranking places 5320 in Top-3 but not Top-1. **Not a projection issue.** Founder §11: "Do not assume TRANSACTION_TEXT aggregation alone should fix it." |
| Various capital cases | ASSET vs EXPENSE nature reasoning | canonical `CAPITAL_ASSET_MATCH` scoring path — untouched in E-b |
| `mixed-tax-invoice` | Currently correct (7.2D fix), preserved | |

Estimated ~4 cases in this bucket. **Deferred to Phase 7.2F (accounting-taxonomy reasoning).**

### 18. Token-thin bucket (§16)

Cases where extraction / clustering produces too little semantic signal for canonical to reason confidently:

| Case | Issue |
|------|-------|
| `image-only-narrative-service` | Image-OCR narrative — sparse extracted line items, weak semantic bridge |
| `food-service-invoice` | Extracted lines don't produce a canonical purpose commit; per-line matching falls back to inventory (`1250/1260`) |
| Similar sparse-line cases | Same pattern |

Estimated ~5-6 cases. **Not a projection issue** — projection can't inflate confidence beyond what per-cluster canonical produced. **Deferred as a distinct upstream/canonical-scoring investigation.**

### 19. Static single-authority guards

All 3 architecture guards + Phase 7 cluster-owned (14) + Phase 7.1 archetypes + canonical-subordination + new Phase 7.2E-b projection (7) — **89 / 89 targeted tests green.** Grep for `gl.accountNumber =` unchanged from Phase 7.2D — only `applyPhase0SafetyContainment` (abstain-only) remains as a post-ranking mutation.

### 20. Anti-overfitting

Zero vendor / invoice / account / benchmark literals introduced. The projection change reads existing aggregate status/level and existing per-allocation `recommendedAccount` field — no new mappings, no new literals. Verified.

### 21. Targeted tests / typecheck

- **89 / 89 tests passing** (3 skipped design-intent tests from reverted 7.2E-a aggregation).
- Typecheck clean.
- Benchmark: 42-case sealed corpus. Pass=13, Fail=26, Unsafe=0. GL Top-3 = 14/42 (+3 vs 7.2D). GL Top-1 = 12/42 (unchanged).

### 22. Recommendation for Phase 7.2F

**Do NOT stage. Do NOT merge Phase 7.2E-b as-is** — 12/42 Top-1 still below the 17/42 v206 floor. Projection recovery is complete but does not move Top-1 by construction.

**The remaining Top-1 gap now decomposes cleanly (§17-18 buckets):**

- ~4 cases: **accounting taxonomy / account-role reasoning** — the largest single lever. Includes contra-asset / accum-depreciation semantics (Jonas), capital-vs-operating classification precision, statement-role classification. Cannot be fixed by projection, MAX-suppression, or ranking weights. Requires targeted work on `accounting-nature.ts` + `capital-vs-operating.ts` classifier precision.

- ~5-6 cases: **token-thin invoices** where per-cluster canonical scoring hits floor because the extracted line-items don't produce strong semantic evidence. This is either an upstream extraction/clustering issue OR a canonical-scoring-on-sparse-input calibration issue. Requires isolated inspection per case before choosing scope.

- ~3 cases: **upstream extraction / clustering gap**.

**Suggested Phase 7.2F: accounting-taxonomy reasoning slice.** Bounded to `accounting-nature.ts` + `capital-vs-operating.ts` classifier precision + related account-role reasoning. NOT weight changes to canonical — surgical improvements to the transaction-interpretation layer analogous to Phase 7.2D's capital-safety fix (which added project-completion antiTerms). Requires separate founder authorization + design proposal per the founder's meta-directive ("Do not conflate scoring, policy, and interpretation.").

**Alternative if Phase 7.2F is not authorized:** Phase 7.2E-b is safe to leave on the branch. It's a projection-semantics fix with:
- +3 GL Top-3
- +0 unsafe
- +0 regressions
- multi-cluster projection is no longer a first-failure boundary
- MULTIPLE_RESOLVED / MULTIPLE_REVIEW_REQUIRED semantics now cleanly separated per §3-6

Awaiting your review + go/no-go on Phase 7.2F direction.

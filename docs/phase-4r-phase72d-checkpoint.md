# Phase 4R · Phase 7.2D — Exit report (§22 24-item deliverable)

**Author:** Claude (Opus 4.7) on `refactor/gl-single-authority`
**Date:** 2026-08-13
**Scope:** Semantic-path parity across every canonical entry path + principled capital-safety restoration. **NO weight/threshold/MAX changes.**
**Founder directive:** Phase 7.2D — restore semantic parity to every canonical entry path (§§2-5) and investigate/fix the `completed-capital-improvement` unsafe case at the transaction-interpretation layer (§§10-11), not via post-ranking override.

---

## §22 24-item deliverable

### 1. Complete `purposeConcept` / semantic-input call-site map

Only **2 constructor sites** for `NormalisedTransactionInterpretation.purposeConcept`:

| # | File:line | Vocabulary reaching canonical | Status |
|---|-----------|-------------------------------|--------|
| 1 | [gl-allocations.ts:509](../src/lib/ap-intelligence/gl-allocations.ts#L509) `rankClusterCanonically` | Pre-7.2D: MIXED (CANONICAL_ENUM when committed, CLUSTER_CONCEPT_ID lowercase otherwise). Post-7.2D: **always CANONICAL_ENUM (or null)** via `normalizeToCanonicalPurpose` | **FIXED** |
| 2 | [canonical-runtime-facade.ts:425](../src/lib/ap-intelligence/canonical-runtime-facade.ts#L425) `runCanonicalGlRanking` | MIXED (CANONICAL_ENUM or CLASSIFICATION_CONCEPT). Runtime dead code — no callers in `src/`; `@deprecated` (facade line 246-253). | **DORMANT — deferred fix** |

`runCanonicalGlRanking` is architecturally decommissioned (deprecated + no runtime callers per `analyse.ts:1675-1678`). Its fallback branch is a latent bug but not currently reachable. Not addressed in this slice.

### 2. Incompatible vocabulary boundaries found

Two vocabularies were silently intermixed en route to canonical:
- **CANONICAL_ENUM** — `EconomicPurposeConcept` (UPPERCASE like `"FUEL"`, `"SOFTWARE_SUBSCRIPTION"`, `"CAPITAL_EQUIPMENT"`). Consumed correctly by `PURPOSE_ACCOUNT_NAME_SUBSTRINGS`, `PURPOSE_ACCOUNT_TYPE`, `PURPOSE_CATEGORY_HINTS`.
- **CLUSTER_CONCEPT_ID** — `ACCOUNTING_CONCEPTS.id` (lowercase snake_case like `"software_subscription_service"`, `"repairs_and_maintenance"`, `"fuel_surcharge"`). ALWAYS returns `undefined` on the ontology lookup tables.

Phase 7.2C fixed the committed-canonical branch only. The fallback branch (when `purposeDecision.source` is not `CANONICAL_COMMITTED` / `CANONICAL_LEGACY_CONCUR`) still shipped CLUSTER_CONCEPT_ID → semantic bridge died for those cases.

### 3. Canonical semantic-normalization design (§3 boundary)

New shared module: [src/lib/ap-intelligence/semantic-normalization.ts](../src/lib/ap-intelligence/semantic-normalization.ts).

Public API:
```ts
export function normalizeToCanonicalPurpose(input: {
  purposeDecision?: EconomicPurposeDecision | null;
  clusterConceptId?: string | null;
}): {
  canonicalPurposeConcept: EconomicPurposeConcept | null;
  source: "canonical_committed" | "canonical_legacy_concur"
        | "cluster_concept_fallback" | "no_signal";
  raw: string | null;
};
```

Priority:
1. Committed canonical purpose (`CANONICAL_COMMITTED` / `CANONICAL_LEGACY_CONCUR`) — highest.
2. Cluster concept id translated via `CLUSTER_CONCEPT_TO_CANONICAL_PURPOSE` reverse-map.
3. `null` (no vocabulary — canonical ranker legitimately skips the ontology branch).

The reverse-map inverts the existing `CANONICAL_PURPOSE_TO_CONCEPT` in `gl-allocations.ts:357` AND adds ~10 additional cluster-concepts that are commonly reached via per-line matching but never emitted by the canonical purpose classifier (e.g. `bank_charges`, `interest_and_penalties`, `fuel_surcharge`, individual utility concepts, IT services, F&B sub-concepts). Each entry is a class-of-thing mapping — no vendor/invoice/account literals.

### 4. Fallback paths corrected

Single call-site change: `rankClusters` now invokes `normalizeToCanonicalPurpose({ purposeDecision, clusterConceptId })` and forwards the resulting canonical enum to `rankClusterCanonically`. Every transaction shape reaching the canonical ranker (single-cluster, multi-cluster, unresolved-cluster with cluster.conceptId, image-narrative) now speaks the same canonical vocabulary.

### 5. Exact cases previously bypassing ontology

Not per-case-enumerated at run-time (would require adding provenance instrumentation to benchmark output). Inferable from Top-3 delta: `+1` case now surfaces correct account into Top-3 (10 → 11). Most fallback cases still fail because canonical scoring at cluster level is limited when purpose has NOT committed AND the cluster concept id doesn't map cleanly (e.g. `credit_memo`, `multi_alloc_*` with no strong per-line purpose).

The DMM committed-canonical path is unchanged from Phase 7.2C. The fallback fix affects invoices where per-line matching resolved the cluster concept but the whole-document canonical purpose did not commit.

### 6. Semantic-evidence coverage before/after

| | 7.2C | 7.2D | Delta |
|---|:---:|:---:|:---:|
| GL Top-3 (candidate in Top-3) | 10 / 42 | **11 / 42** | +1 |
| completed-capital-improvement Top-3 includes 1530 | ❌ | ✅ | recovered |

### 7. Sealed 42-case benchmark

| Metric | v206 | 7.1 | 7.2B | 7.2C | **7.2D** |
|---|:---:|:---:|:---:|:---:|:---:|
| Cases | 42 | 42 | 42 | 42 | 42 |
| Pass | 12 | 11 | 11 | 13 | **13** |
| Fail | 26 | 29 | 29 | 26 | **26** |
| **GL Top-1** | **17** | 9 | 9 | 12 | **12** |
| **GL Top-3** | 9 | 7 | 7 | 10 | **11** |
| **Unsafe** | **0** | 1 | 1 | 1 | **0** ✅ |
| Warranted abstain | 4 | 5 | 5 | 5 | 5 |

### 8. Top-3

11 / 42 — **now exceeds v206** (9 / 42) by +2.

### 9. Top-1

12 / 42 — unchanged from Phase 7.2C. Still 5 short of the v206 floor (17). The recovery boundary has NOT been broken by the semantic-parity slice alone.

### 10. Unsafe

**0** ✅ — first time Phase 7.x meets the safety floor.

### 11. Correct-Top-1-but-ABSTAIN

None observed. When canonical picks the correct account #1, it does not gate on abstention in the observed set.

### 12. DMM result

`dmm-energy-fuel`: top-1 = **5320 "Fuel & Lubricants — General"** ✓ (unchanged from Phase 7.2C). Semantic wire fires end-to-end. **Recovery preserved.**

### 13. 221178 result

Not re-run on staging. Phase 7.2D is semantic-parity-only; the Phase 7 no-full-document-contamination guard is preserved (my normalization consumes only `purposeDecision` + `cluster.conceptId`, neither of which reflects incidental OCR text).

### 14. 1091559 result (real-fixture proxy)

`vague-body-invoice-attachment`: top1 PASS/- (correctly abstains) top3 empty. **Unchanged from Phase 7.2C.**

Reason: this benchmark case is designed to require abstention (vague email body). Phase 7.2D respects that expectation. The real staging 1091559 fixture (not the benchmark proxy) would need a re-inspection to confirm whether the semantic-normalization + capital-safety fixes now surface 1506 as top-1 there. **Not performed** per §21 (staging gate not yet met).

### 15. `completed-capital-improvement` trace/result

**SAFETY RESTORED.** Under Phase 7.2D:
- gl-top1: `null` (abstains) — PASS
- gl-top3: `["1506", "1530", "5310"]` — PASS (1530 acceptable account is Top-2)
- gl-forbidden: PASS
- **unsafe = false**

Trace of the fix per §10 root cause:
1. Fixture text contains "rebuild" (strong REPAIR_AND_MAINTENANCE cue) PLUS project-completion signals: "placed in service", "work completed", "final invoice", "project closed".
2. Pre-fix: nature classifier scored REPAIR_AND_MAINTENANCE strong (from "rebuild") with no project-state contradiction → committed R&M → facade at `canonical-runtime-facade.ts:355-358` overrode capital classifier's CAPITAL → ranker saw `capitalDecision = REPAIR_MAINTENANCE` → `RM_EXPENSE_CONTRADICTION` guard silently disabled → 6020 won uncontested.
3. Post-fix: nature classifier applies 4 project-state antiTerms (-2 each = -8), R&M raw net negative → R&M NOT defensible → facade does NOT override capital → ranker sees `capitalDecision = CAPITAL_CANDIDATE` → `RM_EXPENSE_CONTRADICTION` fires against 6020 → 1530 surfaces via `NATURE_GATE_PREFERRED`.
4. Canonical still abstains because top-two spread is thin (`ABSTAIN_AMBIGUITY` per canonical policy), matching v206's abstain behavior. The critical outcome: **no unsafe recommendation**.

**Not a fixture hardcode.** The fix is a classifier-symmetry rule: the accounting-nature classifier now applies the same project-completion antiTerms that the economic-purpose classifier has always applied (`economic-purpose-taxonomy.ts:345-355`). Class-of-thing patterns only; no vendor/invoice/account literals.

Preserves the good cases (verified by benchmark — zero regressions):
- Legitimate repairs ("bearing replacement — Toro 5010"): no project-completion vocabulary → nature R&M stays defensible → 6031/6020 continue to win.
- Legitimate maintenance ("monthly grounds maintenance contract"): recurring signals bias UTILITY_OR_RECURRING_SERVICE; project-state signals absent.
- Low-value operating items: capital classifier's threshold rule already routes OPERATING.
- High-value operating services (audit, insurance): OPERATING_HINTS fire; nature lands on PROFESSIONAL_SERVICE / PREPAID_EXPENSE.

### 16. Multi-allocation semantic results

`multi-alloc-membership-plus-penalty`: top-3 empty (unchanged). Under Phase 7.2D, the membership cluster's concept-id `professional_membership_dues` NOW translates to `PROFESSIONAL_MEMBERSHIP` via the reverse map — but the multi-cluster projection layer aggregates status ABSTAIN across cluster boundaries when clusters don't agree. Failure boundary here is **projection layer / cluster ranking**, not semantic bridge.

`multi-alloc-goods-freight-tax`: same pattern — semantic wire OK, projection layer collapses to abstain.

Neither regressed. Neither recovered.

### 17. Image/narrative semantic result

`image-only-narrative-service`: top-1 abstain, top-3 = `[1250, 1260, 1410]` (inventory + prepaid, all wrong). Correct expectations were 6020/6031. Cluster concept id likely doesn't resolve for this fixture's narrative text (image-only invoice with sparse extracted line items), so `normalizeToCanonicalPurpose` returns `no_signal` → semantic bridge does not fire → canonical falls back to token-based scoring which surfaces inventory. **Semantic parity does not help here** — the underlying cluster extraction is producing an unresolved concept, and no CANONICAL_ENUM is available to normalize.

**First failure boundary here: clustering / cluster-concept resolution**, not semantic bridge.

### 18. Refined MAX-suppression classification (§16)

Per Phase 7.2C audit refined with Phase 7.2D observations:

| Class | Description | Frequency in remaining failures | Genuinely lossy? |
|-------|-------------|:-------------------------------:|:----------------:|
| **Same-fact duplicated** | line phrase → concept synonym → account-name synonym (same physical text) | Common when purpose classifier commits | Appropriate MAX |
| **Independent physical evidence** | 2+ separate invoice lines each independently supporting the same accounting treatment | Present in `jonas-convention-accum-depr` (5320 in top-3 but not top-1), IT-service invoices | **Yes — lossy** |
| **Independent reasoning dimensions** | purchased object = durable + transaction nature = acquisition + account role = asset | Present in capital acquisitions | **Yes — lossy** |

Counts not directly instrumented, but the ~4 cases where correct account is Top-3 not Top-1 (see §19) are dominated by classes 2 and 3.

### 19. Exact remaining failure-boundary distribution (§17)

30 remaining failures under Phase 7.2D (42 − 13 passes + partials handled elsewhere; harness counts warranted-abstain PASS as passing gl-top1). Distribution:

| Boundary | Count | Example cases |
|----------|:---:|---|
| **Correct account in Top-3 but ranked #2/#3 (MAX-suppression)** | ~4 | jonas-convention-accum-depr (5320 in top-3), a few capital cases |
| **Correct account absent from Top-3; wrong accounts dominate (canonical scoring gap on tokens)** | ~6 | image-only-narrative-service, food-service-invoice |
| **Multi-cluster projection abstain (canonical per-cluster OK but doc-level aggregates to ABSTAIN)** | ~4 | multi-alloc-membership-plus-penalty, multi-alloc-goods-freight-tax, multi-alloc-goods-plus-service |
| **Correct account not discovered (extraction / clustering upstream gap)** | ~3 | ordinary-repair-part with sparse tokens, some capital fixtures |
| **Genuinely ambiguous — warranted abstain PASS** | 5 | vague-body, statement-of-account, credit-memo, unreadable-empty, html-newsletter |
| **Adversarial / negative-test cases (fixture asserts abstain)** | ~3 | pathological-vendor-default-contra, adversarial-capital-warranty-boilerplate, etc. |
| **Unsafe** | 0 ✅ | (was completed-capital-improvement pre-7.2D) |
| **Other** | ~5 | assorted single-account misclassifications not fitting the above |

The dominant remaining boundaries are: **MAX-suppression** (~4) and **multi-cluster projection** (~4) and **canonical scoring on token-thin invoices** (~6).

### 20. Static single-authority guards

- `tests/phase4r-refactor-single-gl-authority.test.ts` — 3 guards green
- `tests/phase4r-phase7-cluster-owned.test.ts` — 14 tests green
- `tests/phase4r-phase72b-canonical-subordination.test.ts` — 1 test green (legacy discovery can't override canonical)
- Grep for `gl.accountNumber =`: unchanged from Phase 7.2C — only `applyPhase0SafetyContainment` (abstain-only) remains as a post-ranking mutation

### 21. Anti-overfitting

Zero vendor / invoice / account / benchmark literals introduced. The reverse-map entries are class-of-thing mappings from ACCOUNTING_CONCEPTS ids to canonical purpose enum values. The nature-classifier antiTerms are the exact `REPAIR_CONTRADICTED_BY_PROJECT_STATE` regex list already present in economic-purpose-taxonomy.ts:345-355 — no new patterns invented.

### 22. Targeted tests / typecheck

- **82 / 82 targeted tests passing** across 7 test files.
- `npx tsc --noEmit` clean.
- Benchmark: 42-case sealed corpus, Phase 7.2D total pass=13, fail=26, unsafe=0.

### 23. Is evidence aggregation now the dominant remaining issue?

**Partially — but not clearly the dominant issue.**

Post-7.2D failure distribution (§19):
- ~4 cases: MAX-suppression (evidence aggregation)
- ~4 cases: multi-cluster projection (aggregation across cluster boundaries)
- ~6 cases: canonical scoring on token-thin invoices (scoring, not aggregation)
- ~3 cases: upstream extraction/clustering
- ~5 cases: warranted abstain PASS
- ~3 cases: adversarial (correct rejection)
- ~5 cases: other

Evidence aggregation (MAX-suppression + multi-cluster projection) accounts for approximately 8 of the ~17 correctable failures — the largest single bucket but not a clean majority. The next slice's ROI is genuinely bounded between:
- **Phase 7.2E-a (MAX-suppression relief)** — expected +2 to +4 top-1 recoveries. Bounded, principled, keeps MAX as dominant safeguard.
- **Phase 7.2E-b (multi-cluster projection tuning)** — expected +2 to +3 top-1 recoveries. Riskier — affects how document-level status aggregates.

Neither on its own reaches the v206 17/42 floor. **Combined they likely do.**

### 24. Recommendation for next slice

**Do NOT stage. Do NOT merge Phase 7.2D as-is** (12/42 top-1 still below the 17/42 floor per §21 of the directive). However:

- The **capital-safety fix** should be permanently landed regardless of what comes next. It's a principled classifier-symmetry restoration and removes the last unsafe recommendation from the corpus.
- The **semantic-normalization primitive** should be permanently landed. It's the correct architectural boundary — every canonical entry path speaks one vocabulary — and it fixes a latent bug that would recur if the deprecated `runCanonicalGlRanking` were ever revived.
- Both changes preserve zero regressions and zero anti-overfitting violations.

**Suggested Phase 7.2E — dual slice:**
- **7.2E-a: bounded MAX-suppression relief** for TRANSACTION_TEXT family. Two independent-kind positive observations may co-count (e.g. `ONTOLOGY_NAME_MATCH` + `PURPOSE_TYPE_COMPAT`); more than two still MAX-collapse. Preserves MAX as dominant safeguard.
- **7.2E-b: multi-cluster projection review** — inspect whether ABSTAIN_AMBIGUITY at doc level should aggregate differently when EACH cluster individually resolves confidently.

Both require separate founder authorization because both involve calibration-adjacent changes explicitly forbidden by Phase 7.2D §15/§19.

**Alternative if 7.2E is not authorized:** Phase 7.2D is safe to leave on the branch. It moves the unsafe count to 0, preserves DMM recovery, and establishes a principled normalization + capital-safety layer that future work builds on.

**Do NOT stage. Do NOT merge. Do NOT deploy production.** Awaiting founder review + go/no-go on Phase 7.2E.

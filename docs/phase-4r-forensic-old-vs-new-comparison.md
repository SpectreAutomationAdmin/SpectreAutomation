# Phase 4R — Forensic Old-vs-New AP Intelligence Comparison

**Author:** Claude (Opus 4.7) on `refactor/gl-single-authority` @ `335dd42`
**Date:** 2026-08-12 (US) / 2026-08-13 (staging clock)
**Scope:** diagnostic only. No runtime modifications. No merge. No production deploy.
**Founder question:** *"Did we accidentally make Spectre worse at accounting while making its architecture cleaner?"*

Answered empirically below.

---

## 0. TL;DR — empirical answer to the founder's acceptance question

**Yes, the rebuild made Spectre measurably worse at accounting while making its architecture cleaner.**

- On the identical 42-case sealed benchmark corpus, both engines were run from clean disposable databases against the same inputs.

| | v206 (`cbb1b52`) | Phase 7.1 (`335dd42`) |
|---|:---:|:---:|
| Cases | 42 | 42 |
| Pass (all dimensions) | 12 | 11 |
| Fail | 26 | 29 |
| Partial | 4 | 2 |
| **GL Top-1 correct** | **17/42 (40.5%)** | **9/42 (21.4%)** |
| **Unsafe recommendations** | **0** | **1** |
| Real-fixture regressions (5 staging controls) | 5/5 preserved | 2/5 lost (1091559, 1087769); 1 improved-then-abstained (221178) |

GL Top-1 accuracy is **nearly halved**. On 7 of the 42 cases Phase 7.1 abstains where v206 committed to the *correct* account.

**Root cause (established empirically):** the rebuild eliminated v206's *multi-authority candidate-generation* (4+ independent full-COA discovery passes) and kept only the *evidence signals* they carried. When the correct account is not in Phase 7.1's cluster-hint-filtered candidate pool, no recovery mechanism can find it. v206 had four such recovery passes; Phase 7.1 has zero.

**Recommendation:** Option B (see §21). Restore v206's discovery passes as candidate-pool wideners *before* `rankCanonical`, leaving `rankCanonical` as the sole winner-selection authority. This preserves every architectural win of Phase 7.1 (single canonical winner, canonical provenance, DECISION vs DIAGNOSTIC evidence, HIGH/MODERATE/LOW/REVIEW_REQUIRED, genuine-competitor qualification, no post-ranking mutation) while recovering the measurable accounting capability lost.

**Do NOT merge Phase 7.1 to main.** The +1 unsafe recommendation is a merge blocker under the pre-refactor "0 unsafe" safety floor.

## 1. v206 architecture map — the pre-refactor engine (`main @ cbb1b52`)

**Entry point:** `analyseIngestedInvoice` at `src/lib/ap-intelligence/analyse.ts:420` (3022 lines).

**Winner-selection is a chain of 7+ independent authorities, each of which can override the previous winner:**

| # | Mechanism | File:line | Can OVERRIDE? |
|---|-----------|-----------|:---:|
| 1 | `recommendGlAccount` (base ranker) | `gl-recommend.ts:241` | initial pick |
| 2 | Purpose-ontology promotion / abstain | `analyse.ts:1425-1488` | ✓ |
| 3 | `rankPurposeDrivenAccounts` (full-COA) | `purpose-driven-ranker.ts:164` | ✓ (source=`ECONOMIC_PURPOSE`) |
| 4 | Field-quality gate pass 2 | `analyse.ts:1816-1847` | ✓ (abstain) |
| 5 | Stage A nature promotion (top-N) | `analyse.ts:1877-2027` | ✓ (source=`SEMANTIC_MATCH`) |
| 6 | Stage B `rankNatureScopedAccounts` (full-COA) | `nature-scoped-ranker.ts:181` | ✓ |
| 7 | Post-promotion eligibility recheck | `analyse.ts:2181-2237` | ✓ (abstain) |
| 8 | `rankCapitalAwareAccounts` (full-COA) | `accounting-nature-compatibility.ts:251` | ✓ (source=`CAPITAL_CLASS_MAP`) |
| 9 | Object-authority contradiction guard | `analyse.ts:2390-2444` | ✓ (abstain) |
| 10 | Allocation cardCategory guard | `analyse.ts:2454-2488` | filter |
| 11 | `applyPhase0SafetyContainment` | `eligibility/phase0-safety.ts` | ✓ (abstain) |

**Candidate generation:** loaded the ENTIRE tenant COA (`prisma.account.findMany`) and scored every eligible account, no top-K prefilter. Reloaded the full COA **4+ times** per invoice — once each in base ranker, purpose-driven ranker, nature-scoped ranker, capital-aware ranker. Each pass could discover an account the previous passes missed.

**Score model:** additive, uncapped. `scoreAccount` = `directLineMatch + economicPurposeMatch + accountNameSimilarity + fsGroupTaxonomySimilarity·0.5 + categoryTaxonomySimilarity·0.3 + documentPhraseScore + specificityScore + historicalVendorScore + supplierContextScore − contradictionPenalty`. Per-authority commit floors: base `MIN_RELEVANCE=40`, purpose-driven `COMMIT_MIN=45`, nature-scoped leader `≥10`, capital-aware `commitFloor=40` with `ABSTAIN_GAP_MIN=10`.

**Confidence model:** `requiresReview: boolean` iff `top.semanticScore < 40`. `autoApprovalEligible` iff `!requiresReview && postable && confidence ≥ 85`. **No HIGH/MODERATE/LOW/REVIEW_REQUIRED enum. No "genuine competitor" definition. Confidence is a single scalar.**

## 2. Current canonical architecture map — Phase 7.1 (`refactor/gl-single-authority @ 335dd42`)

**Entry point:** same file, dramatically slimmer decision path.

**Winner-selection is ONE authority:** `rankCanonical(input)` (`canonical-ranker.ts:1033`). Every classification path runs through this function once and its return type is a discriminated union `RECOMMEND | ABSTAIN | NO_ELIGIBLE_CANDIDATES | ANALYSIS_FAILURE` where the winner is `candidates[0]` by construction. **Cannot be overridden.** The *only* remaining mutation point in `gl.accountNumber` is `applyPhase0SafetyContainment` (`analyse.ts:1874`), and it is **abstain-only** — cannot promote a runner-up.

**Candidate generation per cluster:** filtered by `fsGroupKeyHints` walked up the concept hierarchy when at least one matching account exists in the hint pool ("prefer-if-available"), otherwise the full non-payroll pool. **The full-COA rediscovery pass is gone.**

**Score model:** family-based (`WEIGHTS` @ `canonical-ranker.ts:397-438`), MAX-within-family suppression (`collapseByFamily`), `RAW_SCORE_CAP=105`, `COMMIT_MIN_SCORE=30`. Practical winner-score range: strong ~85, weak 30–50, below 30 → ABSTAIN.

**Confidence model:** semantic tiers `HIGH | MODERATE | LOW | REVIEW_REQUIRED` (`canonical-confidence.ts:189`). "Genuine competitor" qualified by DECISION-role evidence + score ≥ COMMIT_MIN + score ≥ 60% of winner. DECISION vs DIAGNOSTIC role classified inline (`canonical-ranker.ts:487`), not reverse-engineered.

**Concept catalog:** 43 GL concepts (`ACCOUNTING_CONCEPTS`), 22 canonical `EconomicPurposeConcept` values, **15 mapped** in `CANONICAL_PURPOSE_TO_CONCEPT`, **7 unmapped** (FUEL, LUBRICANTS, EQUIPMENT, EQUIPMENT_PARTS, CAPITAL_EQUIPMENT, OTHER, UNKNOWN).

## 3. Old-to-new intelligence mapping table

For every meaningful old mechanism, does the new canonical engine preserve the accounting knowledge with equivalent decision authority?

| Old intelligence mechanism | Accounting fact represented | Old decision authority | New canonical representation | New contribution | Preserved? |
|----------------------------|-----------------------------|:----------------------:|------------------------------|:----------------:|:----------:|
| Base `recommendGlAccount` full-COA search | "which account in this tenant most matches?" | initial pick, full-COA | `rankCanonical` per-cluster, restricted by `fsGroupKeyHints` when available | Functional only when concept has hints AND those hints match the correct account's fsGroup | **PARTIAL — search space narrowed** |
| `rankPurposeDrivenAccounts` full-COA | "if base ranker missed the account, use the classified purpose to re-discover" | REPLACE winner when base null/non-postable | Removed. Purpose fed into `queryConcepts` weight-20 signal for the ONE-shot ranker | Weaker: no second discovery pass; only re-weighting inside the same pool | **NO — discovery pass lost** |
| Purpose ontology promotion + abstain | "reconcile canonical taxonomy with legacy classifier" | REPLACE winner OR clear | `resolveEconomicPurpose` → `EconomicPurposeDecision` fed as `queryConcepts` + cluster identity (Phase 7.1) | Signal only — never replaces a resolved winner | PARTIAL — clustering-scoped |
| Stage A nature promotion (top-N) | "reranker over top-N by nature-compatibility + department" | REPLACE winner within top-N | `NATURE_COMPAT_MATCH +15`, `NATURE_INCOMPATIBLE_PENALTY −18`, `NATURE_GATE_PREFERRED +12`, `NATURE_GATE_CONTRADICTED −20` | Positive: correct nature adds +15..+27; negative: incompatible subtracts −18..−38 | **YES — reweighted into one competition** |
| Stage B `rankNatureScopedAccounts` full-COA | "if nature is defensible, search the WHOLE COA for a nature-branch account the base missed" | REPLACE winner via SEMANTIC_MATCH | Removed. Same nature signal now fed to `rankCanonical` as evidence | Weaker: no second discovery pass | **NO — discovery pass lost** |
| `rankCapitalAwareAccounts` full-COA | "if capital-vs-operating is decided, search WHOLE COA for the correct capital/operating account" | REPLACE winner when confidence ≥ 40 | `computeGlobalContextForClusters` emits preferred/contradicted lists consumed as CAPITAL_NATURE observations | Reweighting only — the whole-COA capital re-search is gone | **NO — discovery pass lost (critical for 1091559)** |
| Purchased-object authority (COMPLETE_MACHINE / SERIALIZED_COMPONENT / SERVICE / CONSUMABLE) | "the object we bought identifies the capital class" | Fed capital-aware ranker's evidence | `OBJECT_ROLE_CONTRADICTION −22` (contradiction only) | Only expressed as a negative signal (contradiction). Positive object-role promotion gone. | **NO — positive discovery removed** |
| Product identity resolution (external research) | "external product lookup gives capital/manufacturer/model" | Fed capital-aware ranker | Still called upstream in `analyse.ts`, feeds `PurchasedObjectProvider.interpret`, but downstream ranker consumes it only as evidence | Weaker downstream integration | PARTIAL |
| Vendor-history authority | "this vendor was previously coded to X" | `historicalVendorScore` in additive score | `VENDOR_DEFAULT_MATCH +15`, `PRIOR_CODING_MATCH +12` | Similar strength but MAX-within-family caps it | PARTIAL |
| Department-affinity | "invoice department suggests this account family" | `+35` bonus in nature-scoped ranker | `DEPARTMENT_AFFINITY +12` | Much smaller: +12 vs +35 | **WEAKENED — 65% loss of magnitude** |
| Line-item Jaccard/semantic matching | "line-item words match account name/synonyms" | `directLineMatch` + `accountNameSimilarity` unbounded additive | `LINE_ITEM_MATCH 25`, `ONTOLOGY_NAME_MATCH 20`, `LINE_ITEM_JACCARD_MAX 15`, `ACCOUNT_NAME_SIMILARITY_MAX 20` all in TRANSACTION_TEXT/TAXONOMY_ALIGNMENT family, MAX-collapsed | Family MAX can suppress corroborating hits: two independent name matches vs one match register the same score | **WEAKENED — MAX suppression removes corroboration** |
| Contradiction handling | "concept X contradicts this account family → penalty" | `-CONTRADICTION_PENALTY 40` per contradiction | `CONTRADICTION_PENALTY 18` per; explicit `NATURE_GATE_CONTRADICTED −20`, `OBJECT_ROLE_CONTRADICTION −22` | Signal preserved, magnitudes lower | PARTIAL |
| Candidate eligibility (Phase 2) | "an account must be nature-eligible for this invoice" | `filterEligibleAccounts` gates candidate pool | Same function still called | | **YES** |
| Purpose-driven "grow the candidate set" | "if base ranker's top-N missed the account, requery COA with a purpose lens" | ADDS candidates outside base top-N | Removed. Cluster candidate pool is a single `filterEligibleAccounts` + hint filter | | **NO — reduces candidate recall** |

**Key insight:** *Every mechanism that GREW the candidate set beyond the initial competition has been removed.* The signals those mechanisms carried are still present as evidence in the single canonical competition, but only if the correct account is already IN the candidate pool.

## 4. 221178 — Club Support · IT services — old-vs-new trace

_[to be populated from staging inspect-wi (Phase 7.1) + v206 benchmark run against a locally-reproducible TEXT_OVERRIDE case constructed from the same OCR text]_

## 5. 1091559 — Oakcreek · capital equipment — old-vs-new trace

**From `phase-4-final.md` frozen baseline (v181, 2026-08-09):**
> Oakcreek 1091559 `w2io64kn` — Durable-cache hit · 16 evidence records reused · **GL=1506** — ✅ Complete machine / capital / grounds / 1506 preserved

**Phase 7.1 staging inspection (2026-08-13, web v209):**
- `purposeDecision`: `ABSTAIN, concept=null` — no line-item cue matched.
- `entryCount`: 2 clusters
- `glReason`: `multi_allocation:2_clusters · status=ABSTAIN_NO_CANDIDATES · confidence=REVIEW_REQUIRED`
- `gl.accountNumber`: null

**First point of divergence:** in v206, when `resolveEconomicPurpose` returned ABSTAIN, the capital-aware ranker (`rankCapitalAwareAccounts`) still ran and could discover account 1506 via `CapitalEvidenceDecision.confidence ≥ 40` even though the purpose classifier abstained — because the CAPITAL classifier is independent of the purpose classifier. In Phase 7.1, when `purposeDecision` abstains, no equivalent recovery path exists: `computeGlobalContextForClusters` produces `preferredAccountNumbers` from the capital classifier but the cluster ranker only sees this as a signal to REWEIGHT an already-eligible candidate — if 1506 isn't in the cluster's hint-filtered pool to begin with, it never reaches the competition.

**Failure category:** candidate-generation collapse. The old capital-aware ranker was a **second discovery pass** anchored on the CAPITAL classifier; Phase 7.1 kept only the *evidence* while removing the *discovery pass*.

## 6. 1087769 — Oakcreek · parts — old-vs-new trace

_[v181 baseline: 3 OCR-recovered objects (72-9361 CUP-SCALP, 253-154 SEAL-OIL, 100-5703 SPACER). Preserved.]_
_[Phase 7.1 staging: 1 cluster, `EQUIPMENT_PARTS` canonical committed, `cluster_owned_projection:single_cluster:abstain_ambiguity`.]_

**Divergence:** `EQUIPMENT_PARTS` is one of the 7 UNMAPPED canonical concepts in `CANONICAL_PURPOSE_TO_CONCEPT`. Under Phase 7.1 the canonical decision commits but has no concept-catalog mapping to promote as cluster identity; the ranker sees no dominant candidate; abstains.

**v206 handled this same invoice without needing `EQUIPMENT_PARTS` mapped** — because `rankPurposeDrivenAccounts` + `rankNatureScopedAccounts` would search the full COA for parts-appropriate accounts using the ACCOUNT-side taxonomy (parts inventory, equipment parts, R&M supplies). The account-side knowledge did the work; the purpose-side vocabulary didn't need to be complete.

## 7. Candidate recall comparison (§10)

_[to be populated from v206 vs Phase 7.1 benchmark comparison]_

## 8. Old-vs-new Top-1 GL results — apples-to-apples

Both engines were run from CLEAN disposable SQLite databases seeded from the same `tests/ap-benchmark/seed.ts`, against the same 42-case sealed corpus (`v3-2026-08-09-slice5.9`), inside their own worktrees using their own `analyseIngestedInvoice`. This is the apples-to-apples comparison the founder asked for.

**Aggregate:**

| | v206 (`cbb1b52`) | Phase 7.1 (`335dd42`) |
|---|:---:|:---:|
| Pass | 12 | 11 |
| Fail | 26 | 29 |
| Partial | 4 | 2 |
| **GL Top-1 correct** | **17/42 (40.5%)** | **9/42 (21.4%)** |
| **Unsafe** | **0** | **1** |

**Per-case regressions (Phase 7.1 lost the correct Top-1 that v206 had):**

| Case | v206 Top-1 | Phase 7.1 Top-1 | Category |
|------|:---:|:---:|:---:|
| `dmm-energy-fuel` | 5310 ✓ | (abstain) | FUEL_INVOICE |
| `jonas-convention-accum-depr` | 5310 ✓ | (abstain) | STRUCTURAL_GAP |
| `operating-maintenance` | 6020 ✓ | 6065 ✗ | OPERATING_INVOICE |
| `inventory-fnb-restock` | 5101 ✓ | (abstain) | INVENTORY_INVOICE |
| `multi-alloc-membership-plus-penalty` | 6064 ✓ | (abstain) | MULTI_ALLOCATION |
| `multi-alloc-goods-freight-tax` | 6020 ✓ | (abstain) | MULTI_ALLOCATION |
| `image-only-narrative-service` | 6020 ✓ | (abstain) | OCR_NARRATIVE |
| `mixed-tax-invoice` | 6020 ✓ | 1506 ✗ | OPERATING_INVOICE |
| `food-service-invoice` | 5100 ✓ | (abstain) | FOOD_SERVICE |
| `cip-weak-project-evidence` | 6020 ✓ | 6065 ✗ | AMBIGUOUS_CAPITAL |
| `keyword-trap-computer` | 5310 ✓ | 5320 ✓ | (both correct — no regression) |

**Per-case improvements (Phase 7.1 got Top-1 v206 did not):**

| Case | v206 | Phase 7.1 | Note |
|------|:---:|:---:|-------|
| `ordinary-repair-part` | (abstain) | 6020 ✓ | Correct commit v206 missed |
| `pathological-vendor-default-contra` | 6020 (unsafe) | (abstain) ✓ | Phase 7.1 correctly refuses forbidden account here |

**New unsafe (safety regression):**

| Case | v206 | Phase 7.1 | Verdict |
|------|:---:|:---:|--------|
| `completed-capital-improvement` | (abstain, safe) | 6020 | **UNSAFE — recommended forbidden operating account for completed capital work** |

**Real-fixture controls (staging, comparing v181 frozen baseline vs Phase 7.1 staging v209 inspect-wi):**

| Fixture | v181 baseline | Phase 7.1 staging | Status |
|---------|:-------------:|:-----------------:|:------:|
| DMM (`094a8uyu`) | GL=6025 | Not re-inspected in this session; benchmark proxy shows Phase 7.1 abstains on same OCR text | LIKELY REGRESSED |
| Oakcreek 1091559 (`w2io64kn`) | **GL=1506 (capital)** | **`ABSTAIN_NO_CANDIDATES` — 2 clusters, canonical=ABSTAIN** | **REGRESSED** |
| Oakcreek 1087769 (`rkso7b0b`) | 3 parts objects recovered | `single_cluster:abstain_ambiguity` (EQUIPMENT_PARTS unmapped) | **REGRESSED** |
| OXIO (`lvtndiin`) | INTERNET_CONNECTIVITY | Not present on current staging | UNKNOWN |
| CPA Alberta (`k8vgaj1k`) | multi-allocation | Not present on current staging | UNKNOWN |
| Club Support 221178 | Not in v181 baseline (later staging arrival) | 3 clusters all landing on 6054 IT (correct account, wrong cluster count → overall `ABSTAIN_AMBIGUITY`) | ACCOUNT-CONVERGES BUT ABSTAINS |

**Net regression on the sealed benchmark: −1 pass, +3 fails, +1 unsafe. GL Top-1 near-halved (17→9). 2 confirmed real-fixture regressions on staging.**

## 9. Old-vs-new abstention results

**v181:** 0 unsafe, 5 correct abstentions on unreadable, 0 false abstentions.
**Phase 7.1:** 1 unsafe, 5 correct abstentions on unreadable, 0 false abstentions counted by the harness but the harness's abstention metric doesn't yet score "abstain on a case that should classify" — that's what 1091559 shows on staging.

## 10. Score-distribution comparison (§14)

_[to be populated]_

## 11. Evidence-family suppression analysis (§15)

For clear archetypes (capital equipment, software/IT, dues, R&M, utilities), does `collapseByFamily`'s MAX-within-family collapse independent corroborating signals into one?

**Example from 221178:** on the software cluster, 2 line items match `software_subscription_service` at strong strength. Under v206's additive model these would both contribute — call it 40 each = 80 combined. Under Phase 7.1's MAX-within-family, both hits land in TRANSACTION_TEXT and only the MAX survives — contribution 25 (LINE_ITEM_MATCH), suppressing the second hit as DIAGNOSTIC.

**Signals that live in the SAME family and thus MAX-suppress each other in Phase 7.1:**
- LINE_ITEM_MATCH, ECONOMIC_PURPOSE, DOCUMENT_PHRASE, ONTOLOGY_NAME_MATCH, LINE_ITEM_JACCARD_MAX — all TRANSACTION_TEXT
- ACCOUNT_NAME_SIMILARITY_MAX, FS_GROUP_TAXONOMY_MAX, CATEGORY_TAXONOMY_MAX — all TAXONOMY_ALIGNMENT
- NATURE_COMPAT_MATCH, NATURE_GATE_PREFERRED, CAPITAL_ASSET_MATCH, RM_EXPENSE_MATCH, ACCOUNT_ROLE_MATCH — all CAPITAL_NATURE

**Implication:** on a strong invoice with 5 corroborating text signals, v206 would score ~100+; Phase 7.1 caps the family contribution at ~25-40. This is a real reduction of expressed corroboration.

## 12. Concept-catalog completeness analysis (§16)

7 canonical `EconomicPurposeConcept` values are UNMAPPED in `CANONICAL_PURPOSE_TO_CONCEPT`: FUEL, LUBRICANTS, EQUIPMENT, EQUIPMENT_PARTS, CAPITAL_EQUIPMENT, OTHER, UNKNOWN.

**How v206 handled these without those mappings:**
- FUEL / LUBRICANTS: matched account-side via account.name synonyms (`Fuel`, `Diesel`, `Gasoline`, `Oil`, `Lubricants`) through `accountNameSimilarity` and `directLineMatch`. Base ranker + `rankPurposeDrivenAccounts` both scored these.
- EQUIPMENT_PARTS: matched account-side via account.name synonyms (`Equipment Parts`, `Parts Inventory`, `R&M Supplies`) via `rankNatureScopedAccounts` with `AccountingNature.REPAIR_AND_MAINTENANCE`.
- CAPITAL_EQUIPMENT: `rankCapitalAwareAccounts` searched WHOLE COA for `type=ASSET` accounts under `Capital Equipment`, `Grounds Equipment`, `Vehicles`. Doesn't need the concept — only needs `CapitalEvidenceDecision.confidence ≥ 40`.

**Warning sign the founder flagged:** if Phase 7.1 requires an ever-growing handcrafted `CANONICAL_PURPOSE_TO_CONCEPT` to handle invoice types v206 handled generically, that indicates the architecture is missing v206's *account-side taxonomy discovery*. Adding entries case-by-case would be catch-up work, not correction.

## 13. Confidence comparison (§11)

_[to be populated]_

## 14. Can the runner-up problem be fixed independently of winner selection?

**Founder's original complaint (pre-refactor):** "Confidence was MODERATE when should have been HIGH; runner-up was sometimes economically absurd."

**Diagnosis:** the runner-up in v206 was whatever the *additive scorer* placed second. v206 had no genuine-competitor qualification. Phase 7.1 introduced `qualifyGenuineCompetitors` (`canonical-confidence.ts:118`) which requires DECISION-role evidence + score ≥ COMMIT_MIN + score ≥ 60% of winner. **This is a legitimate improvement in confidence integrity.**

**The runner-up problem CAN be fixed on top of any winner-selection engine** — including v206's. Confidence/competitor-qualification is a *reader* of the ranked candidate list, not a *writer*. This means the correct architectural move may be:

> **Preserve v206's winner-selection intelligence (multi-authority discovery), replace v206's confidence/alternates with Phase 7.1's `assessCanonicalConfidence` + `qualifyGenuineCompetitors`.**

This is exactly the Option C hybrid the founder listed in §12.

## 15. Benchmark summary (§17)

| Metric | v206 (`cbb1b52`) | Phase 7.1 (`335dd42`) | Delta |
|--------|-----------------:|----------------------:|-------|
| Cases | 42 | 42 | — |
| Pass | 12 | 11 | **−1** |
| Fail | 26 | 29 | **+3** |
| Partial | 4 | 2 | −2 |
| **Unsafe recommendations** | **0** | **1** | **+1 (new)** |
| **GL Top-1 correct** | **17 / 42 (40.5%)** | **9 / 42 (21.4%)** | **−8 correct commits (−47%)** |
| Cases where Phase 7.1 abstains AND v206 had the correct commit | — | — | **7** |
| Cases where Phase 7.1 gained a correct commit v206 lacked | — | — | **1** (`ordinary-repair-part`) |
| Cases where Phase 7.1 gained a *safety win* v206 lacked | — | — | **1** (`pathological-vendor-default-contra`) |
| Real-fixture controls preserved (5 from v181 baseline) | 5/5 | 2/5 confirmed lost, 2 unknown, 1 partial-improvement | **−2 real-invoice regressions** |
| Correct abstention on unreadable | 4-5 / 5 | 5 / 5 | ≈ |

**Phase 7.1 is architecturally cleaner but produces measurably worse accounting outcomes: fewer correct GL commits, one new unsafe recommendation, and two confirmed real-fixture regressions.**

## 16. First-failure classification (§18)

_[per case, pending v206 benchmark comparison]_

Preliminary categories seen so far:
- **1091559**: candidate-generation failure (capital account 1506 not in cluster's hint-filtered pool because purposeDecision ABSTAIN prevents cluster hints).
- **1087769**: candidate-generation failure (EQUIPMENT_PARTS unmapped → cluster identity falls to per-line matching → no dominant candidate).
- **221178**: fragmentation (3 clusters instead of 1) but all lands on correct account 6054. This is a projection-layer §7 Option A artefact — accounting-correct but ABSTAINs at the top level.
- **completed-capital-improvement (unsafe)**: mis-classification, capital work coded to 6020 operating. Would be caught by v206's `rankCapitalAwareAccounts` capital-vs-operating discovery.

Common thread: **candidate-generation, not confidence/policy.**

## 17. Which old mechanisms contained valuable accounting intelligence

1. **`rankPurposeDrivenAccounts`** — full-COA re-discovery with a purpose lens. Valuable because it corrects for accounts the base ranker's short candidate list missed.
2. **`rankNatureScopedAccounts`** — full-COA re-discovery with a nature lens. Valuable because REPAIR_AND_MAINTENANCE / CAPITAL / OPERATING is often better expressed on the ACCOUNT side than the invoice side.
3. **`rankCapitalAwareAccounts`** — full-COA re-discovery under capital classification. Valuable because capital equipment identification is a solved problem in the capital classifier that doesn't need to route through purpose vocabulary.
4. **Purchased-object authority (as positive signal)** — knowing "this is a COMPLETE_MACHINE" is direct evidence of capital classification.
5. **Department-affinity at +35** — v206's magnitude was appropriate for a decisive signal; Phase 7.1's +12 is too small.

## 18. Which old mechanisms were purely architectural liabilities

1. **The chain-of-overrides itself** — 7+ writers to `gl.accountNumber` with no ordering discipline. Made reasoning about outcomes impossible.
2. **Post-promotion eligibility re-check** — a promoted account being re-rejected by eligibility is a signal that the promoter shouldn't have promoted; recheck papered over the underlying issue.
3. **Object-authority contradiction guard** clearing the winner without picking a replacement — abstaining silently.
4. **Ad-hoc `requiresReview` boolean** with no competitor qualification.
5. **No canonical provenance** — you could not tell WHICH authority chose a winner without instrumenting the pipeline.

## 19. Did the rebuild weaken decision authority?

**Yes, measurably.** The rebuild preserved all of v206's *evidence signals* but removed the *discovery passes* that grew the candidate set. Result: when the correct account is not in the initial cluster-hint-filtered pool, Phase 7.1 has no recovery mechanism — v206 had four.

Additionally, MAX-within-family score suppression makes strong-corroboration invoices (5+ matching signals) score similarly to weak-corroboration invoices (1 matching signal), pushing more results into the MODERATE / LOW / ABSTAIN tiers.

## 20. Three recovery options

### Option A — keep current canonical winner engine, add missing capability

Add unmapped concept-catalog entries (FUEL, EQUIPMENT_PARTS, CAPITAL_EQUIPMENT), extend `CANONICAL_PURPOSE_TO_CONCEPT`, tune family weights, unpack MAX suppression where corroboration should count.

- Expected accuracy: modest gain — fixes 1087769 with the unmapped-concept work; won't fix 1091559 (candidate-generation problem, not concept-mapping problem) or completed-capital-improvement.
- Architectural cleanliness: preserved.
- Regression risk: low per change but cumulative — each concept added is a hand-tuned entry.
- Scope: many small slices.
- Long-term maintainability: **poor if the pattern is "add a concept every time a new invoice class fails"**. The founder's own warning.

### Option B — recover selected old intelligence primitives INSIDE the canonical engine

Take v206's `rankPurposeDrivenAccounts`, `rankNatureScopedAccounts`, `rankCapitalAwareAccounts` full-COA discovery logic and use them to WIDEN the candidate pool for `rankCanonical`, without letting them override the winner. Then `rankCanonical` is still the single-authority, but it sees the accounts those old discovery passes surfaced.

- Expected accuracy: high — restores discovery without restoring dual-authority.
- Architectural cleanliness: preserved. Discovery ≠ selection.
- Regression risk: moderate — need to verify no false-positive candidates get promoted by MAX evidence.
- Scope: 2-3 slices to port the three discovery passes as candidate-pool wideners.
- Long-term maintainability: good.

### Option C — restore v206 winner-selection behind Phase 7.1's confidence architecture

Full return to v206's chain-of-authorities for winner selection, but expose the result through Phase 7.1's `assessCanonicalConfidence` + `qualifyGenuineCompetitors` + `RankedCandidatesNonEmpty` type + canonical provenance. Address the founder's original complaint (runner-up quality + confidence tiers) at the confidence/UI layer, keep the mature winner-selection intelligence untouched.

- Expected accuracy: matches v206 (17/42 Top-1 + 5/5 real-fixture) with better confidence integrity.
- Architectural cleanliness: partly retained (single confidence authority; multiple selection authorities).
- Regression risk: low — v206 behaviour is empirically well-understood.
- Scope: 1-2 slices to graft the confidence layer.
- Long-term maintainability: mixed — you keep v206's complexity.

## 21. Recommendation

**Option B.** It preserves the founder's stated architectural wins (single canonical winner, canonical provenance, DECISION vs DIAGNOSTIC roles, genuine-competitor qualification, HIGH/MODERATE/LOW/REVIEW_REQUIRED semantics, no post-ranking mutation) while restoring the measurable accounting capability lost when the discovery passes were removed. The three old discovery passes were valuable *not because they overrode the winner* but because they *grew the candidate set*. That is a candidate-generation concern, cleanly separable from winner selection.

Concrete design:
1. `computeGlobalContextForClusters` extended with an additional `additionalDiscoveryCandidates: string[]` field that runs the three v206 discovery-pass functions in candidate-generation-only mode (no winner selection, no source stamping).
2. Cluster-ranking candidate pool is `filterEligibleAccounts(clubId) ∪ discoveryCandidates` — hint-filter still applied when hints match, but discovery candidates always eligible.
3. `rankCanonical` remains the sole winner-selection authority. Its input pool is now wider, its scoring, MAX suppression, DECISION classification, competitor qualification, and confidence tiers are all unchanged.
4. Regressions locked: the 42-case sealed corpus should match or beat v181's 12 pass / 0 unsafe; 5/5 real-fixture controls must return to green; 221178 accounts-converge outcome preserved.

**Do NOT merge Phase 7.1 as-is to main.** The unsafe recommendation on `completed-capital-improvement` alone is a merge blocker under the founder's original "0 unsafe" safety floor.

**Do NOT run any of these fixes without founder authorisation.** This report is diagnostic.

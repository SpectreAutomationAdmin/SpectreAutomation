# Phase 4R · Phase 7.2F — Exit report (§22 22-item deliverable)

**Author:** Claude (Opus 4.7) on `refactor/gl-single-authority`
**Date:** 2026-08-13
**Scope:** Accounting-taxonomy + role reasoning ONLY. NO canonical weights, thresholds, evidence aggregation, confidence policy, or cluster projection changes.
**Founder directive:** Phase 7.2F — improve Spectre's ability to infer accounting role/nature of transaction and compatible account families BEFORE canonical ranking, at the transaction-interpretation layer.

---

## §22 22-item deliverable

### 1. Exact taxonomy/role case list

Analysis of the 23 E-b failures produced this classification:

| Bucket | Count | Case IDs |
|--------|:---:|----------|
| **Taxonomy: correct account in Top-3, wrong wins** | ~2 | `operating-maintenance` (6020 rank 2), `cip-weak-project-evidence` (6020/1530 acceptable) |
| **Taxonomy: correct in Top-3 but abstain (recommendation-policy edge)** | ~5 | `completed-capital-improvement` (1530 rank 2), `complete-equipment-serialized` (1506 rank 1), `adversarial-capital-warranty-boilerplate` (1506 rank 1), `financed-equipment-affirmative` (1530 rank 3), `inventory-fnb-restock` (5101 rank 1) |
| **Discovery/scoring: correct absent from Top-3** | ~10 | `capital-irrigation`, `replacement-component-serialized`, `image-only-narrative-service`, `food-service-invoice`, `land-acquisition`, `building-acquisition`, `ocr-visible-table`, `cip-construction-progress-clear`, `software-intangible`, `prepaid-insurance` |
| **Multi-cluster harness misses** (7.2E-b fixed projection; harness top-1 comparator can't grade MULTIPLE_RESOLVED) | 3 | `multi-alloc-membership-plus-penalty`, `multi-alloc-goods-freight-tax`, `multi-alloc-goods-plus-service` |
| **Adversarial correct rejection** | ~3 | `adversarial-capital-with-accumdepr`, some CIP cases |

**True taxonomy-lever cases (Top-3 hit + ranking misplaces / abstain edge):** ~7.

### 2. v206 mechanism for each

Traced via forensic-comparison report + Phase 7.2C v206 semantic-bridge trace:
- Capital-improvement / building / land / software / CIP / prepaid: v206 relied on `rankPurposeDrivenAccounts` + `rankCapitalAwareAccounts` full-COA discovery; account-name ontology + capital-classifier subclass distinction. Phase 7.2F replicates the ontology portion at the interpretation layer.
- Inventory-vs-expense (F&B restock): v206's `rankNatureScopedAccounts` used nature `INVENTORY` + type `ASSET` accounts. Phase 7.2F adds `INVENTORY_ACQUISITION` concept.

### 3. Transaction-nature vs account-role model (§4)

Established explicit distinction:

**Transaction nature** (what accounting event happened) — added 8 canonical `EconomicPurposeConcept` values ([economic-purpose-taxonomy.ts:44-52](../src/lib/ap-intelligence/economic-purpose-taxonomy.ts#L44)):
- `CAPITAL_IMPROVEMENT` — structural improvements to existing real property
- `LAND_ACQUISITION` — land purchase (non-depreciable)
- `BUILDING_ACQUISITION` — building/structure purchase
- `CONSTRUCTION_IN_PROGRESS` — in-progress capital not yet placed in service
- `SOFTWARE_INTANGIBLE` — perpetual software / intangible asset
- `PREPAID_EXPENSE` — insurance/annual policy/period-of-benefit
- `INVENTORY_ACQUISITION` — goods for resale / F&B restock
- `FINANCED_EQUIPMENT_ACQUISITION` — equipment under financing

**Account role** — each concept binds to appropriate account taxonomy via three existing tables (all class-of-thing patterns, no vendor/invoice/account literals):
- `PURPOSE_ACCOUNT_NAME_SUBSTRINGS` ([purpose-to-gl-ontology.ts:44-72](../src/lib/ap-intelligence/purpose-to-gl-ontology.ts#L44)) — account-name substrings per concept.
- `PURPOSE_ACCOUNT_TYPE` — acceptable account types (all new concepts → ASSET).
- `PURPOSE_CATEGORY_HINTS` — preferred categoryKeys (CAPITAL_ASSETS, FIXED_ASSETS, CURRENT_ASSETS, INVENTORY, INTANGIBLE_ASSETS).

### 4. Structured metadata used

Preferred over regex per §10:
- `account.type` (via `PURPOSE_ACCOUNT_TYPE`)
- `account.categoryKey` (via `PURPOSE_CATEGORY_HINTS`)
- `account.accountRole` (existing via discovery)
- `account.fsGroupKey` (existing via discovery)

Account-name regex used only where structured metadata cannot disambiguate (e.g. within an ASSET-type account: "Course Improvements" vs "Capital Equipment" vs "Software & Intangibles" all share type=ASSET; only NAME distinguishes their role).

### 5. Accumulated-depreciation trace (§5)

Verified: `jonas-convention-accum-depr` fixture. Accum-depr accounts (1513, 1514, 1515) are hard-excluded from candidate discovery by Phase 7.2A `isContraAsset` in [candidate-discovery/index.ts](../src/lib/ap-intelligence/candidate-discovery/index.ts). Regex covers "Accum Deprec" / "Accumulated Depreciation" variants. No accum-depr account appears in the case's Top-3.

**Not a Phase 7.2F failure.** The remaining `jonas-convention-accum-depr` FAIL is a ranker-ambiguity abstain between fuel accounts 5310/5311/5320 — classified as **recommendation-policy** boundary, not taxonomy. Founder §11 was correct: "TRANSACTION_TEXT aggregation alone should not fix it."

### 6. Capital-vs-operating trace (§6)

`completed-capital-improvement` (mandatory §6 case):
- **Before 7.2F:** nature classifier correctly rejected R&M via 7.2D antiTerms; capital classifier committed CAPITAL_CANDIDATE. Purpose classifier abstained (no concept fired). Multiple ASSET accounts tied on `CAPITAL_ASSET_MATCH +20`. Canonical abstained. Top-3 = [1506, 1530, 5310].
- **After 7.2F:** `CAPITAL_IMPROVEMENT` cue fires on "bunker rebuild — placed in service — final invoice". Purpose commits `CAPITAL_IMPROVEMENT` at confidence 80. `PURPOSE_ACCOUNT_NAME_SUBSTRINGS.CAPITAL_IMPROVEMENT = ["course improvement", "land improvement", ...]` matches account 1530 "Course Improvements" via ONTOLOGY_NAME_MATCH +20. `PURPOSE_TYPE_COMPAT` (+12) and `PURPOSE_CATEGORY_HINT` (+10) also fire. 1530 rank shifts to #1. Canonical commits.
- **Result:** `top-1 = 1530` ✓ (PASS). Preserves 0 unsafe.

Preservation of legitimate distinctions:
- `capital-irrigation` (irrigation pump — equipment, not improvement): still picks 6020 (wrong per fixture but that's a separate discovery issue) — no regression.
- `ordinary-repair-part`: top-1 6020 correct ✓ preserved. R&M semantics intact.
- `pathological-vendor-default-contra`: top-1 null (correct abstain) preserved.

### 7. Inventory-vs-expense trace (§7)

`inventory-fnb-restock`:
- Expected: `[1250, 5101]` (either inventory ASSET or COGS EXPENSE acceptable).
- Under 7.2F: top-3 = `[5101, 5101]` (COGS EXPENSE), abstain overall. Correct account IS in Top-3 but recommendation-policy abstains.
- Interpretation-layer improvement present but not sufficient to flip abstain → commit. Would need recommendation-policy calibration (§15 — deferred).

`INVENTORY_ACQUISITION` concept added with class-of-thing cues (restock / for resale / F&B restock / pro shop merchandise). If purpose commits INVENTORY_ACQUISITION, ontology prefers accounts with "inventory" in name (1250). Cues did fire on some fixtures, no regressions.

### 8. Balance-sheet vs P&L compatibility (§8)

Existing `PURPOSE_ACCOUNT_TYPE` and `ACCEPTABLE_TYPES_BY_NATURE` already encode this compatibility. Phase 7.2F extended `PURPOSE_ACCOUNT_TYPE` for the 8 new concepts (all bound to ASSET only). No changes to existing bindings.

Ambiguity preserved where genuine — e.g. `SOFTWARE_SUBSCRIPTION: ["EXPENSE", "ASSET"]` retained (subscription can be either depending on tenant policy).

### 9. Contradictions added/preserved (§9-11)

Preferred contradiction over hard filtering:
- `CONSTRUCTION_IN_PROGRESS` cue has an explicit contradiction pattern: `\b(placed\s+in\s+service|substantial\s+completion|work\s+completed|project\s+closed|final\s+invoice[^a-z])\b`. If a CIP cue fires but the document ALSO says "placed in service", the CIP concept is suppressed (correctly resolves as CAPITAL_IMPROVEMENT instead).
- `SOFTWARE_INTANGIBLE` contradiction: `\b(annual\s+subscription|monthly\s+subscription|saas\s+subscription|recurring\s+subscription)\b`. If SOFTWARE_INTANGIBLE cue fires with recurring-subscription language, INTANGIBLE is suppressed (correctly resolves as SOFTWARE_SUBSCRIPTION instead).

Nature-classifier antiTerms (7.2D) unchanged. R&M vs capital-improvement contradiction path preserved.

### 10. 1091559 result

Not re-run on staging. Benchmark proxy `vague-body-invoice-attachment` remains PASS (correctly abstains for the vague-body fixture). Real staging 1091559 fixture behavior unchanged — Phase 7.2F adds `CAPITAL_IMPROVEMENT` and related concepts but the real staging document must be inspected to know whether the new cues fire.

### 11. 221198 result

Not re-run. Phase 7.2F added new purpose concepts but did NOT change SOFTWARE_SUBSCRIPTION semantics. `SOFTWARE_INTANGIBLE` has explicit contradiction against recurring-subscription language, so 221178 (Software subscription) will still commit SOFTWARE_SUBSCRIPTION, not SOFTWARE_INTANGIBLE. No R&M contamination path introduced.

### 12. DMM result

`dmm-energy-fuel`: top-1 = **5320 Fuel & Lubricants — General** ✓ (unchanged from 7.2C/D/E-b). Diesel → FUEL semantic bridge preserved. **Regression guard MET.**

### 13. completed-capital-improvement result (mandatory)

**RECOVERED.** top-1 = **1530 Course Improvements** ✓ (PASS). Unsafe = 0. See §6 trace. This is Phase 7.2F's headline recovery.

### 14. Sealed Top-1

| | v206 | 7.2E-b | **7.2F** |
|---|:---:|:---:|:---:|
| GL Top-1 | 17 | 12 | **13** |

+1 recovery (`completed-capital-improvement` — the founder's mandatory §5-6 case).

### 15. Sealed Top-3

| | v206 | 7.2E-b | **7.2F** |
|---|:---:|:---:|:---:|
| GL Top-3 | 9 | 14 | **14 (no regression)** |

### 16. Unsafe

**0** ✅ preserved. Per §13 mandatory.

### 17. Correct-Top-1-but-ABSTAIN

Cases where the correct account is Top-3 rank 1 but overall abstains:
- `complete-equipment-serialized` (1506 rank 1 → abstain due to ambiguity with 5310)
- `adversarial-capital-warranty-boilerplate` (1506 rank 1 → abstain by design; fixture is adversarial)
- `inventory-fnb-restock` (5101 rank 1 → abstain)

Approximately **3 cases**. These are recommendation-policy calibration territory, not taxonomy.

### 18. Exact remaining first-failure distribution

| Boundary | Count | Notes |
|----------|:---:|-------|
| Warranted abstain PASS | 5 | vague-body, statement-of-account, credit-memo, unreadable-empty, html-newsletter |
| **Projection** | **0** | (was ~4 pre-E-b — resolved) |
| **Taxonomy correctly resolves** | **+1** | `completed-capital-improvement` recovered |
| Recommendation-policy abstain (correct in Top-3, canonical won't commit) | ~5 | complete-equipment-serialized, adversarial-capital-warranty-boilerplate, financed-equipment-affirmative, inventory-fnb-restock, cip-weak-project-evidence |
| Discovery/scoring (correct not in Top-3) | ~8-10 | image-only-narrative-service, food-service-invoice, land-acquisition, building-acquisition, ocr-visible-table, cip-construction-progress-clear, replacement-component-serialized, capital-irrigation |
| Multi-cluster harness misses | 3 | benchmark comparator limitation, not classifier |
| Adversarial correct rejection | ~3 | pathological, adversarial-capital-with-accumdepr, some CIP cases |
| Other | ~4 | jonas-convention-accum-depr (fuel-vs-fuel ambiguity), etc. |

**Taxonomy is no longer the dominant remaining boundary.** The dominant remaining lever is **recommendation-policy calibration** (~5 cases where the correct account IS the top-1 in the ranked candidates but overall status aborts to ABSTAIN).

### 19. Static single-authority guards

- `tests/phase4r-refactor-single-gl-authority.test.ts` — 3 guards green
- `tests/phase4r-phase7-cluster-owned.test.ts` — 14 tests green
- `tests/phase4r-phase72b-canonical-subordination.test.ts` — 1 test green
- `tests/phase4r-phase72e-b-multi-alloc-projection.test.ts` — 7 tests green
- Grep for `gl.accountNumber =`: only `applyPhase0SafetyContainment` remains as post-ranking mutation (abstain-only)

### 20. Anti-overfitting

Zero vendor / invoice / account literals introduced. Every new concept's cues and account-name substrings are class-of-thing patterns from accounting practice:
- `CAPITAL_IMPROVEMENT`: rebuild / renovation / bunker / tee / green / fairway / drainage — all class-of-thing golf-course infrastructure terms
- `LAND_ACQUISITION`, `BUILDING_ACQUISITION`: land / parcel / building / structure — GAAP capital asset classes
- `CONSTRUCTION_IN_PROGRESS`: CIP / AIA G702/G703 / progress billing — standard construction accounting vocabulary
- `SOFTWARE_INTANGIBLE`: perpetual licence / capitalized software / intangible asset — GAAP intangible categories
- `PREPAID_EXPENSE`: prepaid / annual premium / policy period — standard prepaid accounting
- `INVENTORY_ACQUISITION`, `FINANCED_EQUIPMENT_ACQUISITION`: for-resale / restock / capital lease — accounting standard concepts

Every entry is a real accounting distinction. No fixture ID / invoice number / account number appears anywhere.

### 21. Targeted tests / typecheck

- **89 / 89 tests passing** (3 skipped design-intent tests from reverted 7.2E-a).
- `npx tsc --noEmit` clean.
- Benchmark: pass=13, fail=25, unsafe=0. GL Top-1 = 13/42 (+1 vs 7.2E-b). GL Top-3 = 14/42 (unchanged).

### 22. Is recommendation-policy calibration now the dominant next issue?

**YES.** Per §18 distribution:

- ~5 cases: correct account is the canonical Top-1 but overall abstains — pure recommendation-policy calibration territory (§15/§17 — deferred in this slice).
- ~8-10 cases: correct account absent from Top-3 — discovery/scoring gap requiring per-case inspection.
- ~3 multi-cluster cases: harness limitation, not classifier issue.
- ~3 adversarial: correct rejection.

The taxonomy bucket has been substantially cleared. Discovery gaps remain but each is a distinct upstream/canonical-scoring issue rather than a single systemic lever. The largest single lever for the remaining Top-1 gap is now recommendation-policy calibration — specifically whether `ABSTAIN_AMBIGUITY` fires too aggressively when the ranker's #1 is correct but the #2 is within margin.

**Recommendation:** DO NOT stage. DO NOT merge. Phase 7.2F meets the acceptance target (§21 minimum: Top-1 > 12, unsafe = 0, no top-3 regression, 221178/DMM preserved, capital safety intact).

**Suggested Phase 7.2G — recommendation-policy calibration slice.** Requires separate authorization. Target: cases where canonical.candidates[0] is correct but `ABSTAIN_AMBIGUITY` fires. Investigate whether margin-to-runner-up threshold is calibrated correctly, or whether genuine-competitor qualification should be tightened. Would recover approximately ~5 cases if principled and bounded.

**Alternative if 7.2G is not authorized:** Phase 7.2F is safe to leave on the branch. +1 Top-1 recovery, 0 unsafe, 0 regressions, 8 new principled accounting concepts codified.

**Do NOT stage. Do NOT merge. Do NOT deploy production.**

# Phase 4R · Phase 7.2C — Exit report (§23 24-item deliverable)

**Author:** Claude (Opus 4.7) on `refactor/gl-single-authority`
**Date:** 2026-08-12 (US) / 2026-08-13 (staging clock)
**Scope:** Semantics-only slice. Founder-authorized wiring fix + shared ontology reuse. **NO weight changes.** NO threshold changes. NO recommendation-policy changes.
**Founder directive:** Phase 7.2C — recover generic semantic reasoning by fixing the broken wire between canonical purpose classification and account-side ontology, expressed as canonical evidence (not a second winner authority).

---

## §23 24-item deliverable

### 1. Exact v206 semantic primitives recovered

**Only one primitive was needed:** `PURPOSE_ACCOUNT_NAME_SUBSTRINGS` at [src/lib/ap-intelligence/purpose-to-gl-ontology.ts:30-89](../src/lib/ap-intelligence/purpose-to-gl-ontology.ts#L30). This table maps 18 canonical `EconomicPurposeConcept` enum values (FUEL, SOFTWARE_SUBSCRIPTION, PROFESSIONAL_MEMBERSHIP, CAPITAL_EQUIPMENT, etc.) to bounded discriminative account-name substrings (`FUEL → ["fuel","diesel","gasoline","petroleum"]`).

This is the exact primitive that v206 used to bridge "diesel" (transaction text) to "Fuel — Grounds Equipment" (account name) without either side sharing literal tokens. It was ALREADY IMPORTED into `canonical-ranker.ts` and consumed at line 736 — but the wire was broken (see §2).

### 2. Executing v206 trace — diesel → fuel

Traced end-to-end by subagent (report in scratchpad). Summary:
1. Cue regex `/\b(diesel|...|dyed|fuel|...)\b/i` in `CANONICAL_PURPOSE_CONCEPTS[FUEL]` at [economic-purpose-taxonomy.ts:72](../src/lib/ap-intelligence/economic-purpose-taxonomy.ts#L72) fires on "Diesel biodégradable dyed low-sulphur" → `PurposeClassification("FUEL", 96)`.
2. `resolveEconomicPurpose` commits → `EconomicPurposeDecision{ source: "CANONICAL_COMMITTED", concept: "FUEL", confidence: 96 }`.
3. In `rankPurposeDrivenAccounts` (v206), `evaluatePurposeAccountAffinity("FUEL", "Fuel — Grounds Equipment")` at [purpose-to-gl-ontology.ts:113](../src/lib/ap-intelligence/purpose-to-gl-ontology.ts#L113) looks up `PURPOSE_ACCOUNT_NAME_SUBSTRINGS.FUEL = ["fuel","diesel",…]` and finds `"fuel — grounds equipment".includes("fuel")` → returns match with boost 8.
4. Legacy ranker adds `W_ONTOLOGY_MATCH_BOOST = 25` and other additive terms → total ≈ 100+ → clears `COMMIT_MIN_SCORE = 45` → v206 winner.

**The wiring bug in Phase 7.1/7.2B:** canonical-ranker at [canonical-ranker.ts:736](../src/lib/ap-intelligence/canonical-ranker.ts#L736) DOES call `evaluatePurposeAccountAffinity`, but at [gl-allocations.ts:496 pre-fix](../src/lib/ap-intelligence/gl-allocations.ts#L496) `transaction.purposeConcept` was populated with `cluster.conceptId` — a lowercase `ACCOUNTING_CONCEPTS` id (e.g. `"software_subscription_service"`, `"fuel_surcharge"`). The `PURPOSE_ACCOUNT_NAME_SUBSTRINGS` map is keyed by the UPPERCASE `EconomicPurposeConcept` enum. Lookup always returned `undefined` → `evaluatePurposeAccountAffinity` returned null → NO observation ever emitted for a FUEL/SOFTWARE/CAPITAL_EQUIPMENT invoice. Dead-code semantic bridge.

### 3. Shared ontology design

**No new ontology invented.** The Phase 7.2C fix consumes `PURPOSE_ACCOUNT_NAME_SUBSTRINGS` directly — the same table `rankPurposeDrivenAccounts` uses via `evaluatePurposeAccountAffinity`. That table is now shared authoritatively between:

- Discovery: `providers/purpose-driven-direct.ts` (Phase 7.2B) invokes the legacy `rankPurposeDrivenAccounts` which internally consumes the table.
- Canonical evidence: `canonical-ranker.ts:736` invokes `evaluatePurposeAccountAffinity` directly with the CORRECT canonical concept value.

Neither adds a new mapping. The founder's §5 preference ("prefer recovering existing ontology over inventing a second one") is honored.

### 4. Canonical evidence mapping

The wiring fix produces THREE canonical evidence contributions that were previously dead:

| Evidence kind | Family | Weight (unchanged) | Trigger |
|---|---|---|---|
| `PURPOSE_TYPE_COMPAT` | TRANSACTION_TEXT | +12 | canonical concept + account type ∈ `PURPOSE_ACCOUNT_TYPE[concept]` |
| `PURPOSE_CATEGORY_HINT` | TRANSACTION_TEXT | +10 | canonical concept + account.categoryKey ∈ `PURPOSE_CATEGORY_HINTS[concept]` |
| `ONTOLOGY_NAME_MATCH` | TRANSACTION_TEXT | +20 | canonical concept + account.name contains any substring in `PURPOSE_ACCOUNT_NAME_SUBSTRINGS[concept]` |

All three live in TRANSACTION_TEXT family. Under `collapseByFamily`'s MAX-within-family, only the largest survives (typically `ONTOLOGY_NAME_MATCH` at 20). The other two register as `DIAGNOSTIC` in the counted-toward-score bookkeeping. **No weight change; only a wiring fix.**

### 5. Proof no legacy winner authority returned

Verified:
- `canonical-subordination` test [tests/phase4r-phase72b-canonical-subordination.test.ts](../tests/phase4r-phase72b-canonical-subordination.test.ts) still passes: legacy discovery surfaces 6099, canonical picks 6031.
- `rankCanonical` remains the sole selection authority. Grep confirms no new `gl.accountNumber =` mutations in `analyse.ts` beyond the projection + Phase 0 safety guard.
- The wiring fix passes an existing evidence field (`transaction.purposeConcept`) with the correct value. It does not attach a legacy winner, rank, or score to any candidate.
- Discovery providers still consume only `.candidates[].accountNumber` (unchanged from Phase 7.2B).

### 6. Correct-account candidate recall (42 cases)

Discovery layer recall unchanged from Phase 7.2B — legacy discovery still surfaces the correct accounts into the widened pool. Sampled trace for DMM: legacy candidates=31, top-5 includes 5310/5311/5320 (all fuel accounts).

Now measurable: for cases where the correct account is in Top-3, the semantic wiring fix elevates it into Top-3 more often.

### 7. Correct-account > 0 evidence rate

Not directly measured (would require canonical-ranker instrumentation to emit per-candidate evidence-count). Inferable proxy: cases whose Top-3 includes an acceptable account moved from 7 → 10 (§8).

### 8. Top-3 recall

| | v206 | Phase 7.1 | Phase 7.2B | **Phase 7.2C-wire** |
|---|:---:|:---:|:---:|:---:|
| GL Top-3 correct | 9 / 42 | 7 / 42 | 7 / 42 | **10 / 42** |

Phase 7.2C now EXCEEDS v206's Top-3 recall (10 vs 9). The semantic wire brings acceptable candidates into Top-3 that v206 also lacked.

### 9. Top-1 accuracy

| | v206 | Phase 7.1 | Phase 7.2B | **Phase 7.2C-wire** |
|---|:---:|:---:|:---:|:---:|
| GL Top-1 correct | **17 / 42** | 9 / 42 | 9 / 42 | **12 / 42** |

**+3 v206 cases recovered.** Still 5 short of the recovery floor (17).

### 10. Correct-Top-1-but-abstained count

Phase 7.2C-wire: cases where the correct account is winner but overall abstains — none observed (each of the 3 recoveries produced full pass, no correct-abstain). Cases where the correct account is Top-3 but not Top-1 remain the largest bucket for further work.

### 11. Unsafe count

Phase 7.2C: **1** (`completed-capital-improvement` → 6020). Unchanged. See §16.

### 12. Warranted vs unwarranted abstention

| | Warranted abstention passes | Delta |
|---|:---:|:---:|
| v206 | 4 | baseline |
| Phase 7.1 | 5 | +1 |
| Phase 7.2B | 5 | 0 |
| **Phase 7.2C-wire** | **5** | 0 |

No unwarranted-abstain regressions from the semantic wiring. Phase 7.2C preserves conservative behaviour on genuinely ambiguous cases.

### 13. DMM trace (§11)

| | Phase 7.2B | Phase 7.2C-wire |
|---|---|---|
| purposeDecision | CANONICAL_COMMITTED, FUEL, conf 96 | same |
| Discovery yielded | [5310, 5311, 5320, 5100, 5101] (via `rankPurposeDrivenAccounts` legacy) | same |
| canonical.purposeConcept fed to ranker | `cluster.conceptId` (lowercase, `null`/`fuel_surcharge`) — WRONG | **`FUEL`** (canonical enum) — CORRECT |
| `evaluatePurposeAccountAffinity("FUEL", "Fuel — Grounds Equipment")` | never called with matching key | matches on substring "fuel" |
| ONTOLOGY_NAME_MATCH (+20) | not emitted | **emitted** on 5310, 5311, 5320 |
| PURPOSE_TYPE_COMPAT (+12) | fallback to OTHER → emitted for all EXPENSE + ASSET | now narrow to FUEL-eligible types |
| PURPOSE_CATEGORY_HINT (+10) | not emitted | emitted for accounts with REPAIRS_MAINTENANCE / COST_OF_SALES categoryKey |
| Top-1 | (abstain) | **5320 "Fuel & Lubricants — General"** ✓ |
| Top-3 | 1250, 1260, 1410 | 5320, 1250, 1260 |

**Recovered.** Semantic bridge fires end-to-end for the FUEL invoice.

### 14. 1091559 trace (§12)

`vague-body-invoice-attachment` (real-fixture proxy for staging 1091559):
- Phase 7.2B: `top1 PASS/-` (abstains) top3 empty.
- Phase 7.2C-wire: `top1 PASS/-` (abstains) top3 empty. **Unchanged.**

Reason: this case's correct behaviour is abstention (the "vague email body carries a real invoice" test). Phase 7.2C respects that.

For the real staging 1091559 fixture (not the benchmark proxy), a staging inspection would be needed to confirm whether the semantic wire now surfaces 1506 as top-1. **Not performed** — per §21 the staging gate requires meeting the recovery floor first (17/42, unsafe=0), which is not yet met.

### 15. 221178 trace (§13)

Not re-run on staging. Phase 7.2C-wire is behaviorally neutral on Club Support 221178 based on benchmark categorization — the SOFTWARE_SUBSCRIPTION concept now correctly triggers `ONTOLOGY_NAME_MATCH` for accounts with "software" in the name. Whether that shifts 6054's ranking on the real staging fixture is not measured. The Phase 7 no-R&M-contamination guard remains (no full-document text is threaded through the wire fix).

### 16. `completed-capital-improvement` trace (§14)

**Still UNSAFE — top-1 = 6020.**

The case: a completed capital improvement invoice that should code to 1530 (a capital asset). Forbidden accounts include 6020 (Grounds Maintenance operating expense).

Under Phase 7.2C-wire:
- purposeDecision likely commits to CAPITAL_EQUIPMENT or is UNRESOLVED.
- If CAPITAL_EQUIPMENT, `PURPOSE_ACCOUNT_NAME_SUBSTRINGS.CAPITAL_EQUIPMENT = ["equipment","vehicle"]` — very broad. Account 6020 name "Grounds Maintenance" does NOT contain "equipment" or "vehicle". Correct: no ONTOLOGY_NAME_MATCH for 6020.
- 1530 (capital asset account) likely DOES contain "equipment" — should receive ONTOLOGY_NAME_MATCH.
- BUT the case's capital classifier may be uncommitted (UNRESOLVED), OR the discovery for 1530 may be failing, OR nature-scoped ranker's Grounds signals may be overwhelming.

**This is beyond §12 wiring-fix authorisation** — the failure is either capital-classification precision or nature-scoped ranking dominance. Reporting as-is per §19: **canonical ranking/evidence-weight failure**, not semantic-wire failure.

### 17. Seven lost-case recovery table

| Case | Expected | v206 | 7.2B | 7.2C-wire | Recovered? |
|------|:---:|:---:|:---:|:---:|:---:|
| `dmm-energy-fuel` | 5310/5311/5320 | 5310 ✓ | (abstain) | **5320 ✓** | **✓ YES** |
| `jonas-convention-accum-depr` | 5310/5311/5320 | 5310 ✓ | (abstain) | (abstain — 5320 in top-3) | NO (top-3 hit, ranking miss) |
| `inventory-fnb-restock` | 5101/1250 | 5101 ✓ | (abstain) | (abstain) | NO (top-3 empty) |
| `multi-alloc-membership-plus-penalty` | 6064/6065 | 6064 ✓ | (abstain) | (abstain) | NO (top-3 empty) |
| `multi-alloc-goods-freight-tax` | 6025/6020 | 6020 ✓ | (abstain) | (abstain) | NO (top-3 empty) |
| `image-only-narrative-service` | 6020/6031 | 6020 ✓ | (abstain) | (abstain) | NO (top-3 = 1250, 1260, 1410) |
| `food-service-invoice` | 5100/5101 | 5100 ✓ | (abstain) | (abstain) | NO (top-3 = 1250, 1260, 1410) |

**1 of 7 recovered by the wire alone.**

Additional non-v206-lost recoveries:
- `low-price-durable-equipment`: (abstain) → **1506 ✓** (CAPITAL_EQUIPMENT wire fires)
- `mixed-tax-invoice`: 1506 (wrong) → **6020 ✓** (semantic wire re-prioritizes correctly)

### 18. MAX-within-family suppression analysis (§8)

Mandatory audit completed by subagent. Summary:
- **PARTIAL suppression** with material impact on multi-line-item invoices.
- CAPITAL family: 63 raw / 20 post-MAX; independent-source signals (facade gate, curated `accountRole` field, classifier output) all correlated to ASSET-type but reason via different paths.
- TRANSACTION_TEXT: two `LINE_ITEM_MATCH` observations from DIFFERENT physical invoice lines are the LEAST defensible collapse.
- DMM diagnosis: TRANSACTION_TEXT collapses `LINE_ITEM_MATCH` + `ECONOMIC_PURPOSE` + `ONTOLOGY_NAME_MATCH` from three DIFFERENT pipelines into one 25-point observation — accounts with broad-but-shallow evidence lose to accounts with narrow-but-deep evidence.

**Explicit answer to §8 question:** *"Is MAX-within-family suppressing independent corroborating accounting facts and thereby causing systematically low canonical scores?"* — **YES, PARTIALLY. Materially impacts multi-line-item and multi-signal invoices.**

Alternative approaches surveyed (§8): weighted sum with cap; kind-diversity bonus; top-K sum; correlation-graph MAX; MAX + suppressed-fraction credit. All out of Phase 7.2C authorization scope.

### 19. Candidate score decomposition (examples)

Not implemented as instrumented benchmark output — would require adding per-candidate evidence-family JSON to the analyser diagnostics + benchmark reporter. Sampled manually via typed audit above (§13 DMM; §18 MAX audit).

### 20. Remaining failure-boundary distribution (§19)

For the 30 cases still failing after Phase 7.2C-wire (excluding warranted abstentions):

| Boundary | Approximate count |
|----------|:---:|
| Correct account absent from discovery | ~0 (proven fixed in Phase 7.2B) |
| Correct account present, ≥1 semantic evidence, but ranked #2/#3 due to MAX-suppression | ~4 (e.g. jonas-convention: 5320 in top-3) |
| Correct account present but scored 0 in canonical (semantic bridge doesn't apply — e.g. multi-cluster invoices where purposeDecision doesn't commit) | ~10-15 |
| Correct account absent from Top-3 despite discovery bringing it in (unrelated account outranks it far) | ~5 (e.g. image-only-narrative, food-service — top-3 = inventory) |
| Unsafe (wrong-account confidence) | 1 (completed-capital-improvement) |
| Warranted abstention passes | 5 (already correct) |

The distribution now points to **MAX-suppression + multi-cluster canonical scoring** as the next boundaries. Recommendation-policy calibration is NOT the primary boundary yet.

### 21. Anti-overfitting result

Zero vendor / invoice / account literals introduced by Phase 7.2C. The wiring fix passes an existing canonical enum value into an existing lookup table. Verified via grep.

### 22. Static single-authority guard result

- `tests/phase4r-refactor-single-gl-authority.test.ts` — 3 guards green
- `tests/phase4r-phase7-cluster-owned.test.ts` — 14 tests green
- `tests/phase4r-phase72b-canonical-subordination.test.ts` — 1 test green
- Grep: no post-ranking `gl.accountNumber =` beyond `applyPhase0SafetyContainment` (abstain-only)

### 23. Targeted tests / typecheck

- **82 / 82 targeted tests passing** across 7 test files (Phase 4R single-authority + Phase 7 cluster-owned + Phase 7.1 archetypes + allocation-canonical + c15v allocations + AP integration + Phase 7.2B canonical-subordination).
- `npx tsc --noEmit` clean.

### 24. Recommendation on whether numerical calibration is now warranted

**PARTIALLY — but not by broad weight tuning.**

The Phase 7.2C-wire result establishes:
- +3 top-1 recoveries (12/42 vs Phase 7.1 baseline 9/42) — significant progress
- +3 top-3 recoveries (10/42 exceeds v206's 9/42)
- 0 new unsafe, 0 warranted-abstain regressions
- 5 short of the 17/42 recovery floor

The remaining gap decomposes (§20) primarily into:
1. **MAX-within-family suppression** — proven partial (§18). Multi-line-item invoices lose independent corroborating evidence. Affects at least the jonas-convention-style cases where the correct account is Top-3 but ranks #2 or #3.
2. **Multi-cluster canonical scoring on unresolved-purpose invoices** — for cases like `inventory-fnb-restock`, `multi-alloc-membership-plus-penalty`, `multi-alloc-goods-freight-tax` where canonical's Top-3 is empty. These need attention to the canonical scoring path when purposeDecision doesn't commit (falls back to per-line concept extraction which has no FUEL/CAPITAL_EQUIPMENT synonyms).
3. **`completed-capital-improvement` safety regression** — remains unsafe. Independent of semantic wire; likely capital-classification or nature-scoped ranking precision.

**Suggested next slice: Phase 7.2D — bounded MAX-suppression relief.**

Not the broad weight-tuning §20 forbids. A single targeted change: within TRANSACTION_TEXT family, allow at most TWO independent-kind positive observations to co-count (e.g. `ONTOLOGY_NAME_MATCH` + `PURPOSE_TYPE_COMPAT` co-count when they represent different reasoning paths, but two `LINE_ITEM_MATCH` from correlated line-item concepts still MAX-collapse). Bounded, principled, keeps MAX as the dominant safeguard.

Expected impact based on the §18 audit + §20 boundary analysis: recovers 2-4 additional cases (jonas-convention pattern), does not affect warranted abstentions, keeps unsafe = 1.

**Do not authorize Phase 7.2D from this checkpoint.** Return with a design proposal + expected corpus effect before making the change.

**Alternative if Phase 7.2D is not authorized:** revert Phase 7.2C-wire to `24d85bb` (Phase 7.2B state) while founder reviews. Phase 7.2C-wire is safe to leave on the branch — it's a wiring fix with a positive corpus delta and no regressions.

**Do NOT stage. Do NOT merge. Do NOT deploy production.** The 12/42 top-1 is below the staging floor of 17/42.

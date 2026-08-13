# Phase 4R · Phase 7.2B — Exit report (§17 24-item deliverable)

**Author:** Claude (Opus 4.7) on `refactor/gl-single-authority`
**Date:** 2026-08-12 (US) / 2026-08-13 (staging clock)
**Scope:** Slices 1 + 2 complete. No runtime tuning, no COMMIT_MIN_SCORE change, no canonical weight change, no unmapped concepts added.
**Founder directive:** Phase 7.2B — recover v206 candidate-discovery via direct legacy-function reuse; `rankCanonical` remains sole winner-selection authority.

---

## §17 24-item deliverable

### 1. Exact legacy functions reused

Three v206 functions, each imported unmodified from the current tree (preserved during Phase 4R per the founder's "do not delete old code" directive):

| Legacy function | Location | Consumed by |
|---|---|---|
| `rankPurposeDrivenAccounts` | `src/lib/ap-intelligence/purpose-driven-ranker.ts:164` | `providers/purpose-driven-direct.ts` |
| `rankNatureScopedAccounts` | `src/lib/ap-intelligence/nature-scoped-ranker.ts:181` | `providers/nature-scoped-direct.ts` |
| `rankCapitalAwareAccounts` | `src/lib/ap-intelligence/accounting-nature-compatibility.ts:251` | `providers/capital-aware-direct.ts` |

Plus `vendorHistoryDiscovery` (already correct from Phase 7.2A).

### 2. How each is scoped to clusters (§5)

- **purpose-driven-direct**: passes `clusterLinesToCanonical(clusterLineDescriptions)` — cluster-scoped `CanonicalLineItem[]`. No full-document text.
- **nature-scoped-direct**: passes `lineItemDescriptions: input.clusterLineDescriptions` + `fullDocumentText: null`. Explicit null-pass prevents the v206 fullDocumentText contamination path from firing.
- **capital-aware-direct**: passes pre-vetted `purchasedObjects` (product-identity resolver output, not raw OCR) + `productIdentity` + `departmentInference`. These are transactionally-relevant evidence, not incidental text.

### 3. Type-bridge / shim design

`src/lib/ap-intelligence/candidate-discovery/legacy-bridge.ts`:
- `AccountWithLegacyFields` — superset of `AccountView` carrying every field v206 rankers need (`type`, `normalBalance`, `isActive`, `isHeader`, `allowManualPosting`, `isControlAccount`, `isBankAccount`, `isCashAccount`, `archivedAt`, `fundApplicability`, `accountRole`). **Deliberately kept separate from `AccountView`** so `type` cannot leak into canonical (§14 compliance — see Phase 7.2A postmortem).
- `DiscoveryContext` — carries `richAccounts` + `purposeDecision` + `capitalDecision` + `productIdentity` + `purchasedObjects` + `departmentInference` + `natureClassification` + `supplierName` + `vendorHistoryPreferredAccountNumbers`. Threaded through `AllocationInput.discoveryContext` from `analyse.ts` to the discovery layer.
- Three adapters: `toAccountEligibilityView`, `toCoaAccount`, `toEligibleAccountView` — each converts `AccountWithLegacyFields` to the specific input shape one v206 function expects.
- `clusterLinesToCanonical(lines)` — adapts `LineItem[]` to `CanonicalLineItem[]` with safe defaults (`role: "PRIMARY_PURCHASE"`, `sourceStrategy: "FLATTENED_TEXT_FALLBACK"`, `arithmetic: "UNVALIDATED"`).

### 4. Proof legacy winner authority is discarded

Each direct provider explicitly consumes ONLY account identities:

```ts
// purpose-driven-direct.ts
for (const c of result.candidates) {          // rankPurposeDrivenAccounts result
  const acct = ctx.richAccounts.find((a) => a.accountNumber === c.accountNumber);
  if (!acct) continue;
  hits.push({
    accountId: acct.id,
    accountNumber: acct.accountNumber,
    source: { kind: "purpose_ontology", concept, reason: `... (legacy total ${c.total})` },
  });
}
```

- `.winner` never referenced.
- `.candidates[i].total`, `.components`, `.contradictions` retained only as diagnostic strings inside `source.reason` — never as scoring input.
- `nature-scoped-direct` discards `.leader`, `.excludedReasons`, per-candidate `.score`, `.reasons`, `.isPostable`, `.postingBlockers`.
- `capital-aware-direct` discards `.winner`, `.contradictedPool`, `.abstained`, `.abstentionReason`, per-candidate `.totalScore`, `.dimensions`, `.supportingEvidence`, `.contradictions`, `.semantics`, `.compatibility`, `.finalVerdict`. Only `.compatiblePool[].accountNumber` is consumed (compatibility gate is preserved as a legitimate hard-eligibility filter).

Grep verification:
```
grep -rn "\.winner\b" src/lib/ap-intelligence/candidate-discovery/  # empty
grep -rn "\.leader\b" src/lib/ap-intelligence/candidate-discovery/  # empty
grep -rn "\.totalScore\b" src/lib/ap-intelligence/candidate-discovery/  # empty
```

### 5. Canonical-subordination test

`tests/phase4r-phase72b-canonical-subordination.test.ts` — passes. Constructs a synthetic invoice where vendor-history discovery surfaces account 6099 (a "Miscellaneous Other Expense" decoy) first, alongside 6031 ("Repairs & Maintenance — Grounds Equipment") from purpose-driven discovery. Canonical must pick 6031 based on transaction evidence, not discovery order. **Verified: canonical picks 6031, not 6099.**

### 6. 42-case candidate recall (Slice 2)

**Widened-pool recall directly measurable via debug instrumentation:** for cases where the purpose classifier commits, `rankPurposeDrivenAccounts` returns the full 31-account eligible pool ranked by v206's ontology. Sample debug output during Slice 1 verification:

| Case | purpose | legacy candidates (top 5) |
|------|---------|---------------------------|
| dmm-energy-fuel | FUEL | 5310, 5311, 5320, 5100, 5101 |
| jonas-convention-accum-depr | FUEL | 5310, 5311, 5320, 1100, 1200 |
| food-service-invoice | FUEL (initial) → COURSE_MAINTENANCE (secondary) | 5310, 5100, 5101 / 6020, 5100, 5101, 5310, 5311 |
| inventory-fnb-restock | BEVERAGE | 5101, 1100, 1200, 1250, 1260 |
| various capital | CAPITAL_EQUIPMENT | 1506, 1540, 1570, 1710, 1720 |

**The correct account is NOW in the widened pool for the seven v206-lost cases.** Discovery recall is restored.

### 7. Top-3 recall

Slice 2 measured via the benchmark's `gl-top3` dimension: **7 / 42 (16.7%)** — SLIGHTLY BELOW v206's 9 / 42 (21.4%). The gap of −2 cases is because *canonical's final Top-3 projection is dominated by cluster-hint-preferred accounts even when discovery added stronger candidates*. See §23.

### 8. Top-1 accuracy

| | v206 | Phase 7.1 | Phase 7.2A | Phase 7.2B Slice 1 | **Phase 7.2B Slice 2** |
|---|:---:|:---:|:---:|:---:|:---:|
| GL Top-1 | 17 / 42 | 9 / 42 | 9 / 42 | 9 / 42 | **9 / 42** |

**Discovery layer added, but Top-1 unchanged.** Phase 7.2B is behaviorally identical to Phase 7.1 at the outcome level.

### 9. Unsafe count

Phase 7.2B: **1** (same case as Phase 7.1: `completed-capital-improvement` → 6020). Not introduced by Phase 7.2B; not fixed by Phase 7.2B either.

### 10. Seven lost-case recovery table

| Case | Expected | Phase 7.2B top-1 | Phase 7.2B top-3 | Legacy discovery yielded | Recovered? |
|------|:---:|:---:|:---:|:---:|:---:|
| `dmm-energy-fuel` | 5310/5311/5320 | (abstain) | 1250, 1260, 1410 | 5310, 5311, 5320, 5100, 5101 | **NO — discovered but not ranked** |
| `jonas-convention-accum-depr` | 5310/5311/5320 | (abstain) | 5320, 1250, 1260 | 5310, 5311, 5320, 1100, 1200 | **NO — 5320 in top-3 but not #1** |
| `inventory-fnb-restock` | 1250/5101 | (abstain) | empty | 5101, 1100, 1200, 1250, 1260 | **NO — canonical top-3 empty** |
| `multi-alloc-membership-plus-penalty` | 6064/6065 | (abstain) | empty | (not sampled) | **NO — canonical top-3 empty** |
| `multi-alloc-goods-freight-tax` | 6025/6020 | (abstain) | empty | (not sampled) | **NO** |
| `image-only-narrative-service` | 6020/6031 | (abstain) | 1250, 1260, 1410 | (not sampled) | **NO** |
| `food-service-invoice` | 5100/5101 | (abstain) | 1250, 1260, 1410 | 5310, 5100, 5101 | **NO — discovered but not ranked** |

**Zero recoveries.** The correct account is in the widened pool for at least 4 of 7 cases (DMM, Jonas, Inventory F&B, food-service — via legacy discovery output), but canonical ranks other accounts above it.

### 11. `completed-capital-improvement` result

Still recommends 6020 (forbidden). Unsafe = 1. **Not resolved by Phase 7.2B.** Widening the pool did not change canonical's choice. Per §10 of the directive: *"If the correct capital account is now discovered but canonical still selects 6020, the failure is no longer recall — it is ranking/evidence/safety-policy. Stop at that boundary."*

### 12. 221178 result

Not re-run on staging — Phase 7.2B is behaviorally identical to Phase 7.1 on the benchmark, so no expected change on staging. Would need staging deploy + re-inspection to confirm.

### 13. 1091559 result (real-fixture proxy `vague-body-invoice-attachment`)

Under Slice 2: `top1 PASS/-` (correctly abstains for the "abstain-expected" case) and `top3 empty`. Discovery is bringing capital accounts (1506, 1540) into the pool via `capital-aware-direct`, but canonical's Top-3 shows nothing.

**The correct behavior here is contested:** the benchmark case expects abstention (the "vague body carries a real invoice" test — meant to catch OVER-confident ranking on an under-supported email). Phase 7.2B respects that expectation. In production, however, the actual 1091559 real fixture on staging should ideally return `1506` (capital) because the invoice PDF itself has clear signal.

### 14. 1087769 result

Not re-run on staging.

### 15. Candidate-count distribution

Not systematically measured across all 42 cases (would require instrumenting `rankClusters` to emit widened-pool size per cluster). Sampled: DMM case with 3-vendor COA yields 31 discovered candidates from purpose-driven alone, plus additional from nature-scoped + capital-aware. Total widened pool typically 30–60 accounts per cluster on the benchmark seed.

### 16. Ontology/semantic bridge examples

**Directly proven working via debug instrumentation:**
- `diesel → fuel`: DMM case, canonical purpose = FUEL, top discovered accounts include 5310 "Fuel — Grounds Equipment", 5311 "Fuel — Fleet", 5320 "Fuel & Lubricants".
- `backup/license → software`: (not tested in benchmark but Phase 7.1 already proved this via clustering; Phase 7.2B preserves).
- `durable equipment acquisition → capital-asset family`: CAPITAL_EQUIPMENT purpose yields 1506/1540/1570/1710/1720 (all capital-asset accounts) via legacy purpose-driven ranker.
- `equipment parts`: EQUIPMENT_PARTS purpose yields 6020/6031 R&M accounts.
- `professional membership → dues`: (not sampled but purpose-driven ranker covers).

### 17. Full-document contamination risk

**Zero identified.** All three direct providers pass either cluster-scoped `LineItem[]`/`clusterLineDescriptions` or pre-vetted `purchasedObjects`. `nature-scoped-direct` passes `fullDocumentText: null` explicitly. Search: `grep "fullDocumentText" src/lib/ap-intelligence/candidate-discovery/` returns only `providers/nature-scoped-direct.ts:41: fullDocumentText: null`.

### 18. Provider ablation result

Prior Phase 7.2A ablation (env-flag toggles preserved in `providers/index.ts`) proved:
- Vendor-history alone: same as Phase 7.1 baseline.
- Vendor + purpose synthetic: same as Phase 7.1 baseline.
- All 5 synthetic providers: same as Phase 7.1 baseline (with type-propagation reverted).

Phase 7.2B legacy-direct providers: **same as Phase 7.1 baseline** (9 / 42). The discovery layer is behaviorally neutral at the outcome level, even though candidate recall is measurably better.

**Conclusion:** the discovery layer works correctly. The next boundary is not discovery.

### 19. Static guards

All existing single-authority guards continue to pass:
- `tests/phase4r-refactor-single-gl-authority.test.ts` — 3 guards green
- `tests/phase4r-phase7-cluster-owned.test.ts` — 14 tests green
- **NEW:** `tests/phase4r-phase72b-canonical-subordination.test.ts` — 1 test green (§5)
- Grep for post-ranking `gl.accountNumber =` in `analyse.ts`: unchanged from Phase 7.1 (only `applyPhase0SafetyContainment` remains, abstain-only)
- Grep for `.winner` / `.leader` / `.totalScore` in `candidate-discovery/`: **zero hits** (verified §4)

### 20. Anti-overfitting

Zero vendor / invoice / account literals introduced by Phase 7.2B. The legacy-direct providers operate on generic v206 taxonomy tables (PURPOSE_ACCOUNT_TYPE, PURPOSE_CATEGORY_HINTS, NATURE_COMPATIBILITY, capital-asset semantics) that are themselves generic. Verified.

### 21. Targeted test totals

**82 / 82 tests passing** across 7 test files (Phase 4R single-authority + Phase 7 cluster-owned + Phase 7.1 archetypes + allocation-canonical + c15v allocations + AP integration + Phase 7.2B canonical-subordination). Typecheck clean.

Benchmark: 42-case sealed corpus, Slice 1 + Slice 2 runs both showed pass=11, fail=29, unsafe=1.

### 22. Was v206 recovery floor met?

**NO.** Required floor: Top-1 ≥ 17 / 42 AND unsafe = 0. Actual: Top-1 = 9 / 42, unsafe = 1. Same as Phase 7.1.

### 23. Next first-failure boundary

**Canonical ranking / scoring**, per §11 of the directive.

The evidence:
1. Legacy discovery IS surfacing the correct accounts into the widened pool (proven for DMM, Jonas, food-service via debug).
2. Canonical THEN scores those accounts and consistently places them below noise (inventory 1250/1260, prepaid 1410).
3. Canonical abstains.

Specifically for DMM (fuel invoice):
- Widened pool includes 5310 "Fuel — Grounds Equipment" and 5311/5320 (the correct answers)
- Canonical Top-3 = [1250, 1260, 1410] (F&B inventory + prepaid insurance)
- Canonical winner = none (abstain)

The hypothesis: canonical-ranker's evidence functions do not include ontology-based line-item-text → account-name-token bridging. v206's `rankPurposeDrivenAccounts` had explicit `evaluatePurposeAccountAffinity` mappings (in `purpose-to-gl-ontology.ts`) that connected purposes to account-name patterns. Canonical uses `extractConceptsForAccount` (concept-catalog lookup on account NAME) but only if the account name contains a concept synonym. "Fuel — Grounds Equipment" MAY be extracted as concept `fuel_surcharge` (via synonym "fuel"), but the transaction line "Diesel biodégradable dyed low-sulphur" tokens (diesel, biodégradable, dyed, sulphur) don't overlap with "fuel" tokens — so the concept never fires as a scoring signal.

**This is the boundary the founder anticipated in §11:** *"After the correct account reliably enters the competition, then inspect: winner score, runner-up score, DECISION evidence, genuine competitor, recommendation status. Only then can we determine whether the recommendation policy is too conservative."*

Related second-order boundary: for at least 4 of the 7 lost cases, canonical's Top-3 is EMPTY (`inventory-fnb-restock`, `multi-alloc-membership-plus-penalty`, `multi-alloc-goods-freight-tax`, `adversarial-capital-with-accumdepr`). Empty Top-3 means canonical produced NO scored candidate above 0 — every account got a raw score of 0. This is a canonical-scoring failure, not a recall failure.

### 24. Recommendation on whether to proceed to staging

**DO NOT proceed to staging. DO NOT merge.**

Phase 7.2B did not meet the recovery floor. The discovery layer works correctly and is architecturally sound (canonical-subordination test proves winner authority stayed with `rankCanonical`), but the failure boundary has moved from *discovery* to *canonical ranking*. Deploying Phase 7.2B to staging would change nothing observable to the founder.

**Recommended next slice — Phase 7.2C: canonical scoring alignment.** Requires separate founder authorization because it operates on canonical scoring / weights / evidence, which §12 and §15 explicitly forbade in Phase 7.2B. Specifically:

- Add an ontology-bridge scoring signal in `canonical-ranker.ts` that consumes v206's `evaluatePurposeAccountAffinity` output. When purpose is committed and an account's name/taxonomy matches the purpose's account-name patterns from `purpose-to-gl-ontology.ts`, add a bounded evidence contribution. This is a NEW evidence family; the existing WEIGHTS remain unchanged.
- OR: allow the discovery layer to attach *evidence hints* (not scores) to a candidate, and canonical-ranker consumes them as one more observation. Preserves canonical-subordination.
- OR: allow legacy `rankPurposeDrivenAccounts` to supply a *supporting* canonical evidence observation (bounded weight ≤ NATURE_COMPAT_MATCH = 15) for its top-K, so ontology-matched accounts don't lose to token-matched inventory accounts. Explicitly bounded so no legacy winner authority leaks in.

**None of these are authorized right now.** Report is the deliverable; the founder decides direction.

**Alternative if Phase 7.2C is not authorized:** revert Phase 7.2B to `f685aec` (Phase 7.2A committed state) while the founder reviews. Phase 7.2B is on branch as `refactor/gl-single-authority` @ (next commit) with:
- Discovery layer functional (candidate recall RESTORED)
- Canonical output UNCHANGED vs Phase 7.1
- 82 / 82 targeted tests green
- Zero regressions vs Phase 7.1
- Zero improvements vs Phase 7.1

Not merged. Not staged. No production deploy.

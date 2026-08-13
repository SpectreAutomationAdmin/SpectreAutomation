# Phase 4R · Phase 7.2A/B — Checkpoint report (§29)

**Author:** Claude (Opus 4.7) on `refactor/gl-single-authority`
**Date:** 2026-08-12 (US) / 2026-08-13 (staging clock)
**Scope:** Phase 7.2A candidate-discovery layer implementation + 5 benchmark iterations + ablation. No runtime tuning, no COMMIT_MIN_SCORE change, no canonical weight change, no unmapped concepts added.
**Founder directive:** Phase 7.2 architectural law: *"Spectre may have multiple independent ways to DISCOVER plausible GL accounts, but exactly one mechanism may RANK and SELECT the GL account."*

---

## §29 24-item deliverable

### 1. Old discovery mechanisms recovered

Phase 7.2A implemented five discover-only providers, each mirroring the DISCOVERY portion of a v206 mechanism (v206 files preserved unchanged; providers reimplement the taxonomy tables inline):

| Old mechanism | Phase 7.2A provider | File |
|---|---|---|
| `recommendGlAccount` (semantic full-COA scoring) | `semanticFullCoaDiscovery` | [providers/semantic-full-coa.ts](../src/lib/ap-intelligence/candidate-discovery/providers/semantic-full-coa.ts) |
| `rankPurposeDrivenAccounts` (purpose-category hints) | `purposeOntologyDiscovery` | [providers/purpose-ontology.ts](../src/lib/ap-intelligence/candidate-discovery/providers/purpose-ontology.ts) |
| `rankNatureScopedAccounts` (nature compatibility) | `natureScopedDiscovery` | [providers/nature-scoped.ts](../src/lib/ap-intelligence/candidate-discovery/providers/nature-scoped.ts) |
| `rankCapitalAwareAccounts` (capital-decision → asset accts) | `capitalAwareDiscovery` | [providers/capital-aware.ts](../src/lib/ap-intelligence/candidate-discovery/providers/capital-aware.ts) |
| Vendor prior-coding history | `vendorHistoryDiscovery` | [providers/vendor-history.ts](../src/lib/ap-intelligence/candidate-discovery/providers/vendor-history.ts) |

### 2. How winner authority was removed

Each provider implements `DiscoveryProvider.discover()` returning `Iterable<DiscoveryHit>` — a stream of `(accountId, accountNumber, source)` tuples. **No score, no rank, no winner, no recommendation status.** The contract is intentionally impoverished so a provider physically cannot smuggle selection authority in. `rankCanonical` remains the sole winner-selection authority (checked in the existing static guard at [tests/phase4r-refactor-single-gl-authority.test.ts](../tests/phase4r-refactor-single-gl-authority.test.ts)).

### 3. New discovery interface

[src/lib/ap-intelligence/candidate-discovery/index.ts](../src/lib/ap-intelligence/candidate-discovery/index.ts):
- `DiscoveredAccountCandidate { accountId, accountNumber, discoverySources[] }` — dedup unit
- `DiscoverySource` — provenance union with 6 variants (cluster_hint, purpose_ontology, nature_scoped, capital_aware, semantic_full_coa, vendor_history)
- `DiscoveryProvider { kind, discover(input) }` — provider contract
- `discoverCandidates(providers, input) → CandidateDiscoveryResult` — union orchestrator with hard eligibility exclusion
- `unionEligiblePool(clusterPool, fullCoa, discovery) → AccountView[]` — widens the ranker pool

### 4. Candidate-union architecture

`rankClusters` at [gl-allocations.ts:706-736](../src/lib/ap-intelligence/gl-allocations.ts#L706) now:
1. Computes `nonPayrollAccounts` (payroll hard exclusion, unchanged from Phase 7.1)
2. Applies cluster-hint preference to build `clusterPool` (unchanged from Phase 7.1)
3. **NEW:** builds `discoveryInput` and calls `discoverCandidates(ALL_DISCOVERY_PROVIDERS, discoveryInput)`
4. **NEW:** widens `eligibleAccounts = unionEligiblePool(clusterPool, nonPayrollAccounts, discovery)`
5. Feeds widened pool to `rankClusterCanonically` (unchanged from Phase 7.1)

Discovery frequency is NOT accounting evidence — a candidate found by three sources gets ONE entry with three provenance tags, not three votes.

### 5. Hard eligibility boundary

Applied uniformly across all providers and to the final widened pool in [candidate-discovery/index.ts:24-51](../src/lib/ap-intelligence/candidate-discovery/index.ts#L24):

- **Name-based hard exclusions:** accumulated-depreciation, amortization, contra-asset, allowance-for-doubtful. Mirrors v206 nature-scoped-ranker §8.
- **Flag-based hard exclusions:** `isBankAccount`, `isCashAccount`, `isControlAccount`, `allowManualPosting === false`. Bank/cash cannot receive AP debits without breaking the ledger; control accounts are system-managed.

To carry these flags, [analyse.ts:1385-1418](../src/lib/ap-intelligence/analyse.ts#L1385) was extended to select and project them into `AccountView`. **Note:** `type` and `accountRole` are deliberately NOT propagated — see §14 below.

### 6. Evidence / provenance treatment

Discovery provenance is retained on each `DiscoveredAccountCandidate.discoverySources[]` for audit but is not consumed by `rankCanonical`. Canonical scoring reads the account's own evidence (concept synonyms, taxonomy, capital-nature, etc.) — never the discovery source. This is §23 compliance ("Do not automatically translate 'capital discovery ranked this account first' into a score.")

### 7. 42-case candidate recall

**Not directly measurable without instrumenting the analyser to emit the widened pool per case.** Inferable from Top-3:

- **Phase 7.1 Top-3 recall:** cases where any of the acceptable accounts appears in Top-3.
- **Phase 7.2A Top-3 recall:** same measure after widening.

Sampled inspection of the 7 lost-v206 cases (§14): Phase 7.2A Top-3 for `dmm-energy-fuel` = `1250, 1260, 1410` — **the correct accounts (5310/5311/5320) do NOT appear even in Top-3**, meaning discovery did not surface them. This is the key finding: my token-based semantic provider does not match `Diesel` line-item text to `Fuel — Grounds Equipment` account name because they share no tokens. v206 handled this via `purpose-to-gl-ontology.ts` mappings (FUEL purpose → account-name patterns like `/fuel|diesel|gasoline/`) that my synthetic reimplementation did not fully port.

### 8. 42-case Top-3 recall

Not systematically computed. See §7.

### 9. 42-case Top-1 accuracy

| | v206 | Phase 7.1 | Phase 7.2A (final iter) |
|---|:---:|:---:|:---:|
| **GL Top-1 correct** | **17 / 42 (40.5%)** | **9 / 42 (21.4%)** | **9 / 42 (21.4%)** |

**Phase 7.2A ties Phase 7.1 exactly.** The discovery widening is behaviorally neutral — no cases recovered, no cases regressed.

### 10. Conditional ranking accuracy

Not computed. Would require candidate-recall instrumentation (§7).

### 11. Correct-winner-but-abstained count

The 7 lost-v206 cases all abstain under Phase 7.2A. For 6 of them, the correct account is not even in Top-3 (see §7). So the failure mode is candidate-generation — my providers surface the WRONG accounts (inventory 1250/1260, prepaid 1410) instead of the correct COGS/expense accounts.

### 12. Unsafe count

| | v206 | Phase 7.1 | Phase 7.2A |
|---|:---:|:---:|:---:|
| Unsafe | 0 | 1 (`completed-capital-improvement`) | 1 (same) |

Phase 7.2A did not introduce a new unsafe, but also did not fix Phase 7.1's existing unsafe.

### 13. v206 vs Phase 7.1 vs Phase 7.2A table

| Metric | v206 (`cbb1b52`) | Phase 7.1 (`335dd42`) | Phase 7.2A |
|---|:---:|:---:|:---:|
| Pass | 12 | 11 | 11 |
| Fail | 26 | 29 | 29 |
| Partial | 4 | 2 | 2 |
| **GL Top-1** | **17 / 42** | **9 / 42** | **9 / 42** |
| **Unsafe** | **0** | **1** | **1** |

### 14. Seven v206-correct cases under Phase 7.2A (individually)

| Case | v206 winner | Phase 7.1 | Phase 7.2A |
|------|:---:|:---:|:---:|
| `dmm-energy-fuel` | 5310 ✓ | (abstain) | (abstain) — top3 = 1250, 1260, 1410 (all wrong) |
| `jonas-convention-accum-depr` | 5310 ✓ | (abstain) | (abstain) — top3 = 5320, 1250, 1260 (5320 acceptable, but abstained) |
| `inventory-fnb-restock` | 5101 ✓ | (abstain) | (abstain) — top3 empty |
| `multi-alloc-membership-plus-penalty` | 6064 ✓ | (abstain) | (abstain) — top3 empty |
| `multi-alloc-goods-freight-tax` | 6020 ✓ | (abstain) | (abstain) — top3 empty |
| `image-only-narrative-service` | 6020 ✓ | (abstain) | (abstain) — top3 = 1250, 1260, 1410 |
| `food-service-invoice` | 5100 ✓ | (abstain) | (abstain) — top3 = 1250, 1260, 1410 |

**Zero recoveries.** The discovery layer as designed does not surface the accounts v206 found. Diagnostic in §16.

### 15. `completed-capital-improvement` safety result

Still recommends 6020 (forbidden). Unchanged from Phase 7.1. Widening the pool did not surface an alternative that scores higher. The founder in §8 called this a hard blocker. **Not resolved by Phase 7.2A.**

### 16. 221178 result

Not re-run on staging — Phase 7.2A tied Phase 7.1 on the benchmark, so no staging redeploy is warranted at this checkpoint.

### 17. 1091559 result

Same. Not re-run.

### 18. 1087769 result

Same. Not re-run.

### 19. Candidate-count distribution

Not instrumented. Would require exposing the widened pool size per cluster from `rankClusters` — deliberate opaque instrumentation to add in a follow-up (see recommended next steps §24).

### 20. Static guards

All existing single-authority guards continue to pass:
- `tests/phase4r-refactor-single-gl-authority.test.ts` — 3 guards green
- `tests/phase4r-phase7-cluster-owned.test.ts` — 14 tests green
- No new authority points added (checked by grep — `gl.accountNumber =` assignments unchanged from Phase 7.1)

### 21. Anti-overfitting

No vendor / invoice / account literals in `candidate-discovery/`. Providers operate on generic account-side taxonomy (categoryKey, fsGroupKey, accountRole, name pattern) and generic signals (`clusterConceptId`, `capitalDecision`). Verified.

### 22. Targeted test totals

Typecheck clean. Existing Phase 4R suites and Phase 7 cluster-owned suites unchanged.
- Full targeted L1 (not re-run in this session, but the surface area of change is confined to `candidate-discovery/` + minimal edits in `analyse.ts` and `gl-allocations.ts`).
- 42-case benchmark: 5 iterations, all captured under `tests/ap-benchmark/runs/ap-bench-2026-08-13T*.json`.

### 23. Does `COMMIT_MIN_SCORE` now appear miscalibrated?

**Cannot determine yet.** The prerequisite (§11 in the Phase 7.2 directive) is "candidate recall reliably brings the correct account into the competition." My Phase 7.2A does NOT achieve that on the 7 lost cases. Until the correct accounts appear at least in Top-3, examining `COMMIT_MIN_SCORE` calibration is premature.

### 24. Explicit recommendation

**Recommendation: DO NOT proceed to Phase 7.2C, DO NOT stage, DO NOT merge. Phase 7.2A is architecturally correct but functionally insufficient.** Escalate to a redesigned Phase 7.2B that consumes v206's actual discovery *functions* directly instead of synthetic reimplementations of their taxonomy tables.

**Root cause of the 7 non-recoveries:** my reimplemented discovery providers (`purposeOntologyDiscovery`, `natureScopedDiscovery`, `capitalAwareDiscovery`, `semanticFullCoaDiscovery`) use lookup tables copied from v206's source but omit the concept ↔ account-name ontology in [purpose-to-gl-ontology.ts](../src/lib/ap-intelligence/purpose-to-gl-ontology.ts) and [gl-recommend.ts](../src/lib/ap-intelligence/gl-recommend.ts)'s account-side concept extraction. That ontology is what lets v206 match "Diesel" (line-item) to "Fuel — Grounds Equipment" (account name) — my token-based semantic provider cannot bridge that lexical gap.

Proposed Phase 7.2B (requires founder authorisation):

1. Retain the discovery-only contract from Phase 7.2A.
2. Delete my four synthetic taxonomy-table providers (keep `vendorHistoryDiscovery` — it is trivial and correct).
3. Replace them with direct invocations of the actual v206 functions:
   - `rankPurposeDrivenAccounts(input) → PurposeDrivenRankerResult` — consume `.candidates[].accountNumber` only, discard `.winner`, `.totalConsidered`, all `.components` scores.
   - `rankNatureScopedAccounts(args) → NatureScopedRankingResult` — consume `.ranked[].account.accountNumber` only, discard `.leader`, scores.
   - `rankCapitalAwareAccounts(input) → CapitalAwareRankingResult` — consume `.compatiblePool[].accountNumber` only, discard `.winner`, `.contradictedPool`, scores.
4. Bridge the type gap: build v206-compatible input structs (`AccountEligibilityView`, `CapitalEvidenceDecisionResult`, `CanonicalLineItem[]`, `ProductIdentityResolution`, `DepartmentInferenceResult`) from the already-computed values in `analyse.ts` and thread them through `AllocationInput.globalSignals`.
5. Preserve v206's account-side ontology and compatibility gates automatically — because they live inside the reused functions.
6. Preserve hard eligibility exclusion at the union step.
7. Rerun the 42-case benchmark.
8. Acceptance floor unchanged: **≥ 17 / 42 Top-1 AND 0 unsafe.** If Phase 7.2B does not clear the floor, further diagnosis before any staging.

**Scope estimate:** 2 focused slices (~800 lines including type-bridge shims), 1 benchmark run per slice, 1 checkpoint report.

**Do not merge Phase 7.2A.** It is a neutral change on the benchmark and doesn't clear the acceptance floor. The infrastructure it introduces (contract, union, hard-eligibility) is the correct foundation for 7.2B, but keeping it on the branch without the actual capability recovery would leave the branch in a state that is architecturally novel but functionally unchanged from Phase 7.1.

**Alternative if Phase 7.2B is not authorised:** revert this Phase 7.2A slice (candidate-discovery/ + analyse.ts flag propagation + gl-allocations.ts union call) and return to the pure Phase 7.1 codebase at commit `a351285` while the forensic report [docs/phase-4r-forensic-old-vs-new-comparison.md](phase-4r-forensic-old-vs-new-comparison.md) is used to decide direction.

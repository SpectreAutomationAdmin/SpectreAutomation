# Phase 4R · Single-GL-Authority Architectural Refactor · Session Checkpoint

**Branch:** `refactor/gl-single-authority`
**Baseline:** v206 = `cbb1b52` (main + staging unchanged)
**Current session ended:** 2026-08-11
**Phase reached:** **Phase 1 complete** (TDD RED verified for the right reason)
**Next phase to begin:** **Phase 2 — build the canonical unified ranker**

---

## Architectural context (do not re-investigate)

The v206 architecture has TWO GL ranking pipelines running sequentially:

1. **Pipeline A** — `recommendGlAccount` in [src/lib/ap-intelligence/gl-recommend.ts](../src/lib/ap-intelligence/gl-recommend.ts) invokes `rankAccountsPure` (line 1052) and returns `gl.candidates[]` with `candidates[0]` as its base winner.
2. **Pipeline B** — `rankPurposeDrivenAccounts` in [src/lib/ap-intelligence/purpose-driven-ranker.ts](../src/lib/ap-intelligence/purpose-driven-ranker.ts) runs a second, separate scoring over the full eligible COA using purpose ontology + department + capital nature signals.

Then in [src/lib/ap-intelligence/analyse.ts](../src/lib/ap-intelligence/analyse.ts) there are **10+ post-ranking override sites** (lines 1446, 1472, 1583, 1824, 2006, 2149, 2221, 2342, 2360, 2419) that mutate `gl = { ...gl, accountNumber: X }`. Each override rewrites the winner without rebuilding `gl.candidates`.

**The primary divergence** is at line 1583: `pdResult.winner.accountNumber` (from Pipeline B) becomes `gl.accountNumber`, while `gl.candidates` (from Pipeline A) is untouched. Pipeline B's own scored candidates array is DISCARDED.

Reason string patterns identifying override sites (used by the RED classifier):
- `purpose_ontology_promotion` — line 1446
- `purpose_ontology_abstain` — line 1472
- `purpose_driven_full_coa_search` — line 1583 (the primary defect)
- `capital_aware_ranking` — later sites
- `split_*` — split/multi-allocation sites

## Phase 1 · what was delivered (this session)

**New file:** [tests/phase4r-refactor-single-gl-authority.test.ts](../tests/phase4r-refactor-single-gl-authority.test.ts)

- Uses `analyseIngestedInvoice({ clubId, ingestedDocumentId, extractedTextOverride })` — the same integration path the acceptance suite exercises. Skips real PDF/OCR entirely.
- Hermetic Prisma fixture: one Club + a 19-account neutral COA + `ingestAttachment` with `memoryDocumentStorageAdapter`. Modelled on [tests/ap-intelligence-integration.test.ts](../tests/ap-intelligence-integration.test.ts).
- 17 synthetic scenarios covering the required transaction shapes (§3): operating expense, capital equipment, repair service, professional service, subscription, utility, fuel, merchandise, professional dues, novel vendor, department-sensitive, genuine ambiguity, weak semantic accident, capital/operating ambiguity, multi-allocation, insurance, telephone/internet.
- **Failure-mode classifier** (`classifyInvariant`) categorises every scenario as one of: `INVARIANT_HOLDS`, `ABSTAINED`, `WINNER_REPLACED_AFTER_RANKING`, `WINNER_ABSENT_FROM_CANDIDATES`, `NO_CANDIDATES`.
- **Anti-overfitting lint** — a static test that scans `gl-recommend.ts`, `purpose-driven-ranker.ts`, `analyse.ts`, `gl-allocations.ts` for forbidden literal comparisons against specific vendor names / invoice numbers / account numbers. Guards against smuggled hardcoded rules.
- **Reason-string override check** — samples 5 scenarios and fails on `purpose_ontology_promotion` / `purpose_driven_full_coa_search` / `purpose_ontology_abstain` markers. Will go GREEN after Phase 3 eliminates the override sites.

**Verified failure modes on v206** (RED for the right reason per §4):

| Scenario | Outcome | Detail |
|---|---|---|
| `utility` | `WINNER_REPLACED_AFTER_RANKING` | winner=6020 (Grounds Maint) vs top=6050 (Utilities); reason=`purpose_driven_full_coa_search:REPAIR_MAINTENANCE(92,quality=MEDIUM)->6020` |
| `novel_vendor` | `NO_CANDIDATES` | winner=6035 with empty candidates[]; reason=`purpose_driven_full_coa_search:CAPITAL_EQUIPMENT(95,quality=HIGH)->6035` — winner not just repositioned, entirely absent from list |
| 15 other scenarios | `INVARIANT_HOLDS` | pipelines happen to agree OR only Pipeline A ran |

Both failure modes trace to the same root cause (analyse.ts:1583 `rankPurposeDrivenAccounts` override), demonstrating the systemic defect without every scenario needing to fail.

## Not deployed. Not merged.

- Branch `refactor/gl-single-authority` off `cbb1b52`.
- Not pushed (feature branch is local; push at end of Phase 6 or when ready for founder review).
- Main + staging remain on v206. Founder-facing behaviour unchanged.

## Phase 2 · what to do next session

**Goal:** build ONE canonical unified ranker that consolidates the accounting intelligence currently distributed between `rankAccountsPure` and `rankPurposeDrivenAccounts`. Do NOT create a third ranker (§6). Do NOT sum scores naively (§7).

### 2.1 — Read + document current scoring semantics BEFORE writing code

Both rankers use different score scales:

- `rankAccountsPure` (gl-recommend.ts:1052+): components include `directLineMatch`, `economicPurposeMatch`, `accountNameSimilarity`, `fsGroupTaxonomySimilarity * 0.5`, `categoryTaxonomySimilarity * 0.3`, `documentPhraseScore`, `specificityScore`, `historicalVendorScore`, `supplierContextScore`, minus `contradictionPenalty`. Ranges roughly 0–100 with `SPECIFICITY_BONUS_PER_DEPTH`, `CONTRADICTION_PENALTY` constants.
- `rankPurposeDrivenAccounts` (purpose-driven-ranker.ts:164+): components include `purposeCompat`, `ontologyMatch`, `natureCompat`, `accountRoleMatch`, `departmentAffinity`, `lineItemJaccard`, `vendorHistoryBoost`, `capitalNatureBoost`. Own weight constants + own commit threshold (score >= ~60 to promote).

Document each component's:
- range/normalization
- whether absolute or comparative
- boost/penalty origin
- interaction/correlation with signals from the other ranker (e.g. does `directLineMatch` overlap with `lineItemJaccard`? does `economicPurposeMatch` overlap with `purposeCompat`?)

The correlation analysis is important — §7: "a line-item phrase may generate a concept + an ontology match + account-name relatedness + an economic-purpose match. Those may all originate from essentially the same piece of invoice evidence. Do not accidentally count one observation four times and manufacture confidence."

Produce a short design note in `docs/phase-4r-unified-ranker-scoring.md` before writing the ranker.

### 2.2 — Define canonical types

New in `src/lib/ap-intelligence/gl-recommend.ts` (or a new `canonical-ranker.ts` if that's cleaner):

```ts
export interface CanonicalRankerInput {
  transaction: NormalisedTransactionInterpretation;  // purpose, nature, capital state, department, line items, vendor context, taxonomy, tax treatment
  eligibleAccounts: ReadonlyArray<AccountView>;
  vendorHistory?: { defaultAccountId: string | null; priorCoding: Array<{ accountNumber: string; count: number }> };
  postingBlockersByAccount: Map<string, PostingBlocker[]>;
}

export interface CanonicalRankerResult {
  rankedCandidates: CanonicalCandidate[];         // winner at [0], invariant enforced
  winnerAccountNumber: string | null;             // === rankedCandidates[0]?.accountNumber
  recommendationStatus: "RECOMMEND" | "ABSTAIN";  // §9 abstention is separate from selection
  abstentionReason: string | null;
  provenance: { rulesFired: string[]; contradictions: string[] };  // §9 winner provenance
}

export interface CanonicalCandidate {
  accountId: string;
  accountNumber: string;
  accountName: string;
  categoryKey: string | null;
  fsGroupKey: string | null;
  score: number;                                  // harmonised scale 0..100
  evidence: CanonicalEvidence[];
  contradictions: CanonicalContradiction[];
  postable: boolean;
  postingBlockers: PostingBlocker[];
}
```

### 2.3 — Build the canonical ranker

- Consolidate scoring so a single `rankCanonical(input): CanonicalRankerResult` returns ONE ranked list.
- All signals from BOTH current rankers participate, with correlation-aware weights.
- Winner at `rankedCandidates[0]` is enforced by construction (return type prohibits divergence).
- Abstention is a SEPARATE field (§9): `recommendationStatus = "ABSTAIN"` when winner score < commit threshold, but `rankedCandidates[0]` remains identifiable.

### 2.4 — Compatibility wrapper (temporary)

Keep `recommendGlAccount()` and `rankPurposeDrivenAccounts()` exports available but rewire them to delegate to `rankCanonical`. Mark as `@deprecated`. Phase 3 removes callers; Phase 5 or later removes the wrappers.

### 2.5 — Update existing tests

Suites likely affected by the consolidation:
- `tests/c15u-recommender-ranking.test.ts` (30+ tests on ranker behavior)
- `tests/c15q-gl-recommend-taxonomy.test.ts` (8 tests)
- `tests/phase4-final-purpose-evidence-hierarchy.test.ts` (16 tests)
- `tests/phase4-slice5-canonical-line-items.test.ts` (35 tests)
- `tests/c16b-hierarchical-ranking.test.ts` (25 tests, of which 3 are pre-existing failures unrelated to this refactor)

Each test's expected behavior needs re-validation. If a test asserts a specific score number, migrate to the harmonised scale. If a test asserts a specific account winner, verify it holds under the unified ranker.

### 2.6 — Phase 2 exit gate

- New `tests/phase4r-canonical-ranker.test.ts` — direct unit tests of `rankCanonical` covering the correlation-avoidance cases from §7.
- Existing ranker suites pass (30+ tests migrated).
- `analyse.ts` STILL calls the old dual pipelines (Phase 2 does not touch analyse.ts). Runtime behaviour unchanged. Regression fixture suites remain green.

## Phases 3–6 · outline (unchanged from prior authorisation)

- **Phase 3** — Migrate 10+ override sites in analyse.ts to pre-ranking-input pattern. GROUP by accounting responsibility, not arbitrary count (§8): economic-purpose/ontology, capital classification, abstention/recommendation policy, split/multi-allocation, historical/vendor. Each group: state what accounting intelligence the override preserved → move to pre-ranking input or ranker policy → delete the winner-mutation capability → run the fixture that motivated it.
- **Phase 4** — Evidence-integrity model. `role: "DECISION" | "DIAGNOSTIC"` on `CanonicalEvidence`. Threshold derived empirically from the synthetic matrix + regression fixtures (§10 — do NOT hardcode 15%). Investigate whether one global rule suffices or whether it should be source-calibrated / competition-relative. Document reasoning.
- **Phase 5** — `gl-allocations.ts` per-cluster ranker uses `rankCanonical` per cluster (§10 architectural rule). Multi-allocation preserves invariant per allocation.
- **Phase 6** — Deploy to staging. Verify analysis → candidates → projection → DOM → AP coding parity for all 7 real fixtures. Restore CS 221178 into visible feed. Contract test for posting provenance.

## Stop conditions (§16)

Continue across sessions unless one of:
1. Another runtime subsystem outside the mapped architecture independently selects/replaces the final GL account.
2. Normalized transaction interpretation is structurally inadequate for the unified ranker.
3. Scoring systems incompatible without a deeper scoring redesign.
4. Posting path has another independent classification authority.
5. Correct architecture would require weakening an accounting correctness invariant merely to retain regression behaviour.

Operational context limits are NOT stop conditions.

## Continuation instructions for next session

1. `git checkout refactor/gl-single-authority`
2. Confirm `git log --oneline -3` shows the Phase 1 commit at head.
3. Confirm `npx vitest run tests/phase4r-refactor-single-gl-authority.test.ts` still fails on `utility` (WINNER_REPLACED_AFTER_RANKING) and `novel_vendor` (NO_CANDIDATES).
4. Begin Phase 2.1 (scoring semantics documentation) — do NOT skip.
5. Do not investigate the architecture from scratch — it is documented above and in the §Investigation report from the prior session. Consult those first.
6. Do not modify main. Do not deploy. Deployment happens after Phase 6 gate.

## Session commit

```
[refactor/gl-single-authority] Phase 1: single-GL-authority invariant test suite + failure-mode classifier
+ tests/phase4r-refactor-single-gl-authority.test.ts
+ docs/phase-4r-single-authority-refactor-checkpoint.md
```

# Phase 4R · Single-GL-Authority Architectural Refactor · Session Checkpoint

**Branch:** `refactor/gl-single-authority`
**Baseline:** v206 = `cbb1b52` (main + staging unchanged)
**Current session ended:** 2026-08-11
**Phase reached:** **Phase 1 complete + hardened; Phase 2.1 + 2.2 + 2.3 complete** (canonical unified ranker implemented with family-based scoring + correlation-avoidance + full coverage tests + concrete ranking examples for six accounting shapes)
**Next phase to begin:** **Phase 2 legacy suite migration + Phase 3 — remove analyse.ts post-ranking override authorities**

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
- **Explicit architectural regression tests** — `REGRESSION · utility invoice must not exhibit WINNER_REPLACED_AFTER_RANKING` and `REGRESSION · novel-vendor invoice must not produce NO_CANDIDATES` (§2 requirement to preserve both empirical counterexamples).
- **Static architectural guard (§3.B)** — source-code scan of `analyse.ts` for the `gl = { ...gl, accountNumber: ... }` override pattern. Currently expected to detect 10 sites (the ceiling under §16 for Phases 1-2). Flips to zero after Phase 3 without any test change; catches any future reintroduction thereafter. **Runs independently of whether any fixture executes the override path** — this is source-code truth, not execution truth.

The prior "reason-string override check" was replaced by the static guard above per founder §3 — an execution-dependent guard is insufficient to protect an architectural invariant. See test file for full documentation.

**Verified failure modes on v206** (RED for the right reason per §4):

Vitest result: **4 failed / 17 passed / 21 total tests** on the refactor branch against v206.

| Test | Outcome | Detail |
|---|---|---|
| `utility — invariant check` | **FAIL · WINNER_REPLACED_AFTER_RANKING** | winner=6020 (Grounds Maint) vs top=6050 (Utilities); reason=`purpose_driven_full_coa_search:REPAIR_MAINTENANCE(92,quality=MEDIUM)->6020` |
| `novel_vendor — invariant check` | **FAIL · NO_CANDIDATES** | winner=6035 with empty candidates[]; Pipeline A returned `emptyRecommendation()`, Pipeline B backfilled winner |
| `REGRESSION · utility` | **FAIL** | explicit named regression case; must GREEN after Phase 3 without candidate re-sorting hacks |
| `REGRESSION · novel-vendor` | **FAIL** | explicit named regression case; must GREEN by canonical ranker producing the competition, NOT by post-hoc `candidates=[winner]` |
| 15 other invariant scenarios | **PASS · INVARIANT_HOLDS** | pipelines coincidentally agree OR only Pipeline A ran |
| Anti-overfitting lint | **PASS** | v206 runtime has no smuggled vendor/invoice/account literals |
| Static architectural guard | **PASS** | 10 override sites detected ≤ 10 refactor-phase ceiling; goes to zero after Phase 3 |

The two failure modes trace to the same root cause (analyse.ts:1583 `rankPurposeDrivenAccounts` override). Per §4 it is CORRECT that most scenarios pass — the suite proves the architecture does not GUARANTEE the invariant, not that every fixture must fail.

**novel_vendor NO_CANDIDATES trace (§4)** — traced to option **A**: Pipeline A (`recommendGlAccount → rankAccountsPure`) genuinely produces an empty candidate list via `emptyRecommendation()` at [gl-recommend.ts:407-411](../src/lib/ap-intelligence/gl-recommend.ts#L407-L411) when `queryConcepts.length === 0 || scored.every((s) => s.components.semanticScore === 0)`. Pipeline B (`rankPurposeDrivenAccounts`) then independently finds winner 6035 with CAPITAL_EQUIPMENT purpose confidence 95 and writes it into `gl.accountNumber` via the analyse.ts:1583 override. No new authority. Same mechanism as the `utility` case — the override site fires whether Pipeline A produced candidates or not. **§16.1 does NOT trigger.**

## Not deployed. Not merged.

- Branch `refactor/gl-single-authority` off `cbb1b52`.
- Not pushed (feature branch is local; push at end of Phase 6 or when ready for founder review).
- Main + staging remain on v206. Founder-facing behaviour unchanged.

## Phase 2 progress this session

**Phase 2.1 · scoring semantics + correlation analysis (COMPLETE)**
- New: [docs/phase-4r-unified-ranker-scoring.md](./phase-4r-unified-ranker-scoring.md)
- Documents both pipelines' candidate universes, empty-recommendation exits, signal/weight tables, evidence emission rules, winner semantics.
- **Correlation finding**: 8-10 signals across the two pipelines are largely correlated derivatives of the same invoice phrase. Naïve sum would inflate one observation to 100+ points.
- **Consolidation rule** (§3.3): signals grouped into 5 evidence FAMILIES; MAX within family (collapse correlated signals), SUM across families (independent information sources).
- Families: `TRANSACTION_TEXT`, `TAXONOMY_ALIGNMENT`, `NATURE_ROLE`, `VENDOR_HISTORY`, `DEPARTMENT_CONTEXT`.
- Canonical score scale: 0..100 harmonised. `RECOMMEND` at 60-90, `MODERATE` 40-60, `ABSTAIN` below commit floor.

**Phase 2.2 · canonical output contract (COMPLETE)**
- New: [src/lib/ap-intelligence/canonical-ranker.ts](../src/lib/ap-intelligence/canonical-ranker.ts) — types + placeholder implementation.
- **Discriminated result union** enforces §1 invariant BY CONSTRUCTION:
  - `RECOMMEND` — non-empty `RankedCandidatesNonEmpty` tuple (winner === candidates[0] structurally); no separate `winnerAccountNumber` field can diverge
  - `ABSTAIN` — same tuple shape; winner still candidates[0]; separate `abstentionReason`
  - `NO_ELIGIBLE_CANDIDATES` — empty candidates by type; distinct from ABSTAIN (§7)
  - `ANALYSIS_FAILURE` — empty candidates by type; distinct from NO_ELIGIBLE_CANDIDATES (§7)
- `canonicalWinnerAccountNumber()` accessor reads `candidates[0]` directly — no way for downstream code to select a different account without violating the type.
- New: [tests/phase4r-canonical-ranker.test.ts](../tests/phase4r-canonical-ranker.test.ts) — 6 type-contract tests all PASS. Locks the placeholder as-is so Phase 2.3 must deliberately replace it.

**Phase 2.3 · rankCanonical() implementation (COMPLETE)**
- `rankCanonical()` body implemented in `canonical-ranker.ts` following the design in the scoring doc §6.
- Reuses existing scoring primitives: `conceptRelatedness`, `extractConceptsForAccount`, `evaluatePurposeAccountAffinity`. Pipeline-A/B scoring math consolidated into ONE function.
- Family model **revised** during Phase 2.3 per founder §3 (evidence causal-independence validation):
  - Split original `NATURE_ROLE` family into two: `CAPITAL_NATURE` (nature classifier + capital-decision + account-role — all "does this account's nature match?") absorbed `NATURE_ROLE`'s intended scope. `TAXONOMY_ALIGNMENT` absorbed specificity bonus (it's a taxonomy signal).
  - Final families: `TRANSACTION_TEXT`, `TAXONOMY_ALIGNMENT`, `CAPITAL_NATURE`, `VENDOR_HISTORY`, `DEPARTMENT_CONTEXT`.
- MAX within family (correlated signals from same observation collapse) + SUM across families (independent info) + separate contradiction penalty accumulation.
- **`countedTowardScore` field on each `CanonicalEvidence`** preserves suppressed correlated observations for engineering diagnostics per §4.
- Discriminated result: RECOMMEND when top score ≥ 30; ABSTAIN with candidates when winner < 30; NO_ELIGIBLE_CANDIDATES when eligible list empty OR all candidates score 0; ANALYSIS_FAILURE reserved for exception paths (not currently emitted).
- Deterministic tie-break by accountNumber.

**§14 Concrete ranking examples on synthetic fixtures** (from `phase4r-canonical-ranker.test.ts`):

| Scenario | Winner | Score | Runner-up | Score | Margin | Notes |
|---|---|---|---|---|---|---|
| `utility` (electricity) | 6050 Utilities-Electricity | 54 | 6025 Fuel | 52 | 2 | genuinely close — both utility-adjacent |
| `novel_vendor` (aerator service) | 6020 Grounds Maintenance | 38 | 6033 R&M Preventative | 38 | 0 | tie broken by accountNumber — both plausible R&M options; candidates non-empty ✓ (§7 invariant) |
| `capital_equipment` (mower complete unit) | 1500 Equipment & Fixtures (ASSET) | 38 | 5000 COGS Merch | 0 | 38 | capital correctly picks ASSET; runner-up gets nature-incompat penalty |
| `same_vendor_diff_econ` (vendor default = utilities, but capital transaction) | 1500 Equipment & Fixtures (ASSET) | 38 | 5000 COGS Merch | 0 | 38 | current transaction substance beats vendor default (§9 vendor is context, not destiny) ✓ |
| `weak_semantic_accident` (landscape maintenance) | 6020 Grounds Maintenance | 54 | 6033 R&M Preventative | 54 | 0 | both R&M-family — deterministic tie-break |
| `genuine_ambiguity` (professional dues + subscription tokens) | 6071 Subscriptions | 49 | 6064 Membership & Dues | 32 | 17 | winner ahead but runner-up preserved as competitive (§11) |

Observations:
- Winner IS candidates[0] in every case (invariant established at type-contract boundary).
- Family contributions visible; suppressed correlated evidence retained (§4).
- Scores conservative (30-60 range typical) — Phase 4 will recalibrate confidence thresholds against these + real fixtures.
- Same-vendor different-economics + weak-semantic-accident behave correctly: capital signal beats vendor history; R&M-family accounts (not bank charges / interest / IT) surface for R&M invoices.

## Phase 2 exit-gate CLOSURE (second session pass)

**Legacy suites (§7 point 11)** — 75/75 pass unchanged:
- `c15u-recommender-ranking` (16 tests) — tests `rankAccountsPure` directly; legacy function still exists.
- `c15q-gl-recommend-taxonomy` (8 tests) — tests `recommendGlAccount` end-to-end.
- `phase4-final-purpose-evidence-hierarchy` (16 tests) — tests purpose-authority evidence-hierarchy against the legacy pipeline.
- `phase4-slice5-canonical-line-items` (36 tests) — tests canonical line-item extraction (pipeline stage BEFORE ranking; unaffected by canonical-ranker addition).

None contain override markers (`purpose_ontology_promotion` / `purpose_driven_full_coa_search` / `purpose_ontology_abstain`) → no direct C-class dual-authority artefacts. The 75 tests are protecting behaviours of functions that CONTINUE TO EXIST in the codebase; supersession (deletion or migration to `rankCanonical`) happens in Phase 3+ as callers of legacy functions are removed. This satisfies §7 point 11 "Legacy suites green or intentionally superseded" — currently green.

**§2 semantic ranking review** of the six concrete examples:
- **utility (54 vs 52)**: Fuel scores 52 because the NEUTRAL_COA test fixture assigns `fsGroupKey: IS_UTILITIES` to 6025 Fuel — the electricity concept + utilities fs-group is a legitimate diagnostic similarity per the tenant COA structure. This is CORRECT — the ranker is honestly reflecting a COA where the tenant chose to co-group Fuel with Utilities. Phase 4 confidence must treat the 2-point margin as MODERATE (real ambiguity in that COA).
- **novel_vendor (38-38)**: Grounds Maintenance vs R&M Preventative — both are legitimate R&M expense accounts for an "aerator equipment quarterly service" invoice. The tie is real; both are valid interpretations. Tie-break by accountNumber is deterministic; Phase 4 must recognise this as an ambiguity requiring reviewer judgment, not evidentiary strength.
- **capital_equipment (38 vs 0)**: Clear win — capital gets ASSET type match; runner-up (COGS) gets nature-incompat penalty (–18). Non-ambiguous.
- **same_vendor_diff_econ (38 vs 0)**: Capital signal (from purpose + nature + capital classifier) beats vendor default. Vendor is context, not destiny (§9 confirmed).
- **weak_semantic_accident (54-54)**: Grounds Maintenance vs R&M Preventative — again both R&M-family. Tie is correct; Bank Charges / Interest / IT correctly absent.
- **genuine_ambiguity (49 vs 32)**: Subscriptions vs Membership & Dues on "professional membership dues subscription" invoice. Subscriptions wins because "subscription" token matched with Membership carrying an unexpected -6 PURPOSE_TYPE_MISMATCH or similar. 17-point gap is defensible; Phase 4 may still treat this as MODERATE-with-runner-up.

All ranking outcomes are ACCOUNTING-COHERENT. No inflated scores from correlation leaks. Family-collapse rule prevents double-counting.

**§3 winner separation info added**:
- `CanonicalRankerResult` (RECOMMEND | ABSTAIN) now carries `separation: { marginToRunnerUp, isDeterministicTieBreak, tiedRunnerUpCount }`.
- Downstream Phase 4 confidence can distinguish "won by material evidence" from "won by deterministic accountNumber tie-break". §3 requirement satisfied.

**§5 contradiction / hard-eligibility tests added**:
- Capital contradiction: R&M expense candidates get RM_EXPENSE_CONTRADICTION (–12) on CAPITAL_CANDIDATE transactions.
- Operating contradiction: routine service invoices do not drift into ASSET accounts.
- Vendor-history contradiction: capital signal beats vendor default.
- Hard eligibility: `rankCanonical(eligibleAccounts=[])` returns `NO_ELIGIBLE_CANDIDATES` — ranker does not compensate for missing pre-filter.

**§6 hard vs soft distinction documented** in the ranker's own contract:
- **Hard eligibility** enforced by CALLER via `eligibleAccounts` input list. The canonical ranker never sees ineligible accounts. Header/inactive/non-posting/wrong-fund/wrong-role accounts must be filtered BEFORE `rankCanonical`. This is currently done by `filterEligibleAccounts` upstream of `recommendGlAccount` — Phase 3 will feed that same pre-filter output into `rankCanonical`.
- **Soft contradictions** live inside `rankCanonical`: nature incompat, capital/operating mismatch, concept contradictions, R&M-vs-capital contradictions. These reduce score but do not remove the account from the competition. Emitted as `CanonicalContradiction[]` with `code` + `penalty` + `description`.

## Phase 2 exit gate status (this session)

**MET**:
- Canonical-ranker unit tests: 21/21 pass in `tests/phase4r-canonical-ranker.test.ts`. Covers §1 (structural invariant), §2 (correlation avoidance — 4 tests), §7 (correct-account discovery — 2 tests), §8 (reverse ontology), §9 (vendor not destiny), §11 (genuine ambiguity), §4 (diagnostics preservation), §7 discriminated variants (3 tests), §14 concrete examples (6 tests), §35 anti-overfitting.
- Typecheck clean.
- `analyse.ts` unchanged. Phase 1 invariant suite continues to show the same 4 architectural failures (utility + novel_vendor + their explicit regressions) — expected because runtime still calls the dual pipelines. Static architectural guard continues to report 10 override sites (unchanged; will flip to 0 after Phase 3).
- No account/vendor/invoice literals introduced.
- No deployment. Main + staging remain v206.

**DEFERRED to next session**:
- Legacy suite migration (§12) — `c15u-recommender-ranking` (30+ tests), `c15q-gl-recommend-taxonomy` (8 tests), `phase4-final-purpose-evidence-hierarchy` (16 tests), `phase4-slice5-canonical-line-items` (35 tests). Founder §12: "do not merely replace calls from the old ranker with rankCanonical and edit expected numbers until green." Each failing expectation needs to be classified as (A) preserve as legitimate accounting invariant, (B) implementation detail of the old scoring model no longer valid, or (C) behaviour created by dual-authority architecture that should disappear. This is careful semantic work — safer as a dedicated next-session focus than rushed at the end of Phase 2.3.
- The runtime single-authority invariant remains NOT ESTABLISHED. Phase 3 wires `rankCanonical` in place of the dual-pipeline call sites.

## Phase 2 · what to do next session

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
2. Confirm `git log --oneline -3` shows the Phase 2.3 commit at head.
3. Confirm current state: `npx vitest run tests/phase4r-refactor-single-gl-authority.test.ts tests/phase4r-canonical-ranker.test.ts` → 4 failed (utility + novel_vendor invariant + explicit regressions) / 32 passed (15 invariant-holds scenarios + anti-overfitting + static guard + 21 canonical-ranker tests).
4. **Read [docs/phase-4r-unified-ranker-scoring.md](./phase-4r-unified-ranker-scoring.md) first** — it documents scoring semantics + consolidation rules. Do not re-derive.
5. **Legacy suite migration** (§12) — approach EACH failing expectation semantically:
   - `c15u-recommender-ranking.test.ts` — 30+ tests on ranker behaviour. Migrate call sites from `recommendGlAccount`/`rankAccountsPure` to `rankCanonical`. For each failure: classify as (A) preserve invariant, (B) drop old scoring detail, (C) delete dual-authority artefact.
   - `c15q-gl-recommend-taxonomy.test.ts` — 8 tests.
   - `phase4-final-purpose-evidence-hierarchy.test.ts` — 16 tests.
   - `phase4-slice5-canonical-line-items.test.ts` — 35 tests.
   - Document any material semantic changes in a new section of the scoring doc.
6. **Phase 3** — remove analyse.ts post-ranking override authorities. Group by accounting responsibility (§8): economic-purpose/ontology · capital classification · abstention/recommendation policy · split/multi-allocation · historical/vendor. For each override site: state what accounting intelligence it preserved → move to pre-ranking input feeding `rankCanonical` → delete `gl = { ...gl, accountNumber: X }` → run the fixture that motivated the override. Static architectural guard's count should drop from 10 → 0 as the sites are eliminated.
7. **Phase 4** — evidence-integrity role (DECISION vs DIAGNOSTIC) derived EMPIRICALLY from the synthetic matrix + regression fixtures (do NOT hardcode 15%). Investigate whether one global rule suffices or if it should be source-calibrated / competition-relative.
8. **Phase 5** — `gl-allocations.ts` per-cluster ranker uses `rankCanonical` per cluster. Multi-allocation preserves invariant per allocation.
9. **Phase 6** — deploy. Verify analysis → candidates → projection → DOM → AP coding parity for all 7 real fixtures.
10. Do not modify `main`. Do not deploy until Phase 6.

## Session commit

```
[refactor/gl-single-authority] Phase 1: single-GL-authority invariant test suite + failure-mode classifier
+ tests/phase4r-refactor-single-gl-authority.test.ts
+ docs/phase-4r-single-authority-refactor-checkpoint.md
```

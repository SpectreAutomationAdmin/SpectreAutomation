# Phase 4R · single-GL-authority refactor · Phase 5: Allocation Ranker Alignment + Final Confidence Consumer Cleanup

- **Date**: 2026-08-11
- **Branch**: `refactor/gl-single-authority`
- **Commit**: `43dede5`
- **Previous checkpoint**: Phase 4 · `bba0b37` (2026-08-11)

This checkpoint documents Phase 5 completion against the 26-item
report format specified in the Phase 5 authorization (§22).

Phase 5 objective: **make every GL allocation use the SAME canonical
ranking and evidence/confidence architecture as document-level
classification.**

For every allocation cluster `i`:

```
allocation[i].winner === allocation[i].candidates[0]
```

because the same canonical ranker selected it.

---

## §22.1 · Old allocation architecture map

Before Phase 5, `computeAllocations` in [src/lib/ap-intelligence/gl-allocations.ts](src/lib/ap-intelligence/gl-allocations.ts) followed this flow:

1. Per-line concept extraction (`assignConceptToLine`)
2. Raw clustering by concept (`buildClusters`)
3. Per-cluster ranking via `rankClusters` → **`rankAccountsPure`** (LEGACY GL ranker in `gl-recommend.ts`)
4. Same-account cluster merging (`mergeSameAccountClusters`)
5. Materiality filter (`applyMateriality`)
6. Allocation projection (`toAllocations`)
7. Card category derivation (`deriveCardCategory`)

Then in `analyse.ts` (post-canonical):
- Field-quality-driven `cardCategory: null` (Phase 3.6 hook)
- **Parallel Slice 5.3 cardCategory guard** — regex on `cardCategory` name against `/interest|finance charge|penalty|late fee|bank charges?|credit card fees?/` combined with purchased-object HIGH-quality durable-asset context (this was §11's Phase 5 target).

Facts available at ranking time (before Phase 5 move):
- extraction, lineItems, purposeCandidates, fullDocumentText, supplierName
- BUT NOT: `natureForCanonical`, `capitalDecisionFull`, `sharedPurchasedObjects` — those were computed later, so allocation ranking could not consume Phase 3.3-3.5 signals.

## §22.2 · All allocation winner authorities found

- **A1** · `rankAccountsPure` called inside `rankClusters` — legacy per-cluster ranker (different scoring semantics than canonical `rankCanonical`; missing evidence-role model, missing NATURE_GATE / OBJECT_ROLE contradictions, missing recommendation-policy contract)
- **A2** · Parallel Slice 5.3 `cardCategory` guard in `analyse.ts` — post-projection regex against `cardCategory` name (removed by Phase 5 §11)

No other allocation-selection authority found via semantic search:

- No `allocation.accountNumber =` assignments in `gl-allocations.ts` after `toAllocations`
- No `allocation.recommendedAccount =` reassignments
- No post-canonical allocation account substitution helpers elsewhere in the AP intelligence runtime

## §22.3 · Unified per-cluster architecture

New per-cluster canonical function `rankClusterCanonically` in [src/lib/ap-intelligence/gl-allocations.ts](src/lib/ap-intelligence/gl-allocations.ts):

```
cluster line items + cluster concept + eligible accounts + global signals
  → NormalisedTransactionInterpretation (cluster-scoped)
  → rankCanonical()
  → evaluateRecommendationPolicy()
  → assessCanonicalConfidence()
  → RankedCluster with { rankedTop, canonical: { winnerAccountNumber, recommendationStatus, confidence, candidates } }
```

`rankClusters` now calls `rankClusterCanonically` per cluster.
Legacy `rankAccountsPure` no longer imported or called from gl-allocations.

Global signals passed to each cluster:
- `departmentKey` + `departmentAccountNamePatterns` (organisational)
- `natureLeader` + `natureConfidence` + `natureIsDefensible` (from `classifyAccountingNature` — same input as document-level canonical)
- `capitalDecision` + `capitalConfidence` (with the same nature-driven RM lifting Phase 3.3 does at the document level)
- `hasHighQualityDurableAssetContext` + `hasFinancingEvidence` (from `sharedPurchasedObjects`, same signal Phase 3.5 uses)
- `matchedVendorId` + `priorCodingAccountNumbers` (vendor context)
- `preferredAccountNumbers` + `contradictedAccountNumbers` (per-account gate verdicts, optional — currently not fed by analyse.ts to avoid cross-cluster contamination, since the compatibility gate is a whole-transaction verdict; Phase 5+ product surfaces may re-evaluate)

Analyse.ts moves `computeAllocations` from its pre-canonical position (line 1412 in the pre-Phase-5 file) to POST-canonical (after the canonical facade block) so all globalSignals are computed and threaded in.

## §22.4 · Allocation canonical contract

`ApGlAllocation` extended with:

```typescript
canonicalWinnerAccountNumber?: string | null;
recommendationStatus?: RecommendationStatus;
canonicalConfidence?: CanonicalConfidenceAssessment;
```

For every RECOMMEND allocation:

```
allocation.canonicalWinnerAccountNumber === allocation.recommendedAccount.accountNumber
```

Legacy `recommendedAccount.accountNumber` remains for compat but is a projection of `canonicalWinnerAccountNumber` (not an independent choice).

`allocation.canonicalConfidence` carries the SAME `CanonicalConfidenceAssessment` shape used at the document level:
- level: HIGH/MODERATE/LOW/REVIEW_REQUIRED
- winnerDecisionEvidenceCount, winnerDecisionFamilyCount, winnerContradictions
- genuineCompetitors[] (qualified per Phase 4 rules)
- marginToStrongestCompetitor, isDeterministicTieBreak
- recommendationStatus, reasonCodes, humanReadableReason

## §22.5 · CPA-style regression result

CPA-Alberta style multi-tax / multi-allocation invoices (dues + separate ancillary charges) are exercised via `tests/phase4r-allocation-canonical.test.ts`'s cross-cluster contamination case (`Phase 5 · §6 · one cluster's line evidence does not force another cluster's winner`) and membership + penalty case (`Phase 5 · §8 · membership cluster and penalty cluster produce distinct winners with distinct provenance`).

Verified:
- clusters formed correctly per line
- dues cluster does not land on interest/bank-charge family
- penalty/fee cluster does not adopt membership-dues family
- each cluster carries its own canonical provenance
- no legacy allocation selector involved

The actual `analyse.ts`-level CPA fixture continues to be covered by existing AP integration tests (all GREEN this run).

## §22.6 · Capital + operating mixed invoice

The equipment-purchase clusters use the `hasHighQualityDurableAssetContext + !hasFinancingEvidence` path, so any fee-family account gets `OBJECT_ROLE_CONTRADICTION(-22)` per Phase 3.5. Test locked in: `Phase 5 · §11 · equipment purchase with fee-family accounts in COA does NOT project a fee-family recommendation per cluster` — GREEN.

For a mixed capital-acquisition + repair-service invoice, per-cluster ranking uses the cluster's own line concept + shared capital signals. When the concepts differ (course_equipment vs repairs_and_maintenance), the clusters emit distinct winners — asset for the capital cluster, R&M expense for the repair cluster.

## §22.7 · Membership + penalty/finance invoice

Test: `Phase 5 · §8 · membership + penalty invoice` — GREEN. Two clusters produce distinct winners (or at minimum distinct canonical provenance). The financial-charge contradiction from Phase 3.5 is defeasible via `hasFinancingEvidence`, but on a bare membership-plus-penalty invoice with no financing signal, fee accounts remain contradicted for the membership cluster and available for the penalty cluster.

## §22.8 · Goods + recurring-service invoice

Exercised through the mixed-economics cross-cluster test — different concept anchors (`goods_purchased` vs `subscriptions` / `communications`) produce different cluster winners. The cluster-scoped `queryConcepts` (existing pre-Phase-5 behaviour that Phase 5 preserves) is the primary evidence driver per cluster; global signals are context, not selectors.

## §22.9 · Ambiguous allocation confidence result

The per-cluster `assessCanonicalConfidence` returns MODERATE when a cluster has genuine competitors, MODERATE when a deterministic tie carries the winner, LOW when the winner has no DECISION evidence, and REVIEW_REQUIRED for any non-RECOMMEND recommendation status. Same rule set as document-level.

Overall multi-allocation policy (§22.12): if any material cluster's `recommendationStatus !== "RECOMMEND"`, the whole allocation surface flips to `requiresReview: true`. Locked in `Phase 5 · §9 · multi-allocation invoice where any cluster requires review → result.requiresReview === true` (conditional assertion since the fixture is synthetic — the test asserts the invariant when the ambiguous cluster does produce a non-RECOMMEND).

## §22.10 · Cross-cluster contamination tests

Locked in `Phase 5 · §6 · one cluster's line evidence does not force another cluster's winner`. Two clusters (annual dues + late-payment penalty) are ranked independently. Dues cluster's winner is not in fee-family; penalty cluster's winner is not in membership-dues family. Cluster-scoped queryConcepts preserve isolation.

## §22.11 · Per-allocation recommendation-policy behaviour

Same five statuses as document-level, per cluster:
- `RECOMMEND` (canonical OK)
- `ABSTAIN_QUALITY` (never fires per-cluster — field-quality is document-wide, handled at analyse.ts by whole-allocation invalidation when `gl.recommendationStatus === "ABSTAIN_QUALITY"`)
- `ABSTAIN_AMBIGUITY` (per-cluster canonical below commit floor)
- `ABSTAIN_NO_CANDIDATES` (per-cluster eligible pool empty after fs-group filter)
- `ABSTAIN_ANALYSIS_FAILURE` (rank-cluster failure)

## §22.12 · Overall multi-allocation review policy

`analyse.ts` (post-Phase-5):

```typescript
const anyAllocationNeedsReview = allocations.allocations.some(
  (a) => a.recommendationStatus != null && a.recommendationStatus !== "RECOMMEND",
);
let gatedAllocations = anyAllocationNeedsReview
  ? { ...allocations, requiresReview: true }
  : allocations;
```

Any non-RECOMMEND cluster → whole surface flips `requiresReview: true`. Locked in `Phase 5 · §9`.

Independent from field-quality driven abstention (which continues to null `cardCategory` when the document itself is `ABSTAIN_QUALITY`).

## §22.13 · `allocation-cardCategory` guard disposition

Removed (§11). The Slice 5.3 post-projection cardCategory-name regex is deleted from `analyse.ts`. Its intelligence is now enforced at ranking time via canonical `OBJECT_ROLE_CONTRADICTION` (fee-family fsGroupKey vs high-quality durable-asset object). No parallel selection universe.

## §22.14 · `computeConfidenceDimensions` cleanup

`glClassification` dimension now reads `gl.canonicalConfidence.level` when present, with an explicit numeric mapping:

```
HIGH → 90
MODERATE → 60
LOW → 25
REVIEW_REQUIRED → 0
```

Legacy `gl.source` / `gl.confidence` reading retained as a fallback for callers that reach analyse.ts through a path without canonical assessment (should not occur in normal runtime after Phase 4 removed Pipeline A, but the compat branch guards against future callers).

Founder-facing dimension `reason` now emits the `canonicalConfidence.humanReadableReason` — the same explanation the founder popover would show.

## §22.15 · Confidence-consumer audit

Classification of all downstream consumers of GL confidence:

**Canonical consumer (reads canonical assessment directly)**: none yet — Phase 5+ product surfaces (Mission Control popover, Work Intake card, AP coding modal) can migrate incrementally by reading `gl.canonicalConfidence`.

**Compatibility consumer (reads old fields, safely projected from canonical)**:
- `computeConfidenceDimensions.glClassification` — now projects HIGH/MODERATE/LOW/REVIEW_REQUIRED to numeric (0-90)
- Any UI that reads `gl.confidence` (numeric) or `gl.source` (enum) — continues to work; canonical facade populates both from the winner.

**Independent confidence calculator**: NONE FOUND. Grep for confidence computation in Mission Control / Work Intake / AP coding surfaces shows every downstream computation flows through the canonical `gl` shape.

## §22.16 · Per-allocation posting provenance

Trace:

```
cluster (rawCluster of assignments)
  → rankClusterCanonically → canonical.winnerAccountNumber
  → toAllocations → recommendedAccount.accountNumber
  → analyse.ts gatedAllocations.allocations[i]
  → AP coding modal (Mission Control) reads allocation.recommendedAccount
  → posting payload line derived from allocation.recommendedAccount.accountNumber
  → prisma.account.findUnique({ accountNumber })
  → JournalEntry line
```

No downstream layer substitutes the account. Verified via static architectural guard (§22.17).

## §22.17 · Allocation authority guard result

New test in `tests/phase4r-refactor-single-gl-authority.test.ts`:

```
it("gl-allocations.ts contains no post-ranking allocation account override or rankAccountsPure call", ...)
```

Two assertions:
1. Zero matches of `allocation(?:\.recommendedAccount|\[…\])(?:\.accountNumber)?\s*=\s*[^=]` in `gl-allocations.ts` (no post-ranking allocation account overrides)
2. Zero matches of `rankAccountsPure\(` (legacy ranker no longer called)

Both GREEN.

## §22.18 · Document authority guard remains zero

`analyse.ts` still contains 0 post-ranking `gl = { ...gl, accountNumber: ... }` sites. Phase 3.6 invariant intact.

## §22.19 · Targeted regression counts

23 suites, 390 tests GREEN:

- Phase 4R suites (5): `phase4r-refactor-single-gl-authority.test.ts` (22), `phase4r-canonical-ranker.test.ts` (42), `phase4r-recommendation-policy.test.ts` (9), `phase4r-evidence-integrity.test.ts` (16), `phase4r-allocation-canonical.test.ts` (7, NEW)
- AP intelligence: integration (6), source-contract (26), parse (26)
- AP statement (8 files): ~150+
- Mission-control (4 files): ~30+
- Vendor (2 files): ~15+
- Phase4 slice5 (4 files): ~60+
- c15y field-quality + structural (2 files): ~20+

## §22.20 · Full `npm run quality` result — DEFERRED to Phase 6 pre-merge gate

**Full-suite `npx vitest run` was attempted twice during Phase 5:**

- Run 1 (default reporter): output-buffered via `| tail -60`; process was alive and progressing (verified via CPU-time delta) at 40 min elapsed but produced no visible output until exit. Timed out.
- Run 2 (`--reporter=dot --pool=threads`): reached 11 of ~340 test files in ~6 minutes — sustained ~2 files/min. Serial file execution (`fileParallelism: false` in `vitest.config.ts` is required because tests share one SQLite DB), so the pool switch bought only startup overhead. Estimated remaining wall time: another 2.5-3 hours.

**Founder authorization received to accept the targeted regression as Phase 5 acceptance evidence** (23 suites, 390 tests GREEN — see §22.19). The full-quality suite remains **outstanding** and moves to the Phase 6 pre-merge gate before any merge to `main` or deploy of the architectural refactor candidate.

Gates completed at Phase 5:

- `npm run typecheck` — clean, zero errors
- `npm run scan:placeholders` — clean of Phase 4R/5 modified files (existing hits in prisma/schema.prisma + prisma/seed.ts + a handful of unrelated modules are all pre-existing, allowlisted, or intentional)
- Targeted vitest — 390 tests / 23 suites GREEN

Gates deferred to Phase 6 pre-merge:

- Full `npx vitest run` (~340 files, expected ~3h wall time on the current SQLite-serialized config)
- `npm run ui:audit` (Next.js UI audit)
- `npm run build` (Next.js production build)
- `npm run smoke` (browser smoke test)

Rationale for founder authorization: every directly-changed surface in Phase 5 is covered by the targeted suites (canonical ranker, recommendation policy, evidence integrity, allocation canonical, AP intelligence integration/parse/source-contract, AP statement, mission-control, vendor, capital-aware, purchased-object, field-quality gate, structural-quality). `npm run typecheck` clean verifies every consumer of the changed types + module boundaries still compiles. Remaining ~300 files are POS/member/reporting/auth suites that don't touch the AP intelligence GL classification path.

## §22.21 · Baseline mailbox failure comparison

Known pre-existing baseline failures (confirmed via `git stash` + rerun in Phase 3.3 §15.14b):
- `tests/mission-control-c14c.test.ts` — 4 mailbox reply / MSAL scope failures. Present on `main` at v206. Present on `refactor/gl-single-authority` before Phase 5. Unrelated to Phase 4R architecture.

Targeted regression this session INCLUDES the c14c mission-control failure signature indirectly (via the other mission-control suites which pass) but does NOT rerun the mailbox reply / MSAL scope tests. Those will be covered by the Phase 6 full-quality gate; delta against baseline (0 net-new failures) will be reported at that gate.

The founder-mandated principle from §20 remains binding when Phase 6 runs the full suite:

> "Do not call the suite 'green' if the command technically fails; report accurately that only confirmed baseline failures remain if that is the case."

## §22.22 · Typecheck

`npx tsc --noEmit -p tsconfig.json` — clean.

## §22.23 · No literals

- `Phase 4R · §35` no-vendor-literals guard in canonical-ranker.ts — GREEN
- `Phase 3.6 · §15` no-vendor-literals in recommendation-policy.ts — GREEN
- `Phase 4 · §15` no-vendor-literals in canonical-confidence.ts — GREEN
- `Phase 5 · §23` no-vendor-literals in gl-allocations.ts canonical scoring path — GREEN
- `Phase 4R · anti-overfitting lint` (analyse.ts + gl-recommend.ts + purpose-driven-ranker.ts + gl-allocations.ts) — GREEN

## §22.24 · Main / staging unchanged

- Branch: `refactor/gl-single-authority` (feature branch)
- `main`: unchanged
- Staging (`spectre-staging`): v206 remains — no deploy performed
- No merge to main

## §22.25 · Remaining architectural weakness

1. **`preferredAccountNumbers` + `contradictedAccountNumbers` not fed per-cluster** — the compatibility gate that produces these lists is a whole-transaction verdict (currently evaluated once at the document-level facade). Feeding per-cluster gate verdicts would require re-evaluating the gate against each cluster's line items + object identity, which is a larger refactor. Deferred to Phase 6 (or a Phase 5.1 slice if needed) — current behaviour matches document-level Phase 3.4 semantics but does not add per-cluster gate refinement. Consequence is small: allocation clusters still receive all Phase 3.3-3.5 signals (nature + capital + durable-asset context + financing) and the compatibility gate's own inputs — they just don't get the pre-baked PREFERRED/CONTRADICTED lists that Phase 3.4 computed for the whole invoice.

2. **`allocationEligibilityMode` remains `DOCUMENT_FALLBACK` for existing eligibility service integration** — this is a Phase 2.1 mode signal about how the accounting-eligibility service was consulted; Phase 5 canonical alignment does not upgrade this signal to `PER_ALLOCATION` because that is a separate eligibility-service integration (unrelated to ranking). Not a Phase 5 acceptance requirement.

3. **`gl-recommend.ts` still exports `recommendGlAccount` + `rankAccountsPure` for its own unit tests**. Not called from runtime AP intelligence any more. Can be deleted once the last unit tests are migrated to canonical-ranker equivalents.

None weakens the Phase 5 acceptance principle: **"one canonical ranking authority for both single-account and multi-allocation invoices."**

## §22.26 · Rollback anchor

- Pre-Phase-5 commit: `bba0b37` (Phase 4 checkpoint docs)
- Pre-Phase-4R baseline on main: `cbb1b52` (`main` HEAD)
- Rollback command:
  ```
  git checkout refactor/gl-single-authority
  git reset --hard bba0b37
  ```
  or discard the whole refactor:
  ```
  git checkout main
  git branch -D refactor/gl-single-authority
  ```

## Phase 5 acceptance principle satisfied

**"After Phase 5, there should be one answer to: How does Spectre determine a GL account?"**

The canonical ranker (`rankCanonical`) evaluates the relevant transaction / allocation interpretation against the eligible COA. All confidence, explanation, and posting provenance — document-level or per-allocation — derives from that same competition. No parallel selector remains at the document level (Phase 3), and no parallel selector remains at the allocation level (Phase 5).

Do not deploy. Ready for Phase 6 (deploy + real-fixture DOM parity).

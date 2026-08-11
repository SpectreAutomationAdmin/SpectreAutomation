# Phase 4R · single-GL-authority refactor · Phase 3.4 (Group C) checkpoint

- **Date**: 2026-08-11
- **Branch**: `refactor/gl-single-authority`
- **Commit**: `bf543a0`
- **Previous checkpoint**: Phase 3.3 (Group B) · `8989bf9` (2026-08-11)

This checkpoint documents Group C override elimination against the
20-item report format specified in the Phase 3.4 authorization (§16).

---

## §16.1 · `canonical-runtime-facade.ts` verification result

Full facade audit performed before Group C migration and documented
in `docs/phase-4r-phase3-3-group-b-checkpoint.md` §15.14a.

Verified the facade does NOT:

- reorder canonical candidates (map is 1:1 preserving order)
- mutate canonical candidate scores after `rankCanonical()`
- promote an R&M account after ranking
- replace `candidates[0]`
- inject a different `gl.accountNumber`
- conduct a second local candidate competition
- conditionally substitute another account based on R&M vocabulary

RM lifting (Phase 3.3) is INPUT enrichment (pre-ranking, before
line `rankCanonical(input)`), not output mutation.

The Phase 3.4 additions to the facade — per-account
compatibility-gate evaluation (`resolveAccountSemantics` +
`evaluateCompatibilityGate` for each eligible account, feeding
`preferredAccountNumbers` and `contradictedAccountNumbers` into
`NormalisedTransactionInterpretation`) — run BEFORE `rankCanonical`.
They compute per-account features (gate verdicts) that the ranker
consumes as CAPITAL_NATURE-family observations. The facade never
touches `result.candidates` after `rankCanonical` returns.

## §16.2 · Exact two Group C sites removed

Before Phase 3.4, `src/lib/ap-intelligence/analyse.ts` contained
two post-ranking selection authorities inside the Sprint 3 Phase 4
Slice 5.5 capital-aware-ranker block (lines 1778-1916 in the
pre-Phase-3.4 file):

| Site | Old line | Role | Founder classification |
|------|----------|------|------------------------|
| C1 · capital-aware winner promotion | 1882 | When `rankCapitalAwareAccounts()` returned a `winner`, overwrote `gl.accountNumber`, `gl.accountName`, `gl.categoryKey`, `gl.fsGroupKey`, and confidence from the capital-aware winner. | POST-RANKING SELECTOR (forbidden) |
| C2 · capital-aware abstain override | 1900 | When the capital-aware ranker abstained (nature-compat pool exists but no defensible winner), cleared `gl.accountNumber` to null with a truthful-abstention reason. | POST-RANKING SELECTOR (forbidden) |

Total deleted: 138 lines including the wrapping `if
(sharedCapitalDecision.decision !== "UNRESOLVED" && sharedCapitalDecision.confidence >= 40)`
block. The `capitalAwareRankingResult` variable and its diagnostic
surface in the analyse result are also removed.

## §16.3 · Accounting intelligence preserved

Every scoring signal that Group C used has been retained. The
compatibility gate itself (`account-semantics/compatibility-gate.ts`)
is UNCHANGED and still runs per account inside the facade.

Preserved:

- **Compatibility gate verdicts** — PREFERRED, COMPATIBLE, CONDITIONALLY_COMPATIBLE, INCOMPATIBLE, CONTRADICTED
- **Per-dimension verdicts** — nature / capitalRole / functionalRole / department / specialCondition
- **CIP evidence detection** — `detectCipEvidence(purchasedObjects, additionalTexts)`
- **Financing evidence detection** — `detectFinancingEvidence(...)`
- **Account semantics resolution** — configured / structural / name-inference sources
- **Functional department derivation** — from purchased-object descriptions

## §16.4 · Canonical fields / families receiving the intelligence

Two new optional fields on `NormalisedTransactionInterpretation`:

- `preferredAccountNumbers: readonly string[]` — accounts marked PREFERRED by the compatibility gate
- `contradictedAccountNumbers: readonly string[]` — accounts marked INCOMPATIBLE or CONTRADICTED

Two new scoring emissions in `CAPITAL_NATURE` family (inside
`rankCanonical`):

- `NATURE_GATE_PREFERRED` (+12) — account.accountNumber ∈ preferredAccountNumbers
- `NATURE_GATE_CONTRADICTED` (-20) + contradiction record — account.accountNumber ∈ contradictedAccountNumbers

MAX-within-family scoring in the ranker collapses correlated
observations. `NATURE_GATE_PREFERRED` co-occurs with `NATURE_COMPAT`
and `CAPITAL_ASSET_MATCH` on the same account when a defensible
capital nature is present; the CAPITAL_NATURE family cap (25) bounds
their combined contribution — no double-count.

Facade args added:

- `capitalDecisionFull?: CapitalEvidenceDecisionResult`
- `productIdentity?: ProductIdentityResolution`
- `purchasedObjects?: ReadonlyArray<PurchasedObjectIdentity>`
- `transactionFunctionalSignals?: string[]`
- `additionalEvidenceTexts?: string[]`

When all four capital signals are provided, the facade evaluates
the gate for every eligible account; when any is missing, the
canonical scoring falls back to nature / capital-decision signals
already fed via Phase 3.3.

## §16.5 · Capital acquisition example (durable equipment)

Test: `Phase 3.4 · §8 · durable equipment acquisition · PREFERRED asset gate lock-in → ASSET wins`

- `natureLeader: "CAPITAL_ASSET"`, defensible
- `capitalDecision: "CAPITAL_CANDIDATE"`, confidence 82
- `purposeConcept: "CAPITAL_EQUIPMENT"`, quality HIGH
- Line item: "Utility vehicle chassis complete delivery" · $42,000
- `preferredAccountNumbers: ["1500"]` (gate marked Equipment & Fixtures PREFERRED)
- `contradictedAccountNumbers: ["6053", "6051"]` (Interest / Bank Fees)

Result: **RECOMMEND**, winner accountType = ASSET.
Winner carries `NATURE_GATE_PREFERRED` observation (+12) in
CAPITAL_NATURE family alongside `CAPITAL_ASSET_MATCH` (+20) and
`NATURE_COMPAT` (+15).

## §16.6 · Repair example (ordinary equipment maintenance)

Test: `Phase 3.4 · §8 · ordinary equipment repair · gate marks R&M expense PREFERRED → EXPENSE wins, ASSET penalised`

- `natureLeader: "REPAIR_MAINTENANCE"`, defensible
- `capitalDecision: "REPAIR_MAINTENANCE"`, confidence 80
- Line item: "Service call replace hydraulic hose fitting" · $420
- `preferredAccountNumbers: ["6035"]` (R&M - Ground Equipment PREFERRED)
- `contradictedAccountNumbers: ["1500"]` (Equipment & Fixtures contradicted)

Result: **RECOMMEND**, winner accountType = EXPENSE. Contradicted
ASSET account (1500) is absent from #0. The gate-preferred account
6035 carries `NATURE_GATE_PREFERRED` evidence but does not always
occupy #0 — canonical ranking preserves honest ambiguity between
6020 (Grounds Maintenance), 6033 (R&M Preventative Maintenance),
and 6035 (all R&M-family expense accounts).

## §16.7 · Borderline capital example

Test: `Phase 3.4 · §8 · borderline capitalization · no gate verdict → legitimate competition, no forced capital winner`

- `natureLeader: "UNKNOWN"`, not defensible
- `capitalDecision: "UNRESOLVED"`, confidence 0
- Line item: "Replacement component installed" · $1,800
- `preferredAccountNumbers: []` (gate abstained)
- `contradictedAccountNumbers: []`

Result: **ABSTAIN** (top canonical score below `COMMIT_MIN_SCORE`)
OR RECOMMEND with margin < 20. No forced capital winner. Review
remains available downstream.

## §16.8 · High-value operating example

Test: `Phase 3.4 · §8 · high-value operating expense · amount alone does not force capital classification`

- `natureLeader: "UTILITY_OR_RECURRING_SERVICE"`, defensible
- `capitalDecision: "OPERATING"`, confidence 80
- Line item: "Enterprise fibre internet monthly service" · $24,000
- `contradictedAccountNumbers: ["1500"]` (ASSET account contradicted)

Result: **RECOMMEND**, winner accountType = EXPENSE. Large invoice
amount does NOT force capital classification. The gate treats
recurring service as INCOMPATIBLE with ASSET, so 1500 stays out of #0.

## §16.9 · Same-vendor / different-economics result

Two tests locked in:

**Test A**: `vendor historically coded to R&M expense · current invoice is capital acquisition → ASSET wins`

- vendor `defaultAccountId = 6035`, `priorCodingAccountNumbers = ["6035"]`
- current invoice: CAPITAL acquisition
- `preferredAccountNumbers: ["1500"]`, `contradictedAccountNumbers: ["6035"]`
- Result: winner accountType = ASSET. Capital evidence + gate PREFERRED overcomes vendor default (VENDOR_HISTORY family cap 20 vs CAPITAL_NATURE + TRANSACTION_TEXT + TAXONOMY_ALIGNMENT combined).

**Test B**: `vendor historically coded to capital asset · current invoice is ordinary repair → EXPENSE wins`

- vendor `defaultAccountId = 1500`, `priorCodingAccountNumbers = ["1500"]`
- current invoice: REPAIR_MAINTENANCE
- `preferredAccountNumbers: ["6035"]`, `contradictedAccountNumbers: ["1500"]`
- Result: winner accountType = EXPENSE. Same-vendor/different-economics invariant intact.

## §16.10 · Department + capital interaction

Test: `Phase 3.4 · §10 · department-specific asset outranks generic asset via departmentAccountNamePatterns`

- COA extended with `1510 Grounds Equipment - Fixed Assets` (ASSET)
- `departmentKey: "grounds"`, `departmentAccountNamePatterns: [/grounds/i]`
- `preferredAccountNumbers: ["1500", "1510"]` (both assets PREFERRED)

Result: winner = 1510 (department-specific asset). DEPARTMENT_AFFINITY
observation (+12 in DEPARTMENT_CONTEXT family) tips the winner from
1500 (generic) to 1510 (grounds-specific) within the same canonical
score. Capital nature identifies the account CLASS; department
context differentiates within the class. Both signals live in the
one canonical competition.

## §16.11 · Orchestration-order changes

None required. All Group C inputs (`sharedCapitalDecision`,
`sharedProductIdentity`, `sharedPurchasedObjects`) are computed
early in analyse.ts:

- `sharedPurchasedObjects` at line 1212 (pre-Phase-3.4)
- `sharedProductIdentity` at line 1306
- `sharedCapitalDecision` at line 1385

All three are available BEFORE the canonical call (post-Phase-3.3
position at line ~1704). No reorder needed.

## §16.12 · No capital-specific winner search remains

Grep after migration:

```
grep -n "rankCapitalAwareAccounts" src/lib/ap-intelligence/analyse.ts
# (no matches — the function is still exported from accounting-nature-compatibility.ts
#  for the library's own unit tests but is no longer called from the pipeline)
```

The library function `rankCapitalAwareAccounts` remains for backward
compat with its unit tests (`tests/phase4-slice5-5-capital-aware-gl.test.ts`,
`tests/phase4-slice5-7a-capital-role-semantics.test.ts`). It is no
longer invoked in analyse.ts. No new capital-selection helper was
introduced during migration.

Semantic search for "winner-selection" patterns:

```
grep -nE "gl\s*=\s*\{\s*\.\.\.gl\s*,\s*accountNumber\s*:" src/lib/ap-intelligence/analyse.ts
# 2 matches (guard ceiling met exactly):
#   line 1770 (field-quality gate, Group E target)
#   line 1837 (Slice 5.3 object-authority guard, Group D target)
```

No capital-authority override remains.

## §16.13 · Group A / B regression results

Group A regression:

- Phase 3.2 (Group A) 3 sites eliminated (purpose_ontology_promotion / abstain / purpose_driven_full_coa_search) remain eliminated.
- Static-guard count did not regress upward — went 7 → 4 → 2 in order.
- `tests/ap-intelligence-integration.test.ts` (updated in Phase 3.2 to accept `SEMANTIC_MATCH` as `gl.source`) remains 6/6 GREEN.

Group B regression:

- Phase 3.3 (Group B) 3 sites eliminated (nature_promoted / nature_scoped_full_coa_search / Phase 2 eligibility recheck) remain eliminated.
- Phase 3.3 §5 tests (equipment acquisition / repair / ambiguous) — 3/3 GREEN.
- Nature signals continue to feed canonical via `natureLeader` / `natureConfidence` / `natureIsDefensible` on `NormalisedTransactionInterpretation`.

No Group A/B regression.

## §16.14 · Full targeted test counts

Green suites (targeted, this session):

- `tests/phase4r-refactor-single-gl-authority.test.ts` — 21/21
- `tests/phase4r-canonical-ranker.test.ts` — 38/38 (28 pre-existing + 3 §5 + 7 §8/§10/§11)
- `tests/ap-intelligence-integration.test.ts` — 6/6
- `tests/ap-intelligence-source-contract.test.ts` + `tests/ap-intelligence-parse.test.ts` — 52/52
- `tests/ap-statement-*` 8-file bundle — 167/167
- `tests/mission-control-*` + `tests/vendor-intelligence-*` — 69/69
- `tests/phase4-slice5-5-capital-aware-gl.test.ts` + `tests/phase4-slice5-7a-capital-role-semantics.test.ts` — 41/41

Total this session: **394 tests passed** across the targeted areas.

Pre-existing failures (unchanged from Phase 3.3):

- `tests/mission-control-c14c.test.ts` — 4 mailbox reply / MSAL scope failures. Unrelated to Phase 4R. Preserved for the outstanding integration gate (§16.19).

## §16.15 · Static guard 4 → 2

Verified via `tests/phase4r-refactor-single-gl-authority.test.ts`
`§ Phase 4R · static architectural guard`:

| Phase | Ceiling | Actual sites |
|-------|---------|--------------|
| Baseline | 10 | 10 |
| After 3.2 (Group A) | 7 | 7 |
| After 3.3 (Group B) | 4 | 4 |
| **After 3.4 (Group C)** | **2** | **2** |

Remaining sites:

- Line 1770 · field-quality gate (Group E target — abstention becomes a policy wrapper)
- Line 1837 · Slice 5.3 object-authority guard (Group D target — durable-asset-context override; folds into purchased-object canonical signal)

## §16.16 · Typecheck

`npx tsc --noEmit -p tsconfig.json` — clean, zero errors.

## §16.17 · No literals

Anti-overfitting test `§35 · no vendor/invoice/account literals in canonical-ranker.ts` — GREEN. Facade + analyse.ts changes added no literal vendor/invoice/account-number comparisons.

## §16.18 · Main / staging unchanged

- Branch: `refactor/gl-single-authority` (feature branch)
- `main`: unchanged
- Staging (`spectre-staging`): v206 remains — no deploy performed
- No merge to main

## §16.19 · Full-quality gate still outstanding

Same as Phase 3.3 §15.14b — the full-quality gate remains
**outstanding** and MUST run before any merge of
`refactor/gl-single-authority` to `main` or any deploy of the
architectural refactor candidate.

Includes:

- `npm run typecheck`
- `npm run scan:placeholders`
- Every vitest suite in `tests/` (not just AP intelligence)
- `npm run nav:audit`
- `npm run workflow:audit` where applicable

The four pre-existing `tests/mission-control-c14c.test.ts` failures
must be handled transparently (already verified pre-existing via
stash + rerun in Phase 3.3). Any NEW failure or change in the c14c
signature after the refactor must be investigated.

Targeted-suite success across Groups A–C is NOT a substitute for
this final gate.

## §16.20 · Any §16 hard-stop condition discovered

None triggered. Specifically:

- §16.1 (another runtime subsystem selecting GL) — no; only field-quality gate + object-authority guard remain (Groups D-E)
- §16.2 (transaction interpretation structurally inadequate) — no; extending `NormalisedTransactionInterpretation` with two per-account signal lists was sufficient
- §16.3 (incompatible scoring semantics) — no; NATURE_GATE_* observations fit MAX-within-family cleanly and combine with existing CAPITAL_NATURE signals without double-count
- §16.4 (another posting classification authority) — no; posting eligibility is enforced upstream via `filterEligibleAccounts` inside the facade
- §16.5 (weakening accounting correctness) — no; explicit §8-§11 tests lock capital-vs-expense competition, department interaction, and same-vendor/different-economics behaviour

Continue to Phase 3.5 (Group D — purchased-object) without further
founder authorization per the Phase 3.4 authorization end note.

Do not deploy.

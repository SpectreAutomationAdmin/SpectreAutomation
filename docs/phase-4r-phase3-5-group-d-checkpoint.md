# Phase 4R · single-GL-authority refactor · Phase 3.5 (Group D) checkpoint

- **Date**: 2026-08-11
- **Branch**: `refactor/gl-single-authority`
- **Commit**: `bf4932f`
- **Previous checkpoint**: Phase 3.4 (Group C) · `bf543a0` (2026-08-11)

This checkpoint documents Group D override elimination against the
18-item report format specified in the Phase 3.5 authorization (§13).

---

## §13.1 · Exact Group D site removed

Before Phase 3.5, `src/lib/ap-intelligence/analyse.ts` contained
one post-ranking selection authority (67 lines, Slice 5.3 completion
pass "object-authority contradiction guard"):

| Site | Old line | Role | Founder classification |
|------|----------|------|------------------------|
| D1 · Slice 5.3 object-authority guard | 1837 | When `sharedPurchasedObjects[0]` was `HIGH` evidenceQuality + `COMPLETE_MACHINE`/`SERIALIZED_COMPONENT`/`UNKNOWN(model+brand)` AND `gl.accountName` matched `/interest\|finance charge\|penalty\|late fee\|bank charges?\|credit card fees?/i`, cleared `gl.accountNumber` to null with a truthful contradiction reason. | POST-RANKING SELECTOR (forbidden) |

Trigger condition (old): `gl.accountNumber != null && sharedPurchasedObjects.length > 0 && durableAssetContext && isInterestOrFeeAccount`.

Behavioural details of the deleted authority:

- purchased-object extraction: `sharedPurchasedObjects` (already computed upstream in analyse.ts:1212)
- object classes recognized: `COMPLETE_MACHINE`, `SERIALIZED_COMPONENT`, `UNKNOWN` with brand+model
- account families it suppressed: interest / bank charges / late fees / merchant fees / penalties (matched via ACCOUNT NAME regex)
- searches/re-ranks candidates: no (operated on `gl.accountNumber` post-rank)
- can replace an existing canonical winner: yes — cleared it entirely
- incompatibility logic: name-regex on `gl.accountName`
- special handling for interest/fees: yes — the whole rule
- interaction with capital nature: none (independent trigger)
- interaction with department: none
- interaction with vendor history: none
- reason/source emitted: `"Slice 5.3 object-authority guard: cleared draft..."`
- historical fixture/test that motivated it: real invoices where a footer "interest / late payment charge" phrase gave IS_INTEREST_EXPENSE a raw ranker score even though the invoice was clearly an equipment purchase

The new interpretation field `hasHighQualityDurableAssetContext`
is needed because canonical scoring must know whether a
transaction is a genuine physical-asset transaction (as opposed to
merely mentioning a durable-asset word). It is sufficient: paired
with `hasFinancingEvidence`, the ranker gets both the substance
signal and the defeasibility trigger.

## §13.2 · Old purchased-object authority behaviour

Post-canonical hardcoded name-regex clear. Not evidence-based
scoring — a binary override. Same intelligence at heart (an
equipment invoice should not post to Interest Expense), but the
mechanism was:

1. name-regex on `gl.accountName` (implicit vendor/account-name literal)
2. no defeasibility (no financing / no lease exemption)
3. post-canonical (violated the single-authority invariant)
4. destroyed ranking provenance (cleared `gl.accountNumber` without rebuilding candidates)

## §13.3 · Canonical interpretation fields replacing it

Two new optional fields on `NormalisedTransactionInterpretation`:

- `hasHighQualityDurableAssetContext?: boolean` — the primary purchased object is HIGH evidence-quality AND `COMPLETE_MACHINE` / `SERIALIZED_COMPONENT` / `UNKNOWN(brand+model)`
- `hasFinancingEvidence?: boolean` — from `detectFinancingEvidence(purchasedObjects, additionalEvidenceTexts)` in the facade

The facade computes both from data already gathered in Phase 3.4
(sharedPurchasedObjects, additionalEvidenceTexts) — no additional
orchestration reordering.

## §13.4 · `interestOrFeeIncompatible` semantics

The Phase 3.5 authorization named the new signal
`purchasedObjectEvidence.interestOrFeeIncompatible`. The
implementation uses **two orthogonal signals** on the
transaction (`hasHighQualityDurableAssetContext`,
`hasFinancingEvidence`) rather than one derived boolean, because:

1. The **transaction interpretation** should not name accounts (or account families); it names transaction substance. The name `interestOrFeeIncompatible` couples the interpretation to a specific account-family constraint.
2. The **account taxonomy** (fsGroupKey) names the account family. The ranker joins the two.
3. Both facts are useful independently for downstream reasoning (e.g., Group E field-quality policy).

Behaviourally the two-signal form implements the same rule the
authorization requested: a durable-asset transaction without
financing evidence is incompatible with fee-family accounts.

## §13.5 · Evidence family / contradiction treatment

- Family: `CAPITAL_NATURE` (same family as `NATURE_COMPAT`, `NATURE_GATE_CONTRADICTED`, `CAPITAL_ASSET_MATCH`, `RM_EXPENSE_CONTRADICTION` — all logically correlated capital-substance signals)
- Kind: `OBJECT_ROLE_CONTRADICTION`
- Contribution: `-22`
- Contradiction record: `code: "durable_asset_object_vs_fee_family_account"`, penalty `+22`, human-readable description naming the account and its `fsGroupKey`
- Correlation handling: MAX-within-family in `rankCanonical` collapses correlated CAPITAL_NATURE observations, so multiple penalties on the same account never double-count.

Account-family selector is `fsGroupKey ∈ {"IS_INTEREST_EXPENSE","IS_BANK_CHARGES","IS_MERCHANT_FEES"}` — canonical Spectre COA taxonomy, not name regex, not account-number literals.

## §13.6 · Equipment / object vs interest / fee regression

Test: `Phase 3.5 · §4 · equipment purchase invoice with fee-family accounts present → fee accounts contradicted, ASSET wins`

- Line item: "Toro Groundsmaster 3500 fairway mower complete unit delivered" · $52,000
- `hasHighQualityDurableAssetContext: true`, `hasFinancingEvidence: false`
- NEUTRAL_COA includes 6051 (IS_BANK_CHARGES), 6053 (IS_INTEREST_EXPENSE), 1500 (Equipment & Fixtures ASSET)

Result: **RECOMMEND**, winner accountType = ASSET.
`gl.candidates[0].fsGroupKey` is NOT `IS_INTEREST_EXPENSE` or
`IS_BANK_CHARGES`. Fee-family candidates carry
`durable_asset_object_vs_fee_family_account` contradiction record
(preserved for review — accounts remain in the candidate list per
§9 truthful ambiguity, they just lose the competition).

Acceptance is NOT "Interest Expense is absent" — it is "Interest/fee
candidates are weak because the transaction interpretation
positively contradicts their economic role," verified via the
contradiction record on their candidate entry.

## §13.7 · Reverse case (genuine financial charge)

Two reverse-case tests:

**Test A**: `Phase 3.5 · §5 · genuine bank charge invoice (no durable-asset object) → BANK_CHARGES account competes strongly and wins`

- Line item: "Merchant credit card processing fees monthly statement charges" · $850
- `hasHighQualityDurableAssetContext: false`, `hasFinancingEvidence: false`

Result: fee-family accounts remain in candidate list, no
`OBJECT_ROLE_CONTRADICTION` fires. Winner (when RECOMMEND) is a
fee-family fsGroup. ABSTAIN is also acceptable because it reflects
low canonical score without object contradiction — the point is
proving the Group D rule stayed inactive.

**Test B**: `Phase 3.5 · §5 · financed equipment lease (durable asset + financing evidence) → interest account NOT contradicted`

- Line item: "Fairway mower 24-month lease financing charge" · $620
- `hasHighQualityDurableAssetContext: true`, `hasFinancingEvidence: true` (defeasibility trigger)

Result: fee-family candidates do NOT carry
`durable_asset_object_vs_fee_family_account` contradictions even
though the durable-asset context is present. Defeasibility works.

## §13.8 · Object ambiguity case

Test: `Phase 3.5 · §6 · known equipment object but ambiguous treatment (no defensible nature) → legitimate alternatives survive`

- Line item: "Toro Groundsmaster 3500 replacement component" · $3,200
- `natureLeader: "UNKNOWN"`, `natureIsDefensible: false`, `capitalDecision: "UNRESOLVED"`
- `hasHighQualityDurableAssetContext: true`, `hasFinancingEvidence: false`

Result: fee-family accounts are still contradicted (the durable-asset
substance is genuine), but the ranker does NOT force a specific asset
or R&M winner. When RECOMMEND, winner's fsGroupKey is NOT any of
`IS_INTEREST_EXPENSE`/`IS_BANK_CHARGES`/`IS_MERCHANT_FEES`; ABSTAIN
with candidates preserved is also acceptable — reflects honest
accounting-treatment ambiguity.

Object substance can steer the FAMILY away from fees, but only nature
+ capital can commit to a specific account within the legitimate
family. This will be useful for Phase 4 confidence.

## §13.9 · Correlation / double-counting check

`OBJECT_ROLE_CONTRADICTION` lives in the `CAPITAL_NATURE` family.
Correlated observations on the same account:

- `NATURE_INCOMPATIBLE` (already fires when account type doesn't accept nature)
- `NATURE_GATE_CONTRADICTED` (already fires when gate marked INCOMPATIBLE)
- `CAPITAL_ACCOUNT_CONTRADICTION` (fires on R&M-transaction-vs-ASSET-account)
- `RM_EXPENSE_CONTRADICTION` (fires on CAPITAL-transaction-vs-R&M-account)

MAX-within-family scoring in `rankCanonical` collapses all
CAPITAL_NATURE observations on one account to their strongest single
contribution (positive AND negative are pooled by MAX of absolute).
Existing correlation tests (`§2 · MAX within family / SUM across
families`) validate this and remain GREEN.

The corresponding contradiction records (in
`gl.candidates[i].contradictions`) DO accumulate — they are diagnostic,
not scoring. Downstream code can inspect the full contradiction
inventory without those records affecting the ranker outcome.

## §13.10 · Group C regressions

All Group C tests remain GREEN:

- `durable equipment acquisition · PREFERRED asset gate lock-in → ASSET wins`
- `ordinary equipment repair · gate marks R&M expense PREFERRED → EXPENSE wins, ASSET penalised`
- `borderline capitalization · no gate verdict → legitimate competition`
- `high-value operating expense · amount alone does not force capital classification`
- `department-specific asset outranks generic asset via departmentAccountNamePatterns`
- `vendor historically R&M · current invoice capital → ASSET wins`
- `vendor historically capital · current invoice repair → EXPENSE wins`

Object evidence REFINES the canonical result (contradicting
fee-family accounts on physical-purchase transactions) but does not
undo Group C's substance-based capital reasoning. When both signals
are present (durable-asset + capital-preferred), they combine
through SUM-across-families and MAX-within-family.

## §13.11 · Phase 1 / canonical suite state

- `tests/phase4r-refactor-single-gl-authority.test.ts` — 21/21 GREEN
- `tests/phase4r-canonical-ranker.test.ts` — 42/42 GREEN (38 pre-Phase-3.5 + 4 new §4/§5/§6 Group D tests)

Guard assertion:
```
overrideMatches.length (1) ≤ EXPECTED_MAX_SITES_DURING_REFACTOR (1)  ✓
```

## §13.12 · Broader targeted regression count

18 suites executed after Group D:

- `tests/phase4r-refactor-single-gl-authority.test.ts` — 21
- `tests/phase4r-canonical-ranker.test.ts` — 42
- `tests/ap-intelligence-integration.test.ts` — 6
- `tests/ap-intelligence-source-contract.test.ts` — 26
- `tests/ap-intelligence-parse.test.ts` — 26
- `tests/ap-statement-integration.test.ts` — 30+
- `tests/ap-statement-parse.test.ts` — 30+
- `tests/ap-statement-source-contract.test.ts` — 15+
- `tests/mission-control-analysis-pending-lifecycle.test.ts` — 8+
- `tests/mission-control-founder-confidence.test.ts` — 10+
- `tests/mission-control-modal-confidence.test.ts` — 8+
- `tests/mission-control-projection-confidence-inputs.test.ts` — 4+
- `tests/vendor-intelligence-integration.test.ts` — 4+
- `tests/vendor-intelligence-normalize.test.ts` — 10+
- `tests/phase4-slice5-5-capital-aware-gl.test.ts` — 24
- `tests/phase4-slice5-7a-capital-role-semantics.test.ts` — 17
- `tests/phase4-slice5-3-purchased-object.test.ts` — 20+
- `tests/phase4-slice5-3-purchased-item-authority.test.ts` — 15+

**Total this run: 326 tests · 18 files · all GREEN.**

Pre-existing failures (unchanged from Phase 3.3):

- `tests/mission-control-c14c.test.ts` — 4 mailbox reply / MSAL scope failures. Unrelated to Phase 4R. Preserved for the outstanding integration gate.

## §13.13 · Static guard 2 → 1

Verified via `tests/phase4r-refactor-single-gl-authority.test.ts`
`§ Phase 4R · static architectural guard`:

| Phase | Ceiling | Actual sites |
|-------|---------|--------------|
| Baseline | 10 | 10 |
| After 3.2 (Group A) | 7 | 7 |
| After 3.3 (Group B) | 4 | 4 |
| After 3.4 (Group C) | 2 | 2 |
| **After 3.5 (Group D)** | **1** | **1** |

Remaining site:

- Line 1770 · field-quality gate — recommendation-quality policy (abstention wrapper), Group E target. Cannot select another account when correctly rewritten as a policy.

Semantic search for any new post-canonical object-based promotion:

```
grep -nE "isInterestOrFeeAccount|isFeeAccount|isPurchasedObjectContradictory" src/lib/ap-intelligence/analyse.ts
# (no matches)
grep -n "applyPurchasedObjectCorrection\|applyObjectAuthority" src/lib/ap-intelligence/
# (no matches)
```

The object-authority guard did not migrate into any helper function
that could still replace a winner.

## §13.14 · Typecheck

`npx tsc --noEmit -p tsconfig.json` — clean, zero errors.

## §13.15 · No literals

Anti-overfitting test `§35 · no vendor/invoice/account literals in canonical-ranker.ts` — GREEN.

Group D scoring uses fsGroupKey values (`IS_INTEREST_EXPENSE`,
`IS_BANK_CHARGES`, `IS_MERCHANT_FEES`), which are canonical Spectre
COA taxonomy keys — not account numbers, not account names, not
vendor names, not invoice patterns. Same taxonomy the tenant's
seed and import predictor already assign to accounts.

## §13.16 · Main / staging unchanged

- Branch: `refactor/gl-single-authority` (feature branch)
- `main`: unchanged
- Staging (`spectre-staging`): v206 remains — no deploy performed
- No merge to main

## §13.17 · Full-quality gate still outstanding

Same as Phase 3.3 §15.14b and Phase 3.4 §16.19 — the full-quality
gate remains **outstanding** and MUST run before any merge of
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

Targeted-suite success across Groups A–D is NOT a substitute for
this final gate.

## §13.18 · Any §16 hard-stop condition discovered

None triggered. Specifically:

- §16.1 (another runtime subsystem selecting GL) — no; only the field-quality gate at line 1770 remains, and it is a POLICY (abstention wrapper), not a selector — Group E will make that architectural role explicit
- §16.2 (transaction interpretation structurally inadequate) — no; extending `NormalisedTransactionInterpretation` with two orthogonal boolean fields (`hasHighQualityDurableAssetContext`, `hasFinancingEvidence`) was sufficient
- §16.3 (incompatible scoring semantics) — no; `OBJECT_ROLE_CONTRADICTION` fits MAX-within-family cleanly and combines with existing CAPITAL_NATURE signals without double-count
- §16.4 (another posting classification authority) — no; posting eligibility remains enforced upstream via `filterEligibleAccounts` inside the facade
- §16.5 (weakening accounting correctness) — no; explicit §4/§5/§6 tests lock the equipment-vs-fee contradiction, the two reverse cases (genuine bank charge, financed lease), and object-ambiguity behaviour

Parallel allocation guard (was lines 1872-1912 pre-Group-D, still
present) operates on `gatedAllocations.cardCategory`, not on
`gl.accountNumber`. It uses the same regex pattern for now. Its
migration belongs to Phase 5 (allocation-ranker alignment) per the
Phase 3.5 authorization §7 note ("do not prematurely implement
allocation logic here if it belongs in Phase 5"). Documented here
so Phase 5 doesn't miss it.

Continue to Phase 3.6 (Group E — field-quality abstention as
policy wrapper) without further founder authorization per the
Phase 3.5 authorization end note. Group E is not "eliminate
abstention" — it is "remove abstention's ability to destroy or
replace ranking provenance."

Do not deploy.

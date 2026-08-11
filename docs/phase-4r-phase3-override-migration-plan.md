# Phase 4R · Phase 3 · Override-Site Migration Plan

**Purpose:** enumerate every post-ranking `gl = { ...gl, accountNumber: X }` mutation in [src/lib/ap-intelligence/analyse.ts](../src/lib/ap-intelligence/analyse.ts), group by accounting responsibility per founder §8, and specify the exact migration path for each into pre-ranking inputs of `rankCanonical()`.

**Prerequisite:** Phase 2 exit gate met (`refactor/gl-single-authority` at commit `78e3aa6`). Canonical engine invariant established at the type-contract boundary. Runtime single-authority invariant NOT ESTABLISHED — this document plans the migration that establishes it.

**Rule (founder §8):** for each override group:
1. Identify the accounting fact/policy it contributes.
2. Feed that fact into canonical-ranker input.
3. Add/identify the relevant canonical-ranker test.
4. Remove the downstream account-selection authority.
5. Run the specific historical regression suite.
6. Run the runtime single-authority suite.
7. Confirm the static guard count decreases because the runtime code was actually removed.

**Rule (founder §9):** once `rankCanonical()` returns, `analyse.ts` may enrich / project / explain / validate / reconcile / construct allocations — but MUST NOT recalculate which GL account should have won.

---

## Site inventory (10 total)

Each site rewrites `gl.accountNumber` (and sometimes `gl.candidates`, `gl.source`, `gl.reason`, `gl.confidence`) after the initial `recommendGlAccount` call. Line numbers as of `78e3aa6`.

| # | Line | Reason marker | Accounting responsibility group |
|---|---|---|---|
| 1 | 1446 | `purpose_ontology_promotion` | **A — Purpose / ontology authority** |
| 2 | 1472 | `purpose_ontology_abstain` | **A — Purpose / ontology authority** |
| 3 | 1590 | `purpose_driven_full_coa_search` | **A — Purpose / ontology authority** (Pipeline B — primary defect) |
| 4 | 1824 | `abstained_field_quality` | **E — Abstention policy** |
| 5 | 2006 | `nature_promoted` | **B — Accounting nature authority** |
| 6 | 2149 | `nature_scoped_full_coa_search` | **B — Accounting nature authority** |
| 7 | 2221 | Phase 2 eligibility rejection of promoted leader | **B — Accounting nature authority** (eligibility-driven abstain) |
| 8 | 2342 | `capital-aware nature-compatible search` | **C — Capital-aware ranker** |
| 9 | 2360 | capital-aware abstain | **C — Capital-aware ranker** |
| 10 | 2419 | `Slice 5.3 object-authority guard` | **D — Purchased-object authority** |

---

## Group A · Purpose / ontology authority (sites #1, #2, #3)

### Accounting facts these encode
- **`purpose_ontology_promotion`**: when the invoice's committed purpose has an ontology-named account (e.g. PROFESSIONAL_MEMBERSHIP → "Membership" account), promote that account over the base ranker's top pick.
- **`purpose_ontology_abstain`**: when no purpose-compatible candidate exists in the ranker's top-N, abstain rather than let a purpose-incompatible winner stand.
- **`purpose_driven_full_coa_search`** (Pipeline B): when purpose is committed with HIGH quality, run a separate full-COA scan with purpose-driven scoring; if it finds a strong winner, override.

### Migration into `rankCanonical`
- **Already covered.** `rankCanonical` accepts `NormalisedTransactionInterpretation.purposeConcept` + `purposeConfidence` + `purposeQuality`. Inside `scoreCandidateAgainstTransaction`:
  - `PURPOSE_TYPE_COMPAT` / `PURPOSE_TYPE_MISMATCH` observations
  - `PURPOSE_CATEGORY_HINT` observation
  - `ONTOLOGY_NAME_MATCH` observation (`evaluatePurposeAccountAffinity`)
  - `ECONOMIC_PURPOSE` evidence from query concepts
- All three overrides collapse into ONE competition: the account whose combined transaction-text signals (including purpose + ontology) score highest wins at `candidates[0]`. The "override" logic becomes just "compete and rank once."
- Abstention (site #2) becomes structural: if the winner's score < `COMMIT_MIN_SCORE`, `rankCanonical` returns `ABSTAIN` with the winner still populated. No `gl = { ...gl, accountNumber: null }` needed.

### Migration steps
1. Delete lines 1446-1458 (`purpose_ontology_promotion` block).
2. Delete lines 1472-1490 (`purpose_ontology_abstain` block).
3. Delete lines 1580-1604 (`purpose_driven_full_coa_search` — the `rankPurposeDrivenAccounts` call + override).
4. Confirm that the initial `recommendGlAccount` call at line 1076 has been REPLACED with a call to `rankCanonical()` at the same call site. That's the fundamental switch — one canonical ranker, one candidate set, one winner.
5. Run canonical-ranker suite: existing tests already cover PROFESSIONAL_MEMBERSHIP, SOFTWARE_SUBSCRIPTION, REPAIR_MAINTENANCE, TELECOMMUNICATIONS purposes. Verify all pass.
6. Run Phase 1 single-authority suite. The `utility` scenario should flip from RED (WINNER_REPLACED_AFTER_RANKING) to PASS.
7. Static guard count: **10 → 7**.

### Fixtures this affects
- Club Support 221178 (winner selection was via site #3)
- CPA Alberta multi-allocation (each allocation went through the per-cluster ranker; site #3 doesn't fire per-allocation but the analysis-level winner did)
- Utility scenario in Phase 1 test suite

---

## Group B · Accounting nature authority (sites #5, #6, #7)

### Accounting facts these encode
- **`nature_promoted`** (Stage A): when the accounting-nature classifier commits (e.g. UTILITY_OR_RECURRING_SERVICE), promote the best nature-compat candidate from the initial ranker's candidate set.
- **`nature_scoped_full_coa_search`** (Stage B): when Stage A can't find a compatible candidate in top-N, do a full-COA scan under nature scope.
- **Site #7**: when the eligibility filter rejects the promoted leader post-hoc, clear the winner and abstain.

### Migration into `rankCanonical`
- **Already covered.** `NormalisedTransactionInterpretation.natureLeader` + `natureConfidence` + `natureIsDefensible` feed the CAPITAL_NATURE family scoring:
  - `NATURE_COMPAT` observation when account type matches
  - `NATURE_INCOMPATIBLE` observation + explicit contradiction when defensible + mismatch
- Full-COA search is no longer a separate stage — `rankCanonical` always ranks the ENTIRE eligible COA. No "top-N first, then full-COA search on fallback" — one pool, one competition.
- Eligibility rejection is now a HARD gate BEFORE the ranker (§6): if an account is Phase-2 ineligible, it never enters `eligibleAccounts`. `rankCanonical` cannot pick an ineligible account by construction.

### Migration steps
1. Delete lines 1980-2020 (Stage A `nature_promoted` block).
2. Delete lines 2130-2170 (Stage B `nature_scoped_full_coa_search` block).
3. Delete lines 2200-2240 (Phase 2 eligibility rejection block) — replaced by the caller's `filterEligibleAccounts` call feeding `rankCanonical.eligibleAccounts`.
4. Confirm `rankCanonical` receives the pre-filtered eligible set + the committed nature/capital signals.
5. Run canonical-ranker suite + slice suites. Fixtures: OXIO (telecom nature), Oakcreek 1087769 (R&M nature), Oakcreek 1091559 (capital nature — still ambiguous per prior Phase 4R work).
6. Static guard count: **7 → 4**.

---

## Group C · Capital-aware ranker (sites #8, #9)

### Accounting facts these encode
- **Site #8** (`capital-aware nature-compatible search`): when the capital-vs-operating classifier + accounting-nature classifier BOTH commit, the capital-aware ranker picks the best account respecting both.
- **Site #9** (capital-aware abstain): when the pool exists but no defensible winner, abstain.

### Migration into `rankCanonical`
- **Already covered.** `NormalisedTransactionInterpretation.capitalDecision` + `capitalConfidence` feed the CAPITAL_NATURE family:
  - `CAPITAL_ASSET_MATCH` (+20) when CAPITAL_CANDIDATE + ASSET type
  - `CAPITAL_ASSET_CATEGORY_BONUS` (+6) when categoryKey includes CAPITAL/FIXED
  - `RM_EXPENSE_MATCH` (+20) when REPAIR_MAINTENANCE + R&M expense name
  - `CAPITAL_ACCOUNT_CONTRADICTION` (–25) when REPAIR_MAINTENANCE + ASSET
  - `RM_EXPENSE_CONTRADICTION` (–12) when CAPITAL_CANDIDATE + R&M expense
- The abstention decision becomes structural via the RECOMMEND/ABSTAIN split.

### Migration steps
1. Delete lines 2330-2380 (both capital-aware blocks).
2. Verify `capitalDecision` + `capitalConfidence` are already threaded into the `NormalisedTransactionInterpretation` produced upstream of `rankCanonical`.
3. Run canonical-ranker + capital-focused tests.
4. Static guard count: **4 → 2**.

### Related work
- Prior Phase 4R FINAL slice (v202) added a resolved-authority commit branch to `evaluateCapitalObjectEvidence` for COMPLETE_MACHINE + resolved-primary. That fires BEFORE `rankCanonical` (it determines the `capitalDecision` value). Preserved.

---

## Group D · Purchased-object authority (site #10)

### Accounting facts this encodes
- **Site #10** (`Slice 5.3 object-authority guard`): when purchased-object evidence identifies a durable-asset context (COMPLETE_MACHINE or explicit equipment model), CLEAR any drafted GL that routes to an interest/fee account.

### Migration into `rankCanonical`
- **New signal needed.** Add `NormalisedTransactionInterpretation.purchasedObjectEvidence` — a small enum/tag surfaced from the object classifier: `{ hasCompleteMachine: boolean; hasEquipmentModel: boolean; interestOrFeeIncompatible: boolean }`.
- Inside `rankCanonical`, use `interestOrFeeIncompatible` to emit a strong contradiction observation (e.g. `-30`) against `IS_INTEREST_EXPENSE` / `IS_BANK_CHARGES` fs-group accounts. The account is not filtered out (soft contradiction §6), but its score drops materially so it cannot win.

### Migration steps
1. Add `purchasedObjectEvidence` field to `NormalisedTransactionInterpretation` type.
2. Emit `PURCHASED_OBJECT_CONTRADICTION` observations in `scoreCandidateAgainstTransaction` when interestOrFeeIncompatible + account is interest/bank-charges.
3. Add canonical-ranker test: durable-asset transaction with candidate 6053 Interest Expense scores strongly negative → does not win.
4. Delete lines 2410-2430.
5. Static guard count: **2 → 1**.

---

## Group E · Field-quality abstention (site #4)

### Accounting facts this encodes
- **Site #4** (`abstained_field_quality`): when the extraction's field-quality gate reports abstention reasons (unreconciled totals, ambiguous vendor, etc.), null the winner.

### Migration into `rankCanonical` — POLICY, not selection
- Founder §6 + §9: abstention is a separate policy decision from selection. The canonical ranker owns SELECTION. The field-quality gate owns a POLICY layer that may say "even though the ranker committed, don't recommend posting yet."
- **This is NOT a `rankCanonical` change.** Instead, `analyse.ts` should:
  1. Call `rankCanonical` → get the committed winner + candidates.
  2. Consult the field-quality gate.
  3. If gate says abstain, wrap the result: keep `analysis.gl.candidates` populated (still the canonical competition), but expose `analysis.gl.recommendationStatus === "ABSTAIN"` with the field-quality reason.
- **The invariant STILL holds**: `analysis.gl.accountNumber === analysis.gl.candidates[0].accountNumber`. The projection can render "review required" via `recommendationStatus`, but the winner and competition remain traceable.

### Migration steps
1. Convert site #4 from a `gl = { ...gl, accountNumber: null }` mutation to a POLICY WRAPPER: `if (fieldQualityGate.abstain) { analysis.gl.recommendationStatus = "ABSTAIN"; analysis.gl.abstentionReason = fieldQualityGate.reasons }`.
2. `gl.accountNumber` remains as `candidates[0].accountNumber`. Downstream (projection) reads `recommendationStatus` to decide whether to render the recommendation as final or as "review required".
3. Add contract test: field-quality abstain does not blank the winner or candidates.
4. Static guard count: **1 → 0**.

---

## Overall Phase 3 sequencing

**Phase 3.2** — Group A (sites #1, #2, #3): highest impact. Removes the Pipeline B override that was the primary defect the Phase 1 suite identified. Static guard: 10 → 7.

**Phase 3.3** — Group B (sites #5, #6, #7): next largest. Nature-scoped ranker. Static guard: 7 → 4.

**Phase 3.4** — Group C (sites #8, #9): capital-aware. Static guard: 4 → 2.

**Phase 3.5** — Group D (site #10): purchased-object authority. Requires new `NormalisedTransactionInterpretation` field. Static guard: 2 → 1.

**Phase 3.6** — Group E (site #4): field-quality abstention. Convert from selection override to policy wrapper. Static guard: 1 → 0.

**Phase 3 exit gate**:
- Static architectural guard reports 0 override sites.
- Phase 1 single-authority invariant suite: all failures GREEN.
- `analyse.ts` calls `rankCanonical()` exactly once per document (per allocation for Multiple invoices — Phase 5 wiring).
- Legacy `recommendGlAccount()` and `rankAccountsPure()` become UNUSED runtime — kept as compat wrappers deprecated for external consumers OR deleted.
- Runtime single-authority invariant ESTABLISHED. Distinct from the canonical engine invariant (already established at Phase 2).

## Between-phase discipline
- No deployment during Phases 3.2-3.6. Main + staging remain v206.
- Each phase's commit runs the FULL regression: canonical-ranker suite + Phase 1 suite + affected legacy suites + `ap-intelligence-integration`.
- Any Group's migration that fails a regression halts that group's work; investigate whether the fixture encoded (A) an accounting invariant we must preserve, (B) an obsolete detail, or (C) a dual-authority artefact to remove per §12.

## Not started this session
Phase 3.2 code migration deferred to the next session due to session-boundary discipline. The audit above is complete and gives the next session a per-line plan.

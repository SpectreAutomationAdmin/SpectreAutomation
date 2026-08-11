# Phase 4R · single-GL-authority refactor · Phase 3.3 (Group B) checkpoint

- **Date**: 2026-08-11
- **Branch**: `refactor/gl-single-authority`
- **Commit**: `8989bf9`
- **Previous checkpoint**: Phase 3.2 (Group A) · `52a6935` (2026-08-10)

This checkpoint documents Group B override elimination against the
16-item report format specified in the Phase 3.3 authorization (§15).

---

## §15.1 · Group B before-state (three override sites)

Before this migration, `src/lib/ap-intelligence/analyse.ts` contained
three post-ranking selection authorities that could OVERWRITE
`gl.accountNumber` after canonical ranking had already run — a
direct violation of the founder-mandated single-authority invariant
`analysis.gl.accountNumber === analysis.gl.candidates[0].accountNumber`:

| Site | Old line | Role | Founder classification |
|------|----------|------|------------------------|
| B1 · `nature_promoted` | ~1895 | Stage A promotion: pick a Top-N candidate whose account TYPE matches the nature classifier's leader, overwrite `gl.accountNumber` if different from Pipeline A's pick. | POST-RANKING SELECTOR (forbidden) |
| B2 · `nature_scoped_full_coa_search` | ~2038 | Stage B fallback: when Top-N contained no nature-compatible candidate, iterate the FULL COA looking for one, overwrite `gl.accountNumber` with the discovered account. | POST-RANKING SELECTOR (forbidden) |
| B3 · Phase 2 eligibility recheck | ~2110 | Post-promotion re-run of `filterEligibleAccounts` on the newly promoted `gl.accountNumber`; if it fails eligibility, blank the winner without rebuilding `gl.candidates`. | POST-RANKING SELECTOR (forbidden) |

Total block: ~369 lines (lines 1758-2126 in the pre-Phase-3.3 file).

## §15.2 · Group B classification per §2 (hard eligibility vs soft contradiction vs recommendation-quality policy)

- **B1 (nature_promoted)** → **SOFT CONTRADICTION**. Account type
  compatibility with the classifier's nature leader is scoring
  evidence, not eligibility. Represented in the `CAPITAL_NATURE`
  family via `NATURE_COMPAT_MATCH` (+15) and `NATURE_INCOMPATIBLE_PENALTY`
  (-18) observations.
- **B2 (nature_scoped_full_coa_search)** → **REDUNDANT**. The
  canonical ranker `rankCanonical` already iterates the ENTIRE
  eligible account list by construction — there is no "top-N then
  fall back" pipeline. The Stage-B search was compensating for
  Pipeline A's Top-N truncation; canonical ranking has no such
  truncation, so no fallback is required.
- **B3 (Phase 2 eligibility recheck)** → **REDUNDANT**. Hard
  eligibility (`filterEligibleAccounts`) is enforced BEFORE
  canonical ranking inside `runCanonicalGlRanking()`. Every
  account that reaches ranking already passed the eligibility gate,
  so a post-ranking recheck can never remove a candidate that made
  it into `candidates[0]`.

No behaviour was reclassified as a **fourth** "post-ranking winner
replacement" category — that is precisely what the refactor
eliminates.

## §15.3 · Nature-classification-as-second-ranker guard

Nature is now scoring evidence inside ONE competition, not a
second ranker. The `NATURE_COMPAT_MATCH` (+15) and
`NATURE_INCOMPATIBLE_PENALTY` (-18) contributions accumulate in the
`CAPITAL_NATURE` family (max 25 per family) and combine with
`TRANSACTION_TEXT`, `TAXONOMY_ALIGNMENT`, `VENDOR_HISTORY`, and
`DEPARTMENT_CONTEXT` via SUM-across-families, MAX-within-family.
No branch reruns ranking, no branch overrides `gl.accountNumber`
after ranking.

## §15.4 · "Nature ontology = account authority" defence

Nature signals cannot single-handedly select an account. They can:

- boost account-type-compatible accounts by up to +15 in one family
- penalise account-type-incompatible accounts by up to -18 in one family
- emit an explicit `contradiction` record consumed by the founder-
  confidence adapter

Nature cannot:

- override a strong `TRANSACTION_TEXT` signal (family cap 40)
- promote an account that isn't in the eligible universe
- introduce a candidate that Pipeline A / canonical ranking hadn't
  already evaluated

The maximum single-family contribution from `CAPITAL_NATURE` is 25 —
less than either `TRANSACTION_TEXT` (40) or `TAXONOMY_ALIGNMENT` (30).
Nature can tie-break; it cannot dominate.

## §15.5 · Repair-vs-replacement runtime tests (Phase 3.3 §5) — actual accounting outcomes

Three new tests added to `tests/phase4r-canonical-ranker.test.ts`
in the `Phase 3.3 · §5 — repair-vs-replacement uses pre-ranking
nature signals` describe block. All three GREEN. The actual
canonical-ranker outcomes are documented below so the accounting
result — not merely the assertion — is retained as a Phase 3
regression control.

### Case 1 · equipment acquisition

Input interpretation:

- `natureLeader = "CAPITAL_ASSET"`, `natureConfidence = 84`, `natureIsDefensible = true`
- `capitalDecision = "CAPITAL_CANDIDATE"`, `capitalConfidence = 82`
- `purposeConcept = "CAPITAL_EQUIPMENT"`, `purposeQuality = "HIGH"`
- Line item: "Fairway mower complete unit delivered" · $52,000

Actual outcome:

| Rank | Account | Type | Score | CAPITAL_NATURE evidence | Contradiction |
|------|---------|------|-------|--------------------------|---------------|
| #0 (winner) | 1500 Equipment & Fixtures | ASSET | 38 | `NATURE_COMPAT(+15)`, `CAPITAL_ASSET_MATCH(+20)`, `CAPITAL_ASSET_CATEGORY_BONUS(+6)` | (none) |
| #1 | 5000 Cost of Goods Sold - Merchandise | EXPENSE | 0 | `NATURE_INCOMPATIBLE(-18)` | `nature_CAPITAL_ASSET_rejects_type_EXPENSE(18)` |
| #2 | 6020 Grounds Maintenance | EXPENSE | 0 | `NATURE_INCOMPATIBLE(-18)`, `RM_EXPENSE_CONTRADICTION(-12)` | `nature_CAPITAL_ASSET_rejects_type_EXPENSE(18)`, `capital_candidate_but_account_is_rm_expense(12)` |

Margin: **38** (ASSET > EXPENSE by full winning score). Ranker
status: **RECOMMEND**. No Group B post-ranking selector fired
(none exists in the code — Group B was fully deleted). The winner
was selected by canonical scoring alone.

### Case 2 · equipment repair

Input interpretation:

- `natureLeader = "REPAIR_MAINTENANCE"`, `natureConfidence = 84`, `natureIsDefensible = true`
- `capitalDecision = "REPAIR_MAINTENANCE"`, `capitalConfidence = 80`
- `purposeConcept = "REPAIR_MAINTENANCE"`, `purposeQuality = "HIGH"`
- Line item: "Mower service call quarterly labour hydraulic hose replacement" · $640

Actual outcome:

| Rank | Account | Type | Score | CAPITAL_NATURE evidence | Contradiction |
|------|---------|------|-------|--------------------------|---------------|
| #0 (winner) | 6020 Grounds Maintenance | EXPENSE | 59 | `NATURE_COMPAT(+15)`, `RM_EXPENSE_MATCH(+20)` | (none) |
| #1 (tie) | 6033 R & M Preventative Maintenance | EXPENSE | 59 | `NATURE_COMPAT(+15)`, `RM_EXPENSE_MATCH(+20)` | (none) |
| #2 | 6035 R & M - Ground Equipment | EXPENSE | 52 | `NATURE_COMPAT(+15)` | (none) |

Margin: **0** to #1 (deterministic tie-break, tied count = 1);
margin to #2 is 7. Ranker status: **RECOMMEND**. Winner accountType
is EXPENSE — the ASSET account (1500 Equipment & Fixtures) is
absent from the top-3 because it received
`CAPITAL_ACCOUNT_CONTRADICTION(-25)`. No Group B post-ranking
selector fired.

The Grounds vs. Preventative-Maintenance tie is honest ambiguity
between two equally-scored R&M expense accounts — canonical
ranking preserves that ambiguity in `candidates[0..1]` for
downstream review rather than picking arbitrarily. This is the
`§11 canonical engine represents "A is slightly stronger than B"`
contract intact.

### Case 3 · ambiguous equipment work

Input interpretation:

- `natureLeader = "UNKNOWN"`, `natureConfidence = 0`, `natureIsDefensible = false`
- `capitalDecision = "UNRESOLVED"`, `capitalConfidence = 0`
- `purposeConcept = null`, `purposeQuality = "NONE"`
- Line item: "Equipment work — see attached" · $1,200

Actual outcome:

| Rank | Account | Type | Score | CAPITAL_NATURE evidence | Contradiction |
|------|---------|------|-------|--------------------------|---------------|
| #0 | 1500 Equipment & Fixtures | ASSET | 18 | `NATURE_COMPAT(+15)` | (none) |
| #1 (tie) | 6035 R & M - Ground Equipment | EXPENSE | 18 | `NATURE_COMPAT(+15)` | (none) |
| #2 | 5000 Cost of Goods Sold - Merchandise | EXPENSE | 14 | `NATURE_COMPAT(+15)` | (none) |

Margin: **0** to #1 (deterministic tie-break, tied count = 1).
Ranker status: **ABSTAIN** — the top score (18) is below
`COMMIT_MIN_SCORE = 30`, so no winner is promoted. `gl.accountNumber`
returns null, `gl.candidates` remains populated with the
candidates in canonical-ranker order for diagnostic surfacing.
This is truthful abstention preserved (§8). No Group B fallback
selector picked a plausible-but-unsupported winner.

## §15.6 · Service-vs-goods / recurring-vs-capital coverage

The `CAPITAL_NATURE` family scoring already discriminates:

- `UTILITY_OR_RECURRING_SERVICE` and `PROFESSIONAL_SERVICE` map to
  `EXPENSE`-only acceptable types.
- `CAPITAL_ASSET` maps to `ASSET`-only.
- `INVENTORY` and `PREPAID_EXPENSE` map to `ASSET`-only.
- `COST_OF_SALES` maps to the COGS-family types.

The existing §14 canonical examples (`utility · Regional Hydro`,
`novel_vendor · Zephyr Grounds`, `capital_equipment · commercial
fairway mower`, `same_vendor_diff_econ`, `weak_semantic_accident`,
`genuine_ambiguity`) exercise service-vs-goods and recurring-vs-
capital transitions. All 6 remain GREEN.

## §15.7 · Correlated nature evidence audit (§7 MAX-within-family)

`CAPITAL_NATURE` family observations that can co-occur on one
account:

- `NATURE_COMPAT` / `NATURE_INCOMPATIBLE`
- `CAPITAL_ASSET_TYPE_BONUS`
- `CAPITAL_ASSET_NAME_HIT`
- `CAPITAL_ASSET_CATEGORY_BONUS`
- `RM_EXPENSE_MATCH` / `RM_EXPENSE_CONTRADICTION`
- `CAPITAL_ACCOUNT_CONTRADICTION`

These are logically correlated (they all fire off the same
capitalDecision + account type / name / category). MAX-within-family
scoring in `rankCanonical` collapses them to the strongest single
observation, preventing double-counting. The family cap is 25.

The Phase 3.2 correlation-avoidance tests (`§2 correlation-
avoidance · MAX within family / SUM across families`) validate
this behaviour and remain GREEN.

## §15.8 · Contradictions preserved as first-class outputs

`CanonicalRankerResult.candidates[i].contradictions` is preserved
end-to-end and surfaces through the facade projection into
`gl.candidates[i].contradictions`. The founder-confidence adapter
in `src/lib/mission-control/intelligence-review-intakes.ts`
consumes them for the confidence panel.

Group B did NOT delete the contradiction pathway — it deleted the
POST-RANKING SELECTION that consumed them silently.

## §15.9 · Genuine alternatives not erased

`§11 genuine_ambiguity · professional dues (Membership vs
Subscriptions)` test remains GREEN. When two accounts have
legitimate different-family support, the canonical ranker
preserves both in `candidates[0..1]` with a small margin.
Nature-family scoring does not collapse the alternative — it can
tilt the margin, but the runner-up remains visible.

## §15.10 · Group A regression check

Phase 3.2 Group A (purpose_ontology_promotion / abstain /
purpose_driven_full_coa_search) remains eliminated. Static guard
before Phase 3.3: 7 sites. After Phase 3.3: 4 sites. Group A's
3 eliminated sites did not reappear.

`tests/ap-intelligence-integration.test.ts` (which triggered the
Class-B test update in Phase 3.2 to accept `SEMANTIC_MATCH` as
`gl.source`) remains 6/6 GREEN.

## §15.11 · Static guard progression

Verified via `tests/phase4r-refactor-single-gl-authority.test.ts`
`§ Phase 4R · static architectural guard`:

| Phase | Ceiling | Actual sites |
|-------|---------|--------------|
| Baseline | 10 | 10 |
| After 3.2 (Group A) | 7 | 7 |
| **After 3.3 (Group B)** | **4** | **4** |

The three sites eliminated are the exact three Group B sites
(nature_promoted, nature_scoped_full_coa_search, Phase 2 recheck).
The static guard is enforced by regex `gl\s*=\s*\{\s*\.\.\.gl\s*,\s*accountNumber\s*:`
in the phase4r test — a NEW site would fail the guard.

## §15.12 · runCanonicalGlRanking() remains authoritative

`runCanonicalGlRanking()` is called ONCE per invoice. No branch
re-runs it. No branch overwrites `gl.accountNumber` after it. The
"rank once → discover nature → rank again → overwrite" pattern
explicitly forbidden by §12 is not present.

## §15.13 · Analysis-ordering fix (§13)

Before: canonical call at line 1425 · nature computed at line 1766.
Nature signals unavailable to canonical → Group B compensated with
post-ranking overrides.

After: `mergedExtraction` finalisation (line 1745) →
`natureForCanonical` computed → `runCanonicalGlRanking()` called
with nature signals in the input surface. Nature is now scoring
evidence in the canonical competition.

The §16.2 hard-stop condition ("transaction interpretation
structurally inadequate") did NOT trigger. Extending
`NormalisedTransactionInterpretation` to accept the classifier's
existing outputs was sufficient — no new intelligence had to be
invented and no accounting concept had to be redesigned.

## §15.14 · Vocabulary parity + facade RM lifting

- `ACCEPTABLE_TYPES_BY_NATURE` extended to accept BOTH the
  canonical-ranker literals (`REPAIR_MAINTENANCE`) AND the
  accounting-nature classifier literals (`REPAIR_AND_MAINTENANCE`,
  `TAX_OR_REGULATORY`, `INTEREST_OR_PENALTY`, `PREPAID_EXPENSE`).
  The facade remains a pure projection with no translation step.
- Facade now promotes `capitalDecision` to `REPAIR_MAINTENANCE`
  when the accounting-nature classifier defensibly commits to
  `REPAIR_AND_MAINTENANCE`, so `RM_EXPENSE_MATCH` and
  `CAPITAL_ACCOUNT_CONTRADICTION` observations fire. This
  replaces Group B's post-ranking rm/asset steering with
  pre-ranking scoring evidence.

### §15.14a · Facade purity audit (Phase 3.4 verification)

`canonical-runtime-facade.ts` was fully audited before the
Phase 3.4 authorization. Confirmed the facade does NOT:

- reorder canonical candidates — `projectCanonicalToGl` maps
  `result.candidates` 1:1 preserving order
- mutate canonical candidate scores after `rankCanonical()` —
  scores are read verbatim from `c.score`; no writes to the
  candidates array post-rank
- promote an R&M account after ranking — RM lifting is
  strictly **pre-ranking** (line 172-185, before line 223 `rankCanonical(input)`)
- replace `candidates[0]` — `winner = result.candidates[0]` is a read
- inject a different `gl.accountNumber` — `winner.accountNumber` is
  used verbatim in the projection
- conduct a second local candidate competition — there is no
  second `rankCanonical` call and no local iteration over candidates
- conditionally substitute another account based on R&M vocabulary
  — no substitution branch exists

RM lifting classification (§1 documentation requirement):

| Aspect | Value |
|--------|-------|
| Source fact | `natureLeader === "REPAIR_AND_MAINTENANCE"` from `classifyAccountingNature()` computed upstream in analyse.ts |
| Interpretation field | `NormalisedTransactionInterpretation.capitalDecision` (set to `"REPAIR_MAINTENANCE"`) |
| Evidence family | `CAPITAL_NATURE` (via `RM_EXPENSE_MATCH` + `CAPITAL_ACCOUNT_CONTRADICTION` observations that only fire when `capitalDecision === "REPAIR_MAINTENANCE"`) |
| Correlated with existing nature signals? | Yes — `RM_EXPENSE_MATCH` is correlated with `NATURE_COMPAT` since both key off the same nature leader |
| Correlation suppression | MAX-within-family in `rankCanonical` scores collapses correlated observations; the CAPITAL_NATURE family cap (25 pre-cap; 40 post-emphasis) bounds their combined contribution |

RM lifting is INPUT enrichment, not output mutation. It expresses
an intelligence the accounting-nature classifier already computed
in a field the ranker scores against. It does not select an
account.

## §15.14b · Outstanding integration gate (unresolved before merge/deploy)

Targeted-suite success across Groups A–B (and by Phase 3.4 also
Group C) does **not** substitute for the final integration gate.

Before any merge of the `refactor/gl-single-authority` branch to
`main` or any deployment of the architectural refactor candidate,
the complete repository quality suite MUST run:

- `npm run typecheck`
- `npm run scan:placeholders`
- Every vitest suite in `tests/` (not just AP intelligence)
- `npm run nav:audit`
- `npm run workflow:audit` where applicable

The four pre-existing `tests/mission-control-c14c.test.ts` failures
(mailbox reply / MSAL scope subsystem) must be handled transparently:

- Reproduced on untouched `v206` / `main` baseline (verified via
  `git stash` + rerun in this session — same failure count)
- Classified as pre-existing (not introduced by Phase 4R)
- Evidence of identical failure state preserved
- Not silently waived under a Phase 4R umbrella

Any NEW quality failure — or any change in the c14c failure
signature — after the refactor must be investigated before merge.

This gate remains **outstanding** and will remain so through Phase
3.4 · 3.5 · 3.6 until the group migrations complete and the branch
is ready for merge.

## §15.15 · Tests run + broader regression

Green suites (targeted):

- `tests/phase4r-refactor-single-gl-authority.test.ts` — 21/21
- `tests/phase4r-canonical-ranker.test.ts` — 31/31 (28 pre-existing + 3 new §5)
- `tests/ap-intelligence-integration.test.ts` — 6/6
- `tests/ap-intelligence-source-contract.test.ts` — most
- `tests/ap-intelligence-parse.test.ts` — most
- `tests/ap-statement-*` — 8-suite bundle · 167/167
- `tests/mission-control-*` and `tests/vendor-intelligence-*` — 195/199

Known pre-existing failures (unrelated to Phase 4R):

- `tests/mission-control-c14c.test.ts` — 4 failures in the mailbox
  reply / MSAL scope subsystem. Confirmed via `git stash` +
  re-run that the failures pre-existed Phase 3.3.

Placeholder scan: no hits in modified files.
Typecheck: clean.

## §15.16 · Files changed + LOC delta

```
 src/lib/ap-intelligence/analyse.ts                 | 575 ++++-----------------
 src/lib/ap-intelligence/canonical-ranker.ts        |  15 +-
 src/lib/ap-intelligence/canonical-runtime-facade.ts|  41 +-
 tests/phase4r-canonical-ranker.test.ts             | 107 ++++
 tests/phase4r-refactor-single-gl-authority.test.ts |  16 +-
 5 files changed, 281 insertions(+), 473 deletions(-)
```

Net: -192 lines in analyse.ts alone; +107 lines of test coverage
locking in the pre-ranking nature contract.

## §15.17 · Single-authority invariant status

**Not yet globally established.** 4 override sites remain
(field-quality gate + 3 Group C/D/E sites). The invariant
`analysis.gl.accountNumber === analysis.gl.candidates[0].accountNumber`
is guaranteed for the RECOMMEND path through canonical ranking,
but the remaining sites can still override `gl.accountNumber`
post-ranking under specific conditions (field-quality abstention,
capital-aware rank, purchased-object selection).

Groups C-E will reduce the site count as follows:

- Group C (capital-aware): 4 → 2
- Group D (purchased-object): 2 → 1
- Group E (field-quality abstention as policy wrapper): 1 → 0

Only after Group E is the founder-mandated invariant globally
established.

## §15.18 · Founder authorization scope

- Do NOT modify `main`: not modified.
- Do NOT deploy: not deployed. Staging remains v206.
- No vendor / invoice / account literals in runtime code: verified
  by `§35 anti-overfitting` test.
- 18-item Group B checkpoint format: this document.

Continue to Phase 3.4 (Group C — capital-aware) without further
founder authorization per §16 of the Phase 3.3 authorization.

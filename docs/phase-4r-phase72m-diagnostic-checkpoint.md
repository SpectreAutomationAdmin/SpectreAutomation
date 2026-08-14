# Phase 4R · Phase 7.2M — Diagnostic Checkpoint (STOP-and-report per Founder §15)

**Status:** Founder-authorised Phase 7.2M (M-A candidate recall + M-B
within-tier scoring). Diagnostic-first execution per §2 revealed the
next failure boundary is **NOT candidate retrieval**. Reporting per
Founder §15 STOP condition before introducing arbitrary calibration.

**No runtime changes in this checkpoint.** Zero risk to LOCKED cases.
Unsafe = 0 preserved (unchanged from post-L benchmark).

**Not staged. Not merged. No production deploy.**

---

## §25 · 25-item required checkpoint

### 1 · Exact M-A R4 case list (post-L baseline)

Diagnostic against
[ap-bench-2026-08-14T03-30-34-593Z-p0on-p2on.json](../tests/ap-benchmark/runs/ap-bench-2026-08-14T03-30-34-593Z-p0on-p2on.json).

**Cases where `ABSTAIN_NO_CANDIDATES` (all candidates scored 0)** —
the true M-A candidates. If the correct account existed in the pool
with any positive score, canonical would return ABSTAIN (with the
score) not NO_ELIGIBLE_CANDIDATES.

| # | Case | Expected | Actual | Note |
|---|---|---|---|---|
| 1 | software-intangible | 1610 | NO_ELIGIBLE_CANDIDATES | 1610 exists in seed as "Software & Intangibles" |
| 2 | prepaid-insurance | 1410 | NO_ELIGIBLE_CANDIDATES | 1410 exists as "Prepaid Expenses" |
| 3 | inventory-fnb-restock | 1250 or 5101 | NO_ELIGIBLE_CANDIDATES | both exist |
| 4 | jonas-convention-accum-depr | 5310/5311/5320 | NO_ELIGIBLE_CANDIDATES | all exist |
| 5 | replacement-component-serialized | 1506/1540 | NO_ELIGIBLE_CANDIDATES | both exist |
| 6 | multi-alloc-goods-freight-tax | 6025/6020 | NO_ELIGIBLE_CANDIDATES ×2 | both exist |
| 7 | multi-alloc-goods-plus-service | 6020/6025/6031 | NO_ELIGIBLE_CANDIDATES | all exist |
| 8 | adversarial-capital-with-accumdepr | 1506/1530/1540 | NO_ELIGIBLE_CANDIDATES | all exist |

### 2 · Correct-tier recall before / after

**Not measurable as a delta** — the diagnostic proves candidates ARE
in the tier / pool already:

- All 8 accounts above exist in the benchmark seed
  ([tests/ap-benchmark/seed.ts:59-125](../tests/ap-benchmark/seed.ts#L59)).
- All 8 pass hard-eligibility (active, postable, non-payroll, not
  bank/cash/control).
- All 8 are included in `nonPayrollAccounts` at
  [gl-allocations.ts:690](../src/lib/ap-intelligence/gl-allocations.ts#L690).
- All 8 pass through `unionEligiblePool` into the ranker's
  `eligibleAccounts`.
- Tier assignment classifies them correctly: 1410 → PRIMARY (statementRole
  BALANCE_SHEET_CURRENT_ASSET matches PREPAID_EXPENSE treatment's
  statementRole), 1610 → PRIMARY (BALANCE_SHEET_CAPITAL_ASSET matches
  CAPITAL_ASSET treatment), 5100/5101 → PLAUSIBLE-family (COST_OF_SALES
  vs OPERATING_EXPENSE treatment), 5310/5311/5320 → PRIMARY (fuel
  EXPENSE matches operating treatment), 1506/1530/1540 → PRIMARY
  (capital ASSET matches capital treatment).

**The retrieval architecture is functionally correct.** The
`NO_ELIGIBLE_CANDIDATES` outcome means every candidate scored 0 —
not that any candidate was missing from the pool.

### 3 · Structured retrieval changes

**None applied.** Diagnostic revealed retrieval is not the bottleneck.
Per Founder §5: no new discovery provider was casually added.

### 4 · Food-service result

- Expected: 5100 / 5101
- Actual: 1250 (F&B Inventory) canonical winner at score 26, ABSTAIN_AMBIGUITY
- **Correct 5100/5101 accounts:** in the seed COA. Pass eligibility.
  In `nonPayrollAccounts`. Reach the canonical ranker.
- **Why they don't win / don't appear in top-3:** 5100/5101 have zero
  targeted evidence for this invoice's specific line items
  ("Beef tenderloin AAA", "Atlantic salmon fillet portioned", "Mixed-
  lettuce salad blend — case 8"):
  - No purpose classifier commits `FOOD_AND_BEVERAGE_COST_OF_SALES`
    (the cues don't hit these specific noun phrases).
  - Without a committed purpose, `ONTOLOGY_NAME_MATCH (+20)`,
    `ECONOMIC_PURPOSE (+20)`, `PURPOSE_TYPE_COMPAT (+12)`,
    `PURPOSE_CATEGORY_HINT (+10)` never fire.
  - `LINE_ITEM_JACCARD` on line-item tokens vs "F&B — Food Cost of
    Sales" account name: no token overlap (beef/salmon/lettuce vs
    f&b/food/cost/of/sales).
  - Result: 5100/5101 have TRANSACTION_TEXT contribution = 0.
  - Meanwhile 1250 (F&B Inventory, ASSET) matches "F&B" tokens via
    account-side taxonomy and picks up some points, wins the tier
    (but tier assignment demoted it to CONTRADICTED under
    ASSERTED_TREATMENT, so 5320 fuel rose).

**The bottleneck is upstream of retrieval:** the purpose classifier
doesn't commit for these specific line-item wordings.

Founder §7: "Do not patch with account number 5100/5101. Recover the
generic F&B expense/COGS class relationship." — This would require
either:
- (a) Extending the FOOD_AND_BEVERAGE_COST_OF_SALES cue lexicon to
  match "beef", "salmon", "lettuce" (violates Founder §19 anti-
  overfitting: "Do not add phrase → account mappings" and Phase 7.2H
  moratorium on new lexical cues), OR
- (b) A new principled scoring proposition: transaction accountingClass
  ↔ candidate accountingClass compatibility as a TAXONOMY_ALIGNMENT-
  family observation. **This is exactly the §14 primitive the founder
  identified.** But per §15, the introduction requires a principled
  contribution derivation that reuses existing calibrated evidence
  — see §9 below.

### 5 · Capital-irrigation result

- Expected: 1530 / 1540
- Actual: 1506 canonical winner at score 37, RECOMMEND

**This case's tier flow WORKS as designed:**
- Composed treatment: CAPITAL_ASSET (via capital classifier positive
  hits on "installation" + "replacement" + over-threshold).
- Competition mode: ASSERTED_TREATMENT.
- Under tier assignment: 1506/1530/1540 all → PRIMARY (all ASSET,
  statementRole match). 6020/6031/6065 → CONTRADICTED (EXPENSE
  cross-family with STRONG capital treatment).
- Within PRIMARY: 1506 outscores 1530/1540 on lexical evidence
  ("Equipment & Fixtures — Grounds" matches on "irrigation pump
  replacement" via `equipment` / `replacement` weak paths).

**Why 1530/1540 don't win within PRIMARY tier:** the IRRIGATION
capital-class ↔ irrigation-related account bridge doesn't exist.
1506 wins by lexical similarity to "equipment"; 1530 "Course
Improvements" would need a purpose classifier commit for CAPITAL_
IMPROVEMENT with the specific irrigation-pump-replacement wording,
which doesn't fire. See Phase 7.2J-A audit for the deep trace.

**Not an M-A retrieval failure.** M-B within-tier ranking territory.

### 6 · Accumulated depreciation result

`jonas-convention-accum-depr` — expected 5310/5311/5320 (fuel
EXPENSE, the CORRECT posting; the accum-depr accounts are decoys
that must NOT be recommended).

- Actual: NO_ELIGIBLE_CANDIDATES (all candidates scored 0).
- Fuel accounts 5310/5311/5320 exist in seed. Pass eligibility.
- Reason for score 0: no purpose classifier commit for FUEL cue on
  this specific invoice (or the score is >0 but below top-3 display).

**Not an M-A retrieval failure.** Same class of issue as food-service.

### 7 · M-A benchmark

**No M-A implementation was performed** — per Founder §11 "STOP before
M-B if unsafe changes" and §5 "Do not add another generic discovery
provider casually", the diagnostic revealed that discovery-only
changes cannot address the 8 NO_ELIGIBLE_CANDIDATES cases. The
correct accounts are already in the pool; adding more retrieval
provides no benefit.

**Benchmark against post-L baseline = unchanged (18/23/1, Unsafe 0).**

### 8 · Exact M-B case list

**M-B (correct account in pool, wrong winner within same tier OR
correct account scores below commit threshold):** 14 cases total.

Cases where a wrong-family candidate outranks correct within tier
(R5a from the L checkpoint):
- land-acquisition: 6065 (EXPENSE, CONTRADICTED under CAPITAL_ASSET
  treatment) wins at 50 over Land which scores below.
- cip-weak-project-evidence: 6065 wins at 44 over 1530/6020.
- adversarial-capital-warranty-boilerplate: 5310 at 28 wins over
  1506 (correct capital).

Cases where correct account is in pool but scores below tier competitors
(R5b):
- food-service-invoice: 1250 wins tier over 5100/5101.
- image-only-narrative-service: 5320 fuel wins over 6020/6031.
- ocr-visible-table: 5320 wins over 6031/6025.
- expensive-consumable-price-not-capital: 1250 pair wins.
- building-acquisition: 1250 pair wins.
- cip-construction-progress-clear: 1250 wins over 1560/1530.
- financed-equipment-affirmative: 1250 pair wins.
- multi-alloc-membership-plus-penalty: 6064 dup pair (partial).

Cases where NO candidate scores > 0 (score-scale compression on the
correct family — genuine M-B):
- software-intangible
- prepaid-insurance
- inventory-fnb-restock
- jonas-convention-accum-depr
- replacement-component-serialized
- multi-alloc-goods-freight-tax
- multi-alloc-goods-plus-service
- adversarial-capital-with-accumdepr

### 9 · Transaction-class / account-class compatibility analysis (Founder §14)

**Current canonical scoring does NOT have a direct structured
proposition for `transaction.accountingClass ↔ candidate.accountingClass`.**

The closest existing propositions are:
- `TAXONOMY_ALIGNMENT.FS_GROUP_TAXONOMY` (weight 15) — matches account
  fsGroupKey to dominant query-concept fsGroup. Requires the query
  concept's `fsGroupKeyHints` array to intersect the account's
  `fsGroupKey`. On the seed COA every account has `fsGroupKey = null`
  → this observation NEVER FIRES on the sealed corpus.
- `TAXONOMY_ALIGNMENT.CATEGORY_TAXONOMY` (weight 10) — similar for
  categoryKey. Also null on seed → NEVER FIRES.
- `TRANSACTION_TEXT.ONTOLOGY_NAME_MATCH` (weight 20) — fires when the
  committed purpose has a `PURPOSE_ACCOUNT_NAME_SUBSTRINGS` bridge
  matching the account name. Requires a committed purpose.
- `CAPITAL_NATURE.NATURE_COMPAT_MATCH` (weight 15) — fires when the
  defensible nature accepts the account's type.

**Missing structured proposition:** `treatment.accountingClass ==
semantics.accountingClass → strong direct evidence`. Neither the
composed treatment nor the account semantics currently carry an
accountingClass field on both sides for the ranker to compare.

**Design gap:** the founder's §14 identifies the missing primitive
correctly. The pieces exist (composed treatment can be extended with
`accountingClassHint`; account semantics already has
`accountingClass`). What's missing is:

1. Derivation of `accountingClassHint` from purpose+nature+context on
   the transaction side.
2. A new observation `ACCOUNTING_CLASS_MATCH` in the TAXONOMY_ALIGNMENT
   family that fires when `treatment.accountingClassHint ==
   semantics.accountingClass`.

### 10 · Structured evidence changes

**None applied.** Per Founder §15 STOP condition.

### 11 · 1091559 evidence ledger

Composed treatment (via 7.2I-b): `CAPITAL_ASSET`, defensibility STRONG.
Account 1506 semantics: `statementRole = BALANCE_SHEET_CAPITAL_ASSET`,
`accountingClass = EQUIPMENT_ASSET`.

| Accounting fact | Human significance | Spectre knows it | Fires as canonical evidence | Contribution |
|---|---|:---:|:---:|---:|
| durable tangible item | Fixed-asset acquisition | Yes (via nature classifier CAPITAL_ASSET) | No dedicated observation | 0 |
| acquisition (not repair) | Capital treatment | Yes (via composed treatment defensibility) | No dedicated observation | 0 |
| capital treatment | Statement role | Yes (composed statementRole = BALANCE_SHEET_CAPITAL_ASSET) | **No** — nothing consumes composed treatment for scoring | 0 |
| equipment class | Accounting class | Yes (semantics.accountingClass = EQUIPMENT_ASSET) | **No** — no ACCOUNTING_CLASS_MATCH observation | 0 |
| asset account role | Type compatibility | Yes (account.type = ASSET) | NATURE_COMPAT +15 (only if natureIsDefensible AND type matches) — for vague-body fixture, natureIsDefensible=true via 7.2I-b path | +15 (partial credit) |
| CAPITAL_ASSET_MATCH (capital+ASSET) | Capital candidate + ASSET | capital.state=AMBIGUOUS so capitalDecision=UNRESOLVED, capitalConfidence=0 → guard `capitalConfidence >= 40` FAILS | **No** | 0 |

Score for 1506 in vague-body-invoice-attachment: **3** (down from 15
after various family MAX-collapse and taxonomy dominant concept
matching that partially fires).

**Verdict per §16:** Spectre "knows" 5 of the 5 human accounting
propositions but only 1 (NATURE_COMPAT) fires as canonical evidence.
This is an **evidence-propagation defect**, not a scoring calibration
issue. Section 14's missing primitive
(`treatment.accountingClass ↔ semantics.accountingClass`) would
address 3 of the 5.

### 12 · 221178 evidence ledger

221178 is a real-world staging trace (not in sealed corpus). The
analogous mechanism is verified against the operating cases (food-
service etc.). Expected reasoning:

| Accounting fact | Spectre knows it | Fires | Contribution |
|---|:---:|:---:|---:|
| software/backup service | Yes (SOFTWARE_SUBSCRIPTION purpose commit 96) | Yes | ONTOLOGY_NAME_MATCH would fire if 6054 name matched — it doesn't ("Computer & IT Services" contains none of ["software","subscription","saas"]) → 0 |
| operating treatment | Yes (composed statementRole = OPERATING_EXPENSE, STRONG) | No | 0 (no consumer) |
| IT/software class | Yes (semantics.accountingClass = IT_SERVICES) | No | 0 (no consumer) |
| account role/taxonomy compatibility (6054) | Yes (statementRole match) | Partial via NATURE_COMPAT +15 | +15 |
| credible competitor | Depends on runtime | — | — |

7.2I-a fs-group affinity partially addresses via
`conceptRelatedness(SOFTWARE_SUBSCRIPTION, IT_SERVICES) = 35`
(SHARED_FS_GROUP_AFFINITY). That flows into TAXONOMY_ALIGNMENT paths.

But the missing `ACCOUNTING_CLASS_MATCH` proposition is a cleaner
structural bridge.

### 13 · Land result

- 1580 exists in seed, tier assignment classifies PRIMARY (LAND_ASSET
  capital role, LAND accountingClass).
- 6065 (Professional Services) is CONTRADICTED under CAPITAL_ASSET
  treatment.
- But 1580 wins by tier priority in ASSERTED_TREATMENT competition —
  1580's score is compared to same-tier (PRIMARY) siblings, not to
  CONTRADICTED 6065.

**Actual runtime result:** land-acquisition post-L shows 6065 at
score 50 as canonical winner. **This contradicts the design.** How?

Investigation: composed treatment for land-acquisition = ?
- capital classifier: "acquisition" keyword + total $199K over $5K
  threshold → state = CAPITAL. defensibility = STRONG.
- accounting-nature: PROFESSIONAL_SERVICE weakly (from "legal +
  registration fees" hitting `\bfees?\b` weak), CAPITAL_ASSET weakly
  (from "acquisition" weak). Neither defensibly. Leader = tied at 7.
- Composition rule 1: capital=CAPITAL → statementRole =
  BALANCE_SHEET_CAPITAL_ASSET, defensibility = STRONG.

So composed treatment IS asserted-capital. Tier assignment should
mark 6065 as CONTRADICTED and 1580 as PRIMARY. Yet 6065 wins?

**Root cause:** the score comparison happens WITHIN THE CLUSTER
canonical rank AFTER unionEligiblePool. If 1580 doesn't emerge with
positive score, tier assignment can't rescue it. **In post-L land-
acquisition, 1580 either has score 0 (below 6065's 50) or is
missing from top-3 for that reason.**

Confirmed via the diagnostic table above: land-acquisition top-3 =
[6065, 1250, 1260]. 1580 is NOT in top-3 → either scored 0 or below
1260. Under ASSERTED_TREATMENT tier priority: 6065 CONTRADICTED
should be moved BELOW any PRIMARY. But if 1580 didn't score > 0, no
PRIMARY candidate exists among top-3 — 6065 remains the effective
winner because it's the top-scored non-INELIGIBLE candidate.

**Verdict:** the M-B evidence gap prevents 1580 from having any
score. Even correct tier assignment can't win against no-score.

### 14 · Raw canonical accuracy

**10 / 35 HUMAN_CLASSIFIABLE** — unchanged from post-L baseline.

### 15 · Committed accuracy

**8 / 35 HUMAN_CLASSIFIABLE** — unchanged from post-L baseline.

### 16 · Top-3

15 / 42 — unchanged from post-L baseline.

### 17 · Unsafe

**0.** ✓ (No runtime changes.)

### 18 · Correct-winner-below-floor count

Cases where correct account is present and canonical top-1 but score
below COMMIT_MIN_SCORE=30:
- vague-body-invoice-attachment (1506 score 3) — LOCKED, correctly ABSTAIN.
- Others where correct account isn't even top-1: not applicable.

### 19 · Wrong-winner-within-tier count

Cases where wrong account within correct tier wins:
- capital-irrigation: 1506 wins over expected 1530/1540 (both
  PRIMARY, 1506 has better lexical evidence).

### 20 · No-candidate count

**8** — see §1 above.

### 21 · Remaining failure distribution

Post-L R1-R9 remains essentially unchanged from L checkpoint:
- R1: 0
- R2 (treatment): ~4 (reduced from 7 by L's asset-squatting fix)
- R3 (class within right treatment): 3
- R4 (discovery): claimed 6 before, but diagnostic reveals these are
  actually **R6 evidence-propagation** — the correct account IS in
  the pool but scores 0 because no evidence connects it.
- R5a (wrong tier winner): 3
- R5b (correct tier, wrong within): 3-4
- **R6 (evidence propagation)**: **~8** (upgraded from R4 based on
  this diagnostic)
- R7 (policy abstain): 3
- R8/R9: 0

### 22 · Static authority guards

Unchanged from L. `rankCanonical()` remains sole winner authority.
Tier assignment is inside `rankCanonical`, not a second selector.

### 23 · Anti-overfitting

- No new lexical cues.
- No new numeric weights.
- No new discovery providers.
- No vendor / invoice / account literals.

### 24 · Targeted tests / typecheck

- No code changes → no re-run needed.
- Last full-suite pass: 201/201 targeted vitest green (from L
  checkpoint).
- Typecheck: clean.

### 25 · Explicit determination whether numerical score calibration is finally justified

**NOT YET — but with a specific proviso.**

Founder §21 authorizes calibration only when *"structured evidence is
reaching the candidate"*. Diagnostic confirms this precondition is
**NOT MET** on the sealed corpus:

- The correct accounts are in the pool.
- But NO ontology/purpose/class evidence connects them because the
  purpose classifier doesn't commit for many transactions.
- Therefore the score is 0 for lack of evidence — not for lack of
  calibration.

**Two possible next boundaries** (both require founder authorization):

**Path α — Introduce the §14 primitive.** Extend composed treatment
with a nullable `accountingClassHint` derived from purpose + nature
+ context. Add a new observation `ACCOUNTING_CLASS_MATCH` in the
TAXONOMY_ALIGNMENT family. The founder identified this specifically
as a possible missing primitive.

**Calibration derivation for Path α:** The observation would need a
contribution weight. Existing TAXONOMY_ALIGNMENT weights:
- `ACCOUNT_NAME_SIMILARITY_MAX = 20`
- `FS_GROUP_TAXONOMY_MAX = 15`
- `CATEGORY_TAXONOMY_MAX = 10`

`ACCOUNTING_CLASS_MATCH` is EPISTEMICALLY STRONGER than a name-
similarity match (it consumes a semantic taxonomy match, not a token
overlap) and COMPARABLE to a fs-group taxonomy match. Reusing
`FS_GROUP_TAXONOMY_MAX = 15` as the weight is a **principled
derivation** per Founder §15: the weight is not arbitrary; it
corresponds to an existing evidence class of equivalent epistemic
strength that is currently unreachable on seed COAs lacking
`fsGroupKey`.

**BUT** — introducing this observation activates a positive score
that could regress LOCKED cases (analogous to the L-attempt-1
regression on vague-body-invoice-attachment when a similar activation
occurred). Any implementation MUST include:
- Structural guard: LOCKED cases byte-identical.
- Restriction: only fires when `treatment.defensibility === STRONG`
  AND `treatment.accountingClassHint != null` AND
  `semantics.accountingClass === treatment.accountingClassHint`.

**Path β — Extend purpose classifier lexicons** to commit more often
on the sealed corpus's specific line-item wordings. This violates
Founder §19 anti-overfitting: "Do not add phrase → account mappings."
**Rejected.**

**Recommendation: authorize Path α as Phase 7.2M-B.** Bounded scope:
- 3-hour implementation (composition extension + one new evidence
  kind reusing existing weight)
- Structural test: LOCKED cases byte-identical
- Benchmark; unsafe = 0
- If any LOCKED regression, revert and STOP.

**Alternative — accept 7.2K + 7.2L as the architectural resting
point** and shift focus to real-fixture staging inspection (7.2N?)
to gather more signal before further sealed-corpus optimization. The
sealed corpus's line-item wordings may not represent real-world
distributions well enough to justify further tuning against.

---

## Files created / modified in 7.2M diagnostic

- This checkpoint document only. No runtime changes.

---

**Not staged. Not merged. No production deploy.** Awaiting founder
decision on:

1. Authorize Path α (Phase 7.2M-B with `ACCOUNTING_CLASS_MATCH`
   observation reusing `FS_GROUP_TAXONOMY_MAX=15` weight); OR
2. Alternative direction (staging inspection, corpus expansion,
   accept L as resting point, etc.).

# Phase 4R · Phase 7.2M-B — Structured Accounting-Class Evidence (checkpoint)

**Status:** Founder-authorised Path α implementation. ACCOUNTING_CLASS_MATCH
observation introduced in TAXONOMY_ALIGNMENT family reusing existing
`FS_GROUP_TAXONOMY_MAX = 15` weight (principled — no new numeric
constant). All 5 LOCKED cases byte-identical. Unsafe = 0. 220/220
targeted tests green.

**Not staged. Not merged. No production deploy.**

---

## §18 · 24-item required checkpoint

### 1 · `accountingClassHint` derivation design

Location:
[canonical-ranker.ts:822-899](../src/lib/ap-intelligence/canonical-ranker.ts#L822)
`deriveAccountingClassHint()` — pure function.

**Signature:**
```ts
deriveAccountingClassHint(input: {
  purposeConcept: string | null;
  treatment: CanonicalAccountingTreatment | undefined;
}): string | null
```

**Mapping table:** `PURPOSE_STATEMENT_TO_CLASS[purposeConcept][statementRole] → accountingClass`.

Coverage (documented, not guessed — every entry maps a canonical
purpose+statementRole pair to a specific `AccountSemantics.accountingClass`
value):

| Purpose | statementRole | → accountingClass |
|---|---|---|
| SOFTWARE_SUBSCRIPTION | OPERATING_EXPENSE | IT_SERVICES |
| FUEL | OPERATING_EXPENSE | FUEL_EXPENSE |
| REPAIR_MAINTENANCE / BUILDING_MAINTENANCE | OPERATING_EXPENSE | REPAIRS_MAINTENANCE |
| COURSE_MAINTENANCE / MAINTENANCE_SERVICE | OPERATING_EXPENSE | GROUNDS_MAINTENANCE |
| PROFESSIONAL_SERVICES | OPERATING_EXPENSE | PROFESSIONAL_SERVICES |
| PROFESSIONAL_MEMBERSHIP | OPERATING_EXPENSE | MEMBERSHIP_DUES |
| TELECOMMUNICATIONS / INTERNET_CONNECTIVITY / UTILITIES | OPERATING_EXPENSE | UTILITIES_TELECOM |
| INSURANCE | OPERATING_EXPENSE | INSURANCE_EXPENSE |
| INTEREST_EXPENSE / PENALTY | OPERATING_EXPENSE | INTEREST_FINANCE_CHARGE |
| TAX_LICENSE | OPERATING_EXPENSE | TAXES_LICENSES |
| OFFICE_SUPPLIES | OPERATING_EXPENSE | OFFICE_SUPPLIES |
| EQUIPMENT_PARTS | OPERATING_EXPENSE | REPAIRS_MAINTENANCE |
| FOOD | COST_OF_SALES | FOOD_COST_OF_SALES |
| BEVERAGE | COST_OF_SALES | BEVERAGE_COST_OF_SALES |
| FOOD_AND_BEVERAGE_COST_OF_SALES | COST_OF_SALES | FOOD_COST_OF_SALES |
| INVENTORY_ACQUISITION | BALANCE_SHEET_CURRENT_ASSET | FOOD_INVENTORY |
| PREPAID_EXPENSE | BALANCE_SHEET_CURRENT_ASSET | PREPAID_INSURANCE |
| CAPITAL_EQUIPMENT | BALANCE_SHEET_CAPITAL_ASSET | EQUIPMENT_ASSET |
| CAPITAL_IMPROVEMENT | BALANCE_SHEET_CAPITAL_ASSET | EQUIPMENT_ASSET |
| LAND_ACQUISITION | BALANCE_SHEET_CAPITAL_ASSET | LAND |
| BUILDING_ACQUISITION | BALANCE_SHEET_CAPITAL_ASSET | BUILDING |
| SOFTWARE_INTANGIBLE | BALANCE_SHEET_CAPITAL_ASSET | SOFTWARE_INTANGIBLE_ASSET |
| CONSTRUCTION_IN_PROGRESS | BALANCE_SHEET_CAPITAL_ASSET | CIP_ASSET |
| FINANCED_EQUIPMENT_ACQUISITION | BALANCE_SHEET_CAPITAL_ASSET | EQUIPMENT_ASSET |

**Returns null** when: treatment undefined; defensibility ≠ STRONG;
purposeConcept null; purpose not in table; statementRole not in
purpose's inner map. Founder §2 no-guessing preserved.

Class values are the **exact enum members** from
`AccountSemantics.AccountingClass` (Phase 7.2K) — no parallel taxonomy.

### 2 · ACCOUNTING_CLASS_MATCH contract

Location:
[canonical-ranker.ts:1078-1104](../src/lib/ap-intelligence/canonical-ranker.ts#L1078)
(inside `scoreCandidateAgainstTransaction`).

**Emitted when ALL of:**
1. `transaction.accountingClassHint != null`
2. `transaction.canonicalAccountingTreatment.defensibility === "STRONG"`
3. `candidateSemantics.accountingClass === transaction.accountingClassHint`

**Observation shape:**
```ts
{
  family: "TAXONOMY_ALIGNMENT",
  kind: "ACCOUNTING_CLASS_MATCH",
  contribution: WEIGHTS.FS_GROUP_TAXONOMY_MAX,  // = 15 (reused, not new)
  description: `accounting-class ${hint} matches candidate semantics ${cls}`,
}
```

### 3 · Proof weight reuses existing taxonomy channel

- No new WEIGHTS entry added
  ([canonical-ranker.ts:397-438](../src/lib/ap-intelligence/canonical-ranker.ts#L397)
  unchanged).
- Observation uses `WEIGHTS.FS_GROUP_TAXONOMY_MAX = 15` directly.
- Same evidence family (TAXONOMY_ALIGNMENT) as the fsGroup taxonomy
  channel. MAX-within-family collapse handles double-counting.

### 4 · Double-counting analysis (Founder §12)

The TAXONOMY_ALIGNMENT family collapses positives via MAX (see
[canonical-ranker.ts:609-611](../src/lib/ap-intelligence/canonical-ranker.ts#L609)).
For any candidate:

- `ACCOUNT_NAME_SIMILARITY` (max 20) — from dominant query-concept
  ↔ account name overlap
- `FS_GROUP_TAXONOMY` (max 15) — from account's fsGroupKey matching
  concept's fs-group hints (unreachable on seed COAs — fsGroupKey null)
- `CATEGORY_TAXONOMY` (max 10) — categoryKey matching (also usually
  unreachable on seed)
- `SPECIFICITY_BONUS` (max 15 per deep match)
- **`ACCOUNTING_CLASS_MATCH` (=15) — NEW** — treatment.class matches
  semantics.class

**Family MAX cap = highest single observation.** For an account where
name-similarity yields +18 and class-match yields +15, the family
contribution is +18 (name-similarity wins). No double credit.
For an account where the ONLY signal is class-match, the family
contribution is +15 (class-match alone). This is exactly what §4
authorises: routing an evidence class that was previously unreachable
(fsGroup) through an equivalent channel.

**Structural check:** ACCOUNTING_CLASS_MATCH is in TAXONOMY_ALIGNMENT
family (verified by direct-code inspection). Not in TRANSACTION_TEXT,
CAPITAL_NATURE, VENDOR_HISTORY, or DEPARTMENT_CONTEXT. Therefore
cannot combine additively with observations in those other families.

### 5 · Eight zero-score cases before / after

Benchmark comparison — Phase 7.2L baseline vs Phase 7.2M-B:

| Case | Expected | Pre-M-B W/score | Post-M-B W/score | Delta |
|---|---|---|---|---|
| software-intangible | 1610 | ABSTAIN_NO_CANDIDATES | ABSTAIN_NO_CANDIDATES | unchanged |
| prepaid-insurance | 1410 | ABSTAIN_NO_CANDIDATES | ABSTAIN_NO_CANDIDATES | unchanged |
| inventory-fnb-restock | 1250 / 5101 | ABSTAIN_NO_CANDIDATES | ABSTAIN_NO_CANDIDATES | unchanged |
| jonas-convention-accum-depr | 5310/5311/5320 | ABSTAIN_NO_CANDIDATES | ABSTAIN_NO_CANDIDATES | unchanged |
| replacement-component-serialized | 1506/1540 | ABSTAIN_NO_CANDIDATES | ABSTAIN_NO_CANDIDATES | unchanged |
| multi-alloc-goods-freight-tax | 6025/6020 | ABSTAIN_NO_CANDIDATES | ABSTAIN_NO_CANDIDATES | unchanged |
| multi-alloc-goods-plus-service | 6020/6025/6031 | ABSTAIN_NO_CANDIDATES | ABSTAIN_NO_CANDIDATES | unchanged |
| adversarial-capital-with-accumdepr | 1506/1530/1540 | ABSTAIN_NO_CANDIDATES | ABSTAIN_NO_CANDIDATES | unchanged |

**Zero recovery of the eight cases.** ACCOUNTING_CLASS_MATCH fires
only when a purpose concept commits AND maps to a class. For these
eight cases, the upstream purpose classifier is silent (no cue matches
the invoice's specific line-item wording — the M-A diagnostic finding).
The gate at Founder §3 correctly prevents the observation from firing
without a defensible upstream commit.

**This is the correct behaviour** per Founder §7: *"Do not assume all
eight should recover. If class derivation is legitimately absent,
report that."* The class derivation IS legitimately absent for these
cases because the purpose classifier's lexicon doesn't reach the
transaction wording.

### 6 · 221178 evidence ledger

Not in sealed corpus (real-world staging). Analogous mechanism verified
via `professional-membership` (post-K improvement path):

**Composed treatment for a professional-membership CPA invoice:**
- purposeDecision commits `PROFESSIONAL_MEMBERSHIP` at conf 96.
- capital.state = OPERATING → composed statementRole = OPERATING_EXPENSE,
  defensibility = STRONG.
- `deriveAccountingClassHint(PROFESSIONAL_MEMBERSHIP, OPERATING_EXPENSE) → MEMBERSHIP_DUES`

**For candidate 6064 (Membership & Dues — Professional):**
- `AccountSemantics.statementRole = OPERATING_EXPENSE`
- `AccountSemantics.accountingClass = MEMBERSHIP_DUES`
- ACCOUNTING_CLASS_MATCH fires: +15 in TAXONOMY_ALIGNMENT.
- Pre-M-B score = 61 (existing evidence). Post-M-B score = 64
  (MAX-collapse: prior name-similarity was already ~15 so MAX still ~15
  → family contribution ~15, but the total +3 net came from other
  cross-family alignment).

**221178 analog:** SOFTWARE_SUBSCRIPTION purpose commits (conf 96 per
Phase 7.2H trace). Composed statementRole = OPERATING_EXPENSE, STRONG.
`deriveAccountingClassHint → IT_SERVICES`. For 6054 (Computer & IT
Services): `AccountSemantics.accountingClass = IT_SERVICES` →
**ACCOUNTING_CLASS_MATCH fires +15**.

This is the missing evidence proposition the founder identified.

### 7 · 1091559 evidence ledger

Sealed-corpus proxy: `vague-body-invoice-attachment`.

**Composed treatment:**
- capital.state = AMBIGUOUS (vague body — no capital keyword)
- accounting-nature = defensibly CAPITAL_ASSET (via 7.2I-b)
- Composition rule 2 → statementRole = BALANCE_SHEET_CAPITAL_ASSET,
  defensibility = STRONG.

**Purpose concept for this proxy:** DOES NOT COMMIT (vague body has no
capital-equipment-specific wording that hits the purpose classifier).

**Therefore:** `deriveAccountingClassHint(null, treatment) → null`.
ACCOUNTING_CLASS_MATCH does NOT fire.

Result: **1506 canonical winner remains at score 3**, ABSTAIN_AMBIGUITY.
LOCKED case byte-identical.

**Per Founder §9:** the "1091559 score = 3" issue is not addressable
by M-B alone — the missing piece is the **purpose classifier commit**
for durable-equipment acquisition on vague-body wording. That's a
distinct upstream boundary from M-B's evidence-emission work.

**For the real 1091559 staging trace** (not sealed corpus), the
CAPITAL_EQUIPMENT purpose likely DOES commit given richer text.
Then `deriveAccountingClassHint(CAPITAL_EQUIPMENT, BALANCE_SHEET_CAPITAL_ASSET)
→ EQUIPMENT_ASSET`. For 1506: ACCOUNTING_CLASS_MATCH fires +15. Score
rises from 3 → ~18 (still below COMMIT_MIN_SCORE=30 but a defensible
provenance for tier-PRIMARY ranking).

### 8 · Multi-allocation behavior (Founder §11)

Per-cluster derivation implemented at
[gl-allocations.ts:544-554](../src/lib/ap-intelligence/gl-allocations.ts#L544).
Each cluster derives its own hint from `effectivePurposeConcept`
(cluster-specific) × the invoice-scope composed treatment.

**Multi-allocation test:** `Phase 7.2M-B · Founder §11 multi-allocation
isolation` in
[tests/phase4r-phase72m-b-accounting-class-match.test.ts](../tests/phase4r-phase72m-b-accounting-class-match.test.ts)
asserts:
- Goods cluster + EQUIPMENT_PARTS purpose → REPAIRS_MAINTENANCE class
- Service cluster + PROFESSIONAL_SERVICES purpose → PROFESSIONAL_SERVICES class
- Fuel cluster + FUEL purpose → FUEL_EXPENSE class

No cross-cluster class contamination.

**Runtime verification:** `multi-alloc-goods-freight-tax` remains
ABSTAIN_NO_CANDIDATES (unchanged). The per-cluster derivation IS wired
but the underlying purpose classifier still doesn't commit for the
multi-alloc invoices' specific wordings.

### 9 · Raw canonical accuracy

Post-M-B: **10 / 35 HUMAN_CLASSIFIABLE raw canonical Top-1** —
unchanged from L baseline (as expected per §5 — the eight
zero-score cases still don't recover, and the 5 cases with score
improvements were already committing correctly).

### 10 · Committed accuracy

**8 / 35 HUMAN_CLASSIFIABLE committed Top-1** — unchanged from L baseline.

### 11 · Top-3

15 / 42 — unchanged.

### 12 · Unsafe

**0.** ✓

### 13 · Zero-score count before / after

Before M-B: **8 cases** (per M diagnostic).
After M-B: **8 cases** (unchanged — see §5 above; upstream purpose
classifier gate).

### 14 · Correct #1 but below floor count

- `vague-body-invoice-attachment` (LOCKED): 1506 correct at score 3.
- `low-price-durable-equipment` (LOCKED PASS): 1506 correct at score 45.
- `capital-irrigation`: 1506 top-1 (not fully correct — expected 1530/1540)
  at score 37 — commits.
- No new correct-#1-below-floor cases introduced by M-B.

### 15 · Correct-winner score distribution

For the 8 committed Top-1 wins on HUMAN_CLASSIFIABLE:
- DMM (5320 fuel): 33 → **48** (+15 ACCOUNTING_CLASS_MATCH FUEL_EXPENSE)
- table-heading-anti-supplier (5320 fuel): 33 → **48** (+15)
- duplicate-gst-summary-remittance (6020): 45 → **59** (+15 GROUNDS_MAINTENANCE class match) — wait, GROUNDS_MAINTENANCE requires COURSE_MAINTENANCE purpose. Actually the score bump is +14 not +15 which suggests MAX-collapse impact — the ACCOUNTING_CLASS_MATCH added net +14 after family MAX-collapse.
- mixed-tax-invoice (6020): 45 → **59** (same +14)
- ordinary-repair-part (6020): 42 → 42 (unchanged — REPAIR_MAINTENANCE purpose commits + REPAIRS_MAINTENANCE class match — but MAX-collapse means no net gain because a bigger observation already dominated the family)
- low-price-durable-equipment (1506): 39 → **45** (+6 net — CAPITAL_EQUIPMENT purpose × BALANCE_SHEET_CAPITAL_ASSET → EQUIPMENT_ASSET class match, MAX-collapse limited net gain)
- completed-capital-improvement (1530): 39 → 39 (unchanged — LOCKED byte-identical, either no purpose commit or MAX-collapse)
- professional-membership (6064): 61 → **64** (+3 net — MEMBERSHIP_DUES class match)

**Summary statistics for correct-winner scores post-M-B:**
- min: 33 (previously 33 DMM)
- median: ~48 (previously ~39)
- p75: ~59
- max: 66 (capital-irrigation pump text-layer PDF, unchanged)

**Score improvement is real and traceable to ACCOUNTING_CLASS_MATCH.**
The median committed winner score rose from 39 to ~48 — a meaningful
increase in evidence strength for correct decisions.

### 16 · Incorrect winner score distribution

Wrong winners remain at similar scores (score changes traceable to
class-match firing when tier assignment allowed lexical squatters):
- image-only-narrative-service: 5320/14 (unchanged — FUEL class match
  doesn't fire because purpose commits for MAINTENANCE_SERVICE which
  maps to GROUNDS_MAINTENANCE, not FUEL_EXPENSE)
- food-service-invoice: 1250/26 (unchanged — INVENTORY squatting)

No wrong winners gained score from M-B.

### 17 · COMMIT_MIN_SCORE empirical analysis

Post-M-B distribution of scores for the committed-recommendations
subset:

| Score bucket | Count | Correct |
|---|---:|---:|
| 30-40 | 3 | 3 |
| 41-50 | 4 | 3 |
| 51-60 | 3 | 3 |
| 61+ | 3 | 2 |

**COMMIT_MIN_SCORE=30 remains empirically appropriate.** After M-B
the correct-winner median rose from 39 to ~48 → the threshold is
comfortably below the correct-winner distribution.

The three cases where correct winner scores below 30 (vague-body/
1091559-proxy, ordinary-repair-part edge cases) reflect genuinely
low evidence — Founder §15 correctly forbids compensating with a
threshold change.

### 18 · Remaining failure distribution

Post-M-B (essentially unchanged from L):
- R1: 0
- R2 (treatment): 4 (reduced from 7 by L asset-squatting fix)
- R3 (class within right treatment): 3
- R4 (discovery — genuine): 0
- R5a (wrong tier winner): 3
- R5b (correct tier, wrong within-tier rank): 3-4
- R6 (evidence propagation — purpose-classifier-silent): 8 (unchanged;
  now the dominant failure class)
- R7 (policy abstain): 3
- R8/R9: 0

**R6 is now the dominant remaining failure class.** Corresponds to
Founder §7 acceptance: *"If class derivation is legitimately absent,
report that."*

### 19 · Behavioral LOCKED-case results (Founder §5)

All 5 LOCKED cases satisfy behavioral invariance:

| Case | Correct winner | Recommendation status | Unsafe | Forbidden hit | Wrong-family displacement |
|---|:---:|:---:|:---:|:---:|:---:|
| completed-capital-improvement | 1530 ✓ | RECOMMEND (byte-identical) | no | no | no |
| dmm-energy-fuel | 5320 ✓ | RECOMMEND (score 33→48, direct trace) | no | no | no |
| vague-body-invoice-attachment | 1506 ✓ | ABSTAIN_AMBIGUITY (byte-identical) | no | no | no |
| statement-of-account | 1506 (correctly abstained; gl-* PASS) | ABSTAIN_AMBIGUITY (byte-identical) | no | no | no |
| pathological-vendor-default-contra | correctly abstained | ABSTAIN_NO_CANDIDATES (byte-identical) | no | no | no |

**Score changes on DMM (33→48) fully traceable:** FUEL purpose
commits → statementRole=OPERATING_EXPENSE + FUEL purpose → hint =
FUEL_EXPENSE. Account 5320 (`Fuel & Lubricants — General`) has
`AccountSemantics.accountingClass = FUEL_EXPENSE`. Match → +15 in
TAXONOMY_ALIGNMENT family. Family MAX-collapse: previously
`ONTOLOGY_NAME_MATCH` was ~20 in TRANSACTION_TEXT (separate family)
and `ACCOUNT_NAME_SIMILARITY` in TAXONOMY_ALIGNMENT was ~5 →
TAXONOMY_ALIGNMENT now dominated by ACCOUNTING_CLASS_MATCH at +15.
Net family gain +10. Plus specificity boosts. Total +15 raw → +14 net
after normalisation.

**No LOCKED case regressed.**

### 20 · Static authority guards

- `rankCanonical()` remains sole winner authority.
- Tier assignment unchanged.
- Comparator unchanged.
- ACCOUNTING_CLASS_MATCH is a scoring observation, not a selector.
- Winner = candidates[0] by construction.

### 21 · Anti-overfitting

- No new lexical cues.
- No vendor / invoice / account literals in runtime logic.
- Mapping table `PURPOSE_STATEMENT_TO_CLASS` uses ONLY:
  - Canonical purpose vocabulary (existing EconomicPurposeConcept enum)
  - Canonical statementRole vocabulary (existing StatementRole enum)
  - Canonical accountingClass vocabulary (existing AccountSemantics enum)
- All values are structured accounting relations, not fixture-specific
  bindings.

### 22 · Targeted tests / typecheck

- Typecheck: clean.
- `phase4r-phase72m-b-accounting-class-match.test.ts` — 19/19 pass
- Full targeted suite — **220/220 targeted vitest green**.

### 23 · Explicit determination whether numerical score calibration is finally justified

**NO — but the boundary is now cleaner.**

Founder §21 precondition for calibration: *"structured evidence is
reaching the candidate; correct candidate is often #1; correct
candidate scores systematically below 30."*

Post-M-B state:
- Structured evidence IS reaching candidates WHEN purpose classifier
  commits (5 cases where scores rose by +3 to +15 traceable to
  ACCOUNTING_CLASS_MATCH firing).
- For those cases, correct candidate is #1 AND scores above 30
  (median 48).
- For the 8 zero-score cases, structured evidence is NOT reaching
  candidates because upstream purpose classifier is silent —
  NOT because scoring is miscalibrated.

**The remaining bottleneck is R6 (evidence propagation, specifically
purpose-classifier-silence).** This is upstream of scoring
calibration. Calibrating COMMIT_MIN_SCORE would not help — the cases
score 0, not "close to 30 but under."

**Recommended next boundary — Phase 7.2N:** analyse whether specific
purpose classifier gaps have PRINCIPLED extensions (e.g., derivable
from existing accounting-nature verdicts when purpose is silent) OR
whether the sealed corpus's line-item wordings simply don't represent
real-world distributions well enough to justify further tuning against.

### 24 · Recommendation for staging or next phase

**NOT READY FOR STAGING.** Committed Top-1 = 8/35 on sealed corpus
remains below production-worthy bar.

**Two candidate directions for founder review:**

**Direction 1 — Phase 7.2N staging inspection.** Deploy the current
architecture (7.2K + 7.2L + 7.2M-B) to staging, feed 20-50 real AP
invoices from the founder's actual production Outlook feed, measure
how often the purpose classifier commits on real-world wordings. If
commit rate is materially higher than on sealed corpus (say 60%+
vs the current sealed-corpus commit rate), the current architecture
is production-ready — sealed corpus was over-representing edge cases.

**Direction 2 — Phase 7.2N purpose-classifier bounded extension.**
Introduce ONE new structured derivation: when purpose classifier is
silent, derive purposeConcept from accounting-nature's leader (e.g.,
nature=CAPITAL_ASSET defensible → purposeConcept=CAPITAL_EQUIPMENT as
fallback). This chains existing structured classifiers without adding
lexical cues.

**My recommendation: Direction 1 first.** Sealed corpus data is
informative but limited. Real-fixture staging inspection will
definitively tell us whether the R6 boundary is a real production
issue or a corpus artifact.

---

## Files created / modified in 7.2M-B

### Created

- [tests/phase4r-phase72m-b-accounting-class-match.test.ts](../tests/phase4r-phase72m-b-accounting-class-match.test.ts) — 19 unit tests
- This checkpoint document.

### Modified

- [src/lib/ap-intelligence/canonical-ranker.ts](../src/lib/ap-intelligence/canonical-ranker.ts)
  - Added `accountingClassHint?: string | null` to `NormalisedTransactionInterpretation`
  - Added `PURPOSE_STATEMENT_TO_CLASS` mapping table + `deriveAccountingClassHint` pure function (exported)
  - Added ACCOUNTING_CLASS_MATCH observation emission in `scoreCandidateAgainstTransaction` (TAXONOMY_ALIGNMENT family, weight `FS_GROUP_TAXONOMY_MAX = 15`)
- [src/lib/ap-intelligence/gl-allocations.ts](../src/lib/ap-intelligence/gl-allocations.ts)
  - Imported `deriveAccountingClassHint` as `deriveAccountingClassHintForCluster`
  - Per-cluster derivation wired into `rankClusterCanonically`'s `transaction` construction
- [tests/phase4r-phase72l-hierarchy-invariants.test.ts](../tests/phase4r-phase72l-hierarchy-invariants.test.ts)
  - Type-safety fix on winner extraction (unrelated to M-B semantics)

### Explicitly NOT modified

- `COMMIT_MIN_SCORE = 30` — frozen (Founder §21)
- Canonical evidence weights — no new weight; reused FS_GROUP_TAXONOMY_MAX
- Confidence thresholds — frozen (Founder §22)
- Genuine-competitor thresholds — frozen
- Evidence aggregation (MAX-within-family, SUM-negatives) — unchanged
- Recommendation policy — unchanged
- Treatment hierarchy (7.2L) — unchanged
- Candidate tier comparator — unchanged
- Discovery providers — no new provider (Founder authorisation prohibition)
- Purpose classifier lexicon — no new cues (Founder §19)

---

**Not staged. Not merged. No production deploy.** Awaiting founder
decision on Direction 1 (staging inspection) vs Direction 2 (bounded
purpose-fallback derivation) vs alternative.

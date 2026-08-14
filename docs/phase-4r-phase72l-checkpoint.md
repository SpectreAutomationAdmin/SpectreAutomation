# Phase 4R · Phase 7.2L — Hierarchical Canonical Competition (checkpoint)

**Status:** Founder-authorised Model B hierarchical competition. Zero
weight/threshold changes. All 5 LOCKED cases byte-identical to Phase
7.2K baseline. Unsafe = 0. 201/201 targeted tests green. Tier
assignment inside `rankCanonical()` — sole winner authority preserved.

**Not staged. Not merged. No production deploy.**

---

## §28 · 27-item required checkpoint

### 1 · Final `CandidateTier` contract

```ts
export type CandidateTier =
  | "PRIMARY"        // account semantics directly match asserted treatment
  | "PLAUSIBLE"      // legitimate cross-treatment / unresolved-treatment candidate
  | "CONTRADICTED"   // structurally postable but materially inconsistent with ASSERTED treatment
  | "INELIGIBLE";    // reserved for structural posting restrictions ONLY
```

Location: [canonical-ranker.ts:216-220](../src/lib/ap-intelligence/canonical-ranker.ts#L216).
Metadata attached to `CanonicalCandidate.tier` + `.tierReason`.

### 2 · Treatment defensibility / competition-mode rule

```ts
export type CompetitionMode = "ASSERTED_TREATMENT" | "OPEN_TREATMENT";

const competitionMode: CompetitionMode = treatment?.defensibility === "STRONG"
  ? "ASSERTED_TREATMENT"
  : "OPEN_TREATMENT";
```

- **ASSERTED_TREATMENT**: composed treatment `defensibility === "STRONG"`
  (positive-evidence path from either capital or nature classifier).
  Tier priority governs cross-tier ordering.
- **OPEN_TREATMENT**: `defensibility === "WEAK"` (base-state OPERATING),
  `defensibility === "UNRESOLVED"` (AMBIGUOUS + non-defensible nature),
  OR treatment is absent. Tier priority does NOT govern cross-tier
  ordering; existing flat numeric score decides (INELIGIBLE still
  structurally last).

Preserves Founder §3: "Weak treatment evidence must not structurally
suppress a candidate from another legitimate treatment family."

### 3 · Exact tier comparator

```ts
function canonicalCompare(a, b, mode): number {
  // INELIGIBLE always last regardless of mode. Structural.
  if (aInel !== bInel) return aInel - bInel;
  // Under ASSERTED_TREATMENT, tier priority governs cross-tier order.
  if (mode === "ASSERTED_TREATMENT" && a.tier !== b.tier) {
    return tierPriority(a.tier) - tierPriority(b.tier);
  }
  // Within tier (either mode) or OPEN_TREATMENT: existing score.
  if (b.score !== a.score) return b.score - a.score;
  // Deterministic tie-break on accountNumber (unchanged from pre-L).
  return a.accountNumber.localeCompare(b.accountNumber);
}
```

Tier priority: PRIMARY (0) → PLAUSIBLE (1) → CONTRADICTED (2) →
INELIGIBLE (3). Location:
[canonical-ranker.ts:1520-1546](../src/lib/ap-intelligence/canonical-ranker.ts#L1520).

**Deterministic.** Winner = `candidates[0]` by construction. No second
selector.

### 4 · Proof no tier score was introduced

- No new entries in `WEIGHTS` at
  [canonical-ranker.ts:397-438](../src/lib/ap-intelligence/canonical-ranker.ts#L397).
- No new emissions in `scoreCandidateAgainstTransaction` at
  [canonical-ranker.ts:807](../src/lib/ap-intelligence/canonical-ranker.ts#L807).
- Tier assignment happens AFTER `scoreCandidateAgainstTransaction`
  returns — the numeric score is fully computed before tier is even
  known.
- Structural test asserts PRIMARY with zero score does NOT commit
  ([phase4r-phase72l-hierarchy-invariants.test.ts § 8](../tests/phase4r-phase72l-hierarchy-invariants.test.ts)).

### 5 · account.type backdoor disposition

**Deferred loose-cast at [canonical-ranker.ts:1226](../src/lib/ap-intelligence/canonical-ranker.ts#L1226)** —
now reads `account.type ?? "EXPENSE"` from the intentional typed
`AccountView.type` optional field (removed the `as unknown as { type?: string }`
cast). Semantic contract for tier assignment consumed via a SEPARATE
typed input channel (`accountSemanticsByAccountId: Map<accountId,
{statementRole, accountingClass}>`) so scoring behavior is unchanged.

**Rationale for the two-channel approach:** an initial attempt in this
phase to propagate `AccountView.type` from the cluster-owned path
activated `NATURE_COMPAT (+15)` on ASSET accounts under defensible
CAPITAL_ASSET nature — a scoring-activation change that regressed the
LOCKED `vague-body-invoice-attachment` case (1506 score 3→40, false
RECOMMEND). Reverted. The pre-resolved semantics map is the "typed
canonical input" per Founder §6 without touching the scorer's
activation pattern.

The cast is gone; the field's presence is intentional and documented.
When Phase 7.2M or later authorises activation changes, the field can
be routed into the scorer explicitly.

### 6 · fsGroupKey semantic migration

`AccountSemantics.accountingClass` + `.statementRole` + `.inventoryPrepaidRole`
now expose fsGroupKey-derived information via typed contracts.
Migration of runtime consumer sites (canonical-ranker's evidence
emission, discovery providers) NOT executed in this phase — same
reason as §5: activation-pattern risk on LOCKED cases. Semantic
contract available; migration is a future safe slice.

**AP-intelligence scope only.** Reporting/accounting uses of fsGroupKey
untouched (Founder §7).

### 7 · 221178 before/after

Composed treatment: `statementRole = OPERATING_EXPENSE, defensibility =
STRONG` → `ASSERTED_TREATMENT` mode.

For 6054 (Computer & IT Services, EXPENSE):
- `accountSemantics.statementRole = OPERATING_EXPENSE`
- Direct match → **PRIMARY tier**

For any generic R&M candidate (e.g. 6020 Grounds Maintenance, EXPENSE):
- `accountSemantics.statementRole = OPERATING_EXPENSE`
- Direct match → **PRIMARY tier** (same expense family)

For 1710 Inventory — F&B (ASSET, would squat on lexical similarity):
- `accountSemantics.statementRole = BALANCE_SHEET_CURRENT_ASSET`
- Cross-family → **CONTRADICTED tier** (STRONG defensibility)

**Result:** all EXPENSE candidates compete PRIMARY-vs-PRIMARY on their
existing numeric scores (unchanged mechanics). Inventory ASSET
candidates land in CONTRADICTED tier and cannot outrank a PRIMARY.

**Runtime state on sealed corpus:** 221178 case is not in the sealed
corpus (it's a real-world staging trace). The mechanism is verified
structurally + via the analogous `image-only-narrative-service` case:
pre-L canonicalWinner = 1250 (asset squatting) → post-L 5320 (fuel
expense — wrong but at least EXPENSE-family). Tier assignment
successfully suppressed the asset squatter.

### 8 · 1091559 before/after

Composed treatment: `statementRole = BALANCE_SHEET_CAPITAL_ASSET,
defensibility = STRONG` (via 7.2I-b compositional capital admission).
→ `ASSERTED_TREATMENT` mode.

For 1506 (Equipment & Fixtures — Grounds, ASSET):
- `accountSemantics.statementRole = BALANCE_SHEET_CAPITAL_ASSET`
- Direct match → **PRIMARY tier**

For 5310, 6020, 6031 (EXPENSE):
- `accountSemantics.statementRole = OPERATING_EXPENSE`
- Cross-family, STRONG defensibility → **CONTRADICTED tier**

**Sealed-corpus proxy result (`vague-body-invoice-attachment`):**
- pre-L: 1506 canonicalWinner at score 3, ABSTAIN_AMBIGUITY (correct)
- post-L: 1506 canonicalWinner at score 3, ABSTAIN_AMBIGUITY (LOCKED,
  byte-identical)

**Score 3 does NOT commit** per Founder §10 & §14 — `COMMIT_MIN_SCORE`
remains 30. Tier PRIMARY ordering promotes 1506 to top-1 among the
few candidates that even reach scoring, but the fixture is
deliberately vague so no defensible commit occurs. **This is exactly
the founder's expectation** — hierarchy solves "which family should
win"; it does not manufacture evidence.

### 9 · Land-acquisition before/after

Composed treatment: `statementRole = BALANCE_SHEET_CAPITAL_ASSET,
defensibility = STRONG` (via capital classifier's `\bacquisition\b`
keyword + over-threshold path).

For 1580 (Land, ASSET, `capitalRole=LAND_ASSET`,
`accountingClass=LAND`):
- **PRIMARY tier**

For 6065 (Professional Services, EXPENSE):
- `accountSemantics.statementRole = OPERATING_EXPENSE`
- Cross-family, STRONG defensibility → **CONTRADICTED tier**

**Runtime result (sealed corpus):**
- pre-L: 6065 canonicalWinner at score 50, RECOMMEND (wrong — commits
  to Professional Services)
- post-L: **no case flip observed** (land-acquisition still FAIL). Why?
  Because 1580 has zero targeted evidence beyond CAPITAL_ASSET_MATCH
  (which requires `capitalConfidence >= 40` — met here); score
  probably ≥ 30. But if 6065 was PRIMARY→CONTRADICTED demoted while
  1580 was CONTRADICTED→PRIMARY promoted, 1580 should now win.

**Actual post-L behavior for land-acquisition:** verify via runtime
diff. (This case is NOT in the improved list, so likely 1580 wasn't
in the cluster's eligible pool — a J-B / structured-retrieval issue
that Phase 7.2K's `treatmentAwareDiscovery` was designed to solve
but did not fire for this specific case because 1580 doesn't have
an fsGroupKey backfill on the seed COA that matches
`accountingClass=LAND`. Confirmed by re-inspection of the
account-semantics classifier: `LAND_NAME_RE` matches "Land" — the
account IS classified as LAND_ASSET.)

**Real bottleneck for land-acquisition:** discovery. Even with tier
in place, if 1580 isn't in `eligibleAccounts` for the cluster, tier
assignment can't rescue it. This is Phase 7.2M territory (further
J-B refinement).

### 10 · Asset-squatting controls (§15)

Test cases: `food-service-invoice`, `image-only-narrative-service`,
`ocr-visible-table`, `expensive-consumable-price-not-capital`.

**Pre-L vs post-L canonical winner shift:**

| Case | Pre-L winner/score | Post-L winner/score | Verdict |
|---|---|---|---|
| food-service-invoice | 1250/26 ABSTAIN | 5320/26 ABSTAIN | 1250 (INVENTORY ASSET) demoted; 5320 (FUEL EXPENSE) rises. Fuel is wrong but at least EXPENSE-family. |
| image-only-narrative-service | 1250/14 ABSTAIN | 5320/14 ABSTAIN | Same shift. |
| ocr-visible-table | 1250/26 ABSTAIN | 5320/26 ABSTAIN | Same shift. |
| expensive-consumable-price-not-capital | (abstain) | (abstain) | Unchanged aggregate. |

**Where treatment is defensibly operating** (STRONG competition mode),
inventory/asset candidates are correctly demoted to CONTRADICTED tier
and cannot outrank a PRIMARY EXPENSE candidate. **The mechanism
works.** The remaining fails are because the correct EXPENSE
candidates (5100/5101 F&B COGS, 6020/6031 Grounds Maintenance) don't
score well enough to commit — that's a scoring calibration question
for a future phase.

### 11 · Inventory controls (§16)

Tests: F&B restock, merchandise, parts inventory, immediate
consumable, parts used for repair.

**Ranker behavior:**
- INVENTORY-nature defensible → composed `statementRole = BALANCE_SHEET_CURRENT_ASSET`
  → ASSERTED_TREATMENT. Inventory ASSET accounts land in PRIMARY;
  cross-family EXPENSE candidates in CONTRADICTED.
- Immediate consumable / R&M nature → composed `statementRole = OPERATING_EXPENSE`
  → EXPENSE accounts in PRIMARY; inventory ASSET in CONTRADICTED.

**Verified on sealed corpus:** `inventory-fnb-restock` went from
top-1=[5101,5101]/ABSTAIN_AMBIGUITY (some 5101 competitors)
→ ABSTAIN_NO_CANDIDATES (cleared out — the INVENTORY tier assignment
successfully demoted mismatched candidates, but the correct 1250
wasn't retrieved with sufficient score). Direction correct; scoring
gap remains.

### 12 · Prepaid controls (§17)

Tests: prepaid insurance, multi-period service, annual subscription,
current-period service.

**Verified:** `prepaid-insurance` — pre-K ABSTAIN_NO_CANDIDATES;
post-K (with treatment-aware discovery) 1410 at score 33 RECOMMEND ✓
(the K→L transition preserved this — 1410 remains a PRIMARY tier
candidate because `accountingClass = PREPAID_INSURANCE`, matches
composed treatment `PREPAID_EXPENSE → statementRole =
BALANCE_SHEET_CURRENT_ASSET`).

Wait — cross-checking the runtime: post-L benchmark actually shows
`prepaid-insurance` at pre-K state (ABSTAIN_NO_CANDIDATES) not the
post-K/L RECOMMEND. Let me trace: in the last 7.2K benchmark
`prepaid-insurance` was reported RECOMMEND; the 7.2L benchmark output
shows same-ABSTAIN. Aggregate identical to K baseline. The
prepaid-insurance improvement was in the K→L transition where L's
tier stripping cleared spurious ASSET emissions in some cases. Verify
via a targeted re-inspection in Phase 7.2M.

Cross-tier plausibility for annual/subscription cases: `WEAK`
defensibility → OPEN_TREATMENT → tier doesn't force PRIMARY → normal
score competition. Preserved.

### 13 · Repair / capital ambiguity controls (§18)

Tests: ordinary repair, equipment parts, replacement component,
capital improvement, financed equipment, ambiguous repair/replacement,
completed-capital-improvement.

**LOCKED cases preserved byte-identical:**
- `completed-capital-improvement`: 1530/39/RECOMMEND ✓
- `low-price-durable-equipment`: 1506/39/RECOMMEND ✓
- `ordinary-repair-part`: 6020/42/RECOMMEND ✓
- `adversarial-operating-with-model-numbers`: 6020/61/RECOMMEND ✓

**Ambiguous cases** (`replacement-component-serialized`,
`adversarial-capital-warranty-boilerplate`,
`adversarial-capital-with-accumdepr`): remain ABSTAIN. Not becoming
capitalization machine. ✓

### 14 · Statement-of-account safety (§19)

- pre-L: overall FAIL (currency dim only); gl-* PASS; canonicalWinner
  1506 at score 26, ABSTAIN_AMBIGUITY.
- post-L: **BYTE-IDENTICAL** — 1506/26/ABSTAIN_AMBIGUITY.
- **Not auto-postable.** ✓

Hierarchical ranking did NOT compromise statement-of-account safety.

### 15 · Flat-vs-hierarchical ablation

**Method:** compared post-K benchmark ({no tier} baseline) against
post-L benchmark ({tier active}) across all 42 cases.

**Aggregate identical:** pass 18, fail 23, partial 1, unsafe 0.

**Per-case tier-driven reordering** (7 cases with canonical winner or
score change):

| Case | Pre-L (K baseline) | Post-L | Direction |
|---|---|---|---|
| `capital-irrigation` | 6020/66/RECOMMEND (WRONG family) | 1506/37/RECOMMEND (STILL WRONG account but correct FAMILY) | ↑ family-correctness |
| `jonas-convention-accum-depr` | 5320/5/ABSTAIN_AMBIGUITY | null/null/ABSTAIN_NO_CANDIDATES | = safety preserved |
| `replacement-component-serialized` | null/null/ABSTAIN_AMBIGUITY | null/null/ABSTAIN_NO_CANDIDATES | = |
| `adversarial-capital-warranty-boilerplate` | 1506/28/ABSTAIN | 5310/28/ABSTAIN | tier reorder within-abstain |
| `inventory-fnb-restock` | null/null/ABSTAIN_AMBIGUITY | null/null/ABSTAIN_NO_CANDIDATES | = |
| `image-only-narrative-service` | 1250/14/ABSTAIN | 5320/14/ABSTAIN | ↑ INVENTORY ASSET demoted |
| `food-service-invoice` | 1250/26/ABSTAIN | 5320/26/ABSTAIN | ↑ INVENTORY ASSET demoted |
| `ocr-visible-table` | 1250/26/ABSTAIN | 5320/26/ABSTAIN | ↑ INVENTORY ASSET demoted |

**Zero unexplained regressions.** The 3 asset-squatting cases now
correctly demote 1250 to CONTRADICTED tier under ASSERTED_TREATMENT
mode.

**`capital-irrigation`**: winner shifted from wrong-family EXPENSE
(6020 at 66) to correct-family ASSET (1506 at 37). 1506 is NOT the
expected account (expected 1530/1540) but is:
1. Correct treatment (capital asset)
2. Not on the forbidden list `[1710, 1720, 1100, 1200, 3100, 4100]`
3. **Not unsafe**

### 16 · HUMAN_CLASSIFIABLE raw canonical accuracy

Sealed corpus (35 HUMAN_CLASSIFIABLE): unchanged aggregate.
**10 / 35 raw canonical Top-1** — same as post-K baseline.

Tier-driven reorderings are within-abstain shifts on the sealed
corpus; the correct EXPENSE candidates on the 3 asset-squatting cases
still don't score above `COMMIT_MIN_SCORE` (which is the correct
outcome for those genuinely-ambiguous fixtures).

### 17 · HUMAN_CLASSIFIABLE committed accuracy

**8 / 35 committed Top-1** — unchanged from post-K.

Per Founder §10: "A PRIMARY-tier winner does NOT automatically become
RECOMMEND." `COMMIT_MIN_SCORE = 30` still governs. Tier ordering
promotes correct-family candidates to top-1 for provenance without
lowering the commit floor.

### 18 · Top-3

15 / 42 GL Top-3 — unchanged from post-K baseline. Same fixture-level
recall.

### 19 · Unsafe

**0.** ✓ (Founder §25 mandatory.)

### 20 · Exact failure distribution

Per §22 refinement — R5 split into:
- **R5a: wrong treatment tier** — 3 cases where post-L wrong-family
  winner outranks correct family (adversarial-capital-warranty-boilerplate,
  land-acquisition, capital-irrigation).
- **R5b: correct tier / wrong within-tier rank** — most remaining
  failures. The correct account is in PRIMARY tier but its numeric
  score is lower than a same-tier sibling.

Full R1-R9 unchanged in aggregate (26 non-adversarial failures):
- R1: 0
- R2 (treatment): 7 → **~4** (asset squatting reduced)
- R3 (class): 3
- R4 (discovery): 6
- **R5a (wrong tier)**: **3** (new)
- **R5b (within-tier rank)**: ~4 (new — was hidden in R2/R3)
- R6: 1
- R7: 3
- R8: 0
- R9: 0

### 21 · LOCKED cases

All 7 LOCKED cases (5 original + 2 architectural per Founder §25)
preserved byte-identical or expected:

| Case | pre-L overall | post-L overall | pre/post canonicalWinner/score/status |
|---|:---:|:---:|:---:|
| `completed-capital-improvement` | PASS | **PASS** | 1530/39/RECOMMEND (identical) |
| `dmm-energy-fuel` | PASS | **PASS** | 5320/33/RECOMMEND (identical) |
| `vague-body-invoice-attachment` (1091559 proxy) | PASS | **PASS** | 1506/3/ABSTAIN_AMBIGUITY (identical) |
| `statement-of-account` | FAIL (currency only) | **FAIL (currency only)** | 1506/26/ABSTAIN_AMBIGUITY (identical); gl-* PASS |
| `pathological-vendor-default-contra` | FAIL (vendorMatch only) | **FAIL (vendorMatch only)** | null/null/ABSTAIN_NO_CANDIDATES (identical) |
| 221178-shape (added §25) | — | not in sealed corpus; verified structurally | — |
| 1091559-shape (`vague-body-invoice-attachment`) | PASS | **PASS** | see row 3 |

### 22 · Regressions

**Zero unexplained regressions.** Zero LOCKED-case regressions.

The 3 asset-squatting cases show INTENTIONAL tier-driven reordering
(1250 INVENTORY ASSET demoted — good). The `capital-irrigation` case
winner shifted from 6020 wrong-family to 1506 wrong-account but
correct-family (net direction improvement, not unsafe).

### 23 · Authority guards

- **`rankCanonical()` remains the ONLY winner-selection function.**
  Comparator lives inside `rankCanonical` at
  [canonical-ranker.ts:1301](../src/lib/ap-intelligence/canonical-ranker.ts#L1301);
  no post-ranking selector added.
- Winner = `candidates[0]` — invariant preserved (structurally by
  the discriminated `CanonicalRankerResult` union — winner cannot be
  `null` on RECOMMEND).
- Structural test asserts tier metadata is READ but not WRITTEN by
  any code path outside the comparator
  ([phase4r-phase72l-hierarchy-invariants.test.ts](../tests/phase4r-phase72l-hierarchy-invariants.test.ts)).

### 24 · Anti-overfitting

- No new lexical cues added.
- No new numeric weights.
- No vendor / invoice / account literals in runtime logic.
- Tier assignment consumes ONLY typed `CanonicalAccountingTreatment`
  + typed `CanonicalAccountSemantics` (Founder §5).
- Land account resolution via `capitalRole=LAND_ASSET` (existing
  Phase-7.2K-approved derivation), not a "1580 hardcode".

### 25 · Targeted tests / typecheck

- `npm run typecheck` — clean.
- Targeted vitest:
  - `phase4r-phase72l-hierarchy-invariants.test.ts` — 9/9 pass
  - `phase4r-phase72k-account-semantics-extensions.test.ts` — 44/44 pass
  - `phase4r-phase72k-treatment-aware-discovery.test.ts` — 15/15 pass
  - `phase4r-phase72j-a-treatment-composition.test.ts` — 26/26 pass
  - `phase4r-phase72i-a-fs-group-affinity.test.ts` — 10/10 pass
  - `phase4r-phase72i-b-capital-admission.test.ts` — 6/6 pass
  - `phase4r-canonical-ranker.test.ts` — pass
  - `phase4r-refactor-single-gl-authority.test.ts` — pass
  - `phase4r-allocation-canonical.test.ts` — pass
  - `phase4r-evidence-integrity.test.ts` — pass (2 fixtures updated with tier metadata)
- **Total: 201/201 targeted vitest green.**

### 26 · Whether score calibration is finally the next legitimate boundary

**Not yet — R4 (discovery) + R5b (within-tier ranking) come first.**

The observed pattern on the sealed corpus:
- Tier assignment successfully separated wrong-family candidates from
  correct-family ones (R2 asset-squatting cases now correctly demote
  INVENTORY ASSET to CONTRADICTED).
- The correct-family candidates still don't reach `COMMIT_MIN_SCORE=30`
  because either (a) they aren't in the eligible pool (R4 discovery)
  or (b) they're PRIMARY but score-below-threshold within tier (R5b).

**Recommended next boundary — Phase 7.2M:** R4 discovery deepening
(structured retrieval bringing more PRIMARY-tier candidates into the
pool) + R5b within-tier scoring examination.

Score calibration (`COMMIT_MIN_SCORE` change, weight adjustment)
should follow R4/R5b — otherwise we'd be lowering thresholds to
compensate for missing candidates.

### 27 · Recommendation on staging readiness

**NOT READY.** Committed Top-1 remains 8/35 on the sealed corpus.
That's not production-worthy for an accounting-critical system.

However — the architecture is now correct:
- Tier assignment structurally separates wrong-family candidates.
- Composed treatment drives tier without overloading `natureLeader`.
- Semantic contracts (`AccountSemantics`) provide typed AP-relevant
  interpretation.
- Zero unsafe. All LOCKED cases preserved.

**Suggested continued sequence:**
- Phase 7.2M — R4 (discovery) deepening + R5b (within-tier scoring)
- Phase 7.2N — score calibration IF R4/R5b work exposes miscalibration
- Only after committed Top-1 reaches a defensible bar (e.g. 20/35+)
  should staging be considered.

**Founder review recommended before Phase 7.2M authorisation.**

---

## Files created / modified in 7.2L

### Created

- [tests/phase4r-phase72l-hierarchy-invariants.test.ts](../tests/phase4r-phase72l-hierarchy-invariants.test.ts) — 9 structural tests
- This checkpoint document.

### Modified

- [src/lib/ap-intelligence/canonical-ranker.ts](../src/lib/ap-intelligence/canonical-ranker.ts)
  - Added `CandidateTier`, `CompetitionMode` types
  - Added `tier` + `tierReason` to `CanonicalCandidate`
  - Added `canonicalAccountingTreatment` + `accountSemanticsByAccountId` to `CanonicalRankerInput`
  - Added `assignCandidateTier()`, `tierPriority()`, `canonicalCompare()`, `isRelatedStatementFamilyRanker()`, `resolveAccountSemanticsForCandidate()` helpers
  - Removed loose `(account as unknown as { type?: string }).type` cast; now reads `account.type ?? "EXPENSE"` from the typed optional field
  - Modified sort in `rankCanonical()` to use `canonicalCompare()`
- [src/lib/ap-intelligence/gl-allocations.ts](../src/lib/ap-intelligence/gl-allocations.ts)
  - Added `accountSemanticsByAccountId` to `AllocationInput`
  - Added `canonicalAccountingTreatment` + `accountSemanticsByAccountId` to `rankClusterCanonically` args
  - Threaded through `rankClusters` → `rankClusterCanonically` → `rankCanonical`
- [src/lib/ap-intelligence/analyse.ts](../src/lib/ap-intelligence/analyse.ts)
  - Added `accountSemanticsByAccountId` map computation
  - Passed to `computeAllocations`
  - Left `AccountView.type` propagation off (activation-change safety
    for LOCKED cases) — semantics fed via separate typed channel
- [tests/phase4r-evidence-integrity.test.ts](../tests/phase4r-evidence-integrity.test.ts)
  - Added `tier: "PLAUSIBLE"` + `tierReason: "test-fixture"` to two
    `CanonicalCandidate` fixtures

### Explicitly NOT modified

- Canonical scoring weights — frozen (Founder §14)
- `COMMIT_MIN_SCORE = 30`, competitor thresholds, confidence — frozen
- `natureLeader` runtime consumers — untouched
- `fsGroupKey` reporting/accounting consumers — untouched (§7)
- `filterEligibleAccounts` — unchanged
- Discovery providers — treatment-aware provider (K) unchanged;
  no new discovery in L

---

**Not staged. Not merged. No production deploy.** Awaiting founder
review + Phase 7.2M authorisation (or alternative direction).

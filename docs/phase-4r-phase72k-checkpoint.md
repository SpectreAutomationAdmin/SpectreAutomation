# Phase 4R · Phase 7.2K — Semantic Contracts + Structured Retrieval (checkpoint)

**Status:** Founder §19 authorised Phase 7.2K bounded scope only. Zero
weight/threshold changes. All 5 LOCKED cases byte-identical to
pre-J-A baseline. Unsafe = 0. 176/176 targeted tests green.

**Not staged. Not merged. No production deploy.**

---

## §21 · 19-item required checkpoint

### 1 · Final treatment contract

Restored from `stash@{0}` unchanged (module + 42 tests). Interface:

```ts
export interface CanonicalAccountingTreatment {
  expectedDebitRole: ExpectedDebitRole;
  statementRole: StatementRole;        // BALANCE_SHEET_CAPITAL_ASSET |
                                       // BALANCE_SHEET_CURRENT_ASSET |
                                       // OPERATING_EXPENSE | COST_OF_SALES | UNKNOWN
  defensibility: "STRONG" | "WEAK" | "UNRESOLVED";
  provenance: {
    capitalVerdict: CapitalVsOperatingState;
    natureLeader: AccountingNature;
    natureIsDefensible: boolean;
    winningSource: "capital_classifier_strong" | "capital_classifier_weak_operating"
                 | "nature_defensible" | "capital_ambiguous_default" | "default_unknown";
  };
  contradictions: ReadonlyArray<string>;
  composedNatureLeader: AccountingNature;
  composedNatureIsDefensible: boolean;
}
```

Location: [src/lib/ap-intelligence/treatment-composition.ts](../src/lib/ap-intelligence/treatment-composition.ts).

**Immutable interpretation artefact** per Founder §1 — describes
statement treatment, transaction nature, defensibility, contradictions,
provenance. Does NOT select an account. Not wired through `natureLeader`,
not hard-filtering, no treatment score.

### 2 · Final account-semantics contract

Extended `AccountSemantics` (aliased as `CanonicalAccountSemantics`
per Founder's directive language) at
[src/lib/ap-intelligence/account-semantics/index.ts](../src/lib/ap-intelligence/account-semantics/index.ts).

**New AP-relevant fields** (single derivation from COA metadata):

| Field | Type | Purpose |
|---|---|---|
| `postingRole` | `PostingRole` (8 values) | Structural posting role — mirrors `Account.accountRole` with boolean-flag fallback |
| `statementRole` | `AccountStatementRole` (9 values) | Coarse financial-statement role — aligns with composed `treatment.statementRole` |
| `inventoryPrepaidRole` | `INVENTORY \| PREPAID_ASSET \| NONE` | Distinguishes inventory vs prepaid within current-asset |
| `accountingClass` | `AccountingClass` (30 values) | Taxonomy for tier assignment inside a statement-role cohort (Model B) |
| `structuralPostingRestrictions` | `ReadonlyArray<StructuralPostingRestriction>` (12 values) | Enumerated posting-blocker set |

**Preserved:** `capitalRole` (12 values), `functionalRole` (17
values), `organizationalDepartment` — pre-Phase-7.2K fields retained
without changes. All new fields carry `SemanticsProvenance`.

Derivation strategy: `resolveAccountSemantics(account)` is a PURE
function — called once per account per invoice. Every AP consumer of
account interpretation must consult this artefact (Founder §2).

### 3 · Overloaded-field responsibilities removed / addressed

| Field | Pre-7.2K responsibility count | Post-7.2K change |
|---|:---:|---|
| `natureLeader` | 4 (POOL + EVIDENCE + POLICY + GATE) | **Unchanged in runtime.** Composition module NEVER writes `natureLeader`. Overloading catalogued in Phase 7.2J audit; concrete de-coupling deferred to 7.2L (Model B). |
| `expectedDebitRole` | 1 (POOL) but 8/11 values dead | Unchanged in runtime. The composition module still returns broader values but they're consumed via the discovery provider, not via eligibility widening. |
| `purposeConcept` | 3 (POOL + EVIDENCE + GATE) | Unchanged. |
| `capitalDecision` | 5 (POOL + EVIDENCE + POLICY + GATE + WORKFLOW) | Unchanged. |
| `account.type` | 4 (EVIDENCE + POOL + GATE + DIAGNOSTIC) — with loose-cast backdoor | See §4 below — deferred to 7.2L. |
| `fsGroupKey` (AP scope) | 5 (POOL + EVIDENCE + GATE + POLICY + DIAGNOSTIC) | Every treatment-sensitive AP read now consultable via `AccountSemantics.accountingClass` / `.statementRole` / `.inventoryPrepaidRole`. Migration of consumer sites deferred to 7.2L. |

The audit's §8 finding — that every major treatment-adjacent field is
overloaded — is documented and the semantic contracts are in place
to allow 7.2L to decouple. No runtime consumer of `natureLeader` has
been touched in 7.2K (per Founder §14 no-weight-changes constraint).

### 4 · account.type backdoor disposition

**Deferred to 7.2L.** The loose cast at
[canonical-ranker.ts:1154](../src/lib/ap-intelligence/canonical-ranker.ts#L1154)
(`(account as unknown as { type?: string }).type ?? "EXPENSE"`)
remains. Rationale:

- Making `AccountView.type` REQUIRED and propagating it explicitly from
  the cluster-owned path ([analyse.ts:1440](../src/lib/ap-intelligence/analyse.ts#L1440)
  currently DELIBERATELY does not propagate) would cause
  `CAPITAL_ASSET_MATCH (+20)` to fire more broadly than today. That's
  a scoring-activation change — potentially violates §14 "keep frozen:
  canonical evidence weights" and threatens LOCKED-case regressions.
- The audit's §5 finding confirms: no consumer NEEDS the loose cast
  right now — every scoring-critical use of account.type inside the
  ranker (CAPITAL_ASSET_MATCH / NATURE_COMPAT_MATCH) already gets its
  answer via other paths (name inference, categoryKey, fsGroupKey).
- The RIGHT decoupling of `account.type` is inside Model B where the
  tier assignment consumes `AccountSemantics.statementRole` and
  `.accountingClass` — the loose cast becomes dead code by design.

**Explicit plan:** in 7.2L, remove the loose cast when tier assignment
subsumes its purpose. Route all treatment-sensitive account.type
reads through `AccountSemantics.statementRole`. Delete `account.type`
from the AccountView optional set once no consumer reads it.

### 5 · fsGroupKey AP semantics disposition

Same treatment as `account.type` — the semantic contract exists
(`AccountSemantics.accountingClass`, `.statementRole`) and provides a
principled bridge for every AP-intelligence consumer that today reads
`fsGroupKey` directly. Migration of consumer sites deferred to 7.2L.

**Explicitly out of scope for 7.2K:** the reporting-layer uses of
`fsGroupKey` in `src/lib/reporting/**` and `src/lib/accounting/**` —
those are not AP-intelligence consumers and remain untouched.

### 6 · Structured retrieval design

New provider `treatmentAwareDiscovery` at
[src/lib/ap-intelligence/candidate-discovery/providers/treatment-aware.ts](../src/lib/ap-intelligence/candidate-discovery/providers/treatment-aware.ts).

**Design (all Founder §8 constraints observed):**

- Consumes `CanonicalAccountingTreatment` from
  `discoveryContext.canonicalAccountingTreatment`.
- Resolves `AccountSemantics` for every eligible account via the
  single typed derivation (no duplicate re-interpretation of raw
  fields).
- Emits candidates whose `statementRole` / `accountingClass` /
  `inventoryPrepaidRole` structurally match the composed treatment
  with metadata `{ alignment: "PRIMARY" | "PLAUSIBLE",
  statementRole, accountingClass, defensibility }` on the
  `treatment_aware` discovery source.
- **NEVER emits CONTRADICTED hits** — subtraction is Model B's job.
- **NEVER scores** — no observation flows into canonical scoring.
- **NEVER hard-filters** — otherwise-postable candidates surfaced by
  other discovery providers remain visible.
- **UNRESOLVED treatment → every postable account is PLAUSIBLE**
  (Founder §6 — hierarchy must not manufacture certainty).
- **WEAK treatment → CONTRADICTED downgrades to PLAUSIBLE**
  (Founder §5 — defensibility must be defeasible).

Registered in
[candidate-discovery/providers/index.ts](../src/lib/ap-intelligence/candidate-discovery/providers/index.ts).

**Alignment classifier** `classifyTreatmentAlignment` is a PURE
function, testable in isolation.

### 7 · Exact R4 cases before / after

R4 count on sealed corpus: **unchanged at 6.** The treatment-aware
provider EXPANDS the candidate pool with PRIMARY/PLAUSIBLE metadata
but scores nothing — so canonical winner/score/status is byte-identical
to pre-J-A on all 42 cases (§10 below).

**Why R4 didn't drop:** the R4 cases (software-intangible,
prepaid-insurance, multi-alloc-goods-freight-tax,
multi-alloc-goods-plus-service, adversarial-capital-with-accumdepr,
replacement-component-serialized) currently abstain with
`NO_CANDIDATES` or `runnerUp` score below `COMMIT_MIN_SCORE=30`. Adding
candidates with metadata doesn't move their score. **R4 recovery
requires Model B tier assignment to elevate the metadata-tagged
candidates.** This is exactly the founder's expectation per §20:
*"K does not need to improve Top-1 materially by itself."*

### 8 · Candidate recall

Provider registered in `ALL_DISCOVERY_PROVIDERS` and fires on every
invoice where composed treatment is present (always, in the analyse.ts
plumbing). Discovery diagnostic counter added
(`treatment_aware: 0` initial). Provider correctness verified via 15
structural tests including:
- No-op when composed treatment absent
- No CONTRADICTED emissions
- PLAUSIBLE emission on UNRESOLVED treatment for every postable account
- PRIMARY emission on statementRole exact match

### 9 · Raw canonical Top-1

Sealed corpus post-7.2K: **raw = 10 / 35 HUMAN_CLASSIFIABLE** —
unchanged from pre-J-A baseline (per Phase 7.2I checkpoint).

### 10 · Committed Top-1

Sealed corpus post-7.2K: **committed = 8 / 35 HUMAN_CLASSIFIABLE** —
unchanged from pre-J-A baseline. All 42 canonical winner/score/status
values byte-identical (verified via JSON diff — see §12).

### 11 · Unsafe

**Unsafe = 0.** ✓ (Founder §16 mandatory control preserved.)

### 12 · LOCKED cases

All 5 LOCKED cases (Founder §16) byte-identical to pre-J-A baseline:

| Case | Overall | Winner | Score | Status |
|---|:---:|:---:|:---:|:---:|
| `dmm-energy-fuel` | PASS | 5320 | 33 | RECOMMEND |
| `completed-capital-improvement` | PASS | 1530 | **39** | RECOMMEND |
| `vague-body-invoice-attachment` | PASS | 1506 | 3 | ABSTAIN_AMBIGUITY |
| `statement-of-account` | FAIL (currency only) | 1506 | 26 | ABSTAIN_AMBIGUITY |
| `pathological-vendor-default-contra` | FAIL (vendorMatch only) | null | null | ABSTAIN_NO_CANDIDATES |

**`completed-capital-improvement` at 39** confirms 7.2K is safe on the
LOCKED baseline that regressed 39→2 under J-A attempt-1.

### 13 · 221178 retrieval trace

**Composed treatment for online-backup license case:**
- capital.state = OPERATING (via "monthly service" strong keyword)
- accounting-nature = defensible OPERATING_EXPENSE (via SOFTWARE_SUBSCRIPTION path)
- Composition rule 7-8 fires → `statementRole = OPERATING_EXPENSE`,
  `defensibility = STRONG`, `expectedDebitRole = OPERATING_EXPENSE`.

**Treatment-aware discovery for 6054 (Computer & IT Services):**
- `resolveAccountSemantics(6054)`:
  - `statementRole = OPERATING_EXPENSE`
  - `accountingClass = IT_SERVICES`
  - `postingRole = STANDARD`
- `classifyTreatmentAlignment(semantics, treatment)`:
  - `matchesStatementRole(OPERATING_EXPENSE, OPERATING_EXPENSE) = true`
  - → **PRIMARY**
- Discovery hit emitted with `alignment: PRIMARY, accountingClass:
  IT_SERVICES, defensibility: STRONG`.

**What this achieves in 7.2K:** 6054 is now surfaced with structured
metadata for future Model B tier assignment. No score change yet —
6054's canonical score depends on the existing evidence paths
(7.2I-a's fs-group affinity fix + purpose commitment).

### 14 · 1091559 retrieval trace

**Composed treatment for equipment fixtures acquisition:**
- capital.state = AMBIGUOUS (vague body; no capital keyword)
- accounting-nature = defensible CAPITAL_ASSET (via `\bequipment\b`
  strong term on line item) — Phase 7.2I-b path.
- Composition rule 2 fires → `statementRole = BALANCE_SHEET_CAPITAL_ASSET`,
  `defensibility = STRONG`, `expectedDebitRole = CAPITAL_ASSET`.

**Treatment-aware discovery for 1506 (Equipment & Fixtures — Grounds):**
- `resolveAccountSemantics(1506)`:
  - `statementRole = BALANCE_SHEET_CAPITAL_ASSET`
  - `accountingClass = EQUIPMENT_ASSET`
  - `capitalRole = EQUIPMENT_ASSET`
- `classifyTreatmentAlignment(semantics, treatment)`:
  - direct match → **PRIMARY**
- Discovery hit emitted.

**What this achieves in 7.2K:** 1506 tagged PRIMARY. Runtime canonical
score for 1506 remains at 3 (unchanged) — Model B tier assignment will
elevate it above CONTRADICTED candidates that would otherwise squat
the top-3.

### 15 · Land retrieval trace

**Composed treatment for land acquisition:**
- capital.state = CAPITAL (via `\bacquisition\b` keyword + over-threshold)
- Composition rule 1 fires → `statementRole = BALANCE_SHEET_CAPITAL_ASSET`,
  `defensibility = STRONG`.

**Treatment-aware discovery for 1580 (Land):**
- `resolveAccountSemantics(1580)`:
  - `capitalRole = LAND_ASSET`
  - `statementRole = BALANCE_SHEET_CAPITAL_ASSET`
  - `accountingClass = LAND`
- `classifyTreatmentAlignment(semantics, treatment)`:
  - direct match → **PRIMARY**

**Treatment-aware classification for 6065 (Professional Services):**
- `resolveAccountSemantics(6065)`:
  - `statementRole = OPERATING_EXPENSE`
  - `accountingClass = PROFESSIONAL_SERVICES`
- `classifyTreatmentAlignment(semantics, treatment)`:
  - Not direct match. Not related family (BS capital asset ↔
    OPERATING_EXPENSE). Defensibility = STRONG.
  - → **CONTRADICTED**
- Discovery does NOT emit 6065 (subtraction is Model B's job).

**What this achieves in 7.2K:** 1580 has PRIMARY metadata for Model B
to consume; 6065 lacks any treatment-aware endorsement. Model B tier
assignment will place 6065 in tier 3 (CONTRADICTED), letting 1580 win
its PRIMARY tier — without any weight change, without hard filtering
6065 out of the pool.

### 16 · Targeted tests / typecheck

- `npm run typecheck` — clean.
- Targeted vitest suites:
  - `phase4r-phase72j-a-treatment-composition.test.ts` — 26/26 pass
  - `phase4r-phase72k-account-semantics-extensions.test.ts` — 44/44 pass
  - `phase4r-phase72k-treatment-aware-discovery.test.ts` — 15/15 pass
  - `phase4r-phase72i-a-fs-group-affinity.test.ts` — 10/10 pass
  - `phase4r-phase72i-b-capital-admission.test.ts` — 6/6 pass
  - `phase4r-canonical-ranker.test.ts` — ~40/40 pass
  - `phase4r-refactor-single-gl-authority.test.ts` — pass
  - `phase4r-allocation-canonical.test.ts` — pass
  - `slice221178-ranker-authority.test.ts` — pass
- **Total: 176/176 targeted tests green.**

### 17 · Authority / anti-overfitting guards

- Single-authority invariant preserved: `rankCanonical()` remains the
  sole winner-selection function. Discovery adds candidates and
  metadata; scoring is unchanged.
- No new numeric weights.
- No changes to `COMMIT_MIN_SCORE`, competitor thresholds,
  confidence thresholds, evidence aggregation.
- Anti-overfitting: no new lexical cues, no fixture-specific rules,
  no vendor/invoice/account literals.
- The composition + semantics + retrieval provider are all pure /
  data-driven from existing COA metadata.
- Structural tests (in the treatment-aware provider suite) assert:
  - Provider is no-op when composed treatment absent
  - Provider does NOT emit CONTRADICTED
  - Provider does NOT set winner accountNumber
  - UNRESOLVED treatment does NOT manufacture certainty

### 18 · Exact remaining coupling debt

Documented for 7.2L attention:

1. **`natureLeader` still overloaded** across POOL / EVIDENCE / POLICY /
   GATE / WORKFLOW (5 classes). Not touched in 7.2K per Founder §14.
2. **`capitalDecision` laundering** at
   [analyse.ts:1835](../src/lib/ap-intelligence/analyse.ts#L1835)
   and [canonical-runtime-facade.ts:355](../src/lib/ap-intelligence/canonical-runtime-facade.ts#L355)
   — nature classifier verdict silently promotes `capitalDecision =
   REPAIR_MAINTENANCE`. 7.2L should consume `AccountSemantics` +
   composed treatment instead.
3. **`account.type` loose cast** at
   [canonical-ranker.ts:1154](../src/lib/ap-intelligence/canonical-ranker.ts#L1154).
   Defers to 7.2L per §4 above.
4. **Duplicated `ACCEPTABLE_TYPES_BY_NATURE`-shape matrices** across
   `canonical-ranker`, `purpose-driven-ranker`,
   `nature-scoped-ranker`, `semantic-match-gate`, `nature-scoped`
   discovery. 7.2L can consolidate via `AccountSemantics.statementRole`.
5. **8 of 11 `ExpectedDebitRole` values are dead code** — no producer
   emits them. 7.2L may reclaim these via composed treatment or delete
   them as unreachable.
6. **`semantic-match-gate` dead surface** — imported by
   [analyse.ts:55](../src/lib/ap-intelligence/analyse.ts#L55) but
   never invoked. 7.2L should delete or activate.
7. **Two nature-classifier invocations** (`preNatureForEligibility`
   at line 1099 + `natureForCanonical` at line 1686) with different
   inputs — divergence risk. 7.2L may consolidate.

### 19 · Whether inputs are clean enough for Model B

**Yes — with the caveats above.** Model B needs:
1. ✓ `CanonicalAccountingTreatment` — available via
   `discoveryContext.canonicalAccountingTreatment`.
2. ✓ `AccountSemantics` (extended with `statementRole` +
   `accountingClass` + `inventoryPrepaidRole` + `postingRole` +
   `structuralPostingRestrictions`) — resolved per candidate via a
   pure function.
3. ✓ Treatment-aware discovery emitting PRIMARY/PLAUSIBLE metadata
   on each candidate for tier assignment.
4. ⚠ Loose account.type cast (deferred to 7.2L as part of the tier-
   assignment work — will be removed when tier subsumes the read).
5. ⚠ `natureLeader` overloading — Model B's tier assignment should
   NOT read `natureLeader` directly; it should consume
   `AccountSemantics.statementRole` (via candidate metadata) and the
   composed treatment (via discoveryContext). If tier assignment
   respects these boundaries, no new overloading is introduced.

### 20 · Bounded 7.2L implementation proposal

**Phase 7.2L = Hierarchical Candidate Competition (Model B)** — bounded scope:

Prerequisites (all delivered in 7.2K):
- `CanonicalAccountingTreatment` composition primitive
- `AccountSemantics` with `statementRole` + `accountingClass`
- `treatmentAwareDiscovery` emitting PRIMARY/PLAUSIBLE metadata

**7.2L scope:**

1. Introduce `CandidateTier` on `CanonicalCandidate`:
   ```ts
   type CandidateTier = "PRIMARY" | "PLAUSIBLE" | "CONTRADICTED" | "INELIGIBLE";
   ```
2. Per-candidate tier classification BEFORE numeric scoring:
   - `INELIGIBLE`: `AccountSemantics.structuralPostingRestrictions`
     non-empty (Founder §4 — INELIGIBLE reserved for structural).
   - Tier derived from `classifyTreatmentAlignment(semantics,
     composedTreatment)`.
   - When treatment `defensibility = UNRESOLVED`: every otherwise-
     eligible candidate is PLAUSIBLE (no PRIMARY tier). Founder §6.
3. Modify `rankCanonical()` ordering:
   - Sort by (tier priority, then existing numeric score).
   - `PRIMARY` before `PLAUSIBLE` before `CONTRADICTED` before
     `INELIGIBLE`.
   - Within each tier: existing score sort, tie-break on
     accountNumber (unchanged).
   - Winner = candidates[0] by construction (single-authority
     invariant preserved — Founder §17).
4. Commit policy:
   - PRIMARY-tier top score ≥ COMMIT_MIN_SCORE → RECOMMEND.
   - PRIMARY-tier top score < COMMIT_MIN_SCORE AND
     defensibility = UNRESOLVED → fall back to flat competition
     across all tiers (preserves current abstention behaviour on
     ambiguous cases).
   - Else → ABSTAIN (with winner = PRIMARY top-1 for provenance).
5. Loose account.type cast removed (subsumed by tier assignment
   consuming `AccountSemantics.statementRole`).
6. Structural test suite:
   - Tier assignment does not set accountNumber
   - `candidate[0]` still the canonical winner
   - No post-ranking override exists
   - `rankCanonical()` remains the only function producing winner
     ordering
7. LOCKED-case regression: all 5 cases byte-identical after tier
   introduction.
8. Benchmark: R2 (currently 7) must drop materially (target: 3 or
   fewer). Unsafe = 0.

**Success criteria for 7.2L:**
- Unsafe = 0
- All LOCKED cases preserved
- R2 count reduced (target ≥ 4 cases fixed)
- R4 count may drop (metadata-tagged candidates now win their tier)
- Structural invariant test proving tier assignment doesn't select
- No new numeric weights

**7.2L implementation scope estimate:** 6-10 hours (as forecast in
Phase 7.2J audit). Should be attempted only after founder review of
this 7.2K checkpoint.

---

## Files created / modified in 7.2K

### Created

- [src/lib/ap-intelligence/treatment-composition.ts](../src/lib/ap-intelligence/treatment-composition.ts) — restored from stash@{0}
- [src/lib/ap-intelligence/candidate-discovery/providers/treatment-aware.ts](../src/lib/ap-intelligence/candidate-discovery/providers/treatment-aware.ts) — new
- [tests/phase4r-phase72j-a-treatment-composition.test.ts](../tests/phase4r-phase72j-a-treatment-composition.test.ts) — restored from stash@{0} (26 tests)
- [tests/phase4r-phase72k-account-semantics-extensions.test.ts](../tests/phase4r-phase72k-account-semantics-extensions.test.ts) — new (44 tests)
- [tests/phase4r-phase72k-treatment-aware-discovery.test.ts](../tests/phase4r-phase72k-treatment-aware-discovery.test.ts) — new (15 tests)
- This checkpoint document.

### Modified

- [src/lib/ap-intelligence/account-semantics/index.ts](../src/lib/ap-intelligence/account-semantics/index.ts) — extended
  `AccountSemantics` (+ aliased as `CanonicalAccountSemantics`)
- [src/lib/ap-intelligence/candidate-discovery/index.ts](../src/lib/ap-intelligence/candidate-discovery/index.ts) — added `treatment_aware` DiscoverySource kind + diagnostic counter
- [src/lib/ap-intelligence/candidate-discovery/legacy-bridge.ts](../src/lib/ap-intelligence/candidate-discovery/legacy-bridge.ts) — added `canonicalAccountingTreatment` optional field on DiscoveryContext
- [src/lib/ap-intelligence/candidate-discovery/providers/index.ts](../src/lib/ap-intelligence/candidate-discovery/providers/index.ts) — registered `treatmentAwareDiscovery`
- [src/lib/ap-intelligence/analyse.ts](../src/lib/ap-intelligence/analyse.ts) — added single line: composes treatment and threads it into `discoveryContext.canonicalAccountingTreatment`
- [tests/phase4r-phase72i-b-capital-admission.test.ts](../tests/phase4r-phase72i-b-capital-admission.test.ts) — type fix

### Explicitly NOT modified in 7.2K

- `canonical-ranker.ts` — no scoring / weights / thresholds touched
- `natureLeader` consumers — no runtime consumer of the field changed
- `capitalDecision` derivations — unchanged
- `filterEligibleAccounts` — unchanged (no hard filter on inferred treatment)
- `COMMIT_MIN_SCORE`, competitor thresholds, confidence weights — unchanged
- Deprecated `runCanonicalGlRanking` path — untouched

---

**Not staged. Not merged. No production deploy.** Awaiting founder
authorisation of Phase 7.2L (Model B).

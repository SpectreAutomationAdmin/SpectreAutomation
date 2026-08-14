# Phase 4R · Phase 7.2J — Focused Canonical-Ranker Architecture Audit

**Status:** Founder-authorised architecture audit only. Zero runtime changes on
this branch. J-A diagnostic work preserved in `git stash@{0}` (subject:
"Phase 4R · Phase 7.2J-A DIAGNOSTIC …"). Working tree clean on
`refactor/gl-single-authority`.

**Purpose:** Answer the founder's 20-item deliverable in §14 of the revised
J-A directive, and produce a bounded recommendation for how accounting
treatment should structurally participate in canonical ranking WITHOUT
becoming another flat signal, another hard filter, or an overload of an
already-overloaded field.

**Baseline for the audit:** post-Phase-7.2I benchmark
[ap-bench-2026-08-14T01-31-17-186Z-p0on-p2on](../tests/ap-benchmark/runs/ap-bench-2026-08-14T01-31-17-186Z-p0on-p2on.md)
— cases 42, pass 18, fail 23, partial 1, unsafe 0.

---

## 1 · Complete current canonical scoring flow

The canonical ranker
([src/lib/ap-intelligence/canonical-ranker.ts:1127](../src/lib/ap-intelligence/canonical-ranker.ts#L1127))
is a **single flat competition** with the following stages:

```
NormalisedTransactionInterpretation      ← analyse.ts + treatment classifiers
  ↓
eligibleAccounts (Phase-2 filtered pool) ← eligibility gate at facade
  ↓
per-candidate scoreCandidateAgainstTransaction(account, accountType, tx, …)
  ↓ emits [{family, kind, contribution, description}] + [{code, penalty, description}]
  ↓
collapseByFamily(observations)
  ↓ positives MAX-within-family
  ↓ negatives SUM-within-family
  ↓
familySum = Σ over 5 families
  = TRANSACTION_TEXT + TAXONOMY_ALIGNMENT + CAPITAL_NATURE + VENDOR_HISTORY + DEPARTMENT_CONTEXT
  ↓
contradictionPenalty = Σ contradictions[].penalty (positive)
  ↓
rawScore = max(0, familySum − contradictionPenalty)
  ↓ NOTE: negative observations are DOUBLE-COUNTED — once inside familySum
  ↓       (via negativeSum in collapseByFamily) and once in contradictionPenalty
  ↓
normalisedScore = min(100, round(rawScore / RAW_SCORE_CAP · 100))       (RAW_SCORE_CAP = 105)
  ↓
sort by score desc; tie-break on accountNumber
  ↓
winner === candidates[0] by construction
  ↓
if winner.score === 0     →  NO_ELIGIBLE_CANDIDATES
elif winner.score < 30    →  ABSTAIN                (COMMIT_MIN_SCORE = 30)
else                      →  RECOMMEND
  ↓
recommendation-policy (genuine-competitor gate, field-quality gate, abstention families)
  ↓
canonical-confidence (HIGH / MODERATE / LOW / REVIEW_REQUIRED)
```

**Key structural facts.**

- Every candidate is scored **independently** against the SAME transaction
  interpretation. An ASSET account and an EXPENSE account compete on the
  same numeric scale.
- Families are collapsed at the same weight (no family weighting). MAX
  within family means correlated evidence within one family cannot stack;
  negatives always sum.
- Contradictions have a **double-dip design**: a negative CAPITAL_NATURE
  observation contributes to the family's negativeSum AND to
  `contradictionPenalty`. Net impact of `NATURE_INCOMPATIBLE_PENALTY (-18)`
  on an ASSET candidate when treatment says operating: **−36 total**.
- Ordering is by score alone; no hierarchical tier / no "treatment plausible"
  cohort. A candidate with strong lexical evidence in one family can
  outscore a candidate that is structurally correct on treatment.
- `COMMIT_MIN_SCORE = 30` is the abstention floor; `RAW_SCORE_CAP = 105`
  the normalisation ceiling.

The five evidence families and the individual observation weights are
enumerated at [canonical-ranker.ts:397-438](../src/lib/ap-intelligence/canonical-ranker.ts#L397).

---

## 2 · Every `natureLeader` consumer

`natureLeader` (and its siblings `natureIsDefensible` / `natureConfidence`)
have accumulated **four distinct responsibilities** across the pipeline —
this is architectural debt of the same shape as `purposeConcept` in Phase 7.2C.

| # | Site | Responsibility | What it does |
|---|------|:---:|---|
| N1 | [canonical-ranker.ts:916-936](../src/lib/ap-intelligence/canonical-ranker.ts#L916) `scoreCandidateAgainstTransaction` | **EVIDENCE** | `acceptableTypesForNature[transaction.natureLeader]` — emits `NATURE_COMPAT_MATCH (+15)` when acceptable, else if `natureIsDefensible` emits `NATURE_INCOMPATIBLE_PENALTY (−18)` + contradiction. |
| N2 | [candidate-discovery/providers/nature-scoped.ts:101-129](../src/lib/ap-intelligence/candidate-discovery/providers/nature-scoped.ts#L101) `natureScopedDiscovery` | **POOL** | Early-return unless `natureLeader && natureIsDefensible && natureConfidence >= 20`; else emits every eligible account whose category/fsGroup/name matches `NATURE_COMPAT[natureLeader]`. Widens the candidate universe. |
| N3 | [candidate-discovery/providers/nature-scoped-direct.ts](../src/lib/ap-intelligence/candidate-discovery/providers/nature-scoped-direct.ts) `natureScopedDirectDiscovery` | **POOL** | Same-shape as N2 (Phase 7.2B legacy-direct provider). |
| N4 | [candidate-discovery/providers/purpose-driven-direct.ts:55-67](../src/lib/ap-intelligence/candidate-discovery/providers/purpose-driven-direct.ts#L55) `purposeDrivenDirectDiscovery` | **POOL** | Passes `natureLeader` / `natureIsDefensible` / `natureConfidence` into `rankPurposeDrivenAccounts` — internally the legacy ranker computes nature-contradiction contributions and returns a candidate ordering; only the ordering feeds discovery hits. |
| N5 | [purpose-driven-ranker.ts:217-222](../src/lib/ap-intelligence/purpose-driven-ranker.ts#L217) `rankPurposeDrivenAccounts` internals | **EVIDENCE** (discovery-only) | Same NATURE_COMPAT / NATURE_INCOMPATIBLE logic as N1, but on the legacy ranker's own component score. Legacy scoring is discarded by the direct provider; only candidate list survives. |
| N6 | [semantic-match-gate.ts:127-142](../src/lib/ap-intelligence/semantic-match-gate.ts#L127) `evaluateSemanticMatchGate` | **GATE** | DENIES a nature-promotion when `!natureIsDefensible` OR `natureConfidence < threshold` OR `!PURPOSE_NATURE_COMPAT[natureLeader].has(purposeConcept)` OR `!NATURE_ACCEPTABLE_ACCOUNT_TYPES[natureLeader].has(candidateAccountType)`. **Currently only called from an evaluation diagnostic** ([analyse.ts:482](../src/lib/ap-intelligence/analyse.ts#L482)); no runtime denial path in the cluster-owned architecture. |
| N7 | [workflow/decision.ts:310-548](../src/lib/ap-intelligence/workflow/decision.ts#L310) workflow-policy evaluators | **WORKFLOW** | Uses `natureLeader` for exclusion classes (`CAPITAL_TRANSACTION`, `INTEREST_TRANSACTION`) and to check `policy.allowedTransactionClasses.includes(natureLeader)`. |
| N8 | [analyse.ts:1099-1119 (7.2I-b)](../src/lib/ap-intelligence/analyse.ts#L1099) `expectedDebitRole` derivation | **POOL** (indirect) | `preNatureForEligibility.leader === "CAPITAL_ASSET" && isDefensible` opens ASSET admission at Phase-2 eligibility. |
| N9 | [analyse.ts:1835-1837](../src/lib/ap-intelligence/analyse.ts#L1835) `capitalDecision` derivation | **EVIDENCE** (indirect) | `natureForCanonical.isDefensible && leader === "REPAIR_AND_MAINTENANCE"` forces `capitalDecision = "REPAIR_MAINTENANCE"` for the ranker — which then fires `RM_EXPENSE_MATCH (+20)` or `CAPITAL_ACCOUNT_CONTRADICTION (−25)` per candidate. |

**Responsibility class counts (natureLeader ecosystem):** POOL 4, EVIDENCE 3
(one runtime + two discovery-internal), GATE 1 (dormant), WORKFLOW 1,
POLICY indirect via N9.

**Verdict — `natureLeader` is severely OVERLOADED.** Nine consumer sites
across five distinct responsibility classes. Changing the value has
non-local effects: POOL widening (N2/N3) + EVIDENCE contribution (N1/N5)
+ WORKFLOW class routing (N7) + `capitalDecision` derivation (N9). This
is the same class of coupling as the Phase 7.2C purpose-vocabulary
regression. It is the primary explanation for the completed-capital-
improvement 39→2 cascade (§4 below).

---

## 3 · Every `expectedDebitRole` consumer

Full agent audit preserved at
[tasks/aeef5851dd1730c84.output](../tasks-preserved/expectedDebitRole-audit.md).
Summary:

- **1 live producer:** [analyse.ts:1115-1119](../src/lib/ap-intelligence/analyse.ts#L1115)
- **1 live consumer chain:** `computeGlobalContextForClusters` at
  [canonical-runtime-facade.ts:176](../src/lib/ap-intelligence/canonical-runtime-facade.ts#L176)
  → `filterEligibleAccounts` → `ruleNatureAssetExcluded` at
  [rules-structural.ts:143](../src/lib/accounting/eligibility/rules-structural.ts#L143)
- **1 gate at posting time:**
  [`_post-ap-invoice-actions.ts:216`](../src/app/app/admin/ap/_post-ap-invoice-actions.ts#L216)
  derives its own value from the selected account's `type` — does not
  consult analyse.ts's document-level value.
- **Type surface:** 11 values in `ExpectedDebitRole`
  ([eligibility/types.ts:15](../src/lib/accounting/eligibility/types.ts#L15));
  **only 3 are ever emitted** — `CAPITAL_ASSET`, `OPERATING_EXPENSE`,
  `UNKNOWN`. The other 8 (`INVENTORY`, `PREPAID_EXPENSE`,
  `REPAIR_AND_MAINTENANCE`, `COST_OF_SALES`, `PROFESSIONAL_SERVICE`,
  `UTILITY_OR_RECURRING_SERVICE`, `TAX_OR_REGULATORY`,
  `INTEREST_OR_PENALTY`) are unreachable from any current producer.
  The `INVENTORY` / `PREPAID_EXPENSE` early-return branches in
  `ruleNatureAssetExcluded` and the `REPAIR_AND_MAINTENANCE`
  capitalisation-evidence branch are dead code.
- **Responsibility:** POOL only. Single, well-scoped effect: admits ASSET
  accounts into the eligible pool when treatment says asset-family;
  excludes ASSET when treatment says operating.

**Verdict — `expectedDebitRole` is SINGLE-PURPOSE and correctly narrow.**
Extending it to the other 8 values (as attempted J-A composition did)
does not violate its responsibility contract but has zero downstream
effect because no other consumer reads those values. Widening on its
own is architecturally clean but behaviourally null on the current
sealed corpus.

**Also:** the local narrower type `ExpectedDebitRoleLocal` at
[canonical-runtime-facade.ts:44](../src/lib/ap-intelligence/canonical-runtime-facade.ts#L44)
currently pins to 3 values — matching the live producer set. The J-A
widening of this type (attempted) was cosmetic; the facade's local type
is the honest reflection of runtime behaviour.

---

## 4 · Exact `completed-capital-improvement` 39→2 cascade

**Observed:** Under J-A attempt 1 (composed `natureLeader` fed to
`globalSignals.natureLeader` / `natureIsDefensible`), the canonical
winner 1530 (Course Improvements, ASSET) score dropped from **39 to 2**
on a case whose winner and treatment were already correct pre-J-A.

**Static-analysis reconstruction** (from the codebase, without live
instrumentation):

Pre-J-A input to ranker `globalSignals` for this case:
- `natureLeader = natureForCanonical.leader` — accounting-nature classifier's
  own verdict. For this invoice ("bunker rebuild — placed in service —
  final invoice"), the anti-term regexes at
  [accounting-nature.ts:196-228](../src/lib/ap-intelligence/accounting-nature.ts#L196)
  ("placed in service", "final invoice", "substantial completion",
  "project closed") STRIP the R&M raw score. CAPITAL_ASSET strong terms
  are line-item-gated and don't hit ordinary rebuild wording. Most
  likely leader = `UNKNOWN` (base state) OR `OPERATING_EXPENSE` at
  score < 20 → `natureIsDefensible = false`.

Post-J-A attempt 1:
- Composed `natureLeader = "CAPITAL_ASSET"` (forced by composition
  rule 1: `capitalState === "CAPITAL"`).
- Composed `natureIsDefensible = true`.

**Direct effects at each of the 9 natureLeader consumers:**

| Site | Pre → Post | Effect on 1530 |
|------|:---:|---|
| N1 canonical-ranker EVIDENCE | Silent → NATURE_COMPAT `+15` fires | +15 in CAPITAL_NATURE family but MAX = +20 (CAPITAL_ASSET_MATCH still wins). Family unchanged. |
| N2 nature-scoped discovery | Early-return (defensible=false) → **potentially fires** if `natureConfidence >= 20` | `natureConfidence` still raw. If raw < 20: unchanged. If raw ≥ 20: emits every ASSET-family account whose category/fsGroup/name matches `NATURE_COMPAT["CAPITAL_ASSET"]`. New candidates ADDED to competition. |
| N3 nature-scoped-direct | Same gate as N2 | Same as N2. |
| N4 purpose-driven-direct | passes `nature = "CAPITAL_ASSET"` defensible into legacy ranker | Legacy ranker's `rankPurposeDrivenAccounts` returns candidates in different order and possibly with different contradictions. Only candidate list survives → **potentially adds new candidates**. |
| N5 legacy ranker EVIDENCE | Same as N1 but on discarded score | No canonical effect. |
| N6 semantic-match-gate | Non-runtime | No effect. |
| N7 workflow-policy | Nature class routing changed to CAPITAL_TRANSACTION | Doesn't affect ranker score. |
| N8 expectedDebitRole via preNature | Was already CAPITAL_ASSET (capital.state = CAPITAL) | Unchanged. |
| N9 capitalDecision derivation | `natureForCanonical.leader !== "REPAIR_AND_MAINTENANCE"` → falls to `capital.state` branch → CAPITAL_CANDIDATE. **Unchanged.** But now composed leader = CAPITAL_ASSET. **Semantics unchanged for this case.** |

**Best-supported hypothesis** (not fully verified without live
instrumentation): the drop came from **N2/N3/N4 pool widening**. When
composition forced defensibility, discovery providers that gated on
`natureIsDefensible` emitted a broader ASSET-family candidate set. Those
new candidates entered the CLUSTER-level canonical ranker with strong
name-substring matches for the invoice's project-completion vocabulary
(e.g. specific renovation/construction-family accounts on the seed COA)
and either:
- outscored 1530 through TRANSACTION_TEXT / TAXONOMY_ALIGNMENT paths
  that 1530 had been winning by default, OR
- shifted the compat-gate `preferredAccountNumbers` /
  `contradictedAccountNumbers` sets such that 1530 lost its
  `NATURE_GATE_PREFERRED (+12)` observation.

The alternative hypothesis — that the ranker's own +NATURE_COMPAT for
1530 was somehow negated by a contradiction — is **inconsistent with
static analysis**: 1530 is ASSET, matches CAPITAL_ASSET's acceptable
types, and no site emits a contradiction against a compatible pairing.

**Actionable conclusion:** the cascade is not in `natureLeader` per se —
it is in the pool-widening consumers **N2/N3/N4** silently reacting to
the field. This is EXACTLY the "hidden coupling" pattern the founder
warned about in §8. Any future consumer of composed treatment MUST NOT
feed a field that these three POOL-widening providers gate on.

**Verifying the hypothesis definitively** would require re-applying the
stash and running the benchmark with per-provider hit logs. That work is
bounded (~30 min) but was not performed in this audit per §12's
"no runtime changes" constraint. It is a candidate first task for the
implementation phase of whichever model is chosen.

---

## 5 · Treatment abstraction value independent of the failed wiring

The `CanonicalAccountingTreatment` abstraction itself — as a *type* and
as a *pure composition function* — has value **independent** of whether
it feeds the ranker directly. Concretely:

1. **Records structural disagreement between classifiers as first-class
   data.** The current pipeline has three treatment-adjacent
   classifiers (`capital-vs-operating`, `accounting-nature`,
   `capital-evidence`) whose contradictions are only observable via
   post-hoc diagnostics. The composition type surfaces contradictions
   explicitly in a shape downstream reasoning can consult.

2. **Distinguishes STRONG / WEAK / UNRESOLVED defensibility.** No
   existing field carries this gradient; `natureIsDefensible` is
   boolean and derived only from the single nature classifier's own
   supporting-evidence count. STRONG requires a positive-evidence
   verdict (capital keyword hit OR defensible nature), WEAK is
   base-state OPERATING (no positive signal, just "no keyword"),
   UNRESOLVED is AMBIGUOUS + non-defensible nature.

3. **Provides `statementRole`** — a 4-value classification
   (`BALANCE_SHEET_CAPITAL_ASSET`, `BALANCE_SHEET_CURRENT_ASSET`,
   `OPERATING_EXPENSE`, `COST_OF_SALES`, `UNKNOWN`) that maps cleanly
   to reporting-layer semantics and is coarser (safer for hierarchy)
   than `natureLeader`'s 11-value enum.

4. **Provenance provides audit** — `winningSource` records which
   classifier drove the verdict, useful for founder-facing explanations.

**The pure composition function** ([diagnostic
treatment-composition.ts](../src/lib/ap-intelligence/treatment-composition.ts)
preserved in stash) has 42 passing unit tests covering every branch. If
Model A / B / C requires a treatment primitive at all, the type + the
function are correct.

**What the failed wiring taught us**:
- The correct architectural layer to consume composed treatment is
  **NOT** `globalSignals.natureLeader`.
- The consumption boundary must be a field that has **exactly one
  responsibility** (POOL, EVIDENCE, or STRUCTURE — pick one) so a
  future change to composition cannot cascade across four consumer
  classes.

---

## 6 · Model A — Treatment as canonical evidence (new bounded contribution)

### Design

Introduce a **new evidence kind** in the CAPITAL_NATURE family (or in a
new family if the founder authorises adding one):

- `ACCOUNT_ROLE_COMPATIBLE (+W_compat)` — fires when composed treatment's
  `statementRole` matches the candidate's structured account role
  (via `Account.accountRole` if backfilled, else via `type + fsGroupKey`
  taxonomy inference).
- `ACCOUNT_ROLE_CONTRADICTION (−W_contra)` — fires when treatment is
  DEFENSIBLE (`STRONG`) and role does NOT match.

Both observations are DEFEASIBLE — only fire when `defensibility === "STRONG"`.
When `defensibility === "WEAK"` or `"UNRESOLVED"`, silent.

### Calibration derivation attempt

The founder's §11 forbids arbitrary calibration. Two anchors exist for
principled derivation:

- **Anchor A**: existing `NATURE_COMPAT_MATCH = +15`. If treatment
  composition is EPISTEMICALLY SIMILAR to defensible nature-classifier
  agreement, `W_compat = 15` would double-dip with the existing NATURE
  observation (both are "role matches"). To avoid double-counting, the
  new evidence would need to REPLACE the existing NATURE_COMPAT rather
  than add to it. That's a scoring redesign, not a bounded addition.
- **Anchor B**: existing `NATURE_INCOMPATIBLE_PENALTY = −18` (net −36 via
  double-dip). Same problem — replacing rather than adding.

**Conclusion:** Model A cannot introduce a NEW bounded contribution
without either double-counting existing signals (double-dip) or
requiring an arbitrary calibration constant. Per founder §11, this is a
STOP condition.

Model A can only be non-arbitrary if it **replaces** existing
NATURE_COMPAT / NATURE_INCOMPATIBLE inside the CAPITAL_NATURE family
using the same weights, sourced from composed treatment instead of raw
`natureLeader`. That's viable but reintroduces the exact 39→2 cascade
risk unless the POOL-widening consumers (N2/N3/N4) are structurally
decoupled from the new field first.

### Can it avoid the completed-capital regression?

Only if:
1. The new field is NEVER read by N2/N3/N4 (discovery providers), AND
2. Composed treatment SUPERSEDES the raw `natureLeader` for the ranker's
   NATURE_COMPAT observation only, AND
3. Raw `natureLeader` continues to feed discovery unchanged.

That splits `natureLeader`'s responsibilities — treatment evidence
consumes composed, POOL widening consumes raw. Achievable but requires
introducing a second parallel field (`composedTreatmentLeader` or
similar) and rewriting the ranker's NATURE_COMPAT logic. Moderate
implementation cost; low ongoing coupling.

### Pros

- Fits the existing evidence-family model — no new families.
- Bounded contribution using existing weights (once double-dip is
  addressed).
- Preserves the flat competition; no ordering change.
- Composition primitive is re-usable for J-B discovery, reporting, and
  founder-facing explanations.

### Cons

- Cannot introduce a NEW contribution without breaking §11.
- Requires splitting `natureLeader` into two parallel fields to avoid
  the cascade — architectural debt.
- Still fundamentally "signals → scores" — doesn't structurally address
  the founder's Phase-7.2H verdict.

---

## 7 · Model B — Hierarchical candidate competition

### Design

Introduce a **candidate cohort tier** before numeric scoring:

```
1. compose(treatment)
2. classify each candidate into a tier based on (composed treatment × account role):
   - Tier 1: PRIMARY_COMPATIBLE — role directly matches statementRole
   - Tier 2: SECONDARY_PLAUSIBLE — role in a related family (e.g. INVENTORY
             candidate when treatment is COST_OF_SALES)
   - Tier 3: CONTRADICTED — role structurally incompatible with treatment
3. Within each tier, run the existing rankCanonical scoring UNMODIFIED
4. Rank order: Tier 1 winners before Tier 2 before Tier 3
5. All tiers remain VISIBLE in candidates[] — the tier is metadata,
   NOT deletion (per founder §2 "not hard filtering")
6. Commit policy:
   - If Tier 1 top score >= COMMIT_MIN_SCORE → RECOMMEND (Tier 1 winner)
   - Else if defensibility is UNRESOLVED, fall back to flat competition
     across all tiers
   - Else ABSTAIN
```

### Pros

- Structurally different from "signals → scores" — treats treatment as
  the competition's ORGANISING PRINCIPLE, not another signal.
- CANDIDATES REMAIN VISIBLE in Tier 3 — no hard filtering (§2).
- The 1250-squatting problem (food-service etc.) is resolved because
  1250 lands in Tier 3 when treatment is defensibly OPERATING_EXPENSE
  and can't win over any Tier 1 candidate that scores at all.
- 1091559 case resolves cleanly: Tier 1 = CAPITAL_ASSET-role accounts
  (1506, 1540); winner picked from within that tier.
- 221178 case resolves cleanly: Tier 1 = OPERATING_EXPENSE role +
  IT/software family; winner picked from within.
- Defeasibility of treatment via `defensibility` field prevents
  UNRESOLVED cases from mis-tiering (fallback to flat competition).

### Cons

- Bigger implementation lift than Model A — requires per-candidate tier
  classification (2-4 hours) plus ranker changes to consume tiers.
- COMMIT_MIN_SCORE semantics may need revisit: what if Tier 1 top score
  is 25 but a Tier 2 candidate scores 60? Founder §11 forbids threshold
  changes — mitigation: Tier 1 threshold stays 30; if Tier 1 fails to
  commit, fall back to flat competition (safe default).
- Introduces a new architectural concept — the "tier" — that must be
  understood by recommendation-policy, canonical-confidence, workflow
  projection, and every consumer of `CanonicalCandidate`.

### Impact on existing single-authority guarantees

- `rankCanonical` REMAINS the sole winner authority — tier is applied
  ABOVE rankCanonical, and the winner is still `candidates[0]` at
  runtime.
- Discovery is unchanged.
- Scoring weights are unchanged.
- Zero new lexical cues.

---

## 8 · Model C — Structured accounting-class retrieval, flat scoring unchanged

### Design

Composed treatment affects **candidate metadata and retrieval breadth**
but not score directly. Concretely:

1. `composeAccountingTreatment` produces the composed treatment (as
   already implemented in the stashed module).
2. A **new discovery provider** `treatmentAwareRetrieval` consumes
   composed treatment + `statementRole` + `defensibility` to emit
   candidates that structurally match the treatment (via
   `fsGroupKey` / `Account.accountRole` / `type` — not name substring).
3. Each candidate carries a `treatmentAlignment` metadata field:
   `PRIMARY` (structural match), `SECONDARY` (related family), or
   `NONE` (no structural relation).
4. Canonical ranker CONSUMES `treatmentAlignment` as a new EVIDENCE kind
   inside the TAXONOMY_ALIGNMENT family (not CAPITAL_NATURE — to avoid
   the natureLeader coupling) — using the EXISTING
   `FS_GROUP_TAXONOMY_MAX = 15` weight (already bounded, no new weight).
5. The MAX-within-family collapse ensures no double-dip with the
   existing FS_GROUP_TAXONOMY observation.

### Pros

- Zero coupling with `natureLeader` — treatment flows through a
  parallel channel.
- Uses existing weights (FS_GROUP_TAXONOMY_MAX = 15).
- Naturally addresses R4 (discovery) issues: software-intangible /
  prepaid-insurance / building-acquisition get first-class retrieval
  based on structured account taxonomy, not name substrings.
- Composition primitive reused between J-A and J-B — the founder's
  §11's convergence goal.
- No ordering / policy / commit changes.

### Cons

- Requires accounts to have `accountRole` (or `fsGroupKey`) populated
  correctly on the seed COA. On Coulee Ridge some accounts may be
  under-tagged.
- Does NOT directly address the 1250-squatting problem (food-service):
  1250 has an fsGroupKey that matches "food/inventory" — it would still
  receive a positive TAXONOMY signal. Unless the treatment-aware
  retrieval provider EXCLUDES 1250 from its Tier 1 emission (still no
  hard filter, but no positive treatment-alignment observation), 1250
  keeps competing.
- Does not fully solve the founder's §3B role-contradiction desire —
  treatment can only ADD positive evidence on aligned candidates; there
  is no path to CONTRADICT misaligned candidates without either a new
  weight (forbidden §11) or replacing an existing contradiction (moves
  us back to Model A's cascade risk).

---

## 9 · Pros/cons summary

| Model | Structural change | New weight? | Solves 1250 leak? | Solves 1091559 / 221178? | Cascade risk | Impl scope |
|-------|:---:|:---:|:---:|:---:|:---:|:---:|
| **A** — treatment as evidence | No | Yes (blocked §11) OR replace existing | Partial (via contradiction on defensible treatment) | Partial | HIGH — natureLeader must be split | Small once split, but split is architectural |
| **B** — hierarchical tiers | **Yes** — competition structure | No | **Yes** (Tier 3 loses to Tier 1) | **Yes** | Low (tier isolated) | Moderate — 6-10 hours |
| **C** — structured retrieval | No | No | Partial | **Yes for retrieval; scoring imbalance remains** | Low | Small — 3-4 hours |

**Model B is the most structurally ambitious and the only model that
addresses the founder's Phase-7.2H verdict** ("Spectre still
fundamentally operates as signals → account scores"). It reframes
canonical competition around treatment first, evidence second.

**Model C is the safest incremental step.** It cleanly addresses R4
(discovery) without touching scoring, and is compatible with a future
Model B upgrade.

**Model A** as originally sketched is not viable under §11 without
either splitting `natureLeader` (structural debt) or breaking a
LOCKED-baseline (as attempt-1 demonstrated).

---

## 10 · 1091559 mapped through each model

**Human reasoning:** durable equipment (fixtures — grounds) → acquisition
→ capital asset treatment → equipment fixed-asset class → account 1506
(Equipment & Fixtures — Grounds).

**Current state (post-7.2I-b):**
- Composed treatment (from I-b) = CAPITAL_ASSET; 1506 admitted to pool.
- Canonical score for 1506 = 3 (top-1 by ordering, below COMMIT_MIN).
- Root: 1506 receives ONLY CAPITAL_ASSET_MATCH (+20) and NATURE_COMPAT
  (+15) — CAPITAL_NATURE MAX = +20. Nothing else fires because the
  invoice's line-item text ("Equipment & fixtures — grounds") doesn't
  match any purpose ontology substring.

**Model A** (treatment as evidence): +ACCOUNT_ROLE_COMPATIBLE would
already fire because 1506 is ASSET matching CAPITAL_ASSET statement
role — but it MAX-collapses with existing NATURE_COMPAT. Net effect on
1506 = 0 additional score. **Not fixed.**

**Model B** (hierarchical tiers): 1506 lands in Tier 1 (PRIMARY_COMPATIBLE
with CAPITAL_ASSET treatment). Tier 1 competition includes 1506 vs
1540 vs other capital-asset accounts. 1506 wins Tier 1 by ordering /
minimal score. Because Tier 1 candidates exist AND treatment is
STRONG-defensible, commit policy could either (a) commit at reduced
threshold within Tier 1 (would need founder authorisation to lower
threshold — §11 forbids) or (b) abstain but present 1506 as the top
recommendation. **Structurally correct; commit outcome depends on
threshold policy.**

**Model C** (structured retrieval): `treatmentAwareRetrieval` emits 1506
as PRIMARY (fsGroupKey / accountRole match). New TAXONOMY_ALIGNMENT
observation for 1506 fires at +15. MAX-collapses with existing family
signals. Depending on existing TAXONOMY signals may add +5 to +15.
**Partial fix — helps but likely still below commit floor without
additional evidence.**

---

## 11 · 221178 mapped through each model

**Human reasoning:** SaaS online backup license/service → operating
service treatment → IT/software class → account 6054 (Computer & IT
Services).

**Current state (post-7.2I-a):**
- SOFTWARE_SUBSCRIPTION purpose commits (conf 96).
- 6054 receives ~0 targeted evidence — `conceptRelatedness(SOFTWARE_SUBSCRIPTION,
  IT_SERVICES) = 0` in ontology tree; 7.2I-a introduced fs-group
  affinity (+35) which relates them cross-tree.

**Model A** (treatment as evidence): composed treatment =
OPERATING_EXPENSE (statement role) via strong operating verdict from
"monthly service" keyword. +ACCOUNT_ROLE_COMPATIBLE fires on 6054
(EXPENSE matches). MAX-collapse with existing NATURE_COMPAT. Net = 0
additional. **Not fixed.**

**Model B** (hierarchical tiers): Tier 1 = all EXPENSE-role accounts
matching statement role OPERATING_EXPENSE. 6054 lands in Tier 1.
Competition inside Tier 1 between 6054 vs 6020 vs 6031 vs 6072 etc.
6054 winning depends on TRANSACTION_TEXT + TAXONOMY family scoring
within the tier. The tier removes ASSET distractions but does NOT
solve 6054's low targeted evidence. **Structurally correct but
committing 6054 as winner within Tier 1 depends on 6054 scoring above
Tier 1 siblings.** The 7.2I-a fs-group affinity fix already elevated
this.

**Model C** (structured retrieval): `treatmentAwareRetrieval` emits
6054 as PRIMARY when statementRole = OPERATING_EXPENSE AND
`fsGroupKey = IS_IT_SOFTWARE`. New TAXONOMY_ALIGNMENT observation +15.
MAX-collapses with existing FS_GROUP_TAXONOMY. Net effect depends
on the current FS_GROUP_TAXONOMY contribution for 6054. **Partial fix.**

---

## 12-15 · Impacts on existing guarantees

**Single-authority (Model B):**
- `rankCanonical` remains the sole winner-selection authority within a
  tier and across tiers.
- Tier assignment is pre-ranker metadata, deterministically derived
  from composed treatment + candidate role.
- No new winner competition.

**Candidate recall:**
- Model A: unchanged (no candidates added or removed).
- Model B: unchanged at retrieval; Tier 3 candidates still visible.
- Model C: candidate recall INCREASES (new retrieval provider) — must
  be validated for regression on cases where widening produced 1250-squatting.

**Safety / abstention (all models):**
- Zero-unsafe floor is preserved as long as tier-1-commit policy uses
  the same `COMMIT_MIN_SCORE`.
- Model B: falls back to flat competition when defensibility is
  UNRESOLVED — preserves current abstention behaviour on ambiguous
  cases.
- Founder-mandated LOCKED cases (`completed-capital-improvement`,
  `statement-of-account`, `dmm-energy-fuel`, `pathological-vendor-
  default-contra`, `vague-body-invoice-attachment`): must be validated
  under each model.

**Migration risk:**
- Model A: HIGH — requires splitting `natureLeader` responsibilities.
- Model B: MEDIUM — new architectural concept, all consumers of
  `CanonicalCandidate` unaffected because tier is metadata.
- Model C: LOW — one new discovery provider + one new evidence kind.

**Modules that become simpler / redundant:**
- Under **B**: `NATURE_INCOMPATIBLE_PENALTY` becomes redundant (tiering
  supersedes) — could be removed after B lands.
- Under **B**: nature-scoped POOL-widening discovery providers
  (`natureScopedDiscovery` / `natureScopedDirectDiscovery`) may become
  unnecessary — Tier 1 assignment covers the same need. Consolidation
  opportunity.
- Under **C**: the multi-provider discovery layer partially converges —
  the treatment-aware provider can subsume some N2/N3/N4 emissions.

**Implementation scope estimates:**
- Model A: 4-6 hours (composition + evidence kind + splitting
  natureLeader).
- Model B: 6-10 hours (tier classifier + rankCanonical changes +
  policy update + regression tests + benchmark).
- Model C: 3-4 hours (new provider + new evidence kind + tests +
  benchmark).

---

## 16-19 · Recommendation

**Recommendation: Model B, staged behind Model C.**

**Rationale:**

The founder's Phase-7.2H verdict is correct: incremental additions to
the flat "signals → score" ranker are producing diminishing returns.
Model B is the only architecture that reframes canonical competition
around accounting treatment as an ORGANISING PRINCIPLE rather than
another signal — and it does so WITHOUT hard filtering, WITHOUT new
weights, and WITHOUT breaking the single-authority guarantee.

Model C is compatible with Model B and offers the safest first
implementation step — a new treatment-aware discovery provider is a
purely additive change that can land, benchmark, and be measured
before any structural change to the ranker's competition organisation.

**Rejected alternatives:**

- **Model A** as originally sketched — cannot introduce a new bounded
  contribution without either §11 calibration or splitting
  `natureLeader` (structural debt).
- **Continued signal-tuning** — Phase 7.2H-J-A evidence shows this
  path has produced no material R2/R4 movement; further additions
  will not converge.
- **Doing nothing** — the R2/R4 gap remains at 13 of 21 failures.
  Structural repair is the appropriate response.

---

## 20 · Proposed next bounded implementation phase

**Phase 7.2K — Structured treatment-aware retrieval (Model C first)**

Scope (bounded):

1. Restore the `treatment-composition.ts` module from stash@{0} onto
   `refactor/gl-single-authority` as a new commit (module + 42 tests).
   NO wiring changes.
2. Introduce a new discovery provider `treatmentAwareRetrieval`
   ([candidate-discovery/providers/treatment-aware.ts]) that:
   - Consumes `CanonicalAccountingTreatment`.
   - Emits candidates whose structured role (`accountRole` if
     populated, else `type` + `fsGroupKey` taxonomy inference) matches
     the composed `statementRole`.
   - Attaches metadata `treatmentAlignment: "PRIMARY"` on each hit.
3. Extend `AccountView` / `DiscoveryHit` to carry
   `treatmentAlignment` metadata (optional field, defaults `null`).
4. Add a new bounded evidence kind
   `TREATMENT_ALIGNMENT_TAXONOMY_MATCH` in the TAXONOMY_ALIGNMENT
   family, reusing the existing `FS_GROUP_TAXONOMY_MAX = 15` weight
   (no new calibration).
5. Extensive regression: all founder-LOCKED cases
   (completed-capital-improvement, statement-of-account,
   dmm-energy-fuel, pathological-vendor-default-contra,
   vague-body-invoice-attachment) must remain byte-identical.
6. Benchmark before/after; unsafe = 0.

Success criteria:
- R4 count materially reduced (target: 6 → 3 or fewer on sealed corpus).
- R2 count unchanged (Model C doesn't address 1250 squatting).
- Unsafe = 0.
- Zero LOCKED-case regressions.

**Phase 7.2L — Hierarchical candidate competition (Model B) — deferred**

Only authorise 7.2L after 7.2K lands and its impact is measured.
7.2L is the structural repair that addresses the R2 leak; 7.2K
provides both the composition primitive and the field-level metadata
that 7.2L will consume.

---

**Delivery status:** all 20 audit items complete. No runtime changes.
Stash@{0} preserved. Recommendation is Model C first (Phase 7.2K),
Model B (Phase 7.2L) staged after — pending founder authorisation.

Not staged. Not merged. No production deploy.

# Phase 4R · Unified Ranker Scoring Semantics + Consolidation Design

**Purpose (founder §5):** analyse the two current ranking systems' scoring semantics BEFORE writing the unified ranker. Document correlation / double-counting risks. Establish the harmonised scoring model that the canonical ranker will implement.

**Sources analysed:**
- [src/lib/ap-intelligence/gl-recommend.ts](../src/lib/ap-intelligence/gl-recommend.ts) — Pipeline A (`rankAccountsPure` inside `recommendGlAccount`)
- [src/lib/ap-intelligence/purpose-driven-ranker.ts](../src/lib/ap-intelligence/purpose-driven-ranker.ts) — Pipeline B (`rankPurposeDrivenAccounts`)

---

## 1 · Pipeline A — `rankAccountsPure` (via `recommendGlAccount`)

### 1.1 Candidate universe

- **Source**: `prisma.account.findMany({ where: { clubId } })` — full tenant COA. [gl-recommend.ts:246-253](../src/lib/ap-intelligence/gl-recommend.ts#L246-L253).
- **Pre-filter (Phase-2 eligibility)**: `filterEligibleAccounts()` applies structural rules (control / bank / cash / revenue / equity / liability / contra-asset / normal-balance contradiction) AND nature-conditioned rules (asset excluded from ordinary operating AP unless capitalization evidence). [gl-recommend.ts:299-303](../src/lib/ap-intelligence/gl-recommend.ts#L299-L303).
- **Legacy fallback** (when `AP_INTELLIGENCE_PHASE2_ELIGIBILITY` env off): `isActive && !isHeader && type in {EXPENSE, ASSET}`.
- **Empty-recommendation exits** (return `emptyRecommendation()` with `candidates: []`):
  - Line 254-255: `accountsRaw.length === 0` (no COA loaded)
  - Line 344-350: `noEvidenceProvided` (no extraction vendor + no line items + no purpose candidates + no vendorId)
  - Line 405-411: `zeroEvidenceEverywhere` (`queryConcepts.length === 0` OR all candidates scored 0) ← **novel_vendor path**
  - Line 428-432: `!top` (no eligible expense/asset accounts survive)

**Root cause for `novel_vendor NO_CANDIDATES`**: line 405-411. When Zephyr Grounds Solutions invoicing "Aerator equipment quarterly service" doesn't produce any query concept that matches any tenant account concept, `zeroEvidenceEverywhere` fires and Pipeline A returns empty candidates. Pipeline B then independently backfills a winner into `gl.accountNumber` via the analyse.ts:1583 override.

### 1.2 Signals + weights

For each account, `scoreAccount()` computes 10 components:

| Component | Source | Formula | Range | Notes |
|---|---|---|---|---|
| `directLineMatch` | qc.source = `line_item_description` | `Σ (qc.weight × ac.totalMatchStrength × rel) / (100 × 33)` | 0..∞ (unbounded) | one contribution per query concept, using best account-concept match |
| `economicPurposeMatch` | qc.source = `economic_purpose` | same formula | 0..∞ | |
| `documentPhraseScore` | qc.source = `document_phrase` | same formula | 0..∞ | |
| `historicalVendorScore` | qc.source = `vendor_history` | same formula | 0..∞ | plus explicit `historicalVendorScore += 15` when `account.id === vendorDefaultAccountId` [line 609+] |
| `supplierContextScore` | qc.source = `supplier_identity` | same formula | 0..∞ | |
| `accountNameSimilarity` | dominant query concept × account concepts | `Σ (ac.nameMatchStrength × rel) / 100` | 0..100 typical | reads account NAME tokens |
| `fsGroupTaxonomySimilarity` | dominant query concept × account concepts | `Σ (ac.fsGroupMatchStrength × rel) / 100` | 0..100 typical | |
| `categoryTaxonomySimilarity` | dominant query concept × account concepts | `Σ (ac.categoryMatchStrength × rel) / 100` | 0..100 typical | |
| `specificityScore` | when `rel === 100 && concept.depth >= 2` | `+ SPECIFICITY_BONUS_PER_DEPTH × (depth - 1)` | small (~5-15) | rewards deeper concept match |
| `contradictionPenalty` | qc.weight ≥ 6 AND `isContradiction(qc, ac)` | `+ CONTRADICTION_PENALTY` per hit | positive integer | subtracted at final |

**Final semanticScore** (line 632-644):
```
semanticScore = max(0, round(
    directLineMatch
  + economicPurposeMatch
  + accountNameSimilarity
  + fsGroupTaxonomySimilarity * 0.5
  + categoryTaxonomySimilarity * 0.3
  + documentPhraseScore
  + specificityScore
  + historicalVendorScore
  + supplierContextScore
  - contradictionPenalty
))
```

**Range**: unbounded upper, floor at 0. Empirically the winner's semanticScore is typically 20-95 (capped at 95 for `confidence` presentation).

### 1.3 Evidence emission

- Per query concept with `bestContribution > 0`: emit `evidence.push({ kind, description, score: round(bestContribution) })`.
- Kind is derived from `qc.source`:
  - `line_item_description` → `LINE_ITEM_MATCH`
  - `economic_purpose` → `ECONOMIC_PURPOSE`
  - `document_phrase` → `DOCUMENT_PHRASE`
  - `vendor_history` → `PRIOR_CODING`
  - anything else → `NAME_KEYWORD`
- Per contradiction: emit `evidence.push({ kind: "CONTRADICTION_PENALTY", ..., score: -CONTRADICTION_PENALTY })`.
- `evidence.slice(0, 6)` capped in `finaliseRecommendation()`.

### 1.4 Winner selection

Line 424-473. Sort scored accounts by `semanticScore` desc, take top. If `top.semanticScore < MIN_RELEVANCE_THRESHOLD` → `requiresReview: true` but still returned as winner. If `requiresReview` and top is nonpostable, still winner. Final winner = `topCandidates[0]` per the current `finaliseRecommendation()` construction — INVARIANT HOLDS at Pipeline A's boundary.

---

## 2 · Pipeline B — `rankPurposeDrivenAccounts`

### 2.1 Candidate universe

- **Input**: pre-filtered `eligibleAccounts: ReadonlyArray<AccountEligibilityView>` — same Phase-2 eligibility filter as Pipeline A (`filterEligibleAccounts()`).
- **Purpose gate**: `if (!input.purposeDecision.concept) return { candidates: [], winner: null }` — no committed purpose, no ranking. [purpose-driven-ranker.ts:165-171](../src/lib/ap-intelligence/purpose-driven-ranker.ts#L165-L171).
- **No additional pre-filter**: iterates all eligible accounts and scores them all.

### 2.2 Signals + weights

For each account, `scored.push()` accumulates 8 components:

| Component | Source | Weight | Notes |
|---|---|---|---|
| `purposeCompat` | `PURPOSE_ACCOUNT_TYPE[concept]` type match | `+20` match, `-5` mismatch | purposeCategoryHints adds `+15` if categoryKey matches |
| `ontologyMatch` | `evaluatePurposeAccountAffinity(concept, account.name)` | `+25` | §2 amendment: BOOST, not filter |
| `natureCompat` | `ACCEPTABLE_TYPES_BY_NATURE[natureLeader]` | `+15` match, `-20` mismatch when defensible | |
| `accountRoleMatch` | `purposeExpectedRoles(concept).includes(accountRole)` | `+10` | reads `Account.accountRole` |
| `departmentAffinity` | `departmentAccountNamePatterns.some(p => p.test(account.name))` | `+12` | department-token pattern match on account name |
| `lineItemJaccard` | Jaccard(canonicalLineItem tokens, account.name tokens) | `+round(jaccard × 20)` | max +20 |
| `vendorHistoryBoost` | `vendorHistoryPreferredAccountNumbers.includes(accountNumber)` | `+6` | capped |
| `capitalNatureBoost` | capitalDecision × account type/name/category | `+22` / `+8` boost or `-30` / `-14` penalty | fires only when `capitalDecisionConfidence >= 40` |

Non-postable / inactive → `W_NON_POSTABLE_PENALTY = -100` / `W_INACTIVE_PENALTY = -100` (effectively removes).

**Total score**: additive sum of all components.

**COMMIT_MIN_SCORE = 45** — a winner only "promotes" if it scores ≥ 45. Below that, `winner: null`.

### 2.3 Evidence emission

None. Pipeline B does NOT emit `GlEvidence[]`-shaped evidence. Its `PurposeDrivenScoredAccount` records `components` (per-signal contribution) and `contradictions: string[]` (short reason codes). The [analyse.ts:1583](../src/lib/ap-intelligence/analyse.ts#L1583) override then rewrites `gl.accountNumber` but the winning account has ZERO evidence in `gl.candidates` — because Pipeline B's candidates are discarded entirely.

### 2.4 Winner selection

Sort by total desc. If top score ≥ 45, top wins. If `input.purposeDecision.concept == null`, no winner.

---

## 3 · Correlation + double-counting analysis (founder §7)

The same invoice observation can generate multiple scoring signals across the two pipelines. Naïvely summing scores would count one accounting fact several times.

### 3.1 A single line-item phrase produces (at minimum):

For **"Aerator equipment quarterly service"** on a novel-vendor invoice:

| Signal | Pipeline | Contribution mechanism | Independent of other signals? |
|---|---|---|---|
| Query concept `equipment` from line-item description | A | qc.source=line_item_description → `directLineMatch` bucket | ✗ derivative of the phrase |
| Query concept `service` from line-item description | A | qc.source=line_item_description → `directLineMatch` bucket | ✗ derivative of the phrase |
| Economic-purpose `CAPITAL_EQUIPMENT` or `REPAIR_MAINTENANCE` | A | qc.source=economic_purpose → `economicPurposeMatch` bucket | ✗ inferred FROM the phrase |
| Account-name similarity vs "R & M - Ground Equipment" | A | dominant × ac.nameMatchStrength → `accountNameSimilarity` | ✗ correlated with line-item token overlap |
| fs-group taxonomy similarity → `IS_REPAIRS_MAINTENANCE` | A | dominant × ac.fsGroupMatchStrength × 0.5 → `fsGroupTaxonomySimilarity` | ✗ correlated with dominant concept |
| Pipeline B `purposeCompat` for `REPAIR_MAINTENANCE` → EXPENSE | B | `+20` | ✗ same purpose signal as A's economicPurposeMatch |
| Pipeline B `ontologyMatch` on "Ground Equipment" name | B | `+25` | ✗ correlated with A's accountNameSimilarity |
| Pipeline B `lineItemJaccard` between "aerator equipment quarterly service" and "R & M - Ground Equipment" | B | +round(jaccard × 20) | ✗ correlated with A's directLineMatch |
| Pipeline B `departmentAffinity` if Grounds department pattern | B | `+12` | ✗ correlated with fs-group taxonomy |
| Pipeline B `capitalNatureBoost` (asset match when CAPITAL_CANDIDATE OR R&M expense match when REPAIR_MAINTENANCE) | B | `+22` (with `+8` category bonus) | somewhat independent — reflects capital DECISION, not text |

**Key finding**: 8-10 signals in the two pipelines are largely CORRELATED DERIVATIVES of the same phrase. Summing them naïvely would inflate a single observation to 100+ points.

### 3.2 Genuinely independent signals

Signals that carry independent information:
- `historicalVendorScore` / `vendorHistoryBoost` — depends on the tenant's prior coding, independent of the invoice text
- `capitalNatureBoost` — depends on the capital classifier's separate decision (via `CapitalEvidenceDecision`)
- `contradictionPenalty` — negative, reflects incompatibility with committed purpose
- `accountRoleMatch` — depends on the account's `accountRole` metadata, independent of text
- `departmentAffinity` (Pipeline B) IF driven by a document DIFFERENT from the account name (e.g. department inference from vendor name)

### 3.3 Consolidation rules

**Rule 1 — evidence family, not signal:** The unified ranker organises signals into 5 evidence FAMILIES that reflect independent information sources:

| Family | Represents | Contributing signals |
|---|---|---|
| `TRANSACTION_TEXT` | line items + document phrases + phrase-derived concepts | A.directLineMatch + A.economicPurposeMatch + A.documentPhraseScore + B.purposeCompat + B.ontologyMatch + B.lineItemJaccard |
| `TAXONOMY_ALIGNMENT` | account-side taxonomy match to the transaction | A.accountNameSimilarity + A.fsGroupTaxonomySimilarity + A.categoryTaxonomySimilarity |
| `NATURE_ROLE` | capital vs operating + account role | A.specificityScore + B.natureCompat + B.accountRoleMatch + B.capitalNatureBoost |
| `VENDOR_HISTORY` | tenant's prior coding + vendor-default | A.historicalVendorScore + B.vendorHistoryBoost + A.supplierContextScore |
| `DEPARTMENT_CONTEXT` | organisational beneficiary | B.departmentAffinity |

**Rule 2 — within a family, take the MAX (not sum):** Correlated signals within a family collapse to their strongest observation. This eliminates the double-counting problem.

**Rule 3 — across families, sum:** The 5 families ARE independent information sources; their contributions sum to the candidate's total.

**Rule 4 — contradictions are cross-family:** `A.contradictionPenalty` + `B.contradictions` add up (they can fire from different observations) with a shared penalty scale.

**Rule 5 — canonical score = 0..100:** unified score normalised so a "clearly correct" recommendation lands in 60-90 range, "genuinely ambiguous" 40-60, "weak" 20-40, "no evidence" <20. Below the commit floor → recommend `ABSTAIN`, but the candidate list still exists with candidates[0] intact.

### 3.4 Correlation-avoidance validation

The Phase 2 unit tests will construct synthetic scenarios where two correlated signals are ON simultaneously and prove the unified score DID NOT double-count. Specifically:
- Same invoice text produces LINE_ITEM_MATCH + ONTOLOGY_MATCH + JACCARD_MATCH → all in `TRANSACTION_TEXT` family → max, not sum.
- Account-name string tokens correlated with line-item tokens → `TAXONOMY_ALIGNMENT` MAX rather than duplicate contribution.

---

## 4 · Winner semantics

Pipeline A's winner = `topCandidates[0]` (invariant holds internally). Pipeline B's winner = the highest-scored `PurposeDrivenScoredAccount` ≥ 45 (invariant holds internally). **The runtime violation happens at [analyse.ts:1583](../src/lib/ap-intelligence/analyse.ts#L1583)**: Pipeline B's winner overrides `gl.accountNumber` without updating `gl.candidates` (which came from Pipeline A).

The unified ranker's winner = `rankedCandidates[0]` **by construction** — the type contract makes divergence structurally impossible (see canonical types design in Phase 2.2).

## 5 · Candidate retention

The novel-vendor NO_CANDIDATES case (Pipeline A `emptyRecommendation()` returning `candidates: []` + Pipeline B backfill) is resolved by the unified ranker in one of two ways depending on the outcome:

- **Recommendation state:**  the ranker produced a winner from the unified evidence. `rankedCandidates[0]` is the winner; other candidates trail. INVARIANT_HOLDS.
- **Abstention state:** no candidate meets the commit threshold. Return `rankedCandidates` sorted by score with `winner === rankedCandidates[0]` but `recommendationStatus === "ABSTAIN"`. The invariant STILL holds; abstention is a separate policy decision (§9), not a candidate-empty state.
- **No-eligible-candidates state:** `filterEligibleAccounts` produced zero candidates. Return `NoEligibleCandidates` discriminated variant of the result union (§7 — do not collapse into `accountNumber: null` with empty array).

---

## 6 · Consolidation strategy (implementation plan for Phase 2.3)

1. **Preserve existing scoring primitives** — Pipeline A's `conceptRelatedness`, `extractConceptsForAccount`, `extractQueryConcepts`, contradiction logic. Pipeline B's `PURPOSE_ACCOUNT_TYPE`, `PURPOSE_CATEGORY_HINTS`, `evaluatePurposeAccountAffinity`, `tokenize` Jaccard.
2. **New `rankCanonical()` function** in `src/lib/ap-intelligence/canonical-ranker.ts` that:
   - Accepts a `CanonicalRankerInput` (defined in Phase 2.2)
   - Applies Phase-2 eligibility (reuses `filterEligibleAccounts`)
   - Computes 5 evidence-family contributions per candidate using the max-within-family / sum-across-families rules
   - Applies contradiction penalties (from both A and B sources)
   - Emits `CanonicalEvidence[]` per candidate with `role: "DECISION" | "DIAGNOSTIC"` (empirical threshold TBD in Phase 4)
   - Sorts candidates by canonical score
   - Returns a `CanonicalRankerResult` discriminated union enforcing `winner === candidates[0]`
3. **Compatibility wrappers** — `recommendGlAccount()` and `rankPurposeDrivenAccounts()` continue to exist as `@deprecated` shims, delegating to `rankCanonical()` under the hood. This lets Phase 3 migrate override sites one at a time without a big-bang runtime cutover.
4. **Wrappers removed in Phase 5 or later** when all callers have moved to `rankCanonical()` directly.

---

## 7 · Explicit non-goals for Phase 2

- Do NOT change `analyse.ts` orchestration. The 10 override sites remain during Phase 2. Runtime behaviour on staging is unchanged.
- Do NOT change per-cluster allocation ranking (Phase 5).
- Do NOT introduce evidence roles (`DECISION` vs `DIAGNOSTIC`) yet — Phase 4 derives the rule from empirical evidence via the synthetic matrix; premature choice violates §10.
- Do NOT introduce new ontology, new concepts, or new taxonomies.
- Do NOT deploy.

Phase 2 exit gate:
- `rankCanonical()` implemented and unit-tested.
- Correlation-avoidance validated by targeted tests.
- Existing ranker suites (`c15u-recommender-ranking`, `c15q-gl-recommend-taxonomy`, `phase4-final-purpose-evidence-hierarchy`, `phase4-slice5-canonical-line-items`) pass — either unchanged or migrated with documented semantic-change justification.
- Typecheck clean.
- `analyse.ts` unchanged. Phase 1 invariant suite STILL RED on the same 4 tests (because the runtime still calls the dual pipelines). Static architectural guard STILL reports 10 override sites.
- Distinction made clear in the Phase 2 checkpoint: **canonical engine invariant established** (the ranker cannot produce winner ≠ candidates[0] by construction) ≠ **runtime single-authority invariant established** (analyse.ts still allows post-ranking mutation).

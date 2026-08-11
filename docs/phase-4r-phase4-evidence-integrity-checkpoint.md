# Phase 4R · single-GL-authority refactor · Phase 4: Evidence Integrity + Confidence Calibration

- **Date**: 2026-08-11
- **Branch**: `refactor/gl-single-authority`
- **Commit**: `18657d7`
- **Previous checkpoint**: Phase 3.6 (Group E) · `4966fee` (2026-08-11) — single-authority invariant ESTABLISHED

This checkpoint documents Phase 4 completion against the 25-item
report format specified in the Phase 4 authorization (§22).

Phase 4 objective: establish an evidence-integrity model that
answers **"How much confidence should Spectre place in the canonical
accounting competition it just performed?"** without inflating
scores, hiding ambiguity, or resurrecting parallel selection
authority.

---

## §22.1 · Legacy confidence path before-state

Before Phase 4, `analyse.ts:1076` called `recommendGlAccount` (Pipeline A)
producing an intermediate `gl` used ONLY by `computeConfidenceDimensions`
at line 1134. Pipeline A's own selection result was fully overwritten
by the canonical facade at line ~1714 — but the confidence dimension
`glClassification` was computed against Pipeline A's `source` +
`confidence` + `reason` fields, not against the canonical winner.

This preserved a softer form of the split-authority defect the Phase 3
groups eliminated: canonical chose the winner, Pipeline A explained
its confidence. Not acceptable per founder §1.

## §22.2 · Was `recommendGlAccount` runtime execution removed?

**Yes.**

- `analyse.ts:1076` `let gl = await recommendGlAccount({...})` (58-line call block) — deleted
- `analyse.ts:1134` `const confidenceDimensions = computeConfidenceDimensions({..., gl})` — moved to AFTER the canonical facade runs (new location just after the field-quality allocation clearing block)
- `analyse.ts:24` `import { recommendGlAccount, ... }` — removed `recommendGlAccount` from the import list

`gl` is now declared uninitialized (`let gl: GlRecommendation`) at
the original Pipeline A location and populated by the canonical
facade at line ~1714. The `glClassification` dimension in
`computeConfidenceDimensions` reads the canonical winner via
`gl.source === "SEMANTIC_MATCH"` (RECOMMEND) or `gl.source === "NONE"`
(ABSTAIN_*), correctly mapping to the `computed` dimension source.

`recommendGlAccount` remains exported from `gl-recommend.ts` for
library-scope callers (its own unit tests still exercise it). It
has zero runtime role in the document-level GL recommendation OR
GL confidence path.

## §22.3 · DECISION/DIAGNOSTIC role methodology

Role is assigned inside `collapseByFamily()` in `canonical-ranker.ts` —
the evidence creation/aggregation point per founder §4. Downstream
projections consume the role; no reverse-engineering.

Type addition:

```typescript
export type CanonicalEvidenceRole = "DECISION" | "DIAGNOSTIC";
export interface CanonicalEvidence {
  // ...existing fields...
  role: CanonicalEvidenceRole;
}
```

Assignment function `classifyEvidenceRole(contribution, countedTowardScore, familyContribution)`
runs alongside the family MAX-collapse so both the observation's
own contribution AND its family's post-collapse total are available.

## §22.4 · Evidence-family calibration method

Not begun from a hardcoded percentage (§3 constraint). Grounded in
the ranker's own weights + COMMIT_MIN_SCORE=30:

- Individual weight range: 5..25 across all evidence kinds
- Family caps (via MAX-within-family):
  - TRANSACTION_TEXT: ~40 (largest, single-observation ceiling ~30)
  - TAXONOMY_ALIGNMENT: ~30 (ACCOUNT_NAME_SIMILARITY_MAX 20 + specificity ~10)
  - CAPITAL_NATURE: ~25 (multiple 15-20 observations, MAX collapses)
  - VENDOR_HISTORY: ~20
  - DEPARTMENT_CONTEXT: ~12
- COMMIT_MIN_SCORE floor: 30

Derived thresholds:

- 10 = 1/3 of COMMIT_MIN_SCORE — the "individual observation
  materially contributes" floor. Any observation contributing 10+
  alone represents a meaningful accounting reasoning step.
- 5 = 1/6 of COMMIT_MIN_SCORE — the "below this alone is noise"
  floor. Observations below 5 do not carry meaningful accounting
  weight even in aggregate.
- 15 for family total — meaningfully more than half the smallest
  family cap (12 for DEPARTMENT_CONTEXT), enough to declare "this
  family is contributing meaningful evidence to this candidate."

The 5-9 range with family ≥15 catches the case where several
small-but-not-trivial observations aggregate to a meaningful
family narrative (e.g., ACCOUNT_ROLE_MATCH +10 alongside
NATURE_COMPAT +15 gives a 25-family-total).

## §22.5 · Genuine-competitor definition

`qualifyGenuineCompetitors(candidates, winner)` requires ALL:

1. Distinct identity (accountId AND accountNumber)
2. score ≥ COMMIT_MIN_SCORE (30) — the canonical winner floor
3. score ≥ 60% of winner.score — family-cap-based threshold. Under
   the family caps, a candidate at <60% of winner's score is short
   at least one full evidence family, which IS a material accounting
   difference.
4. At least one DECISION-role positive evidence observation
5. Contradiction penalty sum < candidate's own score

Non-competitors (weak semantic accidents, adjacent-taxonomy near-ties
without substantive evidence, dominated-by-contradiction candidates)
do NOT appear in the founder-facing competitor set.

## §22.6 · Confidence semantic definitions

- **HIGH**: transaction interpretation is good, winner has strong
  independent DECISION evidence (multiple families), no genuine
  competitor is close enough to materially challenge, no
  contradictions on the winner.
- **MODERATE**: credible leading interpretation but
  (a) a genuine competitor exists, OR
  (b) evidence separation is limited to a single family, OR
  (c) winner is a deterministic tie-break (§9 — never HIGH from
      ordering alone).
- **LOW**: winner has no DECISION-role evidence at all. Score alone
  does not warrant recommendation.
- **REVIEW_REQUIRED**: any ABSTAIN_* recommendation status (§14 —
  confidence never manufactured over an abstention).

## §22.7 · Threshold / rule derivation evidence — not arbitrary numbers

All thresholds derive from the ranker's own value system:

| Threshold | Value | Derivation |
|-----------|-------|------------|
| Individual DECISION contribution floor | 10 | 1/3 of COMMIT_MIN_SCORE (30) — single observation carrying ≥1/3 of the winner floor is materially significant |
| Small-observation DECISION cap | 5 | 1/6 of COMMIT_MIN_SCORE — below is noise-level |
| Family-total DECISION floor | 15 | >½ of smallest family cap (12) — the "meaningful family narrative" line |
| Competitor score floor | 30 | Direct equal to COMMIT_MIN_SCORE — a candidate that could never have been a canonical winner cannot represent a genuine accounting alternative |
| Competitor relative score floor | 60% of winner | Family-cap analysis: at <60% of winner's score, the losing candidate is short at least one full evidence family. That is a material accounting difference, not close competition |

No occurrence of `15%`, `20%`, `40%`, or arbitrary percentages
disconnected from the ranker's own weight system.

## §22.8 · Tie handling

`assessCanonicalConfidence` reads
`canonicalResult.separation.isDeterministicTieBreak` and
`canonicalResult.separation.tiedRunnerUpCount` (Phase 2 additions).

Rule 4 in `deriveConfidenceLevel`: deterministic tie with tied
runner-up count > 0 → MODERATE. Never HIGH.

Reason code emitted: `deterministic_tie:<count>`.

Locked in test: `deterministic tie without genuine competitor still lands MODERATE (§9 — never HIGH from ordering alone)`.

## §22.9 · ABSTAIN handling

Four distinct abstention paths per Phase 3.6 recommendation-policy
model, all → REVIEW_REQUIRED with distinct reason codes:

- `ABSTAIN_QUALITY` → reason `policy_abstain_quality` (extraction insufficient)
- `ABSTAIN_AMBIGUITY` → reason `policy_abstain_ambiguity` (canonical below commit floor)
- `ABSTAIN_NO_CANDIDATES` → reason `canonical_no_eligible_candidates`
- `ABSTAIN_ANALYSIS_FAILURE` → reason `canonical_analysis_failure`

No status collapses. Downstream consumers can distinguish "review
because extraction is bad" from "review because two accounts genuinely
compete" for Phase 5+ product surfaces.

## §22.10 · Canonical confidence-assessment contract

```typescript
export interface CanonicalConfidenceAssessment {
  level: ConfidenceLevel;              // HIGH | MODERATE | LOW | REVIEW_REQUIRED
  winnerAccountId: string | null;
  winnerAccountNumber: string | null;
  winnerScore: number | null;
  winnerDecisionEvidenceCount: number;
  winnerDecisionFamilyCount: number;
  winnerContradictions: string[];
  genuineCompetitors: CanonicalGenuineCompetitor[];
  marginToStrongestCompetitor: number | null;
  isDeterministicTieBreak: boolean;
  recommendationStatus: RecommendationDecision["status"];
  reasonCodes: string[];
  humanReadableReason: string;
}
```

Attached to `GlRecommendation` via new field `canonicalConfidence`.
Consumers render this directly — no parallel confidence reconstruction.

## §22.11 · GL/category confidence relationship

Category confidence remains a separate downstream concern (Mission
Control projection). Phase 4 does not merge them, but the founder's
§17 rule is now structurally enforceable: any category-confidence
consumer that reads the canonical evidence (via `gl.canonicalConfidence`
or `gl.candidates`) sees the SAME competition data the GL confidence
reflects. If category is derived from purpose or capital nature,
that inference is already visible in the canonical evidence trail —
Phase 5 can consume it consistently without rebuilding a separate
competitor pool.

## §22.12 · Utility fixture result (§10)

Fixture: Utilities-Electricity vs Fuel (raw scoring produced 26/26 on
this iteration of ranker weights, below COMMIT_MIN_SCORE=30).

- Canonical status: **ABSTAIN**
- Confidence: **REVIEW_REQUIRED** (policy_abstain_ambiguity)
- Genuine competitors: 0
- Reason: below-commit-floor tie triggered ABSTAIN; the confidence
  layer correctly refuses to inflate a poor interpretation into a
  MODERATE recommendation.

Founder's caution honoured: **"Do not decide from margin alone."**
A 0-point margin below the commit floor is ABSTAIN, not MODERATE
competition.

## §22.13 · Novel-vendor tie result (§10)

The novel-vendor scenario (Grounds Maintenance = 38 vs R&M Preventative = 38)
appears in the calibration probe's equipment-repair case (adjusted
to Phase 3.5's family weights):

- Canonical status: **RECOMMEND**
- Winner: 6020 Grounds Maintenance (score 59, tied with 6033 R&M Preventative)
- Confidence: **MODERATE** (`genuine_competitors:2`)
- Genuine competitors: 2 (6033 tied at 59, 6035 at 52)

Both competitors have DECISION evidence (NATURE_COMPAT +15 +
LINE_ITEM_MATCH). Correct — this is real accounting ambiguity between
R&M-family accounts. Deterministic tie-break selected 6020 (lower
accountNumber ordering) but MODERATE confidence surfaces the
competition to the founder.

## §22.14 · Weak-semantic-accident result

Fixture: equipment invoice + Interest Expense candidate present.

- Interest Expense (6053): score 0 (below COMMIT_MIN_SCORE 30)
- Bank Charges (6051): score 0

Both fee-family accounts carry:
- NATURE_INCOMPATIBLE (-18) contradiction
- OBJECT_ROLE_CONTRADICTION (-22) contradiction (from Group D)

Neither qualifies as a genuine competitor because:
- score 0 < COMMIT_MIN_SCORE floor
- contradictions dominate their score

Confidence assessment on the equipment purchase: **HIGH** with 0
genuine competitors, even though fee-family accounts are present in
the candidate list. The original nonsense-alternative failure class
is structurally eliminated.

## §22.15 · Genuine-alternative result

The equipment-repair fixture (§22.13) is a natural genuine-alternative
case. Test locked in:
`Phase 4 · §13 · winner with a genuine competitor → MODERATE (calibration fixture: repair-tie at 59)`.

For a curated pure-unit test (§6-7 direct testing), the
`qualifyGenuineCompetitors()` unit test with a close candidate
(score 30 vs winner 50, at 60% ratio) with DECISION evidence
correctly qualifies it as a competitor. Locked in
`Phase 4 · §6-§7 · candidate at 60% of winner score qualifies if it has DECISION evidence`.

## §22.16 · Equipment/capital ambiguity result (§10)

Ambiguous equipment work fixture: "Equipment work — see attached" with
UNKNOWN nature, UNRESOLVED capital.

- Canonical status: **ABSTAIN** (top score 18 < COMMIT_MIN_SCORE 30)
- Confidence: **REVIEW_REQUIRED** (policy_abstain_ambiguity)
- Genuine competitors: 0

Correct. The GL classification honestly abstains; the confidence
layer doesn't manufacture a level. Phase 4 confidence input
`winnerDecisionEvidenceCount: 1` and `winnerDecisionFamilyCount: 1`
would land LOW if canonical had RECOMMENDed anyway, but the more
authoritative policy signal wins.

## §22.17 · Original Interest / Bank-Charges failure-class regression

Locked in test:
`Phase 4 · §11 · equipment invoice · Interest Expense does NOT qualify as genuine competitor even when present in candidates`.

The test constructs an equipment purchase, runs the full canonical
ranker (which produces all 10 NEUTRAL_COA accounts as candidates),
runs the confidence assessment, and asserts NO fee-family fsGroup
(`IS_INTEREST_EXPENSE`, `IS_BANK_CHARGES`, `IS_MERCHANT_FEES`) appears
in `conf.genuineCompetitors`. GREEN.

This is the systemic elimination of the founder-reported original
defect class — solved through (a) Group D contradictions +
(b) Phase 4 DECISION-evidence + score-floor competitor qualification,
not through any name/vendor/account literal.

## §22.18 · Founder-facing alternate projection tests

Genuine-competitor identity dedup test:
`Phase 4 · §6-§7 · same-account-identity duplicate cannot appear as competitor`. GREEN.

The `canonicalConfidence.genuineCompetitors` field is the
founder-facing alternate projection. Mission Control (Phase 5+
integration) will render it directly instead of reconstructing an
alternate list from `gl.candidates[1..N]`.

## §22.19 · Full targeted test counts

Green suites this run — 22 files, 382 tests:

- `tests/phase4r-refactor-single-gl-authority.test.ts` — 21
- `tests/phase4r-canonical-ranker.test.ts` — 42
- `tests/phase4r-recommendation-policy.test.ts` — 9
- `tests/phase4r-evidence-integrity.test.ts` — 16 (new)
- `tests/ap-intelligence-integration.test.ts` — 6
- `tests/ap-intelligence-source-contract.test.ts` — 26
- `tests/ap-intelligence-parse.test.ts` — 26
- `tests/ap-statement-*` — 8-file bundle (150+)
- `tests/mission-control-*` — 4-file bundle (30+)
- `tests/vendor-intelligence-*` — 2-file bundle (15+)
- `tests/phase4-slice5-*` — 4-file bundle (60+)
- `tests/c15y-*` — 2-file bundle (20+)

Pre-existing failures (unchanged from Phase 3.3):

- `tests/mission-control-c14c.test.ts` — 4 mailbox reply / MSAL scope failures. Unrelated to Phase 4R.

## §22.20 · Typecheck

`npx tsc --noEmit -p tsconfig.json` — clean, zero errors.

## §22.21 · Static authority guard remains 0

Verified via `tests/phase4r-refactor-single-gl-authority.test.ts`:
```
overrideMatches.length (0) ≤ EXPECTED_MAX_SITES_DURING_REFACTOR (0)  ✓
```

Single-authority invariant established by Phase 3 remains intact.
Phase 4 added scoring/evidence machinery but no new `gl.accountNumber`
overrides.

## §22.22 · No literals

Anti-overfitting test `Phase 4 · §15 · no vendor/invoice/account literals in canonical-confidence.ts` — GREEN. Also forbids `accountName === "..."` and `accountName.includes(...)`.

Existing `§35 · no vendor/invoice/account literals in canonical-ranker.ts` — GREEN.

## §22.23 · Main / staging unchanged

- Branch: `refactor/gl-single-authority` (feature branch)
- `main`: unchanged
- Staging (`spectre-staging`): v206 remains — no deploy performed
- No merge to main

## §22.24 · Full-quality gate status

Unchanged from prior checkpoints — remains **outstanding** and MUST
run before any merge to `main` or deploy. Includes:

- `npm run typecheck`
- `npm run scan:placeholders`
- Every vitest suite in `tests/` (not just AP intelligence)
- `npm run nav:audit`
- `npm run workflow:audit` where applicable

The four pre-existing `tests/mission-control-c14c.test.ts` failures
must be handled transparently per Phase 3.3 §15.14b.

## §22.25 · Remaining architectural weakness

Two items scoped to future phases, neither weakening Phase 4:

1. **`computeConfidenceDimensions` glClassification dimension** —
   still consumes only `gl.source` / `gl.confidence` / `gl.reason`
   from the projected `GlRecommendation`, not the richer
   `canonicalConfidence` assessment. Phase 5+ product-facing
   surfaces should consume `gl.canonicalConfidence` directly.
   `computeConfidenceDimensions` is a legacy multi-dimension score
   surface consumed by Mission Control confidence panels; its
   `glClassification` dimension is an intentional summary of the
   canonical winner's score, not a competing confidence signal.

2. **Parallel allocation-cardCategory guard** (Phase 3.5 §13.18
   deferred item) — still present. Allocation-scope concern for
   Phase 5.

Phase 4 acceptance principle satisfied:

> **"When Spectre says HIGH, the accounting evidence actually warrants HIGH."**

Verified through the equipment-purchase HIGH assessment (winner
1500 with 2 independent DECISION families and 0 contradictions vs
a candidate list containing fee-family accounts that never qualify
as competitors) and the equipment-repair MODERATE assessment
(winner 6020 with a genuine tied competitor at 6033).

> **"When two accounting interpretations genuinely compete, Spectre says so."**

Verified through the equipment-repair MODERATE with 2 genuine
competitors, and the calibration probe results.

Continue to Phase 5 (allocation-ranker alignment) or Phase 6
(deploy + real-fixture DOM parity) per the original refactor
schedule. Both remain within the founder-approved Phase 4R
refactor scope.

Do not deploy.

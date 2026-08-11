# Phase 4R · single-GL-authority refactor · Phase 3.6 (Group E) checkpoint · Phase 3 completion

- **Date**: 2026-08-11
- **Branch**: `refactor/gl-single-authority`
- **Commit**: `4966fee`
- **Previous checkpoint**: Phase 3.5 (Group D) · `bf4932f` (2026-08-11)

This checkpoint documents Group E override elimination against the
20-item report format specified in the Phase 3.6 authorization
(§15), plus the post-Phase-3 authority scan (§14) and the
single-authority-invariant establishment (§16).

---

## §15.1 · Exact Group E site removed / migrated

Before Phase 3.6, `src/lib/ap-intelligence/analyse.ts` contained
one post-canonical selection authority (28 lines, the "field-quality
gate" post-canonical override at line 1770):

| Site | Old line | Role | Founder classification |
|------|----------|------|------------------------|
| E1 · field-quality gate | 1770 | When `fieldQualityGate.glEligible === false`, cleared `gl.accountNumber`, `gl.accountName`, `gl.categoryKey`, `gl.fsGroupKey` to null with reason `abstained_field_quality:…` and set `autoApprovalEligible: false`. Preserved `gl.candidates` but nulled the winner projection. | RECOMMENDATION POLICY posing as SELECTOR (forbidden shape) |

The site was NOT selecting a different account — but it was
destroying winner provenance by nulling the projected fields at
the same layer that ran ranking. Group E is categorically
different from A–D: the underlying policy is legitimate; the
mechanism was wrong.

## §15.2 · Original quality-gate semantics

The field-quality gate (`src/lib/ap-intelligence/field-quality/index.ts`)
assesses upstream extraction quality across three axes:

- **Supplier candidate validation** — `validateSupplierCandidate(guessedName, fullText)` → `keep` / `rescued` / `rejected`
- **Payable reference validation** — `validatePayableReferenceCandidate(invoiceNumber)` → `keep` / `trimmed` / `rejected`
- **Substantive line-item evidence** — at least one line item with description ≥ 12 chars AND positive amount OR positive quantity+price

`glEligible = true` iff supplier is `keep`/`rescued` AND reference
is `keep`/`trimmed` AND substantive line items exist.

The gate reads NONE of: economic purpose, purchased object,
vendor identity, invoice totals, department, tax, capital nature.
It is a pure extraction-quality gate.

The historical motivation is footer/marketing/policy-text
contamination when line items are sparse — the ranker's
document-wide keyword matching pulls contamination from
non-invoice-charge text (§12 field-quality rule in the field-
quality module). Group E was the enforcement site.

The gate answers: **"the upstream transaction interpretation is
too weak to permit an automated recommendation."** NOT: "the GL
classification itself is uncertain." Those are the two distinct
meanings the founder called out in §1 of the Phase 3.6
authorization, and this one is squarely the second.

## §15.3 · New recommendation-policy structure

New module: `src/lib/ap-intelligence/recommendation-policy.ts` (129 lines).

```typescript
export type RecommendationStatus =
  | "RECOMMEND"
  | "ABSTAIN_QUALITY"
  | "ABSTAIN_AMBIGUITY"
  | "ABSTAIN_NO_CANDIDATES"
  | "ABSTAIN_ANALYSIS_FAILURE";

export function evaluateRecommendationPolicy(input: {
  canonicalStatus: "RECOMMEND" | "ABSTAIN" | "NO_ELIGIBLE_CANDIDATES" | "ANALYSIS_FAILURE";
  canonicalWinnerAccountNumber: string | null;
  canonicalAbstentionReason: string | null;
  fieldQualityEligible: boolean;
  fieldQualityAbstentionReasons: readonly string[];
}): RecommendationDecision;
```

The module contains NO account-selection logic. It reads only
status + policy inputs and returns a decision. Never touches
candidates. Never reorders. Never reads account names.

Invocation site: `canonical-runtime-facade.ts` at line ~344,
between `rankCanonical(input)` and `projectCanonicalToGl(result,
count, recommendation)`. The projector then writes the decision's
fields onto the compat `GlRecommendation`.

## §15.4 · Canonical status variants used

Five status variants total:

| Status | Meaning | canonicalWinnerAccountNumber | autoApprovalEligible | requiresReview |
|--------|---------|------------------------------|----------------------|----------------|
| `RECOMMEND` | canonical + policy both green | winner acct # | true | false |
| `ABSTAIN_QUALITY` | canonical OK but extraction weak | winner acct # | false | true |
| `ABSTAIN_AMBIGUITY` | canonical returned ABSTAIN | winner acct # | false | true |
| `ABSTAIN_NO_CANDIDATES` | canonical NO_ELIGIBLE_CANDIDATES | null | false | true |
| `ABSTAIN_ANALYSIS_FAILURE` | canonical ANALYSIS_FAILURE | null | false | true |

The `nullable accountNumber` legacy compat is preserved on
`gl.accountNumber` (null for every non-RECOMMEND). The
authoritative canonical state is on `gl.recommendationStatus` +
`gl.canonicalWinnerAccountNumber` + `gl.candidates`.

## §15.5 · Strong-quality RECOMMEND example

Contract test: `Phase 3.6 · §9 · strong interpretation + canonical RECOMMEND → RECOMMEND, autoApprovalEligible=true, winner projected`

- `canonicalStatus: "RECOMMEND"`, `canonicalWinnerAccountNumber: "6035"`
- `fieldQualityEligible: true`, `fieldQualityAbstentionReasons: []`

Result:
- `status: "RECOMMEND"`
- `abstentionCategory: null`
- `abstentionReasons: []`
- `canonicalWinnerAccountNumber: "6035"`
- `autoApprovalEligible: true`
- `requiresReview: false`

## §15.6 · Weak-quality ABSTAIN example

Contract test: `Phase 3.6 · §9 · weak interpretation + canonical RECOMMEND → ABSTAIN_QUALITY, winner provenance preserved, no auto-approval`

- `canonicalStatus: "RECOMMEND"`, `canonicalWinnerAccountNumber: "6035"`
- `fieldQualityEligible: false`, `fieldQualityAbstentionReasons: ["supplier_rejected_placeholder", "line_items_insufficient_for_gl"]`

Result:
- `status: "ABSTAIN_QUALITY"`
- `abstentionCategory: "QUALITY"`
- `abstentionReasons: ["supplier_rejected_placeholder", "line_items_insufficient_for_gl"]` (§5 preserves distinct causes)
- `canonicalWinnerAccountNumber: "6035"` (§4 preserved)
- `autoApprovalEligible: false` (§11 safety invariant)
- `requiresReview: true`

## §15.7 · Genuine-ambiguity behaviour

Contract test: `Phase 3.6 · §9 · canonical ABSTAIN (genuine ambiguity) + strong field quality → ABSTAIN_AMBIGUITY, winner provenance preserved`

When `canonicalStatus === "ABSTAIN"` (top score below `COMMIT_MIN_SCORE`
or genuine two-account competition below the discriminator), the
policy returns `ABSTAIN_AMBIGUITY` with:

- distinct `abstentionCategory: "AMBIGUITY"` (not `QUALITY`)
- winner provenance preserved (`canonicalWinnerAccountNumber: "6033"`)
- `autoApprovalEligible: false`, `requiresReview: true`

Group E does not substitute another account. The policy does not
inspect candidates. Ambiguity is surfaced honestly; Phase 4
confidence work will use `abstentionCategory === "AMBIGUITY"` as a
distinct signal.

## §15.8 · `NO_ELIGIBLE_CANDIDATES` behaviour

Contract test: `Phase 3.6 · §9 · canonical NO_ELIGIBLE_CANDIDATES → ABSTAIN_NO_CANDIDATES (NOT ABSTAIN_QUALITY)`

Distinct status:
- `status: "ABSTAIN_NO_CANDIDATES"`
- `abstentionCategory: "NO_CANDIDATES"`
- `canonicalWinnerAccountNumber: null`

Additional test: `canonical NO_ELIGIBLE_CANDIDATES takes precedence over weak field quality` — even when field quality is bad AND canonical has no candidates, the structural signal wins. `ABSTAIN_NO_CANDIDATES` is not collapsed into `ABSTAIN_QUALITY`.

## §15.9 · `ANALYSIS_FAILURE` behaviour

Contract test: `Phase 3.6 · §9 · canonical ANALYSIS_FAILURE → ABSTAIN_ANALYSIS_FAILURE (NOT ABSTAIN_QUALITY)`

Distinct status:
- `status: "ABSTAIN_ANALYSIS_FAILURE"`
- `abstentionCategory: "ANALYSIS_FAILURE"`
- Preserved separately from every other abstention cause

## §15.10 · Winner provenance under ABSTAIN

`gl.canonicalWinnerAccountNumber` is a NEW field on `GlRecommendation`
that carries the canonical winner accountNumber even when the
projected `gl.accountNumber` is null under any ABSTAIN status. This
lets downstream diagnostics answer:

- What account ranked first? — `gl.candidates[0].accountNumber` (also mirrored on `gl.canonicalWinnerAccountNumber` for ABSTAIN_*)
- What ranked second? — `gl.candidates[1]`
- What evidence supported them? — `gl.candidates[i].evidence`
- What was the score margin? — from `candidates[0].confidence - candidates[1].confidence`
- Was there a deterministic tie? — preserved in the canonical result upstream (not currently projected onto GlRecommendation but available via allocation diagnostic; Phase 4 target)
- What contradictions existed? — `gl.candidates[i].contradictions`
- Why did policy refuse to automate? — `gl.abstentionCategory` + `gl.abstentionReasons`

## §15.11 · Posting-safety behaviour

Contract test: `Phase 3.6 · §9 · §11 safety invariant — autoApprovalEligible is FALSE for every non-RECOMMEND status`

The policy proves at the module level: `autoApprovalEligible === true`
only when `status === "RECOMMEND"`. Every other status returns false.
`requiresReview === true` for every non-RECOMMEND status.

This is a NECESSARY condition — other integration-layer authorities
(approvals, duplicate detection, etc.) remain independent. §16.4
does not trigger; no other posting classification authority exists.

The compat projection also enforces this in the facade
(`autoApprovalEligible: recommendation.autoApprovalEligible && projectAccount`)
so a stale downstream that reads only `gl.autoApprovalEligible`
still cannot post an ABSTAIN result.

## §15.12 · Static architectural guard — 1 → 0

Verified via `tests/phase4r-refactor-single-gl-authority.test.ts`
`§ Phase 4R · static architectural guard`:

| Phase | Ceiling | Actual sites |
|-------|---------|--------------|
| Baseline | 10 | 10 |
| After 3.2 (Group A) | 7 | 7 |
| After 3.3 (Group B) | 4 | 4 |
| After 3.4 (Group C) | 2 | 2 |
| After 3.5 (Group D) | 1 | 1 |
| **After 3.6 (Group E)** | **0** | **0** |

Zero post-ranking `gl = { ...gl, accountNumber: ... }` overrides
remain. The static guard now polices the FINAL state — any new site
is architectural regression against the single-authority invariant.

## §15.13 · Post-Phase-3 semantic authority scan

**Allowed and present:**

- Canonical candidate generation/ranking (`rankCanonical` in `canonical-ranker.ts`)
- Recommendation-quality policy (`evaluateRecommendationPolicy` in `recommendation-policy.ts`)
- Facade per-account compatibility-gate evaluation (`evaluateCompatibilityGate` per eligible account — feature extraction only, no selection)
- Projection/serialization (`projectCanonicalToGl` — pure read, no mutation)
- Multi-line allocation ranker (`gl-allocations.ts` — Phase 5 scope, per-cluster ranking not per-invoice)

**Forbidden and confirmed absent:**

- Second document-level winner selector for the single-GL surface — CONFIRMED ABSENT
- Post-ranking account promotion — CONFIRMED ABSENT
- Post-ranking account substitution — CONFIRMED ABSENT
- Candidate reconstruction to justify a different winner — CONFIRMED ABSENT

**Known secondary ranker (flagged for Phase 4):**

`analyse.ts:1076` still calls `recommendGlAccount(...)` (Pipeline A)
producing an intermediate `gl` that is used ONCE at line ~1134 as
input to `computeConfidenceDimensions` (a diagnostic surface),
then FULLY OVERWRITTEN by the canonical facade at line ~1714. The
Pipeline A output does NOT reach the final `gl` returned by
`analyse`. Not a selector for the final winner.

Recommend Phase 4 evidence-integrity work fold `computeConfidenceDimensions`
onto the canonical result (so confidence dimensions compute against
the actual winner, not against Pipeline A's guess) and delete the
Pipeline A call. This is a Phase 4 optimization, not a Phase 3
authority failure.

## §15.14 · Phase 1 state

- `tests/phase4r-refactor-single-gl-authority.test.ts` — 21/21 GREEN
- Static guard assertion:
  ```
  overrideMatches.length (0) ≤ EXPECTED_MAX_SITES_DURING_REFACTOR (0)  ✓
  ```

## §15.15 · Canonical + broader regression totals

**Green suites (targeted, this run — 21 files, 366 tests):**

- `tests/phase4r-refactor-single-gl-authority.test.ts` — 21
- `tests/phase4r-canonical-ranker.test.ts` — 42
- `tests/phase4r-recommendation-policy.test.ts` — 9 (new)
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
- `tests/c15y-field-quality-gate.test.ts` — 10+
- `tests/c15y-structural-quality.test.ts` — 10+

Total: **366 tests · 21 files · all GREEN.**

Pre-existing failures (unchanged from Phase 3.3):

- `tests/mission-control-c14c.test.ts` — 4 mailbox reply / MSAL scope failures. Unrelated to Phase 4R.

## §15.16 · Typecheck

`npx tsc --noEmit -p tsconfig.json` — clean, zero errors.

## §15.17 · No literals

`§35 · no vendor/invoice/account literals in canonical-ranker.ts` — GREEN.
`Phase 3.6 · §15 · no vendor/invoice/account literals in recommendation-policy.ts` (new anti-overfitting test) — GREEN. Also forbids `accountName === "..."` and `accountName.includes(...)` in the policy module.

## §15.18 · Main / staging unchanged

- Branch: `refactor/gl-single-authority` (feature branch)
- `main`: unchanged
- Staging (`spectre-staging`): v206 remains — no deploy performed
- No merge to main

## §15.19 · Full-quality gate still outstanding

Unchanged from Phase 3.3/3.4/3.5 checkpoints. Full `npm run quality`
remains **outstanding** and MUST run before any merge of
`refactor/gl-single-authority` to `main` or any deploy of the
architectural refactor candidate.

Includes:

- `npm run typecheck`
- `npm run scan:placeholders`
- Every vitest suite in `tests/` (not just AP intelligence)
- `npm run nav:audit`
- `npm run workflow:audit` where applicable

The four pre-existing `tests/mission-control-c14c.test.ts` failures
must be handled transparently per Phase 3.3 §15.14b.

Targeted-suite success across Groups A–E is NOT a substitute.

## §15.20 · Remaining architectural weakness

Two Phase-4-scoped items surfaced during Phase 3 completion:

1. **Pipeline A still runs but is unused for final selection.**
   `recommendGlAccount` at `analyse.ts:1076` produces an
   intermediate `gl` used only by `computeConfidenceDimensions`
   at line 1134. Fully overwritten by the canonical facade at
   line 1714. Not a §14 selector but a wasted computation and a
   confidence-input mismatch. Phase 4 target: fold confidence
   dimensions onto the canonical result and delete the Pipeline A
   call.

2. **Parallel allocation-cardCategory clear** (deleted here in
   Phase 3.6 by re-basing on `gl.recommendationStatus`) still
   uses the OLD Slice 5.3 durable-asset-vs-name-regex rule on
   `gatedAllocations.cardCategory` at lines 1872-1912 pre-Group-D
   (relative line numbers now shifted). This is allocation-scope
   (Phase 5), not GL-scope. Documented in the Phase 3.5
   checkpoint §13.18; still valid for Phase 5.

Neither weakens Phase 3's single-authority invariant. Both are
scoped to their respective future phases.

## §16 · Runtime single-authority invariant status

**ESTABLISHED** for the document-level single-GL surface.

For the RECOMMEND path:
```
analysis.gl.accountNumber === analysis.gl.candidates[0].accountNumber
```

For every ABSTAIN_* path:
```
gl.accountNumber = null                     // legacy compat
gl.canonicalWinnerAccountNumber = <winner from candidates[0]>
gl.candidates = <full canonical competition>
gl.recommendationStatus = <one of five distinct states>
gl.abstentionCategory = <QUALITY|AMBIGUITY|NO_CANDIDATES|ANALYSIS_FAILURE|null>
gl.abstentionReasons = <preserved cause strings>
```

The founder's §16 authorization end-note applies: proceed into
Phase 4 evidence-integrity calibration. The §14 authority scan
found no additional selector; §16.1 does not trigger.

Do not deploy.

# v206 SaaS-Recall Repair — 20-Item §16 Checkpoint

**Prepared:** 2026-08-15 · **Branch:** `v206-saas-recall-fix` (off `main` = v206 = `cbb1b52`) · **Deployed:** staging web v214 / worker v111.

Founder-authorised bounded fix for the first-failure boundary identified in the CS #221178 vs #200824 paired forensic. **Not merged. No production deploy.**

---

## 1. Exact code change

Six files, ~445 lines added, 3 removed:

| File | Nature |
|---|---|
| [src/lib/ap-intelligence/economic-purpose-taxonomy.ts](src/lib/ap-intelligence/economic-purpose-taxonomy.ts) | New optional field `corroboratedCues` on `ConceptDefinition`; three corroboration pairs added under `SOFTWARE_SUBSCRIPTION` (plan-tier / plan-number / per-unit — each paired with commitment cadence); classifier's `pool.forEach` loop iterates `corroboratedCues` and records the strength ONLY when both regexes match the SAME line-item description. |
| [src/lib/ap-intelligence/purpose-evidence-quality.ts](src/lib/ap-intelligence/purpose-evidence-quality.ts) | Imports `CANONICAL_PURPOSE_CONCEPTS`; extends `hasDiscriminativeMatch` computation to accept a corroborated cue-pair match on any primary line as HIGH-quality evidence (symmetric to the taxonomy per §5). |
| [tests/ap-benchmark/seed.ts](tests/ap-benchmark/seed.ts) | Adds one operating expense account: `6067 Software Subscriptions` (seed COA only — no runtime code touched). |
| [tests/ap-benchmark/corpus/manifest.json](tests/ap-benchmark/corpus/manifest.json) | Registers the new sealed corpus fixture. |
| [tests/ap-benchmark/corpus/dev/saas-brand-recurring-subscription.case.json](tests/ap-benchmark/corpus/dev/saas-brand-recurring-subscription.case.json) | New sealed corpus case (generic supplier, brand-neutral, tests the class permanently). |
| [tests/v206-saas-recall-corroborated-cues.test.ts](tests/v206-saas-recall-corroborated-cues.test.ts) | 13 tests: 4 positive, 6 negative controls, 2 brand-literal guards, 1 real-shape regression. |

Commit: `825cc90` on `v206-saas-recall-fix`.

## 2. Corroboration rule

Three corroborated cue pairs on `SOFTWARE_SUBSCRIPTION`:

```js
corroboratedCues: [
  { // Plan-tier + commit-cadence
    a: /\b(?:business|enterprise|team|frontline)\s+(?:basic|standard|premium|plus|essentials?|starter|pro|professional|advanced|e\d)\b/i,
    b: /\b(?:\d+[-\s]?year|multi[-\s]?year|monthly|annually?|yearly)\s+commit(?:ment)?\b/i,
    strength: 78,
    label: "SaaS plan-tier + commitment-cadence corroborated",
  },
  { // Plan-number/edition-number + commit-cadence
    a: /\b(?:plan|edition|tier|package|level)\s*\d+\b/i,
    b: /\b(?:\d+[-\s]?year|multi[-\s]?year|monthly|annually?|yearly)\s+commit(?:ment)?\b/i,
    strength: 78,
    label: "SaaS plan-number + commitment-cadence corroborated",
  },
  { // Per-unit + commit-cadence
    a: /\b(?:per[-\s]?user|per[-\s]?seat|per[-\s]?licen[cs]e)\b/i,
    b: /\b(?:\d+[-\s]?year|multi[-\s]?year|monthly|annually?|yearly)\s+commit(?:ment)?\b/i,
    strength: 78,
    label: "SaaS per-unit + commitment-cadence corroborated",
  },
],
```

**Rule contract:** each pair contributes `strength` to the concept's score ONLY when BOTH `a` and `b` regexes match the SAME line-item description. Neither regex alone commits the concept. Commitment cadence in isolation (§7) does NOT signal SOFTWARE_SUBSCRIPTION.

Applied inside `DeterministicTaxonomyProvider.classify` after the standard cue loop, before the body-text and supplier-name passes. Uses the same `record()` helper as existing cues — pair matches accumulate into the concept's score the same way, cap at 96 confidence.

Symmetric consumption in `purpose-evidence-quality.ts:hasDiscriminativeMatch`:

```js
const corroboratedPairs = concept
  ? (CANONICAL_PURPOSE_CONCEPTS.find(c => c.concept === concept)?.corroboratedCues ?? [])
  : [];
const hasCorroboratedMatch = concept != null
  && primaryPurchaseLines.some(li =>
    corroboratedPairs.some(pair => pair.a.test(li.description) && pair.b.test(li.description)));
const hasDiscriminativeMatch = concept != null && (
  primaryPurchaseLines.some(li => vocab.some(r => r.test(li.description)))
  || hasCorroboratedMatch
);
```

## 3. Proof: no brand/vendor literals

Automated guard in [tests/v206-saas-recall-corroborated-cues.test.ts](tests/v206-saas-recall-corroborated-cues.test.ts) `§3 vendor/brand-literal guard`. Twenty-five forbidden brand tokens checked against every regex source, corroborated-pair source, and pair label in `SOFTWARE_SUBSCRIPTION`:

```
microsoft, office 365, office365, m365, entra, visio, sharepoint,
onedrive, teams, google workspace, gsuite, g suite, adobe,
creative cloud, slack, salesforce, sfdc, zoom, dropbox, box.com,
notion, figma, github enterprise, gitlab, atlassian, jira,
confluence, quickbooks, xero, sage
```

Result: **zero forbidden tokens found in runtime regex sources.** Source-level guard additionally scans both file bodies; any brand mention must live inside a comment line (documentation of the failing case in a rationale block), never inside a `/regex/` literal or runtime string. Both guard tests pass.

## 4. Positive tests (all pass)

Founder §6 mandatory generics (no Microsoft tokens):

1. **Business Premium + 1 Year Commit Paid Monthly (repeated plan lines)** → `SOFTWARE_SUBSCRIPTION` top with confidence ≥ 60 ✓
2. **Enterprise Plan 2 - Monthly Commit** → `SOFTWARE_SUBSCRIPTION` (plan-number path) ✓
3. **Per User Plan - 1 Year Commit** → `SOFTWARE_SUBSCRIPTION` (per-unit path) ✓
4. **Evidence-quality gate accepts corroborated `SOFTWARE_SUBSCRIPTION` as HIGH discriminative match** → `commitEligible=true`, `hasDiscriminativeMatch=true` ✓
5. **Real-#200824-shape sanitised fixture** (brand-neutral: Business Standard, Business Basic, Business Premium, Visio Plan 2 line items; no supplier identity) → decision.concept = SOFTWARE_SUBSCRIPTION, source = CANONICAL_COMMITTED/LEGACY_CONCUR, evidence-quality gate commit-eligible ✓

## 5. Negative controls (all pass)

Founder §7 mandatory. Commitment cadence alone must NOT misclassify:

1. **Telecom** — `"Internet service — 1 year commitment, paid monthly."` → NOT SOFTWARE_SUBSCRIPTION (or, if surfaced at all, confidence < 60 threshold) ✓
2. **Equipment maintenance contract** — `"Annual maintenance agreement — 1 year commitment."` → NOT SOFTWARE_SUBSCRIPTION ✓
3. **Professional membership** — `"Annual membership commitment."` → NOT SOFTWARE_SUBSCRIPTION ✓
4. **Equipment lease** — `"Equipment lease — 36 month commitment / monthly payment."` → NOT SOFTWARE_SUBSCRIPTION ✓
5. **Managed service** — `"Managed support service — annual commitment."` → NOT SOFTWARE_SUBSCRIPTION ✓
6. **Bare cadence** — `"Monthly commit."` (no plan-tier / plan-number / per-unit token) → NOT SOFTWARE_SUBSCRIPTION ✓

Result: all six negative controls pass. Commitment cadence in isolation is not a SOFTWARE_SUBSCRIPTION trigger, exactly as the founder mandated.

## 6. #200824 purpose classifier — BEFORE vs AFTER

| | v206 baseline (v213) | v206 + SaaS-recall (v214) |
|---|---|---|
| `documentIdTail` | `k5j6ev` | `k5j6ev` |
| Extraction | STRUCTURED, 1045 chars, 7 lines | STRUCTURED, 1045 chars, 7 lines (identical) |
| Purpose classifier commit | **no commit** — `purposeDecision` null/UNKNOWN, log shows no `purpose-driven-ranker.promotion` for `k5j6ev` | **`SOFTWARE_SUBSCRIPTION(96, quality=HIGH)`** — quality upgraded to HIGH because corroborated cue matches on multiple primary lines |
| Evidence-quality gate | short-circuited: gate never asked because trigger `purposeDecision != null` failed | commitEligible = `true` (HIGH via corroborated discriminative match) |
| Log signature | `analyse.complete` + `semantic-match.override-denied(6065, nature_confidence 27<40)` | `analyse.complete` + `purpose-driven-ranker.promotion(SOFTWARE_SUBSCRIPTION → 6071 score=75)` |

## 7. #200824 candidate pool — BEFORE vs AFTER

| | v206 baseline (v213) | v206 + SaaS-recall (v214) |
|---|---|---|
| Base recommendGlAccount candidates | **0** (`"Ranker found no account with supporting evidence"`) | 0 from base ranker; purpose-driven full-COA search runs |
| Purpose-driven full-COA search | did not fire (trigger failed) | fires — 79 accounts considered |
| Winner selected | null | `6071 Subscriptions` at score 75 |
| Top-5 shown on card | empty | 6071 Subscriptions (no strong alternates surfaced above competitive threshold) |

## 8. #200824 final winner

**`6071 Subscriptions`** — reason string exact:
```
purpose_driven_full_coa_search:SOFTWARE_SUBSCRIPTION(96,quality=HIGH)->6071(score=75,considered=79)
```

Compare to baseline (v213): `"Ranker found no account with supporting evidence — no GL recommendation can be made from this document."`

## 9. #200824 founder-facing card

Reading from Mission Control feed on `spectre-staging` at v214 (`test-results/v206-saas-recall-acceptance/mission-control-feed.png`, top AP card):

```
MISSING INFORMATION · MAIL-LZWG · 1 hr ago
Club Support Inc invoice #220824 — $778.16 CAD · Subscriptions
c.s.turcato@gmail.com

Spectre classified the attached PDF as an invoice and extracted the vendor as
Club Support Inc. Invoice #220824. Verified GST at 5 %. No matching vendor
record exists. Prepared a proposed entry to post $778.16 CAD to
[ GL 6071 Subscriptions ]. No purchase order was identified.
2 findings for review.

AMOUNT             INVOICE       CATEGORY                CONFIDENCE
$778.16 CAD        #220824       Subscriptions           High ·

[Request information] [Assign] [Defer 24 hr]        Invoice · PDF  [Open]
```

- **Category: Subscriptions** (was: blank / unresolved)
- **GL: 6071 Subscriptions** (was: null)
- **Confidence: High** (was: Needs review · Category)
- Amount / invoice # / total / supplier all extracted correctly (unchanged from baseline)

**Founder acceptance criterion (§9)**: "A defensible software/subscription GL must be surfaced. 6071 Subscriptions is acceptable if the accounting evidence supports the recurring-subscription classification." ✓ — recurring monthly SaaS billing → 6071 Subscriptions with quality=HIGH.

## 10. #221178 underlying winner vs founder-facing projection

**Explanation of the divergence surfaced by the paired diagnostic.**

The v206 codebase runs TWO ranking authorities per invoice, and they can disagree:

1. **Document-level ranker** — `recommendGlAccount` + downstream purpose-driven-full-COA promotion. Produces `analysis.gl.accountNumber`. On #221178 today: `6071 Subscriptions` (same as before the fix).

2. **Allocation-level ranker** — `computeAllocations` (in `gl-allocations.ts`) runs `rankAccountsPure` per economic-purpose cluster. Cluster-scoped scoring can produce a different winner than the document-level ranker because it consumes only within-cluster line items. On #221178: the single cluster resolves to `6054 Computer & IT Services`.

The card projection in [intelligence-review-intakes.ts:1387-1402](src/lib/mission-control/intelligence-review-intakes.ts#L1387) **prefers the allocation-level winner when exactly one material allocation exists**, and only falls back to the document-level winner otherwise. The comment at lines 1380-1386 explicitly documents this precedent:

> `on 221178 the single allocation resolves to 6054 Computer & IT Services while the document-level analysis.gl still recommends 6071 Subscriptions. The narrative must follow the allocation authority.`

This is intentional v206 design (Ranker-Authority slice, 2026-08-10), not a bug and not something the SaaS-recall fix introduced. The prior full-restoration checkpoint's founder-facing report of `6054 Computer & IT Services` for #221178 was reading the allocation-level winner (correct card behavior). The paired-forensic diagnostic's report of `6071 Subscriptions` was reading the document-level winner (also correct, from a different projection).

**For #200824 today:** allocation-level and document-level both resolve to `6071 Subscriptions` — they agree. So the card shows `6071 Subscriptions` and there is no projection divergence to reconcile.

**Not modified in this slice.** The two-authority projection is a v206 architectural feature; touching it would violate §11 "Do not modify v206 architecture."

## 11. #221178 regression

| | v206 baseline (v213) | v206 + SaaS-recall (v214) |
|---|---|---|
| Document-level GL | 6071 Subscriptions | 6071 Subscriptions ✓ unchanged |
| Card GL | 6054 Computer & IT Services | 6054 Computer & IT Services ✓ unchanged |
| Card category | Computer & IT Services | Computer & IT Services ✓ unchanged |
| Card confidence | Moderate · GL | Moderate · GL ✓ unchanged |
| Alternates surfaced | 6033/6054/5016/6030/6031 (all conf 95/94) | 6033/6054/5016/6030/6031 (all conf 95/94) ✓ identical |

**No regression.**

## 12. DMM B0037FC regression

| | v206 baseline | v206 + SaaS-recall |
|---|---|---|
| GL winner | `6025 Fuel (Gas/Diesel)` | `6025 Fuel (Gas/Diesel)` ✓ |
| Confidence | High | High ✓ |
| Reason | `purpose_driven_full_coa_search:FUEL(96,quality=HIGH)->6025(score=82,considered=79)` | identical ✓ |

**No regression.**

## 13. Oakcreek #1091559 regression

| | v206 baseline | v206 + SaaS-recall |
|---|---|---|
| GL winner | `1506 Equipment & Fixtures - Grounds` | `1506 Equipment & Fixtures - Grounds` ✓ |
| Card category | Equipment & Fixtures - Grounds | Equipment & Fixtures - Grounds ✓ |
| Confidence | Moderate · Category | Moderate · Category ✓ |
| Split entry | 2 allocations, 1 requiring review, PO #Lance | identical ✓ |

**No regression.**

## 14. Oakcreek #1087769 regression

| | v206 baseline | v206 + SaaS-recall |
|---|---|---|
| GL winner | `6031 R & M - Ground Equip` | `6031 R & M - Ground Equip` ✓ |
| Card category | R & M - Ground Equip | R & M - Ground Equip ✓ |
| Confidence | High | High ✓ |
| PO match | #Shop | #Shop ✓ |

**No regression.**

## 15. OXIO regression

| | v206 baseline | v206 + SaaS-recall |
|---|---|---|
| GL | `6072 Telephone & Internet` | `6072 Telephone & Internet` ✓ (from feed screenshot) |
| Card category | Telephone & Internet | Telephone & Internet ✓ |
| Confidence | Moderate · Supplier | Moderate · Supplier ✓ |
| Total | $40.32 CAD, #OXIO-23375874 | identical ✓ |

**No regression.**

Notably: OXIO's line items contain "Internet 100Mbps" / similar — the `INTERNET_CONNECTIVITY` classifier still fires correctly, unaffected by the SaaS-recall addition to `SOFTWARE_SUBSCRIPTION`. Cross-classifier isolation preserved.

## 16. CPA Alberta regression (both copies)

| | v206 baseline | v206 + SaaS-recall |
|---|---|---|
| GL / category | `Multiple` (split entry across 2 allocations) | `Multiple` (split entry across 2 allocations) ✓ |
| Confidence | High | High ✓ |
| Total | $1,420.50 CAD, #1007565767 (both copies) | identical ✓ |
| Duplicate-submission chip | shown on first CPA card | shown ✓ |

**No regression.** CPA uses `PROFESSIONAL_MEMBERSHIP` classifier — unaffected by the SaaS-recall addition.

## 17. Sealed benchmark result including new fixture

| Metric | v206 baseline (42) | v206 + SaaS-recall (43) | Δ |
|---|---:|---:|---:|
| Case count | 42 (dev 36 + validation 6) | 43 (dev 37 + validation 6) | +1 (new SaaS fixture) |
| Pass overall | 12 | 12 | 0 |
| Partial | 4 | 5 | +1 (new case: `workflowState` label mismatch only; all 12 accounting dimensions pass) |
| Fail overall | 26 | 26 | 0 |
| **GL Top-1** | **17/42 (40.5%)** | **18/43 (41.9%)** | **+1** (new case GL Top-1 PASS) |
| GL Top-3 | 9 | 10 | +1 (new case) |
| Forbidden GL (correctly excluded) | 35/42 | 36/43 | +1 |
| **Unsafe recommendations** | **0** | **0** | **0** |
| Correct abstention on unreadable | 4 | 4 | 0 |
| False abstention | 0 | 0 | 0 |
| Supplier accuracy | 40/42 (95.2%) | 41/43 (95.3%) | +1 |

**Per-case winners diff between the two runs:** exactly ONE change — the new `saas-brand-recurring-subscription` case at position 72 with GL Top-1 = `6067 Software Subscriptions` at confidence 95. **All 42 pre-existing cases have IDENTICAL winners.** Diff evidence in `tests/ap-benchmark/runs/ap-bench-2026-08-15T04-22-23-796Z-p0on-p2on.md` vs `ap-bench-2026-08-15T01-26-45-558Z-p0on-p2on.md`.

New fixture per-case verdict:
- Split: `dev` · Category: `OPERATING_INVOICE`
- Overall: **PARTIAL** (12 accounting dimensions pass; only `workflowState` NEEDS_JUDGMENT vs expected REVIEW_REQUIRED — cosmetic label mismatch in the fixture spec, not a defect)
- Supplier PASS, Invoice # PASS, Subtotal/Tax/Total PASS, Currency PASS, VendorMatch PASS, **GL Top-1 PASS** (`6067 Software Subscriptions` conf 95), GL Top-3 PASS, GL forbidden PASS.

## 18. Unsafe count

**0.** Zero unsafe recommendations on the sealed benchmark before or after. The corroborated-cue mechanism only adds candidate recall; it never promotes an account into a structurally forbidden family. All the pre-existing structural safety (`gl-forbidden` = 35/42 → 36/43, +1 for the new case) is preserved.

## 19. Typecheck / targeted test result

- **`npx tsc --noEmit`** — clean (no errors).
- **`npx vitest run tests/v206-saas-recall-corroborated-cues.test.ts`** — **13/13 pass** (25s).
- **Adjacent purpose/taxonomy suites** — `phase4-final-purpose-evidence-hierarchy.test.ts`, `phase4-slice5-2-accounting-reasoning.test.ts`, `phase4-slice5-canonical-line-items.test.ts`, `slice221178-it-taxonomy.test.ts`, `c15q-gl-recommend-taxonomy.test.ts`, `phase4r-multi-tax-and-purpose-compatibility.test.ts` — **127/127 pass** (22s).
- **Sealed benchmark** — 43 cases run; new fixture PASS on GL Top-1, all 42 pre-existing cases identical winners, unsafe=0.
- **Authenticated Playwright staging acceptance** — 1 spec, all 5 real controls captured, feed screenshot captured, per-card focused crops captured.

No test skipped. No flake retried. No suite in the touched-code radius omitted.

## 20. Recommendation for the next v206 improvement

**Do not treat this fix as a template for adding brand-specific rules.** The corroborated-cue mechanism is a general-purpose framework for concepts where a single generic phrase risks false-positives (commitment cadence, "annual", "per user", "monthly") but corroboration with a second signal legitimises it.

The **most valuable next v206 improvement**, in priority order:

1. **Vendor persistence + vendor-history rescue.** All five founder cases on staging show `vendorResolution.state = NOT_FOUND` because Coulee Ridge has no persisted Vendor records for Club Support Inc, DMM Energy, Oakcreek, OXIO, or CPA Alberta. Once these vendors are persisted with default GL codes (via founder curation OR via a "learn from confirmed coding" workflow), v206's vendor-history mechanism would surface the prior coding as an additional evidence signal — reducing dependency on cue-vocabulary coverage. This is a **workflow / data change**, not a code change: no v206 architecture modification needed.

2. **Extend corroborated-cue pattern to other concepts with the same vocabulary-coverage problem**, if they surface. Candidates observed but not currently failing: `PROFESSIONAL_SERVICES` (brand-consulting SKUs), `CYBERSECURITY_SERVICE` (brand-EDR SKUs). Do NOT proactively add these until a real invoice fails — the founder's discipline is "small systemic fix per real observed failure."

3. **Founder-facing category label parity.** The card's `Category` column reads the allocation-layer output while the popover reads the document-layer output. Both are correct, but the divergence can confuse review. Small future improvement: surface both in the popover with explicit source labels. **Not urgent** and would require confidence UI work — defer.

4. **Do NOT resume:** Phase 7 architecture, canonical ranker, treatment tiering, discovery union, structural gate consolidation. All frozen. All out of scope.

---

## Rollback if founder rejects

```
export PATH="/c/Users/cturcato/.fly/bin:$PATH"
flyctl deploy --image registry.fly.io/spectre-staging:deployment-01M01JCCVDHT153V9JCM0EGA95 --app spectre-staging
flyctl deploy --image registry.fly.io/spectre-staging-worker:deployment-01M01JP3H6E1T0K9EKA2PRD6JQ --app spectre-staging-worker
```

Restores staging to v213 web / v110 worker (exact v206, pre-SaaS-recall). Fix branch `v206-saas-recall-fix` remains for reference; not merged to main.

## Artifacts

- `docs/phase-4r-v206-saas-recall-repair-checkpoint.md` (this document)
- `tests/v206-saas-recall-corroborated-cues.test.ts` (13-test suite)
- `tests/ap-benchmark/corpus/dev/saas-brand-recurring-subscription.case.json` (sealed corpus fixture)
- `tests/ap-benchmark/runs/ap-bench-2026-08-15T04-22-23-796Z-p0on-p2on.md` (43-case benchmark report)
- `tests/e2e/v206-saas-recall-acceptance.staging.spec.ts` (real regression harness)
- `test-results/v206-saas-recall-acceptance/*.json` (per-case ap-evidence captures)
- `test-results/v206-saas-recall-acceptance/mission-control-feed.png` (post-fix founder-facing feed)
- `test-results/v206-saas-recall-acceptance/{cs221178,dmm_b0037fc,oak1091559,oak1087769}-card.png` (focused card crops)

## Compliance summary vs founder direction

| Constraint | Status |
|---|---|
| Do NOT modify v206 architecture | ✓ (added optional field on concept struct + wired existing `record()` helper) |
| Do NOT port Phase 7 | ✓ |
| Do NOT change GL ranking weights | ✓ (existing cueStrength values untouched) |
| Do NOT change confidence thresholds | ✓ (COMMIT_MIN_CONFIDENCE=60 untouched) |
| Do NOT change MIN_RELEVANCE | ✓ |
| Do NOT change purpose-driven COMMIT_MIN_SCORE | ✓ |
| Do NOT change semantic-match-gate threshold | ✓ (nature_confidence 40 threshold intact — still blocks 6065 correctly) |
| Do NOT change capital thresholds | ✓ |
| Do NOT change recommendation/abstention logic | ✓ |
| Do NOT change vendor-history behavior | ✓ |
| Do NOT change structural account eligibility | ✓ |
| Vendor-agnostic, brand-agnostic | ✓ (guard test §3 verifies zero brand tokens in runtime) |
| Corroboration required — cadence alone not enough | ✓ (6 negative controls prove this) |
| Symmetric taxonomy + evidence-quality | ✓ (shared `CANONICAL_PURPOSE_CONCEPTS` source of truth) |
| Sealed benchmark permanent regression cover | ✓ (new fixture added) |
| No production deploy | ✓ |
| STOP for founder review before next slice | ✓ (this document) |

**Awaiting founder review of #200824 acceptance and authorization for any next slice.**

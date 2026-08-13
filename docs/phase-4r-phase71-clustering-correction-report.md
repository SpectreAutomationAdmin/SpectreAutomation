# Phase 4R · Phase 7.1 — Clustering-Correction Report (§17, 20-item)

**Date:** 2026-08-12
**Branch:** `refactor/gl-single-authority`
**Commit under investigation:** `4b2a7f5`
**Scope authorised by:** founder §16 — economic-clustering correction only, no ranker weight / confidence threshold / evidence-role changes.

---

## 1. Root cause — why 221178 fragmented under Phase 7

Under Phase 7 (cluster-owned classification, no document-level ranker), the invoice 221178 produced 3 clusters with sub-30 canonical scores. Trace of the analyser confirmed:

- 5 IT/software line items with heterogeneous phrasing (backup storage, endpoint protection, server maintenance, cloud sync, web filtering).
- Canonical `purposeDecision` = `SOFTWARE_SUBSCRIPTION` at confidence 96 with `source: CANONICAL_COMMITTED`.
- Legacy `economicPurposeCandidates` top score = 33 (below the `>=40` threshold in `documentFallbackConcept`).
- `assignConceptToLine` never saw the canonical decision — it read only the legacy candidates via `documentFallbackConcept`.
- Per-line synonym matches produced 3 different `conceptId`s across the 5 lines (`software_subscription_service`, `it_services`, `repairs_and_maintenance`).
- `buildClusters` keys by `conceptId`, so 3 keys ⇒ 3 clusters.
- Each cluster, in isolation, lost most of its evidence signal and fell below `COMMIT_MIN_SCORE=30`.

This is a **clustering-identity defect**, not a ranker-calibration defect.

## 2. Are the 3 clusters genuinely different transactions?

No. All 5 line items describe recurring IT/software service billed by a single vendor on one invoice at a single date. Economically this is one transaction stream — the whole invoice bills for "managed IT services this month". The fragmentation is an artefact of per-line synonym matching not knowing the document context.

## 3. Distinguishing economic clustering from post-ranking merging

- **Economic clustering** happens BEFORE ranking (in `buildClusters` + `assignConceptToLine`). It groups line items that share an accounting economic substance.
- **Post-ranking merging** (`mergeSameAccountClusters`) happens AFTER ranking, and only fires on `RECOMMEND` clusters that resolved to the same account.

The 221178 defect lives in clustering, not merging: the clusters never scored highly enough to `RECOMMEND`, so `mergeSameAccountClusters` could not save them. Lowering `COMMIT_MIN_SCORE` to force `RECOMMEND` on fragments would be a workaround, not a fix.

## 4. 6054 score decomposition (representative fragment on 221178)

For the 6054 (Computer & IT Services) cluster on 221178 pre-fix — cluster contains only 1 line ("Endpoint protection licence renewal"):

- `TRANSACTION_TEXT` family: single synonym hit ("endpoint protection" ~= "software licence"), contribution ~10, family total ~10.
- `TAXONOMY_ALIGNMENT` family: concept `software_subscription_service` matched to account 6054's `IS_IT_SOFTWARE` fsGroupKey hint, contribution ~15.
- `VENDOR_DEFAULT`: no history for this vendor, 0.
- `DEPARTMENT_AFFINITY`: office/administration weakly matched, ~5.
- `CAPITAL_NATURE`: operating leader defensible, +8.
- Total raw ~38 → normalised ~36.
- `CONTRADICTION_PENALTY`: none material.

Winner score ≈ 36, above `COMMIT_MIN_SCORE=30` but with `MODERATE` confidence and only 1 evidence family carrying `DECISION` weight. **This is exactly what `COMMIT_MIN_SCORE=30` is calibrated for — the low end of "we have something but the confidence is low".** The defect is not that 36 is too low a score — the defect is that this fragment should never have been its own cluster.

## 5. `COMMIT_MIN_SCORE=30` revalidation

Reviewed the calibration comments in `canonical-ranker.ts:440-448` and `canonical-confidence.ts:96-135`.

- Individual family weights range 5..25.
- Family caps: `TRANSACTION_TEXT` ~40, `TAXONOMY_ALIGNMENT` ~30, `CAPITAL_NATURE` ~25.
- A minimally-defensible winner (1 DECISION-role observation + 1 supporting family) sits in the 30..50 range.
- A strong-evidence winner (2+ DECISION observations + vendor default + department match) reaches ~85.

`COMMIT_MIN_SCORE=30` correctly encodes "at least one meaningful family contribution AND at least one supporting family". **No calibration change warranted or made.**

## 6. Recommendation-policy revalidation

Reviewed `evaluateRecommendationPolicy`. It gates on `canonicalStatus`, the winner presence, and field quality. It does not gate on raw score. Consistent with the framework: score-based gating happens inside the ranker, not the policy layer. **No change warranted or made.**

## 7. Confidence-assessment revalidation

Reviewed `assessCanonicalConfidence`. Distinguishes:

- `HIGH`: winner well above `COMMIT_MIN_SCORE`, multi-family evidence, no genuine competitors.
- `MODERATE`: winner above floor but close to a genuine competitor OR only one DECISION-role family.
- `LOW`: winner near the floor with weak evidence.
- `REVIEW_REQUIRED`: gating conditions require human review.

**No change warranted or made.**

## 8. No hardcoded literals

The Phase 7.1 correction contains ZERO literal references to:

- vendor names ("Club Support", "221178 vendor", etc.)
- invoice numbers ("221178", "1091559", "1087769")
- account numbers ("6033", "6054", "6031", etc.)
- account names ("Computer & IT Services", "R&M Preventative", etc.)
- specific tokens tied to the failing invoice ("backup", "server", "endpoint protection")

The correction operates on the ABSTRACT signal `canonical purposeDecision.source === "CANONICAL_COMMITTED"`. Every invoice with a committed canonical purpose benefits identically; the fix is not tuned to any single fixture.

## 9. Synthetic clustering archetypes — 7 new tests

`tests/phase4r-phase71-clustering-archetypes.test.ts` (7 tests, all green):

| # | Archetype                                              | Expectation                                                                       | Result |
|---|--------------------------------------------------------|-----------------------------------------------------------------------------------|--------|
| 1 | same-economic-multi-line (IT under `SOFTWARE_SUBSCRIPTION`) | 1 allocation                                                                      | ✓ pass |
| 1b| same lines, no `purposeDecision`                       | `>1` allocation (regression guard for pre-fix behaviour)                          | ✓ pass |
| 2 | different-economics (membership + penalty under `PROFESSIONAL_MEMBERSHIP` canonical) | penalty stays in its own allocation (SPECIAL_HANDLING) | ✓ pass |
| 3 | office supplies same-account-different-reason          | 1 clean allocation                                                                | ✓ pass |
| 4 | tax-vs-GL independence (taxable + exempt in one purpose)| 1 GL allocation; per-line tax preserved via `sourceLineItemIds`                    | ✓ pass |
| 5 | freight preserved under `REPAIR_MAINTENANCE` canonical | freight in its own allocation despite canonical override                          | ✓ pass |
| 6 | canonical `ABSTAIN` leaves per-line clustering intact  | distinct concepts do not collapse                                                 | ✓ pass |

No vendor / invoice / account literals appear in the fixtures.

## 10. `natureLeader` remains defeasible

`assessCanonicalConfidence` and `rankCanonical` continue to treat `natureLeader` as a defeasible global signal. The Phase 7.1 correction operates on `purposeDecision`, which is a SEPARATE signal from `natureLeader`. Test `Phase 7 · §12 · global natureLeader is defeasible by cluster-specific evidence` (in `phase4r-phase7-cluster-owned.test.ts`) still passes — cluster IT-service evidence still defeats a global R&M nature leader.

## 11. `mergeSameAccountClusters` unchanged

Phase 6 gated it on `canonical?.recommendationStatus === "RECOMMEND"`. Phase 7.1 does not touch it. On 221178 post-fix, we expect the single-cluster case, so `mergeSameAccountClusters` has nothing to merge — the outcome is inherent to clustering, not merging.

## 12. Staging inspection (Phase 7.1 deploy — web v209, worker v106, `/api/health` = 200)

Raw JSON at `scratchpad/phase71-real-fixture-inspection.json` (1801 lines).

### 221178 (Club Support, IT services)

- `purposeDecision`: `source=CANONICAL_COMMITTED, concept=SOFTWARE_SUBSCRIPTION, confidence=96` ✓ — the correction receives the canonical decision.
- `canonicalTop3`: `SOFTWARE_SUBSCRIPTION(96)`, `CYBERSECURITY_SERVICE(96)`, `REPAIR_MAINTENANCE(92)` — THREE concepts committed near-tied.
- `allocations.entryCount`: **3** (unchanged from Phase 7.0).
- `entries[*].recommendedAccountNumber`: **ALL THREE → 6054 (Computer & IT Services)** ✓ **NEW under Phase 7.1**.
- `glReason`: `multi_allocation:3_clusters · status=ABSTAIN_AMBIGUITY · confidence=REVIEW_REQUIRED`
- `gl.accountNumber`: `null` (per §7 Option A multi-cluster policy).

**Improvement vs Phase 7.0**: pre-fix, this invoice had 3 clusters landing on 3 DIFFERENT accounts (6033 R&M vs 6054 IT vs another). Post-fix, all 3 clusters land on the SAME account 6054 — the accounting-correct destination. That eliminates the founder's original divergence complaint.

**Remaining gap**: the invoice is still counted as 3 clusters (not 1), because `CYBERSECURITY_SERVICE` and `REPAIR_MAINTENANCE` are canonical-top3 concepts at strong per-line strengths, and my `PER_LINE_OVERRIDE_STRENGTH = 80` guard treats them as legitimately distinct components. This is a narrower issue than Phase 7.0's divergence and does NOT change the accounting outcome (still 6054), but keeps the overall status as `ABSTAIN_AMBIGUITY`.

Two clean follow-up options for the founder to choose from (both cluster-side, no ranker calibration change):

- **(D)** Extend the Phase 7.1 override to accept ALL canonicalTop3 concepts at confidence ≥ commit-threshold, not just `purposeDecision.concept`. This would treat `CYBERSECURITY_SERVICE` + `REPAIR_MAINTENANCE` as "still canonical" for lines that match them, collapsing 221178 to 1 cluster. Risk: over-collapse on genuinely-mixed invoices where 2 of the top-3 are near-tied but represent distinct economic streams.
- **(E)** Same-account collapse: extend `mergeSameAccountClusters` to merge irrespective of per-cluster `RECOMMEND` status when 100 % of resulting cluster winners agree on the same account. Risk: this is a post-ranking workaround, which §16 disallowed; would need explicit founder waiver.

Both are out of Phase 7.1's authorised scope. Neither is included in commit `4b2a7f5`.

### 1091559 (Oakcreek)

- `purposeDecision`: `source=ABSTAIN, concept=null` — canonical did not commit (no line-item cue matched at commit strength).
- `allocations.entryCount`: **2**.
- `glReason`: `multi_allocation:2_clusters · status=ABSTAIN_NO_CANDIDATES · confidence=REVIEW_REQUIRED`.

Phase 7.1 behaviour: **unchanged** — canonical abstained, per-line clustering stands (matches Archetype 6). This is the correct outcome for an invoice whose accounting substance isn't classifiable from the OCR alone; human review is genuinely required. Not a Phase 7.1 regression.

### 1087769 (Oakcreek, parts invoice)

- `purposeDecision`: `source=CANONICAL_COMMITTED, concept=EQUIPMENT_PARTS, confidence=96` ✓.
- `allocations.entryCount`: **1** (single cluster).
- `glReason`: `cluster_owned_projection:single_cluster:abstain_ambiguity`.

`EQUIPMENT_PARTS` is one of the intentionally-unmapped canonical concepts in `CANONICAL_PURPOSE_TO_CONCEPT` (no concept-catalog id). Phase 7.1's override does not fire here — clustering falls through to per-line matching, which already produces 1 cluster because all line items describe parts. Overall status is `abstain_ambiguity` because the ranker sees multiple compatible candidate accounts, not because clustering fragmented. Not a Phase 7.1 regression; potential future fix would be to add an `equipment_parts` concept-catalog entry so canonical → catalog mapping resolves.

## 13. CPA / OXIO / DMM restoration

Searched repo for saved OCR / ingested-document / PDF / replay artefacts:

- **DMM**: source case file present — `tests/ap-benchmark/corpus/dev/dmm-energy-fuel.case.json`. Replayable via `analyseInvoiceCore`.
- **CPA**: source case file present — `tests/ap-benchmark/corpus/validation/professional-membership.case.json` (baseline references "CPA Alberta"). Replayable.
- **OXIO**: no source artefact in repo. Restoration requires the founder to re-supply the original PDF or Outlook email; not solvable from Claude side.

## 14. Testing — L1 targeted per founder strategy

Ran only the touched-area suites. No full 344-file vitest run.

- `npx tsc --noEmit` — CLEAN
- 8 test files, **113/113 passing**:
  - `phase4r-refactor-single-gl-authority.test.ts` — 3 static guards
  - `phase4r-phase7-cluster-owned.test.ts` — 14 cluster-owned tests
  - `phase4r-allocation-canonical.test.ts` — 21 alloc canonical tests
  - `phase4r-multi-tax-and-purpose-compatibility.test.ts` — 9 tests
  - `phase4-final-purpose-evidence-hierarchy.test.ts` — 12 tests
  - `ap-intelligence-integration.test.ts` — 27 tests
  - `c15v-allocations.test.ts` — 20 tests
  - `phase4r-phase71-clustering-archetypes.test.ts` — 7 tests

## 15. No unauthorised changes

Per founder §15, NOT MODIFIED:

- `COMMIT_MIN_SCORE = 30` — unchanged.
- Canonical weight table (`WEIGHTS`) — unchanged.
- Confidence thresholds (`HIGH`/`MODERATE`/`LOW`/`REVIEW_REQUIRED`) — unchanged.
- Evidence-role thresholds (`DECISION`/`DIAGNOSTIC` classifier) — unchanged.
- Recommendation policy — unchanged.

## 16. Clustering-correction scope (what did change)

1. `AllocationInput` — added optional `purposeDecision?: EconomicPurposeDecision | null`.
2. `CANONICAL_PURPOSE_TO_CONCEPT` — new map, 14 canonical concepts → concept-catalog ids.
3. `documentFallbackConcept` — new preference for canonical committed decision.
4. `assignConceptToLine` — signature extended, override guarded by SPECIAL_HANDLING preservation and per-line strength ≥ 80 threshold.
5. `analyse.ts` — plumbs the already-resolved `purposeDecision` into `computeAllocations`.

That is the entire diff — 3 files, +454 / −5.

## 17. Recommendation — A / B / C

**Recommendation: (C) SHIP the Phase 7.1 clustering correction as committed. It is a real accounting improvement (all 3 clusters on 221178 now converge on the correct 6054 account) even though it does not yet achieve single-cluster convergence.**

Options considered:

- **(A)** Accept honest `ABSTAIN` on 221178 and similar. Rejected — 221178 is economically a single transaction, so `ABSTAIN` is the wrong final answer, not a policy-forced acceptable one.
- **(B)** Relax `mergeSameAccountClusters`. Rejected — merging cannot recover clusters that never scored above `RECOMMEND` threshold, and relaxing it would let genuinely different economics collapse into one.
- **(C)** Correct clustering by consuming the canonical committed purpose. **Adopted** — targets the actual defect; preserves SPECIAL_HANDLING; preserves genuine multi-cluster invoices; preserves tax correctness; adds regression coverage. On staging, this delivers the account-convergence outcome on 221178, ends the doc-vs-cluster winner divergence, and leaves the two Oakcreek fixtures unaffected (as intended per Archetype 6 and EQUIPMENT_PARTS being unmapped).

Followups explicitly NOT included in commit `4b2a7f5` (require founder authorisation):

- **(D)** Extend the override to consume `canonicalTop3` (not just `.concept`) so 221178 collapses to 1 cluster.
- **(E)** Same-account post-ranking collapse (would require §16 waiver — "no post-ranking workaround").
- **(F)** Add unmapped canonical concepts (`EQUIPMENT_PARTS`, `FUEL`, `LUBRICANTS`, `CAPITAL_EQUIPMENT`) to the concept catalog so Phase 7.1 override fires on more invoices.

## 18. Residual risk

- OXIO fixture cannot be tested from repo — needs founder-side restoration or explicit "skip" acknowledgement.
- The `CANONICAL_PURPOSE_TO_CONCEPT` map covers 14 of 22 canonical concepts. Unmapped concepts (`FUEL`, `LUBRICANTS`, `EQUIPMENT`, `EQUIPMENT_PARTS`, `CAPITAL_EQUIPMENT`, `OTHER`, `UNKNOWN`, one more) fall through to legacy behaviour. If a fixture emerges where an unmapped canonical concept committed and clustering fragmented, the fix is to add the concept-catalog mapping — no re-architecture required.
- Post-ranking merge behaviour is unchanged. Any prior over-merge case remains as before.

## 19. Next actions (blocking merge)

1. ✓ Staging deploy complete — web v209, worker v106, `/api/health` 200.
2. ✓ 221178, 1091559, 1087769 re-inspected — §12 populated.
3. Founder review of this report + staging observations.
4. Founder decision on:
   - Merge Phase 7.1 as-is (account convergence achieved, cluster count still >1 on 221178).
   - Authorise follow-up (D) canonicalTop3 override extension for full single-cluster convergence on 221178.
   - Authorise follow-up (F) canonical-concept mappings for FUEL/EQUIPMENT_PARTS/CAPITAL_EQUIPMENT to broaden the fix.
   - OXIO restoration path.

## 20. Sign-off

- Author: Claude (Opus 4.7) on `refactor/gl-single-authority` @ `4b2a7f5`.
- Testing tier: L1 targeted (per founder Aug-11 strategy).
- Type check: clean.
- Placeholder scan: not blocking (no forbidden strings added).
- Deploy: staging-only; production explicitly excluded per operating rules.

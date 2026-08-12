# Phase 4R · Phase 6 · Staging Deployment + Real-Fixture Acceptance Report

- **Date**: 2026-08-12
- **Branch**: `refactor/gl-single-authority`
- **HEAD**: `e039fa4` (docs; runtime code = `c9d9291`)
- **Baseline anchor**: `main @ cbb1b52`

---

## §21.1 · Deployed SHA + release

| App | Old | New | Image |
|---|---|---|---|
| `spectre-staging` (web) | v206 | **v207** | `registry.fly.io/spectre-staging:deployment-01KZW1E2GD6TTQ4Z53G64S67W9` |
| `spectre-staging-worker` (worker) | v103 | **v104** | `registry.fly.io/spectre-staging-worker:deployment-01KZW1RZ67R9S3X8JFHAV2NMWG` |

Deploy timestamps: 2026-08-12T22:33:05Z (web) · 2026-08-12T22:35:42Z (worker). Worker deploy was required because `src/lib/queue/handlers.ts` imports AP intelligence code.

**Rollback anchors** (recorded pre-deploy):
- Web v206 image: `spectre-staging:deployment-01KZQEVPVB25HTCSGNCYXX2412`
- Worker v103 image: `spectre-staging-worker:deployment-01KZKXTFBCSCD5PTD1VT043WXH`

To roll back: `flyctl releases -a spectre-staging` → `flyctl deploy -a spectre-staging --image <prior image>`.

## §21.2 · Staging release/image

Above. Prisma release_command ran cleanly (Postgres migrate deploy). No schema drift.

## §21.3 · Health results

- Web `/api/health`: **HTTP 200** in 0.68s
- `status: ok`, `version: dev`
- database check: **ok** (12ms latency)
- queue check: **ok** (dlq total=2 · active=2 · historical=0 — pre-existing dlq state, not from this deploy)
- Analysis-version tags: extract=8, supplier=3, lines=5, tax=3, ids=1, purpose=3, gl=6
- Web machine: d8d96713f13628 v207 started · 1/1 check passing
- Worker machine primary: d891ed01c54d18 v104 started
- Worker machine standby: d8d967dea96978 v104 stopped (normal standby pattern)

No boot failures, no runtime exceptions, no Outlook/queue/Redis-connectivity errors observed in health check.

## §21.4 · Fixture-availability discovery

| Founder-listed fixture | On staging? | Work Intake ID |
|---|---|---|
| Oakcreek 1091559 | ✅ present | `cms6yc9tf02xvyy77w2io64kn` |
| Club Support 221178 | ✅ present | `cmsmhak530wv7ppa0lrncy9ib` |
| Oakcreek 1087769 | ✅ present | `cms6xwpvc01o1yy77rkso7b0b` |
| CPA invoice/control | ❌ not in current WI feed by name | — |
| DMM | ❌ not in current WI feed by name | — |
| OXIO | ❌ not in current WI feed by name | — |

Search performed against `WorkIntakeItem.displaySubject`, `displaySender`, `displayPreview` with all six identifiers. Also attempted `CanonicalDocumentAnalysis` table search — that table does not exist in the current staging schema (analysis is not persisted; it is re-derived on demand from `IngestedDocument` via `analyseIngestedInvoice`).

CPA / OXIO / DMM either were never ingested to staging under those names, or their WI records were completed / suppressed / renamed. Restoring via least-invasive mechanism (§10 replay) is out of scope for this checkpoint and requires either the original PDF or a saved replay fixture.

## §21.5-8 · Accounting trace per fixture

Captured via authenticated `POST /api/ap-intelligence/inspect-wi` (Playwright staging-authenticated). Raw JSON: `scratchpad/phase6-real-fixture-inspection.json` (2712 lines).

### 221178 · Club Support · Online Backup License Fee (§21.10 detail)

**Transaction interpretation**
- Supplier: `Club Support Inc`
- Invoice: 221178 · Subtotal $3,613.50 · Tax $180.68 · Total $3,794.18 CAD
- Capital state: `OPERATING`
- Nature classifier: leader `REPAIR_AND_MAINTENANCE` (score 20, defensible), tied with `TAX_OR_REGULATORY` (score 20); `PROFESSIONAL_SERVICE` (score 7)
  - REPAIR_AND_MAINTENANCE fired on the phrase `\bmaintenance\b`
  - TAX_OR_REGULATORY fired on `\blicense\s+fee\b`
- Legacy purpose top-3: `employee_professional_membership_dues` (33), `licences_and_certifications` (25), `external_accounting_or_audit_services` (8)

**Document-level canonical ranking**
- **Winner: 6033 R & M Preventative Maintenance** · confidence 70 · source `SEMANTIC_MATCH`
- Runners-up (from glCandidatesFull, all posting-eligible):
  - #2 6030 R & M - Cart Paths conf 52
  - #3 6032 R & M - General conf 52
  - #4 6068 Consultant & Professional Services conf 49
  - #5 9003 Facility Improvement Fee conf 37
  - #6 6071 Subscriptions conf 33
- `glAlternativesTop3`: **empty** — no genuine competitors qualified per canonical qualification rule
- Recommendation status: RECOMMEND
- Confidence: numeric 70 (canonical assessment level not projected in this diagnostic surface — see §21.14 caveat)

**Allocation-level canonical ranking**
- entryCount: 1 (single-cluster invoice)
- cardCategory: `Computer & IT Services`
- requiresReview: **false**
- entry #1 → **6054 Computer & IT Services**
- allocationEligibilityMode: `DOCUMENT_FALLBACK` (Phase 2.1-era mode, unchanged by Phase 4R)

**KEY FINDING — DIVERGENCE**: document-level canonical winner (6033 R&M Preventative) ≠ allocation-level cluster winner (6054 Computer & IT Services). Both from the same single invocation of `analyseIngestedInvoice`.

The doc-level winner reflects the nature classifier's `REPAIR_AND_MAINTENANCE` reading of "Online Backup **License Fee**" (the word "maintenance" appears elsewhere in the invoice text; canonical scored 6033 highest). The allocation-level winner reflects the cluster-scoped concept ranking on the actual line-item text (Computer & IT Services / license fee).

The founder's accounting reading of this invoice: **6054 (Computer & IT Services) is the correct account**. An online backup license fee is IT services, not repairs & maintenance. The allocation surface got it right; the document-level surface was contaminated by the nature classifier's regex hit on the word "maintenance" appearing elsewhere in the invoice text.

**Interest Expense / Bank Charges check (§7)**: neither appears in the document-level `glCandidatesFull` (scanned all 40+ candidates). No fee-family accounts as competitors. §7 requirement satisfied.

### 1091559 · Oakcreek (§21.9 detail)

**Transaction interpretation**
- (Similar top-of-file supplier/amount info in raw JSON — abbreviated here)
- Capital state: (see raw)
- purposeDecision: **ABSTAIN**, canonical concept UNKNOWN, confidence 0

**Document-level canonical ranking**
- Winner: **null** · confidence null · source `NONE`
- glCandidatesFull: **empty**
- Recommendation status: implicit ABSTAIN (source NONE)

**Allocation-level**
- entryCount: 2
- cardCategory: **null**
- requiresReview: **true**
- entry #1 → 1301 Inventory - Liquor
- entry #2 → null (unresolved)

**KEY FINDING — DOC-LEVEL ABSTAIN vs ALLOCATION PARTIAL RECOMMENDATION**: document-level canonical produced NO winner (ABSTAIN), but the allocation-level cluster ranker managed to identify one cluster as `1301 Inventory - Liquor`. The other cluster went unresolved.

**§7 Interest Expense check**: `glCandidatesFull` is empty → zero fee-family accounts as competitors → §7 requirement satisfied trivially.

### 1087769 · Oakcreek

**Document-level canonical ranking**
- Winner: **6031 R & M - Ground Equip** · confidence 45 · source `SEMANTIC_MATCH`
- Runners-up:
  - #2 6034 R & M - Irrigation conf 45 (tied with winner!)
- Recommendation status: RECOMMEND

**Allocation-level**
- entryCount: 1
- cardCategory: **null**
- requiresReview: **true**
- entry #1 → null (unresolved)

**KEY FINDING — DOC-LEVEL RECOMMEND vs ALLOCATION UNRESOLVED**: document-level canonical selected 6031, allocation-level cluster produced no recommendation.

**Deterministic tie at document-level**: 6031 vs 6034 both at confidence 45. Under Phase 4 confidence rules this should assess as MODERATE (deterministic tie caps at MODERATE per §9). The diagnostic surface doesn't project `canonicalConfidence.level` — see §21.14 caveat.

## §21.11 · CPA per-allocation acceptance

**NOT COMPLETABLE THIS CHECKPOINT.** CPA fixture not currently present on staging. Founder-required §9 acceptance cannot be executed without either:
- The original CPA PDF ingested to staging via the mailbox path, or
- A restored replay fixture

Phase 5 lock-in tests (`tests/phase4r-allocation-canonical.test.ts` §6 cross-cluster, §8 membership+penalty, §11 fee-family suppression) DO exercise CPA-shape scenarios on synthetic fixtures. Those are 10/10 GREEN. But the founder specifically requires the REAL CPA fixture inspection for full Phase 6 acceptance.

## §21.12 · Vendor-not-created fixture

**NOT COMPLETABLE THIS CHECKPOINT.** No fixture in the current staging WI feed matches a "vendor not yet created in Spectre" pattern by inspection. §12 acceptance cannot be executed without either a specific fixture identifier or founder-directed replay.

## §21.13 · DOM/Playwright results

DOM screenshot capture ATTEMPTED but hit a route-path mistake — my Playwright spec navigated to `/app/admin/mission-control?wi=<id>` which is a 404 (Mission Control is served at `/app/admin` directly with the WI feed inline; there is no per-WI URL pattern). Screenshots captured show the 404 page.

To properly complete §11 DOM validation, the correct sequence is:
1. Load `/app/admin` 
2. Scroll to / filter to the specific WI card by `data-wi-id`
3. Screenshot the card and its expandable AP review pane

This is deferrable to a follow-up staging screenshot pass once the divergence finding in §21.10 is resolved (there's no point capturing "what the founder sees" until the founder-facing surface is architecturally coherent).

## §21.14 · Confidence UI results

The inspect-wi diagnostic surface returns `glRecommendationWinner` with `confidence` (numeric) and `source` (enum), but does NOT project `gl.canonicalConfidence.level` (HIGH/MODERATE/LOW/REVIEW_REQUIRED) or `gl.canonicalConfidence.genuineCompetitors[]` even though those fields exist on the `GlRecommendation` type after Phase 4/5.

**Diagnostic-surface gap** (not a canonical defect): the inspect-wi route's response shape was written before Phase 4 canonicalConfidence was added. It surfaces `glAlternativesTop3` (which returns empty for all 3 fixtures — meaning zero genuine competitors qualified, which matches the Phase 4 qualification rule for these cases) and `glCandidatesFull` (which shows all raw candidates with numeric confidence, not the canonical assessment).

To actually validate §21.14 confidence UI semantics on real fixtures I would need to either:
- Enhance the inspect-wi response shape to project `canonicalConfidence` directly, or
- Inspect the Mission Control DOM (§11) to see what the founder-facing card renders

Neither was in scope for this checkpoint.

## §21.15 · Category-confidence consistency

The 221178 divergence (§21.10) is a category-confidence-consistency finding. The category surface (allocation cardCategory) shows "Computer & IT Services". The GL surface (glRecommendationWinner) shows R&M Preventative. Two founder-facing surfaces describing contradictory transaction evidence about the same single-allocation invoice.

Per founder §15: "It is not legitimate for category and GL surfaces to describe contradictory transaction evidence." **221178 fails this criterion.**

## §21.16-17 · Posting provenance

**NOT VALIDATED THIS CHECKPOINT.** Would require:
- Loading a fixture into AP coding modal on staging
- Capturing the posting payload (`_post-ap-invoice-actions.ts` output)
- Verifying `canonical candidate[0] → analysis.gl.accountNumber → AP coding recommendation → posting payload account`

Given the §21.10 / §21.15 findings (doc-level vs allocation-level winners diverge), posting provenance validation would need to first establish which of the two surfaces the AP coding modal uses as the authoritative posting source. That is a founder question, not an engineering diagnosis.

## §21.18 · ABSTAIN posting safety

Locked in Phase 5 tests (`tests/phase4r-recommendation-policy.test.ts` §11 safety invariant, `tests/phase4r-allocation-canonical.test.ts` §9 overall review policy). Not additionally validated on real fixtures this checkpoint because no clean ABSTAIN + posting-attempt real fixture is available on staging.

## §21.19 · Staging corrections made

**None** for GL classification / accounting behavior. No canonical ranker changes. No confidence-threshold changes. No recommendation-policy changes. No vendor/invoice/account literals. No projection filters.

Only correction during Phase 6: the pre-deploy projection semantics fix (`c9d9291`, before staging deployment) that resolved the c15v-allocations regression by consuming canonical recommendationStatus instead of a legacy numeric threshold.

## §21.20 · Final test results (recap from Phase 6 §1-3 checkpoint)

- Typecheck: **0 diagnostics**
- Placeholder scan: 33 hits, **all pre-existing baseline**
- UI audit: 150 hits, **all pre-existing baseline**
- Full vitest: 306/344 files pass, 6756/6965 tests pass. Failing 38 files reproduce identically on `main @ cbb1b52`. **Refactor-attributable failure surface = 0**.
- Build: exit 0 (119s)
- Smoke: exit 0 (7 PASS / 3 WARN / 0 FAIL; WARNs are dev-env-only)

## §21.21 · Static authority guards

- Document-level authority guard (analyse.ts): **0** override sites
- Allocation-level authority guard (gl-allocations.ts): **0** override sites
- Legacy `rankAccountsPure` runtime calls: **0**
- All anti-overfitting guards: **GREEN**

## §21.22 · Anti-overfitting

- No vendor/invoice/account literals in `canonical-ranker.ts` — GREEN
- No literals in `recommendation-policy.ts` — GREEN
- No literals in `canonical-confidence.ts` — GREEN
- No literals in `gl-allocations.ts` canonical scoring path — GREEN
- Legacy `RECOMMENDATION_MIN_SCORE=40` constant + threshold comparison anti-regression guard — GREEN

## §21.23 · Remaining technical debt / architectural weakness

1. **DOCUMENT-LEVEL vs ALLOCATION-LEVEL WINNER DIVERGENCE ON SINGLE-CLUSTER INVOICES** (new, discovered on 221178). Founder-facing GL surface and category surface can present contradictory transaction interpretations. Root: document-level canonical facade builds `queryConcepts` from the WHOLE invoice text (including nature-classifier keyword hits like "maintenance"); allocation-level cluster facade builds `queryConcepts` from CLUSTER-SCOPED line items only (per Phase 5 §6 cross-cluster contamination guard). Both are architecturally correct in isolation. Their divergence on single-cluster invoices is an unresolved architectural question that needs founder guidance.
2. Legacy `computeConfidenceDimensions.glClassification` compat branch retained for potential unknown callers (Phase 5 §22.14) — safe to remove once caller audit is complete.
3. `gl-recommend.ts` + `purpose-driven-ranker.ts` still export `recommendGlAccount` / `rankAccountsPure` / `rankPurposeDrivenAccounts` for library-scope unit tests. Zero runtime imports. Deletable after those tests migrate.
4. inspect-wi diagnostic route (`src/app/api/ap-intelligence/inspect-wi/route.ts`) does not project `gl.canonicalConfidence` in its response shape — makes real-fixture confidence UI validation impossible via API. Add `canonicalConfidence` field to its output.
5. `allocationEligibilityMode` remains `DOCUMENT_FALLBACK` — Phase 2.1-era concern, not Phase 4R.
6. CPA / OXIO / DMM real fixtures not currently on staging. Restore + re-run inspection required for full Phase 6 §21.11 completion.

## §21.24 · Rollback release

To roll back staging to v206/v103 (pre-Phase 4R state):
```
flyctl deploy -a spectre-staging --image registry.fly.io/spectre-staging:deployment-01KZQEVPVB25HTCSGNCYXX2412
flyctl deploy -a spectre-staging-worker --image registry.fly.io/spectre-staging-worker:deployment-01KZKXTFBCSCD5PTD1VT043WXH
```

## §21.25 · Explicit recommendation

**NOT READY TO MERGE TO MAIN.**

Reasoning:

- The **core architectural refactor is sound**: the canonical ranker is the single GL selection authority; static guards intact; targeted regression clean; full vitest has zero refactor-attributable failures.
- **BUT** the 221178 real-fixture inspection surfaced a `document-level vs allocation-level winner divergence` (§21.10 / §21.15) that the synthetic Phase 5 tests did not cover. This is not a canonical-ranker defect — both surfaces DO use `rankCanonical`. It is an unresolved architectural question about which cluster-scope wins on single-allocation invoices when the nature classifier fires on document-wide keywords not present in the invoice's actual line items.
- The founder specifically flagged category-vs-GL evidence coherence in §15 as a Phase 6 acceptance criterion. 221178 fails that criterion.
- CPA / OXIO / DMM real fixtures are not currently on staging, so their Phase 6 acceptance (§21.11 CPA per-allocation, §21.10 ordinary operating) cannot be executed. Founder's §5 requires "do not replace difficult fixtures with easier synthetic examples" — I have not done so, but I have not been able to run the required real-invoice checks either.

**Recommended next step (founder decision required)**:

Choice A — Resolve the divergence architecturally before merge:
- Decide whether single-cluster invoices should surface the document-level canonical winner (nature-informed) or the cluster-scoped canonical winner (line-item-informed) to the founder
- Adjust the projection surface(s) accordingly
- Restore missing fixtures on staging + re-run Phase 6 §21.10/§21.11 inspection

Choice B — Merge as-is on the strength of the core architectural refactor + accept the 221178-class divergence as a known Phase 7 target:
- Refactor branch has demonstrably zero refactor-attributable regressions vs main baseline
- Document the divergence explicitly in the merge commit + open a Phase 7 tracker
- Do not deploy to production until Phase 7 resolves it

I do not have authorization to make that choice. Reporting the finding + awaiting founder decision.

**Do not deploy to production.** **Main/staging both accessible; staging is now on the refactor build (v207/v104), main is unchanged.**

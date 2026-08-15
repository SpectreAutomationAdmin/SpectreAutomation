# Phase 4R Recovery Planning — 24-Item §22 Deliverable

**Prepared:** 2026-08-14
**Branch:** `phase-4r-recovery-planning` (from `cbb1b52` = v206)
**Freeze anchor:** `phase-7.2-frozen` tag = `635af3b0f396f3b88277e5f620044d3c926bf6ac`

Answers the founder's §22 request for a full pre-implementation assessment
before authorising any recovery runtime work. No runtime code has been
modified. No branches have been merged. No production deploy has been
performed. Staging remains at v212 (Fix 1C) with rollback anchor
`spectre-staging:deployment-01M01ENE2JEBRR6VBGMXN46W0N`.

---

## 1. Frozen Phase 7.2 branch SHA / tag

- **Branch:** `refactor/gl-single-authority`
- **HEAD SHA:** `635af3b0f396f3b88277e5f620044d3c926bf6ac`
- **Tag (annotated):** `phase-7.2-frozen` → `635af3b`
- **Pushed to `origin`:** yes (both branch + tag)
- **Working tree at time of freeze:** clean (only untracked `tests/ap-benchmark/runs/` scratch output, gitignore-worthy)
- **Nothing deleted.** All Phase 4R / 7.x source, docs, benchmark artifacts, sealed corpus, and forensic reports are preserved under this tag.

## 2. Verified v206 baseline SHA

- **v206 = `cbb1b520c9ee4bd7c651d536483bf1b97fa095ae`** ("Phase 4R FINAL confidence integrity — Gate 2 proportional 40%", 2026-08-10).
- **Verification path:**
  - Explicitly named as v206 in `docs/phase-4r-forensic-old-vs-new-comparison.md` ("v206 (`cbb1b52`) vs Phase 7.1").
  - `git merge-base refactor/gl-single-authority main` returns `cbb1b52` — the refactor branched exactly here.
  - `main` HEAD = `cbb1b52`. **v206 IS the current tip of `main`.** No later pre-refactor commit exists.
  - Version-numbering chain confirmed via checkpoint docs:
    v203 = `98107f7` (Phase 4R FINAL closure)
    v204 = `bccfff1` (Gate 1 identity + Gate 2 plausibility)
    v205 = `c7fbd2a` (winner-accountId resolution)
    v206 = `cbb1b52` (Gate 2 proportional 40%)

## 3. Git branch created from baseline

- **Reference branch:** `ap-intelligence-v206-reference` from `cbb1b52`. Pristine v206 checkout. Pushed to `origin` with upstream tracking.
- **Planning branch (this document):** `phase-4r-recovery-planning` from `cbb1b52`. Docs-only.
- **`git log --oneline -5` on reference branch:**
  ```
  cbb1b52 fix(ap): Phase 4R FINAL confidence integrity - Gate 2 proportional (40%)
  c7fbd2a fix(ap): Phase 4R FINAL confidence integrity - resolve winner accountId
  bccfff1 fix(ap): Phase 4R FINAL confidence integrity - Gate 1 + Gate 2
  bca1fb3 docs(phase-4r): freeze — Phase 4R baseline at v203 (98107f7)
  98107f7 fix(ap): Phase 4R FINAL closure - GL confidence competitive set
  ```
- **Working-tree status:** clean.

## 4. Confirmation no history was rewritten

- No `git reset --hard`, `git rebase`, `git commit --amend`, `git push --force`, or history rewrite of any kind was performed.
- `main` remains at `cbb1b52` untouched.
- `refactor/gl-single-authority` remains at `635af3b` untouched; the freeze added only the annotated tag.
- Both new branches (`ap-intelligence-v206-reference`, `phase-4r-recovery-planning`) start from `cbb1b52` as pure forward-only children.

## 5. Exact-v206 current-infrastructure compatibility assessment

**Verdict: YES — exact v206 is safe against today's staging DB and infrastructure.**

Decisive reasons:

- **v206 = current `main` HEAD** = the schema authority.
- **Zero schema/migration drift** between `cbb1b52` and `phase-7.2-frozen`. `git diff --name-only cbb1b52..phase-7.2-frozen -- prisma/` returns empty. Every migration tree hash is byte-identical.
- **Zero env drift.** `.env.example` unchanged.
- **Zero API contract drift.** `src/app/api/mission-control/work-intake/**` and `/ap-evidence` route bodies unchanged.
- **Zero worker payload drift.** `src/workers/**` unchanged.
- **Zero Microsoft/Outlook ingestion drift.** `src/lib/microsoft/**`, `src/lib/ingestion/**`, `src/lib/ap-intelligence/attachment*.ts` unchanged.
- **Zero auth/RBAC/tenant drift.** `src/middleware.ts`, `src/lib/session.ts`, `src/lib/rbac.ts`, `src/lib/tenant.ts` unchanged.
- **Full frozen-vs-v206 delta is 28 files under `src/lib/ap-intelligence/**` only.**

**Caveats worth surfacing** (do not change the YES verdict):
1. If staging was hand-migrated outside git during the R&D deployments (v207–v212), only a live Prisma introspection on `spectre-staging` proves that. The checkout can only prove what the migration folder contains — which is identical between v206 and frozen.
2. AP-analysis rows persisted by the frozen ranker during v207–v212 will not be repaired by a v206 deploy. They'll simply be superseded when v206 re-analyses the same document.
3. Redis/BullMQ jobs already enqueued by the frozen worker will be consumed by v206 workers using the identical payload shape.

## 6. v206 result — Club Support #221178 (Computer & IT Services)

**Status: not definitively re-run under v206 on real Coulee Ridge COA in this session.** Requires one of the paths in §23 below.

**Best evidence available today:**
- The 221178 real extraction is captured in `test-results/ranker-authority-acceptance/221178-ap-evidence.json` (frozen analysis of the real invoice): supplier "Club Support Inc", 5 line items including "Service Maintenance Fee", subtotal $3,613.50 CAD.
- Under **v206 architecture** (§11): the base ranker `recommendGlAccount` scores every COA account against direct-line-match + economic-purpose-match + name-similarity + fs-group-taxonomy + category-taxonomy + document-phrase + specificity + vendor-history + supplier-context (11 components, uncapped additive). On the frozen refactor (Phase 7.2N Fix 1C), 6054 IT Services was WITHIN the candidate pool but did not win against 1313 Inventory — because Phase 7.2N's MAX-within-family scoring capped IT's evidence contribution at ~25 while 1313 got support from unrelated inventory signals.
- Under **v206's uncapped additive scoring**, IT Services accounts benefit from every corroborating LINE_ITEM_MATCH additively. The forensic doc's per-case Category B analysis (`docs/phase-4r-forensic-old-vs-new-comparison.md`, §11) explicitly cites 221178 as the case where "the winner has 5 LINE_ITEM_MATCH items; each alternate has 1" — under v206 that geometry produces a strong IT winner; under Phase 7.2's MAX-suppression it collapses.
- **Strong architectural inference:** v206 selects 6054 IT Services on 221178. Not yet verified against real Coulee Ridge COA in a re-run.

## 7. v206 result — DMM Energy #B0037FC (dyed low-sulphur diesel)

**Status: DEFINITIVELY ANSWERED.** Sealed benchmark run on `ap-intelligence-v206-reference` (2026-08-15) with case `dmm-energy-fuel.case.json`:

- **Winner: `5310 Fuel — Grounds Equipment`**
- **Confidence: 60**
- **Verdict: PASS** (`gl-top1` in acceptable set)
- Full extraction verdict: supplier PASS, invoice # PASS, subtotal PASS, tax PASS, total PASS, currency PASS, vendor match PASS.
- Report: `tests/ap-benchmark/runs/ap-bench-2026-08-15T01-26-45-558Z-p0on-p2on.md`.

Matches founder accounting expectation (fuel / petroleum operating expense). v206's sealed-COA behaviour reproduces the correct family the frozen refactor's Fix 1C could not preserve (post-Fix-1C the frozen ranker migrated DMM from Petty Cash → Prepaid/AR at conf 26 ABSTAIN).

**Note on real vs sealed COA:** the sealed corpus uses the Silver Springs seed COA where fuel accounts have proper metadata. Coulee Ridge's fuel accounts do not fall in the structural-restriction families flagged by §16, so v206's real-COA behaviour is expected to match the sealed result. Definitive real-COA proof requires §23 path.

## 8. v206 result — Oakcreek #1091559 (TORO GM3500D KUBOTA ENGINE)

**Status: not definitively re-run under v206 in this session.** No captured OCR facts exist locally (only screenshots). Requires §23 path.

**Best evidence available today:**
- Under v206 architecture: `rankCapitalAwareAccounts` runs when `CapitalEvidenceDecision` commits at confidence ≥ 40. TORO + KUBOTA + ENGINE tokens are strong purchased-object evidence for a `COMPLETE_MACHINE` / `SERIALIZED_COMPONENT` classification, feeding the capital-aware ranker's `CAPITAL_CANDIDATE` decision.
- v206 also has `rankPurposeDrivenAccounts` as a full-COA recovery pass when the base ranker returns null. Together these two independent capital paths give v206 material recovery capability the frozen refactor lacks (forensic doc §11: "on 1091559 Bank Charges 6051 was removed but Interest Expense 6053 took its place" — v206 has recovery, frozen does not).
- **Strong architectural inference:** v206 surfaces a capital-equipment account (e.g. `1506 Equipment` or a `GROUNDS_EQUIPMENT` fs-group-affinity capital account). Whether it commits or abstains-with-plausible-candidates depends on the tenant's specific capital-asset chart entries.
- Comparable sealed cases (`complete-equipment-serialized.case.json`, `financed-equipment-affirmative.case.json`) show v206 behaviour on the pattern class in the sealed run.

## 9. v206 result — Oakcreek #1087769

**Status: not definitively re-run under v206 in this session.** Same reason as §8. Requires §23 path.

**Best evidence available today:**
- Fixture truth for 1087769 was not captured in accessible local artifacts; the case is referenced only by screenshot in `test-results/lifecycle-analysis-pending/Oakcreek_1087769-stable.png` and `test-results/phase5-slice1-confidence-ux/Oakcreek_1087769-{disclosed,closed}.png`.
- Behaviour on the pattern class (ordinary R&M vs capital-equipment) is exercised by the sealed cases `ordinary-repair-part.case.json` and `low-price-durable-equipment.case.json`. Their v206 sealed-run verdicts are available in the same benchmark report.
- Founder should provide the expected accounting truth for 1087769 as part of authorising §23.

## 10. Fresh sealed benchmark result on exact v206 baseline

Executed 2026-08-15 on `ap-intelligence-v206-reference` (HEAD = `cbb1b52`):

| Metric | Value |
|---|---|
| Corpus | `v3-2026-08-09-slice5.9` |
| Cases | 42 (dev 36 + validation 6) |
| Phase 0 containment | ENABLED |
| **GL Top-1** | **17/42 (40.5%)** |
| GL Top-3 | 9/42 |
| Forbidden GL (correctly excluded) | 35/42 |
| **Unsafe recommendations** | **0** |
| Correct abstention on unreadable | 4 |
| False abstention | 0 |
| Latency p50 / p95 (ms) | 89 / 129 |

**Comparison anchors:**
- Historical forensic (`docs/phase-4r-forensic-old-vs-new-comparison.md`): v206 = 17 Top-1; Phase 7.1 = 9 Top-1 (nearly halved). **Fresh run confirms 17.**
- Phase 7.2N Fix 1C sealed (`docs/phase-4r-phase72n-fix1c-checkpoint.md`): 18 Top-1. One case above v206 on the sealed corpus — but frozen collapses on real Coulee Ridge COA (§6, §7 evidence).

Report artifact: `tests/ap-benchmark/runs/ap-bench-2026-08-15T01-26-45-558Z-p0on-p2on.md`.

## 11. Exact v206 AP intelligence architecture map

**Entry point:** `analyseIngestedInvoice(args: ApAnalyseArgs) → ApAnalyseResult` at `src/lib/ap-intelligence/analyse.ts:420`.

**Discovery / ranking pass inventory (v206):**

| Mechanism | Location | Purpose |
|---|---|---|
| `recommendGlAccount` | `gl-recommend.ts:241` | BASE ranker. Filters eligible accounts, extracts query concepts, scores 11 components (direct-line-match, economic-purpose, name-similarity, fs-group-taxonomy, category-taxonomy, document-phrase, specificity, vendor-history, supplier-context, contradiction penalty, semantic), sorts deterministically, applies Phase-0 safety. Returns `GlRecommendation` with top-5 `candidates[]`. |
| `rankPurposeDrivenAccounts` | `purpose-driven-ranker.ts:164` | Full-COA additive ranker invoked when base winner is null/non-postable AND canonical purpose is COMMIT-eligible. 8 components. `COMMIT_MIN_SCORE=45`. |
| `rankNatureScopedAccounts` | `nature-scoped-ranker.ts:181` | Stage-B full-COA branch search. `NATURE_COMPATIBILITY` table gates by type + category/fsGroup + name substrings; excludes contra/depreciation/header/inactive/control. |
| `rankCapitalAwareAccounts` | `accounting-nature-compatibility.ts:251` | Slice 5.5 authority. Runs when `CapitalEvidenceDecision` commits at confidence ≥ 40. Compatibility gate per account (INCOMPATIBLE/CONTRADICTED → contradicted pool). Scores 9 dimensions. `ABSTAIN_GAP_MIN=10`. |
| Purpose ontology | `purpose-to-gl-ontology.ts`, `economic-purpose-taxonomy.ts`, `economic-purpose-authority.ts` | Purpose concept → account-name affinity. `resolveEconomicPurpose` produces canonical `EconomicPurposeDecision`. |
| Capital-vs-operating | `capital-vs-operating.ts`, `capital-evidence.ts` | Two coexisting authorities: legacy state (CAPITAL/OPERATING/AMBIGUOUS/INSUFFICIENT_EVIDENCE) + Slice 5.3 `CapitalEvidenceDecision` (CAPITAL_CANDIDATE/OPERATING/REPAIR_MAINTENANCE/UNRESOLVED with confidence). |
| Purchased-object | `purchased-object-identity.ts`, `product-identity-resolution.ts`, `external-product-reference/*` | Extracts brand/model/sku/serial; classifies objectRole (COMPLETE_MACHINE / SERIALIZED_COMPONENT / COMPONENT / ACCESSORY / CONSUMABLE / SERVICE / UNKNOWN); durable ProductReference cache. |
| Vendor history | `vendor-resolve.ts`, `vendor-profile-extract.ts`, `vendor-enrichment/index.ts`, `loadVendorHistory` in `gl-recommend.ts:681` | No dedicated `vendor-matcher` module on v206 — spread across three sites. |
| Family incompatibility | `account-semantics/family-incompatibility.ts:115` | Payroll-only after Phase 4R (broad IT↔R&M and IT↔Telecom exclusions removed). Applied in `gl-allocations.ts:358`. |
| SUMMARY_ROW_REJECTED | `evidence/canonical-line-item.ts:46` (marker) | Pre-ranker phantom-subtotal filter. |
| Allocation composition | `gl-allocations.ts:1658` (`computeAllocations`) | Per-purpose clustering → nature-compatible per-cluster ranking → alternatives + tax treatment. |
| Field-quality gate | `field-quality/index.ts:424` | Rejects header-row supplier candidates; forces GL abstention when `glEligible === false`. |
| Phase-2 eligibility | `@/lib/accounting/eligibility` (`filterEligibleAccounts`) | Structural + nature-conditioned COA filter. **Runs three times** (pre-ranker, purpose-driven-ranker input, post-promotion re-check). |
| Phase-0 safety | `eligibility/phase0-safety.ts:158` | Independent structural guard. **Runs twice** (end of `recommendGlAccount`, after all `analyse.ts` overrides). "Most restrictive wins" (analyse.ts:2494). |
| Semantic-match gate | `semantic-match-gate.ts` | Guards Stage-A/B nature promotions from confidence-laundering. |
| Confidence — 8-dimension | `analyse.ts:2892` (`computeConfidenceDimensions`) | Supplier/invoice/dates/lines/tax/total/vendor/gl. |
| Confidence — Gate 1 + Gate 2 | `mission-control/intelligence-review-intakes.ts:2210-2301` + `:1415-1465` | **Phase 4R FINAL** (v206 already includes this). Gate 1: winner hard-exclusion + identity dedupe. Gate 2: `MIN_RELATIVE_STRENGTH = 0.40` proportional substantive-score competitiveness. |
| Founder-facing tiers | `mission-control/founder-confidence.ts:111/161/267` | Three-dimension supplier/transaction/gl view; `weakestOf` composition. |

**Final winner chosen at:** `analyse.ts:1076` (initial from `recommendGlAccount`) then **mutated at up to 10 downstream sites** on the same `gl` local variable — 5 promotions, 4 abstentions, 1 Phase-0 wholesale replacement. This is the "authority leak" pattern the recovery architecture must contain (§20).

**Phase 4R FINAL confidence work is a pure function of ranker output.** Gate 1 and Gate 2 operate exclusively on `a.gl.candidates` — no re-entry into the ranker.

## 12. Valuable accounting mechanisms (A-tier)

Help discover / rank the right account:

- `recommendGlAccount` — base ranker + 11-component evidence extraction
- `rankPurposeDrivenAccounts` — purpose-driven full-COA scoring
- `rankNatureScopedAccounts` — nature-scoped full-COA scoring
- `rankCapitalAwareAccounts` — compatibility-gated capital pool + 9-dimension scoring
- Purpose ontology + `resolveEconomicPurpose`
- `evaluateCapitalObjectEvidence` + `evaluateCapitalEvidence`
- `DeterministicPurchasedObjectProvider` + `product-identity-resolution`
- Vendor-history reasoning (`resolveVendorForExtraction` + `extractVendorProfile` + `loadVendorHistory` + `conceptsFromEnrichment`)
- Family-incompatibility gate (Phase 4R-narrowed to payroll only) — pre-selection filter, not post-ranking mutation
- SUMMARY_ROW_REJECTED — pre-ranker filter
- `computeAllocations` — genuine multi-GL discovery
- `evaluateSemanticMatchGate` — gate only (blocks bad promotions; does not compose a winner)
- Phase-2 eligibility filter (pre-ranker) and pre-ranker re-check

## 13. Unsafe winner-mutation mechanisms (B-tier)

Ten `gl = { … }` mutation sites in `analyse.ts`, all executing after `recommendGlAccount` returned a winner:

| Site | Location | Behaviour |
|---|---|---|
| 1 | `analyse.ts:1446-1458` | `purpose_ontology_promotion` — REPLACES with an alternative from `gl.candidates` |
| 2 | `analyse.ts:1472-1486` | `purpose_ontology_abstain` — NULLS the winner |
| 3 | `analyse.ts:1590-1604` | `purpose_driven_full_coa_search` — OVERWRITES with purpose-driven ranker's pick |
| 4 | `analyse.ts:2006-2018` | Stage-A nature promotion — OVERWRITES from `gl.candidates` |
| 5 | `analyse.ts:2149-2161` | Stage-B nature-scoped full-COA — OVERWRITES |
| 6 | `analyse.ts:2342-2355` | Capital-aware winner — OVERRIDES prior leader |
| 7 | `analyse.ts:2360-2373` | Capital-aware abstention — NULLS |
| 8 | `analyse.ts:2419-2432` | Slice 5.3 object-authority contradiction guard — NULLS |
| 9 | `analyse.ts:2541` | Phase-0 safety re-application — REPLACES wholesale (`gl = guarded.recommendation`) |
| D-tier 10 | `analyse.ts:1824-1835` | Field-quality gate — legitimate quality signal, implemented as null-mutation |
| D-tier 11 | `analyse.ts:2221-2233` | Phase-2 post-promotion eligibility — legitimate integrity gate, implemented as null-mutation |

The `source` union on `GlRecommendation` collapses these under `"ECONOMIC_PURPOSE"` or `"SEMANTIC_MATCH"` regardless of which specific mutation wrote the field. The `reason` string prose is the only auditable trace of which authority actually won.

## 14. Confidence-only mechanisms (C-tier)

Affect confidence / runner-up presentation without improving the accounting decision:

- Gate 1 identity distinctness (`intelligence-review-intakes.ts:2249-2263` + `:1436-1448`)
- Gate 2 proportional 40% substantive competitiveness (`:2284-2301` + `:1449-1458`)
- `computeConfidenceDimensions` (analyse.ts:2892) — 8-dimension derivative
- `deriveSupplierConfidence` / `deriveTransactionConfidence` / `deriveGlConfidence` (founder-confidence.ts)
- `deriveApCardConfidence` — legacy 0-100 numeric summary
- Founder-facing category-chip fallback in `purchasedItemIntelligence` (analyse.ts:2726-2751) — only fires when GL is null

## 15. Phase 7 components worth retaining

Ten from the founder's list (verdict: RETAIN unless noted) plus five uncalled:

**Strong retentions:**
1. **Single-winner invariant** — sits on projection layer. Cheap to port.
2. **Canonical provenance** — projection layer reader; attaches to whichever ranker's output.
3. **DECISION vs DIAGNOSTIC evidence roles** — pure function over any additive scorer's family totals. RETAIN-WITH-ADAPTATION per §11 caveat (v206 evidence must be projected through a conservative classifier — see §20 risk 1).
4. **Genuine competitor qualification** — engine-agnostic reader of a ranked list.
5. **Canonical confidence semantics** (HIGH/MODERATE/LOW/REVIEW_REQUIRED) — composes A2/A3/A4 into a semantic tier.
6. **Explicit recommendation-policy separation** — 146-line file with zero account-selection logic. Pure policy.
7. **Anti-overfitting concepts** — RETAIN-WITH-ADAPTATION. Retain deterministic tie-break + discovery-frequency-is-not-evidence rules. **DO NOT retain MAX-within-family suppression** (which caused the accuracy regression).
8. **Benchmark harness + sealed corpus + versioned baselines** — non-negotiable retention.
9. **Real-COA structural posting restrictions (Fix 1 + Fix 1C)** — supersede by §18's single-boundary gate.
10. **Cluster isolation** — documented rule + unit test.

**Uncalled retentions:**
- Static architectural guard test (`fs.readFileSync` source-level assertions on invariants)
- Real-COA regression suite (6 controls: 1000/1001/9900/1506/1313/1101)
- Sealed benchmark methodology + `baselines/v*.json` versioned snapshots
- Discover-only legacy-bridge shims (candidate-discovery/legacy-bridge.ts)
- `AP_DISCOVERY_*` env-flag ablation knobs

## 16. Phase 7 components NOT recommended for retention

- **`rankCanonical()` scoring engine** — DISCARD. Sealed benchmark shows Phase 7.1 dropped GL Top-1 from 17→9 (+1 unsafe). Phase 7.2N recovered to 18 only via Option-B discovery widening — the ranker itself never closed the gap. Post-Fix-1C still leaves 221178 on 1313. Redundant vs v206.
- **Hierarchical tiering (PRIMARY/PLAUSIBLE/CONTRADICTED/INELIGIBLE)** — DISCARD except INELIGIBLE. Fix1C §11 admits: under OPEN_TREATMENT mode (the common case) tier priority does not govern; flat score decides anyway.
- **`CanonicalAccountingTreatment` wiring** — DISCARD. 352 lines. v206 already reasons about capital + nature independently through `rankCapitalAwareAccounts` + `rankNatureScopedAccounts`.
- **Discovery-union architecture** — RETAIN-WITH-ADAPTATION. Keep the *pooling* structure (Option-B validated); route the union to v206's ranker, not `rankCanonical`.
- **Current score weights** — DISCARD. LINE_ITEM_MATCH 25 vs v206 uncapped; DEPARTMENT_AFFINITY 12 vs v206 +35. Empirically weaker.
- **`COMMIT_MIN_SCORE=30`** — DISCARD as constant; RETAIN as concept. Use v206's per-authority floors (MIN_RELEVANCE=40, COMMIT_MIN=45, capital `commitFloor=40`).
- **Broad Phase 7 semantic plumbing** — DISCARD. `canonical-runtime-facade.ts` (723 lines), `NormalisedTransactionInterpretation`, `semantic-normalization.ts` — all orphaned once `rankCanonical` is out.
- **`CanonicalAccountSemantics` full extension** — RETAIN-WITH-ADAPTATION (narrow). Keep only `postingRole` + `structuralPostingRestrictions` + `statementRole`. Drop `accountingClass` / `inventoryPrepaidRole`.
- **`ACCOUNTING_CLASS_MATCH` observation (weight=15)** — DISCARD. Landed in the MAX-suppressed family that already loses corroboration relative to v206's uncapped path.
- **`TierSemanticsInput`** — RETAIN as data shape, rename to `CanonicalStructuralGateInput`.

## 17. v206 winner + new confidence diagnostic result

**Central finding: v206 IS Phase 4R FINAL — the "new confidence" (Gate 1 + Gate 2) is already present.**

`intelligence-review-intakes.ts:2210-2301` on v206 contains the identity-distinctness gate and the `MIN_RELATIVE_STRENGTH = 0.40` proportional-substantive-competitiveness gate. These operate on `a.gl.candidates` — a pure function of ranker output. The founder's original concern ("Spectre often choses the correct GL but confidence is MODERATE when it should be HIGH, and the alternative presented is economically implausible") is closed by this Phase 4R FINAL work, which is on v206 by definition.

The diagnostic §15 imagined ("v206 winner + modern confidence model") is not an experiment — it is v206's already-shipped behaviour.

**Category-by-category expected confidence on v206:**
- **Clear IT service** (221178): winner IT Services with 5 LINE_ITEM_MATCH support → alternates fail Gate 2's 40% threshold → **HIGH**.
- **Fuel** (DMM): sealed run confirms Winner=5310 conf 60, single substantive family → **HIGH**.
- **Capital equipment** (1091559-class): CapitalEvidenceDecision commits + capital-aware winner + no genuine cross-family competitor → **HIGH** or **MODERATE** depending on tenant COA specificity.
- **Professional membership**: sealed `professional-membership.case.json` v206 run available in benchmark report.
- **Ordinary R&M**: sealed `ordinary-repair-part.case.json` v206 run available.
- **Genuine ambiguity**: Gate 2 admits the alternate → **MODERATE** or **REVIEW_REQUIRED**.

Definitive per-case tiers for the four founder cases require §23 real-COA replay.

## 18. Structural-account safety proposal

Single boundary function: `evaluateStructuralAPEligibility(account) → { eligible, exclusionReasonCode?, provenance }`.

**Location:** `src/lib/accounting/eligibility/structural-ap-eligibility.ts` (elevated out of `ap-intelligence` — eligibility is an accounting property, not an AP-ranker property).

**Signature is transaction-context-free.** Nature-conditioned exclusions (`ruleNatureAssetExcluded`, `rulePayrollAccountExcluded`) MOVE OUT of the gate into a sibling `nature-compatibility.ts` where the ranker consumes them as scoring.

**Resolution order** (first hit wins, provenance tagged):

1. **Non-postable** — `!isActive || isHeader || !allowManualPosting || archivedAt`
2. **fs-group primary** — `fsGroupKey ∈ {BS_CASH_EQUIVALENTS → CASH/BANK, BS_AR → AR_RECEIVABLE, BS_AP → AP_CONTROL, BS_CIP → CIP_HOLDING, BS_EQUITY → EQUITY, IS_REVENUE_* → REVENUE, BS_ACCUM_DEPRECIATION → CONTRA_ASSET}`
3. **accountRole secondary** — `accountRole ∈ {BANK, CASH, CONTROL, CONTRA_ASSET, CLEARING}`
4. **Boolean-flag fallback** (safety net) — `isBankAccount / isCashAccount / isControlAccount`
5. **Type + normalBalance fallback** — `type === REVENUE / EQUITY / (ASSET & CREDIT → CONTRA_ASSET)`

**Nine closed reason codes:** BANK, CASH, AR_RECEIVABLE, AP_CONTROL, EQUITY, REVENUE, CONTRA_ASSET, CIP_HOLDING, NON_POSTABLE.

**Coulee Ridge failure classes this closes structurally:**
- Fix 1 (bank/cash accounts with `isBankAccount=false` but `fsGroupKey=BS_CASH_EQUIVALENTS`) → caught by rule 2.
- Fix 1D (AR asset accounts with `fsGroupKey=BS_AR` + `type=ASSET`) → caught by rule 2 **without a code patch**.

**Call site:** exactly once, in `gl-recommend.ts` immediately after COA fetch. `verdictsByAccountId` threaded to every ranker as a read-only lookup. Deletes `analyse.ts:1543`, `analyse.ts:2200`, `phase0-safety.ts` entirely, and the inline structural cut at `accounting-nature-compatibility.ts:420-425`.

**Static architectural guard** greps codebase and asserts fs-group keys used for eligibility appear only in `structural-ap-eligibility.ts`.

**Regression tests (13 total)** listed in the structural-safety agent's proposal (7 real-COA controls including the two new 1200/1201 AR cases, 2 inverse safety-fallback tests, 3 static architectural guards, 1 contract-shape test).

## 19. Current-app integration dependency map

Complete file-level map produced. Highlights:

### Files SAFE TO ADOPT WHOLE from frozen
7 files — all additive: `accounting-nature.ts` (+30), `economic-purpose-authority.ts` (+9), `economic-purpose-taxonomy.ts` (+115), `gl-account-concepts.ts` (+11), `gl-concepts.ts` (+46), `purpose-to-gl-ontology.ts` (+29), `tests/ap-benchmark/types.ts` (+13).

### NEW files from frozen (bring in unchanged)
- `candidate-discovery/index.ts` (248 lines) + `legacy-bridge.ts` (200 lines) + 8 provider files
- `recommendation-policy.ts` (146 lines) — zero local imports
- `semantic-normalization.ts` (165 lines) — depends only on economic-purpose-* (both v206)

**Edit before commit:** `candidate-discovery/providers/index.ts` — strip `treatmentAwareDiscovery` import + registry entry (its file is discarded).

### Files REQUIRING SURGICAL MERGE
1. **`analyse.ts`** — KEEP v206 body (3021 lines). Splice ONLY the additive `gl.canonicalWinnerAccountNumber` / `gl.recommendationStatus` / `gl.abstentionCategory` / `gl.abstentionReasons` / `gl.canonicalConfidence` fields, plus the `AllocationInput.globalSignals` construction block. **Do not** import `canonical-ranker`, `canonical-runtime-facade`, or `treatment-composition`.
2. **`gl-allocations.ts`** — KEEP v206 body (730 lines) as authoritative ranker. Splice ADDITIVELY: discovery union call (`discoverCandidates` + `unionEligiblePool`) to widen the pool, plus `AllocationInput.purposeDecision` / `discoveryContext` / `globalSignals` fields. Do NOT call `rankCanonical`.
3. **`gl-recommend.ts`** — 16-line splice: optional `recommendationStatus` / `abstentionCategory` / `abstentionReasons` / `canonicalWinnerAccountNumber` / `canonicalConfidence` fields on `GlRecommendation`. Pure addition; every downstream consumer already type-guards.
4. **`account-semantics/index.ts`** — narrow the frozen extension. Bring in `PostingRole` / `AccountStatementRole` / `StructuralPostingRestriction`. Add `postingRole` / `statementRole` / `structuralPostingRestrictions` to `AccountSemantics`. Drop `AccountingClass` / `InventoryPrepaidRole` (they exist to feed the discarded tier system).
5. **`canonical-confidence.ts`** — HIGH-RISK rewrite. Keep confidence-level derivation + genuine-competitor qualification + DECISION-vs-DIAGNOSTIC discrimination. **Replace input types** with a small `V206RankerAssessmentInput` projected from v206's `GlRecommendation` + candidate list. **Conservative fallback:** any v206 evidence without an explicit DECISION signal → DIAGNOSTIC; winners with only DIAGNOSTIC evidence → MODERATE + requiresReview.
6. **`tests/ap-benchmark/comparators/index.ts` + `run.ts`** — keep frozen body; snapshot builder projects from v206 ranker output.
7. **`tests/ap-intelligence-integration.test.ts`** — adopt frozen (cluster-owned relaxation is more correct).

### Files STAYING AT v206 UNCHANGED
- `gl-recommend.ts:241` (`recommendGlAccount`)
- `purpose-driven-ranker.ts:164`
- `nature-scoped-ranker.ts:181`
- `accounting-nature-compatibility.ts:251` (`rankCapitalAwareAccounts`)
- `purpose-to-gl-ontology.ts`, `economic-purpose-authority.ts`, `economic-purpose-taxonomy.ts`, `economic-purpose.ts`
- `capital-evidence.ts`
- `purchased-object-identity.ts`, `purchased-item-identity.ts`, `product-identity-resolution.ts`
- `vendor-profile-extract.ts`, `vendor-resolve.ts`, `vendor-enrichment/index.ts`
- `account-semantics/family-incompatibility.ts` (payroll-only after Phase 4R)
- `account-semantics/cip-evidence.ts`, `financing-evidence.ts`, `payroll-evidence.ts`, `compatibility-gate.ts`
- `mission-control/intelligence-review-intakes.ts` (0-line delta v206 vs frozen)

### Files to DELETE from frozen before landing on recovery
- `canonical-ranker.ts` (1737 lines)
- `canonical-runtime-facade.ts` (723 lines)
- `treatment-composition.ts` (352 lines)
- `candidate-discovery/providers/treatment-aware.ts` (242 lines)

### Prisma / migrations / env / API / worker
No changes required. Zero drift.

### Test suite adoptions / deletions
Detailed list in appendix of the §18-19 report — 9 test files brought over, 7 deleted (all coupled to discarded tier machinery), 5 existing v206 tests must continue to pass.

### Integration risk register (top 5)
1. **`canonical-confidence.ts` input-surface rewrite** may silently downgrade confidence if v206 rankers don't emit per-evidence DECISION/DIAGNOSTIC roles. Mitigation: conservative fallback (DIAGNOSTIC by default; MODERATE + requiresReview when winner has only DIAGNOSTIC evidence). Verification: existing `phase4r-confidence-integrity-gates.test.ts` must stay green.
2. **Discovery-union pool widening** may surface accounts v206 ranker cannot confidently rank → sealed regressions. Mitigation: `AP_DISCOVERY_UNION_ENABLED` env kill-switch. Verification: `Top-1 delta ≥ 0 AND unsafe delta ≤ 0` on sealed run.
3. **Orphaned imports** if any migrated test forgot to be removed from §7 delete list. Verification: `npm run typecheck` + grep `canonical-ranker|canonical-runtime-facade|treatment-composition` → zero hits.
4. **Additive `GlRecommendation` fields** could propagate into stricter downstream Zod schemas. Verification: enumerate `.parse()` / `.safeParse()` calls; verify optionality.
5. **Losing an override site** during surgical merge of `analyse.ts`. Mitigation: line-by-line delta of the 10 override sites; the single-winner test must be re-baselined to "winner ∈ candidates" (not `=== candidates[0]`) since v206's post-ranking overrides are legitimate on recovery.

## 20. Recommended bounded recovery architecture

Preserves v206's mature accounting brain. Adds the single-authority winner discipline the founder demands. Does NOT rebuild v206's discovery/ranking machinery.

### Layer diagram

```
[v206 discovery + rankers]  ← unchanged
        ↓
[§18 single structural gate]  ← new, replaces 4 duplicated sites
        ↓
[Sealed selection phase]  ← new, contains v206's ordered promotion sequence
        ↓  (winner frozen here; downstream mutation prohibited)
[Immutable ApAnalyseResult]
        ↓
[Phase 4R canonical projection]  ← retained (already on v206)
        ↓
[Founder-facing card]
```

### Concrete boundaries

**Layer A — Discovery (v206 unchanged).** All rankers, purpose ontology, capital-evidence, purchased-object, vendor-history, allocation composition preserved byte-identical.

**Layer B — Structural eligibility (§18 gate).** `evaluateStructuralAPEligibility` runs once, immediately after COA fetch. `verdictsByAccountId` threaded read-only. Replaces `filterEligibleAccounts` + `phase0-safety` + `analyse.ts:1543,2200` + `accounting-nature-compatibility.ts:420-425`.

**Layer C — Sealed selection.** New function `resolveSealedWinner(discoveryResults, structuralVerdicts) → SealedSelection`. Contains v206's ordered promotion sequence (base ranker → purpose-ontology promotion → purpose-driven full-COA → nature Stage-A → nature Stage-B → capital-aware → object-authority contradiction → field-quality → post-promotion eligibility → phase-0 re-check → return). But:
- Each promotion RETURNS a new value; no in-place mutation of a shared `gl` local.
- Return shape is `Readonly<SealedSelection>` — TypeScript prevents downstream mutation.
- Result carries first-class `WinnerProvenance = { source: RankerId, decisionRule: string, contradictedBy?: [], supersededBy?: [] }` — the popover reads this, not `gl.reason` prose.
- After `resolveSealedWinner` returns, no code path is allowed to change the winner. Contradictions discovered downstream become ABSTAIN, not silent replacement.

**Layer D — Projection (Phase 4R retained).** `CanonicalConfidenceAssessment` (via `canonical-confidence.ts` rewrite, §19 risk 1), genuine-competitor qualification, HIGH/MODERATE/LOW/REVIEW_REQUIRED, recommendation-policy — all consume Layer C's immutable output.

### Single-authority invariant (§14 answer)

`finalWinner === sealedResult.winner` at every downstream consumer. Achieved WITHOUT replacing the mature v206 engine:

- v206's mature engine RUNS INSIDE Layer C — its multi-authority reasoning is legitimate accounting intelligence, not "unsafe winner mutation" as long as the mutations happen inside a bounded selection function that produces a single immutable result.
- The "authority leak" is not the multiple rankers — it's the shared mutable `gl` local in `analyse.ts`. Layer C eliminates the shared local while preserving the ordered policy.
- Static architectural guard: no `gl = { ... }` mutation site outside `resolveSealedWinner`. Grep-based test in the harness.

### What v206 loses
- 9 in-place mutation sites in analyse.ts → collapsed into one policy-ordered function returning new values each step
- 3 Prisma re-queries for COA → single fetch cached per analyse call
- 4 duplicated structural-eligibility sites → single Layer B call

### What v206 keeps
- Every ranker's scoring logic byte-identical
- Purpose ontology / capital classifier / product identity / vendor history unchanged
- Allocation composition unchanged
- Phase 4R FINAL confidence work unchanged (Gate 1 + Gate 2 already on v206)

## 21. Proposed recovery branch point

**Branch from `main` (= v206 = `cbb1b52`)**, NOT from `refactor/gl-single-authority`.

Rationale:
- v206 is the current tip of main. Nothing on main needs to be reverted.
- Starting from v206 keeps unrelated application development intact (per §18 rule: "do not permanently revert unrelated application development to July").
- Files bring-over from `phase-7.2-frozen` happen via targeted `git show phase-7.2-frozen:PATH > PATH` + surgical splices, guided by §19 map. Never a whole-directory overwrite.

**Recommended branch name:** `ap-intelligence-recovery` (following the founder's §20 diagram).

**Do not create until §22 deliverable is accepted and §6/§8/§9 real-case validation completes.**

## 22. Estimated implementation scope

Bounded, small-slice-first. Roughly six numbered slices:

| Slice | Scope | Approximate size |
|---|---|---|
| S1 | §18 single structural gate (`evaluateStructuralAPEligibility` + 13 regression tests + delete 4 duplicated sites) | Small — 1 new file, 4 delete-and-collapse, ~350 test lines |
| S2 | Adopt whole-safe frozen additions (§19 Section 1: 7 files, additive-only) + bring in `recommendation-policy.ts` + `semantic-normalization.ts` | Small — 7 file diffs, 2 new files |
| S3 | Bring in `candidate-discovery/*` (12 files) + narrow `account-semantics/index.ts` extension | Medium — 12 new files, one surgical merge, `AP_DISCOVERY_UNION_ENABLED=0` kill-switch by default |
| S4 | Extract Layer C `resolveSealedWinner` from `analyse.ts` (refactor the 10 mutation sites into an ordered promotion function returning immutable steps). Add `WinnerProvenance`. Static architectural guard. | Medium — one file (analyse.ts), test additions |
| S5 | `canonical-confidence.ts` input-surface rewrite (§19 risk 1) + `gl-recommend.ts` 16-line additive splice + `gl-allocations.ts` additive union widening | Medium — three files, high test coverage required |
| S6 | Turn `AP_DISCOVERY_UNION_ENABLED=1` by default AFTER S3+S4+S5 sealed benchmark shows Top-1 delta ≥ 0 and unsafe delta ≤ 0 vs v206 baseline. Deploy to staging. Real-case founder acceptance. | Small — env flip, benchmark verification, staging deploy |

Total: ~30-40 files touched over 6 slices. No slice larger than a normal Phase 4R checkpoint.

## 23. Staging strategy

**Do not immediately deploy exact v206 to staging.**

Even though §5 proves it is safe, deploying v206 alone (without §18 structural gate) would fix DMM but NOT close the AR structural leak that Fix 1C exposed post-Coulee-Ridge audit. The founder's acceptance signal should come from the recovery architecture, not from bare v206.

**Recommended sequence:**

1. **Now:** Founder decides which of these paths answers §6, §8, §9 (real-case results for 221178 / 1091559 / 1087769):
   - **Path A (recommended):** Local Coulee-Ridge-seeded replay harness. ~2-4 hours of build. Fetches Coulee Ridge COA + real OCR text via authenticated Playwright against v212 staging, seeds disposable SQLite, runs v206's `analyseIngestedInvoice`. Zero staging state change. Definitive per-case answers.
   - **Path B:** Deploy exact v206 to staging web (rollback v212, deploy `ap-intelligence-v206-reference`). Overwrites founder's current test state. Definitive founder-facing card outcomes via authenticated Playwright.
   - **Path C:** Accept sealed-corpus proxies + architectural inference from §11 map. No new capture; documented `strong inference` per §6/§8/§9 above.

2. **After §6/§8/§9 is complete:** Founder authorises the recovery integration branch (`ap-intelligence-recovery`, §21).

3. **After Slice 1 (§18 structural gate) + Slice 2 (safe adopts) land:** Deploy that branch to `spectre-staging`. Rollback anchor v212. Verify `/api/health` = 200. Re-run authenticated Playwright acceptance for the four real cases.

4. **After Slice 6 (union widening default-on):** Second staging deploy. Founder acceptance.

5. **Production:** Never deployed without per-change founder authorisation (per standing rule).

**Keep staging where it is (v212) until Slice 1+2 recovery branch is ready.**

## 24. Explicit go / no-go recommendation

### **GO — proceed with recovery via Option B (v206 + selective Phase 7.2 retention), branching from current `main`.**

Basis:
- v206 is empirically the stronger accounting engine (17/42 sealed Top-1 vs Phase 7.1's 9/42; DMM correctly resolved to Fuel; Category B and D per-case regressions documented in the forensic doc).
- v206 already includes Phase 4R FINAL confidence work — the founder's original complaint ("MODERATE when it should be HIGH; runner-ups economically implausible") is closed by code already on v206.
- Phase 7.2's genuine wins are portable (single-winner invariant, canonical provenance, DECISION vs DIAGNOSTIC evidence, genuine-competitor qualification, canonical confidence semantics, recommendation-policy separation, real-COA structural restrictions, cluster isolation, benchmark harness).
- The structural safety proposal (§18) closes both Fix 1 (BS_CASH_EQUIVALENTS) and Fix 1D (BS_AR) *by design*, not by patch.
- Recovery is wire-compatible with current staging (§5). No schema/env/API/worker/auth risk.
- Bounded scope (6 slices, ~30-40 files). No new product modules. No big-bang rewrite.
- No history rewrite; no destructive git operation; no production deploy; frozen refactor preserved as annotated tag.

### **Conditional on:**

1. **Founder chooses a §23 path for §6/§8/§9 real-case validation.** Recommendation: Path A (local Coulee-Ridge replay). Without this, §6/§8/§9 remain "strong inference" not "verified".
2. **Recovery slices ship in the order §22 defines** — do not skip Layer C sealed-selection extraction (Slice 4) in favour of ranker changes.
3. **Every slice re-runs the sealed benchmark** and requires `Top-1 delta ≥ 0 AND unsafe delta ≤ 0` vs the v206 baseline of `17/42, 0 unsafe`.
4. **Real-COA regression tests (§18 + Fix 1C's 6 controls + new AR controls)** run on every slice.
5. **No production deploy without per-change founder authorisation.**

### **Explicit non-goals:**

- Do not implement Fix 1D as a patch to the frozen branch. §18 closes it structurally.
- Do not merge `refactor/gl-single-authority` to main.
- Do not delete anything under the frozen tag.
- Do not rebuild v206 into Phase 7 canonical scoring.
- Do not introduce a hierarchical tier system.
- Do not add MAX-within-family scoring suppression.

---

## Appendix — Artifacts produced this session

| Item | Path |
|---|---|
| Freeze tag | `phase-7.2-frozen` → `635af3b` |
| v206 reference branch | `ap-intelligence-v206-reference` from `cbb1b52` |
| Planning branch (this doc) | `phase-4r-recovery-planning` from `cbb1b52` |
| Fresh v206 sealed benchmark | `tests/ap-benchmark/runs/ap-bench-2026-08-15T01-26-45-558Z-p0on-p2on.md` |
| This deliverable | `docs/phase-4r-recovery-planning-deliverable.md` |

## Appendix — Prior evidence relied on

| Reference | Value |
|---|---|
| Forensic old-vs-new comparison | `docs/phase-4r-forensic-old-vs-new-comparison.md` (v206 vs Phase 7.1 sealed 17→9 Top-1 regression) |
| Fix 1C checkpoint | `docs/phase-4r-phase72n-fix1c-checkpoint.md` (post-Fix-1C sealed 18/42; BS_AR leak) |
| Fix 1C semantic-consumption test | `tests/phase4r-phase72n-fix1c-semantic-consumption.test.ts` (real-COA regression pattern) |
| 221178 real extraction | `test-results/ranker-authority-acceptance/221178-ap-evidence.json` |

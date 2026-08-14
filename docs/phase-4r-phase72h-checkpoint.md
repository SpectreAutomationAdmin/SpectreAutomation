# Phase 4R · Phase 7.2H — Diagnostic architecture checkpoint (§20 24-item deliverable)

**Author:** Claude (Opus 4.7) on `refactor/gl-single-authority`
**Date:** 2026-08-13
**Status:** Diagnostic-architecture phase per founder directive. ONE runtime change (§1 benchmark comparator upgrade). NO other runtime code touched. NO new concepts, NO weights, NO thresholds, NO discovery changes, NO policy changes.
**Founder question this answers:** "which piece of accounting reasoning is missing?"

---

## §20 24-item deliverable

### 1. Corrected benchmark methodology (§1)

`cmpGlTop1` at [tests/ap-benchmark/comparators/index.ts:160-215](../tests/ap-benchmark/comparators/index.ts#L160) now detects MULTIPLE_RESOLVED (`recommendationStatus==="RECOMMEND"` + `glCandidateNumbers.length>1`) and grades via per-allocation candidates:
- All per-allocation winners in acceptable set → PASS
- Some in acceptable set → PARTIAL
- None → FAIL

Impact: **1 case shifted** (`complete-equipment-serialized`: FAIL → PARTIAL). The other 3 multi-alloc failures (`multi-alloc-membership-plus-penalty`, `multi-alloc-goods-freight-tax`, `multi-alloc-goods-plus-service`) do NOT reclassify — their per-cluster canonical returned ABSTAIN_AMBIGUITY / ABSTAIN_NO_CANDIDATES, so `recommendationStatus !== RECOMMEND` and the MULTIPLE_RESOLVED branch doesn't apply. **This is itself a diagnostic finding**: the Phase 7.2G Option C hypothesis was wrong — multi-alloc failures are canonical-scoring gaps, not projection gaps.

### 2. Corrected single-account metrics

Post-fix 42-case corpus with extended snapshot:

| Metric | Count |
|--------|:---:|
| Committed correct (single-account) | 8 |
| Warranted abstain PASS | 5 |
| MULTIPLE_RESOLVED PASS | 0 |
| MULTIPLE_RESOLVED PARTIAL | 1 |
| MULTIPLE_RESOLVED FAIL | 0 |
| Single wrong-winner | 8 |
| Single no-winner (ABSTAIN_NO_CANDIDATES / ABSTAIN_AMBIGUITY with candidates[0]=null) | 11 |
| Non-top-1-dim cases | 7 |
| **Unsafe** | **0** ✅ |

### 3. Corrected multi-allocation metrics

Only 1 case reached MULTIPLE_RESOLVED post-comparator-fix. The 3 fixture-labeled multi-alloc cases produced NO per-allocation canonical winners at all — canonical failed at the per-cluster ranking level.

### 4. HUMAN_CLASSIFIABLE denominator

Of 42 cases:
- **7** are non-top-1-dim (fixture doesn't test GL classification: supplier disambiguation, currency hierarchy, tax dedup, credit memo, PO reference, statement+account-number reference).
- **5** are warranted abstain (fixture-designed: vague-body, html-newsletter, unreadable, statement-of-account, pathological-vendor-default-contra).
- **3** are adversarial correct-rejection (already inside the top-1-testing set — statement gets counted here).

**HUMAN_CLASSIFIABLE = 42 − 7 − 5 = 30 cases** (approximately — some overlap with adversarial counted inside the 30). A competent human accountant with the invoice text would reasonably classify these into an acceptable GL.

### 5. Canonical accuracy against HUMAN_CLASSIFIABLE

Raw canonical Top-1 correct: **10 / 30 ≈ 33%**.

### 6. Committed accuracy against HUMAN_CLASSIFIABLE

Committed Top-1 (canonical picked + policy allowed): **8 / 30 ≈ 27%**.

### 7. Exact R1-R9 first-failure distribution

For the 26 failing non-adversarial cases (§§2-4 audit, single primary boundary per case):

| First failure | Count | Meaning |
|--------------|:---:|---------|
| R1 Transaction understanding | 0 | — |
| **R2 Accounting-treatment failure** (asset vs expense vs inventory vs prepaid vs contra) | **7** | inventory picked instead of expense/COGS; expense picked instead of asset; asset picked instead of expense — wrong statement treatment |
| R3 Accounting-class failure (same treatment, wrong class family) | 3 | Prof Services picked instead of Grounds Maintenance; F&B Inventory picked instead of CIP — same type, wrong class family |
| **R4 COA retrieval / discovery failure** | **7** | Correct account (1610 software intangible, 1410 prepaid, 1550 building, 1570 financed, capital pool, etc.) never reaches candidate competition |
| R5 Canonical competition failure | 1 | Correct account in Top-3 but competition never designated a winner (`complete-equipment-serialized`) |
| R6 Evidence propagation failure | 1 | `jonas-convention-accum-depr`: correct winner 5320 but score 5 — dead-bridge suspected |
| R7 Recommendation-policy failure | 3 | Correct Top-3 candidate present but policy abstains |
| R8 Extraction / clustering failure | 0 | — |
| R9 Benchmark / harness failure | 4 | `workflowState` label mismatch (NEEDS_JUDGMENT vs REVIEW_REQUIRED) — runtime reasoning correct |
| **TOTAL** | **26** | |

**Dominant boundaries:** R2 (7) + R4 (7) = **54% of failures are accounting-treatment or discovery issues**. R7 (policy) is only 3 — close to the founder's estimate of ~2.

### 8. Case-by-case failure table

Full table in the R1-R9 subagent report. Preserved in commit for engineering audit. Every case has a single primary R# classification with reasoning.

### 9. 221178 reasoning trace (§7)

Expected human chain: "Online Backup License Fee" → service/technology → operating expense → IT/software family → 6054 Computer & IT Services.

| Step | Represented by | Fires? | Reaches canonical as… |
|------|----------------|:---:|-----------------------|
| 1 Service/technology purpose | `economic-purpose-taxonomy.ts:145` SOFTWARE_SUBSCRIPTION cue `/online\s*backup/` | YES (conf 96) | `purposeConcept = "SOFTWARE_SUBSCRIPTION"` |
| 2 Operating expense treatment | `canonical-ranker.ts:806-811` `PURPOSE_TYPE_COMPAT` | YES | +12 in TRANSACTION_TEXT — DECISION |
| 3 IT/software family (via category hint) | `canonical-ranker.ts:820-828` `PURPOSE_CATEGORY_HINT` | Fires but **MAX-suppressed** by step 2 (same origin `"purpose_authority"`) | DIAGNOSTIC only |
| 4 Bind to 6054 by name | `purpose-to-gl-ontology.ts:82` `SOFTWARE_SUBSCRIPTION = ["software","subscription","saas"]` | **NO** — "Computer & IT Services" contains none | `ONTOLOGY_NAME_MATCH` (+20) never emitted |

**Independent path also missing:** `extractConceptsForAccount(6054)` returns `it_services`. Query concept for line = `software_subscription_service`. `conceptRelatedness("software_subscription_service", "it_services") = 0` because they live in different ontology trees (SOFTWARE.parent = `memberships_and_subscriptions`, IT_SERVICES.parent = null). Consequence: `LINE_ITEM_MATCH`, `ECONOMIC_PURPOSE`, `ACCOUNT_NAME_SIMILARITY`, `FS_GROUP_TAXONOMY` all yield **0 contribution** for account 6054. Even the **shared `IS_IT_SOFTWARE` fs-group hint on BOTH concepts** ([gl-concepts.ts:96, 335](../src/lib/ap-intelligence/gl-concepts.ts#L96)) is multiplied by relatedness=0 in `canonical-ranker.ts:872-880` and vanishes.

**Missing accounting-reasoning primitive:** cross-tree relatedness / fs-group affinity for concepts that share a financial-statement group. Human accountants recognize "SaaS subscription" and "IT Services" as the same broad accounting home; the current ontology tree does not.

**Is this ambiguity?** No. Canonical treats it as ambiguity only because (a) the invoice fragments into 3 clusters each carrying one line's evidence, and (b) inside each fragment the identity chain SOFTWARE_SUBSCRIPTION purpose ↔ IT_SERVICES account concept is not expressed by any relatedness or ontology edge.

### 10. 1091559 reasoning trace (§8)

Expected human chain: purchased equipment → durable tangible → acquisition (not repair) → capital treatment → equipment fixed-asset → 1506 / 1540.

| Step | Represented by | Fires? | Consequence |
|------|----------------|:---:|-------------|
| 1 Durable tangible identity | `purchased-object-identity.ts:116` `COMPLETE_MACHINE_NOUNS` | **NO** — bare "equipment"/"fixtures" not in list (only mower/tractor/HVAC unit/…) | `objectRole = UNKNOWN` |
| 2 Acquisition vs repair | `capital-vs-operating.ts:53` `CAPITAL_HINTS` (needs "new equipment"/"acquisition"/"install"/"purchase of") | **Neither fires** | `capital.state = AMBIGUOUS` |
| 3 Capital treatment | `capital-evidence.ts:591` requires topScore ≥ COMMIT_MIN_CONFIDENCE=40 | Score = 0 → **UNRESOLVED** | `sharedCapitalDecision.decision = UNRESOLVED` |
| 4 Equipment fixed-asset class | `accounting-nature.ts:112` CAPITAL_ASSET.strongTerms includes `/\bequipment\b/` | **YES** — barely defensible (raw=3, score=20, isDefensible threshold=20) | `natureLeader = "CAPITAL_ASSET"` |
| 5 Post to 1506/1540 | `candidate-discovery/providers/capital-aware-direct.ts` requires decision != UNRESOLVED + conf ≥ 40; `nature-scoped-direct.ts` finds them via name substrings | capital-aware: **skipped** (UNRESOLVED). nature-scoped: **DOES surface 1506/1540** as candidates | Discovery emits — see next step |

**The choke point:** `analyse.ts:1071` sets `expectedDebitRole = capital.state==="CAPITAL" ? "CAPITAL_ASSET" : ... : "UNKNOWN"`. Since state = AMBIGUOUS → **"UNKNOWN"**. `filterEligibleAccounts` with `expectedDebitRole="UNKNOWN"` excludes ALL ASSET accounts via `rules-structural.ts:143` `ruleNatureAssetExcluded` returning `TRANSACTION_NATURE_INCOMPATIBLE`. 1506/1540 are removed from `eligibleAccountsForAllocation`.

`unionEligiblePool` at [candidate-discovery/index.ts:219-237](../src/lib/ap-intelligence/candidate-discovery/index.ts#L219) re-admits a discovered candidate only if it exists in `fullTenantCoa` (= `nonPayrollAccounts`, derived from `args.accounts` = the already-Phase-2-filtered pool). **1506/1540 aren't in `args.accounts`, so the nature-scoped discovery hits are silently dropped.**

Every EXPENSE candidate then receives `NATURE_INCOMPATIBLE_PENALTY = -18` at canonical-ranker.ts:924-935 because `natureLeader = "CAPITAL_ASSET"` and `ACCEPTABLE_TYPES_BY_NATURE.CAPITAL_ASSET = {"ASSET"}`. Every candidate scores 0 → `NO_ELIGIBLE_CANDIDATES`.

**Founder §14 category: C — missing candidate/evidence.**

**Missing accounting-reasoning primitive:** compositional capital decision. Three authorities each independently see a durable-asset signal (nature=CAPITAL_ASSET conf 20; over-threshold amount; asset-named line) but there is no coherence rule that composes them. Phase-2 eligibility hard-couples ASSET admission to `capital-vs-operating.state === "CAPITAL"`, not to `accounting-nature = CAPITAL_ASSET (defensible)`. Discovery *finds* the right accounts, but the founder-approved `unionEligiblePool` pattern cannot re-add accounts that a stricter upstream gate already deleted from the pool.

### 11. DMM reasoning trace

`dmm-energy-fuel`: line "Diesel biodégradable dyed low-sulphur…" matches FUEL cue (economic-purpose-taxonomy.ts:95) at strength 82 → committed FUEL conf 96. Canonical scores every eligible account. TRANSACTION_TEXT MAX: `LINE_ITEM_MATCH` + `ONTOLOGY_NAME_MATCH` (fuel substring, purpose-to-gl-ontology.ts:31) yield ~20-25 for accounts with "Fuel" in name. Winner: **5320 "Fuel & Lubricants — General"** at score 33, RECOMMEND ✓. Preserved.

### 12. completed-capital-improvement reasoning trace

Winner 1530 "Course Improvements" at score 39, RECOMMEND ✓. Phase 7.2F CAPITAL_IMPROVEMENT concept fires on "bunker rebuild — placed in service — final invoice" and binds via `PURPOSE_ACCOUNT_NAME_SUBSTRINGS.CAPITAL_IMPROVEMENT = ["course improvement", ...]` matching "Course Improvements". Preserved.

### 13. Evidence ledger for all correct winners below 30 (§9)

Two cases:

**`jonas-convention-accum-depr`** — winner 5320 (correct), score **5**:

| Accounting fact | Human significance | Spectre representation | Canonical contribution |
|---|---|---|---:|
| Line = "Dyed diesel fuel" | Unambiguous fuel purchase | FUEL cue matches, purpose committed conf 96 | Should be +12 PURPOSE_TYPE_COMPAT + +20 ONTOLOGY_NAME_MATCH ≈ 20+ pt in TRANSACTION_TEXT |
| 5320 = "Fuel & Lubricants — General" | Direct account name match | ONTOLOGY_NAME_MATCH "fuel" | Should be +20 (but score = 5 suggests it didn't fire) |
| Vendor "Grande Prairie Petroleum" | Fuel vendor | SUPPLIER_CONTEXT | +10 max if matched |
| PO reference "Equipment: fleet truck 44821" | Fleet-fuel context | Not currently captured as evidence | 0 |

**Score 5 is anomalous for a well-labelled fuel invoice** on the same COA where `dmm-energy-fuel` scored 33. Signals fuel evidence being scored under a wrong vocabulary or stripped somewhere. **Classified R6 (evidence propagation) — dead-bridge symptom analogous to Phase 7.2C.** Requires deeper instrumentation to pinpoint (out of §18 scope for this diagnostic phase).

**`adversarial-capital-warranty-boilerplate`** — winner 1506 (correct), score **28**:

| Accounting fact | Human significance | Spectre representation | Contribution |
|---|---|---|---:|
| Winner 1506 "Equipment & Fixtures" | Direct name match to CAPITAL_EQUIPMENT purpose | Purpose commits CAPITAL_EQUIPMENT (assumed); ONTOLOGY_NAME_MATCH matches "equipment" | ≈ +20 |
| Deterministic tie with runner-up (score = 28 for both) | Genuine competition | canonical.separation.isDeterministicTieBreak = true | Score preserved but tied |

**Score 28 just below floor** — small distance from commit threshold. Runner-up at same score = deterministic tie = genuine accounting ambiguity between two capital-asset accounts (which is legitimate — 1506 vs 1540 are both plausible for equipment).

### 14. Structural explanation for low scores

Two systemic issues, one severe:

- **221178 pattern (severe):** `conceptRelatedness` reasons purely from ontology tree ancestry. Cross-tree accounting affinity (fs-group co-membership, taxonomic sibling implication) is never consulted. Two concepts that share `IS_IT_SOFTWARE` but live in different ontology trees produce 0 contribution to each other's scoring — the ONE most-affirmative account-side evidence path silently zeroes out.

- **jonas pattern (localized):** score = 5 vs DMM's 33 on the "same" fuel-invoice shape suggests fuel evidence is being propagated under the wrong vocabulary for this specific COA / cluster shape. Dead-bridge R6 symptom. Requires per-cluster canonical-ranker instrumentation to trace observation emission.

- **1091559 pattern (severe):** Phase-2 eligibility hard-filters ASSET accounts unless `capital-vs-operating.state === "CAPITAL"`. When the classifier commits AMBIGUOUS despite the accounting-nature classifier reaching CAPITAL_ASSET defensibly, the correct accounts are structurally excluded before discovery can help. Every EXPENSE candidate then gets NATURE_INCOMPATIBLE_PENALTY = -18 (because nature = CAPITAL_ASSET) → all zeros → NO_ELIGIBLE_CANDIDATES.

**None of these are threshold problems. All three are architectural composition problems.**

### 15. `COMMIT_MIN_SCORE = 30` analysis (§10)

Score-bucket distribution across 42 cases:

| Bucket | Cases | Correct winner | Recommended |
|--------|:---:|:---:|:---:|
| <20 | 3 | 1 | 0 |
| 20-29 | 4 | 1 | 0 |
| 30-39 | 4 | 3 | 4 |
| 40-49 | 6 | 2 | 6 |
| 50-59 | 2 | 1 | 2 |
| 60+ | 4 | 2 | 4 |

**Empirical answer to "What was 30 originally intended to represent?"** Reading `canonical-ranker.ts:440-448`:
> "A strong single-concept invoice with vendor default + department match reaches ~85, and a weak-evidence winner sits in the 30-50 range."

The design intent was: strong invoices ~85, weak-but-committable ~30-50, uncommittable <30. Actual observed distribution: strong invoices reach 33-66 (not 85), weak-committable cluster at 39-45, correct-winners fall below 30 for 2 legitimate cases.

**The evidence scale is compressed relative to design intent.** Strong-invoice DMM reaches only 33 — 52 points below design expectation. This is not a threshold problem — it is a scoring problem: the scoring architecture systematically undershoots its design range because MAX-within-family + missing cross-tree relatedness leave 40-60 points of theoretically-available score unclaimed.

**Answer to §10:** `COMMIT_MIN_SCORE = 30` is calibrated for a scoring model that would produce 30-85 winner scores; the current model produces 0-66 with median ~35. The threshold is not miscalibrated — the SCALE the threshold operates on is compressed.

### 16. Evidence-family audit (§11)

Full analysis in the concept-inventory subagent report. Summary:

| Family | Independent proposition | Lexical vs Structured |
|--------|------------------------|:---:|
| TRANSACTION_TEXT | "invoice text is about X" | Mixed but predominantly LEXICAL |
| TAXONOMY_ALIGNMENT | "account taxonomy matches dominant query concept" | LEXICAL |
| CAPITAL_NATURE | "nature/capital/role fit" | STRUCTURED but MAX-collapsed against itself |
| VENDOR_HISTORY | "vendor prior coding" | Mixed |
| DEPARTMENT_CONTEXT | "account name matches department" | LEXICAL |

**Missing propositions:** "Transaction is a recurring IT service AND account taxonomy says Computer & IT Services" — no dedicated family. Two derivable signals collide in TRANSACTION_TEXT (via ontology-substring path) and TAXONOMY_ALIGNMENT (via conceptRelatedness), MAX-collapsed against unrelated lexical hits. The composition never becomes a single strong signal.

### 17. Semantic-vs-accounting evidence audit (§12)

Structured accounting propositions (nature commit, capital classifier verdict, account.type, categoryKey) enter canonical scoring as SOFT contributions capped at 10-25 points. Lexical/semantic signals (line-item token matches, ontology name-substring hits, Jaccard) can produce the same or higher contribution.

For 221178: 6054 receives 0 structured accounting evidence because `conceptRelatedness=0`. Only PURPOSE_TYPE_COMPAT (+12) survives — a whole-invoice generic signal, not a targeted 6054-specific accounting fact.

For 1091559: nature classifier's CAPITAL_ASSET conf 20 gets NO downstream benefit because it doesn't flow into the eligibility gate. The one accounting fact strong enough to open ASSET admission is `capital-vs-operating.state`, which requires vocabulary the invoice doesn't carry.

**Canonical scoring currently gives semantic and accounting evidence approximately equal footing.** Structured accounting evidence does NOT have primacy — MAX-within-family means a strong lexical LINE_ITEM_MATCH can silence a structured PURPOSE_TYPE_COMPAT.

### 18. Phase 7.2F abstraction-level audit (§13)

The 8 concepts do NOT occupy one abstraction level:

| Concept | Abstraction level |
|---------|-------------------|
| CAPITAL_IMPROVEMENT | Financial-statement treatment + accounting class (two levels) |
| LAND_ACQUISITION | Purchase-nature × asset-class combo |
| BUILDING_ACQUISITION | Purchase-nature × asset-class combo |
| CONSTRUCTION_IN_PROGRESS | Financial-statement treatment (completion-state classification) |
| SOFTWARE_INTANGIBLE | Financial-statement treatment + accounting class (two levels) |
| PREPAID_EXPENSE | Financial-statement treatment |
| INVENTORY_ACQUISITION | Financial-statement treatment |
| FINANCED_EQUIPMENT_ACQUISITION | Purchase-nature + financing-method combo |

Sitting alongside the pre-Phase-7.2F 22 concepts — mostly accounting class / commodity (FUEL, LUBRICANTS, EQUIPMENT_PARTS, FOOD, etc.) with two treatment/behaviour outliers (INTEREST, PENALTY). **The taxonomy mixes at least four abstraction levels into one flat enum.**

### 19. Discovery-provider unique-recall analysis (§14)

Not systematically computed (would require per-provider ablation loop). Preliminary observation from concept inventory: 6+ discovery providers each mirror a distinct v206 authority. Consolidation is deferred; §14 recommends inspection but not action.

### 20. Current vs proposed hierarchy map

Founder §15 hierarchy vs current runtime:

| Layer (§15) | Current runtime representation | Coherence |
|-------------|--------------------------------|-----------|
| L1 Document validity | analyse.ts extract + field-quality gates | OK |
| L2 Transaction identity | economic-purpose (3 vocabs), purchased-object, product-identity | Fragmented across 3+ modules |
| L3 Accounting treatment | capital-vs-operating (4-state) + accounting-nature (11-state, overlapping) + capital-evidence | 3 authorities on same question, not composed |
| L4 Accounting class | Mixed into L2 + L3 vocabularies (no dedicated layer) | Absent as distinct layer |
| L5 Context | Department + vendor history + capital state + tax | Present but scored as flat evidence |
| L6 COA retrieval | Phase-2 eligibility gate + 6 discovery providers | HARD-COUPLED to capital-vs-operating.state; discovery cannot override the gate |
| L7 Canonical competition | rankCanonical + collapseByFamily | Present; treats structured + lexical evidence symmetrically |
| L8 Recommendation policy | recommendation-policy.ts | Present; pure propagation of canonical status |
| L9 Confidence | canonical-confidence.ts (HIGH/MODERATE/LOW/REVIEW_REQUIRED + genuine competitors) | Present |

**Verdict:** L1, L5, L7, L8, L9 exist. L2 is fragmented across 3 vocabularies. L3 has 3 competing authorities with no composition. L4 is absent. L6 is hard-coupled to L3 in a way that lets a partial L3 signal silently exclude the correct accounts.

Runtime does NOT execute `transaction → treatment → class → COA` as a hierarchy. It executes `many signals → weighted scoring → highest score`.

### 21. Which current components should be retained

Preserve unchanged per §16:
- Single canonical winner authority (`rankCanonical`)
- Cluster ownership + Phase 7 architecture
- Discovery/winner separation (Phase 7.2B)
- Canonical provenance
- DECISION/DIAGNOSTIC evidence classification
- Genuine competitor model (working correctly per Phase 7.2G)
- Recommendation policy separation
- Confidence semantics (MODERATE:RECOMMEND fires — no coupling issue)
- Static single-authority guards + anti-overfitting guards
- Zero-unsafe safety floor
- L1/L5/L7/L8/L9 layers as-designed

### 22. Which components are duplicated / misaligned

- **3 parallel purpose vocabularies** (canonical enum 30, legacy 12, ACCOUNTING_CONCEPTS 43) with partial bridges between them.
- **`AccountingNature` vs `CapitalDecision`** — same distinctions, different spellings, both consumed with duplicate rows in `ACCEPTABLE_TYPES_BY_NATURE`.
- **`ObjectRole` vs `ProductObjectType`** — two enums for "what kind of thing".
- **`PURPOSE_ROLE_HINTS`** is a documented "local mirror" of purpose-driven-ranker's — a deliberate fork that will drift.
- **8 Phase 7.2F concepts** lack entries in `PURPOSE_ROLE_HINTS` (so ACCOUNT_ROLE_MATCH never fires for them) and in `CLUSTER_CONCEPT_TO_CANONICAL_PURPOSE` (so cluster-fallback discovery can't reach them).
- **`conceptRelatedness` reasons only from tree ancestry** — never consults `fsGroupKeyHints` co-membership, which is the accounting-affinity signal that would rescue 221178.
- **Phase-2 eligibility hard-couples ASSET admission to `capital.state === "CAPITAL"`**, ignoring the accounting-nature classifier's CAPITAL_ASSET verdict. Systemic issue behind 1091559.
- **8 Phase 7.2F concepts mix at least 4 abstraction levels** into one flat enum.

### 23. Whether the next phase should repair existing architecture or introduce hierarchical layer

**Repair — DO NOT rewrite.** The forensic evidence points to specific, bounded architectural gaps rather than a fundamental design failure. Retained architecture (§21) is sound. Missing pieces are:

1. **`conceptRelatedness` cross-tree affinity via `fsGroupKeyHints`** — rescues 221178-shape cases. Single-function change in `gl-concepts.ts`. No new concepts, no weight change. **Would let 6054 receive its legitimate ACCOUNT_NAME_SIMILARITY / FS_GROUP_TAXONOMY / CATEGORY_TAXONOMY signals.**

2. **Compositional capital decision** — when `accounting-nature.leader === "CAPITAL_ASSET"` with `isDefensible=true`, that alone should be sufficient to open ASSET admission at Phase-2 eligibility. Currently only `capital-vs-operating.state === "CAPITAL"` opens it. Single-rule change at the eligibility gate. **Rescues 1091559-shape cases + likely 3-4 other capital cases in the R4 bucket.**

3. **Vocabulary consolidation** — merge the 3 parallel purpose vocabularies (canonical 30, legacy 12, ACCOUNTING_CONCEPTS 43) into a single canonical enum with explicit bridges maintained in one place. Longer-scoped refactor.

Neither #1 nor #2 requires a new abstraction layer. Both fit within the existing L1-L9 hierarchy.

### 24. Bounded Phase 7.2I recommendation

**DO NOT stage. DO NOT merge. DO NOT deploy production.**

Suggested Phase 7.2I is **a two-slice interpretation-layer repair, both bounded**:

- **7.2I-a: fs-group affinity in `conceptRelatedness`.** When two concepts share a non-empty `fsGroupKeyHints` intersection, elevate `conceptRelatedness` from 0 to a bounded value (e.g. 40-60, well below tree-ancestor 100 but above stranger 0). Single-function change in [gl-concepts.ts:682-698](../src/lib/ap-intelligence/gl-concepts.ts#L682). Requires unit test + benchmark. Expected recovery: 221178-shape cases (3+ cases including R6 jonas-convention if its cause is the same missing bridge).

- **7.2I-b: compositional capital admission.** When `accounting-nature.leader === "CAPITAL_ASSET"` with `isDefensible=true`, treat as sufficient standalone evidence to admit ASSET accounts at Phase-2 eligibility (currently only `capital.state === "CAPITAL"` admits). Single-rule change at `rules-structural.ts:143` or a compositional pre-check before `filterEligibleAccounts` is called. Expected recovery: 1091559-shape cases + several R4 discovery-failure cases (financed-equipment, building-acquisition, complete-equipment-serialized, replacement-component-serialized).

Both slices are **interpretation-layer repairs, not weight/threshold changes**. Both operate on the composition of existing structured accounting signals. Neither invents new concepts or new synonyms. Both preserve §16's architectural gains.

**Combined expected impact:** 4-7 top-1 recoveries if both work, moving committed-top-1 from 8 to 12-15 on the corpus. Would bring canonical accuracy to 14-17/30 (~50%) and committed to 12-15/30 (~40-50%). Neither approaches "production-worthy" alone.

**Neither is authorized in this phase.** Do not implement.

Not staged. Not merged. No production deploy.

---

**Key architectural finding to reinforce:** the two hardest cases (221178 and 1091559) both fail for the same structural reason — an accounting fact that human reviewers use every day is INFERRED by Spectre's classifiers but does not COMPOSE into the downstream reasoning:

- 221178: fs-group co-membership (`IS_IT_SOFTWARE` on both concepts) is inferred but not consulted by `conceptRelatedness`.
- 1091559: `accounting-nature.leader = CAPITAL_ASSET` is inferred but not consulted by Phase-2 eligibility.

Both are missing COMPOSITION rules, not missing evidence weight, not missing thresholds, not missing concepts. This is the answer to the founder's question.

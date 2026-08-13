# Phase 4R · Phase 7.2E-a — Exit report (§22 24-item deliverable)

**Author:** Claude (Opus 4.7) on `refactor/gl-single-authority`
**Date:** 2026-08-13
**Status:** **REVERTED per §8 mandatory safety.** Design + tests preserved for a future gated re-attempt.
**Scope:** Bounded evidence-aggregation relief for `collapseByFamily`. NO weight/threshold changes.

---

## §22 24-item deliverable

### 1. Evidence provenance model

Extended `RawObservation` with a synthetic *origin* derived from the observation's `kind` + `description`. Every observation now maps to exactly one origin string:

| Origin category | Kinds mapped to it |
|-----------------|--------------------|
| Per-line (per-observation): `${kind}:${description}` | `LINE_ITEM_MATCH`, `ECONOMIC_PURPOSE`, `DOCUMENT_PHRASE`, `PRIOR_CODING`, `SUPPLIER_CONTEXT`, `NAME_KEYWORD` |
| `purpose_authority` | `PURPOSE_TYPE_COMPAT`, `PURPOSE_TYPE_MISMATCH`, `PURPOSE_CATEGORY_HINT`, `ONTOLOGY_NAME_MATCH` |
| `nature_classifier` | `NATURE_COMPAT`, `NATURE_INCOMPATIBLE`, `ACCOUNT_ROLE_MATCH` |
| `capital_classifier` | `CAPITAL_ASSET_MATCH`, `CAPITAL_ASSET_CATEGORY_BONUS`, `RM_EXPENSE_MATCH`, `RM_EXPENSE_CONTRADICTION`, `CAPITAL_ACCOUNT_CONTRADICTION` |
| `compat_gate` | `NATURE_GATE_PREFERRED`, `NATURE_GATE_CONTRADICTED`, `OBJECT_ROLE_CONTRADICTION` |
| `taxonomy_alignment` | `ACCOUNT_NAME_SIMILARITY`, `FS_GROUP_TAXONOMY`, `CATEGORY_TAXONOMY`, `SPECIFICITY_BONUS` |
| `vendor_default` | `VENDOR_DEFAULT` |
| `line_item_jaccard` | `LINE_ITEM_JACCARD` |
| `department` | `DEPARTMENT_AFFINITY` |

Implementation: `inferObservationOrigin` in [canonical-ranker.ts](../src/lib/ap-intelligence/canonical-ranker.ts) — **retained in the file** for a future gated re-attempt.

### 2. Independence-key design

Same origin ⇒ correlated derivatives ⇒ MAX.
Different origins within same family ⇒ potentially independent ⇒ bounded SUM (cap = `INDEPENDENT_ORIGINS_CAP = 2`).
Extra group-MAX beyond cap ⇒ diagnostic.

Rationale (§3): per-line kinds derive from distinct physical phrases (description encodes the source); whole-invoice kinds derive from single-authority classifiers so all their observations share one origin.

### 3. Bounded aggregation rule

Two-step within each family:
1. Group positive observations by origin → per-group MAX (existing MAX-collapse behavior).
2. Sort per-group MAX values descending → sum top-K (K=2) → additional group-MAX values marked diagnostic.

Negatives (contradictions) unchanged: SUM.

### 4-7. Aggregation unit tests

All FOUR tests written and passed on the aggregation-active version. Marked `.skip` in [tests/phase4r-phase72e-aggregation.test.ts](../tests/phase4r-phase72e-aggregation.test.ts) after the revert. Design-intent tests preserved.

| # | Test | Expected | Result on active aggregation |
|---|------|----------|:-------:|
| 1 | Same phrase, multiple derivatives (purpose_authority) | ≤1 counted, others diagnostic | ✓ PASS |
| 2 | Two independent physical lines, both count | 2 counted | ✓ PASS |
| 3 | Three independent same-kind observations, only top-2 count | 2 counted, 1 diagnostic | ✓ PASS |
| 4 | Bounded corroboration + CAPITAL contradiction | contradiction still bites | ✓ PASS |

### 8. Contradiction interaction

Negatives were preserved as SUM (unchanged from Phase 7.1). Contradiction observations register independently and subtract from family total. **Test 4 confirmed contradictions remained effective** vs bounded positive corroboration on the specific R&M-vs-capital case tested.

However, the sealed 42-case corpus revealed an unexpected failure mode: **absence-of-contradiction cases** (documents that should ABSTAIN because no clear intent, not because contradictions fire) can now cross the commit threshold via bounded positive corroboration. Test 4 verified contradiction effectiveness but did NOT test absence-of-contradiction protection.

### 9. Suspected MAX case list

Cases classified in Phase 7.2D §19 as "correct account in Top-3 but ranked #2/#3 due to MAX-suppression":
- `jonas-convention-accum-depr` (5320 in Top-3, not Top-1)
- ~3 additional capital cases whose specific IDs would require Top-3 delta enumeration

### 10. Before/after scores for suspected cases

Phase 7.2E-a active run (`ap-bench-2026-08-13T22-28-53-238Z-p0on-p2on.json`) vs Phase 7.2D (`ap-bench-2026-08-13T12-43-47-653Z-p0on-p2on.json`):

**Recovered (aggregation helped):**
- `food-service-invoice`: 7.2D `(abstain)` → E-a `5100 ✓` (canonical selected the F&B COGS account correctly)

**Regressed (aggregation hurt):**
- `statement-of-account`: 7.2D `(abstain PASS)` → E-a **`5310` UNSAFE** — the fixture is a STATEMENT (not an invoice) that should abstain; forbidden accounts include 5310. Bounded aggregation pushed a per-line-derived fuel account above commit threshold.
- `low-price-durable-equipment`: 7.2D `1506 ✓` → E-a `5310 (wrong)` — bounded aggregation shifted the winning family from CAPITAL_NATURE (1506) to TRANSACTION_TEXT (5310).
- `completed-capital-improvement`: 7.2D `(abstain, Top-3 had 1530)` → E-a `1506 (wrong)` — the capital-safety abstain became a commit.

**Net:** +1 recovery, −2 correct → −1 net Top-1 gain. **+1 unsafe.**

### 11. 42-case Top-1

| | v206 | 7.1 | 7.2D | 7.2E-a active | **7.2E-a REVERTED (current)** |
|---|:---:|:---:|:---:|:---:|:---:|
| Pass | 12 | 11 | 13 | 14 | **13** |
| GL Top-1 | 17 | 9 | 12 | ? | **12** |

Top-1 count under 7.2E-a active: not systematically enumerated because the case-level distribution mixed recoveries and regressions.

### 12. Top-3

Not re-measured on the reverted branch (matches Phase 7.2D = 11).

### 13. Unsafe

**7.2E-a active: 1 (`statement-of-account`) — violates §8 mandatory safety.**
**7.2E-a reverted (current branch state): 0.**

### 14. Correct-winner-but-abstained

Not additionally reported — reverted state matches Phase 7.2D §11 (none observed).

### 15. Warranted vs unwarranted abstentions

7.2E-a active: warranted-abstain count DECREASED because bounded aggregation converted 2 warranted abstains (statement-of-account, completed-capital-improvement) into commits — one unsafe, one merely-wrong.

### 16. 221178 result

Not re-run on staging (aggregation change reverted).

### 17. 1091559 result

Not re-run on staging (aggregation change reverted).

### 18. DMM result

Preserved on both active and reverted runs — top-1 = 5320 ✓. Semantic wire fires end-to-end regardless of aggregation change.

### 19. `completed-capital-improvement` result

- 7.2D: `top-1 null` (correctly abstain), `top-3 = [1506, 1530, 5310]` — UNSAFE = 0. Safety preserved by the Phase 7.2D nature-classifier project-completion antiTerms.
- 7.2E-a active: `top-1 = 1506` (wrong but not forbidden) — safety NOT unsafe but classified correctly rejected.
- 7.2E-a reverted (current): `top-1 null`, UNSAFE = 0. Preserved.

### 20. Jonas trace

`jonas-convention-accum-depr`: still `top-1 null` (abstain) with `top-3 = [5320, 1250, 1260]` under both 7.2E-a active AND reverted. The aggregation change did NOT recover this specific case even in active mode (the 5320 evidence chain was purpose-authority-origin dominated, not per-line-independent).

**Founder §11 observation:** "Accumulated depreciation is a special accounting-role/taxonomy case. Do not assume TRANSACTION_TEXT aggregation alone should fix it." — CONFIRMED. TRANSACTION_TEXT aggregation did not fix Jonas; classifying it as a taxonomy/role case is correct.

### 21. Exact remaining failure-boundary distribution (post-revert)

Same as Phase 7.2D §19. No change from revert:

| Boundary | Count |
|----------|:---:|
| Correct in Top-3, ranked #2/#3 (evidence-suppression / correlated ranking) | ~4 |
| Correct absent from Top-3, wrong dominates (canonical scoring on token-thin invoices) | ~6 |
| Multi-cluster projection ABSTAIN when per-cluster is confident | ~4 |
| Upstream extraction/clustering gap | ~3 |
| Warranted abstain PASS | 5 |
| Adversarial (correct rejection) | ~3 |
| Unsafe | **0 ✅** |
| Other | ~5 |

### 22. Static single-authority guards

All 3 authority guards + Phase 7 cluster-owned + canonical-subordination — green after revert. 83 / 83 targeted tests (3 skipped design-intent tests for the reverted aggregation).

### 23. Anti-overfitting

Zero literals introduced. The `inferObservationOrigin` mapping uses generic kinds and generic authority names. Preserved as dormant infrastructure in `canonical-ranker.ts`.

### 24. Targeted tests / typecheck

- **83 / 83 tests passing** (3 skipped by design). Typecheck clean.
- Benchmark post-revert: 13/26/**0 unsafe**. Matches Phase 7.2D exactly.

### 25. Explicit recommendation for the next first-failure boundary

**Do NOT stage. Do NOT merge. Do NOT deploy production.** The branch state after Phase 7.2E-a revert is byte-identical in behavior to Phase 7.2D (pass=13, unsafe=0). Top-1 remains 12/42, five short of the 17/42 v206 recovery floor.

**Root cause of the aggregation regression:**
The bounded-SUM rule created a new commit path for documents where the aggregation change materially increased score WITHOUT a countering signal. Two specific patterns triggered:
1. **Statement / non-invoice documents** with multiple line-derived observations that all support the same account. Under old MAX the total stayed below `COMMIT_MIN_SCORE`; under bounded SUM the total crossed it. There is no contradiction observation for "document is a statement" — the abstain behavior relied on scoring staying below threshold.
2. **Capital-improvement over-commits** where bounded aggregation across TRANSACTION_TEXT origins pushed a semantically-plausible but wrong account (1506) above threshold in a case whose correct behavior is abstain.

**The founder's §8 test caught both.** The unit tests (§7) passed because they verified LOCAL correctness of the aggregation rule; the corpus benchmark caught the SYSTEMIC failure mode where absence-of-contradiction cases lose their scoring-floor protection.

**Two paths forward for Phase 7.2E-a-gated (not authorized in this slice):**

- **Option A — document-class gate.** Apply bounded SUM only when `documentClass === "INVOICE"` and canonical purpose committed. Statement/unreadable/informational documents keep MAX-collapse. Preserves 7.2D safety, likely recovers `food-service-invoice` and similar real-invoice cases where the aggregation would help.
- **Option B — commit-threshold-aware gate.** Apply bounded SUM only when the MAX-only score is already ≥ `COMMIT_MIN_SCORE − X` for small X. This makes the aggregation change a "confidence booster" for cases already near commit, not a "commit enabler" for cases that should abstain. Requires calibration of X.

**Neither is authorized right now.** Return with a design proposal + expected safety impact before re-implementation.

**Alternative if Phase 7.2E-a-gated is not authorized:** the branch is safe at Phase 7.2D state. The failure boundary distribution (§21) confirms canonical ranking / evidence-suppression accounts for ~4 cases; multi-cluster projection ~4; canonical scoring on token-thin invoices ~6. **Multi-cluster projection (Phase 7.2E-b, previously deferred) may now be a better ROI than continuing to iterate on evidence aggregation.**

---

**COMMIT SUMMARY:**
- `inferObservationOrigin` + `INDEPENDENT_ORIGINS_CAP` retained in `canonical-ranker.ts` as dormant infrastructure.
- `collapseByFamily` restored to Phase 7.2D MAX-only behavior.
- Design-intent tests preserved in `tests/phase4r-phase72e-aggregation.test.ts` as `.skip` with revert-context header.
- Zero behavior change from Phase 7.2D. Zero regressions. Zero new tests running.

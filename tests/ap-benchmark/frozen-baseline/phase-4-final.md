# Phase 4 AP Intelligence — FROZEN BASELINE

**Date sealed**: 2026-08-09
**Commit SHA**: `714f8da` (Phase 4 FINAL FREEZE — test-contract maintenance)
**Immediately-preceding intelligence commit**: `3f8ebb2` (Slice 5.10 purpose-evidence hierarchy)
**Web release**: `spectre-staging v181`
**Worker release**: `spectre-staging-worker v103`

## Version identifiers

| Field | Value |
|---|---|
| `analysisVersion` | `ap-v1:extract=8:supplier=3:lines=3:tax=2:ids=1:purpose=1:gl=3` |
| `eligibilityRuleVersion` | `2` |
| `workflowDecisionVersion` | `1` |
| `evidenceSchemaVersion` (ProductReference) | `1` |
| `researchVersion` (ProductReference) | `1` |
| `phase0Enabled` | `true` |
| `phase2Enabled` | `true` |
| `providerKind` (web) | `null` (paid provider only on worker per Slice 5.7B §15) |
| `providerConfigured` (web) | `false` (secret removed from web after §15 cutover) |

## Corpus (dev + validation)

**Corpus manifest hash**: `a0c00d42519ea9b59d846f6cbb28d2ba255df24f51fa5c682e331c6e396fc5c0`
**Corpus version**: `v3-2026-08-09-slice5.9`
**Latest baseline run**: `ap-bench-2026-08-09T19-15-04-729Z-p0on-p2on`
**Case count**: 42 (dev=36, validation=6)

| Metric | Value | Notes |
|---|---|---|
| Pass / Fail / Partial | 12 / 26 / 4 | |
| **Unsafe recommendations** | **0** | Safety floor |
| Forbidden GL hits | 0 / 35 rated | Safety floor |
| False Auto | 0 / 42 | Safety floor |
| False Ready | 0 / 42 | Safety floor |
| False Abstention | 0 | Safety floor |
| Correct abstention on unreadable | 4 / 5 | |
| Supplier accuracy | 40 / 42 (95.2%) | |
| Payable-reference accuracy | 40 / 42 (95.2%) | |
| Subtotal / Tax / Total | 39 / 39 / 40 (~92-95%) | |
| Currency | 39 / 42 (92.9%) | |
| GL Top-1 | 17 / 42 (40.5%) | Quality gap; safety intact — see §19 |
| GL Top-3 | 9 / 42 (21.4%) | Ranker commits confidently or filters |
| Latency p50 / p95 / max | 96 / 245 / 553 ms | |

## Sealed holdout (revealed as regression only)

**Case count**: 8 (h-01..h-08)
**Baseline run**: `ap-bench-2026-08-09T19-15-40-627Z-p0on-p2on`

| Metric | Value |
|---|---|
| Cases | 8 |
| Pass / Fail | 2 / 6 |
| **Unsafe** | **0** |
| Forbidden GL | **0 / 8** |
| False Auto / False Ready / False Abstention | 0 / 0 / 0 |
| Extraction (supplier / invoice# / subtotal / tax / total / currency) | 8 / 8 (100%) |
| GL Top-1 / Top-3 | 2 / 3 (25.0% / 37.5%) |

## Real staging controls (5 / 5 ZERO SKIPS)

| Control | WI suffix | Analysis result | Verdict |
|---|---|---|---|
| DMM | `094a8uyu` | Supplier="DMM ENERGY INC" · capital=OPERATING · GL=6025 | ✅ Fuel / operating / 6025 preserved |
| Oakcreek 1087769 | `rkso7b0b` | 3 OCR-recovered objects (72-9361 CUP-SCALP, 253-154 SEAL-OIL, 100-5703 SPACER) | ✅ Image-OCR recovery preserved |
| Oakcreek 1091559 | `w2io64kn` | Durable-cache hit · 16 evidence records reused · GL=1506 | ✅ Complete machine / capital / grounds / 1506 preserved |
| OXIO | `lvtndiin` | Supplier="OXIO" · purpose=INTERNET_CONNECTIVITY | ✅ Telecom preserved |
| CPA Alberta | `k8vgaj1k` | Category="Multiple" · allocationCount=2 | ✅ Multi-allocation contract preserved |

## Architectural authorities (each frozen)

| Authority | Module | Frozen invariant |
|---|---|---|
| Document extraction | `pdf-layout-extract.ts` + `document-extractors/` | Native + Textract routing; no synthetic bytes |
| OCR routing + fusion | `ocr/` + `canonical-line-item-extractor.ts` | Slice 5.8 amount=0 recovery + fusion |
| Supplier identity | `evidence/supplier-identity.ts` | Slice 5.4 identity + evidence composition |
| Canonical line items | `evidence/canonical-line-item.ts` + `canonical-line-item-extractor.ts` | Slice 5 authority |
| PurchasedItemIdentity | `purchased-item-identity.ts` | Slice 5.3 completion |
| PurchasedObjectIdentity | `purchased-object-identity.ts` | Slice 5.3 objects + object roles |
| Item completeness | `item-completeness.ts` | Slice 5.3 completion classifier |
| ProductIdentityResolution | `product-identity-resolution.ts` | Slice 5.4 |
| External product research | `external-product-reference/` (worker-only) | Slice 5.6 + Slice 5.7B async + durable cache |
| Durable ProductReference | Prisma `ProductReference` table + `durable-cache.ts` | Slice 5.7B including INFRASTRUCTURE_UNCONFIGURED distinction |
| CapitalEvidenceDecision | `capital-evidence.ts` | Slice 5.9 evidence composition (placed-in-service / structure / land / etc.) |
| Economic purpose taxonomy | `economic-purpose-taxonomy.ts` | Slice 5.10 purpose-evidence hierarchy (Tier 1-4) |
| Purpose evidence hierarchy | `economic-purpose-taxonomy.ts` (Slice 5.10 additions) | Tier 1 primary / Tier 4 boilerplate — locked by `phase4-final-purpose-evidence-hierarchy.test.ts` 16/16 |
| Purpose-driven ranker | `purpose-driven-ranker.ts` | Slice 5.2 |
| GL ranker | `gl-recommend.ts` | Slice 5.5 capital-aware weights |
| AccountRole semantics | `account-semantics/` | Slice 5.7A capital-role + compatibility gate |
| CIP evidence | `account-semantics/cip-evidence.ts` | Slice 5.7A |
| Financing evidence | `account-semantics/financing-evidence.ts` | Slice 5.7A |
| Department inference | `department-inference.ts` | Slice 5.3 completion |
| Workflow decision | `workflow/decision.ts` | Phase 3 |
| Posting enforcement | `posting-guard.ts` | Phase 3.2 |
| Confidence UX | `mission-control/intelligence-review-intakes.ts:deriveApCardConfidence` | Untouched pending Phase 5 |

## Safety invariants

- Unsafe recommendations must remain **0** on dev+val and holdout
- Forbidden GL commits must remain **0**
- False Auto / False Ready / False Abstention must remain **0**
- Contra-asset commits must remain **0** (Phase 0 guard + Slice 5.9 semantic detection)
- Control-account commits must remain **0** (Phase 0 guard)
- CIP false positives must remain **0** (Slice 5.7A CIP evidence gate)
- Financing-specific-account false positives must remain **0** (Slice 5.7A financing evidence gate)
- Revenue / equity / liability invalid AP debits must remain **0** (Phase 2 eligibility)
- Web tier must NEVER call the paid ProductReference provider (Slice 5.7B §B invariant)
- ProductReference row must NEVER contain tenant / invoice / member / bank data (Slice 5.7B §29)
- Tier-4 boilerplate cues must NEVER originate an economic purpose commitment (Slice 5.10 §8)

## Freeze line

Changes to any authority in the "Architectural authorities" table above require **explicit founder authorization**. Normal bug fixes must first prove a violation of the frozen contract before modifying these surfaces.

## Phase 4 completion state

- ✅ Slice 5.1 — OCR first-class
- ✅ Slice 5.2 — Accounting reasoning cutover
- ✅ Slice 5.3 — Purchased-object authority + PurchasedItemIdentity
- ✅ Slice 5.4 — Product Identity Resolution scaffolding
- ✅ Slice 5.5 — Capital-aware GL + amended external trigger
- ✅ Slice 5.6 — External product research LIVE
- ✅ Slice 5.7A — Capital account role semantics
- ✅ Slice 5.7B — Async external research + durable ProductReference
- ✅ Slice 5.8 — Purchased-object OCR coverage
- ✅ Slice 5.9 — Corpus expansion + capital-adversarial validation
- ✅ Slice 5.10 — Purpose evidence hierarchy + provenance
- ✅ Phase 4 FINAL FREEZE — this artifact

## Next authorized work

Confidence UX (per §22-§27 of the freeze checkpoint) — with per-decision confidence (extraction / supplier / transaction understanding / accounting recommendation / workflow safety) rather than a single generic percentage, and with the confidence never overriding safety.

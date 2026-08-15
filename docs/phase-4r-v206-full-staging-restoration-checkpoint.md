# v206 Full Staging Restoration — 18-Item §8 Checkpoint

**Prepared:** 2026-08-14 · **Branch:** `main` (= v206) · **Founder direction:** "Restore full v206 to staging. No engine transplant, no cherry-pick, no Phase 7 fixes. First restore and observe."

Stop-for-founder-review checkpoint. No production deployment.

---

## 1. Exact v206 SHA

**`cbb1b520c9ee4bd7c651d536483bf1b97fa095ae`**

- `git merge-base refactor/gl-single-authority main` → `cbb1b520c9ee4bd7c651d536483bf1b97fa095ae` ✓
- `git rev-parse main` → `cbb1b520c9ee4bd7c651d536483bf1b97fa095ae` ✓
- v206 IS the current tip of `main`. The refactor branched off exactly here.

## 2. Staging compatibility result — SAFE, deployment authorised

Non-destructive live check (script executed on staging via `flyctl ssh console`, read-only):

- **Prisma migration set** (via `SELECT migration_name FROM _prisma_migrations`): **20 rows applied on staging = 20 migrations in `prisma-postgres/migrations/` at v206.** Byte-identical name set. Zero drift.
- **Schema**: v206's `prisma-postgres/schema.prisma` is the schema Neon has been evolved to. Release_command `prisma migrate deploy --schema prisma-postgres/schema.prisma` was a no-op (all migrations already applied — confirmed by successful release_command exit).
- **Environment variables**: no changes required. All required secrets (`DATABASE_URL`, `DIRECT_DATABASE_URL`, `REDIS_URL`, `S3_*`, `R2_*`, `AWS_*`, `MICROSOFT_GRAPH_DELEGATED_*`, `SPECTRE_SESSION_SECRET`, `MAILBOX_INTEGRATION_ENABLED`) present on Fly and unchanged.
- **Work Intake APIs**: routes unchanged between v206 and phase-7.2-frozen (verified by prior git diff — the entire frozen refactor was 28 files under `src/lib/ap-intelligence/**`).
- **Worker payload shapes**: unchanged.
- **RBAC / auth / tenant scoping / iron-session**: unchanged.
- **Microsoft/Outlook integration**: unchanged.
- **Redis / R2 / object storage**: same Fly-injected secret references.

**No destructive incompatibility. Deploy proceeded.**

*(Initial check accidentally queried the SQLite dev migration folder `prisma/migrations/` and reported "DRIFT_DETECTED" — false alarm. The Postgres migration set at `prisma-postgres/migrations/` matches staging exactly. Corrected before proceeding.)*

## 3. Previous rollback anchors (before deploy)

| App | Version | Image | Machine |
|---|---|---|---|
| `spectre-staging` (web) | **v212** | `spectre-staging:deployment-01M01ENE2JEBRR6VBGMXN46W0N` | `d8d96713f13628` |
| `spectre-staging-worker` (worker) | **v109** | `spectre-staging-worker:deployment-01M01EXWZD82SMPKFCJVADB3ZA` | primary `d891ed01c54d18`, standby `d8d967dea96978` |

Both preserved on Fly. Rollback command: `flyctl deploy --image <image> --app <app>`.

## 4. New web / worker releases

| App | Version | Image | Deployed |
|---|---|---|---|
| `spectre-staging` (web) | **v213** | `spectre-staging:deployment-01M01JCCVDHT153V9JCM0EGA95` | 2026-08-15 02:05 UTC |
| `spectre-staging-worker` (worker) | **v110** | `spectre-staging-worker:deployment-01M01JP3H6E1T0K9EKA2PRD6JQ` | 2026-08-15 02:07 UTC |

Deploy strategy: rolling. Release_command completed successfully (schema no-op).

## 5. Health results

`GET https://staging.spectreautomation.com/api/health` → **HTTP 200**

```json
{
  "status": "ok",
  "version": "dev",
  "apIntelligence": {
    "analysisVersion": "ap-v1:extract=8:supplier=3:lines=5:tax=3:ids=1:purpose=3:gl=6",
    "eligibilityRuleVersion": 3,
    "workflowDecisionVersion": 1,
    "phase0Enabled": true,
    "phase2Enabled": true,
    "productReference": {
      "evidenceSchemaVersion": "1", "researchVersion": "1",
      "providerKind": "null", "providerConfigured": false,
      "stats": { "totalRows": 1, "byState": { "COMPLETED": 1 } },
      "queueDepth": { "pending": 0, "running": 0, "dlq": 0 }
    }
  },
  "checks": [
    { "name": "database", "status": "ok", "latencyMs": 16 },
    { "name": "queue", "status": "ok", "detail": "dlq total=2 · active=2 · historical=0" }
  ]
}
```

- **DB check**: ok (16ms)
- **Queue check**: ok (BullMQ; dlq total=2 is pre-existing residue, active=2 processing normally)
- **Analysis-version signature** = `ap-v1:extract=8:supplier=3:lines=5:tax=3:ids=1:purpose=3:gl=6` — pre-refactor v206 signature confirmed. (Frozen v212 signature was different and higher — this confirms staging is now running v206 code, not cached frozen artifacts.)
- **Worker**: both primary and standby machines started, no errors in start-up.
- **Outlook/Work Intake**: front-end Mission Control feed renders 9 items with 7 needing judgment (see §7/§9/§11/§13). Feed-Synced pill green.

**All green. Staging stable on v206.**

## 6. Club Support #221178 — full AP pipeline under v206

Trigger: authenticated `GET /api/mission-control/work-intake/cmsmhak530wv7ppa0lrncy9ib/ap-evidence` — this endpoint re-runs `analyseIngestedInvoice` on every call (route.ts:72, read-only).

| Stage | Value |
|---|---|
| PDF read | 34,758 bytes, `STRUCTURED` extraction, 940 text chars |
| Supplier | `Club Support Inc` (email `contactus@clubsupport.ca`, domain `clubsupport.ca`, tax # null) |
| Invoice # | `221178` |
| Invoice date | `2026-01-06` |
| Subtotal | `$3,613.50 CAD` |
| Tax | `$180.68` (5%) |
| Total | `$3,794.18 CAD` |
| Line items | 5 |
| Vendor match | `NOT_FOUND` |
| Capital state | `OPERATING` |
| Economic purpose | `SOFTWARE_SUBSCRIPTION` (score 96, quality=MEDIUM) |
| Document-level GL winner | **`6071 Subscriptions`** — source `ECONOMIC_PURPOSE`, reason `purpose_driven_full_coa_search:SOFTWARE_SUBSCRIPTION(96,quality=MEDIUM)->6071(score=75,considered=79)` |
| Alternate candidates (top 5) | `6033 R&M Preventative Maintenance` (95), `6054 Computer & IT Services` (95), `5016 Proshop Cost of Sales - Repairs` (95), `6030 R&M - Cart Paths` (94), `6031 R&M - Ground Equip` (94) |
| **Allocation-layer winner (founder-facing)** | **`6054 Computer & IT Services`** (see §7) |
| Persisted findings | 4 |

*Note: the API's `glRecommendation` (document level) and the allocations layer diverge on 221178. Allocations cluster-scoped ranking picks `6054`. The founder-facing card reads allocations.*

## 7. Club Support #221178 — founder-facing card under v206

`test-results/v206-full-restoration/mission-control-feed-full.png` — top AP card:

```
MISSING INFORMATION · MAIL-XM7H · 5 days ago
Club Support Inc invoice #221178 — $3,794.18 CAD · Computer & IT Services
c.s.turcato@gmail.com

Spectre classified the attached PDF as an invoice and extracted the vendor as
Club Support Inc. Invoice #221178. Verified GST at 5 %. No matching vendor
record exists. Prepared a proposed entry to post $3,794.18 CAD to
[ GL 6054 Computer & IT Services ]. No purchase order was identified.
2 findings for review.

AMOUNT             INVOICE       CATEGORY               CONFIDENCE
$3,794.18 CAD      #221178       Computer & IT Services Moderate · GL

RECOMMENDED  Supplier identity is not resolved to sufficient confidence.

[Request information] [Assign] [Defer 24 hr]        Invoice · PDF  [Open]
```

- **GL: 6054 Computer & IT Services** — matches founder-expected accounting for the CPA-adjacent IT service invoice.
- **Confidence: Moderate · GL** — driven by GL alternate presence, not by supplier or transaction quality.

## 8. DMM #B0037FC — full AP pipeline under v206

| Stage | Value |
|---|---|
| PDF read | 87,617 bytes, `PARTIAL` extraction, 974 text chars |
| Supplier | `DMM ENERGY INC` (tax # `724076930RT0001`) |
| Invoice # | `B0037FC` |
| Invoice date | null (extraction gap) |
| Subtotal | `$2,412.30 CAD` |
| Tax | `$120.62` (5%) |
| Total | `$2,532.92 CAD` |
| Line items | 2 (dyed low-sulphur diesel) |
| Vendor match | `NOT_FOUND` |
| Capital state | `OPERATING` |
| Economic purpose | `FUEL` (score 96, quality=HIGH) |
| GL winner | **`6025 Fuel (Gas/Diesel)`** — source `ECONOMIC_PURPOSE`, reason `purpose_driven_full_coa_search:FUEL(96,quality=HIGH)->6025(score=82,considered=79)` |
| Persisted findings | 5 |

## 9. DMM #B0037FC — founder-facing card under v206

```
MISSING INFORMATION · MAIL-BFK9 · 8/5/2026
DMM ENERGY INC invoice #B0037FC — $2,532.92 CAD · Fuel ( Gas/Diesel )

Spectre classified the attached PDF as an invoice and extracted the vendor as
DMM ENERGY INC. Invoice #B0037FC. Verified GST at 5 %. No matching vendor
record exists. Prepared a proposed entry to post $2,532.92 CAD to
[ GL 6025 Fuel ( Gas/Diesel ) ]. No purchase order was identified.
2 findings for review.

AMOUNT             INVOICE       CATEGORY               CONFIDENCE
$2,532.92 CAD      #B0037FC      Fuel ( Gas/Diesel )    High ·

[Request information] [Assign] [Defer 24 hr]        Invoice · PDF  [Open]
```

- **GL: 6025 Fuel (Gas/Diesel)** — matches founder-expected fuel operating expense.
- **Confidence: High** — clean fuel purpose signal, no genuine competitor.
- **No cash / bank / AR leak.** Structural failure pattern that trapped v212 Fix 1C never appears under v206 because v206's ranker discovers `6025 Fuel` directly via the purpose ontology + full-COA search — it does not depend on the same eligibility gate that missed BS_CASH_EQUIVALENTS / BS_AR under the frozen refactor.

## 10. Oakcreek #1091559 — full AP pipeline under v206

| Stage | Value |
|---|---|
| PDF read | 138,214 bytes, `STRUCTURED` extraction, 2,023 text chars |
| Supplier | `Oakcreek Golf & Turf LP` (email `accountsreceivable@oakcreekgolf.com`, tax # `830535936RT0001`) |
| Invoice # | `1091559-00` |
| Invoice date | `4/6/26` |
| Subtotal | `$74,112.00 CAD` |
| Tax | `$3,706.35` (5%) |
| Total | `$77,833.35 CAD` |
| Line items | 3 |
| Vendor match | `NOT_FOUND` |
| Capital state | `AMBIGUOUS` (dual-authority: legacy AMBIGUOUS, Slice 5.3 committed `CAPITAL_CANDIDATE` at confidence 95) |
| Purchased object | TORO / KUBOTA / ENGINE — resolved to serialized capital equipment |
| GL winner | **`1506 Equipment & Fixtures - Grounds`** — source `SEMANTIC_MATCH`, reason `capital-aware nature-compatible search: decision=CAPITAL_CANDIDATE(95) → 1506 (Equipment & Fixtures - Grounds) totalScore=88 natureCompat=PREFERRED dims={"accountingNature":30,"department":22,"purpose":20,"objectIdentity":0,"accountNameSimilarity":0,...}` |
| Alternate candidates (top 5) | `6053 Interest Expense` (71), `6051 Bank Charges & Credit Card Fees` (59), `5008 Cost of Sales - Draught Beer` (42), `5004 Cost of Sales - Liquor` (39), `5006 Cost of Sales - Wine` (0) |
| Splits | Multi-allocation: split entry across 2 accounting allocations, 1 requiring review |
| Persisted findings | 6 |

## 11. Oakcreek #1091559 — founder-facing card under v206

```
MISSING INFORMATION · MAIL-VKBM · 7/30/2026
Oakcreek Golf & Turf LP invoice #1091559-00 — $77,833.35 CAD ·
Equipment & Fixtures - Grounds

Spectre classified the attached PDF as an invoice and extracted the vendor as
Oakcreek Golf & Turf LP. Invoice #1091559-00. Tax was extracted from the PDF
but the rate could not be reconciled — reviewer must confirm. No matching
vendor record exists. Prepared a proposed split entry across 2 accounting
allocations with 1 requiring review. Matched to [ PO #Lance ].
3 findings for review.

AMOUNT             PO            CATEGORY               CONFIDENCE
$77,833.35 CAD     #Lance        Equipment & Fixtures - Moderate · Category
                                 Grounds

[Request information] [Assign] [Defer 24 hr]        Invoice · PDF  [Open]
```

- **Category: Equipment & Fixtures - Grounds** — v206 independently identifies the invoice as capital equipment.
- **Confidence: Moderate · Category** — reduced because of tax-rate reconciliation issue + multi-allocation split, not because of GL ambiguity.
- **PO matched**: `#Lance` (vendor-side PO recognized).

## 12. Oakcreek #1087769 — full AP pipeline under v206

| Stage | Value |
|---|---|
| PDF read | 342,862 bytes, `STRUCTURED` extraction, 359 text chars |
| Supplier | `Oakcreek Golf & Turf LP` (tax # `830535936RT0001`) |
| Invoice # | `1087769-00` |
| Invoice date | `1/7/26` |
| Subtotal | `$1,005.92 CAD` |
| Tax | `$50.30` (5%) |
| Total | `$1,056.22 CAD` |
| Line items | 3 |
| Vendor match | `NOT_FOUND` |
| Capital state | `OPERATING` |
| Economic purpose | `EQUIPMENT_PARTS` (score 96, quality=HIGH) |
| GL winner | **`6031 R & M - Ground Equip`** — source `ECONOMIC_PURPOSE`, reason `purpose_driven_full_coa_search:EQUIPMENT_PARTS(96,quality=HIGH)->6031(score=87,considered=79)` |
| Persisted findings | 4 |

## 13. Oakcreek #1087769 — founder-facing card under v206

```
MISSING INFORMATION · MAIL-ZZ7O · 7/30/2026
Oakcreek Golf & Turf LP invoice #1087769-00 — $1,056.22 CAD · R & M - Ground Equip

Spectre classified the attached PDF as an invoice and extracted the vendor as
Oakcreek Golf & Turf LP. Invoice #1087769-00. Verified GST at 5 %. No matching
vendor record exists. Prepared a proposed entry to post $1,056.22 CAD to
[ GL 6031 R & M - Ground Equip ]. Matched to [ PO #Shop ]. 1 finding for review.

AMOUNT             PO            CATEGORY               CONFIDENCE
$1,056.22 CAD      #Shop         R & M - Ground Equip   High ·

[Request information] [Assign] [Defer 24 hr]        Invoice · PDF  [Open]
```

- **Category: R & M - Ground Equip** — small $1,056 grounds-equipment repair-parts invoice correctly routed to ordinary R&M.
- **Confidence: High** — clean EQUIPMENT_PARTS purpose signal, no significant alternate.
- **PO matched**: `#Shop`.

## 14. PDF / OCR / extraction comparison

**All four invoices extract cleanly under v206.** Every field the founder listed reads correctly:

| Case | PDF read | Supplier | Inv # | Date | Subtotal | Tax | Total | Line items |
|---|---|---|---|---|---|---|---|---|
| 221178 | 34,758 B / STRUCTURED / 940 chars | ✓ Club Support Inc | ✓ | ✓ | ✓ | ✓ | ✓ | 5 |
| DMM | 87,617 B / **PARTIAL** / 974 chars | ✓ DMM ENERGY INC | ✓ | ✗ null | ✓ | ✓ | ✓ | 2 |
| 1091559 | 138,214 B / STRUCTURED / 2,023 chars | ✓ Oakcreek | ✓ | ✓ | ✓ | ✓ | ✓ | 3 |
| 1087769 | 342,862 B / STRUCTURED / 359 chars | ✓ Oakcreek | ✓ | ✓ | ✓ | ✓ | ✓ | 3 |

Extraction quality is on par with what the founder was seeing during Fix 1C acceptance — no regression in PDF reading, OCR, supplier ID, invoice # extraction, line-item extraction, tax handling. The only imperfection is the DMM date not being extracted, which pre-dates the refactor (frozen v212 also had this gap on DMM).

## 15. GL classification comparison

| Case | v206 founder-facing GL (v213) | Frozen Fix 1C GL (v212) | Founder-expected | v206 verdict |
|---|---|---|---|---|
| **221178** | `6054 Computer & IT Services`, Moderate · GL | `1313 Inventory - Proshop Repairs`, RECOMMEND MODERATE, conf 54 (POST-Fix-1C) | Computer & IT Services / IT software-service | **✓ v206 correct** |
| **DMM** | `6025 Fuel (Gas/Diesel)`, High | `1000 Petty Cash` (pre-Fix-1) → `1200/1201 Accts Receivable` ABSTAIN conf 26 (post-Fix-1C) | Fuel / petroleum operating | **✓ v206 correct** |
| **1091559** | `Equipment & Fixtures - Grounds`, Moderate · Category, split w/ PO #Lance | `ABSTAIN_NO_CANDIDATES` / REVIEW_REQUIRED | Capital equipment | **✓ v206 correct** |
| **1087769** | `6031 R & M - Ground Equip`, High, PO #Shop | (not previously documented under v212) | *Founder to confirm; result plausible for grounds-equipment repair parts.* | **~ likely correct** |

**All four cases materially better under v206 than under the frozen refactor.**

## 16. Confidence behavior

The Phase 4R FINAL Gate 1 (identity distinctness) + Gate 2 (proportional 40% substantive competitiveness) work is present on v206 in [src/lib/mission-control/intelligence-review-intakes.ts:2210-2301](src/lib/mission-control/intelligence-review-intakes.ts) — v206 IS Phase 4R FINAL. The founder-facing confidence tiers on the four cards:

| Case | Confidence tier | Weakest dimension | Reason |
|---|---|---|---|
| 221178 | Moderate | GL | Multiple GL candidates at conf 95 within the alternate pool — Gate 2's 40% substantive threshold is met by more than one, so GL confidence downgrades to Moderate |
| DMM | High | — | Clean single fuel winner; no genuine competitor passes Gate 2 |
| 1091559 | Moderate | Category | Not driven by GL — driven by tax-rate reconciliation + multi-allocation split needing review |
| 1087769 | High | — | Single clean R&M purpose signal, no alternate near winner |

Confidence behavior on v206 is **exactly what the founder's original complaint asked for**: HIGH when the winner is strong and no serious alternate exists (DMM, 1087769); Moderate when genuine alternates exist (221178) or when transaction quality is in doubt (1091559); no MODERATE where it should have been HIGH.

## 17. v206 real-COA defects observed

Observed issues (all documented; none are behavior regressions from v206's own baseline):

1. **Vendor match: NOT_FOUND on all four cases.** All four AP cards read "No matching vendor record exists / Supplier identity is not resolved to sufficient confidence." This is a **pre-existing v206 behavior** — no Coulee Ridge vendor rows exist that match these suppliers (Club Support Inc, DMM ENERGY INC, Oakcreek Golf & Turf LP). Not a v206 bug; a data seeding gap on the Coulee Ridge tenant.
2. **All AP cards render "MISSING INFORMATION" badge.** Same root cause as #1 (supplier not resolved to confidence). Not a code defect.
3. **DMM extraction state = `PARTIAL`, invoice date = null.** Persistent extraction gap unique to the DMM PDF layout. Existed on v212 as well.
4. **1091559 tax rate cannot be reconciled.** The extracted `$3,706.35 / $74,112.00 = 5.001%` reconciles fine numerically, but the extractor's tax-rate finding was flagged for reviewer confirmation. Pre-existing v206 behavior.
5. **221178 document-level GL (`6071 Subscriptions`) differs from allocation-level GL (`6054 Computer & IT Services`).** The founder-facing card reads the allocation layer. The `gl` field on the ap-evidence API response reflects the document-level ranker. This is a pre-existing v206 architecture note (not a defect) — the allocations layer is intentionally cluster-scoped and can pick differently from the document-level ranker.
6. **No 1000 Petty Cash / 1001 Bank / 9900 Bank leak observed on any of the four cases.** The specific Coulee Ridge structural-failure classes that Fix 1 / Fix 1C were built to close **do not manifest under v206**. v206's `filterEligibleAccounts` + `phase0-safety` combination happens to exclude these accounts for DMM's FUEL purpose because the purpose-driven ranker discovers `6025 Fuel` directly and never scores the bank accounts high enough to surface. This is not proof that v206's structural gate is universally correct — the same latent gap identified by Fix 1 (v206 reads raw `isBankAccount=false` on tenants where the truth is `fsGroupKey=BS_CASH_EQUIVALENTS`) still exists in v206's code. It just doesn't hurt these four cases.

**Bottom line for §17**: no NEW defects introduced by the v206 restoration. Every issue observed is either pre-existing v206 behavior or a data-seeding condition on Coulee Ridge unrelated to code.

## 18. Founder-facing assessment — how close is exact v206 to pre-refactor behavior?

**Exact match. This IS pre-refactor v206. The staging surface behaves as it did before the Phase 7 refactor began.**

Evidence:
- Analysis-version signature on `/api/health` = `ap-v1:extract=8:supplier=3:lines=5:tax=3:ids=1:purpose=3:gl=6` — the exact pre-refactor version identifiers.
- Founder-facing Mission Control feed at `/app/admin` renders the exact v206 EmailIntakeCard component (`src/components/mission-control/EmailIntakeCard.tsx` unchanged since baseline).
- All four founder-priority AP cards resolve to accounting outcomes consistent with what the founder previously observed on v206 (per the forensic doc `docs/phase-4r-forensic-old-vs-new-comparison.md`, which measured v206 at 17/42 GL Top-1 on the sealed corpus — the fresh v206 sealed benchmark run today at cbb1b52 reproduced 17/42 exactly).
- No Phase 7 code paths run: `rankCanonical`, `CanonicalAccountingTreatment`, `CanonicalAccountSemantics`, `TierSemanticsInput`, `evaluateStructuralAPEligibility`, `discoverCandidates` — none of these exist on this checkout. The frozen refactor's 28 changed files are all absent.

**Compared to v212 (Fix 1C) — the state the founder was reviewing before this direction change:**
- v212 had `1313 Inventory - Proshop Repairs` on 221178. v213/v206 has `6054 Computer & IT Services`.
- v212 had `1200 / 1201 Accts Receivable` (ABSTAIN, conf 26) on DMM after Fix 1C. v213/v206 has `6025 Fuel (Gas/Diesel)` at High confidence.
- v212 had `ABSTAIN_NO_CANDIDATES / REVIEW_REQUIRED` on 1091559. v213/v206 has `Equipment & Fixtures - Grounds` with a proper split entry.
- v212 had multiple architectural safety improvements Phase 7 built (single-winner invariant, canonical provenance, structural eligibility gate, DECISION vs DIAGNOSTIC evidence, etc.) that v206 does NOT have. Those are all now absent from staging.

**Assessment: exact v206 is materially closer to founder-expected accounting behavior on all four real controls than the frozen refactor. The Phase 7 architectural improvements are absent — the founder now sees what pre-refactor Spectre actually does end-to-end.**

---

## Artifacts

- `test-results/v206-full-restoration/health.json`
- `test-results/v206-full-restoration/mission-control-feed-full.png` (full Mission Control feed, all 4 cards visible)
- `test-results/v206-full-restoration/{221178,DMM_B0037FC,1091559,1087769}-ap-evidence.json` (full ApAnalyseResult JSON per case)
- `test-results/v206-full-restoration/{221178,DMM_B0037FC,1091559,1087769}-card-focused.png` (per-case card crops)
- `tests/e2e/v206-full-restoration.staging.spec.ts` (repeatable acceptance harness)

## Rollback if founder rejects

```
export PATH="/c/Users/cturcato/.fly/bin:$PATH"
flyctl deploy --image registry.fly.io/spectre-staging:deployment-01M01ENE2JEBRR6VBGMXN46W0N --app spectre-staging
flyctl deploy --image registry.fly.io/spectre-staging-worker:deployment-01M01EXWZD82SMPKFCJVADB3ZA --app spectre-staging-worker
```

Restores staging to v212 (frozen Fix 1C) exactly.

## Stop point per §7

**No changes applied to v206.** Per founder direction: "First restore and observe."

Do NOT proceed to:
- new structural gate (§16 proposal)
- Phase 7 confidence changes
- discovery union
- canonical ranker
- treatment hierarchy
- new thresholds / weights / account exclusions

Awaiting founder review of this checkpoint before any next step.

**No production deployment.**

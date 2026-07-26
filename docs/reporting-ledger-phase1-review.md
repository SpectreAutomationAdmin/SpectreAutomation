# Reporting Ledger — Phase 1 Review

**Date:** 2026-06-23
**Scope:** Pilot architecture — Jonas GL importer, Trial Balance ingestion, Balance Sheet projection, Income Statement projection, Financial Position migration, import responsiveness test harness.
**Decision needed:** Is the pilot architecture proven enough to begin migrating the rest of the Monthly Board Reporting Package onto the Reporting Ledger?

---

## Executive Summary

**The architecture is proven. The production wiring is not.**

End-to-end the pipeline works: a Jonas CSV → `JonasGlImporter` → `TrialBalanceSnapshot` → `BalanceSheetProjection` / `IncomeStatementProjection` → `BalanceSheetSnapshot` / `IncomeStatementSnapshot` → ledger-driven section renderer → React. Every contract has tests; every projection writes back to the ledger with idempotency, batch lifecycle, and tenant isolation; the Statement of Financial Position is fully snapshot-driven with reactive commentary; an e2e responsiveness harness proves Dataset A vs Dataset B produce materially different reports.

However, **two production-readiness gaps remain** before mass migration is safe:

1. **No persistence.** The active ledger is `InMemoryReportingLedger`. The Prisma adapter was recommended in [docs/reporting-ledger-storage-decision.md](reporting-ledger-storage-decision.md) but is not built. Every project restart drops every snapshot.
2. **No end-to-end production path.** A club operator cannot, today, upload a Jonas CSV through the deployed app and see it flow into the Statement of Financial Position. The admin route at [src/app/app/admin/imports/page.tsx](../src/app/app/admin/imports/page.tsx) uses the older `ImportBatch` system, not the new `JonasGlImporter`. The Monthly Reporting Package page reads from `buildSilverSpringsStatementOfFinancialPosition()` which builds seeded snapshots from [silver-springs-balance-sheet-seed.ts](../src/lib/reporting/seeds/silver-springs-balance-sheet-seed.ts) — NOT from a ledger query.

**Recommendation:** Approve mass migration architecturally, but **gate Phase 2 on closing the two production gaps first** (Prisma adapter + production wiring of `monthly-package.ts` + admin route upgrade). With those gaps closed, the migration order in §8 below is the recommended sequence.

---

## 1. Architecture Assessment

### 1.1 Layered design — clean and minimal

The ledger separates concerns sharply across five layers:

```
Source systems (Jonas / Spectre Accounting / payroll / POS)
      ↓
Import Layer (validators + mappers + importers)
      ↓
Reporting Ledger (8 normalized entities + atomic batches + idempotency)
      ↓
Projection Services (TB → BS, TB → IS, future: TB → AR, etc.)
      ↓
Reporting Services / View Builders (per-chapter renderers)
```

Each layer has a tight interface contract and one obvious responsibility. The split between **projections** (write derived snapshots back to the ledger) and **reporting services** (read snapshots and produce React-renderable shapes) is the right boundary — projections own accounting math, services own presentation.

**Strengths:**
- 8-entity normalization ([contracts.ts](../src/lib/reporting/ledger/contracts.ts)) covers every chapter of the Monthly Reporting Package without overlap.
- `LedgerSnapshotMetadata` is uniform across entity kinds — provenance (`sourceSystem`, `dataSource`, `importBatchId`), audit (`capturedAt`, `notes`), and identity (`snapshotId`, `clubId`) sit in one place.
- Discriminated union (`LedgerSnapshot`) gives compile-time entity narrowing.
- Atomic batches with `pending → committed | rolled-back` lifecycle support multi-entity month-close imports.

**Weaknesses:**
- `TrialBalanceLine` carries `endingBalance` only (YTD per the Jonas convention). The Income Statement projection's current-month mode has to derive month activity by subtracting two YTDs. A future enhancement should add an optional `periodActivity` field to avoid the second TB read.
- Storage contract has no schema migration story documented. When entities grow new optional fields, the in-memory implementation Just Works; the Prisma adapter will need an explicit schema-evolution plan.
- The "logical identity" function in [in-memory-ledger.ts:108](../src/lib/reporting/ledger/in-memory-ledger.ts#L108) is duplicated knowledge — it's also implicit in the budget version-handling and prior-year fiscal-year keying. A small `logicalIdentityOf(snapshot)` helper exported from the contracts module would prevent drift.

### 1.2 Idempotency + immutability — sound

The `payloadHash` (SHA-256 over value-bearing fields, excluding `snapshotId` / `capturedAt` / `importBatchId` / `notes`) cleanly distinguishes "same data" from "different data" regardless of metadata. The `upsertSnapshot` no-op path returns the existing `snapshotId` when the incoming payload matches — preventing snapshot proliferation on re-imports.

Two latent bugs found and fixed during validation gave evidence the architecture is honest about edge cases:
- Same-millisecond tie ordering in `committedSnapshotsForClub` (fixed: changed `>` to `>=` so insertion order breaks ties).
- `BalanceSheetProjection` returned a fresh UUID even when `upsertSnapshot` no-op'd (fixed: now returns the authoritative stored id from the ledger).

Both bugs were caught by tests within hours of being introduced — confidence that the test infrastructure pulls weight.

### 1.3 Tenant isolation — proven by tests, not by types

Every read API filters by `clubId`. Every projection threads `clubId` from input to snapshot. The Jonas importer binds `clubId` per import. Tests assert no cross-club leakage at the `getTrialBalance` / `getBalanceSheet` / `getIncomeStatement` boundary.

**Caveat:** isolation is enforced at the implementation level, not the type level. A future writer that forgets to filter by `clubId` would compile. The CLAUDE.md operating rule "every query that returns club-scoped rows MUST be scoped via `tenantWhere` / `tenantScope` / explicit `clubId`" applies but is not lint-enforced for the ledger module. **Recommend:** when the Prisma adapter is built, route every read through a `tenantScopedLedgerRead<T>(clubId, query)` helper that makes a missing `clubId` filter impossible to express.

---

## 2. Import Performance

Measurements from the test suite (Windows 11, single-process Node, in-memory backend):

| Operation | Cost |
|---|---|
| Parse + validate a 10-row Jonas CSV | ~1 ms |
| Map 10 accounts via standard ranges | < 1 ms |
| Reconcile trial balance (debits ≡ credits) | < 1 ms |
| Write `TrialBalanceSnapshot` to in-memory ledger | < 1 ms |
| Compute SHA-256 payload hash | < 1 ms |
| Full Jonas import pipeline (10 rows) | ~2–5 ms |
| `BalanceSheetProjection.getBalanceSheetSnapshot` | ~1–3 ms |
| `IncomeStatementProjection.getIncomeStatementSnapshot` (YTD) | ~1–3 ms |
| `IncomeStatementProjection.getIncomeStatementSnapshot` (current-month) | ~2–4 ms (reads 2 TBs) |
| Full e2e (CSV → BS → SoFP render contract) | ~5–10 ms |

For the typical month-close envelope (one club, ~200 accounts, four imports — TB, AR, payroll, capital), this projects to **< 100 ms total per close**. Comfortable.

**Scaling concerns:**
- The in-memory ledger uses linear iteration for every read (`committedSnapshotsForClub` walks all snapshots, dedups by identity). At ~10,000 snapshots per club this is still microseconds, but at ~1M snapshots (300 clubs × 5 years × multiple entities × multiple versions) the constant-factor cost matters. The Prisma adapter must use real indexes on `(clubId, entityKind, asOf)` and `(clubId, entityKind, periodEnd)`.
- The payload hash computation walks every line of every snapshot. For a 5,000-line TB this is still milliseconds, but a future "all-clubs nightly re-projection" needs to cache hashes (or compute them only when the underlying payload mutates, which is once — at write time).

**Bottom line:** no performance concerns for Phase 2. Re-evaluate once the Prisma adapter is in place and snapshot counts grow past 100k per backend.

---

## 3. Data Lineage Assessment

The Financial Reporting Data Integrity rule in CLAUDE.md requires every rendered value to trace through the chain:

```
Accounting Records → Reporting Service → KPI Calculations → Visualizations → Commentary
```

Status per layer:

| Layer | Status |
|---|---|
| Accounting Records | ✓ Jonas extract format supported via importer |
| TrialBalanceSnapshot | ✓ Idempotent, balanced, immutable |
| BalanceSheetSnapshot via projection | ✓ Configurable per-club mapping; reconciled |
| IncomeStatementSnapshot via projection | ✓ YTD + current-month; 7 buckets + NOI roll-up |
| Section render contracts | ✓ For Statement of Financial Position only (1 of 14) |
| React render | ✓ Renders the contract; no client-side calculation |

For the **one section that is migrated** (Statement of Financial Position), every value (asset / liability / equity line, every subtotal, working-capital ratio, net-to-gross PP&E, every commentary number) traces back to a `BalanceSheetSnapshot.lines[]` or a deterministic formula on those lines. The e2e responsiveness spec proves it: Dataset A and Dataset B produce different values, ratios, and commentary text.

**Caveats:**
- 4 of 6 SoFP stewardship ratios (AR Current Rate, Dues:Revenue, Reserve Coverage, Debt Service Coverage) and the Net-to-Gross PP&E override are still passed in via `SoFPAuxiliaryRatioInputs`. Each is explicitly documented as awaiting its own ledger projection (AR Aging, Income Statement, Capital Tracker / Reserve Study).
- Income Statement variance against budget + prior-year is implemented in `buildIncomeStatementView` but no Budget or Prior-Year importer exists — the joined view falls through to null for those columns.
- All 13 other sections still source from inline literals or `SILVER_SPRINGS_*` constants (see [docs/monthly-reporting-data-lineage-audit.md](monthly-reporting-data-lineage-audit.md)).

---

## 4. Remaining Hardcoded Items

After the SoFP migration, the following remain hardcoded in production rendering code:

### 4.1 Highest-visibility — board's first impression
- **Executive Opening cover KPIs** ([src/lib/reporting/executive-summary.ts](../src/lib/reporting/executive-summary.ts)) — `$14.62M`, `$3.18M`, `$2.04M`, `1.42x`, `$4.71M`, `78.4%`. These are the first numbers a board member sees and they would NOT change after a real Jonas import today.

### 4.2 Financial Performance chapter
- **Statement of Activities** ([statement-of-activities.ts](../src/lib/reporting/statement-of-activities.ts)) — 37 rows seeded.
- **Capital Fund statement** ([capital-fund-statement.ts](../src/lib/reporting/capital-fund-statement.ts)) — 11 rows seeded; Reserve Adequacy has two unconditional "risk" tones.

### 4.3 Other chapters
- **Stewardship Dashboard** — operating + capital scorecard rows read from `SILVER_SPRINGS_OPERATING_INPUTS` / `SILVER_SPRINGS_CAPITAL_INPUTS`. 3 rows are live; 13+ are seeded.
- **AR Aging** ([accounts-receivable-aging.ts](../src/lib/reporting/accounts-receivable-aging.ts)) — values hardcoded; `prisma.memberAccount` data is fetched upstream but ignored.
- **Payroll Analysis** ([payroll-analysis.ts](../src/lib/reporting/payroll-analysis.ts)) — chart math is correct, but inputs are demo seeds.
- **Capital Projects** ([capital-project-tracker.ts](../src/lib/reporting/capital-project-tracker.ts)) — 6 active projects + 1 planning row are seeded.

### 4.4 Hardcodes that survived the SoFP migration on purpose
- **Silver Springs balance-sheet seed** ([silver-springs-balance-sheet-seed.ts](../src/lib/reporting/seeds/silver-springs-balance-sheet-seed.ts)) — 22 line items. These are the demo data the rendered SoFP currently shows. They are NOT in the section renderer (which is fully snapshot-driven); they are data passed into the snapshot. To remove them, real Jonas imports for Silver Springs need to land in a persisted ledger.
- **4 auxiliary ratios + Net-to-Gross PP&E override** in `buildSilverSpringsStatementOfFinancialPosition`. Each is documented as awaiting its specific ledger projection.

---

## 5. Remaining Demo Data

Demo data still lives in three places:

1. **Section service seeds** (the inline literals in §4) — these are the immediate target for migration.
2. **Silver Springs balance-sheet seed** ([silver-springs-balance-sheet-seed.ts](../src/lib/reporting/seeds/silver-springs-balance-sheet-seed.ts)) — passes through the ledger-driven render path but originates as code, not data. Removable once a real Jonas import for Silver Springs is committed to the ledger.
3. **Test fixtures** — Datasets A, B, C, D in [tests/balance-sheet-projection.test.ts](../tests/balance-sheet-projection.test.ts), [tests/jonas-gl-importer.test.ts](../tests/jonas-gl-importer.test.ts), [tests/income-statement-projection.test.ts](../tests/income-statement-projection.test.ts), and the e2e spec. These are correct to keep — they exercise the contract regardless of which club is in production.

**Seed → snapshot is the right escape path** for Silver Springs during transition. The architecture allows the production app to keep rendering valid demo data while the persistence layer + admin UI catch up.

---

## 6. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Mass migration begins before Prisma adapter exists → in-memory ledger is rebuilt on every process restart, breaking production reporting | Med | High | **Gate Phase 2 on Prisma adapter completion** (see §9) |
| 2 | Admin import route uses the OLD `ImportBatch` system; clubs upload Jonas CSVs that never reach the new pipeline | High | High | **Build a `/app/admin/imports/jonas` route** that wraps `JonasGlImporter` before declaring the success criteria met |
| 3 | `monthly-package.ts` continues calling `buildSilverSpringsStatementOfFinancialPosition` (which builds seed snapshots) instead of reading from the ledger; rendered SoFP shows demo data after real imports | Certain (until fixed) | High | Add a ledger-aware orchestrator that prefers committed snapshots over seeds |
| 4 | A future writer forgets the `clubId` filter and leaks data across clubs | Low | Catastrophic | Route every Prisma read through a `tenantScopedLedgerRead<T>(clubId, ...)` helper; lint-enforce |
| 5 | Account mapping coverage is incomplete for a real club's chart of accounts; imports fail with `failed-mapping` | High during onboarding | Medium | The Jonas importer surfaces unmapped accounts as diagnostics; per-club overrides are the documented escape. **Recommend:** a "mapping coverage" admin page that shows unmapped accounts with one-click "add override" buttons |
| 6 | Income Statement current-month derivation requires the PRIOR period TB to be in the ledger; clubs onboarding mid-year won't have it | High during onboarding | Medium | Document the requirement; allow a "current-month not computable" sentinel rather than failing the projection |
| 7 | `payloadHash` includes `accountName`. If a club renames an account between two otherwise-identical imports, the projection writes a new snapshot — bloating snapshot count | Medium over time | Low | Acceptable for now; revisit when snapshot count > 10k per club |
| 8 | Reserve Study / Budget / Prior-Year importers don't exist; sections that depend on them stay stuck on auxiliary inputs | Certain (until built) | Medium | Sequencing in §8 below — build these importers before migrating the dependent sections |

---

## 7. Success Criteria Verification

The founder named four success criteria. Status of each as of this review:

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | A club can export Trial Balance from Jonas | ✓ Out of scope (Jonas-side) | Standard Jonas GL extract CSV format is supported |
| 2 | A club can import the CSV into Spectre | ✗ Not via the production app | `JonasGlImporter` exists and works programmatically; admin route at `/app/admin/imports` is wired to a DIFFERENT system (`ImportBatch`). **Gap: no UI calls `JonasGlImporter`** |
| 3 | The import populates the Reporting Ledger | ✗ Not in production | `InMemoryReportingLedger` populates correctly in tests; no Prisma adapter; in-process ledger is reset on every restart |
| 4 | The result is a materially different Financial Position report | △ Proven in tests; not in production | [tests/e2e/reporting-ledger-balance-sheet.spec.ts](../tests/e2e/reporting-ledger-balance-sheet.spec.ts) proves Dataset A vs Dataset B produce different values + ratios + commentary. Production rendering still consumes seed snapshots — would NOT change after a real CSV upload until §6 risk #3 is closed |

**Net:** 1 of 4 criteria are met today. The other 3 are 80% architecturally there but the last-mile production wiring is missing.

---

## 8. Recommended Migration Order

For the 7 sections the founder named, sequence is driven by **(a) dependencies on other importers/projections** and **(b) board-visibility risk**.

### Phase 2a — Prerequisites (do FIRST; gates everything else)
1. **Prisma-backed ReportingLedger adapter** — same external interface as `InMemoryReportingLedger`; new entity table + JSON payload column per [docs/reporting-ledger-storage-decision.md](reporting-ledger-storage-decision.md).
2. **Admin route at `/app/admin/imports/jonas`** that wraps `JonasGlImporter` end-to-end (CSV paste / file upload → diagnostics → formatted report).
3. **Wire `monthly-package.ts`** to prefer ledger reads over seed snapshots for Silver Springs (and any onboarded club). Falls back to seed only when the ledger has no committed snapshot for the period.

Once Phase 2a lands, all 4 success criteria are met for Silver Springs.

### Phase 2b — Migrate sections that depend on projections that EXIST

| Order | Section | Depends on | Complexity | Why this order |
|---|---|---|---|---|
| 1 | **Statement of Activities** | IncomeStatementProjection (✓ built) | Medium | Same shape as the SoFP refactor; proves the IS view's variance columns; lowest-risk way to validate the IS projection in production |
| 2 | **Executive Opening** | BS + IS projections (✓ both built) | Medium | **Highest board-visibility hardcoded values** — `$14.62M` / `1.42x` etc. The first thing a board member sees should reflect real data first |
| 3 | **Stewardship Dashboard** | BS + IS + RAG engine (✓ all exist) | Medium-High | Already has reactive narrative scaffolding; the migration removes the `SILVER_SPRINGS_*_INPUTS` constants and routes through the projections |

Each of these migrations follows the SoFP pattern (move literals into a seed → re-write the section service to consume the snapshot → reactive commentary → e2e responsiveness spec).

### Phase 3 — Build the next importers, then migrate the dependent sections

| Order | Build | Then migrate | Notes |
|---|---|---|---|
| 1 | **AR Aging projection** (TB → ArAgingSnapshot, OR direct importer from AR subledger) | **AR Aging** chapter | Unlocks the `arCurrentRate` auxiliary input in SoFP |
| 2 | **Payroll importer** (ADP / Workday / Gusto adapter → PayrollSnapshot) | **Payroll Analysis** chapter | Distinct from Jonas — payroll providers are separate systems |
| 3 | **Capital Project importer** (CSV / manual entry → CapitalProjectSnapshot) | **Capital Projects** chapter | Can be manual-entry-driven for first iteration |
| 4 | **Reserve Study importer / projection** | **Capital Fund** chapter | Most complex — reserve studies are typically PDFs; OCR or structured manual entry |

### Why not Capital Fund first?
It has the **most external dependencies** (Reserve Study + Capital Project tracker + Income Statement). Building those importers before migrating the section avoids a half-migrated chapter that has to be torn out and redone.

### Why not AR Aging first?
The AR Aging service today reads from `prisma.memberAccount` upstream (the audit confirms this) but ignores the data and renders literals. There's an opportunity to **wire it directly** to `prisma.memberAccount` without a ledger projection (the data is already in a transactional table). But the discipline argument says: every reporting surface should read from the ledger, not directly from a transactional table — so the AR projection should be built first.

---

## 9. Final Recommendation

**Do not declare the architecture proven for mass migration today.** The architecture is sound, the contracts are clean, the projections are working, and the e2e harness is in place. But three production-blocking gaps remain:

1. No persistence (Prisma adapter)
2. No production import path (admin route still uses `ImportBatch`, not `JonasGlImporter`)
3. No production wiring (monthly-package reads seeds, not the ledger)

**Approve Phase 2a as the next slice** — Prisma adapter + admin Jonas route + monthly-package wiring. These are the three things standing between "tests prove it works" and "a club can do this through the deployed app."

**After Phase 2a lands, mass migration is approved.** The recommended order is in §8: Statement of Activities → Executive Opening → Stewardship Dashboard, then build AR / Payroll / Capital Project / Reserve Study importers in parallel with their dependent sections.

The pattern established by the SoFP migration ([statement-of-financial-position.ts](../src/lib/reporting/statement-of-financial-position.ts) + [silver-springs-balance-sheet-seed.ts](../src/lib/reporting/seeds/silver-springs-balance-sheet-seed.ts) + [tests/e2e/reporting-ledger-balance-sheet.spec.ts](../tests/e2e/reporting-ledger-balance-sheet.spec.ts)) is the repeatable template — every future section follows the same three-file shape:

1. Move section's literals to a `seeds/<club>-<entity>-seed.ts` builder that produces a `LedgerSnapshot`.
2. Rewrite the section service to derive every value, ratio, and commentary line from the snapshot. Reactive commentary branches on snapshot values. Auxiliary inputs are typed and documented as awaiting their own projection.
3. Add `tests/e2e/reporting-ledger-<section>.spec.ts` proving Dataset A vs Dataset B produce different values, ratios, and commentary on every displayed subsystem.

When each new section ships, update [docs/monthly-reporting-data-lineage-audit.md](monthly-reporting-data-lineage-audit.md) so the data-lineage status of the package as a whole stays current.

---

## Appendix — Files reviewed for this assessment

**Reporting Ledger core**
- [src/lib/reporting/ledger/contracts.ts](../src/lib/reporting/ledger/contracts.ts)
- [src/lib/reporting/ledger/in-memory-ledger.ts](../src/lib/reporting/ledger/in-memory-ledger.ts)
- [src/lib/reporting/ledger/payload-hash.ts](../src/lib/reporting/ledger/payload-hash.ts)
- [src/lib/reporting/ledger/read-api.ts](../src/lib/reporting/ledger/read-api.ts)
- [src/lib/reporting/ledger/write-api.ts](../src/lib/reporting/ledger/write-api.ts)
- [src/lib/reporting/ledger/index.ts](../src/lib/reporting/ledger/index.ts)

**Importers + projections**
- [src/lib/reporting/ledger/importers/jonas-gl-importer.ts](../src/lib/reporting/ledger/importers/jonas-gl-importer.ts)
- [src/lib/reporting/ledger/importers/jonas-gl-csv.ts](../src/lib/reporting/ledger/importers/jonas-gl-csv.ts)
- [src/lib/reporting/ledger/importers/jonas-gl-mapping.ts](../src/lib/reporting/ledger/importers/jonas-gl-mapping.ts)
- [src/lib/reporting/ledger/projections/balance-sheet-projection.ts](../src/lib/reporting/ledger/projections/balance-sheet-projection.ts)
- [src/lib/reporting/ledger/projections/balance-sheet-mapping.ts](../src/lib/reporting/ledger/projections/balance-sheet-mapping.ts)
- [src/lib/reporting/ledger/projections/financial-position-service.ts](../src/lib/reporting/ledger/projections/financial-position-service.ts)
- [src/lib/reporting/ledger/projections/income-statement-projection.ts](../src/lib/reporting/ledger/projections/income-statement-projection.ts)
- [src/lib/reporting/ledger/projections/income-statement-mapping.ts](../src/lib/reporting/ledger/projections/income-statement-mapping.ts)
- [src/lib/reporting/ledger/projections/income-statement-view.ts](../src/lib/reporting/ledger/projections/income-statement-view.ts)

**Migrated section**
- [src/lib/reporting/statement-of-financial-position.ts](../src/lib/reporting/statement-of-financial-position.ts)
- [src/lib/reporting/seeds/silver-springs-balance-sheet-seed.ts](../src/lib/reporting/seeds/silver-springs-balance-sheet-seed.ts)

**Test infrastructure**
- [tests/jonas-gl-importer.test.ts](../tests/jonas-gl-importer.test.ts)
- [tests/balance-sheet-projection.test.ts](../tests/balance-sheet-projection.test.ts)
- [tests/income-statement-projection.test.ts](../tests/income-statement-projection.test.ts)
- [tests/statement-of-financial-position.test.ts](../tests/statement-of-financial-position.test.ts)
- [tests/statement-of-financial-position-ledger.test.ts](../tests/statement-of-financial-position-ledger.test.ts)
- [tests/e2e/reporting-ledger-balance-sheet.spec.ts](../tests/e2e/reporting-ledger-balance-sheet.spec.ts)

**Architecture context**
- [docs/reporting-ledger-architecture.md](reporting-ledger-architecture.md)
- [docs/reporting-ledger-storage-decision.md](reporting-ledger-storage-decision.md)
- [docs/monthly-reporting-data-lineage-audit.md](monthly-reporting-data-lineage-audit.md)

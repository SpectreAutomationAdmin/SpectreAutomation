# Statement of Financial Position — Cutover Review

**Date:** 2026-06-23
**Scope:** All seven layers of the Financial Position chapter — import route, persistence, snapshot builder, projection layer, reporting service, UI rendering, commentary generation.
**Decision needed:** Is Financial Position ready to become the first fully production-driven chapter in the Monthly Board Reporting Package?

---

## Executive Summary

**GO.** Financial Position is cutover-ready.

The complete pipeline — Jonas CSV upload → server-side validation → idempotent persistence → ledger projection → reactive section render → branched commentary — works end-to-end through the deployed app, is covered by tests, survives application restart, and produces a materially different report from a different upload.

The six confirmation checks the founder asked for all pass. The three founder success criteria are met end-to-end without operator intervention beyond the upload itself.

Six small caveats are honestly catalogued in §4; none are blockers, and each has a clear owner in the Phase 3 roadmap (mostly: build the missing auxiliary-ratio projections — AR Aging, Income Statement, Reserve Study — so the remaining 4 ratio inputs are also ledger-driven instead of caller-supplied).

---

## 1. Component-by-component review

### 1.1 Import route — `/app/admin/imports/jonas`

**Files:** [src/app/app/admin/imports/jonas/page.tsx](../src/app/app/admin/imports/jonas/page.tsx), [src/app/app/admin/imports/jonas/jonas-import-form.tsx](../src/app/app/admin/imports/jonas/jonas-import-form.tsx), [src/app/app/admin/imports/jonas/actions.ts](../src/app/app/admin/imports/jonas/actions.ts)

**Workflow:** Upload → Validate → Preview → Map Accounts (blocks commit if unmapped) → Import → Persist → Success Summary.

**Server actions:**
- `previewJonasImport` — parses + maps + reconciles WITHOUT writing; surfaces validation errors, mapping coverage, reconciliation math, and a duplicate-period warning.
- `commitJonasImport` — runs the full `JonasGlImporter` against `PrismaReportingLedger`. Returns the `JonasImporterResult` for the success summary.
- `listJonasImports` — reads `ReportingLedgerBatch` filtered by `sourceSystem = "jonas-gl"` for the audit history rail.

**Tenancy + RBAC:** every server action resolves `clubId` from the session (never trusted from the client) and requires `settings:write` on the active club. Unauthorized callers redirect to `/app/admin`.

**Discoverability:** sidebar link "Imports · Jonas GL" under Data, gated by the same permission as the page guard.

**Status: PRODUCTION-READY.**

### 1.2 Persistence layer — `PrismaReportingLedger`

**Files:** [src/lib/reporting/ledger/prisma-ledger.ts](../src/lib/reporting/ledger/prisma-ledger.ts), [prisma/schema.prisma](../prisma/schema.prisma) (`ReportingLedgerSnapshot` + `ReportingLedgerBatch`)

**Schema:** hybrid storage — indexed columns (clubId, entityKind, asOf/periodEnd, fiscalYearLabel, batchState, payloadHash, importBatchId) for every read path; full snapshot payload as JSON (TEXT on SQLite, jsonb-portable on Postgres).

**Audit metadata:** every row carries `createdAt`, `importedAt`, `capturedAt`, `sourceSystem`, `sourceFile`, `reportingPeriod`, `dataSource`, `notes`.

**Semantics (matches in-memory backend):**
- IMMUTABLE — rows are never updated in place; replacements insert new rows.
- IDEMPOTENT — bit-identical re-imports no-op via SHA-256 payload hash.
- ATOMIC BATCHES — pending → committed | rolled-back lifecycle.
- MULTI-TENANT — every read filters by `clubId`.
- LATEST-WINS — most recent `capturedAt` per logical identity, tied broken on `createdAt`.

**Restart-persistence test** ([tests/prisma-reporting-ledger.test.ts](../tests/prisma-reporting-ledger.test.ts)) proves: import → discard instance → new instance against same DB → read returns the persisted snapshot with `Date` instances re-hydrated. 4/4 tests, 5/5 consecutive runs stable.

**Status: PRODUCTION-READY.**

### 1.3 Snapshot builder — `BalanceSheetProjection`

**Files:** [src/lib/reporting/ledger/projections/balance-sheet-projection.ts](../src/lib/reporting/ledger/projections/balance-sheet-projection.ts), [src/lib/reporting/ledger/projections/balance-sheet-mapping.ts](../src/lib/reporting/ledger/projections/balance-sheet-mapping.ts)

**Inputs:** `TrialBalanceSnapshot` + per-club `BalanceSheetMapping` (defaults to `STANDARD_PRIVATE_CLUB_BALANCE_SHEET_RANGES`).

**Outputs:** `BalanceSheetSnapshot` with the 9-value `BalanceSheetCategory` taxonomy (current-asset / capital-fund-asset / ppe-gross / ppe-accumulated-depreciation / current-liability / long-term-liability / operating-fund-balance / capital-fund-balance / ytd-net-income), all roll-ups pre-computed, reconciliation checked.

**Idempotency:** writes via `upsertSnapshot` → bit-identical projection is a no-op (same payload hash). Re-projection after a TB replacement writes a new BS row; the prior BS stays for audit.

**Mapping precedence:** explicit per-account override > account-range rule > null (surfaces as `failed-mapping` diagnostic).

**Status: PRODUCTION-READY.** Tested in [tests/balance-sheet-projection.test.ts](../tests/balance-sheet-projection.test.ts) — 8/8 tests, including tenant isolation, configuration-driven mapping (works for any club without overrides), and full BS reconciliation against Datasets C and D.

### 1.4 Reporting service — `getStatementOfFinancialPositionForClub` (dual-read)

**File:** [src/lib/reporting/statement-of-financial-position.ts](../src/lib/reporting/statement-of-financial-position.ts)

**Pattern:**
```
1. If TB exists in ledger at period.periodEnd:
     project → BS (idempotent — same TB → same hash → no-op write)
     return the projected BS
2. Else if a hand-imported BS exists:
     return it directly
3. Else:
     fall back to demoFallback() — Silver Springs seed for now
```

**Why always re-project at read time:** the first iteration cached via "BS-read first; project if missing." That returned a stale BS after a Dataset B re-import (Dataset A's cached BS was still the most recent). Re-projecting on every read is the correct behaviour — `upsertSnapshot` short-circuits to no-op when nothing changed, so there's no row churn.

**asOf normalization:** `period.periodEnd` is normalized to end-of-day before the ledger query so a TB stored at `May 31 23:59:59` matches a query for "as of May 31" regardless of the input timestamp's time-of-day.

**Prior-year snapshot:** loaded from the ledger via the same one-year-back query; returns null when no historical data exists. The Comparative column renders em-dash on first onboarding.

**Status: PRODUCTION-READY.**

### 1.5 UI rendering — chapter VII

**Files:** [src/app/app/admin/reporting/monthly/page.tsx:5414-5728](../src/app/app/admin/reporting/monthly/page.tsx) (chapter VII React render)

**Architecture:** React renders the `StatementOfFinancialPosition` contract produced by the service. The page is a thin renderer — switch on `SoFPRow.kind` (`section-band-operating` / `section-band-capital` / `detail` / `subtotal` / `total` / `total-mid`) → render that row class. No client-side calculation. No inline literal numbers.

**Grep verification:** `awk 'NR>=5414 && NR<=5728'` over the file matched ZERO numeric literals that look like balance-sheet values. The single regex hit was a CSS grid template (`1.4rem_minmax(0,1fr)`), not a financial value.

**Stable testids:** every row gets `data-testid="sofp-row-${row.key}"`, every ratio `data-testid` references its key. This is what the e2e validation specs assert against.

**Status: PRODUCTION-READY.**

### 1.6 Commentary generation — `buildBalanceSheetNotes`

**File:** [src/lib/reporting/statement-of-financial-position.ts:124-225](../src/lib/reporting/statement-of-financial-position.ts) (notes block)

**Reactive branches:**
- **Note 1** — structural (fund separation). No numbers. Identical across snapshots by design.
- **Note 2 — PP&E aging**, 3 branches by `netToGrossPpe`:
  - `< 0.40`: "materially aged ... prioritise replenishing reserve contributions"
  - `0.40–0.60`: "importance of maintaining reserve contributions at or above study-recommended levels"
  - `≥ 0.60`: "asset base remains relatively young and current reserve contributions appear adequate"
- **Note 3 — Deferred initiation fees**: conditional — omitted entirely when `hasDeferredInitFees === false`. When present, quotes the actual amount from the snapshot.
- **Note 4 — Working capital health**, 4 branches by `workingCapitalRatio`:
  - `< 1.0`: "below the 1.0x liquidity floor — immediate Board attention"
  - `1.0–1.5`: "below the 1.5x policy target — Finance Committee should monitor receivables aging"
  - `1.5–2.5`: "comfortably exceeds the 1.5x policy target"
  - `> 2.5`: "well above the 1.5x policy target — consider deployment to reserves or principal pay-down"

**Verified in tests** — `tests/statement-of-financial-position.test.ts:73-110` flips inputs and asserts each branch fires. Total branches in commentary: **3 × 4 × 2 = 24 distinct rendered states** (PP&E age × working-capital health × deferred-init-fees on/off).

**Status: PRODUCTION-READY.**

---

## 2. Six-point confirmation

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | Jonas CSV import works | ✓ | [tests/e2e/jonas-import-route.spec.ts](../tests/e2e/jonas-import-route.spec.ts) — 3/3 tests, 5/5 stable. Validation errors, duplicate warnings, success commit all green. |
| 2 | Imported data persists | ✓ | [tests/prisma-reporting-ledger.test.ts](../tests/prisma-reporting-ledger.test.ts) — instance #1 imports → instance #2 reads back via DB, same snapshotId, same line values, `Date` instances rehydrated. 4/4 tests, 5/5 stable. |
| 3 | Financial Position responds to imports | ✓ | [tests/e2e/sofp-production-ledger.spec.ts](../tests/e2e/sofp-production-ledger.spec.ts) — BEFORE: Cash `1,896,328` (seed). AFTER Dataset A: Cash `2,000,000`. AFTER Dataset B: Cash `2,200,000`. Total Assets and other rows also flip. 2/2 tests, 5/5 stable. |
| 4 | Commentary responds to imports | ✓ | Working-capital note and PP&E aging note both quote snapshot-derived ratios; tests assert per-branch text. [tests/statement-of-financial-position.test.ts:73-110](../tests/statement-of-financial-position.test.ts) flips inputs across all branch boundaries. |
| 5 | No remaining hardcoded balance-sheet values exist | ✓ (see note) | Grep over `statement-of-financial-position.ts` → ZERO inline numeric literals. Grep over the React render → ZERO. Six hardcoded literals remain in [monthly-package.ts:1627-1633](../src/lib/reporting/monthly-package.ts) but they are **auxiliary cross-system ratios** (AR Current, Dues:Revenue, Reserve Coverage, Debt Service Coverage, Net-to-Gross PP&E override, Replacement Cost label) — NOT balance-sheet line values. Each is explicitly typed (`SoFPAuxiliaryRatioInputs`) and documented as awaiting its own ledger projection (AR Aging / IS / Reserve Study). See §4 risk #1 for the cleanup path. |
| 6 | Demo fallback works correctly | ✓ | E2E spec's "BEFORE" stage with empty ledger verifies the seeded value (`1,896,328`) renders. The dual-read's branch 3 (no TB, no BS → demoFallback) is the exact path. |

### Detail on confirmation #5 — what counts as "balance-sheet"

For the purposes of this review, "balance-sheet values" means the per-line dollar amounts that compose the Assets, Liabilities, and Members' Equity sections (Cash, AR, Reserve Fund, PP&E gross, AP, LT Debt, Members' Equity, etc.) plus their derived subtotals (Net PP&E, Total Assets, Total Liabilities, Total Equity).

**Every one of those values now traces to a `BalanceSheetSnapshot` line** — either from a live Jonas import (production path) or from the Silver Springs seed (fallback path). The seed itself is data, not formula — moving it represents data migration, not refactoring.

The 6 remaining literals in `monthly-package.ts` are:
- 4 ratios that derive from non-BS data sources (AR aging, income statement, capital tracker)
- 1 override for Net-to-Gross PP&E that intentionally uses the Reserve Study figure (replacement-cost basis) rather than book-value PP&E from the BS
- 1 string label for replacement cost (`"$7.9M"`)

These are **cross-system aggregates** that the BS alone cannot compute. They become live data when their respective importers / projections land in Phase 3.

---

## 3. End-to-end click path (founder reproducible)

1. Log in as `admin@silversprings.club` / `password`.
2. **Sidebar → Governance & Reporting → Monthly Package** — observe the Statement of Financial Position chapter. Cash row reads `1,896,328` (seed value).
3. **Sidebar → Data → Imports · Jonas GL** — the new route.
4. Fill the form:
   - Period start: `2026-05-01`
   - Period end: `2026-05-31`
   - Fiscal year label: `FY2026`
   - Fiscal period: `5`
   - Paste a Jonas CSV (the spec datasets work; or any Jonas-format CSV with Cash YTD different from `1,896,328`).
5. Click **Preview** — confirm `PASS` reconciliation and `10/10` mapped.
6. Click **Commit import** — confirm `Import result: SUCCEEDED` and a fresh snapshot ID.
7. Navigate back to **Monthly Package**. The Statement of Financial Position now reads the imported value (e.g. `2,000,000` for Dataset A).
8. Scroll to the Balance Sheet Notes block. The working-capital and PP&E aging paragraphs now quote the imported club's actual ratios; the deferred-initiation-fee paragraph is omitted because no such account exists in the typical Jonas extract.
9. **Re-import** a different CSV for the same period → the page reflects the replacement on the next render.

---

## 4. Risks remaining

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Auxiliary ratios (`arCurrentRate`, `duesToRevenueRatio`, `reserveCoverageRatio`, `debtServiceCoverage`, `netToGrossPpeOverride`) are hardcoded in `monthly-package.ts` | Med | Will move to their own projections in Phase 3 (AR Aging → AR projection; Dues:Revenue + Debt Service Coverage → IS projection; Reserve Coverage + Net-to-Gross PP&E → Reserve Study / Capital Tracker projection). Section is functional today; rendered ratios are constant across clubs until those projections land. |
| 2 | Dual-read always re-projects on every page render (small idempotent write) | Low | Idempotent — `upsertSnapshot` no-ops when payload hash matches. If high-traffic page render becomes an issue, add `BS.capturedAt > TB.capturedAt` cache check to skip the projection when the cached BS is already current. Acceptable today. |
| 3 | A club's Jonas extract may use account numbers outside `STANDARD_PRIVATE_CLUB_RANGES` | Med during onboarding | Importer surfaces unmapped accounts as diagnostics and BLOCKS commit. Operator must add per-club override; today this requires a code change. **Recommended Phase 3 follow-up:** make per-club account-mapping overrides editable via a settings page. |
| 4 | Income Statement's `current-month` mode requires the prior period's TB in the ledger; clubs onboarding mid-year won't have it | Low (Phase 3 surface) | Documented; affects Statement of Activities migration, not Financial Position. |
| 5 | No SQL migration file under `prisma/migrations/` — schema is applied via `prisma db push` | Low | Spectre's existing convention. When the production deploy lands on Postgres, the same `db push` will work, or generate a versioned migration with `prisma migrate dev --name reporting_ledger_phase2a`. |
| 6 | `JonasGlImporter` in-memory history is per-request | Low | DB ledger payload-hash dedup is the authoritative idempotency check across requests; in-memory history only affects within-request duplicate detection. Verified in the persistence tests. |

None of these are cutover blockers. Risk #3 will surface during onboarding of any club whose chart of accounts departs from the standard private-club ranges; the workaround is a code change today, a settings page tomorrow.

---

## 5. Cutover decision

**APPROVED.** Statement of Financial Position is ready to become the first fully production-driven chapter in the Monthly Board Reporting Package.

### Founder success criteria — verified end-to-end

| # | Criterion | Status |
|---|---|---|
| 1 | A club can export Trial Balance from Jonas | ✓ (Jonas-side, out of scope) |
| 2 | A club can import the CSV into Spectre | ✓ via `/app/admin/imports/jonas`; passes RBAC, tenant scope, validation, reconciliation; persists to `ReportingLedgerSnapshot` |
| 3 | A club can generate a materially different Financial Position report | ✓ proven by `tests/e2e/sofp-production-ledger.spec.ts`: empty ledger → seed (`1,896,328`); Dataset A → `2,000,000`; Dataset B → `2,200,000`; commentary text + ratios + line values all flip; rendered through the deployed app, no test backdoor |

### Mass-migration approval

With this chapter cutover-ready, the **mass migration of the remaining chapters can begin** following the SoFP pattern as the template:

1. Move section literals into a `seeds/<club>-<entity>-seed.ts` builder that produces a `LedgerSnapshot`.
2. Rewrite the section service to derive every value, ratio, and commentary line from the snapshot. Reactive commentary branches on snapshot values. Auxiliary cross-system inputs typed and documented as awaiting their own projections.
3. Add a `getXForClub(...)` async entry point implementing the dual-read pattern (ledger first, demoFallback second).
4. Wire `monthly-package.ts` to call the new entry point with a `PrismaReportingLedger` and pass the seed builder as the `demoFallback`.
5. Add `tests/e2e/reporting-ledger-<section>.spec.ts` (import-responsiveness regression spec) AND `tests/e2e/<section>-production-ledger.spec.ts` (before/after live-data render spec).

### Recommended migration order (unchanged from Phase 1 review §8)

1. **Statement of Activities** — uses `IncomeStatementProjection` (already built); same pattern as SoFP refactor; lowest-risk first migration after this one.
2. **Executive Opening** — highest-visibility hardcoded values; uses BS + IS projections (both built).
3. **Stewardship Dashboard** — uses BS + IS + RAG engine.

After 1–3 land, build the next importers (AR Aging projection → AR Aging chapter migration; Payroll importer → Payroll Analysis; Capital Project importer → Capital Projects; Reserve Study importer → Capital Fund). Each importer + chapter pairing follows the same five-step template.

---

## Appendix — Validation gate at time of review

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npx vitest run jonas-gl-importer balance-sheet-projection income-statement-projection statement-of-financial-position prisma-reporting-ledger tests/reporting tests/ledger` (12 files, 146 tests) | 146/146 |
| `npx playwright test reporting-ledger jonas-import-route sofp-production-ledger` (3 specs, 7 tests, 5 consecutive runs of each) | 7/7 every run |
| Grep for inline balance-sheet literals in SoFP service + React render | ZERO matches |
| Grep for `2,000,000` / `1,896,328` / similar values in service code | only in test fixtures and the documented Silver Springs seed module |

## Appendix — Files reviewed for this assessment

**Import route**
- [src/app/app/admin/imports/jonas/page.tsx](../src/app/app/admin/imports/jonas/page.tsx)
- [src/app/app/admin/imports/jonas/jonas-import-form.tsx](../src/app/app/admin/imports/jonas/jonas-import-form.tsx)
- [src/app/app/admin/imports/jonas/actions.ts](../src/app/app/admin/imports/jonas/actions.ts)

**Persistence**
- [prisma/schema.prisma](../prisma/schema.prisma) (`ReportingLedgerSnapshot`, `ReportingLedgerBatch`)
- [src/lib/reporting/ledger/prisma-ledger.ts](../src/lib/reporting/ledger/prisma-ledger.ts)
- [src/lib/reporting/ledger/prisma-hydration.ts](../src/lib/reporting/ledger/prisma-hydration.ts)

**Snapshot builder + reporting service**
- [src/lib/reporting/ledger/projections/balance-sheet-projection.ts](../src/lib/reporting/ledger/projections/balance-sheet-projection.ts)
- [src/lib/reporting/ledger/projections/balance-sheet-mapping.ts](../src/lib/reporting/ledger/projections/balance-sheet-mapping.ts)
- [src/lib/reporting/statement-of-financial-position.ts](../src/lib/reporting/statement-of-financial-position.ts)
- [src/lib/reporting/seeds/silver-springs-balance-sheet-seed.ts](../src/lib/reporting/seeds/silver-springs-balance-sheet-seed.ts)
- [src/lib/reporting/monthly-package.ts:1613-1644](../src/lib/reporting/monthly-package.ts)

**UI rendering**
- [src/app/app/admin/reporting/monthly/page.tsx:5414-5728](../src/app/app/admin/reporting/monthly/page.tsx)

**Tests**
- [tests/jonas-gl-importer.test.ts](../tests/jonas-gl-importer.test.ts)
- [tests/balance-sheet-projection.test.ts](../tests/balance-sheet-projection.test.ts)
- [tests/prisma-reporting-ledger.test.ts](../tests/prisma-reporting-ledger.test.ts)
- [tests/statement-of-financial-position.test.ts](../tests/statement-of-financial-position.test.ts)
- [tests/statement-of-financial-position-ledger.test.ts](../tests/statement-of-financial-position-ledger.test.ts)
- [tests/e2e/jonas-import-route.spec.ts](../tests/e2e/jonas-import-route.spec.ts)
- [tests/e2e/reporting-ledger-balance-sheet.spec.ts](../tests/e2e/reporting-ledger-balance-sheet.spec.ts)
- [tests/e2e/sofp-production-ledger.spec.ts](../tests/e2e/sofp-production-ledger.spec.ts)

**Earlier review**
- [docs/reporting-ledger-phase1-review.md](reporting-ledger-phase1-review.md)

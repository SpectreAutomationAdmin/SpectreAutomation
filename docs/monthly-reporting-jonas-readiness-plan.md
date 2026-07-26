# Monthly Reporting Package — Jonas Readiness Implementation Plan (Phase 1)

**Status:** Planning artefact — **no functional code changes in this pass**
**Source:** [docs/monthly-reporting-data-lineage-audit.md](monthly-reporting-data-lineage-audit.md) §5 Phase 1
**Date:** 2026-06-22
**Purpose:** Convert the 9 Phase 1 audit items into an actionable, dependency-ordered implementation checklist a single engineer can execute against a real Silver Springs Jonas GL import without further investigation.

---

## 0. Background — what already works (do not touch)

The plan assumes these foundations and treats them as **DONE**:

| Foundation | Status | Source |
|---|---|---|
| Prisma `FiscalYear` model with `closingEquity` snapshot for closed years | ✓ in schema | `prisma/schema.prisma:L1693` |
| Prisma `FiscalPeriod` model with `closingNoi`, `closingRevenue`, `budgetNoi` Decimal snapshots | ✓ in schema | `prisma/schema.prisma:L1722` |
| Prisma `JournalEntry` + `JournalEntryLine` with `accountId` / `departmentId` / `costCenterId` | ✓ in schema | `prisma/schema.prisma:L1790` |
| Prisma `Account` + `AccountCategory` + `Department` + `Budget` + `BudgetLine` (with `monthlyAmounts` JSON) | ✓ in schema | `prisma/schema.prisma:L1610–L3340` |
| Prisma `CapitalAsset` + `AssetDepreciationEntry` + `AssetDisposal` | ✓ in schema | `prisma/schema.prisma:L3196` |
| Prisma `MemberAccount` reads (used by AR aging plumbing already in `monthly-package.ts:L1377`) | ✓ live | `accounts-receivable-aging.ts` |
| `getOperatingResults()` — `prisma.fiscalPeriod.findMany` for trailing 12 months + 12 prior-year | ✓ live | `operating-results.ts:L106` |
| `getEquityHistory()` — `prisma.fiscalYear.findMany` for closed FYs + live balance sheet for OPEN FY | ✓ live | `equity-history.ts:L141` |
| `buildOperatingCommentary()` / `buildEquityCommentary()` — fully reactive on numeric inputs | ✓ live | `operating-commentary.ts`, `equity-commentary.ts` |
| `buildReportingPeriod()` — single source of truth for every period label | ✓ live | `reporting-period.ts:L117` |
| `dataSource: "live" \| "demo"` annotation pattern on every section block | ✓ in place | `monthly-package.ts:L109` |

**These are the gold-standard examples.** Every Phase 1 service we add follows the same pattern: read prisma → return typed data with `dataSource: "live"`.

---

## 1. Phase 1 scope (the 9 items)

Audit ID maps to plan ID 1:1.

| Plan ID | Audit ID | Item | Type | Primary file |
|---|---|---|---|---|
| **P1-1** | 1.1 | Cover-page At-a-Glance KPIs (7 tiles) | new + replace | `monthly-package.ts` |
| **P1-2** | 1.2 | `SILVER_SPRINGS_OPERATING_INPUTS` → live GL reads (6 scorecard rows) | replace | `scorecard-metrics.ts` |
| **P1-3** | 1.3 | `SILVER_SPRINGS_CAPITAL_INPUTS` → live GL + balance-sheet reads (7 scorecard rows) | replace | `scorecard-metrics.ts` |
| **P1-4** | 1.4 | Statement of Activities Depreciation row → depreciation schedule | replace | `statement-of-activities.ts` |
| **P1-5** | 1.5 | Statement of Activities "On Plan" Capital Dues chip → variance branch | replace literal with logic | `statement-of-activities.ts` |
| **P1-6** | 1.6 | Capital Fund Reserve Adequacy: Deferred Capital Liability + Net-to-Gross PPE + YTD Contribution checkmark | replace + branch | `capital-fund-statement.ts` |
| **P1-7** | 1.7 | Statement of Financial Position (Balance Sheet) — entire service rewrite | replace | `statement-of-financial-position.ts` |
| **P1-8** | 1.8 | Period labels audit — confirm no hardcoded date strings remain | audit + spot-fix | every service |
| **P1-9** | 1.9 | Cover-page Executive Summary headline narrative | new generator | `monthly-package.ts` + new `executive-summary-commentary.ts` |

**Out of scope for Phase 1** (deferred to Phase 2/3 per the audit):
- AR aging refactor (Phase 2.1) — plumbing exists; lower board-visibility risk
- Operating Statistics live integration (Phase 2.2) — needs PMS/POS
- Departmental P&L Summary cards (Phase 2.3)
- Dues Subsidy donut allocation mapping (Phase 2.5)
- Capital Projects tracking (Phase 2.6)
- Payroll provider integration (Phase 2 / 3)
- Operational integrations: weather API, POS, inventory subledger

---

## 2. Dependency map

Phase 1 items are NOT independent. Three "input services" feed many of the other items. Build the inputs first; the items that consume them light up automatically.

### 2.1 Dependency graph

```
                ┌──────────────────────────────────────────────────────────┐
                │  Foundation (already done)                              │
                │  • getOperatingResults()  • getEquityHistory()          │
                │  • buildReportingPeriod()  • prisma.memberAccount       │
                └──────────────────────────────────────────────────────────┘
                           │            │              │
                           ▼            ▼              ▼
       ┌──────────────────────────┐   ┌──────────────────────────┐
       │ NEW INPUT SERVICES        │   │ EXISTING REACTIVE        │
       │ (build these first)       │   │ COMMENTARY GENERATORS    │
       │                           │   │                           │
       │ • getBalanceSheet()       │   │ • buildOperatingCommentary│
       │ • getGLAccountTotals()    │   │ • buildEquityCommentary  │
       │ • getDepreciationSchedule │   │ • buildCfoCommentary     │
       │ • getReserveCoverage()    │   │ • buildCapitalStressTest │
       │ • getWorkingCapital()     │   │ • buildStewardshipNotes  │
       │ • getCapitalIncomeYTD()   │   │ (these auto-correct once │
       └───────────┬───────────────┘   │  inputs are live)        │
                   │                   └──────────────────────────┘
                   ▼
       ┌──────────────────────────────────────────────────────────┐
       │ DOWNSTREAM CONSUMERS (light up once inputs above ship)   │
       │                                                            │
       │ P1-1  Cover-page 7 KPIs                                    │
       │ P1-2  Operating Scorecard 6 rows                           │
       │ P1-3  Capital Scorecard 7 rows                             │
       │ P1-4  SOA Depreciation row                                 │
       │ P1-5  SOA Capital Dues chip (only needs existing SOA data) │
       │ P1-6  Capital Fund Reserve Adequacy 3 items                │
       │ P1-7  Balance Sheet entire service                         │
       │ P1-9  Executive Summary headline                           │
       └──────────────────────────────────────────────────────────┘
```

### 2.2 Concrete dependency table

| Plan ID | Depends on data | Depends on services |
|---|---|---|
| P1-1 (Cover KPIs) | GL actuals (rev, NOI, capital), MemberAccount (AR), balance sheet | `getOperatingResults` ✓, `getEquityHistory` ✓, `getCapitalIncomeYTD` (new), `getReserveCoverage` (new), `getWorkingCapital` (new), AR aging refactor ✓-ish |
| P1-2 (Operating Scorecard) | GL actuals + budget + GL classes (dues, payroll, initiation, F&B, golf rounds, F&B covers) | `getGLAccountTotals(category)` (new) + `getOperatingResults` ✓ (already used for NOI/NOI%) |
| P1-3 (Capital Scorecard) | Balance sheet (equity, assets, reserve, PPE), debt schedule, capital income, depreciation | `getBalanceSheet` (new), `getDepreciationSchedule` (new), `getCapitalIncomeYTD` (new), `getEquityHistory` ✓ |
| P1-4 (SOA Depreciation row) | Depreciation schedule (CapitalAsset + AssetDepreciationEntry) | `getDepreciationSchedule` (new) |
| P1-5 (SOA Capital Dues chip) | No new data — already in SOA data | None — replace literal with branch logic |
| P1-6 (Capital Fund Adequacy) | Balance sheet, capital projects unfunded, depreciation | `getBalanceSheet` (new), Capital Projects unfunded (read seed for now — Phase 2.6 is real fix), `getDepreciationSchedule` (new) |
| P1-7 (Balance Sheet) | Every GL account, fund tags, AR/AP subledgers | `getBalanceSheet` (new — large) + reuses existing AR plumbing |
| P1-8 (Period labels audit) | `ReportingPeriod` ✓ | None — pure audit; spot-fix if anything found |
| P1-9 (Executive Summary headline) | All Phase 1 KPI values | New generator `buildExecutiveSummaryNarrative()` — depends on P1-1 output |

### 2.3 Critical insight: ONE service unlocks THREE Phase 1 items

`getBalanceSheet()` is the keystone. It unlocks:
- **P1-3** (Capital Scorecard — equity, assets, reserve, PPE all come from balance sheet)
- **P1-6** (Capital Fund Reserve Adequacy — same inputs)
- **P1-7** (Statement of Financial Position — IS the balance sheet)

Build `getBalanceSheet()` first. Three sections come online.

---

## 3. Service contracts to create / update

### 3.1 NEW services (Phase 1)

**`getBalanceSheet(clubId, asOf)` — `src/lib/reporting/balance-sheet.ts`** *(new file)*

```ts
export type BalanceSheetSnapshot = {
  asOf: Date;
  dataSource: ReportingDataSource;        // "live" | "demo"
  currentAssets: { accountId: string; label: string; amount: Decimal }[];
  ppeGross: Decimal;
  ppeAccumulatedDepreciation: Decimal;
  ppeNet: Decimal;
  capitalReserveFundBalance: Decimal;     // GL account tagged FUND=CAPITAL
  capitalProjectsFundBalance: Decimal;
  totalAssets: Decimal;
  currentLiabilities: { accountId: string; label: string; amount: Decimal }[];
  longTermDebt: Decimal;
  deferredInitiationFees: Decimal;
  totalLiabilities: Decimal;
  operatingFundBalance: Decimal;          // GL account tagged FUND=OPERATING
  capitalReserveBalance: Decimal;
  ytdNetIncome: Decimal;                  // computed (not stored) from SOA
  totalEquity: Decimal;
  // Reconciliation check (asserts totalAssets === totalLiabilities + totalEquity)
  isReconciled: boolean;
};
export async function getBalanceSheet(clubId: string, asOf?: Date): Promise<BalanceSheetSnapshot>;
```

Reads: `prisma.journalEntryLine` aggregated by `account.category` + `account.fundTag` as-of-date.

**`getGLAccountTotals(clubId, accountCategoryKey, asOf, fiscalYearId)` — `src/lib/reporting/gl-account-totals.ts`** *(new file)*

Generalised GL category roll-up used by P1-1, P1-2, P1-3. Returns YTD actual + YTD budget + prior YTD per account category (e.g. `OPERATING_DUES_REVENUE`, `PAYROLL_BENEFITS`, `INITIATION_FEES`, `FB_REVENUE`, `FB_COGS`).

```ts
export type GLCategoryTotals = {
  categoryKey: string;
  ytdActual: Decimal;
  ytdBudget: Decimal;       // from BudgetLine.monthlyAmounts sum-Jan-to-current-month
  ytdPriorYear: Decimal;    // sum from FiscalPeriod records of prior FY
  fullYearBudget: Decimal;  // BudgetLine.annualTotal
  dataSource: ReportingDataSource;
};
export async function getGLAccountTotals(clubId: string, categoryKey: string, asOf?: Date): Promise<GLCategoryTotals>;
```

**`getDepreciationSchedule(clubId, asOf, periodId?)` — `src/lib/reporting/depreciation-schedule.ts`** *(new file)*

```ts
export type DepreciationSnapshot = {
  ytdActual: Decimal;       // sum of AssetDepreciationEntry.amount YTD
  ytdBudget: Decimal;       // BudgetLine sum for depreciation account
  currentMonthActual: Decimal;
  currentMonthBudget: Decimal;
  dataSource: ReportingDataSource;
};
export async function getDepreciationSchedule(clubId: string, asOf?: Date): Promise<DepreciationSnapshot>;
```

Reads: `prisma.assetDepreciationEntry` + Budget line for depreciation GL account.

**`getReserveCoverage(clubId, asOf)` — `src/lib/reporting/reserve-coverage.ts`** *(new file)*

```ts
export type ReserveCoverageSnapshot = {
  reserveFundBalance: Decimal;          // from balance sheet
  totalAssetReplacementCost: Decimal;   // from Reserve Study config (still demo for now)
  coverageRatio: number;                 // 0..1
  threeYearTargetRatio: number;          // policy: 0.75
  meetsFloor: boolean;                   // ratio >= 0.60
  dataSource: ReportingDataSource;
};
```

Numerator goes LIVE in P1; denominator stays a configured policy value until Reserve Study integration.

**`getWorkingCapital(clubId, asOf)` — `src/lib/reporting/working-capital.ts`** *(new file)*

```ts
export type WorkingCapitalSnapshot = {
  currentAssets: Decimal;
  currentLiabilities: Decimal;
  workingCapital: Decimal;
  ratio: number;
  dataSource: ReportingDataSource;
};
```

Trivial once `getBalanceSheet()` exists.

**`getCapitalIncomeYTD(clubId, asOf)` — `src/lib/reporting/capital-income.ts`** *(new file)*

Sum of capital-dues + initiation-fees + investment-income + transfer-from-ops YTD vs budget. Used by P1-1 (cover Capital Income tile) and P1-3 (Capital Scorecard Total Capital Income vs Budget row).

**`buildExecutiveSummaryNarrative(inputs)` — `src/lib/reporting/executive-summary-commentary.ts`** *(new file)*

Mirrors `buildOperatingCommentary` / `buildEquityCommentary`. Inputs: ytdRevenue, ytdNoi, capitalIncomeYtd, reserveCoverageRatio, workingCapital, arCurrentPct. Branches on outcome (favorable/unfavorable/on plan) and produces the 1-paragraph executive headline.

**`formatExecutiveSummaryKpis(inputs)` — addition to `monthly-package.ts` or new `executive-summary-format.ts`**

Pure formatter that converts the 6 numeric inputs above into the 6 KPI cards rendered on the cover. AR Current % comes from the AR aging service (already live-plumbed; refactor it in P1-1 to actually compute the bucket pct).

### 3.2 UPDATED services (Phase 1)

| Service file | Update |
|---|---|
| `scorecard-metrics.ts` | `buildOperatingScorecardData()` reads from new `getGLAccountTotals()` instead of `SILVER_SPRINGS_OPERATING_INPUTS`. `buildCapitalScorecardData()` reads from new `getBalanceSheet()` + `getCapitalIncomeYTD()` + `getDepreciationSchedule()` instead of `SILVER_SPRINGS_CAPITAL_INPUTS`. Constants remain exported for tests / fallback / preview-mode but no longer the primary path. |
| `statement-of-activities.ts` | (a) **Depreciation row**: read from `getDepreciationSchedule()` instead of literal `-350_000` / `-1_050_000`. (b) **Capital Dues chip**: replace literal `{ label: "On Plan", tone: "neutral" }` at L532 with branch on `variancePct` — green if `|variancePct| < 5%`, gold if `|variancePct| ≤ 10%`, clay if outside. |
| `capital-fund-statement.ts` | (a) **Deferred Capital Liability**: read from Capital Projects unfunded items (use the seed sum for now, hooks ready for P2.6). (b) **Net-to-Gross PPE**: compute from `getBalanceSheet()`. (c) **Tones**: replace unconditional "risk" with branch — green if ratio ≥ 50 %, gold if 40–50 %, clay if < 40 %. (d) **YTD Contribution checkmark**: branch on variance, parallel to the Capital Dues chip change in P1-5. |
| `statement-of-financial-position.ts` | Entire rewrite. `buildSilverSpringsStatementOfFinancialPosition()` consumes `getBalanceSheet()` snapshot, formats into the existing `BalanceSheetRow[]` shape. 6 stewardship ratio bars compute from snapshot values. Balance Sheet Notes paragraphs are already template-reactive — they auto-correct. |
| `monthly-package.ts` | (a) Replace cover KPI literals (`L1620–L1670`) with calls to `formatExecutiveSummaryKpis()`. (b) Replace executive headline literal with `buildExecutiveSummaryNarrative()`. (c) Wire `getBalanceSheet`, `getReserveCoverage`, `getWorkingCapital`, `getCapitalIncomeYTD`, `getDepreciationSchedule` into the package builder. (d) Set `dataSource: "live"` on every block that's now sourced. |
| `accounts-receivable-aging.ts` *(partial — for AR Current % in P1-1)* | Compute `currentPct` from the already-fetched `prisma.memberAccount` data (used by cover KPI). Full AR aging refactor remains Phase 2.1; this is a minimal accommodation so the cover KPI can go live. |

### 3.3 Period labels (P1-8)

**No new contracts.** This is an audit pass over every service file looking for any string literal matching `\b(Jan|Feb|...|Dec)\b`, `\bQ[1-4]\s+20\d\d\b`, or `\b20\d\d\b` outside of (a) historical fixtures, (b) policy/config, or (c) test fixtures. Verified by a single grep, fixed inline if found.

---

## 4. Files likely affected

### 4.1 NEW files

- `src/lib/reporting/balance-sheet.ts`
- `src/lib/reporting/gl-account-totals.ts`
- `src/lib/reporting/depreciation-schedule.ts`
- `src/lib/reporting/reserve-coverage.ts`
- `src/lib/reporting/working-capital.ts`
- `src/lib/reporting/capital-income.ts`
- `src/lib/reporting/executive-summary-commentary.ts`
- `tests/balance-sheet.test.ts`
- `tests/gl-account-totals.test.ts`
- `tests/depreciation-schedule.test.ts`
- `tests/executive-summary-commentary.test.ts`
- `tests/e2e/jonas-import-responsiveness.spec.ts` *(end-to-end)*

### 4.2 UPDATED files

- `src/lib/reporting/monthly-package.ts` *(wire new services; replace cover literals)*
- `src/lib/reporting/scorecard-metrics.ts` *(swap `SILVER_SPRINGS_*_INPUTS` for live reads)*
- `src/lib/reporting/statement-of-activities.ts` *(depreciation row; capital dues chip)*
- `src/lib/reporting/capital-fund-statement.ts` *(reserve adequacy 3 items)*
- `src/lib/reporting/statement-of-financial-position.ts` *(entire body)*
- `src/lib/reporting/accounts-receivable-aging.ts` *(compute currentPct for cover)*
- `tests/monthly-reporting-package.test.ts` *(update assertions for live-mode outputs; add Jonas-import responsiveness tests)*
- `tests/reporting-period-golden-rule.test.ts` *(verify no new hardcoded period strings)*

### 4.3 LIKELY NOT touched (defensive callout)

- `src/components/reporting/*` — no chart primitive changes
- `src/app/app/admin/reporting/monthly/page.tsx` — should need **zero** changes (services own all data; React renders only)
- Equity card spec — locked; no font/geometry changes
- Chart governance docs — no rule changes
- Prisma schema — no migration needed; all needed models exist

---

## 5. Tests required

### 5.1 Unit / service tests

Each new service ships with a vitest spec proving:

| Test | Asserts |
|---|---|
| `tests/balance-sheet.test.ts` | (a) Reconciliation: `totalAssets === totalLiabilities + totalEquity` for a known seeded `clubId`. (b) Mutating a `JournalEntryLine` debit/credit changes the snapshot. (c) `dataSource: "live"` when journal entries exist; `"demo"` when none. |
| `tests/gl-account-totals.test.ts` | For a known `accountCategoryKey`: YTD actual sums to the journal lines for that category through `asOf`; YTD budget sums from `BudgetLine.monthlyAmounts`; YTD prior-year sums from prior FY periods. |
| `tests/depreciation-schedule.test.ts` | YTD depreciation sums `AssetDepreciationEntry.amount` through `asOf`; budget pulled from BudgetLine for the depreciation account. |
| `tests/executive-summary-commentary.test.ts` | Generator branches on input (favorable vs unfavorable NOI; healthy vs deficient reserve coverage); produces materially different prose for each branch; never returns a literal `$14.62M` style fixed string. |

### 5.2 Existing-test updates

| Test | Change |
|---|---|
| `tests/monthly-reporting-package.test.ts` | Existing assertions tied to demo seed values for items P1-1 through P1-7 need to be re-anchored to the live-data fixture. Add explicit "no cover-page literal in package output" assertion (grep `"$14.62M"`, `"$3.18M"`, etc. — should be absent). |
| `tests/reporting-period-golden-rule.test.ts` | Run as-is — should still pass. Add any newly-discovered forbidden strings to its `FORBIDDEN` list (the P1-8 audit may surface 1–2). |

### 5.3 End-to-end Jonas-import responsiveness spec

`tests/e2e/jonas-import-responsiveness.spec.ts` *(new)* — implements §7 of the audit document. Each test seeds a minimal Jonas-style fixture, asserts the corresponding card/chart/commentary updates:

- T1 — GL actual revenue/NOI changes flow through to Operating Results
- T2 — Budget changes flow through to Budget Goal tile + Capital Dues chip
- T3 — Prior-year FiscalPeriod changes flow through to Prior Year YTD tile + Equity overlay
- T4 — MemberAccount changes flow through to AR Current % tile
- T5 — Depreciation entries change SOA depreciation row + Capital Scorecard
- T7 — Forced favourable→unfavourable NOI flip changes CFO Commentary branch
- T8 — Cover-page seeded literals (`$14.62M`, `$3.18M`, `1.42x`, `78.4%`) are NOT present in rendered HTML after live data load

### 5.4 Quality gates

- `npm run typecheck` — clean
- `npm run scan:placeholders` — clean (the audit doc itself is allowlisted; no other placeholders should appear)
- Targeted vitest: `tests/balance-sheet.test.ts`, `tests/gl-account-totals.test.ts`, `tests/depreciation-schedule.test.ts`, `tests/monthly-reporting-package.test.ts`, `tests/reporting-period-golden-rule.test.ts`, `tests/reporting-chart-system.test.ts`, `tests/executive-summary-commentary.test.ts`
- Equity card guards (5 specs in `tests/e2e/equity-*.spec.ts`) — must continue to pass; the bumped axis-typography work already proved this is fragile
- Multi-viewport regression (`tests/e2e/chart-plot-utilization.spec.ts`, `tests/e2e/weather-pattern-evidence.spec.ts`) — must continue to pass

---

## 6. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Jonas chart-of-accounts mapping is wrong.** Every new service depends on `Account.category` being correctly tagged (e.g. `OPERATING_DUES_REVENUE`, `PAYROLL_BENEFITS`, `CAPITAL_RESERVE_FUND`). If the Jonas import mapping mis-classifies an account, every downstream KPI / chart / scorecard derived from it will be wrong. | Define a `chartOfAccountsMapping.json` config that the importer consults. Add a vitest spec that asserts every category referenced by reporting services has at least one account in the seed mapping for the Silver Springs club. Run import in DRY-RUN mode first; produce a mapping coverage report. |
| R2 | **Live-vs-demo seam is wide.** Services need to gracefully degrade when prisma returns nothing (e.g. brand-new club with no journal entries yet). Today the `dataSource: "demo"` tag handles this — but new services must continue the pattern. | Each new service follows the established convention: if prisma returns no rows, log `dataSource: "demo"` and fall back to a seeded constant. Vitest asserts both branches. Never throw — that breaks the package page. |
| R3 | **Reconciliation drift.** The Balance Sheet reconciliation invariant `totalAssets === totalLiabilities + totalEquity` is a fundamental accounting check. If a journal entry is unbalanced, this fails and surfaces an error. | `getBalanceSheet()` returns `isReconciled: boolean`. The Statement of Financial Position renders a visible red banner if `!isReconciled` (not a silent pass-through). Vitest asserts an unbalanced fixture trips the banner. |
| R4 | **Status-pill thresholds need policy agreement.** P1-5 (Capital Dues chip), P1-6 (PPE tone), P1-7 (Reserve Coverage tone) all branch on numeric thresholds (e.g. `variancePct < 5%`, PPE ratio ≥ 50 %). These are policy decisions, not implementation details. | Centralise thresholds in `src/lib/reporting/policy-thresholds.ts`. Get founder approval on the numbers before merging. Document each threshold's rationale inline. |
| R5 | **Cover-page Executive Summary headline is interpretive.** The narrative says "tracking favorably to plan" or similar — wrong tone after Jonas import would mislead board. | `buildExecutiveSummaryNarrative()` must branch on multiple inputs (NOI variance, reserve coverage, AR health) and produce a paragraph that reconciles to all of them. Test must cover at least 4 branches (all favourable, all unfavourable, mixed-good, mixed-bad). |
| R6 | **Equity card alignment regression.** Equity Card is locked (4 geometry numbers including `padLeft=44`). Several services we touch render adjacent to it. | Equity guards (5 specs) must remain green throughout. Do not touch `EditorialLineChart` (it still uses hardcoded `9px` font per the recent typography work, intentionally). |
| R7 | **Performance — adding 6 new prisma queries to every package load.** | Run the new services in parallel via `Promise.all`. Existing services already do this. Profile the package build time after wiring (target: < 1.5 s for cold load against seeded Silver Springs fixture). |
| R8 | **Test fixture data drift.** Vitest fixtures need fiscal periods, budget lines, depreciation entries seeded to match the assertions. Diverging fixtures = flaky tests. | Single shared fixture builder in `tests/_fixtures/silver-springs-live.ts`. All Phase 1 tests pull from it. Don't inline fixture data in individual specs. |
| R9 | **Cover-page KPI tile order / labels rely on `monthly-package.ts:L1620–L1670` shape.** React renders 6 / 7 cards based on this exact array shape. | Don't change the array shape. Replace literal values inline. Add typescript test that the cover-KPI array length matches the React grid's expected count (compile-time). |
| R10 | **Period labels — false positives.** Some hardcoded period strings are legitimate (e.g. historical comparisons, test fixtures, locked Equity card years). | The P1-8 audit produces a list; the founder reviews each finding; only true regressions are fixed. The forbidden-string spec already exists at `tests/reporting-period-golden-rule.test.ts` — extend its FORBIDDEN list, not its allowlist, when in doubt. |

---

## 7. Implementation order

**Strict left-to-right; do not start an item until all its dependencies are green.**

```
Step 1 ─ FOUNDATIONS                                  [3-5 days]
        │
        ├─ A. Build getBalanceSheet()                 ← unblocks P1-3, P1-6, P1-7
        │     + tests/balance-sheet.test.ts
        │
        ├─ B. Build getGLAccountTotals()              ← unblocks P1-1, P1-2
        │     + tests/gl-account-totals.test.ts
        │
        └─ C. Build getDepreciationSchedule()         ← unblocks P1-3, P1-4, P1-6
              + tests/depreciation-schedule.test.ts

Step 2 ─ NARROW INPUT SERVICES                        [1-2 days]
        │
        ├─ D. Build getReserveCoverage()              ← unblocks P1-1, P1-6
        ├─ E. Build getWorkingCapital()               ← unblocks P1-1
        └─ F. Build getCapitalIncomeYTD()             ← unblocks P1-1, P1-3

Step 3 ─ AR AGING MINIMAL ACCOMMODATION               [0.5 day]
        │
        └─ G. Compute currentPct from MemberAccount   ← unblocks P1-1
              (full AR refactor remains Phase 2.1)

Step 4 ─ POLICY THRESHOLDS                            [0.5 day]
        │
        └─ H. Create policy-thresholds.ts              ← unblocks P1-5, P1-6
              founder approval on threshold values

Step 5 ─ DOWNSTREAM CONSUMERS                         [3-5 days]
        │
        ├─ P1-4 Statement of Activities Depreciation row
        ├─ P1-5 Statement of Activities Capital Dues chip
        ├─ P1-6 Capital Fund Reserve Adequacy 3 items
        ├─ P1-7 Statement of Financial Position rewrite
        ├─ P1-2 Operating Scorecard rows
        ├─ P1-3 Capital Scorecard rows
        ├─ P1-9 buildExecutiveSummaryNarrative()
        └─ P1-1 formatExecutiveSummaryKpis() + cover wiring
                    │
                    └─ wire all into monthly-package.ts

Step 6 ─ AUDIT + RESPONSIVENESS                       [1-2 days]
        │
        ├─ P1-8 Period labels audit (grep + spot-fix)
        └─ Write tests/e2e/jonas-import-responsiveness.spec.ts
              (T1-T8 from audit §7)

Step 7 ─ FINAL VALIDATION                             [0.5 day]
        │
        ├─ npm run typecheck — clean
        ├─ npm run scan:placeholders — clean
        ├─ Full vitest suite — green
        ├─ Equity card guards (5 specs) — green
        ├─ Multi-viewport spec — green
        ├─ Manual Jonas-import smoke test on a copy of the Silver Springs
        │  Jonas extract, in DRY-RUN mode
        └─ Founder sign-off
```

**Critical-path note:** Step 1A (`getBalanceSheet()`) is the longest single deliverable. Three Phase 1 items unlock when it lands. Build it first, in isolation, with thorough tests.

**Parallelism opportunities (post-Step 1):**
- Step 2 services (D, E, F) can run in parallel — they're small and independent.
- Step 5 consumers can be split across multiple developers once Step 1+2 inputs are stable.

---

## 8. Definition of done — Phase 1

A single checklist. Every box must be true before declaring Phase 1 complete.

### 8.1 Code

- [ ] All 9 plan items (P1-1 through P1-9) merged.
- [ ] All 6 new service files live + each has a vitest spec.
- [ ] `monthly-package.ts` no longer contains any of these literals: `"$14.62M"`, `"$3.18M"`, `"$2.04M"`, `"1.42x"`, `"$4.71M"`, `"78.4%"`. (Grep clean.)
- [ ] `statement-of-activities.ts` has no `currentBudget: -350_000` or `ytdBudget: -1_050_000` literal in the depreciation row. (Grep clean.)
- [ ] `statement-of-activities.ts` Capital Dues chip is a branch expression, not a literal `{ label: "On Plan" }`.
- [ ] `capital-fund-statement.ts` Deferred Capital Liability, Net-to-Gross PPE, YTD Contribution checkmark all source from computed inputs + branch on policy thresholds.
- [ ] `statement-of-financial-position.ts` reads from `getBalanceSheet()`; no hardcoded `1_896_328` / `984_200` / etc. literals remain.
- [ ] `scorecard-metrics.ts` no longer uses `SILVER_SPRINGS_OPERATING_INPUTS` / `SILVER_SPRINGS_CAPITAL_INPUTS` as the primary path. Constants may remain for fallback / preview-mode.
- [ ] No new hardcoded period strings introduced. (`tests/reporting-period-golden-rule.test.ts` green.)

### 8.2 Gates

- [ ] `npm run typecheck` clean
- [ ] `npm run scan:placeholders` clean
- [ ] `npm run quality` clean (the broad gate)
- [ ] `tests/monthly-reporting-package.test.ts` — green (assertions updated where needed)
- [ ] `tests/balance-sheet.test.ts` — new, green
- [ ] `tests/gl-account-totals.test.ts` — new, green
- [ ] `tests/depreciation-schedule.test.ts` — new, green
- [ ] `tests/executive-summary-commentary.test.ts` — new, green
- [ ] `tests/reporting-period-golden-rule.test.ts` — green
- [ ] `tests/reporting-chart-system.test.ts` — green
- [ ] All 5 `tests/e2e/equity-*.spec.ts` — green
- [ ] `tests/e2e/chart-plot-utilization.spec.ts` — green
- [ ] `tests/e2e/weather-pattern-evidence.spec.ts` — green
- [ ] `tests/e2e/jonas-import-responsiveness.spec.ts` — new, green (all 8 tests from §7 of the audit pass)

### 8.3 Manual verification

- [ ] Open the Monthly Reporting Package at `/app/admin/reporting/monthly` against a fixture seeded with Silver Springs Jonas-style data.
- [ ] Cover-page 7 KPIs display **live** values (not the seeded `$14.62M` etc.).
- [ ] Executive Summary headline narrates the LIVE figures with the correct favourable/unfavourable tone.
- [ ] Stewardship Dashboard scorecards (16 rows) carry the correct green/amber/red tones for the live numbers.
- [ ] Statement of Financial Position reconciles (`isReconciled: true`); banner is absent.
- [ ] Capital Fund Reserve Adequacy carries appropriate tones (not unconditionally "risk").
- [ ] Statement of Activities Depreciation row matches the depreciation schedule.
- [ ] Capital Dues chip flips appropriately when budget is perturbed.
- [ ] No `dataSource: "demo"` tags remain on any Phase 1 block. (Open browser devtools / data inspector and verify.)

### 8.4 Documentation

- [ ] Update [docs/monthly-reporting-data-lineage-audit.md](monthly-reporting-data-lineage-audit.md) Phase 1 section: mark each item ✅ done with date.
- [ ] Update CLAUDE.md if any policy thresholds were added to `policy-thresholds.ts` (record the rationale).
- [ ] Capture before/after screenshots of the cover page at 1440 × 900 (multi-viewport rule still applies).

### 8.5 Founder sign-off

- [ ] Founder reviews the live cover page side-by-side with the previous demo cover page.
- [ ] Founder reviews the Capital Fund Reserve Adequacy card and confirms the new tone branching matches policy.
- [ ] Founder approves the policy thresholds in `policy-thresholds.ts`.
- [ ] Founder authorises Jonas import test against the live cover page (production data) once all the above is green.

---

## 9. Out of scope (deferred)

For clarity — do NOT attempt in Phase 1:

- AR Aging service full refactor — Phase 2.1
- Operating Statistics live integration — Phase 2.2 (depends on PMS / POS)
- Departmental P&L Summary cards — Phase 2.3 (needs GL department mapping)
- Dues Subsidy donut allocation — Phase 2.5 (needs Jonas chart-of-accounts mapped to 15 buckets)
- Capital Projects tracking — Phase 2.6 (needs new `CapitalProject` table)
- Payroll provider integration — Phase 2 or 3
- Weather, F&B Statistics, Inventory Analysis — Phase 3 (operational, not GL)

These remain as audit-tracked work for after the Jonas import baseline is established.

---

## Companion documents

- [docs/monthly-reporting-data-lineage-audit.md](monthly-reporting-data-lineage-audit.md) — source audit
- [CLAUDE.md](../CLAUDE.md) — `Financial Reporting Data Integrity — Mandatory`, `Reactive Commentary for Financial Reporting — Mandatory`, `Reporting Period Golden Rule — Mandatory`
- [docs/equity-value-over-time-card-spec.md](equity-value-over-time-card-spec.md) — locked card spec (do not regress)
- [docs/monthly-reporting-chart-governance.md](monthly-reporting-chart-governance.md) — chart governance (do not regress)
- `prisma/schema.prisma` — `FiscalYear`, `FiscalPeriod`, `JournalEntry`, `JournalEntryLine`, `Account`, `Department`, `Budget`, `CapitalAsset` (all in place; no migration needed)

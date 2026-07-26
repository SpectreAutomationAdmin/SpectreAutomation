# Reporting Ledger — Architecture

**Status:** Contracts only — no importers, no service migrations.
**Scope:** Define the boundary between source systems and reporting services.
**Companion code:**
- [src/lib/reporting/ledger/contracts.ts](../src/lib/reporting/ledger/contracts.ts) — 8 entity interfaces
- [src/lib/reporting/ledger/read-api.ts](../src/lib/reporting/ledger/read-api.ts) — read-side contract
- [src/lib/reporting/ledger/write-api.ts](../src/lib/reporting/ledger/write-api.ts) — write-side contract (for the future Import Layer)

---

## 1. Why this exists

The Monthly Board Reporting Package today reads from a mix of:
- Demo seed constants (`SILVER_SPRINGS_*`)
- The existing prisma schema (`FiscalPeriod`, `FiscalYear`, `MemberAccount`, etc.)
- Snapshot-style fields the closing engine writes (`closingNoi`, `closingEquity`)

Two problems with continuing this way:

1. **It binds reporting to whatever source system the club uses.** If a club runs Jonas today and migrates to the future Spectre Accounting system next year, the reporting services would need to be re-pointed at the new schema. Every chart, scorecard, and commentary block becomes a per-source maintenance burden.

2. **It can't aggregate across multiple sources.** Real club reporting reads from:
   - GL (Jonas / Spectre Accounting / Sage / QuickBooks Enterprise / etc.)
   - AR subledger (often the GL but sometimes a separate system)
   - Payroll (ADP / Workday / Gusto / Paychex / in-house)
   - POS (Lightspeed / Toast / for F&B + golf revenue + covers)
   - Capital project tracker (project accounting or spreadsheet)
   - Reserve study (PDF / spreadsheet input)
   - Tee sheet (Chronogolf / ForeUP / Tagmarshal)

Even one club can have 4–7 of these. Trying to make `getOperatingResults()` know about each is unsustainable.

**The Reporting Ledger is a normalized, immutable, source-agnostic record of what reporting reads.** Source systems push *into* it via the Import Layer; reporting services read *from* it via a single typed API.

---

## 2. The 5-layer stack

```
┌────────────────────────────────────────────────────────────────┐
│ 1. Source System(s)                                            │
│    Jonas GL · Jonas AR · ADP Payroll · Lightspeed POS ·        │
│    Future Spectre Accounting · Manual board worksheets         │
└────────────────────────────────────────────────────────────────┘
                              ↓ (source-specific extracts)
┌────────────────────────────────────────────────────────────────┐
│ 2. Import Layer  (per-source adapters — Phase 1 work)          │
│    JonasGlImporter   → emits: Trial Balance + Income Statement │
│                                + Balance Sheet snapshots       │
│    JonasArImporter   → emits: AR Aging snapshot                │
│    AdpPayrollImporter → emits: Payroll snapshot                │
│    LightspeedImporter → emits: POS-derived operational lines   │
│                                (future)                        │
│    BoardBudgetEntry  → emits: Budget snapshot                  │
└────────────────────────────────────────────────────────────────┘
                              ↓ (typed LedgerSnapshot objects)
┌────────────────────────────────────────────────────────────────┐
│ 3. Reporting Ledger  (the canonical record — this PR's scope)  │
│    Trial Balance / Income Statement / Balance Sheet / Budget / │
│    Prior Year / AR Aging / Payroll / Capital Project           │
│    snapshots — immutable, dated, provenance-tagged             │
└────────────────────────────────────────────────────────────────┘
                              ↓ (typed read API)
┌────────────────────────────────────────────────────────────────┐
│ 4. Reporting Services                                          │
│    getOperatingResults / getEquityHistory / getBalanceSheet /  │
│    getGLAccountTotals / getCapitalIncomeYTD /                  │
│    buildExecutiveSummary / buildOperatingScorecardData /       │
│    buildCapitalScorecardData / RAG rule engine                 │
└────────────────────────────────────────────────────────────────┘
                              ↓ (pre-formatted view models)
┌────────────────────────────────────────────────────────────────┐
│ 5. Monthly Board Reporting Package                             │
│    /app/admin/reporting/monthly                                │
└────────────────────────────────────────────────────────────────┘
```

### Layer responsibilities

| Layer | Owns | Does NOT own |
|---|---|---|
| **1. Source** | Whatever schema the source vendor ships | Anything Spectre-specific |
| **2. Import** | Translating source schema → ledger entities; idempotency; provenance tagging | Reporting math; status classification; commentary |
| **3. Ledger** | Immutable normalized snapshots; point-in-time queries; multi-source aggregation | Variance math; tone classification; period labels |
| **4. Services** | Variance math; tone classification; period labels; commentary generation | Knowing where data came from (Jonas vs Spectre — the ledger hides it) |
| **5. Package** | React rendering | Numeric computation; data fetching |

The **strict no-skip rule:** a reporting service NEVER reaches past the ledger to query a source-system schema directly. If a service needs data the ledger doesn't yet expose, the ledger contract is extended first.

---

## 3. The 8 normalized entities

Every snapshot carries the same metadata block (`LedgerSnapshotMetadata`) — `snapshotId`, `clubId`, `capturedAt`, `sourceSystem`, `importBatchId`, `dataSource`, `notes`. The entity-specific shape sits alongside.

| # | Entity | Captures | Cadence | Primary source |
|---|---|---|---|---|
| 1 | **Trial Balance Snapshot** | Per-account debit / credit / ending balance + the chart of accounts itself | Monthly (close) | GL (Jonas, Spectre Accounting) |
| 2 | **Income Statement Snapshot** | Per-account / per-department revenue + expense for a period | Monthly | GL |
| 3 | **Balance Sheet Snapshot** | Per-account asset / liability / equity balances as of a date; reconciliation flag | Monthly | GL |
| 4 | **Budget Snapshot** | Per-account / per-department budget; 12-month splits; approval status; version | Annual + revisions | Board / Finance Committee approval |
| 5 | **Prior Year Snapshot** | Comparative IS + BS for the prior fiscal year | Annual (rolls forward at FY close) | GL (closed FY snapshot) |
| 6 | **AR Aging Snapshot** | Per-member receivables × 4 buckets; totals | Monthly | AR subledger (often the GL) |
| 7 | **Payroll Snapshot** | Per-department wages / taxes / benefits / hours / headcount | Monthly | Payroll provider |
| 8 | **Capital Project Snapshot** | Per-project authorized / contracted / spent / projected final / status | Monthly | Capital project tracker / project accounting |

### Entity contracts at a glance

(Full interfaces in [contracts.ts](../src/lib/reporting/ledger/contracts.ts).)

```ts
// Shared by every entity
type LedgerSnapshotMetadata = {
  snapshotId: string;
  clubId: string;
  capturedAt: Date;
  sourceSystem: LedgerSourceSystem;     // "jonas-gl" | "spectre-accounting" | ...
  importBatchId: string | null;
  dataSource: MonthlyAccountingDataSource; // "accounting" | "operational" | "demo" | "derived"
  notes: string | null;
};

// 8 union members
type LedgerSnapshot =
  | TrialBalanceSnapshot
  | IncomeStatementSnapshot
  | BalanceSheetSnapshot
  | BudgetSnapshot
  | PriorYearSnapshot
  | ArAgingSnapshot
  | PayrollSnapshot
  | CapitalProjectSnapshot;
```

The `entityKind` field on each variant is the union discriminator — switch on it to narrow.

---

## 4. Boundary contracts (read + write)

### 4.1 The Reporting Ledger read API

A single typed interface every reporting service consumes:

```ts
interface ReportingLedger {
  // Point-in-time queries
  getTrialBalance(clubId, asOf): Promise<TrialBalanceSnapshot | null>;
  getBalanceSheet(clubId, asOf): Promise<BalanceSheetSnapshot | null>;
  getArAging(clubId, asOf): Promise<ArAgingSnapshot | null>;
  getCapitalProjects(clubId, asOf): Promise<CapitalProjectSnapshot | null>;

  // Period queries
  getIncomeStatement(clubId, periodStart, periodEnd): Promise<IncomeStatementSnapshot | null>;
  getPayroll(clubId, periodStart, periodEnd): Promise<PayrollSnapshot | null>;

  // Fiscal-year queries
  getBudget(clubId, fiscalYearLabel): Promise<BudgetSnapshot | null>;
  getPriorYear(clubId, fiscalYearLabel): Promise<PriorYearSnapshot | null>;

  // Trailing-history queries — for the 12-month chart series
  listIncomeStatements(clubId, opts): Promise<IncomeStatementSnapshot[]>;
  listBalanceSheets(clubId, opts): Promise<BalanceSheetSnapshot[]>;
}
```

A reporting service always returns `null` when a snapshot doesn't exist — never throws. The cover-page Executive Summary's `comparator: null` handling is the canonical fallback shape.

### 4.2 The Reporting Ledger write API (for the future Import Layer)

```ts
interface ReportingLedgerWriter {
  // Single-snapshot upsert. Snapshots are IMMUTABLE — re-importing
  // the same entity for the same date REPLACES the previous
  // snapshot (writes a new row with the same logical key + a fresh
  // capturedAt); the old row is preserved for audit.
  upsertSnapshot(s: LedgerSnapshot): Promise<{ snapshotId: string; replaced: boolean }>;

  // Atomic multi-entity batch — month-end close emits trial
  // balance + IS + BS together; if any one fails, none publish.
  beginImportBatch(opts): Promise<string /* batchId */>;
  commitImportBatch(batchId): Promise<void>;
  rollbackImportBatch(batchId): Promise<void>;
}
```

---

## 5. Provenance + data-source taxonomy

Each snapshot carries two provenance fields:

- **`sourceSystem`** — *who produced it*. A string discriminator: `"jonas-gl"`, `"jonas-ar"`, `"adp-payroll"`, `"spectre-accounting"`, `"manual-entry"`, `"demo-seed"`. Used for audit trails and to drive cut-over policies.

- **`dataSource`** — *how reliable it is*. The 4-value `MonthlyAccountingDataSource` taxonomy already in use across the reporting layer (`"accounting"` / `"operational"` / `"demo"` / `"derived"`). The Executive Summary block and scorecard rows already roll up to a legacy `"live" | "demo"` flag from this taxonomy.

When the Import Layer writes a snapshot from Jonas:
- `sourceSystem: "jonas-gl"` (or `"jonas-ar"` for AR aging, etc.)
- `dataSource: "accounting"` (or `"operational"` for AR-subledger snapshots)

When a demo seed factory writes a snapshot (today):
- `sourceSystem: "demo-seed"`
- `dataSource: "demo"`

Reporting services bubble the `dataSource` tag up to the UI provenance banner. The board never sees a tile claiming `"live"` when the ledger holds a `"demo"` snapshot — that contract is enforced end-to-end.

---

## 6. Import idempotency rules

1. **Identity:** the logical identity of a snapshot is `(clubId, entityKind, period-or-date-key)`. Re-importing the same logical snapshot produces a new physical row with the same logical key.

2. **No mutation:** once captured, the values in a snapshot row never change. The Import Layer never UPDATEs a row; it INSERTs a new one (or no-ops if the values are bit-identical).

3. **Replacement semantics:** when a re-import has different values from the prior snapshot, the writer returns `{ replaced: true }`. The previous snapshot stays in history; reads return the most recent.

4. **Batch atomicity:** snapshots written inside a batch (`beginImportBatch` → `commitImportBatch`) all become readable together or none of them do. Month-end close emits 4 snapshots (TB + IS + BS + AR aging) in one batch.

5. **Idempotent re-runs:** running the same import a second time is safe. If nothing changed, no new physical row is created; if values changed, a replacement row is written.

These rules give the Import Layer one job: translate source → ledger. The reporting layer can trust that every read returns a coherent, committed snapshot.

---

## 7. Read patterns

### 7.1 Point-in-time

> "What was the balance sheet on May 31, 2026?"

```ts
const bs = await ledger.getBalanceSheet(clubId, may31);
```

Returns the **most recent committed snapshot** with `asOf <= may31`. If no snapshot exists yet → `null` (service composes a fallback).

### 7.2 Period

> "What was YTD operating revenue through May 2026?"

```ts
const is = await ledger.getIncomeStatement(clubId, fyStart, may31);
```

Returns the snapshot whose `(periodStart, periodEnd)` matches the requested window. The Import Layer is responsible for producing one IS snapshot per close period (typically monthly).

### 7.3 Trailing history

> "Give me the trailing 12 income statements for the Operating Results chart."

```ts
const ribbon = await ledger.listIncomeStatements(clubId, { startDate: priorYearMay, endDate: may31 });
```

Returns 12 ordered snapshots — the data the existing `getOperatingResults` already feeds into the bar chart.

### 7.4 Fiscal year

> "Pull the FY2026 board-approved budget."

```ts
const budget = await ledger.getBudget(clubId, "FY2026");
```

Returns the latest committed budget version. If the budget was revised mid-year, `getBudget` returns the latest revised version; older versions remain in the ledger for audit.

---

## 8. Migration strategy

### 8.1 Today (this PR)

- The ledger contract exists. No implementation. No reporting service consumes it.
- Existing services continue to read demo seeds + prisma directly.
- This PR is **contracts only**.

### 8.2 Phase 1 (subsequent work, per the Jonas-readiness plan)

- Build a Jonas Import Layer (`JonasGlImporter` / `JonasArImporter`) that emits snapshots.
- Migrate **one** reporting service onto the ledger as a pilot — likely `getBalanceSheet()` (currently doesn't exist, would be net-new and read the new Balance Sheet snapshot).
- Run dual-read during the cut-over: the service reads BOTH the ledger AND the legacy source; logs differences for QA.
- Once parity is proven, retire the legacy read path on that one service.
- Repeat per service.

### 8.3 Future — Spectre Accounting cut-over

When the club moves from Jonas to a future Spectre-built accounting system:
1. Build a `SpectreAccountingImporter` that emits the same snapshots.
2. Switch the Import Layer's wiring for that club: source = Spectre Accounting instead of Jonas.
3. **Zero reporting-service or component changes.** The ledger looks the same; the package renders the same. Source-system change is an Import Layer concern.

This is the architectural payoff. Today: source-specific code threads through 30+ reporting files. Tomorrow: source-specific code lives in one adapter file.

---

## 9. What's NOT in this PR

| Out of scope | Why |
|---|---|
| Prisma schema for ledger storage | Storage backend choice (prisma table vs. blob store vs. external warehouse) is a separate decision once the contracts are stable. |
| Jonas import adapter | Importer is Phase 1 work — needs the Jonas extract format pinned first. |
| Spectre Accounting import adapter | Pending the Spectre Accounting system itself. |
| Migration of any existing reporting service | This PR is contracts only. No existing service touched. |
| Backfill of historical snapshots | Needed before the package can render history off the ledger, but mechanically separate. |
| AR / payroll / POS provider selection per club | Configuration concern at the Import Layer. |

---

## 10. Non-goals — explicit

The Reporting Ledger is **not**:

- **A general OLAP cube.** It captures the specific entities the Monthly Board Reporting Package needs. New report types may need new entities (added explicitly via this contract).
- **A data warehouse.** Snapshots are point-in-time records, not raw transactions. Drill-down from a snapshot back to source-system transactions is a future Import Layer responsibility (the `notes` field can carry a source-system batch reference).
- **A real-time stream.** The ledger is updated by deliberate import operations, not by continuous source-system writes. The Monthly Reporting Package's cadence is monthly close; the ledger's cadence matches.
- **A replacement for the existing reporting service contracts.** Services like `buildExecutiveSummary`, `buildOperatingScorecardData`, `buildCapitalScorecardData`, and the RAG rule engine continue to own variance math, tone classification, and narrative generation. The ledger only changes where their *inputs* come from.

---

## Companion documents

| Doc | Purpose |
|---|---|
| [docs/monthly-reporting-data-lineage-audit.md](monthly-reporting-data-lineage-audit.md) | The audit that identified the source-system coupling problem this architecture solves |
| [docs/monthly-reporting-jonas-readiness-plan.md](monthly-reporting-jonas-readiness-plan.md) | Phase 1 implementation plan — the Import Layer for the first source (Jonas) |
| [CLAUDE.md](../CLAUDE.md) `Financial Reporting Data Integrity — Mandatory` | The integrity rule the ledger architecture serves |

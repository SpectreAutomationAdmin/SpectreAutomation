# Reporting Ledger — Storage Architecture Decision

**Status:** Decision recorded. Reference implementation shipped (in-memory). Prisma adapter follows in Phase 1.
**Scope:** Where the Reporting Ledger snapshots physically live.
**Companion code:**
- [src/lib/reporting/ledger/in-memory-ledger.ts](../src/lib/reporting/ledger/in-memory-ledger.ts) — reference implementation
- [src/lib/reporting/ledger/payload-hash.ts](../src/lib/reporting/ledger/payload-hash.ts) — idempotency hash
- [tests/ledger-storage.test.ts](../tests/ledger-storage.test.ts) — behavior tests

---

## 1. Decision summary

**Recommended:** Hybrid storage — a small set of indexed prisma columns for query keys, plus a single JSON payload column holding the full typed snapshot.

**Backed by two prisma models** (sketched in §5):
1. `ReportingLedgerSnapshot` — one row per snapshot variant.
2. `ReportingLedgerBatch` — atomic import-batch lifecycle.

**Rejected:**
- Fully-normalized prisma tables (one table per entity) — too much schema churn.
- Pure JSON blob in a single column with no indexed keys — query performance suffers.
- External warehouse (Snowflake / BigQuery / Redshift) — over-engineered for monthly cadence.

**Reference implementation today:** An in-memory backend (`InMemoryReportingLedger`) that fully implements both the read + write interfaces. The Prisma adapter is a thin translation layer (constructor-injectable `PrismaClient`) that lands in Phase 1 along with the first importer.

---

## 2. The criteria

| Criterion | Why it matters |
|---|---|
| **CSV onboarding from Jonas** | Phase 1 work — needs a place to land trial balance + IS + BS + AR aging extracts. The importer should be able to write 4 snapshots in one atomic batch. |
| **Future Spectre Accounting integration** | The storage choice must NOT couple to Jonas — Spectre Accounting must be able to write the same shapes years from now without schema churn. |
| **Historical reporting periods** | Snapshots are immutable. Re-imports preserve history (audit). Reads at "May 31, 2026" return what was committed for that date, not what the live system says today. |
| **Multi-tenant club architecture** | One storage backend serves N clubs. Tenant isolation enforced at query time (clubId filter). |
| **Reporting performance** | Each Monthly Board Reporting Package render reads ~12 income statements + 1 balance sheet + 1 AR aging + 1 budget + 1 prior-year snapshot. Must be < 100ms per club. |
| **Auditability** | Every snapshot ever published is preserved. Replacements add new rows; old rows stay. Each row carries `sourceSystem`, `importBatchId`, `notes`, `capturedAt`. |

---

## 3. Option evaluation

### Option A — Fully-normalized Prisma tables (one table per entity)

```prisma
model ReportingTrialBalance       { id; clubId; asOf; ...; lines TBLines[] }
model ReportingTrialBalanceLine   { ... }
model ReportingIncomeStatement    { ... }
model ReportingIncomeStatementLine{ ... }
model ReportingBalanceSheet       { ... }
model ReportingBalanceSheetLine   { ... }
// ... × 8 entities, each with its own line table = ~16 tables
```

**Pros:**
- Strongest type coupling (Prisma's generated types match the entity)
- Indexes per column
- Foreign keys per line

**Cons:**
- 16+ tables to keep in sync with the contracts
- Every new field on an entity → migration
- Every new entity → 2 new tables + migration + generated client refresh
- Lots of join overhead per query (each `IncomeStatementSnapshot` is 1 row + N line rows)
- Difficult to evolve the contract incrementally (Prisma migrations are forward-only)

**Verdict: REJECTED.** Too much schema churn for the cadence and shape of evolution we expect.

### Option B — Pure JSON blob (one table, no indexed query keys)

```prisma
model ReportingSnapshot {
  id        String @id
  clubId    String
  payload   Json   // full LedgerSnapshot with metadata + entity-specific shape
}
```

**Pros:**
- Single table; one model
- Schema-flexible
- Trivial to add new entity kinds

**Cons:**
- Every query needs to scan + parse JSON to find matching snapshots
- Postgres JSON-path indexes help but are slower than column indexes
- No DB-level constraint enforcement on identity / period uniqueness
- Hard to debug ("which snapshots exist for May 2026?" requires payload scan)

**Verdict: REJECTED.** Performance + debuggability suffer.

### Option C — Hybrid (Prisma + JSON payload) ★ RECOMMENDED

```prisma
model ReportingLedgerSnapshot {
  id              String   @id
  clubId          String
  entityKind      String   // discriminator
  // Indexed query keys
  asOf            DateTime?
  periodStart     DateTime?
  periodEnd       DateTime?
  fiscalYearLabel String?
  budgetVersion   Int?
  // Provenance
  sourceSystem    String
  importBatchId   String?
  dataSource      String
  // The full typed payload
  payload         Json
  payloadHash     String   // deterministic; drives idempotency
  // Lifecycle
  batchState      String   // "pending" | "committed" | "rolled-back"
  capturedAt      DateTime @default(now())
  @@index([clubId, entityKind, asOf])
  @@index([clubId, entityKind, periodEnd])
  @@index([clubId, entityKind, fiscalYearLabel, budgetVersion])
}
```

**Pros:**
- Fast query keys via dedicated indexed columns (`clubId + entityKind + asOf / periodEnd / fiscalYearLabel`) — every read in the read API hits an index
- Schema-flexible payload — adding a field to a contract entity doesn't require a Prisma migration
- One model for all 8 entity variants (discriminated by `entityKind`)
- Adding a new entity = adding a new `entityKind` value, no schema change
- Multi-tenant by design (`clubId` is the lead index column on every query)
- Auditable: immutable rows + `capturedAt` + `payloadHash`
- Easy to debug: SQL queries inspect the indexed columns; payload is JSON
- Stable Prisma surface — the migration churn from Option A is gone

**Cons:**
- Small field duplication: query keys exist in both columns AND the payload (importer must keep them consistent — enforced by the storage adapter at write time)
- Schema validation at write time, not DB-level (the typed contracts cover this)

**Verdict: RECOMMENDED.**

### Option D — External warehouse (Snowflake / BigQuery / Redshift)

**Pros:**
- Best for analytical workloads
- Built for time-series + history
- Decouples reporting compute from operational DB

**Cons:**
- Operational overhead (separate auth, networking, billing)
- Latency higher than in-database reads
- Cost (per-query or per-compute pricing)
- Not designed for tens-of-millions of rows — overkill for monthly cadence × dozens of clubs
- Adds a new system to the Spectre operational footprint

**Verdict: REJECTED for now.** Revisit when:
- Multi-club data volume exceeds the operational DB's reasonable limits (likely > 100K clubs, far away)
- Analytical workload diverges from operational reporting (e.g. ML / forecasting / cross-club benchmarking)

The hybrid model can replay into a warehouse later without changes to the contracts.

---

## 4. Why hybrid wins on each criterion

| Criterion | How hybrid satisfies it |
|---|---|
| **CSV onboarding from Jonas** | Importer parses the CSV, produces 4 `LedgerSnapshot` values, calls `beginImportBatch` → 4× `upsertSnapshot` → `commitImportBatch`. The atomic batch matches the close-period mental model. |
| **Future Spectre Accounting integration** | Spectre Accounting writes the same `LedgerSnapshot` shape via the same `ReportingLedgerWriter` interface. The contract doesn't know which source produced the data; only `sourceSystem` differs. |
| **Historical reporting periods** | Each snapshot is one row, immutable, dated. Reads return the most recent committed snapshot at the requested asOf/period. Older rows remain in history. |
| **Multi-tenant club architecture** | `clubId` is the lead column in every index. Every read filters on it. No leakage possible at the storage layer. |
| **Reporting performance** | A package render is ~16 reads. Each read hits a `(clubId, entityKind, dateKey)` index → O(log N) per query. For a 12-month chart, one `listIncomeStatements` query returns 12 rows in one index scan. |
| **Auditability** | Rows are immutable (writer never UPDATEs). Replacement inserts a new row; old row stays. Every row carries `sourceSystem`, `importBatchId`, `capturedAt`, `notes`. `payloadHash` lets diffs flag exactly which fields changed across a replacement. |

---

## 5. Prisma schema (the migration that lands in Phase 1)

```prisma
// Append to prisma/schema.prisma during Phase 1 deployment.
//
// Storage backend for the Reporting Ledger. One row per snapshot
// variant (8 entity kinds discriminated by `entityKind`). One row
// per import batch.
//
// Multi-tenant: clubId is the lead index column on every read path.
// Auditable: rows are immutable; replacements add new rows; old rows
// stay. `payloadHash` is deterministic — identical re-imports no-op.

model ReportingLedgerSnapshot {
  id              String   @id @default(cuid())
  clubId          String
  club            Club     @relation(fields: [clubId], references: [id])

  // Discriminator + query keys
  entityKind      String   // "trial-balance" | "income-statement" | ...
  asOf            DateTime?
  periodStart     DateTime?
  periodEnd       DateTime?
  fiscalYearLabel String?
  budgetVersion   Int?

  // Provenance + audit
  sourceSystem    String
  importBatchId   String?
  importBatch     ReportingLedgerBatch? @relation(fields: [importBatchId], references: [id])
  dataSource      String
  notes           String?

  // The typed payload — full LedgerSnapshot serialised
  payload         Json
  payloadHash     String

  // Lifecycle — "pending" rows are NOT visible to reads.
  batchState      String   @default("committed")

  capturedAt      DateTime @default(now())
  createdAt       DateTime @default(now())

  @@index([clubId, entityKind, asOf])
  @@index([clubId, entityKind, periodEnd])
  @@index([clubId, entityKind, fiscalYearLabel, budgetVersion])
  @@index([importBatchId])
  @@index([clubId, batchState])
}

model ReportingLedgerBatch {
  id            String    @id @default(cuid())
  clubId        String
  club          Club      @relation(fields: [clubId], references: [id])
  sourceSystem  String
  state         String    @default("pending") // "pending" | "committed" | "rolled-back"
  notes         String?
  openedAt      DateTime  @default(now())
  closedAt      DateTime?
  snapshotCount Int       @default(0)

  snapshots     ReportingLedgerSnapshot[]

  @@index([clubId, state])
}
```

Plus the new relations on `Club`:

```prisma
model Club {
  // ... existing fields ...
  reportingLedgerSnapshots ReportingLedgerSnapshot[]
  reportingLedgerBatches   ReportingLedgerBatch[]
}
```

**Migration steps (Phase 1):**
1. Add the two models + Club relations.
2. `npx prisma migrate dev --name add-reporting-ledger-storage`.
3. Wire the `PrismaReportingLedger` adapter (mirrors the in-memory implementation).
4. Backfill is OPTIONAL — historical snapshots accrue forward; no need to replay the past.

---

## 6. Migration considerations

### 6.1 Per-club rollout

Multi-tenant by design — the schema doesn't require a per-club migration. Once the tables exist, ANY club can start writing snapshots. The first club is gated only on its Import Layer being ready.

### 6.2 Source-system cut-overs

Switching a club from Jonas to Spectre Accounting:
1. Verify the Spectre Accounting importer emits the same `LedgerSnapshot` shapes (typecheck enforces this).
2. Change the per-club Import Layer routing config: `sourceSystem: "jonas-gl"` → `sourceSystem: "spectre-accounting"`.
3. Run the new importer for the next close period.
4. Old Jonas-sourced snapshots stay in the ledger for audit; new snapshots are sourced from Spectre Accounting; the read API returns the most recent.

**Zero reporting-service changes. Zero React changes.**

### 6.3 Schema evolution within an entity

When a contract entity gains a field (e.g. `IncomeStatementSnapshot.depreciation` lands in the contract today):
- Existing snapshots written before the field existed have the field `undefined` in their payload — reads return them with the field missing.
- New snapshots written after the field exists have the value.
- Reporting services treat `undefined` as a no-data signal (the Executive Summary's `comparator: null` pattern).
- No prisma migration required.

When a contract entity gains a REQUIRED field — bump a `payloadVersion` in the metadata and write a one-off backfill if the older snapshots need to surface the new field. This has not yet happened; the contracts are designed to keep new fields optional.

### 6.4 Re-importing corrected files

Real workflow: the bookkeeper finds an error in the April close, re-runs the Jonas extract with the correction, and re-imports.

Workflow with the hybrid storage:
1. `beginImportBatch({ clubId, sourceSystem: "jonas-gl", notes: "April correction — payroll accrual fix" })`.
2. `upsertSnapshot()` for each of the 4 affected snapshots (TB / IS / BS / AR aging).
3. Each `upsertSnapshot` checks `payloadHash` against the most recent snapshot for the same logical identity:
   - Hash matches → no-op, returns `{ replaced: false }`.
   - Hash differs → inserts a new row with a new `snapshotId` and a fresh `capturedAt`; previous row stays in history; returns `{ replaced: true }`.
4. `commitImportBatch()` — the 4 new snapshots become readable atomically.
5. Reads now return the corrected values; auditors can reconstruct the prior committed state via `capturedAt` / `payloadHash` history.

### 6.5 Historical backfill

Optional. Today's reporting layer reads from demo seeds + the legacy `FiscalPeriod` / `FiscalYear` schema. As importers come online, snapshots accrue forward. If historical reporting needs to replay against older data, a one-off backfill job can read the legacy schema and synthesize snapshots tagged `sourceSystem: "spectre-accounting"` or `"manual-entry"`. Not blocking for Phase 1.

---

## 7. Performance considerations

### 7.1 Query patterns + index coverage

Every read in the [read API](../src/lib/reporting/ledger/read-api.ts) hits an indexed column:

| Method | Index used | Rows scanned |
|---|---|---|
| `getTrialBalance(clubId, asOf)` | `[clubId, entityKind, asOf]` | 1 |
| `getBalanceSheet(clubId, asOf)` | `[clubId, entityKind, asOf]` | 1 |
| `getArAging(clubId, asOf)` | `[clubId, entityKind, asOf]` | 1 |
| `getCapitalProjects(clubId, asOf)` | `[clubId, entityKind, asOf]` | 1 |
| `getIncomeStatement(clubId, periodStart, periodEnd)` | `[clubId, entityKind, periodEnd]` | 1 |
| `getPayroll(clubId, periodStart, periodEnd)` | `[clubId, entityKind, periodEnd]` | 1 |
| `getBudget(clubId, fyLabel)` | `[clubId, entityKind, fiscalYearLabel, budgetVersion]` | 1 |
| `getPriorYear(clubId, fyLabel)` | `[clubId, entityKind, fiscalYearLabel, budgetVersion]` | 1 |
| `listIncomeStatements(clubId, window)` | `[clubId, entityKind, periodEnd]` | 12 (trailing year) |
| `listBalanceSheets(clubId, window)` | `[clubId, entityKind, asOf]` | 12 |

Estimated render budget for the Monthly Reporting Package: **~16 indexed queries × < 5 ms each = < 100 ms / club**. Headroom for many clubs.

### 7.2 Row volume estimate

- 8 entities × 12 periods/yr × 5 years of history × 1 replacement-on-correction = ~480 rows / club / 5 yrs.
- 100 clubs × 480 rows = 48,000 rows.
- 1,000 clubs × 5 years = 480,000 rows.

Well within Postgres / SQLite single-table comfort range for many years.

### 7.3 Pending-state filtering

Every read filters `batchState = 'committed'` so in-flight pending writes aren't visible. Adding `batchState` to the indexes (`[clubId, batchState]`) lets the planner skip pending rows efficiently.

### 7.4 JSON payload size

Per-snapshot payload size estimates:
- Trial Balance: ~50 KB (chart of accounts + ~500 lines)
- Income Statement: ~10 KB (~100 lines)
- Balance Sheet: ~5 KB (~50 lines)
- Budget: ~30 KB (12-month splits × 500 accounts)
- AR Aging: ~50 KB (1000 members × 4 buckets)
- Payroll: ~5 KB (per-department detail)
- Capital Project: ~5 KB (per-project detail)

Average ~25 KB. Postgres handles JSON columns of this size without issue.

---

## 8. The reference implementation that ships today

[src/lib/reporting/ledger/in-memory-ledger.ts](../src/lib/reporting/ledger/in-memory-ledger.ts) — `InMemoryReportingLedger`.

Implements both `ReportingLedger` (read) and `ReportingLedgerWriter` (write). Backed by a `Map` keyed by snapshotId + an array index for query-key lookups. Has the same semantics the Prisma adapter will have:

- Immutability via insert-only semantics.
- Idempotency via `payloadHash`.
- Atomic batches with pending/committed/rolled-back lifecycle.
- Multi-tenant isolation via clubId filtering.

Used today by tests and by local development. The PrismaReportingLedger adapter (Phase 1) is a thin translation layer over the same interface — tests written against the in-memory backend will pass unchanged against the prisma backend.

---

## 9. Storage tests

[tests/ledger-storage.test.ts](../tests/ledger-storage.test.ts) — comprehensive behaviour suite against the in-memory backend:

- Insert / read round-trip per entity
- Idempotent re-imports (bit-identical → no-op)
- Replacement on value change (new row, old row preserved for audit)
- Most-recent-wins on reads
- Multi-tenant isolation (clubId filter)
- Point-in-time vs period vs fiscal-year queries
- Trailing-history ordering
- Batch lifecycle: pending → committed → readable
- Batch rollback discards pending rows
- Pending rows are NOT visible to reads
- Re-running the same importer twice is a no-op

When the prisma adapter lands, the same tests will be ported (or shared via a `LedgerContractTestSuite` factory) and run against a real test DB.

---

## 10. What's NOT in this decision

- **Prisma migration file.** The schema sketch in §5 is the blueprint; the actual `prisma migrate dev` step happens in Phase 1 when the first importer lands. Today we ship contracts + reference implementation + tests.
- **Backfill of historical data.** Optional. Decided independently per club when reporting against old periods is needed.
- **Per-club source-system routing.** Configuration concern handled at the Import Layer (a new `ClubProfile` field or a separate `ImportConfiguration` model).
- **CDC / external warehouse replication.** Future work. The hybrid model's append-only structure makes downstream replication straightforward when needed.

---

## Companion documents

| Doc | Purpose |
|---|---|
| [docs/reporting-ledger-architecture.md](reporting-ledger-architecture.md) | The 5-layer architecture this storage backs |
| [docs/monthly-reporting-jonas-readiness-plan.md](monthly-reporting-jonas-readiness-plan.md) | The Phase 1 plan whose first storage need this decision satisfies |
| [docs/monthly-reporting-data-lineage-audit.md](monthly-reporting-data-lineage-audit.md) | The audit that motivates the whole effort |

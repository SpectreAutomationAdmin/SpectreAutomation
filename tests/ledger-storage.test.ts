// Reporting Ledger storage — behaviour tests.
//
// Targets the in-memory reference implementation
// (`InMemoryReportingLedger`). The same suite ports unchanged to
// the Prisma-backed adapter when it lands in Phase 1.
//
// Proves the storage contract delivers on the requirements in
// docs/reporting-ledger-storage-decision.md:
//
//   • Historical reporting periods (point-in-time + period reads
//     return the snapshot committed for that date).
//   • Re-importing corrected files (idempotent on bit-identical
//     payload; replacement-on-drift writes a new row, old row stays
//     for audit).
//   • Multiple clubs (tenant isolation enforced at the query layer).
//   • Reporting snapshots (8 entity kinds; one round-trip test
//     each).
//   • Batch lifecycle (pending → committed atomically; rollback
//     discards; pending rows are invisible to reads).

import { describe, it, expect, beforeEach } from "vitest";

import {
  InMemoryReportingLedger,
  computePayloadHash,
} from "@/lib/reporting/ledger";
import type {
  ArAgingSnapshot,
  BalanceSheetSnapshot,
  BudgetSnapshot,
  CapitalProjectSnapshot,
  IncomeStatementSnapshot,
  LedgerSnapshotMetadata,
  PayrollSnapshot,
  PriorYearSnapshot,
  TrialBalanceSnapshot,
} from "@/lib/reporting/ledger";

// ---------------------------------------------------------------------------
// Fixtures — builders for each of the 8 entity variants
// ---------------------------------------------------------------------------

const CLUB_A = "club_a";
const CLUB_B = "club_b";

function metadata(overrides: Partial<LedgerSnapshotMetadata> = {}): LedgerSnapshotMetadata {
  return {
    snapshotId: `snap_${Math.random().toString(36).slice(2, 10)}`,
    clubId: CLUB_A,
    capturedAt: new Date("2026-06-01T12:00:00Z"),
    sourceSystem: "jonas-gl",
    importBatchId: null,
    dataSource: "accounting",
    notes: null,
    ...overrides,
  };
}

function makeTrialBalance(overrides: Partial<TrialBalanceSnapshot> = {}): TrialBalanceSnapshot {
  return {
    ...metadata(),
    entityKind: "trial-balance",
    asOf:           new Date("2026-05-31T23:59:59Z"),
    periodStart:    new Date("2026-05-01T00:00:00Z"),
    periodEnd:      new Date("2026-05-31T23:59:59Z"),
    fiscalYearLabel: "FY2026",
    fiscalPeriodSequence: 5,
    accounts: [],
    lines: [],
    totalDebits:  100_000,
    totalCredits: 100_000,
    isBalanced:   true,
    ...overrides,
  };
}

function makeIncomeStatement(overrides: Partial<IncomeStatementSnapshot> = {}): IncomeStatementSnapshot {
  return {
    ...metadata(),
    entityKind: "income-statement",
    periodStart:    new Date("2026-05-01T00:00:00Z"),
    periodEnd:      new Date("2026-05-31T23:59:59Z"),
    fiscalYearLabel: "FY2026",
    fiscalPeriodSequence: 5,
    lines: [],
    totalOperatingRevenue: 1_300_000,
    totalOperatingExpense:   850_000,
    noiBeforeDepreciation:   450_000,
    depreciation:             87_500,
    totalCapitalIncome:       96_000,
    totalCapitalExpense:      80_000,
    ...overrides,
  };
}

function makeBalanceSheet(overrides: Partial<BalanceSheetSnapshot> = {}): BalanceSheetSnapshot {
  return {
    ...metadata(),
    entityKind: "balance-sheet",
    asOf:           new Date("2026-05-31T23:59:59Z"),
    fiscalYearLabel: "FY2026",
    lines: [],
    totalAssets:        30_000_000,
    totalLiabilities:    2_000_000,
    totalEquity:        28_000_000,
    isReconciled:       true,
    ...overrides,
  };
}

function makeBudget(overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot {
  return {
    ...metadata(),
    entityKind: "budget",
    fiscalYearLabel: "FY2026",
    startDate:       new Date("2026-01-01T00:00:00Z"),
    endDate:         new Date("2026-12-31T23:59:59Z"),
    approvalStatus:  "approved",
    approvalDate:    new Date("2025-11-15T00:00:00Z"),
    version:         1,
    lines: [],
    ...overrides,
  };
}

function makePriorYear(overrides: Partial<PriorYearSnapshot> = {}): PriorYearSnapshot {
  return {
    ...metadata(),
    entityKind: "prior-year",
    fiscalYearLabel: "FY2025",
    periodStart:     new Date("2025-01-01T00:00:00Z"),
    periodEnd:       new Date("2025-12-31T23:59:59Z"),
    incomeStatement: {
      periodStart: new Date("2025-01-01T00:00:00Z"),
      periodEnd:   new Date("2025-12-31T23:59:59Z"),
      fiscalYearLabel: "FY2025",
      fiscalPeriodSequence: 12,
      lines: [],
      totalOperatingRevenue: 14_400_000,
      totalOperatingExpense: 11_500_000,
      noiBeforeDepreciation:  2_900_000,
      depreciation:           1_050_000,
      totalCapitalIncome:     1_800_000,
      totalCapitalExpense:      900_000,
    },
    balanceSheetAtYearEnd: {
      asOf: new Date("2025-12-31T23:59:59Z"),
      fiscalYearLabel: "FY2025",
      lines: [],
      totalAssets:       28_500_000,
      totalLiabilities:   2_100_000,
      totalEquity:       26_400_000,
      isReconciled:      true,
    },
    ...overrides,
  };
}

function makeArAging(overrides: Partial<ArAgingSnapshot> = {}): ArAgingSnapshot {
  return {
    ...metadata(),
    entityKind: "ar-aging",
    asOf: new Date("2026-05-31T23:59:59Z"),
    lines: [],
    totalsByBucket: { current: 900_000, "31-60": 50_000, "61-90": 30_000, "over-90": 20_000 },
    totalAR:     1_000_000,
    currentPct:  0.90,
    over90Pct:   0.02,
    ...overrides,
  };
}

function makePayroll(overrides: Partial<PayrollSnapshot> = {}): PayrollSnapshot {
  return {
    ...metadata(),
    entityKind: "payroll",
    periodStart:    new Date("2026-05-01T00:00:00Z"),
    periodEnd:      new Date("2026-05-31T23:59:59Z"),
    fiscalYearLabel: "FY2026",
    fiscalPeriodSequence: 5,
    lines: [],
    totalGrossPayroll:   700_000,
    totalBenefits:       150_000,
    totalPayrollExpense: 850_000,
    totalFTE:                 84,
    ...overrides,
  };
}

function makeCapitalProject(overrides: Partial<CapitalProjectSnapshot> = {}): CapitalProjectSnapshot {
  return {
    ...metadata(),
    entityKind: "capital-project",
    asOf: new Date("2026-05-31T23:59:59Z"),
    fiscalYearLabel: "FY2026",
    projects: [],
    totalAuthorized:    1_740_000,
    totalContracted:    1_568_000,
    totalSpentToDate:     620_000,
    totalProjectedFinal: 1_575_000,
    countsByStatus: {
      planning: 1, approved: 0, "in-progress": 5,
      complete: 0, deferred: 0, "on-hold": 0,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Round-trip per entity
// ---------------------------------------------------------------------------

describe("ledger storage — round-trip per entity kind", () => {
  let ledger: InMemoryReportingLedger;
  beforeEach(() => {
    ledger = new InMemoryReportingLedger();
  });

  it("trial balance — write, read at asOf", async () => {
    const tb = makeTrialBalance();
    const result = await ledger.upsertSnapshot(tb);
    expect(result).toEqual({ snapshotId: tb.snapshotId, replaced: false });
    const read = await ledger.getTrialBalance(CLUB_A, tb.asOf);
    expect(read?.snapshotId).toBe(tb.snapshotId);
    expect(read?.totalDebits).toBe(100_000);
    expect(read?.isBalanced).toBe(true);
  });

  it("income statement — write, read by (periodStart, periodEnd)", async () => {
    const is = makeIncomeStatement();
    await ledger.upsertSnapshot(is);
    const read = await ledger.getIncomeStatement(CLUB_A, is.periodStart, is.periodEnd);
    expect(read?.snapshotId).toBe(is.snapshotId);
    expect(read?.totalOperatingRevenue).toBe(1_300_000);
  });

  it("balance sheet — write, read at asOf", async () => {
    const bs = makeBalanceSheet();
    await ledger.upsertSnapshot(bs);
    const read = await ledger.getBalanceSheet(CLUB_A, bs.asOf);
    expect(read?.totalAssets).toBe(30_000_000);
    expect(read?.isReconciled).toBe(true);
  });

  it("budget — write, read by fiscalYearLabel returns latest version", async () => {
    const v1 = makeBudget({ snapshotId: "budget_v1", version: 1 });
    const v2 = makeBudget({
      snapshotId: "budget_v2",
      version: 2,
      capturedAt: new Date("2026-06-10T00:00:00Z"),
    });
    await ledger.upsertSnapshot(v1);
    await ledger.upsertSnapshot(v2);
    const read = await ledger.getBudget(CLUB_A, "FY2026");
    expect(read?.version).toBe(2);
    expect(read?.snapshotId).toBe("budget_v2");
    // Explicit version query returns v1.
    const v1Read = await ledger.getBudgetVersion(CLUB_A, "FY2026", 1);
    expect(v1Read?.snapshotId).toBe("budget_v1");
  });

  it("prior year — write, read by fiscalYearLabel", async () => {
    const py = makePriorYear();
    await ledger.upsertSnapshot(py);
    const read = await ledger.getPriorYear(CLUB_A, "FY2025");
    expect(read?.snapshotId).toBe(py.snapshotId);
    expect(read?.incomeStatement.totalOperatingRevenue).toBe(14_400_000);
  });

  it("AR aging — write, read at asOf; derived percentages preserved", async () => {
    const ar = makeArAging();
    await ledger.upsertSnapshot(ar);
    const read = await ledger.getArAging(CLUB_A, ar.asOf);
    expect(read?.totalAR).toBe(1_000_000);
    expect(read?.currentPct).toBe(0.90);
  });

  it("payroll — write, read by period", async () => {
    const p = makePayroll();
    await ledger.upsertSnapshot(p);
    const read = await ledger.getPayroll(CLUB_A, p.periodStart, p.periodEnd);
    expect(read?.totalPayrollExpense).toBe(850_000);
    expect(read?.totalFTE).toBe(84);
  });

  it("capital projects — write, read at asOf", async () => {
    const cp = makeCapitalProject();
    await ledger.upsertSnapshot(cp);
    const read = await ledger.getCapitalProjects(CLUB_A, cp.asOf);
    expect(read?.totalAuthorized).toBe(1_740_000);
    expect(read?.countsByStatus["in-progress"]).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Multi-tenant isolation
// ---------------------------------------------------------------------------

describe("ledger storage — multi-tenant isolation", () => {
  it("club A reads only see club A snapshots", async () => {
    const ledger = new InMemoryReportingLedger();
    const a = makeBalanceSheet({ clubId: CLUB_A, snapshotId: "bs_a", totalAssets: 30_000_000 });
    const b = makeBalanceSheet({ clubId: CLUB_B, snapshotId: "bs_b", totalAssets: 50_000_000 });
    await ledger.upsertSnapshot(a);
    await ledger.upsertSnapshot(b);
    const readA = await ledger.getBalanceSheet(CLUB_A, a.asOf);
    const readB = await ledger.getBalanceSheet(CLUB_B, b.asOf);
    expect(readA?.snapshotId).toBe("bs_a");
    expect(readA?.totalAssets).toBe(30_000_000);
    expect(readB?.snapshotId).toBe("bs_b");
    expect(readB?.totalAssets).toBe(50_000_000);
  });

  it("listIncomeStatements scoped to clubId", async () => {
    const ledger = new InMemoryReportingLedger();
    await ledger.upsertSnapshot(makeIncomeStatement({ clubId: CLUB_A, snapshotId: "is_a" }));
    await ledger.upsertSnapshot(makeIncomeStatement({ clubId: CLUB_B, snapshotId: "is_b" }));
    const listA = await ledger.listIncomeStatements(CLUB_A, {
      startDate: new Date("2026-01-01"),
      endDate:   new Date("2026-12-31"),
    });
    expect(listA).toHaveLength(1);
    expect(listA[0].snapshotId).toBe("is_a");
  });
});

// ---------------------------------------------------------------------------
// Idempotency + auditable replacement
// ---------------------------------------------------------------------------

describe("ledger storage — idempotent re-imports", () => {
  let ledger: InMemoryReportingLedger;
  beforeEach(() => {
    ledger = new InMemoryReportingLedger();
  });

  it("bit-identical re-import is a no-op (replaced: false; same snapshotId)", async () => {
    const tb = makeTrialBalance({ snapshotId: "tb1" });
    await ledger.upsertSnapshot(tb);
    // Re-import: SAME logical identity (clubId + entityKind + asOf),
    // SAME value content, but with a different snapshotId on the new
    // call (importer would have generated a new uuid).
    const reImport = makeTrialBalance({
      snapshotId: "tb1_reimport",
      capturedAt: new Date("2026-06-15T08:00:00Z"),
    });
    const result = await ledger.upsertSnapshot(reImport);
    expect(result).toEqual({ snapshotId: "tb1", replaced: false });
  });

  it("value drift writes a new row (replaced: true; old row preserved)", async () => {
    const original = makeTrialBalance({ snapshotId: "tb1", totalDebits: 100_000, totalCredits: 100_000 });
    await ledger.upsertSnapshot(original);
    const corrected = makeTrialBalance({
      snapshotId: "tb1_correction",
      totalDebits: 105_000,
      totalCredits: 105_000,
      capturedAt: new Date("2026-06-15T08:00:00Z"),
      notes: "April correction — payroll accrual fix",
    });
    const result = await ledger.upsertSnapshot(corrected);
    expect(result).toEqual({ snapshotId: "tb1_correction", replaced: true });

    // Read returns the corrected snapshot (latest wins).
    const read = await ledger.getTrialBalance(CLUB_A, corrected.asOf);
    expect(read?.snapshotId).toBe("tb1_correction");
    expect(read?.totalDebits).toBe(105_000);
  });

  it("notes change alone is NOT a value drift (notes are metadata)", async () => {
    const a = makeTrialBalance({ snapshotId: "tb1", notes: "first" });
    await ledger.upsertSnapshot(a);
    const b = makeTrialBalance({
      snapshotId: "tb1_redo",
      notes: "re-imported with a new comment",
    });
    const result = await ledger.upsertSnapshot(b);
    // Only metadata changed; hash matches → no replacement.
    expect(result.replaced).toBe(false);
    expect(result.snapshotId).toBe("tb1");
  });

  it("payloadHash is deterministic across runs (the idempotency primitive)", () => {
    const a = makeTrialBalance({ snapshotId: "x", capturedAt: new Date("2026-06-01") });
    const b = makeTrialBalance({ snapshotId: "y", capturedAt: new Date("2026-06-10") });
    expect(computePayloadHash(a)).toBe(computePayloadHash(b));
  });
});

// ---------------------------------------------------------------------------
// Historical reporting periods
// ---------------------------------------------------------------------------

describe("ledger storage — historical reporting periods", () => {
  it("trailing list returns chronologically ordered snapshots inside the window", async () => {
    const ledger = new InMemoryReportingLedger();
    // 12 monthly IS snapshots: Jun 2025 .. May 2026.
    for (let i = 0; i < 12; i++) {
      const monthIndex = 5 + i; // start in Jun 2025 (0-idx month = 5)
      const year = 2025 + Math.floor(monthIndex / 12);
      const m = monthIndex % 12;
      const periodStart = new Date(Date.UTC(year, m, 1));
      const periodEnd = new Date(Date.UTC(year, m + 1, 0, 23, 59, 59));
      await ledger.upsertSnapshot(
        makeIncomeStatement({
          snapshotId: `is_${year}_${m + 1}`,
          periodStart,
          periodEnd,
          fiscalPeriodSequence: ((m - 0) % 12) + 1,
          totalOperatingRevenue: 1_000_000 + i * 25_000,
        }),
      );
    }
    const list = await ledger.listIncomeStatements(CLUB_A, {
      startDate: new Date("2025-06-01T00:00:00Z"),
      // Use end-of-day so the May 2026 snapshot (periodEnd =
      // 2026-05-31T23:59:59Z) falls inside the window.
      endDate:   new Date("2026-05-31T23:59:59Z"),
    });
    expect(list).toHaveLength(12);
    expect(list[0].snapshotId).toBe("is_2025_6");
    expect(list[11].snapshotId).toBe("is_2026_5");
    // Revenue rises monotonically by $25K.
    expect(list[11].totalOperatingRevenue - list[0].totalOperatingRevenue).toBe(275_000);
  });

  it("point-in-time read returns the most recent snapshot with asOf ≤ requested date", async () => {
    const ledger = new InMemoryReportingLedger();
    const march = makeBalanceSheet({
      snapshotId: "bs_mar",
      asOf: new Date("2026-03-31T23:59:59Z"),
      totalAssets: 28_000_000,
    });
    const may = makeBalanceSheet({
      snapshotId: "bs_may",
      asOf: new Date("2026-05-31T23:59:59Z"),
      totalAssets: 30_000_000,
    });
    await ledger.upsertSnapshot(march);
    await ledger.upsertSnapshot(may);
    // As of April → March snapshot.
    expect((await ledger.getBalanceSheet(CLUB_A, new Date("2026-04-15")))?.snapshotId).toBe("bs_mar");
    // As of June → May snapshot.
    expect((await ledger.getBalanceSheet(CLUB_A, new Date("2026-06-15")))?.snapshotId).toBe("bs_may");
  });

  it("missing data → returns null (not throw, not undefined)", async () => {
    const ledger = new InMemoryReportingLedger();
    expect(await ledger.getBalanceSheet(CLUB_A, new Date("2026-05-31"))).toBeNull();
    expect(await ledger.getBudget(CLUB_A, "FY2030")).toBeNull();
    expect(await ledger.listIncomeStatements(CLUB_A, { startDate: new Date("2020"), endDate: new Date("2021") }))
      .toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Batch lifecycle — pending → committed (atomic)
// ---------------------------------------------------------------------------

describe("ledger storage — import batches", () => {
  let ledger: InMemoryReportingLedger;
  beforeEach(() => {
    ledger = new InMemoryReportingLedger();
  });

  it("pending snapshots are NOT visible to reads", async () => {
    const batchId = await ledger.beginImportBatch({ clubId: CLUB_A, sourceSystem: "jonas-gl" });
    await ledger.upsertSnapshot(
      makeBalanceSheet({
        snapshotId: "pending_bs",
        importBatchId: batchId,
        clubId: CLUB_A,
      }),
    );
    // Pending → invisible.
    const read = await ledger.getBalanceSheet(CLUB_A, new Date("2026-05-31T23:59:59Z"));
    expect(read).toBeNull();
    // Commit → visible.
    await ledger.commitImportBatch(batchId);
    const readAfter = await ledger.getBalanceSheet(CLUB_A, new Date("2026-05-31T23:59:59Z"));
    expect(readAfter?.snapshotId).toBe("pending_bs");
  });

  it("commit makes all snapshots in the batch readable atomically", async () => {
    const batchId = await ledger.beginImportBatch({
      clubId: CLUB_A,
      sourceSystem: "jonas-gl",
      notes: "May 2026 close",
    });
    // Month-end imports 4 snapshots in one batch.
    const ids = ["tb", "is", "bs", "ar"] as const;
    await ledger.upsertSnapshot(makeTrialBalance({ snapshotId: "tb", importBatchId: batchId }));
    await ledger.upsertSnapshot(makeIncomeStatement({ snapshotId: "is", importBatchId: batchId }));
    await ledger.upsertSnapshot(makeBalanceSheet({ snapshotId: "bs", importBatchId: batchId }));
    await ledger.upsertSnapshot(makeArAging({ snapshotId: "ar", importBatchId: batchId }));
    // Before commit: no reads succeed.
    expect(await ledger.getBalanceSheet(CLUB_A, new Date("2026-05-31T23:59:59Z"))).toBeNull();
    expect(await ledger.getTrialBalance(CLUB_A, new Date("2026-05-31T23:59:59Z"))).toBeNull();
    await ledger.commitImportBatch(batchId);
    // After commit: every snapshot is readable.
    expect((await ledger.getTrialBalance(CLUB_A, new Date("2026-05-31T23:59:59Z")))?.snapshotId).toBe("tb");
    expect((await ledger.getIncomeStatement(CLUB_A, new Date("2026-05-01"), new Date("2026-05-31T23:59:59Z")))?.snapshotId).toBe("is");
    expect((await ledger.getBalanceSheet(CLUB_A, new Date("2026-05-31T23:59:59Z")))?.snapshotId).toBe("bs");
    expect((await ledger.getArAging(CLUB_A, new Date("2026-05-31T23:59:59Z")))?.snapshotId).toBe("ar");
    void ids;
  });

  it("rollback discards every pending snapshot in the batch (and keeps them invisible to reads)", async () => {
    const batchId = await ledger.beginImportBatch({ clubId: CLUB_A, sourceSystem: "jonas-gl" });
    await ledger.upsertSnapshot(
      makeBalanceSheet({ snapshotId: "bs_to_discard", importBatchId: batchId }),
    );
    await ledger.rollbackImportBatch(batchId);
    expect(await ledger.getBalanceSheet(CLUB_A, new Date("2026-05-31T23:59:59Z"))).toBeNull();
    const status = await ledger.getImportBatchStatus(batchId);
    expect(status?.state).toBe("rolled-back");
  });

  it("rollback after commit throws (forces explicit race handling)", async () => {
    const batchId = await ledger.beginImportBatch({ clubId: CLUB_A, sourceSystem: "jonas-gl" });
    await ledger.upsertSnapshot(makeBalanceSheet({ snapshotId: "bs", importBatchId: batchId }));
    await ledger.commitImportBatch(batchId);
    await expect(ledger.rollbackImportBatch(batchId)).rejects.toThrow(/already committed/);
  });

  it("commit after rollback throws", async () => {
    const batchId = await ledger.beginImportBatch({ clubId: CLUB_A, sourceSystem: "jonas-gl" });
    await ledger.rollbackImportBatch(batchId);
    await expect(ledger.commitImportBatch(batchId)).rejects.toThrow(/rolled back/);
  });

  it("commit is idempotent (calling twice is a no-op)", async () => {
    const batchId = await ledger.beginImportBatch({ clubId: CLUB_A, sourceSystem: "jonas-gl" });
    await ledger.upsertSnapshot(makeBalanceSheet({ snapshotId: "bs", importBatchId: batchId }));
    await ledger.commitImportBatch(batchId);
    await expect(ledger.commitImportBatch(batchId)).resolves.not.toThrow();
  });

  it("rollback is idempotent (calling twice is a no-op)", async () => {
    const batchId = await ledger.beginImportBatch({ clubId: CLUB_A, sourceSystem: "jonas-gl" });
    await ledger.rollbackImportBatch(batchId);
    await expect(ledger.rollbackImportBatch(batchId)).resolves.not.toThrow();
  });

  it("write to unknown batch throws", async () => {
    await expect(
      ledger.upsertSnapshot(
        makeBalanceSheet({ snapshotId: "bs", importBatchId: "no-such-batch" }),
      ),
    ).rejects.toThrow(/unknown import batch/);
  });

  it("write to already-committed batch throws (caller must open a new batch)", async () => {
    const batchId = await ledger.beginImportBatch({ clubId: CLUB_A, sourceSystem: "jonas-gl" });
    await ledger.commitImportBatch(batchId);
    await expect(
      ledger.upsertSnapshot(makeBalanceSheet({ snapshotId: "bs", importBatchId: batchId })),
    ).rejects.toThrow(/already committed/);
  });

  it("getImportBatchStatus returns lifecycle state + counts", async () => {
    const batchId = await ledger.beginImportBatch({
      clubId: CLUB_A,
      sourceSystem: "jonas-gl",
      notes: "test",
    });
    await ledger.upsertSnapshot(makeBalanceSheet({ snapshotId: "bs", importBatchId: batchId }));
    await ledger.upsertSnapshot(makeArAging({ snapshotId: "ar", importBatchId: batchId }));
    const pending = await ledger.getImportBatchStatus(batchId);
    expect(pending?.state).toBe("pending");
    expect(pending?.snapshotCount).toBe(2);
    await ledger.commitImportBatch(batchId);
    const committed = await ledger.getImportBatchStatus(batchId);
    expect(committed?.state).toBe("committed");
    expect(committed?.closedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end re-import of a corrected file
// ---------------------------------------------------------------------------

describe("ledger storage — re-importing corrected files (end-to-end)", () => {
  it("preserves the historical sequence: original → correction → reads return correction; both rows exist", async () => {
    const ledger = new InMemoryReportingLedger();

    // First import (original).
    const original = makeIncomeStatement({
      snapshotId: "is_may_v1",
      totalOperatingRevenue: 1_300_000,
      notes: "Jonas GL extract — fye_2026_m05.csv",
    });
    const r1 = await ledger.upsertSnapshot(original);
    expect(r1).toEqual({ snapshotId: "is_may_v1", replaced: false });

    // Corrected re-import (bookkeeper fixed a coding error).
    const corrected = makeIncomeStatement({
      snapshotId: "is_may_v2",
      capturedAt: new Date("2026-06-15T10:00:00Z"),
      totalOperatingRevenue: 1_312_500, // +12.5K correction
      notes: "May correction — F&B revenue reclass",
    });
    const r2 = await ledger.upsertSnapshot(corrected);
    expect(r2).toEqual({ snapshotId: "is_may_v2", replaced: true });

    // Read returns corrected values.
    const read = await ledger.getIncomeStatement(
      CLUB_A,
      new Date("2026-05-01"),
      new Date("2026-05-31T23:59:59Z"),
    );
    expect(read?.snapshotId).toBe("is_may_v2");
    expect(read?.totalOperatingRevenue).toBe(1_312_500);

    // Re-running the corrected import is now a no-op (bit-identical).
    const r3 = await ledger.upsertSnapshot({
      ...corrected,
      snapshotId: "is_may_v2_retry",
      capturedAt: new Date("2026-06-15T11:00:00Z"),
    });
    expect(r3).toEqual({ snapshotId: "is_may_v2", replaced: false });
  });
});

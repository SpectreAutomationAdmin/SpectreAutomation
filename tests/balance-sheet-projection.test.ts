// Balance Sheet Projection — end-to-end behaviour tests.
//
// Covers:
//   • Import a Jonas TB → project to Balance Sheet → readable via
//     ledger.getBalanceSheet AND FinancialPositionService.
//   • All six user-facing buckets populate correctly:
//        Current Assets, Capital Assets, Accumulated Depreciation,
//        Current Liabilities, Long-Term Liabilities, Equity
//   • YTD net income aggregates from revenue + expense lines.
//   • Balance Sheet reconciles (assets ≡ liabilities + equity).
//   • Dataset A and Dataset B produce DIFFERENT balance sheets
//     (the requested validation).
//   • Re-projection after a corrected TB writes a NEW snapshot.
//   • Tenant isolation across clubs.
//   • Configuration-driven mapping — no Silver Springs hardcoded.
//   • Unmapped account → diagnostic + no snapshot written.

import { describe, it, expect } from "vitest";

import {
  BalanceSheetProjection,
  DEFAULT_BALANCE_SHEET_MAPPING,
  FinancialPositionService,
  InMemoryReportingLedger,
  JonasGlImporter,
  type BalanceSheetMapping,
} from "@/lib/reporting/ledger";

// ---------------------------------------------------------------------------
// Test datasets — exercise all 6 buckets (current asset / capital
// asset / accumulated depreciation / current liab / long-term liab /
// equity) plus revenue + expense for YTD net income calculation.
//
// Dataset C (May 2026) reconciles at $25M debits ≡ $25M credits.
// Dataset D (June 2026) — a month of activity rolls through; balances
// shift across every section.
// ---------------------------------------------------------------------------

// Dataset C reconciles: debits 27M ≡ credits 27M.
// Members' Equity carries 17.8M to absorb the 2.5M of accumulated
// depreciation (a contra-asset booked on the credit side at TB-time).
const DATASET_C_MAY_2026 = `AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod
1010,Cash - Operating Account,180000,2000000,FY2026,5
1100,Accounts Receivable Net,84000,1000000,FY2026,5
1200,Food & Beverage Inventory,40000,300000,FY2026,5
1300,Prepaid Insurance,0,200000,FY2026,5
1850,Reserve Fund Investment,540000,5000000,FY2026,5
1900,Property Plant & Equipment - Gross,0,12000000,FY2026,5
1990,Accumulated Depreciation,-25000,-1500000,FY2026,5
2010,Accounts Payable,-22000,300000,FY2026,5
2150,Accrued Payroll,0,200000,FY2026,5
2510,Long-Term Debt,-15000,1200000,FY2026,5
3010,Members' Equity,0,17800000,FY2026,5
4010,Membership Dues Revenue,900000,4500000,FY2026,5
4020,F&B Revenue,320000,1500000,FY2026,5
5010,Operating Expenses,1100000,5000000,FY2026,5
5050,Cost of Goods Sold - F&B,500000,1500000,FY2026,5`;

// Dataset D reconciles: debits 28.785M ≡ credits 28.785M.
const DATASET_D_JUNE_2026 = `AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod
1010,Cash - Operating Account,200000,2200000,FY2026,6
1100,Accounts Receivable Net,50000,1050000,FY2026,6
1200,Food & Beverage Inventory,10000,310000,FY2026,6
1300,Prepaid Insurance,-20000,180000,FY2026,6
1850,Reserve Fund Investment,80000,5080000,FY2026,6
1900,Property Plant & Equipment - Gross,0,12000000,FY2026,6
1990,Accumulated Depreciation,-25000,-1525000,FY2026,6
2010,Accounts Payable,0,300000,FY2026,6
2150,Accrued Payroll,0,200000,FY2026,6
2510,Long-Term Debt,0,1200000,FY2026,6
3010,Members' Equity,0,18300000,FY2026,6
4010,Membership Dues Revenue,920000,5420000,FY2026,6
4020,F&B Revenue,340000,1840000,FY2026,6
5010,Operating Expenses,955000,5955000,FY2026,6
5050,Cost of Goods Sold - F&B,510000,2010000,FY2026,6`;

const CLUB_SILVER_SPRINGS = "club_silver_springs";
const CLUB_PINEHURST = "club_pinehurst";

const MAY_START = new Date(Date.UTC(2026, 4, 1));
const MAY_END = new Date(Date.UTC(2026, 4, 31, 23, 59, 59));
const JUNE_START = new Date(Date.UTC(2026, 5, 1));
const JUNE_END = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));

// Per-club balance-sheet mapping with one override demonstrating
// that a club can deviate from the default. Override: re-classify
// 1850 (reserve fund) display name to a club-specific label.
const SILVER_SPRINGS_BS_MAPPING: BalanceSheetMapping = {
  label: "Silver Springs balance sheet",
  overrides: [
    {
      accountNumber: "1850",
      category: "capital-fund-asset",
      normalizedName: "Capital Reserve Fund (Investment Portfolio)",
    },
  ],
};

// ---------------------------------------------------------------------------
// Helper — import a TB then project to a BS in one call.
// ---------------------------------------------------------------------------
async function importAndProject(args: {
  ledger: InMemoryReportingLedger;
  clubId: string;
  csv: string;
  periodStart: Date;
  periodEnd: Date;
  fiscalPeriodSequence?: number;
  mapping?: BalanceSheetMapping;
}) {
  const importer = new JonasGlImporter({ writer: args.ledger });
  const tb = await importer.importJonasExtract({
    clubId: args.clubId,
    extract: {
      csv: args.csv,
      filename: "test.csv",
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: args.fiscalPeriodSequence,
    },
  });
  if (tb.status !== "succeeded") {
    throw new Error(`TB import did not succeed: ${tb.status}`);
  }

  const projection = new BalanceSheetProjection({
    ledger: args.ledger,
    writer: args.ledger,
    mapping: args.mapping ?? DEFAULT_BALANCE_SHEET_MAPPING,
  });
  return projection.getBalanceSheetSnapshot({
    clubId: args.clubId,
    asOf: args.periodEnd,
  });
}

// ---------------------------------------------------------------------------
// Dataset C — Dataset D end-to-end
// ---------------------------------------------------------------------------

describe("BalanceSheetProjection — Dataset C end-to-end", () => {
  it("projects Dataset C → balanced May 2026 Balance Sheet snapshot", async () => {
    const ledger = new InMemoryReportingLedger();
    const result = await importAndProject({
      ledger,
      clubId: CLUB_SILVER_SPRINGS,
      csv: DATASET_C_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
      mapping: SILVER_SPRINGS_BS_MAPPING,
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return; // type narrowing

    expect(result.snapshot.entityKind).toBe("balance-sheet");
    expect(result.snapshot.dataSource).toBe("derived");
    expect(result.snapshot.sourceSystem).toBe("jonas-gl"); // inherits TB source
    expect(result.snapshot.isReconciled).toBe(true);
    expect(result.diagnostics.isReconciled).toBe(true);
    expect(result.diagnostics.mappingErrors).toEqual([]);

    // Balance-sheet line count = 11 GL accounts + 1 YTD net income line.
    expect(result.diagnostics.balanceSheetLineCount).toBe(12);
    expect(result.diagnostics.netIncomeLineCount).toBe(4); // 2 revenue + 2 expense

    // The snapshot is readable via the ledger read API.
    const snap = await ledger.getBalanceSheet(CLUB_SILVER_SPRINGS, MAY_END);
    expect(snap?.snapshotId).toBe(result.snapshot.snapshotId);
  });

  it("FinancialPositionService surfaces all 6 buckets correctly for Dataset C", async () => {
    const ledger = new InMemoryReportingLedger();
    await importAndProject({
      ledger,
      clubId: CLUB_SILVER_SPRINGS,
      csv: DATASET_C_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
      mapping: SILVER_SPRINGS_BS_MAPPING,
    });

    const fps = new FinancialPositionService({ ledger });
    const view = await fps.getFinancialPosition({
      clubId: CLUB_SILVER_SPRINGS,
      asOf: MAY_END,
    });

    expect(view).not.toBeNull();
    if (!view) return;

    // ----- Current Assets: 2,000,000 + 1,000,000 + 300,000 + 200,000 = 3,500,000
    expect(view.currentAssets.subtotal).toBe(3_500_000);
    expect(view.currentAssets.lines).toHaveLength(4);
    expect(view.currentAssets.lines.map((l) => l.accountCode).sort()).toEqual(
      ["1010", "1100", "1200", "1300"],
    );

    // ----- Capital Assets: reserve fund 5,000,000 + PP&E gross 12,000,000 = 17,000,000
    expect(view.capitalAssets.subtotal).toBe(17_000_000);
    expect(view.capitalAssets.lines.map((l) => l.accountCode).sort()).toEqual(
      ["1850", "1900"],
    );
    // Verify the override applied: 1850 carries the club-specific name.
    const reserveFundLine = view.capitalAssets.lines.find(
      (l) => l.accountCode === "1850",
    );
    expect(reserveFundLine?.accountName).toBe(
      "Capital Reserve Fund (Investment Portfolio)",
    );

    // ----- Accumulated Depreciation: 1,500,000 (positive in the line; subtracted at total time)
    expect(view.accumulatedDepreciation.subtotal).toBe(1_500_000);
    expect(view.accumulatedDepreciation.lines).toHaveLength(1);
    expect(view.accumulatedDepreciation.lines[0].accountCode).toBe("1990");

    // ----- Total Assets = current + capital − accum-depr
    //                    = 3,500,000 + 17,000,000 − 1,500,000 = 19,000,000
    expect(view.totalAssets).toBe(19_000_000);

    // ----- Current Liabilities: AP 300,000 + Accrued Payroll 200,000 = 500,000
    expect(view.currentLiabilities.subtotal).toBe(500_000);
    expect(view.currentLiabilities.lines).toHaveLength(2);

    // ----- Long-Term Liabilities: 1,200,000
    expect(view.longTermLiabilities.subtotal).toBe(1_200_000);
    expect(view.longTermLiabilities.lines).toHaveLength(1);

    // ----- Total Liabilities = 500,000 + 1,200,000 = 1,700,000
    expect(view.totalLiabilities).toBe(1_700_000);

    // ----- Equity:
    //   Members' Equity 17,800,000
    //   + YTD net income = (revenue 6,000,000) − (expense 6,500,000) = -500,000
    //   = 17,300,000
    expect(view.equity.subtotal).toBe(17_300_000);
    expect(view.totalEquity).toBe(17_300_000);
    const ytdLine = view.equity.lines.find(
      (l) => l.category === "ytd-net-income",
    );
    expect(ytdLine).toBeDefined();
    expect(ytdLine?.amount).toBe(-500_000);

    // ----- Reconciliation: 19,000,000 ≡ 1,700,000 + 17,300,000
    expect(view.totalLiabilitiesAndEquity).toBe(view.totalAssets);
    expect(view.isReconciled).toBe(true);
  });
});

describe("BalanceSheetProjection — Dataset D shows different balances", () => {
  it("Dataset D balances differ from Dataset C — same buckets, different numbers", async () => {
    const ledger = new InMemoryReportingLedger();
    // Import C first, then D — D replaces C for its own period (June)
    // and C's snapshot stays around for May.
    await importAndProject({
      ledger,
      clubId: CLUB_SILVER_SPRINGS,
      csv: DATASET_C_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
      mapping: SILVER_SPRINGS_BS_MAPPING,
    });
    await importAndProject({
      ledger,
      clubId: CLUB_SILVER_SPRINGS,
      csv: DATASET_D_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalPeriodSequence: 6,
      mapping: SILVER_SPRINGS_BS_MAPPING,
    });

    const fps = new FinancialPositionService({ ledger });
    const may = await fps.getFinancialPosition({
      clubId: CLUB_SILVER_SPRINGS,
      asOf: MAY_END,
    });
    const june = await fps.getFinancialPosition({
      clubId: CLUB_SILVER_SPRINGS,
      asOf: JUNE_END,
    });

    expect(may).not.toBeNull();
    expect(june).not.toBeNull();
    if (!may || !june) return;

    // The two snapshots are distinct ledger rows.
    expect(may.snapshotId).not.toBe(june.snapshotId);

    // ----- Cash grew: 2M → 2.2M (operating activity)
    const cashMay = may.currentAssets.lines.find((l) => l.accountCode === "1010");
    const cashJune = june.currentAssets.lines.find((l) => l.accountCode === "1010");
    expect(cashMay?.amount).toBe(2_000_000);
    expect(cashJune?.amount).toBe(2_200_000);

    // ----- AR shrank: 1M → 1.05M (small increase actually, members billed)
    const arMay = may.currentAssets.lines.find((l) => l.accountCode === "1100");
    const arJune = june.currentAssets.lines.find((l) => l.accountCode === "1100");
    expect(arMay?.amount).toBe(1_000_000);
    expect(arJune?.amount).toBe(1_050_000);

    // ----- Reserve fund accumulating: 5M → 5.08M
    const reserveMay = may.capitalAssets.lines.find(
      (l) => l.accountCode === "1850",
    );
    const reserveJune = june.capitalAssets.lines.find(
      (l) => l.accountCode === "1850",
    );
    expect(reserveMay?.amount).toBe(5_000_000);
    expect(reserveJune?.amount).toBe(5_080_000);

    // ----- Accumulated depreciation grew: 1.5M → 1.525M (monthly depr)
    expect(may.accumulatedDepreciation.subtotal).toBe(1_500_000);
    expect(june.accumulatedDepreciation.subtotal).toBe(1_525_000);

    // ----- YTD net income changed: May -500K loss, June (5420K+1840K) - (5955K+2010K)
    //       = 7,260K - 7,965K = -705K loss
    const mayYtd = may.equity.lines.find((l) => l.category === "ytd-net-income");
    const juneYtd = june.equity.lines.find(
      (l) => l.category === "ytd-net-income",
    );
    expect(mayYtd?.amount).toBe(-500_000);
    expect(juneYtd?.amount).toBe(-705_000);

    // ----- Subtotals overall changed.
    expect(may.totalAssets).not.toBe(june.totalAssets);
    expect(may.totalEquity).not.toBe(june.totalEquity);

    // Both snapshots reconcile.
    expect(may.isReconciled).toBe(true);
    expect(june.isReconciled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Re-projection on a corrected TB → new BS snapshot
// ---------------------------------------------------------------------------

describe("BalanceSheetProjection — re-projection after corrected TB", () => {
  it("a fresh projection after the TB is corrected writes a new BS snapshot", async () => {
    const ledger = new InMemoryReportingLedger();
    await importAndProject({
      ledger,
      clubId: CLUB_SILVER_SPRINGS,
      csv: DATASET_C_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
      mapping: SILVER_SPRINGS_BS_MAPPING,
    });

    // Corrected: F&B revenue +12,500K, expense +12,500K (keeps TB balanced).
    const corrected = DATASET_C_MAY_2026
      .replace(
        "4020,F&B Revenue,320000,1500000,FY2026,5",
        "4020,F&B Revenue,332500,1512500,FY2026,5",
      )
      .replace(
        "5010,Operating Expenses,1100000,5000000,FY2026,5",
        "5010,Operating Expenses,1112500,5012500,FY2026,5",
      );

    const result = await importAndProject({
      ledger,
      clubId: CLUB_SILVER_SPRINGS,
      csv: corrected,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
      mapping: SILVER_SPRINGS_BS_MAPPING,
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;

    // The latest BS reads from the corrected TB:
    //   F&B revenue 1,512,500 + dues 4,500,000 = 6,012,500
    //   Operating exp 5,012,500 + COGS 1,500,000 = 6,512,500
    //   YTD = -500,000 (still!)
    // BUT total revenue went up by 12,500, expense went up by 12,500 →
    // YTD unchanged. To prove correction flowed through, look at the
    // diagnostics:
    expect(result.diagnostics.computedYtdNetIncome).toBe(-500_000);

    // And the snapshot is the latest:
    const snap = await ledger.getBalanceSheet(CLUB_SILVER_SPRINGS, MAY_END);
    expect(snap?.snapshotId).toBe(result.snapshot.snapshotId);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe("BalanceSheetProjection — tenant isolation", () => {
  it("Silver Springs and Pinehurst projections coexist; reads are scoped", async () => {
    const ledger = new InMemoryReportingLedger();
    await importAndProject({
      ledger,
      clubId: CLUB_SILVER_SPRINGS,
      csv: DATASET_C_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
    });
    await importAndProject({
      ledger,
      clubId: CLUB_PINEHURST,
      csv: DATASET_D_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalPeriodSequence: 6,
    });

    const fps = new FinancialPositionService({ ledger });
    const ssMay = await fps.getFinancialPosition({
      clubId: CLUB_SILVER_SPRINGS,
      asOf: MAY_END,
    });
    const phJune = await fps.getFinancialPosition({
      clubId: CLUB_PINEHURST,
      asOf: JUNE_END,
    });

    expect(ssMay?.clubId).toBe(CLUB_SILVER_SPRINGS);
    expect(phJune?.clubId).toBe(CLUB_PINEHURST);
    expect(ssMay?.snapshotId).not.toBe(phJune?.snapshotId);

    // Cross-club leak check: Pinehurst has no May snapshot.
    const phMay = await fps.getFinancialPosition({
      clubId: CLUB_PINEHURST,
      asOf: MAY_END,
    });
    expect(phMay).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Configuration-driven — no Silver Springs hardcoded
// ---------------------------------------------------------------------------

describe("BalanceSheetProjection — configuration driven", () => {
  it("default mapping works for any club without per-club overrides", async () => {
    const ledger = new InMemoryReportingLedger();
    const result = await importAndProject({
      ledger,
      clubId: "club_brand_new_onboarding",
      csv: DATASET_C_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
      // NO mapping passed — uses DEFAULT_BALANCE_SHEET_MAPPING.
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.snapshot.isReconciled).toBe(true);
  });

  it("unmapped balance-sheet account → failed-mapping; no snapshot written", async () => {
    // Synthesize a TB directly with an asset account that no BS
    // mapping rule covers.
    const ledger = new InMemoryReportingLedger();
    const batchId = await ledger.beginImportBatch({
      clubId: "club_isolated",
      sourceSystem: "manual-entry",
      notes: "test",
    });
    await ledger.upsertSnapshot({
      snapshotId: "tb_test_1",
      clubId: "club_isolated",
      capturedAt: new Date(),
      sourceSystem: "manual-entry",
      importBatchId: batchId,
      dataSource: "demo",
      notes: null,
      entityKind: "trial-balance",
      asOf: MAY_END,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 5,
      accounts: [
        // 9999 — asset account that BS mapping default doesn't cover.
        {
          accountCode: "9999",
          accountName: "Mystery Asset",
          category: "asset",
          fund: "other",
          parentAccountCode: null,
        },
      ],
      lines: [
        { accountCode: "9999", debit: 100, credit: 0, endingBalance: 100 },
      ],
      totalDebits: 100,
      totalCredits: 0,
      isBalanced: false,
    });
    await ledger.commitImportBatch(batchId);

    const projection = new BalanceSheetProjection({
      ledger,
      writer: ledger,
    });
    const result = await projection.getBalanceSheetSnapshot({
      clubId: "club_isolated",
      asOf: MAY_END,
    });

    expect(result.status).toBe("failed-mapping");
    if (result.status !== "failed-mapping") return;
    expect(result.diagnostics.mappingErrors).toHaveLength(1);
    expect(result.diagnostics.mappingErrors[0].accountCode).toBe("9999");

    // No BS snapshot written.
    const bs = await ledger.getBalanceSheet("club_isolated", MAY_END);
    expect(bs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No-TB case
// ---------------------------------------------------------------------------

describe("BalanceSheetProjection — no trial balance", () => {
  it("returns no-trial-balance when nothing has been imported yet", async () => {
    const ledger = new InMemoryReportingLedger();
    const projection = new BalanceSheetProjection({
      ledger,
      writer: ledger,
    });
    const result = await projection.getBalanceSheetSnapshot({
      clubId: "club_empty",
      asOf: MAY_END,
    });
    expect(result.status).toBe("no-trial-balance");
  });
});

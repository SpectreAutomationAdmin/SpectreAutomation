// Income Statement Projection — end-to-end behaviour tests.
//
// Covers:
//   • Jonas TB → IS projection (YTD mode): per-account amounts +
//     bucket roll-ups populate from snapshot.
//   • Current-month mode: needs two TBs (current + prior); the
//     projection subtracts YTDs to recover month activity.
//   • Dataset A and Dataset B produce DIFFERENT IS snapshots.
//   • All 7 user-facing buckets (revenue / departmental revenue /
//     payroll / operating expense / depreciation / capital income /
//     capital expense) accumulate via the mapping.
//   • NOI = revenue − expense reconciles to the pre-rolled totals.
//   • Tenant isolation.
//   • Mapping configuration driven — no Silver Springs literals.
//   • Variance helper: actual / budget / prior-year math.

import { describe, it, expect } from "vitest";

import {
  buildIncomeStatementView,
  buildVariance,
  DEFAULT_INCOME_STATEMENT_MAPPING,
  InMemoryReportingLedger,
  IncomeStatementProjection,
  JonasGlImporter,
  type IncomeStatementMapping,
} from "@/lib/reporting/ledger";

// ---------------------------------------------------------------------------
// Datasets — the same Jonas TB datasets used by the BS projection +
// SoFP refactor tests, so the IS projection consumes the SAME ledger
// shape downstream code already exercises.
// ---------------------------------------------------------------------------

const DATASET_A_MAY_2026 = `AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod
1010,Cash - Operating Account,180000,2000000,FY2026,5
1100,Accounts Receivable Net,84000,1000000,FY2026,5
1850,Reserve Fund Investment,540000,5000000,FY2026,5
1910,Property Plant & Equipment Net,-25000,8000000,FY2026,5
2010,Accounts Payable,-22000,300000,FY2026,5
2510,Long-Term Debt,-15000,1200000,FY2026,5
3010,Members' Equity,0,13500000,FY2026,5
4010,Membership Dues Revenue,900000,4500000,FY2026,5
4020,F&B Revenue,320000,1500000,FY2026,5
5010,Operating Expenses,1100000,5000000,FY2026,5`;

const DATASET_B_JUNE_2026 = `AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod
1010,Cash - Operating Account,200000,2200000,FY2026,6
1100,Accounts Receivable Net,50000,1050000,FY2026,6
1850,Reserve Fund Investment,80000,5080000,FY2026,6
1910,Property Plant & Equipment Net,-25000,7975000,FY2026,6
2010,Accounts Payable,0,300000,FY2026,6
2510,Long-Term Debt,0,1200000,FY2026,6
3010,Members' Equity,0,13500000,FY2026,6
4010,Membership Dues Revenue,920000,5420000,FY2026,6
4020,F&B Revenue,340000,1840000,FY2026,6
5010,Operating Expenses,955000,5955000,FY2026,6`;

// Richer dataset exercising payroll + depreciation + capital lines.
// Reconciles at $24.7M debits ≡ $24.7M credits.
const DATASET_RICH_MAY_2026 = `AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod
1010,Cash,200000,6000000,FY2026,5
1900,Property Plant & Equipment,0,15000000,FY2026,5
2010,Accounts Payable,0,500000,FY2026,5
3010,Members' Equity,0,16500000,FY2026,5
4010,Membership Dues,800000,4000000,FY2026,5
4110,Golf Green Fees,180000,900000,FY2026,5
4210,F&B Dining Sales,300000,1500000,FY2026,5
4310,Pro Shop Retail,60000,300000,FY2026,5
5010,Wages - Operations,400000,2000000,FY2026,5
5510,Payroll Taxes & Benefits,80000,400000,FY2026,5
6010,Utilities,40000,200000,FY2026,5
6510,Depreciation Expense,80000,400000,FY2026,5
6800,Insurance,40000,200000,FY2026,5
9010,Capital Contributions,200000,1000000,FY2026,5
9510,Capital Project Spend,100000,500000,FY2026,5`;

const CLUB_SS = "club_silver_springs";
const CLUB_PH = "club_pinehurst";

const MAY_START = new Date(Date.UTC(2026, 4, 1));
const MAY_END = new Date(Date.UTC(2026, 4, 31, 23, 59, 59));
const JUNE_START = new Date(Date.UTC(2026, 5, 1));
const JUNE_END = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));

// ---------------------------------------------------------------------------
// Helper — import a TB then project to an IS in one call.
// ---------------------------------------------------------------------------

async function importTb(args: {
  ledger: InMemoryReportingLedger;
  clubId: string;
  csv: string;
  periodStart: Date;
  periodEnd: Date;
  fiscalPeriodSequence: number;
}) {
  const importer = new JonasGlImporter({ writer: args.ledger });
  const tb = await importer.importJonasExtract({
    clubId: args.clubId,
    extract: {
      csv: args.csv,
      filename: "tb.csv",
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: args.fiscalPeriodSequence,
    },
  });
  if (tb.status !== "succeeded") {
    throw new Error(`TB import did not succeed: ${tb.status}`);
  }
  return tb;
}

// ---------------------------------------------------------------------------
// Dataset A + Dataset B end-to-end (YTD)
// ---------------------------------------------------------------------------

describe("IncomeStatementProjection — Dataset A vs Dataset B (YTD mode)", () => {
  it("projects Dataset A → balanced YTD IS snapshot for May 2026", async () => {
    const ledger = new InMemoryReportingLedger();
    await importTb({
      ledger,
      clubId: CLUB_SS,
      csv: DATASET_A_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
    });

    const projection = new IncomeStatementProjection({ ledger, writer: ledger });
    const result = await projection.getIncomeStatementSnapshot({
      clubId: CLUB_SS,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 5,
      mode: "ytd",
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;

    // Dataset A revenue: dues 4,500,000 + F&B 1,500,000 = 6,000,000.
    // Dataset A expense: operating expenses 5,000,000.
    expect(result.snapshot.totalOperatingRevenue).toBe(6_000_000);
    expect(result.snapshot.totalOperatingExpense).toBe(5_000_000);
    // NOI before depreciation = revenue − (payroll + opex)
    //                         = 6,000,000 − 5,000,000 = 1,000,000
    expect(result.snapshot.noiBeforeDepreciation).toBe(1_000_000);
    // No depreciation account in Dataset A.
    expect(result.snapshot.depreciation).toBe(0);

    // The snapshot is readable via the ledger.
    const snap = await ledger.getIncomeStatement(CLUB_SS, MAY_START, MAY_END);
    expect(snap?.snapshotId).toBe(result.snapshot.snapshotId);

    // Dataset A: 5010 is the only expense. Standard range
    // 5000-5499 maps it to "payroll" — verify via bucket totals.
    expect(result.diagnostics.bucketTotals.payroll).toBe(5_000_000);
    expect(result.diagnostics.bucketTotals.operatingExpense).toBe(0);
  });

  it("projects Dataset B → produces DIFFERENT IS values from Dataset A", async () => {
    const ledger = new InMemoryReportingLedger();
    await importTb({
      ledger,
      clubId: CLUB_SS,
      csv: DATASET_B_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalPeriodSequence: 6,
    });

    const projection = new IncomeStatementProjection({ ledger, writer: ledger });
    const result = await projection.getIncomeStatementSnapshot({
      clubId: CLUB_SS,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 6,
      mode: "ytd",
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;

    // Dataset B revenue: 5,420,000 + 1,840,000 = 7,260,000
    // Dataset B expense: 5,955,000
    expect(result.snapshot.totalOperatingRevenue).toBe(7_260_000);
    expect(result.snapshot.totalOperatingExpense).toBe(5_955_000);
    expect(result.snapshot.noiBeforeDepreciation).toBe(1_305_000);
  });

  it("REGRESSION: Dataset A IS and Dataset B IS have materially different totals", async () => {
    const ledger = new InMemoryReportingLedger();
    await importTb({
      ledger,
      clubId: CLUB_SS,
      csv: DATASET_A_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
    });
    const proj = new IncomeStatementProjection({ ledger, writer: ledger });
    const a = await proj.getIncomeStatementSnapshot({
      clubId: CLUB_SS,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 5,
      mode: "ytd",
    });

    // Same club, different period — import B's TB, project again.
    await importTb({
      ledger,
      clubId: CLUB_SS,
      csv: DATASET_B_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalPeriodSequence: 6,
    });
    const b = await proj.getIncomeStatementSnapshot({
      clubId: CLUB_SS,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 6,
      mode: "ytd",
    });

    expect(a.status).toBe("succeeded");
    expect(b.status).toBe("succeeded");
    if (a.status !== "succeeded" || b.status !== "succeeded") return;
    expect(a.snapshot.snapshotId).not.toBe(b.snapshot.snapshotId);
    expect(a.snapshot.totalOperatingRevenue).not.toBe(
      b.snapshot.totalOperatingRevenue,
    );
    expect(a.snapshot.noiBeforeDepreciation).not.toBe(
      b.snapshot.noiBeforeDepreciation,
    );
  });
});

// ---------------------------------------------------------------------------
// Current-month mode
// ---------------------------------------------------------------------------

describe("IncomeStatementProjection — current-month mode", () => {
  it("derives June month activity from June YTD minus May YTD", async () => {
    const ledger = new InMemoryReportingLedger();
    await importTb({
      ledger,
      clubId: CLUB_SS,
      csv: DATASET_A_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
    });
    await importTb({
      ledger,
      clubId: CLUB_SS,
      csv: DATASET_B_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalPeriodSequence: 6,
    });

    const projection = new IncomeStatementProjection({ ledger, writer: ledger });
    const result = await projection.getIncomeStatementSnapshot({
      clubId: CLUB_SS,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 6,
      mode: "current-month",
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;

    // June month revenue:
    //   dues:  5,420,000 − 4,500,000 = 920,000
    //   F&B:   1,840,000 − 1,500,000 = 340,000
    //   total: 1,260,000
    expect(result.snapshot.totalOperatingRevenue).toBe(1_260_000);
    // June month expense (5010 only in these datasets):
    //   5,955,000 − 5,000,000 = 955,000
    expect(result.snapshot.totalOperatingExpense).toBe(955_000);
    // NOI before depreciation = 1,260,000 − 955,000 = 305,000
    expect(result.snapshot.noiBeforeDepreciation).toBe(305_000);

    // Diagnostics expose the prior TB used.
    expect(result.diagnostics.priorTrialBalanceSnapshotId).not.toBeNull();
  });

  it("returns no-prior-trial-balance when only the current TB is present", async () => {
    const ledger = new InMemoryReportingLedger();
    await importTb({
      ledger,
      clubId: CLUB_SS,
      csv: DATASET_B_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalPeriodSequence: 6,
    });
    const projection = new IncomeStatementProjection({ ledger, writer: ledger });
    const result = await projection.getIncomeStatementSnapshot({
      clubId: CLUB_SS,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 6,
      mode: "current-month",
    });
    expect(result.status).toBe("no-prior-trial-balance");
  });
});

// ---------------------------------------------------------------------------
// All 7 buckets exercised via the richer dataset
// ---------------------------------------------------------------------------

describe("IncomeStatementProjection — all 7 user-facing buckets", () => {
  it("rich dataset populates revenue / departmental-revenue / payroll / operating-expense / depreciation / capital-income / capital-expense", async () => {
    const ledger = new InMemoryReportingLedger();
    await importTb({
      ledger,
      clubId: CLUB_SS,
      csv: DATASET_RICH_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
    });
    const projection = new IncomeStatementProjection({ ledger, writer: ledger });
    const result = await projection.getIncomeStatementSnapshot({
      clubId: CLUB_SS,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 5,
      mode: "ytd",
    });
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;

    const b = result.diagnostics.bucketTotals;
    // revenue 4010 = 4,000,000 (general membership dues)
    expect(b.revenue).toBe(4_000_000);
    // departmental-revenue: golf 900K + F&B 1,500K + retail 300K = 2,700K
    expect(b.departmentalRevenue).toBe(2_700_000);
    // payroll: 5010 (2,000K) + 5510 (400K) = 2,400K
    expect(b.payroll).toBe(2_400_000);
    // operating-expense: 6010 (200K) + 6800 (200K) = 400K
    expect(b.operatingExpense).toBe(400_000);
    // depreciation: 6510 = 400K
    expect(b.depreciation).toBe(400_000);
    // capital-income: 9010 = 1,000K
    expect(b.capitalIncome).toBe(1_000_000);
    // capital-expense: 9510 = 500K
    expect(b.capitalExpense).toBe(500_000);

    // Computed roll-ups.
    expect(b.totalOperatingRevenue).toBe(4_000_000 + 2_700_000);
    expect(b.totalOperatingExpense).toBe(2_400_000 + 400_000 + 400_000);
    expect(b.noiBeforeDepreciation).toBe(6_700_000 - (2_400_000 + 400_000));
    expect(b.noi).toBe(6_700_000 - 3_200_000);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe("IncomeStatementProjection — tenant isolation", () => {
  it("two clubs' IS projections coexist; reads are scoped", async () => {
    const ledger = new InMemoryReportingLedger();
    await importTb({
      ledger,
      clubId: CLUB_SS,
      csv: DATASET_A_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
    });
    await importTb({
      ledger,
      clubId: CLUB_PH,
      csv: DATASET_B_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalPeriodSequence: 6,
    });
    const projection = new IncomeStatementProjection({ ledger, writer: ledger });
    const ss = await projection.getIncomeStatementSnapshot({
      clubId: CLUB_SS,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 5,
      mode: "ytd",
    });
    const ph = await projection.getIncomeStatementSnapshot({
      clubId: CLUB_PH,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 6,
      mode: "ytd",
    });
    expect(ss.status).toBe("succeeded");
    expect(ph.status).toBe("succeeded");
    if (ss.status !== "succeeded" || ph.status !== "succeeded") return;
    expect(ss.snapshot.clubId).toBe(CLUB_SS);
    expect(ph.snapshot.clubId).toBe(CLUB_PH);
    expect(ss.snapshot.snapshotId).not.toBe(ph.snapshot.snapshotId);

    // Cross-club leak check: PH has no May IS snapshot.
    const phMay = await ledger.getIncomeStatement(CLUB_PH, MAY_START, MAY_END);
    expect(phMay).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Configuration-driven — no Silver Springs hardcoded
// ---------------------------------------------------------------------------

describe("IncomeStatementProjection — configuration driven", () => {
  it("default mapping works for any club without per-club overrides", async () => {
    const ledger = new InMemoryReportingLedger();
    await importTb({
      ledger,
      clubId: "club_brand_new",
      csv: DATASET_A_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
    });
    const projection = new IncomeStatementProjection({
      ledger,
      writer: ledger,
      mapping: DEFAULT_INCOME_STATEMENT_MAPPING,
    });
    const result = await projection.getIncomeStatementSnapshot({
      clubId: "club_brand_new",
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 5,
      mode: "ytd",
    });
    expect(result.status).toBe("succeeded");
  });

  it("unmapped revenue/expense account → failed-mapping; no snapshot written", async () => {
    const ledger = new InMemoryReportingLedger();
    // Synthesize a TB with a revenue account outside the default
    // ranges (3500 — equity range in the Jonas mapping, but here we
    // bypass Jonas to force a revenue-classified account that the IS
    // mapping doesn't cover).
    const batchId = await ledger.beginImportBatch({
      clubId: "club_isolated",
      sourceSystem: "manual-entry",
      notes: "test",
    });
    await ledger.upsertSnapshot({
      snapshotId: "tb_isolated_test",
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
        {
          accountCode: "3500",
          accountName: "Mystery Revenue",
          category: "revenue",
          fund: "operating",
          parentAccountCode: null,
        },
      ],
      lines: [
        { accountCode: "3500", debit: 0, credit: 100, endingBalance: 100 },
      ],
      totalDebits: 0,
      totalCredits: 100,
      isBalanced: false,
    });
    await ledger.commitImportBatch(batchId);

    // Restrict the IS mapping so 3500 has no rule (default ranges
    // start at 4000).
    const restricted: IncomeStatementMapping = {
      label: "restricted",
      overrides: [],
      ranges: [
        { rangeStart: 4000, rangeEnd: 4999, bucket: "revenue" },
        { rangeStart: 5000, rangeEnd: 8999, bucket: "operating-expense" },
      ],
    };
    const projection = new IncomeStatementProjection({
      ledger,
      writer: ledger,
      mapping: restricted,
    });
    const result = await projection.getIncomeStatementSnapshot({
      clubId: "club_isolated",
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 5,
      mode: "ytd",
    });
    expect(result.status).toBe("failed-mapping");
    if (result.status !== "failed-mapping") return;
    expect(result.diagnostics.mappingErrors).toHaveLength(1);
    expect(result.diagnostics.mappingErrors[0].accountCode).toBe("3500");
    // No IS snapshot written.
    const is = await ledger.getIncomeStatement("club_isolated", MAY_START, MAY_END);
    expect(is).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Variance helper math
// ---------------------------------------------------------------------------

describe("buildVariance — actual / budget / prior year + variance %", () => {
  it("computes variance + variance % when budget is present", () => {
    const v = buildVariance({ actual: 500_000, budget: 400_000, priorYear: 450_000 });
    expect(v.actual).toBe(500_000);
    expect(v.budget).toBe(400_000);
    expect(v.variance).toBe(100_000); // 500K - 400K
    expect(v.variancePct).toBe(0.25); // 100K / 400K
    expect(v.priorYear).toBe(450_000);
  });

  it("returns null variance when budget is null", () => {
    const v = buildVariance({ actual: 500_000, budget: null, priorYear: null });
    expect(v.variance).toBeNull();
    expect(v.variancePct).toBeNull();
  });

  it("returns null variancePct when budget is zero (avoids divide-by-zero)", () => {
    const v = buildVariance({ actual: 500_000, budget: 0, priorYear: null });
    expect(v.variance).toBe(500_000);
    expect(v.variancePct).toBeNull();
  });

  it("handles unfavorable variance (negative)", () => {
    const v = buildVariance({ actual: 300_000, budget: 400_000, priorYear: null });
    expect(v.variance).toBe(-100_000);
    expect(v.variancePct).toBe(-0.25);
  });
});

// ---------------------------------------------------------------------------
// IncomeStatementView — joined comparator across two snapshots
// ---------------------------------------------------------------------------

describe("buildIncomeStatementView — joined actual + YTD + variance", () => {
  it("composes a view from current-month + YTD snapshots; lines carry both perspectives", async () => {
    const ledger = new InMemoryReportingLedger();
    // Need two TBs to derive current-month.
    await importTb({
      ledger,
      clubId: CLUB_SS,
      csv: DATASET_A_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
    });
    await importTb({
      ledger,
      clubId: CLUB_SS,
      csv: DATASET_B_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalPeriodSequence: 6,
    });
    const projection = new IncomeStatementProjection({ ledger, writer: ledger });
    const cm = await projection.getIncomeStatementSnapshot({
      clubId: CLUB_SS,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 6,
      mode: "current-month",
    });
    const ytd = await projection.getIncomeStatementSnapshot({
      clubId: CLUB_SS,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 6,
      mode: "ytd",
    });
    expect(cm.status).toBe("succeeded");
    expect(ytd.status).toBe("succeeded");
    if (cm.status !== "succeeded" || ytd.status !== "succeeded") return;

    const view = buildIncomeStatementView({
      currentMonthActual: cm.snapshot,
      ytdActual: ytd.snapshot,
      budget: null,
      priorYear: null,
    });

    // Cross-period line for dues (4010): June month 920K vs YTD 5,420K.
    const duesLine = view.lines.find((l) => l.accountCode === "4010");
    expect(duesLine?.currentMonth.actual).toBe(920_000);
    expect(duesLine?.ytd.actual).toBe(5_420_000);
    // Without budget / prior-year, variance + priorYear are null.
    expect(duesLine?.ytd.variance).toBeNull();
    expect(duesLine?.ytd.priorYear).toBeNull();

    // Roll-ups also carry both perspectives.
    expect(view.categoryRollups.totalOperatingRevenue.currentMonth.actual).toBe(
      1_260_000,
    );
    expect(view.categoryRollups.totalOperatingRevenue.ytd.actual).toBe(7_260_000);
    expect(view.categoryRollups.noi.currentMonth.actual).toBe(305_000);

    // Provenance.
    expect(view.sources.currentMonthActualSnapshotId).toBe(cm.snapshot.snapshotId);
    expect(view.sources.ytdActualSnapshotId).toBe(ytd.snapshot.snapshotId);
    expect(view.sources.budgetSnapshotId).toBeNull();
    expect(view.sources.priorYearSnapshotId).toBeNull();
  });

  it("throws when snapshots belong to different clubs (tenant safety)", async () => {
    const ledger = new InMemoryReportingLedger();
    await importTb({
      ledger,
      clubId: CLUB_SS,
      csv: DATASET_A_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalPeriodSequence: 5,
    });
    await importTb({
      ledger,
      clubId: CLUB_PH,
      csv: DATASET_B_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalPeriodSequence: 6,
    });
    const proj = new IncomeStatementProjection({ ledger, writer: ledger });
    const ss = await proj.getIncomeStatementSnapshot({
      clubId: CLUB_SS,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 5,
      mode: "ytd",
    });
    const ph = await proj.getIncomeStatementSnapshot({
      clubId: CLUB_PH,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      fiscalYearLabel: "FY2026",
      fiscalPeriodSequence: 6,
      mode: "ytd",
    });
    if (ss.status !== "succeeded" || ph.status !== "succeeded") {
      throw new Error("setup failed");
    }
    expect(() =>
      buildIncomeStatementView({
        currentMonthActual: ss.snapshot,
        ytdActual: ph.snapshot,
      }),
    ).toThrow(/clubId mismatch/);
  });
});

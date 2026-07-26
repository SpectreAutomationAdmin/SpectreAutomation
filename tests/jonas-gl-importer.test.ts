// Jonas GL importer — end-to-end behaviour tests.
//
// Covers:
//   • Dataset A + Dataset B both import successfully and produce
//     distinct Reporting Ledger snapshots.
//   • The trial balance reconciles (debits ≡ credits).
//   • Per-row VALUES flow through to the snapshot's lines.
//   • Re-importing the same dataset for the same period is detected
//     as a duplicate (no new snapshot).
//   • Corrected re-import writes a replacement snapshot (old one
//     preserved for audit via the ledger writer).
//   • Tenant isolation — Club A and Club B coexist; reads are
//     scoped.
//   • CSV validation — missing headers / bad numerics / empty cells
//     surface as diagnostics + import is aborted.
//   • Account mapping — unknown account codes surface as mapping
//     errors + import is aborted.
//   • Trial-balance reconciliation failure aborts.
//   • Sample report output matches the documented format.

import { describe, it, expect } from "vitest";

import {
  InMemoryReportingLedger,
  JonasGlImporter,
  formatJonasImportReport,
  type JonasAccountMapping,
} from "@/lib/reporting/ledger";

// ---------------------------------------------------------------------------
// Two sample Jonas GL CSV extracts
// ---------------------------------------------------------------------------

/**
 * Dataset A — Silver Springs May 2026 close. 10 accounts spanning
 * assets / liabilities / equity / revenue / expenses, with YTD
 * balances that reconcile (debits ≡ credits):
 *
 *   Debits  = assets ($16M) + expenses ($5M) = $21M
 *   Credits = liabilities ($1.5M) + equity ($13.5M) + revenue ($6M) = $21M
 */
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

/**
 * Dataset B — Silver Springs June 2026 close. Same chart, different
 * balances (a month's activity flows through). Reconciles to $22.26M.
 */
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

const CLUB_SILVER_SPRINGS = "club_silver_springs";
const CLUB_PINEHURST = "club_pinehurst";

// May / June 2026 period bounds.
const MAY_START = new Date(Date.UTC(2026, 4, 1));
const MAY_END = new Date(Date.UTC(2026, 4, 31, 23, 59, 59));
const JUNE_START = new Date(Date.UTC(2026, 5, 1));
const JUNE_END = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));

// Per-club mapping with one override (account 1910 is contra-PP&E
// for many clubs — the standard range rule puts it in `asset` but
// the description says "Net" so it's the netted account, fine to
// stay as asset). Add an override to demonstrate the source-tag
// works.
const SILVER_SPRINGS_MAPPING: JonasAccountMapping = {
  label: "Silver Springs",
  overrides: [
    {
      accountNumber: "1850",
      category: "asset",
      fund: "reserve",
      normalizedName: "Reserve Fund Investment (Capital Reserve)",
    },
  ],
};

// ---------------------------------------------------------------------------
// Dataset A + B import successfully → two distinct snapshots
// ---------------------------------------------------------------------------

describe("JonasGlImporter — Dataset A + Dataset B end-to-end", () => {
  it("imports Dataset A — produces a balanced May 2026 trial-balance snapshot", async () => {
    const ledger = new InMemoryReportingLedger();
    const importer = new JonasGlImporter({
      writer: ledger,
      mapping: SILVER_SPRINGS_MAPPING,
    });

    const result = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv: DATASET_A_MAY_2026,
        filename: "silver_springs_fy2026_m05.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
        fiscalYearLabel: "FY2026",
        fiscalPeriodSequence: 5,
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.snapshotId).toBeTruthy();
    expect(result.diagnostics.rowCount).toBe(10);
    expect(result.diagnostics.mappingCoverage.unmapped).toBe(0);
    expect(result.diagnostics.mappingCoverage.fromOverride).toBe(1); // account 1850
    expect(result.diagnostics.reconciliation.isBalanced).toBe(true);

    // The snapshot is readable via the ledger read API.
    const snap = await ledger.getTrialBalance(CLUB_SILVER_SPRINGS, MAY_END);
    expect(snap).not.toBeNull();
    expect(snap?.fiscalYearLabel).toBe("FY2026");
    expect(snap?.fiscalPeriodSequence).toBe(5);
    expect(snap?.lines).toHaveLength(10);
    expect(snap?.accounts).toHaveLength(10);
    expect(snap?.isBalanced).toBe(true);
  });

  it("imports Dataset B — produces a separate balanced June 2026 trial-balance snapshot", async () => {
    const ledger = new InMemoryReportingLedger();
    const importer = new JonasGlImporter({
      writer: ledger,
      mapping: SILVER_SPRINGS_MAPPING,
    });

    // Import both A and B; both succeed; both readable; values differ.
    const a = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv: DATASET_A_MAY_2026,
        filename: "may.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
        fiscalYearLabel: "FY2026",
        fiscalPeriodSequence: 5,
      },
    });
    const b = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv: DATASET_B_JUNE_2026,
        filename: "june.csv",
        periodStart: JUNE_START,
        periodEnd: JUNE_END,
        fiscalYearLabel: "FY2026",
        fiscalPeriodSequence: 6,
      },
    });

    expect(a.status).toBe("succeeded");
    expect(b.status).toBe("succeeded");
    expect(a.snapshotId).not.toBe(b.snapshotId);

    const snapA = await ledger.getTrialBalance(CLUB_SILVER_SPRINGS, MAY_END);
    const snapB = await ledger.getTrialBalance(CLUB_SILVER_SPRINGS, JUNE_END);
    expect(snapA?.fiscalPeriodSequence).toBe(5);
    expect(snapB?.fiscalPeriodSequence).toBe(6);

    // The Membership Dues line value differs between the two
    // datasets — exactly what the trailing-12-month chart would
    // need to read.
    const linesA = snapA?.lines.find((l) => l.accountCode === "4010");
    const linesB = snapB?.lines.find((l) => l.accountCode === "4010");
    expect(linesA?.endingBalance).toBe(4_500_000);
    expect(linesB?.endingBalance).toBe(5_420_000);
  });

  it("re-importing Dataset A for the same period is a duplicate-no-op", async () => {
    const ledger = new InMemoryReportingLedger();
    const importer = new JonasGlImporter({
      writer: ledger,
      mapping: SILVER_SPRINGS_MAPPING,
    });

    const first = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv: DATASET_A_MAY_2026,
        filename: "may.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
      },
    });
    expect(first.status).toBe("succeeded");

    // Re-import the SAME csv for the SAME period.
    const second = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv: DATASET_A_MAY_2026,
        filename: "may_re_run.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
      },
    });
    expect(second.status).toBe("duplicate-no-op");
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.notes).toMatch(/already been imported/);

    // History records BOTH attempts (the audit trail).
    const history = importer.history.listForClub(CLUB_SILVER_SPRINGS);
    expect(history).toHaveLength(2);
    expect(history[0].status).toBe("duplicate-no-op");
    expect(history[1].status).toBe("succeeded");
  });

  it("re-importing a corrected file (different content) writes a replacement snapshot", async () => {
    const ledger = new InMemoryReportingLedger();
    const importer = new JonasGlImporter({
      writer: ledger,
      mapping: SILVER_SPRINGS_MAPPING,
    });

    await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv: DATASET_A_MAY_2026,
        filename: "may.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
      },
    });

    // Corrected file: F&B revenue increased by 12.5K (a coding fix).
    // Keep debits ≡ credits by raising operating expenses by the
    // same amount (revenue is a credit; expense is a debit — both
    // sides shift by 12.5K and balance is preserved).
    const correctedCsv = DATASET_A_MAY_2026
      .replace("4020,F&B Revenue,320000,1500000,FY2026,5", "4020,F&B Revenue,332500,1512500,FY2026,5")
      .replace("5010,Operating Expenses,1100000,5000000,FY2026,5", "5010,Operating Expenses,1112500,5012500,FY2026,5");

    const corrected = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv: correctedCsv,
        filename: "may_corrected.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
      },
    });
    expect(corrected.status).toBe("succeeded");
    expect(corrected.replacedCount).toBe(1);

    // The latest snapshot reflects the correction.
    const snap = await ledger.getTrialBalance(CLUB_SILVER_SPRINGS, MAY_END);
    const fbLine = snap?.lines.find((l) => l.accountCode === "4020");
    expect(fbLine?.endingBalance).toBe(1_512_500); // corrected YTD
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe("JonasGlImporter — tenant isolation", () => {
  it("imports for Club A and Club B coexist; reads are scoped", async () => {
    const ledger = new InMemoryReportingLedger();
    const importer = new JonasGlImporter({ writer: ledger });

    const ssResult = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv: DATASET_A_MAY_2026,
        filename: "ss_may.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
      },
    });
    const phResult = await importer.importJonasExtract({
      clubId: CLUB_PINEHURST,
      extract: {
        csv: DATASET_B_JUNE_2026,
        filename: "ph_june.csv",
        periodStart: JUNE_START,
        periodEnd: JUNE_END,
      },
    });

    expect(ssResult.status).toBe("succeeded");
    expect(phResult.status).toBe("succeeded");
    expect(ssResult.snapshotId).not.toBe(phResult.snapshotId);

    // Each club's read returns only its own snapshot.
    const ssMay = await ledger.getTrialBalance(CLUB_SILVER_SPRINGS, MAY_END);
    const phJune = await ledger.getTrialBalance(CLUB_PINEHURST, JUNE_END);
    expect(ssMay?.snapshotId).toBe(ssResult.snapshotId);
    expect(phJune?.snapshotId).toBe(phResult.snapshotId);

    // Tenant scoping — Pinehurst has no snapshot at or before May,
    // so the May-asOf query for Pinehurst returns null (would have
    // returned Silver Springs's snapshot if the clubId filter
    // leaked).
    expect(await ledger.getTrialBalance(CLUB_PINEHURST, MAY_END)).toBeNull();
    // Silver Springs has its May snapshot — and the June-asOf
    // query returns the SAME May snapshot (latest at-or-before
    // semantic), NOT Pinehurst's June snapshot. Confirms reads
    // never cross clubs.
    const ssAtJune = await ledger.getTrialBalance(CLUB_SILVER_SPRINGS, JUNE_END);
    expect(ssAtJune?.snapshotId).toBe(ssResult.snapshotId);
    expect(ssAtJune?.clubId).toBe(CLUB_SILVER_SPRINGS);

    // Import history is also scoped.
    expect(importer.history.listForClub(CLUB_SILVER_SPRINGS)).toHaveLength(1);
    expect(importer.history.listForClub(CLUB_PINEHURST)).toHaveLength(1);
  });

  it("re-importing the same CSV for a DIFFERENT club is NOT a duplicate", async () => {
    const ledger = new InMemoryReportingLedger();
    const importer = new JonasGlImporter({ writer: ledger });

    const ss = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv: DATASET_A_MAY_2026,
        filename: "may.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
      },
    });
    const ph = await importer.importJonasExtract({
      clubId: CLUB_PINEHURST,
      extract: {
        csv: DATASET_A_MAY_2026, // identical CSV...
        filename: "may.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
      },
    });

    // ...but different club → both succeed; no duplicate detection.
    expect(ss.status).toBe("succeeded");
    expect(ph.status).toBe("succeeded");
    expect(ss.snapshotId).not.toBe(ph.snapshotId);
  });
});

// ---------------------------------------------------------------------------
// CSV validation failures
// ---------------------------------------------------------------------------

describe("JonasGlImporter — CSV validation", () => {
  it("missing required columns → failed-validation; no snapshot written", async () => {
    const ledger = new InMemoryReportingLedger();
    const importer = new JonasGlImporter({ writer: ledger });

    const result = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv: "AccountNumber,AccountDescription\n1010,Cash",
        filename: "bad.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
      },
    });
    expect(result.status).toBe("failed-validation");
    expect(result.diagnostics.fileErrors[0].kind).toBe("missing-column");
    expect(result.diagnostics.fileErrors[0].message).toContain("periodbalance");
    expect(result.snapshotId).toBeNull();
    expect(await ledger.getTrialBalance(CLUB_SILVER_SPRINGS, MAY_END)).toBeNull();
  });

  it("malformed numeric in a row → failed-validation with line number", async () => {
    const ledger = new InMemoryReportingLedger();
    const importer = new JonasGlImporter({ writer: ledger });

    const csv = `AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod
1010,Cash,180000,1896000,FY2026,5
1100,AR,not-a-number,984000,FY2026,5`;

    const result = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv,
        filename: "malformed.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
      },
    });
    expect(result.status).toBe("failed-validation");
    expect(result.diagnostics.rowErrors).toHaveLength(1);
    expect(result.diagnostics.rowErrors[0].lineNumber).toBe(3);
    expect(result.diagnostics.rowErrors[0].column).toBe("periodbalance");
  });

  it("empty CSV → failed-validation with file 'empty' error", async () => {
    const ledger = new InMemoryReportingLedger();
    const importer = new JonasGlImporter({ writer: ledger });

    const result = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv: "",
        filename: "empty.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
      },
    });
    expect(result.status).toBe("failed-validation");
    expect(result.diagnostics.fileErrors[0].kind).toBe("empty");
  });
});

// ---------------------------------------------------------------------------
// Mapping failures + trial-balance reconciliation failure
// ---------------------------------------------------------------------------

describe("JonasGlImporter — mapping + reconciliation failures", () => {
  it("unknown account code → failed-mapping; no snapshot written", async () => {
    const ledger = new InMemoryReportingLedger();
    // Restrict the mapping to ranges that do NOT cover account 99999.
    const restrictedMapping: JonasAccountMapping = {
      label: "Restricted",
      overrides: [],
      ranges: [
        { rangeStart: 1000, rangeEnd: 1999, category: "asset", fund: "operating" },
      ],
    };
    const importer = new JonasGlImporter({
      writer: ledger,
      mapping: restrictedMapping,
    });

    const csv = `AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod
1010,Cash,100,100,FY2026,5
99999,Unknown Bucket,50,50,FY2026,5`;

    const result = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv,
        filename: "unknown_account.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
      },
    });
    expect(result.status).toBe("failed-mapping");
    expect(result.diagnostics.mappingErrors).toHaveLength(1);
    expect(result.diagnostics.mappingErrors[0].accountNumber).toBe("99999");
    expect(result.snapshotId).toBeNull();
  });

  it("trial-balance does NOT reconcile → failed-reconciliation; no snapshot written", async () => {
    const ledger = new InMemoryReportingLedger();
    const importer = new JonasGlImporter({ writer: ledger });

    // Unbalanced — debit side $1000, credit side $0.
    const csv = `AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod
1010,Cash,1000,1000,FY2026,5`;

    const result = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv,
        filename: "unbalanced.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
      },
    });
    expect(result.status).toBe("failed-reconciliation");
    expect(result.diagnostics.reconciliation.isBalanced).toBe(false);
    expect(result.diagnostics.reconciliation.delta).toBe(1000);
    expect(result.notes).toMatch(/does NOT reconcile/);
  });
});

// ---------------------------------------------------------------------------
// Sample import report output
// ---------------------------------------------------------------------------

describe("JonasGlImporter — sample report output", () => {
  it("formats a successful Dataset A import into a readable report", async () => {
    const ledger = new InMemoryReportingLedger();
    const importer = new JonasGlImporter({
      writer: ledger,
      mapping: SILVER_SPRINGS_MAPPING,
    });

    const result = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv: DATASET_A_MAY_2026,
        filename: "silver_springs_fy2026_m05.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
        fiscalYearLabel: "FY2026",
        fiscalPeriodSequence: 5,
      },
    });

    const report = formatJonasImportReport({
      clubId: CLUB_SILVER_SPRINGS,
      filename: "silver_springs_fy2026_m05.csv",
      periodEnd: MAY_END,
      result,
    });

    // Sanity-check the report — full sample printed below for review.
    expect(report).toMatch(/Jonas GL Import — silver_springs_fy2026_m05\.csv/);
    expect(report).toMatch(/Status: SUCCEEDED/);
    expect(report).toMatch(/Rows parsed:\s+10/);
    expect(report).toMatch(/Reconciliation:\s+PASS/);
    expect(report).toMatch(/Total debits:/);
    expect(report).toMatch(/snapshot .* committed/);

    // Emit the formatted report so test runs document the actual
    // output shape. The console output is captured by the test
    // runner; failure makes the sample visible.
    // eslint-disable-next-line no-console
    console.log("\n" + report + "\n");
  });

  it("formats a failed import (mapping error) so the operator can act", async () => {
    const ledger = new InMemoryReportingLedger();
    const restricted: JonasAccountMapping = {
      label: "test-restricted",
      overrides: [],
      ranges: [
        { rangeStart: 1000, rangeEnd: 1999, category: "asset", fund: "operating" },
      ],
    };
    const importer = new JonasGlImporter({
      writer: ledger,
      mapping: restricted,
    });
    const csv = `AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod
1010,Cash,100,100,FY2026,5
99999,Unknown Account,50,50,FY2026,5`;

    const result = await importer.importJonasExtract({
      clubId: CLUB_SILVER_SPRINGS,
      extract: {
        csv,
        filename: "unmapped.csv",
        periodStart: MAY_START,
        periodEnd: MAY_END,
      },
    });
    const report = formatJonasImportReport({
      clubId: CLUB_SILVER_SPRINGS,
      filename: "unmapped.csv",
      periodEnd: MAY_END,
      result,
    });
    expect(report).toMatch(/Status: FAILED-MAPPING/);
    expect(report).toMatch(/Errors/);
    expect(report).toMatch(/account 99999/);
    expect(report).toMatch(/ABORTED/);
    // eslint-disable-next-line no-console
    console.log("\n" + report + "\n");
  });
});

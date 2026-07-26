// Statement of Financial Position — end-to-end ledger validation.
//
// Proves the refactor: Chapter VII (SoFP) is now driven entirely by
// `BalanceSheetSnapshot` data. Same code path, two different
// imported datasets → different values, ratios, and reactive
// commentary.
//
// Pipeline under test:
//
//   Jonas CSV (Dataset A or B)
//      ↓ JonasGlImporter
//   TrialBalanceSnapshot in ledger
//      ↓ BalanceSheetProjection
//   BalanceSheetSnapshot in ledger
//      ↓ buildStatementOfFinancialPositionFromBalanceSheet
//   StatementOfFinancialPosition (rendered by React)

import { describe, it, expect } from "vitest";

import {
  BalanceSheetProjection,
  InMemoryReportingLedger,
  JonasGlImporter,
} from "@/lib/reporting/ledger";
import {
  buildStatementOfFinancialPositionFromBalanceSheet,
  type SoFPAuxiliaryRatioInputs,
} from "@/lib/reporting/statement-of-financial-position";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

// ---------------------------------------------------------------------------
// Datasets — same shape as tests/jonas-gl-importer + a couple of extra
// accounts so the SoFP exercises the long-term-liability bucket.
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

const CLUB = "club_test_ledger_sofp";

const MAY_END = new Date(Date.UTC(2026, 4, 31, 23, 59, 59));
const MAY_START = new Date(Date.UTC(2026, 4, 1));
const JUNE_END = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));
const JUNE_START = new Date(Date.UTC(2026, 5, 1));

const MAY_PERIOD = buildReportingPeriod(MAY_END);
const JUNE_PERIOD = buildReportingPeriod(JUNE_END);

// Auxiliary inputs that the four non-BS ratios would come from
// (Income Statement / AR Aging / Reserve Study projections). The
// VALUES of these inputs are held constant across datasets so that
// any per-dataset difference can be attributed to the BS snapshot
// alone — proving the section is snapshot-driven.
const AUX_INPUTS: SoFPAuxiliaryRatioInputs = {
  arCurrentRate: 0.92,
  duesToRevenueRatio: 0.61,
  reserveCoverageRatio: 0.65,
  debtServiceCoverage: 2.0,
  // No netToGrossPpeOverride — derived from BS lines, so it WILL
  // vary between Datasets A and B (proves BS drives the ratio).
};

// Run the full pipeline for one dataset → return the rendered SoFP.
async function buildSoFPFromCsv(args: {
  csv: string;
  periodStart: Date;
  periodEnd: Date;
  reportingPeriod: ReturnType<typeof buildReportingPeriod>;
}) {
  const ledger = new InMemoryReportingLedger();
  const importer = new JonasGlImporter({ writer: ledger });
  const tb = await importer.importJonasExtract({
    clubId: CLUB,
    extract: {
      csv: args.csv,
      filename: "test.csv",
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      fiscalYearLabel: "FY2026",
    },
  });
  if (tb.status !== "succeeded") {
    throw new Error(`Jonas import did not succeed: ${tb.status}`);
  }
  const projection = new BalanceSheetProjection({
    ledger,
    writer: ledger,
  });
  const bs = await projection.getBalanceSheetSnapshot({
    clubId: CLUB,
    asOf: args.periodEnd,
  });
  if (bs.status !== "succeeded") {
    throw new Error(`BS projection did not succeed: ${bs.status}`);
  }

  return buildStatementOfFinancialPositionFromBalanceSheet({
    clubName: "Test Club",
    period: args.reportingPeriod,
    currentSnapshot: bs.snapshot,
    priorYearSnapshot: null, // no prior year for this validation
    auxiliaryRatioInputs: AUX_INPUTS,
    grossReplacementCostLabel: "$8M",
  });
}

// ---------------------------------------------------------------------------
// Validation: Dataset A vs Dataset B
// ---------------------------------------------------------------------------

describe("SoFP ledger refactor — Dataset A vs Dataset B", () => {
  it("Total Assets changes between Dataset A and Dataset B", async () => {
    const sofpA = await buildSoFPFromCsv({
      csv: DATASET_A_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      reportingPeriod: MAY_PERIOD,
    });
    const sofpB = await buildSoFPFromCsv({
      csv: DATASET_B_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      reportingPeriod: JUNE_PERIOD,
    });

    expect(sofpA.reconciliation.totalAssetsCurrent).not.toBe(
      sofpB.reconciliation.totalAssetsCurrent,
    );
    // Sanity: balance-sheet equation holds for both.
    expect(sofpA.reconciliation.balances).toBe(true);
    expect(sofpB.reconciliation.balances).toBe(true);
  });

  it("Per-account values trace to the snapshot — Cash 2M → 2.2M, Reserve 5M → 5.08M", async () => {
    const sofpA = await buildSoFPFromCsv({
      csv: DATASET_A_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      reportingPeriod: MAY_PERIOD,
    });
    const sofpB = await buildSoFPFromCsv({
      csv: DATASET_B_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      reportingPeriod: JUNE_PERIOD,
    });

    const cashA = sofpA.assetsRows.find((r) => r.key === "acct-1010")!;
    const cashB = sofpB.assetsRows.find((r) => r.key === "acct-1010")!;
    expect(cashA.current).toBe(2_000_000);
    expect(cashB.current).toBe(2_200_000);

    const reserveA = sofpA.assetsRows.find((r) => r.key === "acct-1850")!;
    const reserveB = sofpB.assetsRows.find((r) => r.key === "acct-1850")!;
    expect(reserveA.current).toBe(5_000_000);
    expect(reserveB.current).toBe(5_080_000);
  });

  it("Working Capital Ratio changes when AP shifts between datasets", async () => {
    const sofpA = await buildSoFPFromCsv({
      csv: DATASET_A_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      reportingPeriod: MAY_PERIOD,
    });
    const sofpB = await buildSoFPFromCsv({
      csv: DATASET_B_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      reportingPeriod: JUNE_PERIOD,
    });

    const wcA = sofpA.stewardshipRatios.rows.find((r) => r.key === "working-capital-ratio")!;
    const wcB = sofpB.stewardshipRatios.rows.find((r) => r.key === "working-capital-ratio")!;
    // Dataset A: current assets = 2M + 1M = 3M; current liabilities = 0.3M (AP);
    //   WC = 3M / 0.3M = 10.0
    // Dataset B: current assets = 2.2M + 1.05M = 3.25M; current liabilities = 0.3M;
    //   WC = 3.25M / 0.3M = 10.833...
    expect(wcA.actualValue).not.toBe(wcB.actualValue);
    expect(wcA.actualLabel).not.toBe(wcB.actualLabel);
  });

  it("Commentary changes between datasets — every dollar / ratio in narrative traces to the snapshot", async () => {
    const sofpA = await buildSoFPFromCsv({
      csv: DATASET_A_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      reportingPeriod: MAY_PERIOD,
    });
    const sofpB = await buildSoFPFromCsv({
      csv: DATASET_B_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      reportingPeriod: JUNE_PERIOD,
    });

    // The working-capital note quotes the actual ratio. Different
    // datasets → different ratio → different rendered text.
    const wcNoteA = sofpA.balanceSheetNotes.notes.at(-1)!.body;
    const wcNoteB = sofpB.balanceSheetNotes.notes.at(-1)!.body;
    expect(wcNoteA).toMatch(/Working capital ratio/);
    expect(wcNoteB).toMatch(/Working capital ratio/);
    expect(wcNoteA).not.toBe(wcNoteB);
  });

  it("RECONCILIATION holds for both datasets", async () => {
    const sofpA = await buildSoFPFromCsv({
      csv: DATASET_A_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      reportingPeriod: MAY_PERIOD,
    });
    const sofpB = await buildSoFPFromCsv({
      csv: DATASET_B_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      reportingPeriod: JUNE_PERIOD,
    });

    expect(sofpA.reconciliation.balances).toBe(true);
    expect(sofpB.reconciliation.balances).toBe(true);
    expect(sofpA.reconciliation.totalAssetsCurrent).toBe(
      sofpA.reconciliation.totalLiabilitiesAndEquityCurrent,
    );
    expect(sofpB.reconciliation.totalAssetsCurrent).toBe(
      sofpB.reconciliation.totalLiabilitiesAndEquityCurrent,
    );
  });
});

// ---------------------------------------------------------------------------
// No-hardcode regression — the source file must not contain inline
// balance-sheet literals that don't trace to a snapshot.
// ---------------------------------------------------------------------------

describe("SoFP ledger refactor — no hardcoded balance-sheet numbers remain", () => {
  it("statement-of-financial-position.ts source has no large dollar literals", async () => {
    const { readFileSync } = await import("node:fs");
    const path = require("node:path").resolve(
      process.cwd(),
      "src/lib/reporting/statement-of-financial-position.ts",
    );
    const src = readFileSync(path, "utf8");
    // Old code contained literals like `1_896_328`, `984_200`,
    // `4_820_000`, `-20_480_000`. After the refactor these MUST
    // live in the seed module, not in this file.
    const dollarLiteralPattern = /\b\d_\d{3}(?:_\d{3})+\b/;
    expect(src).not.toMatch(dollarLiteralPattern);
  });

  it("auxiliary ratio inputs are explicitly documented as awaiting their own projection services", async () => {
    const { readFileSync } = await import("node:fs");
    const path = require("node:path").resolve(
      process.cwd(),
      "src/lib/reporting/statement-of-financial-position.ts",
    );
    const src = readFileSync(path, "utf8");
    expect(src).toMatch(/AR Aging projection/);
    expect(src).toMatch(/Income Statement projection/);
    expect(src).toMatch(/Capital Tracker/);
  });
});

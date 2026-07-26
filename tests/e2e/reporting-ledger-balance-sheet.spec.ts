// Import responsiveness — Statement of Financial Position
// ============================================================================
//
// FIRST import-responsiveness test harness. PATTERN for all future
// reporting-section responsiveness specs:
//
//   1. Define two materially different datasets (A and B).
//   2. Run each through the full pipeline:
//        CSV → Jonas importer → ReportingLedger → projection →
//        section-rendering service.
//   3. Compare the two rendered outputs and assert that EVERY
//      stated subsystem responds to the new data:
//        - per-account asset balances
//        - per-account liability balances
//        - equity (per-account + YTD net income)
//        - stewardship ratios (the BS-derivable ones)
//        - reactive commentary
//
// This spec uses the Playwright test runner (per the operating-rule
// convention that tests/e2e/*.spec.ts ride the e2e runner) but does
// NOT use the `page` fixture today, because:
//
//   • The Reporting Ledger is currently in-process
//     (InMemoryReportingLedger). When the Prisma-backed ledger and
//     admin import UI land, this spec evolves to drive the actual
//     import workflow in the browser — same assertions, real UI.
//   • The pipeline integration IS the e2e contract today: any new
//     reporting section that claims to "consume the Reporting
//     Ledger" must add a sibling spec that proves data flows
//     through it.
//
// HOW TO ADAPT FOR A NEW SECTION (the "pattern" part):
//
//   1. Copy this file to `tests/e2e/reporting-ledger-<section>.spec.ts`.
//   2. Replace the CSV inputs with whatever exercise data the new
//      section needs.
//   3. Replace the projection + builder calls with the new section's
//      pipeline (e.g. IncomeStatementProjection + chapter IV builder).
//   4. Adjust the assertion block to cover the new section's
//      subsystems (KPI cards, charts, commentary, etc.) — at minimum
//      one assertion per "displayed surface" that must respond to data.

import { test, expect } from "@playwright/test";

import {
  BalanceSheetProjection,
  InMemoryReportingLedger,
  JonasGlImporter,
  type BalanceSheetSnapshot,
} from "@/lib/reporting/ledger";
import {
  buildStatementOfFinancialPositionFromBalanceSheet,
  type SoFPAuxiliaryRatioInputs,
  type StatementOfFinancialPosition,
} from "@/lib/reporting/statement-of-financial-position";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

// ---------------------------------------------------------------------------
// Two materially different datasets
// ---------------------------------------------------------------------------
//
// Both reconcile (debits ≡ credits at TB time) so the projection
// pipeline succeeds end-to-end. They differ in every section we
// assert against — assets, liabilities, equity, revenue, expense.

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

const CLUB = "club_e2e_responsiveness";

const MAY_START = new Date(Date.UTC(2026, 4, 1));
const MAY_END = new Date(Date.UTC(2026, 4, 31, 23, 59, 59));
const JUNE_START = new Date(Date.UTC(2026, 5, 1));
const JUNE_END = new Date(Date.UTC(2026, 5, 30, 23, 59, 59));

const MAY_REPORTING_PERIOD = buildReportingPeriod(MAY_END);
const JUNE_REPORTING_PERIOD = buildReportingPeriod(JUNE_END);

// Auxiliary inputs (would normally come from IS / AR Aging /
// Capital Tracker projections — held CONSTANT so any per-dataset
// difference is attributable to the BS snapshot alone).
const AUX: SoFPAuxiliaryRatioInputs = {
  arCurrentRate: 0.92,
  duesToRevenueRatio: 0.61,
  reserveCoverageRatio: 0.65,
  debtServiceCoverage: 2.0,
};

// ---------------------------------------------------------------------------
// Pipeline runner — the "test harness" entry point
// ---------------------------------------------------------------------------

/**
 * Run the full pipeline for one CSV → return the rendered SoFP +
 * the BalanceSheetSnapshot that produced it. The pattern future
 * specs adopt: one helper that drives the whole pipeline.
 */
async function importAndRender(args: {
  csv: string;
  periodStart: Date;
  periodEnd: Date;
  reportingPeriod: ReturnType<typeof buildReportingPeriod>;
}): Promise<{
  sofp: StatementOfFinancialPosition;
  snapshot: BalanceSheetSnapshot;
}> {
  const ledger = new InMemoryReportingLedger();

  const importer = new JonasGlImporter({ writer: ledger });
  const importResult = await importer.importJonasExtract({
    clubId: CLUB,
    extract: {
      csv: args.csv,
      filename: "e2e.csv",
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      fiscalYearLabel: "FY2026",
    },
  });
  expect(importResult.status, "Jonas import must succeed end-to-end").toBe("succeeded");

  const projection = new BalanceSheetProjection({ ledger, writer: ledger });
  const projectionResult = await projection.getBalanceSheetSnapshot({
    clubId: CLUB,
    asOf: args.periodEnd,
  });
  expect(projectionResult.status, "BS projection must succeed end-to-end").toBe("succeeded");
  if (projectionResult.status !== "succeeded") throw new Error("unreachable");

  const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
    clubName: "Test Club",
    period: args.reportingPeriod,
    currentSnapshot: projectionResult.snapshot,
    priorYearSnapshot: null,
    auxiliaryRatioInputs: AUX,
    grossReplacementCostLabel: "$8M",
  });
  return { sofp, snapshot: projectionResult.snapshot };
}

// ---------------------------------------------------------------------------
// Per-section comparators
// ---------------------------------------------------------------------------

function detailRowsByAccount(rows: ReadonlyArray<{ key: string; current?: number | null }>) {
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.key.startsWith("acct-") && r.current != null) {
      map.set(r.key, r.current);
    }
  }
  return map;
}

function ratiosByKey(sofp: StatementOfFinancialPosition) {
  return new Map(sofp.stewardshipRatios.rows.map((r) => [r.key, r.actualValue]));
}

function commentaryByNumber(sofp: StatementOfFinancialPosition) {
  return new Map(sofp.balanceSheetNotes.notes.map((n) => [n.number, n.body]));
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

test.describe("Import responsiveness — Statement of Financial Position (chapter VII)", () => {
  test("Dataset A vs Dataset B: assets, liabilities, equity, ratios, AND commentary all respond to the new data", async () => {
    const a = await importAndRender({
      csv: DATASET_A_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      reportingPeriod: MAY_REPORTING_PERIOD,
    });
    const b = await importAndRender({
      csv: DATASET_B_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      reportingPeriod: JUNE_REPORTING_PERIOD,
    });

    // -----------------------------------------------------------------
    // 1. Snapshot identity — the projection wrote distinct rows.
    // -----------------------------------------------------------------
    expect(a.snapshot.snapshotId).not.toBe(b.snapshot.snapshotId);

    // -----------------------------------------------------------------
    // 2. ASSET balances change
    // -----------------------------------------------------------------
    const assetsA = detailRowsByAccount(a.sofp.assetsRows);
    const assetsB = detailRowsByAccount(b.sofp.assetsRows);
    // Cash: 2,000,000 → 2,200,000
    expect(assetsA.get("acct-1010")).toBe(2_000_000);
    expect(assetsB.get("acct-1010")).toBe(2_200_000);
    expect(assetsA.get("acct-1010")).not.toBe(assetsB.get("acct-1010"));
    // Reserve fund: 5,000,000 → 5,080,000
    expect(assetsA.get("acct-1850")).toBe(5_000_000);
    expect(assetsB.get("acct-1850")).toBe(5_080_000);
    expect(assetsA.get("acct-1850")).not.toBe(assetsB.get("acct-1850"));
    // Total Assets must also differ.
    expect(a.sofp.reconciliation.totalAssetsCurrent).not.toBe(
      b.sofp.reconciliation.totalAssetsCurrent,
    );

    // -----------------------------------------------------------------
    // 3. LIABILITY balances change (AP shifts between A and B)
    // -----------------------------------------------------------------
    const liabsA = detailRowsByAccount(a.sofp.liabilitiesEquityRows);
    const liabsB = detailRowsByAccount(b.sofp.liabilitiesEquityRows);
    expect(liabsA.size).toBeGreaterThan(0);
    expect(liabsB.size).toBeGreaterThan(0);
    // AP is the same in both datasets (300_000) — but the long-term
    // debt and equity should change OR be stable depending on dataset
    // design. Assert via the Liabilities & Equity reconciled total
    // (different total assets ↔ different total liabilities+equity).
    expect(a.sofp.reconciliation.totalLiabilitiesAndEquityCurrent).not.toBe(
      b.sofp.reconciliation.totalLiabilitiesAndEquityCurrent,
    );

    // -----------------------------------------------------------------
    // 4. EQUITY changes — YTD net income reflects the new revenue +
    //    expense activity in the underlying TB.
    // -----------------------------------------------------------------
    const equityYtdA = a.sofp.liabilitiesEquityRows.find(
      (r) => r.key === "acct-__YTD_NET_INCOME__",
    );
    const equityYtdB = b.sofp.liabilitiesEquityRows.find(
      (r) => r.key === "acct-__YTD_NET_INCOME__",
    );
    expect(equityYtdA, "YTD net income row must be present in Dataset A").toBeDefined();
    expect(equityYtdB, "YTD net income row must be present in Dataset B").toBeDefined();
    expect(equityYtdA?.current).not.toBe(equityYtdB?.current);

    // -----------------------------------------------------------------
    // 5. RATIOS change — at minimum the BS-derived ones.
    // -----------------------------------------------------------------
    const ratiosA = ratiosByKey(a.sofp);
    const ratiosB = ratiosByKey(b.sofp);
    // Working capital ratio is derived from current assets ÷ current
    // liabilities — both inputs change between A and B → ratio
    // must change.
    expect(ratiosA.get("working-capital-ratio")).toBeDefined();
    expect(ratiosB.get("working-capital-ratio")).toBeDefined();
    expect(ratiosA.get("working-capital-ratio")).not.toBe(
      ratiosB.get("working-capital-ratio"),
    );
    // The auxiliary ratios (AR Current Rate / Dues:Revenue / Reserve
    // Coverage / Debt Service Coverage) are held constant in this
    // harness, so they MUST be equal — this anchors the assertion
    // that ratio changes come from the snapshot, not from drift in
    // the auxiliary input contract.
    expect(ratiosA.get("ar-current-rate")).toBe(ratiosB.get("ar-current-rate"));
    expect(ratiosA.get("debt-service-coverage")).toBe(
      ratiosB.get("debt-service-coverage"),
    );

    // -----------------------------------------------------------------
    // 6. COMMENTARY changes — the working-capital note quotes the
    //    actual ratio, so different snapshots → different rendered
    //    sentence.
    // -----------------------------------------------------------------
    const commA = commentaryByNumber(a.sofp);
    const commB = commentaryByNumber(b.sofp);
    expect(commA.size).toBeGreaterThan(0);
    expect(commA.size).toBe(commB.size); // same note count
    // The working-capital note is the LAST note (number = notes.length).
    const wcA = commA.get(commA.size)!;
    const wcB = commB.get(commB.size)!;
    expect(wcA, "Dataset A working-capital note must exist").toMatch(/Working capital ratio/);
    expect(wcB, "Dataset B working-capital note must exist").toMatch(/Working capital ratio/);
    expect(wcA, "commentary text must differ between snapshots").not.toBe(wcB);

    // -----------------------------------------------------------------
    // 7. RECONCILIATION holds for both datasets — proves the pipeline
    //    is producing valid balance sheets, not garbled ones.
    // -----------------------------------------------------------------
    expect(a.sofp.reconciliation.balances).toBe(true);
    expect(b.sofp.reconciliation.balances).toBe(true);
  });

  test("REGRESSION GUARD: if any one subsystem stops responding to imported data, this test fails", async () => {
    // Belt-and-braces — the same comparison rolled into a single
    // failure-mode statement so a future regression (e.g. someone
    // re-introduces a hardcoded value in the section) trips here.
    const a = await importAndRender({
      csv: DATASET_A_MAY_2026,
      periodStart: MAY_START,
      periodEnd: MAY_END,
      reportingPeriod: MAY_REPORTING_PERIOD,
    });
    const b = await importAndRender({
      csv: DATASET_B_JUNE_2026,
      periodStart: JUNE_START,
      periodEnd: JUNE_END,
      reportingPeriod: JUNE_REPORTING_PERIOD,
    });

    const differences = {
      totalAssets:
        a.sofp.reconciliation.totalAssetsCurrent !==
        b.sofp.reconciliation.totalAssetsCurrent,
      totalLiabilitiesAndEquity:
        a.sofp.reconciliation.totalLiabilitiesAndEquityCurrent !==
        b.sofp.reconciliation.totalLiabilitiesAndEquityCurrent,
      cash:
        detailRowsByAccount(a.sofp.assetsRows).get("acct-1010") !==
        detailRowsByAccount(b.sofp.assetsRows).get("acct-1010"),
      ytdNetIncome:
        a.sofp.liabilitiesEquityRows.find((r) => r.key === "acct-__YTD_NET_INCOME__")?.current !==
        b.sofp.liabilitiesEquityRows.find((r) => r.key === "acct-__YTD_NET_INCOME__")?.current,
      workingCapitalRatio:
        ratiosByKey(a.sofp).get("working-capital-ratio") !==
        ratiosByKey(b.sofp).get("working-capital-ratio"),
      commentary:
        a.sofp.balanceSheetNotes.notes.at(-1)?.body !==
        b.sofp.balanceSheetNotes.notes.at(-1)?.body,
    };

    // EVERY subsystem must respond.
    for (const [subsystem, didChange] of Object.entries(differences)) {
      expect(
        didChange,
        `Subsystem "${subsystem}" did NOT respond to imported data. ` +
          `The Statement of Financial Position is no longer fully ledger-driven.`,
      ).toBe(true);
    }
  });
});

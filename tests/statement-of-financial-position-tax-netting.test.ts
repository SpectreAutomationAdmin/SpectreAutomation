// Founder rule 2026-07-13 v15.18 â€” Statement of Financial Position
// tax-family net settlement.
//
// Root cause the founder observed after v15.17: the standard
// FS-Group aggregation summed the ABSOLUTE VALUE of every tax
// control account regardless of debit/credit direction. For the
// May 2026 GST accounts (2005 Collected $31,625 credit, 2006 Paid
// $31,403 debit, 2007 Suspense $9,135 debit), the report displayed
// `Sales Tax Payable $72,164` â€” the sum of absolutes. The correct
// algebraic net is $8,913 debit â†’ `Sales Tax Receivable`.
//
// v15.18 pipes every tax-family line (SALES_TAX / CORPORATE_TAX)
// through a pre-aggregation net-settlement stage:
//
//   1. Identify the family by FS-Group key or account-name pattern.
//   2. Compute algebraic net across the family (credit contributes
//      negatively, debit contributes positively â€” the direction
//      inferred from account-name terms like "Collected" /
//      "Payable" (credit) vs "Paid" / "ITCs" / "Recoverable" /
//      "Suspense" / "Refund" / "Instalment" (debit)).
//   3. Emit ONE dynamic SoFPRow on the side determined by the
//      resulting sign: net debit â†’ Receivable (asset side); net
//      credit â†’ Payable (liability side).
//   4. Underlying accounts are consumed exactly once â€” they never
//      re-enter the standard aggregation.
//   5. Signed drill-down: authorised viewers see each underlying
//      account with its actual signed contribution.

import { describe, it, expect } from "vitest";

import {
  getTaxFamily,
  getTaxAccountDirection,
} from "@/lib/reporting/ledger/classification-resolver";
import { buildStatementOfFinancialPositionFromBalanceSheet } from "@/lib/reporting/statement-of-financial-position";
import type {
  BalanceSheetLine,
  BalanceSheetSnapshot,
} from "@/lib/reporting/ledger/contracts";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));

const AUX_INPUTS = {
  arCurrentRate: 0.999,
  duesToRevenueRatio: 0.659,
  reserveCoverageRatio: 0.61,
  debtServiceCoverage: 2.1,
  netToGrossPpeOverride: 0.44,
} as const;

function makeSnapshot(
  lines: ReadonlyArray<Omit<BalanceSheetLine, "priorYearSameDateAmount">>,
): BalanceSheetSnapshot {
  return {
    snapshotId: "bs_test",
    clubId: "club_test",
    capturedAt: new Date(0),
    sourceSystem: "demo-seed",
    importBatchId: null,
    dataSource: "demo",
    notes: "test snapshot",
    entityKind: "balance-sheet",
    asOf: MAY_2026.periodEnd,
    fiscalYearLabel: `FY${MAY_2026.year}`,
    lines: lines.map((l) => ({
      ...l,
      // v15.22 â€” auto-derive rawSignedAmount so the strict live-mode guard
      // in `normaliseSign` does not throw. Convention matches the demo seed.
      // v15.22 — for tax-family accounts (fsGroupKey ~ BS_*_TAX_*) we
      // intentionally LEAVE rawSignedAmount undefined so `netTaxFamily`s
      // legacy name-based `getTaxAccountDirection` inference fires — the
      // sign of a tax control account is NOT determined by category
      // alone (GST Collected is credit-normal, GST Paid is debit-normal,
      // both live inside the same `current-liability` bucket).
      rawSignedAmount:
        l.rawSignedAmount ??
        (l.fsGroupKey && /TAX/i.test(l.fsGroupKey)
          ? undefined
          : l.category === "current-asset" ||
              l.category === "capital-fund-asset" ||
              l.category === "long-term-asset" ||
              l.category === "ppe-gross"
            ? l.amount
            : -l.amount),
      priorYearSameDateAmount: null,
    })),
    totalAssets: 0,
    totalLiabilities: 0,
    totalEquity: 0,
    isReconciled: true,
  };
}

// ---------------------------------------------------------------------------
// 1) getTaxFamily â€” identifies tax control accounts.
// ---------------------------------------------------------------------------
describe("v15.18 getTaxFamily â€” identifies sales tax and corporate tax families", () => {
  it("recognises founder-observed sales-tax names", () => {
    expect(getTaxFamily({ accountName: "GST Collected" })).toBe("SALES_TAX");
    expect(getTaxFamily({ accountName: "GST Paid (ITCs)" })).toBe("SALES_TAX");
    expect(getTaxFamily({ accountName: "GST Suspense" })).toBe("SALES_TAX");
    expect(getTaxFamily({ accountName: "HST Collected" })).toBe("SALES_TAX");
    expect(getTaxFamily({ accountName: "PST Payable" })).toBe("SALES_TAX");
    expect(getTaxFamily({ accountName: "Sales Tax Receivable" })).toBe("SALES_TAX");
  });
  it("recognises corporate income tax names", () => {
    expect(getTaxFamily({ accountName: "Corporate Income Tax Payable" })).toBe("CORPORATE_TAX");
    expect(getTaxFamily({ accountName: "Tax Instalments" })).toBe("CORPORATE_TAX");
    expect(getTaxFamily({ accountName: "Current Tax Provision" })).toBe("CORPORATE_TAX");
    expect(getTaxFamily({ accountName: "Income Tax Refund Receivable" })).toBe("CORPORATE_TAX");
  });
  it("recognises structured FS-Group metadata", () => {
    expect(getTaxFamily({ fsGroupKey: "BS_SALES_TAX_PAYABLE" })).toBe("SALES_TAX");
    expect(getTaxFamily({ fsGroupKey: "BS_INCOME_TAX_PAYABLE" })).toBe("CORPORATE_TAX");
    expect(getTaxFamily({ fsGroupKey: "BS_GST_HST" })).toBe("SALES_TAX");
  });
  it("does NOT confuse regular liability accounts (false-positive guard)", () => {
    expect(getTaxFamily({ accountName: "Accounts Payable" })).toBeNull();
    expect(getTaxFamily({ accountName: "Deferred Dues" })).toBeNull();
    expect(getTaxFamily({ accountName: "Property Tax Expense" })).toBeNull();
    expect(getTaxFamily({ accountName: "Land Transfer Duty" })).toBeNull();
    expect(getTaxFamily({ accountName: "" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2) getTaxAccountDirection â€” natural side.
// ---------------------------------------------------------------------------
describe("v15.18 getTaxAccountDirection â€” natural side of tax control accounts", () => {
  it("CREDIT side â€” collected / payable / provision / owing", () => {
    expect(getTaxAccountDirection("GST Collected")).toBe("CREDIT");
    expect(getTaxAccountDirection("Sales Tax Payable")).toBe("CREDIT");
    expect(getTaxAccountDirection("Current Tax Provision")).toBe("CREDIT");
    expect(getTaxAccountDirection("Corporate Tax Owing")).toBe("CREDIT");
  });
  it("DEBIT side â€” paid / input / ITCs / recoverable / refund / instalment / suspense", () => {
    expect(getTaxAccountDirection("GST Paid (ITCs)")).toBe("DEBIT");
    expect(getTaxAccountDirection("Tax Instalments")).toBe("DEBIT");
    expect(getTaxAccountDirection("Income Tax Refund Receivable")).toBe("DEBIT");
    expect(getTaxAccountDirection("GST Suspense")).toBe("DEBIT");
    expect(getTaxAccountDirection("GST Recoverable")).toBe("DEBIT");
    expect(getTaxAccountDirection("Input Tax Credits")).toBe("DEBIT");
  });
});

// ---------------------------------------------------------------------------
// 3) Founder's EXACT May 2026 GST scenario.
// ---------------------------------------------------------------------------
describe("v15.18 Founder's exact May 2026 GST scenario â€” Sales Tax Receivable $8,913 not Sales Tax Payable $72,164", () => {
  it("nets the three GST accounts algebraically â†’ Sales Tax Receivable $8,913 (not $72,164)", () => {
    const snapshot = makeSnapshot([
      // Founder's exact source balances (magnitudes, not signed â€”
      // BalanceSheetLine.amount is always positive; direction is
      // inferred from account name).
      { accountCode: "2005", accountName: "GST Collected",    category: "current-liability", fund: "operating", amount: 31_625.49, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2006", accountName: "GST Paid (ITCs)",  category: "current-liability", fund: "operating", amount: 31_402.71, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2007", accountName: "GST Suspense",     category: "current-liability", fund: "operating", amount:  9_135.35, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      // Cash + equity to make the sheet reconcile.
      { accountCode: "1010", accountName: "Cash â€” Operating", category: "current-asset",     fund: "operating", amount: 100_000,   fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      // 100_000 cash + 8_912.57 tax receivable = 108_912.57 assets.
      // 0 liabilities + 108_912.57 equity = 108_912.57 L+E. Reconciles.
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 108_912.57, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });

    // The dynamic tax row is a receivable on the asset side.
    const taxRow = sofp.assetsRows.find((r) => r.fsGroupKey === "BS_SALES_TAX_RECEIVABLE");
    expect(taxRow).toBeDefined();
    expect(taxRow?.label).toBe("Sales Tax Receivable");
    // 31,402.71 + 9,135.35 - 31,625.49 = 8,912.57
    expect(Math.round(taxRow?.current ?? 0)).toBe(8_913);

    // NO payable row exists â€” that's the founder's regression.
    const payableRow = sofp.assetsRows
      .concat(sofp.liabilitiesEquityRows)
      .find((r) => r.fsGroupKey === "BS_SALES_TAX_PAYABLE");
    expect(payableRow).toBeUndefined();

    // Total Current Assets includes the receivable; Total Current
    // Liabilities excludes it.
    const totalCurrentAssets = sofp.assetsRows.find((r) => r.key === "total-current-assets");
    expect(Math.round(totalCurrentAssets?.current ?? 0)).toBe(108_913);
    const totalCurrentLiab = sofp.liabilitiesEquityRows.find((r) => r.key === "total-current-liabilities");
    expect(totalCurrentLiab?.current).toBe(0);

    // Balance sheet reconciles.
    expect(sofp.reconciliation.balances).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4) Net credit position â†’ Sales Tax Payable.
// ---------------------------------------------------------------------------
describe("v15.18 net credit position â†’ Sales Tax Payable", () => {
  it("emits a Sales Tax Payable row on the liability side when Collected exceeds Paid + Suspense", () => {
    const snapshot = makeSnapshot([
      { accountCode: "2005", accountName: "GST Collected",    category: "current-liability", fund: "operating", amount: 100_000, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2006", accountName: "GST Paid (ITCs)",  category: "current-liability", fund: "operating", amount:  30_000, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "1010", accountName: "Cash â€” Operating", category: "current-asset",     fund: "operating", amount: 200_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      // 200k cash - 70k tax payable = 130k retained earnings.
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 130_000, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    const payableRow = sofp.liabilitiesEquityRows.find(
      (r) => r.fsGroupKey === "BS_SALES_TAX_PAYABLE",
    );
    // 100_000 - 30_000 = 70_000 net credit â†’ payable
    expect(payableRow?.label).toBe("Sales Tax Payable");
    expect(payableRow?.current).toBe(70_000);
    // No receivable exists on the asset side.
    const receivableRow = sofp.assetsRows.find(
      (r) => r.fsGroupKey === "BS_SALES_TAX_RECEIVABLE",
    );
    expect(receivableRow).toBeUndefined();
    expect(sofp.reconciliation.balances).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5) Corporate Income Tax â€” same mechanism.
// ---------------------------------------------------------------------------
describe("v15.18 corporate income tax uses the same net-settlement mechanism", () => {
  it("net debit â†’ Corporate Income Tax Receivable (instalments exceed provision)", () => {
    const snapshot = makeSnapshot([
      { accountCode: "2410", accountName: "Current Tax Provision", category: "current-liability", fund: "operating", amount: 100_000, fsGroupKey: "BS_INCOME_TAX_PAYABLE", fsGroupName: "Income Tax Payable", fsGroupSortOrder: 550 },
      { accountCode: "2411", accountName: "Tax Instalments",       category: "current-liability", fund: "operating", amount: 130_000, fsGroupKey: "BS_INCOME_TAX_PAYABLE", fsGroupName: "Income Tax Payable", fsGroupSortOrder: 550 },
      { accountCode: "1010", accountName: "Cash",   category: "current-asset", fund: "operating", amount: 500_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      // 500k cash + 30k tax receivable = 530k equity.
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 530_000, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    const row = sofp.assetsRows.find((r) => r.fsGroupKey === "BS_INCOME_TAX_RECEIVABLE");
    // 130_000 - 100_000 = 30_000 net debit â†’ receivable
    expect(row?.label).toBe("Corporate Income Tax Receivable");
    expect(row?.current).toBe(30_000);
    expect(sofp.reconciliation.balances).toBe(true);
  });

  it("net credit â†’ Corporate Income Tax Payable (provision exceeds instalments)", () => {
    const snapshot = makeSnapshot([
      { accountCode: "2410", accountName: "Current Tax Provision", category: "current-liability", fund: "operating", amount: 100_000, fsGroupKey: "BS_INCOME_TAX_PAYABLE", fsGroupName: "Income Tax Payable", fsGroupSortOrder: 550 },
      { accountCode: "2411", accountName: "Tax Instalments",       category: "current-liability", fund: "operating", amount:  70_000, fsGroupKey: "BS_INCOME_TAX_PAYABLE", fsGroupName: "Income Tax Payable", fsGroupSortOrder: 550 },
      { accountCode: "1010", accountName: "Cash", category: "current-asset", fund: "operating", amount: 500_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      // 500k cash - 30k tax payable = 470k equity.
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 470_000, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    const row = sofp.liabilitiesEquityRows.find((r) => r.fsGroupKey === "BS_INCOME_TAX_PAYABLE");
    expect(row?.label).toBe("Corporate Income Tax Payable");
    expect(row?.current).toBe(30_000);
    expect(sofp.reconciliation.balances).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6) Signed drill-down + duplicate protection.
// ---------------------------------------------------------------------------
describe("v15.18 signed drill-down + duplicate protection", () => {
  it("underlying accounts are consumed exactly once (no duplicate GST row inside Current Liabilities)", () => {
    const snapshot = makeSnapshot([
      { accountCode: "2005", accountName: "GST Collected",   category: "current-liability", fund: "operating", amount: 31_625.49, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2006", accountName: "GST Paid (ITCs)", category: "current-liability", fund: "operating", amount: 31_402.71, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2007", accountName: "GST Suspense",    category: "current-liability", fund: "operating", amount:  9_135.35, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "1010", accountName: "Cash", category: "current-asset", fund: "operating", amount: 100_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 108_912.57, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    // The Sales Tax Payable FS-Group's standard aggregation row
    // must NOT appear in Current Liabilities â€” those lines were
    // extracted before the standard aggregation ran.
    const standardPayableRow = sofp.liabilitiesEquityRows.find(
      (r) => r.kind === "fs-group" && r.fsGroupKey === "BS_SALES_TAX_PAYABLE" && r.label === "Sales Tax Payable",
    );
    expect(standardPayableRow).toBeUndefined();
  });

  it("signed drill-down: GST Collected renders NEGATIVE; GST Paid + Suspense render POSITIVE; the three sum to the parent net", () => {
    const snapshot = makeSnapshot([
      { accountCode: "2005", accountName: "GST Collected",   category: "current-liability", fund: "operating", amount: 31_625.49, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2006", accountName: "GST Paid (ITCs)", category: "current-liability", fund: "operating", amount: 31_402.71, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2007", accountName: "GST Suspense",    category: "current-liability", fund: "operating", amount:  9_135.35, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "1010", accountName: "Cash", category: "current-asset", fund: "operating", amount: 100_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 108_912.57, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
      viewerCanDrillDown: true, // â† authorised drill-down
    });
    const taxRow = sofp.assetsRows.find((r) => r.fsGroupKey === "BS_SALES_TAX_RECEIVABLE");
    expect(taxRow?.accounts).toBeDefined();
    expect(taxRow?.accounts).toHaveLength(3);
    const collected = taxRow?.accounts?.find((a) => a.accountCode === "2005");
    const paid = taxRow?.accounts?.find((a) => a.accountCode === "2006");
    const suspense = taxRow?.accounts?.find((a) => a.accountCode === "2007");
    expect(collected?.current).toBeCloseTo(-31_625.49, 2); // CREDIT
    expect(paid?.current).toBeCloseTo(31_402.71, 2);       // DEBIT
    expect(suspense?.current).toBeCloseTo(9_135.35, 2);    // DEBIT
    const accountsSum =
      (collected?.current ?? 0) + (paid?.current ?? 0) + (suspense?.current ?? 0);
    // Underlying signed contributions sum to the parent net
    // (floating-point tolerance for the Â± 0.01 rounding).
    expect(Math.abs(accountsSum - (taxRow?.current ?? 0))).toBeLessThan(0.01);
  });

  it("Board / member payload (viewerCanDrillDown: false) omits `accounts` from the dynamic tax row", () => {
    const snapshot = makeSnapshot([
      { accountCode: "2005", accountName: "GST Collected",   category: "current-liability", fund: "operating", amount: 100_000, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "1010", accountName: "Cash", category: "current-asset", fund: "operating", amount: 100_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 0, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
      // viewerCanDrillDown omitted â†’ Board default
    });
    const payable = sofp.liabilitiesEquityRows.find((r) => r.fsGroupKey === "BS_SALES_TAX_PAYABLE");
    expect(payable?.accounts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7) Comparative period switches side.
// ---------------------------------------------------------------------------
describe("v15.18 comparative period independently determines its tax side", () => {
  it("May 2026 receivable + May 2025 payable â†’ two separate rows on their respective sides", () => {
    // May 2026 net = debit (receivable). May 2025 net = credit
    // (payable). The two periods emerge as separate dynamic rows
    // on different sides so the reader never sees a prior-year
    // payable value floating inside the receivable row.
    const may2026 = makeSnapshot([
      { accountCode: "2005", accountName: "GST Collected",   category: "current-liability", fund: "operating", amount: 31_625.49, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2006", accountName: "GST Paid (ITCs)", category: "current-liability", fund: "operating", amount: 31_402.71, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2007", accountName: "GST Suspense",    category: "current-liability", fund: "operating", amount:  9_135.35, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "1010", accountName: "Cash", category: "current-asset", fund: "operating", amount: 100_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 108_912.57, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const may2025 = makeSnapshot([
      { accountCode: "2005", accountName: "GST Collected",   category: "current-liability", fund: "operating", amount: 50_000, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2006", accountName: "GST Paid (ITCs)", category: "current-liability", fund: "operating", amount: 25_000, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2007", accountName: "GST Suspense",    category: "current-liability", fund: "operating", amount: 12_600, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "1010", accountName: "Cash", category: "current-asset", fund: "operating", amount: 100_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 87_600, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: may2026,
      priorYearSnapshot: may2025,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    // Current row on the ASSET side: Sales Tax Receivable ~$8,913,
    // prior comparative on the same row is null (prior was payable
    // side â€” surfaces separately below).
    const receivable = sofp.assetsRows.find((r) => r.fsGroupKey === "BS_SALES_TAX_RECEIVABLE");
    expect(receivable?.label).toBe("Sales Tax Receivable");
    expect(Math.round(receivable?.current ?? 0)).toBe(8_913);
    expect(receivable?.comparative).toBeNull();
    // Prior row on the LIABILITY side: Sales Tax Payable
    // ($50,000 - $25,000 - $12,600 = $12,400).
    const payable = sofp.liabilitiesEquityRows.find((r) => r.fsGroupKey === "BS_SALES_TAX_PAYABLE");
    expect(payable?.label).toBe("Sales Tax Payable");
    expect(payable?.current).toBeNull(); // current period is on the asset side
    expect(payable?.comparative).toBe(12_400);
  });
});

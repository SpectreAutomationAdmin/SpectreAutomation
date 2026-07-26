// Founder rule 2026-07-13 v15.19 â€” Raw Trial Balance sign preserved
// for tax-family net settlement.
//
// Root cause of the founder-observed regression after v15.18:
//   â€¢ My v15.18 `netTaxFamily` inferred each tax account's direction
//     from its NAME via `getTaxAccountDirection` â€” patterns that
//     matched "collected" (CREDIT), "paid" / "itcs" (DEBIT), etc.
//   â€¢ Account 2007 "GST Filed" matched NEITHER pattern, so my code
//     defaulted it to CREDIT and subtracted its $9,135 debit balance
//     from the net.
//   â€¢ Result: -31,625 + 31,403 - 9,135 = -$9,357 â†’ presented as
//     "Sales Tax Payable $9,358" instead of the correct
//     "Sales Tax Receivable $8,913".
//
// v15.19 fix: `BalanceSheetLine.rawSignedAmount` carries the untouched
// Trial Balance sign (debit-positive / credit-negative) through the
// projection. `netTaxFamily` and `buildTaxRowAccounts` use it directly
// when present; name inference is only a legacy-snapshot fallback.
// Account Type / normal-balance metadata NEVER overrides the imported
// sign â€” an abnormal debit balance in a liability-classified account
// remains a debit in the net calculation.

import { describe, it, expect } from "vitest";

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
// 1) Founder's exact May 2026 GST scenario â€” using rawSignedAmount.
// ---------------------------------------------------------------------------
describe("v15.19 founder's exact May 2026 GST scenario via rawSignedAmount", () => {
  it("GST Filed at +$9,135.35 debit stays positive; net is +$8,912.57 â†’ Sales Tax Receivable $8,913", () => {
    // Founder's exact source Trial Balance values â€” signed as the
    // Jonas import writes them. All three lines share the same
    // liability-classified FS Group; the tax builder must NEVER
    // reinterpret their signs from that classification.
    const snapshot = makeSnapshot([
      { accountCode: "2005", accountName: "GST Collected",   category: "current-liability", fund: "operating", amount: 31_625.49, rawSignedAmount: -31_625.49, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2006", accountName: "GST Paid (ITCs)", category: "current-liability", fund: "operating", amount: 31_402.71, rawSignedAmount:  31_402.71, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      // The founder-flagged bug: GST Filed at +$9,135.35 debit
      // was being read as CREDIT because "Filed" didn't match my
      // v15.18 DEBIT patterns. With rawSignedAmount populated, the
      // account's Chart-of-Accounts liability classification NEVER
      // overrides the imported debit sign.
      { accountCode: "2007", accountName: "GST Filed",       category: "current-liability", fund: "operating", amount:  9_135.35, rawSignedAmount:   9_135.35, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "1010", accountName: "Cash â€” Operating", category: "current-asset", fund: "operating", amount: 100_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      // Equity balances the sheet: 100_000 cash + 8_912.57 receivable.
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 108_912.57, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    // Sales Tax Receivable row exists on the asset side.
    const receivable = sofp.assetsRows.find(
      (r) => r.fsGroupKey === "BS_SALES_TAX_RECEIVABLE",
    );
    expect(receivable).toBeDefined();
    expect(receivable?.label).toBe("Sales Tax Receivable");
    // -31,625.49 + 31,402.71 + 9,135.35 = 8,912.57 â†’ rounded $8,913.
    expect(Math.round(receivable?.current ?? 0)).toBe(8_913);
    // The founder's regression value MUST NOT appear anywhere.
    const wrongPayable = sofp.liabilitiesEquityRows
      .concat(sofp.assetsRows)
      .find((r) => r.kind === "fs-group" && Math.round(r.current ?? 0) === 9_358);
    expect(wrongPayable).toBeUndefined();
    // Balance sheet reconciles.
    expect(sofp.reconciliation.balances).toBe(true);
  });

  it("drill-down preserves each account's actual signed balance â€” sums to +$8,912.57 parent", () => {
    const snapshot = makeSnapshot([
      { accountCode: "2005", accountName: "GST Collected",   category: "current-liability", fund: "operating", amount: 31_625.49, rawSignedAmount: -31_625.49, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2006", accountName: "GST Paid (ITCs)", category: "current-liability", fund: "operating", amount: 31_402.71, rawSignedAmount:  31_402.71, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2007", accountName: "GST Filed",       category: "current-liability", fund: "operating", amount:  9_135.35, rawSignedAmount:   9_135.35, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "1010", accountName: "Cash", category: "current-asset", fund: "operating", amount: 100_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 108_912.57, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
      viewerCanDrillDown: true, // authorised drill-down
    });
    const row = sofp.assetsRows.find(
      (r) => r.fsGroupKey === "BS_SALES_TAX_RECEIVABLE",
    );
    expect(row?.accounts).toHaveLength(3);
    const collected = row?.accounts?.find((a) => a.accountCode === "2005");
    const paid = row?.accounts?.find((a) => a.accountCode === "2006");
    const filed = row?.accounts?.find((a) => a.accountCode === "2007");
    // Each detail account renders WITH ITS ACTUAL SIGN â€” no
    // side-of-parent normalisation.
    expect(collected?.current).toBeCloseTo(-31_625.49, 2);
    expect(paid?.current).toBeCloseTo(31_402.71, 2);
    expect(filed?.current).toBeCloseTo(9_135.35, 2); // â† the founder's fix: NOT negative
    // Signed drill-down sums to the parent net.
    const sum =
      (collected?.current ?? 0) + (paid?.current ?? 0) + (filed?.current ?? 0);
    expect(Math.abs(sum - (row?.current ?? 0))).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// 2) Account Type never overrides raw signed amount.
// ---------------------------------------------------------------------------
describe("v15.19 account Type never overrides raw signed amount", () => {
  it("a debit balance in a liability-classified GST account remains positive in tax netting", () => {
    // Even though "GST Filed" is classified under BS_SALES_TAX_PAYABLE
    // (a liability FS Group), its debit balance is preserved by
    // rawSignedAmount and contributes POSITIVELY to the family net.
    const snapshot = makeSnapshot([
      { accountCode: "2007", accountName: "GST Filed", category: "current-liability", fund: "operating", amount: 5_000, rawSignedAmount: 5_000, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "1010", accountName: "Cash", category: "current-asset", fund: "operating", amount: 10_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 15_000, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    // Net is +$5,000 (debit) â†’ Sales Tax Receivable.
    const receivable = sofp.assetsRows.find(
      (r) => r.fsGroupKey === "BS_SALES_TAX_RECEIVABLE",
    );
    expect(receivable?.current).toBe(5_000);
    // No payable emitted on the liability side.
    const payable = sofp.liabilitiesEquityRows.find(
      (r) => r.fsGroupKey === "BS_SALES_TAX_PAYABLE",
    );
    expect(payable).toBeUndefined();
  });

  it("a credit balance in the same account in another period is treated as credit (abnormal-side balances are period-specific)", () => {
    const snapshot = makeSnapshot([
      { accountCode: "2007", accountName: "GST Filed", category: "current-liability", fund: "operating", amount: 5_000, rawSignedAmount: -5_000, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "1010", accountName: "Cash", category: "current-asset", fund: "operating", amount: 10_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 5_000, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    // Net is -$5,000 (credit) â†’ Sales Tax Payable.
    const payable = sofp.liabilitiesEquityRows.find(
      (r) => r.fsGroupKey === "BS_SALES_TAX_PAYABLE",
    );
    expect(payable?.current).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// 3) rawSignedAmount takes precedence over name inference.
// ---------------------------------------------------------------------------
describe("v15.19 rawSignedAmount takes precedence over name-based direction inference", () => {
  it("even if a name pattern would suggest CREDIT, rawSignedAmount's DEBIT sign wins", () => {
    // Synthetic scenario: an account named "GST Collected" (which
    // the pattern detector says CREDIT) but whose actual TB balance
    // is a debit ($100 positive). rawSignedAmount wins â€” the account
    // contributes +$100 to the family net, not -$100.
    const snapshot = makeSnapshot([
      { accountCode: "2005", accountName: "GST Collected", category: "current-liability", fund: "operating", amount: 100, rawSignedAmount: 100, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "1010", accountName: "Cash", category: "current-asset", fund: "operating", amount: 1_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 1_100, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    const receivable = sofp.assetsRows.find(
      (r) => r.fsGroupKey === "BS_SALES_TAX_RECEIVABLE",
    );
    expect(receivable?.current).toBe(100);
  });

  it("legacy snapshot (no rawSignedAmount) falls back to name inference â€” and 'GST Filed' now correctly matches DEBIT", () => {
    // Founder-authorised fallback: if a pre-v15.19 snapshot didn't
    // carry rawSignedAmount, the name-inference path handles it â€”
    // and v15.19 added a `\bfiled\b` DEBIT pattern so "GST Filed"
    // still nets correctly on the debit side even without the raw
    // amount.
    const snapshot = makeSnapshot([
      { accountCode: "2005", accountName: "GST Collected",   category: "current-liability", fund: "operating", amount: 31_625.49, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2006", accountName: "GST Paid (ITCs)", category: "current-liability", fund: "operating", amount: 31_402.71, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2007", accountName: "GST Filed",       category: "current-liability", fund: "operating", amount:  9_135.35, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
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
    const receivable = sofp.assetsRows.find(
      (r) => r.fsGroupKey === "BS_SALES_TAX_RECEIVABLE",
    );
    expect(Math.round(receivable?.current ?? 0)).toBe(8_913);
  });
});

// ---------------------------------------------------------------------------
// 4) Source-contract: BalanceSheetLine + projection carry
// rawSignedAmount through the pipeline.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

describe("v15.19 source-contract â€” rawSignedAmount is populated in the projection + preserved through enrichment", () => {
  const contracts = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/reporting/ledger/contracts.ts"),
    "utf8",
  );
  const projection = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/lib/reporting/ledger/projections/balance-sheet-projection.ts",
    ),
    "utf8",
  );
  const sofp = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/lib/reporting/statement-of-financial-position.ts",
    ),
    "utf8",
  );

  it("BalanceSheetLine.rawSignedAmount is defined as an optional number", () => {
    expect(contracts).toMatch(/rawSignedAmount\?:\s*number/);
    // The doc-block must explain the debit-positive / credit-negative
    // convention so future readers don't reintroduce the bug.
    expect(contracts).toMatch(/debit[^)]*(positive|=|â†’)/i);
    expect(contracts).toMatch(/credit[^)]*(negative|=|â†’)/i);
  });

  it("balance-sheet projection populates rawSignedAmount verbatim from tbLine.endingBalance", () => {
    expect(projection).toMatch(/rawSignedAmount:\s*tbLine\.endingBalance/);
  });

  it("netTaxFamily prefers rawSignedAmount when present (raw TB sign wins)", () => {
    expect(sofp).toMatch(/typeof line\.rawSignedAmount === "number"/);
    // The raw path adds the raw amount directly â€” no name-inference,
    // no sign flip based on Account Type or FS Group.
    expect(sofp).toMatch(/signed \+= line\.rawSignedAmount/);
  });

  it("buildTaxRowAccounts reuses the same rawSignedAmount-first strategy for drill-down consistency", () => {
    expect(sofp).toMatch(/const signedContribution = \(line: BalanceSheetLine\)/);
    expect(sofp).toMatch(/typeof line\.rawSignedAmount === "number"[\s\S]{0,80}return line\.rawSignedAmount/);
  });
});

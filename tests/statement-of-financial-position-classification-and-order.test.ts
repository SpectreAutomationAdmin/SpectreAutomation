// Founder rule 2026-07-13 v15.20 â€” non-current asset placement +
// liquidity ordering.
//
// Two founder-observed presentation defects after v15.19 shipped:
//
//   1. Long-term Receivables were being displayed inside Current
//      Assets. The founder rule: "A receivable classified in the
//      COA as long-term must appear in a non-current asset category."
//
//   2. Current-asset FS Groups were not ordered from most liquid to
//      least liquid. The founder-required order:
//          Cash â†’ Sales Tax Receivable â†’ Accounts Receivable
//          â†’ Member Receivables â†’ Inventory â†’ Prepaid Expenses.
//
// v15.20 corrections:
//
//   â€¢ New `long-term-asset` value on `BalanceSheetCategory`.
//   â€¢ `deriveBalanceSheetCategoryFromCoa` routes accounts by CoA
//     `Account.category` â€” LONG_TERM_ASSETS / NON_CURRENT_ASSETS
//     / OTHER_ASSETS â€” AND by FS-Group key â€” BS_LONG_TERM_RECEIVABLES
//     / BS_ROU_ASSETS / BS_INTANGIBLES / BS_OTHER_LONG_TERM_ASSETS
//     â€” to the new section. Neither Account Type nor Account Number
//     alone can force a non-current asset into Current Assets.
//   â€¢ Dedicated Long-Term Assets section band + subtotal appear
//     between Capital & Reserve Assets and PP&E. Total Assets
//     includes it exactly once.
//   â€¢ New `presentation-order.ts` centralises liquidity ordering
//     for every section. Dynamic tax rows slot into their correct
//     liquidity position (BS_SALES_TAX_RECEIVABLE = 300, between
//     Cash at 100 and AR at 400).
//   â€¢ `sortRowsByPresentation` applies the order deterministically:
//     canonical > sortOrder > lexicographic tie-break. Never
//     alphabetical, never insertion order.

import { describe, it, expect } from "vitest";

import {
  deriveBalanceSheetCategoryFromCoa,
} from "@/lib/reporting/ledger/classification-resolver";
import {
  comparePresentationOrder,
  resolvePresentationOrder,
} from "@/lib/reporting/ledger/presentation-order";
import {
  buildStatementOfFinancialPositionFromBalanceSheet,
} from "@/lib/reporting/statement-of-financial-position";
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
      // v15.22 â€” every seed / fixture line MUST carry rawSignedAmount so the
      // strict `normaliseSign` guard in the SoFP builder does not throw
      // MISSING_RAW_SIGNED_AMOUNT. Derive from category using the same
      // convention as `silver-springs-balance-sheet-seed.ts`.
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
// 1) deriveBalanceSheetCategoryFromCoa routes Long-Term Assets.
// ---------------------------------------------------------------------------
describe("v15.20 deriveBalanceSheetCategoryFromCoa â€” routes long-term assets", () => {
  it("Account.category = LONG_TERM_ASSETS â†’ long-term-asset", () => {
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "ASSET",
        categoryKey: "LONG_TERM_ASSETS",
        fsGroupKey: "BS_LONG_TERM_RECEIVABLES",
      }),
    ).toBe("long-term-asset");
  });
  it("Account.category = NON_CURRENT_ASSETS â†’ long-term-asset", () => {
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "ASSET",
        categoryKey: "NON_CURRENT_ASSETS",
        fsGroupKey: "BS_INTANGIBLES",
      }),
    ).toBe("long-term-asset");
  });
  it("FS-Group BS_LONG_TERM_RECEIVABLES â†’ long-term-asset regardless of Category", () => {
    // Even if the CoA mistakenly typed it under CURRENT_ASSETS, the
    // FS-Group override wins.
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "ASSET",
        categoryKey: "CURRENT_ASSETS",
        fsGroupKey: "BS_LONG_TERM_RECEIVABLES",
      }),
    ).toBe("long-term-asset");
  });
  it("Other long-term FS-Group keys route non-current too", () => {
    for (const fs of [
      "BS_ROU_ASSETS",
      "BS_INTANGIBLES",
      "BS_OTHER_LONG_TERM_ASSETS",
    ]) {
      expect(
        deriveBalanceSheetCategoryFromCoa({
          accountType: "ASSET",
          categoryKey: null,
          fsGroupKey: fs,
        }),
      ).toBe("long-term-asset");
    }
  });
  it("Regular current-asset FS Groups still route to current-asset", () => {
    for (const fs of [
      "BS_CASH_EQUIVALENTS",
      "BS_AR",
      "BS_MEMBER_AR",
      "BS_INVENTORY",
      "BS_PREPAID_EXPENSES",
    ]) {
      expect(
        deriveBalanceSheetCategoryFromCoa({
          accountType: "ASSET",
          categoryKey: "CURRENT_ASSETS",
          fsGroupKey: fs,
        }),
      ).toBe("current-asset");
    }
  });
});

// ---------------------------------------------------------------------------
// 2) End-to-end: Long-term Receivables land in the non-current
// section AND Total Assets is unchanged by the reclassification.
// ---------------------------------------------------------------------------
describe("v15.20 Long-term Receivables excluded from Current Assets", () => {
  it("moving a receivable from CURRENT_ASSETS to LONG_TERM_ASSETS keeps Total Assets unchanged", () => {
    // Same balances, only the classification changes.
    const balances = [
      { accountCode: "1010", accountName: "Cash", category: "current-asset" as const, fund: "operating" as const, amount: 100_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance" as const, fund: "operating" as const, amount: 532_762, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ];

    // Version A: receivable in Current Assets (pre-v15.20).
    const versionA = makeSnapshot([
      ...balances,
      { accountCode: "1400", accountName: "Long-term Receivables â€” Members", category: "current-asset", fund: "operating", amount: 432_762, fsGroupKey: "BS_LONG_TERM_RECEIVABLES", fsGroupName: "Long-term Receivables", fsGroupSortOrder: 405 },
    ]);
    // Version B: SAME balance but tagged with Long-Term FS Group.
    // v15.20 routes it to long-term-asset via the FS-Group override.
    const versionB = makeSnapshot([
      ...balances,
      { accountCode: "1400", accountName: "Long-term Receivables â€” Members", category: "long-term-asset", fund: "operating", amount: 432_762, fsGroupKey: "BS_LONG_TERM_RECEIVABLES", fsGroupName: "Long-term Receivables", fsGroupSortOrder: 405 },
    ]);
    const sofpA = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test",
      period: MAY_2026,
      currentSnapshot: versionA,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    const sofpB = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test",
      period: MAY_2026,
      currentSnapshot: versionB,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    // Total Assets unchanged.
    expect(sofpA.reconciliation.totalAssetsCurrent)
      .toBe(sofpB.reconciliation.totalAssetsCurrent);

    // Version B: Long-term Receivables is NOT in Current Assets.
    const currentAssetsSection = sofpB.assetsRows.slice(
      sofpB.assetsRows.findIndex((r) => r.key === "band-current-assets") + 1,
      sofpB.assetsRows.findIndex((r) => r.key === "total-current-assets"),
    );
    const receivableInCurrent = currentAssetsSection.find(
      (r) => r.fsGroupKey === "BS_LONG_TERM_RECEIVABLES",
    );
    expect(receivableInCurrent).toBeUndefined();

    // Version B: Total Current Assets DROPS by the reclassified balance.
    const totalCurrentA = sofpA.assetsRows.find((r) => r.key === "total-current-assets");
    const totalCurrentB = sofpB.assetsRows.find((r) => r.key === "total-current-assets");
    expect((totalCurrentA?.current ?? 0) - (totalCurrentB?.current ?? 0)).toBe(432_762);

    // Version B: Long-Term Assets section shows the receivable.
    const longTermReceivableRow = sofpB.assetsRows.find(
      (r) => r.fsGroupKey === "BS_LONG_TERM_RECEIVABLES",
    );
    expect(longTermReceivableRow?.current).toBe(432_762);

    // Version B: Total Long-Term Assets = $432,762.
    const totalLongTerm = sofpB.assetsRows.find((r) => r.key === "total-long-term-assets");
    expect(totalLongTerm?.current).toBe(432_762);

    // Both versions reconcile.
    expect(sofpA.reconciliation.balances).toBe(true);
    expect(sofpB.reconciliation.balances).toBe(true);
  });

  it("Long-Term Assets section band appears only when the section has rows", () => {
    // Snapshot without any long-term-asset lines omits the section
    // entirely â€” an empty section shouldn't clutter clubs that
    // don't use long-term receivables.
    const snapshot = makeSnapshot([
      { accountCode: "1010", accountName: "Cash", category: "current-asset", fund: "operating", amount: 100_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 100_000, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    const band = sofp.assetsRows.find((r) => r.key === "band-long-term-assets");
    const subtotal = sofp.assetsRows.find((r) => r.key === "total-long-term-assets");
    expect(band).toBeUndefined();
    expect(subtotal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3) Presentation-order helper.
// ---------------------------------------------------------------------------
describe("v15.20 presentation-order â€” deterministic liquidity order", () => {
  it("current-asset order â€” Cash < Sales Tax Receivable < AR < Member AR < Inventory < Prepaid", () => {
    const cash = resolvePresentationOrder({ section: "current-asset", fsGroupKey: "BS_CASH_EQUIVALENTS" });
    const salesTax = resolvePresentationOrder({ section: "current-asset", fsGroupKey: "BS_SALES_TAX_RECEIVABLE" });
    const ar = resolvePresentationOrder({ section: "current-asset", fsGroupKey: "BS_AR" });
    const memberAr = resolvePresentationOrder({ section: "current-asset", fsGroupKey: "BS_MEMBER_AR" });
    const inventory = resolvePresentationOrder({ section: "current-asset", fsGroupKey: "BS_INVENTORY" });
    const prepaid = resolvePresentationOrder({ section: "current-asset", fsGroupKey: "BS_PREPAID_EXPENSES" });
    expect(cash).toBeLessThan(salesTax);
    expect(salesTax).toBeLessThan(ar);
    expect(ar).toBeLessThan(memberAr);
    expect(memberAr).toBeLessThan(inventory);
    expect(inventory).toBeLessThan(prepaid);
  });

  it("unknown FS Group falls back to sortOrder, then to key lexicographic â€” never alphabetical", () => {
    // Unknown group with sortOrder 50 sorts BEFORE unknown with sortOrder 100.
    const a = { fsGroupKey: "BS_UNKNOWN_A", fsGroupSortOrder: 50 };
    const b = { fsGroupKey: "BS_UNKNOWN_B", fsGroupSortOrder: 100 };
    expect(comparePresentationOrder(a, b, "current-asset")).toBeLessThan(0);
    // Same sortOrder â†’ lexicographic on key.
    const c = { fsGroupKey: "BS_UNKNOWN_C", fsGroupSortOrder: 50 };
    expect(comparePresentationOrder(a, c, "current-asset")).toBeLessThan(0);
  });

  it("canonical order beats sortOrder â€” a Cash group with sortOrder 9999 still comes first", () => {
    // Canonical current-asset table pins BS_CASH_EQUIVALENTS = 100.
    // If the CoA persisted sortOrder 9999 on it (data-quality
    // problem), the canonical table wins.
    const cashWeirdOrder = { fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupSortOrder: 9999 };
    const arDefault = { fsGroupKey: "BS_AR", fsGroupSortOrder: 400 };
    expect(comparePresentationOrder(cashWeirdOrder, arDefault, "current-asset"))
      .toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4) Founder's Current-Asset order end-to-end.
// ---------------------------------------------------------------------------
describe("v15.20 SoFP renders Current Assets in liquidity order", () => {
  it("Cash â†’ Sales Tax Receivable â†’ AR â†’ Member AR â†’ Inventory â†’ Prepaid â€” regardless of input order", () => {
    // Deliberately shuffle the input so insertion order does NOT
    // match the required output â€” only canonical presentation
    // order should influence the rendered sequence.
    const snapshot = makeSnapshot([
      { accountCode: "1400", accountName: "Prepaid Expenses",    category: "current-asset", fund: "operating", amount: 40_000, fsGroupKey: "BS_PREPAID_EXPENSES", fsGroupName: "Prepaid Expenses", fsGroupSortOrder: 800 },
      { accountCode: "1300", accountName: "Inventory",           category: "current-asset", fund: "operating", amount: 50_000, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 700 },
      { accountCode: "1100", accountName: "Accounts Receivable", category: "current-asset", fund: "operating", amount: 60_000, fsGroupKey: "BS_AR", fsGroupName: "Accounts Receivable", fsGroupSortOrder: 400 },
      { accountCode: "1200", accountName: "Member Receivables",  category: "current-asset", fund: "operating", amount: 70_000, fsGroupKey: "BS_MEMBER_AR", fsGroupName: "Member Receivables", fsGroupSortOrder: 500 },
      { accountCode: "1010", accountName: "Cash",                category: "current-asset", fund: "operating", amount: 80_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      // Sales Tax Receivable emerges dynamically from tax netting.
      { accountCode: "2005", accountName: "GST Collected",   category: "current-liability", fund: "operating", amount: 10_000, rawSignedAmount: -10_000, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "2006", accountName: "GST Paid (ITCs)", category: "current-liability", fund: "operating", amount: 15_000, rawSignedAmount:  15_000, fsGroupKey: "BS_SALES_TAX_PAYABLE", fsGroupName: "Sales Tax Payable", fsGroupSortOrder: 505 },
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 305_000, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$0",
    });
    const currentAssetsFsGroups = sofp.assetsRows
      .slice(
        sofp.assetsRows.findIndex((r) => r.key === "band-current-assets") + 1,
        sofp.assetsRows.findIndex((r) => r.key === "total-current-assets"),
      )
      .filter((r) => r.kind === "fs-group")
      .map((r) => r.fsGroupKey);
    expect(currentAssetsFsGroups).toEqual([
      "BS_CASH_EQUIVALENTS",
      "BS_SALES_TAX_RECEIVABLE", // dynamic tax row slots into liquidity position 300
      "BS_AR",
      "BS_MEMBER_AR",
      "BS_INVENTORY",
      "BS_PREPAID_EXPENSES",
    ]);
  });
});

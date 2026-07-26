// Founder rule 2026-07-13 v15.17 â€” Statement of Financial Position
// contra-asset treatment + Current-Year Earnings to Date.
//
// Two defects the founder flagged after v15.16 shipped:
//
//   1. Accumulated depreciation was being ADDED to Net PP&E (positive
//      summary row) instead of DEDUCTED. When the CoA doesn't yet
//      split accum. depreciation onto its own dedicated FS Group,
//      the aggregation summed all Capital Assets FS Group entries as
//      positive amounts. Result: Net PP&E inflated by 2Ã— the depr.
//      balance.
//
//   2. Current-Year Earnings to Date was absent from Members' Equity
//      even though the projection had a synthetic YTD line. The
//      previous `ytdEarningsAlreadyBooked` guard triggered on any
//      CoA account tagged BS_CURRENT_YEAR_EARNINGS â€” including empty
//      placeholder accounts â€” suppressing the synthetic line and
//      losing the YTD from the balance sheet entirely.
//
// v15.17 corrections:
//
//   â€¢ `isAccumulatedDepreciationLine()` â€” a founder-authorised
//     name-pattern detector that recognises accum. depreciation /
//     amortization accounts even when the CoA leaves them on a
//     generic Capital Assets FS Group. Wired into both the
//     projection and the read-time enrichment.
//
//   â€¢ `deriveBalanceSheetCategoryFromCoa()` accepts an `accountName`
//     input and returns `ppe-accumulated-depreciation` whenever the
//     contra pattern matches â€” regardless of any other CoA field.
//
//   â€¢ Synthetic YTD line is emitted with the founder-approved label
//     "Current-Year Earnings to Date" (or "Current-Year Deficit to
//     Date" for a negative amount).
//
//   â€¢ `ytdEarningsAlreadyBooked` now flips ONLY when the actual CoA
//     account carries a NON-ZERO balance. A zero placeholder no
//     longer suppresses the synthetic line.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  deriveBalanceSheetCategoryFromCoa,
  isAccumulatedDepreciationLine,
} from "@/lib/reporting/ledger/classification-resolver";
import {
  buildStatementOfFinancialPositionFromBalanceSheet,
  buildSilverSpringsStatementOfFinancialPosition,
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
      // v15.22 â€” auto-derive rawSignedAmount so the strict live-mode guard
      // in `normaliseSign` does not throw. Convention matches the demo seed:
      // debit-normal categories â†’ +amount; credit-normal (and contra) â†’ -amount.
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
// 1) isAccumulatedDepreciationLine â€” pattern detector.
// ---------------------------------------------------------------------------
describe("v15.17 isAccumulatedDepreciationLine â€” founder-authorised pattern detector", () => {
  it("matches standard accum-depreciation account names (case-insensitive)", () => {
    // Founder-visible screenshot names.
    expect(isAccumulatedDepreciationLine({ accountName: "Accum Deprec â€” Capital Improvements" })).toBe(true);
    expect(isAccumulatedDepreciationLine({ accountName: "Accum Deprec â€” Clubhouse" })).toBe(true);
    expect(isAccumulatedDepreciationLine({ accountName: "Accum Deprec â€” Grounds Eq & Fix" })).toBe(true);
    expect(isAccumulatedDepreciationLine({ accountName: "Accumulated Depreciation" })).toBe(true);
    expect(isAccumulatedDepreciationLine({ accountName: "accumulated depreciation" })).toBe(true);
    expect(isAccumulatedDepreciationLine({ accountName: "Accum. Deprec." })).toBe(true);
  });

  it("matches accumulated amortization (intangibles / lease liabilities)", () => {
    expect(isAccumulatedDepreciationLine({ accountName: "Accumulated Amortization" })).toBe(true);
    expect(isAccumulatedDepreciationLine({ accountName: "Accum. Amort. â€” Software" })).toBe(true);
    expect(isAccumulatedDepreciationLine({ accountName: "accum amortisation" })).toBe(true);
  });

  it("matches the FS-Group override keys (structured metadata path)", () => {
    expect(isAccumulatedDepreciationLine({ fsGroupKey: "BS_ACCUMULATED_DEPRECIATION" })).toBe(true);
    expect(isAccumulatedDepreciationLine({ fsGroupKey: "BS_ACCUMULATED_AMORTIZATION" })).toBe(true);
    expect(isAccumulatedDepreciationLine({ fsGroupKey: "BS_ACCUMULATED_DEPRECIATION_CAPITAL" })).toBe(true);
  });

  it("does NOT match unrelated capital-asset lines (no false positives)", () => {
    expect(isAccumulatedDepreciationLine({ accountName: "Land" })).toBe(false);
    expect(isAccumulatedDepreciationLine({ accountName: "Buildings â€” Clubhouse" })).toBe(false);
    expect(isAccumulatedDepreciationLine({ accountName: "Construction in Progress" })).toBe(false);
    expect(isAccumulatedDepreciationLine({ accountName: "Capital Improvements" })).toBe(false);
    expect(isAccumulatedDepreciationLine({ accountName: "Depreciation Expense" })).toBe(false);
    expect(isAccumulatedDepreciationLine({ accountName: "" })).toBe(false);
    expect(isAccumulatedDepreciationLine({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2) deriveBalanceSheetCategoryFromCoa â€” contra route.
// ---------------------------------------------------------------------------
describe("v15.17 deriveBalanceSheetCategoryFromCoa â€” contra-asset name pattern wins over CoA classification", () => {
  it("Accum Deprec on a generic Capital Assets FS Group routes to ppe-accumulated-depreciation", () => {
    // Founder's exact defect: the CoA lists accumulated depreciation
    // accounts under generic BS_CAPITAL_ASSETS or BS_BUILDINGS,
    // which without the name pattern would route to ppe-gross and
    // sum positive. Name-pattern detection forces the correct route.
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "ASSET",
        categoryKey: "CAPITAL_ASSETS",
        fsGroupKey: "BS_CAPITAL_IMPROVEMENTS",
        accountName: "Accum Deprec â€” Capital Improvements",
      }),
    ).toBe("ppe-accumulated-depreciation");
  });

  it("Accum Deprec â€” Clubhouse (screenshot example) routes to ppe-accumulated-depreciation", () => {
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "ASSET",
        categoryKey: "CAPITAL_ASSETS",
        fsGroupKey: "BS_BUILDINGS",
        accountName: "Accum Deprec â€” Clubhouse",
      }),
    ).toBe("ppe-accumulated-depreciation");
  });

  it("Land (no pattern match) still routes to ppe-gross", () => {
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "ASSET",
        categoryKey: "CAPITAL_ASSETS",
        fsGroupKey: "BS_LAND",
        accountName: "Land",
      }),
    ).toBe("ppe-gross");
  });
});

// ---------------------------------------------------------------------------
// 3) End-to-end: contra-classified snapshot reduces Net PP&E + Total Assets.
// ---------------------------------------------------------------------------
describe("v15.17 accumulated depreciation reduces Net PP&E and Total Assets", () => {
  it("balance sheet with gross PP&E $23.6M and contra $12.3M produces Net PP&E $11.3M â€” not $35.9M", () => {
    // Founder's exact scenario reconstructed. Nine gross PP&E lines
    // + seven Accum Deprec lines under `ppe-accumulated-depreciation`.
    const snapshot = makeSnapshot([
      // Gross PP&E â€” the founder's exact screenshot numbers.
      { accountCode: "1500", accountName: "Land",                                     category: "ppe-gross", fund: "capital", amount:    442_118, fsGroupKey: "BS_LAND",       fsGroupName: "Land",       fsGroupSortOrder: 200 },
      { accountCode: "1505", accountName: "Construction in Progress â€” Teeboxes",       category: "ppe-gross", fund: "capital", amount:      9_605, fsGroupKey: "BS_CIP",        fsGroupName: "Construction in Progress", fsGroupSortOrder: 205 },
      { accountCode: "1510", accountName: "Construction in Progress â€” Irrigation",     category: "ppe-gross", fund: "capital", amount:  2_481_341, fsGroupKey: "BS_CIP",        fsGroupName: "Construction in Progress", fsGroupSortOrder: 205 },
      { accountCode: "1520", accountName: "Capital Improvements",                       category: "ppe-gross", fund: "capital", amount:  3_803_961, fsGroupKey: "BS_CAPITAL_IMPROVEMENTS", fsGroupName: "Capital Improvements", fsGroupSortOrder: 210 },
      { accountCode: "1530", accountName: "Buildings â€” Clubhouse",                      category: "ppe-gross", fund: "capital", amount:  9_463_576, fsGroupKey: "BS_BUILDINGS",  fsGroupName: "Buildings",  fsGroupSortOrder: 220 },
      { accountCode: "1540", accountName: "Equipment & Fixtures â€” Clubhouse",           category: "ppe-gross", fund: "capital", amount:  2_919_360, fsGroupKey: "BS_EQUIPMENT", fsGroupName: "Equipment", fsGroupSortOrder: 230 },
      { accountCode: "1541", accountName: "Equipment & Fixtures â€” Grounds",             category: "ppe-gross", fund: "capital", amount:  2_614_584, fsGroupKey: "BS_EQUIPMENT", fsGroupName: "Equipment", fsGroupSortOrder: 230 },
      { accountCode: "1542", accountName: "Equipment & Fixtures â€” Computers",           category: "ppe-gross", fund: "capital", amount:    253_024, fsGroupKey: "BS_EQUIPMENT", fsGroupName: "Equipment", fsGroupSortOrder: 230 },
      { accountCode: "1550", accountName: "Equipment under financing",                  category: "ppe-gross", fund: "capital", amount:  1_613_371, fsGroupKey: "BS_EQUIPMENT", fsGroupName: "Equipment", fsGroupSortOrder: 230 },

      // Accum Deprec â€” same names as the founder's screenshot.
      { accountCode: "1590", accountName: "Accum Deprec â€” Capital Improvements",       category: "ppe-accumulated-depreciation", fund: "capital", amount: 3_132_037, fsGroupKey: "BS_ACCUMULATED_DEPRECIATION", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },
      { accountCode: "1591", accountName: "Accum Deprec â€” Clubhouse",                  category: "ppe-accumulated-depreciation", fund: "capital", amount: 4_065_304, fsGroupKey: "BS_ACCUMULATED_DEPRECIATION", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },
      { accountCode: "1592", accountName: "Accum Deprec â€” Clubhouse Eq & Fix",         category: "ppe-accumulated-depreciation", fund: "capital", amount: 2_066_320, fsGroupKey: "BS_ACCUMULATED_DEPRECIATION", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },
      { accountCode: "1593", accountName: "Accum Deprec â€” Grounds Eq & Fix",           category: "ppe-accumulated-depreciation", fund: "capital", amount: 1_804_833, fsGroupKey: "BS_ACCUMULATED_DEPRECIATION", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },
      { accountCode: "1594", accountName: "Accum Deprec â€” Computer Eq & Fix",          category: "ppe-accumulated-depreciation", fund: "capital", amount:   157_850, fsGroupKey: "BS_ACCUMULATED_DEPRECIATION", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },
      { accountCode: "1595", accountName: "Accum Deprec â€” Equip under financing",      category: "ppe-accumulated-depreciation", fund: "capital", amount: 1_037_823, fsGroupKey: "BS_ACCUMULATED_DEPRECIATION", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },
      { accountCode: "1596", accountName: "Accum Deprec â€” Irrigation",                 category: "ppe-accumulated-depreciation", fund: "capital", amount:     6_203, fsGroupKey: "BS_ACCUMULATED_DEPRECIATION", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },

      // Balancing equity so we can assert reconciliation.
      // Gross PP&E = 23,600,940. Accum. Depr = 12,270,370.
      // Net PP&E = 11,330,570. Balancing equity = 11,330,570.
      { accountCode: "3010", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 11_330_570, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$25M",
    });
    // Net PP&E = 23,600,940 - 12,270,370 = 11,330,570
    const netPpeRow = sofp.assetsRows.find((r) => r.key === "net-ppe");
    expect(netPpeRow?.current).toBe(11_330_570);
    // Total Assets = 0 (current) + 0 (capital-fund) + 11,330,570 (Net PP&E)
    expect(sofp.reconciliation.totalAssetsCurrent).toBe(11_330_570);
    // Reconciles to the balancing equity.
    expect(sofp.reconciliation.balances).toBe(true);
  });

  it("Accumulated Depreciation summary row displays as NEGATIVE (parentheses via presenter)", () => {
    const snapshot = makeSnapshot([
      { accountCode: "1500", accountName: "Land",                       category: "ppe-gross",                       fund: "capital", amount: 10_000_000, fsGroupKey: "BS_LAND", fsGroupName: "Land", fsGroupSortOrder: 200 },
      { accountCode: "1590", accountName: "Accum Deprec â€” Capital",     category: "ppe-accumulated-depreciation",    fund: "capital", amount:  3_000_000, fsGroupKey: "BS_ACCUMULATED_DEPRECIATION", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },
      { accountCode: "3010", accountName: "Retained Earnings",          category: "operating-fund-balance",           fund: "operating", amount:  7_000_000, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$10M",
    });
    const accumRow = sofp.assetsRows.find((r) => r.fsGroupKey === "BS_ACCUMULATED_DEPRECIATION");
    expect(accumRow?.current).toBe(-3_000_000);
  });
});

// ---------------------------------------------------------------------------
// 4) Current-Year Earnings to Date â€” synthetic line labels + duplicate guard.
// ---------------------------------------------------------------------------
describe("v15.17 Current-Year Earnings to Date â€” projection labels + duplicate protection", () => {
  const projection = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/reporting/ledger/projections/balance-sheet-projection.ts"),
    "utf8",
  );

  it("synthetic YTD line uses founder-approved label for surplus", () => {
    expect(projection).toMatch(/"Current-Year Earnings to Date"/);
  });
  it("synthetic YTD line uses founder-approved label for deficit", () => {
    expect(projection).toMatch(/"Current-Year Deficit to Date"/);
  });
  it("synthetic YTD line branches label based on the sign of computedYtdNetIncome", () => {
    expect(projection).toMatch(/const isDeficit = computedYtdNetIncome < 0/);
    expect(projection).toMatch(/isDeficit\s*\?\s*"Current-Year Deficit to Date"\s*:\s*"Current-Year Earnings to Date"/);
  });

  it("ytdEarningsAlreadyBooked flag only trips when the actual account has NON-ZERO balance", () => {
    // Founder's exact defect: a zero-balance BS_CURRENT_YEAR_EARNINGS
    // placeholder account was suppressing the synthetic line and
    // losing the YTD from the balance sheet.
    expect(projection).toMatch(/Math\.abs\(line\.endingBalance\) >= 1/);
    // The flag flip must still require BS_CURRENT_YEAR_EARNINGS.
    expect(projection).toMatch(
      /coa\?\.\s*fsGroupKey\?\.\s*toUpperCase\(\)\s*===\s*"BS_CURRENT_YEAR_EARNINGS"/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5) Silver Springs demo â€” no regression on labels + reconciliation.
// ---------------------------------------------------------------------------
describe("v15.17 Silver Springs demo â€” label + reconciliation invariants held", () => {
  it("YTD row renders under the founder-approved label", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({
      clubName: "Silver Springs",
      period: MAY_2026,
    });
    const ytdRow = sofp.liabilitiesEquityRows.find(
      (r) => r.fsGroupKey === "BS_CURRENT_YEAR_EARNINGS",
    );
    expect(ytdRow?.label).toBe("Current-Year Earnings to Date");
  });

  it("Silver Springs reconciles (no regression from v15.16)", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({
      clubName: "Silver Springs",
      period: MAY_2026,
    });
    expect(sofp.reconciliation.balances).toBe(true);
  });

  it("displayed liability + equity rows sum to Total Liabilities + Members' Equity (retained earnings + current-year + other)", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({
      clubName: "Silver Springs",
      period: MAY_2026,
    });
    let visibleSum = 0;
    for (const row of sofp.liabilitiesEquityRows) {
      if (row.kind === "fs-group" && typeof row.current === "number") {
        visibleSum += row.current;
      }
    }
    expect(Math.abs(visibleSum - sofp.reconciliation.totalLiabilitiesAndEquityCurrent)).toBeLessThan(1);
  });
});

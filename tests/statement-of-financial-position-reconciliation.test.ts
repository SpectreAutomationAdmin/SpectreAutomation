// Founder rule 2026-07-13 v15.16 â€” Statement of Financial Position
// must reconcile to the balanced Trial Balance.
//
// Root cause of the $26.6M mismatch reported after v15.15: the
// projection derived `BalanceSheetCategory` (the section enum that
// decides current-asset vs. ppe-gross vs. current-liability etc.)
// from account-number ranges. Live Silver Springs data has PP&E and
// equity accounts numbered outside the standard 1900-1999 / 3000-3999
// ranges, so PP&E balances leaked into current-asset (inflating
// Total Assets) while non-retained-earnings equity balances were
// mis-sectioned and never surfaced under Members' Equity.
//
// v15.16 makes `BalanceSheetCategory` derive from CoA classification
// (accountType + categoryKey + fsGroupKey) rather than account
// number. This suite locks the invariants required to prove the
// Statement of Financial Position reconciles under a wide range of
// TB inputs.

import { describe, it, expect } from "vitest";

import {
  buildStatementOfFinancialPositionFromBalanceSheet,
  buildSilverSpringsStatementOfFinancialPosition,
} from "@/lib/reporting/statement-of-financial-position";
import { deriveBalanceSheetCategoryFromCoa } from "@/lib/reporting/ledger/classification-resolver";
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
// 1) deriveBalanceSheetCategoryFromCoa â€” pure function tests
// ---------------------------------------------------------------------------
describe("v15.16 deriveBalanceSheetCategoryFromCoa â€” CoA classification decides section", () => {
  it("Accumulated Depreciation FS Group overrides Category â€” routes to ppe-accumulated-depreciation", () => {
    // Some COAs put accum. depreciation under CURRENT_ASSETS (a
    // contra-asset). The FS-Group signal takes precedence so those
    // balances still reduce PP&E.
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "ASSET",
        categoryKey: "CURRENT_ASSETS",
        fsGroupKey: "BS_ACCUMULATED_DEPRECIATION",
      }),
    ).toBe("ppe-accumulated-depreciation");
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "ASSET",
        categoryKey: "CAPITAL_ASSETS",
        fsGroupKey: "BS_ACCUMULATED_DEPRECIATION",
      }),
    ).toBe("ppe-accumulated-depreciation");
  });

  it("BS_CURRENT_YEAR_EARNINGS routes to ytd-net-income regardless of Category", () => {
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "EQUITY",
        categoryKey: "EQUITY",
        fsGroupKey: "BS_CURRENT_YEAR_EARNINGS",
      }),
    ).toBe("ytd-net-income");
  });

  it("BS_CAPITAL_RESERVE routes to capital-fund-balance regardless of Category", () => {
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "EQUITY",
        categoryKey: "EQUITY",
        fsGroupKey: "BS_CAPITAL_RESERVE",
      }),
    ).toBe("capital-fund-balance");
  });

  it("Category CURRENT_ASSETS -> current-asset (regardless of account number range)", () => {
    // Founder's scenario: live account numbered 1508 with
    // categoryKey CURRENT_ASSETS. Old range-based mapper put this
    // in current-asset only if the number fell inside 1000-1799.
    // CoA-driven derivation succeeds independent of the number.
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "ASSET",
        categoryKey: "CURRENT_ASSETS",
        fsGroupKey: "BS_INVENTORY",
      }),
    ).toBe("current-asset");
  });

  it("Category CAPITAL_ASSETS -> ppe-gross (this is the founder's PP&E-missing scenario)", () => {
    // Live PP&E accounts often numbered 1500-1900 (below the
    // 1900-1999 range). Old mapper misclassified as current-asset.
    // CoA-driven derivation correctly routes to ppe-gross.
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "ASSET",
        categoryKey: "CAPITAL_ASSETS",
        fsGroupKey: "BS_LAND",
      }),
    ).toBe("ppe-gross");
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "ASSET",
        categoryKey: "CAPITAL_ASSETS",
        fsGroupKey: "BS_BUILDINGS",
      }),
    ).toBe("ppe-gross");
  });

  it("Category CURRENT_LIABILITIES -> current-liability, LONG_TERM_LIABILITIES -> long-term-liability", () => {
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "LIABILITY",
        categoryKey: "CURRENT_LIABILITIES",
        fsGroupKey: "BS_AP",
      }),
    ).toBe("current-liability");
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "LIABILITY",
        categoryKey: "LONG_TERM_LIABILITIES",
        fsGroupKey: "BS_LONG_TERM_DEBT",
      }),
    ).toBe("long-term-liability");
  });

  it("EQUITY with a known Category routes to operating-fund-balance (catches share capital, contributed capital, opening equity)", () => {
    // Founder's scenario: multiple equity accounts beyond retained
    // earnings â€” share capital, contributed capital, opening
    // members' equity â€” that previously fell OUTSIDE the 3000-3999
    // range and were lost. When the CoA has a Category assigned,
    // the derivation routes to operating-fund-balance so they
    // render under Members' Equity.
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "EQUITY",
        categoryKey: "EQUITY",
        fsGroupKey: "BS_SHARE_CAPITAL",
      }),
    ).toBe("operating-fund-balance");
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "EQUITY",
        categoryKey: "EQUITY",
        fsGroupKey: "BS_RETAINED_EARNINGS",
      }),
    ).toBe("operating-fund-balance");
  });

  it("STRICT â€” returns null when the CoA has no Category assigned so the caller can fall back to legacy range mapping", () => {
    // Founder rule: don't invent a section when the CoA is thin.
    // Return null so the legacy range-based mapping runs. This
    // preserves pre-v15.16 behaviour for test fixtures + TB
    // importers that haven't seeded the CoA side yet.
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: null,
        categoryKey: null,
        fsGroupKey: null,
      }),
    ).toBeNull();
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "UNKNOWN",
        categoryKey: null,
        fsGroupKey: null,
      }),
    ).toBeNull();
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "ASSET",
        categoryKey: null, // no Category on the CoA
        fsGroupKey: null,
      }),
    ).toBeNull();
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "LIABILITY",
        categoryKey: null,
        fsGroupKey: null,
      }),
    ).toBeNull();
    expect(
      deriveBalanceSheetCategoryFromCoa({
        accountType: "EQUITY",
        categoryKey: null,
        fsGroupKey: null,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2) End-to-end reconciliation of a CoA-classified snapshot.
// ---------------------------------------------------------------------------
describe("v15.16 reconciliation invariants â€” Total Assets = Total Liabilities + Members' Equity", () => {
  it("Silver Springs demo reconciles (baseline sanity)", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({
      clubName: "Silver Springs",
      period: MAY_2026,
    });
    expect(sofp.reconciliation.balances).toBe(true);
    expect(Math.abs(sofp.reconciliation.difference)).toBeLessThan(1);
  });

  it("displayed asset FS-Group rows sum to Total Assets (no invisible pre-rolled inflation)", () => {
    // Founder's exact defect: pre-rolled Total Assets included
    // PP&E balances that were hidden inside a misclassified
    // current-asset row. This test proves the DISPLAYED asset rows
    // sum to the DISPLAYED Total Assets â€” no invisible source.
    const sofp = buildSilverSpringsStatementOfFinancialPosition({
      clubName: "Silver Springs",
      period: MAY_2026,
    });
    const totalAssets = sofp.reconciliation.totalAssetsCurrent;
    // Sum every fs-group + accum-depr row across the assets side
    // and confirm it matches the reconciliation Total Assets.
    let visibleAssetSum = 0;
    for (const row of sofp.assetsRows) {
      if (row.kind === "fs-group" && typeof row.current === "number") {
        visibleAssetSum += row.current;
      }
    }
    // Small tolerance for floating-point rounding across ~25 rows.
    expect(Math.abs(visibleAssetSum - totalAssets)).toBeLessThan(1);
  });

  it("liability + equity displayed rows sum to Total Liabilities + Members' Equity", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({
      clubName: "Silver Springs",
      period: MAY_2026,
    });
    let visibleLiabEqSum = 0;
    for (const row of sofp.liabilitiesEquityRows) {
      if (row.kind === "fs-group" && typeof row.current === "number") {
        visibleLiabEqSum += row.current;
      }
    }
    expect(Math.abs(visibleLiabEqSum - sofp.reconciliation.totalLiabilitiesAndEquityCurrent)).toBeLessThan(1);
  });

  it("v15.16 reconciliation diagnostics â€” payload exposes difference / totalLiabilities / totalEquity", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({
      clubName: "Silver Springs",
      period: MAY_2026,
    });
    expect(typeof sofp.reconciliation.difference).toBe("number");
    expect(typeof sofp.reconciliation.totalLiabilitiesCurrent).toBe("number");
    expect(typeof sofp.reconciliation.totalEquityCurrent).toBe("number");
    // Total Liabilities + Total Equity must equal
    // totalLiabilitiesAndEquityCurrent (identity check).
    expect(
      Math.abs(
        sofp.reconciliation.totalLiabilitiesCurrent +
          sofp.reconciliation.totalEquityCurrent -
          sofp.reconciliation.totalLiabilitiesAndEquityCurrent,
      ),
    ).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// 3) Founder's scenario: PP&E outside 1900-1999 range MUST reach the PP&E
// section under v15.16 (was misclassified as current-asset pre-v15.16).
// ---------------------------------------------------------------------------
describe("v15.16 founder scenario â€” PP&E accounts numbered outside 1900-1999 reach ppe-gross", () => {
  it("a synthetic snapshot with PP&E lines pre-classified via v15.16 CoA fields reconciles to Net PP&E", () => {
    // Simulates the exact defect: PP&E balances totalling $28M
    // with account numbers OUTSIDE the range-mapper's 1900-1999
    // window, but with CoA classification (`ppe-gross` category +
    // BS_LAND / BS_BUILDINGS FS Group). The snapshot uses the
    // CoA-derived category directly so the SoFP builder aggregates
    // it under Property, Plant & Equipment.
    const snapshot = makeSnapshot([
      { accountCode: "1500", accountName: "Land",       category: "ppe-gross", fund: "capital", amount:  8_000_000, fsGroupKey: "BS_LAND",       fsGroupName: "Land",       fsGroupSortOrder: 200 },
      { accountCode: "1520", accountName: "Buildings",  category: "ppe-gross", fund: "capital", amount: 15_000_000, fsGroupKey: "BS_BUILDINGS",  fsGroupName: "Buildings",  fsGroupSortOrder: 210 },
      { accountCode: "1540", accountName: "Equipment",  category: "ppe-gross", fund: "capital", amount:  5_000_000, fsGroupKey: "BS_EQUIPMENT",  fsGroupName: "Equipment",  fsGroupSortOrder: 220 },
      { accountCode: "1590", accountName: "Accum. Depreciation", category: "ppe-accumulated-depreciation", fund: "capital", amount: 10_000_000, fsGroupKey: "BS_ACCUMULATED_DEPRECIATION", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },
      // A single equity line to balance the sheet: 18_000_000 in
      // equity = 28M gross - 10M accum. depr. = 18M net assets.
      { accountCode: "3010", accountName: "Members' Equity", category: "operating-fund-balance", fund: "operating", amount: 18_000_000, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$28M",
    });
    // Net PP&E = 28M gross - 10M accum. depr. = 18M
    const netPpeRow = sofp.assetsRows.find((r) => r.key === "net-ppe");
    expect(netPpeRow?.current).toBe(18_000_000);
    // Total Assets = 0 (current) + 0 (capital-fund) + 18M (Net PP&E) = 18M
    expect(sofp.reconciliation.totalAssetsCurrent).toBe(18_000_000);
    // Reconciles.
    expect(sofp.reconciliation.balances).toBe(true);
  });

  it("multiple equity FS Groups all render under Members' Equity (was: only Retained Earnings visible)", () => {
    // Founder scenario: live COA has share capital, contributed
    // capital, opening equity â€” pre-v15.16 these fell outside the
    // 3000-3999 range and were lost. v15.16 routes every EQUITY
    // account with a valid FS Group to operating-fund-balance so
    // it renders under Members' Equity.
    const snapshot = makeSnapshot([
      { accountCode: "1010", accountName: "Cash", category: "current-asset", fund: "operating", amount: 12_000_000, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
      { accountCode: "3010", accountName: "Members' Share Capital", category: "operating-fund-balance", fund: "operating", amount: 5_000_000, fsGroupKey: "BS_SHARE_CAPITAL", fsGroupName: "Members' Share Capital", fsGroupSortOrder: 790 },
      { accountCode: "3020", accountName: "Contributed Capital", category: "operating-fund-balance", fund: "operating", amount: 4_000_000, fsGroupKey: "BS_CONTRIBUTED_CAPITAL", fsGroupName: "Contributed Capital", fsGroupSortOrder: 795 },
      { accountCode: "3030", accountName: "Retained Earnings", category: "operating-fund-balance", fund: "operating", amount: 3_000_000, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Retained Earnings", fsGroupSortOrder: 800 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$1M",
    });
    // Every equity FS Group renders as its own summary row
    // (previously: only Retained Earnings appeared).
    const equityFsGroups = sofp.liabilitiesEquityRows.filter(
      (r) => r.kind === "fs-group" &&
        ["BS_SHARE_CAPITAL", "BS_CONTRIBUTED_CAPITAL", "BS_RETAINED_EARNINGS"].includes(r.fsGroupKey ?? ""),
    );
    expect(equityFsGroups).toHaveLength(3);
    // Total Members' Equity = 5M + 4M + 3M = 12M
    expect(sofp.reconciliation.totalEquityCurrent).toBe(12_000_000);
    // Balance sheet reconciles: 12M cash = 0 liabilities + 12M equity
    expect(sofp.reconciliation.balances).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4) Reconciliation banner + publication guard â€” source-contract tests.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
describe("v15.16 reconciliation banner + publication guard â€” source contract", () => {
  const monthlyBody = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx"),
    "utf8",
  );
  const lifecycle = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/reporting/monthly-package-lifecycle.ts"),
    "utf8",
  );

  it("SoFP renderer surfaces an out-of-balance banner when `reconciliation.balances` is false", () => {
    expect(monthlyBody).toMatch(/sofp-out-of-balance-banner/);
    expect(monthlyBody).toMatch(/!sofp\.reconciliation\.balances/);
    // The banner must show all three numeric fields the payload
    // exposes so the operator can size the defect.
    expect(monthlyBody).toMatch(/reconciliation\.totalAssetsCurrent/);
    expect(monthlyBody).toMatch(/reconciliation\.totalLiabilitiesAndEquityCurrent/);
    expect(monthlyBody).toMatch(/reconciliation\.difference/);
  });

  it("publish path refuses to freeze an out-of-balance package (BALANCE_SHEET_OUT_OF_BALANCE)", () => {
    expect(lifecycle).toMatch(/BALANCE_SHEET_OUT_OF_BALANCE/);
    // The guard must fire BEFORE `packagePayloadJson: JSON.stringify(...)`
    // so no serialised payload can carry an out-of-balance snapshot
    // into the archive.
    const guardIndex = lifecycle.indexOf("BALANCE_SHEET_OUT_OF_BALANCE");
    const freezeIndex = lifecycle.indexOf("packagePayloadJson: JSON.stringify(packagePayload)");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(freezeIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(freezeIndex);
  });

  it("guard error message names Total Assets, Total L+E, and Difference for operator triage", () => {
    expect(lifecycle).toMatch(/Total Assets \$\$\{/);
    expect(lifecycle).toMatch(/Total Liabilities \+ Members' Equity/);
    expect(lifecycle).toMatch(/Difference \$\$\{/);
  });
});

// ---------------------------------------------------------------------------
// 5) YTD net income double-count prevention (closing entries booked).
// ---------------------------------------------------------------------------
describe("v15.16 projection skips synthetic YTD net income when TB already carries a BS_CURRENT_YEAR_EARNINGS account", () => {
  const projection = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/reporting/ledger/projections/balance-sheet-projection.ts"),
    "utf8",
  );
  it("projection tracks `ytdEarningsAlreadyBooked` flag", () => {
    expect(projection).toMatch(/let ytdEarningsAlreadyBooked = false/);
  });
  it("flag flips when an account whose fsGroupKey === BS_CURRENT_YEAR_EARNINGS appears in the TB", () => {
    expect(projection).toMatch(
      /coa\?\.\s*fsGroupKey\?\.\s*toUpperCase\(\)\s*===\s*"BS_CURRENT_YEAR_EARNINGS"[\s\S]{0,80}ytdEarningsAlreadyBooked\s*=\s*true/,
    );
  });
  it("synthetic YTD net income line is skipped when the flag is true", () => {
    expect(projection).toMatch(/!ytdEarningsAlreadyBooked/);
  });
});

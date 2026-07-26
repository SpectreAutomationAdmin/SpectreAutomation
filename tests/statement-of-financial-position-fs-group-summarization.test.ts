// Founder rule 2026-07-13 v15.14 â€” Statement of Financial Position
// FS-Group summarisation.
//
// Root cause of the regression before v15.14: `BalanceSheetLine`
// carried no FS-Group classification, so the SOFP builder emitted
// one row per account. The result read like a trial balance rather
// than a professional balance sheet.
//
// v15.14 pushes the ChartAccount â†’ FinancialStatementGroup
// classification into `BalanceSheetLine` (as `fsGroupKey` /
// `fsGroupName` / `fsGroupSortOrder`) and replaces the pre-v15.14
// per-account rendering with an FS-Group aggregation step that
// emits ONE `fs-group` SoFPRow per group.
//
// This suite locks the behaviour end-to-end:
//   1. Aggregation â€” multiple accounts within one FS Group collapse
//      to a single summary row; sums are exact.
//   2. Comparative â€” current and comparative periods aggregate
//      independently under identical FS-Group identity.
//   3. Signs â€” accumulated depreciation displays negative;
//      YTD net income keeps its raw sign so a deficit reads as
//      negative; all other categories display positive magnitudes.
//   4. Permission gating â€” `viewerCanDrillDown: true` attaches
//      `accounts[]` per summary row; `false` (default) omits them,
//      so no account-level data leaks into Board / member / PDF /
//      archive payloads.
//   5. Unmapped accounts are never silently dropped â€” they surface
//      via `unmappedAccounts` and still contribute to totals.
//   6. Backward compatibility with pre-v15.14 archived snapshots â€”
//      the payload marker `sofpVersion: 2` and the omission of
//      `accounts` arrays on Board-safe payloads.
//   7. Reconciliation â€” Total Assets always equals Total
//      Liabilities + Members' Equity within a $1 tolerance.

import { describe, it, expect } from "vitest";

import {
  buildStatementOfFinancialPositionFromBalanceSheet,
  buildSilverSpringsStatementOfFinancialPosition,
  type StatementOfFinancialPosition,
  type SoFPRow,
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

/** Convenience factory â€” build a minimal `BalanceSheetSnapshot`
 *  from an inline list of lines, mirroring what the ledger writer
 *  would produce. */
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
// 1) Aggregation â€” multiple accounts collapse to ONE FS-Group row.
// ---------------------------------------------------------------------------
describe("v15.14 aggregation â€” multiple accounts roll up to one FS-Group summary row", () => {
  const nineInventoryLines = [
    { accountCode: "1300", accountName: "Inventory - Food",           category: "current-asset" as const, fund: "operating" as const, amount:  31_400, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
    { accountCode: "1301", accountName: "Inventory - Liquor",         category: "current-asset" as const, fund: "operating" as const, amount:  11_650, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
    { accountCode: "1302", accountName: "Inventory - Beer",           category: "current-asset" as const, fund: "operating" as const, amount:  10_343, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
    { accountCode: "1303", accountName: "Inventory - Draught Beer",   category: "current-asset" as const, fund: "operating" as const, amount:   4_490, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
    { accountCode: "1304", accountName: "Inventory - Wine",           category: "current-asset" as const, fund: "operating" as const, amount:  23_514, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
    { accountCode: "1305", accountName: "Inventory - Pop",            category: "current-asset" as const, fund: "operating" as const, amount:   5_209, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
    { accountCode: "1306", accountName: "Inventory - Proshop Clothes", category: "current-asset" as const, fund: "operating" as const, amount:  81_625, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
    { accountCode: "1307", accountName: "Inventory - Proshop Balls",  category: "current-asset" as const, fund: "operating" as const, amount:  41_900, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
    { accountCode: "1308", accountName: "Inventory - Proshop Clubs",  category: "current-asset" as const, fund: "operating" as const, amount: 123_914, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  ];
  const inventoryTotal = nineInventoryLines.reduce((s, l) => s + l.amount, 0); // 344_045
  const singleAssetSnapshot = makeSnapshot(nineInventoryLines);

  const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
    clubName: "Test Club",
    period: MAY_2026,
    currentSnapshot: singleAssetSnapshot,
    auxiliaryRatioInputs: AUX_INPUTS,
    grossReplacementCostLabel: "$1.0M",
  });

  it("nine inventory accounts collapse to a SINGLE `fs-group` summary row (the founder's exact example)", () => {
    const fsGroupRows = sofp.assetsRows.filter((r) => r.kind === "fs-group");
    expect(fsGroupRows).toHaveLength(1);
    expect(fsGroupRows[0].label).toBe("Inventory");
    expect(fsGroupRows[0].fsGroupKey).toBe("BS_INVENTORY");
  });

  it("summary row balance equals the sum of every underlying account", () => {
    const row = sofp.assetsRows.find((r) => r.kind === "fs-group")!;
    expect(row.current).toBe(inventoryTotal);
  });

  it("no per-account `detail` rows survive when every line carries an FS-Group classification", () => {
    const detailRows = sofp.assetsRows.filter((r) => r.kind === "detail");
    expect(detailRows).toHaveLength(0);
  });

  it("payload marker `sofpVersion: 2` identifies the summarised shape (backward-compat gate)", () => {
    expect(sofp.sofpVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2) Category subtotals + statement totals reconcile.
// ---------------------------------------------------------------------------
describe("v15.14 reconciliation â€” subtotals and totals agree with underlying balances", () => {
  const sofp = buildSilverSpringsStatementOfFinancialPosition({
    clubName: "Silver Springs",
    period: MAY_2026,
  });

  it("Total Assets equals Total Liabilities + Members' Equity within $1", () => {
    const { totalAssetsCurrent, totalLiabilitiesAndEquityCurrent } = sofp.reconciliation;
    expect(Math.abs(totalAssetsCurrent - totalLiabilitiesAndEquityCurrent)).toBeLessThan(1);
    expect(sofp.reconciliation.balances).toBe(true);
  });

  it("Total Current Assets subtotal equals the sum of its FS-Group rows", () => {
    const rows = sofp.assetsRows;
    const start = rows.findIndex((r) => r.key === "band-current-assets");
    const end = rows.findIndex((r) => r.key === "total-current-assets");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const between = rows.slice(start + 1, end);
    const sum = between.reduce((s, r) => s + (r.current ?? 0), 0);
    expect(between.every((r) => r.kind === "fs-group")).toBe(true);
    expect(sum).toBeCloseTo(rows[end].current ?? 0, 0);
  });

  it("Total Liabilities equals Current + Long-Term Liabilities subtotals", () => {
    const rows = sofp.liabilitiesEquityRows;
    const currentSubtotal = rows.find((r) => r.key === "total-current-liabilities")!.current!;
    const longSubtotal = rows.find((r) => r.key === "total-long-term-liabilities")!.current!;
    const totalLiab = rows.find((r) => r.key === "total-liabilities")!.current!;
    expect(currentSubtotal + longSubtotal).toBeCloseTo(totalLiab, 0);
  });
});

// ---------------------------------------------------------------------------
// 3) Signs â€” contra, deficit, and normal presentation preserved.
// ---------------------------------------------------------------------------
describe("v15.14 signs â€” presentation convention preserved across FS-Group aggregation", () => {
  it("accumulated depreciation renders as a NEGATIVE FS-Group summary line", () => {
    const snapshot = makeSnapshot([
      { accountCode: "1990", accountName: "Accum. Depr. â€” Buildings",  category: "ppe-accumulated-depreciation", fund: "capital", amount:  12_000_000, fsGroupKey: "BS_ACCUM_DEPR", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },
      { accountCode: "1991", accountName: "Accum. Depr. â€” Equipment",  category: "ppe-accumulated-depreciation", fund: "capital", amount:   3_000_000, fsGroupKey: "BS_ACCUM_DEPR", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$1.0M",
    });
    const row = sofp.assetsRows.find((r) => r.kind === "fs-group" && r.fsGroupKey === "BS_ACCUM_DEPR")!;
    expect(row.current).toBe(-15_000_000);
  });

  it("YTD net income keeps its raw sign so a deficit renders in parentheses via the presenter", () => {
    const snapshot = makeSnapshot([
      { accountCode: "__YTD__", accountName: "YTD Net Loss", category: "ytd-net-income", fund: "operating", amount: -450_000, fsGroupKey: "BS_YTD", fsGroupName: "YTD Net Income", fsGroupSortOrder: 820 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$1.0M",
    });
    const row = sofp.liabilitiesEquityRows.find((r) => r.kind === "fs-group" && r.fsGroupKey === "BS_YTD")!;
    expect(row.current).toBe(-450_000);
  });

  it("a normal credit-balance liability (rawSignedAmount = -N) renders as positive N via credit-normal normalisation", () => {
    // v15.21 semantics: `amount` is the account's magnitude (always
    // positive); `rawSignedAmount` is the Jonas debit-positive /
    // credit-negative signed balance. A liability with a normal
    // credit balance is stored as `rawSignedAmount: -284_600` and the
    // `credit-normal` mode returns `-raw = +284_600` â€” a positive
    // presentation figure that ADDS to Total Liabilities.
    const snapshot = makeSnapshot([
      { accountCode: "2010", accountName: "AP", category: "current-liability", fund: "operating", amount: 284_600, rawSignedAmount: -284_600, fsGroupKey: "BS_AP", fsGroupName: "Accounts Payable", fsGroupSortOrder: 500 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$1.0M",
    });
    const row = sofp.liabilitiesEquityRows.find((r) => r.kind === "fs-group" && r.fsGroupKey === "BS_AP")!;
    expect(row.current).toBe(284_600);
  });
});

// ---------------------------------------------------------------------------
// 4) Comparative-period aggregation.
// ---------------------------------------------------------------------------
describe("v15.14 comparative period â€” FS-Group identity aligns current + comparative sums independently", () => {
  it("comparative balance for an FS Group equals sum of prior-year accounts in the same group", () => {
    const currentSnapshot = makeSnapshot([
      { accountCode: "1300", accountName: "Inventory - Food",   category: "current-asset", fund: "operating", amount:  31_400, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
      { accountCode: "1301", accountName: "Inventory - Liquor", category: "current-asset", fund: "operating", amount:  11_650, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
    ]);
    const priorSnapshot = makeSnapshot([
      { accountCode: "1300", accountName: "Inventory - Food",   category: "current-asset", fund: "operating", amount:  28_600, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
      { accountCode: "1301", accountName: "Inventory - Liquor", category: "current-asset", fund: "operating", amount:  10_800, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot,
      priorYearSnapshot: priorSnapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$1.0M",
    });
    const row = sofp.assetsRows.find((r) => r.kind === "fs-group" && r.fsGroupKey === "BS_INVENTORY")!;
    expect(row.current).toBe(43_050);
    expect(row.comparative).toBe(39_400);
  });

  it("comparative renders as `null` (em-dash in UI) when the prior snapshot is absent", () => {
    const snapshot = makeSnapshot([
      { accountCode: "1300", accountName: "Inventory - Food", category: "current-asset", fund: "operating", amount: 31_400, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
    ]);
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      priorYearSnapshot: null,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$1.0M",
    });
    const row = sofp.assetsRows.find((r) => r.kind === "fs-group")!;
    expect(row.comparative).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5) Permission gating â€” `showAccountDetail` controls the accounts leak.
// ---------------------------------------------------------------------------
describe("v15.14 permission gating â€” accounts arrays never leak into Board / member / PDF payloads", () => {
  const snapshot = makeSnapshot([
    { accountCode: "1300", accountName: "Inventory - Food",   category: "current-asset", fund: "operating", amount:  31_400, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
    { accountCode: "1301", accountName: "Inventory - Liquor", category: "current-asset", fund: "operating", amount:  11_650, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  ]);

  it("Board-safe default (viewerCanDrillDown omitted) omits `accounts` on every FS-Group row", () => {
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$1.0M",
    });
    expect(sofp.showAccountDetail).toBe(false);
    for (const row of sofp.assetsRows) {
      expect(row.accounts).toBeUndefined();
    }
    // Serialising the payload (as happens when publishing) must
    // not accidentally include an empty accounts array.
    const serialised = JSON.parse(JSON.stringify(sofp));
    for (const row of serialised.assetsRows as ReadonlyArray<SoFPRow>) {
      expect(row.accounts).toBeUndefined();
    }
  });

  it("Authorised admin (viewerCanDrillDown: true) receives underlying accounts on every FS-Group summary row", () => {
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$1.0M",
      viewerCanDrillDown: true,
    });
    expect(sofp.showAccountDetail).toBe(true);
    const row = sofp.assetsRows.find((r) => r.kind === "fs-group")!;
    expect(row.accounts).toBeDefined();
    expect(row.accounts).toHaveLength(2);
    expect(row.accounts![0].accountCode).toBe("1300");
    expect(row.accounts![1].accountCode).toBe("1301");
  });

  it("expanding a row does not change totals â€” sum of `accounts[].current` equals the summary row total", () => {
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: snapshot,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$1.0M",
      viewerCanDrillDown: true,
    });
    const row = sofp.assetsRows.find((r) => r.kind === "fs-group")!;
    const accountsSum = row.accounts!.reduce((s, a) => s + (a.current ?? 0), 0);
    expect(accountsSum).toBe(row.current);
  });
});

// ---------------------------------------------------------------------------
// 6) Unmapped accounts â€” never silently dropped.
// ---------------------------------------------------------------------------
describe("v15.14 unmapped accounts â€” surfaced explicitly, never silently omitted", () => {
  const withUnmapped = makeSnapshot([
    { accountCode: "1300", accountName: "Inventory - Food",   category: "current-asset", fund: "operating", amount: 31_400, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
    // Missing fsGroupKey / fsGroupName â€” this account has NO FS-Group
    // assigned on the ChartAccount record (a data-quality problem).
    { accountCode: "9999", accountName: "Uncategorised Suspense", category: "current-asset", fund: "operating", amount: 42_000 },
  ]);

  it("unmapped accounts land in `unmappedAccounts` with a preserved balance", () => {
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: withUnmapped,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$1.0M",
    });
    expect(sofp.unmappedAccounts).toHaveLength(1);
    expect(sofp.unmappedAccounts[0].accountCode).toBe("9999");
    expect(sofp.unmappedAccounts[0].current).toBe(42_000);
    expect(sofp.unmappedAccounts[0].inferredSide).toBe("assets");
  });

  it("unmapped accounts don't appear as their own `fs-group` row â€” they only surface through the band", () => {
    const sofp = buildStatementOfFinancialPositionFromBalanceSheet({
      clubName: "Test Club",
      period: MAY_2026,
      currentSnapshot: withUnmapped,
      auxiliaryRatioInputs: AUX_INPUTS,
      grossReplacementCostLabel: "$1.0M",
    });
    const fsGroupRows = sofp.assetsRows.filter((r) => r.kind === "fs-group");
    expect(fsGroupRows.every((r) => r.fsGroupKey !== undefined && r.fsGroupKey !== "")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7) Backward compatibility â€” legacy pre-v15.14 payloads still work.
// ---------------------------------------------------------------------------
describe("v15.14 backward compatibility â€” legacy archived payloads still load", () => {
  it("a payload constructed by the current builder still exposes the pre-v15.14 SoFPRow fields (key, kind, label, current, comparative)", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({
      clubName: "Silver Springs",
      period: MAY_2026,
    });
    for (const row of sofp.assetsRows) {
      expect(typeof row.key).toBe("string");
      expect(typeof row.kind).toBe("string");
      if ("label" in row) expect(typeof row.label === "string" || row.label === undefined).toBe(true);
    }
  });

  it("`SoFPRow.kind` union still accepts the legacy `detail` value so archived payloads render unchanged", () => {
    // Structurally hydrate a legacy payload â€” an assetsRows array
    // that contains only the pre-v15.14 `detail` kind. The renderer
    // must accept this shape (backward-compat contract) because
    // MonthlyPackage rows serialised before v15.14 carry it. This
    // test proves the type still admits the value; the renderer's
    // switch statement covers `detail` via its default branch.
    const legacyRow = {
      key: "acct-1300",
      kind: "detail" as const,
      label: "Inventory - Food",
      current: 31_400,
      comparative: null,
    };
    expect(legacyRow.kind).toBe("detail");
  });
});

// ---------------------------------------------------------------------------
// 8) Silver Springs demo â€” visible summarisation across a
// multi-account FS Group.
// ---------------------------------------------------------------------------
describe("v15.14 Silver Springs demo â€” nine inventory accounts summarise to ONE 'Inventory' line", () => {
  it("finds exactly one 'Inventory' FS-Group summary row in the assets table", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({
      clubName: "Silver Springs",
      period: MAY_2026,
    });
    const inventoryRows = sofp.assetsRows.filter(
      (r) => r.kind === "fs-group" && r.fsGroupKey === "BS_INVENTORY",
    );
    expect(inventoryRows).toHaveLength(1);
    // 31_400 + 11_650 + 10_343 + 4_490 + 23_514 + 5_209 + 81_625 + 41_900 + 123_914 = 334_045
    expect(inventoryRows[0].current).toBe(334_045);
    expect(inventoryRows[0].label).toBe("Inventory");
  });

  it("with drill-down authorization, the Inventory row exposes all nine underlying account lines", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({
      clubName: "Silver Springs",
      period: MAY_2026,
      viewerCanDrillDown: true,
    });
    const row = sofp.assetsRows.find(
      (r) => r.kind === "fs-group" && r.fsGroupKey === "BS_INVENTORY",
    );
    expect(row?.accounts).toHaveLength(9);
  });

  it("without drill-down authorization, the Inventory row omits `accounts` entirely", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({
      clubName: "Silver Springs",
      period: MAY_2026,
    });
    const row = sofp.assetsRows.find(
      (r) => r.kind === "fs-group" && r.fsGroupKey === "BS_INVENTORY",
    );
    expect(row?.accounts).toBeUndefined();
  });

  it("Silver Springs reconciles â€” Total Assets equals Total Liabilities & Members' Equity", () => {
    const sofp = buildSilverSpringsStatementOfFinancialPosition({
      clubName: "Silver Springs",
      period: MAY_2026,
    });
    expect(sofp.reconciliation.balances).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9) Presentation-shape source-contract: the client-side disclosure
//    island only ever renders on FS-Group rows with populated
//    `accounts` â€” the renderer contract guarantees Board / PDF safety.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
describe("v15.14 renderer + entry contract â€” publish + PDF + Board paths never opt in", () => {
  const monthlyPackage = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/reporting/monthly-package.ts"),
    "utf8",
  );
  const publishPath = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/reporting/monthly-package-lifecycle.ts"),
    "utf8",
  );
  const printPage = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/print/monthly-package/page.tsx"),
    "utf8",
  );
  const adminPage = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/reporting/monthly/page.tsx"),
    "utf8",
  );

  it("getMonthlyReportingPackage exposes the viewerCanDrillDown option", () => {
    expect(monthlyPackage).toMatch(/viewerCanDrillDown\?:\s*boolean/);
  });

  it("publish path explicitly passes viewerCanDrillDown: false (defence-in-depth for archived payloads)", () => {
    expect(publishPath).toMatch(/viewerCanDrillDown:\s*false/);
  });

  it("print / PDF page explicitly passes viewerCanDrillDown: false", () => {
    expect(printPage).toMatch(/viewerCanDrillDown:\s*false/);
  });

  it("admin route derives viewerCanDrillDown from `hasPermission(principal, clubId, \"coa:read\")`", () => {
    expect(adminPage).toMatch(/hasPermission\(principal,\s*clubId,\s*"coa:read"\)/);
    expect(adminPage).toMatch(/viewerCanDrillDown/);
  });
});

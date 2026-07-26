// Financial Position Reporting Service.
//
// Reads a Balance Sheet Snapshot from the Reporting Ledger and
// returns it as a 6-bucket FinancialPositionView — the shape board
// reports and finance committee packages render.
//
// The 9 BalanceSheetCategory values on the snapshot collapse to the
// 6 buckets the board cares about:
//
//   current-asset                  → Current Assets
//   capital-fund-asset + ppe-gross → Capital Assets
//   ppe-accumulated-depreciation   → Accumulated Depreciation (contra)
//   current-liability              → Current Liabilities
//   long-term-liability            → Long-Term Liabilities
//   operating-fund-balance +
//   capital-fund-balance +
//   ytd-net-income                 → Equity
//
// `totalAssets` follows the convention `gross + capital-fund −
// accumulated-depreciation`. The view's `isReconciled` re-asserts the
// snapshot's reconciliation so consumers don't have to.
//
// This service is READ ONLY. It does not write anything to the ledger
// and does not mutate the snapshot. Projections happen upstream in
// `BalanceSheetProjection`.

import type {
  BalanceSheetCategory,
  BalanceSheetLine,
  BalanceSheetSnapshot,
} from "@/lib/reporting/ledger/contracts";
import type { ReportingLedger } from "@/lib/reporting/ledger/read-api";

// ---------------------------------------------------------------------------
// View shape — the 6 user-facing buckets
// ---------------------------------------------------------------------------

export type FinancialPositionSection = {
  lines: ReadonlyArray<BalanceSheetLine>;
  subtotal: number;
};

export type FinancialPositionView = {
  clubId: string;
  asOf: Date;
  fiscalYearLabel: string;
  snapshotId: string;
  capturedAt: Date;
  dataSource: BalanceSheetSnapshot["dataSource"];
  sourceSystem: BalanceSheetSnapshot["sourceSystem"];

  // ----- Assets ----------------------------------------------------
  currentAssets: FinancialPositionSection;
  capitalAssets: FinancialPositionSection;
  accumulatedDepreciation: FinancialPositionSection;
  /** = currentAssets + capitalAssets − accumulatedDepreciation */
  totalAssets: number;

  // ----- Liabilities -----------------------------------------------
  currentLiabilities: FinancialPositionSection;
  longTermLiabilities: FinancialPositionSection;
  /** = currentLiabilities + longTermLiabilities */
  totalLiabilities: number;

  // ----- Equity ----------------------------------------------------
  equity: FinancialPositionSection;
  /** = sum of equity lines (signed, includes YTD net income) */
  totalEquity: number;

  /** = totalLiabilities + totalEquity. Should equal totalAssets. */
  totalLiabilitiesAndEquity: number;
  /** `true` when totalAssets ≈ totalLiabilities + totalEquity within $1. */
  isReconciled: boolean;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FinancialPositionService {
  private readonly ledger: ReportingLedger;

  constructor(args: { ledger: ReportingLedger }) {
    this.ledger = args.ledger;
  }

  /**
   * Return the Financial Position view for a club as of `asOf`.
   * Reads the latest committed Balance Sheet snapshot at-or-before
   * the requested date. Returns null when no snapshot exists for
   * that club at that date.
   */
  async getFinancialPosition(input: {
    clubId: string;
    asOf: Date;
  }): Promise<FinancialPositionView | null> {
    const snap = await this.ledger.getBalanceSheet(input.clubId, input.asOf);
    if (!snap) return null;
    return buildFinancialPositionView(snap);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Build the 6-bucket view from a BalanceSheetSnapshot. Pure function;
 * useful for testing the bucketing without an in-memory ledger.
 */
export function buildFinancialPositionView(
  snap: BalanceSheetSnapshot,
): FinancialPositionView {
  const currentAssetLines = filterBy(snap.lines, ["current-asset"]);
  const capitalAssetLines = filterBy(snap.lines, [
    "capital-fund-asset",
    "ppe-gross",
  ]);
  const accumDeprLines = filterBy(snap.lines, ["ppe-accumulated-depreciation"]);
  const currentLiabLines = filterBy(snap.lines, ["current-liability"]);
  const longTermLiabLines = filterBy(snap.lines, ["long-term-liability"]);
  const equityLines = filterBy(snap.lines, [
    "operating-fund-balance",
    "capital-fund-balance",
    "ytd-net-income",
  ]);

  const currentAssetsSubtotal = sumAmounts(currentAssetLines);
  const capitalAssetsSubtotal = sumAmounts(capitalAssetLines);
  const accumDeprSubtotal = sumAmounts(accumDeprLines);
  const currentLiabSubtotal = sumAmounts(currentLiabLines);
  const longTermLiabSubtotal = sumAmounts(longTermLiabLines);
  // Equity is signed — ytd-net-income may be negative for a loss.
  const equitySubtotal = equityLines.reduce((acc, l) => acc + l.amount, 0);

  const totalAssets =
    currentAssetsSubtotal + capitalAssetsSubtotal - accumDeprSubtotal;
  const totalLiabilities = currentLiabSubtotal + longTermLiabSubtotal;
  const totalEquity = equitySubtotal;
  const totalLiabilitiesAndEquity = totalLiabilities + totalEquity;
  const isReconciled = Math.abs(totalAssets - totalLiabilitiesAndEquity) < 1;

  return {
    clubId: snap.clubId,
    asOf: snap.asOf,
    fiscalYearLabel: snap.fiscalYearLabel,
    snapshotId: snap.snapshotId,
    capturedAt: snap.capturedAt,
    dataSource: snap.dataSource,
    sourceSystem: snap.sourceSystem,
    currentAssets: { lines: currentAssetLines, subtotal: currentAssetsSubtotal },
    capitalAssets: { lines: capitalAssetLines, subtotal: capitalAssetsSubtotal },
    accumulatedDepreciation: {
      lines: accumDeprLines,
      subtotal: accumDeprSubtotal,
    },
    totalAssets,
    currentLiabilities: {
      lines: currentLiabLines,
      subtotal: currentLiabSubtotal,
    },
    longTermLiabilities: {
      lines: longTermLiabLines,
      subtotal: longTermLiabSubtotal,
    },
    totalLiabilities,
    equity: { lines: equityLines, subtotal: equitySubtotal },
    totalEquity,
    totalLiabilitiesAndEquity,
    isReconciled,
  };
}

function filterBy(
  lines: ReadonlyArray<BalanceSheetLine>,
  categories: ReadonlyArray<BalanceSheetCategory>,
): BalanceSheetLine[] {
  return lines.filter((l) => categories.includes(l.category));
}

function sumAmounts(lines: ReadonlyArray<BalanceSheetLine>): number {
  return lines.reduce((acc, l) => acc + Math.abs(l.amount), 0);
}

// Reporting Ledger — read-side contract.
//
// See docs/reporting-ledger-architecture.md §4.1 for the full
// architecture. This file defines the single typed interface that
// every reporting service consumes when reading from the ledger.
//
// IMPORTANT — this is a CONTRACT FILE. No implementation. Phase 1
// work will introduce a concrete `ReportingLedger` that proxies the
// reads against a prisma-backed storage layer; until then, services
// continue to read demo seeds + the legacy prisma schema directly.
//
// Read-API rules:
//
//   1. Every method returns `Promise<T | null>`. Never throws when
//      a snapshot doesn't exist — null is the legitimate "no data
//      yet" signal. Reporting services compose null-safe fallbacks
//      (see the Executive Summary's `comparator: null` handling
//      and the cover-page partial-data narrative).
//
//   2. Point-in-time queries return the MOST RECENT committed
//      snapshot whose date is ≤ the requested `asOf`. If multiple
//      replacements exist for the same logical key, the latest
//      wins (snapshots are immutable; replacements add new physical
//      rows).
//
//   3. Period queries match the snapshot whose `(periodStart,
//      periodEnd)` exactly equals the requested window. The Import
//      Layer is responsible for producing one snapshot per close
//      period; partial periods are not blended in the ledger.
//
//   4. Trailing-history queries return chronologically ordered
//      arrays (oldest → newest). A missing period in the window
//      yields a gap (the array has fewer entries than expected).
//      Consumers handle the gap explicitly — typically by padding
//      with nulls in the chart series.

import type {
  ArAgingSnapshot,
  BalanceSheetSnapshot,
  BudgetSnapshot,
  CapitalProjectSnapshot,
  IncomeStatementSnapshot,
  PayrollSnapshot,
  PriorYearSnapshot,
  TrialBalanceSnapshot,
} from "@/lib/reporting/ledger/contracts";

/**
 * The Reporting Ledger read interface. ONE injected dependency every
 * Phase 1 reporting service receives. Existing services
 * (`getOperatingResults`, `getEquityHistory`, ...) will be migrated
 * to consume this in subsequent PRs; this file ships the contract.
 *
 * All methods are async + null-returning. No method throws when a
 * snapshot is missing; null is the legitimate signal.
 */
export interface ReportingLedger {
  // -----------------------------------------------------------------
  // Point-in-time queries — returns the most recent snapshot
  // committed at or before `asOf`.
  // -----------------------------------------------------------------

  /** Trial balance as of a date — the raw per-account ending
   *  balances + the chart of accounts captured at close. */
  getTrialBalance(
    clubId: string,
    asOf: Date,
  ): Promise<TrialBalanceSnapshot | null>;

  /** Balance sheet as of a date — assets / liabilities / equity
   *  with reconciliation flag. */
  getBalanceSheet(
    clubId: string,
    asOf: Date,
  ): Promise<BalanceSheetSnapshot | null>;

  /** AR aging as of a date — per-member receivables × 4 buckets
   *  with pre-rolled bucket totals + current% / over90% derived. */
  getArAging(clubId: string, asOf: Date): Promise<ArAgingSnapshot | null>;

  /** Capital project portfolio as of a date — authorized /
   *  contracted / spent / projected-final per project + portfolio
   *  totals. */
  getCapitalProjects(
    clubId: string,
    asOf: Date,
  ): Promise<CapitalProjectSnapshot | null>;

  // -----------------------------------------------------------------
  // Period queries — returns the snapshot matching the exact
  // (periodStart, periodEnd) window.
  // -----------------------------------------------------------------

  /** Income statement for a closed period (typically a month). */
  getIncomeStatement(
    clubId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<IncomeStatementSnapshot | null>;

  /** Payroll for a closed period. */
  getPayroll(
    clubId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<PayrollSnapshot | null>;

  // -----------------------------------------------------------------
  // Fiscal-year queries — returns the latest approved version (or
  // the latest committed snapshot when versioning doesn't apply).
  // -----------------------------------------------------------------

  /** Approved budget for a fiscal year. Returns the LATEST version
   *  (handles mid-year revisions). Use `getBudgetVersion` for an
   *  explicit version. */
  getBudget(
    clubId: string,
    fiscalYearLabel: string,
  ): Promise<BudgetSnapshot | null>;

  /** Specific budget version — for audit reconciliation when the
   *  board needs to compare actuals against a particular approved
   *  version. */
  getBudgetVersion(
    clubId: string,
    fiscalYearLabel: string,
    version: number,
  ): Promise<BudgetSnapshot | null>;

  /** Prior-year IS + BS comparative snapshot. Refreshed when a
   *  fiscal year is closed; older prior-year snapshots remain in
   *  history. */
  getPriorYear(
    clubId: string,
    fiscalYearLabel: string,
  ): Promise<PriorYearSnapshot | null>;

  // -----------------------------------------------------------------
  // Trailing-history queries — chronologically ordered arrays.
  // -----------------------------------------------------------------

  /** Trailing income statements within a date window. Used by the
   *  Operating Results 12-month chart. Returns chronologically
   *  ordered (oldest → newest); missing periods yield a shorter
   *  array. */
  listIncomeStatements(
    clubId: string,
    opts: LedgerHistoryWindow,
  ): Promise<ReadonlyArray<IncomeStatementSnapshot>>;

  /** Trailing balance sheets within a date window. Used by the
   *  Equity Value Over Time chart (which today reads
   *  `FiscalYear.closingEquity` directly — will migrate to read
   *  the BS history off the ledger). */
  listBalanceSheets(
    clubId: string,
    opts: LedgerHistoryWindow,
  ): Promise<ReadonlyArray<BalanceSheetSnapshot>>;

  /** Trailing AR aging snapshots — used by AR trend charts (current%
   *  over 12 months) when the package adds them. */
  listArAging(
    clubId: string,
    opts: LedgerHistoryWindow,
  ): Promise<ReadonlyArray<ArAgingSnapshot>>;

  /** Trailing payroll snapshots — used by the Payroll Ratio
   *  Monthly Trend chart. */
  listPayroll(
    clubId: string,
    opts: LedgerHistoryWindow,
  ): Promise<ReadonlyArray<PayrollSnapshot>>;
}

/**
 * A date window for trailing-history queries. Returned arrays are
 * chronologically ordered (oldest → newest) and cover the closed
 * snapshots whose period falls within `[startDate, endDate]`.
 */
export type LedgerHistoryWindow = {
  /** Inclusive start of the window. */
  startDate: Date;
  /** Inclusive end of the window. */
  endDate: Date;
  /** Optional cap on how many snapshots to return (newest first when
   *  the cap is reached). Default: no cap. */
  limit?: number;
};

// ---------------------------------------------------------------------------
// Reporting-period helper queries
// ---------------------------------------------------------------------------

/**
 * Optional helper interface a `ReportingLedger` implementation may
 * expose — services frequently want the trailing 12 fiscal periods
 * relative to an asOf rather than an explicit date window.
 *
 * Implementing this is OPTIONAL; services that need it should
 * narrow the ledger to this interface (or compose `listX` calls
 * themselves). Not part of the core `ReportingLedger` contract so
 * the storage backend can prioritise simpler primitives.
 */
export interface ReportingLedgerPeriodHelpers {
  /** Trailing N income statements as of a date — convenience for
   *  the 12-month chart. */
  listTrailingIncomeStatements(
    clubId: string,
    asOf: Date,
    count: number,
  ): Promise<ReadonlyArray<IncomeStatementSnapshot>>;
}

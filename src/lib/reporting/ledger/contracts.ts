// Reporting Ledger — entity contracts.
//
// See docs/reporting-ledger-architecture.md for the full
// architecture. This file defines the 8 normalized entities the
// Reporting Ledger exposes plus their shared provenance metadata.
//
// IMPORTANT — this is a CONTRACT FILE. No implementation, no storage
// schema, no importer. The shapes here are the boundary between:
//
//   • Source systems (Jonas / future Spectre Accounting / payroll
//     provider / POS) — write into the ledger via the Import Layer.
//   • Reporting services (`getOperatingResults`, `getBalanceSheet`,
//     `buildExecutiveSummary`, etc.) — read from the ledger.
//
// Every snapshot is IMMUTABLE once captured. Re-importing the same
// logical snapshot writes a NEW physical row with the same logical
// key; the old row is preserved for audit. The Import Layer never
// mutates a row in place.

import type { MonthlyAccountingDataSource } from "@/lib/reporting/monthly-accounting-contract";

// ---------------------------------------------------------------------------
// Shared metadata — every snapshot variant carries this block
// ---------------------------------------------------------------------------

/**
 * Source system that produced the snapshot. Used for audit trails
 * and to drive per-club Import Layer routing.
 *
 *   - `jonas-gl`             — Jonas GL extract (trial balance, IS, BS)
 *   - `jonas-ar`             — Jonas AR subledger
 *   - `jonas-payroll`        — Jonas's embedded payroll module (when used)
 *   - `spectre-accounting`   — Future Spectre-built accounting system
 *   - `adp-payroll`          — ADP / Workday / Gusto / other payroll provider
 *   - `lightspeed-pos`       — Lightspeed / Toast / etc. (F&B + golf POS)
 *   - `capital-tracker`      — Capital project tracker (project accounting)
 *   - `reserve-study`        — Reserve study PDF / spreadsheet (manual)
 *   - `manual-entry`         — Board / Finance Committee direct entry
 *                              (e.g. annual budget approval)
 *   - `demo-seed`            — Seeded demo data — never live
 */
export type LedgerSourceSystem =
  | "jonas-gl"
  | "jonas-ar"
  | "jonas-payroll"
  | "spectre-accounting"
  | "adp-payroll"
  | "lightspeed-pos"
  | "capital-tracker"
  | "reserve-study"
  | "manual-entry"
  | "demo-seed";

/**
 * Provenance + audit metadata every ledger snapshot carries. The
 * fields here are common to all 8 entity variants; entity-specific
 * shape lives alongside.
 */
export type LedgerSnapshotMetadata = {
  /** Unique snapshot row id (UUID). Distinct from the logical
   *  identity `(clubId, entityKind, period-or-date-key)` — re-
   *  importing the same logical snapshot writes a new row with a
   *  new `snapshotId` and a fresh `capturedAt`. */
  snapshotId: string;
  clubId: string;
  /** When this snapshot was imported into the ledger. */
  capturedAt: Date;
  /** Which source system emitted the underlying numbers. */
  sourceSystem: LedgerSourceSystem;
  /** Atomic-batch grouping. Snapshots written inside the same batch
   *  become readable together or none of them do (month-end
   *  imports group TB + IS + BS + AR aging here). `null` for stand-
   *  alone imports. */
  importBatchId: string | null;
  /** Provenance class — feeds the UI provenance pill ("from GL"
   *  vs. "demo seed"). Mirrors the 4-value taxonomy in
   *  `monthly-accounting-contract.ts`. */
  dataSource: MonthlyAccountingDataSource;
  /** Free-form note from the importer — e.g.
   *  `"Jonas GL extract — fye_2026_m05.csv batch #4821"`. */
  notes: string | null;
};

// ---------------------------------------------------------------------------
// Chart of accounts — shared across Trial Balance + IS + BS
// ---------------------------------------------------------------------------

/**
 * A single account in the chart of accounts. Stable identifier
 * (`accountCode`) decouples the ledger from source-system internal
 * ids; the same logical account in Jonas vs. Spectre Accounting
 * carries the same `accountCode` after the Import Layer maps it.
 */
export type LedgerAccount = {
  accountCode: string;
  accountName: string;
  category: LedgerAccountCategory;
  fund: LedgerFund;
  parentAccountCode: string | null;
  /**
   * Founder rule 2026-07-02 v15.0 — Fund Applicability CSV string
   * for P&L accounts (see `src/lib/accounting/fund-applicability.ts`).
   * Sourced from the CoA's `Account.fundApplicability` column;
   * `null` for balance-sheet accounts and for P&L accounts that
   * haven't been backfilled or explicitly tagged. The Income
   * Statement projection reads this instead of inferring the
   * fund from the account name / number. Optional so older
   * snapshot readers that predate v15.0 still typecheck.
   */
  fundApplicability?: string | null;
  // ---------------------------------------------------------------
  // Founder rule 2026-07-13 v15.15 — Chart-of-Accounts point-in-time
  // classification.
  //
  // Every ledger-carrying `LedgerAccount` now MAY carry the stable
  // classification metadata sourced from the ChartAccount record it
  // was derived from. These fields are the SINGLE SOURCE OF TRUTH
  // for how a Balance Sheet line rolls up in the Statement of
  // Financial Position (v15.14).
  //
  // OPTIONAL for backward compatibility with pre-v15.15 snapshots.
  // When absent, downstream reporting services (SoFP builder,
  // projection) enrich lines at read-time via a bounded Prisma
  // query — see `src/lib/reporting/ledger/classification-resolver.ts`.
  // Snapshots imported after v15.15 populate these fields directly
  // at capture time, giving Full point-in-time integrity for future
  // published packages.
  //
  // A published `MonthlyPackage.packagePayloadJson` freezes the
  // built Statement of Financial Position, which already contains
  // the resolved FS-Group summary rows. Once frozen, later CoA
  // edits do NOT change the archived payload — that is the
  // architectural guarantee behind the founder's "May 2026 archive
  // must remain unchanged after a July 2026 CoA edit" rule.
  // ---------------------------------------------------------------
  /** Stable CoA `Account.id` (cuid). Used by future migrations to
   *  repair legacy snapshots without re-scanning by accountCode. */
  accountId?: string;
  /** CoA `Account.type` — "ASSET" | "LIABILITY" | "EQUITY" |
   *  "REVENUE" | "EXPENSE". Distinct from the coarse
   *  `LedgerAccountCategory` (which lower-cases these). Retained on
   *  the snapshot so future classification snapshot models can
   *  reproduce the tri-tier hierarchy without a Prisma lookup. */
  accountType?: string;
  /** CoA `AccountCategory.key` — e.g. `CURRENT_ASSETS`,
   *  `CAPITAL_ASSETS`, `LONG_TERM_LIABILITIES`. Frozen label so a
   *  later category rename doesn't drift historical statements. */
  categoryKey?: string;
  /** CoA `AccountCategory.name` — display label. */
  categoryName?: string;
  /** CoA `AccountCategory.sortOrder`. */
  categorySortOrder?: number;
  /** CoA `FinancialStatementGroup.key` — e.g. `BS_CASH_EQUIVALENTS`,
   *  `BS_INVENTORY`, `BS_ACCUMULATED_DEPRECIATION`. The SoFP builder
   *  aggregates every balance-sheet line by this key. */
  fsGroupKey?: string;
  /** CoA `FinancialStatementGroup.name` — display label. */
  fsGroupName?: string;
  /** CoA `FinancialStatementGroup.sortOrder`. Drives the summary-
   *  row ordering on the Statement of Financial Position. */
  fsGroupSortOrder?: number;
};

export type LedgerAccountCategory =
  | "asset"
  | "liability"
  | "equity"
  | "revenue"
  | "expense";

/** Fund tag. Two-fund accounting separates operating from capital. */
export type LedgerFund = "operating" | "capital" | "reserve" | "other";

// ---------------------------------------------------------------------------
// 1. Trial Balance Snapshot
// ---------------------------------------------------------------------------

/**
 * Per-account debit / credit / ending balance for a closed period.
 * The "raw" snapshot the GL produces at month close — IS and BS
 * derive from it. Capturing the trial balance separately lets
 * reporting services do their own roll-ups when needed.
 */
export type TrialBalanceLine = {
  accountCode: string;
  debit: number;
  credit: number;
  endingBalance: number;
};

export type TrialBalanceSnapshot = LedgerSnapshotMetadata & {
  entityKind: "trial-balance";
  /** Balance-sheet date (e.g. last day of the period). */
  asOf: Date;
  /** Activity period this trial balance covers. */
  periodStart: Date;
  periodEnd: Date;
  /** Fiscal-year label this period belongs to (e.g. "FY2026"). */
  fiscalYearLabel: string;
  /** Sequence within the fiscal year (1..12 for monthly closes). */
  fiscalPeriodSequence: number;
  /** Chart of accounts as of `asOf` — duplicated per snapshot so
   *  account renames or re-categorisations don't retroactively
   *  alter prior periods. */
  accounts: ReadonlyArray<LedgerAccount>;
  /** Per-account balances. */
  lines: ReadonlyArray<TrialBalanceLine>;
  /** Roll-ups for self-check. */
  totalDebits: number;
  totalCredits: number;
  /** `true` when debits ≡ credits within a $1 tolerance. */
  isBalanced: boolean;
};

// ---------------------------------------------------------------------------
// 2. Income Statement Snapshot
// ---------------------------------------------------------------------------

/**
 * Per-account / per-department revenue + expense for a period.
 * Derived from the trial balance at the Import Layer (the importer
 * does the derivation; the ledger just stores the result). Multiple
 * IS snapshots may exist for the same `clubId` — one per closed
 * period — so the trailing-12-months chart can read 12 rows.
 */
export type IncomeStatementLine = {
  accountCode: string;
  accountName: string;
  category: "revenue" | "expense";
  fund: "operating" | "capital";
  /** Optional departmental tag (null for non-departmental lines). */
  departmentCode: string | null;
  /** Signed amount. Revenue and expense both stored as POSITIVE
   *  values; consumers compute NOI = sum(revenue) − sum(expense). */
  amount: number;
};

export type IncomeStatementSnapshot = LedgerSnapshotMetadata & {
  entityKind: "income-statement";
  periodStart: Date;
  periodEnd: Date;
  fiscalYearLabel: string;
  fiscalPeriodSequence: number;
  lines: ReadonlyArray<IncomeStatementLine>;
  /** Pre-rolled top-line totals so consumers don't re-derive. */
  totalOperatingRevenue: number;
  totalOperatingExpense: number;
  /** NOI before depreciation — operating revenue minus operating
   *  expense, before any non-cash depreciation booking. */
  noiBeforeDepreciation: number;
  /** Depreciation for the period — broken out so the SOA
   *  Depreciation row reads it directly. */
  depreciation: number;
  totalCapitalIncome: number;
  totalCapitalExpense: number;
};

// ---------------------------------------------------------------------------
// 3. Balance Sheet Snapshot
// ---------------------------------------------------------------------------

/**
 * Per-account asset / liability / equity balances as of a date.
 * Derived from the trial balance.
 */
export type BalanceSheetCategory =
  | "current-asset"
  | "capital-fund-asset"
  // Founder rule 2026-07-13 v15.20 — dedicated non-current asset
  // section for Long-term Receivables, Investments held long-term,
  // Right-of-Use assets, Intangibles, and Other Long-term Assets.
  // Kept distinct from `capital-fund-asset` (which is
  // reserve/capital-fund only) so a professional balance sheet can
  // display Current Assets, Long-Term Assets, and PP&E as three
  // separate sections.
  | "long-term-asset"
  | "ppe-gross"
  | "ppe-accumulated-depreciation"
  | "current-liability"
  | "long-term-liability"
  | "operating-fund-balance"
  | "capital-fund-balance"
  | "ytd-net-income";

export type BalanceSheetLine = {
  accountCode: string;
  accountName: string;
  category: BalanceSheetCategory;
  fund: LedgerFund;
  /** Amount in dollars (positive); ledger sign convention is
   *  handled by `category` (PP&E accumulated depreciation lines
   *  carry positive amounts that are subtracted from gross at
   *  consumer roll-up time). */
  amount: number;
  /** Optional prior-year same-date comparator. Importer fills this
   *  when the source system can supply it; otherwise `null` and
   *  the Prior Year Snapshot must be queried separately. */
  priorYearSameDateAmount: number | null;
  // ---------------------------------------------------------------
  // Founder rule 2026-07-13 v15.14 — FS-Group classification.
  //
  // Every posting balance-sheet account is assigned to a
  // `FinancialStatementGroup` on the Chart of Accounts (see
  // `prisma/schema.prisma` — Account.fsGroupId → FinancialStatementGroup).
  // The reporting service uses this classification to summarise
  // the Statement of Financial Position by FS Group rather than by
  // individual account — matching the founder's "professional
  // balance sheet, not trial balance" contract.
  //
  // OPTIONAL for backward compatibility with pre-v15.14 snapshots
  // (which never carried FS-Group metadata). When absent, the SOFP
  // builder either (a) enriches from a caller-supplied
  // classifications map (production path), or (b) surfaces the line
  // through the unmapped-accounts band (defence-in-depth: never
  // silently drop a balance).
  // ---------------------------------------------------------------
  /** Stable FS-Group key (e.g. "BS_INVENTORY", "BS_CASH_EQUIVALENTS"). */
  fsGroupKey?: string;
  /** Human-facing FS-Group display label (e.g. "Inventory",
   *  "Cash & Cash Equivalents"). */
  fsGroupName?: string;
  /** Explicit ordering for the FS-Group summary row. Falls back to
   *  the shared FS-Group sortOrder when omitted; a stable per-line
   *  value is preferred so the same FS Group always appears in the
   *  same position across periods. */
  fsGroupSortOrder?: number;
  // ---------------------------------------------------------------
  // Founder rule 2026-07-13 v15.19 — Raw signed Trial Balance
  // amount, preserved verbatim through the projection.
  //
  // `amount` above is `Math.abs(tbLine.endingBalance)` — the
  // absolute-value normalisation the SoFP builder relies on for
  // standard section aggregation. Some downstream consumers,
  // notably the dynamic tax-family net-settlement builder, need
  // the ORIGINAL Trial Balance sign (debit = positive, credit =
  // negative) to net accounts algebraically:
  //
  //   GST Collected     -31,625.49  (credit → negative)
  //   GST Paid (ITCs)   +31,402.71  (debit  → positive)
  //   GST Filed          +9,135.35  (debit  → positive)
  //   Net              +$8,912.57  (net debit → Sales Tax Receivable)
  //
  // Storing the raw signed amount removes any reliance on account
  // NAME to reconstruct the direction. Optional so pre-v15.19
  // snapshots still typecheck; consumers fall back to name
  // inference only when this field is absent.
  // ---------------------------------------------------------------
  rawSignedAmount?: number;
};

export type BalanceSheetSnapshot = LedgerSnapshotMetadata & {
  entityKind: "balance-sheet";
  asOf: Date;
  fiscalYearLabel: string;
  lines: ReadonlyArray<BalanceSheetLine>;
  /** Pre-rolled totals. */
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  /** `true` when `totalAssets === totalLiabilities + totalEquity`
   *  within a $1 tolerance. Render the package banner if false. */
  isReconciled: boolean;
};

// ---------------------------------------------------------------------------
// 4. Budget Snapshot
// ---------------------------------------------------------------------------

/**
 * Per-account / per-department budget for a fiscal year. Carries
 * monthly splits so reporting can read both "May budget" (current
 * month) and "YTD budget through May" (cumulative).
 */
export type BudgetLine = {
  accountCode: string;
  departmentCode: string | null;
  /** 12 entries, in fiscal-month order (slot 0 = fiscal-month 1). */
  monthlyAmounts: ReadonlyArray<number>;
  annualTotal: number;
  notes: string | null;
};

export type BudgetApprovalStatus = "draft" | "approved" | "revised";

export type BudgetSnapshot = LedgerSnapshotMetadata & {
  entityKind: "budget";
  fiscalYearLabel: string;
  startDate: Date;
  endDate: Date;
  /** Where the budget sits in the approval lifecycle. The package
   *  builder may render `"draft"` budgets differently (e.g. with a
   *  banner) until the board votes them through. */
  approvalStatus: BudgetApprovalStatus;
  approvalDate: Date | null;
  /** Version number — bumps with each revision. `getBudget`
   *  returns the latest approved version by default. */
  version: number;
  lines: ReadonlyArray<BudgetLine>;
};

// ---------------------------------------------------------------------------
// 5. Prior Year Snapshot
// ---------------------------------------------------------------------------

/**
 * Comparative IS + BS for the prior fiscal year. Stored as its own
 * entity so reporting services querying prior-year comparatives
 * don't have to re-fetch + re-aggregate the prior-year IS / BS
 * snapshots. Refreshed when a prior fiscal year is closed.
 */
export type PriorYearSnapshot = LedgerSnapshotMetadata & {
  entityKind: "prior-year";
  /** The fiscal year this snapshot represents — e.g. "FY2025". */
  fiscalYearLabel: string;
  periodStart: Date;
  periodEnd: Date;
  /** Full-year income statement for the prior year. Same shape as
   *  `IncomeStatementSnapshot` without the wrapping metadata
   *  (which lives on the outer snapshot). */
  incomeStatement: Omit<
    IncomeStatementSnapshot,
    keyof LedgerSnapshotMetadata | "entityKind"
  >;
  /** Year-end balance sheet for the prior year. */
  balanceSheetAtYearEnd: Omit<
    BalanceSheetSnapshot,
    keyof LedgerSnapshotMetadata | "entityKind"
  >;
};

// ---------------------------------------------------------------------------
// 6. AR Aging Snapshot
// ---------------------------------------------------------------------------

/**
 * Per-member receivables across the four standard aging buckets
 * (Current / 31-60 / 61-90 / Over-90), plus category tagging
 * (membership dues vs F&B vs golf vs amenity). Imported from the
 * AR subledger (often the GL itself for clubs whose GL handles
 * member accounts).
 */
export type ArAgingBucketKey = "current" | "31-60" | "61-90" | "over-90";

export type ArAgingLine = {
  /** Stable id of the member account in the source system. */
  memberAccountId: string;
  /** Display label. */
  memberName: string;
  /** Charge category — "dues" / "fb" / "golf" / "amenity" / etc.
   *  String to allow per-club category sets without a closed
   *  enum. */
  categoryCode: string;
  /** Per-bucket balances in dollars. */
  current: number;
  thirtyToSixty: number;
  sixtyOneToNinety: number;
  overNinety: number;
  /** Total = sum of the four buckets. */
  total: number;
  /** Optional account-status flag — drives the AR Aging row's
   *  status pill (Current / Past Due / Suspension / Collections /
   *  Inactive). */
  accountStatus: ArAccountStatus | null;
};

export type ArAccountStatus =
  | "current"
  | "past-due"
  | "suspension-warning"
  | "collections"
  | "inactive";

export type ArAgingSnapshot = LedgerSnapshotMetadata & {
  entityKind: "ar-aging";
  asOf: Date;
  lines: ReadonlyArray<ArAgingLine>;
  /** Pre-rolled bucket totals across all members. */
  totalsByBucket: Record<ArAgingBucketKey, number>;
  totalAR: number;
  /** Pre-computed share-of-total for the cover-page KPI. */
  currentPct: number;
  over90Pct: number;
};

// ---------------------------------------------------------------------------
// 7. Payroll Snapshot
// ---------------------------------------------------------------------------

/**
 * Per-department payroll detail for a period. Imported from the
 * payroll provider (often a separate system from the GL — ADP /
 * Workday / Gusto / Paychex). The GL receives a summary journal
 * entry from payroll; this snapshot captures the detail behind it.
 */
export type PayrollCategory = "wages" | "taxes-benefits" | "contractor";

export type PayrollLine = {
  departmentCode: string;
  departmentName: string;
  category: PayrollCategory;
  /** Dollar amount for this department × category in this period. */
  amount: number;
  /** Hours worked — null when the source doesn't track hours
   *  (e.g. exempt-only departments). */
  hoursWorked: number | null;
  /** Headcount as of period end — null when source doesn't track. */
  headcount: number | null;
};

export type PayrollSnapshot = LedgerSnapshotMetadata & {
  entityKind: "payroll";
  periodStart: Date;
  periodEnd: Date;
  fiscalYearLabel: string;
  fiscalPeriodSequence: number;
  lines: ReadonlyArray<PayrollLine>;
  /** Pre-rolled totals. */
  totalGrossPayroll: number;     // wages + contractor
  totalBenefits: number;          // taxes + benefits
  totalPayrollExpense: number;    // gross + benefits
  /** Optional FTE roll-up for the operating-stats payroll-ratio
   *  KPI. `null` when source doesn't track headcount. */
  totalFTE: number | null;
};

// ---------------------------------------------------------------------------
// 8. Capital Project Snapshot
// ---------------------------------------------------------------------------

/**
 * Per-project capital authorization + spend + status as of a date.
 * Imported from a capital project tracker (project accounting
 * module or spreadsheet). The Capital Projects chapter of the
 * Monthly Reporting Package reads this directly.
 */
export type CapitalProjectStatus =
  | "planning"
  | "approved"
  | "in-progress"
  | "complete"
  | "deferred"
  | "on-hold";

export type CapitalProjectCategory =
  | "replacement"
  | "improvement"
  | "enhancement"
  | "debt-service";

export type CapitalProjectLine = {
  /** Stable id from the project tracker. */
  projectId: string;
  projectName: string;
  category: CapitalProjectCategory;
  status: CapitalProjectStatus;
  /** Board-authorized amount. */
  authorizedAmount: number;
  /** Contracted amount — `null` when not yet contracted (planning
   *  phase). */
  contractedAmount: number | null;
  /** Cumulative spent to date. */
  spentToDate: number;
  /** Latest projected final cost. `null` when "TBD" (planning). */
  projectedFinal: number | null;
  /** Estimated completion date — `null` when not scheduled. */
  estimatedCompletion: Date | null;
  /** Percent done (0–1) — `null` for planning / deferred. */
  percentDone: number | null;
  notes: string | null;
};

export type CapitalProjectSnapshot = LedgerSnapshotMetadata & {
  entityKind: "capital-project";
  asOf: Date;
  fiscalYearLabel: string;
  projects: ReadonlyArray<CapitalProjectLine>;
  /** Pre-rolled portfolio totals. */
  totalAuthorized: number;
  totalContracted: number;
  totalSpentToDate: number;
  totalProjectedFinal: number;
  /** Count of projects in each status — drives the Exception
   *  Report headline ("3 in progress, 1 deferred"). */
  countsByStatus: Record<CapitalProjectStatus, number>;
};

// ---------------------------------------------------------------------------
// Discriminated union — every snapshot the ledger holds
// ---------------------------------------------------------------------------

/**
 * Every snapshot variant. Switch on `entityKind` to narrow. Used by
 * the write API + storage backend; reporting services usually work
 * with the concrete variant returned by the read API.
 */
export type LedgerSnapshot =
  | TrialBalanceSnapshot
  | IncomeStatementSnapshot
  | BalanceSheetSnapshot
  | BudgetSnapshot
  | PriorYearSnapshot
  | ArAgingSnapshot
  | PayrollSnapshot
  | CapitalProjectSnapshot;

/** String-literal union of every `entityKind` discriminator. */
export type LedgerEntityKind = LedgerSnapshot["entityKind"];

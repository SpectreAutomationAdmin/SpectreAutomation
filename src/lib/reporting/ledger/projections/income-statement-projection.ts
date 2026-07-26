// Income Statement Projection — second Reporting Ledger projection service.
//
// Workflow per docs/reporting-ledger-architecture.md:
//
//   Trial Balance Snapshot(s) (in ledger)
//       ↓ (read by clubId + asOf — mode YTD reads one TB,
//          mode CURRENT-MONTH reads two and subtracts)
//   per-account IS-bucket mapping (configuration driven)
//       ↓ (aggregate into IS lines + roll-up totals)
//   Income Statement Snapshot
//       ↓ (writer.beginImportBatch → upsertSnapshot → commitImportBatch)
//   ledger.getIncomeStatement(clubId, periodStart, periodEnd) returns it
//
// SUPPORTED PROJECTION MODES:
//
//   • "ytd"
//       Reads the latest TB at-or-before `periodEnd`. Each line's
//       `amount` is the TB's `endingBalance` (which is YTD per the
//       Jonas importer convention).
//
//   • "current-month"
//       Reads the latest TB at `periodEnd` AND the latest TB
//       at-or-before `periodStart - 1 day` (i.e. the prior closed
//       period). Each line's amount is the YTD delta — current
//       period's YTD minus prior period's YTD. Accounts new in the
//       current period get their full YTD as month activity.
//
// The projection writes ONE snapshot per call. Callers that want
// both YTD AND current-month for the same period make TWO calls.

import { randomUUID } from "node:crypto";

import type {
  IncomeStatementLine,
  IncomeStatementSnapshot,
  LedgerAccount,
  TrialBalanceLine,
  TrialBalanceSnapshot,
} from "@/lib/reporting/ledger/contracts";
import type { ReportingLedger } from "@/lib/reporting/ledger/read-api";
import type { ReportingLedgerWriter } from "@/lib/reporting/ledger/write-api";

import {
  DEFAULT_INCOME_STATEMENT_MAPPING,
  bucketToCategory,
  bucketToFund,
  mapIncomeStatementAccount,
  type IncomeStatementBucket,
  type IncomeStatementMapping,
  type MappedIncomeStatementAccount,
} from "@/lib/reporting/ledger/projections/income-statement-mapping";

// ---------------------------------------------------------------------------
// Result + diagnostics
// ---------------------------------------------------------------------------

export type IncomeStatementMappingError = {
  accountCode: string;
  accountName: string;
  message: string;
};

/**
 * Per-bucket dollar roll-ups. These mirror the user-facing
 * categories (revenue / departmental revenue / payroll / operating
 * expenses / depreciation / capital income / capital expense) plus
 * the computed NOI.
 *
 * Total operating revenue = revenue + departmental-revenue
 * Total operating expense = payroll + operating-expense + depreciation
 * NOI before depreciation = total operating revenue − (payroll + operating-expense)
 * NOI                     = total operating revenue − total operating expense
 */
export type IncomeStatementBucketTotals = {
  revenue: number;
  departmentalRevenue: number;
  payroll: number;
  operatingExpense: number;
  depreciation: number;
  capitalIncome: number;
  capitalExpense: number;
  totalOperatingRevenue: number;
  totalOperatingExpense: number;
  noiBeforeDepreciation: number;
  noi: number;
};

export type IncomeStatementProjectionDiagnostics = {
  /** Lines considered in the TB (revenue + expense only; BS lines
   *  are skipped). */
  trialBalanceRevenueExpenseLineCount: number;
  /** Lines that mapped successfully. */
  incomeStatementLineCount: number;
  /** Lines that could not be mapped. */
  mappingErrors: ReadonlyArray<IncomeStatementMappingError>;
  /** Bucket-level totals. */
  bucketTotals: IncomeStatementBucketTotals;
  /**
   * Founder rule 2026-07-02 v15.0 — P&L accounts with a null
   * `fundApplicability` are surfaced here as a top-level
   * diagnostic. Their amounts are EXCLUDED from every roll-up
   * (operating AND capital); the reporting UI renders a banner
   * ("N accounts have no Fund Applicability assigned") so
   * operators can fix the CoA before trusting the numbers.
   */
  unmappedFundAccounts: ReadonlyArray<{
    accountCode: string;
    accountName: string;
    category: "revenue" | "expense";
    amount: number;
  }>;
  /** Projection mode used. */
  mode: "ytd" | "current-month";
  /** When `mode === "current-month"`, the snapshotId of the prior
   *  TB whose YTDs were subtracted. */
  priorTrialBalanceSnapshotId: string | null;
};

export type IncomeStatementProjectionResult =
  | {
      status: "succeeded";
      snapshot: IncomeStatementSnapshot;
      replaced: boolean;
      diagnostics: IncomeStatementProjectionDiagnostics;
    }
  | {
      status: "no-trial-balance";
      diagnostics: null;
      notes: string;
    }
  | {
      status: "no-prior-trial-balance";
      diagnostics: null;
      notes: string;
    }
  | {
      status: "failed-mapping";
      diagnostics: IncomeStatementProjectionDiagnostics;
      notes: string;
    };

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type IncomeStatementProjectionInput = {
  clubId: string;
  periodStart: Date;
  periodEnd: Date;
  fiscalYearLabel: string;
  fiscalPeriodSequence: number;
  /** Projection mode — see file header for semantics. */
  mode: "ytd" | "current-month";
  notes?: string;
};

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

export class IncomeStatementProjection {
  private readonly ledger: ReportingLedger;
  private readonly writer: ReportingLedgerWriter;
  private readonly mapping: IncomeStatementMapping;

  constructor(args: {
    ledger: ReportingLedger;
    writer: ReportingLedgerWriter;
    mapping?: IncomeStatementMapping;
  }) {
    this.ledger = args.ledger;
    this.writer = args.writer;
    this.mapping = args.mapping ?? DEFAULT_INCOME_STATEMENT_MAPPING;
  }

  /**
   * Project the Trial Balance(s) into an Income Statement Snapshot.
   * See file header for mode semantics. Writes the result to the
   * ledger and returns it.
   */
  async getIncomeStatementSnapshot(
    input: IncomeStatementProjectionInput,
  ): Promise<IncomeStatementProjectionResult> {
    // -------------------------------------------------------------
    // 1. Read the current-period TB.
    // -------------------------------------------------------------
    const tbCurrent = await this.ledger.getTrialBalance(
      input.clubId,
      input.periodEnd,
    );
    if (!tbCurrent) {
      return {
        status: "no-trial-balance",
        diagnostics: null,
        notes: `No trial balance found for club '${input.clubId}' at or before ${input.periodEnd.toISOString().slice(0, 10)}`,
      };
    }

    // -------------------------------------------------------------
    // 2. For current-month mode, also read the prior period's TB.
    // -------------------------------------------------------------
    let tbPrior: TrialBalanceSnapshot | null = null;
    if (input.mode === "current-month") {
      // Prior period = the instant just before periodStart. Using
      // `-1ms` (rather than `-1 day`) correctly includes a prior TB
      // whose `asOf` falls anywhere within the day before periodStart
      // (e.g. May 31 23:59:59 when periodStart is June 1 00:00:00).
      const priorAsOf = new Date(input.periodStart.getTime() - 1);
      tbPrior = await this.ledger.getTrialBalance(input.clubId, priorAsOf);
      if (!tbPrior) {
        return {
          status: "no-prior-trial-balance",
          diagnostics: null,
          notes:
            `Current-month projection needs a prior-period TB at-or-before ${priorAsOf.toISOString().slice(0, 10)}, ` +
            `but none was found for club '${input.clubId}'.`,
        };
      }
      // Sanity: priorTB must not be the same snapshot as currentTB.
      // If only one TB exists for the club, that period's "current
      // month" cannot be derived.
      if (tbPrior.snapshotId === tbCurrent.snapshotId) {
        return {
          status: "no-prior-trial-balance",
          diagnostics: null,
          notes:
            `Current-month projection found the SAME TB for both the current and prior periods. ` +
            `Import the prior-period TB first.`,
        };
      }
    }

    // -------------------------------------------------------------
    // 3. Build per-account lookup maps for accounts + balances.
    // -------------------------------------------------------------
    const currentAccountsByCode = indexAccounts(tbCurrent.accounts);
    const currentLinesByCode = indexLines(tbCurrent.lines);
    const priorLinesByCode = tbPrior ? indexLines(tbPrior.lines) : null;

    // -------------------------------------------------------------
    // 4. Walk TB lines. Only revenue + expense accounts are IS lines.
    //    Compute the per-line amount according to the projection mode.
    // -------------------------------------------------------------
    const isLines: IncomeStatementLine[] = [];
    const mappingErrors: IncomeStatementMappingError[] = [];
    const buckets: IncomeStatementBucketTotals = {
      revenue: 0,
      departmentalRevenue: 0,
      payroll: 0,
      operatingExpense: 0,
      depreciation: 0,
      capitalIncome: 0,
      capitalExpense: 0,
      totalOperatingRevenue: 0,
      totalOperatingExpense: 0,
      noiBeforeDepreciation: 0,
      noi: 0,
    };

    const unmappedFundAccounts: Array<{
      accountCode: string;
      accountName: string;
      category: "revenue" | "expense";
      amount: number;
    }> = [];

    for (const tbLine of tbCurrent.lines) {
      const account = currentAccountsByCode.get(tbLine.accountCode);
      if (!account) continue; // (shouldn't happen — TB invariant)
      if (account.category !== "revenue" && account.category !== "expense") {
        continue; // skip BS accounts
      }

      const mapped = mapIncomeStatementAccount(
        {
          accountNumber: account.accountCode,
          accountName: account.accountName,
          accountCategory: account.category,
          // Founder rule 2026-07-02 v15.0 — Fund Applicability is
          // sourced from the CoA (`LedgerAccount.fund` field is
          // populated by the projection reader from the stored
          // fundApplicability). Legacy snapshot readers that
          // haven't caught up to v15.0 pass an empty string
          // here — the mapper treats that as "not set" and
          // routes the line to the unmapped-fund diagnostic.
          accountFundApplicability: (account as LedgerAccount & { fundApplicability?: string | null }).fundApplicability ?? null,
        },
        this.mapping,
      );
      if (!mapped) {
        mappingErrors.push({
          accountCode: account.accountCode,
          accountName: account.accountName,
          message:
            `No income-statement mapping for account '${account.accountCode}' ` +
            `('${account.accountName}'). Add an override to the club's ` +
            `IS mapping.`,
        });
        continue;
      }

      const amount = computeAmount({
        mode: input.mode,
        currentLine: tbLine,
        priorLine: priorLinesByCode?.get(tbLine.accountCode) ?? null,
      });

      // Skip zero-amount lines in current-month mode (no activity).
      // Keep them in YTD mode (a $0 YTD is meaningful — it says the
      // account exists but is unused).
      if (input.mode === "current-month" && amount === 0) continue;

      // Founder rule 2026-07-02 v15.0 — unmapped-fund lines are
      // NOT added to the operating or capital totals. They are
      // still returned in the snapshot (so operators can trace
      // the diagnostic to specific rows) and counted in the
      // unmappedFundAccounts diagnostic list. The IS snapshot's
      // `fund` field carries "operating" as a safe placeholder
      // (the snapshot contract's LedgerFund union does not
      // include "unmapped"; the DIAGNOSTIC list is what
      // reporting UIs check).
      if (mapped.bucket === "unmapped-fund") {
        unmappedFundAccounts.push({
          accountCode: mapped.accountCode,
          accountName: mapped.accountName,
          category: account.category,
          amount,
        });
        isLines.push({
          accountCode: mapped.accountCode,
          accountName: mapped.accountName,
          category: account.category,
          fund: "operating",
          departmentCode: mapped.departmentCode,
          amount,
        });
        continue;
      }

      const fund = bucketToFund(mapped.bucket) ?? "operating";
      isLines.push({
        accountCode: mapped.accountCode,
        accountName: mapped.accountName,
        category: bucketToCategory(mapped.bucket, account.category),
        fund,
        departmentCode: mapped.departmentCode,
        amount,
      });

      addToBucket(buckets, mapped.bucket, amount);
    }

    // Finalise computed roll-ups.
    buckets.totalOperatingRevenue = buckets.revenue + buckets.departmentalRevenue;
    buckets.totalOperatingExpense =
      buckets.payroll + buckets.operatingExpense + buckets.depreciation;
    buckets.noiBeforeDepreciation =
      buckets.totalOperatingRevenue - (buckets.payroll + buckets.operatingExpense);
    buckets.noi = buckets.totalOperatingRevenue - buckets.totalOperatingExpense;

    const diagnostics: IncomeStatementProjectionDiagnostics = {
      trialBalanceRevenueExpenseLineCount: tbCurrent.lines.filter((l) => {
        const a = currentAccountsByCode.get(l.accountCode);
        return a && (a.category === "revenue" || a.category === "expense");
      }).length,
      incomeStatementLineCount: isLines.length,
      mappingErrors,
      bucketTotals: buckets,
      unmappedFundAccounts,
      mode: input.mode,
      priorTrialBalanceSnapshotId: tbPrior?.snapshotId ?? null,
    };

    if (mappingErrors.length > 0) {
      return {
        status: "failed-mapping",
        diagnostics,
        notes:
          `${mappingErrors.length} revenue/expense account(s) could not be mapped. ` +
          `Add overrides to the club's IS mapping and re-run.`,
      };
    }

    // -------------------------------------------------------------
    // 5. Open a batch, write the snapshot, commit.
    // -------------------------------------------------------------
    const batchId = await this.writer.beginImportBatch({
      clubId: input.clubId,
      sourceSystem: tbCurrent.sourceSystem,
      notes:
        input.notes ??
        `Income Statement projection (${input.mode}) — derived from TB ${tbCurrent.snapshotId}` +
          (tbPrior ? ` minus TB ${tbPrior.snapshotId}` : ""),
    });

    const capturedAt = new Date();
    const snapshotId = `is_${input.clubId}_${input.fiscalYearLabel}_p${input.fiscalPeriodSequence}_${input.mode}_${randomUUID().slice(0, 8)}`;

    const snapshot: IncomeStatementSnapshot = {
      snapshotId,
      clubId: input.clubId,
      capturedAt,
      sourceSystem: tbCurrent.sourceSystem,
      importBatchId: batchId,
      dataSource: "derived",
      notes:
        input.notes ??
        `Derived from TB ${tbCurrent.snapshotId} via ${this.mapping.label} (mode: ${input.mode})`,
      entityKind: "income-statement",
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      fiscalYearLabel: input.fiscalYearLabel,
      fiscalPeriodSequence: input.fiscalPeriodSequence,
      lines: isLines,
      totalOperatingRevenue: buckets.totalOperatingRevenue,
      totalOperatingExpense: buckets.totalOperatingExpense,
      noiBeforeDepreciation: buckets.noiBeforeDepreciation,
      depreciation: buckets.depreciation,
      totalCapitalIncome: buckets.capitalIncome,
      totalCapitalExpense: buckets.capitalExpense,
    };

    const upsert = await this.writer.upsertSnapshot(snapshot);
    await this.writer.commitImportBatch(batchId);

    const storedSnapshot: IncomeStatementSnapshot =
      upsert.snapshotId === snapshot.snapshotId
        ? snapshot
        : { ...snapshot, snapshotId: upsert.snapshotId };

    return {
      status: "succeeded",
      snapshot: storedSnapshot,
      replaced: upsert.replaced,
      diagnostics,
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function indexAccounts(
  accounts: ReadonlyArray<LedgerAccount>,
): Map<string, LedgerAccount> {
  const m = new Map<string, LedgerAccount>();
  for (const a of accounts) m.set(a.accountCode, a);
  return m;
}

function indexLines(
  lines: ReadonlyArray<TrialBalanceLine>,
): Map<string, TrialBalanceLine> {
  const m = new Map<string, TrialBalanceLine>();
  for (const l of lines) m.set(l.accountCode, l);
  return m;
}

function computeAmount(args: {
  mode: "ytd" | "current-month";
  currentLine: TrialBalanceLine;
  priorLine: TrialBalanceLine | null;
}): number {
  // TB endingBalance is signed on the account's natural side
  // (positive for natural-side balances). Revenue lines are
  // natural-credit → positive endingBalance is positive revenue.
  // Expense lines are natural-debit → positive endingBalance is
  // positive expense. The IS contract stores both as positive
  // amounts; consumers compute NOI = sum(revenue) − sum(expense).
  const currentAbs = Math.abs(args.currentLine.endingBalance);
  if (args.mode === "ytd" || !args.priorLine) {
    return currentAbs;
  }
  const priorAbs = Math.abs(args.priorLine.endingBalance);
  // Current month = current YTD − prior YTD.
  return currentAbs - priorAbs;
}

function addToBucket(
  totals: IncomeStatementBucketTotals,
  bucket: IncomeStatementBucket,
  amount: number,
): void {
  switch (bucket) {
    case "revenue":              totals.revenue += amount; break;
    case "departmental-revenue": totals.departmentalRevenue += amount; break;
    case "payroll":              totals.payroll += amount; break;
    case "operating-expense":    totals.operatingExpense += amount; break;
    case "depreciation":         totals.depreciation += amount; break;
    case "capital-income":       totals.capitalIncome += amount; break;
    case "capital-expense":      totals.capitalExpense += amount; break;
    case "unmapped-fund":        break; // excluded from every roll-up
  }
}

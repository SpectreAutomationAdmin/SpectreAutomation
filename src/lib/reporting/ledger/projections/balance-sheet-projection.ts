// Balance Sheet Projection — first Reporting Ledger projection service.
//
// Workflow per docs/reporting-ledger-architecture.md:
//
//   Trial Balance Snapshot (in ledger)
//       ↓ (read by clubId + asOf)
//   per-account category mapping (configuration driven)
//       ↓ (aggregate revenue / expense → YTD net income)
//   Balance Sheet Snapshot
//       ↓ (writer.beginImportBatch → upsertSnapshot → commitImportBatch)
//   ledger.getBalanceSheet(clubId, asOf) returns the projection
//
// The projection is DERIVED — its `dataSource` is `"derived"` and it
// inherits `sourceSystem` from the source Trial Balance (so the audit
// trail still points back to Jonas / Spectre Accounting / etc.).
//
// Re-projecting after the source TB is replaced (corrected import)
// writes a new Balance Sheet snapshot via the same `upsertSnapshot`
// idempotency path; bit-identical re-projection is a no-op.

import { randomUUID } from "node:crypto";

import type {
  BalanceSheetLine,
  BalanceSheetSnapshot,
  LedgerAccount,
  TrialBalanceLine,
  TrialBalanceSnapshot,
} from "@/lib/reporting/ledger/contracts";
import type { ReportingLedger } from "@/lib/reporting/ledger/read-api";
import type { ReportingLedgerWriter } from "@/lib/reporting/ledger/write-api";

import {
  DEFAULT_BALANCE_SHEET_MAPPING,
  mapBalanceSheetAccount,
  type BalanceSheetMapping,
  type MappedBalanceSheetAccount,
} from "@/lib/reporting/ledger/projections/balance-sheet-mapping";
import {
  deriveBalanceSheetCategoryFromCoa,
  resolveBalanceSheetLineClassifications,
  type BalanceSheetLineClassification,
} from "@/lib/reporting/ledger/classification-resolver";

// ---------------------------------------------------------------------------
// Result + diagnostics
// ---------------------------------------------------------------------------

export type BalanceSheetMappingError = {
  accountCode: string;
  accountName: string;
  message: string;
};

export type BalanceSheetProjectionDiagnostics = {
  /** Total TB lines considered. */
  trialBalanceLineCount: number;
  /** TB lines mapped to a balance-sheet category. */
  balanceSheetLineCount: number;
  /** TB lines aggregated into YTD net income (revenue + expense). */
  netIncomeLineCount: number;
  /** TB lines that could not be mapped + are not revenue/expense. */
  mappingErrors: ReadonlyArray<BalanceSheetMappingError>;
  /** Computed YTD net income (revenue − expense). Positive = profit. */
  computedYtdNetIncome: number;
  /** Pre-rolled section subtotals. */
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  /** `true` when totalAssets ≈ totalLiabilities + totalEquity within $1. */
  isReconciled: boolean;
};

export type BalanceSheetProjectionResult =
  | {
      status: "succeeded";
      snapshot: BalanceSheetSnapshot;
      replaced: boolean;
      diagnostics: BalanceSheetProjectionDiagnostics;
    }
  | {
      status: "no-trial-balance";
      diagnostics: null;
      notes: string;
    }
  | {
      status: "failed-mapping";
      diagnostics: BalanceSheetProjectionDiagnostics;
      notes: string;
    }
  | {
      status: "failed-reconciliation";
      diagnostics: BalanceSheetProjectionDiagnostics;
      notes: string;
    };

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type BalanceSheetProjectionInput = {
  clubId: string;
  /** Balance-sheet date. Projection reads the latest TB at-or-before
   *  this date (point-in-time semantic of the ledger). */
  asOf: Date;
  /** Optional notes — surfaced on the resulting snapshot's metadata. */
  notes?: string;
};

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

export class BalanceSheetProjection {
  private readonly ledger: ReportingLedger;
  private readonly writer: ReportingLedgerWriter;
  private readonly mapping: BalanceSheetMapping;

  constructor(args: {
    ledger: ReportingLedger;
    writer: ReportingLedgerWriter;
    mapping?: BalanceSheetMapping;
  }) {
    this.ledger = args.ledger;
    this.writer = args.writer;
    this.mapping = args.mapping ?? DEFAULT_BALANCE_SHEET_MAPPING;
  }

  /**
   * Project the Trial Balance at `asOf` into a Balance Sheet Snapshot.
   * Writes the result to the ledger and returns it. Re-projection
   * after a TB correction writes a new BS snapshot (the prior one
   * stays in the ledger for audit).
   */
  async getBalanceSheetSnapshot(
    input: BalanceSheetProjectionInput,
  ): Promise<BalanceSheetProjectionResult> {
    // -------------------------------------------------------------
    // 1. Read latest TB at-or-before `asOf`.
    // -------------------------------------------------------------
    const tb = await this.ledger.getTrialBalance(input.clubId, input.asOf);
    if (!tb) {
      return {
        status: "no-trial-balance",
        diagnostics: null,
        notes: `No trial balance found for club '${input.clubId}' at or before ${input.asOf.toISOString().slice(0, 10)}`,
      };
    }

    // -------------------------------------------------------------
    // 2. Index TB accounts by code (lookup needed for each line).
    // -------------------------------------------------------------
    const accountsByCode = new Map<string, LedgerAccount>();
    for (const a of tb.accounts) accountsByCode.set(a.accountCode, a);

    // -------------------------------------------------------------
    // 3. Founder rule 2026-07-13 v15.16 — CoA classification is
    //    consulted FIRST. Resolve every TB account against the
    //    Chart of Accounts in one bounded query, then use the CoA
    //    classification to decide (a) whether the account is
    //    revenue/expense (aggregate into YTD net income) or
    //    balance-sheet (build a BS line), and (b) which
    //    BalanceSheetCategory section it belongs in. The
    //    range-based `mapBalanceSheetAccount` is now only a
    //    FALLBACK for accounts with no CoA record (rare; typically
    //    a stale TB reference).
    //
    //    This closes the founder's reported $26.6M reconciliation
    //    defect: live Silver Springs PP&E accounts (e.g. numbered
    //    outside 1900-1999) were being misclassified as
    //    `current-asset` under the old range mapping.
    // -------------------------------------------------------------
    const coaClassifications = await resolveBalanceSheetLineClassifications({
      clubId: input.clubId,
      accountCodes: tb.lines.map((l) => l.accountCode),
    });

    const bsLines: BalanceSheetLine[] = [];
    const mappingErrors: BalanceSheetMappingError[] = [];
    let revenueTotal = 0;
    let expenseTotal = 0;
    let netIncomeLineCount = 0;
    // v15.16 / v15.17 — detect closing-entries-booked case. When the
    // TB carries an account whose CoA fsGroupKey is
    // `BS_CURRENT_YEAR_EARNINGS` AND its balance is NON-ZERO, the
    // year's surplus/deficit has already been closed into that
    // equity account. A synthetic roll-up would double-count. The
    // v15.17 refinement: a *placeholder* account with a zero balance
    // must NOT suppress the synthetic — otherwise the balance sheet
    // shows no current-year earnings at all when the CoA maintains
    // an empty placeholder for the year's activity.
    let ytdEarningsAlreadyBooked = false;

    for (const line of tb.lines) {
      const account = accountsByCode.get(line.accountCode);
      if (!account) {
        mappingErrors.push({
          accountCode: line.accountCode,
          accountName: "(unknown — not in TB.accounts)",
          message: `TB line references unknown account '${line.accountCode}'`,
        });
        continue;
      }

      const coa = coaClassifications.get(line.accountCode);

      // v15.16 — CoA-first side determination. When the CoA record
      // exists, use `Account.type` (REVENUE / EXPENSE / ASSET /
      // LIABILITY / EQUITY) as the authoritative side signal —
      // never the coarse LedgerAccountCategory the TB importer
      // derived from account-number patterns.
      const effectiveType =
        (coa?.accountType?.toUpperCase() ?? null) ??
        (account.category === "revenue" ? "REVENUE" :
         account.category === "expense" ? "EXPENSE" :
         account.category === "asset"   ? "ASSET" :
         account.category === "liability" ? "LIABILITY" :
         "EQUITY");

      // Revenue + expense → roll into YTD net income.
      if (effectiveType === "REVENUE" || effectiveType === "EXPENSE") {
        if (effectiveType === "REVENUE") {
          revenueTotal += Math.abs(line.endingBalance);
        } else {
          expenseTotal += Math.abs(line.endingBalance);
        }
        netIncomeLineCount++;
        continue;
      }

      // v15.16 — Balance-sheet section derived from CoA when
      // possible. Falls back to range-based mapping only when the
      // CoA record has no category / fsGroup assignment.
      //
      // v15.17 — accountName threaded through so the contra-asset
      // pattern detector runs even when the CoA has no explicit
      // BS_ACCUMULATED_DEPRECIATION FS Group. Founder-authorised
      // legacy fallback that prevents accum. depreciation from
      // inflating Total Assets.
      const coaCategory = deriveBalanceSheetCategoryFromCoa({
        accountType: coa?.accountType ?? effectiveType,
        categoryKey: coa?.categoryKey ?? null,
        fsGroupKey: coa?.fsGroupKey ?? null,
        accountName: account.accountName,
        fsGroupName: coa?.fsGroupName ?? null,
      });

      let mapped: MappedBalanceSheetAccount | null = null;
      if (coaCategory !== null) {
        mapped = {
          accountCode: account.accountCode,
          accountName: account.accountName,
          category: coaCategory,
          source: "explicit-override",
        };
      } else {
        mapped = mapBalanceSheetAccount(
          { accountNumber: account.accountCode, accountName: account.accountName },
          this.mapping,
        );
      }
      if (!mapped) {
        // No CoA classification AND no range fallback — genuine
        // unmapped. Surface via `mappingErrors` so the projection
        // returns `failed-mapping` status and refuses to write the
        // snapshot. This preserves the pre-v15.16 strict contract
        // and the founder's rule "an unresolved account of material
        // amount blocks publication." Materiality is enforced
        // upstream via `mappingErrors.length > 0` (any unmapped is
        // material for balance-sheet integrity).
        mappingErrors.push({
          accountCode: account.accountCode,
          accountName: account.accountName,
          message:
            `No CoA classification for account '${account.accountCode}' ` +
            `('${account.accountName}'). Assign it a Category + FS Group ` +
            `on the Chart of Accounts.`,
        });
        continue;
      }

      // v15.17 — the flag flips ONLY when the actual account has a
      // NON-ZERO balance. A zero-balance placeholder must not
      // suppress the synthetic YTD line — otherwise mid-year TBs
      // whose CoA maintains an empty "Current-Year Earnings" account
      // would lose their YTD roll-up entirely.
      if (
        coa?.fsGroupKey?.toUpperCase() === "BS_CURRENT_YEAR_EARNINGS" &&
        Math.abs(line.endingBalance) >= 1
      ) {
        ytdEarningsAlreadyBooked = true;
      }

      bsLines.push(buildBalanceSheetLine(line, account, mapped));
    }

    // -------------------------------------------------------------
    // 3b. Founder rule 2026-07-13 v15.15/v15.16 — enrich each Balance
    //     Sheet line with its Chart of Accounts classification
    //     (Category, FS Group, sort order). The Category-derivation
    //     happened above (step 3), but pre-existing bsLines built
    //     from the range-fallback path still need fsGroupKey filled
    //     in so the SoFP aggregator can group them.
    // -------------------------------------------------------------
    for (let i = 0; i < bsLines.length; i++) {
      const line = bsLines[i];
      const c = coaClassifications.get(line.accountCode);
      if (!c) continue; // no ChartAccount match — leave as unmapped
      bsLines[i] = enrichBalanceSheetLine(line, c);
    }

    // -------------------------------------------------------------
    // 4. v15.16 — synthetic YTD net income.
    //
    //    The projection aggregates REVENUE - EXPENSE from the TB
    //    into a single equity line that closes the balance-sheet
    //    equation (Assets = Liabilities + Equity + YTD earnings).
    //
    //    IMPORTANT: skip this synthetic line when the TB already
    //    contains an account whose CoA fsGroupKey is
    //    BS_CURRENT_YEAR_EARNINGS. In that case month-end / year-end
    //    closing entries have already booked the surplus / deficit
    //    into that equity account, and rolling in the synthetic
    //    would double-count.
    // -------------------------------------------------------------
    const computedYtdNetIncome = revenueTotal - expenseTotal;
    if (
      (netIncomeLineCount > 0 || computedYtdNetIncome !== 0) &&
      !ytdEarningsAlreadyBooked
    ) {
      // v15.17 — founder-approved display labels. Positive surplus
      // renders as "Current-Year Earnings to Date"; a deficit
      // renders as "Current-Year Deficit to Date". Both share the
      // same FS Group key (`BS_CURRENT_YEAR_EARNINGS`) + sortOrder
      // so they occupy the same section slot beneath Retained
      // Earnings on the Statement of Financial Position.
      const isDeficit = computedYtdNetIncome < 0;
      bsLines.push({
        accountCode: "__YTD_NET_INCOME__",
        accountName: isDeficit
          ? "Current-Year Deficit to Date"
          : "Current-Year Earnings to Date",
        category: "ytd-net-income",
        fund: "operating",
        amount: computedYtdNetIncome,
        priorYearSameDateAmount: null,
        fsGroupKey: "BS_CURRENT_YEAR_EARNINGS",
        fsGroupName: isDeficit
          ? "Current-Year Deficit to Date"
          : "Current-Year Earnings to Date",
        fsGroupSortOrder: 820,
      });
    }

    // -------------------------------------------------------------
    // 5. Roll-ups + reconciliation.
    // -------------------------------------------------------------
    const totals = rollupTotals(bsLines);

    const diagnostics: BalanceSheetProjectionDiagnostics = {
      trialBalanceLineCount: tb.lines.length,
      balanceSheetLineCount: bsLines.length,
      netIncomeLineCount,
      mappingErrors,
      computedYtdNetIncome,
      totalAssets: totals.totalAssets,
      totalLiabilities: totals.totalLiabilities,
      totalEquity: totals.totalEquity,
      isReconciled: totals.isReconciled,
    };

    if (mappingErrors.length > 0) {
      return {
        status: "failed-mapping",
        diagnostics,
        notes:
          `${mappingErrors.length} TB account(s) could not be mapped. ` +
          `Add overrides to the club's balance-sheet mapping and re-run.`,
      };
    }

    if (!totals.isReconciled) {
      return {
        status: "failed-reconciliation",
        diagnostics,
        notes:
          `Balance sheet does NOT reconcile: assets ${totals.totalAssets.toFixed(2)} ` +
          `vs liabilities+equity ${(totals.totalLiabilities + totals.totalEquity).toFixed(2)} ` +
          `(delta ${(totals.totalAssets - totals.totalLiabilities - totals.totalEquity).toFixed(2)}). ` +
          `Snapshot was NOT written.`,
      };
    }

    // -------------------------------------------------------------
    // 6. Open a batch, write the snapshot, commit.
    // -------------------------------------------------------------
    const batchId = await this.writer.beginImportBatch({
      clubId: input.clubId,
      sourceSystem: tb.sourceSystem,
      notes:
        input.notes ??
        `Balance Sheet projection — derived from TB ${tb.snapshotId} (as of ${tb.asOf.toISOString().slice(0, 10)})`,
    });

    const capturedAt = new Date();
    const snapshotId = `bs_${input.clubId}_${tb.fiscalYearLabel}_p${tb.fiscalPeriodSequence}_${randomUUID().slice(0, 8)}`;

    const snapshot: BalanceSheetSnapshot = {
      snapshotId,
      clubId: input.clubId,
      capturedAt,
      sourceSystem: tb.sourceSystem,
      importBatchId: batchId,
      dataSource: "derived",
      notes:
        input.notes ??
        `Derived from TB snapshot ${tb.snapshotId} via ${this.mapping.label}`,
      entityKind: "balance-sheet",
      asOf: tb.asOf,
      fiscalYearLabel: tb.fiscalYearLabel,
      lines: bsLines,
      totalAssets: totals.totalAssets,
      totalLiabilities: totals.totalLiabilities,
      totalEquity: totals.totalEquity,
      isReconciled: totals.isReconciled,
    };

    const upsert = await this.writer.upsertSnapshot(snapshot);
    await this.writer.commitImportBatch(batchId);

    // Reflect the ledger's authoritative snapshot id — when the
    // payload is bit-identical to the prior snapshot, the ledger
    // returns the EXISTING id (no-op) rather than storing our newly
    // minted one. Returning the actual stored id keeps callers and
    // the ledger in sync.
    const storedSnapshot: BalanceSheetSnapshot =
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

function buildBalanceSheetLine(
  tbLine: TrialBalanceLine,
  account: LedgerAccount,
  mapped: MappedBalanceSheetAccount,
): BalanceSheetLine {
  // Per the BalanceSheetLine contract, `amount` is positive — the
  // category drives the sign convention. The TB's `endingBalance` is
  // signed (positive on the account's natural side, negative for
  // contra-balances like accumulated depreciation booked as an asset).
  // For all balance-sheet categories the amount is the absolute value.
  return {
    accountCode: mapped.accountCode,
    accountName: mapped.accountName,
    category: mapped.category,
    fund: account.fund,
    amount: Math.abs(tbLine.endingBalance),
    priorYearSameDateAmount: null,
    // v15.15 — if the LedgerAccount was importer-enriched (i.e. the
    // Jonas importer joined the ChartAccount table at capture time)
    // carry those fields onto the BS line so the classification
    // survives the projection. Legacy TB snapshots leave these
    // undefined; the enrichment step further below fills them via
    // a bounded Prisma lookup.
    fsGroupKey: account.fsGroupKey,
    fsGroupName: account.fsGroupName,
    fsGroupSortOrder: account.fsGroupSortOrder,
    // v15.19 — preserve raw TB sign so dynamic tax-family netting
    // reads the actual imported debit/credit direction rather than
    // guessing from account name. Jonas convention is debit-positive
    // / credit-negative — GST Filed at +$9,135.35 debit stays
    // positive; GST Collected at -$31,625.49 credit stays negative.
    rawSignedAmount: tbLine.endingBalance,
  };
}

/** v15.15 — enrich a projected balance-sheet line with the
 *  classification resolved from the current ChartAccount record.
 *  Idempotent: if the line already carries a classification (e.g.
 *  from an importer-enriched LedgerAccount), the resolver's value
 *  takes precedence when non-null. */
function enrichBalanceSheetLine(
  line: BalanceSheetLine,
  c: BalanceSheetLineClassification,
): BalanceSheetLine {
  return {
    ...line,
    fsGroupKey: c.fsGroupKey ?? line.fsGroupKey,
    fsGroupName: c.fsGroupName ?? line.fsGroupName,
    fsGroupSortOrder: c.fsGroupSortOrder ?? line.fsGroupSortOrder,
  };
}

function rollupTotals(lines: ReadonlyArray<BalanceSheetLine>): {
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  isReconciled: boolean;
} {
  let currentAssets = 0;
  let capitalFundAssets = 0;
  let ppeGross = 0;
  let accumDepr = 0;
  let currentLiab = 0;
  let longTermLiab = 0;
  let operatingFund = 0;
  let capitalFund = 0;
  let ytdNetIncome = 0;

  for (const l of lines) {
    switch (l.category) {
      case "current-asset":
        currentAssets += l.amount;
        break;
      case "capital-fund-asset":
        capitalFundAssets += l.amount;
        break;
      case "ppe-gross":
        ppeGross += l.amount;
        break;
      case "ppe-accumulated-depreciation":
        accumDepr += l.amount;
        break;
      case "current-liability":
        currentLiab += l.amount;
        break;
      case "long-term-liability":
        longTermLiab += l.amount;
        break;
      case "operating-fund-balance":
        operatingFund += l.amount;
        break;
      case "capital-fund-balance":
        capitalFund += l.amount;
        break;
      case "ytd-net-income":
        // Signed: positive = profit, negative = loss.
        ytdNetIncome += l.amount;
        break;
    }
  }

  const totalAssets = currentAssets + capitalFundAssets + ppeGross - accumDepr;
  const totalLiabilities = currentLiab + longTermLiab;
  const totalEquity = operatingFund + capitalFund + ytdNetIncome;
  const delta = totalAssets - (totalLiabilities + totalEquity);

  return {
    totalAssets,
    totalLiabilities,
    totalEquity,
    isReconciled: Math.abs(delta) < 1,
  };
}

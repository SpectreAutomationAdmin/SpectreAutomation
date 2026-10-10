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
// MBR-FIX-2C (2026-10-10) — Prisma lookup used to enrich accounts
// with their authoritative `fsGroupKey` for NOI classification.  The
// TB payload the ledger abstraction returns does not carry fsGroupKey
// (Jonas import path predates v15.15 account-level enrichment), so
// bucketing solely by account-number ranges misclassified Coulee's
// 6115 "Depreciation" and 6083 "Interest Expense" as operating
// expense — understating NOI Before Depreciation by $92,136.19 on
// the Feb 2026 package vs the fsGroup-aware resolvers.  Lookup is
// batched + guarded; a Prisma failure degrades gracefully to the
// pre-fix range-only path.
import { prisma } from "@/lib/prisma";

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
 * expenses / depreciation / financing / capital income / capital
 * expense) plus the computed NOI.
 *
 * MBR-FIX-2C (2026-10-10) — `financing` is NEW: a sidecar tally of
 * accounts tagged `fsGroup.key = IS_INTEREST_EXPENSE`.  Those
 * accounts also appear in `operatingExpense` (they fall through
 * the account-number range rules); the financing sidecar lets the
 * NOI formula carve interest expense back out so NOI Before
 * Depreciation reconciles to the Operating Results chart +
 * ratio-registry + Statement of Activities.  Field is defaulted to
 * 0 on legacy consumers to preserve back-compat.
 *
 * Total operating revenue = revenue + departmental-revenue
 * Total operating expense = payroll + operating-expense + depreciation
 * NOI before depreciation = total operating revenue
 *                           − (payroll + operating-expense − financing)
 *                         = total operating revenue
 *                           − payroll − operating-expense + financing
 * NOI                     = total operating revenue
 *                           − total operating expense + financing
 *                         = NOI before depreciation − depreciation
 */
export type IncomeStatementBucketTotals = {
  revenue: number;
  departmentalRevenue: number;
  payroll: number;
  operatingExpense: number;
  depreciation: number;
  /** MBR-FIX-2C — side-tally of IS_INTEREST_EXPENSE amounts that
   *  were already added to `operatingExpense`.  Carved out of the
   *  NOI formula so NOI matches the authoritative Spectre
   *  definition (excludes financing). */
  financing: number;
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
      financing: 0,
      capitalIncome: 0,
      capitalExpense: 0,
      totalOperatingRevenue: 0,
      totalOperatingExpense: 0,
      noiBeforeDepreciation: 0,
      noi: 0,
    };

    // MBR-FIX-2C (2026-10-10) — authoritative-metadata enrichment.
    //
    // The Jonas-imported TB payload does NOT carry fsGroup.key or
    // Account.fundApplicability on individual `account` entries
    // (confirmed via `scratchpad/mbr-fix-2c-payload-check.js`).
    // Without these:
    //   • IS_DEPRECIATION / IS_INTEREST_EXPENSE promotion silently
    //     fails, understating NOI by $92K on Coulee Feb 2026.
    //   • Capital-fund accounts (fundApplicability = CAPITAL) land
    //     under their account-number range bucket instead of being
    //     promoted to `capital-income` / `capital-expense`, inflating
    //     operating revenue by ~$190K on Coulee Feb 2026.
    //
    // Both failures previously cancelled out via a lossy pre-fix NOI
    // formula.  MBR-FIX-2C restores both signals with a single bulk
    // Prisma lookup (one `findMany` across every account code in
    // the current TB), guarded against unit-test paths that use the
    // in-memory ledger (no Prisma in scope).
    const accountCodes = Array.from(currentLinesByCode.keys());
    const fsGroupKeyByCode = new Map<string, string | null>();
    const fundApplicabilityByCode = new Map<string, string | null>();
    try {
      const rows = await prisma.account.findMany({
        where: { clubId: input.clubId, accountNumber: { in: accountCodes } },
        select: {
          accountNumber: true,
          fundApplicability: true,
          fsGroup: { select: { key: true } },
        },
      });
      for (const r of rows) {
        fsGroupKeyByCode.set(r.accountNumber, r.fsGroup?.key ?? null);
        fundApplicabilityByCode.set(r.accountNumber, r.fundApplicability ?? null);
      }
    } catch {
      /* Enrichment unavailable — proceed with payload-only metadata. */
    }

    const unmappedFundAccounts: Array<{
      accountCode: string;
      accountName: string;
      category: "revenue" | "expense";
      amount: number;
    }> = [];

    // TB-HIST-2 (2026-10-01) — iterate the aggregated map so a
    // dimensional snapshot (multiple lines per accountCode) yields a
    // single IS line per account using the SUM of dimensional balances.
    for (const tbLine of currentLinesByCode.values()) {
      const account = currentAccountsByCode.get(tbLine.accountCode);
      if (!account) continue; // (shouldn't happen — TB invariant)
      if (account.category !== "revenue" && account.category !== "expense") {
        continue; // skip BS accounts
      }

      // MBR-FIX-2C — resolve fundApplicability from Prisma if the
      // payload didn't carry it (Jonas path), falling back to the
      // payload value when enrichment is unavailable.
      //
      // Operating-first normalisation: when an account is tagged
      // "OPERATING,CAPITAL" (dual-fund), the mapper's
      // `isCapitalAccount` helper returns true (CAPITAL appears
      // anywhere in the CSV) and would promote the entire line to
      // capital-income / capital-expense.  Every OTHER resolver on
      // the operating-fund path (ratio-registry, FsGroupProjection,
      // computeOperationsPartialAvailability) treats dual-fund as
      // operating via a `.includes("OPERATING")` check.  This
      // resolver must agree, otherwise the Executive At-A-Glance
      // double-counts a dual-fund account as capital-expense while
      // the Statement of Activities + Operating Results chart count
      // the same account as operating-expense.  Normalising to just
      // "OPERATING" when OPERATING is present preserves the mapper's
      // capital-promotion for genuinely CAPITAL-only accounts without
      // changing the mapper's shared semantics.
      const payloadFundApplicability =
        (account as LedgerAccount & { fundApplicability?: string | null }).fundApplicability ?? null;
      const rawFundApplicability =
        fundApplicabilityByCode.get(account.accountCode) ?? payloadFundApplicability;
      const normalisedFundApplicability = (() => {
        if (!rawFundApplicability) return rawFundApplicability;
        const parts = rawFundApplicability
          .split(",")
          .map((p) => p.trim().toUpperCase())
          .filter((p) => p.length > 0);
        if (parts.includes("OPERATING")) return "OPERATING";
        return rawFundApplicability;
      })();
      const mapped = mapIncomeStatementAccount(
        {
          accountNumber: account.accountCode,
          accountName: account.accountName,
          accountCategory: account.category,
          accountFundApplicability: normalisedFundApplicability,
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
        // TB-HIST-2 (2026-10-01) — pass both snapshots' fiscal-year
        // labels so the current-month branch can detect a fiscal-year
        // boundary and skip the (wrong) `|current YTD| − |prior YTD|`
        // subtraction. See `computeAmount` for the exact rule.
        currentFiscalYearLabel: tbCurrent.fiscalYearLabel,
        priorFiscalYearLabel: tbPrior?.fiscalYearLabel ?? null,
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

      // MBR-FIX-2C (2026-10-10) — fsGroup-aware bucket promotion.
      // When the account's authoritative `fsGroup.key` is
      // IS_DEPRECIATION, override the range-rule bucket to
      // `depreciation` so the carve-out survives Coulee-style
      // non-standard numbering (6115 Depreciation lands in the
      // 6000-6499 operating-expense range by number).  For
      // IS_INTEREST_EXPENSE, keep the range-rule bucket (the
      // amount still appears in the operating-expense roll-up on
      // the Statement of Activities) but tally it to a
      // `financing` sidecar that the NOI formula subtracts back
      // out below, matching the authoritative NOI Before
      // Depreciation definition.
      const fsKey = fsGroupKeyByCode.get(mapped.accountCode) ?? null;
      let effectiveBucket: IncomeStatementBucket = mapped.bucket;
      if (fsKey === "IS_DEPRECIATION" && effectiveBucket !== "depreciation"
          && effectiveBucket !== "capital-income" && effectiveBucket !== "capital-expense") {
        effectiveBucket = "depreciation";
      }
      const fund = bucketToFund(effectiveBucket) ?? "operating";
      isLines.push({
        accountCode: mapped.accountCode,
        accountName: mapped.accountName,
        category: bucketToCategory(effectiveBucket, account.category),
        fund,
        departmentCode: mapped.departmentCode,
        amount,
      });

      addToBucket(buckets, effectiveBucket, amount);
      if (fsKey === "IS_INTEREST_EXPENSE"
          && (effectiveBucket === "operating-expense" || effectiveBucket === "payroll")) {
        buckets.financing += amount;
      }
    }

    // Finalise computed roll-ups.
    buckets.totalOperatingRevenue = buckets.revenue + buckets.departmentalRevenue;
    buckets.totalOperatingExpense =
      buckets.payroll + buckets.operatingExpense + buckets.depreciation;
    // MBR-FIX-2C — carve financing (IS_INTEREST_EXPENSE) out of
    // NOI Before Depreciation.  The amount is still part of
    // `operatingExpense` so the Section IV / Capital Fund / detail
    // listings continue to show it, but NOI matches the
    // authoritative Spectre definition (above-the-line NOI
    // excludes both depreciation AND financing).
    buckets.noiBeforeDepreciation =
      buckets.totalOperatingRevenue
      - buckets.payroll
      - buckets.operatingExpense
      + buckets.financing;
    buckets.noi = buckets.noiBeforeDepreciation - buckets.depreciation;

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
  // TB-HIST-2 (2026-10-01) — dimensional snapshots may carry
  // multiple lines per accountCode (one per Department×Fund).
  // Aggregate them into a single synthetic line per accountCode
  // so IS consumers that key on accountCode see the consolidated
  // balance. Non-dimensional snapshots degenerate to one row per
  // accountCode (unchanged behaviour).
  const m = new Map<string, TrialBalanceLine>();
  for (const l of lines) {
    const prev = m.get(l.accountCode);
    if (!prev) {
      // Store a shallow copy so later aggregation doesn't mutate the
      // caller's snapshot payload.
      m.set(l.accountCode, {
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
        endingBalance: l.endingBalance,
        // Collapsed to null when the account has dimensional detail
        // — the aggregated view is not scoped to any single
        // department or fund.
        department: null,
        fund: null,
      });
      continue;
    }
    prev.debit += l.debit;
    prev.credit += l.credit;
    prev.endingBalance += l.endingBalance;
  }
  return m;
}

export function computeAmount(args: {
  mode: "ytd" | "current-month";
  currentLine: TrialBalanceLine;
  priorLine: TrialBalanceLine | null;
  // TB-HIST-2 (2026-10-01) — fiscal-year labels of the two TB
  // snapshots. When they differ, the prior snapshot represents a
  // DIFFERENT fiscal year's accumulated YTD and must NOT be
  // subtracted. Omit (undefined) to preserve the pre-TB-HIST-2
  // behaviour (used by legacy callers and in-memory tests that
  // don't model fiscal years).
  currentFiscalYearLabel?: string;
  priorFiscalYearLabel?: string | null;
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
  // TB-HIST-2 §1 — if the prior snapshot belongs to a different
  // fiscal year, treat the current-month amount as the current
  // fiscal YTD directly. Subtracting prior-FY YTD from current-FY YTD
  // produces a large negative at every fiscal-year boundary (defect
  // B1 identified in TB-HIST-1).
  const bothLabelsPresent =
    typeof args.currentFiscalYearLabel === "string" &&
    typeof args.priorFiscalYearLabel === "string";
  if (bothLabelsPresent && args.currentFiscalYearLabel !== args.priorFiscalYearLabel) {
    return currentAbs;
  }
  const priorAbs = Math.abs(args.priorLine.endingBalance);
  // Current month = current YTD − prior YTD (within the same FY).
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

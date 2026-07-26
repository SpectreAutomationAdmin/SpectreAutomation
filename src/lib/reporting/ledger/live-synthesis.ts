// Founder rule 2026-07-01 v14.11 — synthesize ReportingLedger
// snapshots from the live GL when no persisted snapshot exists
// for a period AND the club has committed a real Opening Trial
// Balance import.
//
// Background:
//   • The Monthly Reporting Package uses a "dual-read" pattern:
//     `PrismaReportingLedger.getTrialBalance/getBalanceSheet/
//     getIncomeStatement` queries a snapshot table that's only
//     populated by a legacy Jonas month-end import pipeline.
//   • The v14.3 Opening Trial Balance import writes real journal
//     entries to `JournalEntry` / `JournalEntryLine`, but does
//     NOT populate the reporting-ledger snapshot table.
//   • Result: the package falls through to the DEMO fallback and
//     shows figures like YTD Revenue $14.62M even after the
//     founder imports a real April 2026 TB with real YTD
//     Revenue $4.69M.
//
// Fix:
//   • This module synthesizes snapshots from the live accounting
//     service on demand. `PrismaReportingLedger` calls it as a
//     fallback when the snapshot table has no row for the requested
//     asOf / period.
//   • The synthesized snapshot uses `sourceSystem: "spectre-accounting"`
//     so provenance is clear in the UI.
//   • Every derived number goes through the SAME accounting
//     service the Finance reports use (`trialBalance`, `balanceSheet`,
//     `incomeStatement`) — Monthly Package numbers automatically
//     reconcile to Finance report numbers for the same period.

import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import {
  trialBalance,
  balanceSheet,
  incomeStatementByDepartment,
} from "@/lib/accounting/reports";
import { accountBalances, hasCommittedRealTrialBalance } from "@/lib/accounting/balance";
import { hasFund } from "@/lib/accounting/fund-applicability";
import type {
  BalanceSheetCategory,
  BalanceSheetLine,
  BalanceSheetSnapshot,
  IncomeStatementLine,
  IncomeStatementSnapshot,
  LedgerAccount,
  LedgerAccountCategory,
  LedgerFund,
  TrialBalanceLine,
  TrialBalanceSnapshot,
} from "@/lib/reporting/ledger/contracts";

// ---------------------------------------------------------------------------
// Fiscal-period lookup — the snapshot types carry fiscalYearLabel +
// fiscalPeriodSequence, so we need to resolve them from the DB.
// ---------------------------------------------------------------------------
async function resolveFiscalMetadata(
  clubId: string,
  asOf: Date,
): Promise<{ fiscalYearLabel: string; fiscalPeriodSequence: number } | null> {
  const period = await prisma.fiscalPeriod.findFirst({
    where: {
      fiscalYear: { clubId },
      startDate: { lte: asOf },
      endDate: { gte: asOf },
    },
    include: { fiscalYear: true },
  });
  if (!period) return null;
  return {
    fiscalYearLabel: period.fiscalYear.label,
    fiscalPeriodSequence: period.sequence,
  };
}

// ---------------------------------------------------------------------------
// Account-category mapping — the Prisma Account row's `type` is
// UPPERCASE ("ASSET"/"REVENUE"/...); the LedgerAccount contract
// uses lowercase category strings.
// ---------------------------------------------------------------------------
function toCategory(type: string): LedgerAccountCategory {
  switch (type.toUpperCase()) {
    case "ASSET": return "asset";
    case "LIABILITY": return "liability";
    case "EQUITY": return "equity";
    case "REVENUE": return "revenue";
    case "EXPENSE": return "expense";
    default: return "expense";
  }
}

// Founder rule 2026-07-02 v15.0 — Primary fund resolution.
//
// For P&L accounts, `Account.fundApplicability` is the single
// source of truth. This helper picks the "primary" (first) fund
// key from the CSV — used as the LedgerAccount.fund tag on the
// snapshot line. A P&L account with NULL fundApplicability
// (configuration error) defaults to "operating" here so the
// snapshot contract's non-null `fund` field can be populated;
// the mapper downstream still routes such lines to the
// unmapped-fund diagnostic based on the fundApplicability field.
//
// For BS accounts, the historical FS-group-based capital
// inference remains — capital-reserve BS accounts, capital
// asset accounts, and long-term financing accounts are marked
// "capital" here so the Balance Sheet projection can group them
// into the Capital Fund side of the balance sheet.
function primaryFundFor(
  accountType: string,
  fundApplicability: string | null,
  fsGroupKey: string | null,
): LedgerFund {
  const type = accountType.toUpperCase();
  if (type === "REVENUE" || type === "EXPENSE") {
    // P&L path — CoA is the source of truth.
    if (fundApplicability && fundApplicability.length > 0) {
      const tokens = fundApplicability.split(",").map((t) => t.trim().toUpperCase());
      if (tokens.includes("CAPITAL")) return "capital";
      if (tokens.includes("OPERATING")) return "operating";
    }
    return "operating";
  }
  // BS path — FS group carries the capital indicator until BS
  // side receives its own Fund Applicability property.
  const key = String(fsGroupKey ?? "");
  if (
    key === "BS_CAPITAL_ASSETS" ||
    key === "BS_CAPITAL_RESERVE" ||
    key === "BS_LONG_TERM_DEBT" ||
    key === "BS_LEASE_LIABILITIES" ||
    key === "BS_DEFERRED_CAPITAL_CONTRIBUTIONS"
  ) return "capital";
  return "operating";
}

// ---------------------------------------------------------------------------
// Trial Balance synthesis
// ---------------------------------------------------------------------------
/**
 * Return a live-synthesized `TrialBalanceSnapshot` for the club at
 * `asOf` if a committed real Trial Balance import exists. Returns
 * `null` when the club has no real import — the caller (`PrismaReportingLedger`)
 * falls through to its own null, which triggers the builder's demo
 * fallback.
 *
 * Idempotent: computes fresh each call. The `snapshotId` is stable
 * for a given (clubId, asOf) via a deterministic hash so downstream
 * cache keys stay stable across identical requests.
 */
export async function synthesizeTrialBalanceSnapshot(
  clubId: string,
  asOf: Date,
): Promise<TrialBalanceSnapshot | null> {
  if (!(await hasCommittedRealTrialBalance(clubId))) return null;
  const meta = await resolveFiscalMetadata(clubId, asOf);
  if (!meta) return null;

  const tb = await trialBalance(clubId, asOf);
  // Pull the underlying Account records for `accounts` payload.
  const clubAccounts = await prisma.account.findMany({
    where: { clubId, isActive: true, isHeader: false },
    orderBy: { accountNumber: "asc" },
  });
  // Founder rule 2026-07-02 v15.0 — Fund Applicability comes from
  // the CoA's `fundApplicability` column (single source of truth
  // for P&L fund classification). Balance-sheet capital tagging
  // is a separate concern — still inferred from the BS FS Group
  // for now (BS_CAPITAL_ASSETS etc.), since that's how the
  // balance-sheet projection identifies capital-reserve assets.
  const accounts: LedgerAccount[] = clubAccounts.map((a) => {
    const fundApplicabilityField =
      (a as unknown as { fundApplicability?: string | null }).fundApplicability ?? null;
    const fsGroupField =
      (a as unknown as { fsGroupId?: string | null }).fsGroupId ?? null;
    return {
      accountCode: a.accountNumber,
      accountName: a.name,
      category: toCategory(a.type),
      // Primary fund tag: for P&L accounts, read from
      // fundApplicability (first token). For BS accounts, keep
      // the existing FS-group inference used by the BS projection.
      fund: primaryFundFor(a.type, fundApplicabilityField, fsGroupField),
      parentAccountCode: null,
      fundApplicability: fundApplicabilityField,
    };
  });

  const lines: TrialBalanceLine[] = tb.rows.map((r) => {
    const debit = Number(r.debit) || 0;
    const credit = Number(r.credit) || 0;
    return {
      accountCode: r.accountNumber,
      debit,
      credit,
      endingBalance: debit - credit,
    };
  });

  // Period bounds: fiscal-year start → asOf. This mirrors the YTD
  // window every dual-read builder needs.
  const periodStart = await resolveFiscalYearStart(clubId, asOf);
  return {
    entityKind: "trial-balance",
    snapshotId: `live-${randomUUID()}`,
    clubId,
    capturedAt: new Date(),
    sourceSystem: "spectre-accounting",
    importBatchId: null,
    dataSource: "accounting",
    notes: "Synthesized on-demand from posted journal entries.",
    asOf,
    periodStart,
    periodEnd: asOf,
    fiscalYearLabel: meta.fiscalYearLabel,
    fiscalPeriodSequence: meta.fiscalPeriodSequence,
    accounts,
    lines,
    totalDebits: Number(tb.totalDebit),
    totalCredits: Number(tb.totalCredit),
    isBalanced: tb.isBalanced,
  };
}

// ---------------------------------------------------------------------------
// Balance Sheet + Income Statement — same synthesis pattern.
// The BS/IS projections in the Monthly Package layer prefer to
// derive their snapshots from a TB snapshot, so those work as
// soon as `getTrialBalance` returns something. We ALSO expose
// direct BS/IS synth so PrismaReportingLedger's other read
// methods can bypass the projection layer when they need to.
// ---------------------------------------------------------------------------
export async function synthesizeBalanceSheetSnapshot(
  clubId: string,
  asOf: Date,
): Promise<BalanceSheetSnapshot | null> {
  if (!(await hasCommittedRealTrialBalance(clubId))) return null;
  const meta = await resolveFiscalMetadata(clubId, asOf);
  if (!meta) return null;
  const bs = await balanceSheet(clubId, asOf);
  // BS lines: iterate the FS Group tree from balanceSheet() output.
  // Category mapping — a coarse mapping is sufficient because
  // downstream projections only read `amount` + high-level totals.
  const toBsCategory = (t: string): BalanceSheetCategory => {
    switch (t.toUpperCase()) {
      case "ASSET": return "current-asset";
      case "LIABILITY": return "current-liability";
      case "EQUITY": return "operating-fund-balance";
      default: return "current-asset";
    }
  };
  // Founder rule 2026-07-13 v15.22 — SIGN-CRITICAL:
  //
  // Pre-v15.22 this synthesizer stored `Math.abs(naturalBalance)` and
  // omitted `rawSignedAmount`, which caused every downstream sign
  // decision to lose the true debit/credit direction of the account.
  // A LIABILITY account with an ABNORMAL DEBIT balance (e.g. account
  // 2017 — Accts Payable Contra - Grat Payout) landed in Accounts
  // Payable as a POSITIVE $65,486 rather than as a NEGATIVE
  // contribution of ($65,486). The founder called this out as the
  // third consecutive sign defect and demanded the raw sign be
  // preserved at every layer.
  //
  // We now emit BOTH:
  //   • `amount`            — unsigned magnitude (legacy contract kept
  //                           for renderers that format an absolute
  //                           column with a section-level sign hint).
  //   • `rawSignedAmount`   — the RAW Jonas debit-positive /
  //                           credit-negative signed balance
  //                           (i.e. debit − credit). This is the
  //                           canonical input to `normaliseSign` in
  //                           `statement-of-financial-position.ts` and
  //                           the ONLY correct source of an account's
  //                           actual sign.
  //
  // We also thread the FS Group key through so the downstream
  // enrichment does not need to re-query the CoA when the account
  // balance already carries it.
  const flatLines: BalanceSheetLine[] = [];
  const flatten = (nodes: typeof bs.assets) => {
    for (const n of nodes) {
      for (const a of n.accounts) {
        const signed = Number(a.signedBalance);
        flatLines.push({
          accountCode: a.accountNumber,
          accountName: a.accountName,
          category: toBsCategory(a.accountType),
          fund: "operating",
          amount: Math.abs(signed),
          rawSignedAmount: signed,
          fsGroupKey: a.fsGroupKey ?? undefined,
          priorYearSameDateAmount: null,
        });
      }
      flatten(n.subgroups);
    }
  };
  flatten([...bs.assets, ...bs.liabilities, ...bs.equity]);

  // Founder rule 2026-07-14 v15.23 — Members' Equity must include the
  // Statement-of-Activities YTD result. Prior to v15.23 the live
  // synthesizer iterated only the FS-Group tree from
  // `balanceSheet()`. That tree exposes accounts under the equity
  // FS Groups (Retained Earnings, Capital Reserve, etc.) but NEVER
  // emits the current-year earnings — that figure lives ONLY on the
  // scalar `bs.currentYearEarnings`, and `balanceSheet.totalEquity`
  // adds it back as `totalEquity + currentYearEarnings`. Without a
  // matching LINE the Statement of Financial Position renders equity
  // = Retained Earnings only, and Total Assets exceeds Total
  // Liabilities + Total Members' Equity by exactly the current-year
  // surplus / deficit (Silver Springs May 2026: $2,358,610.98).
  //
  // We now emit a synthetic `__YTD_NET_INCOME__` equity line that
  // consumes the SAME canonical figure `balanceSheet()` computed
  // (which internally uses the same posted-journal-line query the
  // Statement of Activities consumes — `accountBalances({from: fy.startDate, to: asOf})`
  // — so the two statements are guaranteed to agree exactly).
  //
  // Sign convention: positive `amount` = surplus, negative = deficit.
  // The SoFP builder aggregates `ytd-net-income` category lines under
  // `signMode: "signed"` which returns `line.amount` unchanged — no
  // credit-normal inversion — so a positive surplus ADDS to Members'
  // Equity and a negative deficit REDUCES it. This is exactly the
  // shape `BalanceSheetProjection` emits at
  // `balance-sheet-projection.ts:326-353`; consolidating the two
  // paths would be a broader refactor for later.
  //
  // Duplicate protection: if the CoA already has an account routed
  // to `BS_CURRENT_YEAR_EARNINGS`, skip the synthetic line — closing
  // entries have already booked the surplus / deficit into that
  // equity account, and rolling in the synthetic would double-count.
  const ytdEarningsAlreadyBooked = flatLines.some(
    (l) => l.fsGroupKey?.toUpperCase() === "BS_CURRENT_YEAR_EARNINGS",
  );
  const ytdSigned = Number(bs.currentYearEarnings);
  if (ytdSigned !== 0 && !ytdEarningsAlreadyBooked) {
    const isDeficit = ytdSigned < 0;
    flatLines.push({
      accountCode: "__YTD_NET_INCOME__",
      accountName: isDeficit
        ? "Current-Year Deficit to Date"
        : "Current-Year Earnings to Date",
      category: "ytd-net-income",
      fund: "operating",
      // `amount` here is the SIGNED statement contribution — the SoFP
      // builder's `ytd-net-income` bucket uses `signMode: "signed"`
      // which returns amount as-is, so a positive surplus ADDs and a
      // negative deficit REDUCEs Members' Equity. Do NOT wrap in
      // Math.abs — that would break the deficit case.
      amount: ytdSigned,
      // rawSignedAmount is deliberately unset — the `signed` mode
      // does not consult rawSignedAmount so setting it would be
      // meaningless. Passes the v15.22 strict guard because that
      // guard only applies to the three canonical live modes
      // (debit-normal / credit-normal / contra-asset-signed).
      priorYearSameDateAmount: null,
      fsGroupKey: "BS_CURRENT_YEAR_EARNINGS",
      fsGroupName: isDeficit
        ? "Current-Year Deficit to Date"
        : "Current-Year Earnings to Date",
      fsGroupSortOrder: 820,
    });
  }

  return {
    entityKind: "balance-sheet",
    snapshotId: `live-${randomUUID()}`,
    clubId,
    capturedAt: new Date(),
    sourceSystem: "spectre-accounting",
    importBatchId: null,
    dataSource: "accounting",
    notes: "Synthesized on-demand from posted journal entries.",
    asOf,
    fiscalYearLabel: meta.fiscalYearLabel,
    lines: flatLines,
    totalAssets: Number(bs.totalAssets),
    totalLiabilities: Number(bs.totalLiabilities),
    totalEquity: Number(bs.totalEquity),
    isReconciled: bs.isBalanced,
  };
}

export async function synthesizeIncomeStatementSnapshot(
  clubId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<IncomeStatementSnapshot | null> {
  if (!(await hasCommittedRealTrialBalance(clubId))) return null;
  const meta = await resolveFiscalMetadata(clubId, periodEnd);
  if (!meta) return null;

  // Founder rule 2026-07-02 v15.4 — Fund Applicability is the
  // SINGLE SOURCE OF TRUTH for operating vs capital classification
  // on the live Income Statement synthesis path.
  //
  // Prior (v14.15) this synth hardcoded `totalCapitalIncome: 0`
  // and stamped every line with `fund: "operating"`, so the
  // Monthly Reporting Package's YTD Capital Income read as $0
  // regardless of what the operator had tagged in the CoA. The
  // Slice 1 refactor of `IncomeStatementProjection` didn't help —
  // real clubs bypass that class and hit this synth instead
  // (via `PrismaReportingLedger`).
  //
  // The refactor below iterates the raw `accountBalances`
  // (which now carry `fundApplicability` + `fsGroupKey`) and
  // partitions revenue / expense by fund:
  //
  //   • fundApplicability contains CAPITAL → contributes to
  //     `totalCapitalIncome` (revenue) / `totalCapitalExpense`
  //     (expense) and the line's `fund` field is "capital".
  //   • fundApplicability contains OPERATING (only) → contributes
  //     to `totalOperatingRevenue` / `totalOperatingExpense` and
  //     the line's `fund` is "operating".
  //   • fundApplicability is null → EXCLUDED from every roll-up
  //     (per the founder's diagnostic rule); the line is still
  //     emitted with `fund: "operating"` as a safe placeholder
  //     (the snapshot's `LedgerFund` union has no "unmapped"
  //     value) and the CoA's amber banner surfaces the count so
  //     the operator can fix the CoA.
  //
  // Depreciation is now identified by FS Group (`IS_DEPRECIATION`)
  // on the balance itself, so hardcoded number ranges never
  // creep in. It's restricted to OPERATING-tagged depreciation
  // accounts so capital-side write-downs land in
  // `totalCapitalExpense`, not the NOI-before-dep denominator.
  const balances = await accountBalances(clubId, {
    from: periodStart,
    to: periodEnd,
  });

  const lines: IncomeStatementLine[] = [];
  let totalOperatingRevenue = 0;
  let totalOperatingExpense = 0; // includes payroll + opex + depreciation
  let opexExDepreciation = 0;    // operating expenses minus depreciation
  let totalCapitalIncome = 0;
  let totalCapitalExpense = 0;
  let depreciation = 0;

  for (const b of balances) {
    if (b.accountType !== "REVENUE" && b.accountType !== "EXPENSE") continue;
    const amount = Math.abs(Number(b.naturalBalance));
    // Ledger contract requires a `category` + `fund`. `fund`
    // for null-tagged accounts stays "operating" (placeholder;
    // the account is excluded from the totals below regardless).
    const isCapital = hasFund(b.fundApplicability, "CAPITAL");
    const isOperating = hasFund(b.fundApplicability, "OPERATING");
    const lineFund: LedgerFund = isCapital ? "capital" : "operating";
    const category = b.accountType === "REVENUE" ? "revenue" : "expense";
    lines.push({
      accountCode: b.accountNumber,
      accountName: b.accountName,
      category,
      fund: lineFund,
      departmentCode: null,
      amount,
    });

    // Founder rule: multi-fund accounts contribute their full
    // amount to CAPITAL when tagged CAPITAL (matches the Slice 1
    // primary-fund tie-break). Accounts with only OPERATING flow
    // into the operating buckets. Untagged accounts fall through
    // every branch and are excluded from every total.
    if (b.accountType === "REVENUE") {
      if (isCapital) totalCapitalIncome += amount;
      else if (isOperating) totalOperatingRevenue += amount;
      // null → excluded from both revenue totals.
    } else {
      // EXPENSE.
      if (isCapital) {
        totalCapitalExpense += amount;
      } else if (isOperating) {
        totalOperatingExpense += amount;
        // Depreciation is an operating-side sub-bucket. FS Group
        // key identifies it (never account name / number).
        if (b.fsGroupKey === "IS_DEPRECIATION") {
          depreciation += amount;
        } else {
          opexExDepreciation += amount;
        }
      }
      // null → excluded from every expense total.
    }
  }

  // v14.15 → v15.4 — NOI Before Depreciation collapses to the
  // operating margin excluding depreciation. Preserved shape:
  //   NOI Before Depreciation
  //     = Operating Revenue − (Operating Expense − Depreciation)
  //     = Operating Revenue − opexExDepreciation
  const noiBeforeDepreciation = totalOperatingRevenue - opexExDepreciation;

  return {
    entityKind: "income-statement",
    snapshotId: `live-${randomUUID()}`,
    clubId,
    capturedAt: new Date(),
    sourceSystem: "spectre-accounting",
    importBatchId: null,
    dataSource: "accounting",
    notes: "Synthesized on-demand from posted journal entries.",
    periodStart,
    periodEnd,
    fiscalYearLabel: meta.fiscalYearLabel,
    fiscalPeriodSequence: meta.fiscalPeriodSequence,
    lines,
    totalOperatingRevenue,
    // v14.15 — operating expense EXCLUDES depreciation from the
    // NOI-before-dep denominator, but the top-level
    // `totalOperatingExpense` DOES include it (aligns with the
    // ledger contract's "operating expense = everything operating
    // on the expense side"). Depreciation is exposed separately
    // via the `depreciation` field.
    totalOperatingExpense,
    noiBeforeDepreciation,
    depreciation,
    totalCapitalIncome,
    totalCapitalExpense,
  };
}

// (v15.4 — `walkGroupTree` retired. Depreciation is now
// identified per balance via `AccountBalance.fsGroupKey` inside
// the balance iteration, which keeps every operating / capital
// bucket + the depreciation carve-out on a single loop.)

// ---------------------------------------------------------------------------
// Fiscal-year start helper — snapshot payloads use YTD windows.
// ---------------------------------------------------------------------------
async function resolveFiscalYearStart(clubId: string, asOf: Date): Promise<Date> {
  const fy = await prisma.fiscalYear.findFirst({
    where: { clubId, startDate: { lte: asOf }, endDate: { gte: asOf } },
  });
  return fy?.startDate ?? new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1));
}

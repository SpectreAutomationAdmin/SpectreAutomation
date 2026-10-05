// REPORT-PRESENTATION-1 §3-6, §12-18 (2026-10-05) — canonical period-
// aware FS Group projection.
//
// PURPOSE
//   One source of truth for Board-facing financial-statement rows.
//   Every reporting surface that aggregates natural accounts into an
//   FS-Group presentation line (Statement of Activities Section IV,
//   Section III Dues-to-Revenue + Payroll Ratio numerators, future
//   Finance Committee packages) consumes THIS projection — never a
//   parallel name-regex / account-number-range classification.
//
//   The projection uses the canonical COA metadata already stored
//   in Spectre:
//     - Account.fundApplicability    → OPERATING vs CAPITAL
//     - Account.type                 → REVENUE vs EXPENSE
//     - Account.fsGroup.key / name   → presentation grouping
//
//   Classification is strictly METADATA-DRIVEN. No account-name
//   regex, no number-range matching. If an account lacks an FS Group,
//   it surfaces under the "(Unassigned)" bucket for controller review
//   — the projection never silently repairs the COA.
//
// SHAPE
//   {
//     sections: {
//       operatingRevenue:  FsGroupProjectionRow[];
//       operatingExpense:  FsGroupProjectionRow[];
//       capitalRevenue:    FsGroupProjectionRow[];
//       capitalExpense:    FsGroupProjectionRow[];
//       depreciation:      FsGroupProjectionRow[];
//     };
//     totals: { ...per-section CM/YTD actual + budget };
//   }
//
//   Each FsGroupProjectionRow has:
//     - fsGroupKey, fsGroupName
//     - cmActual, cmBudget, ytdActual, ytdBudget
//     - accounts: child natural-account rows with the same shape
//
//   Parent/child invariant (directive §15):
//     Σ child.cmActual   === parent.cmActual  (within $0.01)
//     Σ child.cmBudget   === parent.cmBudget
//     Σ child.ytdActual  === parent.ytdActual
//     Σ child.ytdBudget  === parent.ytdBudget
//
// PERIOD-AWARENESS (directive §24, §21)
//   Takes `periodStart` + `periodEnd`. CM = that exact window.
//   YTD = fiscal-year-start → periodEnd. January YTD === CM.
//   June YTD = Jan 1 → Jun 30. No month-specific constants.
//
// NEVER-INVENT RULE
//   Consumes `reportingAccountBalances` (ratio-registry source) +
//   `resolveBudget` (central Budget contract). Zero parallel
//   calculation. Zero account-name inference.

import { prisma } from "@/lib/prisma";
import { reportingAccountBalances } from "@/lib/accounting/reporting-balances";
import { resolveBudget } from "@/lib/reporting/budget-resolver";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FsGroupAccountRow = {
  accountNumber: string;
  accountName: string;
  /** fundApplicability as stored on Account (comma-separated list,
   *  e.g. "OPERATING" or "CAPITAL" or "OPERATING,CAPITAL"). */
  fundApplicability: string | null;
  cmActual: number;
  cmBudget: number;
  ytdActual: number;
  ytdBudget: number;
};

export type FsGroupProjectionRow = {
  /** FS Group key — e.g. "IS_MEMBERSHIP_DUES". Null = "(Unassigned)"
   *  bucket for accounts without an fsGroup. */
  fsGroupKey: string | null;
  /** FS Group display name — e.g. "Membership Dues". When the key is
   *  null, this is "(Unassigned — review classification)". */
  fsGroupName: string;
  /** Sort order from FinancialStatementGroup.sortOrder (0 when null
   *  key, so the unassigned bucket surfaces at the top for review). */
  sortOrder: number;
  cmActual: number;
  cmBudget: number;
  ytdActual: number;
  ytdBudget: number;
  /** Child natural-account breakdown. Rendered when the UI expands
   *  the group row. May be a single account for 1-account groups. */
  accounts: FsGroupAccountRow[];
};

export type FsGroupProjectionSectionTotals = {
  cmActual: number;
  cmBudget: number;
  ytdActual: number;
  ytdBudget: number;
};

export type FsGroupProjection = {
  /** Operating-fund revenue groups (fundApplicability includes
   *  OPERATING). Sorted by FS Group sortOrder, then key. */
  operatingRevenue: FsGroupProjectionRow[];
  /** Operating-fund expense groups, excluding depreciation
   *  (IS_DEPRECIATION is pulled out so the SoA can render it in its
   *  own band). */
  operatingExpense: FsGroupProjectionRow[];
  /** Depreciation only (IS_DEPRECIATION fsGroup). Separate from
   *  operating expense so the canonical NOI-before-dep math stays
   *  identical to REPORT-WIRING-1B. */
  depreciation: FsGroupProjectionRow[];
  /** Capital-fund revenue groups (fundApplicability excludes
   *  OPERATING and includes CAPITAL). */
  capitalRevenue: FsGroupProjectionRow[];
  /** Capital-fund expense groups. */
  capitalExpense: FsGroupProjectionRow[];
  /** Pre-computed section totals so consumers never re-aggregate. */
  totals: {
    operatingRevenue: FsGroupProjectionSectionTotals;
    operatingExpense: FsGroupProjectionSectionTotals;
    depreciation: FsGroupProjectionSectionTotals;
    capitalRevenue: FsGroupProjectionSectionTotals;
    capitalExpense: FsGroupProjectionSectionTotals;
    /** Operating Revenue − Operating COGS/Opex (ex-depreciation).
     *  Reconciles to the ratio-registry's `noi` metric. */
    noiBeforeDep: FsGroupProjectionSectionTotals;
  };
  /** Accounts whose balances we read but whose fsGroup is unassigned
   *  — surfaced as "(Unassigned)" rows for controller review. Empty
   *  array when every account has an FS Group. */
  unassignedAccountCount: number;
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/** Fund-applicability helper. Operating fund = tag includes OPERATING.
 *  Capital fund = tag includes CAPITAL and does NOT include OPERATING
 *  (dual-tagged accounts belong to operating per the current COA
 *  convention and REPORT-WIRING-1A §7). */
function isOperatingFund(fund: string | null): boolean {
  if (!fund) return false;
  return fund.split(",").map((s) => s.trim().toUpperCase()).includes("OPERATING");
}

function isCapitalOnly(fund: string | null): boolean {
  if (!fund) return false;
  const parts = fund.split(",").map((s) => s.trim().toUpperCase());
  return parts.includes("CAPITAL") && !parts.includes("OPERATING");
}

/** Build the canonical FS-Group projection for one reporting period.
 *
 *  Period-aware: CM window = [period.periodStart, period.periodEnd].
 *  YTD window = [fiscal-year-start, period.periodEnd]. Fiscal-year-
 *  start is derived from `period.periodStart.getUTCFullYear()` on
 *  January 1 (the Coulee / Spectre convention; non-Jan FY support
 *  can be added when a tenant with a non-calendar FY lands). */
export async function resolveFsGroupProjection(args: {
  clubId: string;
  period: ReportingPeriod;
}): Promise<FsGroupProjection> {
  const { clubId, period } = args;
  const periodEnd = period.periodEnd;
  const fiscalYear = period.periodStart.getUTCFullYear();
  const throughMonth = periodEnd.getUTCMonth() + 1; // 1..12

  const fiscalYearStart = new Date(Date.UTC(fiscalYear, 0, 1));

  // -- Load Actual (CM window + YTD window) via the canonical
  //    reportingAccountBalances resolver that ratio-registry uses.
  const [cmActualResult, ytdActualResult] = await Promise.all([
    reportingAccountBalances(clubId, { from: period.periodStart, to: periodEnd }),
    reportingAccountBalances(clubId, { from: fiscalYearStart, to: periodEnd }),
  ]);

  // -- Load Budget. YTD = sum through throughMonth; CM = monthlyTotals[throughMonth-1].
  const budgetResult = await resolveBudget({ clubId, fiscalYear, throughMonth });

  // -- Collect every account referenced in Actual or Budget, plus the
  //    account's fsGroup + type + fundApplicability. We don't trust
  //    the ReportingBalanceRow fsGroupKey alone because it reflects
  //    the snapshot-time classification; the current COA is the
  //    source of truth for presentation grouping.
  const accountNumbers = new Set<string>();
  for (const r of cmActualResult.balances) accountNumbers.add(r.accountNumber);
  for (const r of ytdActualResult.balances) accountNumbers.add(r.accountNumber);
  for (const b of budgetResult.byAccount) accountNumbers.add(b.accountNumber);

  const accounts = await prisma.account.findMany({
    where: { clubId, accountNumber: { in: Array.from(accountNumbers) } },
    select: {
      accountNumber: true,
      name: true,
      type: true,
      fundApplicability: true,
      fsGroup: { select: { key: true, name: true, sortOrder: true, statement: true } },
    },
  });
  const acctByNumber = new Map(accounts.map((a) => [a.accountNumber, a]));

  // -- Build account-level aggregation first. One entry per account,
  //    with cmActual + ytdActual + cmBudget + ytdBudget resolved.
  type AcctAgg = {
    accountNumber: string;
    accountName: string;
    accountType: string;
    fundApplicability: string | null;
    fsGroupKey: string | null;
    fsGroupName: string;
    fsGroupSortOrder: number;
    statement: string | null;
    cmActual: number;
    cmBudget: number;
    ytdActual: number;
    ytdBudget: number;
  };
  const acctAgg = new Map<string, AcctAgg>();

  const ensureAgg = (accountNumber: string): AcctAgg | null => {
    const existing = acctAgg.get(accountNumber);
    if (existing) return existing;
    const meta = acctByNumber.get(accountNumber);
    if (!meta) return null; // unknown account — never auto-create
    const agg: AcctAgg = {
      accountNumber: meta.accountNumber,
      accountName: meta.name,
      accountType: meta.type,
      fundApplicability: meta.fundApplicability,
      fsGroupKey: meta.fsGroup?.key ?? null,
      fsGroupName: meta.fsGroup?.name ?? "(Unassigned)",
      fsGroupSortOrder: meta.fsGroup?.sortOrder ?? 0,
      statement: meta.fsGroup?.statement ?? null,
      cmActual: 0,
      cmBudget: 0,
      ytdActual: 0,
      ytdBudget: 0,
    };
    acctAgg.set(accountNumber, agg);
    return agg;
  };

  // Actual amounts arrive as Prisma.Decimal naturalBalance. Convert to
  // Number — Section IV already uses number arithmetic throughout the
  // v2 schema, so keeping Number here avoids a cross-type refactor.
  for (const r of cmActualResult.balances) {
    const a = ensureAgg(r.accountNumber);
    if (!a) continue;
    a.cmActual += Number(r.naturalBalance.toString());
  }
  for (const r of ytdActualResult.balances) {
    const a = ensureAgg(r.accountNumber);
    if (!a) continue;
    a.ytdActual += Number(r.naturalBalance.toString());
  }
  for (const b of budgetResult.byAccount) {
    const a = ensureAgg(b.accountNumber);
    if (!a) continue;
    // Budget monthlyTotals are stored signed per account type — the
    // central Budget contract convention has REVENUE as negative and
    // EXPENSE as positive. For FS-Group aggregation we want
    // display-sign: revenue positive, expense positive. Normalise.
    const sign = a.accountType === "REVENUE" ? -1 : 1;
    const monthIdx = throughMonth - 1;
    a.cmBudget += sign * (b.monthlyTotals[monthIdx] ?? 0);
    a.ytdBudget += sign * b.monthlyTotals.slice(0, throughMonth).reduce((s, v) => s + v, 0);
  }

  // -- Partition accounts into sections based on fund + type + fsGroup. --
  const operatingRevenueAccts: AcctAgg[] = [];
  const operatingExpenseAccts: AcctAgg[] = [];
  const depreciationAccts: AcctAgg[] = [];
  const capitalRevenueAccts: AcctAgg[] = [];
  const capitalExpenseAccts: AcctAgg[] = [];
  let unassignedCount = 0;

  for (const a of acctAgg.values()) {
    // Skip accounts whose statement classification isn't INCOME_STATEMENT.
    if (a.statement && a.statement !== "INCOME_STATEMENT") continue;
    if (a.fsGroupKey === null) unassignedCount++;

    if (a.accountType === "REVENUE") {
      if (isOperatingFund(a.fundApplicability)) {
        operatingRevenueAccts.push(a);
      } else if (isCapitalOnly(a.fundApplicability)) {
        capitalRevenueAccts.push(a);
      }
      // Accounts with null / empty fundApplicability silently drop —
      // revenue without a fund classification cannot be presented
      // without inventing. unassignedCount already flags them for
      // controller review.
    } else if (a.accountType === "EXPENSE") {
      if (isOperatingFund(a.fundApplicability)) {
        if (a.fsGroupKey === "IS_DEPRECIATION") depreciationAccts.push(a);
        else operatingExpenseAccts.push(a);
      } else if (isCapitalOnly(a.fundApplicability)) {
        capitalExpenseAccts.push(a);
      }
    }
  }

  // -- Group each partition by fsGroupKey → emit FsGroupProjectionRow. --
  const makeGroups = (accts: AcctAgg[]): FsGroupProjectionRow[] => {
    const byGroup = new Map<string, { meta: AcctAgg; accts: AcctAgg[] }>();
    for (const a of accts) {
      const k = a.fsGroupKey ?? `__UNASSIGNED__${a.accountNumber}`;
      let g = byGroup.get(k);
      if (!g) {
        g = { meta: a, accts: [] };
        byGroup.set(k, g);
      }
      g.accts.push(a);
    }
    const rows: FsGroupProjectionRow[] = [];
    for (const [k, g] of byGroup) {
      let cmActual = 0, cmBudget = 0, ytdActual = 0, ytdBudget = 0;
      const children: FsGroupAccountRow[] = [];
      for (const a of g.accts.sort((x, y) => x.accountNumber.localeCompare(y.accountNumber))) {
        cmActual += a.cmActual;
        cmBudget += a.cmBudget;
        ytdActual += a.ytdActual;
        ytdBudget += a.ytdBudget;
        children.push({
          accountNumber: a.accountNumber,
          accountName: a.accountName,
          fundApplicability: a.fundApplicability,
          cmActual: a.cmActual,
          cmBudget: a.cmBudget,
          ytdActual: a.ytdActual,
          ytdBudget: a.ytdBudget,
        });
      }
      const isUnassigned = k.startsWith("__UNASSIGNED__");
      rows.push({
        fsGroupKey: isUnassigned ? null : g.meta.fsGroupKey,
        fsGroupName: isUnassigned
          ? `(Unassigned — ${g.meta.accountNumber} ${g.meta.accountName})`
          : g.meta.fsGroupName,
        sortOrder: isUnassigned ? -1 : g.meta.fsGroupSortOrder,
        cmActual, cmBudget, ytdActual, ytdBudget,
        accounts: children,
      });
    }
    return rows.sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return (a.fsGroupKey ?? "").localeCompare(b.fsGroupKey ?? "");
    });
  };

  const operatingRevenue = makeGroups(operatingRevenueAccts);
  const operatingExpense = makeGroups(operatingExpenseAccts);
  const depreciation     = makeGroups(depreciationAccts);
  const capitalRevenue   = makeGroups(capitalRevenueAccts);
  const capitalExpense   = makeGroups(capitalExpenseAccts);

  const sectionTotals = (rows: FsGroupProjectionRow[]): FsGroupProjectionSectionTotals => ({
    cmActual: rows.reduce((s, r) => s + r.cmActual, 0),
    cmBudget: rows.reduce((s, r) => s + r.cmBudget, 0),
    ytdActual: rows.reduce((s, r) => s + r.ytdActual, 0),
    ytdBudget: rows.reduce((s, r) => s + r.ytdBudget, 0),
  });

  const totOpRev  = sectionTotals(operatingRevenue);
  const totOpExp  = sectionTotals(operatingExpense);
  const totDep    = sectionTotals(depreciation);
  const totCapRev = sectionTotals(capitalRevenue);
  const totCapExp = sectionTotals(capitalExpense);
  // NOI-before-dep = Revenue − OpEx (which already excludes depreciation).
  const noiBeforeDep: FsGroupProjectionSectionTotals = {
    cmActual: totOpRev.cmActual - totOpExp.cmActual,
    cmBudget: totOpRev.cmBudget - totOpExp.cmBudget,
    ytdActual: totOpRev.ytdActual - totOpExp.ytdActual,
    ytdBudget: totOpRev.ytdBudget - totOpExp.ytdBudget,
  };

  return {
    operatingRevenue,
    operatingExpense,
    depreciation,
    capitalRevenue,
    capitalExpense,
    totals: {
      operatingRevenue: totOpRev,
      operatingExpense: totOpExp,
      depreciation: totDep,
      capitalRevenue: totCapRev,
      capitalExpense: totCapExp,
      noiBeforeDep,
    },
    unassignedAccountCount: unassignedCount,
  };
}

/** Helper: find one FS Group row across every section (used by
 *  Section III ratio builders — Dues-to-Revenue reads the
 *  IS_MEMBERSHIP_DUES row from `operatingRevenue`; Payroll Ratio
 *  reads the IS_PAYROLL row from `operatingExpense`). */
export function findFsGroupRow(
  projection: FsGroupProjection,
  fsGroupKey: string,
): FsGroupProjectionRow | undefined {
  const all = [
    ...projection.operatingRevenue,
    ...projection.operatingExpense,
    ...projection.depreciation,
    ...projection.capitalRevenue,
    ...projection.capitalExpense,
  ];
  return all.find((r) => r.fsGroupKey === fsGroupKey);
}

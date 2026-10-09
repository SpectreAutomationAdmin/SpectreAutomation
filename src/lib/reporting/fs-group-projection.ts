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
// COA-MAP-1A (2026-10-06) — canonical Board reporting resolves FS Group
// AS OF the reporting-period end via the effective-dated assignment
// table rather than the latest Account.fsGroup pointer.
import { resolveFinancialStatementGroupAsOfBatch } from "@/lib/coa-mapping/fs-group-asof-resolver";
import {
  classifyFsGroupPresentation,
  presentationCategoryFor,
  type PresentationCategoryKey,
} from "@/lib/reporting/fs-group-presentation-categories";

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
  /** CAPITAL-LIVE-1 (2026-10-05) — full-year Budget total (sum of 12
   *  monthlyTotals). Section V consumes this for the Annual Budget
   *  column; other sections only need YTD. 0 when no Budget source
   *  carries this account (caller treats 0 as unavailable via the
   *  availability signal). */
  annualBudget: number;
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
  // REPORT-PRESENTATION-1A §3 (2026-10-05) — Board presentation
  // category this FS Group belongs to. Deterministic lookup via
  // `classifyFsGroupPresentation(fsGroupKey, section)`. Enables
  // Section → Category → FS Group → Account hierarchy without
  // duplicating classification logic across the builder.
  presentationCategoryKey: PresentationCategoryKey;
  presentationCategoryName: string;
  presentationCategorySortOrder: number;
  cmActual: number;
  cmBudget: number;
  ytdActual: number;
  ytdBudget: number;
  /** CAPITAL-LIVE-1 (2026-10-05) — full-year Budget total. 0 when
   *  the Budget source has no lines for this group. */
  annualBudget: number;
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
  /** Operating-fund expense groups, excluding depreciation AND
   *  financing (IS_DEPRECIATION pulled out so the SoA can render it
   *  in its own band; IS_INTEREST_EXPENSE pulled out per
   *  REPORT-PRESENTATION-1A.1 so NOI excludes financing). */
  operatingExpense: FsGroupProjectionRow[];
  /** Depreciation only (IS_DEPRECIATION fsGroup). Separate from
   *  operating expense so the canonical NOI-before-dep math stays
   *  identical to REPORT-WIRING-1B. */
  depreciation: FsGroupProjectionRow[];
  /** REPORT-PRESENTATION-1A.1 (2026-10-05) — financing & other
   *  (currently IS_INTEREST_EXPENSE). Reports below NOI-after-dep.
   *  Not part of NOI math per the Board semantic. */
  financing: FsGroupProjectionRow[];
  /** Capital-fund revenue groups (fundApplicability excludes
   *  OPERATING and includes CAPITAL). */
  capitalRevenue: FsGroupProjectionRow[];
  /** Capital-fund expense groups. */
  capitalExpense: FsGroupProjectionRow[];
  /** Pre-computed section totals so consumers never re-aggregate. */
  totals: {
    operatingRevenue: FsGroupProjectionSectionTotals;
    /** Operating expense EXCLUDING depreciation + financing (the
     *  denominator of NOI-before-dep per the Board semantic). */
    operatingExpense: FsGroupProjectionSectionTotals;
    depreciation: FsGroupProjectionSectionTotals;
    /** Financing total (interest expense + any future non-operating
     *  financing costs). */
    financing: FsGroupProjectionSectionTotals;
    capitalRevenue: FsGroupProjectionSectionTotals;
    capitalExpense: FsGroupProjectionSectionTotals;
    /** Operating Revenue − Operating COGS/Opex (ex-depreciation AND
     *  ex-financing). This is the CANONICAL NOI-before-depreciation
     *  (REPORT-PRESENTATION-1A.1 Board semantic). Reconciles across
     *  Section II Executive, Section III Stewardship headline, and
     *  Section IV. */
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

  // -- Load Actual via the canonical reportingAccountBalances
  //    resolver that ratio-registry uses.
  //
  //    MBR-FIX-1 (2026-10-09) — current-month (CM) activity is now
  //    derived from the fiscal-YTD snapshot DIFFERENCE
  //    (`ytdActual − priorYtdActual`) instead of a direct
  //    `{ from: periodStart, to: periodEnd }` query.  Jonas Trial
  //    Balance snapshots are imported with
  //    `snapshot.periodStart = fiscal-year start`, so the YTD-slice
  //    matcher in `reportingAccountBalances` only serves a slice when
  //    `filter.from === snapshot.periodStart`.  Passing a current-
  //    month start (e.g. Feb 1) used to silently drop every IS row
  //    on Feb+ periods, leaving Statement of Activities and every
  //    FS-Group dependent surface empty.  See MBR-AUDIT-1 DEF-4.
  //
  //    The subtraction preserves the identity:
  //      CM(month N) = YTD(month N) − YTD(month N − 1)
  //    with the edge case `isFirstFiscalMonth` → CM = YTD (no prior
  //    snapshot in this fiscal year).
  const isFirstFiscalMonth = periodEnd.getUTCMonth() === 0;
  const priorMonthEnd = new Date(Date.UTC(
    periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), 0,
    23, 59, 59, 999,
  ));
  const [ytdActualResult, priorYtdActualResult] = await Promise.all([
    reportingAccountBalances(clubId, { from: fiscalYearStart, to: periodEnd }),
    isFirstFiscalMonth
      ? Promise.resolve(null)
      : reportingAccountBalances(clubId, { from: fiscalYearStart, to: priorMonthEnd }),
  ]);

  // -- Load Budget. YTD = sum through throughMonth; CM = monthlyTotals[throughMonth-1].
  const budgetResult = await resolveBudget({ clubId, fiscalYear, throughMonth });

  // -- Collect every account referenced in Actual or Budget, plus the
  //    account's fsGroup AS OF the reporting-period end + type +
  //    fundApplicability. We don't trust the ReportingBalanceRow
  //    fsGroupKey alone because it reflects the snapshot-time
  //    classification. We also don't use `Account.fsGroup` because
  //    that is the LATEST assignment, not the one effective for this
  //    period. COA-MAP-1A (2026-10-06) — canonical Board reporting
  //    now resolves the FS Group via `AccountFinancialStatementAssignment`
  //    AS OF `period.periodEnd`. Published packages remain frozen
  //    (MonthlyPackage.packagePayloadJson); only unpublished live
  //    preview and the active package build consume this as-of
  //    resolver.
  const accountNumbers = new Set<string>();
  for (const r of ytdActualResult.balances) accountNumbers.add(r.accountNumber);
  if (priorYtdActualResult) {
    for (const r of priorYtdActualResult.balances) accountNumbers.add(r.accountNumber);
  }
  for (const b of budgetResult.byAccount) accountNumbers.add(b.accountNumber);

  const accounts = await prisma.account.findMany({
    where: { clubId, accountNumber: { in: Array.from(accountNumbers) } },
    select: {
      id: true,
      accountNumber: true,
      name: true,
      type: true,
      fundApplicability: true,
      // Fallback: when no AccountFinancialStatementAssignment covers
      // periodEnd (e.g. pre-backfill tenant), use current Account.fsGroup
      // so reporting still renders rather than returning (Unassigned).
      fsGroup: { select: { key: true, name: true, sortOrder: true, statement: true } },
    },
  });
  const acctByNumber = new Map(accounts.map((a) => [a.accountNumber, a]));

  // COA-MAP-1A — resolve each account's effective-dated FS Group
  // for `periodEnd`. One batch call, N+1-free.
  const asOfBatch = await resolveFinancialStatementGroupAsOfBatch({
    clubId,
    accountIds: accounts.map((a) => a.id),
    asOf: periodEnd,
  });
  const asOfByAccountNumber = new Map<string, { key: string; name: string; sortOrder: number; statement: string } | null>();
  for (const a of accounts) {
    const asOf = asOfBatch.get(a.id);
    if (asOf) {
      asOfByAccountNumber.set(a.accountNumber, {
        key: asOf.fsGroupKey,
        name: asOf.fsGroupName,
        sortOrder: asOf.sortOrder,
        statement: asOf.statement,
      });
    } else {
      asOfByAccountNumber.set(a.accountNumber, null);
    }
  }

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
    annualBudget: number;
    // MBR-FIX-1 (2026-10-09) — transient prior-month YTD actual
    // used by the CM subtraction pass.  Not emitted on the public
    // projection shape — only consumed inside `resolveFsGroupProjection`
    // to compute `cmActual = ytdActual − priorYtdActual`.
    priorYtdActual: number;
  };
  const acctAgg = new Map<string, AcctAgg>();

  const ensureAgg = (accountNumber: string): AcctAgg | null => {
    const existing = acctAgg.get(accountNumber);
    if (existing) return existing;
    const meta = acctByNumber.get(accountNumber);
    if (!meta) return null; // unknown account — never auto-create
    // COA-MAP-1A — prefer the effective-dated as-of resolution;
    // fall back to current Account.fsGroup only when no assignment
    // exists (pre-backfill tenants).
    const asOf = asOfByAccountNumber.get(accountNumber) ?? null;
    const fsGroupKey = asOf?.key ?? meta.fsGroup?.key ?? null;
    const fsGroupName = asOf?.name ?? meta.fsGroup?.name ?? "(Unassigned)";
    const fsGroupSortOrder = asOf?.sortOrder ?? meta.fsGroup?.sortOrder ?? 0;
    const statement = asOf?.statement ?? meta.fsGroup?.statement ?? null;
    const agg: AcctAgg = {
      accountNumber: meta.accountNumber,
      accountName: meta.name,
      accountType: meta.type,
      fundApplicability: meta.fundApplicability,
      fsGroupKey,
      fsGroupName,
      fsGroupSortOrder,
      statement,
      cmActual: 0,
      cmBudget: 0,
      ytdActual: 0,
      ytdBudget: 0,
      annualBudget: 0,
      priorYtdActual: 0,
    };
    acctAgg.set(accountNumber, agg);
    return agg;
  };

  // Actual amounts arrive as Prisma.Decimal naturalBalance. Convert to
  // Number — Section IV already uses number arithmetic throughout the
  // v2 schema, so keeping Number here avoids a cross-type refactor.
  //
  // MBR-FIX-1 (2026-10-09) — Pass 1 reads YTD into `ytdActual` and
  // Pass 2 reads prior-month YTD into a transient `priorYtd` on the
  // agg (initialised to 0 in `ensureAgg`).  CM is then derived
  // `cmActual = ytdActual − priorYtd` after both passes complete.
  // Accounts that only exist in the prior-month snapshot (e.g. an
  // account retired this month that still has prior-YTD activity)
  // still get an agg entry so their reversal shows up in CM.
  for (const r of ytdActualResult.balances) {
    const a = ensureAgg(r.accountNumber);
    if (!a) continue;
    a.ytdActual += Number(r.naturalBalance.toString());
  }
  if (priorYtdActualResult) {
    for (const r of priorYtdActualResult.balances) {
      const a = ensureAgg(r.accountNumber);
      if (!a) continue;
      a.priorYtdActual += Number(r.naturalBalance.toString());
    }
  }
  // Derive CM from the YTD difference for every account the
  // aggregation touched.  First fiscal month → CM === YTD.
  for (const a of acctAgg.values()) {
    a.cmActual = isFirstFiscalMonth
      ? a.ytdActual
      : a.ytdActual - a.priorYtdActual;
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
    // CAPITAL-LIVE-1 — full-year Budget total (12-month sum).
    a.annualBudget += sign * b.monthlyTotals.reduce((s, v) => s + v, 0);
  }

  // -- Partition accounts into sections based on fund + type + fsGroup. --
  const operatingRevenueAccts: AcctAgg[] = [];
  const operatingExpenseAccts: AcctAgg[] = [];
  const depreciationAccts: AcctAgg[] = [];
  const financingAccts: AcctAgg[] = [];
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
        // REPORT-PRESENTATION-1A.1 (2026-10-05) — IS_INTEREST_EXPENSE
        // is a financing cost, not an operating expense for NOI
        // purposes. Carved out of operatingExpenseAccts so
        // totals.operatingExpense (the NOI denominator) excludes it.
        else if (a.fsGroupKey === "IS_INTEREST_EXPENSE") financingAccts.push(a);
        else operatingExpenseAccts.push(a);
      } else if (isCapitalOnly(a.fundApplicability)) {
        capitalExpenseAccts.push(a);
      }
    }
  }

  // -- Group each partition by fsGroupKey → emit FsGroupProjectionRow. --
  const makeGroups = (
    accts: AcctAgg[],
    projectionSection: "OPERATING_REVENUE" | "OPERATING_EXPENSE" | "DEPRECIATION" | "CAPITAL_REVENUE" | "CAPITAL_EXPENSE",
  ): FsGroupProjectionRow[] => {
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
      let cmActual = 0, cmBudget = 0, ytdActual = 0, ytdBudget = 0, annualBudget = 0;
      const children: FsGroupAccountRow[] = [];
      for (const a of g.accts.sort((x, y) => x.accountNumber.localeCompare(y.accountNumber))) {
        cmActual += a.cmActual;
        cmBudget += a.cmBudget;
        ytdActual += a.ytdActual;
        ytdBudget += a.ytdBudget;
        annualBudget += a.annualBudget;
        children.push({
          accountNumber: a.accountNumber,
          accountName: a.accountName,
          fundApplicability: a.fundApplicability,
          cmActual: a.cmActual,
          cmBudget: a.cmBudget,
          ytdActual: a.ytdActual,
          ytdBudget: a.ytdBudget,
          annualBudget: a.annualBudget,
        });
      }
      const isUnassigned = k.startsWith("__UNASSIGNED__");
      // Resolve Board presentation category using the deterministic
      // fs-group-presentation-categories lookup.
      const presentationCategoryKey = classifyFsGroupPresentation({
        fsGroupKey: isUnassigned ? null : g.meta.fsGroupKey,
        section: projectionSection,
      });
      const presentationCategory = presentationCategoryFor(presentationCategoryKey);
      rows.push({
        fsGroupKey: isUnassigned ? null : g.meta.fsGroupKey,
        fsGroupName: isUnassigned
          ? `(Unassigned — ${g.meta.accountNumber} ${g.meta.accountName})`
          : g.meta.fsGroupName,
        sortOrder: isUnassigned ? -1 : g.meta.fsGroupSortOrder,
        presentationCategoryKey,
        presentationCategoryName: presentationCategory.displayName,
        presentationCategorySortOrder: presentationCategory.sortOrder,
        cmActual, cmBudget, ytdActual, ytdBudget, annualBudget,
        accounts: children,
      });
    }
    return rows.sort((a, b) => {
      // Primary sort: presentation category sort order (groups within
      // the same category stay adjacent for category-subtotal math).
      if (a.presentationCategorySortOrder !== b.presentationCategorySortOrder) {
        return a.presentationCategorySortOrder - b.presentationCategorySortOrder;
      }
      // Secondary: FS Group sortOrder.
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      // Tertiary: fsGroupKey alpha for stable ordering.
      return (a.fsGroupKey ?? "").localeCompare(b.fsGroupKey ?? "");
    });
  };

  const operatingRevenue = makeGroups(operatingRevenueAccts, "OPERATING_REVENUE");
  const operatingExpense = makeGroups(operatingExpenseAccts, "OPERATING_EXPENSE");
  const depreciation     = makeGroups(depreciationAccts, "DEPRECIATION");
  // Financing uses OPERATING_EXPENSE as the projection-section input
  // to classifyFsGroupPresentation; the classifier itself returns
  // FINANCING_AND_OTHER for IS_INTEREST_EXPENSE regardless.
  const financing        = makeGroups(financingAccts, "OPERATING_EXPENSE");
  const capitalRevenue   = makeGroups(capitalRevenueAccts, "CAPITAL_REVENUE");
  const capitalExpense   = makeGroups(capitalExpenseAccts, "CAPITAL_EXPENSE");

  const sectionTotals = (rows: FsGroupProjectionRow[]): FsGroupProjectionSectionTotals => ({
    cmActual: rows.reduce((s, r) => s + r.cmActual, 0),
    cmBudget: rows.reduce((s, r) => s + r.cmBudget, 0),
    ytdActual: rows.reduce((s, r) => s + r.ytdActual, 0),
    ytdBudget: rows.reduce((s, r) => s + r.ytdBudget, 0),
  });

  const totOpRev  = sectionTotals(operatingRevenue);
  const totOpExp  = sectionTotals(operatingExpense);
  const totDep    = sectionTotals(depreciation);
  const totFin    = sectionTotals(financing);
  const totCapRev = sectionTotals(capitalRevenue);
  const totCapExp = sectionTotals(capitalExpense);
  // REPORT-PRESENTATION-1A.1 (2026-10-05) — NOI-before-dep now
  // excludes both depreciation AND financing per the Board semantic.
  // operatingExpense already excludes both (financingAccts carved
  // out above), so the arithmetic is unchanged but the SET of
  // accounts flowing through operatingExpense is smaller than before.
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
    financing,
    capitalRevenue,
    capitalExpense,
    totals: {
      operatingRevenue: totOpRev,
      operatingExpense: totOpExp,
      depreciation: totDep,
      financing: totFin,
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
    ...projection.financing,
    ...projection.capitalRevenue,
    ...projection.capitalExpense,
  ];
  return all.find((r) => r.fsGroupKey === fsGroupKey);
}

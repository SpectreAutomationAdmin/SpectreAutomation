// REPORT-WIRING-1 (2026-10-04) — central Monthly Reporting Package
// financial contract.
//
// WHY THIS EXISTS
//
// Before this file, each Budget-aware chapter (Executive At-a-Glance,
// Statement of Activities, Stewardship Operating/Capital KPI cards)
// consumed Budget through its own typed `aux.budget.*` input and the
// package builder passed EMPTY / UNAVAILABLE zeros on live tenants —
// so three chapters that COULD have surfaced Budget comparisons from
// the canonical Budget resolver instead rendered as "—" / "$0" /
// "comparative not available".
//
// This file resolves Budget ONCE per package build + produces the
// shaped aux-input objects every downstream adapter already knows how
// to consume. Executive-summary, SoA, and stewardship adapters do not
// need to change — they stop receiving EMPTY_* and start receiving
// real values.
//
// Adding a NEW Budget-aware adapter in the future means (a) teaching
// its auxiliary-input type what it needs from Budget, (b) adding one
// mapping in `getMonthlyFinancialContract` below. React tree stays
// a pure consumer.
//
// SOURCES (single-call chain)
//   • `resolveBudget(clubId, fiscalYear, throughMonth)` — raw-dollar
//     consolidated + per-account + per-FS-group + per-dept aggregates.
//   • `resolveBudgetIncomeStatement(…)` — classifier-ready IS roll-up
//     (revenue sign-flipped once; cogs/opex/payroll separated).
//   • `resolveBudgetMonthlyIncomeStatement(…)` — 12-month display-sign
//     per-month arrays for chart consumers.
//
// A tenant without a committed Budget → every aux field surfaces null
// → downstream adapters render "—" / "Not configured" per their own
// null-safety contract (established by REPORT-LIVE-3 + SCORECARD-
// PARTIAL-1).

import {
  resolveBudget,
  resolveBudgetIncomeStatement,
  resolveBudgetMonthlyIncomeStatement,
  type ResolveBudgetResult,
} from "./budget-resolver";

export type MonthlyFinancialContract = {
  /** True iff a Budget row exists for this tenant + fiscal year. All
   *  downstream aux fields are null when this is false. */
  budgetAvailable: boolean;
  budget: ResolveBudgetResult["budget"];
  /** Pre-shaped auxiliary input for `executive-summary.ts`'s
   *  `ExecutiveSummaryAuxiliaryInputs.budget` block. */
  executiveSummaryAuxBudget: {
    ytdRevenue: number | null;
    ytdNoiBeforeDepreciation: number | null;
    ytdCapitalIncome: number | null;
    /** Working-capital floor — Budget doesn't supply this directly.
     *  Null until a policy source is configured. */
    workingCapitalFloor: number | null;
  };
  /** Pre-shaped auxiliary input for `statement-of-activities.ts`'s
   *  `SoAAuxiliaryInputs.budget` block. Both current-month + YTD
   *  values per account AND the roll-up buckets Section IV needs. */
  statementOfActivitiesAuxBudget: {
    byAccount: Record<string, { currentMonth: number; ytd: number }>;
    rollups: {
      totalOperatingRevenue: { currentMonth: number; ytd: number };
      totalOperatingExpense: { currentMonth: number; ytd: number };
      depreciation: { currentMonth: number; ytd: number };
      totalCapitalIncome: { currentMonth: number; ytd: number };
      totalCapitalExpense: { currentMonth: number; ytd: number };
    };
  };
  /** Pre-shaped auxiliary input for `stewardship-dashboard-adapter.ts`'s
   *  `StewardshipAuxiliaryInputs.budget` block (operating + capital
   *  scorecards consume this). */
  stewardshipAuxBudget: {
    duesRevenueYtd: number;
    totalOperatingRevenueYtd: number;
    initiationFeeSubsidyYtd: number;
    payrollBenefitsYtd: number;
    totalCapitalIncomeYtd: number;
  };
  /** 12-month monthly series (display-sign dollars) for the Operating
   *  Results chart. REPORT-WIRING-1 §16 — the chart renders Budget
   *  bars for every month FY2026 Budget covers, not just months with
   *  a committed Actual snapshot. */
  operatingMonthlyBudgetNoi: number[] | null;
  operatingMonthlyBudgetRevenue: number[] | null;
};

/** Resolve the central Budget contract for one package build. */
export async function getMonthlyFinancialContract(
  clubId: string,
  periodEnd: Date,
): Promise<MonthlyFinancialContract> {
  const fiscalYear = periodEnd.getUTCFullYear();
  const throughMonth = periodEnd.getUTCMonth() + 1; // 1..12

  const [bYtd, bFull, bMonthly] = await Promise.all([
    resolveBudgetIncomeStatement({ clubId, fiscalYear, throughMonth })
      .catch(() => null),
    resolveBudget({ clubId, fiscalYear, throughMonth })
      .catch(() => null),
    resolveBudgetMonthlyIncomeStatement({ clubId, fiscalYear, throughMonth: 12 })
      .catch(() => null),
  ]);

  const budgetAvailable = Boolean(bYtd?.budget || bFull?.budget);
  const budget = (bYtd?.budget ?? bFull?.budget) ?? null;

  // ---- Executive At-a-Glance aux.budget ----
  // Spectre's Executive Summary consumes YTD comparators. Capital
  // Income Budget doesn't exist in the operating-only 2026.csv so the
  // slot stays null (no fabricated $0 vs $0 comparison).
  const execAuxBudget: MonthlyFinancialContract["executiveSummaryAuxBudget"] = {
    ytdRevenue: bYtd?.revenue ?? null,
    ytdNoiBeforeDepreciation: bYtd?.noi ?? null,
    ytdCapitalIncome: null, // operating budget doesn't cover capital
    workingCapitalFloor: null, // policy-configured, not Budget-derived
  };

  // ---- Statement of Activities aux.budget ----
  // Shape: byAccount keyed by Account.accountNumber, with current-
  // month + YTD $ values. Plus rollups for the aggregated sections.
  const soaByAccount: Record<string, { currentMonth: number; ytd: number }> = {};
  if (bFull) {
    for (const a of bFull.byAccount) {
      const ytd = a.monthlyTotals.slice(0, throughMonth).reduce((s, v) => s + v, 0);
      const currentMonth = a.monthlyTotals[throughMonth - 1] ?? 0;
      // Sign-flip revenue → display convention (positive revenue).
      // Expenses stay positive. Must match the Actual projection so
      // Actual + Budget are apples-to-apples in Section IV.
      const sign = a.accountType === "REVENUE" ? -1 : 1;
      soaByAccount[a.accountNumber] = {
        currentMonth: sign * currentMonth,
        ytd: sign * ytd,
      };
    }
  }
  const soaRollups = (() => {
    const empty = { currentMonth: 0, ytd: 0 };
    if (!bMonthly) {
      return {
        totalOperatingRevenue: empty,
        totalOperatingExpense: empty,
        depreciation: empty,
        totalCapitalIncome: empty,
        totalCapitalExpense: empty,
      };
    }
    const currentIdx = throughMonth - 1;
    const sumThrough = (arr: number[]) => arr.slice(0, throughMonth).reduce((s, v) => s + v, 0);
    // REPORT-WIRING-1B — bMonthly.monthlyOpex now EXCLUDES
    // depreciation (canonical NOI-before-dep). bMonthly surfaces
    // monthlyDepreciation separately. SoA uses them directly.
    return {
      totalOperatingRevenue: {
        currentMonth: bMonthly.monthlyRevenue[currentIdx] ?? 0,
        ytd: sumThrough(bMonthly.monthlyRevenue),
      },
      totalOperatingExpense: {
        // SoA's "operating expense" row = cogs + opex-ex-dep; the
        // depreciation row below is reported separately.
        currentMonth: (bMonthly.monthlyCogs[currentIdx] ?? 0) + (bMonthly.monthlyOpex[currentIdx] ?? 0),
        ytd: sumThrough(bMonthly.monthlyCogs) + sumThrough(bMonthly.monthlyOpex),
      },
      depreciation: {
        currentMonth: bMonthly.monthlyDepreciation[currentIdx] ?? 0,
        ytd: sumThrough(bMonthly.monthlyDepreciation),
      },
      totalCapitalIncome: empty,  // operating budget only
      totalCapitalExpense: empty, // operating budget only
    };
  })();

  // ---- Stewardship adapter aux.budget ----
  // The adapter already treats these as raw dollars (not nullable).
  // When Budget is unavailable they stay 0 — the scorecard-live-
  // builder (SCORECARD-PARTIAL-1) runs ahead of this adapter and
  // computes its own live rows via the Budget resolver directly, so
  // the adapter zeros here only affect the demo-fallback KPI card
  // path which is already overridden on live tenants.
  const duesYtd = (() => {
    if (!bFull) return 0;
    let d = 0;
    for (const a of bFull.byAccount) {
      if (a.fsGroupKey === "IS_MEMBERSHIP_DUES") {
        d += -a.monthlyTotals.slice(0, throughMonth).reduce((s, v) => s + v, 0);
      }
    }
    return d;
  })();
  const payrollYtd = (() => {
    if (!bFull) return 0;
    let p = 0;
    for (const a of bFull.byAccount) {
      if (a.fsGroupKey === "IS_PAYROLL") {
        p += a.monthlyTotals.slice(0, throughMonth).reduce((s, v) => s + v, 0);
      }
    }
    return p;
  })();
  const stewardshipAuxBudget = {
    duesRevenueYtd: duesYtd,
    totalOperatingRevenueYtd: bYtd?.revenue ?? 0,
    initiationFeeSubsidyYtd: 0, // not in operating-only budget
    payrollBenefitsYtd: payrollYtd,
    totalCapitalIncomeYtd: 0, // not in operating-only budget
  };

  // ---- Operating chart 12-month series ----
  const operatingMonthlyBudgetNoi = bMonthly?.monthlyNoi ?? null;
  const operatingMonthlyBudgetRevenue = bMonthly?.monthlyRevenue ?? null;

  return {
    budgetAvailable,
    budget,
    executiveSummaryAuxBudget: execAuxBudget,
    statementOfActivitiesAuxBudget: {
      byAccount: soaByAccount,
      rollups: soaRollups,
    },
    stewardshipAuxBudget,
    operatingMonthlyBudgetNoi,
    operatingMonthlyBudgetRevenue,
  };
}

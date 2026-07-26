// Income Statement View — variance + comparator helpers.
//
// The `IncomeStatementProjection` produces one snapshot per period
// per mode. Consumer surfaces (Statement of Activities, Executive
// Opening, Stewardship Dashboard) want a JOINED view that combines:
//
//   • Current-month actual         (IS snapshot, mode=current-month)
//   • YTD actual                   (IS snapshot, mode=ytd)
//   • Current-month budget         (Budget snapshot, current period)
//   • YTD budget                   (Budget snapshot, year-to-date)
//   • Prior-year YTD               (PriorYear snapshot)
//   • Variance (actual − budget)   (computed)
//   • Variance % (variance/budget) (computed)
//
// This file provides the read-side composition. It is PURE — every
// helper takes resolved snapshots as input and returns the variance
// math. Callers fetch the snapshots from the ledger (or pass them
// in directly).
//
// NOTE on dependencies: Budget and PriorYear projections are NOT yet
// built. Until they are, callers can pass `null` for those fields
// and the view returns variance values of `null` for them — the
// rendering surface decides whether to render "—" or hide the row.

import type {
  BudgetSnapshot,
  IncomeStatementSnapshot,
  PriorYearSnapshot,
} from "@/lib/reporting/ledger/contracts";

// ---------------------------------------------------------------------------
// View shape — the joined comparator
// ---------------------------------------------------------------------------

export type IncomeStatementVariance = {
  actual: number;
  budget: number | null;
  /** actual − budget. Null when budget is null. */
  variance: number | null;
  /** variance / |budget|. Null when budget is null or zero. */
  variancePct: number | null;
  priorYear: number | null;
};

export type IncomeStatementLineComparator = {
  accountCode: string;
  accountName: string;
  category: IncomeStatementSnapshot["lines"][number]["category"];
  fund: IncomeStatementSnapshot["lines"][number]["fund"];
  departmentCode: string | null;
  currentMonth: IncomeStatementVariance;
  ytd: IncomeStatementVariance;
};

export type IncomeStatementCategoryRollup = {
  currentMonth: IncomeStatementVariance;
  ytd: IncomeStatementVariance;
};

export type IncomeStatementView = {
  clubId: string;
  periodStart: Date;
  periodEnd: Date;
  fiscalYearLabel: string;
  fiscalPeriodSequence: number;

  /** Per-account lines, joined across actual + budget + prior year. */
  lines: ReadonlyArray<IncomeStatementLineComparator>;

  /** Category roll-ups mirroring the IS contract's pre-rolled totals. */
  categoryRollups: {
    totalOperatingRevenue: IncomeStatementCategoryRollup;
    totalOperatingExpense: IncomeStatementCategoryRollup;
    noiBeforeDepreciation: IncomeStatementCategoryRollup;
    noi: IncomeStatementCategoryRollup;
    depreciation: IncomeStatementCategoryRollup;
    totalCapitalIncome: IncomeStatementCategoryRollup;
    totalCapitalExpense: IncomeStatementCategoryRollup;
  };

  /** Provenance of the snapshots that fed this view. */
  sources: {
    currentMonthActualSnapshotId: string;
    ytdActualSnapshotId: string;
    budgetSnapshotId: string | null;
    priorYearSnapshotId: string | null;
  };
};

// ---------------------------------------------------------------------------
// Build the joined view from up-to-four snapshots
// ---------------------------------------------------------------------------

/**
 * Build the IS comparator view. All snapshots must be for the same
 * club + period. Budget and prior-year are optional — when omitted,
 * variances render as null.
 */
export function buildIncomeStatementView(args: {
  currentMonthActual: IncomeStatementSnapshot;
  ytdActual: IncomeStatementSnapshot;
  budget?: BudgetSnapshot | null;
  priorYear?: PriorYearSnapshot | null;
}): IncomeStatementView {
  const { currentMonthActual, ytdActual, budget, priorYear } = args;

  // Tenant guard — every snapshot must belong to the same club.
  if (currentMonthActual.clubId !== ytdActual.clubId) {
    throw new Error(
      `IS view: clubId mismatch between current-month (${currentMonthActual.clubId}) and YTD (${ytdActual.clubId})`,
    );
  }
  if (budget && budget.clubId !== currentMonthActual.clubId) {
    throw new Error(
      `IS view: budget clubId (${budget.clubId}) does not match actual clubId (${currentMonthActual.clubId})`,
    );
  }
  if (priorYear && priorYear.clubId !== currentMonthActual.clubId) {
    throw new Error(
      `IS view: prior-year clubId (${priorYear.clubId}) does not match actual clubId (${currentMonthActual.clubId})`,
    );
  }

  // Index lines by accountCode for cross-snapshot joins.
  const ytdByCode = indexLines(ytdActual.lines);
  const currentMonthByCode = indexLines(currentMonthActual.lines);

  const budgetCurrentMonthByCode = budget
    ? indexBudgetLinesForMonth(budget, currentMonthActual.fiscalPeriodSequence)
    : null;
  const budgetYtdByCode = budget
    ? indexBudgetLinesYtd(budget, currentMonthActual.fiscalPeriodSequence)
    : null;
  const priorYearLinesByCode = priorYear
    ? indexLines(priorYear.incomeStatement.lines)
    : null;

  // Union of account codes across current-month + ytd actual.
  const allAccountCodes = new Set<string>([
    ...currentMonthByCode.keys(),
    ...ytdByCode.keys(),
  ]);

  const lines: IncomeStatementLineComparator[] = [];
  for (const code of allAccountCodes) {
    const cm = currentMonthByCode.get(code);
    const ytd = ytdByCode.get(code);
    // Use whichever snapshot has the line for the metadata (name /
    // category / fund / department).
    const meta = cm ?? ytd!;
    lines.push({
      accountCode: code,
      accountName: meta.accountName,
      category: meta.category,
      fund: meta.fund,
      departmentCode: meta.departmentCode,
      currentMonth: buildVariance({
        actual: cm?.amount ?? 0,
        budget: budgetCurrentMonthByCode?.get(code) ?? null,
        priorYear: null, // prior-year is YTD only in the contract today
      }),
      ytd: buildVariance({
        actual: ytd?.amount ?? 0,
        budget: budgetYtdByCode?.get(code) ?? null,
        priorYear: priorYearLinesByCode?.get(code)?.amount ?? null,
      }),
    });
  }

  // Sort lines by category (revenue first), then by accountCode for
  // a stable rendering order.
  lines.sort((a, b) => {
    if (a.category !== b.category) {
      return a.category === "revenue" ? -1 : 1;
    }
    return a.accountCode.localeCompare(b.accountCode);
  });

  // Roll-ups.
  const categoryRollups = buildCategoryRollups({
    currentMonthActual,
    ytdActual,
    budget,
    priorYear,
  });

  return {
    clubId: currentMonthActual.clubId,
    periodStart: currentMonthActual.periodStart,
    periodEnd: currentMonthActual.periodEnd,
    fiscalYearLabel: currentMonthActual.fiscalYearLabel,
    fiscalPeriodSequence: currentMonthActual.fiscalPeriodSequence,
    lines,
    categoryRollups,
    sources: {
      currentMonthActualSnapshotId: currentMonthActual.snapshotId,
      ytdActualSnapshotId: ytdActual.snapshotId,
      budgetSnapshotId: budget?.snapshotId ?? null,
      priorYearSnapshotId: priorYear?.snapshotId ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Build a variance struct from raw inputs. Pure — exported for tests
 * that want to exercise the variance math without composing a full
 * snapshot.
 */
export function buildVariance(args: {
  actual: number;
  budget: number | null;
  priorYear: number | null;
}): IncomeStatementVariance {
  const variance = args.budget === null ? null : args.actual - args.budget;
  const variancePct =
    args.budget === null || args.budget === 0
      ? null
      : (args.actual - args.budget) / Math.abs(args.budget);
  return {
    actual: args.actual,
    budget: args.budget,
    variance,
    variancePct,
    priorYear: args.priorYear,
  };
}

function indexLines(
  lines: ReadonlyArray<IncomeStatementSnapshot["lines"][number]>,
): Map<string, IncomeStatementSnapshot["lines"][number]> {
  const m = new Map<string, IncomeStatementSnapshot["lines"][number]>();
  for (const l of lines) m.set(l.accountCode, l);
  return m;
}

function indexBudgetLinesForMonth(
  budget: BudgetSnapshot,
  fiscalPeriodSequence: number,
): Map<string, number> {
  const m = new Map<string, number>();
  const slot = fiscalPeriodSequence - 1; // monthlyAmounts is 0-indexed
  for (const l of budget.lines) {
    const amount = l.monthlyAmounts[slot] ?? 0;
    // Merge by accountCode (a budget line per department gets summed).
    m.set(l.accountCode, (m.get(l.accountCode) ?? 0) + amount);
  }
  return m;
}

function indexBudgetLinesYtd(
  budget: BudgetSnapshot,
  fiscalPeriodSequence: number,
): Map<string, number> {
  const m = new Map<string, number>();
  const upToSlot = fiscalPeriodSequence; // sum slots [0, upToSlot)
  for (const l of budget.lines) {
    let ytd = 0;
    for (let i = 0; i < upToSlot && i < l.monthlyAmounts.length; i++) {
      ytd += l.monthlyAmounts[i] ?? 0;
    }
    m.set(l.accountCode, (m.get(l.accountCode) ?? 0) + ytd);
  }
  return m;
}

function buildCategoryRollups(args: {
  currentMonthActual: IncomeStatementSnapshot;
  ytdActual: IncomeStatementSnapshot;
  budget: BudgetSnapshot | null | undefined;
  priorYear: PriorYearSnapshot | null | undefined;
}): IncomeStatementView["categoryRollups"] {
  const { currentMonthActual: cm, ytdActual: ytd, budget, priorYear } = args;

  // Budget roll-ups require an account-level walk. For now we expose
  // budget on per-line only (the per-line totals add up at consumer
  // time). The top-line budget total for the period is sum across
  // all lines for that month slot.
  const budgetMonthTotalRevenue = budget
    ? sumBudgetByFilter(budget, cm.fiscalPeriodSequence, "month", () => true)
    : null;
  const budgetYtdTotalRevenue = budget
    ? sumBudgetByFilter(budget, cm.fiscalPeriodSequence, "ytd", () => true)
    : null;
  // The current Budget contract doesn't carry category metadata per
  // line — that lives on the chart of accounts. For accurate budget
  // roll-ups by category we'd join budget.line.accountCode against
  // the snapshot's accountCode → category mapping. For now we expose
  // the per-line budget on the line comparators and provide
  // top-line ROLLUP variances from the snapshot's pre-rolled totals.
  void budgetMonthTotalRevenue;
  void budgetYtdTotalRevenue;

  const cmRollup = (actualField: number) =>
    buildVariance({ actual: actualField, budget: null, priorYear: null });
  const ytdRollup = (actualField: number, priorYearActual: number | null) =>
    buildVariance({
      actual: actualField,
      budget: null,
      priorYear: priorYearActual,
    });

  const priorYrIS = priorYear?.incomeStatement;

  return {
    totalOperatingRevenue: {
      currentMonth: cmRollup(cm.totalOperatingRevenue),
      ytd: ytdRollup(ytd.totalOperatingRevenue, priorYrIS?.totalOperatingRevenue ?? null),
    },
    totalOperatingExpense: {
      currentMonth: cmRollup(cm.totalOperatingExpense),
      ytd: ytdRollup(ytd.totalOperatingExpense, priorYrIS?.totalOperatingExpense ?? null),
    },
    noiBeforeDepreciation: {
      currentMonth: cmRollup(cm.noiBeforeDepreciation),
      ytd: ytdRollup(ytd.noiBeforeDepreciation, priorYrIS?.noiBeforeDepreciation ?? null),
    },
    noi: {
      currentMonth: cmRollup(cm.totalOperatingRevenue - cm.totalOperatingExpense),
      ytd: ytdRollup(
        ytd.totalOperatingRevenue - ytd.totalOperatingExpense,
        priorYrIS
          ? priorYrIS.totalOperatingRevenue - priorYrIS.totalOperatingExpense
          : null,
      ),
    },
    depreciation: {
      currentMonth: cmRollup(cm.depreciation),
      ytd: ytdRollup(ytd.depreciation, priorYrIS?.depreciation ?? null),
    },
    totalCapitalIncome: {
      currentMonth: cmRollup(cm.totalCapitalIncome),
      ytd: ytdRollup(ytd.totalCapitalIncome, priorYrIS?.totalCapitalIncome ?? null),
    },
    totalCapitalExpense: {
      currentMonth: cmRollup(cm.totalCapitalExpense),
      ytd: ytdRollup(ytd.totalCapitalExpense, priorYrIS?.totalCapitalExpense ?? null),
    },
  };
}

function sumBudgetByFilter(
  budget: BudgetSnapshot,
  fiscalPeriodSequence: number,
  scope: "month" | "ytd",
  predicate: (line: BudgetSnapshot["lines"][number]) => boolean,
): number {
  let total = 0;
  const slotOrUpToSlot = fiscalPeriodSequence - 1;
  for (const l of budget.lines) {
    if (!predicate(l)) continue;
    if (scope === "month") {
      total += l.monthlyAmounts[slotOrUpToSlot] ?? 0;
    } else {
      for (let i = 0; i < fiscalPeriodSequence && i < l.monthlyAmounts.length; i++) {
        total += l.monthlyAmounts[i] ?? 0;
      }
    }
  }
  return total;
}

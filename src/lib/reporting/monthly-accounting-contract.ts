// Canonical Monthly Accounting-Backed Reporting Contract.
//
// Every financial chapter of the Monthly Board Reporting Package
// (Statement of Activities, Capital Fund, Statement of Financial
// Position, Stewardship Dashboard scorecards, Departmental P&L,
// Cover-page At-a-Glance KPIs) MUST consume this contract — never
// hardcoded React literals, never per-chapter ad-hoc demo objects.
//
// Per CLAUDE.md `Financial Reporting Data Integrity — Mandatory`:
//   Accounting Records → Reporting Service → KPI Calculations
//   → Visualizations → Commentary
//
// This file is the "Reporting Service" layer for accounting-backed
// surfaces. It provides:
//
//   • A typed shape (`MonthlyAccountingReport`) that aggregates the
//     fields every Jonas-responsive chapter needs: period, current-
//     month + YTD actuals/budget, prior-year comparatives, balance
//     sheet, departments, capital fund, AR aging.
//
//   • A pure builder (`buildMonthlyAccountingReport`) that takes raw
//     numeric inputs (the kind a future `getGLAccountTotals()` /
//     `getBalanceSheet()` will produce from Jonas-imported prisma
//     data) and returns the fully-formatted, tone-classified,
//     variance-computed contract.
//
//   • A demo input builder (`buildDemoMonthlyAccountingInput`) that
//     supplies a believable Silver-Springs-flavoured raw input so
//     consumers (and tests) can exercise the contract today without
//     waiting for the Jonas import wiring. EVERY block returned by
//     this demo builder is tagged `dataSource: "demo"`.
//
// PHASE 1 INTENT (per docs/monthly-reporting-jonas-readiness-plan.md):
// future Phase 1 services (`getGLAccountTotals()`,
// `getBalanceSheet()`, `getDepreciationSchedule()`, …) will replace
// the demo input builder's output with prisma-backed values. The
// CONTRACT — this file — stays stable; only the input source changes.
//
// EXTENDED DATA SOURCE TAXONOMY:
//   Existing system uses `ReportingDataSource = "live" | "demo"` in
//   monthly-package.ts. The accounting contract uses a richer 4-value
//   taxonomy (`accounting` / `operational` / `demo` / `derived`) so
//   each block carries provenance precise enough to drive a UI
//   provenance pill ("from GL" vs "from AR subledger" vs "demo
//   seed" vs "computed from above"). A round-trip helper maps the
//   new taxonomy onto the legacy `"live" | "demo"` flag for callers
//   that haven't migrated yet (`accounting` and `operational` map to
//   `"live"`; `demo` and `derived` map to `"demo"`).

import type { ReportingPeriod } from "@/lib/reporting/reporting-period";

// ---------------------------------------------------------------------------
// Data-source taxonomy
// ---------------------------------------------------------------------------

/**
 * Provenance of a single block in the accounting contract.
 *
 *  - `accounting` — Sourced from accounting records (Jonas GL via
 *                   prisma queries on FiscalPeriod / FiscalYear /
 *                   JournalEntry / JournalEntryLine). Reacts to a
 *                   Jonas import directly.
 *
 *  - `operational` — Sourced from operational subledgers / external
 *                    systems (MemberAccount for AR, payroll provider,
 *                    POS for F&B, tee sheet for golf, weather API).
 *                    Reacts to its own integration, not to Jonas GL.
 *
 *  - `demo`        — Seeded sample data clearly marked as not-live.
 *                    Used until the matching `accounting` /
 *                    `operational` source lands. Must surface as
 *                    visibly demo on the UI to never mislead the
 *                    board.
 *
 *  - `derived`     — Computed in this contract from other blocks
 *                    (e.g. NOI = total revenue − total expenses;
 *                    variance = actual − budget). Its accuracy is
 *                    transitively at most as good as its inputs.
 *                    Render-time consumers can flag a `derived` block
 *                    as "live" iff every input is `accounting` /
 *                    `operational`.
 */
export type MonthlyAccountingDataSource =
  | "accounting"
  | "operational"
  | "demo"
  | "derived";

/**
 * Legacy package data source — `"live" | "demo"`. Existing
 * `ReportingDataSource` consumers (monthly-package.ts and most
 * services) only know these two values. Until they're migrated, the
 * accounting contract exposes a helper that collapses the 4-value
 * taxonomy onto the 2-value legacy flag.
 */
export type LegacyReportingDataSource = "live" | "demo";

/**
 * Maps the rich `MonthlyAccountingDataSource` onto the legacy 2-value
 * flag. `accounting`, `operational`, and `derived` collapse to
 * `"live"` (a derived block is an internal computation, not unknown
 * provenance — it's as live as its inputs, which the contract
 * validates separately). `demo` is the only value that collapses to
 * `"demo"` — that's the only case where the rendered number is a
 * seeded literal rather than a real datum.
 */
export function toLegacyDataSource(
  src: MonthlyAccountingDataSource,
): LegacyReportingDataSource {
  return src === "demo" ? "demo" : "live";
}

// ---------------------------------------------------------------------------
// Money + comparative primitives
// ---------------------------------------------------------------------------

/**
 * A pre-formatted money amount. The numeric value is held alongside
 * three pre-rendered string variants so React renders strings only;
 * no `toLocaleString` calls in components.
 */
export type MoneyAmount = {
  /** Raw amount in dollars (not cents). May be negative. */
  amount: number;
  /** Full-precision label — e.g. `"$3,180,000"`. */
  label: string;
  /** Compact label — e.g. `"$3.18M"` / `"$245K"` / `"$0"`. */
  shortLabel: string;
};

/** Build a `MoneyAmount` from a raw dollar value. */
export function buildMoneyAmount(amount: number): MoneyAmount {
  return {
    amount,
    label: formatMoneyFull(amount),
    shortLabel: formatMoneyShort(amount),
  };
}

/** Format a dollar value to `"$1,234,567"` (or `"($1,234,567)"`
 *  for negatives, accountant-style). */
export function formatMoneyFull(amount: number): string {
  const abs = Math.abs(amount);
  const body = `$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return amount < 0 ? `(${body})` : body;
}

/** Format a dollar value to compact `"$3.18M"` / `"$245K"` / `"$0"`. */
export function formatMoneyShort(amount: number): string {
  const abs = Math.abs(amount);
  let body: string;
  if (abs >= 1_000_000) {
    body = `$${(abs / 1_000_000).toFixed(2)}M`;
  } else if (abs >= 1_000) {
    body = `$${Math.round(abs / 1_000)}K`;
  } else {
    body = `$${Math.round(abs)}`;
  }
  return amount < 0 ? `(${body})` : body;
}

/** Format a fraction as a signed percent — e.g. `+3.2%` / `(1.4%)`. */
export function formatVariancePct(pct: number): string {
  const abs = Math.abs(pct * 100);
  const body = `${abs.toFixed(1)}%`;
  if (pct > 0) return `+${body}`;
  if (pct < 0) return `(${body})`;
  return body;
}

/** Variance tone derived from an `actual vs budget` ratio. The
 *  contract owns this classification so React renders the tone
 *  string directly — never branches on the variance itself. */
export type VarianceTone = "favorable" | "unfavorable" | "neutral";

/** Threshold for "neutral" tone. Variances within this band (±) are
 *  classified `neutral` ("on plan"); outside the band is favorable /
 *  unfavorable based on sign. Default 0.5 % aligns with the existing
 *  `±3%` and `±5%` corridors used elsewhere (this is the inner,
 *  noise-level band). */
export const NEUTRAL_VARIANCE_BAND = 0.005;

/**
 * Classify variance tone. For revenue / favourable lines, positive
 * variance = favorable. For expense / unfavourable lines, signs are
 * inverted — pass `{ higherIsFavorable: false }`.
 */
export function classifyVarianceTone(
  variancePct: number,
  opts: { higherIsFavorable?: boolean } = {},
): VarianceTone {
  const flip = opts.higherIsFavorable === false ? -1 : 1;
  const signed = variancePct * flip;
  if (Math.abs(signed) < NEUTRAL_VARIANCE_BAND) return "neutral";
  return signed > 0 ? "favorable" : "unfavorable";
}

/**
 * A current-month / YTD / prior-year comparative block. Every GL
 * category aggregate, every NOI line, every department row carries
 * this shape so consumers receive a single comparative quad rather
 * than spelunking into per-period arrays.
 */
export type ActualVsBudget = {
  actual: MoneyAmount;
  budget: MoneyAmount;
  priorYear: MoneyAmount;
  /** Variance = actual − budget. May be negative (unfavorable when
   *  higherIsFavorable). */
  varianceVsBudget: MoneyAmount;
  /** Variance percent = (actual − budget) / budget. Zero when
   *  budget is zero, with `varianceTone: "neutral"`. */
  varianceVsBudgetPct: number;
  varianceVsBudgetPctLabel: string;
  /** Variance vs prior-year. */
  varianceVsPriorYear: MoneyAmount;
  varianceVsPriorYearPct: number;
  varianceVsPriorYearPctLabel: string;
  /** Tone derived from `varianceVsBudgetPct` and the metric's
   *  higher-is-favorable orientation. */
  varianceTone: VarianceTone;
};

/**
 * Compute an `ActualVsBudget` from raw numbers. Pure function.
 * Pass `higherIsFavorable: false` for expense / cost / negative
 * metrics so the tone classification flips correctly.
 */
export function buildActualVsBudget(input: {
  actual: number;
  budget: number;
  priorYear: number;
  higherIsFavorable?: boolean;
}): ActualVsBudget {
  const { actual, budget, priorYear } = input;
  const higherIsFavorable = input.higherIsFavorable ?? true;
  const varianceAmount = actual - budget;
  const variancePct = budget === 0 ? 0 : varianceAmount / Math.abs(budget);
  const varianceVsPyAmount = actual - priorYear;
  const varianceVsPyPct =
    priorYear === 0 ? 0 : varianceVsPyAmount / Math.abs(priorYear);
  return {
    actual: buildMoneyAmount(actual),
    budget: buildMoneyAmount(budget),
    priorYear: buildMoneyAmount(priorYear),
    varianceVsBudget: buildMoneyAmount(varianceAmount),
    varianceVsBudgetPct: variancePct,
    varianceVsBudgetPctLabel: formatVariancePct(variancePct),
    varianceVsPriorYear: buildMoneyAmount(varianceVsPyAmount),
    varianceVsPriorYearPct: varianceVsPyPct,
    varianceVsPriorYearPctLabel: formatVariancePct(varianceVsPyPct),
    varianceTone: classifyVarianceTone(variancePct, { higherIsFavorable }),
  };
}

// ---------------------------------------------------------------------------
// Block shapes — GL category aggregates, balance sheet, departments,
// capital fund, AR aging
// ---------------------------------------------------------------------------

/**
 * A single GL category aggregate carrying current-month + YTD
 * actual/budget/prior-year. The contract uses these as the atomic
 * building blocks for SOA rows, scorecard inputs, and cover KPIs.
 *
 * `categoryKey` is the stable identifier the consumer matches on
 * (e.g. `"OPERATING_DUES_REVENUE"`, `"PAYROLL_BENEFITS"`,
 * `"INITIATION_FEES"`). Labels are display-only.
 */
export type GLCategoryAggregate = {
  categoryKey: string;
  label: string;
  currentMonth: ActualVsBudget;
  ytd: ActualVsBudget;
  dataSource: MonthlyAccountingDataSource;
};

/**
 * A balance-sheet account balance as-of `asOf`. `category` groups
 * accounts so consumers can render assets / liabilities / equity
 * sections without re-classifying. Prior-year comparative is
 * optional (some balances don't have a meaningful prior-year peer).
 */
export type BalanceSheetAccountBalance = {
  accountKey: string;
  /** Display label — e.g. `"Cash — Operating Account"`. */
  label: string;
  /** Coarse classification used by the balance sheet layout. */
  category:
    | "CURRENT_ASSET"
    | "CAPITAL_FUND_ASSET"
    | "PROPERTY_PLANT_EQUIPMENT"
    | "CURRENT_LIABILITY"
    | "LONG_TERM_LIABILITY"
    | "EQUITY";
  amount: MoneyAmount;
  /** Optional prior-year comparative (same account on the same
   *  date one year earlier). */
  priorYearAmount?: MoneyAmount;
  dataSource: MonthlyAccountingDataSource;
};

/**
 * A department result row — used by the Stewardship Dashboard's
 * Department Net Performance card AND the Departmental P&L summary.
 */
export type DepartmentResultRow = {
  departmentId: string;
  name: string;
  ytd: ActualVsBudget;
  /** Contribution margin as a fraction of revenue (0..1). Derived. */
  contributionPctOfRevenue: number;
  dataSource: MonthlyAccountingDataSource;
};

/**
 * Capital fund activity. Sources + deployments are GL category
 * aggregates; net position change is derived. Reserve fund balance
 * cross-links to the balance sheet (`asOf` matches the contract's
 * period end).
 */
export type CapitalFundActivity = {
  sources: GLCategoryAggregate[];
  deployed: GLCategoryAggregate[];
  netPositionChange: ActualVsBudget; // derived: sources − deployed
  reserveFundBalance: MoneyAmount;
  totalAssetReplacementCost: MoneyAmount;
  reserveCoverageRatio: number; // 0..1
  dataSource: MonthlyAccountingDataSource;
};

/**
 * AR aging block — by category × bucket. Carries the totals + per-
 * category breakdown so consumers can render either a 1-row summary
 * (cover-page KPI) or a full 4×4 matrix (AR aging chapter).
 */
export type ARAgingBucketKey = "current" | "31-60" | "61-90" | "over-90";

export type ARAgingByCategoryRow = {
  categoryKey: string;
  /** Display label — e.g. `"Membership Dues"`. */
  label: string;
  buckets: Record<ARAgingBucketKey, MoneyAmount>;
  total: MoneyAmount;
  dataSource: MonthlyAccountingDataSource;
};

export type ARAgingSnapshot = {
  asOf: Date;
  byCategory: ARAgingByCategoryRow[];
  totals: Record<ARAgingBucketKey, MoneyAmount>;
  totalAR: MoneyAmount;
  /** Fraction in `current` bucket (0..1). Derived. */
  currentPct: number;
  /** Fraction in `over-90` bucket (0..1). Derived. */
  over90Pct: number;
  dataSource: MonthlyAccountingDataSource;
};

/**
 * Balance sheet snapshot — assets / liabilities / equity, with
 * reconciliation flag and totals already computed.
 */
export type BalanceSheetSnapshot = {
  asOf: Date;
  accounts: BalanceSheetAccountBalance[];
  totalAssets: MoneyAmount;
  totalLiabilities: MoneyAmount;
  totalEquity: MoneyAmount;
  totalLiabilitiesAndEquity: MoneyAmount;
  /** Reconciliation: `totalAssets === totalLiabilities + totalEquity`
   *  within a small tolerance. Surfaces an error banner on the UI if
   *  false. Derived. */
  isReconciled: boolean;
  dataSource: MonthlyAccountingDataSource;
};

// ---------------------------------------------------------------------------
// The full report
// ---------------------------------------------------------------------------

/**
 * The complete monthly accounting-backed reporting contract. The
 * top-level shape financial chapters consume. Chapters destructure
 * the parts they render; they NEVER read `Date` APIs, never compute
 * variance, never branch on tone — every derived value is already
 * here.
 */
export type MonthlyAccountingReport = {
  /** Selected reporting period (from `buildReportingPeriod`). */
  period: ReportingPeriod;
  /** Club id this report was built for. */
  clubId: string;
  /** Operating revenue lines by GL category. */
  operatingRevenue: GLCategoryAggregate[];
  /** Operating expense lines by GL category. */
  operatingExpenses: GLCategoryAggregate[];
  /** NOI — Total Operating Revenue minus Total Operating Expenses.
   *  Derived from the two arrays above. `varianceTone` reads
   *  current-month-vs-budget. */
  noi: {
    currentMonth: ActualVsBudget;
    ytd: ActualVsBudget;
    dataSource: MonthlyAccountingDataSource;
  };
  /** Capital fund activity (sources + deployed + net + reserve). */
  capitalFund: CapitalFundActivity;
  /** Balance sheet as of `period.periodEnd`. */
  balanceSheet: BalanceSheetSnapshot;
  /** Department result rows for the Stewardship Dashboard +
   *  Departmental P&L sections. */
  departments: DepartmentResultRow[];
  /** Accounts receivable aging as of `period.periodEnd`. */
  arAging: ARAgingSnapshot;
  /** Metadata for the package builder + render-time UI provenance
   *  pills. */
  metadata: {
    builtAt: Date;
    /** Count of blocks per data-source class. Useful for a UI
     *  banner like "23 accounting-backed · 4 operational · 8 demo". */
    sourceSummary: Record<MonthlyAccountingDataSource, number>;
    /** Legacy `"live" | "demo"` rollup — `"live"` iff EVERY block
     *  is `accounting` or `operational`. Convenient for existing
     *  consumers that read `dataSource: ReportingDataSource`. */
    legacyDataSource: LegacyReportingDataSource;
  };
};

// ---------------------------------------------------------------------------
// Raw input shape — what a Jonas-import wiring service produces
// ---------------------------------------------------------------------------

/**
 * Raw GL category numbers — what a future `getGLAccountTotals()`
 * (or a chapter's existing seeded constant) supplies to the
 * contract builder. All values are dollars; the builder formats +
 * computes the variance + classifies the tone.
 */
export type GLCategoryAggregateInput = {
  categoryKey: string;
  label: string;
  /** Current month actual. */
  currentMonthActual: number;
  /** Current month budget. */
  currentMonthBudget: number;
  /** Current month prior-year. */
  currentMonthPriorYear: number;
  /** YTD actual through `period.periodEnd`. */
  ytdActual: number;
  /** YTD budget through `period.periodEnd`. */
  ytdBudget: number;
  /** YTD prior-year (same 12-month window one year earlier). */
  ytdPriorYear: number;
  /** Whether positive variance is favourable (true for revenue,
   *  false for expense). Defaults to true. */
  higherIsFavorable?: boolean;
  dataSource: MonthlyAccountingDataSource;
};

export type BalanceSheetAccountInput = {
  accountKey: string;
  label: string;
  category: BalanceSheetAccountBalance["category"];
  amount: number;
  priorYearAmount?: number;
  dataSource: MonthlyAccountingDataSource;
};

export type DepartmentResultInput = {
  departmentId: string;
  name: string;
  ytdRevenueActual: number;
  ytdRevenueBudget: number;
  ytdRevenuePriorYear: number;
  ytdExpenseActual: number;
  ytdExpenseBudget: number;
  ytdExpensePriorYear: number;
  dataSource: MonthlyAccountingDataSource;
};

export type CapitalFundInput = {
  sources: GLCategoryAggregateInput[];
  deployed: GLCategoryAggregateInput[];
  reserveFundBalance: number;
  totalAssetReplacementCost: number;
  dataSource: MonthlyAccountingDataSource;
};

export type ARAgingByCategoryInput = {
  categoryKey: string;
  label: string;
  current: number;
  thirtyToSixty: number;
  sixtyOneToNinety: number;
  overNinety: number;
  dataSource: MonthlyAccountingDataSource;
};

/** The raw input to the contract builder. Future Jonas-import
 *  services produce this; today the `buildDemoMonthlyAccountingInput`
 *  factory produces a seeded version tagged `dataSource: "demo"`. */
export type MonthlyAccountingReportInput = {
  period: ReportingPeriod;
  clubId: string;
  operatingRevenueRaw: GLCategoryAggregateInput[];
  operatingExpensesRaw: GLCategoryAggregateInput[];
  capitalFundRaw: CapitalFundInput;
  balanceSheetRaw: {
    asOf: Date;
    accounts: BalanceSheetAccountInput[];
    dataSource: MonthlyAccountingDataSource;
  };
  departmentsRaw: DepartmentResultInput[];
  arAgingRaw: {
    asOf: Date;
    byCategory: ARAgingByCategoryInput[];
    dataSource: MonthlyAccountingDataSource;
  };
  /** Time the report was built. Optional; defaults to
   *  `period.periodEnd` if not supplied. Tests pass a fixed date so
   *  snapshot assertions are deterministic. */
  builtAt?: Date;
};

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * Build the canonical `MonthlyAccountingReport` from raw numeric
 * inputs. Pure function — no I/O, deterministic given inputs.
 *
 *  • Formats every money amount via `buildMoneyAmount`.
 *  • Computes variance + variance %.
 *  • Classifies tone (favorable / unfavorable / neutral).
 *  • Derives NOI from revenue − expense aggregates.
 *  • Derives capital-fund net position change from sources − deployed.
 *  • Derives balance-sheet totals + reconciliation flag.
 *  • Derives AR aging current% / over90%.
 *  • Aggregates per-block dataSource counts into metadata.
 */
export function buildMonthlyAccountingReport(
  input: MonthlyAccountingReportInput,
): MonthlyAccountingReport {
  const operatingRevenue = input.operatingRevenueRaw.map(buildGLCategoryAggregate);
  const operatingExpenses = input.operatingExpensesRaw.map((e) =>
    // Default expense lines to higherIsFavorable=false unless caller
    // explicitly overrode. Revenue defaults to true.
    buildGLCategoryAggregate({ ...e, higherIsFavorable: e.higherIsFavorable ?? false }),
  );

  // NOI = sum(revenue) − sum(expense). Each side is summed at the
  // current-month and ytd level separately so the comparative quad
  // is preserved.
  const noi = buildNoiAggregate(operatingRevenue, operatingExpenses);

  const capitalFund = buildCapitalFundActivity(input.capitalFundRaw);

  const balanceSheet = buildBalanceSheetSnapshot(input.balanceSheetRaw);

  const departments = input.departmentsRaw.map(buildDepartmentResultRow);

  const arAging = buildARAgingSnapshot(input.arAgingRaw);

  // Aggregate dataSource counts across every block so a UI
  // provenance banner can render "X accounting · Y operational · Z
  // demo · W derived".
  const sourceSummary = aggregateSourceSummary({
    operatingRevenue,
    operatingExpenses,
    noi,
    capitalFund,
    balanceSheet,
    departments,
    arAging,
  });

  // The package "live"-vs-"demo" rollup is `"live"` iff NO block is
  // tagged `demo`. `derived` blocks (e.g. NOI computed from revenue
  // − expense) are an internal computation, not unknown provenance —
  // they're as live as their inputs. Since the only way for inputs
  // to a `derived` block to be `demo` is for the input blocks
  // themselves to be tagged `demo` (which we check directly), a
  // `derived` block does not contaminate the rollup.
  const legacyDataSource: LegacyReportingDataSource =
    sourceSummary.demo === 0 ? "live" : "demo";

  return {
    period: input.period,
    clubId: input.clubId,
    operatingRevenue,
    operatingExpenses,
    noi,
    capitalFund,
    balanceSheet,
    departments,
    arAging,
    metadata: {
      builtAt: input.builtAt ?? input.period.periodEnd,
      sourceSummary,
      legacyDataSource,
    },
  };
}

function buildGLCategoryAggregate(
  input: GLCategoryAggregateInput,
): GLCategoryAggregate {
  const higherIsFavorable = input.higherIsFavorable ?? true;
  return {
    categoryKey: input.categoryKey,
    label: input.label,
    currentMonth: buildActualVsBudget({
      actual: input.currentMonthActual,
      budget: input.currentMonthBudget,
      priorYear: input.currentMonthPriorYear,
      higherIsFavorable,
    }),
    ytd: buildActualVsBudget({
      actual: input.ytdActual,
      budget: input.ytdBudget,
      priorYear: input.ytdPriorYear,
      higherIsFavorable,
    }),
    dataSource: input.dataSource,
  };
}

function buildNoiAggregate(
  revenue: GLCategoryAggregate[],
  expenses: GLCategoryAggregate[],
): MonthlyAccountingReport["noi"] {
  const sumCurrentMonth = (rows: GLCategoryAggregate[]) =>
    rows.reduce(
      (acc, r) => ({
        actual: acc.actual + r.currentMonth.actual.amount,
        budget: acc.budget + r.currentMonth.budget.amount,
        priorYear: acc.priorYear + r.currentMonth.priorYear.amount,
      }),
      { actual: 0, budget: 0, priorYear: 0 },
    );
  const sumYtd = (rows: GLCategoryAggregate[]) =>
    rows.reduce(
      (acc, r) => ({
        actual: acc.actual + r.ytd.actual.amount,
        budget: acc.budget + r.ytd.budget.amount,
        priorYear: acc.priorYear + r.ytd.priorYear.amount,
      }),
      { actual: 0, budget: 0, priorYear: 0 },
    );
  const revCM = sumCurrentMonth(revenue);
  const expCM = sumCurrentMonth(expenses);
  const revYtd = sumYtd(revenue);
  const expYtd = sumYtd(expenses);
  return {
    currentMonth: buildActualVsBudget({
      actual: revCM.actual - expCM.actual,
      budget: revCM.budget - expCM.budget,
      priorYear: revCM.priorYear - expCM.priorYear,
      higherIsFavorable: true,
    }),
    ytd: buildActualVsBudget({
      actual: revYtd.actual - expYtd.actual,
      budget: revYtd.budget - expYtd.budget,
      priorYear: revYtd.priorYear - expYtd.priorYear,
      higherIsFavorable: true,
    }),
    dataSource: "derived",
  };
}

function buildCapitalFundActivity(input: CapitalFundInput): CapitalFundActivity {
  const sources = input.sources.map((s) =>
    buildGLCategoryAggregate({ ...s, higherIsFavorable: s.higherIsFavorable ?? true }),
  );
  const deployed = input.deployed.map((d) =>
    buildGLCategoryAggregate({ ...d, higherIsFavorable: d.higherIsFavorable ?? false }),
  );
  // Net position change = sources − deployed at the current-month
  // AND ytd level.
  const sourcesCM = sources.reduce(
    (a, r) => ({
      actual: a.actual + r.currentMonth.actual.amount,
      budget: a.budget + r.currentMonth.budget.amount,
      priorYear: a.priorYear + r.currentMonth.priorYear.amount,
    }),
    { actual: 0, budget: 0, priorYear: 0 },
  );
  const deployedCM = deployed.reduce(
    (a, r) => ({
      actual: a.actual + r.currentMonth.actual.amount,
      budget: a.budget + r.currentMonth.budget.amount,
      priorYear: a.priorYear + r.currentMonth.priorYear.amount,
    }),
    { actual: 0, budget: 0, priorYear: 0 },
  );
  const sourcesYtd = sources.reduce(
    (a, r) => ({
      actual: a.actual + r.ytd.actual.amount,
      budget: a.budget + r.ytd.budget.amount,
      priorYear: a.priorYear + r.ytd.priorYear.amount,
    }),
    { actual: 0, budget: 0, priorYear: 0 },
  );
  const deployedYtd = deployed.reduce(
    (a, r) => ({
      actual: a.actual + r.ytd.actual.amount,
      budget: a.budget + r.ytd.budget.amount,
      priorYear: a.priorYear + r.ytd.priorYear.amount,
    }),
    { actual: 0, budget: 0, priorYear: 0 },
  );
  const netPositionChange = buildActualVsBudget({
    actual: sourcesYtd.actual - deployedYtd.actual,
    budget: sourcesYtd.budget - deployedYtd.budget,
    priorYear: sourcesYtd.priorYear - deployedYtd.priorYear,
    higherIsFavorable: true,
  });
  // Currently unused but kept around for future commentary inputs.
  void sourcesCM;
  void deployedCM;
  const reserveFundBalance = buildMoneyAmount(input.reserveFundBalance);
  const totalAssetReplacementCost = buildMoneyAmount(input.totalAssetReplacementCost);
  const reserveCoverageRatio =
    input.totalAssetReplacementCost === 0
      ? 0
      : input.reserveFundBalance / input.totalAssetReplacementCost;
  return {
    sources,
    deployed,
    netPositionChange,
    reserveFundBalance,
    totalAssetReplacementCost,
    reserveCoverageRatio,
    dataSource: input.dataSource,
  };
}

function buildBalanceSheetSnapshot(input: {
  asOf: Date;
  accounts: BalanceSheetAccountInput[];
  dataSource: MonthlyAccountingDataSource;
}): BalanceSheetSnapshot {
  const accounts: BalanceSheetAccountBalance[] = input.accounts.map((a) => ({
    accountKey: a.accountKey,
    label: a.label,
    category: a.category,
    amount: buildMoneyAmount(a.amount),
    priorYearAmount:
      a.priorYearAmount !== undefined
        ? buildMoneyAmount(a.priorYearAmount)
        : undefined,
    dataSource: a.dataSource,
  }));
  const isAsset = (a: BalanceSheetAccountBalance) =>
    a.category === "CURRENT_ASSET" ||
    a.category === "CAPITAL_FUND_ASSET" ||
    a.category === "PROPERTY_PLANT_EQUIPMENT";
  const isLiability = (a: BalanceSheetAccountBalance) =>
    a.category === "CURRENT_LIABILITY" || a.category === "LONG_TERM_LIABILITY";
  const isEquity = (a: BalanceSheetAccountBalance) => a.category === "EQUITY";

  const sumAmount = (rows: BalanceSheetAccountBalance[]) =>
    rows.reduce((s, r) => s + r.amount.amount, 0);

  const totalAssets = sumAmount(accounts.filter(isAsset));
  const totalLiabilities = sumAmount(accounts.filter(isLiability));
  const totalEquity = sumAmount(accounts.filter(isEquity));
  const totalLiabilitiesAndEquity = totalLiabilities + totalEquity;
  // Reconciliation tolerance: $1. (Accounting balance sheets must
  // reconcile exactly; rounding noise from prisma Decimal -> number
  // is the only legitimate source of drift.)
  const isReconciled = Math.abs(totalAssets - totalLiabilitiesAndEquity) < 1;

  return {
    asOf: input.asOf,
    accounts,
    totalAssets: buildMoneyAmount(totalAssets),
    totalLiabilities: buildMoneyAmount(totalLiabilities),
    totalEquity: buildMoneyAmount(totalEquity),
    totalLiabilitiesAndEquity: buildMoneyAmount(totalLiabilitiesAndEquity),
    isReconciled,
    dataSource: input.dataSource,
  };
}

function buildDepartmentResultRow(
  input: DepartmentResultInput,
): DepartmentResultRow {
  // Department "result" = revenue − expense at the YTD level. The
  // ActualVsBudget block carries the net contribution, with
  // higherIsFavorable=true (more net = better).
  const ytd = buildActualVsBudget({
    actual: input.ytdRevenueActual - input.ytdExpenseActual,
    budget: input.ytdRevenueBudget - input.ytdExpenseBudget,
    priorYear: input.ytdRevenuePriorYear - input.ytdExpensePriorYear,
    higherIsFavorable: true,
  });
  const contributionPctOfRevenue =
    input.ytdRevenueActual === 0
      ? 0
      : (input.ytdRevenueActual - input.ytdExpenseActual) /
        input.ytdRevenueActual;
  return {
    departmentId: input.departmentId,
    name: input.name,
    ytd,
    contributionPctOfRevenue,
    dataSource: input.dataSource,
  };
}

function buildARAgingSnapshot(input: {
  asOf: Date;
  byCategory: ARAgingByCategoryInput[];
  dataSource: MonthlyAccountingDataSource;
}): ARAgingSnapshot {
  const byCategory: ARAgingByCategoryRow[] = input.byCategory.map((c) => {
    const buckets: Record<ARAgingBucketKey, MoneyAmount> = {
      current: buildMoneyAmount(c.current),
      "31-60": buildMoneyAmount(c.thirtyToSixty),
      "61-90": buildMoneyAmount(c.sixtyOneToNinety),
      "over-90": buildMoneyAmount(c.overNinety),
    };
    const total =
      c.current + c.thirtyToSixty + c.sixtyOneToNinety + c.overNinety;
    return {
      categoryKey: c.categoryKey,
      label: c.label,
      buckets,
      total: buildMoneyAmount(total),
      dataSource: c.dataSource,
    };
  });
  // Aggregate column totals.
  const totalsRaw = byCategory.reduce(
    (acc, c) => ({
      current: acc.current + c.buckets.current.amount,
      "31-60": acc["31-60"] + c.buckets["31-60"].amount,
      "61-90": acc["61-90"] + c.buckets["61-90"].amount,
      "over-90": acc["over-90"] + c.buckets["over-90"].amount,
    }),
    { current: 0, "31-60": 0, "61-90": 0, "over-90": 0 } as Record<
      ARAgingBucketKey,
      number
    >,
  );
  const totals: Record<ARAgingBucketKey, MoneyAmount> = {
    current: buildMoneyAmount(totalsRaw.current),
    "31-60": buildMoneyAmount(totalsRaw["31-60"]),
    "61-90": buildMoneyAmount(totalsRaw["61-90"]),
    "over-90": buildMoneyAmount(totalsRaw["over-90"]),
  };
  const totalAR =
    totalsRaw.current +
    totalsRaw["31-60"] +
    totalsRaw["61-90"] +
    totalsRaw["over-90"];
  const currentPct = totalAR === 0 ? 0 : totalsRaw.current / totalAR;
  const over90Pct = totalAR === 0 ? 0 : totalsRaw["over-90"] / totalAR;
  return {
    asOf: input.asOf,
    byCategory,
    totals,
    totalAR: buildMoneyAmount(totalAR),
    currentPct,
    over90Pct,
    dataSource: input.dataSource,
  };
}

function aggregateSourceSummary(report: {
  operatingRevenue: GLCategoryAggregate[];
  operatingExpenses: GLCategoryAggregate[];
  noi: MonthlyAccountingReport["noi"];
  capitalFund: CapitalFundActivity;
  balanceSheet: BalanceSheetSnapshot;
  departments: DepartmentResultRow[];
  arAging: ARAgingSnapshot;
}): Record<MonthlyAccountingDataSource, number> {
  const tally: Record<MonthlyAccountingDataSource, number> = {
    accounting: 0,
    operational: 0,
    demo: 0,
    derived: 0,
  };
  const bump = (src: MonthlyAccountingDataSource) => {
    tally[src] += 1;
  };
  report.operatingRevenue.forEach((r) => bump(r.dataSource));
  report.operatingExpenses.forEach((r) => bump(r.dataSource));
  bump(report.noi.dataSource);
  bump(report.capitalFund.dataSource);
  report.capitalFund.sources.forEach((r) => bump(r.dataSource));
  report.capitalFund.deployed.forEach((r) => bump(r.dataSource));
  bump(report.balanceSheet.dataSource);
  report.balanceSheet.accounts.forEach((a) => bump(a.dataSource));
  report.departments.forEach((d) => bump(d.dataSource));
  bump(report.arAging.dataSource);
  report.arAging.byCategory.forEach((c) => bump(c.dataSource));
  return tally;
}

// ---------------------------------------------------------------------------
// Demo input — believable Silver-Springs-flavoured seed
// ---------------------------------------------------------------------------

/**
 * Demo input factory. Returns a `MonthlyAccountingReportInput` whose
 * every block carries `dataSource: "demo"`. Used as the default
 * input until per-section Phase 1 services (`getGLAccountTotals`,
 * `getBalanceSheet`, …) replace it section-by-section.
 *
 * Numbers are deliberately compact and round so a tester can read
 * the demo report without grepping for the specific seeds — the
 * existing `SILVER_SPRINGS_*` constants in scattered service files
 * carry the production-realistic demo. This factory's job is to
 * exercise the contract shape, not impersonate Silver Springs.
 */
export function buildDemoMonthlyAccountingInput(args: {
  period: ReportingPeriod;
  clubId: string;
}): MonthlyAccountingReportInput {
  const { period, clubId } = args;
  return {
    period,
    clubId,
    operatingRevenueRaw: [
      {
        categoryKey: "OPERATING_DUES",
        label: "Operating Dues",
        currentMonthActual: 900_000,
        currentMonthBudget: 900_000,
        currentMonthPriorYear: 880_000,
        ytdActual: 4_500_000,
        ytdBudget: 4_500_000,
        ytdPriorYear: 4_400_000,
        dataSource: "demo",
      },
      {
        categoryKey: "INITIATION_FEES",
        label: "Initiation Fees",
        currentMonthActual: 80_000,
        currentMonthBudget: 100_000,
        currentMonthPriorYear: 70_000,
        ytdActual: 480_000,
        ytdBudget: 540_000,
        ytdPriorYear: 420_000,
        dataSource: "demo",
      },
      {
        categoryKey: "GOLF_OPERATIONS",
        label: "Golf Operations",
        currentMonthActual: 220_000,
        currentMonthBudget: 200_000,
        currentMonthPriorYear: 180_000,
        ytdActual: 720_000,
        ytdBudget: 700_000,
        ytdPriorYear: 640_000,
        dataSource: "demo",
      },
      {
        categoryKey: "FB_REVENUE",
        label: "Food & Beverage",
        currentMonthActual: 320_000,
        currentMonthBudget: 340_000,
        currentMonthPriorYear: 310_000,
        ytdActual: 1_350_000,
        ytdBudget: 1_400_000,
        ytdPriorYear: 1_280_000,
        dataSource: "demo",
      },
    ],
    operatingExpensesRaw: [
      {
        categoryKey: "PAYROLL_BENEFITS",
        label: "Payroll & Benefits",
        currentMonthActual: 760_000,
        currentMonthBudget: 750_000,
        currentMonthPriorYear: 720_000,
        ytdActual: 3_780_000,
        ytdBudget: 3_750_000,
        ytdPriorYear: 3_500_000,
        higherIsFavorable: false,
        dataSource: "demo",
      },
      {
        categoryKey: "FB_COGS",
        label: "Food & Beverage COGS",
        currentMonthActual: 125_000,
        currentMonthBudget: 130_000,
        currentMonthPriorYear: 115_000,
        ytdActual: 530_000,
        ytdBudget: 550_000,
        ytdPriorYear: 480_000,
        higherIsFavorable: false,
        dataSource: "demo",
      },
      {
        categoryKey: "OTHER_OPERATING",
        label: "Other Operating Expenses",
        currentMonthActual: 380_000,
        currentMonthBudget: 380_000,
        currentMonthPriorYear: 360_000,
        ytdActual: 1_900_000,
        ytdBudget: 1_900_000,
        ytdPriorYear: 1_840_000,
        higherIsFavorable: false,
        dataSource: "demo",
      },
    ],
    capitalFundRaw: {
      sources: [
        {
          categoryKey: "CAPITAL_DUES",
          label: "Capital Dues",
          currentMonthActual: 96_000,
          currentMonthBudget: 96_000,
          currentMonthPriorYear: 92_000,
          ytdActual: 480_000,
          ytdBudget: 480_000,
          ytdPriorYear: 460_000,
          dataSource: "demo",
        },
      ],
      deployed: [
        {
          categoryKey: "RESERVE_REPLACEMENTS",
          label: "Replacements",
          currentMonthActual: 82_000,
          currentMonthBudget: 100_000,
          currentMonthPriorYear: 70_000,
          ytdActual: 412_000,
          ytdBudget: 500_000,
          ytdPriorYear: 350_000,
          higherIsFavorable: false,
          dataSource: "demo",
        },
      ],
      reserveFundBalance: 4_820_000,
      totalAssetReplacementCost: 7_900_000,
      dataSource: "demo",
    },
    balanceSheetRaw: {
      asOf: period.periodEnd,
      accounts: [
        {
          accountKey: "CASH_OPERATING",
          label: "Cash — Operating",
          category: "CURRENT_ASSET",
          amount: 1_896_000,
          priorYearAmount: 1_842_000,
          dataSource: "demo",
        },
        {
          accountKey: "AR_NET",
          label: "Accounts Receivable, Net",
          category: "CURRENT_ASSET",
          amount: 984_000,
          priorYearAmount: 921_000,
          dataSource: "demo",
        },
        {
          accountKey: "RESERVE_FUND",
          label: "Reserve Fund",
          category: "CAPITAL_FUND_ASSET",
          amount: 4_820_000,
          priorYearAmount: 4_280_000,
          dataSource: "demo",
        },
        {
          accountKey: "PPE_NET",
          label: "Property, Plant & Equipment (Net)",
          category: "PROPERTY_PLANT_EQUIPMENT",
          amount: 22_300_000,
          priorYearAmount: 22_700_000,
          dataSource: "demo",
        },
        {
          accountKey: "AP",
          label: "Accounts Payable",
          category: "CURRENT_LIABILITY",
          amount: 285_000,
          priorYearAmount: 312_000,
          dataSource: "demo",
        },
        {
          accountKey: "LTD",
          label: "Long-Term Debt",
          category: "LONG_TERM_LIABILITY",
          amount: 1_260_000,
          priorYearAmount: 1_440_000,
          dataSource: "demo",
        },
        {
          accountKey: "EQUITY",
          label: "Members' Equity",
          category: "EQUITY",
          // Set to make the demo reconcile:
          //   assets    = 1_896 + 984 + 4_820 + 22_300 = 30_000K
          //   liab      = 285 + 1_260 = 1_545K
          //   equity    = 30_000 - 1_545 = 28_455K
          amount: 28_455_000,
          priorYearAmount: 27_991_000,
          dataSource: "demo",
        },
      ],
      dataSource: "demo",
    },
    departmentsRaw: [
      {
        departmentId: "GOLF",
        name: "Golf Operations",
        ytdRevenueActual: 720_000,
        ytdRevenueBudget: 700_000,
        ytdRevenuePriorYear: 640_000,
        ytdExpenseActual: 540_000,
        ytdExpenseBudget: 530_000,
        ytdExpensePriorYear: 500_000,
        dataSource: "demo",
      },
      {
        departmentId: "FB",
        name: "Food & Beverage",
        ytdRevenueActual: 1_350_000,
        ytdRevenueBudget: 1_400_000,
        ytdRevenuePriorYear: 1_280_000,
        ytdExpenseActual: 1_180_000,
        ytdExpenseBudget: 1_200_000,
        ytdExpensePriorYear: 1_100_000,
        dataSource: "demo",
      },
    ],
    arAgingRaw: {
      asOf: period.periodEnd,
      byCategory: [
        {
          categoryKey: "MEMBERSHIP_DUES",
          label: "Membership Dues",
          current: 844_000,
          thirtyToSixty: 400,
          sixtyOneToNinety: 0,
          overNinety: 0,
          // AR is a subledger read, not a GL read.
          dataSource: "operational",
        },
        {
          categoryKey: "FB",
          label: "Food & Beverage",
          current: 96_000,
          thirtyToSixty: 800,
          sixtyOneToNinety: 0,
          overNinety: 0,
          dataSource: "operational",
        },
        {
          categoryKey: "GOLF",
          label: "Golf",
          current: 38_000,
          thirtyToSixty: 0,
          sixtyOneToNinety: 0,
          overNinety: 0,
          dataSource: "operational",
        },
        {
          categoryKey: "AMENITIES",
          label: "Amenities",
          current: 5_400,
          thirtyToSixty: 0,
          sixtyOneToNinety: 0,
          overNinety: 0,
          dataSource: "operational",
        },
      ],
      // The AR aging snapshot block itself is operational (the rows
      // come from MemberAccount via prisma).
      dataSource: "operational",
    },
  };
}

/**
 * Convenience helper: build a demo `MonthlyAccountingReport` directly
 * (period + clubId → full report tagged `demo`/`operational`).
 * Saves callers a two-step `buildDemoMonthlyAccountingInput` →
 * `buildMonthlyAccountingReport` dance for the common case.
 */
export function buildDemoMonthlyAccountingReport(args: {
  period: ReportingPeriod;
  clubId: string;
}): MonthlyAccountingReport {
  return buildMonthlyAccountingReport(buildDemoMonthlyAccountingInput(args));
}

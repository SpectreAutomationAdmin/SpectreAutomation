// ---------------------------------------------------------------------------
// Payroll Analysis reporting service.
//
// Owns the data for the two new Chair's Dashboard payroll cards:
//
//   1. Payroll Analysis — Department Breakdown
//      (4 KPI tiles + grouped bar chart by department + Dues-Cover-
//       Payroll check)
//   2. Payroll Ratio — Monthly Trend
//      (4 KPI tiles + 12-month line chart with 4 series)
//
// Inputs are typed numeric seeds (per-department payroll, monthly
// ratios, revenue, dues income). Every display string is COMPUTED
// from the inputs — KPI labels, variance dollars, percentages,
// commentary numerics. The "PASS ✓" check on card 1 is also
// computed (dues > payroll AND duesRatio > payrollRatio).
// ---------------------------------------------------------------------------

import type { ReportingDataSource } from "./monthly-package";
import { SILVER_SPRINGS_OPERATING_DUES as CANONICAL_OPERATING_DUES } from "./dues-subsidy";

// -- Card 1 types -------------------------------------------------------------

export type PayrollDeptRowInput = {
  key: string;
  name: string;
  actual: number;       // dollars
  budget: number;
  priorYear: number;
};

export type FormattedPayrollDeptRow = {
  key: string;
  name: string;
  actualK: number;     // chart-ready (dollars / 1000)
  budgetK: number;
  priorYearK: number;
};

export type PayrollDepartmentData = {
  title: string;
  subtitle: string;
  pillLabel: string;
  /** "Actual" series label for the grouped-bar chart legend (e.g.
   *  "2026 Actual"). Derived from `reportingYear`. */
  actualSeriesLabel: string;
  /** Pre-formatted KPI tile values. */
  kpis: {
    totalYtdLabel:        string;  // "$9.87M"
    vsBudgetLabel:        string;  // "$122K"
    vsPriorYearLabel:     string;  // "$613K"
    payrollRatioLabel:    string;  // "59.2%"
  };
  /** Raw numeric inputs preserved for assertions / downstream calc. */
  totals: {
    actualDollars:    number;
    budgetDollars:    number;
    priorYearDollars: number;
    revenueDollars:   number;
    duesDollars:      number;
    payrollRatioPct:  number;
    duesRatioPct:     number;
  };
  /** 10 departments × 3 series, ready for the grouped bar chart. */
  rows: FormattedPayrollDeptRow[];
  /** Department names in plot order. */
  xLabels: string[];
  /** Series colours for the grouped bar chart. Inline-hex (audit-safe). */
  seriesColors: { actual: string; budget: string; priorYear: string };
  /** Dues-Cover-Payroll narrative: "PASS ✓" iff the model holds. */
  check: {
    /** Header phrase rendered in bold ("Dues Revenue Covers Payroll Check:"). */
    headerPhrase: string;
    /** The two-clause body sentence including the bold numerics. */
    bodySentence: string;
    /** "PASS" or "FAIL" decision computed from the inputs. */
    decision: "PASS" | "FAIL";
  };
  dataSource: ReportingDataSource;
};

export type PayrollDepartmentInputs = {
  departments: PayrollDeptRowInput[];
  revenueDollars: number;
  duesDollars: number;
  /** Calendar year of the reporting period (e.g. 2026 for a May 2026
   *  package). Drives the "Actual" series label in the chart legend.
   *  When the package is later published for a different year, the
   *  legend text follows automatically — no hardcoded "2025 Actual"
   *  or "2026 Actual" literal anywhere in React. */
  reportingYear: number;
};

// -- Card 2 types -------------------------------------------------------------

export type PayrollRatioMonthlyInput = { label: string; ratio: number; };

export type PayrollRatioTrendData = {
  title: string;
  subtitle: string;
  pillLabel: string;
  /** "Actual" series label for the line chart legend (e.g.
   *  "2026 Actual"). Derived from `reportingYear`. */
  actualSeriesLabel: string;
  /** Number of months with actual data plotted (= reportingMonth).
   *  Exposed for assertions / responsive logic. The chart's x-axis
   *  always shows 12 months — `monthsPlotted` describes only how far
   *  the actual line extends. */
  monthsPlotted: number;
  kpis: {
    ytdRatioLabel:    string;
    budgetRatioLabel: string;
    priorYearLabel:   string;
    benchmarkLabel:   string;
  };
  /** Y-axis range / ticks computed from the data with $5% rounding. */
  yDomain: [number, number];
  yTicks: number;
  /** 12-month series for the line chart. */
  months: string[];
  /** Actual series — 12 months. Values for months STRICTLY AFTER the
   *  reporting period are `null` (no point / no line segment drawn).
   *  CRITICAL: futures are null, NEVER zero, NEVER carried-forward,
   *  NEVER interpolated. */
  actualSeries:    { label: string; value: number | null }[];
  /** Budget series — 12 months, always populated end-to-end. The
   *  budget is forecast data and is known for the full fiscal year. */
  budgetSeries:    { label: string; value: number }[];
  /** Benchmark series — 12 months, always populated end-to-end at
   *  the configured benchmark value. */
  benchmarkSeries: { label: string; value: number }[];
  /** Prior-year series — 12 months, always populated end-to-end
   *  (prior-year accounting records are closed and known). */
  priorYearSeries: { label: string; value: number }[];
  /** Commentary paragraph (with the second sentence pre-emphasised by
   *  wrapping in `__…__` so the React renderer can italicise it). */
  commentary: string;
  dataSource: ReportingDataSource;
};

export type PayrollRatioTrendInputs = {
  monthlyActual:    PayrollRatioMonthlyInput[];
  monthlyBudget:    PayrollRatioMonthlyInput[];
  monthlyPriorYear: PayrollRatioMonthlyInput[];
  benchmarkPct:     number;
  duesRatioPct:     number; // for the commentary
  /** Golf rounds YTD — drives the "member utilization up X%"
   *  figure in the commentary. Sourced from the Operating
   *  Stewardship scorecard's golf-rounds row so both surfaces
   *  reconcile to the same underlying count. */
  golfRoundsActual:    number;
  golfRoundsPriorYear: number;
  /** Calendar year of the reporting period (e.g. 2026 for a May 2026
   *  package). Drives the "Actual" series legend label. */
  reportingYear: number;
  /** Month-of-year (1..12) of the reporting period end. Drives the
   *  trend chart's x-axis window: the chart plots ONLY months 1..N
   *  where N = reportingMonth. For a May 2026 package, plots Jan-May;
   *  future months (Jun-Dec) are NOT plotted because their accounting
   *  records don't exist yet. */
  reportingMonth: number;
};

// -- Formatters ---------------------------------------------------------------

function fmtDollarsM(d: number): string {
  return `$${(d / 1_000_000).toFixed(2)}M`;
}
function fmtDollarsK(d: number): string {
  const k = Math.round(d / 1000);
  if (d < 0) return `($${Math.abs(k).toLocaleString("en-US")}K)`;
  return `$${k.toLocaleString("en-US")}K`;
}
function pct1(num: number, den: number): string {
  if (den <= 0) return "—";
  return `${((num / den) * 100).toFixed(1)}%`;
}

// -- Card 1 builder -----------------------------------------------------------

export function buildPayrollDepartmentData(
  inputs: PayrollDepartmentInputs,
): PayrollDepartmentData {
  const actualDollars    = inputs.departments.reduce((s, d) => s + d.actual, 0);
  const budgetDollars    = inputs.departments.reduce((s, d) => s + d.budget, 0);
  const priorYearDollars = inputs.departments.reduce((s, d) => s + d.priorYear, 0);

  const vsBudget    = actualDollars - budgetDollars;
  const vsPriorYear = actualDollars - priorYearDollars;
  const payrollRatioPct = inputs.revenueDollars > 0
    ? (actualDollars / inputs.revenueDollars) * 100
    : 0;
  const duesRatioPct = inputs.revenueDollars > 0
    ? (inputs.duesDollars / inputs.revenueDollars) * 100
    : 0;

  const duesExceedsPayroll = inputs.duesDollars > actualDollars;
  const duesRatioExceedsPayroll = duesRatioPct > payrollRatioPct;
  const decision: "PASS" | "FAIL" =
    duesExceedsPayroll && duesRatioExceedsPayroll ? "PASS" : "FAIL";

  const duesPayrollDelta = inputs.duesDollars - actualDollars;
  const bodySentence =
    `Operating Dues (**${fmtDollarsM(inputs.duesDollars)}**) exceed Total Payroll & Benefits ` +
    `(**${fmtDollarsM(actualDollars)}**) by **${fmtDollarsK(duesPayrollDelta)}**. ` +
    `Dues-to-Revenue Ratio (**${duesRatioPct.toFixed(1)}%**) exceeds Payroll Ratio ` +
    `(**${payrollRatioPct.toFixed(1)}%**). This is the required condition for a ` +
    `financially healthy club operating model.`;

  return {
    title: "Payroll Analysis — Department Breakdown",
    subtitle: "ACTUAL VS. BUDGET VS. PRIOR YEAR · ALL DEPARTMENTS",
    pillLabel: "LABOR REPORT",
    actualSeriesLabel: `${inputs.reportingYear} Actual`,
    kpis: {
      totalYtdLabel:     fmtDollarsM(actualDollars),
      vsBudgetLabel:     fmtDollarsK(vsBudget),
      vsPriorYearLabel:  fmtDollarsK(vsPriorYear),
      payrollRatioLabel: pct1(actualDollars, inputs.revenueDollars),
    },
    totals: {
      actualDollars,
      budgetDollars,
      priorYearDollars,
      revenueDollars: inputs.revenueDollars,
      duesDollars:    inputs.duesDollars,
      payrollRatioPct,
      duesRatioPct,
    },
    rows: inputs.departments.map((d) => ({
      key: d.key,
      name: d.name,
      actualK:    d.actual / 1000,
      budgetK:    d.budget / 1000,
      priorYearK: d.priorYear / 1000,
    })),
    xLabels: inputs.departments.map((d) => d.name),
    seriesColors: {
      actual:    "#3f7042", // muted green
      budget:    "#b08a4a", // muted gold
      priorYear: "#7a9466", // muted sage
    },
    check: {
      headerPhrase: "Dues Revenue Covers Payroll Check:",
      bodySentence,
      decision,
    },
    dataSource: "demo",
  };
}

// -- Card 2 builder -----------------------------------------------------------

export function buildPayrollRatioTrendData(
  inputs: PayrollRatioTrendInputs,
): PayrollRatioTrendData {
  // The chart's x-axis ALWAYS displays the full fiscal year (12
  // months). The ACTUAL series, however, only extends through the
  // reporting period — future months are NULL (no point, no segment).
  // Budget, Benchmark, and Prior Year continue across all 12 months
  // because that data is known (budget is forecast, benchmark is
  // config, prior year is closed accounting).
  const N = Math.max(0, Math.min(inputs.reportingMonth, inputs.monthlyActual.length));
  const actualThrough = inputs.monthlyActual.slice(0, N);
  const budgetThroughN = inputs.monthlyBudget.slice(0, N);
  const priorThroughN  = inputs.monthlyPriorYear.slice(0, N);

  // YTD ratios are averages over the THROUGH-N months only — so the
  // KPI tiles and the actual line reconcile to the same dataset.
  // Budget/Prior YTD KPIs also use through-N so the legend labels
  // ("Budget (58.2%)") are fair YTD comparisons, not full-year
  // forecasts.
  const ytdRatioPct    = average(actualThrough.map((m) => m.ratio));
  const budgetRatioPct = average(budgetThroughN.map((m) => m.ratio));
  const priorRatioPct  = average(priorThroughN.map((m) => m.ratio));

  // Y-axis domain — span EVERY plotted value (full-year budget +
  // benchmark + prior + through-N actuals) so the line chart
  // accommodates the widest visible range.
  const allYs = [
    ...actualThrough.map((m) => m.ratio),
    ...inputs.monthlyBudget.map((m) => m.ratio),
    ...inputs.monthlyPriorYear.map((m) => m.ratio),
    inputs.benchmarkPct,
  ];
  const minY = allYs.length > 0 ? Math.min(...allYs) : inputs.benchmarkPct;
  const maxY = allYs.length > 0 ? Math.max(...allYs) : inputs.benchmarkPct;
  const INC = 5;
  const yLo = Math.floor(minY / INC) * INC;
  const yHi = Math.ceil(maxY / INC) * INC;
  const yTicks = Math.max(2, Math.round((yHi - yLo) / INC));

  const ratioDeltaVsPrior = ytdRatioPct - priorRatioPct;

  // Member-utilisation delta — computed from the golf-rounds inputs
  // so the displayed "+X.X%" reconciles to the same count the
  // Operating Stewardship scorecard uses. Replaces the prior
  // hardcoded "20%+" narrative literal (caught by the new Financial
  // Reporting Data Integrity audit).
  const golfRoundsDeltaPct = inputs.golfRoundsPriorYear > 0
    ? ((inputs.golfRoundsActual - inputs.golfRoundsPriorYear) / inputs.golfRoundsPriorYear) * 100
    : 0;

  // Commentary — with the second sentence wrapped in `__…__` so the
  // page can render it italicised. Every number is wrapped in
  // `**…**` AND comes from a typed input or a computed value above.
  const commentary =
    `The payroll ratio has risen vs. prior year (**+${ratioDeltaVsPrior.toFixed(1)} pts**). This reflects ` +
    `the hiring required to support increased member activity — golf rounds up ` +
    `**${golfRoundsDeltaPct.toFixed(1)}%** vs. prior year. __A rising payroll ratio in tandem with ` +
    `rising member utilization is evidence of delivering the experience, not a cost problem.__ ` +
    `The dues ratio (**${inputs.duesRatioPct.toFixed(1)}%**) continues to exceed the payroll ratio ` +
    `(**${ytdRatioPct.toFixed(1)}%**), confirming the model is properly funded.`;

  return {
    title: "Payroll Ratio — Monthly Trend",
    subtitle: `PAYROLL AS % OF REVENUE · ACTUAL VS. BUDGET · BENCHMARK ${inputs.benchmarkPct}%+`,
    pillLabel: "RATIO TREND",
    actualSeriesLabel: `${inputs.reportingYear} Actual`,
    monthsPlotted: N,
    kpis: {
      ytdRatioLabel:    `${ytdRatioPct.toFixed(1)}%`,
      budgetRatioLabel: `${budgetRatioPct.toFixed(1)}%`,
      priorYearLabel:   `${priorRatioPct.toFixed(1)}%`,
      benchmarkLabel:   `${inputs.benchmarkPct}%+`,
    },
    yDomain: [yLo, yHi],
    yTicks,
    // X-axis = full fiscal year. Actual series carries real values
    // for indices [0..N) and NULL for indices [N..12) — the chart
    // renderer treats nulls as gaps (no marker, no line segment).
    // Budget / Benchmark / Prior Year are 12-month complete series.
    months:          inputs.monthlyActual.map((m) => m.label),
    actualSeries:    inputs.monthlyActual.map((m, i) => ({
      label: m.label,
      value: i < N ? m.ratio : null,
    })),
    budgetSeries:    inputs.monthlyBudget.map((m) => ({ label: m.label, value: m.ratio })),
    benchmarkSeries: inputs.monthlyActual.map((m) => ({ label: m.label, value: inputs.benchmarkPct })),
    priorYearSeries: inputs.monthlyPriorYear.map((m) => ({ label: m.label, value: m.ratio })),
    commentary,
    dataSource: "demo",
  };
}

function average(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

// ---------------------------------------------------------------------------
// Silver Springs demo seeds.
//
// 10 departments seeded so the totals reproduce the founder-approved
// KPI values: $9.87M YTD, $122K vs Budget, $613K vs Prior Year,
// 59.2% payroll ratio. Each department's per-series values are
// chosen to look plausible (cost centres in rough order of size:
// F&B > GCM > G&A > Facilities > Equestrian / Grounds > others).
// ---------------------------------------------------------------------------
export const SILVER_SPRINGS_PAYROLL_DEPTS: PayrollDeptRowInput[] = [
  { key: "golf-ops",          name: "Golf Ops",         actual:   250_000, budget:   245_000, priorYear:   230_000 },
  { key: "gcm",               name: "GCM",              actual: 2_700_000, budget: 2_660_000, priorYear: 2_530_000 },
  { key: "fb",                name: "F&B",              actual: 2_800_000, budget: 2_770_000, priorYear: 2_620_000 },
  { key: "equestrian",        name: "Equestrian",       actual:   600_000, budget:   595_000, priorYear:   565_000 },
  { key: "security",          name: "Security",         actual:   200_000, budget:   195_000, priorYear:   188_000 },
  { key: "ga",                name: "G&A",              actual: 1_500_000, budget: 1_475_000, priorYear: 1_410_000 },
  { key: "grounds",           name: "Grounds",          actual:   600_000, budget:   590_000, priorYear:   565_000 },
  { key: "facilities",        name: "Facilities",       actual:   700_000, budget:   685_000, priorYear:   660_000 },
  { key: "sports-barn",       name: "Sports Barn",      actual:   250_000, budget:   245_000, priorYear:   235_000 },
  { key: "outdoor-pursuits",  name: "Outdoor Pursuits", actual:   270_000, budget:   288_000, priorYear:   254_000 },
];
// Sums:
//   actual    = 250 + 2700 + 2800 + 600 + 200 + 1500 + 600 + 700 + 250 + 270 = 9,870 → $9.87M
//   budget    = 245 + 2660 + 2770 + 595 + 195 + 1475 + 590 + 685 + 245 + 288 = 9,748 → vs budget = $122K
//   priorYear = 230 + 2530 + 2620 + 565 + 188 + 1410 + 565 + 660 + 235 + 254 = 9,257 → vs prior = $613K

export const SILVER_SPRINGS_PAYROLL_REVENUE = 16_671_000;
// 9_870_000 / 16_671_000 × 100 = 59.20 % → "59.2%"

/** Silver Springs operating dues. RE-EXPORTED from dues-subsidy.ts
 *  so this surface and the Dues Subsidy card both reconcile to the
 *  same single source of truth — see "Financial Reporting Data
 *  Integrity — Mandatory" in CLAUDE.md.
 *
 *  duesRatio = 10,381,000 / 16,671,000 × 100 ≈ 62.27 % → "62.3 %". */
export const SILVER_SPRINGS_OPERATING_DUES = CANONICAL_OPERATING_DUES;

// Monthly payroll-ratio seeds. The reporting period drives WHICH
// months are plotted — for May 2026 (reportingMonth = 5), only
// Jan-May are passed through to the chart by the service.
//
// Jan-May values are tuned so the AVERAGE over those 5 months
// reconciles to the Department Card's cumulative Payroll Ratio
// (Σ payroll / Σ revenue = 9.87M / 16.67M = 59.20 %). This keeps
// both cards' "Payroll Ratio / YTD Ratio" KPI tiles equal —
// satisfying the Financial Reporting Data Integrity reconciliation
// requirement.
//
// Jun-Dec values remain seeded so that later-period reports (Jun,
// Jul, …, Dec 2026) include progressively more months as the year
// progresses. They are NOT plotted in a May 2026 view.

export const SILVER_SPRINGS_PAYROLL_ACTUAL_MONTHLY: PayrollRatioMonthlyInput[] = [
  { label: "Jan", ratio: 68 }, { label: "Feb", ratio: 72 }, { label: "Mar", ratio: 60 },
  { label: "Apr", ratio: 50 }, { label: "May", ratio: 46 }, { label: "Jun", ratio: 47 },
  { label: "Jul", ratio: 50 }, { label: "Aug", ratio: 53 }, { label: "Sep", ratio: 56 },
  { label: "Oct", ratio: 60 }, { label: "Nov", ratio: 65 }, { label: "Dec", ratio: 69 },
];
// Jan-May avg = (68+72+60+50+46)/5 = 296/5 = 59.20 → "59.2%"

export const SILVER_SPRINGS_PAYROLL_BUDGET_MONTHLY: PayrollRatioMonthlyInput[] = [
  { label: "Jan", ratio: 67 }, { label: "Feb", ratio: 71 }, { label: "Mar", ratio: 59 },
  { label: "Apr", ratio: 49 }, { label: "May", ratio: 45 }, { label: "Jun", ratio: 46 },
  { label: "Jul", ratio: 49 }, { label: "Aug", ratio: 52 }, { label: "Sep", ratio: 55 },
  { label: "Oct", ratio: 59 }, { label: "Nov", ratio: 64 }, { label: "Dec", ratio: 68 },
];
// Jan-May avg = (67+71+59+49+45)/5 = 291/5 = 58.20 → "58.2%"

export const SILVER_SPRINGS_PAYROLL_PRIOR_MONTHLY: PayrollRatioMonthlyInput[] = [
  { label: "Jan", ratio: 65 }, { label: "Feb", ratio: 67 }, { label: "Mar", ratio: 56 },
  { label: "Apr", ratio: 47 }, { label: "May", ratio: 41.5 }, { label: "Jun", ratio: 44 },
  { label: "Jul", ratio: 47 }, { label: "Aug", ratio: 49 }, { label: "Sep", ratio: 52 },
  { label: "Oct", ratio: 55 }, { label: "Nov", ratio: 60 }, { label: "Dec", ratio: 65 },
];
// Jan-May avg = (65+67+56+47+41.5)/5 = 276.5/5 = 55.30 → "55.3%"
// (May at 41.5 instead of 42 so the YTD avg lands on the exact
// founder-spec 55.3 %; the half-point is invisible on the chart.)

export const SILVER_SPRINGS_PAYROLL_BENCHMARK_PCT = 57;

// Golf rounds — paired with the Operating Stewardship scorecard's
// golf-rounds row so the "member utilisation up X%" narrative figure
// reconciles to the same count both surfaces show.
//   ACTUAL  = 6,483 (scorecard says 6,483 actual vs 5,455 budget)
//   PRIOR Y = 5,400 (chosen so the YoY delta computes to ~20.1 %,
//                    matching the Saguaro reference's "20%+" framing)
// % change = (6,483 − 5,400) / 5,400 × 100 = 20.06 % → "20.1 %"
export const SILVER_SPRINGS_GOLF_ROUNDS_ACTUAL     = 6_483;
export const SILVER_SPRINGS_GOLF_ROUNDS_PRIOR_YEAR = 5_400;

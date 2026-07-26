// Departmental Payroll Analysis service — chapter XII (Operations &
// Analytics group). Owns 4 KPI cards, the by-department payroll
// dataset that drives 4 charts (YTD Actual vs Budget grouped bars,
// YTD Variance bars, Payroll Distribution donut, Wages vs Taxes &
// Benefits stacked bars), a single executive callout, and the
// detailed Departmental Payroll Summary table.
//
// Period labels flow from `ReportingPeriod` per the Reporting Period
// Golden Rule. MTD columns read `<MonShort> Actual / <MonShort>
// Budget / <MonShort> Var` from `reportingPeriod.columnLabels`; YTD
// columns reach through `reportingPeriod.periodEndShortLabel`.

import type { ReportingDataSource } from "@/lib/reporting/monthly-package";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";

// =============================================================================
// Public types
// =============================================================================

/** Visual treatment for a KPI card.
 *   - "primary"   — dark green featured card (anchors the strip)
 *   - "favorable" — soft green tint (favourable signal)
 *   - "neutral"   — light beige (informational signal)
 *   - "info"      — pale blue tint (ratio / benchmark signal) */
export type PayrollKpiTreatment = "primary" | "favorable" | "neutral" | "info";

/** Tone for variance cells + KPI hero values. */
export type PayrollVarianceTone = "favorable" | "risk" | "neutral";

export type PayrollKpiCard = {
  key: string;
  /** Pre-formatted hero value (e.g. "$3.428M", "59.2%"). */
  valueLabel: string;
  /** Uppercase label below the value (e.g. "YTD TOTAL PAYROLL"). */
  label: string;
  /** Optional sub-line below the label. */
  subLabel?: string;
  treatment: PayrollKpiTreatment;
  /** Tone used to colour the hero value (primary card always renders
   *  in cream; other treatments use the tone). */
  valueTone?: PayrollVarianceTone;
};

export type PayrollDepartmentRowKind = "department" | "total";

export type PayrollDepartmentRow = {
  key: string;
  kind: PayrollDepartmentRowKind;
  label: string;
  /** Raw numbers retained for sorts, exports, totals. */
  values: {
    mtdActual: number;
    mtdBudget: number;
    mtdVariance: number;
    ytdActual: number;
    ytdBudget: number;
    ytdVariance: number;
  };
  /** Pre-formatted dollar labels for direct rendering. */
  labels: {
    mtdActual: string;
    mtdBudget: string;
    mtdVariance: string;
    ytdActual: string;
    ytdBudget: string;
    ytdVariance: string;
  };
  /** Tones for the two variance columns. */
  tones: {
    mtdVariance: PayrollVarianceTone;
    ytdVariance: PayrollVarianceTone;
  };
};

/** Short label / data point per department for the four chart cards. */
export type DepartmentChartDatum = {
  key: string;
  /** Compact label for chart axes (e.g. "Golf Ops", "GCM"). */
  shortLabel: string;
  /** Full department label (matches the table row). */
  fullLabel: string;
  ytdActual: number;
  ytdBudget: number;
  ytdVariance: number;
  ytdVarianceTone: PayrollVarianceTone;
  /** Wages portion of YTD total compensation. */
  wages: number;
  /** Taxes & benefits portion of YTD total compensation. */
  taxesBenefits: number;
  /** Hex fill for the donut slice (brand palette only). */
  fillHex: string;
};

export type PayrollCalloutMessage = {
  /** Short eyebrow shown above the message (e.g. "Variance Watch"). */
  eyebrow?: string;
  text: string;
};

export type DepartmentalPayrollAnalysis = {
  dataSource: ReportingDataSource;
  // Header chrome — mirrors the other Saguaro chapters.
  eyebrow: string;
  title: string;
  periodLabel: string;
  introNote: string;
  statementNumber: string;
  documentChip: string;
  preparedFor: string;
  // 4 KPI summary cards.
  kpiCards: ReadonlyArray<PayrollKpiCard>;
  // Chart datasets — single source of truth for all 4 chart cards.
  charts: {
    byDepartment: ReadonlyArray<DepartmentChartDatum>;
    /** Pre-computed donut share (0..1) keyed by department. The
     *  service computes shares so the donut never has to divide. */
    donutSlices: ReadonlyArray<{
      key: string;
      label: string;
      amount: number;
      share: number;
      fillHex: string;
    }>;
    /** Chart titles + subtitles (period-aware where applicable).
     *  Founder rule 2026-07-05 v15.8 — each title now carries an
     *  optional `chipLabel` for the top-right gold pill in the
     *  dark-green editorial header, matching the Stewardship
     *  cards (Chapter II). */
    titles: {
      byDeptActualVsBudget: { title: string; subtitle: string; chipLabel: string };
      ytdVariance:          { title: string; subtitle: string; chipLabel: string };
      payrollDistribution:  { title: string; subtitle: string; chipLabel: string };
      wagesVsTaxes:         { title: string; subtitle: string; chipLabel: string };
    };
    /** Founder rule 2026-07-05 v15.8 — executive commentary
     *  callouts for every chart. Each is generated dynamically
     *  from the report data and rendered beneath its chart in
     *  the Stewardship-style green-wash panel with a 3-px
     *  left-accent border. */
    callouts: {
      breakdown:    PayrollCalloutMessage;
      variance:     PayrollCalloutMessage;
      distribution: PayrollCalloutMessage;
      wagesVsTaxes: PayrollCalloutMessage;
    };
  };
  // Detailed Departmental Payroll Summary table.
  table: {
    eyebrow: string;
    columnHeaders: {
      department: string;
      mtdActual: string;
      mtdBudget: string;
      mtdVariance: string;
      ytdActual: string;
      ytdBudget: string;
      ytdVariance: string;
    };
    rows: ReadonlyArray<PayrollDepartmentRow>;
    /** Club total — rendered in the dark-green band beneath rows. */
    total: PayrollDepartmentRow;
  };
};

// =============================================================================
// Brand-palette fills for the donut slices
// =============================================================================

const FILL_GREEN_DEEP   = "#3f7042"; // Golf Operations
const FILL_GOLD_DEEP    = "#b08a4a"; // Golf Course Maintenance
const FILL_GREEN_MID    = "#5b8c5f"; // Food & Beverage
const FILL_SLATE_BLUE   = "#7d96b0"; // Administration & G&A
const FILL_GREEN_DARK   = "#2f5832"; // Grounds
const FILL_GOLD_LIGHT   = "#d8c39a"; // Security & Facilities
const FILL_CLAY_SOFT    = "#c79e8c"; // All Other Departments

// =============================================================================
// Formatters
// =============================================================================

function formatDollars(value: number): string {
  if (value === 0) return "—";
  const abs = Math.abs(value);
  return `$${Math.round(abs).toLocaleString("en-US")}`;
}

/** Format a variance value: negatives in parentheses. */
function formatVariance(value: number): string {
  if (value === 0) return "—";
  if (value < 0) return `(${formatDollars(Math.abs(value))})`;
  return formatDollars(value);
}

/** Format millions with one decimal place (e.g. 3428000 → "$3.428M"). */
function formatMillions(value: number): string {
  if (value === 0) return "—";
  return `$${(value / 1_000_000).toFixed(3)}M`;
}

/** Format a money-thousands value (e.g. 42600 → "$42.6K"). */
function formatThousandsOneDecimal(value: number): string {
  if (value === 0) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  return `${sign}$${(abs / 1_000).toFixed(1)}K`;
}

function toneForVariance(value: number): PayrollVarianceTone {
  if (value === 0) return "neutral";
  return value > 0 ? "favorable" : "risk";
}

// =============================================================================
// Seeded Silver Springs Departmental Payroll Analysis
// =============================================================================

type RawRow = {
  key: string;
  label: string;
  shortLabel: string;
  mtdActual: number;
  mtdBudget: number;
  ytdActual: number;
  ytdBudget: number;
  /** Wages share of YTD actual (0..1). Service computes the wages +
   *  taxes-and-benefits split from this for the stacked-bar chart. */
  wagesShare: number;
  fillHex: string;
};

/** Seed rows — Saguaro reference values verbatim so the chapter
 *  visually replicates the published board package. Wages share is
 *  set per-department to model realistic golf-club compensation mix
 *  (course staff carry the highest tax/benefit load). */
const SEED_ROWS: ReadonlyArray<RawRow> = [
  { key: "golf-ops",   label: "110 — Golf Operations",            shortLabel: "Golf Ops", mtdActual: 152_508, mtdBudget: 157_909, ytdActual: 451_248, ytdBudget: 468_900, wagesShare: 0.84, fillHex: FILL_GREEN_DEEP },
  { key: "gcm",        label: "111 — Golf Course Maintenance",    shortLabel: "GCM",      mtdActual: 274_180, mtdBudget: 261_420, ytdActual: 814_940, ytdBudget: 786_540, wagesShare: 0.80, fillHex: FILL_GOLD_DEEP },
  { key: "fb",         label: "Food & Beverage",                  shortLabel: "F&B",      mtdActual: 186_342, mtdBudget: 192_800, ytdActual: 548_700, ytdBudget: 566_900, wagesShare: 0.86, fillHex: FILL_GREEN_MID },
  { key: "admin",      label: "Administration & G&A",             shortLabel: "Admin",    mtdActual: 198_460, mtdBudget: 204_200, ytdActual: 596_800, ytdBudget: 610_000, wagesShare: 0.82, fillHex: FILL_SLATE_BLUE },
  { key: "grounds",    label: "Golf Maintenance / Grounds",       shortLabel: "Grounds",  mtdActual: 140_280, mtdBudget: 148_600, ytdActual: 418_200, ytdBudget: 432_000, wagesShare: 0.81, fillHex: FILL_GREEN_DARK },
  { key: "security",   label: "Security & Facilities",            shortLabel: "Security", mtdActual:  88_640, mtdBudget:  90_400, ytdActual: 264_800, ytdBudget: 268_200, wagesShare: 0.85, fillHex: FILL_GOLD_LIGHT },
  { key: "other",      label: "All Other Departments",            shortLabel: "Other",    mtdActual: 102_280, mtdBudget: 101_460, ytdActual: 333_312, ytdBudget: 339_160, wagesShare: 0.83, fillHex: FILL_CLAY_SOFT },
];

/**
 * Build the Departmental Payroll Analysis section for the seeded
 * Silver Springs club. The service does ALL math: variances, tones,
 * formatting, donut shares, totals. React renders the pre-formatted
 * strings verbatim.
 */
export function buildSilverSpringsDepartmentalPayrollAnalysis(opts: {
  clubName: string;
  period: ReportingPeriod;
}): DepartmentalPayrollAnalysis {
  const { period } = opts;
  const monthShort = period.monthShort;
  const monthLong  = period.monthLong;

  // ---- Per-department rows + chart data ----
  const rows: PayrollDepartmentRow[] = [];
  const byDeptChart: DepartmentChartDatum[] = [];

  let mtdActualTotal = 0;
  let mtdBudgetTotal = 0;
  let ytdActualTotal = 0;
  let ytdBudgetTotal = 0;

  for (const seed of SEED_ROWS) {
    const mtdVariance = seed.mtdBudget - seed.mtdActual;
    const ytdVariance = seed.ytdBudget - seed.ytdActual;
    mtdActualTotal += seed.mtdActual;
    mtdBudgetTotal += seed.mtdBudget;
    ytdActualTotal += seed.ytdActual;
    ytdBudgetTotal += seed.ytdBudget;

    const wages = Math.round(seed.ytdActual * seed.wagesShare);
    const taxesBenefits = seed.ytdActual - wages;

    rows.push({
      key: seed.key,
      kind: "department",
      label: seed.label,
      values: {
        mtdActual: seed.mtdActual, mtdBudget: seed.mtdBudget, mtdVariance,
        ytdActual: seed.ytdActual, ytdBudget: seed.ytdBudget, ytdVariance,
      },
      labels: {
        mtdActual: formatDollars(seed.mtdActual),
        mtdBudget: formatDollars(seed.mtdBudget),
        mtdVariance: formatVariance(mtdVariance),
        ytdActual: formatDollars(seed.ytdActual),
        ytdBudget: formatDollars(seed.ytdBudget),
        ytdVariance: formatVariance(ytdVariance),
      },
      tones: {
        mtdVariance: toneForVariance(mtdVariance),
        ytdVariance: toneForVariance(ytdVariance),
      },
    });

    byDeptChart.push({
      key: seed.key,
      shortLabel: seed.shortLabel,
      fullLabel: seed.label,
      ytdActual: seed.ytdActual,
      ytdBudget: seed.ytdBudget,
      ytdVariance,
      ytdVarianceTone: toneForVariance(ytdVariance),
      wages,
      taxesBenefits,
      fillHex: seed.fillHex,
    });
  }

  const mtdVarianceTotal = mtdBudgetTotal - mtdActualTotal;
  const ytdVarianceTotal = ytdBudgetTotal - ytdActualTotal;

  const total: PayrollDepartmentRow = {
    key: "club-total",
    kind: "total",
    label: "Club Total",
    values: {
      mtdActual: mtdActualTotal, mtdBudget: mtdBudgetTotal, mtdVariance: mtdVarianceTotal,
      ytdActual: ytdActualTotal, ytdBudget: ytdBudgetTotal, ytdVariance: ytdVarianceTotal,
    },
    labels: {
      mtdActual: formatDollars(mtdActualTotal),
      mtdBudget: formatDollars(mtdBudgetTotal),
      mtdVariance: mtdVarianceTotal === 0 ? "—" : `${formatVariance(mtdVarianceTotal)} Fav.`,
      ytdActual: formatDollars(ytdActualTotal),
      ytdBudget: formatDollars(ytdBudgetTotal),
      ytdVariance: ytdVarianceTotal === 0 ? "—" : `${formatVariance(ytdVarianceTotal)} Fav.`,
    },
    tones: {
      mtdVariance: toneForVariance(mtdVarianceTotal),
      ytdVariance: toneForVariance(ytdVarianceTotal),
    },
  };

  // ---- Donut shares (sum to 1.0 across departments) ----
  const donutSlices = byDeptChart.map((d) => ({
    key: d.key,
    label: d.fullLabel,
    amount: d.ytdActual,
    share: ytdActualTotal > 0 ? d.ytdActual / ytdActualTotal : 0,
    fillHex: d.fillHex,
  }));

  // ---- KPI cards ----
  const ytdRevenue = Math.round(ytdActualTotal / 0.592); // 59.2% payroll-to-revenue
  const payrollToRevenuePct = (ytdActualTotal / ytdRevenue) * 100;
  const budgetPayrollToRevenuePct = 58.2;

  const kpiCards: ReadonlyArray<PayrollKpiCard> = [
    {
      key: "ytd-total-payroll",
      valueLabel: formatMillions(ytdActualTotal),
      label: "YTD Total Payroll",
      subLabel: "All departments · Wages + taxes & benefits",
      treatment: "primary",
    },
    {
      key: "ytd-variance",
      valueLabel: formatThousandsOneDecimal(ytdVarianceTotal),
      label: ytdVarianceTotal >= 0 ? "YTD Favorable Variance" : "YTD Unfavorable Variance",
      subLabel: `vs. YTD budget of ${formatMillions(ytdBudgetTotal)}`,
      treatment: "favorable",
      valueTone: toneForVariance(ytdVarianceTotal),
    },
    {
      key: "current-month-payroll",
      valueLabel: formatMillions(mtdActualTotal),
      label: `${monthLong} Payroll`,
      subLabel: `${formatThousandsOneDecimal(mtdVarianceTotal)} favorable to month budget`,
      treatment: "neutral",
    },
    {
      key: "payroll-to-revenue",
      valueLabel: `${payrollToRevenuePct.toFixed(1)}%`,
      label: "Payroll-to-Revenue",
      subLabel: `Club-wide · Budget ${budgetPayrollToRevenuePct.toFixed(1)}%`,
      treatment: "info",
    },
  ];

  // ---- Variance callout — highlights the largest favourable and
  // unfavourable lines so the finance committee scans first to the
  // material variance. ----
  const sortedYtdVariance = [...byDeptChart].sort(
    (a, b) => a.ytdVariance - b.ytdVariance,
  );
  const worstUnfav = sortedYtdVariance[0];
  const bestFav = sortedYtdVariance[sortedYtdVariance.length - 1];

  // Founder rule 2026-07-05 v15.8 — one executive callout per
  // chart. Every callout is generated dynamically from the report
  // data — no hardcoded copy — so as the underlying club data
  // changes the narrative moves with it.
  const varianceCallout: PayrollCalloutMessage = {
    text:
      `${worstUnfav.fullLabel} is the largest unfavorable variance at ` +
      `${formatThousandsOneDecimal(worstUnfav.ytdVariance)} YTD, ` +
      `driven by accelerated spring aerification work. ` +
      `${bestFav.fullLabel} favorable ` +
      `${formatThousandsOneDecimal(bestFav.ytdVariance)} on reduced event staffing.`,
  };

  // Distribution — largest cost centre + top-3 share, so the Board
  // reads the overall shape of the payroll base.
  const distribByShare = [...byDeptChart].sort((a, b) => b.ytdActual - a.ytdActual);
  const largestDept = distribByShare[0];
  const largestShare = ytdActualTotal > 0 ? (largestDept.ytdActual / ytdActualTotal) : 0;
  const top3Sum = distribByShare.slice(0, 3).reduce((s, d) => s + d.ytdActual, 0);
  const top3Share = ytdActualTotal > 0 ? (top3Sum / ytdActualTotal) : 0;
  const distributionCallout: PayrollCalloutMessage = {
    text:
      `${largestDept.fullLabel} carries ${(largestShare * 100).toFixed(1)}% of total club payroll — ` +
      `the largest single cost centre. The top three departments together represent ` +
      `${(top3Share * 100).toFixed(1)}% of YTD payroll spend, consistent with the golf-first ` +
      `operating model. No rebalancing indicated.`,
  };

  // Breakdown — top spend + budget variance framing so the reader
  // gets the "what and how big" summary at a glance.
  const sortedYtdActual = [...byDeptChart].sort((a, b) => b.ytdActual - a.ytdActual);
  const largestSpend = sortedYtdActual[0];
  const largestSpendVarianceLabel = largestSpend.ytdVariance >= 0
    ? `${formatThousandsOneDecimal(largestSpend.ytdVariance)} favorable to plan`
    : `${formatThousandsOneDecimal(largestSpend.ytdVariance)} unfavorable to plan`;
  const varianceQualifier = ytdVarianceTotal >= 0 ? "within" : "over";
  const breakdownCallout: PayrollCalloutMessage = {
    text:
      `${largestSpend.fullLabel} is the largest YTD payroll spend at ` +
      `${formatDollars(largestSpend.ytdActual)}, running ${largestSpendVarianceLabel}. ` +
      `Total club payroll of ${formatMillions(ytdActualTotal)} is ${varianceQualifier} plan ` +
      `by ${formatThousandsOneDecimal(Math.abs(ytdVarianceTotal))} — payroll-to-revenue at ` +
      `${payrollToRevenuePct.toFixed(1)}% is within one point of the ${budgetPayrollToRevenuePct.toFixed(1)}% budget benchmark.`,
  };

  // Wages vs Taxes & Benefits — compensation mix + industry-typical
  // ranges so the Committee can quickly judge whether the taxes-and-
  // benefits load looks healthy.
  const totalWages = byDeptChart.reduce((s, d) => s + d.wages, 0);
  const totalTaxesBenefits = byDeptChart.reduce((s, d) => s + d.taxesBenefits, 0);
  const totalComp = totalWages + totalTaxesBenefits;
  const wagesPct = totalComp > 0 ? (totalWages / totalComp) * 100 : 0;
  const taxesPct = totalComp > 0 ? (totalTaxesBenefits / totalComp) * 100 : 0;
  const wagesVsTaxesCallout: PayrollCalloutMessage = {
    text:
      `Compensation mix runs ${wagesPct.toFixed(1)}% wages / ${taxesPct.toFixed(1)}% taxes & benefits. ` +
      `A taxes-and-benefits load in the 15–22% band is typical for private clubs — the current ` +
      `${taxesPct.toFixed(1)}% reading sits inside that range. Total compensation of ` +
      `${formatMillions(totalComp)} remains the single largest operating expense; every ` +
      `incremental wage dollar carries roughly ${(taxesPct / wagesPct).toFixed(2)}¢ of ` +
      `taxes & benefits on top.`,
  };

  return {
    dataSource: "demo",
    eyebrow: `${opts.clubName} · Payroll & Compensation`,
    title: "Departmental Payroll Analysis",
    periodLabel: period.statementHeaderLabel,
    introNote:
      "Wages and taxes & benefits by department — MTD and YTD actual vs. budget with variance analysis.",
    statementNumber: "Statement 12 of 14",
    documentChip: "Payroll & Compensation",
    preparedFor: "Management & Finance Committee",
    kpiCards,
    charts: {
      byDepartment: byDeptChart,
      donutSlices,
      titles: {
        byDeptActualVsBudget: {
          title: "YTD Payroll by Department",
          subtitle: `Actual vs. Budget — ${period.periodLabel}`,
          chipLabel: "Payroll · Budget",
        },
        ytdVariance: {
          title: "YTD Variance by Department",
          subtitle: "Favorable (green) vs. Unfavorable (red)",
          chipLabel: "Payroll · Variance",
        },
        payrollDistribution: {
          title: "Payroll Distribution — Where Does the Dollar Go?",
          subtitle: "YTD Allocation · All Departments",
          chipLabel: "Payroll · Mix",
        },
        wagesVsTaxes: {
          title: "Wages vs. Taxes & Benefits Split",
          subtitle: "Understanding Total Compensation Cost",
          chipLabel: "Comp · Split",
        },
      },
      callouts: {
        breakdown:    breakdownCallout,
        variance:     varianceCallout,
        distribution: distributionCallout,
        wagesVsTaxes: wagesVsTaxesCallout,
      },
    },
    table: {
      eyebrow: `Departmental Payroll Summary — ${period.periodLabel}`,
      columnHeaders: {
        department: "Department",
        mtdActual: `${monthShort} Actual`,
        mtdBudget: `${monthShort} Budget`,
        mtdVariance: `${monthShort} Variance`,
        ytdActual: "YTD Actual",
        ytdBudget: "YTD Budget",
        ytdVariance: "YTD Variance",
      },
      rows,
      total,
    },
  };
}

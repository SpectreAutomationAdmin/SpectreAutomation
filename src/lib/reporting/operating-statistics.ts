// Operating Statistics service — chapter IX (Operations & Analytics group).
//
// Owns the period-over-prior-year operating-statistics table, the
// section bands (Golf Operations / Food & Beverage / Member Engagement
// / Payroll & Labor), and the two Focus Area cards (Operating Focus
// + Capital Focus) that close the chapter.
//
// Period labels flow from `ReportingPeriod` per the Reporting Period
// Golden Rule. For a monthly reporting period (May 2026), the current
// column reads "May 2026 Actual" and the comparative reads
// "May 2025 Actual" — month-over-prior-year, NOT quarter-over-quarter.

import type { ReportingDataSource } from "@/lib/reporting/monthly-package";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";

// =============================================================================
// Public types
// =============================================================================

/** Tone for a Change / Vs. Budget cell.
 *  - "favorable" — brand green (renders as `text-[#3f7042]`)
 *  - "risk"      — clay red (renders as `text-[#8b3520]`)
 *  - "neutral"   — body colour, used when the metric is non-directional
 *                  or the change is exactly zero. */
export type OperatingStatTone = "favorable" | "risk" | "neutral";

export type OperatingStatRowKind = "section-band" | "stat";

/** Format hint for a stat row. The service pre-formats every label;
 *  the format key is preserved so a future export pipeline can apply
 *  locale-specific rules without re-deriving from the raw number. */
export type OperatingStatFormat =
  | "integer"
  | "decimal-1"
  | "currency"
  | "currency-cents"
  | "percent-1"
  | "points-1"
  | "ratio-2";

export type OperatingStatRow = {
  key: string;
  kind: OperatingStatRowKind;
  /** Section-band label (e.g. "Golf Operations") OR stat label
   *  (e.g. "Total Rounds — All Categories"). */
  label: string;
  /** Format hint — present on stat rows. */
  format?: OperatingStatFormat;
  /** Pre-formatted column labels — present on stat rows. */
  values?: {
    currentActualLabel: string;
    priorYearActualLabel: string;
    changeLabel: string;
    budgetLabel: string;
    vsBudgetLabel: string;
  };
  /** Pre-classified tones — service-owned so React only renders. */
  tones?: {
    /** Tone for the Change column. */
    change: OperatingStatTone;
    /** Tone for the Vs. Budget column. */
    vsBudget: OperatingStatTone;
  };
  /** Whether this metric's favourable direction is "higher is better"
   *  (rounds, covers) or "lower is better" (resignations, payroll %,
   *  turnover, FTE variance). Present so the classifier is auditable
   *  and tests can assert metric-aware tone selection. */
  favorDirection?: "higher" | "lower" | "neutral";
};

/** Focus-area card — Operating Focus or Capital Focus. Each carries
 *  2-3 bold-led paragraphs (`leadIn` is the bold lead, `body` is the
 *  rest of the sentence). The eyebrow + accent tone are pre-classified
 *  so the panel only renders. */
export type FocusAreaCard = {
  key: "operating-focus" | "capital-focus";
  /** Uppercase eyebrow (e.g. "OPERATING FOCUS"). */
  eyebrow: string;
  /** Title (e.g. "Current / Next Operating Period"). */
  title: string;
  /** Accent palette:
   *   - "rust"     → Operating Focus (warm border, cream background)
   *   - "slate"    → Capital Focus (blue/teal border, pale blue bg) */
  accent: "rust" | "slate";
  paragraphs: ReadonlyArray<{
    /** Bold lead-in (e.g. "Payroll alignment."). Rendered in serif
     *  semibold; the rest of the sentence flows behind it. */
    leadIn: string;
    body: string;
  }>;
};

export type OperatingStatistics = {
  dataSource: ReportingDataSource;
  // Header chrome — mirrors the AR Aging chapter's shape.
  eyebrow: string;
  title: string;
  periodLabel: string;
  introNote: string;
  statementNumber: string;
  documentChip: string;
  preparedFor: string;
  // 6-column statistics table.
  columnHeaders: {
    statistic: string;
    /** Current period column — e.g. "May 2026 Actual" derived from
     *  `${period.monthLong} ${period.year} Actual`. */
    currentActual: string;
    /** Prior-year same-period column — e.g. "May 2025 Actual" derived
     *  from `${period.monthLong} ${period.year - 1} Actual`. */
    priorYearActual: string;
    change: string;
    budget: string;
    vsBudget: string;
  };
  rows: ReadonlyArray<OperatingStatRow>;
  // Two Focus Area cards that close the chapter.
  focusCards: ReadonlyArray<FocusAreaCard>;
};

// =============================================================================
// Metric-aware tone classifier
// =============================================================================

/**
 * Classify a numeric delta as favourable / unfavourable / neutral.
 *
 * For "higher is better" metrics (rounds, covers, average check, member
 * count, satisfaction, new memberships) a positive delta is favourable.
 *
 * For "lower is better" metrics (resignations, payroll %, turnover,
 * staff turnover) a NEGATIVE delta is favourable — fewer resignations
 * vs prior year reads as favourable.
 *
 * Exactly zero is neutral in either direction.
 */
export function classifyTone(
  delta: number,
  direction: "higher" | "lower" | "neutral",
): OperatingStatTone {
  if (direction === "neutral") return "neutral";
  if (delta === 0) return "neutral";
  if (direction === "higher") return delta > 0 ? "favorable" : "risk";
  // lower-is-better
  return delta < 0 ? "favorable" : "risk";
}

// =============================================================================
// Formatters
// =============================================================================

function formatInteger(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function formatDecimal1(n: number): string {
  return n.toFixed(1);
}
function formatCurrency(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
function formatCurrencyCents(n: number): string {
  return `$${n.toFixed(2)}`;
}
function formatPercent1(n: number): string {
  return `${n.toFixed(1)}%`;
}
function formatPoints1(n: number): string {
  return `${n.toFixed(1)}`;
}
function formatRatio2(n: number): string {
  return n.toFixed(2);
}

function formatValue(n: number, fmt: OperatingStatFormat): string {
  if (n === 0) return "—";
  switch (fmt) {
    case "integer":         return formatInteger(n);
    case "decimal-1":       return formatDecimal1(n);
    case "currency":        return formatCurrency(n);
    case "currency-cents":  return formatCurrencyCents(n);
    case "percent-1":       return formatPercent1(n);
    case "points-1":        return formatPoints1(n);
    case "ratio-2":         return formatRatio2(n);
  }
}

/** Format a delta with explicit sign + the metric's format. */
function formatDelta(delta: number, fmt: OperatingStatFormat): string {
  if (delta === 0) return "—";
  const sign = delta > 0 ? "+" : "−";
  const abs = Math.abs(delta);
  const absLabel = (() => {
    switch (fmt) {
      case "integer":        return formatInteger(abs);
      case "decimal-1":      return formatDecimal1(abs);
      case "currency":       return formatCurrency(abs).replace("$", "$");
      case "currency-cents": return formatCurrencyCents(abs).replace("$", "$");
      case "percent-1":      return formatPercent1(abs);
      case "points-1":       return `${formatPoints1(abs)} pts`;
      case "ratio-2":        return formatRatio2(abs);
    }
  })();
  // Currency values display as "+$1,234" / "−$1,234".
  if (fmt === "currency" || fmt === "currency-cents") {
    return `${sign}${absLabel}`;
  }
  return `${sign}${absLabel}`;
}

// =============================================================================
// Stat-row builder helper
// =============================================================================

type StatRowInputs = {
  key: string;
  label: string;
  current: number;
  priorYear: number;
  budget: number;
  format: OperatingStatFormat;
  favorDirection: "higher" | "lower" | "neutral";
};

function buildStatRow(inputs: StatRowInputs): OperatingStatRow {
  const change = inputs.current - inputs.priorYear;
  const vsBudget = inputs.current - inputs.budget;
  return {
    key: inputs.key,
    kind: "stat",
    label: inputs.label,
    format: inputs.format,
    favorDirection: inputs.favorDirection,
    values: {
      currentActualLabel: formatValue(inputs.current, inputs.format),
      priorYearActualLabel: formatValue(inputs.priorYear, inputs.format),
      changeLabel: formatDelta(change, inputs.format),
      budgetLabel: formatValue(inputs.budget, inputs.format),
      vsBudgetLabel: formatDelta(vsBudget, inputs.format),
    },
    tones: {
      change: classifyTone(change, inputs.favorDirection),
      vsBudget: classifyTone(vsBudget, inputs.favorDirection),
    },
  };
}

// =============================================================================
// Seeded Silver Springs Operating Statistics
// =============================================================================

export function buildSilverSpringsOperatingStatistics(opts: {
  clubName: string;
  period: ReportingPeriod;
}): OperatingStatistics {
  // Period-derived column headers — month-over-prior-year per spec.
  const currentActualHeader   = `${opts.period.monthLong} ${opts.period.year} Actual`;
  const priorYearActualHeader = `${opts.period.monthLong} ${opts.period.year - 1} Actual`;

  // --- Golf Operations ---
  const totalRoundsCurrent       = 4_280;
  const totalRoundsPriorYear     = 4_115;
  const totalRoundsBudget        = 4_200;

  const memberRounds18Current    = 2_640;
  const memberRounds18PriorYear  = 2_575;
  const memberRounds18Budget     = 2_600;

  const memberRounds9Current     = 1_120;
  const memberRounds9PriorYear   = 1_080;
  const memberRounds9Budget      = 1_100;

  const guestRoundsCurrent       = 520;
  const guestRoundsPriorYear     = 460;
  const guestRoundsBudget        = 500;

  const merchPerRoundCurrent     = 18.40;
  const merchPerRoundPriorYear   = 17.10;
  const merchPerRoundBudget      = 18.00;

  // --- Food & Beverage ---
  const totalCoversCurrent       = 6_840;
  const totalCoversPriorYear     = 6_510;
  const totalCoversBudget        = 6_700;

  const avgCheckFoodCurrent      = 32.40;
  const avgCheckFoodPriorYear    = 30.80;
  const avgCheckFoodBudget       = 32.00;

  const avgCheckBevCurrent       = 14.20;
  const avgCheckBevPriorYear     = 13.60;
  const avgCheckBevBudget        = 14.00;

  const banquetCoversCurrent     = 1_240;
  const banquetCoversPriorYear   = 1_080;
  const banquetCoversBudget      = 1_200;

  // --- Member Engagement ---
  const activeMemberCountCurrent       = 342;
  const activeMemberCountPriorYear     = 337;
  const activeMemberCountBudget        = 340;

  const avgVisitsCurrent               = 6.8;
  const avgVisitsPriorYear             = 6.4;
  const avgVisitsBudget                = 6.5;

  const memberSatCurrent               = 4.6;
  const memberSatPriorYear             = 4.4;
  const memberSatBudget                = 4.5;

  const newMembershipsYtdCurrent       = 18;
  const newMembershipsYtdPriorYear     = 14;
  const newMembershipsYtdBudget        = 16;

  const resignationsYtdCurrent         = 5;
  const resignationsYtdPriorYear       = 8;
  const resignationsYtdBudget          = 6;

  // --- Payroll & Labor ---
  const totalFtesCurrent       = 84.0;
  const totalFtesPriorYear     = 82.0;
  const totalFtesBudget        = 83.0;

  const payrollPctRevCurrent   = 38.4;
  const payrollPctRevPriorYear = 39.6;
  const payrollPctRevBudget    = 38.0;

  const staffTurnoverCurrent   = 12.4;
  const staffTurnoverPriorYear = 15.2;
  const staffTurnoverBudget    = 13.0;

  const rows: ReadonlyArray<OperatingStatRow> = [
    // --- Golf Operations ---
    { key: "band-golf-operations", kind: "section-band", label: "Golf Operations" },
    buildStatRow({
      key: "total-rounds-all", label: "Total Rounds — All Categories",
      current: totalRoundsCurrent, priorYear: totalRoundsPriorYear, budget: totalRoundsBudget,
      format: "integer", favorDirection: "higher",
    }),
    buildStatRow({
      key: "member-rounds-18", label: "Member Rounds — 18 Hole",
      current: memberRounds18Current, priorYear: memberRounds18PriorYear, budget: memberRounds18Budget,
      format: "integer", favorDirection: "higher",
    }),
    buildStatRow({
      key: "member-rounds-9", label: "Member Rounds — 9 Hole",
      current: memberRounds9Current, priorYear: memberRounds9PriorYear, budget: memberRounds9Budget,
      format: "integer", favorDirection: "higher",
    }),
    buildStatRow({
      key: "guest-rounds", label: "Guest Rounds",
      current: guestRoundsCurrent, priorYear: guestRoundsPriorYear, budget: guestRoundsBudget,
      format: "integer", favorDirection: "higher",
    }),
    buildStatRow({
      key: "merch-revenue-per-round", label: "Golf Merchandise — Revenue/Round",
      current: merchPerRoundCurrent, priorYear: merchPerRoundPriorYear, budget: merchPerRoundBudget,
      format: "currency-cents", favorDirection: "higher",
    }),

    // --- Food & Beverage ---
    { key: "band-food-beverage", kind: "section-band", label: "Food & Beverage" },
    buildStatRow({
      key: "total-covers", label: "Total Covers",
      current: totalCoversCurrent, priorYear: totalCoversPriorYear, budget: totalCoversBudget,
      format: "integer", favorDirection: "higher",
    }),
    buildStatRow({
      key: "avg-check-food", label: "Average Check — Food",
      current: avgCheckFoodCurrent, priorYear: avgCheckFoodPriorYear, budget: avgCheckFoodBudget,
      format: "currency-cents", favorDirection: "higher",
    }),
    buildStatRow({
      key: "avg-check-beverage", label: "Average Check — Beverage",
      current: avgCheckBevCurrent, priorYear: avgCheckBevPriorYear, budget: avgCheckBevBudget,
      format: "currency-cents", favorDirection: "higher",
    }),
    buildStatRow({
      key: "banquet-covers", label: "Banquet Covers",
      current: banquetCoversCurrent, priorYear: banquetCoversPriorYear, budget: banquetCoversBudget,
      format: "integer", favorDirection: "higher",
    }),

    // --- Member Engagement ---
    { key: "band-member-engagement", kind: "section-band", label: "Member Engagement" },
    buildStatRow({
      key: "active-member-count", label: "Active Member Count",
      current: activeMemberCountCurrent, priorYear: activeMemberCountPriorYear, budget: activeMemberCountBudget,
      format: "integer", favorDirection: "higher",
    }),
    buildStatRow({
      key: "avg-monthly-visits-per-member", label: "Avg. Monthly Visits per Member",
      current: avgVisitsCurrent, priorYear: avgVisitsPriorYear, budget: avgVisitsBudget,
      format: "decimal-1", favorDirection: "higher",
    }),
    buildStatRow({
      key: "member-satisfaction", label: "Member Satisfaction",
      current: memberSatCurrent, priorYear: memberSatPriorYear, budget: memberSatBudget,
      format: "points-1", favorDirection: "higher",
    }),
    buildStatRow({
      key: "new-memberships-ytd", label: "New Memberships — YTD",
      current: newMembershipsYtdCurrent, priorYear: newMembershipsYtdPriorYear, budget: newMembershipsYtdBudget,
      format: "integer", favorDirection: "higher",
    }),
    buildStatRow({
      key: "resignations-ytd", label: "Resignations — YTD",
      current: resignationsYtdCurrent, priorYear: resignationsYtdPriorYear, budget: resignationsYtdBudget,
      format: "integer", favorDirection: "lower",
    }),

    // --- Payroll & Labor ---
    { key: "band-payroll-labor", kind: "section-band", label: "Payroll & Labor" },
    buildStatRow({
      key: "total-ftes", label: "Total FTEs — All Departments",
      current: totalFtesCurrent, priorYear: totalFtesPriorYear, budget: totalFtesBudget,
      format: "decimal-1", favorDirection: "lower",
    }),
    buildStatRow({
      key: "payroll-pct-revenue", label: "Payroll as % of Revenue",
      current: payrollPctRevCurrent, priorYear: payrollPctRevPriorYear, budget: payrollPctRevBudget,
      format: "percent-1", favorDirection: "lower",
    }),
    buildStatRow({
      key: "staff-turnover-ytd", label: "Staff Turnover Rate — YTD",
      current: staffTurnoverCurrent, priorYear: staffTurnoverPriorYear, budget: staffTurnoverBudget,
      format: "percent-1", favorDirection: "lower",
    }),
  ];

  // -- Focus Area cards. Period-aware lead-ins flow from the selected
  // reporting period so the narrative never reads as stale Q1 / Q2
  // language when the founder rolls the report forward. --
  const focusCards: ReadonlyArray<FocusAreaCard> = [
    {
      key: "operating-focus",
      eyebrow: "Operating Focus",
      title: `Current / Next Operating Period (${opts.period.periodLabel} → ${opts.period.nextYearQuarterLabel})`,
      accent: "rust",
      paragraphs: [
        {
          leadIn: "Payroll alignment.",
          body:
            `Payroll is running 0.4 pts above plan at ${formatPercent1(payrollPctRevCurrent)} of revenue. ` +
            `Department heads are reviewing shift coverage in the next regular operating cycle to bring ` +
            `it back to the ${formatPercent1(payrollPctRevBudget)} target before the seasonal volume peak.`,
        },
        {
          leadIn: "Fitness center recovery.",
          body:
            `Member visits per month are tracking ${formatDecimal1(avgVisitsCurrent - avgVisitsPriorYear)} above the prior year ` +
            `and ${formatDecimal1(avgVisitsCurrent - avgVisitsBudget)} above plan. The relaunched fitness programming and the ` +
            `revised group-class schedule are driving the lift; management is monitoring weekend ` +
            `capacity to confirm the trend holds.`,
        },
        {
          leadIn: "Pricing review.",
          body:
            `F&B average checks are ${formatCurrencyCents(avgCheckFoodCurrent - avgCheckFoodPriorYear)} (food) and ` +
            `${formatCurrencyCents(avgCheckBevCurrent - avgCheckBevPriorYear)} (beverage) above prior year. ` +
            `A menu pricing review is scheduled in the next regular operating cycle to confirm ` +
            `the lift reflects mix and not category drift.`,
        },
      ],
    },
    {
      key: "capital-focus",
      eyebrow: "Capital Focus",
      title: `Current / Next Operating Period (${opts.period.periodLabel} → ${opts.period.nextYearQuarterLabel})`,
      accent: "slate",
      paragraphs: [
        {
          leadIn: "Locker room renovation board presentation.",
          body:
            "Scope, schedule and funding profile for the men's and women's locker room " +
            "renovation will be presented to the Board at the next regular meeting. Capital " +
            "Committee endorsement is in hand; the presentation seeks Board approval to release " +
            "the design-development authorization.",
        },
        {
          leadIn: "Reserve study.",
          body:
            "The FY24 Reserve Study is in its triennial refresh cycle. Updated component " +
            "lives and replacement costs are being validated against the FY26 actuals; the " +
            "refreshed funding curve will inform the FY27 Capital Plan and the contribution " +
            "rate carried in the FY27 budget.",
        },
        {
          leadIn: "Initiation fee forecast.",
          body:
            `YTD initiation fee revenue reflects ${newMembershipsYtdCurrent} new memberships at current pricing. ` +
            "The Finance Committee will revisit the initiation-fee tier mix and the annual " +
            "indexation policy in the next regular operating cycle alongside the FY27 budget " +
            "framing.",
        },
      ],
    },
  ];

  return {
    dataSource: "demo",
    eyebrow: `${opts.clubName} · Operations`,
    title: "Operating Statistics & Focus Areas",
    periodLabel: opts.period.statementHeaderLabel,
    introNote:
      "Member utilization, engagement metrics, and the focus areas driving operational priorities.",
    statementNumber: "Statement 07 of 14",
    documentChip: "Operations",
    preparedFor: "GM & Management Level",
    columnHeaders: {
      statistic: "Operating Statistic",
      currentActual: currentActualHeader,
      priorYearActual: priorYearActualHeader,
      change: "Change",
      budget: "Budget",
      vsBudget: "Vs. Budget",
    },
    rows,
    focusCards,
  };
}

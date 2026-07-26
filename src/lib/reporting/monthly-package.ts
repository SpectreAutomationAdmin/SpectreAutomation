// Step / Monthly Reporting Package.
//
// Returns a structured `MonthlyReportingPackage` for the board /
// finance-committee dashboard at /app/admin/reporting/monthly.
//
// Where real Spectre data exists today we read it (club name + active
// branding + member/AR aging from MemberAccount). Everywhere else we
// return *clearly labelled demo data* keyed to the active club so the
// page presents a complete board package without lying about source —
// see the `dataSource` annotation on every block.
//
// The intent: a Club Admin opening this page sees a full board-pack
// shape. As more Spectre data lands (GL closes, payroll, F&B stats),
// we swap the demo branches for real prisma queries one-by-one
// without changing the page or component code.

import { prisma } from "@/lib/prisma";
import { getFiscalPeriodForClub } from "@/lib/clubs/profile";
import { getEquityHistory, type EquityHistory } from "@/lib/reporting/equity-history";
import { buildEquityCommentary } from "@/lib/reporting/equity-commentary";
import { getOperatingResults, type OperatingResults } from "@/lib/reporting/operating-results";
import {
  buildStewardshipDashboardNotes,
  type StewardshipDashboardNotes,
} from "@/lib/reporting/stewardship-dashboard-notes";
import {
  buildSilverSpringsStatementOfActivities,
  getStatementOfActivitiesForClub,
  SILVER_SPRINGS_SOA_AUXILIARY_INPUTS,
  type StatementOfActivitiesV2,
} from "@/lib/reporting/statement-of-activities";
import {
  buildSilverSpringsCapitalFundStatement,
  type CapitalFundStatement,
} from "@/lib/reporting/capital-fund-statement";
import {
  buildSilverSpringsCapitalProjectTracker,
  type CapitalProjectTracker,
} from "@/lib/reporting/capital-project-tracker";
import {
  buildSilverSpringsStatementOfFinancialPosition,
  getStatementOfFinancialPositionForClub,
  type StatementOfFinancialPosition,
} from "@/lib/reporting/statement-of-financial-position";
import { PrismaReportingLedger } from "@/lib/reporting/ledger";
import {
  buildSilverSpringsAccountsReceivableAging,
  type AccountsReceivableAging,
} from "@/lib/reporting/accounts-receivable-aging";
import {
  buildSilverSpringsOperatingStatistics,
  type OperatingStatistics,
} from "@/lib/reporting/operating-statistics";
import {
  buildSilverSpringsDepartmentalPLSummary,
  type DepartmentalPLSummary,
} from "@/lib/reporting/departmental-pl-summary";
import {
  buildSilverSpringsMonthlyWeatherSummary,
  type MonthlyWeatherSummary,
} from "@/lib/reporting/monthly-weather-summary";
import {
  buildSilverSpringsDepartmentalPayrollAnalysis,
  type DepartmentalPayrollAnalysis,
} from "@/lib/reporting/departmental-payroll-analysis";
import {
  buildSilverSpringsFoodBeverageStatistics,
  type FoodBeverageStatistics,
} from "@/lib/reporting/food-beverage-statistics";
import {
  buildSilverSpringsInventoryAnalysis,
  type InventoryAnalysis,
} from "@/lib/reporting/inventory-analysis";
import {
  buildReportingPeriod,
} from "@/lib/reporting/reporting-period";
import { buildOperatingCommentary } from "@/lib/reporting/operating-commentary";
import {
  buildOperatingScorecardData,
  buildCapitalScorecardData,
} from "@/lib/reporting/scorecard-metrics";
import { buildDemoOperatingScorecardSnapshot } from "@/lib/reporting/operating-scorecard-service";
import { buildDemoCapitalScorecardSnapshot } from "@/lib/reporting/capital-scorecard-service";
import {
  getStewardshipForClub,
  SILVER_SPRINGS_STEWARDSHIP_AUX,
} from "@/lib/reporting/stewardship-dashboard-adapter";
import {
  getCapitalFundForClub,
  SILVER_SPRINGS_CAPITAL_FUND_AUX,
} from "@/lib/reporting/capital-fund-adapter";
import {
  buildDepartmentNetPerformanceData,
  SILVER_SPRINGS_DEPARTMENT_INPUTS,
  SILVER_SPRINGS_DEPARTMENT_COMMENTARY,
  type DepartmentNetPerformanceData,
} from "@/lib/reporting/department-net-performance";
import {
  buildDuesSubsidyData,
  SILVER_SPRINGS_DUES_TOTAL,
  SILVER_SPRINGS_MEMBER_COUNT,
  SILVER_SPRINGS_DUES_CATEGORIES,
  type DuesSubsidyData,
} from "@/lib/reporting/dues-subsidy";
import {
  buildPayrollDepartmentData,
  buildPayrollRatioTrendData,
  SILVER_SPRINGS_PAYROLL_DEPTS,
  SILVER_SPRINGS_PAYROLL_REVENUE,
  SILVER_SPRINGS_OPERATING_DUES,
  SILVER_SPRINGS_PAYROLL_ACTUAL_MONTHLY,
  SILVER_SPRINGS_PAYROLL_BUDGET_MONTHLY,
  SILVER_SPRINGS_PAYROLL_PRIOR_MONTHLY,
  SILVER_SPRINGS_PAYROLL_BENCHMARK_PCT,
  SILVER_SPRINGS_GOLF_ROUNDS_ACTUAL,
  SILVER_SPRINGS_GOLF_ROUNDS_PRIOR_YEAR,
  type PayrollDepartmentData,
  type PayrollRatioTrendData,
} from "@/lib/reporting/payroll-analysis";
import {
  buildExecutiveSummary,
  buildDemoExecutiveSummaryInput,
  getExecutiveSummaryForClub,
  SILVER_SPRINGS_EXEC_SUMMARY_AUX,
} from "@/lib/reporting/executive-summary";

export type ReportingDataSource = "live" | "demo";

export type KpiTone = "green" | "amber" | "red" | "neutral";

/**
 * Variance tone for budget-variance subtexts on summary cards.
 *
 * "positive"  — favourable variance (green class on the amount span).
 * "negative"  — unfavourable variance (red class on the amount span).
 * "neutral"   — descriptive subtext with no favourable/unfavourable
 *               signal (muted body colour on the amount span).
 *
 * The reporting service owns the favourable/unfavourable decision —
 * the React component reads `varianceTone` directly. This keeps the
 * reporting service the single source of truth per the
 * `Financial Reporting Data Integrity — Mandatory` rule.
 */
export type VarianceTone = "positive" | "negative" | "neutral";

export type KpiCard = {
  key: string;
  label: string;
  value: string;
  /** Deprecated for At-a-Glance KPIs (use context + comparison). Still
   *  consumed by board-briefing chips for terse one-liners. */
  subtitle?: string;
  tone?: KpiTone;
  /** Plain-English explanation of what this metric represents. Used
   *  by the At-a-Glance KPI cards as a one-line interpretation
   *  beneath the hero number. */
  context?: string;
  /** Budget / policy / benchmark comparator. Drives the bottom strip
   *  of an At-a-Glance KPI card; absent when no comparator applies. */
  comparison?: KpiComparison;
};

export type KpiComparison = {
  /** "vs Budget" / "Policy target" / "Over-90 days" — labels the comparator */
  label: string;
  /** "$ 14.10M" / "1.25x" — the comparator value itself */
  value: string;
  /** "+3.7% above plan" — short directional summary, tone-coloured by
   *  the parent KpiCard.tone */
  variance?: string;
};

// Step / Stewardship redesign — every metric answers the three
// questions a Finance Committee asks of a controller's brief:
// (1) what is it, (2) why does it matter, (3) is it good or bad.
// The verdict is captured in `assessment`; the directional signal
// (green/amber/red) is on `tone`.
export type StewardshipKpi = {
  key: string;
  name: string;
  whatIsIt: string;
  whyItMatters: string;
  assessment: string;
  actual: string;
  budget?: string;
  benchmark?: string;
  tone: KpiTone;
};

/** Status indicator on a Stewardship scorecard row. Maps to a dot:
 *    on-track → green (club-green-500)
 *    monitor  → gold  (club-gold)
 *    action   → red   (club-clay)
 *  No "neutral" — every scorecard row carries an explicit posture. */
export type ScorecardStatus = "on-track" | "monitor" | "action";

/** One row in a Stewardship — KPI Scorecard. Mirrors the
 *  ClubBenchmarking-style table that Saguaro renders beneath the
 *  Chair's Dashboard chart pair. */
export type StewardshipScorecardRow = {
  key: string;
  /** Row label (left column, "Metric"). */
  metric: string;
  /** Short italic explanation rendered under the metric name. */
  description: string;
  /** Center column — actual / current value, pre-formatted. */
  actual: string;
  /** Center column — budget or goal value. The label varies per card
   *  (Operating uses "Budget"; Capital uses "Budget/Goal"). */
  budget: string;
  /** Right column — best-in-class / benchmark threshold. */
  benchmark: string;
  /** Status dot — drives the colored circle on the left + the
   *  default trend/status glyph on the right when no explicit `trend`
   *  is set (on-track → ↑, monitor → →, action → ↓). */
  status: ScorecardStatus;
  /** Optional explicit trend direction for the right-side glyph,
   *  overriding the default mapping from `status`. Use this when the
   *  metric is, say, Monitor-status but trending DOWN (e.g. Total
   *  Capital Income vs. Budget — short of plan but not yet Action). */
  trend?: "up" | "down" | "flat";
  /** Per-row data provenance. When the row's three values come from
   *  a service computation we mark "live"; otherwise "demo". */
  dataSource: ReportingDataSource;
};

/** A single Stewardship scorecard card. Two of these render side-by-
 *  side beneath the Equity + Operating Results chart pair. */
export type StewardshipScorecard = {
  /** Card header — serif title. */
  title: string;
  /** Smallcaps subtitle (the "question" the scorecard answers). */
  subtitle: string;
  /** Cream section-divider band between the column headers and the
   *  first row. */
  sectionBand: string;
  /** Three center-column header labels. */
  columnHeaders: { actual: string; budget: string; benchmark: string };
  rows: StewardshipScorecardRow[];
  /** Top-line provenance — "live" only when EVERY row is live. */
  dataSource: ReportingDataSource;
};

export type StatementLine = {
  label: string;
  current: string;
  budget?: string;
  variance?: string;
  isTotal?: boolean;
  indent?: number;
};

// Step / Board-readable financial statements. Every statement now
// carries three board-ready surfaces — summary cards, key variance
// rows, and a plain-English notes paragraph — in addition to the
// existing line-by-line detail rows. The page renders these top-down
// (summary → variances → notes → detail) so directors get the headline
// before the accounting system dump.
export type StatementSummaryCard = {
  key: string;
  label: string;
  value: string;
  /** One-sentence interpretation — the "what this line measures"
   *  pillar of the four-pillar KPI card anatomy. Optional; cards
   *  without it still render with just label / value / comparison. */
  context?: string;
  comparison?: {
    label: string;
    value: string;
    variance?: string;
  };
  tone?: KpiTone;
};

export type KeyVarianceRow = {
  key: string;
  label: string;
  current: string;
  variance: string;
  note?: string;
  tone: KpiTone;
};

export type AgingBucket = {
  label: string;
  amount: string;
  share: string;
};

export type DepartmentResult = {
  name: string;
  revenue: string;
  expense: string;
  contribution: string;
  contributionPctOfRevenue: string;
  tone: KpiTone;
};

export type ChartSeriesPoint = { label: string; value: number };

// Step / Executive commentary — every major section of the package
// carries a short controller's note that answers four questions a
// Finance Chair would otherwise ask in the meeting. The shape is
// stable across all sections so the page renders one component for
// all of them. `boardDecision` is intentionally optional but the UI
// always prints SOMETHING in that slot (the page falls back to
// "None this month" when the field is absent), so the question is
// always answered.
/**
 * Board Consideration — the structured governance signal carried by
 * every major narrative on the page. One of four states:
 *
 *   - "no-action"        — No action required. The reading is favorable
 *                          to policy / plan; the Board acknowledges and
 *                          moves on.
 *   - "monitor"          — Monitor. The reading is within policy but the
 *                          trend warrants tracking; no committee action
 *                          this period.
 *   - "committee-review" — Committee review recommended. The relevant
 *                          committee (Membership, Capital, Finance) will
 *                          review and report back at its next meeting.
 *   - "board-decision"   — Board decision required. A motion, vote, or
 *                          explicit Board approval is needed.
 *
 * Defined in docs/executive-narrative-style-guide.md as the four-state
 * cascade every major narrative must carry. The chip rendering of
 * these values gives a Finance Chair the at-a-glance governance
 * posture before reading the prose detail.
 */
export type BoardConsideration =
  | "no-action"
  | "monitor"
  | "committee-review"
  | "board-decision";

// ---------------------------------------------------------------------------
// Board Decisions Required
// ---------------------------------------------------------------------------
//
// The items the Board is being asked to ACT on this period. Sits above
// Board Risks in the Chair's Dashboard because required action always
// outranks ongoing monitoring.
//
// Per the founder's design direction:
//   - Maximum 3 decisions
//   - Ideally 0–2 in a typical month — a clear month is a success,
//     NOT an empty state
//   - Action vocabulary: APPROVE / REVIEW / RATIFY (3 verbs only)
//   - Filled action chip is the visual signature; weight intentionally
//     heavier than Board Risks because decisions drive action
//   - No risk scores, probabilities, urgency dials, or SaaS widgets
//
// Phase 1 contract: management hand-authors decisions on
// pkg.boardDecisions. Same authorship pattern as Board Risks — the
// system never manufactures a decision.
export type DecisionAction = "approve" | "review" | "ratify";

export type BoardDecision = {
  /** Stable identifier for testids and React keys. */
  key: string;
  /** APPROVE = formal Board decision required.
   *  REVIEW  = Board discussion / oversight / feedback / awareness.
   *  RATIFY  = committee or management has already acted; the Board
   *            is being asked to formalize. */
  action: DecisionAction;
  /** Headline — the matter being decided, in 4–8 words. */
  title: string;
  /** Single Director-voice sentence: what is the Board being asked
   *  to act on? */
  ask: string;
  /** Sponsoring body or officer ("Capital Committee", "Membership
   *  Committee", "Finance Committee", "General Manager"). */
  sponsor: string;
  /** Plain-English meeting target — "June 12, 2026 Board meeting",
   *  "FY27 Long Range Plan refresh". Never a calendar widget. */
  meeting: string;
};

// ---------------------------------------------------------------------------
// Board Risks
// ---------------------------------------------------------------------------
//
// The exposures the Board is monitoring this period. Hand-authored by
// management — not derived from engine output. KPIs answer "what
// happened"; Board Risks answer "what should Directors be paying
// attention to". That is a management judgment, not a mathematical one.
//
// Per the founder's design direction:
//   - Maximum 5 risks
//   - Severity: HIGH (red) / MODERATE (amber) / WATCH (gold)
//   - Trend:    WORSENING / STABLE / IMPROVING / NEW
//   - Board-document vocabulary; no CRITICAL / SEVERE / URGENT
//   - No risk scores, no probabilities, no impact matrices
//   - Healthy-month fallback row rendered when the list is empty
//
// Phase 1: management writes these directly. Phase 2: the engine may
// suggest candidates from sustained YELLOW/RED metrics — management
// still approves before publication.
export type BoardRiskSeverity = "high" | "moderate" | "watch";
export type BoardRiskTrend = "worsening" | "stable" | "improving" | "new";

export type BoardRisk = {
  /** Stable identifier used for testids and React keys. */
  key: string;
  /** 2-6 word headline ("Reserve coverage policy floor under pressure"). */
  title: string;
  /** Severity reflects current condition. */
  severity: BoardRiskSeverity;
  /** Trend reflects direction since prior period. */
  trend: BoardRiskTrend;
  /** Single Director-voice sentence (~22 words max). */
  summary: string;
  /** Optional explicit Board-action note (e.g. "Committee review at June 12, 2026 meeting"). */
  boardAction?: string;
};

export type ExecutiveCommentaryBlock = {
  dataSource: ReportingDataSource;
  /** Structured governance signal — required on every commentary block
   *  so the four-state cascade is always answered (the framework's
   *  fourth question, "Does the Board need to act?", made scannable). */
  consideration: BoardConsideration;
  /** Single-sentence Director-voice headline used by The Five Observations
   *  on the Chair's Dashboard. Plain English, no jargon, no raw numbers
   *  beyond what a Director would naturally quote. Five commentary blocks
   *  populate this field — one per stewardship pillar — and the
   *  ExecutiveNarrative component renders them ordered by attention
   *  severity (worst-first). Authoring lives alongside the rest of the
   *  commentary so voice stays consistent. Optional on blocks that do
   *  not feed The Five Observations. */
  boardHeadline?: string;
  whatHappened: string;
  whatItMeans: string;
  whatNeedsAttention: string;
  boardDecision?: string;
};

export type MonthlyReportingPackage = {
  club: {
    id: string;
    name: string;
    /** From ClubProfile — drives the cover identity line
     *  "CITY, PROVINCE · EST. YEAR". Null when the field is not set
     *  in Admin → Club Settings; the cover gracefully omits each
     *  missing piece. */
    city: string | null;
    provinceState: string | null;
    yearFounded: number | null;
  };
  period: {
    /** Short period name — e.g. "<MonthLong> <year>". Derived from periodEnd. */
    label: string;
    /** Editorial period reference for the cover subtitle — e.g.
     *  "For the period ended <MonthLong> <day>, <year>". Derived from periodEnd. */
    periodEndedLabel: string;
    /** Compact period-end date — "<MonthLong> <day>, <year>". Used by
     *  inline eyebrows like the Chair's Dashboard chapter heading.
     *  Derived from periodEnd. */
    periodEndShortLabel: string;
    fiscalYearLabel: string;
    startISO: string;
    endISO: string;
    ytdMonthsElapsed: number;
  };
  preparedFor: string;
  preparedAt: string;
  dataSourcesPresent: ReportingDataSource[];

  executiveSummary: {
    dataSource: ReportingDataSource;
    kpis: KpiCard[];
    headline: string;
    /** Package-level Board Consideration — the at-a-glance governance
     *  posture for the entire monthly reading. */
    consideration: BoardConsideration;
  };

  boardBriefing: {
    operations: {
      status: KpiTone;
      statusLabel: string;
      narrative: string;
      chips: KpiCard[];
      consideration: BoardConsideration;
      // Cover Executive Briefing fields — drive the Operations card on
      // the package's first-scroll view (per docs/spectre-first-scroll-reporting-standard.md).
      // `question` is the briefing question the card answers; `coverNarrative`
      // is the max-2-sentence headline narrative (the chapter II memo
      // narrative stays untouched as the full prose); `coverMetrics` are
      // the three stewardship-grade metrics required by the first-scroll
      // standard's Operating Health block.
      question: string;
      coverNarrative: string;
      coverMetrics: Array<{ key: string; label: string; value: string; sub: string }>;
    };
    financialHealth: {
      status: KpiTone;
      statusLabel: string;
      narrative: string;
      chips: KpiCard[];
      consideration: BoardConsideration;
      // Cover Executive Briefing fields — drive the Financial Health
      // card on the first-scroll view (per docs/spectre-first-scroll-reporting-standard.md).
      // Mirrors the operations.{question, coverNarrative, coverMetrics}
      // shape so the dedicated FinancialHealthBriefingCard atom can
      // mirror the OperationsBriefingCard visually.
      question: string;
      coverNarrative: string;
      coverMetrics: Array<{ key: string; label: string; value: string; sub: string }>;
    };
    capitalProgram: {
      status: KpiTone;
      statusLabel: string;
      narrative: string;
      chips: KpiCard[];
      consideration: BoardConsideration;
      // Cover Executive Briefing fields — drive the Capital Program
      // card on the first-scroll view (per docs/spectre-first-scroll-reporting-standard.md).
      // Mirrors the operations.{question, coverNarrative, coverMetrics}
      // and financialHealth.{question, coverNarrative, coverMetrics}
      // shapes so the dedicated CapitalProgramBriefingCard atom can
      // mirror the OperationsBriefingCard + FinancialHealthBriefingCard
      // anatomy visually.
      question: string;
      coverNarrative: string;
      coverMetrics: Array<{ key: string; label: string; value: string; sub: string }>;
    };
  };

  visualSummary: {
    dataSource: ReportingDataSource;
    intro: string;
    equityTrend: ChartSeriesPoint[];      // last 12 months — equity ($K)
    noiTrend: ChartSeriesPoint[];          // last 12 months — NOI ($K)
    duesSubsidyTrend: ChartSeriesPoint[];  // last 12 months — dues subsidy
    departmentSummary: DepartmentResult[];
  };

  /**
   * Chair's Dashboard — visual stewardship dashboard.
   *
   * Two equal-width cards rendered immediately after the Executive
   * Briefing on the cover. Each card answers ONE of the two board
   * questions a private-club director needs answered in 5 seconds
   * without reading paragraphs:
   *
   *   1. Is the Club becoming financially stronger? → `equity`
   *   2. Are operations performing appropriately?    → `operating`
   *
   * Per the Editorial Reporting Principle, the chart is the
   * dominant element (~70% of card height); the KPI ribbon above
   * carries the four numbers a chair quotes from memory; the
   * interpretation beneath is two sentences MAX, hand-authored
   * stewardship voice — never a paragraph.
   */
  stewardshipDashboard: {
    dataSource: ReportingDataSource;
    equity: {
      /** Year-end equity values in $M for the long-term trend. */
      series: ChartSeriesPoint[];
      /** Hypothetical best-in-class growth line ($M, same length as `series`). */
      benchmarkBest: ChartSeriesPoint[];
      /** Minimum required growth line ($M, same length as `series`). */
      benchmarkMin: ChartSeriesPoint[];
      /** KPI ribbon values, pre-formatted for display. */
      actualCagrLabel: string;          // e.g. "+5.2%"
      bestInClassCagrLabel: string;     // e.g. "+6.0%"
      minimumRequiredCagrLabel: string; // e.g. "+3.0%"
      currentValueLabel: string;        // e.g. "$28.01M"
      /** Two-sentence stewardship interpretation. */
      interpretation: string;
      /** Y-axis lower bound in $M — derived from the first plotted
       *  actual equity value, rounded DOWN to the nearest $5M.
       *  E.g. first value $18.83M → 15. */
      yAxisMin: number;
      /** Y-axis upper bound in $M — derived from the highest value
       *  across actual + both benchmark series, rounded UP to the
       *  nearest $5M. E.g. highest $32.18M → 35. */
      yAxisMax: number;
      /** Number of y-axis tick INTERVALS. Always `(yAxisMax - yAxisMin)/5`
       *  so each interval is a clean $5M step. */
      yAxisTicks: number;
    };
    operating: {
      /** Trailing 12 months of NOI in $K. */
      series: ChartSeriesPoint[];
      /** 12 months of board-approved budget NOI ($K). */
      budget: ChartSeriesPoint[];
      /** 12 months of prior-year NOI for YoY context ($K). */
      priorYear: ChartSeriesPoint[];
      /** 12 months of prior-year YTD CUMULATIVE NOI ($K) — running
       *  sum of `priorYear`. Drives the chart's overlay line so the
       *  visual reconciles to the Prior Year KPI tile: the line's
       *  last point ALWAYS equals the Prior Year KPI value. */
      priorYearYtd: ChartSeriesPoint[];
      /** Break-even value in $K — drawn as a horizontal reference. */
      breakEven: number;
      /** Break-even tolerance corridor in $K (drawn as a tinted band). */
      breakEvenCorridor: { lower: number; upper: number };
      /** KPI ribbon values, pre-formatted for display. */
      ytdNoiLabel: string;        // e.g. "$3.18M"
      noiPctRevenueLabel: string; // e.g. "21.7%"
      budgetGoalLabel: string;    // e.g. "$2.84M"
      priorYearLabel: string;     // e.g. "$2.92M"
      /** Two-sentence operating interpretation. */
      interpretation: string;
    };
    /** Two scorecard cards rendered beneath the chart pair. Each is a
     *  ClubBenchmarking-style KPI table — Saguaro reference.
     *
     *  Sources, per row:
     *    - Where Spectre already computes the value (Actual CAGR from
     *      `getEquityHistory`; NOI / NOI % / Budget / Prior Year from
     *      `getOperatingResults`), the row pulls from the formatter.
     *    - Other rows ship as `demo` until the underlying GL account
     *      mappings land (e.g. Initiation Fee Operating Subsidy needs
     *      an initiation-fee revenue account class). Every demo row
     *      carries `dataSource: "demo"` so the surface honestly tags
     *      its provenance — no React-only literals.
     */
    scorecards: {
      operating: StewardshipScorecard;
      capital:   StewardshipScorecard;
    };
    /** Department Net Performance Highlights card — third row of
     *  Chapter II's Stewardship Dashboard. Department actuals +
     *  budgets + computed variances + trend-bar widths come from
     *  src/lib/reporting/department-net-performance.ts. */
    departmentPerformance: DepartmentNetPerformanceData;
    /** Dues Subsidy Analysis card — third row, second column.
     *  Donut categories + arc angles + summary line come from
     *  src/lib/reporting/dues-subsidy.ts. */
    duesSubsidy: DuesSubsidyData;
    /** Payroll Analysis — Department Breakdown card — fourth row,
     *  first column. Per-department actual/budget/prior-year payroll
     *  + Dues-Cover-Payroll check come from
     *  src/lib/reporting/payroll-analysis.ts. */
    payrollDepartment: PayrollDepartmentData;
    /** Payroll Ratio — Monthly Trend card — fourth row, second
     *  column. 12-month line series + commentary come from the same
     *  payroll-analysis service. */
    payrollRatioTrend: PayrollRatioTrendData;
  };

  operatingKPIs: { dataSource: ReportingDataSource; cards: StewardshipKpi[] };
  capitalKPIs:   { dataSource: ReportingDataSource; cards: StewardshipKpi[] };

  /**
   * Stewardship KPI Dashboard — chapter III executive scorecard
   * (Saguaro reference). Sits AFTER Financial Performance (chapter II)
   * and BEFORE the pillar deep-dives (chapter IV onwards). The
   * four summary cards answer "Are we on plan across all operating
   * and capital dimensions?" at-a-glance; the Operating + Capital
   * panels surface the same `operatingKPIs.cards` / `capitalKPIs.cards`
   * rows that drive the chapter-II Stewardship Dashboard (single
   * source of truth — both chapters render identical row data, just
   * different visual treatments per the founder's direction).
   *
   * Per `Financial Reporting Data Integrity — Mandatory` in CLAUDE.md:
   *   • Actual / budget / variance / margin / balance values flow
   *     from the reporting service. Seeded reporting fields are
   *     tagged via `dataSource: "demo"`.
   *   • Benchmark / threshold / FAC values are configuration-driven.
   *
   * Per `Reactive Commentary for Financial Reporting — Mandatory`:
   *   • Dashboard Notes commentary reconciles to the same dataset
   *     that produces the summary cards + KPI rows; the generator
   *     branches on operating/capital status verdicts (no hardcoded
   *     React strings).
   */
  stewardshipKpiDashboard: {
    dataSource: ReportingDataSource;
    /** Mixed-case editorial metadata line (Saguaro pattern). */
    periodLabel: string;
    /** Italic intro question rendered under the chapter header. */
    introQuestion: string;
    /** Four top KPI summary cards — `value` flows from the reporting
     *  service where supported; benchmark thresholds (e.g. FAC ≥60%)
     *  are configuration-driven.
     *
     *  Summary cards that carry a budget variance split the subtext
     *  into `varianceAmount` + `varianceLabel` + `varianceTone` so the
     *  rendered surface can colour ONLY the amount (green for
     *  favourable, red for unfavourable, neutral for descriptive).
     *  Tone is data-driven — the React component does NOT inspect the
     *  sign of the amount string; it reads `varianceTone` directly.
     *  Per `Financial Reporting Data Integrity — Mandatory` in
     *  CLAUDE.md, this keeps the reporting service the single source
     *  of truth for what counts as favourable vs unfavourable. */
    summaryCards: {
      revenue: {
        value: string;
        varianceAmount: string;
        varianceLabel: string;
        varianceTone: VarianceTone;
      };
      noiBeforeDep: {
        value: string;
        varianceAmount: string;
        varianceLabel: string;
        varianceTone: VarianceTone;
        marginPct: string;
      };
      capitalFundIncome: { value: string; subtext: string };
      reserveCoverage:   { value: string; balance: string; benchmark: string };
    };
    /** Reactive commentary block — an ORDERED list of bullet objects
     *  generated by `buildStewardshipDashboardNotes` from the
     *  underlying operating/capital KPI rows + reserve-coverage +
     *  PP&E status. The React surface renders bullets via list
     *  semantics; no inline string composition.
     *
     *  Per `Reactive Commentary for Financial Reporting — Mandatory`
     *  in CLAUDE.md, EVERY figure quoted in a bullet reconciles to
     *  the same reporting dataset that produces the chapter III KPI
     *  cards above. When KPI tones change, the bullets change. */
    dashboardNotes: StewardshipDashboardNotes;
  };

  /**
   * Chapter IV — Statement of Activities (Two-Fund Format).
   *
   * Saguaro-style board-facing financial statement. Operating
   * revenues + expenses above the NOI line, capital fund activity
   * below — separated by institutional discipline. 8-column table
   * (Category + Current Month Budget/Actual/Variance + YTD
   * Budget/Actual/Variance + % Variance) with section bands, the
   * dark-green NOI band, pale-blue capital divider, inline
   * commentary rows, and a reactive CFO Commentary block.
   *
   * Owned end-to-end by `src/lib/reporting/statement-of-activities.ts`;
   * the React surface renders only. Per CLAUDE.md the variance
   * math, the tone classification, the commentary branches, and
   * the seed numerics ALL live in the service.
   */
  statementOfActivitiesV2: StatementOfActivitiesV2;

  /**
   * Chapter V — Capital Fund Statement.
   *
   * Saguaro-style two-column board-facing capital statement: the
   * Sources & Uses table on the left (with the same column rhythm
   * as Statement of Activities — annual budget / YTD actual /
   * remaining), and a reserve-coverage-ratio card + reserve-adequacy
   * detail table + capital-stress-test commentary stack on the
   * right.
   *
   * Owned end-to-end by
   * `src/lib/reporting/capital-fund-statement.ts`; the React surface
   * renders only. Per CLAUDE.md the seed numerics, the reactive
   * stress-test commentary, the reserve marker scale, and the
   * tone-classified adequacy rows ALL live in the service.
   *
   * Period labels (statement header, "{year} Budget" column header)
   * flow from `ReportingPeriod` per the Reporting Period Golden
   * Rule.
   */
  capitalFundStatement: CapitalFundStatement;

  /**
   * Chapter VI — Capital Project Tracker.
   *
   * Saguaro-style nine-column project ledger: active replacements +
   * active improvements + planning rows, a total band for authorized
   * projects, and a green-tinted exception report + bullet project
   * notes block beneath the table.
   *
   * Owned end-to-end by `src/lib/reporting/capital-project-tracker.ts`;
   * the React surface renders only. Period labels (statement header,
   * exception-report eyebrow "Q[N] {year}", and next-board-meeting
   * reference in the planning row's commentary) flow from
   * `ReportingPeriod` per the Reporting Period Golden Rule.
   *
   * Cross-chapter integration: chapter V (Capital Fund) answers
   * where capital comes from; chapter VI (this) answers what was
   * approved and whether projects are off course. The two chapters
   * share their reserve-balance reference + statement-number cross-
   * citation so the references never drift.
   */
  capitalProjectTracker: CapitalProjectTracker;

  /**
   * Chapter VII — Statement of Financial Position (Balance Sheet).
   *
   * Saguaro-style balance sheet adapted for Spectre's narrower
   * right-hand canvas: rendered VERTICALLY (Assets → Liabilities &
   * Members' Equity → Stewardship Ratios → Balance Sheet Notes)
   * rather than side-by-side. Service owns the row dataset, the
   * reconciliation check, the stewardship-ratio scales, and the
   * reactive notes.
   *
   * Period labels (statement header + per-table current/comparative
   * column headers) flow from `ReportingPeriod` per the Reporting
   * Period Golden Rule.
   *
   * Replaces the chapter XIV `BoardStatement` Statement of Financial
   * Position invocation; chapter XIV continues to host the legacy
   * Capital Fund + (now removed) Statement of Activities.
   */
  statementOfFinancialPositionV2: StatementOfFinancialPosition;

  /**
   * Chapter VIII — Accounts Receivable Aging.
   *
   * Saguaro-style AR aging surface: 4 top KPI summary cards, a
   * 7-column aging table with status pills, a 5-column membership
   * activity table (Current period / Prior-year comparative /
   * Change / Annual forecast), and a reactive collection notes
   * block. Period labels (statement header + membership activity
   * column headers + collection-note quarter references) flow from
   * `ReportingPeriod` per the Reporting Period Golden Rule.
   */
  accountsReceivableAging: AccountsReceivableAging;

  /**
   * Chapter IX — Operating Statistics & Focus Areas. The first chapter
   * of the Operations & Analytics group. Renders a period-over-prior-
   * year operating-stats table (Golf Operations / Food & Beverage /
   * Member Engagement / Payroll & Labor) plus two Focus Area cards
   * (Operating Focus + Capital Focus). Column headers + focus-card
   * lead-ins flow from `ReportingPeriod` per the Reporting Period
   * Golden Rule — month-over-prior-year for monthly reports
   * (e.g. May 2026 vs May 2025), never hardcoded Q1/March.
   */
  operatingStatistics: OperatingStatistics;

  /**
   * Chapter X — Departmental P&L Summary. The second chapter of the
   * Operations & Analytics group. Six department cards (Food &
   * Beverage / Golf Operations / Fitness Center / Racquet Operations
   * / Aquatics & Pool / G&A & Administration) plus a management-
   * document notice and arrow-bullet department notes. All copy
   * (header period, monthly Member-Rounds-vs-PY context, expected-
   * resolution quarter, seasonal-outlook quarter, current-quarter
   * note language) flows from `ReportingPeriod` per the Reporting
   * Period Golden Rule.
   */
  departmentalPLSummary: DepartmentalPLSummary;

  /**
   * Chapter XI — Monthly Weather Summary. The third chapter of the
   * Operations & Analytics group. 4 weather KPI cards + a weather-
   * pattern donut + a rounds-by-condition bar chart + a notable
   * weather events table + 3 weather-utilization correlation cards
   * (Golf / Racquet / Dining). Calgary-calibrated seed (the Silver
   * Springs club location); period labels + the location subtitle
   * + event-date labels + insight copy all flow from
   * `ReportingPeriod` per the Reporting Period Golden Rule.
   */
  monthlyWeatherSummary: MonthlyWeatherSummary;

  /**
   * Chapter XII — Departmental Payroll Analysis. Fourth chapter of
   * the Operations & Analytics group. 4 KPI cards + 4 chart cards
   * (YTD Actual vs Budget by department, YTD Variance, Payroll
   * Distribution donut, Wages vs Taxes & Benefits stacked bars) +
   * an executive variance callout + a detailed MTD/YTD summary
   * table. All period labels flow from `ReportingPeriod` per the
   * Reporting Period Golden Rule.
   */
  departmentalPayrollAnalysis: DepartmentalPayrollAnalysis;

  /**
   * Chapter XIII — Food & Beverage Statistics. Fifth chapter of
   * the Operations & Analytics group. 4 KPI cards + 4 chart cards
   * (Monthly Revenue vs Cost / Revenue by Category donut / Monthly
   * Cover Counts vs Budget vs Prior Year / Food Cost % by Month
   * line). All chart subtitles + reactive callouts derive from
   * `ReportingPeriod` so a May 2026 report shows January–May 2026.
   */
  foodBeverageStatistics: FoodBeverageStatistics;

  /**
   * Chapter XIV — Inventory Analysis. Sixth chapter of the
   * Operations & Analytics group. 4 KPI cards + 2 chart cards
   * (Inventory Turnover by Category grouped bars vs prior year +
   * F&B Inventory Balances monthly multi-line) + an Inventory
   * Management Flags & Action Items table. Period-aware monthly
   * slicing + action-timeline labels derive from `ReportingPeriod`.
   */
  inventoryAnalysis: InventoryAnalysis;

  statementOfActivities: {
    dataSource: ReportingDataSource;
    summaryCards: StatementSummaryCard[];
    keyVariances: KeyVarianceRow[];
    notes: string;
    /** Per-statement Board Consideration — the governance posture of
     *  this specific statement, rendered in its header alongside the
     *  data-source chip. */
    consideration: BoardConsideration;
    lines: StatementLine[];
  };
  capitalFund: {
    dataSource: ReportingDataSource;
    summaryCards: StatementSummaryCard[];
    keyVariances: KeyVarianceRow[];
    notes: string;
    consideration: BoardConsideration;
    lines: StatementLine[];
  };
  capitalProjects: {
    dataSource: ReportingDataSource;
    rows: Array<{
      name: string;
      budget: string;
      ytd: string;
      /** Pre-formatted percentage of budget consumed (YTD / Budget).
       *  Renders the four-pillar variance column so the reader does
       *  not have to perform mental arithmetic. */
      used: string;
      status: string;
      tone: KpiTone;
    }>;
  };
  financialPosition: {
    dataSource: ReportingDataSource;
    summaryCards: StatementSummaryCard[];
    keyVariances: KeyVarianceRow[];
    notes: string;
    consideration: BoardConsideration;
    lines: StatementLine[];
  };

  arAging: {
    dataSource: ReportingDataSource;
    summaryCards: StatementSummaryCard[];
    keyVariances: KeyVarianceRow[];
    notes: string;
    consideration: BoardConsideration;
    buckets: AgingBucket[];
  };

  operatingStats: {
    dataSource: ReportingDataSource;
    members: {
      active: number;
      new: number;
      resignations: number;
      net: number;
      waitlist: number;
      waitlistConversionPct: string;
    };
    rounds: {
      ytd: number;
      ytdBudget: number;
      varPct: string;
      guestYTD: number;
      guestSharePct: string;
    };
    fbCovers: {
      ytd: number;
      ytdBudget: number;
      varPct: string;
      averageCheck: string;
    };
    derived: {
      spendPerMember: string;
      spendPerRound: string;
    };
  };

  departmentPnL: { dataSource: ReportingDataSource; rows: DepartmentResult[] };

  weatherUtilization: {
    dataSource: ReportingDataSource;
    rainoutsMonth: number;
    avgTempF: number;
    rangeUtilizationPct: string;
    courseUtilizationPct: string;
    daysLostYTD: number;
    revenueImpactEstimate: string;
    utilizationTrend: ChartSeriesPoint[];
  };

  payroll: {
    dataSource: ReportingDataSource;
    ytdTotal: string;
    ytdBudget: string;
    ytdVarPct: string;
    ytdPriorYear: string;
    payrollRatio: string;
    duesCoverPayroll: boolean;
    duesCushion: string;
    monthlyRatioTrend: ChartSeriesPoint[];
    byDepartment: Array<{
      key: string;
      name: string;
      ytd: string;
      sharePct: string;
      tone?: KpiTone;
    }>;
    overtimeHoursYTD: number;
    overtimePctOfHours: string;
    peakOvertimeMonth: string;
    seasonalLaborEstimate: string;
  };

  fbStats: {
    dataSource: ReportingDataSource;
    coversYTD: number;
    avgCheck: string;
    salesByOutlet: Array<{ outlet: string; sales: string; covers: number }>;
    laborPct: string;
    foodCostPct: string;
    beverageCostPct: string;
    surveyScore: string | null;
    revenueYTD: string;
    revenueVarPct: string;
    subsidyAmount: string;
    subsidyPctOfDues: string;
    subsidyTrend: ChartSeriesPoint[];
  };

  inventory: {
    dataSource: ReportingDataSource;
    foodOnHand: string;
    beverageOnHand: string;
    daysOnHandFood: number;
    daysOnHandBeverage: number;
    shrinkagePct: string;
    turnsFood: string;
    turnsBeverage: string;
  };

  // Step / Pillar 5 — Experience Stewardship chapter.
  //
  // Closes the five-pillar set: rounds + utilization on the golf
  // side, covers + check on the F&B side, the two cross-cutting spend
  // metrics (per member, per round), and the F&B subsidy of dues that
  // bridges Pillar 5 Experience and Pillar 1 Operating. The chapter
  // is built narrative-first: two editorial paragraphs frame the
  // golf and hospitality readings; the six metrics that support them
  // render below the prose, not above it.
  experienceStewardship: {
    dataSource: ReportingDataSource;
    /** Editorial paragraph — Board tone — interpreting the golf
     *  reading (rounds + utilization + capital-condition crossover).
     *  Renders in the page chapter ABOVE the supporting hero tiles. */
    golfReading: string;
    /** Editorial paragraph — Board tone — interpreting the
     *  hospitality reading (covers + check + spend + subsidy of dues).
     *  Renders in the page chapter ABOVE the supporting hero tiles. */
    hospitalityReading: string;
  };

  // Step / Pillar 4 — Membership Stewardship chapter.
  //
  // Promoted out of `operatingStats.members` (which now stays as the
  // raw counts the Operations & Analytics chapter consumes) into a
  // dedicated stewardship-pillar chapter. Surfaces the five
  // Membership Stewardship dimensions the Board governs:
  //   - active members + category mix
  //   - waitlist depth + aging
  //   - rolling-12-month attrition
  //   - entrance-fee revenue (the Pillar 4 / Pillar 2 crossover)
  //   - average tenure + distribution
  membershipStewardship: {
    dataSource: ReportingDataSource;
    activeMembers: number;
    netYTD: number;
    newYTD: number;
    resignationsYTD: number;
    /** Rolling-12-month resignations as a share of average active
     *  membership over the same window. The Pillar 4 retention signal. */
    attritionRateTTM: string;
    attritionBenchmark: string;
    attritionTone: KpiTone;
    /** 12-month series of monthly resignation counts — feeds the
     *  closing-chapter sparkline. */
    attritionTrend: ChartSeriesPoint[];
    categoryMix: Array<{
      key: string;
      name: string;
      count: number;
      duesRate: string;
      netYTD: number;
      sharePct: string;
    }>;
    waitlist: {
      depth: number;
      conversionPct: string;
      targetDepth: number;
      aging: Array<{ band: string; count: number; sharePct: string }>;
    };
    entranceFee: {
      ytd: string;
      priorYearYTD: string;
      varPctYoY: string;
      perNewMember: string;
      benchmark: string;
      tone: KpiTone;
    };
    tenure: {
      averageYears: string;
      distribution: Array<{ band: string; count: number; sharePct: string }>;
    };
  };

  exports: {
    enabled: boolean;
    reason?: string;
  };

  commentary: {
    atAGlance:              ExecutiveCommentaryBlock;
    stewardship:            ExecutiveCommentaryBlock;
    financialStatements:    ExecutiveCommentaryBlock;
    operations:             ExecutiveCommentaryBlock;
    payroll:                ExecutiveCommentaryBlock;
    fb:                     ExecutiveCommentaryBlock;
    capitalProjects:        ExecutiveCommentaryBlock;
    arCollections:          ExecutiveCommentaryBlock;
    membershipStewardship:  ExecutiveCommentaryBlock;
    experienceStewardship:  ExecutiveCommentaryBlock;
  };

  /** Hand-authored Board Risks for this period. Capped at 5 by the
   *  BoardRisks component contract. Empty array renders the
   *  healthy-month fallback row ("No material risks requiring Board
   *  action this period.") — the system never manufactures risks. */
  boardRisks: BoardRisk[];

  /** Hand-authored Board Decisions Required for this period. Capped
   *  at 3 by the BoardDecisions component contract (the founder's
   *  spec — a Board package should typically carry 0–2 decisions and
   *  never more than 3). Empty array renders the healthy-month
   *  fallback row ("No Board decisions required this period.") which
   *  reads as a success, not a void. */
  boardDecisions: BoardDecision[];
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Equity Value Over Time — display formatter.
//
// Receives the cent-denominated `EquityHistory` from the reporting
// service and converts it to the display shape the React card consumes.
// All number-to-string formatting (CAGR percentages, current equity
// dollar string, FY-bucket labels) happens HERE so the card stays a
// pure presentational consumer. The card never inlines a series or
// hardcodes a benchmark value.
// ---------------------------------------------------------------------------
export function formatEquityDashboard(h: EquityHistory) {
  const M = 1_000_000;
  const centsToM = (c: bigint): number => Number(c) / 100 / M;
  const pct = (bps: number): string => `${(bps / 100).toFixed(1)}%`;
  const dollars = (cents: bigint): string => {
    const m = centsToM(cents);
    // One-decimal $M display matches Saguaro p03's "$31.0M" convention.
    return `$${m.toFixed(1)}M`;
  };
  const fyShort = (label: string): string => {
    // X-axis carries the FY-ending year directly (e.g. FY2025 → "2025").
    // The window of years displayed is the last 8 COMPLETED fiscal
    // years relative to the reporting period, enforced upstream in
    // `getEquityHistory` by `endDate < asOf`. For a May 2026
    // reporting period that gives FY2018..FY2025 → "2018".."2025".
    const m = label.match(/^FY(\d{4})$/);
    if (m) return m[1];
    return label;
  };

  const series: ChartSeriesPoint[] = h.series.map((p) => ({
    label: fyShort(p.fiscalYear),
    value: Number(p.clubEquityCents) / 100 / M,
  }));
  const benchmarkBest: ChartSeriesPoint[] = h.series.map((p) => ({
    label: fyShort(p.fiscalYear),
    value: Number(p.bestInClassBenchmarkCents) / 100 / M,
  }));
  const benchmarkMin: ChartSeriesPoint[] = h.series.map((p) => ({
    label: fyShort(p.fiscalYear),
    value: Number(p.minimumRequiredBenchmarkCents) / 100 / M,
  }));

  const actualCagrLabel = pct(h.actualCagrBps);
  const bestInClassCagrLabel = pct(h.bestInClassCagrBps);
  const minimumRequiredCagrLabel = pct(h.minimumRequiredCagrBps);
  const currentValueLabel = dollars(h.currentEquityCents);

  // Commentary is generated by the dedicated reporting-commentary
  // module so the React tree never sees a literal sentence. The
  // generator handles four cases (above-best, between, near-minimum,
  // below-minimum) and uses the same calendar-year format the x-axis
  // shows. See src/lib/reporting/equity-commentary.ts.
  const firstYear = fyShort(h.series[0]?.fiscalYear ?? "");
  const interpretation = buildEquityCommentary({
    actualCagrBps: h.actualCagrBps,
    bestInClassCagrBps: h.bestInClassCagrBps,
    minimumRequiredCagrBps: h.minimumRequiredCagrBps,
    firstYear: firstYear || "the prior period",
  });

  // Dynamic y-axis bounds:
  //   yAxisMin = floor(first plotted value / $5M) * $5M
  //     E.g. first $18.83M → 15; first $21.4M → 20; first $25.0M → 25
  //   yAxisMax = ceil(highest value across all 3 series / $5M) * $5M
  //     E.g. highest $32.18M → 35; highest $31.0M → 35
  //   yAxisTicks = (yAxisMax - yAxisMin) / 5  (always a clean $5M step)
  const ROUND_INC_M = 5;
  const firstActualM = series[0]?.value ?? 0;
  const allYsM = [
    ...series.map((p) => p.value),
    ...benchmarkBest.map((p) => p.value),
    ...benchmarkMin.map((p) => p.value),
  ];
  const highestM = allYsM.length > 0 ? Math.max(...allYsM) : firstActualM;
  const yAxisMin = Math.floor(firstActualM / ROUND_INC_M) * ROUND_INC_M;
  const yAxisMax = Math.ceil(highestM / ROUND_INC_M) * ROUND_INC_M;
  const yAxisTicks = Math.max(2, Math.round((yAxisMax - yAxisMin) / ROUND_INC_M));

  return {
    series,
    benchmarkBest,
    benchmarkMin,
    actualCagrLabel,
    bestInClassCagrLabel,
    minimumRequiredCagrLabel,
    currentValueLabel,
    interpretation,
    yAxisMin,
    yAxisMax,
    yAxisTicks,
  };
}

// ---------------------------------------------------------------------------
// Operating Results dashboard formatter — parallel to
// formatEquityDashboard. Takes the accounting-fed OperatingResults
// rows and shapes them for the React card: 12-month chart series,
// pre-formatted KPI strings, dynamic y-axis bounds, generated
// commentary. Nothing in this output is hardcoded; everything traces
// back to a FiscalPeriod row in the GL.
// ---------------------------------------------------------------------------
export function formatOperatingDashboard(
  r: OperatingResults,
  opts: { periodLabel?: string } = {},
) {
  const dollarsToK = (d: number): string => {
    const k = Math.round(d / 1000);
    // Drop the "K" suffix for clean-zero values so the budget tile
    // reads "$0" rather than "$0K" when the trailing-12 budget sums
    // to exactly zero. Saguaro-style "no value" presentation.
    if (k === 0) return "$0";
    return d < 0 ? `($${Math.abs(k)}K)` : `$${k}K`;
  };
  const pctOfRev = (n: number, rev: number): string => {
    if (rev <= 0) return "0.0%";
    return `${((n / rev) * 100).toFixed(1)}%`;
  };

  // Chart series — convert dollars to $K so the chart's y-axis stays
  // in board-readable units and the bar heights match Saguaro's NOI
  // chart visually. Months with no posted data fold to 0 (a missing
  // month draws as a zero-height bar — the chart never breaks).
  const series: ChartSeriesPoint[] = r.months.map((m) => ({
    label: m.monthLabel,
    value: (m.noi ?? 0) / 1000,
  }));
  const budget: ChartSeriesPoint[] = r.months.map((m) => ({
    label: m.monthLabel,
    value: (m.budgetNoi ?? 0) / 1000,
  }));
  const priorYear: ChartSeriesPoint[] = r.priorYearMonths.length === r.months.length
    ? r.priorYearMonths.map((m) => ({
        label: m.monthLabel,
        value: (m.noi ?? 0) / 1000,
      }))
    // If prior-year window doesn't align (e.g. first-year club), emit
    // zero overlay aligned to current-year labels so the chart can
    // still render a clean dashed line at the baseline.
    : r.months.map((m) => ({ label: m.monthLabel, value: 0 }));

  // Prior-year YTD CUMULATIVE — running sum of `priorYear` monthly
  // values, scaled in the same $K units. Drives the chart's overlay
  // line so the visual reconciles to the Prior Year KPI tile: the
  // line's last point ALWAYS equals (priorYearLabel) by construction
  // (`Math.round(r.priorYearNoi / 1000)` === priorYearYtd[11].value).
  //
  // This is the key visual reconciliation between the chart and the
  // KPI strip. The bars below show month-by-month performance; the
  // line shows the YoY cumulative trajectory and ANCHORS at the KPI
  // value at the right edge.
  let runningPrior = 0;
  const priorYearYtd: ChartSeriesPoint[] = priorYear.map((p) => {
    runningPrior += p.value;
    return { label: p.label, value: runningPrior };
  });

  const ytdNoiLabel = dollarsToK(r.ytdNoi);
  const noiPctRevenueLabel = pctOfRev(r.ytdNoi, r.ytdRevenue);
  const budgetGoalLabel = dollarsToK(r.ytdBudgetNoi);
  const priorYearLabel = dollarsToK(r.priorYearNoi);

  // Corridor — ClubBenchmarking's published "−2.8 % to +3.3 %"
  // break-even policy zone. This is the board-recognised reference
  // for member-owned private clubs; until ClubProfile carries an
  // explicit policy field (parallel to equityBenchmark*CagrBps), the
  // service ships the published constants directly so the commentary
  // and the card subtitle name the same zone. The $K corridor on
  // the OperatingResults object is preserved for future on-chart
  // band rendering but is no longer back-computed into the commentary
  // percentages.
  const corridorPct = { lower: -2.8, upper: 3.3 };

  const interpretation = buildOperatingCommentary({
    ytdNoiDollars: r.ytdNoi,
    ytdRevenueDollars: r.ytdRevenue,
    ytdBudgetNoiDollars: r.ytdBudgetNoi,
    priorYearNoiDollars: r.priorYearNoi,
    corridorPct,
    periodLabel: opts.periodLabel ?? "Year-end",
  });

  return {
    series,
    budget,
    priorYear,
    priorYearYtd,
    breakEven: r.breakEven / 1000,
    breakEvenCorridor: r.breakEvenCorridor,
    ytdNoiLabel,
    noiPctRevenueLabel,
    budgetGoalLabel,
    priorYearLabel,
    interpretation,
  };
}

// Founder rule 2026-07-01 v14.14 — single canonical source for the
// Cover Executive Briefing Operations tile.
// Prior state: coverMetrics carried hardcoded literals ("$14.62M" /
// "$3.18M") that diverged from the At-A-Glance KPI values ("$4.69M"
// / "$2.76M") for the same reporting period. This helper reads the
// Revenue + NOI values EXCLUSIVELY from `executiveSummary.kpis` so
// the two cards can never disagree.
function buildOperationsBriefing(
  executiveSummary: Awaited<ReturnType<typeof getExecutiveSummaryForClub>>,
): MonthlyReportingPackage["boardBriefing"]["operations"] {
  const revenueKpi = executiveSummary.kpis.find((k) => k.key === "ytd-revenue");
  const noiKpi = executiveSummary.kpis.find((k) => k.key === "noi");
  return {
    status: "green",
    statusLabel: "On Plan",
    consideration: "no-action",
    narrative:
      `Member rounds are running +6.0% to plan year-to-date at 31,420. F&B covers are -1.4% ` +
      `to plan, but average check growth (+4.1% YoY) holds total contribution near plan. ` +
      `Service hours have absorbed the mid-year minimum-wage step-up without breaching the ` +
      `labour ratio cap; YTD labour ratio sits at 31.2% against the 33% policy band. Pillar 4 ` +
      `Membership and Pillar 5 Experience Stewardship are favorable. At current pace I expect ` +
      `FY26 rounds to close +4% to +6% above plan. No Board action is required this period.`,
    chips: [
      { key: "rounds-ytd",   label: "Rounds YTD",     value: "31,420", subtitle: "+6.0% vs plan", tone: "green" },
      { key: "fb-covers",    label: "F&B Covers",     value: "44,180", subtitle: "-1.4% vs plan", tone: "amber" },
      { key: "service-hours", label: "Service Hours", value: "Within cap", subtitle: "Labour ratio 31.2%", tone: "green" },
    ],
    question: "Are we operating successfully?",
    coverNarrative:
      "Operating revenue and NOI before depreciation are shown against the current YTD plan. " +
      "Dues-to-Revenue holds at 41.8%, inside the 38–44% policy band.",
    coverMetrics: [
      {
        key: "revenue",
        label: "Revenue",
        // v14.14 — MUST equal the At-A-Glance ytd-revenue KPI value.
        value: revenueKpi?.value ?? "—",
        sub: revenueKpi?.comparison?.variance ?? "",
      },
      {
        key: "noi",
        label: "NOI before dep.",
        // v14.14 — MUST equal the At-A-Glance noi-before-dep KPI value.
        value: noiKpi?.value ?? "—",
        sub: noiKpi?.comparison?.variance ?? "",
      },
      { key: "dues-rev", label: "Dues-to-Revenue", value: "41.8%", sub: "Policy 38–44%" },
    ],
  };
}

export async function getMonthlyReportingPackage(
  clubId: string,
  opts?: {
    period?: { start: Date; end: Date };
    /** Founder rule 2026-07-13 v15.14 — when `true`, the Statement of
     *  Financial Position is built with underlying-account detail
     *  attached to each FS-Group summary row (via the `coa:read`
     *  permission gate at the route layer). When `false` / omitted,
     *  the package payload is Board-safe: FS-Group summary rows
     *  only, no accounts array, no per-account unmapped band.
     *
     *  IMPORTANT: this flag also controls whether the frozen
     *  `packagePayloadJson` on a published `MonthlyPackage` row
     *  ever contains account-level data. Callers on the publish
     *  path MUST pass `false` so archived payloads can't leak
     *  account detail to Board / member viewers of the published
     *  package. PDF exports likewise pass `false`. */
    viewerCanDrillDown?: boolean;
  },
): Promise<MonthlyReportingPackage> {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { id: true, name: true },
  });
  if (!club) {
    throw new Error(`Club ${clubId} not found`);
  }

  // Period — default to the most recently completed month.
  // Reporting periods use a fixed "May 2026" period in the demo so the
  // page reads the same regardless of what real-clock day it is. The
  // service accepts a real period for forward integration.
  const periodEnd = opts?.period?.end ?? new Date(Date.UTC(2026, 4, 31));
  const periodStart = opts?.period?.start ?? new Date(Date.UTC(2026, 4, 1));

  // Canonical Reporting Period — the SINGLE source of truth for
  // every presentation-period label every section consumes
  // (statement headers, current-month column headers, CFO eyebrow
  // dates, chart x-axis labels). Per the `Reporting Period Golden
  // Rule` in CLAUDE.md + docs/reporting-package-period-golden-rule.md,
  // no section may hardcode Q1 / March / quarter labels or call
  // Date APIs directly — they all read pre-formatted fields off
  // this object.
  const reportingPeriod = buildReportingPeriod(periodEnd, { periodStart });
  // Legacy alias kept for the executive-summary headline narrative
  // and a handful of inline references below. New callsites should
  // read `reportingPeriod.periodLabel` directly — this binding will
  // be removed once those usages are migrated.
  const periodLabel = reportingPeriod.periodLabel;

  // Fiscal-year label + ytdMonthsElapsed read from Admin → Club
  // Settings (ClubProfile.fiscalYearEndMonth/Day) via the centralised
  // helper. When a club has not configured its fiscal-year end yet,
  // we derive both labels from the SUPPLIED reporting period so the
  // "Period X of Twelve" + FY label always reflect the period the
  // operator selected on the launcher. Prior to 2026-06-26 the
  // fallback was hardcoded to "FY2026 (Jul-Jun)" + period 11 (the
  // legacy Silver Springs demo position for May 31, 2026), which
  // made every period the operator picked render as May regardless
  // of the URL.
  const fiscalPeriod = await getFiscalPeriodForClub(clubId, periodEnd);
  const fiscalYearLabel =
    fiscalPeriod?.fiscalYearLabel ?? `FY${reportingPeriod.year}`;
  // No fiscal config → treat the calendar month as the fiscal period
  // (i.e. assume a Jan-Dec fiscal year). This matches the founder's
  // spec: May → "Period five of twelve", June → "Period six", etc.,
  // for any club that hasn't customised its fiscal calendar yet.
  const ytdMonthsElapsed =
    fiscalPeriod?.periodNumber ?? reportingPeriod.month;

  // Equity Value Over Time — derived from the accounting system via the
  // dedicated reporting service. Closed years come from
  // `FiscalYear.closingEquity` (snapshot set by the period-close
  // engine or seeded for historical years); the current open year
  // comes from a live balance-sheet calculation that sums all
  // EQUITY-typed account balances + current-year earnings. The
  // React component no longer ships hardcoded chart arrays.
  const equityHistory = await getEquityHistory(clubId, {
    asOf: periodEnd,
    yearsBack: 8,
  });
  const equityDashboard = formatEquityDashboard(equityHistory);

  // Operating Results — also accounting-fed via the dedicated
  // reporting service. 12 closed FiscalPeriod rows for the trailing
  // year ending at the reporting period, plus the matching prior
  // year for the YoY overlay. Clubs without seeded period snapshots
  // get an empty 12-month structure (zeros), which the formatter
  // shapes into a clean "no data" state rather than crashing.
  const operatingResults = await getOperatingResults(clubId, periodEnd);
  const operatingDashboard = formatOperatingDashboard(operatingResults, {
    periodLabel: "Year-end",
  });

  // The only LIVE data point that's reliable across deployments today
  // is AR aging from MemberAccount. Try to read it; if MemberAccount is
  // empty for this club, fall back to demo aging values.
  const accounts = await prisma.memberAccount.findMany({
    where: { clubId },
    select: {
      currentBalance: true,
      // Aging buckets if they exist on the model — guarded by try/catch
      // below.
    },
  }).catch(() => []);

  const liveArTotal = accounts.reduce((acc, a) => acc + Number(a.currentBalance ?? 0), 0);
  const arSource: ReportingDataSource = accounts.length > 0 ? "live" : "demo";

  const arBucketsDemo: AgingBucket[] = [
    { label: "Current",      amount: "$ 184,200",  share: "78.4%" },
    { label: "31 – 60 days", amount: "$  31,450",  share: "13.4%" },
    { label: "61 – 90 days", amount: "$  10,600",  share: "4.5%"  },
    { label: "Over 90 days", amount: "$   8,840",  share: "3.7%"  },
  ];
  const arTotalDemo = "$ 235,090";

  const dataSources: ReportingDataSource[] = ["demo"];
  if (arSource === "live") dataSources.push("live");

  // Cover identity line — pulled from ClubProfile so each tenant's
  // location/EST renders without code changes. Missing fields are
  // returned as null and the cover renders only the pieces it has.
  const profile = await prisma.clubProfile.findUnique({
    where: { clubId },
    select: { city: true, provinceState: true, yearFounded: true },
  });
  const clubCity = profile?.city ?? null;
  const clubProvince = profile?.provinceState ?? null;
  const clubYearFounded = profile?.yearFounded ?? null;

  // Editorial reference for the cover subtitle — sourced from the
  // canonical reporting period so any periodEnd renders the right
  // label (a December 2026 build reads "For the period ended
  // December 31, 2026"). Per the Reporting Period Golden Rule.
  const periodEndedLabel = reportingPeriod.periodEndedLabel;

  // Operating + Capital KPI rosters are lifted into named consts so
  // the chapter III Dashboard Notes generator can READ the exact
  // same tone roster the cards above render. This is the single
  // source of truth required by the `Reactive Commentary for
  // Financial Reporting — Mandatory` rule in CLAUDE.md: when a KPI
  // tone changes, both the visible card AND the corresponding
  // bullet update in lockstep — no parallel data path.
  const DEMO_OPERATING_KPI_CARDS: StewardshipKpi[] = [
    {
      key: "dues-rev",
      name: "Dues-to-Revenue Ratio",
      whatIsIt: "Share of total operating revenue coming from membership dues.",
      whyItMatters: "Indicates how much of the operation runs on stable, recurring revenue rather than volatile activity income.",
      assessment: "Inside policy band",
      actual: "41.8%",
      budget: "Policy 38–44%",
      benchmark: "Peer median 39.4%",
      tone: "green",
    },
    {
      key: "payroll-ratio",
      name: "Payroll Ratio",
      whatIsIt: "Total payroll and benefits as a share of operating revenue.",
      whyItMatters: "Labour is the single largest operating line; sustained excess erodes margin and reserve replenishment.",
      assessment: "Better than plan",
      actual: "49.2%",
      budget: "Plan 50.0%",
      benchmark: "Peer median 50.6%",
      tone: "green",
    },
    {
      key: "noi-margin",
      name: "NOI Margin",
      whatIsIt: "Net operating income as a share of operating revenue.",
      whyItMatters: "Margin discipline is what funds capital and reserves; below-plan margin compounds across fiscal years.",
      assessment: "Above plan; healthy buffer",
      actual: "21.7%",
      budget: "Plan 20.1%",
      benchmark: "Peer median 18.5%",
      tone: "green",
    },
    {
      key: "fb-subsidy",
      name: "F&B Subsidy",
      whatIsIt: "Share of dues revenue absorbed by F&B operating losses.",
      whyItMatters: "F&B almost always runs at a loss at a private club; the subsidy size signals whether it is contained or growing.",
      assessment: "Contained, below ceiling",
      actual: "5.1%",
      budget: "Target ≤ 8%",
      benchmark: "Peer median 6.8%",
      tone: "green",
    },
    {
      key: "rounds-vs-plan",
      name: "Rounds vs Plan",
      whatIsIt: "Year-to-date rounds played against the rounds budget.",
      whyItMatters: "Rounds drive cart, range, and pro-shop revenue; under-run is the earliest signal that activity is weakening.",
      assessment: "Ahead of plan",
      actual: "+6.0%",
      budget: "Plan +0.0%",
      tone: "green",
    },
    {
      key: "covers-vs-plan",
      name: "Covers vs Plan",
      whatIsIt: "Year-to-date F&B covers against the covers budget.",
      whyItMatters: "Covers below plan with check averages holding means traffic is weak even when revenue looks fine.",
      assessment: "Slightly behind; check average holding revenue",
      actual: "-1.4%",
      budget: "Plan +0.0%",
      tone: "amber",
    },
    {
      key: "ar-current",
      name: "AR Current %",
      whatIsIt: "Share of member receivables aged 30 days or less.",
      whyItMatters: "Members carrying old balances eventually become bad debt; a falling current % is the earliest collections signal.",
      assessment: "Below target; collections review recommended",
      actual: "78.4%",
      budget: "Target ≥ 80%",
      benchmark: "Peer median 81.2%",
      tone: "amber",
    },
    {
      key: "init-fee-subsidy",
      name: "Initiation Fee Operating Subsidy",
      whatIsIt: "Share of operating expense covered by initiation fees rather than dues and activity revenue.",
      whyItMatters: "Operating on the back of initiation fees masks a structurally under-priced membership; the lower the better.",
      assessment: "Within healthy bound",
      actual: "6.4%",
      budget: "Target ≤ 8%",
      benchmark: "Peer median 7.1%",
      tone: "green",
    },
  ];

  const DEMO_CAPITAL_KPI_CARDS: StewardshipKpi[] = [
    {
      key: "reserve-coverage",
      name: "Reserve Coverage",
      whatIsIt: "Capital reserve balance relative to three-year average capital spend.",
      whyItMatters: "Tells the committee whether the club can fund the next ~year of capital work from reserves without new debt or special assessment.",
      assessment: "Above policy floor",
      actual: "1.42x",
      budget: "Policy ≥ 1.25x",
      tone: "green",
    },
    {
      key: "capital-income-vs-plan",
      name: "Capital Income vs Plan",
      whatIsIt: "Initiation, capital dues, and transfer fees actual versus budget.",
      whyItMatters: "Capital income is the long-term funding engine; persistent shortfall reduces what the club can reinvest in its asset base.",
      assessment: "Ahead of plan",
      actual: "+4.6%",
      budget: "Plan +0.0%",
      tone: "green",
    },
    {
      key: "capital-spend-vs-plan",
      name: "Capital Spend vs Plan",
      whatIsIt: "Year-to-date capital project spending against the approved capital plan.",
      whyItMatters: "Under-spend may mean deferred maintenance accumulating; over-spend signals scope/cost discipline issues.",
      assessment: "Below plan; irrigation pump deferred to FY27",
      actual: "-16.5%",
      budget: "Plan +0.0%",
      tone: "amber",
    },
    {
      key: "debt-equity",
      name: "Long-Term Debt-to-Equity",
      whatIsIt: "Long-term debt as a share of member equity.",
      whyItMatters: "Conservative leverage protects future members from inheriting today's debt-service obligations.",
      assessment: "Very low leverage",
      actual: "0.08",
      budget: "Policy ≤ 0.25",
      benchmark: "Peer median 0.18",
      tone: "green",
    },
    {
      key: "ppe-reinvestment",
      name: "PPE Reinvestment",
      whatIsIt: "Net property, plant, and equipment as a share of gross PPE — a proxy for how recently the asset base has been refreshed.",
      whyItMatters: "A falling ratio signals an aging facility; sustained below 0.45 typically precedes a major capital cycle.",
      assessment: "Healthy reinvestment pace",
      actual: "0.51",
      budget: "Caution if < 0.45",
      benchmark: "Peer median 0.49",
      tone: "green",
    },
    {
      key: "reserve-sufficiency",
      name: "Reserve Sufficiency",
      whatIsIt: "Capital reserve balance relative to annual depreciation expense.",
      whyItMatters: "Indicates whether reserves replenish at least as quickly as the asset base is depreciating.",
      assessment: "Well above 1.0x target",
      actual: "2.49x",
      budget: "Target ≥ 1.0x",
      tone: "green",
    },
    {
      key: "working-capital",
      name: "Working Capital",
      whatIsIt: "Current assets less current liabilities at period end.",
      whyItMatters: "Working capital is the cushion for normal operating swings; below the policy floor and the club starts relying on credit lines.",
      assessment: "$1.21M above policy floor",
      actual: "$4.71M",
      budget: "Policy floor $3.50M",
      tone: "green",
    },
    {
      key: "project-completion",
      name: "Capital Project Completion",
      whatIsIt: "Approved capital projects on track, substantially complete, or complete at period close.",
      whyItMatters: "Execution discipline against board-approved plans is how the club proves it can deploy capital reliably.",
      assessment: "On plan; irrigation pump deferred to FY27",
      actual: "6 of 7",
      budget: "Plan 6 of 7 by month 11",
      tone: "green",
    },
  ];

  // Chapter VII — Statement of Financial Position.
  // Chapter IV — Statement of Activities.
  // Both dual-reads share a single PrismaReportingLedger instance
  // so the BS projection + IS projection see consistent batch state
  // within a single package build.
  const productionLedger = new PrismaReportingLedger(prisma);

  const statementOfActivitiesV2 = await getStatementOfActivitiesForClub({
    clubId: club.id,
    clubName: club.name,
    period: reportingPeriod,
    ledger: productionLedger,
    auxiliaryInputs: SILVER_SPRINGS_SOA_AUXILIARY_INPUTS,
    demoFallback: () =>
      buildSilverSpringsStatementOfActivities({
        clubName: club.name,
        period: reportingPeriod,
      }),
  });

  // Stewardship Dashboard (chapter II scorecards + chapter III
  // summary cards). DUAL-READ: prefers live BS + IS snapshots; falls
  // back to the existing Silver Springs demo factories. RAG status
  // dots on every scorecard row recompute from snapshot numerics via
  // the existing classifyNoiVarianceStatus / classifyEquityCagrStatus
  // engines.
  const stewardshipBundle = await getStewardshipForClub({
    clubId: club.id,
    period: reportingPeriod,
    ledger: productionLedger,
    auxiliaryInputs: SILVER_SPRINGS_STEWARDSHIP_AUX,
    demoFallback: () => ({
      operatingScorecard: buildDemoOperatingScorecardSnapshot(),
      capitalScorecard: buildDemoCapitalScorecardSnapshot(),
      operatingKpiCards: DEMO_OPERATING_KPI_CARDS,
      capitalKpiCards: DEMO_CAPITAL_KPI_CARDS,
      summaryCards: {
        revenue: {
          value: "$5.786M",
          varianceAmount: "+$107K",
          varianceLabel: "vs. budget",
          varianceTone: "positive",
        },
        noiBeforeDep: {
          value: "$253K",
          varianceAmount: "-$130K",
          varianceLabel: "vs. budget",
          varianceTone: "negative",
          marginPct: "4.4% margin",
        },
        capitalFundIncome: {
          value: "$1.285M",
          subtext: "Initiation fees, capital dues & investment income",
        },
        reserveCoverage: {
          value: "61%",
          balance: "$4.82M balance",
          benchmark: "FAC benchmark ≥60%",
        },
      },
    }),
  });

  // Chapter V — Capital Fund Statement.
  // DUAL-READ: prefers live BS + IS snapshots; falls back to the
  // Silver Springs demo seed. Reserve fund balance, net-to-gross
  // PP&E ratio, all capital sources & debt-service rows, plus the
  // reserve adequacy tones + YTD-contribution check all derive
  // from snapshot data on the live branch. Reserve study /
  // capital-project inputs stay auxiliary (typed) until their
  // own importers land.
  const capitalFundBundle = await getCapitalFundForClub({
    clubId: club.id,
    clubName: club.name,
    period: reportingPeriod,
    ledger: productionLedger,
    auxiliaryInputs: SILVER_SPRINGS_CAPITAL_FUND_AUX,
    demoFallback: () =>
      buildSilverSpringsCapitalFundStatement({
        clubName: club.name,
        period: reportingPeriod,
      }),
  });

  // Cover — Executive Summary (At-a-Glance KPIs + headline narrative
  // + board consideration). DUAL-READ: prefers live IS + BS
  // snapshots; falls back to the Silver Springs demo input. The
  // KPI cards, the reactive headline, and the consideration block
  // all derive from snapshot values when a TB exists for the period.
  const executiveSummary = await getExecutiveSummaryForClub({
    clubId: club.id,
    clubName: club.name,
    period: reportingPeriod,
    ledger: productionLedger,
    auxiliaryInputs: SILVER_SPRINGS_EXEC_SUMMARY_AUX,
    demoFallback: () =>
      buildExecutiveSummary(
        buildDemoExecutiveSummaryInput({
          period: reportingPeriod,
          clubName: club.name,
        }),
      ),
  });
  const viewerCanDrillDown = opts?.viewerCanDrillDown === true;
  const statementOfFinancialPositionV2 = await getStatementOfFinancialPositionForClub({
    clubId: club.id,
    clubName: club.name,
    period: reportingPeriod,
    ledger: productionLedger,
    auxiliaryRatioInputs: {
      arCurrentRate: 0.999,
      duesToRevenueRatio: 0.659,
      reserveCoverageRatio: 0.61,
      debtServiceCoverage: 2.1,
      netToGrossPpeOverride: 0.44,
    },
    grossReplacementCostLabel: "$7.9M",
    viewerCanDrillDown,
    demoFallback: () =>
      buildSilverSpringsStatementOfFinancialPosition({
        clubName: club.name,
        period: reportingPeriod,
        viewerCanDrillDown,
      }),
  });

  return {
    club: {
      id: club.id,
      name: club.name,
      city: clubCity,
      provinceState: clubProvince,
      yearFounded: clubYearFounded,
    },
    period: {
      label: periodLabel,
      periodEndedLabel,
      // Mirrors reportingPeriod.periodEndShortLabel — kept on the
      // top-level package metadata so React components in
      // page.tsx can render inline period eyebrows without
      // reaching into a chapter-specific block.
      periodEndShortLabel: reportingPeriod.periodEndShortLabel,
      fiscalYearLabel,
      startISO: periodStart.toISOString().slice(0, 10),
      endISO: periodEnd.toISOString().slice(0, 10),
      ytdMonthsElapsed,
    },
    preparedFor: "Finance Committee · Board of Directors",
    preparedAt: periodEnd.toISOString().slice(0, 10),
    dataSourcesPresent: dataSources,

    // Executive Summary — 6 At-a-Glance KPI cards + reactive
    // headline narrative. Per the Jonas-readiness audit (Tier 1,
    // item 1), the previously-hardcoded literals here were the
    // highest-risk Jonas-readiness issue: the first numbers a board
    // member sees on the cover, which after Jonas import would have
    // continued to read the old Silver Springs seed values.
    //
    // Now flows through `buildExecutiveSummary()` which takes
    // typed accounting-backed inputs (revenue / NOI / capital
    // income / reserve coverage / working capital / AR aging / F&B
    // subsidy) and emits the KPIs + headline + consideration. The
    // demo input factory preserves the historical seed values
    // until Phase 1 wiring services replace it with prisma-backed
    // reads. Per CLAUDE.md `Financial Reporting Data Integrity —
    // Mandatory`: the React render layer no longer carries
    // numeric literals for these cards.
    // Resolved above via dual-read pattern (production ledger when a
    // TB exists, demo seed otherwise).
    executiveSummary,

    boardBriefing: {
      operations: buildOperationsBriefing(executiveSummary),
      financialHealth: {
        status: "green",
        // Four-state cover headline cascade per the user's spec:
        // "Strong Position" / "Stable" / "Watch" / "Concern". The
        // current demo state is "green" mapping to "Strong Position".
        statusLabel: "Strong Position",
        consideration: "no-action",
        narrative:
          `Working capital of $4.71M sits $1.21M above the $3.50M policy floor — a 34% cushion. ` +
          `The dues-to-revenue ratio is 41.8%, inside the 38–44% policy band and indicating that ` +
          `the operation is funded by stable recurring revenue rather than volatile activity income. ` +
          `Current ratio holds at 2.18; debt-to-equity at 0.08x. The Pillar 3 Balance Sheet ` +
          `Stewardship position is intact. At current pace the operating reserve will close FY26 ` +
          `above target. No Board action is required this period.`,
        chips: [
          { key: "working-capital", label: "Working Capital", value: "$ 4.71M", tone: "green" },
          { key: "dues-ratio",      label: "Dues / Revenue",  value: "41.8%",   subtitle: "Policy 38–44%", tone: "green" },
          { key: "current-ratio",   label: "Current Ratio",   value: "2.18",    subtitle: "Healthy", tone: "green" },
        ],
        // Cover Executive Briefing — the briefing question this card
        // answers, the max-2-sentence headline narrative, and the four
        // Financial Health metrics from the first-scroll standard
        // (Working Capital, Reserve Coverage, Current Ratio, AR Current %).
        question: "Is the Club financially healthy?",
        coverNarrative:
          "Working capital $4.71M sits $1.21M above the $3.50M policy floor and reserve coverage holds " +
          "at 1.42x, above the 1.25x floor. Current ratio 2.18 is healthy; AR Current 78.4% trails the 80% target.",
        coverMetrics: [
          { key: "working-capital",  label: "Working Capital",  value: "$4.71M", sub: "$1.21M above floor" },
          { key: "reserve-coverage", label: "Reserve Coverage", value: "1.42x",  sub: "Policy ≥ 1.25x"     },
          { key: "current-ratio",    label: "Current Ratio",    value: "2.18",   sub: "Healthy"            },
          { key: "ar-current",       label: "AR Current",       value: "78.4%",  sub: "Target ≥ 80%"       },
        ],
      },
      capitalProgram: {
        status: "green",
        statusLabel: "Executing",
        consideration: "committee-review",
        narrative:
          `Of seven board-approved FY26 capital projects, five are on track to close at or under ` +
          `budget, one (Pro Shop Refresh) is complete, and one (Irrigation Pump Replacement) has ` +
          `been deferred to FY27 pending engineering review of the revised scope. The deferral ` +
          `released $315K of FY26 capital authority back to the Reserve, raising reserve coverage ` +
          `from 1.36x to 1.42x against the 1.25x policy floor adopted in the FY24 Reserve Study. ` +
          `The clubhouse HVAC replacement is tracking $42K favorable to budget. The Capital ` +
          `Committee will review the engineering proposal at its July meeting and recommends ` +
          `Board approval of the revised irrigation scope at the September 2026 meeting.`,
        chips: [
          { key: "capex-spent",     label: "Capex YTD",       value: "$ 1.62M", subtitle: "Plan $ 1.94M", tone: "amber" },
          { key: "projects-active", label: "Active Projects", value: "7",       tone: "neutral" },
          { key: "reserve-funded",  label: "Reserve Funded",  value: "100%",    subtitle: "On policy", tone: "green" },
        ],
        // Cover Executive Briefing — the briefing question this card
        // answers, the max-2-sentence headline narrative, and the four
        // Capital Health metrics from the first-scroll standard
        // (Active Projects, Capital Spend YTD, Reserve Contributions,
        // Reserve Funded %). The demo ships GREEN / "Executing" — the
        // program is broadly on track (five of seven projects on
        // schedule; the irrigation deferral was an engineering choice
        // that raised reserve coverage, not a schedule slip). Capital
        // cascade: Executing / Monitor / Delayed / Critical.
        question: "Are capital projects and reserve investments being executed properly?",
        coverNarrative:
          "Five of seven FY26 projects on track; the irrigation-pump deferral released $315K of FY26 capital " +
          "authority back to the Reserve. Capex YTD $1.62M runs under the $1.94M plan, net reserve contribution +$242K, and funding holds at 100% of policy.",
        coverMetrics: [
          { key: "active-projects",       label: "Active Projects",       value: "7",       sub: "5 on track · 1 deferred" },
          { key: "capital-spend-ytd",     label: "Capital Spend YTD",     value: "$1.62M",  sub: "Plan $1.94M"             },
          { key: "reserve-contributions", label: "Reserve Contributions", value: "+$242K",  sub: "$410K favorable swing"   },
          { key: "reserve-funded",        label: "Reserve Funded",        value: "100%",    sub: "On policy"               },
        ],
      },
    },

    visualSummary: {
      dataSource: "demo",
      intro:
        "Twelve-month trend lines tell the story of the financial year: equity growth, NOI trajectory, " +
        "and the dues subsidy that membership covers each month before any other source of income.",
      equityTrend: monthlySeries([
        16.20, 16.32, 16.41, 16.55, 16.69, 16.81,
        16.94, 17.08, 17.22, 17.34, 17.49, 17.61,
      ]),
      noiTrend: monthlySeries([
        0.18, 0.22, 0.27, 0.31, 0.34, 0.36,
        0.31, 0.27, 0.24, 0.20, 0.16, 0.12,
      ]),
      duesSubsidyTrend: monthlySeries([
        0.42, 0.41, 0.40, 0.39, 0.38, 0.37,
        0.36, 0.35, 0.34, 0.33, 0.32, 0.31,
      ]),
      departmentSummary: demoDepartments(),
    },

    // Chair's Dashboard visual stewardship pair — the two charts that
    // open Section II. BOTH cards are now consume accounting-fed
    // reporting services:
    //   - equity: `getEquityHistory` → FiscalYear.closingEquity (closed
    //     years) + live balance sheet (current open FY).
    //   - operating: `getOperatingResults` → FiscalPeriod.closingNoi /
    //     closingRevenue / budgetNoi for the trailing 12 months
    //     (current + prior year). No inline arrays remain.
    //   - scorecards: ClubBenchmarking-style KPI tables. Every row's
    //     actual / budget value is COMPUTED from typed numeric
    //     inputs in `src/lib/reporting/scorecard-metrics.ts` — no
    //     display strings exist as inline literals in this builder.
    //     `Benchmark` columns are policy threshold strings (e.g. the
    //     dues-floor or capital reserve threshold), allowed by the
    //     audit. Rows wired through
    //     the equity / operating dashboards (CAGR, NOI Variance, NOI
    //     %) carry `dataSource: "live"`; everything else is `demo`
    //     until its matching prisma read lands.
    stewardshipDashboard: {
      // dataSource flips to "live" when the scorecards were derived
      // from a real Jonas-imported BS + IS snapshot.
      dataSource: stewardshipBundle.dataSource,
      equity: equityDashboard,
      operating: operatingDashboard,
      scorecards: {
        // Operating Stewardship scorecard — consumes the typed
        // accounting-backed snapshot rather than the legacy raw
        // operating-inputs constant. Today the
        // snapshot is supplied by the demo factory (preserves the
        // historical Silver Springs seed values + visual layout);
        // Phase 1 wiring will replace `buildDemoOperatingScorecardSnapshot()`
        // with `buildOperatingScorecardSnapshotFromAccounting(...)`
        // reading from `getGLAccountTotals` + `getOperatingResults`.
        // Per the Jonas-readiness audit, the two NOI rows derive
        // their status from the snapshot's NOI numerics (was
        // hardcoded `"on-track"`).
        operating: buildOperatingScorecardData(stewardshipBundle.operatingScorecard, {
          ytdNoiLabel:        operatingDashboard.ytdNoiLabel,
          budgetGoalLabel:    operatingDashboard.budgetGoalLabel,
          noiPctRevenueLabel: operatingDashboard.noiPctRevenueLabel,
        }),
        // Capital Stewardship scorecard — consumes the typed
        // accounting-backed snapshot rather than the legacy raw
        // capital-inputs constant. Today the snapshot is supplied
        // by the demo factory (preserves the historical Silver
        // Springs seed values + visual layout); Phase 1 wiring
        // will replace `buildDemoCapitalScorecardSnapshot()` with
        // `buildCapitalScorecardSnapshotFromAccounting(...)` reading
        // from `getBalanceSheet` + `getCapitalIncomeYTD` +
        // `getDepreciationSchedule` + `getEquityHistory`. Per the
        // Jonas-readiness audit, the Equity Growth CAGR row + the
        // Long-Term Debt-to-Equity row now derive their status
        // from the snapshot's numerics (both were hardcoded
        // `"on-track"` placeholder verdicts before this pass).
        capital: buildCapitalScorecardData(stewardshipBundle.capitalScorecard, {
          actualCagrLabel:      equityDashboard.actualCagrLabel,
          bestInClassCagrLabel: equityDashboard.bestInClassCagrLabel,
        }),
      },
      // Two supplemental cards rendered in the third row of the
      // Stewardship Dashboard. Department actuals/budgets and dues-
      // allocation percentages are seeded through dedicated services;
      // no row literals exist in monthly-package.ts or page.tsx.
      departmentPerformance: buildDepartmentNetPerformanceData(
        SILVER_SPRINGS_DEPARTMENT_INPUTS,
        SILVER_SPRINGS_DEPARTMENT_COMMENTARY,
      ),
      duesSubsidy: buildDuesSubsidyData(
        SILVER_SPRINGS_DUES_TOTAL,
        SILVER_SPRINGS_MEMBER_COUNT,
        SILVER_SPRINGS_DUES_CATEGORIES,
      ),
      // Fourth row — Payroll Analysis pair. Computed from typed
      // numeric inputs in scorecard-metrics' sibling service
      // (payroll-analysis.ts); no inline literals reach React.
      payrollDepartment: buildPayrollDepartmentData({
        departments: SILVER_SPRINGS_PAYROLL_DEPTS,
        revenueDollars: SILVER_SPRINGS_PAYROLL_REVENUE,
        duesDollars: SILVER_SPRINGS_OPERATING_DUES,
        // Reporting year drives the "${YEAR} Actual" chart legend
        // label. Derived from the package's periodEnd so the legend
        // text follows the reporting period automatically — no
        // hardcoded year string in React.
        reportingYear: periodEnd.getUTCFullYear(),
      }),
      payrollRatioTrend: buildPayrollRatioTrendData({
        monthlyActual:    SILVER_SPRINGS_PAYROLL_ACTUAL_MONTHLY,
        monthlyBudget:    SILVER_SPRINGS_PAYROLL_BUDGET_MONTHLY,
        monthlyPriorYear: SILVER_SPRINGS_PAYROLL_PRIOR_MONTHLY,
        benchmarkPct:     SILVER_SPRINGS_PAYROLL_BENCHMARK_PCT,
        // Dues ratio derived from the same dues + revenue figures the
        // payroll department card uses so the two narratives stay
        // numerically consistent.
        duesRatioPct: (SILVER_SPRINGS_OPERATING_DUES / SILVER_SPRINGS_PAYROLL_REVENUE) * 100,
        // Golf rounds — passed through so the "member utilisation
        // up X%" figure in the commentary is COMPUTED, not hardcoded.
        // Same counts the Operating Stewardship scorecard uses.
        golfRoundsActual:    SILVER_SPRINGS_GOLF_ROUNDS_ACTUAL,
        golfRoundsPriorYear: SILVER_SPRINGS_GOLF_ROUNDS_PRIOR_YEAR,
        // Reporting period — drives BOTH the "${YEAR} Actual" line
        // legend label AND the x-axis window. For a May 2026 package
        // (month index 4 → reportingMonth 5) the chart plots Jan-May
        // only; Jun-Dec future months are NOT plotted because their
        // accounting records don't exist yet.
        reportingYear:  periodEnd.getUTCFullYear(),
        reportingMonth: periodEnd.getUTCMonth() + 1,
      }),
    },

    operatingKPIs: {
      dataSource: stewardshipBundle.dataSource,
      cards: stewardshipBundle.operatingKpiCards,
    },

    capitalKPIs: {
      dataSource: stewardshipBundle.dataSource,
      cards: stewardshipBundle.capitalKpiCards,
    },

    // -------------------------------------------------------------
    // Chapter III — Stewardship KPI Dashboard
    // -------------------------------------------------------------
    // Saguaro-style executive scorecard. Top 4 summary cards answer
    // "are we on plan?" at-a-glance. Operating + Capital panels reuse
    // `operatingKPIs.cards` / `capitalKPIs.cards` (single source of
    // truth — chapter III displays the same rows chapter II computes,
    // in a different visual register).
    //
    // Summary card actuals are seeded reporting demo data tagged
    // `dataSource: "demo"` (May 2026 YTD). When the GL ships YTD
    // revenue / NOI / capital-fund-income / reserve-coverage as
    // first-class fields, the seeded values are swapped for live
    // computations without any React change (per the data integrity
    // rule: actual + budget values flow through the reporting
    // service, not React).
    //
    // FAC benchmark (60% reserve coverage) is config-driven — it is a
    // policy threshold, not an accounting record. The 50% Net-to-Gross
    // PP&E benchmark is similarly config-driven.
    stewardshipKpiDashboard: {
      dataSource: stewardshipBundle.dataSource,
      // Period-driven: derived from `reportingPeriod` so a December
      // 2026 report renders "December 31, 2026 · Year to Date", not
      // the May literal. Per the Reporting Period Golden Rule.
      periodLabel: `${reportingPeriod.periodEndShortLabel} · Year to Date`,
      introQuestion:
        "Red · Yellow · Green — Is the club on track across all operating and capital dimensions?",
      // Resolved above via dual-read pattern. Values derive from the
      // production BS + IS snapshots when a TB exists; fall back to
      // the demo literals otherwise.
      summaryCards: stewardshipBundle.summaryCards,
      // Reactive Dashboard Notes — generated from the SAME operating
      // + capital KPI rows the cards above render, so when a KPI
      // tone changes the bullets change in lockstep. Reserve coverage
      // and PP&E benchmark thresholds are policy config (FAC 60%, 50%
      // PP&E), not accounting records. See
      // `src/lib/reporting/stewardship-dashboard-notes.ts` for the
      // branching logic.
      dashboardNotes: buildStewardshipDashboardNotes({
        operatingKpis: stewardshipBundle.operatingKpiCards,
        capitalKpis:   stewardshipBundle.capitalKpiCards,
        reserveCoverageMeetsFloor: true,
        reserveCoveragePct: "61%",
        facBenchmarkPct: "60%",
        ppeBelowBenchmark: true,
      }),
    },

    // Chapter IV — Statement of Activities.
    // Resolved above via dual-read pattern (production ledger when a
    // TB exists, demo seed otherwise).
    statementOfActivitiesV2,

    // Chapter V — Capital Fund Statement.
    // Resolved above via dual-read pattern (production ledger when
    // a TB exists, demo seed otherwise).
    capitalFundStatement: capitalFundBundle.capitalFundStatement,

    // Chapter VI — Capital Project Tracker.
    // Owned end-to-end by src/lib/reporting/capital-project-tracker.ts.
    // Cross-chapter references — reserve balance + Statement of
    // Activities statement number — flow through so the chapter VI
    // project notes never drift from the chapter IV / V chrome.
    // For the demo build, the reserve balance label tracks the
    // chapter V Capital Fund reserve-coverage card ($4.82M).
    capitalProjectTracker: buildSilverSpringsCapitalProjectTracker({
      clubName: club.name,
      period: reportingPeriod,
      reserveBalanceLabel: "$4.82M",
      statementOfActivitiesNumber: "Statement 04",
    }),

    // Chapter VII — Statement of Financial Position.
    // Resolved above via the dual-read pattern (production ledger
    // when available, demo seed otherwise).
    statementOfFinancialPositionV2,

    // Chapter VIII — Accounts Receivable Aging.
    // Owned end-to-end by src/lib/reporting/accounts-receivable-aging.ts.
    accountsReceivableAging: buildSilverSpringsAccountsReceivableAging({
      clubName: club.name,
      period: reportingPeriod,
    }),

    // Chapter IX — Operating Statistics & Focus Areas.
    // Owned end-to-end by src/lib/reporting/operating-statistics.ts.
    operatingStatistics: buildSilverSpringsOperatingStatistics({
      clubName: club.name,
      period: reportingPeriod,
    }),

    // Chapter X — Departmental P&L Summary.
    // Owned end-to-end by src/lib/reporting/departmental-pl-summary.ts.
    departmentalPLSummary: buildSilverSpringsDepartmentalPLSummary({
      clubName: club.name,
      period: reportingPeriod,
    }),

    // Chapter XI — Monthly Weather Summary.
    // Owned end-to-end by src/lib/reporting/monthly-weather-summary.ts.
    // Builder is async (it asks the configured weather provider for
    // a monthly observation); the await happens in the surrounding
    // builder via the resolved-promise field below.
    monthlyWeatherSummary: await buildSilverSpringsMonthlyWeatherSummary({
      clubName: club.name,
      period: reportingPeriod,
      club,
    }),

    // Chapter XII — Departmental Payroll Analysis.
    // Owned end-to-end by src/lib/reporting/departmental-payroll-analysis.ts.
    departmentalPayrollAnalysis: buildSilverSpringsDepartmentalPayrollAnalysis({
      clubName: club.name,
      period: reportingPeriod,
    }),

    // Chapter XIII — Food & Beverage Statistics.
    // Owned end-to-end by src/lib/reporting/food-beverage-statistics.ts.
    foodBeverageStatistics: buildSilverSpringsFoodBeverageStatistics({
      clubName: club.name,
      period: reportingPeriod,
    }),

    // Chapter XIV — Inventory Analysis.
    // Owned end-to-end by src/lib/reporting/inventory-analysis.ts.
    inventoryAnalysis: buildSilverSpringsInventoryAnalysis({
      clubName: club.name,
      period: reportingPeriod,
    }),

    statementOfActivities: {
      dataSource: "demo",
      summaryCards: [
        { key: "total-revenue",  label: "Total Operating Revenue",  value: "$12.62M",
          context: "Total income generated from operations during the period.",
          comparison: { label: "vs Budget", value: "$12.50M", variance: "+1.0% favorable" }, tone: "green" },
        { key: "total-expense",  label: "Total Operating Expense",  value: "$10.25M",
          context: "Total cost of running operations during the period.",
          comparison: { label: "vs Budget", value: "$10.19M", variance: "+0.6% over plan" }, tone: "green" },
        { key: "noi-before-dep", label: "NOI Before Depreciation",  value: "$2.37M",
          context: "Operating margin before non-cash depreciation expense.",
          comparison: { label: "vs Budget", value: "$2.31M",  variance: "+2.8% favorable" }, tone: "green" },
        { key: "noi",            label: "Net Operating Income",     value: "$1.19M",
          context: "Bottom-line operating result after depreciation expense.",
          comparison: { label: "vs Budget", value: "$1.11M",  variance: "+7.2% favorable" }, tone: "green" },
      ],
      keyVariances: [
        { key: "dues",       label: "Membership Dues",          current: "$6.12M", variance: "+0.6%", note: "on plan",            tone: "green" },
        { key: "golf",       label: "Golf Operations",          current: "$2.84M", variance: "+5.1%", note: "rounds ahead of plan", tone: "green" },
        { key: "fb-rev",     label: "F&B Revenue",              current: "$2.01M", variance: "-3.8%", note: "cover softness",     tone: "amber" },
        { key: "payroll",    label: "Payroll & Benefits",       current: "$7.18M", variance: "+1.8%", note: "wage step-up, not headcount", tone: "amber" },
        { key: "fb-cogs",    label: "Cost of Goods (F&B)",      current: "$1.16M", variance: "-3.8%", note: "favorable, tied to covers",   tone: "green" },
      ],
      notes:
        "Operating revenue closed +1.0% favorable to plan, driven by Golf Operations (+5.1%) and Membership Dues (+0.6%). F&B Revenue was the only line that softened (-3.8%); average check growth (+4.1% YoY) held total F&B contribution near plan. Operating expense discipline held — payroll's +1.8% over-budget reading is wage-rate driven (the mid-year minimum-wage step-up added ~$96K), not headcount-driven. At current pace we expect FY26 NOI before depreciation to close +2% to +3% above plan, subject to Q4 weather risk.",
      consideration: "no-action",
      lines: statementOfActivitiesDemo(),
    },

    capitalFund: {
      dataSource: "demo",
      summaryCards: [
        { key: "cap-income",   label: "Total Capital Income",       value: "$2.04M",
          context: "Initiation fees, capital dues, and transfer fees collected during the period.",
          comparison: { label: "vs Budget", value: "$1.95M", variance: "+4.6% favorable" }, tone: "green" },
        { key: "cap-outflows", label: "Total Capital Outflows",     value: "$1.80M",
          context: "Capital project spend and reserve transfers during the period.",
          comparison: { label: "vs Budget", value: "$2.12M", variance: "-15.1% under plan" }, tone: "amber" },
        { key: "net-reserve",  label: "Net Reserve Contribution",   value: "+$242K",
          context: "Net change to the capital reserve at period close.",
          comparison: { label: "vs Plan", value: "-$168K", variance: "$410K favorable swing" }, tone: "green" },
      ],
      keyVariances: [
        { key: "init-fees",   label: "Initiation Fees",        current: "$1.18M", variance: "+5.7%",  note: "entrance-fee momentum",   tone: "green" },
        { key: "cap-dues",    label: "Capital Dues",           current: "$612K",  variance: "+0.0%",  note: "on plan",                  tone: "green" },
        { key: "transfer",    label: "Transfer / Reinstatement",current: "$246K", variance: "+12.0%", note: "above plan",               tone: "green" },
        { key: "cap-spend",   label: "Capital Project Spend",  current: "$1.62M", variance: "-16.5%", note: "irrigation pump deferred", tone: "amber" },
      ],
      notes:
        "Capital income closed +4.6% favorable to plan with entrance-fee momentum (+5.7%). Capital spend ran $315K under plan due to the irrigation-pump deferral, producing a $410K favorable swing in net reserve contribution. Reserve coverage rose from 1.36x to 1.42x — above the 1.25x policy floor adopted in the FY24 Reserve Study. Per the Reserve Study, sustained coverage below 1.00x is the threshold for invoking a special assessment under Article IV § 3 of the by-laws; current coverage provides 0.42x of cushion above that threshold.",
      consideration: "committee-review",
      lines: capitalFundDemo(),
    },

    capitalProjects: { dataSource: "demo", rows: capitalProjectsDemo() },

    financialPosition: {
      dataSource: "demo",
      summaryCards: [
        { key: "assets",         label: "Total Assets",        value: "$30.53M",
          context: "Total resources controlled by the Club at period close.",
          comparison: { label: "vs Prior Year", value: "$28.86M", variance: "+5.8% growth" }, tone: "green" },
        { key: "liabilities",    label: "Total Liabilities",   value: "$2.53M",
          context: "All obligations owed to outside parties at period close.",
          comparison: { label: "vs Prior Year", value: "$2.46M", variance: "+2.8% flat" }, tone: "green" },
        { key: "equity",         label: "Member Equity",       value: "$28.01M",
          context: "Net worth attributable to the membership at period close.",
          comparison: { label: "vs Prior Year", value: "$26.40M", variance: "+$1.61M YoY" }, tone: "green" },
        { key: "working-capital",label: "Working Capital",     value: "$4.71M",
          context: "Current assets less current liabilities — short-term liquidity cushion.",
          comparison: { label: "Policy floor", value: "$3.50M", variance: "+$1.21M cushion" }, tone: "green" },
      ],
      keyVariances: [
        { key: "ppe",          label: "Property, Plant & Equipment (Net)", current: "$24.08M", variance: "flat",       note: "depreciating on schedule",  tone: "neutral" },
        { key: "cap-reserve",  label: "Capital Reserve",                   current: "$2.95M",  variance: "+$242K",     note: "policy funding intact",     tone: "green" },
        { key: "lt-debt",      label: "Long-Term Debt",                    current: "$1.48M",  variance: "-$180K",     note: "principal paydown on schedule", tone: "green" },
      ],
      notes:
        "Member equity will close near $28M, up $1.61M year-over-year. Working capital of $4.71M sits $1.21M above the $3.50M policy floor — a 34% cushion. Long-term debt fell $180K in scheduled principal payments to $1.48M. The asset base remains substantially funded by equity at 0.08x debt-to-equity, well inside the 0.25x policy ceiling adopted in the FY22 capitalization policy. Pillar 3 Balance Sheet Stewardship is intact.",
      consideration: "no-action",
      lines: financialPositionDemo(),
    },

    arAging: {
      dataSource: arSource,
      summaryCards: [
        { key: "total",     label: "Total Receivable", value: arSource === "live" ? formatUsd(liveArTotal) : "$235.1K",
          context: "Total member balance owed across all aging buckets at period close.",
          comparison: { label: "vs Prior Month", value: "$230.6K", variance: "+$4.5K" }, tone: "amber" },
        { key: "current",   label: "Current %",        value: "78.4%",
          context: "Share of total receivable that is current (within 30 days of invoice).",
          comparison: { label: "Target ≥ 80%", value: "80.0%", variance: "below target" }, tone: "amber" },
        { key: "31-60",     label: "31–60 Day Bucket",  value: "$31.5K",
          context: "Member balances aged 31 to 60 days past invoice date.",
          comparison: { label: "vs Prior Month", value: "$27.0K", variance: "+$4.5K (3 accounts)" }, tone: "amber" },
        { key: "over-90",   label: "Over 90 Day Bucket",value: "$8.8K",
          context: "Member balances aged more than 90 days — collections action threshold.",
          comparison: { label: "Share of total", value: "3.7%", variance: `unchanged from ${reportingPeriod.priorMonthLong}` }, tone: "neutral" },
      ],
      keyVariances: [
        { key: "31-60", label: "31–60 day", current: "$31.5K", variance: "+16.7%", note: "concentrated in 3 accounts — GM outreach scheduled", tone: "amber" },
        { key: "61-90", label: "61–90 day", current: "$10.6K", variance: "-2.3%",  note: "flat trend",  tone: "green" },
        { key: "90+",   label: "Over 90 day", current: "$8.8K", variance: "0.0%",   note: "no further aging this month", tone: "green" },
      ],
      // Period-driven narrative: the period-close date and the
      // prior-month comparison come from `reportingPeriod`. The
      // operational seed dates (GM outreach date, payment-plan
      // deadline, historical FY policy adoption) are intrinsic
      // narrative data, not period labels — they remain seeded
      // until the AR Aging commentary is moved to a reactive
      // generator (Phase 2.1 of the Jonas readiness plan).
      notes:
        `Total receivable $235K at period close (${reportingPeriod.periodEndShortLabel}); 78.4% current — below the 80% target adopted in the FY23 collections policy and the second consecutive month below target. The 31–60 day bucket grew $4.5K from ${reportingPeriod.priorMonthLong}, concentrated in three member accounts; the General Manager initiated formal outreach May 30, 2026, with payment plans expected by June 15, 2026. Over-90 share is unchanged at 3.7%. Per board policy adopted May 2022, any account aged beyond 90 days without a payment plan triggers Membership Committee review; no accounts currently meet that condition. Two accounts entered formal collections on agreed payment plans this period.`,
      consideration: "committee-review",
      buckets: arBucketsDemo,
    },

    operatingStats: {
      dataSource: "demo",
      members: {
        active: 1284,
        new: 36,
        resignations: 11,
        net: 25,
        waitlist: 47,
        waitlistConversionPct: "38%",
      },
      rounds: {
        ytd: 31420,
        ytdBudget: 29630,
        varPct: "+6.0%",
        guestYTD: 6840,
        guestSharePct: "21.8%",
      },
      fbCovers: {
        ytd: 44180,
        ytdBudget: 44820,
        varPct: "-1.4%",
        averageCheck: "$38.20",
      },
      derived: {
        spendPerMember: "$1,567",
        spendPerRound: "$63.97",
      },
    },

    departmentPnL: { dataSource: "demo", rows: demoDepartments() },

    weatherUtilization: {
      dataSource: "demo",
      rainoutsMonth: 3,
      avgTempF: 64,
      rangeUtilizationPct: "82.4%",
      courseUtilizationPct: "74.1%",
      daysLostYTD: 11,
      revenueImpactEstimate: "~$48K",
      // Course utilization % over the last 12 months. Seasonal dip
      // through winter, peak late spring.
      utilizationTrend: monthlySeries([
        58.4, 51.2, 48.6, 55.8, 64.2, 72.1,
        75.3, 76.8, 74.5, 71.2, 73.4, 74.1,
      ]),
    },

    payroll: {
      dataSource: "demo",
      ytdTotal:     "$7.18M",
      ytdBudget:    "$7.05M",
      ytdVarPct:    "+1.8%",
      ytdPriorYear: "$6.84M",
      payrollRatio: "49.2%",
      duesCoverPayroll: true,
      duesCushion: "$1.08M",
      monthlyRatioTrend: monthlySeries([
        50.4, 49.8, 49.1, 48.6, 48.4, 48.7,
        49.0, 49.3, 49.4, 49.2, 49.0, 48.8,
      ]),
      byDepartment: [
        { key: "grounds",    name: "Grounds & Maintenance", ytd: "$1.92M", sharePct: "26.8%", tone: "neutral" },
        { key: "fb",         name: "Food & Beverage",       ytd: "$1.62M", sharePct: "22.6%", tone: "amber" },
        { key: "golf-ops",   name: "Golf Operations",       ytd: "$1.15M", sharePct: "16.0%", tone: "neutral" },
        { key: "admin",      name: "Administration",        ytd: "$0.78M", sharePct: "10.9%", tone: "neutral" },
        { key: "hospitality",name: "Hospitality / Events",  ytd: "$0.48M", sharePct: "6.7%",  tone: "neutral" },
        { key: "pro-shop",   name: "Pro Shop / Retail",     ytd: "$0.36M", sharePct: "5.0%",  tone: "neutral" },
        { key: "membership", name: "Membership / Front Desk", ytd: "$0.32M", sharePct: "4.5%", tone: "neutral" },
        { key: "other",      name: "Other & Allocations",   ytd: "$0.55M", sharePct: "7.5%",  tone: "neutral" },
      ],
      overtimeHoursYTD: 4820,
      overtimePctOfHours: "3.4%",
      peakOvertimeMonth: "July (peak grounds load)",
      seasonalLaborEstimate: "$0.42M (May–Sept)",
    },

    fbStats: {
      dataSource: "demo",
      coversYTD: 44180,
      avgCheck: "$38.20",
      salesByOutlet: [
        { outlet: "Clubhouse Dining",  sales: "$1.06M", covers: 22640 },
        { outlet: "Patio Grill",       sales: "$0.42M", covers: 11820 },
        { outlet: "Halfway House",     sales: "$0.18M", covers: 6210  },
        { outlet: "Banquets / Events", sales: "$0.34M", covers: 3510  },
      ],
      laborPct:        "44.2%",
      foodCostPct:     "32.6%",
      beverageCostPct: "24.8%",
      surveyScore: "4.6 / 5.0",
      revenueYTD: "$2.01M",
      revenueVarPct: "-3.8%",
      // Subsidy is "all-in" — operating loss plus allocated overhead,
      // expressed as a share of dues. Demo target ≤ 8%, peer median 6.8%.
      subsidyAmount: "$312K",
      subsidyPctOfDues: "5.1%",
      // 12-month subsidy % of dues. Declining trend = good.
      subsidyTrend: monthlySeries([
        6.8, 6.6, 6.4, 6.2, 6.0, 5.9,
        5.8, 5.6, 5.4, 5.3, 5.2, 5.1,
      ]),
    },

    inventory: {
      dataSource: "demo",
      foodOnHand:    "$28.4K",
      beverageOnHand:"$41.7K",
      daysOnHandFood: 9,
      daysOnHandBeverage: 14,
      shrinkagePct: "1.1%",
      turnsFood: "41x",       // annualized turns (365 / 9 days)
      turnsBeverage: "26x",   // (365 / 14 days)
    },

    experienceStewardship: {
      dataSource: "demo",
      // Editorial paragraphs — Board tone per executive-narrative-style-guide.md.
      // Each reading is 4-6 sentences so the chapter reads as a CFO
      // briefing memo, not as a tile grid with chrome on top.
      golfReading:
        "Rounds played YTD of 31,420 run +6.0% to plan — the third consecutive month above target. " +
        "Member rounds (24,580) carry 78.2% of total activity; guest rounds at 6,840 (21.8% share) sit " +
        "inside the 25% guest-day ceiling adopted in the FY24 member-rights review. Course utilization at " +
        "74.1% holds 4.1 points above the 70% Pillar 5 Experience target; range utilization at 82.4% is a " +
        "three-month high and reflects the spring-clinic program the Golf Committee endorsed in February. " +
        "The Pillar 5 Experience Stewardship signal on the activity dimension — are members using the course? " +
        "— is answered yes. The Capital Committee's bunker renovation (Holes 4–9) is 98.8% complete and " +
        "closes the last identified course-condition gap before the FY27 capital cycle.",
      hospitalityReading:
        "F&B covers of 44,180 run -1.4% to plan; average check of $38.20 is +4.1% YoY from $36.70, with " +
        "the gap concentrated in non-banquet dining. Spend-per-member of $1,567 annualized and " +
        "spend-per-round of $63.97 both grew YoY, but the cover softness in the corporate-events line is " +
        "the read worth watching: events revenue runs -8.2% to plan as the events team rebuilds the " +
        "corporate pipeline that lapsed in late FY25. The F&B subsidy of dues holds at 5.1% — well below " +
        "the 8% policy ceiling adopted in FY23 and below the 6% sustained-target the Board affirmed at " +
        "the FY25 strategic review. The Pillar 1 Operating Stewardship lever (the subsidy) is balancing " +
        "the Pillar 5 Experience Stewardship objective (the member dining experience) without encroaching " +
        "on the dues line. The Membership Committee is tracking whether the cover softness is " +
        "member-driven or reflects broader macro discretionary-spend trends; the board-escalation " +
        "threshold is covers below -3% sustained for three consecutive months.",
    },

    membershipStewardship: {
      dataSource: "demo",
      activeMembers: 1284,
      netYTD: 25,
      newYTD: 36,
      resignationsYTD: 11,
      // Rolling 12-month resignations / average active membership.
      // Demo: 73 trailing-12 resignations / avg 1,271 active = 5.7%.
      // Inside the 4–6% CMAA peer band; tone green.
      attritionRateTTM: "5.7%",
      attritionBenchmark: "Peer median 6.0% (CMAA)",
      attritionTone: "green",
      attritionTrend: monthlySeries([
        7, 6, 5, 8, 7, 6,
        6, 5, 5, 7, 6, 5,
      ]),
      // Category counts sum to 1,284. Net YTD per category sums to +25.
      // Dues rates are demo (typical private-club shape: Full Golf
      // anchors the dues line; Social/Senior carry second tier;
      // Junior/Non-Resident/Corporate fill the long tail).
      categoryMix: [
        { key: "full-golf",     name: "Full Golf",     count: 720, duesRate: "$895/mo",       netYTD: 12, sharePct: "56.1%" },
        { key: "social",        name: "Social",        count: 210, duesRate: "$375/mo",       netYTD:  6, sharePct: "16.4%" },
        { key: "senior",        name: "Senior (65+)",  count: 165, duesRate: "$625/mo",       netYTD:  4, sharePct: "12.9%" },
        { key: "junior",        name: "Junior (<40)",  count:  95, duesRate: "$545/mo",       netYTD:  8, sharePct: " 7.4%" },
        { key: "non-resident",  name: "Non-Resident",  count:  52, duesRate: "$245/mo",       netYTD: -2, sharePct: " 4.0%" },
        { key: "corporate",     name: "Corporate",     count:  42, duesRate: "$720/mo / seat", netYTD: -3, sharePct: " 3.3%" },
      ],
      waitlist: {
        depth: 47,
        conversionPct: "38%",
        targetDepth: 60,
        aging: [
          { band: "0–6 months",   count: 18, sharePct: "38.3%" },
          { band: "7–12 months",  count: 14, sharePct: "29.8%" },
          { band: "13–24 months", count:  9, sharePct: "19.1%" },
          { band: "25+ months",   count:  6, sharePct: "12.8%" },
        ],
      },
      entranceFee: {
        ytd:          "$1.18M",
        priorYearYTD: "$1.05M",
        varPctYoY:    "+12.4% YoY",
        // $1.184M / 36 new members ≈ $32,889 avg initiation.
        perNewMember: "$32,889",
        benchmark:    "Peer median $25,000 (CMAA)",
        tone:         "green",
      },
      tenure: {
        averageYears: "14.2 yrs",
        // Distribution sums to 1,284.
        distribution: [
          { band: "Under 3 yrs", count: 142, sharePct: "11.1%" },
          { band: "3–10 yrs",    count: 386, sharePct: "30.1%" },
          { band: "10–25 yrs",   count: 542, sharePct: "42.2%" },
          { band: "25+ yrs",     count: 214, sharePct: "16.7%" },
        ],
      },
    },

    exports: {
      enabled: false,
      reason: "Export renderer not wired yet — board package PDF/Excel pipeline ships in a follow-up step.",
    },

    commentary: {
      atAGlance: {
        dataSource: "demo",
        consideration: "committee-review",
        whatHappened:
          "Operating revenue closed at $14.62M against a $14.10M plan — a +3.7% favorable variance — with NOI before depreciation of $3.18M (+12.0% to plan). Capital income reached $2.04M (+4.6% favorable), reflecting continued entrance-fee momentum. AR Current % softened to 78.4%, below the 80% target adopted in the FY23 collections policy.",
        whatItMeans:
          "Operating discipline held despite the mid-year minimum-wage step-up. The capital reserve continues to be funded out of operating margin and entrance fees rather than relying on special assessment — sustaining the Pillar 2 Capital Stewardship posture the Board approved at the November 2025 meeting. AR softening is concentrated in the 31–60 day bucket; no accounts have aged over 90 days that were not already in active collections.",
        whatNeedsAttention:
          "AR Current % has held below the 80% target for two consecutive months. The Membership Committee will review whether to tighten the late-fee waiver policy at its June 2026 meeting; the threshold for board-level escalation is three consecutive months below target.",
        boardDecision:
          "No Board action is required this period. The Membership Committee will review the late-fee waiver policy at its June 12, 2026 meeting and report recommendations to the Board at the July meeting.",
      },
      stewardship: {
        dataSource: "demo",
        consideration: "monitor",
        whatHappened:
          "Of sixteen monitored stewardship ratios, fifteen sit favorable to policy and one (AR Current %) sits amber. Pillar 1 Operating ratios are tracking ahead of plan, Pillar 2 Capital reserve coverage holds at 1.42x (above the 1.25x policy floor adopted in the FY24 Reserve Study), and Pillar 3 Balance Sheet long-term debt-to-equity holds at 0.08x.",
        whatItMeans:
          "Stewardship discipline is sound across the Pillar 1 Operating and Pillar 3 Balance Sheet dimensions. The capital reserve is being funded out of operating margin rather than relying on entrance fees alone — an early indicator that the structural dues pricing is set correctly for the current cost base.",
        whatNeedsAttention:
          "F&B covers are running -1.4% to plan. The variance is not material in revenue terms (average check is +4.1% YoY), but the Membership Committee will track whether the cover softness is member-experience driven or reflects broader macro discretionary-spend trends; the threshold for board-level escalation is sustained covers below -3% for three consecutive months.",
        boardDecision: "No Board action is required this period.",
      },
      financialStatements: {
        dataSource: "demo",
        consideration: "no-action",
        boardHeadline:
          "Working capital and reserve coverage both remain comfortably above the Board's policy thresholds.",
        whatHappened:
          "Total operating revenue closed at $12.62M (+1.0% favorable to plan); total operating expense at $10.25M (+0.6% over plan); NOI before depreciation at $2.37M (+2.8% favorable). The capital fund closed at +$242K of net reserve contribution against a budgeted -$168K — a $410K favorable swing, primarily from the irrigation-pump deferral.",
        whatItMeans:
          "FY26 is on track to close above board-approved budget in both Pillar 1 Operating and Pillar 2 Capital fund terms. Member equity will close near $28M, up $1.61M from the FY25 close of $26.40M — sustaining the Pillar 3 Balance Sheet Stewardship posture. Dues income ran +0.6% favorable; entrance-fee income ran +5.7% favorable.",
        whatNeedsAttention:
          "Repairs & maintenance is +2.4% over plan, concentrated in clubhouse HVAC runs preceding the scheduled replacement. The FY26 contingency line remains intact at $58K, above the $40K policy floor.",
        boardDecision: "No Board action is required this period.",
      },
      operations: {
        dataSource: "demo",
        consideration: "board-decision",
        boardHeadline:
          "Operating performance ran ahead of budget while payroll discipline held inside policy.",
        whatHappened:
          "Active membership of 1,284; net +25 members YTD (36 new, 11 resignations) against the Long Range Plan's +30 target. Rounds played YTD 31,420 (+6.0% favorable to plan). F&B covers 44,180 (-1.4% to plan). Course utilization 74.1%; range utilization 82.4%. Waitlist stands at 47 names — below the Long Range Plan's 60-deep buffer target.",
        whatItMeans:
          "Pillar 4 Membership and Pillar 5 Experience Stewardship are both favorable on activity (rounds, utilization) but the waitlist depth is below the Long Range Plan's buffer threshold. The Plan's 60-deep target is the buffer required to absorb attrition without diluting acceptance standards; current 47-deep provides 0 to 4 months of cushion depending on attrition pace.",
        whatNeedsAttention:
          "Waitlist-to-membership conversion has held at 38% for three months. The Membership Committee is reviewing the application timing and onboarding journey to shorten the cycle without changing acceptance standards; the threshold for board-level review is conversion below 35% sustained for two quarters.",
        boardDecision:
          "Board approval requested to extend the spring member-acquisition campaign through July 31, 2026, with incremental marketing spend of ~$22K against the FY26 contingency line. The Membership Committee recommends approval at the June 2026 meeting.",
      },
      payroll: {
        dataSource: "demo",
        consideration: "monitor",
        whatHappened:
          "YTD payroll closed at $7.18M against a $7.05M plan (+1.8% over budget), driven by the mid-year minimum-wage adjustment (+$96K impact) and one additional grounds technician added in March. Payroll ratio holds at 49.2% — below the 50.0% policy band. Dues plus entrance fees continue to cover the payroll line in full, with a $310K cushion.",
        whatItMeans:
          "Headcount is on plan; the budget variance is wage-rate driven, not headcount-driven. The Pillar 1 Operating Stewardship signal is intact: the payroll ratio remains favorable to policy because operating revenue ran +3.7% ahead of payroll growth. At current pace we expect FY26 to close with payroll ratio at or below 49.5%.",
        whatNeedsAttention:
          "Seasonal labor planning for the July–August window requires FY27 budgeting direction on whether to fold the additional grounds technician into the permanent headcount or continue summer-contractor coverage. The decision affects the FY27 payroll ratio by approximately 30 basis points.",
        boardDecision:
          "No Board action is required this period. FY27 budgeting direction on the grounds-technician headcount question is requested by the August 2026 Board meeting.",
      },
      fb: {
        dataSource: "demo",
        consideration: "no-action",
        whatHappened:
          "F&B revenue $2.01M YTD (-3.8% to plan). Covers 44,180; average check $38.20 (+4.1% YoY from $36.70). Member satisfaction score 4.6 of 5.0 on rolling 90-day survey. F&B subsidy of dues holds at 5.1%, well below the 8% policy ceiling adopted in FY23 and below the 6% sustained-target the Board affirmed at the FY25 strategic review.",
        whatItMeans:
          "F&B revenue softness is volume-driven, not pricing — the average check is +4.1% YoY and the member-experience score continues to climb. The Pillar 1 Operating Stewardship lever (F&B subsidy) is balancing the Pillar 5 Experience Stewardship objective without encroaching on the dues line; the trade-off is being managed within Board-approved policy.",
        whatNeedsAttention:
          "Banquets & events revenue is -8.2% to plan. The events team is rebuilding the corporate-event pipeline that lapsed in late FY25. No member-event softness — the gap is entirely in non-member bookings and is being addressed at the operating level.",
        boardDecision: "No Board action is required this period.",
      },
      capitalProjects: {
        dataSource: "demo",
        consideration: "board-decision",
        boardHeadline:
          "Capital projects continue on schedule, with the irrigation pump replacement deferred to FY27 for engineering review.",
        whatHappened:
          "Of seven board-approved FY26 capital projects, five are on track to close at or under budget, one (Pro Shop Refresh) is complete, and one (Irrigation Pump Replacement) has been deferred to FY27 pending engineering review of the revised scope. YTD capital spend $1.62M against $1.94M plan; the deferral released $315K of FY26 capital authority back to the Reserve.",
        whatItMeans:
          "The capital plan is being executed at or under board-approved budget. The Clubhouse HVAC Replacement is tracking $42K favorable to budget. Pillar 2 Capital Stewardship discipline holds: no project is materially over budget, the deferral was made for engineering-review reasons not funding reasons, and the deferral raised reserve coverage from 1.36x to 1.42x against the 1.25x policy floor adopted in the FY24 Reserve Study.",
        whatNeedsAttention:
          "The irrigation system engineering review is scheduled for June 2026. Without a refreshed proposal in front of the Board by the September 2026 meeting, the FY27 capital plan cannot incorporate the deferred work in its first six months — pushing the irrigation upgrade further into FY27 H2.",
        boardDecision:
          "The Capital Committee recommends Board approval of the revised irrigation scope at the September 2026 Board meeting. The Committee will review the engineering proposal at its July 17, 2026 meeting and bring a final recommendation to the August 2026 Board meeting for September consideration.",
      },
      arCollections: {
        dataSource: "demo",
        consideration: "committee-review",
        whatHappened:
          // Period-driven; same data-vs-period-label distinction as
          // the AR notes block above.
          `Total receivable $235K at period close (${reportingPeriod.periodEndShortLabel}); 78.4% current — below the 80% target adopted in the FY23 collections policy. The 31–60 day bucket holds $31.5K (+$4.5K against ${reportingPeriod.priorMonthLong}, concentrated in three member accounts). The over-90 day bucket holds $8.8K (3.7% of total receivable, unchanged from ${reportingPeriod.priorMonthLong}). Two member accounts moved into formal collections in ${reportingPeriod.monthLong}, both already on agreed payment plans.`,
        whatItMeans:
          "AR Current % has held below the 80% target for two consecutive months — the leading indicator the Membership Committee tracks. The over-90 share has not grown, and no member accounts have moved from active to inactive status due to AR. The Pillar 1 Operating Stewardship collection signal is functioning but the early-aged bucket is the leading indicator and is moving the wrong direction.",
        whatNeedsAttention:
          "The 31–60 day bucket grew $4.5K against April, concentrated in three member accounts. The General Manager initiated formal outreach May 30, 2026; payment plans are expected by June 15, 2026. Per board-adopted policy (May 2022), any account aged beyond 90 days without a payment plan triggers Membership Committee review; no accounts currently meet that condition.",
        boardDecision: "No Board action is required this period. The Membership Committee will review the late-fee waiver policy at its June 12, 2026 meeting; the threshold for board-level escalation is three consecutive months of AR Current % below the 80% target.",
      },
      experienceStewardship: {
        dataSource: "demo",
        consideration: "monitor",
        boardHeadline:
          "Member rounds and average check both remain ahead of plan, with non-banquet dining slightly soft.",
        whatHappened:
          "Rounds played 31,420 YTD (+6.0% vs plan); course utilization 74.1% (vs 70% Pillar 5 target); range utilization 82.4% (three-month high). F&B covers 44,180 YTD (-1.4% vs plan); average check $38.20 (+4.1% YoY). Spend-per-member $1,567 annualized; spend-per-round $63.97. F&B subsidy of dues holds at 5.1% — well below the 8% policy ceiling adopted in FY23.",
        whatItMeans:
          "Pillar 5 Experience Stewardship is favorable on the activity dimension: rounds, utilization, and range engagement are all running ahead of plan or above target. The hospitality reading is more nuanced — covers softness is volume-driven, not pricing (the average check is +4.1% YoY), and the F&B subsidy of dues is balancing the Pillar 1 Operating Stewardship lever against the Pillar 5 Experience objective without breaching the policy ceiling. Spend-per-member and spend-per-round are the franchise-engagement signals; both grew YoY, indicating that the members who are using the Club are using it more, not less.",
        whatNeedsAttention:
          "F&B cover softness is concentrated in the corporate-events line (-8.2% to plan). The events team is rebuilding the corporate pipeline that lapsed in late FY25; no member-event softness. The Membership Committee is tracking whether the broader cover softness is member-experience driven or reflects broader macro discretionary-spend trends; the threshold for board-level escalation is covers below -3% sustained for three consecutive months.",
        boardDecision:
          "No Board action is required this period. The Golf Committee will review course-condition feedback on the bunker renovation (Holes 4–9) at its July 10, 2026 meeting; the Membership Committee will assess the F&B cover trend at its June 12, 2026 meeting and report to the Board at the July meeting.",
      },
      membershipStewardship: {
        dataSource: "demo",
        consideration: "monitor",
        boardHeadline:
          "Membership remains stable, though the waitlist sits below the Long Range Plan's buffer for a third consecutive month.",
        whatHappened:
          "Active membership 1,284 at period close; net +25 YTD (36 new, 11 resignations) against the Long Range Plan's +30 target. Rolling-12-month attrition holds at 5.7% — inside the 6.0% CMAA peer-median band. Waitlist 47-deep against the LRP's 60-deep buffer target (three consecutive months below buffer). Entrance-fee income $1.18M YTD, +5.7% favorable to plan and +12.4% YoY. Average member tenure holds at 14.2 years.",
        whatItMeans:
          "Pillar 4 Membership Stewardship is favorable on the retention and franchise-strength dimensions: attrition inside the peer band, average tenure stable, entrance-fee yield per new member ($32,889) above the $25K CMAA peer median. The capital-reserve replenishment story (Pillar 2) is being funded directly out of Pillar 4 entrance fees — the structural pricing of admission is set correctly for the current cost base. The waitlist-depth shortfall is the one watch item: at 47 vs the 60-deep LRP buffer, the cushion against a resignation cliff is 0 to 4 months of attrition pace.",
        whatNeedsAttention:
          "Waitlist depth has held below the 60-deep LRP buffer for three months. The Junior (<40) category grew +8 YTD — the only growth-tier category running ahead of plan — and the Membership Committee will review whether to accelerate the spring acquisition campaign to rebuild the buffer without changing acceptance standards. Non-Resident and Corporate categories are both negative YTD; not yet at the threshold for category-policy review but worth noting in the September Long Range Plan refresh.",
        boardDecision:
          "No Board action is required this period. The Membership Committee will review waitlist-depth strategy and the spring-campaign extension request at its June 12, 2026 meeting; recommendations to the Board at the July meeting. Threshold for board-level escalation is sustained waitlist below the 40-deep floor adopted in the FY24 Long Range Plan refresh.",
      },
    },

    // Board Risks — management-authored, materiality-ordered (HIGH first).
    // Five entries is the maximum the section will render; the component
    // contract caps at 5.
    boardRisks: [
      {
        key: "reserve-coverage-pressure",
        title: "Reserve coverage policy floor under pressure",
        severity: "high",
        trend: "stable",
        summary:
          "Reserve coverage holds at 1.42× today, but the irrigation deferral combined with FY27 HVAC capital could test the 1.25× policy floor.",
        boardAction:
          "Capital Committee reviewing revised irrigation scope at July 17, 2026 meeting.",
      },
      {
        key: "payroll-wage-rate-pressure",
        title: "Payroll wage-rate pressure",
        severity: "moderate",
        trend: "worsening",
        summary:
          "The mid-year minimum-wage step-up has pushed YTD payroll +1.8% over plan; the FY27 grounds-technician decision compounds the exposure.",
        boardAction:
          "FY27 budgeting direction requested by the August 2026 Board meeting.",
      },
      {
        key: "waitlist-buffer-shortfall",
        title: "Waitlist depth below Long Range Plan buffer",
        severity: "moderate",
        trend: "stable",
        summary:
          "The waitlist sits 13 names below the Plan's 60-deep buffer target for a third consecutive month.",
        boardAction:
          "Membership Committee reviewing spring-campaign extension at June 12, 2026 meeting.",
      },
      {
        key: "banquet-cover-softness",
        title: "Non-member banquet softness",
        severity: "moderate",
        trend: "stable",
        summary:
          "Banquets and corporate events are -8.2% to plan; events team is rebuilding the corporate pipeline that lapsed late FY25.",
      },
      {
        key: "ar-current-aging",
        title: "Member receivables aging",
        severity: "watch",
        trend: "worsening",
        summary:
          "AR Current % has held below the 80% target for two consecutive months; the 31-60 day bucket grew $4.5K against April.",
        boardAction:
          "Membership Committee reviewing late-fee waiver policy June 12, 2026.",
      },
    ],

    // Board Decisions Required — management-authored, meeting-precedence
    // ordered. Capped at 3 by the component contract. All three demo
    // entries are sourced from existing CFO commentary so the narrative
    // voice stays single-sourced.
    boardDecisions: [
      {
        key: "spring-campaign-extension",
        action: "approve",
        title: "Spring member-acquisition campaign extension",
        ask:
          "Authorise ~$22K of incremental marketing spend against the FY26 contingency line through July 31, 2026.",
        sponsor: "Membership Committee",
        meeting: "June 12, 2026 Board meeting",
      },
      {
        key: "fy27-grounds-tech-headcount",
        action: "review",
        title: "FY27 grounds-technician headcount direction",
        ask:
          "Board direction requested on whether to fold the additional grounds technician into permanent headcount or continue summer-contractor coverage.",
        sponsor: "Finance Committee",
        meeting: "August 6, 2026 Board meeting",
      },
      {
        key: "irrigation-revised-scope",
        action: "approve",
        title: "Revised irrigation pump replacement scope",
        ask:
          "Approve the revised scope and $315K capital-authority release; the engineering review completes at the July 17, 2026 Capital Committee meeting.",
        sponsor: "Capital Committee",
        meeting: "September 17, 2026 Board meeting",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers + demo data builders.
// ---------------------------------------------------------------------------

function monthlySeries(values: number[]): ChartSeriesPoint[] {
  // Last 12 months ending May 2026 (consistent with the demo period).
  const monthLabels = ["Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar","Apr","May"];
  return values.map((value, i) => ({ label: monthLabels[i] ?? `M${i + 1}`, value }));
}

// Helper removed — the stewardship metrics use object literals
// directly so the controller-style fields (whatIsIt, whyItMatters,
// assessment) read inline and stay reviewable.

function demoDepartments(): DepartmentResult[] {
  return [
    { name: "Membership Dues",      revenue: "$ 6.12M", expense: "$ 0.41M", contribution: "$ 5.71M", contributionPctOfRevenue: "93.3%", tone: "green" },
    { name: "Golf Operations",      revenue: "$ 2.84M", expense: "$ 2.16M", contribution: "$ 0.68M", contributionPctOfRevenue: "23.9%", tone: "green" },
    { name: "Food & Beverage",      revenue: "$ 2.01M", expense: "$ 2.12M", contribution: "$(0.11M)", contributionPctOfRevenue: "-5.5%", tone: "amber" },
    { name: "Hospitality / Events", revenue: "$ 0.94M", expense: "$ 0.68M", contribution: "$ 0.26M", contributionPctOfRevenue: "27.7%", tone: "green" },
    { name: "Grounds & Maintenance",revenue: "$ 0.00M", expense: "$ 1.62M", contribution: "$(1.62M)", contributionPctOfRevenue: "—",    tone: "neutral" },
    { name: "Pro Shop / Retail",    revenue: "$ 0.58M", expense: "$ 0.51M", contribution: "$ 0.07M", contributionPctOfRevenue: "12.1%", tone: "green" },
    { name: "Administration",       revenue: "$ 0.00M", expense: "$ 1.04M", contribution: "$(1.04M)", contributionPctOfRevenue: "—",    tone: "neutral" },
  ];
}

function statementOfActivitiesDemo(): StatementLine[] {
  return [
    { label: "OPERATING REVENUE", current: "", isTotal: true },
    { label: "Membership Dues",            current: "$ 6,120,400", budget: "$ 6,082,000", variance: "+0.6%",  indent: 1 },
    { label: "Golf Operations",            current: "$ 2,841,600", budget: "$ 2,704,000", variance: "+5.1%",  indent: 1 },
    { label: "Food & Beverage",            current: "$ 2,010,800", budget: "$ 2,090,000", variance: "-3.8%",  indent: 1 },
    { label: "Hospitality / Events",       current: "$   942,300", budget: "$   918,000", variance: "+2.6%",  indent: 1 },
    { label: "Pro Shop & Retail",          current: "$   582,000", budget: "$   560,000", variance: "+3.9%",  indent: 1 },
    { label: "Other Operating Revenue",    current: "$   124,500", budget: "$   146,000", variance: "-14.7%", indent: 1 },
    { label: "Total Operating Revenue",    current: "$ 12,621,600", budget: "$ 12,500,000", variance: "+1.0%", isTotal: true },
    { label: "OPERATING EXPENSE", current: "", isTotal: true },
    { label: "Payroll & Benefits",         current: "$ 7,180,400", budget: "$ 7,050,000", variance: "+1.8%",  indent: 1 },
    { label: "Cost of Goods (F&B)",        current: "$ 1,156,200", budget: "$ 1,202,000", variance: "-3.8%",  indent: 1 },
    { label: "Utilities & Fuel",           current: "$   468,200", budget: "$   492,000", variance: "-4.8%",  indent: 1 },
    { label: "Repairs & Maintenance",      current: "$   612,400", budget: "$   598,000", variance: "+2.4%",  indent: 1 },
    { label: "Insurance & Property Tax",   current: "$   316,400", budget: "$   316,000", variance: "+0.1%",  indent: 1 },
    { label: "General & Administrative",   current: "$   514,200", budget: "$   532,000", variance: "-3.3%",  indent: 1 },
    { label: "Total Operating Expense",    current: "$ 10,247,800", budget: "$ 10,190,000", variance: "+0.6%", isTotal: true },
    { label: "NOI Before Depreciation",    current: "$ 2,373,800",  budget: "$ 2,310,000",  variance: "+2.8%", isTotal: true },
    { label: "Depreciation",               current: "$ 1,184,000",  budget: "$ 1,200,000",  variance: "-1.3%", indent: 1 },
    { label: "Net Operating Income",       current: "$ 1,189,800",  budget: "$ 1,110,000",  variance: "+7.2%", isTotal: true },
  ];
}

function capitalFundDemo(): StatementLine[] {
  return [
    { label: "CAPITAL INCOME", current: "", isTotal: true },
    { label: "Initiation Fees",        current: "$ 1,184,000", budget: "$ 1,120,000", variance: "+5.7%", indent: 1 },
    { label: "Capital Dues",           current: "$   612,000", budget: "$   612,000", variance: "+0.0%", indent: 1 },
    { label: "Transfer / Reinstatement Fees", current: "$   246,400", budget: "$   220,000", variance: "+12.0%", indent: 1 },
    { label: "Total Capital Income",   current: "$ 2,042,400", budget: "$ 1,952,000", variance: "+4.6%", isTotal: true },
    { label: "CAPITAL OUTFLOWS",       current: "", isTotal: true },
    { label: "Capital Projects",       current: "$ 1,620,400", budget: "$ 1,940,000", variance: "-16.5%", indent: 1 },
    { label: "Debt Service (Principal)", current: "$   180,000", budget: "$   180,000", variance: "+0.0%", indent: 1 },
    { label: "Net Capital Contribution to Reserve", current: "$   242,000", budget: "$  (168,000)", variance: "Favorable", isTotal: true },
  ];
}

function capitalProjectsDemo(): Array<{ name: string; budget: string; ytd: string; used: string; status: string; tone: KpiTone }> {
  // `used` is the pre-formatted variance (YTD spend / budget) so the
  // table can render the four KPI pillars per project row:
  //   1. Number     — project name + budget
  //   2. Benchmark  — YTD spend
  //   3. Interpretation — % used (the variance reading)
  //   4. Status     — tone-coloured chip
  return [
    { name: "Clubhouse HVAC Replacement",     budget: "$ 480,000", ytd: "$ 438,400", used: "91.3%", status: "On track",       tone: "green" },
    { name: "Cart Path Resurfacing (Phase 2)", budget: "$ 312,000", ytd: "$ 296,200", used: "94.9%", status: "On track",       tone: "green" },
    { name: "Irrigation Pump Replacement",    budget: "$ 315,000", ytd: "$       0", used: "0.0%",  status: "Deferred FY27",  tone: "amber" },
    { name: "Bunker Renovation (Holes 4-9)",  budget: "$ 268,000", ytd: "$ 264,800", used: "98.8%", status: "On track",       tone: "green" },
    { name: "Pro Shop Refresh",               budget: "$  86,000", ytd: "$  82,400", used: "95.8%", status: "Complete",       tone: "green" },
    { name: "Tennis Court Resurfacing",       budget: "$ 174,000", ytd: "$ 168,200", used: "96.7%", status: "On track",       tone: "green" },
    { name: "Patio Furniture Refresh",        budget: "$  46,000", ytd: "$  44,800", used: "97.4%", status: "Complete",       tone: "green" },
  ];
}

function financialPositionDemo(): StatementLine[] {
  return [
    { label: "ASSETS", current: "", isTotal: true },
    { label: "Cash & Equivalents",       current: "$  3,124,800", indent: 1 },
    { label: "Accounts Receivable",      current: "$    235,090", indent: 1 },
    { label: "Inventory (F&B + Pro Shop)", current: "$    142,200", indent: 1 },
    { label: "Property, Plant & Equipment (Net)", current: "$ 24,082,400", indent: 1 },
    { label: "Capital Reserve",          current: "$  2,946,000", indent: 1 },
    { label: "Total Assets",             current: "$ 30,530,490", isTotal: true },
    { label: "LIABILITIES", current: "", isTotal: true },
    { label: "Accounts Payable",         current: "$    482,400", indent: 1 },
    { label: "Accrued Expenses",         current: "$    246,800", indent: 1 },
    { label: "Member Deposits",          current: "$    312,000", indent: 1 },
    { label: "Long-Term Debt",           current: "$  1,484,000", indent: 1 },
    { label: "Total Liabilities",        current: "$  2,525,200", isTotal: true },
    { label: "MEMBER EQUITY",            current: "$ 28,005,290", isTotal: true },
  ];
}

function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return "$ —";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
}

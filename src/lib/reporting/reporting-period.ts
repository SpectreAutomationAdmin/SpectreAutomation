// Canonical Reporting Period — the single source of truth for every
// presentation-period label used by the Monthly Reporting Package.
//
// Per `docs/reporting-package-period-golden-rule.md` and the
// `Reporting Period Golden Rule` section in CLAUDE.md, EVERY section
// in the monthly reporting package must derive its dates, column
// labels, chart axes, captions, commentary, footnotes, statement
// numbers, and export metadata from this object — never from
// hardcoded strings in a component or service seed.
//
// The package builder constructs one of these per package build
// from the `periodEnd: Date` it already resolves, and threads it
// through every section's data builder. If a section needs to name
// the current month in a column header, it reads `period.monthShort`;
// if it needs an italic "for the period ended …" line, it reads
// `period.periodEndedLabel`; if it needs the eyebrow date line, it
// reads `period.statementHeaderLabel`. NO ad-hoc Date formatting in
// sections.

/**
 * Canonical reporting period. All presentation-period strings the
 * Monthly Reporting Package needs are derived from `periodEnd` once
 * at package build time and stored here. Sections + service builders
 * consume the pre-formatted strings; they NEVER touch `Date` APIs
 * directly.
 */
export type ReportingPeriod = {
  /** Inclusive start of the current reporting period (typically the
   *  first day of `periodEnd`'s month, midnight UTC). */
  periodStart: Date;
  /** Inclusive end of the current reporting period (typically the
   *  last day of the month, end-of-day UTC). */
  periodEnd: Date;

  // ------ Calendar facets ------
  /** Calendar year of the period end — e.g. 2026. */
  year: number;
  /** Calendar month of the period end, 1-indexed — e.g. 5 for May. */
  month: number;
  /** Short month label — e.g. "May". Used in column headers like
   *  "May Budget / May Actual / May Var". */
  monthShort: string;
  /** Long month label — e.g. "May". (Same as short for now; held as
   *  a separate field so future locales can diverge.) */
  monthLong: string;

  // ------ Quarter facets ------
  /** Calendar quarter of the period end (1-4). */
  quarter: number;
  /** Short quarter label — e.g. "Q2". */
  quarterLabel: string;
  /** Current quarter + year — e.g. "Q2 2026". Used by exception-
   *  report eyebrows and project-schedule labels that name the
   *  current reporting quarter. */
  currentYearQuarterLabel: string;
  /** Next quarter + year — e.g. "Q3 2026" for a May 2026 period.
   *  Used by reactive commentary that schedules a board action
   *  in the next regular meeting cycle. Crosses a year boundary
   *  cleanly: a Q4 period → "Q1 <year+1>". */
  nextYearQuarterLabel: string;

  // ------ Pre-formatted labels for direct rendering ------
  /** Short period name — e.g. "May 2026". Used in chapter eyebrows. */
  periodLabel: string;
  /** Italic-serif footer line — e.g. "For the period ended May 31, 2026". */
  periodEndedLabel: string;
  /** Short period-end date — e.g. "May 31, 2026". Used in compact
   *  contexts ("at period close (May 31, 2026)", "as of May 31, 2026")
   *  where the longer `periodEndedLabel` is too wordy. */
  periodEndShortLabel: string;
  /** ISO date string for `periodEnd` — e.g. "2026-05-31". Used by
   *  package metadata + export headers; safe for URL slugs and
   *  serialisation. */
  periodEndISO: string;
  /** Long statement-eyebrow label — e.g. "May 2026 · For the period
   *  ended May 31, 2026 · Year to Date". Used directly under
   *  Saguaro-style statement titles. */
  statementHeaderLabel: string;

  // ------ Prior-month / next-month / prior-year derivations ------
  // These let commentary templates name comparison periods without
  // any Date math. A commentary that wants "vs. April" (the month
  // before May) reads `period.priorMonthLong`. A reactive note that
  // schedules a future action reads `period.nextMonthLong`. A prior-
  // year same-month overlay reads `period.priorYearLabel`.

  /** Full prior-month name — e.g. "April" when period is May. Wraps
   *  cleanly from January → "December". */
  priorMonthLong: string;
  /** Short prior-month label — e.g. "Apr" when period is May. */
  priorMonthShort: string;
  /** Full next-month name — e.g. "June" when period is May. Wraps
   *  cleanly from December → "January". */
  nextMonthLong: string;
  /** Short next-month label — e.g. "Jun" when period is May. */
  nextMonthShort: string;
  /** Calendar year of the prior fiscal year — e.g. 2025 when period
   *  is May 2026. Used for prior-year comparative overlays. */
  priorYear: number;
  /** Prior-year same-month label — e.g. "May 2025" when period is
   *  May 2026. */
  priorYearLabel: string;
  /** Pre-formatted column labels for a Current-Month vs YTD table.
   *  Sections render these literals — no template literals in JSX. */
  columnLabels: {
    /** Always "Category". */
    category: string;
    /** Current-month budget header — e.g. "May Budget". */
    currentBudget: string;
    /** Current-month actual header — e.g. "May Actual". */
    currentActual: string;
    /** Current-month variance header — e.g. "May Var". */
    currentVariance: string;
    /** Always "YTD Budget". */
    ytdBudget: string;
    /** Always "YTD Actual". */
    ytdActual: string;
    /** Always "YTD Var". */
    ytdVariance: string;
    /** Always "% Var". */
    variancePct: string;
  };
};

/** Default English month-name table — keep co-located with this
 *  module so a section can never bypass the period source by writing
 *  its own `toLocaleString` call. */
const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Build a `ReportingPeriod` from a `periodEnd: Date`. Period start
 * defaults to the first day of `periodEnd`'s month if not supplied.
 *
 * All label fields are derived NOW — pure data downstream, no Date
 * APIs in any component or section.
 */
export function buildReportingPeriod(periodEnd: Date, opts?: {
  periodStart?: Date;
}): ReportingPeriod {
  const year = periodEnd.getUTCFullYear();
  const monthIdx0 = periodEnd.getUTCMonth(); // 0-11
  const month = monthIdx0 + 1;
  const monthLong = MONTH_LONG[monthIdx0];
  const monthShort = MONTH_SHORT[monthIdx0];

  // Quarter math — 1-4 mapped from the month index.
  const quarter = Math.floor(monthIdx0 / 3) + 1;
  const quarterLabel = `Q${quarter}`;
  const currentYearQuarterLabel = `${quarterLabel} ${year}`;
  // Next quarter wraps from Q4 → Q1 of the following year.
  const nextQuarter = quarter === 4 ? 1 : quarter + 1;
  const nextQuarterYear = quarter === 4 ? year + 1 : year;
  const nextYearQuarterLabel = `Q${nextQuarter} ${nextQuarterYear}`;

  const periodStart =
    opts?.periodStart ?? new Date(Date.UTC(year, monthIdx0, 1));

  const periodEndISO = periodEnd.toISOString().slice(0, 10);

  // Pre-formatted day-of-month label — e.g. "31" for May 31.
  const day = periodEnd.getUTCDate();

  const periodLabel = `${monthLong} ${year}`;
  const periodEndedLabel = `For the period ended ${monthLong} ${day}, ${year}`;
  const periodEndShortLabel = `${monthLong} ${day}, ${year}`;
  const statementHeaderLabel = `${periodLabel} · For the period ended ${monthLong} ${day}, ${year} · Year to Date`;

  // Prior / next month indices — wrap cleanly across year boundaries.
  // The prior-year overlay is just the same calendar month one year
  // earlier (no fiscal-year intricacy in the label — fiscal years
  // are handled separately by FiscalYear records).
  const priorMonthIdx0 = monthIdx0 === 0 ? 11 : monthIdx0 - 1;
  const nextMonthIdx0 = monthIdx0 === 11 ? 0 : monthIdx0 + 1;
  const priorMonthLong = MONTH_LONG[priorMonthIdx0];
  const priorMonthShort = MONTH_SHORT[priorMonthIdx0];
  const nextMonthLong = MONTH_LONG[nextMonthIdx0];
  const nextMonthShort = MONTH_SHORT[nextMonthIdx0];
  const priorYear = year - 1;
  const priorYearLabel = `${monthLong} ${priorYear}`;

  return {
    periodStart,
    periodEnd,
    year,
    month,
    monthShort,
    monthLong,
    quarter,
    quarterLabel,
    currentYearQuarterLabel,
    nextYearQuarterLabel,
    periodLabel,
    periodEndedLabel,
    periodEndShortLabel,
    periodEndISO,
    statementHeaderLabel,
    priorMonthLong,
    priorMonthShort,
    nextMonthLong,
    nextMonthShort,
    priorYear,
    priorYearLabel,
    columnLabels: {
      category: "Category",
      currentBudget: `${monthShort} Budget`,
      currentActual: `${monthShort} Actual`,
      currentVariance: `${monthShort} Var`,
      ytdBudget: "YTD Budget",
      ytdActual: "YTD Actual",
      ytdVariance: "YTD Var",
      variancePct: "% Var",
    },
  };
}

// Departmental P&L Summary service — chapter X
// (Operations & Analytics group, sits immediately after Operating
// Statistics). Owns the six department cards (Food & Beverage, Golf
// Operations, Fitness Center, Racquet Operations, Aquatics & Pool,
// G&A & Administration), the management-document notice, and the
// arrow-bullet department notes. Period labels flow from
// `ReportingPeriod` per the Reporting Period Golden Rule.

import type { ReportingDataSource } from "@/lib/reporting/monthly-package";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";

// =============================================================================
// Public types
// =============================================================================

/** Tone for a metric value OR a header pill.
 *  - "favorable" → brand green (text-[#3f7042])
 *  - "risk"      → clay red    (text-[#8b3520])
 *  - "neutral"   → body colour */
export type DepartmentalTone = "favorable" | "risk" | "neutral";

export type DepartmentMetricRow = {
  key: string;
  label: string;
  /** Pre-formatted value string the panel renders verbatim. */
  value: string;
  /** Tone for the right-aligned value; absent = neutral body colour. */
  tone?: DepartmentalTone;
};

export type DepartmentHeaderPill = {
  /** Short label such as "+$22K YTD", "−$30K YTD", "+9% vs. PY". */
  label: string;
  tone: DepartmentalTone;
};

export type DepartmentCard = {
  key: string;
  name: string;
  /** Optional header pill — when present, sits on the right side of
   *  the dark-green card header. */
  pill?: DepartmentHeaderPill;
  rows: ReadonlyArray<DepartmentMetricRow>;
};

export type DepartmentNote = { text: string };

export type DepartmentalPLSummary = {
  dataSource: ReportingDataSource;
  // Header chrome — same shape as the other Saguaro chapters.
  eyebrow: string;
  title: string;
  periodLabel: string;
  introNote: string;
  statementNumber: string;
  documentChip: string;
  preparedFor: string;
  // Management-document notice — the warm outlined box below the
  // header that calls out this is a management surface, not a board
  // surface.
  managementNotice: {
    eyebrow: string;
    body: string;
  };
  // Six department cards in a responsive grid.
  cards: ReadonlyArray<DepartmentCard>;
  // Department notes block at the bottom — arrow bullets.
  notes: {
    eyebrow: string;
    items: ReadonlyArray<DepartmentNote>;
  };
};

// =============================================================================
// Seeded Silver Springs Departmental P&L Summary
// =============================================================================

export function buildSilverSpringsDepartmentalPLSummary(opts: {
  clubName: string;
  period: ReportingPeriod;
}): DepartmentalPLSummary {
  const { period } = opts;
  // Period-derived references used inside metric values + notes so
  // the chapter never reads as stale Q1 / March copy when the report
  // rolls forward.
  const periodMonthLabel = period.monthLong;
  const nextQuarterLabel = period.nextYearQuarterLabel;
  const currentQuarterLabel = period.currentYearQuarterLabel;

  // =====================================================
  // Six department cards
  // =====================================================
  const cards: ReadonlyArray<DepartmentCard> = [
    {
      key: "food-beverage",
      name: "Food & Beverage",
      pill: { label: "+$22K YTD", tone: "favorable" },
      rows: [
        { key: "revenue-ytd",            label: "Revenue YTD",            value: "$732,493" },
        { key: "vs-budget",              label: "vs. Budget",             value: "+$61,730",     tone: "favorable" },
        { key: "food-cost-pct-ytd",      label: "Food Cost % YTD",        value: "46.4%" },
        { key: "bev-cost-pct-ytd",       label: "Beverage Cost % YTD",    value: "37.7% vs. 39% bgt", tone: "favorable" },
        { key: "net-result-vs-budget",   label: "Net Result vs. Budget",  value: "+$22K",        tone: "favorable" },
        { key: "ytd-covers",             label: "YTD Covers",             value: "12,390" },
      ],
    },
    {
      key: "golf-operations",
      name: "Golf Operations",
      pill: { label: "−$30K YTD", tone: "risk" },
      rows: [
        { key: "revenue-ytd",          label: "Revenue YTD",            value: "$773,639" },
        { key: "vs-budget",            label: "vs. Budget",             value: "+$19,622",       tone: "favorable" },
        { key: "guest-fee-variance",   label: "Guest Fee Variance",     value: "−$45K",          tone: "risk" },
        // Period-aware: month label of the selected reporting period
        // flows in via `period.monthLong` instead of a hardcoded
        // "March" / "May" / "June".
        { key: "member-rounds-vs-py",  label: "Member Rounds vs. PY",   value: `+30% (${periodMonthLabel})`, tone: "favorable" },
        { key: "net-result-vs-budget", label: "Net Result vs. Budget",  value: "−$30K",          tone: "risk" },
        { key: "story",                label: "Story",                  value: "Member-first mix", tone: "favorable" },
      ],
    },
    {
      key: "fitness-center",
      name: "Fitness Center",
      pill: { label: "−$10K YTD", tone: "risk" },
      rows: [
        { key: "revenue-ytd",        label: "Revenue YTD",         value: "$115,525" },
        { key: "vs-budget",          label: "vs. Budget",          value: "−$18,375",      tone: "risk" },
        { key: "primary-cause",      label: "Primary Cause",       value: "Instructor turnover", tone: "risk" },
        { key: "payroll-offset",     label: "Payroll Offset",      value: "+$5K favorable",  tone: "favorable" },
        { key: "staffing-status",    label: "Staffing Status",     value: "Recruiting" },
        // Period-aware: expected resolution lands in the next regular
        // operating cycle — derives from period.nextYearQuarterLabel
        // so a May 2026 report points at Q3 2026, not a stale Q2 2026.
        { key: "expect-resolution",  label: "Expect Resolution",   value: nextQuarterLabel },
      ],
    },
    {
      key: "racquet-operations",
      name: "Racquet Operations",
      pill: { label: "+9% vs. PY", tone: "favorable" },
      rows: [
        { key: "revenue-ytd",            label: "Revenue YTD",            value: "$71,027" },
        { key: "vs-budget",              label: "vs. Budget",             value: "−$3,223",       tone: "risk" },
        { key: "vs-prior-year",          label: "vs. Prior Year",         value: "+9%",           tone: "favorable" },
        { key: "lesson-program-trend",   label: "Lesson & Program Trend", value: "Growing",       tone: "favorable" },
        { key: "net-result-vs-budget",   label: "Net Result vs. Budget",  value: "+$16K",         tone: "favorable" },
        { key: "expense-savings",        label: "Expense Savings",        value: "$14K favorable", tone: "favorable" },
      ],
    },
    {
      key: "aquatics-pool",
      name: "Aquatics & Pool",
      pill: { label: "+$4K YTD", tone: "favorable" },
      rows: [
        { key: "revenue-ytd",            label: "Revenue YTD",            value: "$41,850" },
        { key: "vs-budget",              label: "vs. Budget",             value: "+$4,050",       tone: "favorable" },
        { key: "vs-prior-year",          label: "vs. Prior Year",         value: "+10.7%",        tone: "favorable" },
        { key: "programming-trend",      label: "Programming Trend",      value: "Favorable",     tone: "favorable" },
        { key: "net-result-vs-budget",   label: "Net Result vs. Budget",  value: "+$4K",          tone: "favorable" },
        // Period-aware: seasonal outlook references the NEXT quarter
        // so a May 2026 report points at Q3 2026 peak season.
        { key: "seasonal-outlook",       label: "Seasonal Outlook",       value: `${nextQuarterLabel} peak season` },
      ],
    },
    {
      key: "ga-administration",
      name: "G&A & Administration",
      pill: { label: "−$30K YTD", tone: "risk" },
      rows: [
        { key: "expense-vs-budget",       label: "Expense vs. Budget",       value: "−$29,772",         tone: "risk" },
        { key: "board-approved-bonus",    label: "Board-Approved Bonus",     value: "Included" },
        { key: "longevity-recognition",   label: "Longevity Recognition",    value: "Included" },
        { key: "legal-professional-fees", label: "Legal & Professional Fees", value: "Elevated",        tone: "risk" },
        { key: "structural-concern",      label: "Structural Concern?",      value: "No — authorized" },
        { key: "payroll-vs-py",           label: "Payroll vs. PY",           value: "+$63K vs. prior year", tone: "risk" },
      ],
    },
  ];

  // =====================================================
  // Management notice
  // =====================================================
  const managementNotice = {
    eyebrow: "Management Document",
    body:
      "This statement provides department-level detail for GM and " +
      "department head use. The board receives the combined statement. " +
      "Department variances reach the board only when a department's " +
      "performance is material to overall results or requires board-" +
      "level resource decisions.",
  };

  // =====================================================
  // Department notes — period-aware so they never read stale
  // =====================================================
  const notes = {
    eyebrow: "Department Notes",
    items: [
      {
        text:
          "Course Maintenance expenses are $7.5K unfavorable YTD, driven " +
          "primarily by fuel cost increases and seasonal chemical " +
          "applications. This department has no revenue to offset; " +
          "variances should be evaluated against the maintenance program " +
          "quality standards set by the Golf Committee.",
      },
      {
        text:
          `Facilities and Maintenance is $12.6K favorable YTD. No deferred ` +
          `maintenance is contributing to this variance — favorable result ` +
          `reflects reduced reactive repair activity in ${currentQuarterLabel} ` +
          `relative to budget assumptions.`,
      },
    ],
  };

  return {
    dataSource: "demo",
    eyebrow: `${opts.clubName} · Departmental Detail`,
    title: "Departmental P&L Summary",
    periodLabel: period.statementHeaderLabel,
    introNote:
      "How each department is performing against plan. For the finance committee and management team.",
    statementNumber: "Statement 08 of 14",
    documentChip: "Departmental Detail",
    preparedFor: "Management Level",
    managementNotice,
    cards,
    notes,
  };
}

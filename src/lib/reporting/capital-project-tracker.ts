// Capital Project Tracker service — chapter VI.
//
// Owns the project roster, status classification, reactive
// exception report, and reactive project notes for the chapter VI
// Capital Project Tracker. Mirrors the architecture of the chapter
// IV Statement of Activities + chapter V Capital Fund Statement:
// values + commentary + period labels are owned by the service;
// the React surface renders only.
//
// Cross-chapter integration:
//   - Capital Fund (chapter V) answers WHERE capital comes from
//     and how the reserve fund is trending.
//   - Capital Project Tracker (chapter VI) answers WHAT was
//     approved, WHAT has been spent, and WHETHER projects are off
//     course.
//   - The project notes reference both chapters by their statement
//     number so the cross-references stay accurate as the bundle
//     evolves (the SoA + capital-fund + tracker statement numbers
//     are passed in via `opts`).
//
// Period labels flow from `ReportingPeriod` per the Golden Rule.

import type { ReportingDataSource } from "@/lib/reporting/monthly-package";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";

// =============================================================================
// Public types
// =============================================================================

/** Status pill on a project row. Restrained brand palette — no
 *  SaaS stoplight saturation. */
export type CapitalProjectStatus =
  | "on-track"
  | "pre-install"
  | "planning"
  | "at-risk"
  | "over-budget";

export type CapitalProjectStatusLabel = {
  /** Service-supplied display label (e.g. "On Track"). The component
   *  uppercases at render time. */
  label: string;
  tone: CapitalProjectStatus;
};

export type CapitalProjectRowKind =
  | "section-band"
  | "project"
  | "commentary"
  | "total";

export type CapitalProjectRow = {
  key: string;
  kind: CapitalProjectRowKind;
  label?: string;
  /** Project numerics + schedule. Present on project + total rows. */
  values?: {
    authorized: number | null;
    contracted: number | null;
    spentYtd: number | null;
    projectedFinal: number | null;
    /** Project variance (favourable = positive). NULL when the row
     *  has no variance to report. */
    variance: number | null;
    /** Percent complete as a decimal (0.60 for "60%"). */
    percentDone: number | null;
    /** Estimated completion label — e.g. "Q2 2026" or "TBD". The
     *  service supplies this verbatim; the component does not
     *  format. */
    estCompleteLabel: string;
  };
  /** Optional projected-final override label when the value isn't
   *  numeric (e.g. "TBD"). When present, the component renders this
   *  string instead of `formatStatementValue(values.projectedFinal)`. */
  projectedFinalLabel?: string;
  /** Optional status pill on project rows. */
  status?: CapitalProjectStatusLabel;
  /** Italic commentary text on commentary rows. */
  text?: string;
};

export type CapitalProjectExceptionReport = {
  eyebrow: string;
  body: string;
};

export type CapitalProjectNote = { text: string };

export type CapitalProjectTracker = {
  dataSource: ReportingDataSource;
  // Header chrome — same shape as the other Saguaro chapters.
  eyebrow: string;
  title: string;
  /** Period header line — derived from `ReportingPeriod.statementHeaderLabel`. */
  periodLabel: string;
  introNote: string;
  statementNumber: string;
  documentChip: string;
  preparedFor: string;
  columnHeaders: {
    project: string;
    authorized: string;
    contracted: string;
    spentYtd: string;
    projectedFinal: string;
    variance: string;
    percentDone: string;
    estComplete: string;
    status: string;
  };
  rows: ReadonlyArray<CapitalProjectRow>;
  /** Reactive exception-report block. Eyebrow + body flow from
   *  `buildExceptionReport`. */
  exceptionReport: CapitalProjectExceptionReport;
  /** Reactive bullet-style project notes. */
  projectNotes: ReadonlyArray<CapitalProjectNote>;
};

// =============================================================================
// Reactive exception report generator
// =============================================================================

export type ExceptionReportInputs = {
  /** Period label — e.g. "May 2026" or "Q1 2026". */
  periodLabel: string;
  /** Project rows that count toward the total (active rows ONLY —
   *  pending-board planning rows are excluded). */
  activeProjects: ReadonlyArray<{
    label: string;
    variance: number | null;
    status: CapitalProjectStatus;
  }>;
};

function formatDollarsK(value: number): string {
  const abs = Math.abs(Math.round(value));
  if (abs >= 1000) {
    const k = Math.round(abs / 1000);
    return `$${k}K`;
  }
  return `$${abs.toLocaleString("en-US")}`;
}

/** Build the green-tinted exception report block. Branches on:
 *    - Any project carrying status "over-budget" or unfavourable
 *      variance > 0 (in expense convention, negative variance is
 *      the overrun signal here — but project budgets use the
 *      "authorized − final" convention where positive = favourable).
 *    - Any project carrying status "at-risk".
 *    - All-clear branch: every active project is on-track or
 *      pre-install AND no variances out of band. */
export function buildCapitalProjectExceptionReport(
  inputs: ExceptionReportInputs,
): CapitalProjectExceptionReport {
  const eyebrow = `Exception Report — ${inputs.periodLabel}`;

  const overruns  = inputs.activeProjects.filter(
    (p) => p.status === "over-budget" || (p.variance !== null && p.variance < 0),
  );
  const atRisk    = inputs.activeProjects.filter((p) => p.status === "at-risk");
  const favourable = inputs.activeProjects.filter(
    (p) => p.variance !== null && p.variance > 0,
  );

  let body: string;
  if (overruns.length > 0) {
    const overrunNames = overruns.map((p) => p.label).join(", ");
    body =
      `Material cost overruns to report: ${overrunNames}. ` +
      `Board attention is required to authorize either revised scope, supplemental ` +
      `funding, or deferral.`;
    if (atRisk.length > 0) {
      body += ` Additionally, ${atRisk.map((p) => p.label).join(", ")} ${atRisk.length === 1 ? "is" : "are"} flagged at risk.`;
    }
  } else if (atRisk.length > 0) {
    const atRiskNames = atRisk.map((p) => p.label).join(", ");
    body =
      `No active projects have material cost overruns to report. ` +
      `${atRiskNames} ${atRisk.length === 1 ? "is" : "are"} flagged at risk and ` +
      `${atRisk.length === 1 ? "warrants" : "warrant"} board attention. All other ` +
      `projects are executing within authorized amounts and on schedule.`;
  } else if (favourable.length > 0) {
    // Cite the favourable variance with the largest magnitude.
    const top = [...favourable].sort(
      (a, b) => (b.variance ?? 0) - (a.variance ?? 0),
    )[0];
    body =
      `No active projects have material cost overruns to report. ` +
      `The ${top.label} is tracking ${formatDollarsK(top.variance!)} below ` +
      `authorized budget due to favorable contractor pricing on materials. ` +
      `All other projects are executing within authorized amounts and on schedule.`;
  } else {
    body =
      `No active projects have material cost overruns to report. ` +
      `All projects are executing within authorized amounts and on schedule.`;
  }

  return { eyebrow, body };
}

// =============================================================================
// Reactive project notes generator
// =============================================================================

export type ProjectNotesInputs = {
  /** Label of the largest pending capital decision (e.g. "Locker Room Renovation"). */
  largestPendingProjectLabel: string;
  /** Pre-formatted reserve balance for the funding-capacity sentence (e.g. "$4.82M"). */
  reserveBalanceLabel: string;
  /** Next quarter + year (e.g. "Q3 2026") — when the board is
   *  scheduled to evaluate the pending decision. Flows from
   *  `ReportingPeriod.nextYearQuarterLabel`. */
  nextBoardMeetingLabel: string;
  /** Statement number of the Statement of Activities (e.g.
   *  "Statement 04") — cited in the two-fund framing bullet so
   *  cross-chapter references stay accurate. */
  statementOfActivitiesNumber: string;
};

export function buildCapitalProjectNotes(
  inputs: ProjectNotesInputs,
): ReadonlyArray<CapitalProjectNote> {
  return [
    {
      text:
        `The ${inputs.largestPendingProjectLabel} represents the largest pending ` +
        `capital decision on the club's horizon. The reserve fund balance of ` +
        `${inputs.reserveBalanceLabel} provides capacity to fund this project. ` +
        `Management will present the full funding analysis, phasing options, and ` +
        `member communication plan to the board at the ${inputs.nextBoardMeetingLabel} meeting.`,
    },
    {
      text:
        `The two-fund structure means capital project spending is tracked against ` +
        `the capital fund balance — it does not affect the operating result shown ` +
        `in ${inputs.statementOfActivitiesNumber}. This is intentional: capital ` +
        `decisions should be evaluated on capital terms, not as operating expenses.`,
    },
  ];
}

// =============================================================================
// Seeded Silver Springs Capital Project Tracker
// =============================================================================

export function buildSilverSpringsCapitalProjectTracker(opts: {
  clubName: string;
  period: ReportingPeriod;
  /** Pre-formatted reserve balance (e.g. "$4.82M") — sourced from
   *  the Capital Fund chapter so the cross-reference stays in sync. */
  reserveBalanceLabel: string;
  /** Statement number of the Statement of Activities — sourced from
   *  the chapter IV builder so the project-notes cross-reference
   *  stays accurate as the bundle evolves. */
  statementOfActivitiesNumber: string;
}): CapitalProjectTracker {
  const onTrack: CapitalProjectStatusLabel    = { label: "On Track",    tone: "on-track" };
  const preInstall: CapitalProjectStatusLabel = { label: "Pre-Install", tone: "pre-install" };
  const planning: CapitalProjectStatusLabel   = { label: "Planning",    tone: "planning" };

  // Active projects in canonical Saguaro order. The 6 active rows
  // count toward the total; the planning row (Locker Room) is
  // excluded because no funding has been authorized yet.
  const activeProjects = [
    { key: "hvac-clubhouse", label: "HVAC — Clubhouse",
      authorized: 380_000, contracted: 380_000, spentYtd: 228_000, projectedFinal: 380_000,
      variance: 0, percentDone: 0.60, estCompleteLabel: "Q2 2026", status: onTrack,
      sectionKey: "replacements" },
    { key: "kitchen-equipment", label: "Kitchen Equipment Refresh",
      authorized: 240_000, contracted: 240_000, spentYtd: 96_000, projectedFinal: 240_000,
      variance: 0, percentDone: 0.40, estCompleteLabel: "Q3 2026", status: onTrack,
      sectionKey: "replacements" },
    { key: "golf-cart-fleet", label: "Golf Cart Fleet — Phase 1",
      authorized: 360_000, contracted: 360_000, spentYtd: 180_000, projectedFinal: 360_000,
      variance: 0, percentDone: 0.50, estCompleteLabel: "Q2 2026", status: onTrack,
      sectionKey: "replacements" },
    { key: "fitness-center", label: "Fitness Center Expansion",
      authorized: 320_000, contracted: 280_000, spentYtd: 96_000, projectedFinal: 320_000,
      variance: 0, percentDone: 0.30, estCompleteLabel: "Q3 2026", status: onTrack,
      sectionKey: "improvements" },
    { key: "terrace-patio", label: "Terrace & Patio Renovation",
      authorized: 160_000, contracted: 148_000, spentYtd: 20_000, projectedFinal: 155_000,
      variance: 5_000, percentDone: 0.13, estCompleteLabel: "Q4 2026", status: onTrack,
      sectionKey: "improvements" },
    { key: "driving-range", label: "Driving Range Technology Upgrade",
      authorized: 160_000, contracted: 160_000, spentYtd: 0, projectedFinal: 160_000,
      variance: 0, percentDone: 0.00, estCompleteLabel: "Q2 2026", status: preInstall,
      sectionKey: "improvements" },
  ] as const;

  const replacements = activeProjects.filter((p) => p.sectionKey === "replacements");
  const improvements = activeProjects.filter((p) => p.sectionKey === "improvements");

  // -- Totals — active projects only --
  const totalAuthorized    = activeProjects.reduce((s, p) => s + p.authorized, 0);
  const totalContracted    = activeProjects.reduce((s, p) => s + p.contracted, 0);
  const totalSpentYtd      = activeProjects.reduce((s, p) => s + p.spentYtd, 0);
  const totalProjectedFinal= activeProjects.reduce((s, p) => s + p.projectedFinal, 0);
  const totalVariance      = activeProjects.reduce((s, p) => s + p.variance, 0);

  const rows: CapitalProjectRow[] = [
    // ACTIVE — REPLACEMENTS
    { key: "band-replacements", kind: "section-band", label: "Active — Replacements" },
    ...replacements.map((p): CapitalProjectRow => ({
      key: p.key, kind: "project", label: p.label,
      values: {
        authorized: p.authorized, contracted: p.contracted, spentYtd: p.spentYtd,
        projectedFinal: p.projectedFinal, variance: p.variance, percentDone: p.percentDone,
        estCompleteLabel: p.estCompleteLabel,
      },
      status: p.status,
    })),

    // ACTIVE — IMPROVEMENTS & ENHANCEMENTS
    { key: "band-improvements", kind: "section-band", label: "Active — Improvements & Enhancements" },
    ...improvements.map((p): CapitalProjectRow => ({
      key: p.key, kind: "project", label: p.label,
      values: {
        authorized: p.authorized, contracted: p.contracted, spentYtd: p.spentYtd,
        projectedFinal: p.projectedFinal, variance: p.variance, percentDone: p.percentDone,
        estCompleteLabel: p.estCompleteLabel,
      },
      status: p.status,
    })),

    // PLANNING — PENDING BOARD AUTHORIZATION
    { key: "band-planning", kind: "section-band", label: "Planning — Pending Board Authorization" },
    {
      key: "locker-room", kind: "project", label: "Locker Room Renovation",
      values: {
        authorized: 2_800_000, contracted: null, spentYtd: null, projectedFinal: null,
        variance: null, percentDone: 0.00,
        estCompleteLabel: "TBD",
      },
      projectedFinalLabel: "TBD",
      status: planning,
    },
    {
      key: "locker-room-comment", kind: "commentary",
      text:
        `Design development complete. Board presentation scheduled for ` +
        `${opts.period.nextYearQuarterLabel}. Funding would come from reserve fund ` +
        `and supplemental initiation fee allocation.`,
    },

    // TOTAL — ALL AUTHORIZED PROJECTS (active only)
    {
      key: "total-authorized", kind: "total", label: "Total — All Authorized Projects",
      values: {
        authorized: totalAuthorized, contracted: totalContracted, spentYtd: totalSpentYtd,
        projectedFinal: totalProjectedFinal, variance: totalVariance,
        percentDone: null, estCompleteLabel: "",
      },
    },
  ];

  const exceptionReport = buildCapitalProjectExceptionReport({
    periodLabel: opts.period.currentYearQuarterLabel,
    activeProjects: activeProjects.map((p) => ({
      label: p.label, variance: p.variance, status: p.status.tone,
    })),
  });

  const projectNotes = buildCapitalProjectNotes({
    largestPendingProjectLabel: "Locker Room Renovation",
    reserveBalanceLabel: opts.reserveBalanceLabel,
    nextBoardMeetingLabel: opts.period.nextYearQuarterLabel,
    statementOfActivitiesNumber: opts.statementOfActivitiesNumber,
  });

  return {
    dataSource: "demo",
    eyebrow: `${opts.clubName} · Capital Projects`,
    title: "Capital Project Tracker",
    periodLabel: opts.period.statementHeaderLabel,
    introNote:
      "What was approved, what has been spent, and whether any project is off course.",
    statementNumber: "Statement 06 of 14",
    documentChip: "Capital Projects",
    preparedFor: "Finance Committee",
    columnHeaders: {
      project:        "Project",
      authorized:     "Authorized",
      contracted:     "Contracted",
      spentYtd:       "Spent YTD",
      projectedFinal: "Proj. Final",
      variance:       "Variance",
      percentDone:    "% Done",
      estComplete:    "Est. Complete",
      status:         "Status",
    },
    rows,
    exceptionReport,
    projectNotes,
  };
}

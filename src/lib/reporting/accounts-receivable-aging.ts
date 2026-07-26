// Accounts Receivable Aging service — chapter VIII.
//
// Owns the AR aging table, the 4 summary KPI cards, the membership
// activity table, and the reactive collection notes. Period labels
// flow from `ReportingPeriod` per the Golden Rule.

import type { ReportingDataSource } from "@/lib/reporting/monthly-package";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";

// =============================================================================
// Public types
// =============================================================================

/** Tone class for an AR aging status pill. Restrained brand
 *  palette — no SaaS stoplight saturation. */
export type ARAgingStatus =
  | "current"
  | "watch"
  | "collection"
  | "suspended"
  | "write-off-review";

export type ARAgingStatusLabel = {
  /** Display label (e.g. "Current"). The component uppercases at
   *  render time. */
  label: string;
  tone: ARAgingStatus;
};

export type ARAgingRowKind = "section-band" | "category" | "total";

export type ARAgingRow = {
  key: string;
  kind: ARAgingRowKind;
  label?: string;
  /** Per-bucket numeric values. Present on category + total rows. */
  values?: {
    current: number | null;
    days31to60: number | null;
    days61to90: number | null;
    over90: number | null;
    totalBalance: number | null;
  };
  /** Optional status pill on category rows. */
  status?: ARAgingStatusLabel;
};

export type ARKpiCard = {
  key: string;
  label: string;
  /** Pre-formatted value ("$984,200", "99.9%", "$820", "$—"). */
  valueLabel: string;
  /** Tone hint for the value colour:
   *   - "neutral"  — default body-text colour
   *   - "favorable" — brand green (e.g. high current % is favourable)
   *   - "risk"     — clay (e.g. material over-90 balance is unfavourable)
   *   - "empty"    — slightly muted (when value is em-dash) */
  tone: "neutral" | "favorable" | "risk" | "empty";
};

export type MembershipActivityRowKind = "activity" | "net-change" | "total";

export type MembershipActivityRow = {
  key: string;
  kind: MembershipActivityRowKind;
  label: string;
  /** Display values for each column — formatting (sign prefix, "+N",
   *  "362 projected") is service-owned so the React surface renders
   *  raw strings. */
  currentLabel: string;
  comparativeLabel: string;
  changeLabel: string;
  /** Whether the change is favourable (green) or unfavourable (clay). */
  changeTone: "favorable" | "risk" | "neutral";
  annualForecastLabel: string;
};

export type ARCollectionNote = { text: string };

export type AccountsReceivableAging = {
  dataSource: ReportingDataSource;
  // Header chrome — same shape as the other Saguaro chapters.
  eyebrow: string;
  title: string;
  periodLabel: string;
  introNote: string;
  statementNumber: string;
  documentChip: string;
  preparedFor: string;
  // 4 KPI summary cards.
  kpiCards: ReadonlyArray<ARKpiCard>;
  // 7-column AR aging table.
  agingColumnHeaders: {
    category: string;
    current: string;
    days31to60: string;
    days61to90: string;
    over90: string;
    totalBalance: string;
    status: string;
  };
  agingRows: ReadonlyArray<ARAgingRow>;
  // 5-column membership activity table.
  membershipColumnHeaders: {
    activity: string;
    /** Current-period column — derived as e.g. "Q2 2026" from
     *  `ReportingPeriod.currentYearQuarterLabel`. */
    current: string;
    /** Prior-year same-period column — e.g. "Q2 2025". */
    comparative: string;
    change: string;
    annualForecast: string;
  };
  membershipRows: ReadonlyArray<MembershipActivityRow>;
  // Reactive collection notes block.
  collectionNotes: {
    eyebrow: string;
    notes: ReadonlyArray<ARCollectionNote>;
  };
};

// =============================================================================
// Reactive collection notes generator
// =============================================================================

export type CollectionNotesInputs = {
  /** Pre-formatted total AR balance label (e.g. "$984,200"). */
  totalArBalanceLabel: string;
  /** Pre-formatted current-bucket % (e.g. "99.9%"). */
  currentPctLabel: string;
  /** Pre-formatted 30-60 day bucket label (e.g. "$820"). */
  bucket30to60Label: string;
  /** Pre-formatted net member additions for the current period (e.g. "5"). */
  netMemberAdditionsLabel: string;
  /** Quarter label of the current period (e.g. "Q2") — derived from
   *  `ReportingPeriod.quarterLabel`. */
  periodQuarterLabel: string;
  /** Pre-formatted YTD initiation fee revenue label (e.g. "$480,000"). */
  initiationFeeYtdLabel: string;
  /** Pre-formatted new-membership count YTD (e.g. "7"). */
  newMembershipsYtdLabel: string;
  /** Pre-formatted annual forecast count (e.g. "28"). */
  annualForecastLabel: string;
  /** Whether the period-over-period membership pace exceeds prior year. */
  paceAheadOfPriorYear: boolean;
};

export function buildCollectionNotes(
  inputs: CollectionNotesInputs,
): ReadonlyArray<ARCollectionNote> {
  return [
    {
      text:
        `AR quality is excellent. Of the ${inputs.totalArBalanceLabel} outstanding, ` +
        `${inputs.currentPctLabel} is current. The ${inputs.bucket30to60Label} in the ` +
        `30-60 day bucket is under routine follow-up. No bad debt reserve has been ` +
        `established, and none is currently warranted.`,
    },
    {
      text:
        `Membership count is growing. Net additions of ${inputs.netMemberAdditionsLabel} ` +
        `members in ${inputs.periodQuarterLabel}, ` +
        `${inputs.paceAheadOfPriorYear ? "ahead of" : "behind"} the prior year's ` +
        `${inputs.periodQuarterLabel} pace. Initiation fee revenue YTD of ` +
        `${inputs.initiationFeeYtdLabel} reflects ${inputs.newMembershipsYtdLabel} new ` +
        `memberships at current pricing. Annual forecast of ${inputs.annualForecastLabel} ` +
        `net new memberships remains achievable.`,
    },
  ];
}

// =============================================================================
// Seeded Silver Springs AR aging
// =============================================================================

function formatDollars(value: number): string {
  if (value === 0) return "$—";
  return `$${value.toLocaleString("en-US")}`;
}

export function buildSilverSpringsAccountsReceivableAging(opts: {
  clubName: string;
  period: ReportingPeriod;
}): AccountsReceivableAging {
  // -- Seeded numerics (Saguaro reference Q1 2026 verbatim) --
  const membershipDuesCurrent      = 844_200;
  const membershipDues31to60       = 400;
  const fbCurrent                  = 98_200;
  const fb31to60                   = 280;
  const golfCurrent                = 28_400;
  const golf31to60                 = 140;
  const amenitiesCurrent           = 12_580;

  const totalCurrent =
    membershipDuesCurrent + fbCurrent + golfCurrent + amenitiesCurrent;
  const total31to60 =
    membershipDues31to60 + fb31to60 + golf31to60;
  const total61to90 = 0;
  const totalOver90 = 0;

  const membershipDuesBalance = membershipDuesCurrent + membershipDues31to60;
  const fbBalance             = fbCurrent + fb31to60;
  const golfBalance           = golfCurrent + golf31to60;
  const amenitiesBalance      = amenitiesCurrent;
  const totalAR = totalCurrent + total31to60 + total61to90 + totalOver90;
  const currentPct = totalCurrent / totalAR; // ~0.999

  // -- KPI cards --
  const kpiCards: ReadonlyArray<ARKpiCard> = [
    {
      key: "total-ar-balance", label: "Total AR Balance",
      valueLabel: `$${totalAR.toLocaleString("en-US")}`,
      tone: "neutral",
    },
    {
      key: "current-pct", label: "Current — 0 to 30 Days",
      valueLabel: `${(currentPct * 100).toFixed(1)}%`,
      tone: "favorable",
    },
    {
      key: "bucket-30-60", label: "30-60 Day Balance",
      valueLabel: formatDollars(total31to60),
      tone: "neutral",
    },
    {
      key: "over-90", label: "Over 90 Days",
      valueLabel: formatDollars(totalOver90),
      tone: "empty",
    },
  ];

  const currentStatus: ARAgingStatusLabel = { label: "Current", tone: "current" };

  // -- AR aging table rows --
  const agingRows: ARAgingRow[] = [
    { key: "band-by-category", kind: "section-band", label: "By Charge Category" },
    { key: "membership-dues", kind: "category", label: "Membership Dues",
      values: {
        current: membershipDuesCurrent,
        days31to60: membershipDues31to60,
        days61to90: 0,
        over90: 0,
        totalBalance: membershipDuesBalance,
      },
      status: currentStatus,
    },
    { key: "fb-charges", kind: "category", label: "Food & Beverage Charges",
      values: {
        current: fbCurrent,
        days31to60: fb31to60,
        days61to90: 0,
        over90: 0,
        totalBalance: fbBalance,
      },
      status: currentStatus,
    },
    { key: "golf-pro-shop", kind: "category", label: "Golf Fees & Pro Shop",
      values: {
        current: golfCurrent,
        days31to60: golf31to60,
        days61to90: 0,
        over90: 0,
        totalBalance: golfBalance,
      },
      status: currentStatus,
    },
    { key: "amenities-other", kind: "category", label: "Amenities & Other Charges",
      values: {
        current: amenitiesCurrent,
        days31to60: 0,
        days61to90: 0,
        over90: 0,
        totalBalance: amenitiesBalance,
      },
      status: currentStatus,
    },
    { key: "total-ar", kind: "total", label: "Total Accounts Receivable",
      values: {
        current: totalCurrent,
        days31to60: total31to60,
        days61to90: total61to90,
        over90: totalOver90,
        totalBalance: totalAR,
      },
    },
  ];

  // -- Membership activity --
  const newMembershipsCurrent     = 7;
  const newMembershipsComparative = 6;
  const resignationsCurrent       = 2;
  const resignationsComparative   = 3;
  const netChangeCurrent =
    newMembershipsCurrent - resignationsCurrent;
  const netChangeComparative =
    newMembershipsComparative - resignationsComparative;
  const activeCountCurrent       = 342;
  const activeCountComparative   = 337;
  const annualForecastNew        = 28;
  const annualForecastResig      = 8;
  const annualForecastNet        = 20;
  const projectedActiveCount     = 362;
  const initiationFeeYtd         = 480_000;

  const membershipRows: ReadonlyArray<MembershipActivityRow> = [
    {
      key: "new-memberships", kind: "activity",
      label: "New Memberships Initiated",
      currentLabel: `${newMembershipsCurrent}`,
      comparativeLabel: `${newMembershipsComparative}`,
      changeLabel: `+${newMembershipsCurrent - newMembershipsComparative}`,
      changeTone: "favorable",
      annualForecastLabel: `${annualForecastNew}`,
    },
    {
      key: "resignations", kind: "activity",
      label: "Resignations",
      currentLabel: `${resignationsCurrent}`,
      comparativeLabel: `${resignationsComparative}`,
      // Favourable: fewer resignations than prior year is positive,
      // so the change figure (1 fewer) reads as +1 favourable.
      changeLabel: `+${resignationsComparative - resignationsCurrent}`,
      changeTone: "favorable",
      annualForecastLabel: `${annualForecastResig}`,
    },
    {
      key: "net-membership-change", kind: "net-change",
      label: "Net Membership Change",
      currentLabel: `+${netChangeCurrent}`,
      comparativeLabel: `+${netChangeComparative}`,
      changeLabel: `+${netChangeCurrent - netChangeComparative}`,
      changeTone: "favorable",
      annualForecastLabel: `+${annualForecastNet}`,
    },
    {
      key: "active-membership-count", kind: "total",
      label: "Active Membership Count",
      currentLabel: `${activeCountCurrent}`,
      comparativeLabel: `${activeCountComparative}`,
      changeLabel: `+${activeCountCurrent - activeCountComparative}`,
      changeTone: "favorable",
      annualForecastLabel: `${projectedActiveCount} projected`,
    },
  ];

  // -- Reactive collection notes --
  const collectionNotes = {
    eyebrow: "Collection Notes",
    notes: buildCollectionNotes({
      totalArBalanceLabel: `$${totalAR.toLocaleString("en-US")}`,
      currentPctLabel: `${(currentPct * 100).toFixed(1)}%`,
      bucket30to60Label: formatDollars(total31to60),
      netMemberAdditionsLabel: `${netChangeCurrent}`,
      periodQuarterLabel: opts.period.quarterLabel,
      initiationFeeYtdLabel: `$${initiationFeeYtd.toLocaleString("en-US")}`,
      newMembershipsYtdLabel: `${newMembershipsCurrent}`,
      annualForecastLabel: `${annualForecastNew}`,
      paceAheadOfPriorYear: netChangeCurrent > netChangeComparative,
    }),
  };

  // Column-header period labels — derive from ReportingPeriod.
  // Current period column gets "Q[n] {year}" (e.g. "Q2 2026" for May);
  // comparative column gets "Q[n] {year-1}" (e.g. "Q2 2025").
  const currentYearQuarter   = opts.period.currentYearQuarterLabel;
  const priorYearQuarter     = `${opts.period.quarterLabel} ${opts.period.year - 1}`;

  return {
    dataSource: "demo",
    eyebrow: `${opts.clubName} · AR Aging`,
    title: "Accounts Receivable Aging",
    periodLabel: opts.period.statementHeaderLabel,
    introNote: "Member account balances and collection status.",
    statementNumber: "Statement 10 of 14",
    documentChip: "AR Aging",
    preparedFor: "Finance Committee",
    kpiCards,
    agingColumnHeaders: {
      category: "Category",
      current: "Current (0-30)",
      days31to60: "31-60 Days",
      days61to90: "61-90 Days",
      over90: "Over 90",
      totalBalance: "Total Balance",
      status: "Status",
    },
    agingRows,
    membershipColumnHeaders: {
      activity: "Membership Activity",
      current: currentYearQuarter,
      comparative: priorYearQuarter,
      change: "Change",
      annualForecast: "Annual Forecast",
    },
    membershipRows,
    collectionNotes,
  };
}

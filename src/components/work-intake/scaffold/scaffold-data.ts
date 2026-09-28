// WI-1 (2026-09-27) — Work Intake scaffold data.
//
// Static representative content matching the approved reference
// verbatim per §15. These values are intentionally hard-coded for
// visual scaffolding. Real Work Intake data replaces this map in a
// later slice without redesigning the presentation.

export type WiIcon =
  | "invoice"
  | "payroll"
  | "member"
  | "ap"
  | "hire"
  | "chart";

export type WiStatusTone = "judgment" | "confirm" | "review" | "fyi";

export interface WiFeedRow {
  id: string;
  icon: WiIcon;
  title: string;
  metaLine: string;
  description: string;
  status: { label: string; tone: WiStatusTone };
  timestamp: string;
  attachments?: { kind: "thumb" | "doc"; count?: number }[];
  participants?: { initials: string; tone?: "green" | "gold" | "neutral" }[];
  actionLabel: "Review" | "View";
  /** WI-2A — when present, the primary action renders as a link to
   *  the review page. Non-linked rows keep the inert `<button>` from
   *  the scaffold. Only row-1 (Capital Invoice) links today. */
  reviewHref?: string;
}

export const WI_FEED_ROWS: WiFeedRow[] = [
  {
    id: "row-1",
    icon: "invoice",
    title: "Capital Invoice · Fairway irrigation controls",
    metaLine: "Irrigation Systems Ltd. · $42,680.00",
    description: "Matches approved 2026 capital plan · Asset purchase identified",
    status: { label: "Requires your judgment", tone: "judgment" },
    timestamp: "Today · 11:24 AM",
    attachments: [{ kind: "thumb" }, { kind: "doc" }, { kind: "doc", count: 2 }],
    actionLabel: "Review",
    reviewHref: "/app/admin/work-intake/review/row-1",
  },
  {
    id: "row-2",
    icon: "payroll",
    title: "Payroll · 3 exceptions require confirmation",
    metaLine: "Paychex",
    description:
      "All approvals complete, but 3 exceptions need confirmation before posting to the general ledger.",
    status: { label: "Needs confirmation", tone: "confirm" },
    timestamp: "Today · 9:17 AM",
    participants: [
      { initials: "SM", tone: "green" },
      { initials: "RL", tone: "gold" },
      { initials: "+2", tone: "neutral" },
    ],
    actionLabel: "Review",
  },
  {
    id: "row-3",
    icon: "member",
    title: "Credit adjustment approval",
    metaLine: "James R. Whittaker · Member #10428",
    description:
      "$1,250.00 credit requested due to event cancellation. Member has a strong payment history.",
    status: { label: "Requires your judgment", tone: "judgment" },
    timestamp: "Yesterday · 4:36 PM",
    attachments: [{ kind: "doc" }],
    actionLabel: "Review",
  },
  {
    id: "row-4",
    icon: "ap",
    title: "AP Invoice · Course maintenance supplies",
    metaLine: "The Home Depot Pro · $2,842.17",
    description: "Routine course supplies. PO matched and received.",
    status: { label: "Ready for review", tone: "review" },
    timestamp: "Today · 2:18 PM",
    attachments: [{ kind: "doc" }],
    actionLabel: "Review",
  },
  {
    id: "row-5",
    icon: "hire",
    title: "New hire setup · Assistant Golf Professional",
    metaLine: "Samantha Lewis",
    description:
      "All required documentation received. Ready to create accounts and add to payroll.",
    status: { label: "Ready for review", tone: "review" },
    timestamp: "Today · 1:03 PM",
    attachments: [{ kind: "doc" }, { kind: "doc" }],
    actionLabel: "Review",
  },
  {
    id: "row-6",
    icon: "chart",
    title: "Staffing variance · Carter Wedding",
    metaLine: "Wedding – Carter",
    description:
      "+12% over forecast. Primarily due to extended event time (2.5 hrs).",
    status: { label: "FYI", tone: "fyi" },
    timestamp: "Yesterday · 6:11 PM",
    attachments: [{ kind: "thumb" }],
    actionLabel: "View",
  },
];

// KPI scaffold — reference values verbatim per §12 including trend
// indicators. Do not replace with staging values in WI-1.
export interface WiKpi {
  icon: "calendar" | "clock" | "people" | "check";
  value: number;
  label: string;
  trend:
    | { direction: "down"; delta: string; tone: "attention" }
    | { direction: "up"; delta: string; tone: "positive" }
    | { direction: "flat"; delta: string; tone: "neutral" };
}
export const WI_KPIS: WiKpi[] = [
  {
    icon: "calendar",
    value: 12,
    label: "Items need your attention",
    trend: { direction: "down", delta: "3 from last week", tone: "attention" },
  },
  {
    icon: "clock",
    value: 8,
    label: "Items ready for review",
    trend: { direction: "up", delta: "2 from last week", tone: "positive" },
  },
  {
    icon: "people",
    value: 5,
    label: "Waiting on others",
    trend: { direction: "flat", delta: "No change", tone: "neutral" },
  },
  {
    icon: "check",
    value: 28,
    label: "Completed this week",
    trend: { direction: "up", delta: "12% from last week", tone: "positive" },
  },
];

// Right rail scaffold — reference verbatim per §11.
export interface WiRailData {
  position: {
    memberAr: string;
    over60Days: string;
    teeTimesToday: number;
    reservationsTonight: number;
    coversProjected: number;
  };
  insight: {
    body: string;
    source: string;
    at: string;
  };
  commitments: {
    empty: string;
  };
}
export const WI_RAIL: WiRailData = {
  position: {
    memberAr: "$0.00",
    over60Days: "$0.00",
    teeTimesToday: 0,
    reservationsTonight: 0,
    coversProjected: 0,
  },
  insight: {
    body:
      "Member AR is inside the sixty-day policy line. No accounts require collections judgment this morning.",
    source: "AR ageing report",
    at: "09:30 MDT",
  },
  commitments: {
    empty: "No appointments or proposed follow-ups for today.",
  },
};

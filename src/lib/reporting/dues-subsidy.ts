// ---------------------------------------------------------------------------
// Dues Subsidy Analysis reporting service.
//
// Owns the donut + legend data for the Dues Subsidy Analysis card on
// the Chair's Dashboard. Inputs are the raw dues + member count + a
// list of expense-allocation categories with percentages. The service:
//
//   - Computes the per-member dues figure (totalDues ÷ memberCount).
//   - Formats the summary line ("$10.38M / 253 Members = ~$41K /
//     member / yr") so React renders pre-built strings.
//   - Assigns each category a colour from a 15-step restrained
//     green / gold / sand palette (per Saguaro's editorial register
//     — NO bright SaaS chart colours).
//   - Computes cumulative arc angles so the React donut can render
//     each slice without doing any maths client-side.
// ---------------------------------------------------------------------------

import type { ReportingDataSource } from "./monthly-package";

/** Raw allocation category — percent of total dues spent on this
 *  category. The pct values are board-policy assumptions; a real club
 *  would replace them with department GL aggregates / dues. */
export type DuesCategoryInput = {
  key: string;
  label: string;
  pct: number;
};

/** Formatted category the React donut + legend consume. */
export type FormattedDuesCategory = {
  key: string;
  label: string;
  pct: number;
  /** SVG hex colour for the donut slice + legend swatch. */
  color: string;
  /** Cumulative arc start angle in DEGREES (0 = 12 o'clock). */
  arcStartAngle: number;
  /** Cumulative arc end angle in DEGREES. */
  arcEndAngle: number;
};

export type DuesSubsidyData = {
  title: string;
  subtitle: string;
  pillLabel: string;
  /** Pre-formatted "$10.38M" / "253 Members" / "~$41K / member / yr"
   *  strings — React stays a pure consumer. */
  totalDuesLabel: string;
  memberCountLabel: string;
  perMemberLabel: string;
  /** Raw numeric inputs preserved for downstream consumers + tests. */
  totalDuesDollars: number;
  memberCount: number;
  perMemberDollars: number;
  categories: FormattedDuesCategory[];
  dataSource: ReportingDataSource;
};

/** 15-step restrained palette for the donut.
 *
 *  Reading order: the largest slice (the club's biggest dues spend —
 *  usually Golf Course Maintenance) gets the deepest green; the
 *  category mix shades through olive → muted gold → tan, ending in
 *  the lowest-share slices at the lightest sand tones. NO bright
 *  primary colours, no SaaS-style "category 1 = red" stoplighting. */
const CATEGORY_PALETTE = [
  "#2a3d25",  //  1 — deepest green
  "#3f5c36",  //  2
  "#5a7d4c",  //  3
  "#c2b896",  //  4 — pale sand (sits well next to deep green)
  "#7a9466",  //  5 — soft green
  "#9aab7d",  //  6
  "#b08a4a",  //  7 — brand gold
  "#8a7544",  //  8 — olive gold
  "#c4a16d",  //  9 — light gold
  "#9c7f4a",  // 10 — medium gold
  "#7d6939",  // 11 — dark gold
  "#a89373",  // 12 — tan
  "#d4c4a3",  // 13 — sand
  "#67533d",  // 14 — deep tan
  "#5e4d2e",  // 15 — darkest tan
] as const;

/** Format dollars at $M precision with 2dp ($10,380,000 → "$10.38M"). */
function fmtDollarsM(d: number): string {
  return `$${(d / 1_000_000).toFixed(2)}M`;
}

/** Format dollars at $K precision (no decimals): 41,000 → "$41K". */
function fmtDollarsK(d: number): string {
  return `$${Math.round(d / 1000).toLocaleString("en-US")}K`;
}

export function buildDuesSubsidyData(
  totalDuesDollars: number,
  memberCount: number,
  categories: DuesCategoryInput[],
): DuesSubsidyData {
  // Assign palette colours + cumulative arc angles. The donut starts
  // at the 12-o'clock position (angle 0); each category's arc
  // occupies (pct / 100) × 360°.
  let cursor = 0;
  const formatted: FormattedDuesCategory[] = categories.map((c, i) => {
    const sweep = (c.pct / 100) * 360;
    const start = cursor;
    cursor += sweep;
    return {
      key: c.key,
      label: c.label,
      pct: c.pct,
      color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
      arcStartAngle: start,
      arcEndAngle: cursor,
    };
  });

  const perMemberDollars = memberCount > 0 ? totalDuesDollars / memberCount : 0;

  return {
    title: "Dues Subsidy Analysis",
    subtitle: '"WHAT DO MY CLUB DUES PAY FOR?" — ALLOCATION OF OPERATING EXPENSES',
    pillLabel: "DUES BREAKDOWN",
    totalDuesLabel: fmtDollarsM(totalDuesDollars),
    memberCountLabel: `${memberCount.toLocaleString("en-US")} Members`,
    perMemberLabel: `~${fmtDollarsK(perMemberDollars)} / member / yr`,
    totalDuesDollars,
    memberCount,
    perMemberDollars,
    categories: formatted,
    dataSource: "demo",
  };
}

// ---------------------------------------------------------------------------
// Silver Springs demo seeds.
// ---------------------------------------------------------------------------
/** Silver Springs total operating dues — CANONICAL constant.
 *
 *  Both this card AND the Payroll Analysis cards drive their dues
 *  figures from THIS single value (the Payroll service imports it
 *  rather than defining its own copy). This satisfies the
 *  "Single source of truth — chain" rule in CLAUDE.md → Financial
 *  Reporting Data Integrity by guaranteeing that, no matter which
 *  card displays the dues figure, the underlying number is the same.
 *
 *  Value chosen so the displayed Dues-Cover-Payroll delta lands on
 *  the founder-spec "$511K" (dues 10,381,000 − payroll 9,870,000 =
 *  511,000). Display via `fmtDollarsM` still rounds to "$10.38M";
 *  per-member calc rounds to "~$41K / member / yr". No other
 *  Saguaro-target value shifts. */
export const SILVER_SPRINGS_OPERATING_DUES = 10_381_000;
/** Back-compat alias — was the original name from when this constant
 *  only fed the dues-subsidy card. Both names point at the same
 *  canonical value; new callers should use `SILVER_SPRINGS_OPERATING_DUES`. */
export const SILVER_SPRINGS_DUES_TOTAL = SILVER_SPRINGS_OPERATING_DUES;
export const SILVER_SPRINGS_MEMBER_COUNT = 253;
// Categories sum to 100 % — asserted by tests.
// Note: pcts are configured ALLOCATION ratios (not derived from GL).
// A real club would replace these with classified expense aggregates.
export const SILVER_SPRINGS_DUES_CATEGORIES: DuesCategoryInput[] = [
  { key: "golf-course-maint",     label: "Golf Course Maint. & Staffing",            pct: 25 },
  { key: "admin",                 label: "Admin, Membership, Accounting, IT & HR",   pct: 19 },
  { key: "fb-events",             label: "F&B, Holidays & Community Events",         pct: 16 },
  { key: "lodging",               label: "Lodging & Housekeeping",                   pct:  1 },
  { key: "facilities",            label: "Facilities & Bldg Maint. & Staffing",      pct:  6 },
  { key: "marketing-realestate",  label: "Marketing & Real Estate",                  pct:  5 },
  { key: "utilities",             label: "Utilities",                                pct:  5 },
  { key: "grounds",               label: "Grounds Maintenance & Staffing",           pct:  5 },
  { key: "marina-outdoor",        label: "Marina, Outdoor Pursuits & Staffing",      pct:  4 },
  { key: "equestrian",            label: "Equestrian & Staffing",                    pct:  4 },
  { key: "property-insurance",    label: "Property Insurance",                       pct:  3 },
  { key: "legal-audit",           label: "Legal, Audit & Professional Fees",         pct:  3 },
  { key: "security",              label: "Security & Staffing",                      pct:  1 },
  { key: "poa-fees",              label: "Club Owned Lot POA Fees",                  pct:  2 },
  { key: "golf-operations",       label: "Golf Operations & Staffing",               pct:  1 },
];

// ---------------------------------------------------------------------------
// Department Net Performance Highlights reporting service.
//
// Parallel to scorecard-metrics.ts. Owns the row computation for the
// Department Net Performance card on the Chair's Dashboard. Inputs are
// the raw department actual / budget dollar amounts (negative for net
// loss). The service computes:
//
//   - Variance = ytdActual − ytdBudget (positive when favourable since
//     both numbers are negative net positions)
//   - Display strings ("(\$77K)", "(\$2,884K)") in board-style $K with
//     parens for negatives, "+\$50K" / "(\$48K)" for favourable /
//     unfavourable variance.
//   - Trend-bar widths as a percent of the row with the maximum absolute
//     variance — Saguaro's understated horizontal track convention.
//
// Demo seeds for Silver Springs live in this service file (not in React,
// not in the package builder), satisfying the data-sourcing discipline.
// ---------------------------------------------------------------------------

import type { ReportingDataSource } from "./monthly-package";

/** Raw input for one department row — dollars, signed. */
export type DepartmentRowInput = {
  key: string;
  name: string;
  ytdActual: number;
  ytdBudget: number;
};

/** Formatted row the React card consumes. */
export type FormattedDepartmentRow = {
  key: string;
  name: string;
  actualLabel: string;     // "($77K)"
  budgetLabel: string;
  varianceLabel: string;   // "+$50K" or "($48K)"
  /** Signed variance in dollars. Drives the trend-bar width + color. */
  variance: number;
  /** True iff variance > 0 (department beat budget). */
  isFavorable: boolean;
  /** Trend-bar width as a percent of the widest row in the card.
   *  Computed by the service so React stays a pure consumer. */
  trendBarPct: number;
};

export type DepartmentNetPerformanceData = {
  title: string;
  subtitle: string;
  pillLabel: string;
  rows: FormattedDepartmentRow[];
  commentary: string;
  dataSource: ReportingDataSource;
};

/** Format a signed dollar amount as "($X)" for negatives, "+$X" for
 *  favourable variances, "$X" for plain positives. Uses $K precision
 *  (no decimal) per the Saguaro reference, e.g. $77,000 → "$77K". */
function fmtDollarsK(d: number, opts: { signFavorable?: boolean } = {}): string {
  const k = Math.round(d / 1000);
  if (d === 0) return "$0K";
  if (d < 0) return `($${Math.abs(k).toLocaleString("en-US")}K)`;
  // Favourable variance gets a leading "+" — otherwise plain "$X".
  return opts.signFavorable ? `+$${k.toLocaleString("en-US")}K` : `$${k.toLocaleString("en-US")}K`;
}

export function buildDepartmentNetPerformanceData(
  inputs: DepartmentRowInput[],
  commentary: string,
): DepartmentNetPerformanceData {
  // Variances + max absolute variance for trend-bar scaling.
  const variances = inputs.map((r) => r.ytdActual - r.ytdBudget);
  const maxAbs = Math.max(...variances.map((v) => Math.abs(v)), 1);

  const rows: FormattedDepartmentRow[] = inputs.map((r, i) => {
    const variance = variances[i];
    const isFavorable = variance > 0;
    return {
      key: r.key,
      name: r.name,
      actualLabel: fmtDollarsK(r.ytdActual),
      budgetLabel: fmtDollarsK(r.ytdBudget),
      varianceLabel: fmtDollarsK(variance, { signFavorable: true }),
      variance,
      isFavorable,
      trendBarPct: Math.round((Math.abs(variance) / maxAbs) * 100),
    };
  });

  return {
    title: "Department Net Performance Highlights",
    subtitle: "ACTUAL VS. BUDGET YTD · NET DEPARTMENT RESULT AFTER ALL EXPENSES",
    pillLabel: "DEPT SUMMARY",
    rows,
    commentary,
    dataSource: "demo",
  };
}

// ---------------------------------------------------------------------------
// Silver Springs demo seeds — net department position (always negative
// for cost-centre departments). The numbers reproduce the founder-
// approved Saguaro reference. A real club would replace these with
// prisma reads against department-classified GL lines.
// ---------------------------------------------------------------------------
export const SILVER_SPRINGS_DEPARTMENT_INPUTS: DepartmentRowInput[] = [
  { key: "golf-operations",      name: "Golf Operations",         ytdActual:    -77_000, ytdBudget:   -127_000 },
  { key: "golf-course-maint",    name: "Golf Course Maintenance", ytdActual: -2_884_000, ytdBudget: -2_836_000 },
  { key: "fb",                   name: "Food & Beverage",         ytdActual: -1_886_000, ytdBudget: -1_676_000 },
  { key: "equestrian",           name: "Equestrian & Boarding",   ytdActual:   -448_000, ytdBudget:   -572_000 },
  { key: "outdoor-pursuits",     name: "Outdoor Pursuits",        ytdActual:   -409_000, ytdBudget:   -359_000 },
  { key: "lodging",              name: "Lodging & Housekeeping",  ytdActual:   -101_000, ytdBudget:    -29_000 },
  { key: "sports-barn",          name: "Sports Barn / Fitness",   ytdActual:    -91_000, ytdBudget:    -85_000 },
  { key: "security",             name: "Security",                ytdActual:    -86_000, ytdBudget:    -69_000 },
  { key: "spa",                  name: "Spa",                     ytdActual:     -1_000, ytdBudget:          0 },
];

export const SILVER_SPRINGS_DEPARTMENT_COMMENTARY =
  "Golf Operations and Equestrian both beat budget. F&B subsidy of $1.89M (−18% of dues) sits within the " +
  "healthy (12%–21%) range — lower is not better. Golf Course Maintenance is the club's largest single " +
  "cost center at $2.88M.";

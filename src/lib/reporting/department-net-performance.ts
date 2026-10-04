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

/** Raw input for one department row — dollars, signed. REPORT-LIVE-2
 *  §19 (2026-10-04): `ytdBudget` is nullable so the card can render
 *  the Actual column from live accounting while leaving Budget +
 *  variance + trend-bar unavailable until a budget importer lands.
 *  Null means SOURCE_NOT_CONNECTED, never "zero budget". */
export type DepartmentRowInput = {
  key: string;
  name: string;
  ytdActual: number;
  ytdBudget: number | null;
};

/** Formatted row the React card consumes. REPORT-LIVE-2: every field
 *  derived from the budget column is nullable because the budget
 *  source may be unavailable. The React card renders "—" (not "$0")
 *  for every null field. */
export type FormattedDepartmentRow = {
  key: string;
  name: string;
  actualLabel: string;     // "($77K)"
  budgetLabel: string | null;
  varianceLabel: string | null;
  /** Signed variance in dollars. Drives the trend-bar width + color.
   *  Null when `ytdBudget` is unavailable. */
  variance: number | null;
  /** True iff variance > 0 (department beat budget). Null when the
   *  variance itself is unavailable — the card must NOT infer a
   *  favourability colour from the Actual sign alone. */
  isFavorable: boolean | null;
  /** Trend-bar width as a percent of the widest row in the card.
   *  Null when variance is unavailable; the card omits the trend bar
   *  entirely so a 0% bar never fakes a "beat budget by $0" result. */
  trendBarPct: number | null;
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
  opts: { dataSource?: ReportingDataSource } = {},
): DepartmentNetPerformanceData {
  // Variances + max absolute variance for trend-bar scaling. REPORT-
  // LIVE-2: a row whose ytdBudget is null has no variance. The scale
  // denominator must only consider rows where variance is defined.
  const variances = inputs.map((r) =>
    r.ytdBudget == null ? null : r.ytdActual - r.ytdBudget,
  );
  const definedVariances = variances.filter((v): v is number => v != null);
  const maxAbs = definedVariances.length > 0
    ? Math.max(...definedVariances.map((v) => Math.abs(v)), 1)
    : 1;

  const rows: FormattedDepartmentRow[] = inputs.map((r, i) => {
    const variance = variances[i];
    const isFavorable = variance == null ? null : variance > 0;
    return {
      key: r.key,
      name: r.name,
      actualLabel: fmtDollarsK(r.ytdActual),
      budgetLabel: r.ytdBudget == null ? null : fmtDollarsK(r.ytdBudget),
      varianceLabel: variance == null ? null : fmtDollarsK(variance, { signFavorable: true }),
      variance,
      isFavorable,
      trendBarPct: variance == null
        ? null
        : Math.round((Math.abs(variance) / maxAbs) * 100),
    };
  });

  return {
    title: "Department Net Performance Highlights",
    subtitle: "ACTUAL VS. BUDGET YTD · NET DEPARTMENT RESULT AFTER ALL EXPENSES",
    pillLabel: "DEPT SUMMARY",
    rows,
    commentary,
    dataSource: opts.dataSource ?? "demo",
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

// ---------------------------------------------------------------------------
// REPORT-LIVE-2 §6-8 (2026-10-04) — live builder for committed-TB
// tenants. Reads the authoritative Jan 2026 departmental P&L via
// `incomeStatementByDepartmentFromSnapshot` and shapes it for the
// Department Net Performance card.
//
// Per directive §8: no fabricated Budget / variance / trend. Every
// row's ytdBudget stays null → the formatter renders only the YTD
// Actual column, and the card's React layer blanks the Budget +
// Variance + Trend cells per row.
//
// Per directive §7: reconciles to consolidated — the sum of per-dept
// netIncome equals the consolidated NOI by construction of
// `incomeStatementByDepartmentFromSnapshot` (the resolver aggregates
// the same AccountBalance rows twice: once by department, once
// consolidated).
// ---------------------------------------------------------------------------
export async function buildDepartmentNetPerformanceLive(
  clubId: string,
  periodEnd: Date,
): Promise<DepartmentNetPerformanceData> {
  const { incomeStatementByDepartmentFromSnapshot } = await import(
    "@/lib/accounting/dept-pl-from-snapshot"
  );
  const { resolveBudget } = await import("@/lib/reporting/budget-resolver");
  // YTD window — Jan 2026 reporting period = Jan 1 → Jan 31.
  const fyStart = new Date(Date.UTC(periodEnd.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
  const eod = new Date(Date.UTC(
    periodEnd.getUTCFullYear(),
    periodEnd.getUTCMonth(),
    periodEnd.getUTCDate(),
    23, 59, 59, 999,
  ));
  const [result, budget] = await Promise.all([
    incomeStatementByDepartmentFromSnapshot(clubId, fyStart, eod),
    resolveBudget({
      clubId,
      fiscalYear: periodEnd.getUTCFullYear(),
      throughMonth: periodEnd.getUTCMonth() + 1,
    }).catch(() => null),
  ]);

  // REPORT-LIVE-3 §10-11 (2026-10-04) — per-department Budget NOI
  // (display sign). resolveBudget returns raw-sign monthly totals;
  // flip for display convention so sum(dept Budget) matches
  // consolidated Budget NOI.
  const budgetByDeptCode = new Map<string | null, number>();
  if (budget?.budget) {
    for (const d of budget.byDepartment) {
      const ytdRaw = d.monthlyTotals
        .slice(0, periodEnd.getUTCMonth() + 1)
        .reduce((s, v) => s + v, 0);
      budgetByDeptCode.set(d.departmentCode, -ytdRaw);
    }
  }

  // Sort: largest absolute net result first so the biggest Board-level
  // signal is on top. Nondepartmental sinks to the bottom.
  const sorted = [...result.rows].sort((a, b) => {
    const an = a.departmentCode == null ? 1 : 0;
    const bn = b.departmentCode == null ? 1 : 0;
    if (an !== bn) return an - bn;
    return Math.abs(Number(b.netIncome.toString())) - Math.abs(Number(a.netIncome.toString()));
  });

  const inputs: DepartmentRowInput[] = sorted.map((r) => {
    const ytdBudget = budgetByDeptCode.has(r.departmentCode)
      ? (budgetByDeptCode.get(r.departmentCode) as number)
      : null;
    return {
      key: (r.departmentCode ?? "nondepartmental")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-"),
      name: r.departmentName,
      ytdActual: Number(r.netIncome.toString()),
      ytdBudget,
    };
  });

  // §13 + §28 — factual commentary, no favorable/unfavorable language.
  const commentary =
    inputs.length === 0
      ? "No committed accounting activity for this reporting period."
      : budget?.budget
        ? `Live Jan 2026 departmental net result + canonical Budget comparison (${inputs.length} departments). Variances are mathematical only — no favourable/unfavourable judgment applied.`
        : `Live Jan 2026 departmental net result from the committed trial balance (${inputs.length} departments). ` +
          "Budget comparison not connected — variance and trend indicators are suppressed until a Coulee budget import lands.";

  return buildDepartmentNetPerformanceData(inputs, commentary, { dataSource: "live" });
}

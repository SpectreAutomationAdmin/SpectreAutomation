// MBR-PY-4 (2026-10-13) — shared presentation configuration for the
// two departmental payroll comparison charts:
//
//   • Chapter II  (Financial Performance, Illustrated)
//     "Payroll Analysis — Department Breakdown"
//   • Chapter XII (Departmental Payroll Analysis)
//     "YTD Payroll by Department"
//
// Pre-MBR-PY-4 the two charts used different departmental sorting
// and different Prior-Year colours.  This module is the single
// source of truth for both; both charts read from here.
//
// Scope guard: this module is small on purpose.  It defines three
// things — series identifiers, series colours (both hex and Tailwind
// class forms), and the dept-sorting comparator.  It does NOT define
// chart typography, geometry, margins, or any other presentation
// concern — those remain in their respective chart components.

/** Hex-form palette.  Consumed by BOTH Chapter II's `seriesColors`
 *  object and Chapter XII's `EditorialGroupedBarChart` series
 *  config.  Hex is the sole source of truth; MBR-PY-4A retired the
 *  pre-existing Tailwind-class form (`PAYROLL_DEPT_SERIES_TW`)
 *  because `fill-[#7a9466]` is an arbitrary-value utility that
 *  Tailwind's JIT scanner cannot generate when the class string
 *  reaches the JSX only through module indirection — the deployed
 *  bars rendered BLACK on staging because the CSS class never
 *  existed in the compiled stylesheet.  `EditorialGroupedBarChart`
 *  already detects `color.startsWith("#")` and applies the value
 *  via the SVG `fill` attribute, bypassing the Tailwind pipeline
 *  entirely. */
export const PAYROLL_DEPT_SERIES_HEX = {
  actual:    "#3f7042", // dark green  (= Tailwind club-green-500)
  budget:    "#b08a4a", // gold        (= Tailwind club-gold DEFAULT)
  priorYear: "#7a9466", // muted sage  (Chapter II's historical hex)
} as const;

/** Series labels for legends.
 *  - current year ("2026 Actual") is period-dependent.
 *  - "Budget" is static.
 *  - MBR-PY-4A (2026-10-13): the Prior-Year label is now the
 *    STATIC string "Prior Year" (no year prefix) — the chart
 *    subtitle already carries the reporting-period year context,
 *    and a redundant "2025 Prior Year" legend chip creates visual
 *    noise next to the already period-labelled subtitle. */
export function payrollDeptSeriesLabels(reportingYear: number) {
  return {
    actual:    `${reportingYear} Actual`,
    budget:    "Budget",
    priorYear: "Prior Year",
  } as const;
}

/** Compare two chart rows.
 *  Primary: current-year YTD actual payroll DESCENDING.
 *  Secondary: department display name ALPHABETICAL (ties → ties
 *  resolve deterministically regardless of input order).
 *
 *  Both chapters emit chart rows carrying `ytdActual: number` + a
 *  display-name field; this comparator is adapter-friendly for
 *  either `name` or `fullLabel`. */
export function comparePayrollDeptForChart<
  T extends { ytdActual: number; name?: string; fullLabel?: string },
>(a: T, b: T): number {
  if (b.ytdActual !== a.ytdActual) return b.ytdActual - a.ytdActual;
  const aName = (a.name ?? a.fullLabel ?? "").toLowerCase();
  const bName = (b.name ?? b.fullLabel ?? "").toLowerCase();
  return aName.localeCompare(bName);
}

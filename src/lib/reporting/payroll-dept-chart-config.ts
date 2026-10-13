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

/** Hex-form palette.  Consumed by services that produce
 *  presentation objects (e.g. Chapter II's `seriesColors` object). */
export const PAYROLL_DEPT_SERIES_HEX = {
  actual:    "#3f7042", // dark green  (= Tailwind club-green-500)
  budget:    "#b08a4a", // gold        (= Tailwind club-gold DEFAULT)
  priorYear: "#7a9466", // muted sage  (Chapter II's historical hex)
} as const;

/** Tailwind-class-form palette.  Consumed by Chapter XII's
 *  `EditorialGroupedBarChart` which expects fill-* utility class
 *  strings for its SVG rects. */
export const PAYROLL_DEPT_SERIES_TW = {
  actual:    "fill-club-green-500",
  budget:    "fill-club-gold",
  // Muted sage not in the Tailwind palette — JIT compiles the
  // arbitrary-value utility exactly once per build.  Keeping the
  // literal here (vs. inside the chart file) guarantees both
  // chapters stay in sync when the brand palette evolves.
  priorYear: "fill-[#7a9466]",
} as const;

/** Series labels for legends.  The current-year label is a function
 *  because its "YYYY Actual" prefix is period-dependent. */
export function payrollDeptSeriesLabels(reportingYear: number) {
  return {
    actual:    `${reportingYear} Actual`,
    budget:    "Budget",
    priorYear: `${reportingYear - 1} Prior Year`,
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

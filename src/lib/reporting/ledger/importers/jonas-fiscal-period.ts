// Jonas-import fiscal-period helpers.
//
// A Jonas Trial Balance heading gives us a CALENDAR month + year
// (e.g. "Trial Balance for Apr, 2026"). The Reporting Ledger
// snapshot needs FISCAL period bounds: `periodStart` (first day of
// the fiscal year containing the statement date) and `periodEnd`
// (the statement date itself = month-end).
//
// `periodEnd` always = the last calendar day of the heading's month.
// `periodStart` depends on the club's fiscal-year-end policy:
//
//   FY end Dec 31 + heading Apr 2026 → start Jan 1, 2026
//   FY end Oct 31 + heading Apr 2026 → start Nov 1, 2025
//   FY end Oct 31 + heading Oct 2026 → start Nov 1, 2025
//   FY end Oct 31 + heading Nov 2026 → start Nov 1, 2026
//
// Pure functions; no I/O. The server actions read the club's stored
// `fiscalYearEndMonth`/`fiscalYearEndDay` from prisma and pass them
// in. When the club hasn't set its fiscal year end yet, callers
// should fall back to the Dec 31 default — the most common convention.

/** Last calendar day of `(year, month1to12)`, at end-of-day UTC. */
export function lastDayOfMonthUtc(year: number, month1to12: number): Date {
  return new Date(Date.UTC(year, month1to12, 0, 23, 59, 59, 999));
}

/**
 * Compute the fiscal-year START date for the fiscal year that
 * CONTAINS `periodEnd`, given the club's fiscal-year-end month/day.
 *
 * Algorithm:
 *   1. Find the FIRST occurrence of (fyEndMonth, fyEndDay) at-or-
 *      after `periodEnd` — that's the FY end of the FY containing
 *      `periodEnd`.
 *   2. Subtract one year and add one day to get the FY start.
 *
 * Returned date is at start-of-day UTC (00:00:00).
 */
export function computeFiscalYearStart(
  periodEnd: Date,
  fyEndMonth: number,
  fyEndDay: number,
): Date {
  if (!Number.isInteger(fyEndMonth) || fyEndMonth < 1 || fyEndMonth > 12) {
    throw new Error(`fyEndMonth must be 1..12; got ${fyEndMonth}`);
  }
  if (!Number.isInteger(fyEndDay) || fyEndDay < 1 || fyEndDay > 31) {
    throw new Error(`fyEndDay must be 1..31; got ${fyEndDay}`);
  }

  const yr = periodEnd.getUTCFullYear();
  // Candidate FY end in the same calendar year as periodEnd, at
  // end-of-day so a periodEnd that's exactly the FY end is treated
  // as the LAST day of that FY.
  let fyEnd = new Date(Date.UTC(yr, fyEndMonth - 1, fyEndDay, 23, 59, 59, 999));
  if (fyEnd.getTime() < periodEnd.getTime()) {
    // This calendar year's FY end has already passed; the FY
    // containing periodEnd ends NEXT calendar year.
    fyEnd = new Date(Date.UTC(yr + 1, fyEndMonth - 1, fyEndDay, 23, 59, 59, 999));
  }

  // FY start = day AFTER the previous year's FY end (= one year
  // before fyEnd, plus one day).
  const start = new Date(
    Date.UTC(fyEnd.getUTCFullYear() - 1, fyEnd.getUTCMonth(), fyEnd.getUTCDate(), 0, 0, 0, 0),
  );
  start.setUTCDate(start.getUTCDate() + 1);
  return start;
}

/**
 * Compute the fiscal-year LABEL (year integer) and fiscal-period
 * number (1..12) for a statement date, given the club's fiscal-
 * year-end policy.
 *
 * Spectre convention: the fiscal year is named by the CALENDAR
 * YEAR in which the FY ends (e.g. a Jul 1 2025 – Jun 30 2026 FY
 * is "FY 2026"). The fiscal period is the 1-indexed month count
 * from the FY start to the statement date.
 *
 * Worked examples:
 *   FY end Dec 31 + statement Apr 30 2026 → FY 2026 · period 4
 *   FY end Oct 31 + statement Apr 30 2026 → FY 2026 · period 6
 *   FY end Jun 30 + statement May 31 2026 → FY 2026 · period 11
 *   FY end Mar 31 + statement May 31 2026 → FY 2027 · period 2
 */
export function computeFiscalLabels(
  periodEnd: Date,
  fyEndMonth: number,
  fyEndDay: number,
): { fiscalYearNum: number; fiscalPeriodNum: number } {
  const fyStart = computeFiscalYearStart(periodEnd, fyEndMonth, fyEndDay);
  // FY end = fyStart + 1 year − 1 day. The calendar year of that
  // end-date is the FY label by convention.
  const fyEnd = new Date(
    Date.UTC(fyStart.getUTCFullYear() + 1, fyStart.getUTCMonth(), fyStart.getUTCDate()),
  );
  fyEnd.setUTCDate(fyEnd.getUTCDate() - 1);
  const fiscalYearNum = fyEnd.getUTCFullYear();
  // Period = number of (whole) months from FY start to statement
  // date, inclusive. Statement date is always a month-end, so the
  // result is a clean integer 1..12.
  const fiscalPeriodNum =
    (periodEnd.getUTCFullYear() - fyStart.getUTCFullYear()) * 12 +
    (periodEnd.getUTCMonth() - fyStart.getUTCMonth()) +
    1;
  return { fiscalYearNum, fiscalPeriodNum };
}

/** Default fiscal year end when the club hasn't configured one.
 *  December 31 is the most common private-club convention. */
export const DEFAULT_FISCAL_YEAR_END = { month: 12, day: 31 } as const;

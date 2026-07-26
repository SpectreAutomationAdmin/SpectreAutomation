// Fiscal-period math, centralised for every reporting surface.
//
// Goal: given (clubId, date) compute the period N of 12 the date sits
// in, the fiscal-year label, and the fiscal-year start/end. Pure date
// arithmetic — no DB lookup of the FiscalPeriod table — so the helper
// is stable for any date including dates that fall outside the range
// of already-generated FiscalPeriod rows (e.g. preview rendering for
// a future month, or running ad-hoc reports before the new FY is
// materialised).
//
// Inputs:
//   - fiscalYearEndMonth: 1..12 (Jan..Dec)
//   - fiscalYearEndDay:   1..31
//   - date:               any Date (compared in UTC)
//
// Result:
//   - periodNumber:    1..12, months elapsed from FY start inclusive
//   - totalPeriods:    always 12 (monthly accounting periods)
//   - fiscalYearStart: first DAY of the fiscal year (UTC midnight)
//   - fiscalYearEnd:   last DAY of the fiscal year (UTC midnight)
//   - fiscalYearLabel: "FY2026 (Jul–Jun)" style — month-pair derived
//                      from the FY end month so the label is stable
//                      across calendar boundaries
//
// Examples (anchored to the spec):
//   FYE Jun 30, date = May 15 2026 → period 11, FY2026 (Jul–Jun)
//   FYE Dec 31, date = May 15 2026 → period 5,  FY2026 (Jan–Dec)
//   FYE Jan 31, date = May 15 2026 → period 4,  FY2027 (Feb–Jan)
//
// The "FY label" follows the convention that the FY is named for the
// calendar year containing the FY end. So an FY that ENDS Jan 31 2027
// is "FY2027", not "FY2026".

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export type FiscalPeriodResult = {
  periodNumber: number;
  totalPeriods: 12;
  fiscalYearStart: Date;
  fiscalYearEnd: Date;
  fiscalYearLabel: string;
};

export function computeFiscalPeriod(
  fiscalYearEndMonth: number,
  fiscalYearEndDay: number,
  date: Date,
): FiscalPeriodResult {
  validateMonthDay(fiscalYearEndMonth, fiscalYearEndDay);

  // Strip to UTC midnight so all date math is calendar-day exact.
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

  // Step 1 — find the FY end that's >= `date` (the FY this date belongs
  // to). If FY ends this calendar year and date is past it, the FY
  // ends next calendar year.
  const sameYearEnd = new Date(Date.UTC(utc.getUTCFullYear(), fiscalYearEndMonth - 1, fiscalYearEndDay));
  const fyEnd = utc.getTime() <= sameYearEnd.getTime()
    ? sameYearEnd
    : new Date(Date.UTC(utc.getUTCFullYear() + 1, fiscalYearEndMonth - 1, fiscalYearEndDay));

  // Step 2 — FY start = day after the previous FY end = one year before
  // `fyEnd`, then +1 calendar day.
  const fyStart = addOneDay(new Date(Date.UTC(fyEnd.getUTCFullYear() - 1, fyEnd.getUTCMonth(), fyEnd.getUTCDate())));

  // Step 3 — period N = months elapsed from FY start to `date`'s
  // calendar month + 1 (1-based). This treats partial months as a full
  // period, which matches the operational convention ("May 2026 is
  // period 11" even on May 1).
  const monthsElapsed =
    (utc.getUTCFullYear() - fyStart.getUTCFullYear()) * 12 +
    (utc.getUTCMonth() - fyStart.getUTCMonth());
  const periodNumber = Math.max(1, Math.min(12, monthsElapsed + 1));

  // Step 4 — label: "FY{year} ({startMonth}-{endMonth})" where year is
  // the calendar year of the FY end.
  const startMonthAbbr = MONTH_ABBR[fyStart.getUTCMonth()];
  const endMonthAbbr = MONTH_ABBR[fyEnd.getUTCMonth()];
  const fiscalYearLabel = `FY${fyEnd.getUTCFullYear()} (${startMonthAbbr}-${endMonthAbbr})`;

  return {
    periodNumber,
    totalPeriods: 12,
    fiscalYearStart: fyStart,
    fiscalYearEnd: fyEnd,
    fiscalYearLabel,
  };
}

function addOneDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

function validateMonthDay(month: number, day: number) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`fiscalYearEndMonth must be 1..12 (got ${month})`);
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error(`fiscalYearEndDay must be 1..31 (got ${day})`);
  }
  // Sanity: reject impossible combinations like Feb 30 / Apr 31.
  // JS Date "rolls over" — Date(2024, 1, 30) becomes Mar 1 — so we
  // compare the constructed date back to the requested fields.
  const trial = new Date(Date.UTC(2024, month - 1, day)); // 2024 is a leap year so Feb 29 is valid
  if (trial.getUTCMonth() !== month - 1 || trial.getUTCDate() !== day) {
    throw new Error(`fiscalYearEnd ${month}/${day} is not a valid calendar day`);
  }
}

// One-word convenience: "Eleven of Twelve". Used by the monthly
// reporting cover so the period reads as editorial prose.
const ORDINAL_WORDS = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six",
  "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
];
export function ordinalWord(n: number): string {
  return ORDINAL_WORDS[n] ?? String(n);
}

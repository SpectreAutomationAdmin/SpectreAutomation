// Payroll-3B-5B-1a (2026-08-31) — CPP contribution age-eligibility
// resolver.
//
// PURE function. No I/O. No dollar math. No YTD lookup.
//
// Determines whether Canada Pension Plan (base + CPP2) contributions
// apply to a particular pay date given an Employee's date of birth
// and, optionally, an active CPT30 election. The 3B-5B calculator
// calls this and then applies the resulting contribution windows
// against the pay period.
//
// -----------------------------------------------------------------
// CRA specification (paraphrased; verify against CRA T4127 / T4001
// / RC4120 before seeding production statutory values):
//
//   • Under age 18 —
//       CPP contributions are NOT deducted.
//   • When an Employee turns 18 —
//       Begin CPP deductions with the first pay dated in the MONTH
//       AFTER the Employee turns 18. Example: 18th birthday on
//       Aug 10 2026 → first CPP-contributing pay dated on/after
//       Sep 1 2026.
//   • Age 18 through 69 (inclusive) —
//       CPP generally applies where the other pensionable-
//       employment conditions are met.
//   • Age 65–69 —
//       Employee receiving a CPP/QPP retirement pension may elect
//       to STOP CPP contributions using Form CPT30. The election
//       takes effect the first day of the month AFTER the employer
//       receives it. A REVOCATION also takes effect the first day
//       of the following month. Age alone does not stop CPP at 65.
//   • Turns 70 —
//       CPP deductions continue up to and INCLUDING the last pay
//       dated in the MONTH the Employee turns 70. No CPP after
//       that. Example: 70th birthday on Nov 10 2026 → last
//       CPP-contributing pay dated on/before Nov 30 2026; no CPP
//       for pays dated Dec 1 2026 onward.
//
// The annual CPP maximum must be prorated by CRA-recognised
// contributory months when any of these apply:
//   turns 18 during year, turns 70 during year, CPT30 election /
//   revocation during year, CPP disability, death during year.
//
// Simple `age >= 18 && age < 70` logic is WRONG at the birthday
// boundary — always apply the calendar-month rule via this
// resolver.
// -----------------------------------------------------------------

export type CppInapplicableReason =
  | "UNDER_18_BEFORE_BIRTHDAY_MONTH"
  | "TURNED_18_AND_IN_BIRTHDAY_MONTH_OR_EARLIER"
  | "TURNED_70_AND_PAST_BIRTHDAY_MONTH"
  | "CPT30_ELECTION_STOP"
  | "MISSING_DOB";

export interface CppEligibilityInput {
  /** Civil-date DOB (UTC midnight). NULL = missing. */
  dateOfBirth: Date | null;
  /** Pay-date the eligibility is being resolved for (UTC midnight). */
  payDate: Date;
  /** Optional ACTIVE CPT30 election as of the pay date. */
  cppElection?: {
    kind: "ELECTION_TO_STOP" | "REVOCATION_OF_ELECTION";
    /** First calendar day the election takes effect (per CRA rules). */
    effectiveOn: Date;
  } | null;
}

export interface CppEligibilityResult {
  /** True iff CPP applies to this pay date. */
  cppApplicable: boolean;
  /** When cppApplicable is false, the reason. */
  reason: CppInapplicableReason | null;
  /** True iff the Employee's 18th birthday falls in the pay-date year. */
  turned18ThisYear: boolean;
  /** True iff the Employee's 70th birthday falls in the pay-date year. */
  turned70ThisYear: boolean;
  /** First calendar day CPP contributions can be deducted in the pay-date year. */
  contributionStartDate: Date | null;
  /** Last calendar day CPP contributions can be deducted in the pay-date year. */
  contributionEndDate: Date | null;
  /**
   * Count of whole calendar months in the pay-date year for which
   * CPP is applicable. Used by the 3B-5B calculator to prorate the
   * annual maximum.
   */
  contributoryMonthsInYear: number;
}

function utcMidnight(y: number, m0: number, d: number): Date {
  return new Date(Date.UTC(y, m0, d));
}

/**
 * Return the first day of the month AFTER the given date. Half-open
 * boundary that the "turns 18" rule requires ("first pay dated in
 * the month after the Employee turns 18").
 */
function firstOfMonthAfter(d: Date): Date {
  return utcMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Return the last day (inclusive) of the month containing the given
 * date. Used for the "turns 70" rule ("last pay dated in the month
 * the Employee turns 70").
 */
function lastOfMonthOf(d: Date): Date {
  return utcMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
}

/**
 * Return the number of whole calendar months in the given year that
 * are covered by the half-open interval [start, end + 1 day).
 * `null` for either boundary means the year's respective bound
 * (Jan 1 or Dec 31) is used.
 */
function monthsInYearCovered(year: number, start: Date | null, end: Date | null): number {
  const yStart = utcMidnight(year, 0, 1);
  const yEnd = utcMidnight(year + 1, 0, 1); // exclusive
  const s = start && start.getTime() > yStart.getTime() ? start : yStart;
  // end is INCLUSIVE per the spec; convert to exclusive for math.
  const eExclusive = end ? utcMidnight(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1) : yEnd;
  const e = eExclusive.getTime() < yEnd.getTime() ? eExclusive : yEnd;
  if (s.getTime() >= e.getTime()) return 0;
  // Both boundaries fall on the first of their month (since we round
  // to first-of-month above for start, and end originates from
  // last-of-month → first-of-next-month here). Month count is exact.
  return (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
}

export function resolveCppContributionEligibility(input: CppEligibilityInput): CppEligibilityResult {
  const { dateOfBirth, payDate, cppElection } = input;

  const year = payDate.getUTCFullYear();

  if (!dateOfBirth) {
    return {
      cppApplicable: false,
      reason: "MISSING_DOB",
      turned18ThisYear: false,
      turned70ThisYear: false,
      contributionStartDate: null,
      contributionEndDate: null,
      contributoryMonthsInYear: 0,
    };
  }

  // Compute the 18th and 70th birthdays as UTC-midnight civil dates.
  const birth18 = utcMidnight(dateOfBirth.getUTCFullYear() + 18, dateOfBirth.getUTCMonth(), dateOfBirth.getUTCDate());
  const birth70 = utcMidnight(dateOfBirth.getUTCFullYear() + 70, dateOfBirth.getUTCMonth(), dateOfBirth.getUTCDate());

  const turned18ThisYear = birth18.getUTCFullYear() === year;
  const turned70ThisYear = birth70.getUTCFullYear() === year;

  // Age boundary — the earliest pay date that begins contributing.
  const contribStartForYear = birth18.getUTCFullYear() < year
    ? utcMidnight(year, 0, 1)
    : firstOfMonthAfter(birth18);
  // Age boundary — the latest pay date that ends contributing.
  const contribEndForYear = birth70.getUTCFullYear() > year
    ? utcMidnight(year, 11, 31)
    : lastOfMonthOf(birth70);

  // If the pay date falls BEFORE the age-18 window opens in this year,
  // CPP is not applicable yet.
  if (payDate.getTime() < contribStartForYear.getTime()) {
    return {
      cppApplicable: false,
      reason: birth18.getUTCFullYear() > year
        ? "UNDER_18_BEFORE_BIRTHDAY_MONTH"
        : "TURNED_18_AND_IN_BIRTHDAY_MONTH_OR_EARLIER",
      turned18ThisYear,
      turned70ThisYear,
      contributionStartDate: birth18.getUTCFullYear() === year ? contribStartForYear : null,
      contributionEndDate: birth70.getUTCFullYear() === year ? contribEndForYear : null,
      contributoryMonthsInYear: 0,
    };
  }
  // If the pay date falls AFTER the age-70 window closes, CPP is done.
  if (payDate.getTime() > contribEndForYear.getTime()) {
    return {
      cppApplicable: false,
      reason: "TURNED_70_AND_PAST_BIRTHDAY_MONTH",
      turned18ThisYear,
      turned70ThisYear,
      contributionStartDate: contribStartForYear,
      contributionEndDate: contribEndForYear,
      contributoryMonthsInYear: monthsInYearCovered(year, contribStartForYear, contribEndForYear),
    };
  }

  // Age is fine; consult CPT30 election if present. CPT30 rules apply
  // only when 65 <= age <= 69 at the pay date, but the calculator
  // MAY defensively pass elections outside that band — we still honour
  // an active ELECTION_TO_STOP whose effectiveOn <= payDate as a
  // contributions-stopped signal, and treat REVOCATION_OF_ELECTION
  // whose effectiveOn <= payDate as restoring contributions.
  if (cppElection && cppElection.effectiveOn.getTime() <= payDate.getTime()) {
    if (cppElection.kind === "ELECTION_TO_STOP") {
      return {
        cppApplicable: false,
        reason: "CPT30_ELECTION_STOP",
        turned18ThisYear,
        turned70ThisYear,
        contributionStartDate: contribStartForYear,
        contributionEndDate: contribEndForYear,
        contributoryMonthsInYear: monthsInYearCovered(year, contribStartForYear, contribEndForYear),
      };
    }
    // REVOCATION_OF_ELECTION — falls through to the applicable branch.
  }

  return {
    cppApplicable: true,
    reason: null,
    turned18ThisYear,
    turned70ThisYear,
    contributionStartDate: contribStartForYear,
    contributionEndDate: contribEndForYear,
    contributoryMonthsInYear: monthsInYearCovered(year, contribStartForYear, contribEndForYear),
  };
}

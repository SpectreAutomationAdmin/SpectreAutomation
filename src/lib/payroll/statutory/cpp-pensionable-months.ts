// Payroll-3B-5B-1 (2026-08-31, §8) — canonical CPP pensionable-month
// determination.
//
// PURE function. No I/O. No dollar math.
//
// `contributoryMonthsInYear` from `resolveCppContributionEligibility`
// is a POINT-IN-TIME view: given a single election / disability /
// death state as of THIS pay date, what's the pensionable-month
// window in this calendar year? That's fine for calculating a
// single pay run — but statutory annual-maximum PRORATION needs the
// aggregate across the whole tax year.
//
// This function takes the FULL history and returns:
//   • the set of calendar months in `taxYear` in which the
//     employment is pensionable for CPP
//   • the reasons that shortened the window (if any)
//
// The 3B-5B calculator uses `cppPensionableMonths(taxYear).length`
// as the numerator when prorating the annual CPP maximum.

export type CppMonthExclusionReason =
  | "UNDER_18"                 // any month up to and including birthday-18 month
  | "OVER_70"                  // any month after birthday-70 month
  | "CPT30_STOP_ACTIVE"        // a stop election is in effect
  | "CPP_DISABILITY_ACTIVE"    // a CPP/QPP disability benefit is in payment
  | "AFTER_DEATH";             // any month after death month

export interface CppMonthResult {
  /** 0..11 — UTC calendar month index for `taxYear`. */
  monthIndex: number;
  /** True iff the employment is CPP-pensionable that month. */
  pensionable: boolean;
  /** Populated when `pensionable === false`. */
  reason: CppMonthExclusionReason | null;
}

export interface CppPensionableMonthsInput {
  taxYear: number;
  /** Civil DOB (UTC midnight). Missing DOB → every month excluded. */
  dateOfBirth: Date | null;
  /**
   * ACTIVE CPT30 election history covering ANY portion of taxYear.
   * Each row supplies `kind` and `effectiveOn`. Sorted asc by
   * effectiveOn by the caller (defensively re-sorted here).
   */
  cppElections?: Array<{
    kind: "ELECTION_TO_STOP" | "REVOCATION_OF_ELECTION";
    effectiveOn: Date;
  }>;
  /**
   * Disability intervals covering ANY portion of taxYear. Half-open
   * `[effectiveFrom, effectiveTo)`. NOT_DISABLED rows are ignored.
   */
  cppDisabilities?: Array<{
    status: "NOT_DISABLED" | "CPP_DISABLED" | "QPP_DISABLED";
    effectiveFrom: Date;
    effectiveTo: Date | null;
  }>;
  /** Civil deceased date (UTC midnight). */
  deceasedOn?: Date | null;
}

export interface CppPensionableMonthsResult {
  taxYear: number;
  months: CppMonthResult[];
  /** Count of pensionable months in the tax year. */
  pensionableMonthCount: number;
  /** Reasons that shortened the window (order preserved, deduplicated). */
  exclusionReasons: CppMonthExclusionReason[];
}

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d));
}
function monthStart(y: number, m: number): Date { return utc(y, m, 1); }
function firstOfNextMonth(d: Date): Date {
  return utc(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
function lastOfMonth(d: Date): Date {
  return utc(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
}

export function cppPensionableMonths(input: CppPensionableMonthsInput): CppPensionableMonthsResult {
  const { taxYear, dateOfBirth, cppElections = [], cppDisabilities = [], deceasedOn } = input;

  const months: CppMonthResult[] = [];
  const exclusionReasons: CppMonthExclusionReason[] = [];
  const addReason = (r: CppMonthExclusionReason) => {
    if (!exclusionReasons.includes(r)) exclusionReasons.push(r);
  };

  // If DOB is missing every month is excluded — the calculator will
  // never call this without a DOB in practice (batch preparation
  // BLOCKS on MISSING_DATE_OF_BIRTH first), but the pure function
  // defends against it.
  if (!dateOfBirth) {
    for (let m = 0; m < 12; m++) months.push({ monthIndex: m, pensionable: false, reason: "UNDER_18" });
    return { taxYear, months, pensionableMonthCount: 0, exclusionReasons: ["UNDER_18"] };
  }

  const birth18 = utc(dateOfBirth.getUTCFullYear() + 18, dateOfBirth.getUTCMonth(), dateOfBirth.getUTCDate());
  const birth70 = utc(dateOfBirth.getUTCFullYear() + 70, dateOfBirth.getUTCMonth(), dateOfBirth.getUTCDate());

  // Age-18 rule: "first pay dated in the month AFTER" the 18th
  // birthday. Translated to months: the birthday month is NOT
  // pensionable; the following month is the first pensionable one.
  const firstPensionableMonth =
    birth18.getUTCFullYear() < taxYear
      ? monthStart(taxYear, 0)
      : birth18.getUTCFullYear() === taxYear
        ? firstOfNextMonth(birth18)
        : monthStart(taxYear + 1, 0); // birthday later than this year → no months in taxYear

  // Age-70 rule: contributions continue up to and INCLUDING the
  // month of the 70th birthday. In months: the birthday month IS
  // pensionable; the following month is the first non-pensionable.
  const lastPensionableMonthAge =
    birth70.getUTCFullYear() > taxYear
      ? monthStart(taxYear, 11)
      : birth70.getUTCFullYear() === taxYear
        ? monthStart(birth70.getUTCFullYear(), birth70.getUTCMonth())
        : monthStart(taxYear - 1, 11); // birthday before this year → no months in taxYear

  // Death: capped at the month of death (inclusive).
  const deathLastMonth =
    deceasedOn && deceasedOn.getUTCFullYear() === taxYear
      ? monthStart(deceasedOn.getUTCFullYear(), deceasedOn.getUTCMonth())
      : null;

  // Sorted election history — the applicable status for a given
  // month is the state of the most recent election whose
  // effectiveOn is <= the month's first day.
  const sortedElections = [...cppElections].sort((a, b) => a.effectiveOn.getTime() - b.effectiveOn.getTime());
  const isStoppedByElection = (monthFirstDay: Date): boolean => {
    let stopped = false;
    for (const e of sortedElections) {
      if (e.effectiveOn.getTime() > monthFirstDay.getTime()) break;
      stopped = e.kind === "ELECTION_TO_STOP";
    }
    return stopped;
  };

  // Effective disability rows (drop NOT_DISABLED).
  const disabilityIntervals = cppDisabilities.filter((d) => d.status !== "NOT_DISABLED");
  const isDisabledInMonth = (monthFirstDay: Date): boolean => {
    const monthEndExclusive = firstOfNextMonth(monthFirstDay);
    for (const iv of disabilityIntervals) {
      const s = iv.effectiveFrom.getTime();
      const e = iv.effectiveTo?.getTime() ?? Infinity;
      // Disability covers the month if it overlaps [monthFirstDay, monthEndExclusive).
      if (s < monthEndExclusive.getTime() && e > monthFirstDay.getTime()) return true;
    }
    return false;
  };

  let pensionableMonthCount = 0;
  for (let m = 0; m < 12; m++) {
    const ms = monthStart(taxYear, m);
    let pensionable = true;
    let reason: CppMonthExclusionReason | null = null;

    if (ms.getTime() < firstPensionableMonth.getTime()) {
      pensionable = false;
      reason = "UNDER_18";
      addReason("UNDER_18");
    } else if (ms.getTime() > lastPensionableMonthAge.getTime()) {
      pensionable = false;
      reason = "OVER_70";
      addReason("OVER_70");
    } else if (deathLastMonth && ms.getTime() > deathLastMonth.getTime()) {
      pensionable = false;
      reason = "AFTER_DEATH";
      addReason("AFTER_DEATH");
    } else if (isStoppedByElection(ms)) {
      pensionable = false;
      reason = "CPT30_STOP_ACTIVE";
      addReason("CPT30_STOP_ACTIVE");
    } else if (isDisabledInMonth(ms)) {
      pensionable = false;
      reason = "CPP_DISABILITY_ACTIVE";
      addReason("CPP_DISABILITY_ACTIVE");
    }

    if (pensionable) pensionableMonthCount++;
    months.push({ monthIndex: m, pensionable, reason });
  }

  return { taxYear, months, pensionableMonthCount, exclusionReasons };
}

// Helper for callers (e.g. the future calculator) that already
// have `cppPensionableMonths` output and just need the last day of
// the last pensionable month (used when clipping the annual-max
// pensionable-earnings window).
export function lastPensionableDay(res: CppPensionableMonthsResult): Date | null {
  for (let m = 11; m >= 0; m--) {
    if (res.months[m].pensionable) return lastOfMonth(utc(res.taxYear, m, 1));
  }
  return null;
}

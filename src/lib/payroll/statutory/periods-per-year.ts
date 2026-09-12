// Payroll-3B-5B-1b (2026-09-01, §5) — canonical `P` (number of pay
// periods in a tax year) resolver.
//
// CRA T4127 requires the calculator to use the ACTUAL number of pay
// periods a Pay Group runs in a given calendar year — never a
// hard-coded WEEKLY = 52 or BIWEEKLY = 26. Weekly can be 52 or 53;
// biweekly can be 26 or 27; semi-monthly is ordinarily 24; monthly
// is 12.
//
// This resolver reads Spectre's canonical generated payroll
// calendar (`PayrollPayPeriod` per `PayrollPayGroup`, keyed by
// `taxYear` which follows `payDate` per the 3B-2 invariant) and
// returns the exact count.
//
// Payroll 3D acceptance hotfix (2026-09-12): cross-checks the DB
// count against the Pay Group's declared `payFrequency` and REFUSES
// when the calendar is materially under-populated for the cadence.
// This defends the salary-per-period math from the specific defect
// class in which a fixture (or a partially-generated real calendar)
// yields periodsPerYear = 1 and a $52,000-annual salary flows into
// Calculate as a $52,000 period gross. See §5-6 of the acceptance
// hotfix directive.
//
// PURE at the DB boundary: the caller supplies the resolved rows;
// the count is arithmetic.

import { prisma } from "../../prisma";

/** Canonical minimum number of pay periods per year for each supported
 *  frequency. Extra rows (leap-week 27th biweekly, 53rd weekly) are
 *  legitimate — we only REFUSE when the count falls BELOW the floor. */
const FREQUENCY_MIN_PERIODS: Record<string, number> = {
  WEEKLY:       52,
  BI_WEEKLY:    26,
  BIWEEKLY:     26,
  SEMI_MONTHLY: 24,
  MONTHLY:      12,
};

export class PayPeriodCalendarIncompleteError extends Error {
  readonly code = "PAY_PERIOD_CALENDAR_INCOMPLETE";
  readonly clubId: string;
  readonly payGroupId: string;
  readonly taxYear: number;
  readonly payFrequency: string;
  readonly actualCount: number;
  readonly minimumCount: number;
  constructor(input: {
    clubId: string; payGroupId: string; taxYear: number;
    payFrequency: string; actualCount: number; minimumCount: number;
  }) {
    super(
      `Pay group ${input.payGroupId} has ${input.actualCount} pay period${input.actualCount === 1 ? "" : "s"} for taxYear ` +
        `${input.taxYear} but ${input.payFrequency} requires at least ${input.minimumCount}. ` +
        "Generate the full payroll calendar before preparing or calculating payroll.",
    );
    this.clubId = input.clubId;
    this.payGroupId = input.payGroupId;
    this.taxYear = input.taxYear;
    this.payFrequency = input.payFrequency;
    this.actualCount = input.actualCount;
    this.minimumCount = input.minimumCount;
  }
}

/**
 * Count the pay periods whose `payDate` falls in the given
 * calendar year for a specific Pay Group at a Club. Reads directly
 * from the canonical generated calendar. When a `payFrequency` is
 * supplied, refuses with `PayPeriodCalendarIncompleteError` if the
 * count is below the canonical minimum for that cadence — this
 * prevents the calculator from silently using an under-populated
 * calendar to divide a periodic salary.
 *
 * Refuses when no periods exist for the (Club, PayGroup, taxYear)
 * tuple — the calculator MUST NOT proceed with an assumed value.
 */
export async function resolvePeriodsPerYearFromCalendar(input: {
  clubId: string;
  payGroupId: string;
  taxYear: number;
  /** Pay Group cadence (`WEEKLY | BIWEEKLY | SEMI_MONTHLY | MONTHLY`).
   *  When supplied, drives the minimum-count cross-check. When omitted
   *  the resolver falls back to the count-only 3A behavior — kept for
   *  backwards compatibility with pre-3D callers. */
  payFrequency?: string | null;
}): Promise<number> {
  const count = await prisma.payrollPayPeriod.count({
    where: {
      clubId: input.clubId,
      payGroupId: input.payGroupId,
      taxYear: input.taxYear,
    },
  });
  if (count === 0) {
    throw new Error(
      `No Pay Periods exist for Club ${input.clubId} / PayGroup ${input.payGroupId} / taxYear ${input.taxYear}. ` +
        "Generate the payroll calendar before calculating payroll.",
    );
  }
  if (input.payFrequency) {
    const min = FREQUENCY_MIN_PERIODS[input.payFrequency.toUpperCase()];
    if (min && count < min) {
      throw new PayPeriodCalendarIncompleteError({
        clubId: input.clubId, payGroupId: input.payGroupId,
        taxYear: input.taxYear, payFrequency: input.payFrequency,
        actualCount: count, minimumCount: min,
      });
    }
  }
  return count;
}

/**
 * Pure counter — used by tests / callers that already have the
 * period rows in memory. Same-shaped result as the DB resolver.
 */
export function countPeriodsInTaxYear(
  periods: Array<{ taxYear: number }>,
  taxYear: number,
): number {
  return periods.filter((p) => p.taxYear === taxYear).length;
}

/** Canonical minimum for a cadence. Callers use this to prompt calendar
 *  generation without importing the private table. */
export function minimumPeriodsPerYearForFrequency(payFrequency: string): number | null {
  return FREQUENCY_MIN_PERIODS[payFrequency.toUpperCase()] ?? null;
}

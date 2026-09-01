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
// PURE at the DB boundary: the caller supplies the resolved rows;
// the count is arithmetic.

import { prisma } from "../../prisma";

/**
 * Count the pay periods whose `payDate` falls in the given
 * calendar year for a specific Pay Group at a Club. Reads directly
 * from the canonical generated calendar.
 *
 * Refuses when no periods exist for the (Club, PayGroup, taxYear)
 * tuple — the calculator MUST NOT proceed with an assumed value.
 */
export async function resolvePeriodsPerYearFromCalendar(input: {
  clubId: string;
  payGroupId: string;
  taxYear: number;
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

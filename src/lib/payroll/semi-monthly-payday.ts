// Payroll-3C-3E.1 (2026-09-09) — Spectre semi-monthly payday +
// payroll-cutoff calculator.
//
// Product model per founder:
//   First scheduled payday  = 15th of the month.
//   Second scheduled payday = LAST calendar day of the month.
//   If the scheduled payday lands on Saturday or Sunday, it moves
//   EARLIER to the immediately preceding Friday. (Later movement
//   is not supported for semi-monthly.)
//
// Holiday handling is NOT implemented here — recommendation is that
// holidays follow the same "earlier to preceding banking day" rule
// after a banking-calendar helper ships. Currently only weekend
// adjustment is applied.
//
// Payroll cutoff is `scheduledPayDate − N days` (calendar days by
// default, matching the existing MVP semantics). Cutoff and the
// employee-facing pay-period boundaries are SEPARATE concepts —
// the pay period always displays the compensation window
// (1st–15th / 16th–EOM), not the cutoff.

const DAY_MS = 86_400_000;

/** UTC-safe raw scheduled payday for a semi-monthly half. */
export function rawScheduledSemiMonthlyPayday(
  year: number,
  monthIndex0: number,      // 0 = January
  half: "FIRST_HALF" | "SECOND_HALF",
): Date {
  if (half === "FIRST_HALF") {
    return new Date(Date.UTC(year, monthIndex0, 15));
  }
  // Last calendar day of the month: day 0 of month+1 in UTC.
  return new Date(Date.UTC(year, monthIndex0 + 1, 0));
}

/** Move earlier to preceding Friday when landing on Sat/Sun. */
export function weekendAdjustedPayday(raw: Date): Date {
  const dow = raw.getUTCDay(); // 0=Sun, 6=Sat
  if (dow === 6) return new Date(raw.getTime() - 1 * DAY_MS); // Sat → Fri
  if (dow === 0) return new Date(raw.getTime() - 2 * DAY_MS); // Sun → Fri
  return raw;
}

/** Canonical semi-monthly payday: 15th / EOM adjusted for weekend. */
export function semiMonthlyPayday(
  year: number,
  monthIndex0: number,
  half: "FIRST_HALF" | "SECOND_HALF",
): Date {
  return weekendAdjustedPayday(rawScheduledSemiMonthlyPayday(year, monthIndex0, half));
}

/** Payroll cutoff = payDate − N calendar days (MVP semantics). */
export function payrollCutoff(payDate: Date, leadCalendarDays: number): Date {
  return new Date(payDate.getTime() - leadCalendarDays * DAY_MS);
}

/** Canonical semi-monthly period (half-open):
 *  FIRST_HALF  → [1st, 16th)  → displayed inclusive: 1–15
 *  SECOND_HALF → [16th, 1st-of-next) → displayed inclusive: 16–EOM
 */
export function semiMonthlyPeriod(
  year: number,
  monthIndex0: number,
  half: "FIRST_HALF" | "SECOND_HALF",
): { periodStart: Date; periodEnd: Date } {
  if (half === "FIRST_HALF") {
    return {
      periodStart: new Date(Date.UTC(year, monthIndex0, 1)),
      periodEnd:   new Date(Date.UTC(year, monthIndex0, 16)),
    };
  }
  return {
    periodStart: new Date(Date.UTC(year, monthIndex0, 16)),
    periodEnd:   new Date(Date.UTC(year, monthIndex0 + 1, 1)),
  };
}

/** Full 24-period annual schedule for a semi-monthly pay group. */
export interface SemiMonthlyPeriodRow {
  seq: number;                      // 1..24
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  payrollCutoff: Date;
}
export function generateSemiMonthlySchedule(
  year: number,
  leadCalendarDays: number,
): SemiMonthlyPeriodRow[] {
  const rows: SemiMonthlyPeriodRow[] = [];
  for (let m = 0; m < 12; m++) {
    for (const half of ["FIRST_HALF", "SECOND_HALF"] as const) {
      const seq = m * 2 + (half === "FIRST_HALF" ? 1 : 2);
      const { periodStart, periodEnd } = semiMonthlyPeriod(year, m, half);
      const payDate = semiMonthlyPayday(year, m, half);
      rows.push({
        seq, periodStart, periodEnd, payDate,
        payrollCutoff: payrollCutoff(payDate, leadCalendarDays),
      });
    }
  }
  return rows;
}

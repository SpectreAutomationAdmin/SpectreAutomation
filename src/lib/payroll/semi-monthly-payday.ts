// Payroll-3C-3E.1 (2026-09-09) — Spectre semi-monthly payday +
// payroll-cutoff calculator.
//
// Product model per founder:
//   First scheduled payday  = 15th of the month.
//   Second scheduled payday = LAST calendar day of the month.
//
// Slice E (2026-09-19) — the previously hard-coded "earlier-Friday"
// weekend shift is now founder-configured per pay group via
// `PayrollPayGroup.payDateAdjustment`. `weekendAdjustedPayday` and
// the no-arg `semiMonthlyPayday` remain (they default to
// PREVIOUS_BUSINESS_DAY so historical callers keep the legacy
// behaviour), but callers with access to the pay group should use the
// policy-aware forms below.
//
// Statutory holiday awareness is NOT implemented here — recommendation
// is that holidays follow the same "earlier / next business day" rule
// after a banking-calendar helper ships. Currently only weekend
// adjustment is applied.
//
// Payroll cutoff is `scheduledPayDate − N days` (calendar days by
// default, matching the existing MVP semantics). Cutoff and the
// employee-facing pay-period boundaries are SEPARATE concepts —
// the pay period always displays the compensation window
// (1st–15th / 16th–EOM), not the cutoff.

import {
  applyPayDateAdjustment,
  type PayDateAdjustment,
} from "./pay-date-policy";

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

/** LEGACY — earlier-Friday only. Equivalent to
 *  applyPayDateAdjustment(raw, "PREVIOUS_BUSINESS_DAY"). Kept for
 *  backward compat; prefer the policy-aware form. */
export function weekendAdjustedPayday(raw: Date): Date {
  return applyPayDateAdjustment(raw, "PREVIOUS_BUSINESS_DAY");
}

/** LEGACY — 15th / EOM adjusted with earlier-Friday. Kept for
 *  backward compat; prefer `semiMonthlyPaydayWithPolicy`. */
export function semiMonthlyPayday(
  year: number,
  monthIndex0: number,
  half: "FIRST_HALF" | "SECOND_HALF",
): Date {
  return semiMonthlyPaydayWithPolicy(year, monthIndex0, half, "PREVIOUS_BUSINESS_DAY");
}

/** Canonical policy-aware semi-monthly payday. */
export function semiMonthlyPaydayWithPolicy(
  year: number,
  monthIndex0: number,
  half: "FIRST_HALF" | "SECOND_HALF",
  policy: PayDateAdjustment,
): Date {
  return applyPayDateAdjustment(rawScheduledSemiMonthlyPayday(year, monthIndex0, half), policy);
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
  policy: PayDateAdjustment = "PREVIOUS_BUSINESS_DAY",
): SemiMonthlyPeriodRow[] {
  const rows: SemiMonthlyPeriodRow[] = [];
  for (let m = 0; m < 12; m++) {
    for (const half of ["FIRST_HALF", "SECOND_HALF"] as const) {
      const seq = m * 2 + (half === "FIRST_HALF" ? 1 : 2);
      const { periodStart, periodEnd } = semiMonthlyPeriod(year, m, half);
      const payDate = semiMonthlyPaydayWithPolicy(year, m, half, policy);
      rows.push({
        seq, periodStart, periodEnd, payDate,
        payrollCutoff: payrollCutoff(payDate, leadCalendarDays),
      });
    }
  }
  return rows;
}

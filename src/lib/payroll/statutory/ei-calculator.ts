// Payroll-3B-5B-2b CORRECTION (2026-09-02) — pure EI calculator.
//
// PURE function. No Prisma. No side effects.
//
// EI is a percentage-of-insurable premium capped at BOTH:
//   • an insurable-earnings ceiling (MIE) applied to same-employer YTD
//   • an annual maximum premium
//
// Employee premium (T4127 Chapter 7 — Alberta MVP):
//   EI_EE = min(
//       Package.ei.maxAnnualPremiumEE − ytdEiEE,
//       Package.ei.rateEE × min(insurableThisPay, mie − ytdInsurable)
//   )
//
// Employer premium — CRA operational contract for the standard
// (non-reduced) employer:
//   EI_ER = HALF_UP round( EI_EE × Package.ei.employerMultiplier, 2 )
// bounded by the employer's own remaining annual maximum
// (safety invariant — the employee cap normally binds first).
//
// The nominal `rateER` (2.282% for 2026) IS NOT independently
// applied against per-period insurable earnings here — that would
// diverge from CRA guidance at annual-cap / MIE / employee-at-max
// boundaries. `rateER` is retained on the pinned package for
// annual reconciliation and validation.

import { Decimal, nonNegative, roundCentsHalfUp, toDecimal } from "./decimal-money";

export interface EiCalcInput {
  insurableEarnings: Decimal | string | number;   // current period
  ytdInsurable:      Decimal | string | number;   // same-employer YTD BEFORE this period
  ytdEiEE:           Decimal | string | number;   // same-employer employee EI YTD BEFORE this period
  ytdEiER:           Decimal | string | number;   // same-employer employer EI YTD BEFORE this period
  ei: {
    mie:                string;
    rateEE:             string;
    rateER:             string;
    maxAnnualPremiumEE: string;
    maxAnnualPremiumER: string;
    /** Standard 1.4 unless a CRA-approved reduction applies (out of MVP scope). */
    employerMultiplier: string;
  };
}

export interface EiCalcResult {
  employee: Decimal;               // deductionEiEe (persisted, cent-rounded)
  employer: Decimal;               // employerEi   (persisted, cent-rounded)
  cappedAtAnnualMaxEE: boolean;
  cappedAtInsurableCeilingEE: boolean;
  cappedAtAnnualMaxER: boolean;
}

export function calculateEi(input: EiCalcInput): EiCalcResult {
  const insur   = toDecimal(input.insurableEarnings);
  const ytdIns  = toDecimal(input.ytdInsurable);
  const ytdEiEE = toDecimal(input.ytdEiEE);
  const ytdEiER = toDecimal(input.ytdEiER);
  const mie      = toDecimal(input.ei.mie);
  const rateEE   = toDecimal(input.ei.rateEE);
  const maxEE    = toDecimal(input.ei.maxAnnualPremiumEE);
  const maxER    = toDecimal(input.ei.maxAnnualPremiumER);
  const multiple = toDecimal(input.ei.employerMultiplier);

  // Insurable this period bounded by remaining MIE room.
  const insurableRoom = nonNegative(mie.minus(ytdIns));
  const insurableApplied = Decimal.min(insur, insurableRoom);
  const cappedAtInsurableCeilingEE = insurableApplied.lt(insur);

  // Employee premium — must be computed and rounded FIRST because
  // it is the operative base for the standard employer premium.
  const remainingMaxEE = nonNegative(maxEE.minus(ytdEiEE));
  const rawEE          = rateEE.times(insurableApplied);
  const cappedEE       = Decimal.min(rawEE, remainingMaxEE);
  const employee       = roundCentsHalfUp(nonNegative(cappedEE));
  const cappedAtAnnualMaxEE = cappedEE.lt(rawEE);

  // Employer premium — DERIVE from the actual cent-rounded employee
  // premium, then HALF_UP cent-round. Bounded by the employer's own
  // remaining annual max as a safety invariant. When employee EI = 0
  // (cap already hit, insurable = 0, MIE reached), employer EI is
  // 0 by construction — the calculator does NOT keep charging
  // employer premium after the employee premium has stopped.
  const employerRaw       = employee.times(multiple);
  const remainingMaxER    = nonNegative(maxER.minus(ytdEiER));
  const cappedER          = Decimal.min(employerRaw, remainingMaxER);
  const employer          = roundCentsHalfUp(nonNegative(cappedER));
  const cappedAtAnnualMaxER = cappedER.lt(employerRaw);

  return {
    employee, employer,
    cappedAtAnnualMaxEE, cappedAtInsurableCeilingEE,
    cappedAtAnnualMaxER,
  };
}

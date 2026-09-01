// Payroll-3B-5B-2b (2026-09-01) — pure EI calculator.
//
// PURE function. No Prisma. No side effects.
//
// EI is a percentage-of-insurable premium capped at BOTH:
//   • an insurable-earnings ceiling (MIE) applied to same-employer YTD
//   • an annual maximum premium
//
// T4127 Chapter 7 (Alberta MVP; QC uses different premium rate):
//   EI_EE = min(
//       Package.ei.maxAnnualPremiumEE − ytdEiEE,
//       Package.ei.rateEE × min(insurableThisPay, mie − ytdInsurable)
//   )
//
// Employer EI is computed at Package.ei.rateER against the same
// insurable base and capped at Package.ei.maxAnnualPremiumER.
// The employer multiplier (1.4) is documentation metadata — the
// published employer max is authoritative (do NOT recompute via
// employee EI × 1.4).

import { Decimal, nonNegative, roundCentsHalfUp, toDecimal } from "./decimal-money";

export interface EiCalcInput {
  insurableEarnings: Decimal | string | number;   // current period
  ytdInsurable:      Decimal | string | number;   // same-employer YTD BEFORE this period
  ytdEiEE:           Decimal | string | number;   // same-employer employee EI YTD BEFORE this period
  ytdEiER:           Decimal | string | number;   // same-employer employer EI YTD BEFORE this period
  ei: {
    mie:              string;
    rateEE:           string;
    rateER:           string;
    maxAnnualPremiumEE: string;
    maxAnnualPremiumER: string;
  };
}

export interface EiCalcResult {
  employee: Decimal;               // deductionEiEe (persisted, cent-rounded)
  employer: Decimal;               // employerEi   (persisted, cent-rounded)
  cappedAtAnnualMaxEE: boolean;
  cappedAtInsurableCeilingEE: boolean;
}

export function calculateEi(input: EiCalcInput): EiCalcResult {
  const insur   = toDecimal(input.insurableEarnings);
  const ytdIns  = toDecimal(input.ytdInsurable);
  const ytdEiEE = toDecimal(input.ytdEiEE);
  const ytdEiER = toDecimal(input.ytdEiER);
  const mie      = toDecimal(input.ei.mie);
  const rateEE   = toDecimal(input.ei.rateEE);
  const rateER   = toDecimal(input.ei.rateER);
  const maxEE    = toDecimal(input.ei.maxAnnualPremiumEE);
  const maxER    = toDecimal(input.ei.maxAnnualPremiumER);

  // Insurable this period is bounded by remaining MIE room.
  const insurableRoom = nonNegative(mie.minus(ytdIns));
  const insurableApplied = Decimal.min(insur, insurableRoom);
  const cappedAtInsurableCeilingEE = insurableApplied.lt(insur);

  // Employee premium.
  const remainingMaxEE = nonNegative(maxEE.minus(ytdEiEE));
  const rawEE          = rateEE.times(insurableApplied);
  const cappedEE       = Decimal.min(rawEE, remainingMaxEE);
  const employee       = roundCentsHalfUp(nonNegative(cappedEE));
  const cappedAtAnnualMaxEE = cappedEE.lt(rawEE);

  // Employer premium (own rate + own annual max — never multiplier-derived).
  const remainingMaxER = nonNegative(maxER.minus(ytdEiER));
  const rawER          = rateER.times(insurableApplied);
  const cappedER       = Decimal.min(rawER, remainingMaxER);
  const employer       = roundCentsHalfUp(nonNegative(cappedER));

  return { employee, employer, cappedAtAnnualMaxEE, cappedAtInsurableCeilingEE };
}

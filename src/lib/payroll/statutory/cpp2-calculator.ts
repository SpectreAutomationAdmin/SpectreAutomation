// Payroll-3B-5B-2b (2026-09-01) — pure CPP2 calculator (Factor C2).
//
// PURE function. No Prisma. No side effects.
//
// T4127 §Chapter 6 (second-additional CPP contribution):
//
//   W  = max(PI_YTD, YMPE × PM/12)
//   C2 = min( (cpp2MaxEE × PM/12) − D2, cpp2RateEE × max(0, PI_YTD + PI − W) )
//
// Where:
//   PI_YTD = same-employer pensionable earnings YTD BEFORE this period
//   PI     = current-period pensionable earnings
//   D2     = same-employer CPP2 EE YTD BEFORE this period
//   PM     = pensionable months in the tax year
//
// The result is HALF_UP rounded to the cent and floored at zero.

import { Decimal, nonNegative, roundCentsHalfUp, toDecimal } from "./decimal-money";

export interface Cpp2CalcInput {
  pensionableEarnings:  Decimal | string | number;   // PI  — current period
  ytdPensionable:       Decimal | string | number;   // PI_YTD — same employer, prior periods
  ytdCpp2EE:            Decimal | string | number;   // D2 — same employer, prior periods
  pensionableMonths:    number;                      // PM ∈ [0, 12]
  cpp: {
    ympe:        string;
    yampe:       string;
    cpp2RateEE:  string;
    cpp2MaxEE:   string;
  };
}

export interface Cpp2CalcResult {
  amount: Decimal;               // deductionCpp2Ee (persisted, cent-rounded)
  wThreshold: Decimal;           // W — the effective YMPE-derived threshold
  cappedAtAnnualMax: boolean;    // true when the annual cap was binding this period
}

export function calculateCpp2(input: Cpp2CalcInput): Cpp2CalcResult {
  const { pensionableMonths } = input;
  if (pensionableMonths < 0 || pensionableMonths > 12) throw new Error("pensionableMonths must be in [0, 12]");
  const PI    = toDecimal(input.pensionableEarnings);
  const PIYTD = toDecimal(input.ytdPensionable);
  const D2    = toDecimal(input.ytdCpp2EE);
  const PM    = new Decimal(pensionableMonths);
  const ympe       = toDecimal(input.cpp.ympe);
  const cpp2Rate   = toDecimal(input.cpp.cpp2RateEE);
  const cpp2Max    = toDecimal(input.cpp.cpp2MaxEE);

  if (pensionableMonths === 0) {
    return { amount: new Decimal(0), wThreshold: new Decimal(0), cappedAtAnnualMax: false };
  }

  const proratedYmpe = ympe.times(PM).div(12);
  const w            = Decimal.max(PIYTD, proratedYmpe);
  const proratedRemainingMax = nonNegative(cpp2Max.times(PM).div(12).minus(D2));
  const above        = nonNegative(PIYTD.plus(PI).minus(w));
  const rawAmount    = cpp2Rate.times(above);
  const capped       = Decimal.min(rawAmount, proratedRemainingMax);
  const amount       = roundCentsHalfUp(nonNegative(capped));
  const cappedAtAnnualMax = capped.lt(rawAmount);

  return { amount, wThreshold: w, cappedAtAnnualMax };
}

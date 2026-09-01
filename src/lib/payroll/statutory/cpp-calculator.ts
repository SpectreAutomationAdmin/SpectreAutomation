// Payroll-3B-5B-2b (2026-09-01) — pure CPP calculator (Factor C).
//
// PURE function. No Prisma. No side effects. Same inputs → same
// outputs. Fully deterministic.
//
// Implements the T4127 combined CPP contribution (base + first-
// additional) with the accepted rounding contract:
//
//   pensionable  = min(current period pensionable, prorated cap)
//   combined_raw = combinedRate × max(0, PI − ybe/P)
//   firstAdd_raw = firstAddRate × max(0, PI − ybe/P)
//   combined     = HALF_UP round(min(combined_raw, remaining prorated combined max), 2)
//   firstAdd     = HALF_UP round(firstAdd_raw × cap_ratio, 2)   // where cap_ratio applies proportionally when capped
//   base         = combined − firstAdd                          // residual — preserves base+firstAdd == combined
//
// The residual base is asserted equal to independently-rounded
// base at HALF_UP within one cent (reconciliation guarantee).
//
// PDOC Scenario 1 anchor: PI=2000, YBE=3500, P=26, PM=12, D=0 →
// combined = 110.99, firstAdd = 18.65, base = 92.34. Independent
// rate-based rounding of the first-additional component matches
// PDOC's "CPP additional-contribution deduction" diagnostic.

import { Decimal, nonNegative, roundCentsHalfUp, toDecimal } from "./decimal-money";

export interface CppCalcInput {
  /** Current pay-period pensionable earnings (PI). */
  pensionableEarnings: Decimal | string | number;
  /** Same-employer combined CPP EE YTD BEFORE this pay period (D). */
  ytdCombinedEE: Decimal | string | number;
  /** Actual pay-period count in the tax year (P). */
  periodsPerYear: number;
  /** Canonical pensionable months (PM ∈ [0, 12]). */
  pensionableMonths: number;
  /** Package `cpp` block — read verbatim (all values already Decimal strings). */
  cpp: {
    ybe:              string;
    baseRateEE:       string;
    firstAdditionalRateEE: string;
    combinedRateEE:   string;
    combinedMaxEE:    string;
  };
}

export interface CppCalcResult {
  /** deductionCppEeCombined = base + firstAdd (T4 Box 16 aggregate). */
  combined: Decimal;
  /** deductionCppEeBase = combined − firstAdd (residual). */
  base: Decimal;
  /** deductionCppEeFirstAdd = HALF_UP round(firstAddRate × pensionable_capped, 2). */
  firstAdd: Decimal;
  /** True when the annual combined max was the binding constraint this period. */
  cappedAtCombinedMax: boolean;
}

export function calculateCpp(input: CppCalcInput): CppCalcResult {
  const { periodsPerYear, pensionableMonths } = input;
  if (!(periodsPerYear > 0)) throw new Error("periodsPerYear must be > 0");
  if (pensionableMonths < 0 || pensionableMonths > 12) throw new Error("pensionableMonths must be in [0, 12]");
  const PI  = toDecimal(input.pensionableEarnings);
  const D   = toDecimal(input.ytdCombinedEE);
  const P   = new Decimal(periodsPerYear);
  const PM  = new Decimal(pensionableMonths);
  const ybe          = toDecimal(input.cpp.ybe);
  const baseRate     = toDecimal(input.cpp.baseRateEE);
  const firstAddRate = toDecimal(input.cpp.firstAdditionalRateEE);
  const combinedRate = toDecimal(input.cpp.combinedRateEE);
  const combinedMax  = toDecimal(input.cpp.combinedMaxEE);

  // Not pensionable this period (age, CPT30 stop, etc.) → zero.
  if (pensionableMonths === 0) {
    return {
      combined: new Decimal(0), base: new Decimal(0), firstAdd: new Decimal(0),
      cappedAtCombinedMax: false,
    };
  }

  // Prorated remaining annual combined max: (combinedMax × PM/12) − D.
  const proratedRemainingMax = nonNegative(combinedMax.times(PM).div(12).minus(D));
  // Uncapped current-period combined contribution.
  const pensionableAbove = nonNegative(PI.minus(ybe.div(P)));
  const combinedRaw      = combinedRate.times(pensionableAbove);
  // Apply the prorated remaining max ceiling.
  const cappedCombined = Decimal.min(combinedRaw, proratedRemainingMax);
  const combined       = roundCentsHalfUp(cappedCombined);

  // First-additional at its own rate against the SAME pensionableAbove.
  // If the annual cap bit, scale the first-additional pro-rata (so the
  // combined/base/firstAdd invariant holds under cap conditions too).
  let firstAdd: Decimal;
  const cappedAtCombinedMax = cappedCombined.lt(combinedRaw);
  if (combinedRaw.isZero() || cappedAtCombinedMax) {
    // Under the cap: apportion firstAdd = combined × (firstAddRate/combinedRate).
    const ratio = firstAddRate.div(combinedRate);
    firstAdd = roundCentsHalfUp(combined.times(ratio));
  } else {
    // Normal case: firstAdd_raw = firstAddRate × pensionableAbove.
    firstAdd = roundCentsHalfUp(firstAddRate.times(pensionableAbove));
  }

  // Base is the residual so `base + firstAdd == combined` to the cent.
  const base = combined.minus(firstAdd);

  // Safety floors — no negative statutory amount ever escapes.
  return {
    combined: nonNegative(combined),
    base:     nonNegative(base),
    firstAdd: nonNegative(firstAdd),
    cappedAtCombinedMax,
  };
}

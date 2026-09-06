// Payroll-3C-3D.6 (2026-09-09) — jurisdiction-neutral shared helper
// that computes the CRA year-to-date CPP + EI tax-credit basis
// consumed by T4127 §Federal K2 and §Provincial K2P.
//
// Statutory authority (founder-verified against CRA T4127 123rd
// Edition, effective 2026-07-01, and unchanged from the K2/K2P
// year-to-date instructions carried from the 122nd Edition):
//
//   CPP base ratio     = baseCppRate / combinedCppRate
//                        (2026: 0.0495 / 0.0595)
//   CPP projected      = D × ratio + PR × C × ratio
//   CPP maximum        = combinedCppBaseMaxEE × (PM / 12)
//   CPP selected       = min(projected, maximum)
//
//   EI projected       = D1 + PR × EI
//   EI maximum         = eiMaxAnnualPremiumEE
//   EI selected        = min(projected, maximum)
//
// Where (§3 of the 3C-3D.6 brief):
//   P  = annual pay periods
//   PR = pay periods remaining INCLUDING current
//   PM = pensionable months (from cppPensionableMonths, never hire date)
//   D  = employee YTD combined-CPP contribution with this employer BEFORE this pay
//   D1 = employee YTD EI premium with this employer BEFORE this pay
//   C  = current-pay combined-CPP contribution
//   EI = current-pay EI premium
//
// The federal calculator then applies `federalLowestRate × combinedSelected`;
// Alberta applies `provincialLowestRate × combinedSelected`. All rates
// + maximums come from the frozen statutory package — never hard-coded.

import { Decimal, toDecimal, nonNegative } from "./decimal-money";

export interface CppEiCreditBasisInputs {
  /** T4127 D — prior YTD CPP with THIS employer, EXCLUDING current pay. */
  priorYtdCombinedCpp: Decimal | string | number;
  /** T4127 D1 — prior YTD EI with THIS employer, EXCLUDING current pay. */
  priorYtdEi:          Decimal | string | number;
  /** T4127 C — current-pay combined CPP contribution. */
  currentCombinedCpp:  Decimal | string | number;
  /** T4127 EI — current-pay EI premium. */
  currentEi:           Decimal | string | number;
  /** T4127 PR — pay periods remaining INCLUDING current pay. */
  periodsRemainingIncludingCurrent: number;
  /**
   * T4127 PM — CPP-pensionable months for this employee this tax year.
   * MUST come from cppPensionableMonths (age / election / disability /
   * death). Never derive PM from hire date (§8 3C-3D.6).
   */
  cppPensionableMonths: number;
  /** Statutory package rates + maximums (from the frozen batch package). */
  baseCppRateStr:            string;   // package.cpp.baseRateEE
  combinedCppRateStr:        string;   // package.cpp.combinedRateEE
  combinedCppBaseMaxEEStr:   string;   // package.cpp.baseMaxEE
  eiMaxAnnualPremiumEEStr:   string;   // package.ei.maxAnnualPremiumEE
}

export interface CppEiCreditBasis {
  cppBaseRatio:            Decimal;
  cppProjectedBase:        Decimal;
  cppMaximumBase:          Decimal;
  cppSelectedBase:         Decimal;
  eiProjected:             Decimal;
  eiMaximum:               Decimal;
  eiSelected:              Decimal;
  /** Sum consumed by K2 (federal rate) and K2P (provincial rate). */
  combinedSelectedBasis:   Decimal;
}

export function calculateCppEiTaxCreditBasis(input: CppEiCreditBasisInputs): CppEiCreditBasis {
  const PR = new Decimal(input.periodsRemainingIncludingCurrent);
  if (PR.lt(0)) throw new Error("periodsRemainingIncludingCurrent must be >= 0");
  const PM = new Decimal(input.cppPensionableMonths);
  if (PM.lt(0) || PM.gt(12)) throw new Error("cppPensionableMonths must be in [0, 12]");
  const D    = toDecimal(input.priorYtdCombinedCpp);
  const D1   = toDecimal(input.priorYtdEi);
  const C    = toDecimal(input.currentCombinedCpp);
  const EI   = toDecimal(input.currentEi);

  const baseRate     = toDecimal(input.baseCppRateStr);
  const combinedRate = toDecimal(input.combinedCppRateStr);
  const cppRatio     = baseRate.div(combinedRate);
  const cppBaseMaxEE = toDecimal(input.combinedCppBaseMaxEEStr);
  const eiMaxEE      = toDecimal(input.eiMaxAnnualPremiumEEStr);

  const cppProjectedBase = D.times(cppRatio).plus(PR.times(C).times(cppRatio));
  const cppMaximumBase   = cppBaseMaxEE.times(PM).div(12);
  const cppSelectedBase  = nonNegative(Decimal.min(cppProjectedBase, cppMaximumBase));

  const eiProjected = D1.plus(PR.times(EI));
  const eiMaximum   = eiMaxEE;
  const eiSelected  = nonNegative(Decimal.min(eiProjected, eiMaximum));

  return {
    cppBaseRatio:          cppRatio,
    cppProjectedBase, cppMaximumBase, cppSelectedBase,
    eiProjected, eiMaximum, eiSelected,
    combinedSelectedBasis: cppSelectedBase.plus(eiSelected),
  };
}

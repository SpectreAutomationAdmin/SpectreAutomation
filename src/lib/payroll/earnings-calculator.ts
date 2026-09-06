// Payroll-3B-5B-2b (2026-09-01) — pure earnings + statutory-base
// calculator. Reads ONLY frozen PayrollBatch* snapshots (no Prisma
// query, no live HR read).
//
// The calculator produces four independent bases per employee:
//   grossPay             — every earning + every allowance amount
//   earningsTaxable      — earnings + allowances flagged `taxable`
//   earningsPensionable  — earnings + allowances flagged `pensionable`
//   earningsInsurable    — earnings + allowances flagged `insurable`
//
// These three flags are independent per Payroll-3B-5B-1b §18. An
// allowance may be taxable but non-pensionable, or vice versa.
//
// Earnings sources (all frozen):
//   • REGULAR / OVERTIME / VACATION / STAT_HOLIDAY / SALARY earning
//     rows on PayrollBatchEarning (quantity × rate)
//   • Salary path: when the employee is SALARIED and full-period AND
//     no SALARY earning row already exists, derive periodSalary =
//     annualSalary / P from the frozen compensations snapshot.
//   • Allowances: every PayrollBatchAllowanceSnapshot row's amount
//     converted to per-period via its frozen frequency.
//
// Alberta Employment Standards entitlement (overtime multiplier,
// vacation percentage, stat-holiday premium, average-daily-wage)
// is OUT OF SCOPE. Those earning types are calculated ONLY when the
// snapshot carries an already-authoritative quantity + rate. If not,
// readiness has already surfaced a BLOCKER before this function runs.

import { Decimal, nonNegative, roundCentsHalfUp, sum, toDecimal } from "./statutory/decimal-money";
import type { PayrollBatchSourceFactsV1 } from "./source-facts-schema";

export interface EarningRowLike {
  earningType: string;
  quantity: Decimal | string | number;
  rate:     Decimal | string | number;
}

export interface AllowanceSnapshotLike {
  amount:      Decimal | string | number;
  frequency:   string;
  taxable:     boolean;
  pensionable: boolean;
  insurable:   boolean;
}

// Payroll-3C-2 / -3C-3 — Payroll Component snapshot input.
//
// FIXED_AMOUNT: `resolvedAmount` is authoritative.
// PERCENT_OF_ELIGIBLE_EARNINGS: `resolvedAmount` is NULL from prep;
//   the calculator resolves it here as
//     resolvedAmount = eligibleBase(...) × percentBps / 10000
//   and returns the resolution so caller can persist onto the snapshot.
// A snapshot with a warning (mid-period, missing amount / percent /
// eligible base) is silently skipped by the calc.
export type StatutoryEffect = "ADD" | "SUBTRACT" | "NONE";
export interface ComponentSnapshotLike {
  code:              string;
  side:              "EMPLOYEE" | "EMPLOYER";
  cashEffect:        "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
  taxableEffect:        StatutoryEffect;
  cppPensionableEffect: StatutoryEffect;
  eiInsurableEffect:    StatutoryEffect;
  calculationMethod: "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS";
  resolvedAmount:    Decimal | string | number | null;
  // Payroll-3C-3 — percent only.
  eligibleEarningsBase: "REGULAR_EARNINGS_ONLY" | "CASH_EARNINGS" | null;
  sourcePercentBps:  number | null;
}

export interface EarningsCalcInput {
  sourceFacts:     PayrollBatchSourceFactsV1;
  earningRows:     EarningRowLike[];
  allowances:      AllowanceSnapshotLike[];
  /** Payroll-3C-2 — optional. Only FIXED_AMOUNT with a resolvedAmount contributes. */
  componentSnapshots?: ComponentSnapshotLike[];
  approvedHours:   Decimal | string | number;
  periodsPerYear:  number;
  salariedFullPeriod: boolean;
}

export interface EarningsCalcResult {
  /**
   * Legacy field — kept equal to `cashEarnings` so existing
   * PayrollBatchEmployee.grossPay persistence + downstream statutory
   * reads do not change shape. New code should read `cashEarnings`.
   */
  grossPay:            Decimal;
  earningsTaxable:     Decimal;
  earningsPensionable: Decimal;
  earningsInsurable:   Decimal;
  // Payroll-3C-2 — four independent bases exposed explicitly. Every
  // callsite that reasons about statutory input reads THESE, not
  // grossPay. The four fields are the calculation invariant.
  cashEarnings:                     Decimal;
  taxableRemuneration:              Decimal;
  cppPensionableRemuneration:       Decimal;
  eiInsurableRemuneration:          Decimal;
  employeeDeductionsFromComponents: Decimal;
  employerContributionsFromComponents: Decimal;
  // Payroll-3C-3 — % components landed here for the caller to
  // persist onto their PayrollBatchComponentSnapshot rows (so the
  // review DTO can show "5.00% × $5000 = $250").
  percentResolutions: Array<{
    code:             string;
    percentBps:       number;
    eligibleBase:     "REGULAR_EARNINGS_ONLY" | "CASH_EARNINGS";
    eligibleAmount:   Decimal;   // pre-rounded to cents
    resolvedAmount:   Decimal;   // pre-rounded to cents
  }>;
  // Payroll-3C-3 — non-fatal diagnostics from the calculator itself
  // (e.g. a SUBTRACT component that would have driven a base below
  // zero). Callers should surface these as batch WARNINGs.
  diagnostics: Array<{ code: string; message: string }>;
  /** Per-line breakdown for auditability / T4 reporting downstream. */
  lines: Array<{ source: "SALARY_DERIVED" | "EARNING_ROW" | "ALLOWANCE" | "COMPONENT" | "COMPONENT_PERCENT"; label: string; amount: Decimal; }>;
}

/**
 * Compute regular hourly gross from frozen HR + approved-time
 * snapshot: `hourlyRate × approvedHours`. Returns null when the
 * employee has no HOURLY compensation snapshot.
 */
export function computeHourlyRegular(
  sourceFacts: PayrollBatchSourceFactsV1,
  approvedHours: Decimal | string | number,
): { amount: Decimal; hourlyRate: Decimal } | null {
  const comp = sourceFacts.compensations.find((c) => c.payType === "HOURLY" && c.hourlyRate != null);
  if (!comp || comp.hourlyRate == null) return null;
  const hours = toDecimal(approvedHours);
  const rate  = toDecimal(comp.hourlyRate);
  return { amount: hours.times(rate), hourlyRate: rate };
}

/**
 * Compute the derived per-period base salary for a full-period
 * salaried employee: annualSalary / periodsPerYear. Returns null
 * when the employee has no SALARY compensation snapshot.
 */
export function computePeriodSalary(
  sourceFacts: PayrollBatchSourceFactsV1,
  periodsPerYear: number,
): Decimal | null {
  const comp = sourceFacts.compensations.find((c) => c.payType === "SALARY" && c.annualSalary != null);
  if (!comp || comp.annualSalary == null) return null;
  if (!(periodsPerYear > 0)) throw new Error("periodsPerYear must be > 0");
  return toDecimal(comp.annualSalary).div(periodsPerYear);
}

/**
 * Compute the per-period amount for an allowance snapshot, converting
 * its frequency into per-period money. Unsupported frequency BLOCKS
 * upstream in readiness — this function throws defensively.
 */
export function computeAllowancePerPeriod(
  snap: AllowanceSnapshotLike,
  periodsPerYear: number,
): Decimal {
  const amount = toDecimal(snap.amount);
  if (!(periodsPerYear > 0)) throw new Error("periodsPerYear must be > 0");
  switch (snap.frequency) {
    case "PER_PAY_PERIOD": return amount;
    case "MONTHLY":        return amount.times(12).div(periodsPerYear);
    case "BIWEEKLY":       return amount.times(26).div(periodsPerYear);
    case "WEEKLY":         return amount.times(52).div(periodsPerYear);
    case "ANNUAL":         return amount.div(periodsPerYear);
    case "ONE_TIME":       return amount;
    default:
      throw new Error(`Unsupported allowance frequency: ${snap.frequency}`);
  }
}

export function calculateEarnings(input: EarningsCalcInput): EarningsCalcResult {
  const { sourceFacts, earningRows, allowances, approvedHours, periodsPerYear, salariedFullPeriod } = input;
  const componentSnapshots = input.componentSnapshots ?? [];
  const lines: EarningsCalcResult["lines"] = [];
  let taxable     = new Decimal(0);
  let pensionable = new Decimal(0);
  let insurable   = new Decimal(0);
  const gross     = new Decimal(0);

  // Earning rows (explicit snapshots) — treat all supported types
  // as fully taxable + pensionable + insurable. Alberta Employment
  // Standards entitlement rules that would carve out a non-taxable
  // portion (e.g. vacation-pay carve-outs) are OUT OF MVP scope —
  // if a carve-out is needed a future slice adds explicit fields.
  // Readiness has already rejected UNSUPPORTED_EARNING_TYPE rows.
  const earningTotals = sum(earningRows.map((r) => toDecimal(r.quantity).times(toDecimal(r.rate))));
  for (const row of earningRows) {
    const amt = toDecimal(row.quantity).times(toDecimal(row.rate));
    lines.push({ source: "EARNING_ROW", label: row.earningType, amount: amt });
  }

  // Salary path: only when SALARIED + full-period AND no explicit
  // SALARY earning row already exists (avoid double-counting).
  let salaryDerived = new Decimal(0);
  const hasExplicitSalary = earningRows.some((r) => r.earningType === "SALARY");
  if (salariedFullPeriod && !hasExplicitSalary) {
    const periodSalary = computePeriodSalary(sourceFacts, periodsPerYear);
    if (periodSalary) {
      salaryDerived = periodSalary;
      lines.push({ source: "SALARY_DERIVED", label: "Salary (annual / P)", amount: periodSalary });
    }
  }

  // Regular hourly path: when NOT salaried AND no explicit REGULAR /
  // OVERTIME earning row already exists (avoid double-counting).
  let hourlyDerived = new Decimal(0);
  const hasExplicitHourly = earningRows.some((r) => r.earningType === "REGULAR" || r.earningType === "OVERTIME");
  if (!salariedFullPeriod && !hasExplicitHourly) {
    const hourly = computeHourlyRegular(sourceFacts, approvedHours);
    if (hourly) {
      hourlyDerived = hourly.amount;
      lines.push({ source: "EARNING_ROW", label: "REGULAR (approvedHours × hourlyRate)", amount: hourly.amount });
    }
  }

  // Allowances — classification-decoupled per §18.
  const allowanceTotal = new Decimal(0);
  let allowanceTax = new Decimal(0);
  let allowancePen = new Decimal(0);
  let allowanceIns = new Decimal(0);
  let allowanceGross = new Decimal(0);
  for (const snap of allowances) {
    const per = computeAllowancePerPeriod(snap, periodsPerYear);
    allowanceGross = allowanceGross.plus(per);
    if (snap.taxable)     allowanceTax = allowanceTax.plus(per);
    if (snap.pensionable) allowancePen = allowancePen.plus(per);
    if (snap.insurable)   allowanceIns = allowanceIns.plus(per);
    lines.push({ source: "ALLOWANCE", label: `allowance:${snap.frequency}`, amount: per });
  }
  // TS-friendly no-op reference so `allowanceTotal` isn't flagged; we
  // fold it into the gross calculation below explicitly.
  void allowanceTotal;

  // Payroll-3C-2 / -3C-3 — Payroll Components. TWO-PASS model per
  // the 3C-3 brief §6:
  //   Pass 1 — FIXED_AMOUNT contributions to cash and to the three
  //            statutory bases (directional).
  //   Pass 2 — PERCENT components resolve against a base derived
  //            EXCLUSIVELY from pass 1 outputs (§8 — no component-
  //            to-component graph).
  //
  // Directional statutory effects:
  //   ADD       → grows the target base by the resolved amount
  //   SUBTRACT  → reduces the target base by the resolved amount
  //   NONE      → no effect on that base
  //
  // A base that would go below zero is floored at zero and a
  // NEGATIVE_BASE_FLOORED diagnostic is emitted (§21).
  let componentCashAdds  = new Decimal(0);
  let componentCashSubs  = new Decimal(0);
  let componentTaxAdd    = new Decimal(0);
  let componentTaxSub    = new Decimal(0);
  let componentPenAdd    = new Decimal(0);
  let componentPenSub    = new Decimal(0);
  let componentInsAdd    = new Decimal(0);
  let componentInsSub    = new Decimal(0);
  let componentEmployer  = new Decimal(0);
  const percentResolutions: EarningsCalcResult["percentResolutions"] = [];
  const diagnostics: EarningsCalcResult["diagnostics"] = [];

  const applyFixed = (cs: ComponentSnapshotLike, amt: Decimal): void => {
    if (cs.side === "EMPLOYER") componentEmployer = componentEmployer.plus(amt);
    if (cs.cashEffect === "INCREASES_NET_PAY") componentCashAdds = componentCashAdds.plus(amt);
    if (cs.cashEffect === "DECREASES_NET_PAY") componentCashSubs = componentCashSubs.plus(amt);
    if (cs.taxableEffect        === "ADD")      componentTaxAdd = componentTaxAdd.plus(amt);
    if (cs.taxableEffect        === "SUBTRACT") componentTaxSub = componentTaxSub.plus(amt);
    if (cs.cppPensionableEffect === "ADD")      componentPenAdd = componentPenAdd.plus(amt);
    if (cs.cppPensionableEffect === "SUBTRACT") componentPenSub = componentPenSub.plus(amt);
    if (cs.eiInsurableEffect    === "ADD")      componentInsAdd = componentInsAdd.plus(amt);
    if (cs.eiInsurableEffect    === "SUBTRACT") componentInsSub = componentInsSub.plus(amt);
  };

  // Pass 1 — FIXED_AMOUNT components (previously the only path).
  for (const cs of componentSnapshots) {
    if (cs.calculationMethod !== "FIXED_AMOUNT") continue;
    if (cs.resolvedAmount == null) continue;
    const amt = toDecimal(cs.resolvedAmount);
    applyFixed(cs, amt);
    lines.push({ source: "COMPONENT", label: cs.code, amount: amt });
  }

  // Compute the pre-percent cash and regular-earnings baselines
  // used by Pass 2's eligibleBase resolution (§7-8).
  const regularEarnings = salaryDerived.plus(hourlyDerived);
  const cashPrePercent  = regularEarnings.plus(earningTotals).plus(allowanceGross).plus(componentCashAdds);

  // Pass 2 — PERCENT_OF_ELIGIBLE_EARNINGS. Percentage components
  // resolve against the pre-declared eligible base and never against
  // each other.
  for (const cs of componentSnapshots) {
    if (cs.calculationMethod !== "PERCENT_OF_ELIGIBLE_EARNINGS") continue;
    if (cs.sourcePercentBps == null || cs.eligibleEarningsBase == null) continue;
    const eligible = cs.eligibleEarningsBase === "REGULAR_EARNINGS_ONLY"
      ? regularEarnings
      : cashPrePercent;
    const eligibleR = roundCentsHalfUp(nonNegative(eligible));
    const bpsDec = new Decimal(cs.sourcePercentBps).div(10000);
    const amountR = roundCentsHalfUp(eligibleR.times(bpsDec));
    applyFixed(cs, amountR);
    lines.push({ source: "COMPONENT_PERCENT", label: cs.code, amount: amountR });
    percentResolutions.push({
      code: cs.code, percentBps: cs.sourcePercentBps,
      eligibleBase: cs.eligibleEarningsBase,
      eligibleAmount: eligibleR, resolvedAmount: amountR,
    });
  }

  // Cash earnings = base + INCREASES_NET_PAY component adds.
  // DECREASES_NET_PAY do NOT reduce cash earnings — they land on the
  // net-pay side later.
  const cashBaseline = gross.plus(regularEarnings).plus(earningTotals).plus(allowanceGross);
  const cashEarnings = nonNegative(cashBaseline.plus(componentCashAdds));

  // Three independent statutory bases with directional composition.
  const baseAdd = regularEarnings.plus(earningTotals);
  const rawTaxable     = taxable.plus(baseAdd).plus(allowanceTax).plus(componentTaxAdd).minus(componentTaxSub);
  const rawPensionable = pensionable.plus(baseAdd).plus(allowancePen).plus(componentPenAdd).minus(componentPenSub);
  const rawInsurable   = insurable.plus(baseAdd).plus(allowanceIns).plus(componentInsAdd).minus(componentInsSub);
  const flooredTaxable     = rawTaxable.lt(0)     ? new Decimal(0) : rawTaxable;
  const flooredPensionable = rawPensionable.lt(0) ? new Decimal(0) : rawPensionable;
  const flooredInsurable   = rawInsurable.lt(0)   ? new Decimal(0) : rawInsurable;
  if (rawTaxable.lt(0))
    diagnostics.push({ code: "NEGATIVE_BASE_FLOORED", message: `taxable remuneration would be ${rawTaxable.toFixed(2)}; floored at 0` });
  if (rawPensionable.lt(0))
    diagnostics.push({ code: "NEGATIVE_BASE_FLOORED", message: `CPP pensionable would be ${rawPensionable.toFixed(2)}; floored at 0` });
  if (rawInsurable.lt(0))
    diagnostics.push({ code: "NEGATIVE_BASE_FLOORED", message: `EI insurable would be ${rawInsurable.toFixed(2)}; floored at 0` });
  taxable     = flooredTaxable;
  pensionable = flooredPensionable;
  insurable   = flooredInsurable;

  return {
    grossPay:            roundCentsHalfUp(cashEarnings),
    earningsTaxable:     roundCentsHalfUp(taxable),
    earningsPensionable: roundCentsHalfUp(pensionable),
    earningsInsurable:   roundCentsHalfUp(insurable),
    cashEarnings:                       roundCentsHalfUp(cashEarnings),
    taxableRemuneration:                roundCentsHalfUp(taxable),
    cppPensionableRemuneration:         roundCentsHalfUp(pensionable),
    eiInsurableRemuneration:            roundCentsHalfUp(insurable),
    employeeDeductionsFromComponents:   roundCentsHalfUp(componentCashSubs),
    employerContributionsFromComponents: roundCentsHalfUp(componentEmployer),
    percentResolutions,
    diagnostics,
    lines,
  };
}

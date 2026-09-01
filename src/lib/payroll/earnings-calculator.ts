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

export interface EarningsCalcInput {
  sourceFacts:     PayrollBatchSourceFactsV1;
  earningRows:     EarningRowLike[];
  allowances:      AllowanceSnapshotLike[];
  approvedHours:   Decimal | string | number;
  periodsPerYear:  number;
  salariedFullPeriod: boolean;
}

export interface EarningsCalcResult {
  grossPay:            Decimal;
  earningsTaxable:     Decimal;
  earningsPensionable: Decimal;
  earningsInsurable:   Decimal;
  /** Per-line breakdown for auditability / T4 reporting downstream. */
  lines: Array<{ source: "SALARY_DERIVED" | "EARNING_ROW" | "ALLOWANCE"; label: string; amount: Decimal; }>;
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

  // Gross = every earning + every allowance (unfiltered).
  const grossPay = nonNegative(gross.plus(earningTotals).plus(salaryDerived).plus(hourlyDerived).plus(allowanceGross));

  // Bases — earnings are fully taxable/pensionable/insurable by MVP
  // assumption; allowances honour their three independent flags.
  const earningsBase = earningTotals.plus(salaryDerived).plus(hourlyDerived);
  earningsBase; // referenced below

  taxable     = taxable.plus(earningTotals).plus(salaryDerived).plus(hourlyDerived).plus(allowanceTax);
  pensionable = pensionable.plus(earningTotals).plus(salaryDerived).plus(hourlyDerived).plus(allowancePen);
  insurable   = insurable.plus(earningTotals).plus(salaryDerived).plus(hourlyDerived).plus(allowanceIns);

  return {
    grossPay:            roundCentsHalfUp(grossPay),
    earningsTaxable:     roundCentsHalfUp(nonNegative(taxable)),
    earningsPensionable: roundCentsHalfUp(nonNegative(pensionable)),
    earningsInsurable:   roundCentsHalfUp(nonNegative(insurable)),
    lines,
  };
}

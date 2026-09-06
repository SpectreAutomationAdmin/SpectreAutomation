// Payroll MVP posting hotfix (2026-09-07) — canonical salary
// periodization (computePeriodSalary) unit tests.
//
// Rule: `periodRegularSalary = annualSalary / periodsPerYear`.
// `periodsPerYear` is the ACTUAL count of pay periods on the
// generated calendar for the tax year (per CRA T4127 / §4-5 of the
// hotfix brief). Ordinary reference divisors: WEEKLY 52, BIWEEKLY
// 26, SEMIMONTHLY 24, MONTHLY 12.

import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { computePeriodSalary } from "@/lib/payroll/earnings-calculator";
import type { PayrollBatchSourceFactsV1 } from "@/lib/payroll/source-facts-schema";

// Minimal source-facts fixture — computePeriodSalary only reads
// `compensations[].payType` and `annualSalary`. Cast avoids
// duplicating the entire schema for a purely-arithmetic unit test.
function salaryFacts(annualSalary: number | null): PayrollBatchSourceFactsV1 {
  const compensations = annualSalary == null
    ? []
    : [{
        id: "comp_1", assignmentId: "assn_1", payType: "SALARY",
        annualSalary: String(annualSalary),
        hourlyRate: null,
        effectiveFrom: "2020-01-01T00:00:00.000Z", effectiveTo: null,
      }];
  return { schemaVersion: 1, compensations } as unknown as PayrollBatchSourceFactsV1;
}

describe("computePeriodSalary — canonical periodization", () => {
  it("semi-monthly (P=24): 150_000 → 6_250.00", () => {
    const per = computePeriodSalary(salaryFacts(150_000), 24);
    expect(per).not.toBeNull();
    expect((per as Decimal).toFixed(2)).toBe("6250.00");
  });

  it("monthly (P=12): 120_000 → 10_000.00", () => {
    const per = computePeriodSalary(salaryFacts(120_000), 12);
    expect((per as Decimal).toFixed(2)).toBe("10000.00");
  });

  it("biweekly (P=26): 104_000 → 4_000.00", () => {
    const per = computePeriodSalary(salaryFacts(104_000), 26);
    expect((per as Decimal).toFixed(2)).toBe("4000.00");
  });

  it("weekly (P=52): 78_000 → 1_500.00", () => {
    const per = computePeriodSalary(salaryFacts(78_000), 52);
    expect((per as Decimal).toFixed(2)).toBe("1500.00");
  });

  it("returns null when the employee has no SALARY compensation snapshot", () => {
    expect(computePeriodSalary(salaryFacts(null), 24)).toBeNull();
  });

  it("throws when periodsPerYear <= 0 (fail-closed)", () => {
    expect(() => computePeriodSalary(salaryFacts(150_000), 0)).toThrow();
    expect(() => computePeriodSalary(salaryFacts(150_000), -1)).toThrow();
  });

  it("rounding: 55_000 / 26 rounds to accepted currency (Decimal, not float)", () => {
    // 55000 / 26 = 2115.384615... → downstream calc applies canonical
    // currency rounding. computePeriodSalary itself is pure division
    // and returns full precision — the rounding contract lives with
    // the earnings calculator's grossPay pass, which the calc-execute
    // suite covers end-to-end. Assert precision preservation here.
    const per = computePeriodSalary(salaryFacts(55_000), 26)!;
    // 55000/26 = 2115.384615384615...
    expect(per.toFixed(6)).toBe("2115.384615");
  });

  it("does NOT divide by calendar-days (§5 anti-pattern)", () => {
    // A wrong implementation could compute annualSalary / 365 * daysInPeriod
    // = 150000 / 365 * 15 = 6164.38... For a full semi-monthly period
    // the correct answer is 6250.00. This test proves the periodization
    // uses pay-group frequency, not calendar days.
    const per = computePeriodSalary(salaryFacts(150_000), 24)!;
    expect(per.toFixed(2)).toBe("6250.00");
    expect(per.toFixed(2)).not.toBe("6164.38");
  });
});

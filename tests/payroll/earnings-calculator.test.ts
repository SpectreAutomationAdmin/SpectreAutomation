// Payroll-3B-5B-2b — pure earnings calculator unit tests (no DB).

import { describe, it, expect } from "vitest";
import { calculateEarnings } from "@/lib/payroll/earnings-calculator";
import type { PayrollBatchSourceFactsV1 } from "@/lib/payroll/source-facts-schema";

function facts(overrides: Partial<PayrollBatchSourceFactsV1> = {}): PayrollBatchSourceFactsV1 {
  return {
    schemaVersion: 1,
    coverage: {
      membershipEffectiveFrom: "2026-01-01T00:00:00.000Z",
      membershipEffectiveTo:   null,
      coverageStart:           "2026-01-01T00:00:00.000Z",
      coverageEnd:             "2026-01-14T00:00:00.000Z",
      coverageDays:            14,
      periodDays:              14,
      isFullPeriod:            true,
    },
    identity:      { dateOfBirth: "1990-05-12T00:00:00.000Z" },
    assignments:   [],
    compensations: [],
    allowances:    [],
    ...overrides,
  };
}

describe("calculateEarnings — regular hourly", () => {
  it("hourlyRate × approvedHours → gross + all three bases", () => {
    const r = calculateEarnings({
      sourceFacts: facts({
        compensations: [{
          id: "c1", assignmentId: null, payType: "HOURLY",
          hourlyRate: "22.50", annualSalary: null,
          effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null,
        }],
      }),
      earningRows:        [],
      allowances:         [],
      approvedHours:      "80",
      periodsPerYear:     26,
      salariedFullPeriod: false,
    });
    expect(r.grossPay.toFixed(2)).toBe("1800.00");
    expect(r.earningsTaxable.toFixed(2)).toBe("1800.00");
    expect(r.earningsPensionable.toFixed(2)).toBe("1800.00");
    expect(r.earningsInsurable.toFixed(2)).toBe("1800.00");
  });
});

describe("calculateEarnings — full-period salary", () => {
  it("annualSalary / P → periodSalary; P=26 → 52,000 / 26 = 2,000.00", () => {
    const r = calculateEarnings({
      sourceFacts: facts({
        compensations: [{
          id: "c1", assignmentId: null, payType: "SALARY",
          hourlyRate: null, annualSalary: "52000",
          effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null,
        }],
      }),
      earningRows:        [],
      allowances:         [],
      approvedHours:      "0",
      periodsPerYear:     26,
      salariedFullPeriod: true,
    });
    expect(r.grossPay.toFixed(2)).toBe("2000.00");
    expect(r.earningsPensionable.toFixed(2)).toBe("2000.00");
  });
  it("P is honoured — biweekly-27 year produces a slightly smaller period salary", () => {
    const r = calculateEarnings({
      sourceFacts: facts({
        compensations: [{
          id: "c1", assignmentId: null, payType: "SALARY",
          hourlyRate: null, annualSalary: "52000",
          effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null,
        }],
      }),
      earningRows:        [],
      allowances:         [],
      approvedHours:      "0",
      periodsPerYear:     27,
      salariedFullPeriod: true,
    });
    // 52000 / 27 = 1925.9259... → HALF_UP → 1925.93
    expect(r.grossPay.toFixed(2)).toBe("1925.93");
  });
});

describe("calculateEarnings — allowance classification independence (§18)", () => {
  it("taxable-only allowance affects gross + taxable but NOT pensionable/insurable", () => {
    const r = calculateEarnings({
      sourceFacts: facts({
        compensations: [{
          id: "c1", assignmentId: null, payType: "HOURLY",
          hourlyRate: "20.00", annualSalary: null,
          effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null,
        }],
      }),
      earningRows: [],
      allowances: [{
        amount: "100.00", frequency: "PER_PAY_PERIOD",
        taxable: true, pensionable: false, insurable: false,
      }],
      approvedHours:      "80",
      periodsPerYear:     26,
      salariedFullPeriod: false,
    });
    // Regular = 20 × 80 = 1600. Allowance = 100. Gross = 1700.
    expect(r.grossPay.toFixed(2)).toBe("1700.00");
    expect(r.earningsTaxable.toFixed(2)).toBe("1700.00");
    expect(r.earningsPensionable.toFixed(2)).toBe("1600.00");   // allowance excluded
    expect(r.earningsInsurable.toFixed(2)).toBe("1600.00");
  });
  it("pensionable-only allowance affects pensionable but NOT taxable/insurable", () => {
    const r = calculateEarnings({
      sourceFacts: facts({
        compensations: [{
          id: "c1", assignmentId: null, payType: "HOURLY",
          hourlyRate: "20.00", annualSalary: null,
          effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null,
        }],
      }),
      earningRows: [],
      allowances: [{
        amount: "50.00", frequency: "PER_PAY_PERIOD",
        taxable: false, pensionable: true, insurable: false,
      }],
      approvedHours:      "80",
      periodsPerYear:     26,
      salariedFullPeriod: false,
    });
    expect(r.grossPay.toFixed(2)).toBe("1650.00");
    expect(r.earningsTaxable.toFixed(2)).toBe("1600.00");
    expect(r.earningsPensionable.toFixed(2)).toBe("1650.00");
    expect(r.earningsInsurable.toFixed(2)).toBe("1600.00");
  });
  it("insurable-only allowance affects insurable but NOT taxable/pensionable", () => {
    const r = calculateEarnings({
      sourceFacts: facts({
        compensations: [{
          id: "c1", assignmentId: null, payType: "HOURLY",
          hourlyRate: "20.00", annualSalary: null,
          effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null,
        }],
      }),
      earningRows: [],
      allowances: [{
        amount: "50.00", frequency: "PER_PAY_PERIOD",
        taxable: false, pensionable: false, insurable: true,
      }],
      approvedHours:      "80",
      periodsPerYear:     26,
      salariedFullPeriod: false,
    });
    expect(r.earningsInsurable.toFixed(2)).toBe("1650.00");
    expect(r.earningsTaxable.toFixed(2)).toBe("1600.00");
    expect(r.earningsPensionable.toFixed(2)).toBe("1600.00");
  });
});

describe("calculateEarnings — allowance frequency conversion", () => {
  it("MONTHLY 300 / P=26 → per-period ≈ 138.46 (300 × 12 / 26)", () => {
    const r = calculateEarnings({
      sourceFacts: facts(),
      earningRows: [],
      allowances: [{
        amount: "300.00", frequency: "MONTHLY",
        taxable: true, pensionable: true, insurable: true,
      }],
      approvedHours:      "0",
      periodsPerYear:     26,
      salariedFullPeriod: false,
    });
    // 300 × 12 / 26 = 138.4615... → 138.46
    expect(r.grossPay.toFixed(2)).toBe("138.46");
  });
});

describe("calculateEarnings — explicit earning row (e.g. salary as one lump row)", () => {
  it("REGULAR row quantity=1 rate=2000 → gross 2000 (with no double-counting from salary path)", () => {
    const r = calculateEarnings({
      sourceFacts: facts({
        compensations: [{
          id: "c1", assignmentId: null, payType: "SALARY",
          hourlyRate: null, annualSalary: "52000",
          effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null,
        }],
      }),
      earningRows: [{ earningType: "SALARY", quantity: "1", rate: "2000.00" }],
      allowances:         [],
      approvedHours:      "0",
      periodsPerYear:     26,
      salariedFullPeriod: true,
    });
    // Explicit SALARY row present → salary path is skipped → gross = 2000 (not 4000).
    expect(r.grossPay.toFixed(2)).toBe("2000.00");
  });
});

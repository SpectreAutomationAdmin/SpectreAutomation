// Payroll-3B-5B-2b CORRECTION — pure EI calculator unit tests.
//
// Enforces the CRA operational contract for the STANDARD (non-
// reduced) employer:
//
//     employerEi = HALF_UP round(actualEmployeeEiWithheld × employerMultiplier, 2)
//
// bounded by the employer's own remaining annual max (safety
// invariant). The nominal `rateER` is NOT independently multiplied
// against per-period insurable earnings after the employee premium
// has been calculated.

import { describe, it, expect } from "vitest";
import { calculateEi } from "@/lib/payroll/statutory/ei-calculator";

const EI_2026 = {
  mie:                "68900",
  rateEE:             "0.0163",
  rateER:             "0.02282",
  maxAnnualPremiumEE: "1123.07",
  maxAnnualPremiumER: "1572.30",
  employerMultiplier: "1.4",
};

describe("calculateEi — PDOC Scenario 1 anchor", () => {
  it("insurable=2000, YTD=0 → employee EI = 32.60, employer EI = 45.64 (32.60 × 1.4)", () => {
    const r = calculateEi({
      insurableEarnings: "2000.00",
      ytdInsurable:      "0",
      ytdEiEE:           "0",
      ytdEiER:           "0",
      ei:                EI_2026,
    });
    expect(r.employee.toFixed(2)).toBe("32.60");
    // 32.60 × 1.4 = 45.640 → HALF_UP → 45.64.
    expect(r.employer.toFixed(2)).toBe("45.64");
    expect(r.cappedAtAnnualMaxEE).toBe(false);
    expect(r.cappedAtInsurableCeilingEE).toBe(false);
    expect(r.cappedAtAnnualMaxER).toBe(false);
  });
});

describe("calculateEi — CRA operational relationship 8.97 × 1.4 = 12.56", () => {
  it("employee EI 8.97 → employer EI 12.56 (independent of insurable earnings)", () => {
    // Choose insurable so employee EI rounds to exactly 8.97:
    //   8.97 / 0.0163 = 550.30... → try 550.30 exactly.
    //   0.0163 × 550.30 = 8.969890 → HALF_UP → 8.97. ✓
    const r = calculateEi({
      insurableEarnings: "550.30",
      ytdInsurable:      "0",
      ytdEiEE:           "0",
      ytdEiER:           "0",
      ei:                EI_2026,
    });
    expect(r.employee.toFixed(2)).toBe("8.97");
    // 8.97 × 1.4 = 12.558 → HALF_UP → 12.56.
    // (The independent nominal-rate path would give
    //  0.02282 × 550.30 = 12.5578 → 12.56 — coincidentally equal
    //  here, but the semantic is: employer is DERIVED FROM 8.97.)
    expect(r.employer.toFixed(2)).toBe("12.56");
  });
  it("employer result is DERIVED from the rounded employee premium, not from independent nominal rate", () => {
    // Deliberately construct a case where the two paths DIVERGE.
    //   insurable = 100.31
    //   rateEE × insurable = 0.0163 × 100.31 = 1.635053 → HALF_UP → 1.64
    //   employee-derived employer = 1.64 × 1.4 = 2.296 → HALF_UP → 2.30
    //   INDEPENDENT nominal path = 0.02282 × 100.31 = 2.2891 → HALF_UP → 2.29
    // The correct answer is 2.30 (derived path). If Spectre ever
    // reverts to the independent nominal calculation, this test
    // fails loudly.
    const r = calculateEi({
      insurableEarnings: "100.31",
      ytdInsurable:      "0",
      ytdEiEE:           "0",
      ytdEiER:           "0",
      ei:                EI_2026,
    });
    expect(r.employee.toFixed(2)).toBe("1.64");
    expect(r.employer.toFixed(2)).toBe("2.30");
    // Prove the divergence exists in principle:
    const nominalIndependent = Math.round(0.02282 * 100.31 * 100) / 100;
    expect(nominalIndependent).toBe(2.29);
    expect(Number(r.employer.toFixed(2))).not.toBe(nominalIndependent);
  });
});

describe("calculateEi — annual maximum", () => {
  it("YTD leaves only $3.07 employee room → employee=3.07, employer=4.30 (3.07 × 1.4)", () => {
    const r = calculateEi({
      insurableEarnings: "2000.00",
      ytdInsurable:      "60000.00",
      ytdEiEE:           "1120.00",
      ytdEiER:           "1550.00",
      ei:                EI_2026,
    });
    expect(r.employee.toFixed(2)).toBe("3.07");
    // 3.07 × 1.4 = 4.298 → HALF_UP → 4.30. Remaining employer max
    // is 22.30 (1572.30 - 1550.00), so employer cap does NOT bite.
    expect(r.employer.toFixed(2)).toBe("4.30");
    expect(r.cappedAtAnnualMaxEE).toBe(true);
    expect(r.cappedAtAnnualMaxER).toBe(false);
  });
});

describe("calculateEi — employee already at annual maximum", () => {
  it("employee at annual max → employee = 0.00 AND employer = 0.00 (does NOT keep charging via nominal rate)", () => {
    const r = calculateEi({
      insurableEarnings: "2000.00",
      ytdInsurable:      "70000.00",
      ytdEiEE:           "1123.07",
      ytdEiER:           "1500.00",  // still has 72.30 nominal room, but employee stopped
      ei:                EI_2026,
    });
    expect(r.employee.toFixed(2)).toBe("0.00");
    // Derived from 0 × 1.4 = 0 → 0.00. Independent nominal would
    // wrongly produce 0.02282 × 2000 = 45.64 here.
    expect(r.employer.toFixed(2)).toBe("0.00");
  });
});

describe("calculateEi — employer annual maximum is still a safety invariant", () => {
  it("employer max caps the derived amount when employee×multiple would exceed it", () => {
    // Employee EI = 32.60 → derived employer = 45.64. Remaining
    // employer room = 1572.30 - 1570.00 = 2.30 → capped at 2.30.
    const r = calculateEi({
      insurableEarnings: "2000.00",
      ytdInsurable:      "50000.00",
      ytdEiEE:           "500.00",
      ytdEiER:           "1570.00",
      ei:                EI_2026,
    });
    expect(r.employee.toFixed(2)).toBe("32.60");
    expect(r.employer.toFixed(2)).toBe("2.30");
    expect(r.cappedAtAnnualMaxER).toBe(true);
  });
});

describe("calculateEi — MIE insurable-earnings ceiling", () => {
  it("YTD near MIE — employee premium calculated on the capped insurable; employer derived from THAT premium", () => {
    // Room to MIE = 900. Employee EI = 0.0163 × 900 = 14.67 → 14.67.
    // Employer = 14.67 × 1.4 = 20.538 → HALF_UP → 20.54.
    const r = calculateEi({
      insurableEarnings: "2000.00",
      ytdInsurable:      "68000.00",
      ytdEiEE:           "1108.40",
      ytdEiER:           "1551.76",
      ei:                EI_2026,
    });
    expect(r.employee.toFixed(2)).toBe("14.67");
    expect(r.employer.toFixed(2)).toBe("20.54");
    expect(r.cappedAtInsurableCeilingEE).toBe(true);
  });
  it("YTD at MIE → employee = 0.00 AND employer = 0.00", () => {
    const r = calculateEi({
      insurableEarnings: "2000.00",
      ytdInsurable:      "68900.00",
      ytdEiEE:           "500.00",
      ytdEiER:           "500.00",
      ei:                EI_2026,
    });
    expect(r.employee.toFixed(2)).toBe("0.00");
    expect(r.employer.toFixed(2)).toBe("0.00");
  });
});

describe("calculateEi — non-negative floor", () => {
  it("insurable=0 → EI = 0.00 for both sides", () => {
    const r = calculateEi({
      insurableEarnings: "0",
      ytdInsurable:      "0",
      ytdEiEE:           "0",
      ytdEiER:           "0",
      ei:                EI_2026,
    });
    expect(r.employee.toFixed(2)).toBe("0.00");
    expect(r.employer.toFixed(2)).toBe("0.00");
  });
});

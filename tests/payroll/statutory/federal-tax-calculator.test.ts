// Payroll-3B-5B-2c — pure federal income-tax calculator tests (no DB).

import { describe, it, expect } from "vitest";
import { calculateFederalTax } from "@/lib/payroll/statutory/federal-tax-calculator";

const FED_2026 = {
  brackets: [
    { from: "0",      to: "58523",  rate: "0.1400", constantK: "0" },
    { from: "58523",  to: "117045", rate: "0.2050", constantK: "3804" },
    { from: "117045", to: "181440", rate: "0.2600", constantK: "10241" },
    { from: "181440", to: "258482", rate: "0.2900", constantK: "15685" },
    { from: "258482", to: null,     rate: "0.3300", constantK: "26024" },
  ],
  lowestRate:               "0.1400",
  bpaMax:                   "16452",
  bpaMin:                   "14829",
  bpaPhaseOutStart:         "173205",
  bpaPhaseOutEnd:           "246752",
  canadaEmploymentAmountMax: "1501",
};

describe("calculateFederalTax — PDOC Scenario 1 anchor", () => {
  it("$2000 biweekly + BPA-only TD1 → federal T4 = 163.23", () => {
    const r = calculateFederalTax({
      periodicTaxableRemuneration: "2000", f5aThisPay: "18.65",
      baseCppThisPay: "92.34", eiThisPay: "32.60",
      periodsPerYear: 26,
      federalClaim: "16452", claimZeroFederal: false, totalIncomeLessThanClaim: false,
      federal: FED_2026,
    });
    expect(r.a.toFixed(2)).toBe("51515.10");            // 26 × (2000 − 18.65)
    expect(r.aStar.toFixed(2)).toBe("52000.00");        // 26 × 2000
    expect(r.bpaf.toFixed(2)).toBe("16452.00");         // max — A ≤ phase-out start
    expect(r.bracketRate.toFixed(4)).toBe("0.1400");
    expect(r.k4.toFixed(4)).toBe((0.14 * 1501).toFixed(4));
    expect(r.t4PerPeriod.toFixed(2)).toBe("163.23");
  });
});

describe("calculateFederalTax — Scenario 2 (custom TD1)", () => {
  it("federal TD1 = 20000 → federal T4 = 144.12", () => {
    const r = calculateFederalTax({
      periodicTaxableRemuneration: "2000", f5aThisPay: "18.65",
      baseCppThisPay: "92.34", eiThisPay: "32.60",
      periodsPerYear: 26,
      federalClaim: "20000", claimZeroFederal: false, totalIncomeLessThanClaim: false,
      federal: FED_2026,
    });
    expect(r.t4PerPeriod.toFixed(2)).toBe("144.12");
  });
});

describe("calculateFederalTax — Scenario 4 (claim-zero federal)", () => {
  it("claimZeroFederal=true → federal T4 = 251.82 (no BPA / TCF credit)", () => {
    const r = calculateFederalTax({
      periodicTaxableRemuneration: "2000", f5aThisPay: "18.65",
      baseCppThisPay: "92.34", eiThisPay: "32.60",
      periodsPerYear: 26,
      federalClaim: "0", claimZeroFederal: true, totalIncomeLessThanClaim: false,
      federal: FED_2026,
    });
    expect(r.bpaf.toFixed(2)).toBe("0.00");
    expect(r.k1.toFixed(2)).toBe("0.00");
    expect(r.t4PerPeriod.toFixed(2)).toBe("251.82");
  });
});

describe("calculateFederalTax — A vs A* distinction", () => {
  it("F5A shrinks A but does NOT shrink A*", () => {
    const r = calculateFederalTax({
      periodicTaxableRemuneration: "2000", f5aThisPay: "18.65",
      baseCppThisPay: "92.34", eiThisPay: "32.60",
      periodsPerYear: 26,
      federalClaim: "16452", claimZeroFederal: false, totalIncomeLessThanClaim: false,
      federal: FED_2026,
    });
    // A* = P × I always. A = P × (I − F5A).
    expect(Number(r.aStar)).toBeGreaterThan(Number(r.a));
    expect(r.aStar.minus(r.a).toFixed(2)).toBe(r.f5aAnnual.toFixed(2));
  });
  it("K4 uses A*, not A — cap at CEA when A* > CEA", () => {
    const r = calculateFederalTax({
      periodicTaxableRemuneration: "2000", f5aThisPay: "18.65",
      baseCppThisPay: "92.34", eiThisPay: "32.60",
      periodsPerYear: 26,
      federalClaim: "16452", claimZeroFederal: false, totalIncomeLessThanClaim: false,
      federal: FED_2026,
    });
    // A* = 52000 > CEA 1501 → K4 = 0.14 × 1501 = 210.14.
    expect(r.k4.toFixed(2)).toBe("210.14");
  });
});

describe("calculateFederalTax — K2 excludes CPP first-additional and CPP2", () => {
  it("K2 depends on baseCPP + EI only (annualised)", () => {
    const r = calculateFederalTax({
      periodicTaxableRemuneration: "2000", f5aThisPay: "18.65",
      baseCppThisPay: "92.34", eiThisPay: "32.60",
      periodsPerYear: 26,
      federalClaim: "16452", claimZeroFederal: false, totalIncomeLessThanClaim: false,
      federal: FED_2026,
    });
    // K2 = 0.14 × (26 × 92.34 + 26 × 32.60) = 0.14 × 3248.44 = 454.7816
    expect(r.k2.toFixed(4)).toBe("454.7816");
  });
});

describe("calculateFederalTax — bracket boundaries", () => {
  it("A just below bracket-2 → row 1 (14%)", () => {
    // Choose I so that P × I = 58500 (< 58523), F5A=0.
    // I = 58500/26 = 2250.
    const r = calculateFederalTax({
      periodicTaxableRemuneration: "2250", f5aThisPay: "0",
      baseCppThisPay: "0", eiThisPay: "0",
      periodsPerYear: 26,
      federalClaim: "0", claimZeroFederal: true, totalIncomeLessThanClaim: false,
      federal: FED_2026,
    });
    expect(r.bracketRate.toFixed(4)).toBe("0.1400");
    expect(r.bracketK.toFixed(2)).toBe("0.00");
  });
  it("A between bracket-2 and bracket-3 → row 2 (20.5%, K=3804)", () => {
    const r = calculateFederalTax({
      periodicTaxableRemuneration: "4000", f5aThisPay: "0",
      baseCppThisPay: "0", eiThisPay: "0",
      periodsPerYear: 26,
      federalClaim: "0", claimZeroFederal: true, totalIncomeLessThanClaim: false,
      federal: FED_2026,
    });
    // A = 104000 → row 2.
    expect(r.bracketRate.toFixed(4)).toBe("0.2050");
    expect(r.bracketK.toFixed(2)).toBe("3804.00");
  });
});

describe("calculateFederalTax — BPA phase-out", () => {
  it("A ≤ phase-out start → BPAF = bpaMax", () => {
    const r = calculateFederalTax({
      periodicTaxableRemuneration: "3000", f5aThisPay: "0",
      baseCppThisPay: "0", eiThisPay: "0",
      periodsPerYear: 26,
      federalClaim: "16452", claimZeroFederal: false, totalIncomeLessThanClaim: false,
      federal: FED_2026,
    });
    expect(r.bpaf.toFixed(2)).toBe("16452.00");
  });
  it("A ≥ phase-out end → BPAF = bpaMin", () => {
    // I = 10000 → A = 260000 > phase-out end 246752 → bpaMin.
    const r = calculateFederalTax({
      periodicTaxableRemuneration: "10000", f5aThisPay: "0",
      baseCppThisPay: "0", eiThisPay: "0",
      periodsPerYear: 26,
      federalClaim: "16452", claimZeroFederal: false, totalIncomeLessThanClaim: false,
      federal: FED_2026,
    });
    expect(r.bpaf.toFixed(2)).toBe("14829.00");
  });
});

describe("calculateFederalTax — floors at zero", () => {
  it("very low earnings + high claim → T3 floored at zero, T4 = 0.00", () => {
    const r = calculateFederalTax({
      periodicTaxableRemuneration: "100", f5aThisPay: "0",
      baseCppThisPay: "0", eiThisPay: "0",
      periodsPerYear: 26,
      federalClaim: "16452", claimZeroFederal: false, totalIncomeLessThanClaim: false,
      federal: FED_2026,
    });
    expect(r.t3Annual.toFixed(2)).toBe("0.00");
    expect(r.t4PerPeriod.toFixed(2)).toBe("0.00");
  });
  it("totalIncomeLessThanClaim = true → T4 = 0.00 regardless of earnings", () => {
    const r = calculateFederalTax({
      periodicTaxableRemuneration: "9999", f5aThisPay: "0",
      baseCppThisPay: "0", eiThisPay: "0",
      periodsPerYear: 26,
      federalClaim: "16452", claimZeroFederal: false, totalIncomeLessThanClaim: true,
      federal: FED_2026,
    });
    expect(r.t4PerPeriod.toFixed(2)).toBe("0.00");
  });
});

// Payroll-3B-5B-2b — pure EI calculator unit tests (no DB).

import { describe, it, expect } from "vitest";
import { calculateEi } from "@/lib/payroll/statutory/ei-calculator";

const EI_2026 = {
  mie:                "68900",
  rateEE:             "0.0163",
  rateER:             "0.02282",
  maxAnnualPremiumEE: "1123.07",
  maxAnnualPremiumER: "1572.30",
};

describe("calculateEi — normal case (PDOC Scenario 1)", () => {
  it("insurable=2000, YTD=0 → employee EI = 32.60, employer EI = 45.64", () => {
    const r = calculateEi({
      insurableEarnings: "2000.00",
      ytdInsurable:      "0",
      ytdEiEE:           "0",
      ytdEiER:           "0",
      ei:                EI_2026,
    });
    expect(r.employee.toFixed(2)).toBe("32.60");
    expect(r.employer.toFixed(2)).toBe("45.64");   // 2000 × 0.02282
    expect(r.cappedAtAnnualMaxEE).toBe(false);
    expect(r.cappedAtInsurableCeilingEE).toBe(false);
  });
});

describe("calculateEi — annual maximum", () => {
  it("YTD leaves only a small remaining amount → current EI equals remaining room", () => {
    const r = calculateEi({
      insurableEarnings: "2000.00",
      ytdInsurable:      "60000.00",
      ytdEiEE:           "1120.00",   // 3.07 remaining
      ytdEiER:           "1550.00",
      ei:                EI_2026,
    });
    expect(r.employee.toFixed(2)).toBe("3.07");
    expect(r.cappedAtAnnualMaxEE).toBe(true);
  });
  it("YTD already at annual maximum → EI = 0.00", () => {
    const r = calculateEi({
      insurableEarnings: "2000.00",
      ytdInsurable:      "70000.00",
      ytdEiEE:           "1123.07",
      ytdEiER:           "1572.30",
      ei:                EI_2026,
    });
    expect(r.employee.toFixed(2)).toBe("0.00");
    expect(r.employer.toFixed(2)).toBe("0.00");
  });
});

describe("calculateEi — insurable-earnings ceiling", () => {
  it("YTD near MIE — only the portion up to MIE attracts EI", () => {
    // YTD insurable 68000, MIE 68900 → 900 room. Current PI 2000 → capped at 900.
    // 900 × 0.0163 = 14.67
    const r = calculateEi({
      insurableEarnings: "2000.00",
      ytdInsurable:      "68000.00",
      ytdEiEE:           "1108.40",
      ytdEiER:           "1551.76",
      ei:                EI_2026,
    });
    expect(r.employee.toFixed(2)).toBe("14.67");
    expect(r.cappedAtInsurableCeilingEE).toBe(true);
  });
  it("YTD already at MIE → EI = 0.00", () => {
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

describe("calculateEi — employer premium obeys its own annual maximum", () => {
  it("employer EI is bounded by maxAnnualPremiumER, not by employee EI × 1.4", () => {
    // Big insurable, employer YTD near max.
    const r = calculateEi({
      insurableEarnings: "2000.00",
      ytdInsurable:      "50000.00",
      ytdEiEE:           "500.00",
      ytdEiER:           "1570.00",   // only 2.30 room
      ei:                EI_2026,
    });
    expect(r.employer.toFixed(2)).toBe("2.30");
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

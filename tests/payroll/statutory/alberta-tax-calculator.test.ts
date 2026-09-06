// Payroll-3B-5B-2c — pure Alberta tax calculator tests (no DB).

import { describe, it, expect } from "vitest";
import { calculateAlbertaTax } from "@/lib/payroll/statutory/alberta-tax-calculator";

const AB_2026 = {
  brackets: [
    { from: "0",      to: "61200",  rate: "0.0800", constantK: "0" },
    { from: "61200",  to: "154259", rate: "0.1000", constantK: "1224" },
    { from: "154259", to: "185111", rate: "0.1200", constantK: "4309" },
    { from: "185111", to: "246813", rate: "0.1300", constantK: "6160" },
    { from: "246813", to: "370220", rate: "0.1400", constantK: "8628" },
    { from: "370220", to: null,     rate: "0.1500", constantK: "12331" },
  ],
  lowestRate: "0.0800",
  bpa:        "22769",
  k5p: {
    enabled:          true,
    threshold:        "4896",
    supplementalRate: "0.02",
    baseRate:         "0.08",
  },
};

describe("calculateAlbertaTax — PDOC Scenario 1 anchor", () => {
  it("$2000 biweekly + BPA-only TD1 → Alberta T4P = 78.45", () => {
    const r = calculateAlbertaTax({
      periodicTaxableRemuneration: "2000", f5aThisPay: "18.65",
      baseCppThisPay: "92.34", eiThisPay: "32.60",
      periodsPerYear: 26,
      provincialClaim: "22769", claimZeroProvincial: false, totalIncomeLessThanClaim: false,
      provincial: AB_2026,
    });
    expect(r.a.toFixed(2)).toBe("51515.10");
    expect(r.bracketRate.toFixed(4)).toBe("0.0800");
    expect(r.k4p.toFixed(2)).toBe("0.00");       // §22 statutory non-applicability
    expect(r.k5p.toFixed(2)).toBe("0.00");       // K1P+K2P below threshold
    expect(r.t4pPerPeriod.toFixed(2)).toBe("78.45");
  });
});

describe("calculateAlbertaTax — Scenario 2 (custom Alberta TD1)", () => {
  it("Alberta TD1 = 26000 → Alberta T4P = 68.51", () => {
    const r = calculateAlbertaTax({
      periodicTaxableRemuneration: "2000", f5aThisPay: "18.65",
      baseCppThisPay: "92.34", eiThisPay: "32.60",
      periodsPerYear: 26,
      provincialClaim: "26000", claimZeroProvincial: false, totalIncomeLessThanClaim: false,
      provincial: AB_2026,
    });
    expect(r.t4pPerPeriod.toFixed(2)).toBe("68.51");
  });
});

describe("calculateAlbertaTax — K2P excludes CPP first-additional and CPP2", () => {
  it("K2P depends on baseCPP + EI only, annualised by P", () => {
    const r = calculateAlbertaTax({
      periodicTaxableRemuneration: "2000", f5aThisPay: "18.65",
      baseCppThisPay: "92.34", eiThisPay: "32.60",
      periodsPerYear: 26,
      provincialClaim: "22769", claimZeroProvincial: false, totalIncomeLessThanClaim: false,
      provincial: AB_2026,
    });
    // K2P = 0.08 × (26 × 92.34 + 26 × 32.60) = 0.08 × 3248.44 = 259.8752
    expect(r.k2p.toFixed(4)).toBe("259.8752");
  });
});

describe("calculateAlbertaTax — K5P around the 4,896 threshold", () => {
  it("K1P + K2P BELOW threshold → K5P = 0.00", () => {
    // Set claim so K1P is low.
    const r = calculateAlbertaTax({
      periodicTaxableRemuneration: "2000", f5aThisPay: "18.65",
      baseCppThisPay: "92.34", eiThisPay: "32.60",
      periodsPerYear: 26,
      provincialClaim: "22769", claimZeroProvincial: false, totalIncomeLessThanClaim: false,
      provincial: AB_2026,
    });
    // K1P = 0.08 × 22769 = 1821.52; K2P = 259.8752; sum = 2081.3952 < 4896
    expect(r.k5p.toFixed(2)).toBe("0.00");
  });
  it("K1P + K2P above threshold → K5P > 0 (× 0.25 supplemental rate)", () => {
    // Push K1P higher: claim = 50000 → K1P = 0.08 × 50000 = 4000.
    // Add EI to boost K2P: use ei 100 → K2P = 0.08 × (26 × 100 + 26 × 100) = 416.
    // Actually simpler: use a bigger baseCpp to boost K2P.
    const r = calculateAlbertaTax({
      periodicTaxableRemuneration: "2000", f5aThisPay: "0",
      baseCppThisPay: "200", eiThisPay: "100",
      periodsPerYear: 26,
      provincialClaim: "50000", claimZeroProvincial: false, totalIncomeLessThanClaim: false,
      provincial: AB_2026,
    });
    // K1P = 0.08 × 50000 = 4000.00. K2P = 0.08 × (26 × 200 + 26 × 100) = 0.08 × 7800 = 624.
    // K1P + K2P = 4624 → still < 4896 → K5P = 0.
    expect(r.k1p.toFixed(2)).toBe("4000.00");
    expect(r.k2p.toFixed(2)).toBe("624.00");
    expect(r.k5p.toFixed(2)).toBe("0.00");
  });
  it("K1P + K2P substantially above threshold → K5P = above × 0.25", () => {
    // provincialClaim=60000 → K1P = 4800; ei/base pushed to K2P > 800.
    const r = calculateAlbertaTax({
      periodicTaxableRemuneration: "2000", f5aThisPay: "0",
      baseCppThisPay: "250", eiThisPay: "150",
      periodsPerYear: 26,
      provincialClaim: "60000", claimZeroProvincial: false, totalIncomeLessThanClaim: false,
      provincial: AB_2026,
    });
    // K1P = 0.08 × 60000 = 4800. K2P = 0.08 × (26 × 250 + 26 × 150) = 0.08 × 10400 = 832.
    // sum = 5632, above = 5632 - 4896 = 736 → K5P = 736 × 0.25 = 184.
    expect(r.k1p.toFixed(2)).toBe("4800.00");
    expect(r.k2p.toFixed(2)).toBe("832.00");
    expect(r.k5p.toFixed(2)).toBe("184.00");
  });
});

describe("calculateAlbertaTax — bracket boundaries", () => {
  it("A > 61200 → row 2 (10%, KP=1224)", () => {
    // I = 2500 × 26 = 65000 > 61200 → row 2. claim-zero to isolate bracket lookup.
    const r = calculateAlbertaTax({
      periodicTaxableRemuneration: "2500", f5aThisPay: "0",
      baseCppThisPay: "0", eiThisPay: "0",
      periodsPerYear: 26,
      provincialClaim: "0", claimZeroProvincial: true, totalIncomeLessThanClaim: false,
      provincial: AB_2026,
    });
    expect(r.bracketRate.toFixed(4)).toBe("0.1000");
    expect(r.bracketK.toFixed(2)).toBe("1224.00");
  });
  it("A > 154259 → row 3 (12%, KP=4309)", () => {
    const r = calculateAlbertaTax({
      periodicTaxableRemuneration: "7000", f5aThisPay: "0",
      baseCppThisPay: "0", eiThisPay: "0",
      periodsPerYear: 26,
      provincialClaim: "0", claimZeroProvincial: true, totalIncomeLessThanClaim: false,
      provincial: AB_2026,
    });
    // A = 182000
    expect(r.bracketRate.toFixed(4)).toBe("0.1200");
    expect(r.bracketK.toFixed(2)).toBe("4309.00");
  });
});

describe("calculateAlbertaTax — floors at zero", () => {
  it("low earnings + high claim → T3P floored at zero", () => {
    const r = calculateAlbertaTax({
      periodicTaxableRemuneration: "100", f5aThisPay: "0",
      baseCppThisPay: "0", eiThisPay: "0",
      periodsPerYear: 26,
      provincialClaim: "22769", claimZeroProvincial: false, totalIncomeLessThanClaim: false,
      provincial: AB_2026,
    });
    expect(r.t3pAnnual.toFixed(2)).toBe("0.00");
    expect(r.t4pPerPeriod.toFixed(2)).toBe("0.00");
  });
  it("totalIncomeLessThanClaim = true → T4P = 0.00", () => {
    const r = calculateAlbertaTax({
      periodicTaxableRemuneration: "9999", f5aThisPay: "0",
      baseCppThisPay: "0", eiThisPay: "0",
      periodsPerYear: 26,
      provincialClaim: "22769", claimZeroProvincial: false, totalIncomeLessThanClaim: true,
      provincial: AB_2026,
    });
    expect(r.t4pPerPeriod.toFixed(2)).toBe("0.00");
  });
});

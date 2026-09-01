// Payroll-3B-5B-2b — pure CPP2 calculator unit tests (no DB).

import { describe, it, expect } from "vitest";
import { calculateCpp2 } from "@/lib/payroll/statutory/cpp2-calculator";

const CPP_2026 = {
  ympe:       "74600",
  yampe:      "85000",
  cpp2RateEE: "0.0400",
  cpp2MaxEE:  "416.00",
};

describe("calculateCpp2 — below YMPE (matches PDOC Scenarios 1-4)", () => {
  it("PI=2000, YTD=0 → CPP2 = 0.00 (well below YMPE)", () => {
    const r = calculateCpp2({
      pensionableEarnings: "2000.00",
      ytdPensionable:      "0",
      ytdCpp2EE:           "0",
      pensionableMonths:   12,
      cpp:                 CPP_2026,
    });
    expect(r.amount.toFixed(2)).toBe("0.00");
  });
});

describe("calculateCpp2 — crossing YMPE", () => {
  it("PI+YTD straddles YMPE — only the portion above 74600 attracts CPP2", () => {
    // YTD = 73000, PI = 2000 → total = 75000. Above YMPE by 400. CPP2 = 4% × 400 = 16.00.
    const r = calculateCpp2({
      pensionableEarnings: "2000.00",
      ytdPensionable:      "73000.00",
      ytdCpp2EE:           "0",
      pensionableMonths:   12,
      cpp:                 CPP_2026,
    });
    expect(r.amount.toFixed(2)).toBe("16.00");
    expect(r.wThreshold.toFixed(2)).toBe("74600.00");
  });
});

describe("calculateCpp2 — between YMPE and YAMPE", () => {
  it("PI attracts CPP2 at 4% when YTD is already above YMPE", () => {
    // YTD = 75000 (above YMPE), PI = 1000. Above YMPE by additional 1000. CPP2 = 40.00.
    const r = calculateCpp2({
      pensionableEarnings: "1000.00",
      ytdPensionable:      "75000.00",
      ytdCpp2EE:           "16.00",
      pensionableMonths:   12,
      cpp:                 CPP_2026,
    });
    expect(r.amount.toFixed(2)).toBe("40.00");
  });
});

describe("calculateCpp2 — annual maximum cap", () => {
  it("current period is capped to remaining CPP2 room", () => {
    // YTD CPP2 = 400.00, only 16.00 room.
    const r = calculateCpp2({
      pensionableEarnings: "2000.00",
      ytdPensionable:      "84000.00",
      ytdCpp2EE:           "400.00",
      pensionableMonths:   12,
      cpp:                 CPP_2026,
    });
    expect(r.amount.toFixed(2)).toBe("16.00");
    expect(r.cappedAtAnnualMax).toBe(true);
  });
  it("YTD already at maximum → CPP2 = 0.00", () => {
    const r = calculateCpp2({
      pensionableEarnings: "5000.00",
      ytdPensionable:      "90000.00",
      ytdCpp2EE:           "416.00",
      pensionableMonths:   12,
      cpp:                 CPP_2026,
    });
    expect(r.amount.toFixed(2)).toBe("0.00");
  });
});

describe("calculateCpp2 — PM proration", () => {
  it("PM=6 halves both the CPP2 annual max AND the YMPE threshold", () => {
    // Prorated YMPE = 37300. YTD 38000 is already above → W = max(38000, 37300) = 38000.
    // above = max(0, 38000 + 2000 - 38000) = 2000 → CPP2 = 4% × 2000 = 80.00.
    // Prorated CPP2 max = 208.00 (416/2), so cap does NOT bite.
    const r = calculateCpp2({
      pensionableEarnings: "2000.00",
      ytdPensionable:      "38000.00",
      ytdCpp2EE:           "0",
      pensionableMonths:   6,
      cpp:                 CPP_2026,
    });
    expect(r.amount.toFixed(2)).toBe("80.00");
    expect(r.wThreshold.toFixed(2)).toBe("38000.00");
  });
  it("PM = 0 → zero", () => {
    const r = calculateCpp2({
      pensionableEarnings: "5000.00",
      ytdPensionable:      "80000.00",
      ytdCpp2EE:           "0",
      pensionableMonths:   0,
      cpp:                 CPP_2026,
    });
    expect(r.amount.toFixed(2)).toBe("0.00");
  });
});

describe("calculateCpp2 — non-negative floor", () => {
  it("never returns a negative amount", () => {
    const r = calculateCpp2({
      pensionableEarnings: "0",
      ytdPensionable:      "0",
      ytdCpp2EE:           "0",
      pensionableMonths:   12,
      cpp:                 CPP_2026,
    });
    expect(Number(r.amount.toFixed(2))).toBeGreaterThanOrEqual(0);
  });
});

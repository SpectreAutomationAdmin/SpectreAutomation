// Payroll-3B-5B-2b — pure CPP calculator unit tests (no DB).

import { describe, it, expect } from "vitest";
import { calculateCpp } from "@/lib/payroll/statutory/cpp-calculator";

// Canonical CA/AB 2026 CPP parameters — matches the pinned package
// values so the pure test is dimensionally identical to the
// integration path.
const CPP_2026 = {
  ybe:                    "3500",
  baseRateEE:             "0.0495",
  firstAdditionalRateEE:  "0.0100",
  combinedRateEE:         "0.0595",
  combinedMaxEE:          "4230.45",
};

describe("calculateCpp — ordinary biweekly (PDOC Scenario 1 anchor)", () => {
  it("PI=2000, YBE=3500, P=26, PM=12, D=0 → combined 110.99 / firstAdd 18.65 / base 92.34", () => {
    const r = calculateCpp({
      pensionableEarnings: "2000.00",
      ytdCombinedEE:       "0",
      periodsPerYear:      26,
      pensionableMonths:   12,
      cpp:                 CPP_2026,
    });
    expect(r.combined.toFixed(2)).toBe("110.99");
    expect(r.firstAdd.toFixed(2)).toBe("18.65");
    expect(r.base.toFixed(2)).toBe("92.34");
    expect(r.cappedAtCombinedMax).toBe(false);
  });
});

describe("calculateCpp — invariant + reconciliation", () => {
  it("base + firstAdd == combined for a wide range of PI values", () => {
    for (const pi of ["500.00", "1234.56", "1999.99", "2000.00", "3499.99", "5000.00", "10000.00"]) {
      const r = calculateCpp({
        pensionableEarnings: pi,
        ytdCombinedEE:       "0",
        periodsPerYear:      26,
        pensionableMonths:   12,
        cpp:                 CPP_2026,
      });
      expect(r.base.plus(r.firstAdd).toFixed(2)).toBe(r.combined.toFixed(2));
    }
  });
});

describe("calculateCpp — annual maximum cap", () => {
  it("current period is capped to remaining room when combined YTD is within cents of the annual max", () => {
    const r = calculateCpp({
      pensionableEarnings: "5000.00",           // huge — unconstrained would exceed cap
      ytdCombinedEE:       "4230.00",           // 45c remaining
      periodsPerYear:      26,
      pensionableMonths:   12,
      cpp:                 CPP_2026,
    });
    expect(r.combined.toFixed(2)).toBe("0.45");
    expect(r.base.plus(r.firstAdd).toFixed(2)).toBe(r.combined.toFixed(2));
    expect(r.cappedAtCombinedMax).toBe(true);
  });
  it("YTD already equals annual max → current CPP = 0.00", () => {
    const r = calculateCpp({
      pensionableEarnings: "5000.00",
      ytdCombinedEE:       "4230.45",
      periodsPerYear:      26,
      pensionableMonths:   12,
      cpp:                 CPP_2026,
    });
    expect(r.combined.toFixed(2)).toBe("0.00");
    expect(r.base.toFixed(2)).toBe("0.00");
    expect(r.firstAdd.toFixed(2)).toBe("0.00");
  });
});

describe("calculateCpp — pensionable months", () => {
  it("PM = 0 (not pensionable this period) → zero across the board", () => {
    const r = calculateCpp({
      pensionableEarnings: "2000.00",
      ytdCombinedEE:       "0",
      periodsPerYear:      26,
      pensionableMonths:   0,
      cpp:                 CPP_2026,
    });
    expect(r.combined.toFixed(2)).toBe("0.00");
  });
  it("PM = 6 → prorated combined max ceiling is halved", () => {
    // 4230.45 × 6/12 = 2115.225. YTD 2000 leaves 115.225 room; a
    // huge PI hits that cap.
    const r = calculateCpp({
      pensionableEarnings: "5000.00",
      ytdCombinedEE:       "2000.00",
      periodsPerYear:      26,
      pensionableMonths:   6,
      cpp:                 CPP_2026,
    });
    expect(r.combined.toFixed(2)).toBe("115.23");   // 115.225 → HALF_UP → 115.23
    expect(r.base.plus(r.firstAdd).toFixed(2)).toBe(r.combined.toFixed(2));
  });
});

describe("calculateCpp — non-negative floor", () => {
  it("PI ≤ YBE/P → zero (no negative deduction)", () => {
    const r = calculateCpp({
      pensionableEarnings: "100.00",   // well under YBE/P = 134.62
      ytdCombinedEE:       "0",
      periodsPerYear:      26,
      pensionableMonths:   12,
      cpp:                 CPP_2026,
    });
    expect(r.combined.toFixed(2)).toBe("0.00");
    expect(r.base.toFixed(2)).toBe("0.00");
    expect(r.firstAdd.toFixed(2)).toBe("0.00");
  });
});

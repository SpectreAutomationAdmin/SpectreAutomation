// Pure-fn unit tests for the centralized fiscal-period helper.
//
// No DB — pure date math. Lives under tests/lib/ so it runs in
// `test:unit:fast` (skipping the resetDb tax).

import { describe, it, expect } from "vitest";
import { computeFiscalPeriod, ordinalWord } from "@/lib/clubs/fiscal-period";

const MAY_15_2026 = new Date(Date.UTC(2026, 4, 15)); // May 15, 2026

describe("computeFiscalPeriod", () => {
  describe("the three founder-spec anchors (May 2026 base)", () => {
    it("June 30 fiscal year end → period 11 of 12 (FY ends Jun-30-2026)", () => {
      const r = computeFiscalPeriod(6, 30, MAY_15_2026);
      expect(r.periodNumber).toBe(11);
      expect(r.totalPeriods).toBe(12);
      expect(r.fiscalYearStart.toISOString()).toBe("2025-07-01T00:00:00.000Z");
      expect(r.fiscalYearEnd.toISOString()).toBe("2026-06-30T00:00:00.000Z");
      expect(r.fiscalYearLabel).toBe("FY2026 (Jul-Jun)");
    });

    it("December 31 fiscal year end → period 5 of 12 (calendar-year FY)", () => {
      const r = computeFiscalPeriod(12, 31, MAY_15_2026);
      expect(r.periodNumber).toBe(5);
      expect(r.fiscalYearStart.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(r.fiscalYearEnd.toISOString()).toBe("2026-12-31T00:00:00.000Z");
      expect(r.fiscalYearLabel).toBe("FY2026 (Jan-Dec)");
    });

    it("January 31 fiscal year end → period 4 of 12 (FY ends Jan-31-2027)", () => {
      const r = computeFiscalPeriod(1, 31, MAY_15_2026);
      expect(r.periodNumber).toBe(4);
      expect(r.fiscalYearStart.toISOString()).toBe("2026-02-01T00:00:00.000Z");
      expect(r.fiscalYearEnd.toISOString()).toBe("2027-01-31T00:00:00.000Z");
      expect(r.fiscalYearLabel).toBe("FY2027 (Feb-Jan)");
    });
  });

  describe("boundary days (date == FY end)", () => {
    it("date EQUAL to FY end belongs to that FY's period 12", () => {
      const r = computeFiscalPeriod(6, 30, new Date(Date.UTC(2026, 5, 30)));
      expect(r.periodNumber).toBe(12);
      expect(r.fiscalYearEnd.toISOString()).toBe("2026-06-30T00:00:00.000Z");
    });

    it("date ONE DAY after FY end belongs to the NEXT FY's period 1", () => {
      const r = computeFiscalPeriod(6, 30, new Date(Date.UTC(2026, 6, 1)));
      expect(r.periodNumber).toBe(1);
      expect(r.fiscalYearStart.toISOString()).toBe("2026-07-01T00:00:00.000Z");
      expect(r.fiscalYearEnd.toISOString()).toBe("2027-06-30T00:00:00.000Z");
    });
  });

  describe("invalid month/day combinations", () => {
    it("Feb 30 is rejected", () => {
      expect(() => computeFiscalPeriod(2, 30, MAY_15_2026)).toThrow(/not a valid calendar day/);
    });
    it("Apr 31 is rejected", () => {
      expect(() => computeFiscalPeriod(4, 31, MAY_15_2026)).toThrow(/not a valid calendar day/);
    });
    it("month 0 is rejected", () => {
      expect(() => computeFiscalPeriod(0, 15, MAY_15_2026)).toThrow(/must be 1..12/);
    });
    it("month 13 is rejected", () => {
      expect(() => computeFiscalPeriod(13, 15, MAY_15_2026)).toThrow(/must be 1..12/);
    });
    it("day 32 is rejected", () => {
      expect(() => computeFiscalPeriod(6, 32, MAY_15_2026)).toThrow(/must be 1..31/);
    });
  });
});

describe("ordinalWord", () => {
  it("maps 0..12 to their English words", () => {
    expect(ordinalWord(0)).toBe("Zero");
    expect(ordinalWord(1)).toBe("One");
    expect(ordinalWord(11)).toBe("Eleven");
    expect(ordinalWord(12)).toBe("Twelve");
  });
  it("falls back to the numeric string outside the table", () => {
    expect(ordinalWord(13)).toBe("13");
  });
});

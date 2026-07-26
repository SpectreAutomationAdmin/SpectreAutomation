// Jonas fiscal-period helpers — regression tests.
//
// Covers the date-inference business rule:
//
//   • A Jonas Trial Balance heading "Trial Balance for <Month>, <Year>"
//     always represents the LAST calendar day of that month.
//   • The fiscal-year START is one day after the previous fiscal-
//     year END (derived from the club's `fiscalYearEndMonth` /
//     `fiscalYearEndDay` policy).
//   • Leap-year handling: Feb 2024 → 2024-02-29; Feb 2025 → 2025-02-28.

import { describe, expect, it } from "vitest";

import {
  computeFiscalLabels,
  computeFiscalYearStart,
  DEFAULT_FISCAL_YEAR_END,
  lastDayOfMonthUtc,
} from "@/lib/reporting/ledger/importers/jonas-fiscal-period";

// ---------------------------------------------------------------------------
// lastDayOfMonthUtc — month-end inference
// ---------------------------------------------------------------------------

describe("lastDayOfMonthUtc", () => {
  it("Apr 2026 → 2026-04-30", () => {
    const d = lastDayOfMonthUtc(2026, 4);
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(3); // 0-indexed → April
    expect(d.getUTCDate()).toBe(30);
  });

  it("Feb 2024 (leap year) → 2024-02-29", () => {
    const d = lastDayOfMonthUtc(2024, 2);
    expect(d.getUTCFullYear()).toBe(2024);
    expect(d.getUTCMonth()).toBe(1);
    expect(d.getUTCDate()).toBe(29);
  });

  it("Feb 2025 (non-leap) → 2025-02-28", () => {
    const d = lastDayOfMonthUtc(2025, 2);
    expect(d.getUTCDate()).toBe(28);
  });

  it("Dec 2026 → 2026-12-31", () => {
    const d = lastDayOfMonthUtc(2026, 12);
    expect(d.getUTCDate()).toBe(31);
    expect(d.getUTCFullYear()).toBe(2026);
  });

  it("returns end-of-day timestamps (23:59:59.999 UTC)", () => {
    const d = lastDayOfMonthUtc(2026, 4);
    expect(d.getUTCHours()).toBe(23);
    expect(d.getUTCMinutes()).toBe(59);
    expect(d.getUTCSeconds()).toBe(59);
    expect(d.getUTCMilliseconds()).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// computeFiscalYearStart — fiscal-year-start derivation
// ---------------------------------------------------------------------------

describe("computeFiscalYearStart — fiscal-year-end Dec 31 (calendar-aligned)", () => {
  it("Apr 30 2026 → FY start Jan 1 2026", () => {
    const start = computeFiscalYearStart(lastDayOfMonthUtc(2026, 4), 12, 31);
    expect(start.toISOString().slice(0, 10)).toBe("2026-01-01");
  });

  it("Dec 31 2026 (last day of FY) → FY start Jan 1 2026", () => {
    const start = computeFiscalYearStart(lastDayOfMonthUtc(2026, 12), 12, 31);
    expect(start.toISOString().slice(0, 10)).toBe("2026-01-01");
  });

  it("Jan 31 2027 → FY start Jan 1 2027", () => {
    const start = computeFiscalYearStart(lastDayOfMonthUtc(2027, 1), 12, 31);
    expect(start.toISOString().slice(0, 10)).toBe("2027-01-01");
  });
});

describe("computeFiscalYearStart — fiscal-year-end Oct 31 (off-calendar)", () => {
  it("Apr 30 2026 → FY start Nov 1 2025 (Apr is in FY26 ending Oct 31 2026)", () => {
    const start = computeFiscalYearStart(lastDayOfMonthUtc(2026, 4), 10, 31);
    expect(start.toISOString().slice(0, 10)).toBe("2025-11-01");
  });

  it("Oct 31 2026 (last day of FY26) → FY start Nov 1 2025", () => {
    const start = computeFiscalYearStart(lastDayOfMonthUtc(2026, 10), 10, 31);
    expect(start.toISOString().slice(0, 10)).toBe("2025-11-01");
  });

  it("Nov 30 2026 (first month of FY27) → FY start Nov 1 2026", () => {
    const start = computeFiscalYearStart(lastDayOfMonthUtc(2026, 11), 10, 31);
    expect(start.toISOString().slice(0, 10)).toBe("2026-11-01");
  });

  it("Feb 28 2027 (mid-FY27) → FY start Nov 1 2026", () => {
    const start = computeFiscalYearStart(lastDayOfMonthUtc(2027, 2), 10, 31);
    expect(start.toISOString().slice(0, 10)).toBe("2026-11-01");
  });
});

describe("computeFiscalYearStart — fiscal-year-end Mar 31 (Q1-anchored)", () => {
  it("Apr 30 2026 (first month of FY27) → FY start Apr 1 2026", () => {
    const start = computeFiscalYearStart(lastDayOfMonthUtc(2026, 4), 3, 31);
    expect(start.toISOString().slice(0, 10)).toBe("2026-04-01");
  });

  it("Mar 31 2026 (last day of FY26) → FY start Apr 1 2025", () => {
    const start = computeFiscalYearStart(lastDayOfMonthUtc(2026, 3), 3, 31);
    expect(start.toISOString().slice(0, 10)).toBe("2025-04-01");
  });
});

describe("computeFiscalYearStart — input validation", () => {
  it("rejects out-of-range fyEndMonth", () => {
    expect(() => computeFiscalYearStart(new Date(), 13, 31)).toThrow(/fyEndMonth/);
    expect(() => computeFiscalYearStart(new Date(), 0, 31)).toThrow(/fyEndMonth/);
  });

  it("rejects out-of-range fyEndDay", () => {
    expect(() => computeFiscalYearStart(new Date(), 12, 32)).toThrow(/fyEndDay/);
    expect(() => computeFiscalYearStart(new Date(), 12, 0)).toThrow(/fyEndDay/);
  });
});

describe("computeFiscalLabels — FY label + fiscal period derivation", () => {
  it("Dec 31 FY end (calendar-aligned) — Apr 30 2026 → FY 2026 · period 4", () => {
    const labels = computeFiscalLabels(lastDayOfMonthUtc(2026, 4), 12, 31);
    expect(labels.fiscalYearNum).toBe(2026);
    expect(labels.fiscalPeriodNum).toBe(4);
  });

  it("Oct 31 FY end — Apr 30 2026 → FY 2026 · period 6", () => {
    // Nov=1, Dec=2, Jan=3, Feb=4, Mar=5, Apr=6 — matches the user's
    // worked example from the previous slice's spec.
    const labels = computeFiscalLabels(lastDayOfMonthUtc(2026, 4), 10, 31);
    expect(labels.fiscalYearNum).toBe(2026);
    expect(labels.fiscalPeriodNum).toBe(6);
  });

  it("Jun 30 FY end (Silver Springs) — May 31 2026 → FY 2026 · period 11", () => {
    // Jul=1, Aug=2, Sep=3, Oct=4, Nov=5, Dec=6, Jan=7, Feb=8, Mar=9,
    // Apr=10, May=11.
    const labels = computeFiscalLabels(lastDayOfMonthUtc(2026, 5), 6, 30);
    expect(labels.fiscalYearNum).toBe(2026);
    expect(labels.fiscalPeriodNum).toBe(11);
  });

  it("Mar 31 FY end — May 31 2026 → FY 2027 · period 2", () => {
    // FY 2027 spans Apr 1 2026 – Mar 31 2027. May = period 2.
    const labels = computeFiscalLabels(lastDayOfMonthUtc(2026, 5), 3, 31);
    expect(labels.fiscalYearNum).toBe(2027);
    expect(labels.fiscalPeriodNum).toBe(2);
  });

  it("Jun 30 FY end — Jun 30 2026 (last day of FY) → FY 2026 · period 12", () => {
    const labels = computeFiscalLabels(lastDayOfMonthUtc(2026, 6), 6, 30);
    expect(labels.fiscalYearNum).toBe(2026);
    expect(labels.fiscalPeriodNum).toBe(12);
  });

  it("Jun 30 FY end — Jul 31 2026 (first month of new FY) → FY 2027 · period 1", () => {
    const labels = computeFiscalLabels(lastDayOfMonthUtc(2026, 7), 6, 30);
    expect(labels.fiscalYearNum).toBe(2027);
    expect(labels.fiscalPeriodNum).toBe(1);
  });
});

describe("DEFAULT_FISCAL_YEAR_END", () => {
  it("is Dec 31 — the most common private-club convention", () => {
    expect(DEFAULT_FISCAL_YEAR_END.month).toBe(12);
    expect(DEFAULT_FISCAL_YEAR_END.day).toBe(31);
  });
});

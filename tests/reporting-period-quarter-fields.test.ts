// Quarter facets added to ReportingPeriod 2026-06-15 — exercise the
// canonical quarter math so any future tweak (locale, fiscal year
// override) cannot silently break the dependent reporting chapters.

import { describe, it, expect } from "vitest";

import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

describe("ReportingPeriod — quarter facets", () => {
  it("Q1: January, February, March → quarter 1, 'Q1 {year}', next 'Q2 {year}'", () => {
    for (const monthIdx of [0, 1, 2]) {
      const p = buildReportingPeriod(new Date(Date.UTC(2026, monthIdx, 28)));
      expect(p.quarter).toBe(1);
      expect(p.quarterLabel).toBe("Q1");
      expect(p.currentYearQuarterLabel).toBe("Q1 2026");
      expect(p.nextYearQuarterLabel).toBe("Q2 2026");
    }
  });

  it("Q2: April, May, June → quarter 2, 'Q2 {year}', next 'Q3 {year}'", () => {
    for (const monthIdx of [3, 4, 5]) {
      const p = buildReportingPeriod(new Date(Date.UTC(2026, monthIdx, 28)));
      expect(p.quarter).toBe(2);
      expect(p.quarterLabel).toBe("Q2");
      expect(p.currentYearQuarterLabel).toBe("Q2 2026");
      expect(p.nextYearQuarterLabel).toBe("Q3 2026");
    }
  });

  it("Q3: July, August, September → quarter 3", () => {
    for (const monthIdx of [6, 7, 8]) {
      const p = buildReportingPeriod(new Date(Date.UTC(2026, monthIdx, 28)));
      expect(p.quarter).toBe(3);
      expect(p.currentYearQuarterLabel).toBe("Q3 2026");
      expect(p.nextYearQuarterLabel).toBe("Q4 2026");
    }
  });

  it("Q4: October, November, December → quarter 4, next wraps to next year Q1", () => {
    for (const monthIdx of [9, 10, 11]) {
      const p = buildReportingPeriod(new Date(Date.UTC(2026, monthIdx, 28)));
      expect(p.quarter).toBe(4);
      expect(p.currentYearQuarterLabel).toBe("Q4 2026");
      expect(p.nextYearQuarterLabel).toBe("Q1 2027");
    }
  });
});

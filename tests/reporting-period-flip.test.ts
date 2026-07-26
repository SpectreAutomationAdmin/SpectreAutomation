// Period-flip regression test.
//
// Companion to `tests/reporting-period-golden-rule.test.ts` (which
// statically scans for forbidden literal strings). This test
// EXERCISES the ReportingPeriod object at multiple periods and
// asserts every derived label changes when the period changes.
//
// Concretely: build a May 2026 period AND a December 2026 period;
// for each named ReportingPeriod field, assert the two periods
// produce DIFFERENT values. A regression that hardcoded any label
// inside `buildReportingPeriod` would surface here as two equal
// strings across the period flip.
//
// This is the runtime counterpart of the static golden-rule guard:
// the guard catches "someone wrote 'May 31, 2026' as a literal"; this
// test catches "someone broke buildReportingPeriod so it no longer
// reacts to periodEnd".

import { describe, it, expect } from "vitest";

import {
  buildReportingPeriod,
  type ReportingPeriod,
} from "@/lib/reporting/reporting-period";

const MAY_2026 = new Date(Date.UTC(2026, 4, 31, 23, 59, 59));
const DECEMBER_2026 = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
const JANUARY_2027 = new Date(Date.UTC(2027, 0, 31, 23, 59, 59));

describe("ReportingPeriod — every derived label is period-driven", () => {
  it("flipping May 2026 → December 2026 changes every period-derived label", () => {
    const may = buildReportingPeriod(MAY_2026);
    const dec = buildReportingPeriod(DECEMBER_2026);

    // Calendar facets
    expect(may.year).toBe(2026);
    expect(dec.year).toBe(2026);
    expect(may.month).not.toBe(dec.month);
    expect(may.monthShort).not.toBe(dec.monthShort);
    expect(may.monthLong).not.toBe(dec.monthLong);

    // Quarter facets
    expect(may.quarter).not.toBe(dec.quarter);
    expect(may.quarterLabel).not.toBe(dec.quarterLabel);
    expect(may.currentYearQuarterLabel).not.toBe(dec.currentYearQuarterLabel);
    expect(may.nextYearQuarterLabel).not.toBe(dec.nextYearQuarterLabel);

    // Pre-formatted period labels
    expect(may.periodLabel).not.toBe(dec.periodLabel);
    expect(may.periodEndedLabel).not.toBe(dec.periodEndedLabel);
    expect(may.periodEndShortLabel).not.toBe(dec.periodEndShortLabel);
    expect(may.periodEndISO).not.toBe(dec.periodEndISO);
    expect(may.statementHeaderLabel).not.toBe(dec.statementHeaderLabel);
    expect(may.priorYearLabel).not.toBe(dec.priorYearLabel);

    // Prior / next month derivations
    expect(may.priorMonthLong).not.toBe(dec.priorMonthLong);
    expect(may.priorMonthShort).not.toBe(dec.priorMonthShort);
    expect(may.nextMonthLong).not.toBe(dec.nextMonthLong);
    expect(may.nextMonthShort).not.toBe(dec.nextMonthShort);

    // Column labels — current-month dependent labels MUST differ;
    // YTD labels are static ("YTD Budget", etc.) and may stay equal.
    expect(may.columnLabels.currentBudget).not.toBe(dec.columnLabels.currentBudget);
    expect(may.columnLabels.currentActual).not.toBe(dec.columnLabels.currentActual);
    expect(may.columnLabels.currentVariance).not.toBe(dec.columnLabels.currentVariance);
    expect(may.columnLabels.ytdBudget).toBe(dec.columnLabels.ytdBudget);
    expect(may.columnLabels.ytdActual).toBe(dec.columnLabels.ytdActual);
  });

  it("May 2026 — every label renders the May / Q2 / 2026 shape", () => {
    const period: ReportingPeriod = buildReportingPeriod(MAY_2026);
    expect(period.year).toBe(2026);
    expect(period.month).toBe(5);
    expect(period.monthShort).toBe("May");
    expect(period.monthLong).toBe("May");
    expect(period.quarter).toBe(2);
    expect(period.quarterLabel).toBe("Q2");
    expect(period.currentYearQuarterLabel).toBe("Q2 2026");
    expect(period.nextYearQuarterLabel).toBe("Q3 2026");
    expect(period.periodLabel).toBe("May 2026");
    expect(period.periodEndedLabel).toBe("For the period ended May 31, 2026");
    expect(period.periodEndShortLabel).toBe("May 31, 2026");
    expect(period.periodEndISO).toBe("2026-05-31");
    expect(period.statementHeaderLabel).toBe(
      "May 2026 · For the period ended May 31, 2026 · Year to Date",
    );
    expect(period.priorMonthLong).toBe("April");
    expect(period.priorMonthShort).toBe("Apr");
    expect(period.nextMonthLong).toBe("June");
    expect(period.nextMonthShort).toBe("Jun");
    expect(period.priorYear).toBe(2025);
    expect(period.priorYearLabel).toBe("May 2025");
    expect(period.columnLabels.currentBudget).toBe("May Budget");
    expect(period.columnLabels.currentActual).toBe("May Actual");
    expect(period.columnLabels.currentVariance).toBe("May Var");
  });

  it("December 2026 — every label renders the December / Q4 / 2026 shape and rolls cleanly into Q1 2027", () => {
    const period = buildReportingPeriod(DECEMBER_2026);
    expect(period.monthShort).toBe("Dec");
    expect(period.monthLong).toBe("December");
    expect(period.quarter).toBe(4);
    expect(period.currentYearQuarterLabel).toBe("Q4 2026");
    // next quarter wraps across the year boundary
    expect(period.nextYearQuarterLabel).toBe("Q1 2027");
    expect(period.periodLabel).toBe("December 2026");
    expect(period.periodEndShortLabel).toBe("December 31, 2026");
    expect(period.periodEndedLabel).toBe(
      "For the period ended December 31, 2026",
    );
    expect(period.statementHeaderLabel).toBe(
      "December 2026 · For the period ended December 31, 2026 · Year to Date",
    );
    // Prior month wraps cleanly back to November.
    expect(period.priorMonthLong).toBe("November");
    // Next month wraps into the new calendar year — clean January.
    expect(period.nextMonthLong).toBe("January");
    expect(period.priorYearLabel).toBe("December 2025");
    expect(period.columnLabels.currentBudget).toBe("Dec Budget");
  });

  it("January 2027 — prior month wraps cleanly back into December 2026", () => {
    const period = buildReportingPeriod(JANUARY_2027);
    expect(period.year).toBe(2027);
    expect(period.monthLong).toBe("January");
    expect(period.priorMonthLong).toBe("December");
    expect(period.priorMonthShort).toBe("Dec");
    expect(period.nextMonthLong).toBe("February");
    expect(period.priorYear).toBe(2026);
    expect(period.priorYearLabel).toBe("January 2026");
    expect(period.quarter).toBe(1);
    expect(period.currentYearQuarterLabel).toBe("Q1 2027");
    expect(period.nextYearQuarterLabel).toBe("Q2 2027");
    expect(period.periodEndShortLabel).toBe("January 31, 2027");
  });
});

describe("ReportingPeriod — derived field consistency", () => {
  // Cross-field invariants. If any of these break, the period
  // object is internally inconsistent (different labels for the
  // same conceptual date).
  it.each([
    ["May 2026", MAY_2026],
    ["December 2026", DECEMBER_2026],
    ["January 2027", JANUARY_2027],
  ] as const)("[%s] internal consistency", (_label, periodEnd) => {
    const period = buildReportingPeriod(periodEnd);
    // periodEndShortLabel is a substring of periodEndedLabel.
    expect(period.periodEndedLabel.endsWith(period.periodEndShortLabel)).toBe(true);
    // periodLabel is a substring of statementHeaderLabel.
    expect(period.statementHeaderLabel.startsWith(period.periodLabel)).toBe(true);
    // priorYear = year - 1.
    expect(period.priorYear).toBe(period.year - 1);
    // priorYearLabel renders `<monthLong> <priorYear>`.
    expect(period.priorYearLabel).toBe(`${period.monthLong} ${period.priorYear}`);
    // columnLabels.currentBudget renders `<monthShort> Budget`.
    expect(period.columnLabels.currentBudget).toBe(`${period.monthShort} Budget`);
    // currentYearQuarterLabel renders `Q<quarter> <year>`.
    expect(period.currentYearQuarterLabel).toBe(
      `Q${period.quarter} ${period.year}`,
    );
  });
});

// Slice F (2026-09-19) — Alberta ES overtime classifier unit tests.
// Covers §12 daily/weekly boundary cases + §32 cross-period.

import { describe, it, expect } from "vitest";
import { Decimal } from "@/lib/payroll/statutory/decimal-money";
import {
  classifyWorkweek,
  classifyForPayPeriod,
  workweekStartFor,
  surroundingWorkweekBounds,
  type OvertimePolicyConfig,
  type ApprovedTimeEntryLike,
} from "@/lib/payroll/overtime-classifier";

const ALBERTA: OvertimePolicyConfig = {
  kind: "ALBERTA_DEFAULT_ES",
  dailyThresholdHours: new Decimal(8),
  weeklyThresholdHours: new Decimal(44),
  multiplier: new Decimal(1.5),
  workweekStartDow: 0,
};

function utc(y: number, m: number, d: number): Date { return new Date(Date.UTC(y, m - 1, d)); }

function entry(id: string, workDate: Date, hours: number): ApprovedTimeEntryLike {
  return { id, workDate, hours: new Decimal(hours) };
}

describe("Slice F — workweekStartFor", () => {
  // 2026 actual DOWs: Aug 23 Sun, Aug 24 Mon, Aug 29 Sat, Aug 30 Sun, Sep 5 Sat.
  it("Sunday-anchored: 8/23 (Sun) → 8/23", () => {
    expect(workweekStartFor(utc(2026, 8, 23), 0).toISOString().slice(0, 10)).toBe("2026-08-23");
  });
  it("Sunday-anchored: 8/29 (Sat) → 8/23", () => {
    expect(workweekStartFor(utc(2026, 8, 29), 0).toISOString().slice(0, 10)).toBe("2026-08-23");
  });
  it("Monday-anchored: 8/23 (Sun) → 8/17", () => {
    expect(workweekStartFor(utc(2026, 8, 23), 1).toISOString().slice(0, 10)).toBe("2026-08-17");
  });
});

describe("Slice F — single workweek classification (§12 daily/weekly)", () => {
  it("Daily threshold only: 5 days × 10hr → OT 10hr (daily-driven)", () => {
    const w = classifyWorkweek(
      [
        entry("m", utc(2026, 8, 24), 10),
        entry("t", utc(2026, 8, 25), 10),
        entry("w", utc(2026, 8, 26), 10),
        entry("th", utc(2026, 8, 27), 10),
        entry("f", utc(2026, 8, 28), 10),
      ],
      ALBERTA,
    );
    expect(w.totalHours.toFixed(2)).toBe("50.00");
    expect(w.regularHours.toFixed(2)).toBe("40.00"); // 5 × 8
    expect(w.overtimeHours.toFixed(2)).toBe("10.00"); // 5 × 2
  });

  it("Weekly threshold only: 8 hr × 6 days = 48 hr → OT 4 (weekly-driven)", () => {
    const w = classifyWorkweek(
      [
        entry("d1", utc(2026, 8, 24), 8),
        entry("d2", utc(2026, 8, 25), 8),
        entry("d3", utc(2026, 8, 26), 8),
        entry("d4", utc(2026, 8, 27), 8),
        entry("d5", utc(2026, 8, 28), 8),
        entry("d6", utc(2026, 8, 29), 8),
      ],
      ALBERTA,
    );
    expect(w.totalHours.toFixed(2)).toBe("48.00");
    expect(w.overtimeHours.toFixed(2)).toBe("4.00"); // 48 − 44
    expect(w.regularHours.toFixed(2)).toBe("44.00");
    // Extra 4 OT allocated reverse-chronologically to the LAST day (8/29).
    const lastDay = w.days[w.days.length - 1]!;
    expect(lastDay.workDate.toISOString().slice(0, 10)).toBe("2026-08-29");
    expect(lastDay.overtimeHours.toFixed(2)).toBe("4.00");
    expect(lastDay.regularHours.toFixed(2)).toBe("4.00");
  });

  it("Both daily AND weekly: greater-of applies (10 × 5 days + 2 × 1 = 52 hr; daily OT sum = 10, weekly OT = 8; result = 10)", () => {
    const w = classifyWorkweek(
      [
        entry("d1", utc(2026, 8, 24), 10),
        entry("d2", utc(2026, 8, 25), 10),
        entry("d3", utc(2026, 8, 26), 10),
        entry("d4", utc(2026, 8, 27), 10),
        entry("d5", utc(2026, 8, 28), 10),
        entry("d6", utc(2026, 8, 29), 2),
      ],
      ALBERTA,
    );
    expect(w.totalHours.toFixed(2)).toBe("52.00");
    // daily OT sum = 5 × 2 = 10; weekly OT = 52 − 44 = 8; MAX = 10.
    expect(w.overtimeHours.toFixed(2)).toBe("10.00");
    expect(w.regularHours.toFixed(2)).toBe("42.00");
  });

  it("Daily OT sum LESS than weekly OT: greater-of = weekly", () => {
    // 8.5 × 6 days = 51. daily OT = 0.5 × 6 = 3. weekly OT = 51 − 44 = 7. MAX = 7.
    const w = classifyWorkweek(
      [
        entry("d1", utc(2026, 8, 24), 8.5),
        entry("d2", utc(2026, 8, 25), 8.5),
        entry("d3", utc(2026, 8, 26), 8.5),
        entry("d4", utc(2026, 8, 27), 8.5),
        entry("d5", utc(2026, 8, 28), 8.5),
        entry("d6", utc(2026, 8, 29), 8.5),
      ],
      ALBERTA,
    );
    expect(w.overtimeHours.toFixed(2)).toBe("7.00");
    expect(w.regularHours.toFixed(2)).toBe("44.00");
    expect(w.totalHours.toFixed(2)).toBe("51.00");
  });

  it("No OT: 5 days × 8 hr → all regular", () => {
    const w = classifyWorkweek(
      [
        entry("d1", utc(2026, 8, 24), 8),
        entry("d2", utc(2026, 8, 25), 8),
        entry("d3", utc(2026, 8, 26), 8),
        entry("d4", utc(2026, 8, 27), 8),
        entry("d5", utc(2026, 8, 28), 8),
      ],
      ALBERTA,
    );
    expect(w.overtimeHours.toFixed(2)).toBe("0.00");
    expect(w.regularHours.toFixed(2)).toBe("40.00");
  });

  it("Multiple entries in one day sum correctly", () => {
    // 5 hours morning + 5 hours afternoon = 10 hours daily total.
    const w = classifyWorkweek(
      [
        entry("am", utc(2026, 8, 24), 5),
        entry("pm", utc(2026, 8, 24), 5),
      ],
      ALBERTA,
    );
    expect(w.days.length).toBe(1);
    expect(w.days[0]!.regularHours.toFixed(2)).toBe("8.00");
    expect(w.days[0]!.overtimeHours.toFixed(2)).toBe("2.00");
    expect(w.days[0]!.sourceEntryIds.sort()).toEqual(["am", "pm"]);
  });
});

describe("Slice F — cross-period workweek allocation (§32)", () => {
  it("Workweek [Sun 8/30 → Sun 9/6): OT allocated correctly across SM boundary", () => {
    // Setup: 10 hrs × 7 days = 70 hrs. daily OT sum = 14. weekly = 26. MAX = 26.
    // Extra OT (26 − 14) = 12 allocated reverse-chronologically to
    // 9/5 (Sat): 8 reg → all OT (now reg=0, OT=10). Extra 4 left.
    // 9/4 (Fri): 8 reg → 4 reg + 4 more OT (now reg=4, OT=6).
    // Per-day final:
    //   8/30 (Sun): 8 reg + 2 OT
    //   8/31 (Mon): 8 reg + 2 OT
    //   9/1  (Tue): 8 reg + 2 OT
    //   9/2  (Wed): 8 reg + 2 OT
    //   9/3  (Thu): 8 reg + 2 OT
    //   9/4  (Fri): 4 reg + 6 OT
    //   9/5  (Sat): 0 reg + 10 OT
    // Total workweek: 44 reg + 26 OT.
    // Pay period 1 [Aug 16, Sep 1) contains 8/30, 8/31 → 16 reg + 4 OT.
    // Pay period 2 [Sep 1, Sep 16) contains 9/1..9/5 → 28 reg + 22 OT.
    const entries: ApprovedTimeEntryLike[] = [
      entry("d1", utc(2026, 8, 30), 10),
      entry("d2", utc(2026, 8, 31), 10),
      entry("d3", utc(2026, 9, 1),  10),
      entry("d4", utc(2026, 9, 2),  10),
      entry("d5", utc(2026, 9, 3),  10),
      entry("d6", utc(2026, 9, 4),  10),
      entry("d7", utc(2026, 9, 5),  10),
    ];
    const period1 = classifyForPayPeriod(entries, utc(2026, 8, 16), utc(2026, 9, 1), ALBERTA);
    const period2 = classifyForPayPeriod(entries, utc(2026, 9, 1), utc(2026, 9, 16), ALBERTA);
    expect(period1.regularHours.toFixed(2)).toBe("16.00");
    expect(period1.overtimeHours.toFixed(2)).toBe("4.00");
    expect(period2.regularHours.toFixed(2)).toBe("28.00");
    expect(period2.overtimeHours.toFixed(2)).toBe("22.00");
    // Total across both periods sums to workweek.
    expect(period1.regularHours.plus(period2.regularHours).toFixed(2)).toBe("44.00");
    expect(period1.overtimeHours.plus(period2.overtimeHours).toFixed(2)).toBe("26.00");
  });
});

describe("Slice F — surroundingWorkweekBounds", () => {
  it("Sep 16 → Oct 1 SM period → 9/13 (Sun start of 9/16's week) to 10/4 (end of 9/30's week)", () => {
    const b = surroundingWorkweekBounds(utc(2026, 9, 16), utc(2026, 10, 1), 0);
    expect(b.fetchStart.toISOString().slice(0, 10)).toBe("2026-09-13");
    expect(b.fetchEnd.toISOString().slice(0, 10)).toBe("2026-10-04");
  });
});

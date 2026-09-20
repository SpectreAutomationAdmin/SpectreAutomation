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
};
const SUN = 0;
const MON = 1;

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
      SUN,
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
      SUN,
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
      SUN,
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
      SUN,
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
      SUN,
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
      SUN,
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
    const period1 = classifyForPayPeriod(entries, utc(2026, 8, 16), utc(2026, 9, 1), ALBERTA, SUN);
    const period2 = classifyForPayPeriod(entries, utc(2026, 9, 1), utc(2026, 9, 16), ALBERTA, SUN);
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

// Slice F workweek-closeout (2026-09-19) — proving the classifier
// consumes the workweek boundary as a parameter and does NOT bake
// Sunday into the statutory Alberta ES rule set.
describe("Slice F workweek-closeout — non-Sunday workweeks", () => {
  it("Monday-anchored: same seven days of 10hr each → same 40 reg + 10 OT (workweek shape unchanged)", () => {
    // Under a Monday-anchored workweek, Mon-Fri Aug 24-28 is a
    // FULL workweek [Mon 8/24 → Mon 8/31). Alberta ES 8/44 rule
    // yields 40 reg + 10 OT regardless of which day starts the week —
    // the rule is 8h/day + 44h/week greater-of.
    const w = classifyWorkweek(
      [
        entry("m",  utc(2026, 8, 24), 10),
        entry("t",  utc(2026, 8, 25), 10),
        entry("w",  utc(2026, 8, 26), 10),
        entry("th", utc(2026, 8, 27), 10),
        entry("f",  utc(2026, 8, 28), 10),
      ],
      ALBERTA,
      MON,
    );
    expect(w.workweekStart.toISOString().slice(0, 10)).toBe("2026-08-24");
    expect(w.regularHours.toFixed(2)).toBe("40.00");
    expect(w.overtimeHours.toFixed(2)).toBe("10.00");
  });

  it("Sunday vs Monday: workweek boundary changes the workweek partition + period-2 split", () => {
    // 12hr each day, Sun 8/30 through Sat 9/5. 84h across 7 days.
    // Under SUNDAY-anchored workweek: one workweek [Sun 8/30 → Sun 9/6).
    //   84h/week; daily OT = 4×7 = 28; weekly OT = 84−44 = 40; MAX = 40.
    //   Extra 12 allocated reverse-chrono to 9/5 (fully → 12 OT) then 9/4 (+4 OT).
    //   Period 2 [Sep 1, Sep 16) contains 9/1..9/5 = 5 days.
    //   Per-day: 9/1..9/3 = 8 reg + 4 OT each; 9/4 = 4 reg + 8 OT; 9/5 = 0 reg + 12 OT.
    //   Period 2 = (8+8+8+4+0) reg + (4+4+4+8+12) OT = 28 reg + 32 OT.
    // Under MONDAY-anchored workweek: 8/30 (Sun) in prev workweek [Mon 8/24, Mon 8/31),
    //   which contains ONLY 8/30 → 8 reg + 4 OT.
    //   Workweek [Mon 8/31, Mon 9/7) contains 8/31..9/5 = 72h.
    //   Daily OT = 24; weekly OT = 28; MAX = 28. Extra 4 → 9/5 (4 reg + 8 OT).
    //   Period 2 contains 9/1..9/5 = 5 days.
    //   Per-day: 9/1..9/4 = 8 reg + 4 OT each; 9/5 = 4 reg + 8 OT.
    //   Period 2 = (8×4 + 4) reg + (4×4 + 8) OT = 36 reg + 24 OT.
    const entries: ApprovedTimeEntryLike[] = [
      entry("d1", utc(2026, 8, 30), 12),
      entry("d2", utc(2026, 8, 31), 12),
      entry("d3", utc(2026, 9, 1),  12),
      entry("d4", utc(2026, 9, 2),  12),
      entry("d5", utc(2026, 9, 3),  12),
      entry("d6", utc(2026, 9, 4),  12),
      entry("d7", utc(2026, 9, 5),  12),
    ];
    const sundayP2 = classifyForPayPeriod(entries, utc(2026, 9, 1), utc(2026, 9, 16), ALBERTA, SUN);
    const mondayP2 = classifyForPayPeriod(entries, utc(2026, 9, 1), utc(2026, 9, 16), ALBERTA, MON);
    // Total hours in period 2 is 60 either way (9/1..9/5 = 5 × 12).
    expect(sundayP2.regularHours.plus(sundayP2.overtimeHours).toFixed(2)).toBe("60.00");
    expect(mondayP2.regularHours.plus(mondayP2.overtimeHours).toFixed(2)).toBe("60.00");
    // Sunday P2: 28 reg + 32 OT. Monday P2: 36 reg + 24 OT. Split differs.
    expect(sundayP2.regularHours.toFixed(2)).toBe("28.00");
    expect(sundayP2.overtimeHours.toFixed(2)).toBe("32.00");
    expect(mondayP2.regularHours.toFixed(2)).toBe("36.00");
    expect(mondayP2.overtimeHours.toFixed(2)).toBe("24.00");
    expect(sundayP2.regularHours.toFixed(2)).not.toBe(mondayP2.regularHours.toFixed(2));
  });

  it("Cross-period Monday-anchored: workweek [Mon 8/31 → Mon 9/7) split across SM periods", () => {
    // Mon 8/31 falls in period 1 [Aug 16, Sep 1). Tue 9/1 through Sat 9/5 fall
    // in period 2 [Sep 1, Sep 16). Total workweek = 60h; daily OT = 12; weekly
    // OT = 60 - 44 = 16; MAX = 16. Total 44 reg + 16 OT.
    // Reverse-chronological extra-OT: 16 total OT − 12 daily = 4 extra weekly OT.
    //   9/5 (Sat) 8 reg → all OT (10 OT), 4 extra remaining.
    //   9/4 (Fri) 8 reg → 4 reg + 4 more OT (now 4 reg + 6 OT).
    //   Days final:
    //     8/31 Mon: 8 reg + 2 OT
    //     9/1  Tue: 8 reg + 2 OT
    //     9/2  Wed: 8 reg + 2 OT
    //     9/3  Thu: 8 reg + 2 OT
    //     9/4  Fri: 4 reg + 6 OT
    //     9/5  Sat: 0 reg + 10 OT
    //   Period 1 [Aug 16, Sep 1) contains only 8/31 → 8 reg + 2 OT.
    //   Period 2 [Sep 1, Sep 16) contains 9/1..9/5 → 28 reg + 22 OT.
    const entries: ApprovedTimeEntryLike[] = [
      entry("d1", utc(2026, 8, 31), 10),
      entry("d2", utc(2026, 9, 1),  10),
      entry("d3", utc(2026, 9, 2),  10),
      entry("d4", utc(2026, 9, 3),  10),
      entry("d5", utc(2026, 9, 4),  10),
      entry("d6", utc(2026, 9, 5),  10),
    ];
    const p1 = classifyForPayPeriod(entries, utc(2026, 8, 16), utc(2026, 9, 1), ALBERTA, MON);
    const p2 = classifyForPayPeriod(entries, utc(2026, 9, 1), utc(2026, 9, 16), ALBERTA, MON);
    // Correcting the walk:
    //   6 × 10 = 60h. daily OT = 12. weekly OT = 16. MAX = 16.
    //   Extra weekly = 16 − 12 = 4 → 9/5 reverse-chrono: 8 reg → 4 reg + 4 more OT.
    //   Days:
    //     8/31 Mon: 8 reg + 2 OT   (period 1)
    //     9/1  Tue: 8 reg + 2 OT   (period 2)
    //     9/2  Wed: 8 reg + 2 OT   (period 2)
    //     9/3  Thu: 8 reg + 2 OT   (period 2)
    //     9/4  Fri: 8 reg + 2 OT   (period 2)
    //     9/5  Sat: 4 reg + 6 OT   (period 2)
    //   Period 1 = 8 reg + 2 OT. Period 2 = 36 reg + 14 OT. Total 44 reg + 16 OT.
    expect(p1.regularHours.toFixed(2)).toBe("8.00");
    expect(p1.overtimeHours.toFixed(2)).toBe("2.00");
    expect(p2.regularHours.toFixed(2)).toBe("36.00");
    expect(p2.overtimeHours.toFixed(2)).toBe("14.00");
    expect(p1.regularHours.plus(p2.regularHours).toFixed(2)).toBe("44.00");
    expect(p1.overtimeHours.plus(p2.overtimeHours).toFixed(2)).toBe("16.00");
  });
});

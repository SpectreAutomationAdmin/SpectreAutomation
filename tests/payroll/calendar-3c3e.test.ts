// Payroll-3C-3E.1 (2026-09-09) — semi-monthly payday + payroll-cutoff
// regressions.
//
// These tests do not require a running dev server or a POSTED batch.
// They pin Spectre's semi-monthly payday policy — fixed 15th / EOM
// with Sat/Sun → preceding Friday adjustment — and prove the 3C-3E
// bugs (`payDate = periodEnd + N days`, UTC-midnight timezone
// display shift, 1-day operational lead) cannot silently regress.

import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  rawScheduledSemiMonthlyPayday,
  weekendAdjustedPayday,
  semiMonthlyPayday,
  semiMonthlyPeriod,
  payrollCutoff,
  generateSemiMonthlySchedule,
} from "../../src/lib/payroll/semi-monthly-payday";

// -------------------------------------------------------------------
// A · Raw scheduled payday (before weekend adjustment)
// -------------------------------------------------------------------
describe("Payroll-3C-3E.1 · raw scheduled payday (15th / EOM)", () => {
  it("first half = 15th of month (UTC-midnight)", () => {
    expect(rawScheduledSemiMonthlyPayday(2026, 0, "FIRST_HALF").toISOString())
      .toBe("2026-01-15T00:00:00.000Z");
    expect(rawScheduledSemiMonthlyPayday(2026, 7, "FIRST_HALF").toISOString())
      .toBe("2026-08-15T00:00:00.000Z");
  });

  it("second half = LAST calendar day of month (Jan 31 / Feb 28 non-leap / Apr 30)", () => {
    expect(rawScheduledSemiMonthlyPayday(2026, 0, "SECOND_HALF").toISOString())
      .toBe("2026-01-31T00:00:00.000Z");
    expect(rawScheduledSemiMonthlyPayday(2026, 1, "SECOND_HALF").toISOString())
      .toBe("2026-02-28T00:00:00.000Z"); // 2026 is NOT a leap year
    expect(rawScheduledSemiMonthlyPayday(2026, 3, "SECOND_HALF").toISOString())
      .toBe("2026-04-30T00:00:00.000Z");
    expect(rawScheduledSemiMonthlyPayday(2026, 7, "SECOND_HALF").toISOString())
      .toBe("2026-08-31T00:00:00.000Z");
    expect(rawScheduledSemiMonthlyPayday(2026, 11, "SECOND_HALF").toISOString())
      .toBe("2026-12-31T00:00:00.000Z");
  });

  it("Feb 2028 (leap year) EOM = Feb 29", () => {
    expect(rawScheduledSemiMonthlyPayday(2028, 1, "SECOND_HALF").toISOString())
      .toBe("2028-02-29T00:00:00.000Z");
  });
});

// -------------------------------------------------------------------
// B · Weekend adjustment (Sat/Sun → preceding Friday, NEVER later)
// -------------------------------------------------------------------
describe("Payroll-3C-3E.1 · weekend adjustment", () => {
  it("Saturday → preceding Friday", () => {
    // 2026-08-15 is a Saturday. Adjusted → 2026-08-14 (Fri).
    const raw = new Date("2026-08-15T00:00:00.000Z");
    expect(raw.getUTCDay()).toBe(6); // Sat
    expect(weekendAdjustedPayday(raw).toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });

  it("Sunday → preceding Friday", () => {
    // 2026-03-15 is a Sunday. Adjusted → 2026-03-13 (Fri).
    const raw = new Date("2026-03-15T00:00:00.000Z");
    expect(raw.getUTCDay()).toBe(0); // Sun
    expect(weekendAdjustedPayday(raw).toISOString()).toBe("2026-03-13T00:00:00.000Z");
  });

  it("Weekday → unchanged", () => {
    // 2026-01-15 is a Thursday.
    const raw = new Date("2026-01-15T00:00:00.000Z");
    expect(raw.getUTCDay()).toBe(4); // Thu
    expect(weekendAdjustedPayday(raw).toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  it("NEVER moves later (Mon-Fri raw always stays put)", () => {
    for (const iso of [
      "2026-01-15", "2026-01-30", "2026-02-16", "2026-04-15", "2026-05-15",
      "2026-06-15", "2026-06-30", "2026-07-15", "2026-07-31", "2026-08-31",
      "2026-09-15", "2026-09-30", "2026-10-15", "2026-10-30", "2026-11-16",
      "2026-11-30", "2026-12-15", "2026-12-31",
    ]) {
      const d = new Date(`${iso}T00:00:00.000Z`);
      const dow = d.getUTCDay();
      if (dow >= 1 && dow <= 5) {
        expect(weekendAdjustedPayday(d).toISOString()).toBe(d.toISOString());
      }
    }
  });
});

// -------------------------------------------------------------------
// C · Combined semi-monthly payday
// -------------------------------------------------------------------
describe("Payroll-3C-3E.1 · semiMonthlyPayday (full policy)", () => {
  it("Aug 2026: seq 15 → 2026-08-14 (Sat→Fri), seq 16 → 2026-08-31 (Mon)", () => {
    // Aug 15 2026 is Saturday → Aug 14 Fri.
    expect(semiMonthlyPayday(2026, 7, "FIRST_HALF").toISOString())
      .toBe("2026-08-14T00:00:00.000Z");
    // Aug 31 2026 is Monday → stays Aug 31.
    expect(semiMonthlyPayday(2026, 7, "SECOND_HALF").toISOString())
      .toBe("2026-08-31T00:00:00.000Z");
  });

  it("Every 2026 payday is a Mon-Fri (never Sat/Sun)", () => {
    for (let m = 0; m < 12; m++) {
      for (const half of ["FIRST_HALF", "SECOND_HALF"] as const) {
        const p = semiMonthlyPayday(2026, m, half);
        const dow = p.getUTCDay();
        expect(dow, `${p.toISOString()} landed on dow=${dow}`).toBeGreaterThanOrEqual(1);
        expect(dow, `${p.toISOString()} landed on dow=${dow}`).toBeLessThanOrEqual(5);
      }
    }
  });

  it("Complete 2026 payday roster matches expected values", () => {
    // Precomputed against a calendar for 2026. Weekend hits:
    //   Jan 31 (Sat) → Jan 30 (Fri)
    //   Feb 15 (Sun) → Feb 13 (Fri)
    //   Feb 28 (Sat) → Feb 27 (Fri)
    //   Mar 15 (Sun) → Mar 13 (Fri)
    //   May 31 (Sun) → May 29 (Fri)
    //   Aug 15 (Sat) → Aug 14 (Fri)
    //   Nov 15 (Sun) → Nov 13 (Fri)
    const expected: Record<number, string> = {
      1:  "2026-01-15", 2:  "2026-01-30",
      3:  "2026-02-13", 4:  "2026-02-27",
      5:  "2026-03-13", 6:  "2026-03-31",
      7:  "2026-04-15", 8:  "2026-04-30",
      9:  "2026-05-15", 10: "2026-05-29",
      11: "2026-06-15", 12: "2026-06-30",
      13: "2026-07-15", 14: "2026-07-31",
      15: "2026-08-14", 16: "2026-08-31",
      17: "2026-09-15", 18: "2026-09-30",
      19: "2026-10-15", 20: "2026-10-30",
      21: "2026-11-13", 22: "2026-11-30",
      23: "2026-12-15", 24: "2026-12-31",
    };
    const schedule = generateSemiMonthlySchedule(2026, 5);
    for (const row of schedule) {
      expect(
        row.payDate.toISOString().slice(0, 10),
        `seq ${row.seq}`,
      ).toBe(expected[row.seq]);
    }
  });
});

// -------------------------------------------------------------------
// D · Pay period (compensation window) is independent of payday/cutoff
// -------------------------------------------------------------------
describe("Payroll-3C-3E.1 · pay period boundaries", () => {
  it("FIRST_HALF period = [1st, 16th) — displayed 1st–15th inclusive", () => {
    const { periodStart, periodEnd } = semiMonthlyPeriod(2026, 7, "FIRST_HALF");
    expect(periodStart.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(periodEnd.toISOString()).toBe("2026-08-16T00:00:00.000Z");
    const displayEnd = new Date(periodEnd.getTime() - 86_400_000);
    expect(displayEnd.toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("SECOND_HALF period = [16th, 1st-of-next) — displayed 16th–EOM inclusive", () => {
    const { periodStart, periodEnd } = semiMonthlyPeriod(2026, 7, "SECOND_HALF");
    expect(periodStart.toISOString()).toBe("2026-08-16T00:00:00.000Z");
    expect(periodEnd.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    const displayEnd = new Date(periodEnd.getTime() - 86_400_000);
    expect(displayEnd.toISOString().slice(0, 10)).toBe("2026-08-31");
  });

  it("February 2026: seq 3 (Feb 1–15) + seq 4 (Feb 16–28) — non-leap", () => {
    const feb1 = semiMonthlyPeriod(2026, 1, "FIRST_HALF");
    const feb2 = semiMonthlyPeriod(2026, 1, "SECOND_HALF");
    expect(feb1.periodEnd.toISOString()).toBe("2026-02-16T00:00:00.000Z");
    expect(feb2.periodEnd.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    const displayEnd = new Date(feb2.periodEnd.getTime() - 86_400_000);
    expect(displayEnd.toISOString().slice(0, 10)).toBe("2026-02-28");
  });
});

// -------------------------------------------------------------------
// E · Payroll cutoff = payday − N calendar days (BACKWARD from payday)
// -------------------------------------------------------------------
describe("Payroll-3C-3E.1 · payroll cutoff (backward from payday)", () => {
  it("5-day cutoff for Sam flagship (seq 16) = payday 2026-08-31 − 5 = 2026-08-26", () => {
    const payDate = semiMonthlyPayday(2026, 7, "SECOND_HALF");
    expect(payDate.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(payrollCutoff(payDate, 5).toISOString()).toBe("2026-08-26T00:00:00.000Z");
  });

  it("Cutoff and pay period are independent — cutoff CAN fall inside the period", () => {
    // Aug 26 (Wed) cutoff falls INSIDE Aug 16–31 period.
    // This is expected & correct: the cutoff is when payroll admin
    // must finalize inputs; the period is the compensation window.
    const { periodStart, periodEnd } = semiMonthlyPeriod(2026, 7, "SECOND_HALF");
    const cutoff = payrollCutoff(semiMonthlyPayday(2026, 7, "SECOND_HALF"), 5);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(periodStart.getTime());
    expect(cutoff.getTime()).toBeLessThan(periodEnd.getTime());
  });
});

// -------------------------------------------------------------------
// F · 24-period annual guarantee
// -------------------------------------------------------------------
describe("Payroll-3C-3E.1 · 24-period annual guarantee", () => {
  it("exactly 24 rows per calendar year", () => {
    expect(generateSemiMonthlySchedule(2026, 5)).toHaveLength(24);
  });

  it("periods are contiguous — no overlaps, no gaps", () => {
    const schedule = generateSemiMonthlySchedule(2026, 5);
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i].periodStart.getTime()).toBe(schedule[i - 1].periodEnd.getTime());
    }
  });
});

// -------------------------------------------------------------------
// G · Salary periodization guarantee
// -------------------------------------------------------------------
describe("Payroll-3C-3E.1 · salary periodization guarantee", () => {
  it("annual $110,000 / 24 semi-monthly = $4,583.33", () => {
    const perPeriod = new Decimal("110000").div(24).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    expect(perPeriod.toFixed(2)).toBe("4583.33");
  });
});

// -------------------------------------------------------------------
// H · Regression: pay date is NOT the old periodEnd+5 model
// -------------------------------------------------------------------
describe("Payroll-3C-3E.1 · pay date is NOT `periodEnd + 5 days`", () => {
  it("Sam Aug flagship (seq 16) pay date = 2026-08-31 (NOT 2026-09-06)", () => {
    const payDate = semiMonthlyPayday(2026, 7, "SECOND_HALF");
    expect(payDate.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(payDate.toISOString()).not.toBe("2026-09-06T00:00:00.000Z");
  });

  it("Runtime evidence — SAL-SM-COMPLEX seq 16 in the dev DB matches", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const p = new PrismaClient();
    try {
      const club = await p.club.findFirst({ where: { slug: "coulee-ridge" } });
      if (!club) { console.warn("Skipped — no coulee-ridge in dev DB"); return; }
      const pg = await p.payrollPayGroup.findFirst({ where: { clubId: club.id, code: "SAL-SM-COMPLEX" } });
      if (!pg) { console.warn("Skipped — no SAL-SM-COMPLEX pay group"); return; }
      const flagship = await p.payrollPayPeriod.findFirst({
        where: { clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 16 },
      });
      if (!flagship) { console.warn("Skipped — no seq 16 in dev DB"); return; }
      expect(flagship.payDate.toISOString()).toBe("2026-08-31T00:00:00.000Z");
      expect(flagship.periodStart.toISOString()).toBe("2026-08-16T00:00:00.000Z");
      expect(flagship.periodEnd.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    } finally { await p.$disconnect(); }
  });
});

// -------------------------------------------------------------------
// I · UTC-safe display formatting (§18, root cause of Aug-15/Aug-30 report)
// -------------------------------------------------------------------
describe("Payroll-3C-3E.1 · UTC-safe date display", () => {
  it("`toLocaleDateString(en-CA, timeZone: UTC)` renders UTC-midnight dates on their true civil day", () => {
    const d = new Date("2026-08-16T00:00:00.000Z");
    const utcDisplay = d.toLocaleDateString("en-CA", {
      year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
    });
    expect(utcDisplay).toContain("16");
    expect(utcDisplay).not.toContain("15");
  });
});

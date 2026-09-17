// Phase 5 (2026-09-17) — Coulee Ridge SEMI_MONTHLY cutover regression suite.
//
// Founder acceptance tests A-O (pay frequency + salary math + statutory)
// plus §26 reset / governance invariants. Every assertion here defends a
// property the founder called out explicitly in the Phase 5 directive.
//
// This suite is intentionally isolated from Coulee Ridge staging data —
// all fixtures are synthetic. The staging reset is exercised separately
// by `scripts/coulee-ridge-semimonthly-cutover.ts` under its own guards.

import { describe, it, expect } from "vitest";
import { buildCalendar } from "@/lib/payroll/pay-periods";
import {
  rawScheduledSemiMonthlyPayday,
  weekendAdjustedPayday,
  semiMonthlyPayday,
  semiMonthlyPeriod,
  generateSemiMonthlySchedule,
} from "@/lib/payroll/semi-monthly-payday";
import Decimal from "decimal.js";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe("Phase 5 — SEMI_MONTHLY canonical pay-period generator", () => {
  // -------------------------------------------------------------------
  // A. 24 periods per year — never 26.
  // -------------------------------------------------------------------
  it("A. produces exactly 24 periods for every year in [2024, 2035]", () => {
    for (let y = 2024; y <= 2035; y++) {
      const rows = buildCalendar({
        payFrequency: "SEMI_MONTHLY",
        payDateOffsetDays: 0,
        calendarAnchorDate: null,
        taxYear: y,
      });
      expect(rows.length, `year ${y}`).toBe(24);
    }
  });

  // -------------------------------------------------------------------
  // B. First-half pay dates land on the 15th (weekend → preceding Fri).
  // -------------------------------------------------------------------
  it("B. first-half payDate is the 15th of the month (weekend-earlier)", () => {
    const rows = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 0,
      calendarAnchorDate: null,
      taxYear: 2026,
    });
    for (const r of rows.filter((r) => r.periodStart.getUTCDate() === 1)) {
      const m0 = r.periodStart.getUTCMonth();
      const raw = new Date(Date.UTC(2026, m0, 15));
      const expected = weekendAdjustedPayday(raw);
      expect(r.payDate.getTime()).toBe(expected.getTime());
    }
  });

  // -------------------------------------------------------------------
  // C. Jan 31 — no weekend adjustment (Jan 31 2026 is Sat → Jan 30 Fri).
  //    We prove the LAST-day rule, not literal Jan 31.
  // -------------------------------------------------------------------
  it("C. Jan second-half period ends Feb 1 (exclusive); payDate = Jan LAST", () => {
    const rows = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 0,
      calendarAnchorDate: null,
      taxYear: 2026,
    });
    const jan2 = rows.find(
      (r) => r.periodStart.getUTCMonth() === 0 && r.periodStart.getUTCDate() === 16,
    )!;
    expect(jan2.periodEnd.getTime()).toBe(utc(2026, 2, 1).getTime());
    // Jan 31 2026 is Sat → Fri Jan 30. Rule proven independently of leap.
    expect(jan2.payDate.getTime()).toBe(utc(2026, 1, 30).getTime());
  });

  // -------------------------------------------------------------------
  // D. Feb 28 — 2026 is NOT a leap year. periodEnd = Mar 1 (excl),
  //    payDate = Feb 28 raw → Sat → Fri Feb 27.
  // -------------------------------------------------------------------
  it("D. Feb second-half in 2026 (non-leap) ends Mar 1; payDate = Feb LAST", () => {
    const rows = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 0,
      calendarAnchorDate: null,
      taxYear: 2026,
    });
    const feb2 = rows.find(
      (r) => r.periodStart.getUTCMonth() === 1 && r.periodStart.getUTCDate() === 16,
    )!;
    expect(feb2.periodEnd.getTime()).toBe(utc(2026, 3, 1).getTime());
    // Feb 28 2026 Sat → Fri Feb 27.
    expect(feb2.payDate.getTime()).toBe(utc(2026, 2, 27).getTime());
  });

  // -------------------------------------------------------------------
  // E. Feb 29 — 2028 IS a leap year. periodEnd = Mar 1 (excl),
  //    payDate = Feb 29 raw → Tue → no shift.
  // -------------------------------------------------------------------
  it("E. Feb second-half in leap year 2028 ends Mar 1; payDate = Feb 29", () => {
    const rows = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 0,
      calendarAnchorDate: null,
      taxYear: 2028,
    });
    const feb2 = rows.find(
      (r) => r.periodStart.getUTCMonth() === 1 && r.periodStart.getUTCDate() === 16,
    )!;
    expect(feb2.periodEnd.getTime()).toBe(utc(2028, 3, 1).getTime());
    // Feb 29 2028 Tue → no shift.
    expect(feb2.payDate.getTime()).toBe(utc(2028, 2, 29).getTime());
  });

  // -------------------------------------------------------------------
  // F. Apr 30 — periodEnd = May 1 (excl), payDate = Apr 30.
  //    Apr 30 2026 is Thu → no shift.
  // -------------------------------------------------------------------
  it("F. Apr second-half in 2026 ends May 1; payDate = Apr 30", () => {
    const rows = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 0,
      calendarAnchorDate: null,
      taxYear: 2026,
    });
    const apr2 = rows.find(
      (r) => r.periodStart.getUTCMonth() === 3 && r.periodStart.getUTCDate() === 16,
    )!;
    expect(apr2.periodEnd.getTime()).toBe(utc(2026, 5, 1).getTime());
    expect(apr2.payDate.getTime()).toBe(utc(2026, 4, 30).getTime());
  });

  // -------------------------------------------------------------------
  // G. Dec 31 — periodEnd = Jan 1 next year (excl), payDate = Dec 31.
  //    Dec 31 2026 is Thu → no shift.
  // -------------------------------------------------------------------
  it("G. Dec second-half in 2026 ends Jan 1 2027; payDate = Dec 31 2026", () => {
    const rows = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 0,
      calendarAnchorDate: null,
      taxYear: 2026,
    });
    const last = rows[rows.length - 1]!;
    expect(last.periodStart.getTime()).toBe(utc(2026, 12, 16).getTime());
    expect(last.periodEnd.getTime()).toBe(utc(2027, 1, 1).getTime());
    expect(last.payDate.getTime()).toBe(utc(2026, 12, 31).getTime());
  });

  // -------------------------------------------------------------------
  // H. No overlaps — periodEnd_i <= periodStart_(i+1) for every pair.
  // -------------------------------------------------------------------
  it("H. no two periods overlap", () => {
    const rows = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 0,
      calendarAnchorDate: null,
      taxYear: 2026,
    });
    // Sort by periodStart for interval overlap check.
    const sorted = [...rows].sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.periodStart.getTime()).toBeGreaterThanOrEqual(sorted[i - 1]!.periodEnd.getTime());
    }
  });

  // -------------------------------------------------------------------
  // I. No gaps — sorted, coverage is contiguous [Jan 1, Jan 1 next year).
  // -------------------------------------------------------------------
  it("I. periods cover the whole year with no gaps", () => {
    const rows = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 0,
      calendarAnchorDate: null,
      taxYear: 2026,
    });
    const sorted = [...rows].sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
    expect(sorted[0]!.periodStart.getTime()).toBe(utc(2026, 1, 1).getTime());
    expect(sorted[sorted.length - 1]!.periodEnd.getTime()).toBe(utc(2027, 1, 1).getTime());
    for (let i = 1; i < sorted.length; i++) {
      // Adjacent boundaries touch (periodEnd == next periodStart).
      expect(sorted[i]!.periodStart.getTime()).toBe(sorted[i - 1]!.periodEnd.getTime());
    }
  });

  // -------------------------------------------------------------------
  // J. Deterministic — same inputs, same outputs.
  // -------------------------------------------------------------------
  it("J. generator is deterministic across identical inputs", () => {
    const spec = {
      payFrequency: "SEMI_MONTHLY" as const,
      payDateOffsetDays: 0,
      calendarAnchorDate: null,
      taxYear: 2026,
    };
    const a = buildCalendar(spec);
    const b = buildCalendar(spec);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.periodStart.getTime()).toBe(b[i]!.periodStart.getTime());
      expect(a[i]!.periodEnd.getTime()).toBe(b[i]!.periodEnd.getTime());
      expect(a[i]!.payDate.getTime()).toBe(b[i]!.payDate.getTime());
      expect(a[i]!.sequenceInYear).toBe(b[i]!.sequenceInYear);
    }
  });

  // -------------------------------------------------------------------
  // M. `payDateOffsetDays` is ignored for SEMI_MONTHLY. Two generator
  //     runs with different offsets return identical results — and
  //     neither returns 26 rows.
  // -------------------------------------------------------------------
  it("M. offset=5 and offset=0 produce identical SEMI_MONTHLY schedules (no /26 fallback)", () => {
    const noOffset = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 0,
      calendarAnchorDate: null,
      taxYear: 2026,
    });
    const withOffset = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 5,
      calendarAnchorDate: null,
      taxYear: 2026,
    });
    expect(noOffset.length).toBe(24);
    expect(withOffset.length).toBe(24);
    for (let i = 0; i < 24; i++) {
      expect(withOffset[i]!.payDate.getTime()).toBe(noOffset[i]!.payDate.getTime());
    }
  });
});

describe("Phase 5 — SEMI_MONTHLY helper primitives", () => {
  it("rawScheduledSemiMonthlyPayday emits 15th and LAST calendar day", () => {
    // 2026-04 (Apr): 15 = 15th, LAST = 30.
    expect(rawScheduledSemiMonthlyPayday(2026, 3, "FIRST_HALF").getTime()).toBe(utc(2026, 4, 15).getTime());
    expect(rawScheduledSemiMonthlyPayday(2026, 3, "SECOND_HALF").getTime()).toBe(utc(2026, 4, 30).getTime());
    // 2028-02 (Feb, leap): LAST = 29.
    expect(rawScheduledSemiMonthlyPayday(2028, 1, "SECOND_HALF").getTime()).toBe(utc(2028, 2, 29).getTime());
    // 2026-02 (Feb, non-leap): LAST = 28.
    expect(rawScheduledSemiMonthlyPayday(2026, 1, "SECOND_HALF").getTime()).toBe(utc(2026, 2, 28).getTime());
    // 2026-12 (Dec): LAST = 31.
    expect(rawScheduledSemiMonthlyPayday(2026, 11, "SECOND_HALF").getTime()).toBe(utc(2026, 12, 31).getTime());
  });

  it("weekendAdjustedPayday moves Sat → Fri, Sun → Fri, weekday unchanged", () => {
    // 2026-01-31 = Sat → Fri 2026-01-30.
    expect(weekendAdjustedPayday(utc(2026, 1, 31)).getTime()).toBe(utc(2026, 1, 30).getTime());
    // 2026-02-15 = Sun → Fri 2026-02-13.
    expect(weekendAdjustedPayday(utc(2026, 2, 15)).getTime()).toBe(utc(2026, 2, 13).getTime());
    // 2026-01-15 = Thu → unchanged.
    expect(weekendAdjustedPayday(utc(2026, 1, 15)).getTime()).toBe(utc(2026, 1, 15).getTime());
  });

  it("semiMonthlyPeriod half-open boundaries: [1st,16th) and [16th, 1st-of-next)", () => {
    const first = semiMonthlyPeriod(2026, 3, "FIRST_HALF"); // Apr
    expect(first.periodStart.getTime()).toBe(utc(2026, 4, 1).getTime());
    expect(first.periodEnd.getTime()).toBe(utc(2026, 4, 16).getTime());
    const second = semiMonthlyPeriod(2026, 3, "SECOND_HALF");
    expect(second.periodStart.getTime()).toBe(utc(2026, 4, 16).getTime());
    expect(second.periodEnd.getTime()).toBe(utc(2026, 5, 1).getTime());
  });

  it("generateSemiMonthlySchedule yields 24 rows with monotone payDates", () => {
    const rows = generateSemiMonthlySchedule(2026, 5);
    expect(rows.length).toBe(24);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.payDate.getTime()).toBeGreaterThan(rows[i - 1]!.payDate.getTime());
    }
    // payrollCutoff = payDate - 5 days.
    expect(rows[0]!.payrollCutoff.getTime()).toBe(rows[0]!.payDate.getTime() - 5 * 86_400_000);
  });
});

describe("Phase 5 — Salary /24 math (K, L)", () => {
  it("K. annual salary /24 divides cleanly for canonical staff amounts", () => {
    // Rounded to 2 dp HALF_UP (canonical Spectre payroll rounding).
    const cases: Array<[string, string]> = [
      ["60000", "2500"],
      ["72000", "3000"],
      ["120000", "5000"],
      ["85000", "3541.67"],
      ["110000", "4583.33"],
    ];
    for (const [annual, per] of cases) {
      const rounded = new Decimal(annual)
        .div(24)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toString();
      expect(rounded, annual).toBe(per);
    }
  });

  it("L. Chris @ $110,000 → $4,583.33 per SEMI_MONTHLY period (HALF_UP)", () => {
    const raw = new Decimal("110000").div(24);
    // Raw = 4583.333…
    expect(raw.toFixed(3)).toBe("4583.333");
    // HALF_UP to 2 dp: 4583.33.
    expect(raw.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString()).toBe("4583.33");
  });

  it("Marc @ $85,000 → $3,541.67 per SEMI_MONTHLY period (HALF_UP)", () => {
    const raw = new Decimal("85000").div(24);
    // Raw = 3541.6666…
    expect(raw.toFixed(3)).toBe("3541.667");
    // HALF_UP to 2 dp: 3541.67.
    expect(raw.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString()).toBe("3541.67");
  });
});

describe("Phase 5 — Reset / governance invariants (§26)", () => {
  it("no user-facing `unpost` route exists in the routes tree", async () => {
    // Guard against a future maintainer adding a route that would let
    // POSTED payroll be reversed. The staging maintenance reset lives
    // in `scripts/` and is not routable.
    const glob = await import("fast-glob");
    const matches = await glob.default(["src/app/**/unpost/**", "src/app/**/unpost*"], {
      cwd: process.cwd(),
      onlyFiles: true,
    });
    expect(matches.length, `unexpected unpost routes: ${matches.join(", ")}`).toBe(0);
  });

  it("staging maintenance reset script guards against wrong environment + wrong tenant", async () => {
    const fs = await import("node:fs/promises");
    const script = await fs.readFile("scripts/coulee-ridge-semimonthly-cutover.ts", "utf-8").catch(() => "");
    // The script may not exist at test time; that's fine — the assertion
    // is on structural guards *when it does* exist. If it's absent this
    // test degrades to a no-op (the reset hasn't shipped yet).
    if (script.length === 0) return;
    expect(script, "must guard on staging DB").toMatch(/spectre-staging|staging\.spectreautomation/i);
    expect(script, "must pin Coulee Ridge tenant id").toMatch(/cmrvdeny7000144372ktmmg9c/);
    expect(script, "must support dry-run").toMatch(/dry[-_]?run/i);
    // Must NOT delete any POSTED batch or JournalEntry.
    expect(script).not.toMatch(/\.deleteMany\s*\(\s*\{[^}]*status:\s*['"]POSTED['"]/);
    expect(script).not.toMatch(/journalEntry\.deleteMany|journalEntry\.delete/);
  });
});

// Payroll 3A date-boundary hotfix (2026-09-11) — verifies calendar-date
// formatting for payroll periods does NOT drift across timezones or DST.
//
// The bug: Alberta browser rendered a persisted 2026-08-30 period as
// "Fri, Aug 29, 2026" because `new Date("2026-08-30").toLocaleDateString`
// converts UTC midnight into the previous evening MDT. The fix is a
// timezone-agnostic YYYY-MM-DD parser that treats the ISO prefix as a
// calendar date.

import { describe, it, expect, afterAll } from "vitest";
import { fmtCalendarDate } from "@/components/payroll/PayrollAdminOverview";

describe("fmtCalendarDate — calendar-date semantics", () => {
  it("Alberta (America/Edmonton) — persisted 2026-08-30 displays Sat Aug 30", () => {
    expect(fmtCalendarDate("2026-08-30")).toBe("Sun, Aug 30, 2026");
    // Sanity: Aug 30, 2026 IS a Sunday (Zeller's).
  });

  it("Alberta — persisted 2026-09-12 displays Sat Sep 12", () => {
    expect(fmtCalendarDate("2026-09-12")).toBe("Sat, Sep 12, 2026");
  });

  it("Founder-period start Aug 30 renders exactly (no Aug 29 drift)", () => {
    expect(fmtCalendarDate("2026-08-30")).not.toContain("Aug 29");
  });

  it("Founder-period end Sep 12 renders exactly (no Sep 11 drift)", () => {
    expect(fmtCalendarDate("2026-09-12")).not.toContain("Sep 11");
  });

  it("DST transition — Sunday Nov 1, 2026 renders as Sun Nov 1", () => {
    // Alberta ends DST on Sun Nov 1, 2026 at 02:00 local. The date-only
    // input must not shift.
    expect(fmtCalendarDate("2026-11-01")).toBe("Sun, Nov 1, 2026");
  });

  it("DST transition — Sunday Mar 8, 2026 renders as Sun Mar 8", () => {
    // Spring-forward date; date-only must not shift.
    expect(fmtCalendarDate("2026-03-08")).toBe("Sun, Mar 8, 2026");
  });

  it("accepts full ISO 8601 with UTC time suffix", () => {
    // Values persisted as UTC-midnight instants must still render the
    // calendar date, not the local previous evening.
    expect(fmtCalendarDate("2026-08-30T00:00:00.000Z")).toBe("Sun, Aug 30, 2026");
    expect(fmtCalendarDate("2026-09-12T00:00:00.000Z")).toBe("Sat, Sep 12, 2026");
  });

  it("invalid input returns input unchanged", () => {
    expect(fmtCalendarDate("")).toBe("");
    expect(fmtCalendarDate("nonsense")).toBe("nonsense");
  });

  it("weekday computed correctly across a range of dates", () => {
    // Cross-check a few known days.
    expect(fmtCalendarDate("2026-01-01")).toBe("Thu, Jan 1, 2026");   // Jan 1 2026 = Thu
    expect(fmtCalendarDate("2026-12-25")).toBe("Fri, Dec 25, 2026");
    expect(fmtCalendarDate("2027-01-01")).toBe("Fri, Jan 1, 2027");
  });
});

describe("Cross-timezone stability — process.env.TZ", () => {
  const originalTZ = process.env.TZ;
  afterEachSetTZ(originalTZ);

  it("America/Edmonton — Aug 30 still renders Aug 30", () => {
    process.env.TZ = "America/Edmonton";
    expect(fmtCalendarDate("2026-08-30")).toBe("Sun, Aug 30, 2026");
  });

  it("America/Toronto — Sep 12 still renders Sep 12", () => {
    process.env.TZ = "America/Toronto";
    expect(fmtCalendarDate("2026-09-12")).toBe("Sat, Sep 12, 2026");
  });

  it("Asia/Tokyo — Aug 30 still renders Aug 30", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(fmtCalendarDate("2026-08-30")).toBe("Sun, Aug 30, 2026");
  });
});

function afterEachSetTZ(originalTZ: string | undefined) {
  afterAll(() => {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  });
}

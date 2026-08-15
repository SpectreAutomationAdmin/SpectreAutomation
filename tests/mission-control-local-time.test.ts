// Phase 4R rev-3 (2026-08-15) — Mission Control local-time
// utilities: greeting derivation MUST resolve against the tenant's
// IANA timezone (not the server local hour), and commitment
// formatting MUST render 12-hour AM/PM.

import { describe, it, expect } from "vitest";
import {
  getTimeOfDay,
  greetingWordForInstant,
  formatLocalTimeAmPm,
  GREETING_BOUNDARIES,
} from "@/lib/mission-control/local-time";

const EDMONTON = "America/Edmonton";
const UTC = "UTC";

describe("getTimeOfDay — Edmonton IANA timezone (DST-aware)", () => {
  // ---- Summer (Mountain Daylight Time, UTC-6) -----------------------------
  // 2026-08-15 09:00 America/Edmonton == 2026-08-15 15:00 UTC
  it("Edmonton 09:00 MDT → morning", () => {
    // Real instant: 2026-08-15T15:00:00Z. In Edmonton MDT that is 09:00.
    const instant = new Date("2026-08-15T15:00:00Z");
    expect(getTimeOfDay(instant, EDMONTON)).toBe("morning");
    expect(greetingWordForInstant(instant, EDMONTON)).toBe("Good morning");
  });

  // 2026-08-15 15:00 America/Edmonton == 2026-08-15 21:00 UTC
  // This is the founder-reported bug scenario: server clock 21:00
  // UTC would classify as "evening", but Edmonton 15:00 is afternoon.
  it("Edmonton 15:00 MDT → afternoon (was misreported as evening under UTC)", () => {
    const instant = new Date("2026-08-15T21:00:00Z");
    expect(getTimeOfDay(instant, EDMONTON)).toBe("afternoon");
    expect(greetingWordForInstant(instant, EDMONTON)).toBe("Good afternoon");
    // Regression sentinel: if someone reverts to server/UTC, this
    // would incorrectly classify as evening.
    expect(getTimeOfDay(instant, UTC)).toBe("evening");
  });

  // 2026-08-15 19:00 America/Edmonton == 2026-08-16 01:00 UTC
  it("Edmonton 19:00 MDT → evening", () => {
    const instant = new Date("2026-08-16T01:00:00Z");
    expect(getTimeOfDay(instant, EDMONTON)).toBe("evening");
    expect(greetingWordForInstant(instant, EDMONTON)).toBe("Good evening");
  });

  // ---- Winter (Mountain Standard Time, UTC-7) — DST guard ----------------
  // 2026-01-15 09:00 America/Edmonton MST == 2026-01-15 16:00 UTC
  it("Edmonton 09:00 MST (winter) → morning", () => {
    const instant = new Date("2026-01-15T16:00:00Z");
    expect(getTimeOfDay(instant, EDMONTON)).toBe("morning");
  });

  // 2026-01-15 15:00 America/Edmonton MST == 2026-01-15 22:00 UTC
  it("Edmonton 15:00 MST (winter) → afternoon (regression guard)", () => {
    const instant = new Date("2026-01-15T22:00:00Z");
    expect(getTimeOfDay(instant, EDMONTON)).toBe("afternoon");
    // Regression sentinel — a hard-coded UTC-6 or UTC-7 offset would
    // produce a different answer for at least one of the summer or
    // winter cases. This is why we assert BOTH.
    expect(getTimeOfDay(instant, UTC)).toBe("evening");
  });

  // ---- Boundary edges ----------------------------------------------------
  it("Edmonton 04:59 → evening (wrap-around; conservative)", () => {
    // 04:59 MDT = 10:59 UTC on 2026-08-15
    const instant = new Date("2026-08-15T10:59:00Z");
    expect(getTimeOfDay(instant, EDMONTON)).toBe("evening");
  });
  it("Edmonton 05:00 → morning (boundary)", () => {
    const instant = new Date("2026-08-15T11:00:00Z");
    expect(getTimeOfDay(instant, EDMONTON)).toBe("morning");
  });
  it("Edmonton 11:59 → morning (boundary)", () => {
    const instant = new Date("2026-08-15T17:59:00Z");
    expect(getTimeOfDay(instant, EDMONTON)).toBe("morning");
  });
  it("Edmonton 12:00 → afternoon (boundary)", () => {
    const instant = new Date("2026-08-15T18:00:00Z");
    expect(getTimeOfDay(instant, EDMONTON)).toBe("afternoon");
  });
  it("Edmonton 16:59 → afternoon (boundary)", () => {
    const instant = new Date("2026-08-15T22:59:00Z");
    expect(getTimeOfDay(instant, EDMONTON)).toBe("afternoon");
  });
  it("Edmonton 17:00 → evening (boundary)", () => {
    const instant = new Date("2026-08-15T23:00:00Z");
    expect(getTimeOfDay(instant, EDMONTON)).toBe("evening");
  });

  it("GREETING_BOUNDARIES constants are the founder-approved values", () => {
    expect(GREETING_BOUNDARIES.morningStartHour).toBe(5);
    expect(GREETING_BOUNDARIES.afternoonStartHour).toBe(12);
    expect(GREETING_BOUNDARIES.eveningStartHour).toBe(17);
  });
});

describe("formatLocalTimeAmPm — 12-hour AM/PM, no leading zero, minutes 2-digit", () => {
  // All fixtures use America/Edmonton so the wall clock the founder
  // reads on Mission Control matches the assertion.
  const cases: Array<{ label: string; utc: string; expected: string }> = [
    // Edmonton MDT (summer, UTC-6):
    { label: "08:00 MDT",  utc: "2026-08-15T14:00:00Z", expected: "8:00 AM"  },
    { label: "09:30 MDT",  utc: "2026-08-15T15:30:00Z", expected: "9:30 AM"  },
    { label: "12:00 MDT",  utc: "2026-08-15T18:00:00Z", expected: "12:00 PM" },
    { label: "13:00 MDT",  utc: "2026-08-15T19:00:00Z", expected: "1:00 PM"  },
    { label: "13:30 MDT",  utc: "2026-08-15T19:30:00Z", expected: "1:30 PM"  },
    { label: "15:45 MDT",  utc: "2026-08-15T21:45:00Z", expected: "3:45 PM"  },
    { label: "23:59 MDT",  utc: "2026-08-16T05:59:00Z", expected: "11:59 PM" },
    { label: "00:00 MDT",  utc: "2026-08-15T06:00:00Z", expected: "12:00 AM" },
    // Edmonton MST (winter, UTC-7):
    { label: "08:00 MST",  utc: "2026-01-15T15:00:00Z", expected: "8:00 AM"  },
    { label: "13:00 MST",  utc: "2026-01-15T20:00:00Z", expected: "1:00 PM"  },
  ];

  for (const c of cases) {
    it(`Edmonton ${c.label} → ${c.expected}`, () => {
      expect(formatLocalTimeAmPm(new Date(c.utc), EDMONTON)).toBe(c.expected);
    });
  }

  it("uppercase AM/PM", () => {
    const out = formatLocalTimeAmPm(new Date("2026-08-15T14:00:00Z"), EDMONTON);
    expect(out).toMatch(/\bAM\b/);
    expect(out).not.toMatch(/\bam\b/);
    expect(out).not.toMatch(/\ba\.m\.\b/i);
  });

  it("no leading zero on the hour, minutes always two digits", () => {
    expect(formatLocalTimeAmPm(new Date("2026-08-15T15:05:00Z"), EDMONTON))
      .toBe("9:05 AM");
    expect(formatLocalTimeAmPm(new Date("2026-08-15T14:00:00Z"), EDMONTON))
      .not.toMatch(/^0/);
  });
});

// Sprint 3 · Checkpoint 16H calendar-acceptance (2026-08-05) —
// time-normalisation + temporal-state tests.
//
// Covers §19 (time normalisation) + §20 (commitment state), using
// deterministic fake clocks so the assertions do not depend on the
// actual test-run time.

import { describe, it, expect } from "vitest";
import { normaliseGraphInstant } from "@/lib/integrations/microsoft-graph-calendar";
import { deriveCommitmentState } from "@/lib/mission-control/commitments";

// -----------------------------------------------------------------------------
// §19 — Time normalisation
// -----------------------------------------------------------------------------

const EDMONTON = "America/Edmonton";

function formatEdmonton(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: EDMONTON, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
}
function formatEdmontonDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: EDMONTON, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

describe("16H calendar · normaliseGraphInstant — MDT (August)", () => {
  it("6:00 PM MDT (returned as wall-clock + IANA tz) → displays 18:00 in Edmonton", () => {
    // Reproduces the founder's Board Meeting exactly.
    const utc = normaliseGraphInstant("2026-08-04T18:00:00.0000000", EDMONTON, EDMONTON);
    // 18:00 Edmonton in August = UTC-6 → 2026-08-05T00:00:00Z.
    expect(utc.toISOString()).toBe("2026-08-05T00:00:00.000Z");
    expect(formatEdmonton(utc)).toBe("18:00");
    expect(formatEdmontonDate(utc)).toBe("2026-08-04");
  });

  it("7:00 PM MDT → 19:00 in Edmonton", () => {
    // Reproduces the founder's Test Appointment exactly.
    const utc = normaliseGraphInstant("2026-08-04T19:00:00.0000000", EDMONTON, EDMONTON);
    expect(utc.toISOString()).toBe("2026-08-05T01:00:00.000Z");
    expect(formatEdmonton(utc)).toBe("19:00");
  });

  it("regression: normaliseGraphInstant NEVER produces the founder-observed 12:00 shift for 18:00 MDT input", () => {
    // The founder's staging trace (2026-08-05) recorded the OLD
    // `new Date(e.start.dateTime)` code path producing UTC
    // 2026-08-04T18:00:00.000Z which renders as 12:00 in Edmonton.
    // Node's parse behaviour for 7-digit fractional seconds is
    // implementation-specific — asserting the exact OLD result here
    // would be fragile across Node builds. Instead we assert the
    // fixed path always produces the correct wall-clock.
    const fixed = normaliseGraphInstant("2026-08-04T18:00:00.0000000", EDMONTON, EDMONTON);
    expect(formatEdmonton(fixed)).toBe("18:00");
    expect(formatEdmonton(fixed)).not.toBe("12:00");
  });
});

describe("16H calendar · normaliseGraphInstant — MST (January)", () => {
  it("6:00 PM MST → 18:00 in Edmonton (offset is UTC-7 in Jan, not hardcoded UTC-6)", () => {
    const utc = normaliseGraphInstant("2026-01-15T18:00:00.0000000", EDMONTON, EDMONTON);
    // 18:00 Edmonton in January = UTC-7 → 2026-01-16T01:00:00Z.
    expect(utc.toISOString()).toBe("2026-01-16T01:00:00.000Z");
    expect(formatEdmonton(utc)).toBe("18:00");
    expect(formatEdmontonDate(utc)).toBe("2026-01-15");
  });
});

describe("16H calendar · normaliseGraphInstant — DST transitions in America/Edmonton", () => {
  it("spring forward 2026-03-08 — 09:00 local (after clock jump) is correct", () => {
    // After spring-forward: 09:00 local = UTC-6 → 15:00Z.
    const utc = normaliseGraphInstant("2026-03-08T09:00:00.0000000", EDMONTON, EDMONTON);
    expect(formatEdmonton(utc)).toBe("09:00");
    expect(formatEdmontonDate(utc)).toBe("2026-03-08");
  });

  it("fall back 2026-11-01 — 09:00 local (after clock back) is correct", () => {
    // After fall-back: 09:00 local = UTC-7 → 16:00Z.
    const utc = normaliseGraphInstant("2026-11-01T09:00:00.0000000", EDMONTON, EDMONTON);
    expect(utc.toISOString()).toBe("2026-11-01T16:00:00.000Z");
    expect(formatEdmonton(utc)).toBe("09:00");
    expect(formatEdmontonDate(utc)).toBe("2026-11-01");
  });
});

describe("16H calendar · normaliseGraphInstant — Windows tz fallback + edge cases", () => {
  it("empty event tz falls back to the fallback (club) tz", () => {
    const utc = normaliseGraphInstant("2026-08-04T18:00:00.0000000", "", EDMONTON);
    expect(formatEdmonton(utc)).toBe("18:00");
  });

  it("Windows tz string (has spaces) falls back to the club tz", () => {
    // We do not ship a Windows→IANA table — the fallback uses the
    // zone we requested via Prefer, which matches the display zone,
    // so the wall-clock still renders correctly.
    const utc = normaliseGraphInstant("2026-08-04T18:00:00.0000000", "Mountain Standard Time", EDMONTON);
    expect(formatEdmonton(utc)).toBe("18:00");
  });

  it("crossing UTC midnight stays on the intended Edmonton day", () => {
    // 22:00 Edmonton in August = 04:00 UTC the NEXT day. Display
    // must remain on the original Edmonton date.
    const utc = normaliseGraphInstant("2026-08-04T22:00:00.0000000", EDMONTON, EDMONTON);
    expect(utc.toISOString()).toBe("2026-08-05T04:00:00.000Z");
    expect(formatEdmontonDate(utc)).toBe("2026-08-04");
  });

  it("missing dateTime does not throw", () => {
    const d = normaliseGraphInstant(undefined, EDMONTON, EDMONTON);
    expect(d).toBeInstanceOf(Date);
  });
});

// -----------------------------------------------------------------------------
// §20 — Commitment state derivation (deterministic clock)
// -----------------------------------------------------------------------------

describe("16H calendar · deriveCommitmentState (deterministic clock)", () => {
  const start = new Date("2026-08-05T00:00:00Z");   // 18:00 MDT
  const end   = new Date("2026-08-05T00:30:00Z");   // 18:30 MDT

  it("endAt <= now → PAST", () => {
    const now = new Date("2026-08-05T00:31:00Z");  // 18:31 MDT
    expect(deriveCommitmentState({ startAt: start, endAt: end, isAllDay: false, now })).toBe("PAST");
  });

  it("startAt <= now < endAt → IN_PROGRESS", () => {
    const now = new Date("2026-08-05T00:15:00Z");  // 18:15 MDT
    expect(deriveCommitmentState({ startAt: start, endAt: end, isAllDay: false, now })).toBe("IN_PROGRESS");
  });

  it("startAt > now → UPCOMING", () => {
    const now = new Date("2026-08-04T23:59:00Z");  // 17:59 MDT
    expect(deriveCommitmentState({ startAt: start, endAt: end, isAllDay: false, now })).toBe("UPCOMING");
  });

  it("state derivation NEVER uses startAt alone — an event that has started but not ended is IN_PROGRESS, not PAST", () => {
    // §8: "An appointment that began earlier but has not ended is not past."
    const now = new Date("2026-08-05T00:25:00Z");  // 18:25 MDT — 25 min into a 30-min meeting
    expect(deriveCommitmentState({ startAt: start, endAt: end, isAllDay: false, now })).toBe("IN_PROGRESS");
  });

  it("all-day event stays ALL_DAY regardless of current instant", () => {
    // §12: all-day must not be marked past until the local day ends.
    const now = new Date("2026-08-05T20:00:00Z");  // 14:00 MDT (mid-day)
    expect(deriveCommitmentState({
      startAt: new Date("2026-08-04T06:00:00Z"),
      endAt: new Date("2026-08-05T06:00:00Z"),
      isAllDay: true, now,
    })).toBe("ALL_DAY");
  });

  it("state transitions cleanly at end-time boundary (upcoming → in-progress → past)", () => {
    // §20: "Event changes from upcoming to in-progress at start time.
    //       Event changes from in-progress to past at end time."
    const beforeStart = new Date(start.getTime() - 1);
    const atStart = new Date(start.getTime());
    const atEnd = new Date(end.getTime());
    expect(deriveCommitmentState({ startAt: start, endAt: end, isAllDay: false, now: beforeStart })).toBe("UPCOMING");
    expect(deriveCommitmentState({ startAt: start, endAt: end, isAllDay: false, now: atStart })).toBe("IN_PROGRESS");
    expect(deriveCommitmentState({ startAt: start, endAt: end, isAllDay: false, now: atEnd })).toBe("PAST");
  });
});

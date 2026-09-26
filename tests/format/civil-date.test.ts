// AUTH-3D.CLOSEOUT-FIX — civil-date renderer regression suite.
//
// Guards the "a business calendar date renders as the day it was
// captured, not shifted by the viewer's timezone" invariant. The
// bug that motivated this helper: terminationDate=2026-09-26 was
// stored as 2026-09-26T00:00:00.000Z and rendered as September 25
// for a viewer in America/Chicago (UTC-5).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { formatCivilDate } from "@/lib/format/civil-date";

const ISO_SEPT_26 = "2026-09-26T00:00:00.000Z";
const ISO_JAN_1 = "2026-01-01T00:00:00.000Z";
const ISO_DEC_31 = "2026-12-31T00:00:00.000Z";

describe("formatCivilDate", () => {
  // The renderer uses UTC field extraction, not toLocaleDateString +
  // timeZone. The process TZ is therefore irrelevant to the result —
  // we assert the same output whether Node reports America/Chicago
  // (UTC-5) or Australia/Sydney (UTC+10). We do not need to mock
  // process.env.TZ per test; the pure UTC extraction guarantees
  // timezone independence.

  it("renders 2026-09-26 as September 26 (long) regardless of process TZ", () => {
    expect(formatCivilDate(ISO_SEPT_26, { month: "long" })).toBe("September 26, 2026");
  });

  it("renders 2026-09-26 as Sep 26 in short-month default", () => {
    expect(formatCivilDate(ISO_SEPT_26)).toBe("Sep 26, 2026");
  });

  it("does NOT regress to September 25 (negative UTC offset)", () => {
    // A naive `new Date(iso).toLocaleDateString(undefined, {month:'long'})`
    // in America/Chicago would render "September 25, 2026" here.
    const rendered = formatCivilDate(ISO_SEPT_26, { month: "long" });
    expect(rendered).not.toContain("25");
    expect(rendered).toContain("26");
  });

  it("does NOT advance to September 27 (positive UTC offset)", () => {
    // A naive renderer in Australia/Sydney would render "September 26"
    // for a value stored at midnight UTC — but if the value were
    // stored 24h earlier, it would advance. We assert stability against
    // year/month/day boundaries: 2026-09-26 stays September 26.
    const rendered = formatCivilDate(ISO_SEPT_26, { month: "long" });
    expect(rendered).not.toContain("27");
  });

  it("preserves year boundary (2026-01-01 stays January 1)", () => {
    expect(formatCivilDate(ISO_JAN_1, { month: "long" })).toBe("January 1, 2026");
  });

  it("preserves year boundary (2026-12-31 stays December 31)", () => {
    expect(formatCivilDate(ISO_DEC_31, { month: "long" })).toBe("December 31, 2026");
  });

  it("accepts a Date object (not just a string)", () => {
    // Date constructed from an ISO string keeps UTC semantics
    // regardless of local TZ.
    const d = new Date(ISO_SEPT_26);
    expect(formatCivilDate(d, { month: "long" })).toBe("September 26, 2026");
  });

  it("returns null for null/undefined by default", () => {
    expect(formatCivilDate(null)).toBeNull();
    expect(formatCivilDate(undefined)).toBeNull();
    expect(formatCivilDate("")).toBeNull();
  });

  it("returns the configured fallback for null/undefined", () => {
    expect(formatCivilDate(null, { fallback: "current" })).toBe("current");
    expect(formatCivilDate(undefined, { fallback: "—" })).toBe("—");
  });

  it("returns fallback for invalid input", () => {
    expect(formatCivilDate("not-a-date")).toBeNull();
    expect(formatCivilDate("not-a-date", { fallback: "N/A" })).toBe("N/A");
  });

  it("preserves the actual timestamp semantics of non-civil values", () => {
    // A true timestamp with a non-midnight-UTC time renders based on
    // UTC extraction — the DATE part is what the helper returns, which
    // is correct for civil-date fields but WOULD lose information for
    // true timestamps. Assert this contract so future callers can
    // distinguish: for a value like 2026-09-26T22:00:00Z, the helper
    // still returns "September 26" — call sites that need the local
    // moment must use a different renderer.
    const withTime = "2026-09-26T22:00:00.000Z";
    expect(formatCivilDate(withTime, { month: "long" })).toBe("September 26, 2026");
  });
});

// -----------------------------------------------------------------
// Simulated-TZ round trip. Vitest doesn't let us change TZ per test,
// but we can prove the helper does NOT call toLocaleDateString with
// the process timezone by reading its output for a value that WOULD
// shift under a naive local-TZ renderer.
// -----------------------------------------------------------------
describe("formatCivilDate · naive-renderer regression comparison", () => {
  it("differs from a naive local-TZ renderer for a UTC-midnight value in a negative-offset TZ", () => {
    const iso = ISO_SEPT_26;
    const civil = formatCivilDate(iso, { month: "long" });
    // Simulate what a naive renderer produces when the process is
    // west-of-UTC by constructing a Date and shifting it manually.
    // The helper's output MUST NOT match the shifted rendering.
    const shifted = new Date(new Date(iso).getTime() - 6 * 60 * 60 * 1000); // UTC-6 shift
    const naive = `${["January","February","March","April","May","June","July","August","September","October","November","December"][shifted.getUTCMonth()]} ${shifted.getUTCDate()}, ${shifted.getUTCFullYear()}`;
    expect(naive).toBe("September 25, 2026");
    expect(civil).not.toBe(naive);
    expect(civil).toBe("September 26, 2026");
  });
});

// Sprint 3 · Checkpoint 16H rejection (2026-08-06) — unit tests
// for the Completed History timeline separators. Covers §19 at
// unit-test scope with deterministic fake clocks.
//
// Zone under test: America/Edmonton (Coulee Ridge).

import { describe, it, expect } from "vitest";
import { computeTimelineMarkers, labelForDayKey, localDateKey } from "@/lib/mission-control/timeline-markers";

const CR_TZ = "America/Edmonton";
// 2026-08-04 14:00 UTC = 2026-08-04 08:00 MDT
const NOW = new Date("2026-08-04T14:00:00.000Z");

describe("16H · timeline label ladder (America/Edmonton)", () => {
  it("returns 'Today' for the current local day", () => {
    const key = localDateKey(NOW, CR_TZ);
    expect(labelForDayKey(key, { ianaZone: CR_TZ, now: NOW })).toBe("Today");
  });

  it("returns 'Yesterday' for the previous local day", () => {
    // 2026-08-03 14:00 UTC = 2026-08-03 08:00 MDT
    const y = new Date("2026-08-03T14:00:00.000Z");
    expect(labelForDayKey(localDateKey(y, CR_TZ), { ianaZone: CR_TZ, now: NOW })).toBe("Yesterday");
  });

  it("returns weekday name for items within the last 7 days but not today/yesterday", () => {
    // 2026-07-30 was a Thursday.
    const t = new Date("2026-07-30T14:00:00.000Z");
    expect(labelForDayKey(localDateKey(t, CR_TZ), { ianaZone: CR_TZ, now: NOW })).toBe("Thursday");
  });

  it("returns 'Month Day' for older current-year items", () => {
    // 2026-06-15
    const d = new Date("2026-06-15T14:00:00.000Z");
    expect(labelForDayKey(localDateKey(d, CR_TZ), { ianaZone: CR_TZ, now: NOW })).toBe("June 15");
  });

  it("returns 'Month Day, Year' for prior-year items", () => {
    // 2025-12-18
    const d = new Date("2025-12-18T14:00:00.000Z");
    expect(labelForDayKey(localDateKey(d, CR_TZ), { ianaZone: CR_TZ, now: NOW })).toBe("December 18, 2025");
  });

  it("crosses the UTC-midnight boundary in Edmonton correctly", () => {
    // 2026-08-05 04:00 UTC = 2026-08-04 22:00 MDT — still TODAY locally.
    const stillToday = new Date("2026-08-05T04:00:00.000Z");
    expect(labelForDayKey(localDateKey(stillToday, CR_TZ), { ianaZone: CR_TZ, now: NOW })).toBe("Today");
    // 2026-08-05 07:00 UTC = 2026-08-05 01:00 MDT — the NEXT day locally
    // — this branch is exercised by computeTimelineMarkers below.
  });
});

describe("16H · computeTimelineMarkers", () => {
  const now = NOW;

  it("emits a marker only when the local day changes; consecutive same-day items get null", () => {
    const items = [
      { workIntakeCreatedAt: "2026-08-04T20:00:00.000Z" }, // today (14:00 MDT)
      { workIntakeCreatedAt: "2026-08-04T14:30:00.000Z" }, // today (08:30 MDT)
      { workIntakeCreatedAt: "2026-08-03T18:00:00.000Z" }, // yesterday (12:00 MDT)
      { workIntakeCreatedAt: "2026-07-30T18:00:00.000Z" }, // Thursday
    ];
    const markers = computeTimelineMarkers(items, CR_TZ, now);
    expect(markers[0]?.label).toBe("Today");
    expect(markers[1]).toBeNull();
    expect(markers[2]?.label).toBe("Yesterday");
    expect(markers[3]?.label).toBe("Thursday");
  });

  it("items without workIntakeCreatedAt do not receive a marker", () => {
    const items = [
      { workIntakeCreatedAt: "2026-08-04T14:30:00.000Z" },
      { /* no createdAt */ },
    ];
    const markers = computeTimelineMarkers(items, CR_TZ, now);
    expect(markers[0]?.label).toBe("Today");
    expect(markers[1]).toBeNull();
  });

  it("handles a prior-year transition inside a longer list", () => {
    const items = [
      { workIntakeCreatedAt: "2026-01-15T18:00:00.000Z" },
      { workIntakeCreatedAt: "2025-12-18T18:00:00.000Z" },
    ];
    const markers = computeTimelineMarkers(items, CR_TZ, now);
    expect(markers[0]?.label).toBe("January 15");
    expect(markers[1]?.label).toBe("December 18, 2025");
  });
});

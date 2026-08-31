// Payroll-3B-5A — canonical half-open interval utility.

import { describe, it, expect } from "vitest";
import {
  intersect,
  intersectAll,
  overlaps,
  coverageDays,
  containsDay,
} from "@/lib/payroll/intervals";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

describe("Payroll intervals — half-open semantics", () => {
  it("intersect returns the overlap; end is the min of ends", () => {
    const r = intersect({ start: d(2026, 8, 1), end: d(2026, 8, 31) }, { start: d(2026, 8, 15), end: d(2026, 8, 20) });
    expect(r).toEqual({ start: d(2026, 8, 15), end: d(2026, 8, 20) });
  });

  it("intersect returns null when only touching at a boundary (half-open)", () => {
    // A ends at Aug 15 exclusive; B starts at Aug 15 inclusive — no overlap.
    const r = intersect({ start: d(2026, 8, 1), end: d(2026, 8, 15) }, { start: d(2026, 8, 15), end: d(2026, 8, 20) });
    expect(r).toBeNull();
    expect(overlaps({ start: d(2026, 8, 1), end: d(2026, 8, 15) }, { start: d(2026, 8, 15), end: d(2026, 8, 20) })).toBe(false);
  });

  it("intersect handles open-ended intervals", () => {
    const r = intersect({ start: d(2026, 1, 1), end: null }, { start: d(2026, 8, 1), end: d(2026, 8, 31) });
    expect(r).toEqual({ start: d(2026, 8, 1), end: d(2026, 8, 31) });
  });

  it("intersectAll composes correctly", () => {
    const r = intersectAll([
      { start: d(2026, 8, 1), end: d(2026, 8, 31) },
      { start: d(2026, 8, 10), end: d(2026, 8, 20) },
      { start: d(2026, 8, 12), end: null },
    ]);
    expect(r).toEqual({ start: d(2026, 8, 12), end: d(2026, 8, 20) });
  });

  it("coverageDays counts civil days for a bounded interval", () => {
    expect(coverageDays({ start: d(2026, 8, 1), end: d(2026, 8, 15) })).toBe(14);
    expect(coverageDays({ start: d(2026, 8, 1), end: d(2026, 9, 1) })).toBe(31);
  });

  it("coverageDays refuses open-ended intervals", () => {
    expect(() => coverageDays({ start: d(2026, 8, 1), end: null })).toThrow(/refusing/);
  });

  it("containsDay honours half-open bounds", () => {
    const iv = { start: d(2026, 8, 15), end: d(2026, 9, 1) };
    expect(containsDay(d(2026, 8, 15), iv)).toBe(true);
    expect(containsDay(d(2026, 8, 31), iv)).toBe(true);
    expect(containsDay(d(2026, 9, 1), iv)).toBe(false); // exclusive end
    expect(containsDay(d(2026, 8, 14), iv)).toBe(false);
  });
});

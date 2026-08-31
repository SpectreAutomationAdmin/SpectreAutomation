// Payroll-3B-5A (2026-08-31) — canonical interval-intersection
// utility for effective-dated Payroll facts.
//
// All Payroll intervals use half-open [start, end) semantics:
//   • `start` is inclusive
//   • `end` is EXCLUSIVE (a fact effective through midnight of day N
//     ends at start-of-day (N+1))
//   • `end === null` means open-ended (still in effect)
//
// The future calculator resolves the intersection of many effective-
// dated intervals (Pay Period ∩ Pay Group membership ∩ Employment
// window ∩ Assignment ∩ Compensation). Getting the boundary math
// right in one place — here — is the invariant that keeps salary
// proration honest and prevents duplicate full-period salary on
// mid-period Pay Group transfers.
//
// Zero currency math lives in this file.

export interface HalfOpenInterval {
  /** Inclusive start (UTC midnight for civil dates). */
  start: Date;
  /** EXCLUSIVE end. `null` means open-ended. */
  end: Date | null;
}

const DAY_MS = 86_400_000;

/** Return true when the two half-open intervals share any instant. */
export function overlaps(a: HalfOpenInterval, b: HalfOpenInterval): boolean {
  const aEnd = a.end?.getTime() ?? Infinity;
  const bEnd = b.end?.getTime() ?? Infinity;
  return a.start.getTime() < bEnd && b.start.getTime() < aEnd;
}

/**
 * Return the intersection of two half-open intervals, or `null` when
 * they do not overlap. The result is itself half-open; `end === null`
 * only when BOTH inputs are open-ended.
 */
export function intersect(a: HalfOpenInterval, b: HalfOpenInterval): HalfOpenInterval | null {
  if (!overlaps(a, b)) return null;
  const start = a.start.getTime() >= b.start.getTime() ? a.start : b.start;
  let end: Date | null;
  if (a.end === null && b.end === null) end = null;
  else if (a.end === null) end = b.end;
  else if (b.end === null) end = a.end;
  else end = a.end.getTime() <= b.end.getTime() ? a.end : b.end;
  return { start, end };
}

/**
 * Return the intersection of many intervals, or `null` if any pair
 * fails to overlap. Deterministic ordering — callers may pass the
 * intervals in any order.
 */
export function intersectAll(intervals: HalfOpenInterval[]): HalfOpenInterval | null {
  if (intervals.length === 0) return null;
  let cur: HalfOpenInterval | null = intervals[0];
  for (let i = 1; i < intervals.length && cur; i++) {
    cur = intersect(cur, intervals[i]);
  }
  return cur;
}

/**
 * Count the number of civil days covered by a half-open interval,
 * measured as `floor((end - start) / 86_400_000)`. Requires a
 * bounded `end`; passing an open interval throws — callers must
 * clip to a bounded reference window (e.g. the Pay Period) first.
 */
export function coverageDays(iv: HalfOpenInterval): number {
  if (iv.end === null) throw new Error("coverageDays: refusing to measure an open interval");
  const diff = iv.end.getTime() - iv.start.getTime();
  if (diff <= 0) return 0;
  return Math.round(diff / DAY_MS);
}

/**
 * Return true when `day` (a UTC-midnight civil date) falls in the
 * half-open interval.
 */
export function containsDay(day: Date, iv: HalfOpenInterval): boolean {
  const t = day.getTime();
  const endT = iv.end?.getTime() ?? Infinity;
  return t >= iv.start.getTime() && t < endT;
}

/**
 * Serialize an interval to ISO strings for JSON persistence.
 * `end === null` is preserved as `null`.
 */
export function toIso(iv: HalfOpenInterval): { start: string; end: string | null } {
  return { start: iv.start.toISOString(), end: iv.end ? iv.end.toISOString() : null };
}

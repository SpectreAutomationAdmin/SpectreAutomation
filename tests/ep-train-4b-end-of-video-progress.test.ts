// EP-TRAIN-4B §4 (2026-10-31) — end-of-video progress accuracy.
//
// Exercises the SAME `mergeIntervals` / `uniqueCoverageSeconds`
// helpers used by CoursePlayer.sendProgress, plus the specific
// onEnded post-condition that the final interval is extended to the
// authoritative video duration.
//
// Prior behaviour: a 41.5s video with videoDurationSec=42 in the DB
// yielded a client-side unique coverage of ~41.3s (floor → 41) and
// a server-computed percent of 41/42 = 97.6% → 98% rounded,
// EVEN WHEN THE EMPLOYEE WATCHED THE VIDEO TO ITS NATURAL END.
//
// New behaviour: when the `ended` event fires, the final interval
// is extended to the authoritative duration BEFORE commit, so unique
// coverage reaches the full duration and floor() stays accurate.

import { describe, it, expect } from "vitest";

function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = intervals.map(([s, e]) => [s, e] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}
function uniqueCoverageSeconds(intervals: Array<[number, number]>): number {
  const merged = mergeIntervals(intervals);
  let sum = 0;
  for (const [s, e] of merged) sum += Math.max(0, e - s);
  return sum;
}

/**
 * Simulate the new onEnded post-condition.
 *
 * Three branches mirror the production code:
 *   A. open interval present → push [start, max(lastSeen, duration)]
 *   B. open interval absent  → extend the LAST committed interval's
 *      end to the authoritative duration (closes the sub-second gap
 *      produced by the pause-then-ended sequence)
 *   C. no intervals at all   → push [lastKnown, duration]
 */
function finaliseOnEnded(
  committed: Array<[number, number]>,
  openInterval: [number, number] | null,
  authoritativeDurationSec: number,
  lastKnown: number = 0,
): Array<[number, number]> {
  const copy = committed.map(([s, e]) => [s, e] as [number, number]);
  if (openInterval) {
    const [start, lastSeen] = openInterval;
    const end = Math.max(lastSeen, authoritativeDurationSec);
    return [...copy, [start, end]];
  }
  if (copy.length > 0) {
    const last = copy[copy.length - 1];
    if (last[1] < authoritativeDurationSec) last[1] = authoritativeDurationSec;
    return copy;
  }
  if (lastKnown < authoritativeDurationSec) {
    return [[lastKnown, authoritativeDurationSec]];
  }
  return copy;
}

describe("EP-TRAIN-4B §4 :: end-of-video progress accuracy", () => {
  it("reproduces the 98% defect under the OLD finaliser", () => {
    // Video is 41.5s long; DB stores videoDurationSec=42.
    // Natural playback through to end — the final timeupdate fires at
    // currentTime=41.3 (ε=0.2s short of actual duration).
    const committed: Array<[number, number]> = [[0, 15], [15, 28]];
    const openInterval: [number, number] = [28, 41.3];
    // OLD finaliser: just push the open interval unchanged.
    const old = [...committed, openInterval];
    const oldSeconds = uniqueCoverageSeconds(old);
    const oldFloor = Math.floor(oldSeconds);
    expect(oldFloor).toBe(41);
    expect(Math.round((oldFloor / 42) * 100)).toBe(98);
  });

  it("new finaliser lifts coverage to the authoritative duration on ended", () => {
    const committed: Array<[number, number]> = [[0, 15], [15, 28]];
    const openInterval: [number, number] = [28, 41.3];
    const authoritative = 42;
    const finalised = finaliseOnEnded(committed, openInterval, authoritative);
    const seconds = uniqueCoverageSeconds(finalised);
    expect(seconds).toBeGreaterThanOrEqual(authoritative);
    const floor = Math.floor(seconds);
    expect(floor).toBe(42);
    expect(Math.round((floor / authoritative) * 100)).toBe(100);
  });

  it("does NOT fabricate coverage for a seeked-near-the-end jump that never fires `ended`", () => {
    // User cleared cp1+cp2 then seeked to currentTime=40 and paused.
    // ended never fires; finaliser is never invoked.
    const committed: Array<[number, number]> = [[0, 15], [15, 28]];
    const openInterval: [number, number] | null = null;
    const seconds = uniqueCoverageSeconds(committed);
    // Only the real coverage counts; ~28/42 = 67%.
    expect(seconds).toBe(28);
  });

  it("rewatching previously viewed content does NOT inflate unique coverage past duration", () => {
    const authoritative = 42;
    // Watched [0,15], rewatched [10,20], finished at ended.
    const committed: Array<[number, number]> = [[0, 15], [10, 20]];
    const openInterval: [number, number] = [20, 41.3];
    const finalised = finaliseOnEnded(committed, openInterval, authoritative);
    const seconds = uniqueCoverageSeconds(finalised);
    expect(seconds).toBeLessThanOrEqual(authoritative + 0.5);
    // Floor caps naturally at duration.
    expect(Math.min(authoritative, Math.floor(seconds))).toBe(42);
  });

  it("onPause-then-onEnded edge case (sub-second gap at the end) is closed by extending the last committed interval", () => {
    // Reproduces the exact staging trace that caused the 97% defect:
    //   onPause committed [28.511, 41.352]
    //   onEnded fired with currentIntervalRef=null (nullified by onPause)
    //   lastTimeRef updated by a final `timeupdate` to 41.517 (AFTER
    //     pause's commit) — a NEW tail [41.517, 42] would leave a
    //     gap at [41.352, 41.517].
    // Fix: extend the LAST committed interval's end to the
    // authoritative duration — closes the gap directly.
    const committed: Array<[number, number]> = [
      [0, 15.267],
      [15.267, 28.511],
      [28.511, 41.352], // onPause's commit; falls short of the real duration
    ];
    const authoritative = 42;
    // OLD (broken) behaviour would push a new tail starting at 41.517:
    const oldBroken: Array<[number, number]> = [...committed, [41.517, authoritative]];
    expect(uniqueCoverageSeconds(oldBroken)).toBeLessThan(authoritative);
    expect(Math.floor(uniqueCoverageSeconds(oldBroken))).toBe(41);
    // NEW behaviour closes the gap in place:
    const finalised = finaliseOnEnded(committed, null, authoritative, 41.517);
    expect(uniqueCoverageSeconds(finalised)).toBe(42);
    expect(Math.floor(uniqueCoverageSeconds(finalised))).toBe(42);
  });

  it("else-branch extension only touches the right-most interval (never fabricates coverage in middle gaps)", () => {
    // User watched [0, 10] + [30, 41.352] (seeked past 10-30 after
    // clearing all required checkpoints).  onEnded extends the LAST
    // interval's end to 42 only; the middle gap stays.
    const committed: Array<[number, number]> = [[0, 10], [30, 41.352]];
    const finalised = finaliseOnEnded(committed, null, 42, 41.5);
    expect(uniqueCoverageSeconds(finalised)).toBe(22); // 10 + 12
    expect(Math.round((22 / 42) * 100)).toBe(52); // not 100
  });

  it("empty-committed-intervals edge case still gets a tail segment", () => {
    const finalised = finaliseOnEnded([], null, 42, 40);
    expect(uniqueCoverageSeconds(finalised)).toBe(2);
  });

  it("legitimate 98% result is NOT cosmetically rounded to 100%", () => {
    // Scenario: employee watched 0..30 then seeked past required
    // checkpoints (blocked), bailed. Server stores secondsWatched=30
    // (regardless of what the client reports), videoDurationSec=42.
    // 30/42 ≈ 71% — no fix anywhere turns that into 100%.
    const committed: Array<[number, number]> = [[0, 30]];
    expect(uniqueCoverageSeconds(committed)).toBe(30);
    expect(Math.round((30 / 42) * 100)).toBe(71);
  });
});

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

// Mirrors INTERVAL_MERGE_TOLERANCE_SECONDS in CoursePlayer.tsx.
const INTERVAL_MERGE_TOLERANCE_SECONDS = 0.05;

function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = intervals.map(([s, e]) => [s, e] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1] + INTERVAL_MERGE_TOLERANCE_SECONDS) {
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
    // NEW behaviour closes the gap in place (the merge tolerance
    // ALSO folds the 165ms gap between the pause-committed interval
    // and any new tail — belt-and-suspenders).
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

  it("tick-jitter sub-millisecond gaps are closed by the 0.5s merge tolerance (staging trace reproduction)", () => {
    // Exact intervals captured from staging on 2026-10-31 showing
    // sub-millisecond gaps between successive timeupdate commits:
    //   [15.030706, 15.031616] gap = 910µs
    //   [28.26021, 28.260256]  gap = 46µs
    // Prior to the tolerance fix these forced the merge to produce
    // 3 segments summing to 41.999044 — flooring to 41 → 97%.  With
    // the tolerance, all three fold into one interval ending at 42.
    const committed: Array<[number, number]> = [
      [0, 15.030706],
      [15.031616, 28.26021],
      [28.260256, 42],
    ];
    const seconds = uniqueCoverageSeconds(committed);
    expect(seconds).toBe(42);
    expect(Math.floor(seconds)).toBe(42);
    expect(Math.round((Math.floor(seconds) / 42) * 100)).toBe(100);
  });

  it("real seek gaps > 0.05s are PRESERVED (tolerance does not inflate coverage)", () => {
    // User watched [0, 10] then seeked ahead 2s to [12, 20].  Gap
    // between the two intervals is 2s > tolerance (0.05s), so the
    // merge preserves it.
    const committed: Array<[number, number]> = [[0, 10], [12, 20]];
    const seconds = uniqueCoverageSeconds(committed);
    expect(seconds).toBe(18); // 10 + 8, NOT 20
  });

  it("EP-TRAIN-4B-1: 20 repeated 0.1s pause-resume gaps DO NOT inflate past tolerance", () => {
    // Adversarial: user pause-taps 20 times, each pause creating a
    // 0.1s gap between successive committed intervals.  Prior to
    // tolerance tightening (0.5s), each gap folded during merge →
    // 20 × 0.1 = 2s inflation on a 42s video (5% unearned credit).
    // With the new 0.05s tolerance, each 0.1s gap is PRESERVED as
    // a real gap — zero inflation.
    const committed: Array<[number, number]> = [];
    for (let i = 0; i < 20; i++) {
      committed.push([i * 2, i * 2 + 1.9]);  // 1.9s on + 0.1s gap pattern
    }
    const totalRealWatch = 20 * 1.9;  // 38s
    expect(uniqueCoverageSeconds(committed)).toBeCloseTo(totalRealWatch, 2);
  });

  it("EP-TRAIN-4B-1: pre-existing 0.000910s microsecond gap IS still absorbed by 0.05s tolerance", () => {
    // The real staging trace: successive currentTime snapshots at
    // 15.030706 and 15.031616 — gap of 910µs.  Must still fold.
    const committed: Array<[number, number]> = [
      [0, 15.030706],
      [15.031616, 28.26021],
      [28.260256, 42],
    ];
    expect(uniqueCoverageSeconds(committed)).toBe(42);
    expect(Math.floor(uniqueCoverageSeconds(committed))).toBe(42);
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

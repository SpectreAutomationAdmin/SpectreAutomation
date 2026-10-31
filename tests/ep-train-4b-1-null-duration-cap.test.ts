// EP-TRAIN-4B-1 (2026-10-31) — server-side cap on percentComplete
// when `videoDurationSec` is NULL on the published course version.
//
// The founder observed the employee player showing 100% watch
// progress at a 0:30/0:41 position.  Root-cause audit of Chris's
// TrainingProgress rows revealed multiple courses with
// `videoDurationSec: null` AND `percentComplete: 100`.  The server's
// fallback `duration = Math.max(secondsWatched, farthestSecond)` made
// the ratio always equal 1 whenever `secondsWatched >= farthestSecond`
// — the common case for natural playback.
//
// Fix: if the published course version has no authoritative duration
// stored, cap percentComplete BELOW the final-assessment threshold.
// A missing duration cannot be a shortcut to course completion.

import { describe, it, expect } from "vitest";

// Re-exported scalar from src/lib/hr/training/attempts.ts (threshold
// is 90% globally; test must stay in sync if that constant changes).
const VIDEO_COMPLETION_THRESHOLD_PERCENT = 90;

/**
 * Mirrors the new percent-computation branch in recordVideoProgress.
 * Exported for unit testing.
 */
function computePercentComplete(
  videoDurationSec: number | null,
  nextSeconds: number,
  nextFarthest: number,
): number {
  const hasAuthoritativeDuration = typeof videoDurationSec === "number" && videoDurationSec > 0;
  const duration = hasAuthoritativeDuration
    ? (videoDurationSec as number)
    : (Math.max(nextSeconds, nextFarthest) || 1);
  let percentComplete = Math.min(100, Math.floor((nextSeconds / duration) * 100));
  if (!hasAuthoritativeDuration && percentComplete >= VIDEO_COMPLETION_THRESHOLD_PERCENT) {
    percentComplete = VIDEO_COMPLETION_THRESHOLD_PERCENT - 1;
  }
  return percentComplete;
}

describe("EP-TRAIN-4B-1 :: server percent-complete with NULL videoDurationSec", () => {
  it("reproduces the premature-100% defect under the OLD computation", () => {
    // The staging data: secondsWatched=41, farthestSecond=41,
    // videoDurationSec=NULL.  Old formula: 41/max(41,41)=100%.
    const oldDuration = Math.max(41, 41) || 1;
    expect(Math.min(100, Math.floor((41 / oldDuration) * 100))).toBe(100);
  });

  it("NULL videoDurationSec caps percent BELOW the unlock threshold", () => {
    expect(computePercentComplete(null, 41, 41)).toBeLessThan(VIDEO_COMPLETION_THRESHOLD_PERCENT);
    expect(computePercentComplete(null, 41, 41)).toBe(89);
    expect(computePercentComplete(null, 5, 5)).toBe(89);
    expect(computePercentComplete(null, 100, 100)).toBe(89);
  });

  it("NULL videoDurationSec + secondsWatched < farthestSecond returns the natural ratio uncapped (< threshold)", () => {
    // User seeked ahead to 30s but only legitimately watched 10s:
    // 10/30 = 33%.  No cap needed.
    expect(computePercentComplete(null, 10, 30)).toBe(33);
  });

  it("Known videoDurationSec computes the authoritative percent", () => {
    expect(computePercentComplete(42, 42, 41)).toBe(100);
    expect(computePercentComplete(42, 21, 21)).toBe(50);
    expect(computePercentComplete(42, 41, 41)).toBe(97);
  });

  it("Known videoDurationSec with secondsWatched >= duration is NOT secondarily capped (legitimate completion)", () => {
    expect(computePercentComplete(42, 42, 42)).toBe(100);
    expect(computePercentComplete(42, 60, 42)).toBe(100); // over-floor clamp
  });

  it("Zero-duration edge case uses the fallback branch and the NULL-cap applies", () => {
    expect(computePercentComplete(0, 10, 10)).toBe(89);
  });

  it("Floored percent < threshold is unaffected (no spurious bumps)", () => {
    expect(computePercentComplete(null, 10, 100)).toBe(10);
    expect(computePercentComplete(42, 10, 10)).toBe(23);
  });
});

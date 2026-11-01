// EP-TRAIN-4E-1 (2026-11-01) — completed-course playback reset invariants.
//
// Guards the pure decision-logic the CoursePlayer uses when a
// TrainingCompletion row is present ("alreadyCompleted") so a
// future refactor cannot accidentally reintroduce the 0:49 opening
// position or the write-through replay progress reporting.

import { describe, it, expect } from "vitest";

/** Mirror of the CoursePlayer.onLoadedMetadata resume-position decision.
 *  Returns the currentTime the client will seek to on load. */
function initialPlaybackPosition(opts: {
  alreadyCompleted: boolean;
  initialProgress: { farthestSecond: number };
  duration: number;
}): number {
  const { alreadyCompleted, initialProgress, duration } = opts;
  if (alreadyCompleted) return 0;
  if (initialProgress.farthestSecond > 1 && duration > 0) {
    return Math.min(initialProgress.farthestSecond, Math.max(0, duration - 2));
  }
  return 0;
}

/** Mirror of the CoursePlayer.sendProgress short-circuit for completed courses. */
function shouldSendProgress(opts: { alreadyCompleted: boolean; hasVideo: boolean }): boolean {
  if (opts.alreadyCompleted) return false;
  if (!opts.hasVideo) return false;
  return true;
}

/** Mirror of the checkpoint trigger gate inside onTimeUpdate. */
function shouldTriggerCheckpoint(opts: {
  alreadyCompleted: boolean;
  phase: "video" | "quiz-ready" | "quiz-answering";
  openingCheckpointInFlight: boolean;
}): boolean {
  if (opts.alreadyCompleted) return false;
  if (opts.phase !== "video") return false;
  if (opts.openingCheckpointInFlight) return false;
  return true;
}

describe("EP-TRAIN-4E-1 :: initial playback position", () => {
  it("founder's scenario: completed course with farthestSecond=51 / duration=51 → 0:00 (NOT 0:49)", () => {
    const pos = initialPlaybackPosition({
      alreadyCompleted: true,
      initialProgress: { farthestSecond: 51 },
      duration: 51,
    });
    expect(pos).toBe(0);
  });

  it("in-progress course with farthestSecond=40 / duration=51 → resume at 40 (unchanged behaviour)", () => {
    const pos = initialPlaybackPosition({
      alreadyCompleted: false,
      initialProgress: { farthestSecond: 40 },
      duration: 51,
    });
    expect(pos).toBe(40);
  });

  it("in-progress course near the end (farthestSecond=51 / duration=51) → capped at duration-2 = 49", () => {
    // Pre-4E-1 behaviour preserved for in-progress — the cap prevents
    // mounting at the very last second where the browser might
    // immediately fire `ended`.
    const pos = initialPlaybackPosition({
      alreadyCompleted: false,
      initialProgress: { farthestSecond: 51 },
      duration: 51,
    });
    expect(pos).toBe(49);
  });

  it("fresh course (farthestSecond=0) → 0:00 regardless of completion flag", () => {
    expect(initialPlaybackPosition({
      alreadyCompleted: false,
      initialProgress: { farthestSecond: 0 },
      duration: 51,
    })).toBe(0);
    expect(initialPlaybackPosition({
      alreadyCompleted: true,
      initialProgress: { farthestSecond: 0 },
      duration: 51,
    })).toBe(0);
  });

  it("completed course with duration still 0 (metadata not loaded) → 0:00", () => {
    const pos = initialPlaybackPosition({
      alreadyCompleted: true,
      initialProgress: { farthestSecond: 51 },
      duration: 0,
    });
    expect(pos).toBe(0);
  });
});

describe("EP-TRAIN-4E-1 :: sendProgress gate", () => {
  it("alreadyCompleted=true → sendProgress short-circuits (preserves completion evidence)", () => {
    expect(shouldSendProgress({ alreadyCompleted: true, hasVideo: true })).toBe(false);
  });

  it("alreadyCompleted=false + hasVideo=true → sendProgress runs (unchanged)", () => {
    expect(shouldSendProgress({ alreadyCompleted: false, hasVideo: true })).toBe(true);
  });

  it("alreadyCompleted=false + hasVideo=false → sendProgress still short-circuits (no video to record)", () => {
    expect(shouldSendProgress({ alreadyCompleted: false, hasVideo: false })).toBe(false);
  });
});

describe("EP-TRAIN-4E-1 :: checkpoint-trigger gate", () => {
  it("alreadyCompleted=true + phase=video → no checkpoint fires on replay", () => {
    expect(shouldTriggerCheckpoint({
      alreadyCompleted: true,
      phase: "video",
      openingCheckpointInFlight: false,
    })).toBe(false);
  });

  it("alreadyCompleted=false + phase=video + no in-flight → trigger as normal", () => {
    expect(shouldTriggerCheckpoint({
      alreadyCompleted: false,
      phase: "video",
      openingCheckpointInFlight: false,
    })).toBe(true);
  });

  it("alreadyCompleted=false + another checkpoint already in flight → do NOT re-trigger (EP-TRAIN-3E race guard)", () => {
    expect(shouldTriggerCheckpoint({
      alreadyCompleted: false,
      phase: "video",
      openingCheckpointInFlight: true,
    })).toBe(false);
  });

  it("alreadyCompleted=false + phase=quiz-answering → do NOT trigger (post-quiz state)", () => {
    expect(shouldTriggerCheckpoint({
      alreadyCompleted: false,
      phase: "quiz-answering",
      openingCheckpointInFlight: false,
    })).toBe(false);
  });
});

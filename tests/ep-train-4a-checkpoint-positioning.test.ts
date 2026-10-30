// EP-TRAIN-4A §3 (2026-10-30) — unit tests for the collision-free
// Add-checkpoint timestamp selector.  Mirrors the server-side
// 1-second minimum spacing rule (CHECKPOINT_MIN_SPACING_SECONDS).

import { describe, it, expect } from "vitest";
import { findNextCheckpointPosition } from "../src/app/app/admin/people/safety-training/[courseId]/[versionId]/TimelineEditor";

describe("EP-TRAIN-4A :: findNextCheckpointPosition", () => {
  it("empty timeline — returns the rounded playhead unchanged", () => {
    expect(findNextCheckpointPosition(12.4, [], 60)).toBe(12);
    expect(findNextCheckpointPosition(0, [], 60)).toBe(0);
    expect(findNextCheckpointPosition(59.6, [], 60)).toBe(60);
  });

  it("one existing checkpoint — playhead on it returns next available second forward", () => {
    expect(findNextCheckpointPosition(15, [15], 60)).toBe(16);
  });

  it("playhead on an occupied timestamp — prefers forward, then backward", () => {
    // 15 occupied; forward slots 16+ open → prefers 16.
    expect(findNextCheckpointPosition(15, [15], 60)).toBe(16);
  });

  it("multiple occupied timestamps, playhead between two — picks the nearest valid position", () => {
    // Occupied: 15, 18. Playhead at 16 → 16 collides (distance 1 to 15 is OK, 2 to 18 is OK — wait
    // distance 1 to 15 is NOT < 1 → fine. But distance 1 to 15 is exactly 1 → >= 1 so VALID).
    // So 16 is valid.
    expect(findNextCheckpointPosition(16, [15, 18], 60)).toBe(16);
    // Playhead at 17 collides with 18 (distance 1) and 15 (distance 2) → 17 - 15 = 2 OK but 17-18=1 OK.
    // Actually distance 1 is NOT less than 1, so 17 is valid.
    expect(findNextCheckpointPosition(17, [15, 18], 60)).toBe(17);
  });

  it("playhead near end — searches backward when no forward position exists", () => {
    // Duration 20. Occupied: 18, 19, 20. Playhead at 20 → collide with 20.
    // Scan forward from 21: beyond duration. Scan backward from 19: collides. 18: collides. 17 valid.
    expect(findNextCheckpointPosition(20, [18, 19, 20], 20)).toBe(17);
  });

  it("fully occupied short timeline — returns null (no valid position)", () => {
    // Duration 2 → valid timestamps are {0, 1, 2}. Occupy all of them.
    expect(findNextCheckpointPosition(1, [0, 1, 2], 2)).toBeNull();
  });

  it("repeated Add checkpoint actions — each gets a distinct valid slot", () => {
    const duration = 60;
    const occupied: number[] = [];
    for (let i = 0; i < 5; i++) {
      const next = findNextCheckpointPosition(15, occupied, duration);
      expect(next).not.toBeNull();
      occupied.push(next!);
    }
    const sorted = [...occupied].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(1);
    }
  });

  it("respects the video duration upper bound", () => {
    // Duration 10, occupied 5. Playhead claimed to be 15 → clamp to 10.
    // 10 is valid (distance 5 to the only occupied) → returns 10.
    expect(findNextCheckpointPosition(15, [5], 10)).toBe(10);
  });

  it("never selects an existing checkpoint as a substitute", () => {
    // Occupied: 15. Playhead at 15 — must return 16 (or 14), not 15.
    const result = findNextCheckpointPosition(15, [15], 60);
    expect(result).not.toBe(15);
    expect(result).toBe(16);
  });

  it("deterministic for the same inputs", () => {
    const a = findNextCheckpointPosition(15, [10, 20, 30], 60);
    const b = findNextCheckpointPosition(15, [10, 20, 30], 60);
    expect(a).toBe(b);
    expect(a).toBe(15);
  });

  it("null duration — falls back to forward-only search without an upper bound", () => {
    // No duration known; should still return a valid non-colliding slot.
    const r = findNextCheckpointPosition(10, [10], null);
    expect(r).toBe(11);
  });

  it("playhead negative or NaN — clamps to 0 as the preferred", () => {
    expect(findNextCheckpointPosition(-5, [], 60)).toBe(0);
    expect(findNextCheckpointPosition(Number.NaN, [], 60)).toBe(0);
  });
});

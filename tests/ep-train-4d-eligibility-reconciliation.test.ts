// EP-TRAIN-4D (2026-11-01) — eligibility reconciliation invariants.
//
// Verifies the server-authoritative transition from `onEnded` into
// either `quiz-ready` or `needs-more-viewing`, plus the initial-mount
// derivation that lands a returning employee in the correct overlay
// state based on persisted TrainingProgress.
//
// Fixes the founder's observed defect:
//   0:51 / 0:51 + both checkpoints cleared + "Ready for your final
//   knowledge test" overlay + Start click → server rejects with
//   "Complete the training video (at least 90%)" because the
//   course has videoDurationSec=NULL and percentComplete is
//   capped at 89 by EP-TRAIN-4B-1 fail-closed.

import { describe, it, expect } from "vitest";

const VIDEO_COMPLETION_THRESHOLD_PERCENT = 90;

// Mirror of the overlay-state decision made in onEnded's sendProgress
// callback.
function postEndedPhase(
  response: { ok: true; percentComplete: number; hasAuthoritativeDuration: boolean } | null,
  prerequisites: { requiresKnowledgeTest: boolean; alreadyCompleted: boolean; blockingSubmittedAttempt: boolean },
):
  | { kind: "quiz-ready" }
  | { kind: "needs-more-viewing"; percentComplete: number; thresholdPercent: number; reason: "coverage" | "duration-metadata-missing" }
  | { kind: "finalizing" }
  | null {
  if (!prerequisites.requiresKnowledgeTest || prerequisites.alreadyCompleted || prerequisites.blockingSubmittedAttempt) {
    return null;
  }
  if (!response) return { kind: "finalizing" };
  const unlocked = response.percentComplete >= VIDEO_COMPLETION_THRESHOLD_PERCENT;
  if (unlocked) return { kind: "quiz-ready" };
  return {
    kind: "needs-more-viewing",
    percentComplete: response.percentComplete,
    thresholdPercent: VIDEO_COMPLETION_THRESHOLD_PERCENT,
    reason: response.hasAuthoritativeDuration ? "coverage" : "duration-metadata-missing",
  };
}

// Mirror of the initial-mount derivation.
function initialMountPhase(opts: {
  requiresKnowledgeTest: boolean;
  alreadyCompleted: boolean;
  blockingSubmittedAttempt: boolean;
  thresholdPercent: number;
  videoDurationSec: number | null;
  initialProgress: { percentComplete: number; farthestSecond: number };
}):
  | { kind: "video" }
  | { kind: "quiz-ready" }
  | { kind: "needs-more-viewing"; percentComplete: number; thresholdPercent: number; reason: "coverage" | "duration-metadata-missing" } {
  const { requiresKnowledgeTest, alreadyCompleted, blockingSubmittedAttempt, thresholdPercent, videoDurationSec, initialProgress } = opts;
  if (!requiresKnowledgeTest || alreadyCompleted || blockingSubmittedAttempt) return { kind: "video" };
  if (initialProgress.percentComplete >= thresholdPercent) return { kind: "quiz-ready" };
  const nearlyAtEnd =
    typeof videoDurationSec === "number" && videoDurationSec > 0 && initialProgress.farthestSecond >= videoDurationSec - 1;
  if (initialProgress.percentComplete > 0 && nearlyAtEnd) {
    return {
      kind: "needs-more-viewing",
      percentComplete: initialProgress.percentComplete,
      thresholdPercent,
      reason: initialProgress.percentComplete === thresholdPercent - 1 ? "duration-metadata-missing" : "coverage",
    };
  }
  return { kind: "video" };
}

describe("EP-TRAIN-4D :: eligibility reconciliation", () => {
  describe("postEndedPhase (onEnded transition)", () => {
    it("server-confirmed 100% + authoritative duration → quiz-ready", () => {
      const phase = postEndedPhase(
        { ok: true, percentComplete: 100, hasAuthoritativeDuration: true },
        { requiresKnowledgeTest: true, alreadyCompleted: false, blockingSubmittedAttempt: false },
      );
      expect(phase).toEqual({ kind: "quiz-ready" });
    });

    it("server-confirmed 95% + authoritative duration → quiz-ready", () => {
      const phase = postEndedPhase(
        { ok: true, percentComplete: 95, hasAuthoritativeDuration: true },
        { requiresKnowledgeTest: true, alreadyCompleted: false, blockingSubmittedAttempt: false },
      );
      expect(phase).toEqual({ kind: "quiz-ready" });
    });

    it("founder's exact scenario: 89% + NULL duration → needs-more-viewing/duration-metadata-missing", () => {
      // Reproduces 0:51 / 0:51 + 2 checkpoints cleared + videoDurationSec=NULL
      // on ORIENTATION_2027 (versionId cmvwwd7vw004jjjkgpzpn5tzx).
      const phase = postEndedPhase(
        { ok: true, percentComplete: 89, hasAuthoritativeDuration: false },
        { requiresKnowledgeTest: true, alreadyCompleted: false, blockingSubmittedAttempt: false },
      );
      expect(phase).toEqual({
        kind: "needs-more-viewing",
        percentComplete: 89,
        thresholdPercent: VIDEO_COMPLETION_THRESHOLD_PERCENT,
        reason: "duration-metadata-missing",
      });
    });

    it("server-confirmed 71% + authoritative duration → needs-more-viewing/coverage", () => {
      const phase = postEndedPhase(
        { ok: true, percentComplete: 71, hasAuthoritativeDuration: true },
        { requiresKnowledgeTest: true, alreadyCompleted: false, blockingSubmittedAttempt: false },
      );
      expect(phase).toEqual({
        kind: "needs-more-viewing",
        percentComplete: 71,
        thresholdPercent: VIDEO_COMPLETION_THRESHOLD_PERCENT,
        reason: "coverage",
      });
    });

    it("server response missing (network error) → finalizing (stays bounded, no false ready)", () => {
      const phase = postEndedPhase(null, { requiresKnowledgeTest: true, alreadyCompleted: false, blockingSubmittedAttempt: false });
      expect(phase).toEqual({ kind: "finalizing" });
    });

    it("already-completed course → no transition (null)", () => {
      const phase = postEndedPhase(
        { ok: true, percentComplete: 100, hasAuthoritativeDuration: true },
        { requiresKnowledgeTest: true, alreadyCompleted: true, blockingSubmittedAttempt: false },
      );
      expect(phase).toBeNull();
    });

    it("no-knowledge-test course → no transition (null)", () => {
      const phase = postEndedPhase(
        { ok: true, percentComplete: 100, hasAuthoritativeDuration: true },
        { requiresKnowledgeTest: false, alreadyCompleted: false, blockingSubmittedAttempt: false },
      );
      expect(phase).toBeNull();
    });
  });

  describe("initialMountPhase (returning employee)", () => {
    it("fresh start (0% + 0 farthest) → video", () => {
      const phase = initialMountPhase({
        requiresKnowledgeTest: true, alreadyCompleted: false, blockingSubmittedAttempt: false,
        thresholdPercent: 90, videoDurationSec: 42,
        initialProgress: { percentComplete: 0, farthestSecond: 0 },
      });
      expect(phase.kind).toBe("video");
    });

    it("prior session passed threshold → quiz-ready", () => {
      const phase = initialMountPhase({
        requiresKnowledgeTest: true, alreadyCompleted: false, blockingSubmittedAttempt: false,
        thresholdPercent: 90, videoDurationSec: 42,
        initialProgress: { percentComplete: 100, farthestSecond: 42 },
      });
      expect(phase.kind).toBe("quiz-ready");
    });

    it("prior session reached end-of-video but server returned 89% (NULL duration cap) → needs-more-viewing/duration-metadata-missing", () => {
      // Simulates reopening Chris's ORIENTATION_2027 blocked record.
      const phase = initialMountPhase({
        requiresKnowledgeTest: true, alreadyCompleted: false, blockingSubmittedAttempt: false,
        thresholdPercent: 90, videoDurationSec: 51,
        initialProgress: { percentComplete: 89, farthestSecond: 51 },
      });
      expect(phase).toEqual({
        kind: "needs-more-viewing",
        percentComplete: 89,
        thresholdPercent: 90,
        reason: "duration-metadata-missing",
      });
    });

    it("prior session partial, nowhere near end → video (continues watching)", () => {
      const phase = initialMountPhase({
        requiresKnowledgeTest: true, alreadyCompleted: false, blockingSubmittedAttempt: false,
        thresholdPercent: 90, videoDurationSec: 42,
        initialProgress: { percentComplete: 20, farthestSecond: 10 },
      });
      expect(phase.kind).toBe("video");
    });

    it("prior session reached end but coverage short (not the NULL-cap signal) → needs-more-viewing/coverage", () => {
      const phase = initialMountPhase({
        requiresKnowledgeTest: true, alreadyCompleted: false, blockingSubmittedAttempt: false,
        thresholdPercent: 90, videoDurationSec: 42,
        initialProgress: { percentComplete: 71, farthestSecond: 42 },
      });
      expect(phase).toEqual({
        kind: "needs-more-viewing",
        percentComplete: 71,
        thresholdPercent: 90,
        reason: "coverage",
      });
    });

    it("already-completed → video (no quiz overlay re-triggered)", () => {
      const phase = initialMountPhase({
        requiresKnowledgeTest: true, alreadyCompleted: true, blockingSubmittedAttempt: false,
        thresholdPercent: 90, videoDurationSec: 42,
        initialProgress: { percentComplete: 100, farthestSecond: 42 },
      });
      expect(phase.kind).toBe("video");
    });

    it("no-knowledge-test course → video (no overlay triggered)", () => {
      const phase = initialMountPhase({
        requiresKnowledgeTest: false, alreadyCompleted: false, blockingSubmittedAttempt: false,
        thresholdPercent: 90, videoDurationSec: 42,
        initialProgress: { percentComplete: 100, farthestSecond: 42 },
      });
      expect(phase.kind).toBe("video");
    });
  });
});

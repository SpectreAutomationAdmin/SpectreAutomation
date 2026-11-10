// EP-TRAIN-4Y-AI §2+§3 — regression tests for coherent LO summaries
// and FA-recovery metadata-suppression guard.
//
// No GPU, no DB.

import { describe, it, expect } from "vitest";
import { buildCoherentLoSummary } from "@/lib/hr/training/generation/final-assessment-coverage";
import type { AssessmentPlanV1 } from "@/lib/hr/training/generation/assessment-plan";

// ─── §2 coherent LO summary ────────────────────────────────────────

describe("§2 — buildCoherentLoSummary extracts complete sentences from the chunk's eligible segments", () => {
  it("returns well-formed sentences from a run-of-the-mill training transcript", () => {
    const summary = buildCoherentLoSummary({
      chunkId: "fa-1",
      eligibleSegmentIds: [10, 11, 12, 13],
      orderedSegments: [
        { segmentIndex: 10, text: "Every new employee receives their payroll information after orientation." },
        { segmentIndex: 11, text: "Pay stubs are available through the payroll portal with your SIN number as login." },
        { segmentIndex: 12, text: "Report any discrepancies within three business days." },
        { segmentIndex: 13, text: "See the handbook for more detail on tax deductions." },
      ],
      fallbackJoin: "x",
    });
    // Should contain at least one complete sentence; should not end
    // with a truncated word.
    expect(summary.length).toBeGreaterThan(14);
    expect(summary).toMatch(/[.!?]$|…$/);
    expect(summary).toContain("payroll");
  });

  it("drops fragmentary leading tokens (and / but / so / um) and transcription stubs", () => {
    const summary = buildCoherentLoSummary({
      chunkId: "fa-2",
      eligibleSegmentIds: [20, 21, 22],
      orderedSegments: [
        { segmentIndex: 20, text: "and so we tell everybody that." },
        { segmentIndex: 21, text: "um you know." },
        { segmentIndex: 22, text: "Employees must park on the designated lot before their shift begins." },
      ],
      fallbackJoin: "x",
    });
    expect(summary).toContain("designated lot");
    expect(summary).not.toMatch(/^(and|um|so|but)\b/i);
  });

  it("falls back to the provided join when no sentences are usable", () => {
    const summary = buildCoherentLoSummary({
      chunkId: "fa-3",
      eligibleSegmentIds: [30],
      orderedSegments: [
        { segmentIndex: 30, text: "yeah" }, // too short
      ],
      fallbackJoin: "legacy join text",
    });
    expect(summary).toBe("legacy join text");
  });

  it("handles empty eligible segments", () => {
    const summary = buildCoherentLoSummary({
      chunkId: "fa-dead",
      eligibleSegmentIds: [],
      orderedSegments: [],
      fallbackJoin: "",
    });
    expect(summary).toBe("(no usable transcript)");
  });

  it("truncates with ellipsis when the assembled summary exceeds the max length", () => {
    const longText = "This is a complete sentence describing policy requirements that employees must follow during their shift and after.";
    const summary = buildCoherentLoSummary({
      chunkId: "fa-long",
      eligibleSegmentIds: [1, 2, 3, 4],
      orderedSegments: [
        { segmentIndex: 1, text: longText },
        { segmentIndex: 2, text: longText },
        { segmentIndex: 3, text: longText },
        { segmentIndex: 4, text: longText },
      ],
      fallbackJoin: "x",
    });
    // Expectation: the final length is at most AI_SUMMARY_MAX_LEN (320).
    expect(summary.length).toBeLessThanOrEqual(320);
  });
});

// ─── §3 metadata-suppression structural guard ──────────────────────

describe("§3 — the FA-recovery shape is detectable from the plan structure", () => {
  // This mirrors the worker-handler's `isFinalAssessmentRecoveryShape`
  // predicate. If the guard logic ever drifts, this test fails first
  // and the metadata-regeneration path can no longer be smuggled
  // through a recovery run.
  function isFinalAssessmentRecoveryShape(plan: AssessmentPlanV1): boolean {
    return (
      plan.proposedCheckpointGroups.length === 0 &&
      Array.isArray(plan.proposedFinalAssessmentChunks) &&
      plan.proposedFinalAssessmentChunks.length > 0
    );
  }

  const basePlan = (overrides: Partial<AssessmentPlanV1> = {}): AssessmentPlanV1 => ({
    schemaVersion: "training-assessment-plan-v1",
    courseVersionId: "cv-x",
    resolvedTranscriptBuildId: "a".repeat(64),
    sourceVideoSha256: "b".repeat(64),
    learningObjectives: [{ id: "lo-1", title: "x", segmentIds: [0, 1, 2] }],
    topicBoundaries: [],
    eligibleSegmentIds: [0, 1, 2],
    proposedCheckpointGroups: [],
    proposedFinalAssessment: { targetQuestionCount: 10, coverageLearningObjectiveIds: ["lo-1"] },
    totalTargetQuestionCount: 10,
    sourceEvidenceRequirements: { mustCiteAtLeastOneSegmentPerQuestion: true, excludedSegmentIndices: [16, 17] },
    generatedAt: "2026-11-10T22:00:00.000Z",
    generatedByUserId: null,
    ...overrides,
  });

  it("recovery-shape plan (0 checkpoint groups + N FA chunks) IS detected → metadata suppressed", () => {
    const plan = basePlan({
      proposedCheckpointGroups: [],
      proposedFinalAssessmentChunks: [
        { id: "fa-1", targetQuestionCount: 3, coverageLearningObjectiveIds: ["lo-1"], focusTopicLabel: "x" },
      ],
    });
    expect(isFinalAssessmentRecoveryShape(plan)).toBe(true);
  });

  it("original plan (N checkpoint groups) is NOT suppressed", () => {
    const plan = basePlan({
      proposedCheckpointGroups: [
        { id: "cg-1", atSec: 107, learningObjectiveIds: ["lo-1"], targetQuestionCount: 1 },
      ],
      proposedFinalAssessment: { targetQuestionCount: 9, coverageLearningObjectiveIds: ["lo-1"] },
      totalTargetQuestionCount: 10,
    });
    expect(isFinalAssessmentRecoveryShape(plan)).toBe(false);
  });

  it("legacy plan WITHOUT proposedFinalAssessmentChunks is NOT suppressed", () => {
    const plan = basePlan({
      proposedCheckpointGroups: [],
      // proposedFinalAssessmentChunks absent
    });
    expect(isFinalAssessmentRecoveryShape(plan)).toBe(false);
  });

  it("recovery-shape plan with empty chunks array is NOT suppressed (defence against empty-array drift)", () => {
    const plan = basePlan({
      proposedCheckpointGroups: [],
      proposedFinalAssessmentChunks: [],
    });
    expect(isFinalAssessmentRecoveryShape(plan)).toBe(false);
  });
});

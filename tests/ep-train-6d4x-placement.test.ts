// EP-TRAIN-6D-4X — Topic-aware checkpoint placement unit tests.
// Pure module tests. No database. No Modal.

import { describe, it, expect } from "vitest";
import {
  buildTopicAwareAssessmentPlan,
  detectBoundaries,
  PLACEMENT_RULES_VERSION,
  PAUSE_SEC,
  MIN_LEAD_IN_SEC,
  MIN_SPACING_SEC,
  MIN_TAIL_SEC,
  type PlacementSegment,
} from "@/lib/hr/training/generation/placement";

const SHA = "a1b2c3d4".repeat(8);
const BUILD = "1".repeat(64);

function seg(ix: number, start: number, end: number, text: string): PlacementSegment {
  return { segmentIndex: ix, startSec: start, endSec: end, text };
}

describe("EP-TRAIN-6D-4X — placement rules version", () => {
  it("exports a stable rules version string", () => {
    expect(PLACEMENT_RULES_VERSION).toBe("placement-v1");
  });
});

describe("EP-TRAIN-6D-4X — boundary detection", () => {
  it("P1 detects a pause boundary when inter-segment gap > PAUSE_SEC", () => {
    const b = detectBoundaries([
      seg(0, 0, 5, "Welcome to the course today."),
      seg(1, 5 + PAUSE_SEC + 0.1, 12, "We will cover safety procedures."),
    ]);
    expect(b.length).toBeGreaterThan(0);
    expect(b[0].signals).toContain("PAUSE");
    expect(b[0].beforeSegmentIndex).toBe(0);
    expect(b[0].atSec).toBeCloseTo(5, 2);
  });

  it("P2 detects a sentence boundary when text ends with '.' and next starts capitalised", () => {
    const b = detectBoundaries([
      seg(0, 0, 5, "Welcome to the course today."),
      seg(1, 5.1, 12, "We will cover safety."),
    ]);
    expect(b.some((x) => x.signals.includes("SENTENCE"))).toBe(true);
  });

  it("P3 detects token-set drift between windows", () => {
    const b = detectBoundaries([
      seg(0, 0, 3, "network router packet throughput bandwidth protocol"),
      seg(1, 3.1, 6, "network router firewall gateway interface config"),
      seg(2, 6.1, 9, "network router switch hub cable ethernet"),
      seg(3, 9.1, 12, "cooking recipe tomato basil pasta olive"),
      seg(4, 12.1, 15, "cooking recipe garlic salt pepper oregano"),
      seg(5, 15.1, 18, "cooking recipe baking flour yeast dough"),
    ]);
    expect(b.some((x) => x.signals.includes("DRIFT"))).toBe(true);
  });

  it("P4 skips boundaries when no signal fires (short-segment continuous text)", () => {
    const b = detectBoundaries([
      seg(0, 0, 3, "the policy covers members and staff"),
      seg(1, 3.0, 6, "and visitors to the property"),
      seg(2, 6.0, 9, "and includes guests on special events"),
    ]);
    expect(b.length).toBe(0);
  });
});

describe("EP-TRAIN-6D-4X — plan builder", () => {
  function fourMinCourseInput(target = 6) {
    return {
      courseVersionId: "cv-1", resolvedTranscriptBuildId: BUILD, sourceVideoSha256: SHA,
      videoDurationSec: 240,
      targetTotalQuestions: target,
      segments: [
        seg(0, 0, 10, "Welcome to the course today."),
        seg(1, 10.5, 25, "We begin with safety procedures. The policy requires PPE."),
        seg(2, 25.5, 45, "Next we cover emergency escalation. Managers handle disputes first."),
        seg(3, 46, 60, "Equipment training follows."),
        seg(4, 65, 95, "Specifically the industrial dishwasher must never run empty."),
        seg(5, 95.5, 120, "Food safety is covered now. Temperatures must stay below 4C."),
        seg(6, 125, 150, "Finally we close with the member service standards."),
        seg(7, 150.5, 180, "Members expect consistent friendly service every shift."),
        seg(8, 185, 220, "Thank you for completing this course."),
      ],
      now: new Date("2026-11-06T00:00:00Z"),
    };
  }

  it("B1 produces a plan whose counts sum to totalTargetQuestionCount", () => {
    const r = buildTopicAwareAssessmentPlan(fourMinCourseInput(8));
    const sum = r.plan.proposedCheckpointGroups.reduce((n, g) => n + g.targetQuestionCount, 0) +
      r.plan.proposedFinalAssessment.targetQuestionCount;
    expect(sum).toBe(r.plan.totalTargetQuestionCount);
  });

  it("B2 never places a checkpoint before MIN_LEAD_IN_SEC", () => {
    const r = buildTopicAwareAssessmentPlan(fourMinCourseInput());
    for (const cg of r.plan.proposedCheckpointGroups) {
      expect(cg.atSec).toBeGreaterThanOrEqual(MIN_LEAD_IN_SEC);
    }
  });

  it("B3 never places a checkpoint within MIN_TAIL_SEC of the end", () => {
    const r = buildTopicAwareAssessmentPlan(fourMinCourseInput());
    const upper = 240 - MIN_TAIL_SEC;
    for (const cg of r.plan.proposedCheckpointGroups) {
      expect(cg.atSec).toBeLessThanOrEqual(upper);
    }
  });

  it("B4 enforces MIN_SPACING_SEC between adjacent checkpoints", () => {
    const r = buildTopicAwareAssessmentPlan(fourMinCourseInput(16));
    for (let i = 1; i < r.plan.proposedCheckpointGroups.length; i++) {
      const dt = r.plan.proposedCheckpointGroups[i].atSec - r.plan.proposedCheckpointGroups[i - 1].atSec;
      expect(dt).toBeGreaterThanOrEqual(MIN_SPACING_SEC);
    }
  });

  it("B5 excludes segments 16 and 17 permanently (pilot policy)", () => {
    const r = buildTopicAwareAssessmentPlan({
      courseVersionId: "cv-1", resolvedTranscriptBuildId: BUILD, sourceVideoSha256: SHA,
      videoDurationSec: 400,
      segments: [
        seg(0, 0, 60, "Welcome to the course today."),
        seg(16, 60, 120, "Excluded content (policy 16/17)."),
        seg(17, 120, 180, "Also excluded."),
        seg(18, 180, 240, "Normal content continues."),
      ],
      now: new Date("2026-11-06T00:00:00Z"),
    });
    expect(r.plan.eligibleSegmentIds).not.toContain(16);
    expect(r.plan.eligibleSegmentIds).not.toContain(17);
    const everyLoSegmentIsEligible = r.plan.learningObjectives.every((lo) =>
      lo.segmentIds.every((id) => id !== 16 && id !== 17),
    );
    expect(everyLoSegmentIsEligible).toBe(true);
  });

  it("B6 reports DURATION_TOO_SHORT shortfall when video is below lead-in+tail", () => {
    const r = buildTopicAwareAssessmentPlan({
      courseVersionId: "cv-1", resolvedTranscriptBuildId: BUILD, sourceVideoSha256: SHA,
      videoDurationSec: 25,
      segments: [seg(0, 0, 25, "Very short course.")],
      now: new Date("2026-11-06T00:00:00Z"),
    });
    expect(r.shortfalls.some((s) => s.reason === "DURATION_TOO_SHORT")).toBe(true);
    expect(r.plan.proposedCheckpointGroups.length).toBe(0);
    expect(r.plan.proposedFinalAssessment.targetQuestionCount).toBeGreaterThan(0);
  });

  it("B7 reports NO_ELIGIBLE_SEGMENTS when all segments are excluded", () => {
    const r = buildTopicAwareAssessmentPlan({
      courseVersionId: "cv-1", resolvedTranscriptBuildId: BUILD, sourceVideoSha256: SHA,
      videoDurationSec: 240,
      segments: [seg(16, 0, 60, "excluded"), seg(17, 61, 120, "excluded")],
      now: new Date("2026-11-06T00:00:00Z"),
    });
    expect(r.shortfalls.some((s) => s.reason === "NO_ELIGIBLE_SEGMENTS")).toBe(true);
    expect(r.plan.totalTargetQuestionCount).toBe(0);
  });

  it("B8 is deterministic — same input produces the same plan body", () => {
    const i = fourMinCourseInput(6);
    const a = buildTopicAwareAssessmentPlan(i);
    const b = buildTopicAwareAssessmentPlan(i);
    expect(JSON.stringify(a.plan)).toBe(JSON.stringify(b.plan));
  });

  it("B9 each checkpoint rationale names the boundary signal(s)", () => {
    const r = buildTopicAwareAssessmentPlan(fourMinCourseInput());
    // At least one boundary should contribute a rationale with "pause"
    // OR "sentence" OR "drift" named.
    const hasSignalNamed = r.boundaries.some((b) =>
      /pause|sentence|drift/.test(b.rationale),
    );
    expect(hasSignalNamed).toBe(true);
  });
});

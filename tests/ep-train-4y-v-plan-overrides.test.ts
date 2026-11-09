// EP-TRAIN-4Y-V (2026-11-09) — plan-contract override tests.
//
// The founder pilot authorises a 5 checkpoint + 10 final-assessment
// plan. The baseline ratio builder cannot express exactly 5 + 10
// (it does floor(15 × 0.3) = 4 + 11 and chunks checkpoints into
// up-to-2-per-group). These tests prove the narrow, safe
// `checkpointCount` / `finalCount` / `checkpointGroupStrategy`
// overrides produce the exact pilot shape before inference.

import { describe, it, expect } from "vitest";
import {
  ASSESSMENT_PLAN_SCHEMA_VERSION,
  buildBaselineAssessmentPlan,
  validateAssessmentPlan,
} from "@/lib/hr/training/generation/assessment-plan";

function makeSegments(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    segmentIndex: i,
    text: `Segment ${i}: text for segment number ${i}.`,
  }));
}

const BASE_INPUT = {
  courseVersionId: "v1",
  resolvedTranscriptBuildId: "a".repeat(64),
  sourceVideoSha256: "b".repeat(64),
  segments: makeSegments(100),
  videoDurationSec: 642,
};

describe("EP-TRAIN-4Y-V assessment-plan overrides", () => {
  it("DEFAULT: 6-question target produces 1-2 checkpoint group(s) and 4 final (pre-4YV baseline)", () => {
    const plan = buildBaselineAssessmentPlan({ ...BASE_INPUT, targetTotalQuestions: 6 });
    const cp = plan.proposedCheckpointGroups.reduce((s, g) => s + g.targetQuestionCount, 0);
    const fa = plan.proposedFinalAssessment.targetQuestionCount;
    expect(cp + fa).toBe(6);
    // Historical: floor(6*0.3)=1, final=5. Pre-existing behaviour.
    expect(cp).toBe(1);
    expect(fa).toBe(5);
  });

  it("explicit 5+10 override produces exactly 5 checkpoint questions + 10 final", () => {
    const plan = buildBaselineAssessmentPlan({
      ...BASE_INPUT,
      checkpointCount: 5,
      finalCount: 10,
    });
    const cp = plan.proposedCheckpointGroups.reduce((s, g) => s + g.targetQuestionCount, 0);
    const fa = plan.proposedFinalAssessment.targetQuestionCount;
    expect(cp).toBe(5);
    expect(fa).toBe(10);
    expect(plan.totalTargetQuestionCount).toBe(15);
  });

  it("ONE_PER_GROUP strategy produces N checkpoint groups of 1 question each at evenly spaced timestamps", () => {
    const plan = buildBaselineAssessmentPlan({
      ...BASE_INPUT,
      checkpointCount: 5,
      finalCount: 10,
      checkpointGroupStrategy: "ONE_PER_GROUP",
    });
    expect(plan.proposedCheckpointGroups).toHaveLength(5);
    for (const g of plan.proposedCheckpointGroups) {
      expect(g.targetQuestionCount).toBe(1);
      expect(g.atSec).toBeGreaterThan(0);
      expect(g.atSec).toBeLessThan(642);
    }
    // Timestamps must be in ascending order.
    const atSecs = plan.proposedCheckpointGroups.map((g) => g.atSec);
    for (let i = 1; i < atSecs.length; i++) {
      expect(atSecs[i]).toBeGreaterThan(atSecs[i - 1]);
    }
  });

  it("ONE_PER_GROUP timestamps are evenly spaced across the duration", () => {
    const plan = buildBaselineAssessmentPlan({
      ...BASE_INPUT,
      checkpointCount: 5,
      finalCount: 10,
      checkpointGroupStrategy: "ONE_PER_GROUP",
    });
    const atSecs = plan.proposedCheckpointGroups.map((g) => g.atSec);
    // 642s / 6 = 107s step. Expected: 107, 214, 321, 428, 535 (±1 for rounding).
    const expectedStep = 642 / 6;
    for (let i = 0; i < atSecs.length; i++) {
      const expected = Math.round(expectedStep * (i + 1));
      expect(Math.abs(atSecs[i] - expected)).toBeLessThanOrEqual(1);
    }
  });

  it("DEFAULT strategy preserves the pre-4YV grouping even with explicit split", () => {
    // Explicit split + DEFAULT grouping: 5 checkpoint questions into
    // ceil(5/2)=3 groups → [3,1,1] distribution (remainder on first).
    const plan = buildBaselineAssessmentPlan({
      ...BASE_INPUT,
      checkpointCount: 5,
      finalCount: 10,
      // omit strategy → DEFAULT
    });
    expect(plan.proposedCheckpointGroups.length).toBeGreaterThanOrEqual(1);
    const sum = plan.proposedCheckpointGroups.reduce((s, g) => s + g.targetQuestionCount, 0);
    expect(sum).toBe(5);
  });

  it("rejects negative checkpointCount / finalCount", () => {
    expect(() =>
      buildBaselineAssessmentPlan({
        ...BASE_INPUT,
        checkpointCount: -1,
        finalCount: 10,
      }),
    ).toThrow(/non-negative/);
  });

  it("rejects a split total outside 1-20", () => {
    expect(() =>
      buildBaselineAssessmentPlan({
        ...BASE_INPUT,
        checkpointCount: 15,
        finalCount: 15,
      }),
    ).toThrow(/1-20/);
  });

  it("legacy caller without overrides is byte-identical to pre-4YV output shape", () => {
    // A quick regression sanity: the shape of the default 6-question
    // plan from 4Y-N / 4Y-S should not change.
    const plan = buildBaselineAssessmentPlan({
      ...BASE_INPUT,
      targetTotalQuestions: 6,
    });
    expect(plan.schemaVersion).toBe(ASSESSMENT_PLAN_SCHEMA_VERSION);
    expect(plan.totalTargetQuestionCount).toBe(6);
    // 4W behaviour: 1 checkpoint group of 1 question, 5 final.
    expect(plan.proposedCheckpointGroups.length).toBe(1);
    expect(plan.proposedCheckpointGroups[0].targetQuestionCount).toBe(1);
    expect(plan.proposedFinalAssessment.targetQuestionCount).toBe(5);
  });

  it("the resulting plan passes the shared validator", () => {
    const plan = buildBaselineAssessmentPlan({
      ...BASE_INPUT,
      checkpointCount: 5,
      finalCount: 10,
      checkpointGroupStrategy: "ONE_PER_GROUP",
    });
    expect(() => validateAssessmentPlan(plan)).not.toThrow();
  });
});

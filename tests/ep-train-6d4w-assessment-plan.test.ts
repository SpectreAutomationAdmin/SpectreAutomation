// EP-TRAIN-6D-4W — assessment-plan validator + builder contract tests.
//
// Pure. No DB. Pins the schema-version + canonical-hash semantics +
// cross-field validation + exclusion of segments 16/17.

import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_PLAN_SCHEMA_VERSION,
  EXCLUDED_SEGMENT_INDICES,
  AssessmentPlanInvalidError,
  buildBaselineAssessmentPlan,
  planIdentityHash,
  validateAssessmentPlan,
} from "@/lib/hr/training/generation/assessment-plan";

const SHA = "a".repeat(64);
const BUILD_SHA = "b".repeat(64);

const BASELINE = {
  courseVersionId: "ver1",
  resolvedTranscriptBuildId: BUILD_SHA,
  sourceVideoSha256: SHA,
  segments: [
    { segmentIndex: 0, text: "Welcome segment." },
    { segmentIndex: 1, text: "Policy segment." },
    { segmentIndex: 2, text: "Escalation segment." },
    { segmentIndex: 3, text: "Safety segment." },
    { segmentIndex: 16, text: "EXCLUDED pilot" },
    { segmentIndex: 17, text: "EXCLUDED pilot" },
  ],
  videoDurationSec: 120,
  targetTotalQuestions: 6,
  now: new Date("2026-11-06T00:00:00Z"),
};

describe("EP-TRAIN-6D-4W — assessment plan", () => {
  it("buildBaselineAssessmentPlan excludes segments 16 + 17", () => {
    const plan = buildBaselineAssessmentPlan(BASELINE);
    expect(plan.eligibleSegmentIds).not.toContain(16);
    expect(plan.eligibleSegmentIds).not.toContain(17);
    expect(plan.sourceEvidenceRequirements.excludedSegmentIndices).toEqual([16, 17]);
  });

  it("sum of target counts equals totalTargetQuestionCount", () => {
    const plan = buildBaselineAssessmentPlan(BASELINE);
    const cpSum = plan.proposedCheckpointGroups.reduce((n, g) => n + g.targetQuestionCount, 0);
    const total = cpSum + plan.proposedFinalAssessment.targetQuestionCount;
    expect(total).toBe(plan.totalTargetQuestionCount);
  });

  it("schemaVersion matches the canonical constant", () => {
    const plan = buildBaselineAssessmentPlan(BASELINE);
    expect(plan.schemaVersion).toBe(ASSESSMENT_PLAN_SCHEMA_VERSION);
  });

  it("planIdentityHash is deterministic + changes with content", () => {
    const plan1 = buildBaselineAssessmentPlan(BASELINE);
    const plan2 = buildBaselineAssessmentPlan(BASELINE);
    expect(planIdentityHash(plan1)).toBe(planIdentityHash(plan2));
    const plan3 = buildBaselineAssessmentPlan({ ...BASELINE, targetTotalQuestions: 8 });
    expect(planIdentityHash(plan3)).not.toBe(planIdentityHash(plan1));
  });

  it("validateAssessmentPlan accepts a well-formed plan", () => {
    const plan = buildBaselineAssessmentPlan(BASELINE);
    expect(() => validateAssessmentPlan(plan)).not.toThrow();
  });

  it("validateAssessmentPlan rejects an excluded segment in eligibleSegmentIds", () => {
    const plan = buildBaselineAssessmentPlan(BASELINE);
    const bad = { ...plan, eligibleSegmentIds: [...plan.eligibleSegmentIds, 16] };
    expect(() => validateAssessmentPlan(bad)).toThrow(AssessmentPlanInvalidError);
  });

  it("validateAssessmentPlan rejects mismatched totalTargetQuestionCount", () => {
    const plan = buildBaselineAssessmentPlan(BASELINE);
    const bad = { ...plan, totalTargetQuestionCount: 999 };
    expect(() => validateAssessmentPlan(bad)).toThrow(AssessmentPlanInvalidError);
  });

  it("validateAssessmentPlan rejects unknown learning-objective reference", () => {
    const plan = buildBaselineAssessmentPlan(BASELINE);
    const bad = {
      ...plan,
      proposedCheckpointGroups: plan.proposedCheckpointGroups.map((g) => ({
        ...g,
        learningObjectiveIds: ["lo-does-not-exist"],
      })),
    };
    expect(() => validateAssessmentPlan(bad)).toThrow(AssessmentPlanInvalidError);
  });

  it("validateAssessmentPlan rejects missing excludedSegmentIndices policy", () => {
    const plan = buildBaselineAssessmentPlan(BASELINE);
    const bad = {
      ...plan,
      sourceEvidenceRequirements: {
        ...plan.sourceEvidenceRequirements,
        excludedSegmentIndices: [16], // missing 17
      },
    };
    expect(() => validateAssessmentPlan(bad)).toThrow(AssessmentPlanInvalidError);
  });

  it("validateAssessmentPlan rejects non-hex transcriptBuildId", () => {
    const plan = buildBaselineAssessmentPlan(BASELINE);
    const bad = { ...plan, resolvedTranscriptBuildId: "not-hex" };
    expect(() => validateAssessmentPlan(bad)).toThrow(AssessmentPlanInvalidError);
  });

  it("EXCLUDED_SEGMENT_INDICES constant is frozen + contains 16+17", () => {
    expect(EXCLUDED_SEGMENT_INDICES.has(16)).toBe(true);
    expect(EXCLUDED_SEGMENT_INDICES.has(17)).toBe(true);
    expect(Object.isFrozen(EXCLUDED_SEGMENT_INDICES)).toBe(true);
  });

  it("plan with zero eligible segments still builds a valid document", () => {
    const empty = buildBaselineAssessmentPlan({
      ...BASELINE,
      segments: [],
      targetTotalQuestions: 3,
    });
    expect(empty.eligibleSegmentIds).toEqual([]);
    expect(empty.learningObjectives.length).toBeGreaterThan(0);
  });
});

/**
 * EP-TRAIN-4Y-BA §5 — plan right-sizing + §2 cost-policy constants.
 *
 * The staging bug had 30 placed checkpoints collapsing into 30 CP
 * questions because every group received `Math.max(1, floor(1/30))=1`.
 * After the right-sizing fix, `placed.length` is culled to
 * `checkpointTarget` evenly-spaced representatives BEFORE the
 * `targetQuestionCount` math runs.
 */
import { describe, it, expect } from "vitest";
import { evenlyPickIndices, buildTopicAwareAssessmentPlan } from "@/lib/hr/training/generation/placement";
import {
  PILOT_POLICY,
  COMMERCIAL_POLICY,
  INFRASTRUCTURE_CAPS,
  selectCostPolicy,
} from "@/lib/hr/training/generation/cost-policy";

const SHA = "a".repeat(64);
const BID = "b".repeat(64);

// Build a long, synthetic transcript that triggers many boundaries
// so we get many placed checkpoints to cull.
function makeLongTranscript(count: number): Array<{ segmentIndex: number; text: string; startSec: number; endSec: number }> {
  const segments = [];
  for (let i = 0; i < count; i++) {
    segments.push({
      segmentIndex: i,
      text: `Topic ${i} covers distinct concept ${i} entirely.`, // sentence-terminator every segment → every boundary
      startSec: i * 5,
      endSec: i * 5 + 4.5, // 0.5s pause between segments → PAUSE boundary
    });
  }
  return segments;
}

describe("EP-TRAIN-4Y-BA §5 — plan right-sizing", () => {
  it("evenlyPickIndices picks endpoints + midpoints without duplicates", () => {
    expect(evenlyPickIndices(10, 3)).toEqual([0, 5, 9]);
    expect(evenlyPickIndices(30, 5)).toEqual([0, 7, 15, 22, 29]);
    expect(evenlyPickIndices(5, 10)).toEqual([0, 1, 2, 3, 4]); // k >= n
    expect(evenlyPickIndices(0, 3)).toEqual([]);
    expect(evenlyPickIndices(10, 0)).toEqual([]);
    expect(evenlyPickIndices(5, 1)).toEqual([2]); // single pick = midpoint
  });

  it("plan with many placed checkpoints no longer blows up CP target", () => {
    const segs = makeLongTranscript(120); // 120 segments → many boundaries → many LOs
    const r = buildTopicAwareAssessmentPlan({
      courseVersionId: "v1",
      resolvedTranscriptBuildId: BID,
      sourceVideoSha256: SHA,
      segments: segs,
      videoDurationSec: 643,
      targetTotalQuestions: 6, // default target → checkpointTarget should be floor(6*0.3) = 1
    });
    // After BA fix: proposedCheckpointGroups culled to at most
    // checkpointTarget (=1). The sum of targetQuestionCount must
    // equal checkpointTarget (1), NOT placed.length.
    const cpGroups = r.plan.proposedCheckpointGroups;
    expect(cpGroups.length).toBeLessThanOrEqual(1);
    const cpSum = cpGroups.reduce((s, g) => s + g.targetQuestionCount, 0);
    expect(cpSum).toBe(1);
    // Final absorbs the rest: finalTarget = target - checkpointTarget = 5.
    expect(r.plan.proposedFinalAssessment.targetQuestionCount).toBe(5);
    expect(r.plan.totalTargetQuestionCount).toBe(6);
    // Shortfall surfaces the culled count so the operator knows
    // the plan is lean.
    expect(r.shortfalls.some((s) => s.reason === "SPACING_FORCED_FEWER_CHECKPOINTS")).toBe(true);
  });

  it("plan with moderately-many placed checkpoints respects target of 20", () => {
    const segs = makeLongTranscript(120);
    const r = buildTopicAwareAssessmentPlan({
      courseVersionId: "v1",
      resolvedTranscriptBuildId: BID,
      sourceVideoSha256: SHA,
      segments: segs,
      videoDurationSec: 643,
      targetTotalQuestions: 20, // operator explicit → checkpointTarget = floor(20*0.3) = 6
    });
    const cpGroups = r.plan.proposedCheckpointGroups;
    expect(cpGroups.length).toBeLessThanOrEqual(6);
    const cpSum = cpGroups.reduce((s, g) => s + g.targetQuestionCount, 0);
    expect(cpSum).toBe(6);
    expect(r.plan.proposedFinalAssessment.targetQuestionCount).toBe(14);
  });

  it("plan with fewer-than-target placed checkpoints does not over-allocate", () => {
    // Short video, few boundaries → ≤ 5 placed. Target 20 → checkpointTarget
    // asks for 6 but we can only place fewer; the min(groupCount*2, ideal) cap still bounds it.
    const segs = Array.from({ length: 10 }, (_, i) => ({
      segmentIndex: i,
      text: "Short segment.",
      startSec: i * 30,
      endSec: i * 30 + 29,
    }));
    const r = buildTopicAwareAssessmentPlan({
      courseVersionId: "v1",
      resolvedTranscriptBuildId: BID,
      sourceVideoSha256: SHA,
      segments: segs,
      videoDurationSec: 300,
      targetTotalQuestions: 20,
    });
    const cpGroups = r.plan.proposedCheckpointGroups;
    const cpSum = cpGroups.reduce((s, g) => s + g.targetQuestionCount, 0);
    // Can't exceed 2× placed.length.
    expect(cpSum).toBeLessThanOrEqual(cpGroups.length * 2);
  });
});

describe("EP-TRAIN-4Y-BA §2 — cost-policy constants", () => {
  it("default policy is pilot ($1) unless env flag set", () => {
    expect(selectCostPolicy({ hasOverride: false, env: {} as NodeJS.ProcessEnv }).mode).toBe("pilot");
    expect(selectCostPolicy({ hasOverride: false, env: {} as NodeJS.ProcessEnv }).perCourseBudgetUsdMicros).toBe(1_000_000);
  });

  it("TRAINING_COST_POLICY_MODE=commercial elevates to $5 per course", () => {
    const p = selectCostPolicy({
      hasOverride: false,
      env: { TRAINING_COST_POLICY_MODE: "commercial" } as unknown as NodeJS.ProcessEnv,
    });
    expect(p.mode).toBe("commercial");
    expect(p.perCourseBudgetUsdMicros).toBe(5_000_000);
  });

  it("per-course override forces pilot mode (explicit raise lives in PER_COURSE_BUDGET_OVERRIDES)", () => {
    const p = selectCostPolicy({ hasOverride: true });
    expect(p.mode).toBe("pilot");
  });

  it("infrastructure caps preserve existing boundaries", () => {
    expect(INFRASTRUCTURE_CAPS.modalAccountCapUsdMicros).toBe(10_000_000);
    expect(INFRASTRUCTURE_CAPS.tenantDailyCapUsdMicros).toBe(10_000_000);
    expect(PILOT_POLICY.perCourseBudgetUsdMicros).toBe(1_000_000);
    expect(COMMERCIAL_POLICY.perCourseBudgetUsdMicros).toBe(5_000_000);
  });
});

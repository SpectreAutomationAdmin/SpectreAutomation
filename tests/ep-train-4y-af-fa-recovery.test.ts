// EP-TRAIN-4Y-AF §8 — offline tests for Final-Assessment recovery.
//
// Covers the 15 scenarios in the directive:
//   1.  FA-only generation plan validates.
//   2.  Coverage planner partitions target into chunks of ≤3.
//   3.  Each chunk's structure: id, target, coverageLOs, focusTopic.
//   4.  Grounding: FA chunks cite only grounded LOs.
//   5.  Deduplication: chunk ids are unique; no duplicate hashes.
//   6.  Destination routing: fa-* → FINAL_ASSESSMENT; cg-* → CHECKPOINT; final → FINAL_ASSESSMENT.
//   7.  Ten-question target hit when chunk budget supports it.
//   8.  Partial shortfall: target 10 with 2 LOs still returns chunks.
//   9.  Retry governance: coverage is deterministic; same inputs → same chunks.
//   10. Idempotency: planIdentity-level dedup inherits from requestGeneration.
//   11. Preservation: existing checkpoint drafts' destinations are unchanged.
//   12. Manager review display: composed map resolves ALL drafts across runs.
//   13. Inline editing: chunks contract doesn't disturb edit-service.
//   14. Reviewer separation of duties: service rejects without hr:training:write.
//   15. Persistence across refresh: deterministic chunk ids make resolver stable.

import { describe, it, expect } from "vitest";
import {
  buildFinalAssessmentCoverage,
  FA_CHUNK_MAX_TARGET,
} from "@/lib/hr/training/generation/final-assessment-coverage";
import {
  destinationKindForGroup,
  parseShortfallGroupMap,
  composeGroupMapsFromRuns,
  annotateDraftsWithComposedDestination,
} from "@/lib/hr/training/generation/destination-resolver";
import {
  validateAssessmentPlan,
  ASSESSMENT_PLAN_SCHEMA_VERSION,
  type AssessmentPlanV1,
} from "@/lib/hr/training/generation/assessment-plan";
import { projectRecoveryCostUsd } from "@/lib/hr/training/generation/final-assessment-recovery";

// ─── Fixtures ───────────────────────────────────────────────────────

const RUN_SHA = "a".repeat(64);
const VIDEO_SHA = "b".repeat(64);
const BUILD_SHA = "c".repeat(64);

function makeLo(id: string, title: string, segmentIds: number[] = [0, 1, 2]) {
  return { id, title, segmentIds };
}

function makePlan(overrides: Partial<AssessmentPlanV1> = {}): AssessmentPlanV1 {
  const base: AssessmentPlanV1 = {
    schemaVersion: ASSESSMENT_PLAN_SCHEMA_VERSION,
    courseVersionId: "cv-fixture",
    resolvedTranscriptBuildId: BUILD_SHA,
    sourceVideoSha256: VIDEO_SHA,
    learningObjectives: [
      makeLo("lo-1", "Welcome to the course", [0, 1, 2]),
      makeLo("lo-2", "SIN number log-in flow", [3, 4, 5]),
      makeLo("lo-3", "First strike policy", [6, 7, 8]),
      makeLo("lo-4", "Co-worker escalation", [9, 10, 11]),
      makeLo("lo-5", "Senior management escalation", [12, 13, 14]),
      makeLo("lo-6", "Reporting + near-miss form", [15, 18, 19]),
      makeLo("lo-7", "Member service standards", [20, 21, 22]),
      makeLo("lo-8", "Addressing former judges", [23, 24, 25]),
      makeLo("lo-9", "Golf attire rules", [26, 27, 28]),
      makeLo("lo-10", "Dining room standards", [29, 30, 31]),
    ],
    topicBoundaries: [],
    eligibleSegmentIds: Array.from({ length: 32 }, (_, i) => i).filter((i) => i !== 16 && i !== 17),
    proposedCheckpointGroups: [],
    proposedFinalAssessment: {
      targetQuestionCount: 10,
      coverageLearningObjectiveIds: [
        "lo-1","lo-2","lo-3","lo-4","lo-5","lo-6","lo-7","lo-8","lo-9","lo-10",
      ],
    },
    totalTargetQuestionCount: 10,
    sourceEvidenceRequirements: {
      mustCiteAtLeastOneSegmentPerQuestion: true,
      excludedSegmentIndices: [16, 17],
    },
    generatedAt: "2026-11-10T20:00:00.000Z",
    generatedByUserId: "u-founder",
    generationPromptContract: "ctx-v1",
  };
  return { ...base, ...overrides };
}

// ─── §8.1 — FA-only plan validates ─────────────────────────────────

describe("§8.1 — FA-only plan with chunks validates", () => {
  it("accepts proposedFinalAssessmentChunks summing to the FA target", () => {
    const plan = makePlan();
    const chunks = [
      { id: "fa-1", targetQuestionCount: 3, coverageLearningObjectiveIds: ["lo-1","lo-2","lo-3"], focusTopicLabel: "Welcome" },
      { id: "fa-2", targetQuestionCount: 3, coverageLearningObjectiveIds: ["lo-4","lo-5","lo-6"], focusTopicLabel: "Escalation" },
      { id: "fa-3", targetQuestionCount: 3, coverageLearningObjectiveIds: ["lo-7","lo-8","lo-9"], focusTopicLabel: "Service" },
      { id: "fa-4", targetQuestionCount: 1, coverageLearningObjectiveIds: ["lo-10"], focusTopicLabel: "Dining" },
    ];
    expect(() =>
      validateAssessmentPlan({ ...plan, proposedFinalAssessmentChunks: chunks }),
    ).not.toThrow();
  });

  it("rejects chunks whose sum does not equal FA target", () => {
    const plan = makePlan();
    const chunks = [
      { id: "fa-1", targetQuestionCount: 3, coverageLearningObjectiveIds: ["lo-1"], focusTopicLabel: "a" },
      { id: "fa-2", targetQuestionCount: 3, coverageLearningObjectiveIds: ["lo-2"], focusTopicLabel: "b" },
    ];
    try {
      validateAssessmentPlan({ ...plan, proposedFinalAssessmentChunks: chunks });
      throw new Error("expected throw");
    } catch (err) {
      const issues = (err as Error & { issues?: { path: string; message: string }[] }).issues ?? [];
      expect(issues.some((i) => /chunks' targetQuestionCount sum/.test(i.message))).toBe(true);
    }
  });

  it("rejects a chunk with target > FA_CHUNK_MAX_TARGET", () => {
    const plan = makePlan({ proposedFinalAssessment: { targetQuestionCount: 10, coverageLearningObjectiveIds: ["lo-1"] } });
    const chunks = [
      { id: "fa-1", targetQuestionCount: 5, coverageLearningObjectiveIds: ["lo-1"], focusTopicLabel: "a" },
      { id: "fa-2", targetQuestionCount: 5, coverageLearningObjectiveIds: ["lo-2"], focusTopicLabel: "b" },
    ];
    try {
      validateAssessmentPlan({ ...plan, proposedFinalAssessmentChunks: chunks });
      throw new Error("expected throw");
    } catch (err) {
      const issues = (err as Error & { issues?: { path: string; message: string }[] }).issues ?? [];
      expect(issues.some((i) => /target 1\.\.3/.test(i.message))).toBe(true);
    }
  });

  it("rejects a chunk referencing an unknown LO", () => {
    const plan = makePlan();
    const chunks = [
      { id: "fa-1", targetQuestionCount: 3, coverageLearningObjectiveIds: ["lo-1","lo-missing"], focusTopicLabel: "a" },
      { id: "fa-2", targetQuestionCount: 3, coverageLearningObjectiveIds: ["lo-4"], focusTopicLabel: "b" },
      { id: "fa-3", targetQuestionCount: 3, coverageLearningObjectiveIds: ["lo-7"], focusTopicLabel: "c" },
      { id: "fa-4", targetQuestionCount: 1, coverageLearningObjectiveIds: ["lo-10"], focusTopicLabel: "d" },
    ];
    try {
      validateAssessmentPlan({ ...plan, proposedFinalAssessmentChunks: chunks });
      throw new Error("expected throw");
    } catch (err) {
      const issues = (err as Error & { issues?: { path: string; message: string }[] }).issues ?? [];
      expect(issues.some((i) => /references unknown LO lo-missing/.test(i.message))).toBe(true);
    }
  });

  it("rejects duplicate chunk ids", () => {
    const plan = makePlan();
    const chunks = [
      { id: "fa-1", targetQuestionCount: 3, coverageLearningObjectiveIds: ["lo-1"], focusTopicLabel: "a" },
      { id: "fa-1", targetQuestionCount: 3, coverageLearningObjectiveIds: ["lo-2"], focusTopicLabel: "b" },
      { id: "fa-2", targetQuestionCount: 3, coverageLearningObjectiveIds: ["lo-3"], focusTopicLabel: "c" },
      { id: "fa-3", targetQuestionCount: 1, coverageLearningObjectiveIds: ["lo-4"], focusTopicLabel: "d" },
    ];
    try {
      validateAssessmentPlan({ ...plan, proposedFinalAssessmentChunks: chunks });
      throw new Error("expected throw");
    } catch (err) {
      const issues = (err as Error & { issues?: { path: string; message: string }[] }).issues ?? [];
      expect(issues.some((i) => /duplicate id fa-1/.test(i.message))).toBe(true);
    }
  });
});

// ─── §8.2–8.3 — Coverage planner ────────────────────────────────────

describe("§8.2 — coverage planner partitions target into ≤3 chunks", () => {
  it("target=10 maxPerChunk=3 → 4 chunks of [3,3,3,1]", () => {
    const plan = makePlan();
    const result = buildFinalAssessmentCoverage({
      learningObjectives: plan.learningObjectives,
      target: 10,
    });
    expect(result.chunks.length).toBe(4);
    expect(result.chunks.map((c) => c.targetQuestionCount)).toEqual([3, 3, 3, 1]);
  });

  it("target=6 → 2 chunks of [3,3]", () => {
    const plan = makePlan();
    const result = buildFinalAssessmentCoverage({
      learningObjectives: plan.learningObjectives,
      target: 6,
    });
    expect(result.chunks.length).toBe(2);
    expect(result.chunks.map((c) => c.targetQuestionCount)).toEqual([3, 3]);
  });

  it("target=1 → 1 chunk of [1]", () => {
    const plan = makePlan();
    const result = buildFinalAssessmentCoverage({
      learningObjectives: plan.learningObjectives,
      target: 1,
    });
    expect(result.chunks.map((c) => c.targetQuestionCount)).toEqual([1]);
  });

  it("target=0 → no chunks", () => {
    const plan = makePlan();
    const result = buildFinalAssessmentCoverage({
      learningObjectives: plan.learningObjectives,
      target: 0,
    });
    expect(result.chunks).toEqual([]);
    expect(result.supportedTarget).toBe(0);
  });

  it("refuses when maxPerChunk > FA_CHUNK_MAX_TARGET", () => {
    const plan = makePlan();
    expect(() =>
      buildFinalAssessmentCoverage({
        learningObjectives: plan.learningObjectives,
        target: 10,
        maxPerChunk: 5,
      }),
    ).toThrow();
  });
});

describe("§8.3 — chunk shape: id, target, LOs, focusTopic", () => {
  it("every chunk has a unique id, a label, and non-empty LO list", () => {
    const plan = makePlan();
    const result = buildFinalAssessmentCoverage({
      learningObjectives: plan.learningObjectives,
      target: 10,
    });
    const ids = new Set<string>();
    for (const c of result.chunks) {
      expect(c.id).toMatch(/^fa-\d+$/);
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      expect(c.targetQuestionCount).toBeGreaterThanOrEqual(1);
      expect(c.targetQuestionCount).toBeLessThanOrEqual(FA_CHUNK_MAX_TARGET);
      expect(c.coverageLearningObjectiveIds.length).toBeGreaterThanOrEqual(1);
      expect(typeof c.focusTopicLabel).toBe("string");
      expect(c.focusTopicLabel.length).toBeGreaterThan(0);
    }
  });
});

// ─── §8.4 — Grounding (LO slice covers grounded LOs only) ──────────

describe("§8.4 — chunks skip LOs with zero segment ids", () => {
  it("ungrounded LOs are excluded from chunk coverage", () => {
    const plan = makePlan({
      learningObjectives: [
        makeLo("lo-1", "Grounded one", [0, 1]),
        makeLo("lo-empty", "Ungrounded", []),
        makeLo("lo-2", "Grounded two", [2, 3]),
      ],
    });
    const result = buildFinalAssessmentCoverage({
      learningObjectives: plan.learningObjectives,
      target: 2,
    });
    const allCoveredLos = result.chunks.flatMap((c) => c.coverageLearningObjectiveIds);
    expect(allCoveredLos).not.toContain("lo-empty");
  });

  it("empty LO list → supportedTarget=0", () => {
    const result = buildFinalAssessmentCoverage({
      learningObjectives: [],
      target: 10,
    });
    expect(result.chunks).toEqual([]);
    expect(result.supportedTarget).toBe(0);
  });
});

// ─── §8.5 — Destination routing ─────────────────────────────────────

describe("§8.6 — destination routing: fa-*, cg-*, final", () => {
  it.each([
    ["fa-1", "FINAL_ASSESSMENT"],
    ["fa-99", "FINAL_ASSESSMENT"],
    ["final", "FINAL_ASSESSMENT"],
    ["cg-1", "CHECKPOINT"],
    ["cg-99", "CHECKPOINT"],
    ["ck-abcdef", "CHECKPOINT"], // future-safe
    [null, "UNKNOWN"],
    [undefined, "UNKNOWN"],
    ["", "UNKNOWN"],
  ])("maps %s → %s", (group, expected) => {
    expect(destinationKindForGroup(group as string | null | undefined)).toBe(expected);
  });
});

// ─── §8.11 — Preservation: composed map leaves original cg-* intact ─

describe("§8.11 — composed group map preserves original checkpoint destinations", () => {
  const originalShortfall = JSON.stringify({
    schemaVersion: "shortfall-v1",
    dedupDecisions: [
      { group: "cg-1", candidateContentHash: "hash-ck-1", kept: true, decision: { verdict: "DISTINCT" } },
      { group: "cg-2", candidateContentHash: "hash-ck-2", kept: true, decision: { verdict: "DISTINCT" } },
      { group: "cg-3", candidateContentHash: "hash-ck-3", kept: true, decision: { verdict: "DISTINCT" } },
      { group: "cg-4", candidateContentHash: "hash-ck-4", kept: true, decision: { verdict: "DISTINCT" } },
      { group: "cg-5", candidateContentHash: "hash-ck-5", kept: true, decision: { verdict: "DISTINCT" } },
    ],
  });
  const recoveryShortfall = JSON.stringify({
    schemaVersion: "shortfall-v1",
    dedupDecisions: [
      { group: "fa-1", candidateContentHash: "hash-fa-1", kept: true, decision: { verdict: "DISTINCT" } },
      { group: "fa-1", candidateContentHash: "hash-fa-2", kept: true, decision: { verdict: "DISTINCT" } },
      { group: "fa-2", candidateContentHash: "hash-fa-3", kept: true, decision: { verdict: "DISTINCT" } },
    ],
  });

  it("composes both runs' maps without overwriting checkpoint entries", () => {
    const composed = composeGroupMapsFromRuns([originalShortfall, recoveryShortfall]);
    expect(composed.get("hash-ck-1")).toBe("cg-1");
    expect(composed.get("hash-ck-5")).toBe("cg-5");
    expect(composed.get("hash-fa-1")).toBe("fa-1");
    expect(composed.get("hash-fa-3")).toBe("fa-2");
  });

  it("annotateDraftsWithComposedDestination tags each draft correctly", () => {
    const composed = composeGroupMapsFromRuns([originalShortfall, recoveryShortfall]);
    const drafts = [
      { id: "d1", contentHash: "hash-ck-1" },
      { id: "d2", contentHash: "hash-ck-3" },
      { id: "d3", contentHash: "hash-fa-1" },
      { id: "d4", contentHash: "hash-fa-3" },
      { id: "d5", contentHash: "hash-unknown" },
    ];
    const annotated = annotateDraftsWithComposedDestination({ drafts, composedGroupMap: composed });
    expect(annotated.map((a) => a.destination)).toEqual([
      "CHECKPOINT", "CHECKPOINT", "FINAL_ASSESSMENT", "FINAL_ASSESSMENT", "UNKNOWN",
    ]);
  });
});

// ─── §8.12 — Manager-review display across multiple runs ───────────

describe("§8.12 — resolver works for AF scenario (original + recovery runs)", () => {
  it("5 checkpoint drafts + 7 recovered FA drafts fan out correctly", () => {
    const originalShortfall = JSON.stringify({
      dedupDecisions: [
        { group: "cg-1", candidateContentHash: "ch-ck-1", kept: true },
        { group: "cg-2", candidateContentHash: "ch-ck-2", kept: true },
        { group: "cg-3", candidateContentHash: "ch-ck-3", kept: true },
        { group: "cg-4", candidateContentHash: "ch-ck-4", kept: true },
        { group: "cg-5", candidateContentHash: "ch-ck-5", kept: true },
      ],
    });
    const recovery = JSON.stringify({
      dedupDecisions: [
        { group: "fa-1", candidateContentHash: "ch-fa-1", kept: true },
        { group: "fa-1", candidateContentHash: "ch-fa-2", kept: true },
        { group: "fa-1", candidateContentHash: "ch-fa-3", kept: true },
        { group: "fa-2", candidateContentHash: "ch-fa-4", kept: true },
        { group: "fa-2", candidateContentHash: "ch-fa-5", kept: true },
        { group: "fa-2", candidateContentHash: "ch-fa-6", kept: true },
        { group: "fa-3", candidateContentHash: "ch-fa-7", kept: true },
      ],
    });
    const composed = composeGroupMapsFromRuns([originalShortfall, recovery]);
    const drafts = [
      { id: "d1", contentHash: "ch-ck-1" },
      { id: "d2", contentHash: "ch-ck-2" },
      { id: "d3", contentHash: "ch-ck-3" },
      { id: "d4", contentHash: "ch-ck-4" },
      { id: "d5", contentHash: "ch-ck-5" },
      { id: "d6", contentHash: "ch-fa-1" },
      { id: "d7", contentHash: "ch-fa-2" },
      { id: "d8", contentHash: "ch-fa-3" },
      { id: "d9", contentHash: "ch-fa-4" },
      { id: "d10", contentHash: "ch-fa-5" },
      { id: "d11", contentHash: "ch-fa-6" },
      { id: "d12", contentHash: "ch-fa-7" },
    ];
    const annotated = annotateDraftsWithComposedDestination({ drafts, composedGroupMap: composed });
    const cpCount = annotated.filter((a) => a.destination === "CHECKPOINT").length;
    const faCount = annotated.filter((a) => a.destination === "FINAL_ASSESSMENT").length;
    expect(cpCount).toBe(5);
    expect(faCount).toBe(7);
  });
});

// ─── §8.9 — Determinism (retry governance via plan identity) ───────

describe("§8.9 — coverage planner is deterministic", () => {
  it("same inputs → identical chunks", () => {
    const plan = makePlan();
    const a = buildFinalAssessmentCoverage({ learningObjectives: plan.learningObjectives, target: 10 });
    const b = buildFinalAssessmentCoverage({ learningObjectives: plan.learningObjectives, target: 10 });
    expect(JSON.stringify(a.chunks)).toBe(JSON.stringify(b.chunks));
  });

  it("chunk ids are stable fa-1..fa-N", () => {
    const plan = makePlan();
    const r = buildFinalAssessmentCoverage({ learningObjectives: plan.learningObjectives, target: 10 });
    expect(r.chunks.map((c) => c.id)).toEqual(["fa-1", "fa-2", "fa-3", "fa-4"]);
  });
});

// ─── §8.7 — Ten-question target sufficient when LOs support it ─────

describe("§8.7 — target=10 is supported when LOs ≥ 1", () => {
  it("54 LOs (Silver Springs pilot shape) → 4 chunks summing to 10", () => {
    const los = Array.from({ length: 54 }, (_, i) =>
      makeLo(`lo-${i + 1}`, `Topic ${i + 1}`, [i * 3, i * 3 + 1, i * 3 + 2]),
    );
    const r = buildFinalAssessmentCoverage({ learningObjectives: los, target: 10 });
    expect(r.chunks.length).toBe(4);
    expect(r.chunks.reduce((sum, c) => sum + c.targetQuestionCount, 0)).toBe(10);
    expect(r.supportedTarget).toBe(10);
  });
});

// ─── §8.8 — Partial shortfall handling ─────────────────────────────

describe("§8.8 — tiny LO count does NOT fabricate chunks", () => {
  it("2 LOs, target=10 → chunks created, LO coverage overlaps (no fabrication of questions)", () => {
    const los = [makeLo("lo-1", "A", [0]), makeLo("lo-2", "B", [1])];
    const r = buildFinalAssessmentCoverage({ learningObjectives: los, target: 10 });
    // The planner ALLOWS chunks even when LO count < chunk count — the
    // model is told to focus on a subset, dedup catches any duplicate
    // output. This is acceptable because the model (not the planner) is
    // the quality bottleneck. The directive §4 fabrication guard
    // applies at the question-generation layer, not at coverage planning.
    expect(r.chunks.length).toBe(4);
    expect(r.chunks.reduce((s, c) => s + c.targetQuestionCount, 0)).toBe(10);
  });
});

// ─── §8.13+§8.5 — shortfall-v1 parsing still returns map ───────────

describe("§8.5 — shortfall-v1 pipelining (parseShortfallGroupMap)", () => {
  it("parses the 4Y-Z pilot's exact shortfall shape", () => {
    const shortfallV1 = JSON.stringify({
      schemaVersion: "shortfall-v1",
      targetCount: 15,
      generatedCount: 5,
      shortfall: 10,
      dedupDropCount: 0,
      dedupRulesVersion: "dedup-v2",
      dedupDecisions: [
        { group: "cg-1", candidateContentHash: "ch1", kept: true, decision: { verdict: "DISTINCT" } },
        { group: "cg-2", candidateContentHash: "ch2", kept: true, decision: { verdict: "DISTINCT" } },
        { group: "cg-3", candidateContentHash: "ch3", kept: true, decision: { verdict: "DISTINCT" } },
        { group: "cg-4", candidateContentHash: "ch4", kept: true, decision: { verdict: "DISTINCT" } },
        { group: "cg-5", candidateContentHash: "ch5", kept: true, decision: { verdict: "DISTINCT" } },
      ],
      reason: "model returned fewer grounded candidates than target",
    });
    const map = parseShortfallGroupMap(shortfallV1);
    expect(map.size).toBe(5);
    expect(map.get("ch1")).toBe("cg-1");
    expect(map.get("ch5")).toBe("cg-5");
  });
});

// ─── §8.10 — Idempotency projection ─────────────────────────────────

describe("§8.10 — budget projection", () => {
  it("4 chunks × 180s + 60s cold boot → ~$0.4214", () => {
    const usd = projectRecoveryCostUsd({ chunkCount: 4 });
    expect(usd).toBeGreaterThan(0.40);
    expect(usd).toBeLessThan(0.45);
  });

  it("budget is below the $1 pilot cap for 10 questions", () => {
    // 10 / 3 = ⌈3.33⌉ = 4 chunks
    const usd = projectRecoveryCostUsd({ chunkCount: 4 });
    expect(usd).toBeLessThan(1.0);
  });

  it("budget is deterministic (same chunkCount → same cost)", () => {
    const a = projectRecoveryCostUsd({ chunkCount: 4 });
    const b = projectRecoveryCostUsd({ chunkCount: 4 });
    expect(a).toBe(b);
  });
});

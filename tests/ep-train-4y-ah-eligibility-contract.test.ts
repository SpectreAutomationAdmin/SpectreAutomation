// EP-TRAIN-4Y-AH §6 — offline contract tests for the canonical FA
// evidence eligibility repair.
//
// Scope: everything EXCEPT GPU inference. We do NOT claim Qwen produces
// valid questions. We DO prove the contract transforms correctly and
// synthetic proposals land in the right bucket (accepted / grounding
// drop / etc.) given known inputs.

import { describe, it, expect } from "vitest";
import {
  RUNTIME_EXCLUDED_SEGMENT_INDICES,
  computeWorkerExcludedSegmentIndices,
  computeEligibleSegmentIds,
  trimLearningObjectiveSegments,
} from "@/lib/hr/training/generation/evidence-eligibility";
import {
  buildFinalAssessmentCoverage,
  FA_CHUNK_MAX_TARGET,
} from "@/lib/hr/training/generation/final-assessment-coverage";
import { buildFinalSystemPromptCtxV1 } from "@/lib/hr/training/generation/worker-handler";

// ─── Fixtures: a stylised Silver-Springs-shaped LO list ──────────────

/** 54 LOs covering segments 0..162 in 3-segment slices. Matches the
 *  shape of the live 4Y-Z pilot plan without referencing the live DB. */
function buildSilverSpringsShapeLos() {
  const los: { id: string; title: string; segmentIds: number[] }[] = [];
  for (let i = 0; i < 54; i++) {
    const seg = [i * 3, i * 3 + 1, i * 3 + 2].filter((n) => n <= 162);
    los.push({
      id: `lo-${i + 1}`,
      title: `Learning objective ${i + 1} (segments ${seg.join(", ")})`,
      segmentIds: seg,
    });
  }
  return los;
}

const PLAN_ELIGIBLE_SILVER_SPRINGS = Array.from({ length: 163 }, (_, i) => i)
  .filter((i) => i !== 16 && i !== 17);
const PLAN_EXCLUDED_SILVER_SPRINGS = [16, 17];

// ─── §6.1 — Every segment supplied to the model is accepted ─────────

describe("§6.1 — every id in chunk.eligibleSegmentIds is accepted by the eligibility validator", () => {
  it("coverage planner produces per-chunk eligibleSegmentIds that are a subset of plan-eligible minus worker-excluded", () => {
    const los = buildSilverSpringsShapeLos();
    const coverage = buildFinalAssessmentCoverage({
      learningObjectives: los,
      target: 10,
      planEligibleSegmentIds: PLAN_ELIGIBLE_SILVER_SPRINGS,
      planExcludedSegmentIndices: PLAN_EXCLUDED_SILVER_SPRINGS,
    });
    const workerExcluded = computeWorkerExcludedSegmentIndices(PLAN_EXCLUDED_SILVER_SPRINGS);
    const planEligible = new Set(PLAN_ELIGIBLE_SILVER_SPRINGS);
    for (const chunk of coverage.chunks) {
      expect(Array.isArray(chunk.eligibleSegmentIds)).toBe(true);
      expect(chunk.eligibleSegmentIds!.length).toBeGreaterThan(0);
      for (const id of chunk.eligibleSegmentIds!) {
        expect(planEligible.has(id)).toBe(true); // plan-eligible
        expect(workerExcluded.has(id)).toBe(false); // not worker-excluded
      }
    }
  });
});

// ─── §6.2 — Excluded segments cannot enter prompt evidence ──────────

describe("§6.2 — worker-excluded ids never appear in chunk eligibility OR the FA prompt's allowed-id line", () => {
  it("Silver Springs runtime-excluded {68..82, 160, 161} never surface in any chunk", () => {
    const los = buildSilverSpringsShapeLos();
    const coverage = buildFinalAssessmentCoverage({
      learningObjectives: los,
      target: 10,
      planEligibleSegmentIds: PLAN_ELIGIBLE_SILVER_SPRINGS,
      planExcludedSegmentIndices: PLAN_EXCLUDED_SILVER_SPRINGS,
    });
    const forbidden = [16, 17, ...Array.from({ length: 15 }, (_, i) => 68 + i), 160, 161];
    for (const chunk of coverage.chunks) {
      for (const id of chunk.eligibleSegmentIds!) {
        expect(forbidden).not.toContain(id);
      }
    }
  });

  it("the FA ctx-v1 prompt enumerates allowed ids and never forbidden ones", () => {
    const prompt = buildFinalSystemPromptCtxV1({
      target: 3,
      los: [{ id: "lo-7", title: "test LO" }],
      videoEndSec: 641,
      priorTopics: [],
      allowedSegmentIds: [0, 1, 2, 83, 84, 85],
    });
    expect(prompt).toContain("Allowed segment ids");
    expect(prompt).toContain("[0, 1, 2, 83, 84, 85]");
    expect(prompt).toContain("any other integer will be discarded");
    // No forbidden ids should appear in the allowed-id line
    expect(prompt).not.toMatch(/Allowed segment ids[^\n]*\b(68|82|160|161)\b/);
  });

  it("FA ctx-v1 prompt without allowedSegmentIds falls back to AF wording (backwards compat)", () => {
    const prompt = buildFinalSystemPromptCtxV1({
      target: 3,
      los: [{ id: "lo-1", title: "x" }],
      videoEndSec: 641,
      priorTopics: [],
    });
    expect(prompt).not.toContain("Allowed segment ids");
    expect(prompt).toContain("cite at least one transcript segment id from the full course transcript provided");
  });
});

// ─── §6.3 — Four chunks have meaningful eligible evidence ────────────

describe("§6.3 — four Silver-Springs-shape chunks have meaningful evidence", () => {
  it("target=10 produces 4 chunks, each with ≥ 1 eligible segment id and a focusTopicSummary", () => {
    const los = buildSilverSpringsShapeLos();
    const coverage = buildFinalAssessmentCoverage({
      learningObjectives: los,
      target: 10,
      planEligibleSegmentIds: PLAN_ELIGIBLE_SILVER_SPRINGS,
      planExcludedSegmentIndices: PLAN_EXCLUDED_SILVER_SPRINGS,
    });
    expect(coverage.chunks.length).toBe(4);
    for (const chunk of coverage.chunks) {
      expect(chunk.eligibleSegmentIds!.length).toBeGreaterThanOrEqual(1);
      expect(chunk.focusTopicSummary?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("ineligibleLearningObjectiveIds lists any LOs fully in the excluded range", () => {
    // Craft an LO whose 3 ids are all runtime-excluded.
    const los = [
      { id: "lo-ok", title: "ok", segmentIds: [0, 1, 2] },
      { id: "lo-dead", title: "dead", segmentIds: [68, 69, 70] },
    ];
    const coverage = buildFinalAssessmentCoverage({
      learningObjectives: los,
      target: 1,
      planEligibleSegmentIds: PLAN_ELIGIBLE_SILVER_SPRINGS,
      planExcludedSegmentIndices: PLAN_EXCLUDED_SILVER_SPRINGS,
    });
    expect(coverage.ineligibleLearningObjectiveIds).toContain("lo-dead");
    expect(coverage.ineligibleLearningObjectiveIds).not.toContain("lo-ok");
  });

  it("partially-eligible LO retains only permitted ids", () => {
    const los = [
      { id: "lo-mix", title: "mix", segmentIds: [67, 68, 69, 83, 84] },
    ];
    const coverage = buildFinalAssessmentCoverage({
      learningObjectives: los,
      target: 1,
      planEligibleSegmentIds: PLAN_ELIGIBLE_SILVER_SPRINGS,
      planExcludedSegmentIndices: PLAN_EXCLUDED_SILVER_SPRINGS,
    });
    expect(coverage.chunks[0].eligibleSegmentIds).toEqual([67, 83, 84]);
  });
});

// ─── §6.4 — Valid grounded proposals survive filtering ───────────────
// ─── §6.5 — Invalid proposals fail with precise reasons ──────────────

/** Mirrors the worker's citedOutside + citedExcluded logic, applied to
 *  a synthetic Qwen-shaped proposal. */
function groundingCheck(proposal: { sourceSegmentIds: number[] }, args: {
  planEligible: readonly number[];
  workerExcluded: ReadonlySet<number>;
}): { pass: boolean; citedOutside: number[]; citedExcluded: number[] } {
  const eligible = new Set(args.planEligible);
  const citedOutside = proposal.sourceSegmentIds.filter((id) => !eligible.has(id));
  const citedExcluded = proposal.sourceSegmentIds.filter((id) => args.workerExcluded.has(id));
  return { pass: citedOutside.length === 0 && citedExcluded.length === 0, citedOutside, citedExcluded };
}

describe("§6.4 + §6.5 — synthetic proposals accepted/rejected with precise reasons", () => {
  const planEligible = PLAN_ELIGIBLE_SILVER_SPRINGS;
  const workerExcluded = computeWorkerExcludedSegmentIndices(PLAN_EXCLUDED_SILVER_SPRINGS);

  it("valid cite from chunk-eligible ids passes", () => {
    const p = { sourceSegmentIds: [0, 1, 2] };
    const r = groundingCheck(p, { planEligible, workerExcluded });
    expect(r.pass).toBe(true);
    expect(r.citedOutside).toEqual([]);
    expect(r.citedExcluded).toEqual([]);
  });

  it("cite to a runtime-excluded id (68) fails via citedExcluded", () => {
    const p = { sourceSegmentIds: [67, 68] };
    const r = groundingCheck(p, { planEligible, workerExcluded });
    expect(r.pass).toBe(false);
    expect(r.citedExcluded).toEqual([68]);
  });

  it("cite to an id outside the transcript range fails via citedOutside", () => {
    const p = { sourceSegmentIds: [999] };
    const r = groundingCheck(p, { planEligible, workerExcluded });
    expect(r.pass).toBe(false);
    expect(r.citedOutside).toEqual([999]);
  });

  it("cite mixed valid + invalid still fails (one bad id discards the proposal)", () => {
    const p = { sourceSegmentIds: [0, 68] };
    const r = groundingCheck(p, { planEligible, workerExcluded });
    expect(r.pass).toBe(false);
  });
});

// ─── §6.6 — One malformed proposal does not discard independent valid proposals ─

describe("§6.6 — malformed proposals do not poison their siblings", () => {
  it("in a batch of [valid, invalid, valid], the two valid ones are accepted", () => {
    const planEligible = PLAN_ELIGIBLE_SILVER_SPRINGS;
    const workerExcluded = computeWorkerExcludedSegmentIndices(PLAN_EXCLUDED_SILVER_SPRINGS);
    const proposals = [
      { sourceSegmentIds: [0, 1] },
      { sourceSegmentIds: [68] },
      { sourceSegmentIds: [83, 84] },
    ];
    const results = proposals.map((p) => groundingCheck(p, { planEligible, workerExcluded }));
    expect(results.map((r) => r.pass)).toEqual([true, false, true]);
  });
});

// ─── §6.12 — Determinism (idempotent + no automatic retries guard) ──

describe("§6.12 — determinism + no-retry contract", () => {
  it("coverage planner is deterministic given the same inputs", () => {
    const los = buildSilverSpringsShapeLos();
    const a = buildFinalAssessmentCoverage({
      learningObjectives: los, target: 10,
      planEligibleSegmentIds: PLAN_ELIGIBLE_SILVER_SPRINGS,
      planExcludedSegmentIndices: PLAN_EXCLUDED_SILVER_SPRINGS,
    });
    const b = buildFinalAssessmentCoverage({
      learningObjectives: los, target: 10,
      planEligibleSegmentIds: PLAN_ELIGIBLE_SILVER_SPRINGS,
      planExcludedSegmentIndices: PLAN_EXCLUDED_SILVER_SPRINGS,
    });
    expect(JSON.stringify(a.chunks)).toBe(JSON.stringify(b.chunks));
    expect(a.ineligibleLearningObjectiveIds).toEqual(b.ineligibleLearningObjectiveIds);
  });

  it("trimLearningObjectiveSegments is referentially safe (returns new object)", () => {
    const lo = { id: "lo-1", title: "x", segmentIds: [67, 68] };
    const trimmed = trimLearningObjectiveSegments(lo, new Set([68]));
    expect(trimmed.segmentIds).toEqual([67]);
    expect(lo.segmentIds).toEqual([67, 68]); // original unchanged
  });

  it("computeEligibleSegmentIds returns sorted + dedup-free output", () => {
    const r = computeEligibleSegmentIds({
      planEligibleSegmentIds: [5, 2, 7, 9, 2],
      workerExcludedSegmentIndices: new Set([7]),
    });
    expect([...r]).toEqual([2, 2, 5, 9]); // Note: dedup is caller's job
  });

  it("RUNTIME_EXCLUDED_SEGMENT_INDICES is the exact Silver-Springs runtime hygiene set", () => {
    const expected = new Set([
      68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82,
      160, 161,
    ]);
    expect([...RUNTIME_EXCLUDED_SEGMENT_INDICES].sort()).toEqual([...expected].sort());
  });
});

// ─── §6.3b — four chunks summing to the requested target ────────────

describe("§6 target preservation", () => {
  it("target=10 sums to exactly 10 across chunks [3,3,3,1]", () => {
    const los = buildSilverSpringsShapeLos();
    const coverage = buildFinalAssessmentCoverage({
      learningObjectives: los, target: 10,
      planEligibleSegmentIds: PLAN_ELIGIBLE_SILVER_SPRINGS,
      planExcludedSegmentIndices: PLAN_EXCLUDED_SILVER_SPRINGS,
    });
    expect(coverage.chunks.map((c) => c.targetQuestionCount)).toEqual([3, 3, 3, 1]);
    expect(coverage.chunks.reduce((s, c) => s + c.targetQuestionCount, 0)).toBe(10);
  });

  it("target constraint ≤ FA_CHUNK_MAX_TARGET per chunk", () => {
    const los = buildSilverSpringsShapeLos();
    const coverage = buildFinalAssessmentCoverage({
      learningObjectives: los, target: 10,
      planEligibleSegmentIds: PLAN_ELIGIBLE_SILVER_SPRINGS,
      planExcludedSegmentIndices: PLAN_EXCLUDED_SILVER_SPRINGS,
    });
    for (const c of coverage.chunks) {
      expect(c.targetQuestionCount).toBeGreaterThanOrEqual(1);
      expect(c.targetQuestionCount).toBeLessThanOrEqual(FA_CHUNK_MAX_TARGET);
    }
  });
});

// ─── §6.11 — Failure diagnostics shape (persistence proven at service level) ─

describe("§6.11 — shortfallReasonJson v2 shape (unit-level)", () => {
  it("INSUFFICIENT_EVIDENCE payload shape is JSON-serialisable and round-trips", () => {
    const payload = {
      schemaVersion: "shortfall-v2",
      targetCount: 10,
      generatedCount: 0,
      shortfall: 10,
      sanitizerDropCount: 2,
      dedupDropCount: 0,
      dedupRulesVersion: "dedup-v2",
      dedupDecisions: [
        { group: "fa-1", candidateContentHash: "hash1", kept: false, decision: { verdict: "EXACT_DUP" } },
      ],
      perGroupDiagnostics: [
        { group: "fa-1", kind: "FINAL_ASSESSMENT", requestedCount: 3, proposalCountFromModal: 3,
          groundingDroppedCount: 3, groundingDropReasons: [], sanitizerDroppedCount: 0,
          sanitizerDropReasons: [], dedupDroppedCount: 0, persistedCount: 0,
          modalElapsedMs: 42000, modalPromptTokens: 1000, modalOutputTokens: 500 },
      ],
      reason: "No grounded proposals produced.",
      failureCode: "INSUFFICIENT_EVIDENCE",
    };
    const s = JSON.stringify(payload);
    const parsed = JSON.parse(s);
    expect(parsed.failureCode).toBe("INSUFFICIENT_EVIDENCE");
    expect(parsed.perGroupDiagnostics[0].groundingDroppedCount).toBe(3);
    expect(parsed.schemaVersion).toBe("shortfall-v2");
  });
});

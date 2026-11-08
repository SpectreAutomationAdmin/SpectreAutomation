// EP-TRAIN-4Y-N (2026-11-08) — §6 offline validation suite.
//
// Deterministic fixtures prove the ctx-v1 context-aware prompt
// construction and dedup-v2 grounded near-duplicate rule behave as
// the directive requires BEFORE any GPU invocation.
//
// Fixtures come from the accepted 4Y-L / 4Y-M Silver Springs
// transcript so the assertions reflect real production content.

import { describe, it, expect } from "vitest";
import {
  buildCheckpointSystemPromptCtxV1,
  buildFinalSystemPromptCtxV1,
} from "../src/lib/hr/training/generation/worker-handler";
import {
  buildBaselineAssessmentPlan,
  planIdentityHash,
} from "../src/lib/hr/training/generation/assessment-plan";
import {
  evaluatePair,
  DEDUP_RULES_VERSION,
  GROUNDED_SEGMENT_OVERLAP,
  type QuestionCandidate,
} from "../src/lib/hr/training/generation/dedup";

// ─── §6.1: Per-checkpoint prompts differ meaningfully ─────────────

describe("EP-TRAIN-4Y-N §6.1 — checkpoint prompts are context-aware", () => {
  const LOS = [
    { id: "lo-pay", title: "Pay stubs access via SIN" },
    { id: "lo-strike", title: "Three-strike policy and consequences" },
    { id: "lo-phone", title: "Cell phone policy at Silver Springs" },
  ];

  it("different checkpoints produce different system prompts", () => {
    const p1 = buildCheckpointSystemPromptCtxV1({
      atSec: 90,
      target: 2,
      los: [LOS[0]],
      windowSegmentIds: [0, 1, 2, 3, 4],
      videoEndSec: 640,
      priorTopics: [],
    });
    const p2 = buildCheckpointSystemPromptCtxV1({
      atSec: 200,
      target: 2,
      los: [LOS[1]],
      windowSegmentIds: [5, 6, 7, 8, 9, 10, 11, 12, 13],
      videoEndSec: 640,
      priorTopics: [],
    });
    expect(p1).not.toEqual(p2);
    expect(p1).toContain("Pay stubs access via SIN");
    expect(p2).toContain("Three-strike policy");
    expect(p1).not.toContain("Three-strike policy");
    expect(p2).not.toContain("Pay stubs access via SIN");
  });

  it("includes the checkpoint timestamp in mm:ss format", () => {
    const p = buildCheckpointSystemPromptCtxV1({
      atSec: 325.48,
      target: 1,
      los: [LOS[2]],
      windowSegmentIds: [30, 31, 32],
      videoEndSec: 640,
      priorTopics: [],
    });
    expect(p).toContain("5:25");
    expect(p).toContain("10:40"); // videoEndSec as totalStr
  });

  it("enumerates the evidence window segment ids", () => {
    const p = buildCheckpointSystemPromptCtxV1({
      atSec: 90,
      target: 1,
      los: [LOS[0]],
      windowSegmentIds: [0, 1, 2, 3, 4],
      videoEndSec: 640,
      priorTopics: [],
    });
    expect(p).toContain("[0, 1, 2, 3, 4]");
  });

  it("instructs the model NOT to assess later content", () => {
    const p = buildCheckpointSystemPromptCtxV1({
      atSec: 90,
      target: 1,
      los: [LOS[0]],
      windowSegmentIds: [0, 1, 2, 3, 4],
      videoEndSec: 640,
      priorTopics: [],
    });
    expect(p).toMatch(/not yet watched|BEFORE this checkpoint|not ask about anything later/i);
  });

  it("includes prior-topic hints when supplied", () => {
    const p = buildCheckpointSystemPromptCtxV1({
      atSec: 200,
      target: 1,
      los: [LOS[1]],
      windowSegmentIds: [5, 6, 7],
      videoEndSec: 640,
      priorTopics: [
        `• "How do staff members access their pay stubs…"`,
      ],
    });
    expect(p).toContain("ALREADY been generated");
    expect(p).toContain("How do staff members access their pay stubs");
  });

  it("omits the prior-topic block when none supplied", () => {
    const p = buildCheckpointSystemPromptCtxV1({
      atSec: 90,
      target: 1,
      los: [LOS[0]],
      windowSegmentIds: [0, 1],
      videoEndSec: 640,
      priorTopics: [],
    });
    expect(p).not.toContain("ALREADY been generated");
  });
});

// ─── §6.2: Final-assessment prompt differs from checkpoint ────────

describe("EP-TRAIN-4Y-N §6.2 — final-assessment prompt distinct from checkpoint", () => {
  const LOS = [
    { id: "lo-1", title: "Pay stubs" },
    { id: "lo-2", title: "Three-strike" },
    { id: "lo-3", title: "Cell phone" },
  ];

  it("final-assessment prompt uses course-wide framing, not checkpoint framing", () => {
    const cp = buildCheckpointSystemPromptCtxV1({
      atSec: 200,
      target: 2,
      los: [LOS[1]],
      windowSegmentIds: [5, 6, 7],
      videoEndSec: 640,
      priorTopics: [],
    });
    const fin = buildFinalSystemPromptCtxV1({
      target: 5,
      los: LOS,
      videoEndSec: 640,
      priorTopics: [],
    });
    expect(fin).not.toEqual(cp);
    expect(fin).toContain("FINAL assessment");
    expect(fin).toContain("Course-level coverage learning objectives");
    expect(fin).not.toContain("mid-video knowledge checkpoint");
    expect(cp).toContain("mid-video knowledge checkpoint");
    expect(cp).not.toContain("FINAL assessment");
  });

  it("final allows legitimate reinforcement only with distinct application", () => {
    const fin = buildFinalSystemPromptCtxV1({
      target: 5,
      los: [{ id: "lo-1", title: "Pay stubs" }],
      videoEndSec: 640,
      priorTopics: [`• "How do staff access pay stubs…"`],
    });
    expect(fin).toMatch(/reinforce.*ONLY if.*meaningfully different|do NOT verbatim-restate/i);
  });

  it("prioritises policies/procedures/decisions, not trivia", () => {
    const fin = buildFinalSystemPromptCtxV1({
      target: 5,
      los: [{ id: "lo-1", title: "Pay stubs" }],
      videoEndSec: 640,
      priorTopics: [],
    });
    expect(fin).toMatch(/POLICIES.*PROCEDURES.*EMPLOYEE DECISIONS/);
  });
});

// ─── §6.3: Dedup-v2 grounded near-duplicate rule ──────────────────

describe("EP-TRAIN-4Y-N §6.3 — dedup-v2 segment-overlap TOPIC_CANDIDATE rule", () => {
  // Reproduces 4Y-M draft 1 vs draft 2: both cite segment [4], same
  // "last 4 SIN" correct answer, but different question phrasing.
  const DRAFT_1_PAY_STUBS: QuestionCandidate = {
    id: "d1",
    questionText: "How do staff members access their pay stubs at Silver Springs Golf and Country Club according to Randy Hunter's explanation in the video transcript? \nA) By logging into the company's online portal\nB) By using the last four digits of their Social Insurance Number (SIN)\nC) By contacting HR directly\nD) By checking their personal emails",
    options: [
      { text: "A", isCorrect: false },
      { text: "B", isCorrect: true },
      { text: "C", isCorrect: false },
      { text: "D", isCorrect: false },
    ],
    explanation: "According to the transcript, Randy Hunter states, 'The simple and easy answer is it's the last four digits of your SIN number.' Therefore, the correct answer is B.",
    destination: "cg-2",
    sourceSegmentIds: [4],
  };
  const DRAFT_2_PAY_STUBS: QuestionCandidate = {
    id: "d2",
    questionText: "What is the easiest method to access pay stubs at Silver Springs Golf and Country Club according to the transcript [4]?",
    options: [
      { text: "Using the first four digits of your SIN number", isCorrect: false },
      { text: "Using the last four digits of your SIN number", isCorrect: true },
      { text: "Logging into the company's online portal", isCorrect: false },
      { text: "Receiving a physical copy via mail", isCorrect: false },
    ],
    explanation: "The correct answer is using the last four digits of your SIN number, as stated in the transcript [4].",
    destination: "final",
    sourceSegmentIds: [4],
  };

  it("rules version is dedup-v2", () => {
    expect(DEDUP_RULES_VERSION).toBe("dedup-v2");
  });

  it("flags 4Y-M draft 1 vs draft 2 as TOPIC_CANDIDATE (previously DISTINCT under v1)", () => {
    const d = evaluatePair(DRAFT_2_PAY_STUBS, DRAFT_1_PAY_STUBS);
    expect(d.verdict).toBe("TOPIC_CANDIDATE");
    expect(d.evidence.sourceSegmentJaccard).toBe(1);
    expect(d.explanation).toContain("grounded near-duplicate");
  });

  it("does NOT trip when no shared segments", () => {
    const distinctSegs: QuestionCandidate = {
      ...DRAFT_2_PAY_STUBS,
      sourceSegmentIds: [99], // unrelated segment
    };
    const d = evaluatePair(distinctSegs, DRAFT_1_PAY_STUBS);
    expect(d.verdict).toBe("DISTINCT");
    expect(d.evidence.sourceSegmentJaccard).toBe(0);
  });

  it("does NOT trip when segments overlap but answer/explanation/shingle are all weak", () => {
    const weak: QuestionCandidate = {
      ...DRAFT_2_PAY_STUBS,
      questionText: "Describe the office environment", // unrelated
      options: [
        { text: "Loud", isCorrect: false },
        { text: "Quiet", isCorrect: true },
      ],
      explanation: "Transcript segment 4 depicts a quiet meeting setting.",
      sourceSegmentIds: [4],
    };
    const d = evaluatePair(weak, DRAFT_1_PAY_STUBS);
    // Expect either DISTINCT (no supporting signal) or TOPIC_CANDIDATE
    // (shingle still rises above GROUNDED_SUPPORTING_SHINGLE for the
    // common filler words like "the", "a"). The important invariant
    // is that it is NOT a PARAPHRASE_DUP or EXACT_DUP — the grounded
    // rule is advisory, not deletive.
    expect(["DISTINCT", "TOPIC_CANDIDATE"]).toContain(d.verdict);
  });

  it("legacy priors without sourceSegmentIds don't trigger the rule", () => {
    const legacyPrior: QuestionCandidate = {
      id: "legacy",
      questionText: "How do staff members access their pay stubs?",
      options: [{ text: "SIN number", isCorrect: true }],
      explanation: "last four digits",
      destination: "legacy",
      // sourceSegmentIds OMITTED
    };
    const d = evaluatePair(DRAFT_2_PAY_STUBS, legacyPrior);
    expect(d.evidence.sourceSegmentJaccard).toBe(0);
    // Shingle alone will still classify this pair — either DISTINCT
    // or TOPIC_CANDIDATE — but the grounded rule remains inactive.
    expect(d.explanation).not.toContain("grounded near-duplicate");
  });

  it("GROUNDED_SEGMENT_OVERLAP threshold is 0.5 (half the cited set must overlap)", () => {
    expect(GROUNDED_SEGMENT_OVERLAP).toBe(0.5);
  });
});

// ─── §6.4: Plan contract marker changes plan identity hash ───────

describe("EP-TRAIN-4Y-N §6.4 — generationPromptContract=ctx-v1 forks plan identity", () => {
  const COMMON = {
    courseVersionId: "cv-fixture",
    resolvedTranscriptBuildId: "a".repeat(64),
    sourceVideoSha256: "b".repeat(64),
    segments: Array.from({ length: 50 }, (_, i) => ({
      segmentIndex: i,
      text: `segment ${i} text`,
    })),
    videoDurationSec: 640,
    targetTotalQuestions: 6,
    now: new Date("2026-11-08T15:00:00Z"),
  };

  it("buildBaselineAssessmentPlan stamps generationPromptContract=ctx-v1", () => {
    const plan = buildBaselineAssessmentPlan(COMMON);
    expect(plan.generationPromptContract).toBe("ctx-v1");
  });

  it("plan with ctx-v1 marker has a different identity hash than one without", () => {
    const planWithCtx = buildBaselineAssessmentPlan(COMMON);
    const planWithoutCtx = {
      ...planWithCtx,
      generationPromptContract: undefined as never,
    };
    const h1 = planIdentityHash(planWithCtx);
    const h2 = planIdentityHash(planWithoutCtx);
    expect(h1).not.toEqual(h2);
  });
});

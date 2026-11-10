// EP-TRAIN-4Y-AJ §2 + §4 — offline regression tests for the segment-ID
// leakage repair.
//
// IMPORTANT per directive §4 disclosure: the actual 4Y-AI run's seven
// rejected Qwen proposals were NOT persisted to the DB (the shortfall
// payload records only the finding code, `{proposalIndex, findingCodes}`,
// not the raw text). These tests use SYNTHETIC fixtures modelled after
// the AI shortfall's observed finding codes (EXPLICIT_SEGMENT_ID_REFERENCE,
// 7/7 drops across fa-2..fa-4) and the sanitiser's existing contract.
// No test asserts that any specific synthetic proposal was literally
// what Qwen produced.

import { describe, it, expect } from "vitest";
import { buildFinalSystemPromptCtxV1 } from "@/lib/hr/training/generation/worker-handler";
import { checkEmployeeFacingText } from "@/lib/hr/training/ai-review/question-text-sanitizer";
import { checkQuestionStructure } from "@/lib/hr/training/ai-review/question-structure-validator";

// ─── §2 prompt contract: no raw id enumeration ─────────────────────

describe("§2 — FA prompt no longer enumerates raw segment ids in natural language", () => {
  it("does NOT contain the phrase 'Allowed segment ids'", () => {
    const prompt = buildFinalSystemPromptCtxV1({
      target: 3, los: [{ id: "lo-1", title: "x" }],
      videoEndSec: 641, priorTopics: [],
      allowedSegmentIds: [45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58],
    });
    expect(prompt).not.toContain("Allowed segment ids");
    expect(prompt).not.toContain("[45, 46, 47");
    expect(prompt).not.toMatch(/\[\s*\d+(\s*,\s*\d+){3,}/);
  });

  it("surfaces only an aggregate 'Evidence passages available: N' line, with no integer list", () => {
    const prompt = buildFinalSystemPromptCtxV1({
      target: 3, los: [{ id: "lo-1", title: "x" }],
      videoEndSec: 641, priorTopics: [],
      allowedSegmentIds: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    });
    expect(prompt).toContain("Evidence passages available: 11");
    // No multi-integer comma list anywhere in the prompt
    const matches = prompt.match(/\d+,\s*\d+,\s*\d+/g);
    expect(matches).toBeNull();
  });

  it("instructs that bracketed [N] prefixes are METADATA ONLY", () => {
    const prompt = buildFinalSystemPromptCtxV1({
      target: 3, los: [{ id: "lo-1", title: "x" }],
      videoEndSec: 641, priorTopics: [],
      allowedSegmentIds: [1, 2, 3],
    });
    expect(prompt).toMatch(/INTERNAL METADATA/i);
    expect(prompt).toContain("sourceSegmentIds");
  });

  it("includes the explicit forbidden-mentions clause (segment/passage id/[N])", () => {
    const prompt = buildFinalSystemPromptCtxV1({
      target: 3, los: [{ id: "lo-1", title: "x" }],
      videoEndSec: 641, priorTopics: [],
      allowedSegmentIds: [1, 2, 3],
    });
    expect(prompt).toMatch(/MUST NOT contain the words "segment"/);
    expect(prompt).toMatch(/\[12\]/); // sample forbidden pattern explicitly listed
    expect(prompt).toContain("read by employees");
  });

  it("caps sourceSegmentIds array size to keep the structured output tractable", () => {
    const prompt = buildFinalSystemPromptCtxV1({
      target: 3, los: [{ id: "lo-1", title: "x" }],
      videoEndSec: 641, priorTopics: [],
      allowedSegmentIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    expect(prompt).toMatch(/1-3 tags per question/);
  });

  it("works without allowedSegmentIds (backwards compat)", () => {
    const prompt = buildFinalSystemPromptCtxV1({
      target: 3, los: [{ id: "lo-1", title: "x" }],
      videoEndSec: 641, priorTopics: [],
    });
    expect(prompt).not.toContain("Evidence passages available");
    // Prompt still contains purity clause and sourceSegmentIds guidance
    expect(prompt).toContain("sourceSegmentIds");
    expect(prompt).toMatch(/MUST NOT contain the words "segment"/);
  });
});

// ─── §4 sanitiser contract regression ──────────────────────────────

describe("§4 — sanitiser still rejects segment-id leakage (contract unchanged)", () => {
  it("rejects a question stem that references 'segment [45]'", () => {
    const r = checkEmployeeFacingText({
      questionText: "What does segment [45] teach us about payroll access?",
      options: [
        { text: "SIN number" }, { text: "Date of birth" },
        { text: "Email" }, { text: "Password" },
      ],
      explanation: "The correct answer is SIN number.",
    });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.code === "EXPLICIT_SEGMENT_ID_REFERENCE")).toBe(true);
  });

  it("rejects 'According to transcript segment 12' phrasing", () => {
    const r = checkEmployeeFacingText({
      questionText: "According to transcript segment 12, what is the first step?",
      options: [
        { text: "Report the issue" }, { text: "Ignore it" },
        { text: "Discuss with coworker" }, { text: "Call HR" },
      ],
      explanation: "The correct answer is discuss with coworker.",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an option body that mentions 'segment 70'", () => {
    const r = checkEmployeeFacingText({
      questionText: "What is the proper procedure when an issue arises?",
      options: [
        { text: "Report as described in segment 70" }, { text: "Document" },
        { text: "Discuss" }, { text: "Ignore" },
      ],
      explanation: "The correct answer is Document.",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an explanation that references 'the transcript segments'", () => {
    const r = checkEmployeeFacingText({
      questionText: "What should staff do when a member is a former judge?",
      options: [
        { text: "Address them as 'Your Honor'" }, { text: "Address as 'Sir'" },
        { text: "No special address" }, { text: "Ask HR" },
      ],
      explanation: "See the transcript segments 48, 49 for details.",
    });
    expect(r.ok).toBe(false);
  });
});

// ─── §4 clean proposals pass sanitiser + structure ─────────────────

describe("§4 — proposals grounded in the transcript but WITHOUT id references pass both validators", () => {
  const cleanProposal = {
    questionText: "What is the proper first step when a staff member has a minor issue with a colleague?",
    options: [
      { text: "Report the colleague to a manager immediately.", isCorrect: false },
      { text: "Have a direct conversation with the colleague to resolve the issue.", isCorrect: true },
      { text: "File a written complaint without discussion.", isCorrect: false },
      { text: "Ignore the issue until it escalates.", isCorrect: false },
    ],
    explanation: "Policy at Silver Springs expects colleagues to attempt direct resolution before escalating to management.",
  };

  it("passes the employee-facing text sanitiser", () => {
    const r = checkEmployeeFacingText({
      questionText: cleanProposal.questionText,
      options: cleanProposal.options,
      explanation: cleanProposal.explanation,
    });
    expect(r.ok).toBe(true);
  });

  it("passes the question-structure validator", () => {
    const r = checkQuestionStructure(cleanProposal);
    expect(r.ok).toBe(true);
  });
});

// ─── §4 — 7 synthetic AI-shaped rejected fixtures all still fail ───

describe("§4 — 7 synthetic rejected-shape fixtures reproduce the AI run's sanitiser drops", () => {
  // Modelled after the AI shortfall: 7 proposals, all with
  // EXPLICIT_SEGMENT_ID_REFERENCE. Synthetic — the actual AI proposal
  // payloads were NOT persisted. Labelled per directive §4 disclosure.
  const synthetic = [
    {
      questionText: "According to segment 45, what should a server do first?",
      options: [{text:"a"}, {text:"b"}, {text:"c"}, {text:"d"}],
      explanation: "x",
    },
    {
      questionText: "The transcript at segment 47 explains that employees should:",
      options: [{text:"a"}, {text:"b"}, {text:"c"}, {text:"d"}],
      explanation: "x",
    },
    {
      questionText: "Per segment ids 48 and 49, what is the policy?",
      options: [{text:"a"}, {text:"b"}, {text:"c"}, {text:"d"}],
      explanation: "x",
    },
    {
      questionText: "What is the policy?",
      options: [
        { text: "See segment 90 for details." }, { text: "b" }, { text: "c" }, { text: "d" },
      ],
      explanation: "x",
    },
    {
      questionText: "What is the policy?",
      options: [
        { text: "a" }, { text: "b" }, { text: "c" }, { text: "d" },
      ],
      explanation: "The transcript segment 130 confirms this.",
    },
    {
      questionText: "In segment [134], the trainer explains that members should be addressed how?",
      options: [{text:"a"}, {text:"b"}, {text:"c"}, {text:"d"}],
      explanation: "x",
    },
    {
      questionText: "According to the training segments 155-159, what is the recommended approach?",
      options: [{text:"a"}, {text:"b"}, {text:"c"}, {text:"d"}],
      explanation: "x",
    },
  ];

  it.each(synthetic.map((p, i) => [i, p]))(
    "fixture #%s is rejected by sanitiser (EXPLICIT_SEGMENT_ID_REFERENCE reproduces)",
    (_i, p) => {
      const r = checkEmployeeFacingText({
        questionText: p.questionText,
        options: p.options.map((o) => ({ text: o.text })),
        explanation: p.explanation,
      });
      expect(r.ok).toBe(false);
      expect(r.findings.some((f) => f.code === "EXPLICIT_SEGMENT_ID_REFERENCE")).toBe(true);
    },
  );
});

// ─── §4 — grounding still protected ────────────────────────────────

describe("§4 — grounding still rejects an unauthorised sourceSegmentIds cite", () => {
  // Simulates the worker-handler's grounding check. Even with the AJ
  // prompt rewrite, a proposal whose sourceSegmentIds includes an id
  // outside the chunk's eligibleSegmentIds MUST fail.
  function groundingCheck(proposal: { sourceSegmentIds: number[] }, args: {
    eligibleSegmentIds: readonly number[];
    workerExcluded: ReadonlySet<number>;
  }): { pass: boolean; citedOutside: number[]; citedExcluded: number[] } {
    const eligible = new Set(args.eligibleSegmentIds);
    const citedOutside = proposal.sourceSegmentIds.filter((id) => !eligible.has(id));
    const citedExcluded = proposal.sourceSegmentIds.filter((id) => args.workerExcluded.has(id));
    return { pass: citedOutside.length === 0 && citedExcluded.length === 0, citedOutside, citedExcluded };
  }

  it("cite within chunk eligible passes", () => {
    const r = groundingCheck(
      { sourceSegmentIds: [45, 46] },
      { eligibleSegmentIds: [45, 46, 47, 48], workerExcluded: new Set([16, 17, 68, 160]) },
    );
    expect(r.pass).toBe(true);
  });

  it("cite to a worker-excluded id fails", () => {
    const r = groundingCheck(
      { sourceSegmentIds: [45, 68] },
      { eligibleSegmentIds: [45, 46, 47, 48], workerExcluded: new Set([16, 17, 68, 160]) },
    );
    expect(r.pass).toBe(false);
    expect(r.citedExcluded).toContain(68);
  });
});

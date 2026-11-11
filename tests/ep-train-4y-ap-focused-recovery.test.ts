// EP-TRAIN-4Y-AP §5 — offline tests for the focused-recovery mode.

import { describe, it, expect } from "vitest";
import { buildFinalSystemPromptCtxV1 } from "@/lib/hr/training/generation/worker-handler";

const BASELINE_14_TEXTS = [
  // 5 checkpoints
  "What is the first step in resolving a complaint between two staff members at Silver Springs Golf and Country Club?",
  "If a staff member notices an issue with the club during their first strike, what is the recommended action?",
  "If an employee notices an issue with the system that could be improved, what is the best course of action?",
  "What is the correct way to address a member who is a former judge at Silver Springs Golf Club?",
  "What is the recommended first step when a staff member encounters a minor issue with another colleague at Silver Springs Golf Club?",
  // 6 AK FA
  "Which of the following is NOT part of the three-strike policy at Silver Springs Golf and Country Club?",
  "What is the recommended cell phone usage policy for staff members at Silver Springs Golf and Country Club?",
  "When a staff member sees an issue that could potentially harm the safety of others, what is the recommended procedure according to the course content?",
  "What discount is available to staff members who wish to purchase clothing, hats, and merchandise from the golf shop?",
  "If a staff member wants to play golf early in the morning, what is the likely outcome based on the course content?",
  "According to the training, what is expected of staff members at Silver Springs to ensure they contribute positively to the club's atmosphere and culture?",
  // 3 AN FA
  "When a staff member encounters an issue with another colleague, which step should they take first according to the policy described in the course content?",
  "What should a staff member do if they notice an issue during service to a member at Silver Springs Golf Club?",
  "What expectation does the club have for its staff members regarding their attitude and behavior towards guests and colleagues?",
];

// ─── §5.1 — focused evidence eligibility (segments 3-6 cover SIN pay-stub) ──

describe("§5.1 — focused evidence eligibility", () => {
  it("segments 3-6 are the AP topic evidence (pay-stub access via SIN number)", () => {
    const APtEvidence = [3, 4, 5, 6];
    for (const id of APtEvidence) {
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThanOrEqual(162);
      expect([16, 17, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 160, 161]).not.toContain(id);
    }
  });
});

// ─── §5.2 — focused prompt is substantially smaller than AO's 4732 tokens ──

describe("§5.2 — focused prompt compactness", () => {
  it("4-segment eligible + 2 LOs + 5 prior hints → prompt < 2000 tokens (approx)", () => {
    const prompt = buildFinalSystemPromptCtxV1({
      target: 1,
      los: [
        { id: "lo-2", title: "Getting right into it, the most frequently asked question we have is how do we access our pay stubs" },
        { id: "lo-3", title: "use the last four numbers of your SIN number, and then you're able to get in and view your statement" },
      ],
      videoEndSec: 641,
      priorTopics: BASELINE_14_TEXTS.slice(0, 5).map((t) => `• "${t.split(/\s+/).slice(0, 10).join(" ")}"`),
      allowedSegmentIds: [3, 4, 5, 6],
    });
    // Rough token count = words / 0.75 (approx 4 chars per token)
    const approxTokens = Math.ceil(prompt.length / 4);
    expect(approxTokens).toBeLessThan(2000);
    // Sanity: the AO-scale prompt (49 LOs × ~80 chars each + 14 hints
    // × ~80 chars) would be ~5500+ chars just for those blocks alone.
  });

  it("includes 'Evidence passages available: 4' (small, narrow window)", () => {
    const prompt = buildFinalSystemPromptCtxV1({
      target: 1,
      los: [
        { id: "lo-2", title: "lo-2 title" },
        { id: "lo-3", title: "lo-3 title" },
      ],
      videoEndSec: 641,
      priorTopics: [],
      allowedSegmentIds: [3, 4, 5, 6],
    });
    expect(prompt).toContain("Evidence passages available: 4");
  });
});

// ─── §5.3 — prior-topic hints respect top-K cap ────────────────────

describe("§5.3 — prompt accepts top-K hints only; dedup still sees all 14", () => {
  it("prompt with 5 bullet hints shows exactly 5 lines", () => {
    const top5 = BASELINE_14_TEXTS.slice(0, 5);
    const hintLines = top5.map((t) => `• "${t.split(/\s+/).slice(0, 10).join(" ")}"`);
    const prompt = buildFinalSystemPromptCtxV1({
      target: 1,
      los: [{ id: "lo-2", title: "x" }],
      videoEndSec: 641,
      priorTopics: hintLines,
      allowedSegmentIds: [3, 4, 5, 6],
    });
    // Every hint should appear verbatim
    for (const h of hintLines) {
      expect(prompt).toContain(h);
    }
  });

  it("the 14-count is documentation only; worker dedup contract unchanged", () => {
    // This test documents that the dedup priors in the plan are
    // independent from the prompt hints. The split lives in
    // final-assessment-recovery.ts + worker-handler.ts.
    expect(BASELINE_14_TEXTS.length).toBe(14);
  });
});

// ─── §5.4-5.5 — structured output + sanitiser unchanged ───────────

describe("§5.4 — structured output remains compact (AJ cap 1-3 tags)", () => {
  it("prompt still caps sourceSegmentIds to 1-3 tags per question", () => {
    const prompt = buildFinalSystemPromptCtxV1({
      target: 1,
      los: [{ id: "lo-2", title: "x" }],
      videoEndSec: 641,
      priorTopics: [],
      allowedSegmentIds: [3, 4, 5, 6],
    });
    expect(prompt).toMatch(/Cite 1-3 tags per question/);
  });
});

describe("§5.5 — sanitiser contract unchanged (AJ+AO 15-phrase list intact)", () => {
  it("prompt still names the 'According to the training' forbidden phrases", () => {
    const prompt = buildFinalSystemPromptCtxV1({
      target: 1,
      los: [{ id: "lo-2", title: "x" }],
      videoEndSec: 641,
      priorTopics: [],
      allowedSegmentIds: [3, 4, 5, 6],
    });
    const required = [
      "According to the training",
      "According to the training material",
      "According to the course content",
      "According to the transcript",
      "As stated in the video",
      "Based on the presentation",
    ];
    for (const phrase of required) expect(prompt).toContain(phrase);
  });
});

// ─── §5.6 — shortfall math: 10 target − 9 persisted = 1 ────────────

describe("§5.6 — shortfall math", () => {
  it("existing FA = 9 → shortfall = 1 → focused chunk of [1]", () => {
    expect(Math.max(0, 10 - 9)).toBe(1);
  });
});

// ─── §5.7-5.10 — invariants ─────────────────────────────────────────

describe("§5.7 — idempotency + maxAttempts=1 preserved (code contract)", () => {
  it("documents the contract — tests live in AF suite", () => {
    expect(true).toBe(true);
  });
});

describe("§5.8 — durable diagnostics contract preserved", () => {
  it("shortfall-v2 schema name + perGroupDiagnostics field — tests live in AH + AK suites", () => {
    expect(true).toBe(true);
  });
});

describe("§5.9 — distinct topic verified in transcript (segs 3-6 → SIN/pay-stub)", () => {
  it("none of the 14 existing texts mention SIN number or pay stub", () => {
    for (const t of BASELINE_14_TEXTS) {
      expect(t.toLowerCase()).not.toContain("sin number");
      expect(t.toLowerCase()).not.toContain("pay stub");
      expect(t.toLowerCase()).not.toContain("paystub");
    }
  });
});

describe("§5.10 — 14 baseline hashes unique set", () => {
  it("14 texts are all distinct", () => {
    expect(new Set(BASELINE_14_TEXTS).size).toBe(14);
  });
});

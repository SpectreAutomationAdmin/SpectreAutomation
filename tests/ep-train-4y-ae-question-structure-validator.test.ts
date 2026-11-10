// EP-TRAIN-4Y-AE §4 + §7 — unit tests for the question-structure
// validator. Mirrors the live 5-draft inspection on staging, plus
// defensive synthetic cases.

import { describe, it, expect } from "vitest";
import {
  checkQuestionStructure,
  normaliseStructuredQuestion,
} from "@/lib/hr/training/ai-review/question-structure-validator";

describe("checkQuestionStructure — clean cases pass", () => {
  it("accepts a clean, structured question", () => {
    const r = checkQuestionStructure({
      questionText: "What is the first step in resolving a complaint between two staff members?",
      options: [
        { text: "Have a conversation between both co-workers.", isCorrect: true },
        { text: "Report the issue to management immediately.", isCorrect: false },
        { text: "Submit a formal complaint to HR.", isCorrect: false },
        { text: "Wait for management to notice the issue.", isCorrect: false },
      ],
      explanation: "The training recommends colleagues resolve minor issues directly first.",
    });
    expect(r.ok).toBe(true);
  });
});

describe("checkQuestionStructure — §4 defect detection", () => {
  it("flags EMBEDDED_OPTION_LINES_IN_STEM (A) B) inline after stem)", () => {
    const r = checkQuestionStructure({
      questionText:
        "If a staff member notices an issue, what is the recommended action? \n\nA) Ignore the issue.\nB) Report it.\nC) Fix it themselves.\nD) Wait for the next check.",
      options: [
        { text: "Ignore the issue.", isCorrect: false },
        { text: "Report it.", isCorrect: true },
        { text: "Fix it themselves.", isCorrect: false },
        { text: "Wait for the next check.", isCorrect: false },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("EMBEDDED_OPTION_LINES_IN_STEM");
  });

  it("flags OPTION_BODY_APPEARS_IN_STEM (prose duplication after ?)", () => {
    const r = checkQuestionStructure({
      questionText:
        "What is the best course of action? \n\nDiscuss the issue with other staff members.\n\nReport the issue to management.",
      options: [
        { text: "Discuss the issue with other staff members.", isCorrect: false },
        { text: "Report the issue to management.", isCorrect: true },
      ],
    });
    expect(r.findings.map((f) => f.code)).toContain("OPTION_BODY_APPEARS_IN_STEM");
  });

  it("flags CORRECT_ANSWER_KEY_IN_STEM ('**Correct Answer:** C')", () => {
    const r = checkQuestionStructure({
      questionText: "Pick one.\n\n**Correct Answer:** C",
      options: [
        { text: "Ok one", isCorrect: false },
        { text: "Ok two", isCorrect: false },
        { text: "Correct body", isCorrect: true },
      ],
    });
    expect(r.findings.map((f) => f.code)).toContain("CORRECT_ANSWER_KEY_IN_STEM");
  });

  it("flags TRANSCRIPT_REFERENCE_IN_STEM", () => {
    const r = checkQuestionStructure({
      questionText: "According to the transcript segments [15] and [18], what is the first step?",
      options: [
        { text: "Attend", isCorrect: true },
        { text: "Skip", isCorrect: false },
      ],
    });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("TRANSCRIPT_REFERENCE_IN_STEM");
  });

  it("flags DUPLICATE_OPTION_TEXT", () => {
    const r = checkQuestionStructure({
      questionText: "What is the first step?",
      options: [
        { text: "Report to management.", isCorrect: true },
        { text: "Report to management.", isCorrect: false },
        { text: "Discuss with colleague.", isCorrect: false },
      ],
    });
    expect(r.findings.map((f) => f.code)).toContain("DUPLICATE_OPTION_TEXT");
  });

  it("flags MISSING_CORRECT_OPTION", () => {
    const r = checkQuestionStructure({
      questionText: "What is the first step?",
      options: [
        { text: "A", isCorrect: false },
        { text: "B", isCorrect: false },
      ],
    });
    expect(r.findings.map((f) => f.code)).toContain("MISSING_CORRECT_OPTION");
  });

  it("flags MULTIPLE_CORRECT_OPTIONS", () => {
    const r = checkQuestionStructure({
      questionText: "What is the first step?",
      options: [
        { text: "A", isCorrect: true },
        { text: "B", isCorrect: true },
      ],
    });
    expect(r.findings.map((f) => f.code)).toContain("MULTIPLE_CORRECT_OPTIONS");
  });

  it("flags OPTION_LABEL_PREFIX_IN_TEXT when options carry 'A) ' prefixes", () => {
    const r = checkQuestionStructure({
      questionText: "Pick one.",
      options: [
        { text: "A) First", isCorrect: true },
        { text: "B) Second", isCorrect: false },
      ],
    });
    expect(r.findings.map((f) => f.code)).toContain("OPTION_LABEL_PREFIX_IN_TEXT");
  });
});

describe("normaliseStructuredQuestion — SAFE corrections only", () => {
  it("strips the inlined option block when every chunk matches an option", () => {
    const n = normaliseStructuredQuestion({
      questionText:
        "If a staff member notices an issue, what is the recommended action? \n\nA) Ignore the issue.\nB) Report it.\nC) Fix it themselves.\nD) Wait for the next check.",
      options: [
        { text: "Ignore the issue.", isCorrect: false },
        { text: "Report it.", isCorrect: true },
        { text: "Fix it themselves.", isCorrect: false },
        { text: "Wait for the next check.", isCorrect: false },
      ],
    });
    expect(n).not.toBeNull();
    expect(n!.normalised.questionText).toBe(
      "If a staff member notices an issue, what is the recommended action?",
    );
    expect(n!.remainingFindings).toEqual([]);
  });

  it("strips embedded 'Correct Answer: C' lines", () => {
    const n = normaliseStructuredQuestion({
      questionText:
        "Pick one. \n\n**A)** First\n**B)** Second\n**C)** Third\n\n**Correct Answer:** C",
      options: [
        { text: "A) First", isCorrect: false },
        { text: "B) Second", isCorrect: false },
        { text: "C) Third", isCorrect: true },
      ],
    });
    expect(n).not.toBeNull();
    expect(n!.normalised.questionText).not.toMatch(/Correct Answer/i);
    expect(n!.normalised.options.every((o) => !/^[A-D]\)/.test(o.text))).toBe(true);
  });

  it("strips option-body prose when every paragraph after '?' matches an option", () => {
    const n = normaliseStructuredQuestion({
      questionText:
        "What is the best course of action? \n\nDiscuss the issue with other staff members to gather opinions.\n\nReport the issue to management without offering a solution.",
      options: [
        { text: "Discuss the issue with other staff members to gather opinions.", isCorrect: false },
        { text: "Report the issue to management without offering a solution.", isCorrect: true },
      ],
    });
    expect(n).not.toBeNull();
    expect(n!.normalised.questionText).toBe("What is the best course of action?");
  });

  it("leaves remaining findings when ambiguous (stem ends mid-sentence)", () => {
    const n = normaliseStructuredQuestion({
      questionText:
        "Totally unrelated preamble.\nSomething else entirely.\nAccording to the transcript segments [1,2]…",
      options: [
        { text: "Alpha", isCorrect: true },
        { text: "Bravo", isCorrect: false },
      ],
    });
    // The normaliser can't safely remove the transcript-ref paragraph
    // without guessing where the real question ends; the remaining
    // finding is flagged.
    expect(n!.remainingFindings.length).toBeGreaterThan(0);
    expect(n!.remainingFindings.map((f) => f.code)).toContain("TRANSCRIPT_REFERENCE_IN_STEM");
  });
});

describe("checkQuestionStructure — the 5 live pilot drafts (2026-11-10 inspection)", () => {
  // Captured verbatim from test-results/4yae-pilot-drafts.json.
  const LIVE = [
    {
      id: "cmwa2axv1",
      questionText: "What is the recommended first step when a staff member encounters a minor issue with another colleague at Silver Springs Golf Club? Have a conversation with the general manager immediately. Document the issue and sign off on the documentation. Have a conversation between the two staff members involved. Involve a manager in the conversation right away.",
      options: [{ text: "A", isCorrect: false }, { text: "B", isCorrect: false }, { text: "C", isCorrect: true }, { text: "D", isCorrect: false }],
      expectedDefect: "OPTION_TOO_SHORT", // each option is just a single letter — label-only, no body
    },
    {
      id: "cmwa1p9or",
      questionText: "If a staff member notices an issue with the club during their first strike, what is the recommended action? \n\nA) Ignore the issue and continue using the club.\nB) Report the issue to management and follow the process to print off a near-miss report.\nC) Fix the issue themselves without reporting it.\nD) Wait until the next maintenance check to address the issue.",
      options: [
        { text: "A) Ignore the issue and continue using the club.", isCorrect: false },
        { text: "B) Report the issue to management and follow the process to print off a near-miss report.", isCorrect: true },
        { text: "C) Fix the issue themselves without reporting it.", isCorrect: false },
        { text: "D) Wait until the next maintenance check to address the issue.", isCorrect: false },
      ],
      expectedDefect: "EMBEDDED_OPTION_LINES_IN_STEM",
    },
    {
      id: "cmwa0dyha",
      questionText: "What is the first step in resolving a complaint between two staff members at Silver Springs Golf and Country Club?",
      options: [
        { text: "Have a conversation between both co-workers to resolve the issue themselves", isCorrect: true },
        { text: "Report the issue to management immediately", isCorrect: false },
        { text: "Submit a formal complaint to HR", isCorrect: false },
        { text: "Wait for management to notice the issue", isCorrect: false },
      ],
      expectedDefect: null, // clean
    },
  ];
  for (const t of LIVE) {
    it(`draft ${t.id}: expected defect = ${t.expectedDefect ?? "none"}`, () => {
      const r = checkQuestionStructure({ questionText: t.questionText, options: t.options });
      if (t.expectedDefect === null) {
        expect(r.ok).toBe(true);
      } else {
        expect(r.ok).toBe(false);
        expect(r.findings.map((f) => f.code)).toContain(t.expectedDefect);
      }
    });
  }
});

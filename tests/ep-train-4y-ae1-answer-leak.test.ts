// EP-TRAIN-4Y-AE1 §7 — regression tests for the exact founder-reported
// question (draft `cmwa15k3s`). The AE normaliser left this draft
// untouched because:
//   1. optionTextsLower.length > 10 excluded "Mr. Judge" (9) and
//      "Judge Sir" (9).
//   2. The EMBEDDED_OPTION_LINE_RX only matched newline-prefixed
//      option lines — the regression's exact shape was "\n\nA) Mr.
//      Judge\nB) Judge Sir\n…" which matched BUT the subsequent
//      chunk-matching stage rejected because of #1.
// AE1 lowers the threshold to 3, broadens the regex to match both
// newline- and space-prefixed sequences, and adds an advisory
// finding for editorial-note parentheticals.

import { describe, it, expect } from "vitest";
import {
  checkQuestionStructure,
  normaliseStructuredQuestion,
} from "@/lib/hr/training/ai-review/question-structure-validator";

describe("§7.1–3 — the exact founder-reported question", () => {
  // Captured verbatim from staging via scripts/4yae-inspect-pilot-drafts.mjs.
  const FOUNDER_REPORTED = {
    questionText:
      "What is the correct way to address a member who is a former judge at Silver Springs Golf Club? \n\nA) Mr. Judge\nB) Judge Sir\nC) Mr. Former Judge\nD) Sir Mr. surname (clarified by manager for publication)",
    options: [
      { text: "A) Mr. Judge", isCorrect: false },
      { text: "B) Judge Sir", isCorrect: false },
      { text: "C) Mr. Former Judge", isCorrect: false },
      { text: "D) Sir Mr. surname", isCorrect: true },
    ],
  };

  it("§2 — the raw draft is flagged with EMBEDDED_OPTION_LINES_IN_STEM + OPTION_LABEL_PREFIX_IN_TEXT", () => {
    const r = checkQuestionStructure(FOUNDER_REPORTED);
    expect(r.ok).toBe(false);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("EMBEDDED_OPTION_LINES_IN_STEM");
    expect(codes).toContain("OPTION_LABEL_PREFIX_IN_TEXT");
  });

  it("§3 — normaliser produces the exact expected stem", () => {
    const n = normaliseStructuredQuestion(FOUNDER_REPORTED);
    expect(n).not.toBeNull();
    expect(n!.normalised.questionText).toBe(
      "What is the correct way to address a member who is a former judge at Silver Springs Golf Club?",
    );
  });

  it("§3 — normaliser strips 'A) ' / 'B) ' prefixes from options", () => {
    const n = normaliseStructuredQuestion(FOUNDER_REPORTED);
    const opts = n!.normalised.options;
    expect(opts[0].text).toBe("Mr. Judge");
    expect(opts[1].text).toBe("Judge Sir");
    expect(opts[2].text).toBe("Mr. Former Judge");
    // Editorial annotation stays per §4.
    expect(opts[3].text).toBe("Sir Mr. surname");
  });

  it("§3 — correct-answer designation preserved across normalisation", () => {
    const n = normaliseStructuredQuestion(FOUNDER_REPORTED);
    const correct = n!.normalised.options.filter((o) => o.isCorrect);
    expect(correct).toHaveLength(1);
    expect(correct[0].text).toBe("Sir Mr. surname");
  });

  it("§4 — editorial-note parenthetical is ADVISORY (does not block ok)", () => {
    // Post-normalisation, the stem is clean. The '(clarified by…)'
    // tail got stripped with the D) chunk. Add one back to confirm
    // ADVISORY behaviour.
    const r = checkQuestionStructure({
      questionText:
        "What is the correct way to address a member who is a former judge at Silver Springs Golf Club? (clarified by manager for publication)",
      options: [
        { text: "Mr. Judge", isCorrect: false },
        { text: "Judge Sir", isCorrect: false },
        { text: "Mr. Former Judge", isCorrect: false },
        { text: "Sir Mr. surname", isCorrect: true },
      ],
    });
    // Advisory only — not blocking.
    expect(r.ok).toBe(true);
    const annotation = r.findings.find((f) => f.code === "SUSPECTED_EDITORIAL_ANNOTATION");
    expect(annotation).toBeDefined();
    expect(annotation!.advisory).toBe(true);
  });

  it("§3 — INLINE_OPTION_SEQUENCE_IN_STEM is detected when options are on the SAME line", () => {
    const inlineShape = {
      questionText:
        "What is the correct way to address a member who is a former judge at Silver Springs Golf Club? A) Mr. Judge B) Judge Sir C) Mr. Former Judge D) Sir Mr. surname",
      options: [
        { text: "Mr. Judge", isCorrect: false },
        { text: "Judge Sir", isCorrect: false },
        { text: "Mr. Former Judge", isCorrect: false },
        { text: "Sir Mr. surname", isCorrect: true },
      ],
    };
    const r = checkQuestionStructure(inlineShape);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("INLINE_OPTION_SEQUENCE_IN_STEM");
    // Normaliser should also strip the inline sequence.
    const n = normaliseStructuredQuestion(inlineShape);
    expect(n).not.toBeNull();
    expect(n!.normalised.questionText).toBe(
      "What is the correct way to address a member who is a former judge at Silver Springs Golf Club?",
    );
  });

  it("§3 — does not mangle a legitimate multi-sentence question", () => {
    const multi = {
      questionText:
        "A new employee asks about club etiquette on a Friday evening. What is the most important thing to tell them?",
      options: [
        { text: "Always greet members by name.", isCorrect: true },
        { text: "Stay out of sight on busy nights.", isCorrect: false },
      ],
    };
    const r = checkQuestionStructure(multi);
    expect(r.ok).toBe(true);
    const n = normaliseStructuredQuestion(multi);
    expect(n!.normalised.questionText).toBe(multi.questionText);
  });

  it("§3 — correct answer is NEVER inferred or changed by the normaliser", () => {
    // The option isCorrect flags must pass through unchanged, even
    // when the normaliser rewrites option.text.
    const n = normaliseStructuredQuestion({
      questionText: "Q? \n\nA) alpha body\nB) bravo body\nC) charlie body\nD) delta body",
      options: [
        { text: "A) alpha body", isCorrect: false },
        { text: "B) bravo body", isCorrect: true },
        { text: "C) charlie body", isCorrect: false },
        { text: "D) delta body", isCorrect: false },
      ],
    });
    expect(n!.normalised.options.map((o) => o.isCorrect)).toEqual([false, true, false, false]);
  });
});

describe("§7.4 — ambiguous cases refuse auto-correction", () => {
  it("rejects a stem with option chunks that DON'T match any option.text", () => {
    const n = normaliseStructuredQuestion({
      questionText: "Pick one.\n\nA) something unrelated\nB) also unrelated\nC) weird text\nD) nope",
      options: [
        { text: "Real option 1", isCorrect: true },
        { text: "Real option 2", isCorrect: false },
      ],
    });
    // Normaliser can't cut — remaining findings include the embedded
    // block.
    expect(n!.remainingFindings.map((f) => f.code)).toContain("EMBEDDED_OPTION_LINES_IN_STEM");
  });
});

describe("§7.5 — all five pilot drafts' latest active state", () => {
  // Latest active drafts post-AE repair (captured 2026-11-10).
  // Each tuple is [id, defect-after-AE1].
  const DRAFTS = [
    // These three are already clean (AE cleaned them OR they were
    // born clean). Normaliser is a noop.
    { id: "cmway7rdv", questionText: "If an employee notices an issue with the system that could be improved, what is the best course of action?", options: [{text:"Discuss the issue with other staff members to gather opinions.",isCorrect:false},{text:"Report the issue to management without offering a solution.",isCorrect:false},{text:"Offer a solution along with the report of the issue.",isCorrect:true},{text:"Ignore the issue and let it continue to affect the membership negatively.",isCorrect:false}], ok: true },
    { id: "cmway7qg2", questionText: "If a staff member notices an issue with the club during their first strike, what is the recommended action?", options: [{text:"Ignore the issue and continue using the club.",isCorrect:false},{text:"Report the issue to management and follow the process to print off a near-miss report.",isCorrect:true},{text:"Fix the issue themselves without reporting it.",isCorrect:false},{text:"Wait until the next maintenance check to address the issue.",isCorrect:false}], ok: true },
    { id: "cmwa0dyha", questionText: "What is the first step in resolving a complaint between two staff members at Silver Springs Golf and Country Club?", options: [{text:"Have a conversation between both co-workers to resolve the issue themselves",isCorrect:true},{text:"Report the issue to management immediately",isCorrect:false},{text:"Submit a formal complaint to HR",isCorrect:false},{text:"Wait for management to notice the issue",isCorrect:false}], ok: true },
  ];
  for (const d of DRAFTS) {
    it(`draft ${d.id} is already clean (ok=${d.ok})`, () => {
      const r = checkQuestionStructure({ questionText: d.questionText, options: d.options });
      expect(r.ok).toBe(d.ok);
    });
  }
});

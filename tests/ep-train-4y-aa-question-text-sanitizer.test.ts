// EP-TRAIN-4Y-AA §7 — unit tests for the employee-facing question
// text sanitiser. Uses the exact questionText strings observed on
// staging from the pilot run cmw9rrl1g000rj41xaoxvzqbb (captured by
// scripts/4yaa-staging-inspection.mjs on 2026-11-09) so this suite
// provably rejects every live-staging leakage class, not just
// synthetic contrived examples.

import { describe, expect, it } from "vitest";
import {
  checkEmployeeFacingText,
  codesForAudit,
} from "@/lib/hr/training/ai-review/question-text-sanitizer";

describe("checkEmployeeFacingText — negative cases", () => {
  it("passes a clean question with no internal references", () => {
    const r = checkEmployeeFacingText({
      questionText: "What is the correct way to address a club member who has retired?",
      options: [
        { text: "Mr. (Last Name)" },
        { text: "By their first name" },
      ],
      explanation: "Club etiquette specifies formal address for all members.",
    });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it("does not flag the bare word 'segment' in a non-leaking sentence", () => {
    const r = checkEmployeeFacingText({
      questionText: "What is the first segment of the club's brand?",
    });
    expect(r.ok).toBe(true);
  });
});

describe("checkEmployeeFacingText — live-staging leakage", () => {
  // Live Q5 from 4Y-Z pilot.
  it("flags 'according to the transcript segments [15] and [18]' as EXPLICIT_SEGMENT_ID_REFERENCE + ACCORDING_TO_TRANSCRIPT", () => {
    const r = checkEmployeeFacingText({
      questionText:
        "What is the first step in resolving a complaint between two staff members at Silver Springs Golf and Country Club according to the transcript segments [15] and [18]?",
    });
    expect(r.ok).toBe(false);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("ACCORDING_TO_TRANSCRIPT");
    expect(codes).toContain("EXPLICIT_SEGMENT_ID_REFERENCE");
  });

  // Live Q1 from 4Y-Z pilot.
  it("flags 'According to the transcript, what is …' as ACCORDING_TO_TRANSCRIPT", () => {
    const r = checkEmployeeFacingText({
      questionText:
        "According to the transcript, what is the correct way to address a member who is a former judge at Silver Springs Golf Club?",
    });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("ACCORDING_TO_TRANSCRIPT");
  });

  // Live Q2 from 4Y-Z pilot.
  it("flags 'according to the evidence window content' as ACCORDING_TO_EVIDENCE_WINDOW", () => {
    const r = checkEmployeeFacingText({
      questionText:
        "If a staff member notices an issue with the club during their first strike, what is the recommended action according to the evidence window content?",
    });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("ACCORDING_TO_EVIDENCE_WINDOW");
  });

  // Live Q3 from 4Y-Z pilot.
  it("flags 'according to the training material' as ACCORDING_TO_TRAINING_MATERIAL", () => {
    const r = checkEmployeeFacingText({
      questionText:
        "If an employee notices an issue with the system that could be improved, what is the best course of action according to the training material?",
    });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("ACCORDING_TO_TRAINING_MATERIAL");
  });

  // Live Q3 also contains the embedded answer key.
  it("flags embedded '**Correct Answer:** C' as EMBEDDED_ANSWER_KEY", () => {
    const r = checkEmployeeFacingText({
      questionText:
        "If an employee notices an issue with the system, offer a solution.\n\n**A)** Discuss\n**B)** Report\n**C)** Offer a solution\n**D)** Ignore\n\n**Correct Answer:** C",
    });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("EMBEDDED_ANSWER_KEY");
    expect(codes).toContain("EMBEDDED_MARKDOWN_OPTION_HEADER");
  });

  // Live Q4 from 4Y-Z pilot.
  it("flags embedded '*Segment IDs: [22, 28]*' as EXPLICIT_SEGMENT_ID_REFERENCE", () => {
    const r = checkEmployeeFacingText({
      questionText:
        "What is the recommended first step?\n\n*Segment IDs: [22, 28]*",
    });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("EXPLICIT_SEGMENT_ID_REFERENCE");
  });

  // Live Q1 option text leakage ("Sir Mr. [Last Name]").
  it("flags unresolved '[Last Name]' template placeholder in option text", () => {
    const r = checkEmployeeFacingText({
      questionText: "What is the correct way to address this member?",
      options: [
        { text: "Mr. Judge" },
        { text: "Judge Sir" },
        { text: "Mr. Former Judge" },
        { text: "Sir Mr. [Last Name]" },
      ],
    });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("UNRESOLVED_TEMPLATE_PLACEHOLDER");
  });
});

describe("codesForAudit", () => {
  it("returns an empty string on clean input", () => {
    const r = checkEmployeeFacingText({ questionText: "Clean text here." });
    expect(codesForAudit(r)).toBe("");
  });

  it("returns a comma-joined, sorted, deduplicated code list", () => {
    const r = checkEmployeeFacingText({
      questionText:
        "According to the transcript segments [15] and [18], answer.",
      options: [{ text: "According to the transcript." }],
    });
    // ACCORDING_TO_TRANSCRIPT appears twice (stem + option) but
    // codesForAudit deduplicates. EXPLICIT_SEGMENT_ID_REFERENCE
    // appears once.
    expect(codesForAudit(r)).toBe(
      "ACCORDING_TO_TRANSCRIPT,EXPLICIT_SEGMENT_ID_REFERENCE",
    );
  });
});

describe("pattern coverage — every code is reachable", () => {
  const cases: Record<string, string> = {
    ACCORDING_TO_TRANSCRIPT: "What happens according to the transcript?",
    ACCORDING_TO_EVIDENCE_WINDOW: "According to the evidence window, X.",
    ACCORDING_TO_TRAINING_MATERIAL: "According to the training materials, X.",
    EXPLICIT_SEGMENT_ID_REFERENCE: "See transcript segment 42 for context.",
    EMBEDDED_ANSWER_KEY: "Question? **Correct Answer:** A",
    EMBEDDED_MARKDOWN_OPTION_HEADER: "Pick one: **A)** X **B)** Y",
    UNRESOLVED_TEMPLATE_PLACEHOLDER: "Dear [First Name], welcome.",
  };
  for (const [code, text] of Object.entries(cases)) {
    it(`matches the ${code} pattern`, () => {
      const r = checkEmployeeFacingText({ questionText: text });
      const codes = r.findings.map((f) => f.code);
      expect(codes).toContain(code);
    });
  }
});

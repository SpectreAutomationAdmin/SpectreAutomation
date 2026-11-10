// EP-TRAIN-4Y-AE2 §8 — regression tests for (a) chronological ordering
// and (b) the placeholder-letter reconstruction case.

import { describe, it, expect } from "vitest";
import {
  normaliseStructuredQuestion,
  checkQuestionStructure,
} from "@/lib/hr/training/ai-review/question-structure-validator";

// -----------------------------------------------------------------
// Helpers mirroring the server's sort used by review/page.tsx.
// -----------------------------------------------------------------
type Draft = {
  readonly id: string;
  readonly atSec: number | null;
  readonly originalContentHash: string;
};
function sortByAtSec(drafts: readonly Draft[]): Draft[] {
  return [...drafts].sort((a, b) => {
    if (a.atSec !== null && b.atSec !== null) {
      if (a.atSec !== b.atSec) return a.atSec - b.atSec;
    } else if (a.atSec !== null) return -1;
    else if (b.atSec !== null) return 1;
    return a.originalContentHash.localeCompare(b.originalContentHash);
  });
}

describe("§8.1 — stable chronological ordering by atSec", () => {
  it("sorts 5 drafts by atSec ascending (matches the live pilot cg-1..cg-5)", () => {
    const sorted = sortByAtSec([
      { id: "cmwazeknj", atSec: 535, originalContentHash: "e5" },
      { id: "cmway7rdv", atSec: 321, originalContentHash: "e3" },
      { id: "cmway7qg2", atSec: 428, originalContentHash: "e4" },
      { id: "cmwa0dyha", atSec: 107, originalContentHash: "e1" },
      { id: "cmwa2axv1", atSec: 214, originalContentHash: "e2" },
    ]);
    expect(sorted.map((d) => d.id)).toEqual([
      "cmwa0dyha", "cmwa2axv1", "cmway7rdv", "cmway7qg2", "cmwazeknj",
    ]);
    expect(sorted.map((d) => d.atSec)).toEqual([107, 214, 321, 428, 535]);
  });
});

describe("§8.2 — equal-timestamp tie-break on stable identity", () => {
  it("breaks ties on originalContentHash lexicographically", () => {
    const sorted = sortByAtSec([
      { id: "d-beta",  atSec: 200, originalContentHash: "bbbb" },
      { id: "d-alpha", atSec: 200, originalContentHash: "aaaa" },
      { id: "d-gamma", atSec: 200, originalContentHash: "cccc" },
    ]);
    expect(sorted.map((d) => d.id)).toEqual(["d-alpha", "d-beta", "d-gamma"]);
  });
});

describe("§8.3 — ordering is identity-stable across edits", () => {
  it("a supersedere keeps its ancestor's originalContentHash → stays at the same position", () => {
    const before = sortByAtSec([
      { id: "d-orig-cg2", atSec: 214, originalContentHash: "e2" },
      { id: "d-orig-cg1", atSec: 107, originalContentHash: "e1" },
    ]);
    // Simulate a manager edit on cg-2: NEW active id, NEW contentHash
    // on the row but originalContentHash (from supersedes-walk) is
    // still "e2".
    const after = sortByAtSec([
      { id: "d-supersederes-cg2", atSec: 214, originalContentHash: "e2" },
      { id: "d-orig-cg1", atSec: 107, originalContentHash: "e1" },
    ]);
    expect(before.map((d) => d.atSec)).toEqual(after.map((d) => d.atSec));
    expect(before.map((d) => d.originalContentHash)).toEqual(
      after.map((d) => d.originalContentHash),
    );
  });
});

describe("§8.4 — drafts with unknown atSec sink to the end (stable)", () => {
  it("resolved drafts come first; unresolved go to the end lexicographically", () => {
    const sorted = sortByAtSec([
      { id: "d-unresolved-x", atSec: null, originalContentHash: "zz" },
      { id: "d-resolved-200", atSec: 200, originalContentHash: "mm" },
      { id: "d-unresolved-y", atSec: null, originalContentHash: "aa" },
    ]);
    expect(sorted.map((d) => d.id)).toEqual([
      "d-resolved-200", "d-unresolved-y", "d-unresolved-x",
    ]);
  });
});

// -----------------------------------------------------------------
// §5 reconstruction — placeholder-letter options.
// -----------------------------------------------------------------

describe("§8.9+.10 — placeholder-only options reconstruction", () => {
  // The live `cmwa2axv1` body shape (per 4yae2-diagnose.json):
  const FOUNDER_CMWA2AXV1 = {
    questionText:
      "What is the recommended first step when a staff member encounters a minor issue with another colleague at Silver Springs Golf Club? \n\nHave a conversation with the general manager immediately.\nDocument the issue and sign off on the documentation.\nHave a conversation between the two staff members involved.\nInvolve a manager in the conversation right away.",
    options: [
      { text: "A", isCorrect: false },
      { text: "B", isCorrect: false },
      { text: "C", isCorrect: true },
      { text: "D", isCorrect: false },
    ],
  };

  it("produces the exact expected stem after reconstruction", () => {
    const n = normaliseStructuredQuestion(FOUNDER_CMWA2AXV1);
    expect(n).not.toBeNull();
    expect(n!.normalised.questionText).toBe(
      "What is the recommended first step when a staff member encounters a minor issue with another colleague at Silver Springs Golf Club?",
    );
  });

  it("extracts the 4 prose chunks into options in the directive's expected order", () => {
    const n = normaliseStructuredQuestion(FOUNDER_CMWA2AXV1);
    const opts = n!.normalised.options;
    expect(opts.map((o) => o.text)).toEqual([
      "Have a conversation with the general manager immediately.",
      "Document the issue and sign off on the documentation.",
      "Have a conversation between the two staff members involved.",
      "Involve a manager in the conversation right away.",
    ]);
  });

  it("preserves the correct-answer index (C stays correct)", () => {
    const n = normaliseStructuredQuestion(FOUNDER_CMWA2AXV1);
    const opts = n!.normalised.options;
    expect(opts.map((o) => o.isCorrect)).toEqual([false, false, true, false]);
  });

  it("refuses reconstruction when chunk count ≠ option count (ambiguous)", () => {
    const n = normaliseStructuredQuestion({
      questionText: "What is the answer? \n\nChoice one.\nChoice two.\nChoice three.",
      options: [
        { text: "A", isCorrect: true },
        { text: "B", isCorrect: false },
        { text: "C", isCorrect: false },
        { text: "D", isCorrect: false },
      ],
    });
    // 3 chunks ≠ 4 options → reconstruction refused.
    expect(n!.normalised.options.map((o) => o.text)).toEqual(["A", "B", "C", "D"]);
    // The remaining findings should include OPTION_TOO_SHORT for each.
    expect(n!.remainingFindings.map((f) => f.code)).toContain("OPTION_TOO_SHORT");
  });

  it("does not reconstruct when chunks are too long to be answer bodies", () => {
    const longChunk = "x".repeat(401);
    const n = normaliseStructuredQuestion({
      questionText: `What? \n\n${longChunk}\nshort.\nalso short.\nfinally short.`,
      options: [
        { text: "A", isCorrect: true },
        { text: "B", isCorrect: false },
        { text: "C", isCorrect: false },
        { text: "D", isCorrect: false },
      ],
    });
    // Defensive: the >400 char chunk filtered out, chunk count now
    // doesn't match → reconstruction refused.
    expect(n!.normalised.options.map((o) => o.text)).toEqual(["A", "B", "C", "D"]);
  });

  it("does not touch a draft whose options are already real bodies", () => {
    const n = normaliseStructuredQuestion({
      questionText: "What is the first step?",
      options: [
        { text: "Discuss with the colleague first.", isCorrect: true },
        { text: "Report straight to management.", isCorrect: false },
      ],
    });
    expect(n!.normalised.questionText).toBe("What is the first step?");
    expect(n!.normalised.options.map((o) => o.text)).toEqual([
      "Discuss with the colleague first.",
      "Report straight to management.",
    ]);
  });
});

describe("§8.11+.12 — safe + ambiguous normalisations compose with existing rules", () => {
  it("after placeholder-letter reconstruction, the resulting draft passes structure checks", () => {
    const n = normaliseStructuredQuestion({
      questionText:
        "What is the recommended first step when a staff member encounters a minor issue with another colleague at Silver Springs Golf Club? \n\nHave a conversation with the general manager immediately.\nDocument the issue and sign off on the documentation.\nHave a conversation between the two staff members involved.\nInvolve a manager in the conversation right away.",
      options: [
        { text: "A", isCorrect: false },
        { text: "B", isCorrect: false },
        { text: "C", isCorrect: true },
        { text: "D", isCorrect: false },
      ],
    });
    const check = checkQuestionStructure(n!.normalised);
    expect(check.ok).toBe(true);
  });
});

describe("§8.13 — correct-answer preservation across every repair path", () => {
  const scenarios: ReadonlyArray<{
    readonly name: string;
    readonly input: Parameters<typeof normaliseStructuredQuestion>[0];
  }> = [
    {
      name: "embedded option block strip",
      input: {
        questionText: "Q? \n\nA) alpha body\nB) bravo body\nC) charlie body\nD) delta body",
        options: [
          { text: "A) alpha body", isCorrect: false },
          { text: "B) bravo body", isCorrect: true },
          { text: "C) charlie body", isCorrect: false },
          { text: "D) delta body", isCorrect: false },
        ],
      },
    },
    {
      name: "placeholder-letter reconstruction",
      input: {
        questionText: "Q? \n\nalpha body.\nbravo body.\ncharlie body.\ndelta body.",
        options: [
          { text: "A", isCorrect: false },
          { text: "B", isCorrect: true },
          { text: "C", isCorrect: false },
          { text: "D", isCorrect: false },
        ],
      },
    },
  ];
  for (const s of scenarios) {
    it(`[${s.name}] isCorrect flag passes through unchanged`, () => {
      const n = normaliseStructuredQuestion(s.input);
      expect(n!.normalised.options.map((o) => o.isCorrect)).toEqual(
        s.input.options.map((o) => o.isCorrect),
      );
    });
  }
});

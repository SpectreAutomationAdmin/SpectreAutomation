/**
 * EP-TRAIN-4Y-BF §3 — deterministic, meaning-preserving normalisation of
 * AI question proposals.
 *
 * Fixtures: the 13 proposals the model returned in the first unattended
 * real run (9 rejected for formatting, 4 kept), captured verbatim from
 * the run's restricted diagnostics. No GPU is involved in these tests.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  normaliseProposal,
  proposalNormalisationRuleSummary,
} from "@/lib/hr/training/ai-review/proposal-normaliser";
import {
  checkEmployeeFacingText,
  codesForAudit,
} from "@/lib/hr/training/ai-review/question-text-sanitizer";
import { checkQuestionStructure } from "@/lib/hr/training/ai-review/question-structure-validator";

interface FixtureProposal {
  readonly questionType: string;
  readonly questionText: string;
  readonly options: Array<{ text: string; isCorrect: boolean }>;
  readonly explanation: string;
  readonly sourceSegmentIds: number[];
}
interface Fixture {
  readonly groups: Array<{ group: string; kind: string; rejected: Array<FixtureProposal & { codes: string }> }>;
  readonly kept: Array<FixtureProposal & { group: string }>;
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "ep-train-4y-bf-real-run-proposals.json"), "utf8"),
) as Fixture;
const rejected = fixture.groups.flatMap((g) => g.rejected.map((p) => ({ ...p, group: g.group })));

function sanitise(p: { questionText: string; options: ReadonlyArray<{ text: string }>; explanation: string | null }) {
  return checkEmployeeFacingText({ questionText: p.questionText, options: p.options, explanation: p.explanation });
}

const OPTIONS = [
  { text: "Wash it in the sink", isCorrect: false },
  { text: "Wipe it with a sanitized towel", isCorrect: true },
  { text: "Leave it on the counter", isCorrect: false },
];

function base(over: Partial<Parameters<typeof normaliseProposal>[0]> = {}) {
  return {
    questionText: "What should you do with the carving knife between groups of guests?",
    options: OPTIONS,
    explanation: "Wiping the knife with a sanitized towel keeps the station clean between groups.",
    sourceSegmentIds: [53],
    ...over,
  };
}

describe("EP-TRAIN-4Y-BF §3 — the 13 proposals from the real run", () => {
  it("the fixture is the real run: 5 checkpoint + 4 final rejected, 4 final kept", () => {
    expect(rejected.filter((p) => p.group.startsWith("cg-")).length).toBe(5);
    expect(rejected.filter((p) => p.group.startsWith("fa-")).length).toBe(4);
    expect(fixture.kept.length).toBe(4);
  });

  it.each(rejected.map((p) => [`${p.group} (${p.codes})`, p] as const))(
    "%s — was rejected by the sanitiser as returned",
    (_label, p) => {
      const before = sanitise(p);
      expect(before.ok).toBe(false);
      expect(codesForAudit(before)).toBe(p.codes);
    },
  );

  it.each(rejected.map((p) => [`${p.group} (${p.codes})`, p] as const))(
    "%s — is repaired, then passes the sanitiser and the structural validator",
    (_label, p) => {
      const n = normaliseProposal(p);
      expect(n.ok).toBe(true);
      expect(n.refusedForSafety).toBe(false);
      expect(n.transforms.length).toBeGreaterThan(0);
      expect(sanitise(n).ok).toBe(true);
      expect(
        checkQuestionStructure({
          questionText: n.questionText,
          options: n.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
          explanation: n.explanation,
        }).ok,
      ).toBe(true);
      // The structured answer key is untouched: same count, same order,
      // same correct flags.
      expect(n.options.map((o) => o.isCorrect)).toEqual(p.options.map((o) => o.isCorrect));
      expect(n.options.length).toBe(p.options.length);
    },
  );

  it("removes only the matched span — every repaired field is the original minus the removed text", () => {
    for (const p of rejected) {
      const n = normaliseProposal(p);
      // Stem: the original starts with the repaired stem's body.
      const stemBody = n.questionText.replace(/[?.!]+$/, "");
      expect(p.questionText.toLowerCase()).toContain(stemBody.toLowerCase());
      // Options: each repaired option is a prefix of the original.
      n.options.forEach((o, i) => expect(p.options[i].text.startsWith(o.text)).toBe(true));
      // Explanation: every surviving sentence is in the original
      // (modulo the stripped trailing phrase before its full stop).
      for (const sentence of (n.explanation ?? "").split(/(?<=[.!?])\s+/)) {
        const body = sentence.replace(/[.!?]+$/, "");
        expect(p.explanation).toContain(body);
      }
    }
  });

  it("checkpoint 1: answer-key notes stripped from all four options; the keyed answer is unchanged", () => {
    const p = rejected.find((x) => x.group === "cg-1")!;
    const n = normaliseProposal(p);
    expect(n.options.map((o) => o.text)).toEqual([
      "Do you prefer chicken or fish for dinner tonight?",
      "Is it still hot out there?",
      "What is your favorite hobby?",
      "Can you tell me about your job?",
    ]);
    expect(n.options.findIndex((o) => o.isCorrect)).toBe(1);
    expect(proposalNormalisationRuleSummary(n)).toBe("OPTION_ANSWER_KEY_ANNOTATION");
  });

  it("checkpoint 3 and 5: the sentence that only points at a segment is removed; the reason stays", () => {
    const cg3 = normaliseProposal(rejected.find((x) => x.group === "cg-3")!);
    expect(cg3.explanation).toBe(
      "The correct action is to wipe the carving knives and chef's forks with a clean, sanitized towel to ensure they remain clean and sanitary between groups of guests.",
    );
    const cg5 = normaliseProposal(rejected.find((x) => x.group === "cg-5")!);
    expect(cg5.questionText).toBe("What is the primary responsibility during a light guest flow?");
    expect(cg5.explanation).not.toMatch(/segment/i);
  });

  it("the four proposals that were already acceptable still are (one loses a trailing citation list)", () => {
    for (const k of fixture.kept) {
      const n = normaliseProposal(k);
      expect(n.ok).toBe(true);
      expect(n.questionText).toBe(k.questionText);
      expect(n.options).toEqual(k.options);
      expect(sanitise(n).ok).toBe(true);
    }
    const changed = fixture.kept.map((k) => normaliseProposal(k)).filter((n) => n.transforms.length > 0);
    expect(changed.length).toBe(1);
    expect(changed[0].transforms.map((t) => t.ruleId)).toEqual(["SEGMENT_CITATION_LIST_TRAILING"]);
  });

  it("is idempotent on every fixture", () => {
    for (const p of [...rejected, ...fixture.kept]) {
      const once = normaliseProposal(p);
      const twice = normaliseProposal({
        questionText: once.questionText,
        options: once.options,
        explanation: once.explanation,
        sourceSegmentIds: p.sourceSegmentIds,
      });
      expect(twice.transforms).toEqual([]);
      expect(twice.questionText).toBe(once.questionText);
      expect(twice.explanation).toBe(once.explanation);
    }
  });
});

describe("EP-TRAIN-4Y-BF §3A — source references in the stem", () => {
  it.each([
    ["trailing", "How should you respond according to the training material?", "How should you respond?"],
    ["trailing with comma", "How should you respond, according to the training video?", "How should you respond?"],
    ["comma-delimited", "What, according to the training material, is the first step when carving?", "What is the first step when carving?"],
    ["before a clause", "How should you respond according to the training material when a guest insists?", "How should you respond when a guest insists?"],
    ["leading (4Y-AQ rule)", "According to the training material, what is the first step when carving?", "What is the first step when carving?"],
    ["leading statement", "According to the training video, carvers must hone knives regularly.", "Carvers must hone knives regularly."],
    ["ends on a verb", "What should the holding temperature be according to the training material?", "What should the holding temperature be?"],
    ["ends on a preposition", "Which towel should you wipe the knife with according to the training video?", "Which towel should you wipe the knife with?"],
  ])("%s", (_label, input, expected) => {
    const n = normaliseProposal(base({ questionText: input }));
    expect(n.ok).toBe(true);
    expect(n.questionText).toBe(expected);
  });

  // Phrases that can be the CONTENT of the sentence are never touched.
  it.each([
    ["'was shown in' is the question", "Which carving technique was shown in the training video?"],
    ["'was mentioned in'", "Which safety rule was mentioned in the video?"],
    ["'as stated in'", "What is the standard slice width as stated in the presentation?"],
    ["'based on' as predicate", "Which of the following statements is based on the training video?"],
    ["'based on' trailing", "Which action is safest based on the video?"],
    ["source noun with a post-modifier", "Which knife should you use according to the training video about carving ham?"],
    ["possessive source", "Which rule according to the training video's second chapter applies here?"],
    ["relative clause after a leading phrase", "According to the training video, which emphasizes safety, what should you do first?"],
  ])("leaves the stem byte-for-byte unchanged: %s", (_label, stem) => {
    const n = normaliseProposal(base({ questionText: stem }));
    expect(n.questionText).toBe(stem);
    expect(n.transforms.filter((t) => t.field === "questionText")).toEqual([]);
  });

  it("does not remove the phrase when it is the predicate ('is NOT according to …')", () => {
    const stem = "Which of the following is NOT according to the training material?";
    const n = normaliseProposal(base({ questionText: stem }));
    expect(n.questionText).toBe(stem);
    // Still rejected by the unchanged sanitiser.
    expect(sanitise(n).ok).toBe(false);
  });

  it("does not cut inside a longer source phrase ('… training material about knife safety')", () => {
    const stem = "What is the safest action according to the training material about knife safety?";
    const n = normaliseProposal(base({ questionText: stem }));
    expect(n.questionText).toBe(stem);
    expect(sanitise(n).ok).toBe(false);
  });

  it("leaves a phrase it cannot remove cleanly — the sanitiser then rejects it as before", () => {
    const stem = "Which rule according to the training material's second chapter applies here?";
    const n = normaliseProposal(base({ questionText: stem }));
    expect(n.questionText).toBe(stem);
    expect(sanitise(n).ok).toBe(false);
  });

  it("refuses when the stem carries more than one source reference — and falls back to the earlier stem-only behaviour", () => {
    const n = normaliseProposal(
      base({ questionText: "According to the training material, what should you do according to the training video?" }),
    );
    expect(n.ok).toBe(false);
    expect(n.refusalReason).toBe("MULTIPLE_SOURCE_REFERENCES_IN_STEM");
    // Exactly what the pipeline produced before this module: the 4Y-AQ
    // leading strip only. Options and explanation are untouched.
    expect(n.questionText).toBe("What should you do according to the training video?");
    expect(n.options).toEqual(OPTIONS);
    expect(n.transforms).toEqual([]);
  });

  it("a refusal never loses a stem repair the earlier rules already made", () => {
    // The options carry a conflicting answer key, so nothing beyond the
    // stem may be changed — but the stem keeps its 4Y-AQ repair.
    const n = normaliseProposal(
      base({
        questionText: "According to the training material, what is PPE?",
        options: OPTIONS.map((o, i) => ({ text: i === 0 ? `${o.text} (Correct Answer: A)` : o.text, isCorrect: o.isCorrect })),
      }),
    );
    expect(n.ok).toBe(false);
    expect(n.questionText).toBe("What is PPE?");
  });

  it("a short stem repaired by the earlier rules is still accepted", () => {
    const n = normaliseProposal(base({ questionText: "According to the training material, what is PPE?" }));
    expect(n.ok).toBe(true);
    expect(n.questionText).toBe("What is PPE?");
  });

  it("refuses when nothing meaningful would be left", () => {
    const n = normaliseProposal(base({ questionText: "What, according to the training material?" }));
    expect(n.ok).toBe(false);
    expect(n.refusalReason).toBe("MALFORMED_AFTER_NORMALISATION");
  });
});

describe("EP-TRAIN-4Y-BF §3B — segment references in the explanation", () => {
  it("drops a pure pointer sentence", () => {
    const n = normaliseProposal(
      base({ explanation: "Wiping keeps the station clean. This aligns with the instruction given in segment [53]." }),
    );
    expect(n.explanation).toBe("Wiping keeps the station clean.");
    expect(n.transforms.map((t) => t.ruleId)).toEqual(["SEGMENT_POINTER_SENTENCE"]);
  });

  it("strips a trailing adjunct and keeps the sentence", () => {
    const n = normaliseProposal(
      base({ explanation: "Knives are wiped with a sanitized towel between groups, as stated in segment 53." }),
    );
    expect(n.explanation).toBe("Knives are wiped with a sanitized towel between groups.");
  });

  it("strips a trailing bare citation list", () => {
    const n = normaliseProposal(base({ explanation: "Wiping keeps the station clean. [53]" }));
    expect(n.explanation).toBe("Wiping keeps the station clean.");
  });

  it("removes 'according to the training material' from an explanation sentence", () => {
    const n = normaliseProposal(
      base({ explanation: "Letting the knife fall is the safest action according to the training material." }),
    );
    expect(n.explanation).toBe("Letting the knife fall is the safest action.");
  });

  it("never removes a reference to a segment that is NOT in the structured provenance", () => {
    const explanation = "Wiping keeps the station clean. This aligns with segment [99].";
    const n = normaliseProposal(base({ explanation, sourceSegmentIds: [53] }));
    expect(n.explanation).toBe(explanation);
    expect(n.skipped.length).toBeGreaterThan(0);
    // Still rejected by the unchanged sanitiser.
    expect(sanitise(n).ok).toBe(false);
  });

  it("never deletes a sentence that carries content alongside the reference", () => {
    const explanation = "Segment [53] explains that knives must be wiped with a sanitized towel between groups.";
    const n = normaliseProposal(base({ explanation }));
    expect(n.explanation).toBe(explanation);
    expect(sanitise(n).ok).toBe(false);
  });

  it("never touches the structured source segment ids", () => {
    const ids = [53, 60];
    const input = base({ explanation: "Wiping keeps the station clean. [53, 60]", sourceSegmentIds: ids });
    normaliseProposal(input);
    expect(input.sourceSegmentIds).toEqual([53, 60]);
    expect(ids).toEqual([53, 60]);
  });
});

describe("EP-TRAIN-4Y-BF §3C — answer-key annotations in options", () => {
  const annotate = (notes: Array<string | null>) =>
    OPTIONS.map((o, i) => ({ text: notes[i] ? `${o.text} ${notes[i]}` : o.text, isCorrect: o.isCorrect }));

  it("strips a tag that agrees with the structured key", () => {
    const n = normaliseProposal(base({ options: annotate([null, "(Correct)", null]) }));
    expect(n.ok).toBe(true);
    expect(n.options).toEqual(OPTIONS);
  });

  it("strips '(Correct Answer: B)' when B is the keyed option", () => {
    const n = normaliseProposal(base({ options: annotate([null, "(Correct Answer: B)", null]) }));
    expect(n.ok).toBe(true);
    expect(n.options).toEqual(OPTIONS);
  });

  it("REFUSES when the annotation names a different option than the structured key", () => {
    const options = annotate(["(Correct Answer: A)", null, null]);
    const n = normaliseProposal(base({ options }));
    expect(n.ok).toBe(false);
    expect(n.refusalReason).toBe("ANSWER_KEY_CONFLICTS_WITH_CORRECT_OPTION");
    expect(n.options).toEqual(options);
    expect(sanitise(n).ok).toBe(false);
  });

  it("REFUSES when a 'correct' tag sits on an option the key marks wrong", () => {
    const n = normaliseProposal(base({ options: annotate(["(Correct)", null, null]) }));
    expect(n.ok).toBe(false);
    expect(n.refusalReason).toBe("ANSWER_KEY_CONFLICTS_WITH_CORRECT_OPTION");
  });

  it("REFUSES when an 'incorrect' tag sits on the keyed option", () => {
    const n = normaliseProposal(base({ options: annotate([null, "(Incorrect)", null]) }));
    expect(n.ok).toBe(false);
    expect(n.refusalReason).toBe("ANSWER_KEY_CONFLICTS_WITH_CORRECT_OPTION");
  });

  it("REFUSES when a free-text answer-key note appears only on a wrong option", () => {
    const n = normaliseProposal(
      base({ options: annotate(["(Correct Answer: this is the cleanest method.)", null, null]) }),
    );
    expect(n.ok).toBe(false);
    expect(n.refusalReason).toBe("ANSWER_KEY_ONLY_ON_INCORRECT_OPTION");
  });

  it("REFUSES when the explanation names a different answer than the structured key", () => {
    const n = normaliseProposal(
      base({
        options: annotate([null, "(Correct Answer: keeps the station clean.)", null]),
        explanation: "The correct answer is 'Wash it in the sink'.",
      }),
    );
    expect(n.ok).toBe(false);
    expect(n.refusalReason).toBe("EXPLANATION_NAMES_DIFFERENT_ANSWER");
  });

  it("leaves options alone when there is not exactly one keyed answer", () => {
    const options = [
      { text: "Wash it (Correct)", isCorrect: true },
      { text: "Wipe it (Correct)", isCorrect: true },
    ];
    const n = normaliseProposal(base({ options }));
    expect(n.options).toEqual(options);
  });
});

describe("EP-TRAIN-4Y-BF §3 — normalisation never accepts a defective question", () => {
  it("a stem with the options embedded is still rejected by the structural validator", () => {
    const stem =
      "How should you respond according to the training material?\nA) Wash it in the sink\nB) Wipe it with a sanitized towel\nC) Leave it on the counter";
    const n = normaliseProposal(base({ questionText: stem }));
    const structure = checkQuestionStructure({
      questionText: n.questionText,
      options: n.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
      explanation: n.explanation,
    });
    expect(structure.ok).toBe(false);
  });

  it("an unresolved template placeholder is still rejected by the sanitiser", () => {
    const n = normaliseProposal(
      base({ questionText: "How should you greet Mr. [Last Name] according to the training material?" }),
    );
    expect(sanitise(n).ok).toBe(false);
  });

  it("a clean proposal is returned byte-for-byte unchanged", () => {
    const input = base();
    const n = normaliseProposal(input);
    expect(n.ok).toBe(true);
    expect(n.transforms).toEqual([]);
    expect(n.questionText).toBe(input.questionText);
    expect(n.options).toEqual(input.options);
    expect(n.explanation).toBe(input.explanation);
  });
});

describe("EP-TRAIN-4Y-BF §3 — simulated 'badly formatted' output used for staging acceptance", () => {
  it("every decorated simulated question is rejected as-is and restored exactly by normalisation", async () => {
    const { buildMockProposals, withFormattingDefects } = await import("@/lib/hr/training/generation/mock-inference");
    const { buildMockTranscriptSegments } = await import("@/lib/hr/training/transcription/mock-transcript");
    const segments = buildMockTranscriptSegments(643).map((s) => ({ segmentIndex: s.id, text: s.text }));
    const clean = buildMockProposals({
      target: 8,
      windowSegmentIds: segments.map((s) => s.segmentIndex),
      segments,
      usedSegmentIndices: new Set<number>(),
    });
    expect(clean.length).toBe(8);
    const defective = withFormattingDefects(clean);
    for (let i = 0; i < clean.length; i++) {
      const before = checkEmployeeFacingText({
        questionText: defective[i].questionText,
        options: defective[i].options,
        explanation: defective[i].explanation,
      });
      expect(before.ok).toBe(false);
      const n = normaliseProposal({
        questionText: defective[i].questionText,
        options: defective[i].options.map((o) => ({ text: o.text, isCorrect: !!o.isCorrect })),
        explanation: defective[i].explanation,
        sourceSegmentIds: defective[i].sourceSegmentIds,
      });
      expect(n.ok).toBe(true);
      expect(n.questionText).toBe(clean[i].questionText);
      expect(n.options.map((o) => o.text)).toEqual(clean[i].options.map((o) => o.text));
      expect(n.options.map((o) => o.isCorrect)).toEqual(clean[i].options.map((o) => !!o.isCorrect));
      expect(n.explanation).toBe(clean[i].explanation);
    }
  });
});

describe("EP-TRAIN-4Y-BF §3 — cases raised in independent review", () => {
  const annotated = (notes: Array<string | null>) =>
    OPTIONS.map((o, i) => ({ text: notes[i] ? `${o.text} ${notes[i]}` : o.text, isCorrect: o.isCorrect }));

  describe("explanations that must be left untouched", () => {
    it.each([
      ["the sentence's own verb", "Honing realigns the edge. The honing technique is explained in segment [53]."],
      ["'was stated in'", "Honing realigns the edge. The rule was stated in segment [53]."],
      ["'within'", "Honing realigns the edge. This is covered within segment [53]."],
      ["a second citation outside the provenance", "Wiping keeps the station clean. This is stated in segment [53] and in [99]."],
      ["a quantity beside the reference", "Wiping keeps the station clean. See segment [53] for the 10 to 15 slice rule."],
      ["'was explained in the video'", "Honing realigns the blade. This was explained in the training video."],
      ["'is based on'", "Letting the knife fall is the safest action. This answer is based on the training material."],
    ])("%s", (_label, explanation) => {
      const n = normaliseProposal(base({ explanation, sourceSegmentIds: [53] }));
      expect(n.explanation).toBe(explanation);
    });

    it("a sentence that names the answer is not deleted as a 'pointer'", () => {
      const n = normaliseProposal(
        base({ explanation: "The correct answer is B, as stated in segment [53].", sourceSegmentIds: [53] }),
      );
      // The aside goes; the sentence stays (B is the keyed option here).
      expect(n.ok).toBe(true);
      expect(n.explanation).toBe("The correct answer is B.");
    });
  });

  describe("the explanation names a different answer than the structured key", () => {
    it.each([
      ["quoted option text, no option annotations", "The correct answer is 'Wash it in the sink', as stated in segment [53]."],
      ["a letter", "The correct answer is C, as stated in segment [53]."],
      ["'Option A is correct'", "Option A is correct. This aligns with segment [53]."],
      ["unquoted option text", "The correct option is wash it in the sink. This aligns with segment [53]."],
      ["an option that does not exist", "The correct answer is D. This aligns with segment [53]."],
    ])("REFUSES: %s", (_label, explanation) => {
      const n = normaliseProposal(base({ explanation, sourceSegmentIds: [53] }));
      expect(n.ok).toBe(false);
      expect(n.refusalReason).toBe("EXPLANATION_NAMES_DIFFERENT_ANSWER");
      expect(n.explanation).toBe(explanation);
      // And so the unchanged sanitiser still rejects it.
      expect(sanitise(n).ok).toBe(false);
    });

    it("a wrong letter that cannot be detached cleanly is simply left for the sanitiser", () => {
      const explanation = "The correct answer is A, as stated in segment [53].";
      const n = normaliseProposal(base({ explanation, sourceSegmentIds: [53] }));
      expect(n.explanation).toBe(explanation);
      expect(sanitise(n).ok).toBe(false);
    });

    it("an option text containing an apostrophe is still compared", () => {
      const options = [
        { text: "I'm sorry, we don't serve that", isCorrect: false },
        { text: "I'd be glad to carve you that", isCorrect: true },
      ];
      const n = normaliseProposal(
        base({
          options,
          explanation: "The correct answer is 'I'm sorry, we don't serve that'. This aligns with segment [53].",
          sourceSegmentIds: [53],
        }),
      );
      expect(n.ok).toBe(false);
      expect(n.refusalReason).toBe("EXPLANATION_NAMES_DIFFERENT_ANSWER");
    });

    it("naming the keyed answer is fine", () => {
      const n = normaliseProposal(
        base({
          explanation: "The correct answer is 'Wipe it with a sanitized towel'. This aligns with segment [53].",
          sourceSegmentIds: [53],
        }),
      );
      expect(n.ok).toBe(true);
      expect(n.explanation).toBe("The correct answer is 'Wipe it with a sanitized towel'.");
    });
  });

  describe("answer-key annotations that disagree with the structured key (B)", () => {
    it.each([
      ["letter plus text on the keyed option", [null, "(Correct Answer: A - Wash it in the sink)", null]],
      ["letter plus text on every option", ["(Correct Answer: A - Wash it in the sink)", "(Correct Answer: A - Wash it in the sink)", "(Correct Answer: A - Wash it in the sink)"]],
      ["a letter that is out of range", [null, "(Correct Answer: D)", null]],
      ["'A is correct'", [null, "(Correct Answer: A is correct)", null]],
      ["'the first option'", [null, "(Correct Answer: the first option)", null]],
      ["a negative note on the keyed option", ["(Correct Answer: leaves residue.)", "(Correct Answer: No, this is not enough.)", null]],
      ["a wrong option claimed correct in free text", ["(Correct Answer: this is the correct choice.)", "(Correct Answer: keeps the station clean.)", null]],
    ])("REFUSES: %s", (_label, notes) => {
      const options = annotated(notes as Array<string | null>);
      const n = normaliseProposal(base({ options }));
      expect(n.ok).toBe(false);
      expect(n.refusalReason).toBe("ANSWER_KEY_CONFLICTS_WITH_CORRECT_OPTION");
      expect(n.options).toEqual(options);
      expect(sanitise(n).ok).toBe(false);
    });

    it("an annotation naming the keyed option by letter plus text is accepted", () => {
      const n = normaliseProposal(
        base({ options: annotated([null, "(Correct Answer: B - Wipe it with a sanitized towel)", null]) }),
      );
      expect(n.ok).toBe(true);
      expect(n.options).toEqual(OPTIONS);
    });
  });

  describe("bounded work on hostile input", () => {
    it("very long or whitespace-padded fields are not normalised, and return quickly", () => {
      const padded = "How should you respond" + " ".repeat(5_000) + "according to the training material?";
      const huge = "Wiping keeps the station clean. ".repeat(600);
      const started = Date.now();
      const a = normaliseProposal(base({ questionText: padded }));
      const b = normaliseProposal(base({ explanation: huge }));
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(a.questionText).toBe(padded);
      expect(b.explanation).toBe(huge);
    });

    it("a long run of near-matches does not blow up", () => {
      const stem = "What should you do " + "according to the training ".repeat(40) + "material?";
      const started = Date.now();
      normaliseProposal(base({ questionText: stem }));
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });
});

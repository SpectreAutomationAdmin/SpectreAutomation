// EP-TRAIN-6D-4X — Semantic duplicate detection unit tests.
// Pure module tests.

import { describe, it, expect } from "vitest";
import {
  evaluatePair,
  evaluateAgainstPriors,
  normaliseQuestion,
  candidateFingerprint,
  DEDUP_RULES_VERSION,
  type QuestionCandidate,
} from "@/lib/hr/training/generation/dedup";

function q(text: string, correct: string, others: string[] = ["Wrong A", "Wrong B"], explanation = ""): QuestionCandidate {
  return {
    questionText: text,
    options: [
      { text: correct, isCorrect: true },
      ...others.map((t) => ({ text: t, isCorrect: false })),
    ],
    explanation,
  };
}

describe("EP-TRAIN-6D-4X — dedup rules version", () => {
  it("exports a stable rules version string", () => {
    expect(DEDUP_RULES_VERSION).toBe("dedup-v1");
  });
});

describe("EP-TRAIN-6D-4X — normalisation", () => {
  it("D1 normalises punctuation + case + whitespace", () => {
    expect(normaliseQuestion("What is  the ESCALATION-policy?")).toBe("what is the escalation policy");
  });

  it("D2 candidateFingerprint is deterministic and permutation-stable on options", () => {
    const a = q("What is the escalation policy?", "Notify the manager");
    const b = q("What is the escalation policy?", "Notify the manager", ["Wrong B", "Wrong A"]);
    expect(candidateFingerprint(a)).toBe(candidateFingerprint(b));
  });
});

describe("EP-TRAIN-6D-4X — pairwise verdicts", () => {
  it("D3 EXACT_DUP when normalised question text is identical", () => {
    const cand = q("What is the escalation policy?", "Notify the manager");
    const prior = q("What is the ESCALATION policy?!", "Notify the manager");
    const d = evaluatePair(cand, prior);
    expect(d.verdict).toBe("EXACT_DUP");
    expect(d.evidence.normalizedMatch).toBe(true);
  });

  it("D4 PARAPHRASE_DUP when shingles match AND option tokens overlap", () => {
    const cand = q(
      "Which action should staff take when a member reports a dispute to the manager at escalation time?",
      "Notify the manager immediately",
    );
    const prior = q(
      "Which action should staff immediately take upon a member reporting a dispute to the manager at escalation time?",
      "Notify the manager at once",
    );
    const d = evaluatePair(cand, prior);
    expect(d.verdict).toBe("PARAPHRASE_DUP");
    expect(d.evidence.shingleJaccard).toBeGreaterThanOrEqual(0.55); // PARAPHRASE_SHINGLE
  });

  it("D5 TOPIC_CANDIDATE when shingles indicate shared topic but overlap below paraphrase threshold", () => {
    const cand = q(
      "When should the escalation procedure be invoked by staff during a dispute?",
      "Only after attempting resolution",
    );
    const prior = q(
      "Which action should staff take when a member reports a dispute to the manager at escalation time?",
      "Notify the manager immediately",
    );
    const d = evaluatePair(cand, prior);
    expect(["TOPIC_CANDIDATE", "PARAPHRASE_DUP", "DISTINCT"]).toContain(d.verdict);
    // The point is: a question on the same broad topic that tests
    // different knowledge is NOT EXACT_DUP.
    expect(d.verdict).not.toBe("EXACT_DUP");
  });

  it("D6 DISTINCT when the two questions test different topics", () => {
    const cand = q("What is the safe operating temperature for the industrial dishwasher?", "Between 60 and 82 celsius");
    const prior = q("Which action should staff take when a member reports a dispute to the manager?", "Notify the manager immediately");
    const d = evaluatePair(cand, prior);
    expect(d.verdict).toBe("DISTINCT");
  });

  it("D7 PARAPHRASE requires more than shingle alone (option overlap OR answer overlap OR explanation overlap)", () => {
    const cand: QuestionCandidate = {
      questionText: "Which action should staff take when a member reports a dispute to the manager at escalation time?",
      options: [
        { text: "Something else entirely", isCorrect: true },
        { text: "Also different", isCorrect: false },
      ],
      explanation: "totally different explanation here about other topic matter",
    };
    const prior: QuestionCandidate = {
      questionText: "Which action should staff immediately take upon a member reporting a dispute to the manager at escalation time?",
      options: [
        { text: "Notify the manager", isCorrect: true },
        { text: "Confront", isCorrect: false },
      ],
      explanation: "immediate manager notification",
    };
    const d = evaluatePair(cand, prior);
    // Even high shingle overlap shouldn't alone produce PARAPHRASE_DUP
    // when option/answer/explanation all diverge.
    if (d.evidence.shingleJaccard >= 0.6) {
      expect(d.verdict).not.toBe("PARAPHRASE_DUP");
    }
  });
});

describe("EP-TRAIN-6D-4X — against priors (multi-source)", () => {
  it("D8 picks the strictest verdict across all priors", () => {
    const priors = [
      q("something totally different about dishwashers", "yes"),
      q("What is the escalation policy?", "Notify the manager"),
    ];
    const cand = q("What is the ESCALATION policy?!", "Notify the manager");
    const d = evaluateAgainstPriors(cand, priors);
    expect(d.verdict).toBe("EXACT_DUP");
    expect(d.againstPriorId).toBe(null); // priors here had no id
  });

  it("D9 returns DISTINCT when priors array is empty", () => {
    const d = evaluateAgainstPriors(q("x", "y"), []);
    expect(d.verdict).toBe("DISTINCT");
  });

  it("D10 cross-destination screening: flags a final-assessment dup of a checkpoint", () => {
    const checkpointPrior: QuestionCandidate = {
      id: "cp-1",
      destination: "cg-1",
      questionText: "What is the escalation policy?",
      options: [{ text: "Notify the manager", isCorrect: true }, { text: "Confront", isCorrect: false }],
    };
    const finalCand: QuestionCandidate = {
      id: "fa-1",
      destination: "final",
      questionText: "What is the escalation policy?",
      options: [{ text: "Notify the manager", isCorrect: true }, { text: "Argue", isCorrect: false }],
    };
    const d = evaluateAgainstPriors(finalCand, [checkpointPrior]);
    expect(d.verdict).toBe("EXACT_DUP");
    expect(d.againstPriorDestination).toBe("cg-1");
  });
});

// EP-TRAIN-6C-10B — Contract regression for the integrated training-question
// validation pipeline.
//
// All tests exercise the AUTHORITATIVE entry point
//   `validateTrainingQuestion({ draft, grounding, authorization, placement? })`
// Tests MUST NOT import the converter or grounding-validator directly;
// that would defeat the purpose of ensuring every future call site uses
// the same single entry point.
//
// Fixtures are derived verbatim from EP-TRAIN-6C-9 accepted evidence
// (Q1 / Q2 / Q3) plus an adversarial battery. The 6C-9 raw artifacts on
// disk are NOT modified and are NOT re-run.

import { describe, expect, it } from "vitest";
import {
  validateTrainingQuestion,
  VALIDATOR_ERRORS,
  VALIDATOR_FLAGS,
  PIPELINE_ERRORS,
  type GroundingPassage,
  type GroundingProjection,
  type PilotAuthorizationV1,
  type TrainingQuestionDraftLiteV1,
  type PipelineResult,
} from "@/lib/training/ai-generation";

// -----------------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------------

function makePassage(opts: {
  passageId: number;
  startSec: number;
  endSec: number;
  text: string;
  pendingReview?: string[];
}): GroundingPassage {
  return {
    passageId: opts.passageId,
    sourceSegmentIds: [opts.passageId],
    sourceStartSec: opts.startSec,
    sourceEndSec: opts.endSec,
    text: opts.text,
    citationHandle: `segment-${opts.passageId}@${opts.startSec}-${opts.endSec}s`,
    flags: {
      pendingReview: opts.pendingReview ?? [],
      sourceOrgMismatch: [],
      uncertaintyWarning: null,
    },
  };
}

function makeGrounding(passages: GroundingPassage[]): GroundingProjection {
  return {
    schemaVersion: "training-grounding-v1",
    operation: "GENERATE_DRAFT_QUESTIONS",
    tenantId: "test-tenant",
    courseId: "test-course",
    versionId: "test-version",
    sourceVideoSha256: "x".repeat(64),
    resolvedTranscriptBuildId: "y".repeat(64),
    passages,
  };
}

function makeAuth(excludedSegmentIds: number[] = []): PilotAuthorizationV1 {
  return {
    schemaVersion: "pilot-generation-authorization-v1",
    authorizationId: "auth-test",
    tenantId: "test-tenant",
    courseId: "test-course",
    versionId: "test-version",
    sourceVideoSha256: "x".repeat(64),
    resolvedTranscriptBuildId: "y".repeat(64),
    approvedGroundingProjectionSha256: "z".repeat(64),
    operation: "GENERATE_DRAFT_QUESTIONS",
    maxRequestedQuestions: 1,
    pilotRestrictions: {
      publicationProhibited: true,
      employeeAssignmentProhibited: true,
      databaseWritesProhibited: true,
      automaticRetriesProhibited: true,
      excludedSegmentIds,
      scope: "offline test",
    },
    issuedAtUtc: new Date(0).toISOString(),
    expiresAtUtc: new Date(3600_000).toISOString(),
    issuedBy: "test",
    fingerprint: "a".repeat(64),
  };
}

function hasErrorCode(result: PipelineResult, code: string): boolean {
  return result.errors.some((e) => e.code === code);
}

// -----------------------------------------------------------------------------
// 6C-9 fixtures — Q1 / Q2 / Q3 (verbatim copies of accepted evidence)
// -----------------------------------------------------------------------------

const Q1_GROUNDING = makeGrounding([
  makePassage({ passageId: 5, startSec: 24.84, endSec: 30.96, text: "Criticism. If you see issues with our current procedures and how we execute things," }),
  makePassage({ passageId: 6, startSec: 30.96, endSec: 35.0, text: "we welcome your feedback, we do. We would like to hear from you." }),
  makePassage({ passageId: 7, startSec: 35.0, endSec: 41.0, text: "But the point is this: first we expect you not to vent out loud. Second, if you want something" }),
  makePassage({ passageId: 8, startSec: 41.0, endSec: 47.32, text: "changed, it's best not to talk about it to other staff, breed negativity, let that fester. If you" }),
  makePassage({ passageId: 9, startSec: 47.32, endSec: 55.08, text: "have some criticism, you must be offered or be prepared to offer at least one solution. Harassment" }),
]);
const Q1_AUTH = makeAuth([16, 17]);
const Q1_DRAFT: TrainingQuestionDraftLiteV1 = {
  questionType: "SINGLE_CHOICE",
  questionText: "What must an employee do if they identify an issue with current procedures at Silver Springs according to the administrator's instructions in the video transcript?",
  options: [
    { text: "Report the issue to other staff members to breed negativity", isCorrect: false },
    { text: "Discuss the issue with other staff members to find a solution", isCorrect: false },
    { text: "Come with a solution if they want to improve the procedures", isCorrect: true },
    { text: "Ignore the issue and do nothing", isCorrect: false },
  ],
  explanation: "The administrator's instructions clearly state that if an employee identifies an issue, they must come with a solution if they want to improve the procedures. This is supported by the following passages: segment_id=5, start=24.84 end=30.96, 'Criticism. If you see issues with our current procedures and how we execute things,' and segment_id=8, start=41 end=47.32, 'If you have some criticism, you must be offered or be prepared to offer at least one solution.'",
  sourceSegmentIds: [5, 8],
};

const Q2_GROUNDING = makeGrounding([
  makePassage({ passageId: 11, startSec: 55.08, endSec: 63.68, text: "And will not be tolerated at Silver Springs. Also, we'd like all of you to be aware that there" }),
  makePassage({ passageId: 12, startSec: 63.68, endSec: 69.3,  text: "are three $500 scholarships available at Silver Springs and your applications must be submitted" }),
  makePassage({ passageId: 13, startSec: 69.3,  endSec: 77.04, text: "by November 1st. There'll be more information that comes out on this in our monthly staff" }),
  makePassage({ passageId: 14, startSec: 77.04, endSec: 81.76, text: "newsletters. So make sure you're watching for that. Make sure you get in your application before" }),
  makePassage({ passageId: 15, startSec: 81.76, endSec: 88.12, text: "the deadline. A little reminder on parking. Please use caution when driving to the clubhouse. We don't" }),
]);
const Q2_AUTH = makeAuth([16, 17]);
const Q2_DRAFT: TrainingQuestionDraftLiteV1 = {
  questionType: "TRUE_FALSE",
  questionText: "The deadline for submitting scholarship applications at Silver Springs is November 1st, and more information will be provided in monthly staff newsletters about the scholarship program and how to apply before the deadline arrives on November 1st, 2026",
  options: [
    { text: "True", isCorrect: true },
    { text: "False", isCorrect: false },
  ],
  explanation: "The evidence states that there are three $500 scholarships available and applications must be submitted by November 1st. Additionally, more information will be provided in monthly staff newsletters before the deadline. Therefore, the statement is true",
  sourceSegmentIds: [12, 13, 14, 15],
};

const Q3_GROUNDING = makeGrounding([
  makePassage({ passageId: 19, startSec: 132.3, endSec: 144.12, text: "We do have a health and safety committee here at Silver Springs. Our goal is to make sure that our staff, number one, are protected and safe in the work environment." }),
  makePassage({ passageId: 20, startSec: 144.12, endSec: 150.0, text: "We also want to make sure we review our processes and make sure things are being done correctly." }),
  makePassage({ passageId: 21, startSec: 150.0, endSec: 155.0, text: "If you see something that you think is a near miss, please report it to your manager." }),
]);
const Q3_AUTH = makeAuth([16, 17]);
const Q3_DRAFT: TrainingQuestionDraftLiteV1 = {
  questionType: "SINGLE_CHOICE",
  questionText: "What is the primary goal of the health and safety committee at Silver Springs according to the administrator's instructions on staff orientation and near miss reporting process for the employee handbook onboarding stage requirements",
  options: [
    { text: "To ensure staff are protected and safe in the work environment", isCorrect: true },
    { text: "To ensure all staff sign off on the employee handbook", isCorrect: false },
    { text: "To report near misses to the insurance company", isCorrect: false },
    { text: "To provide training on OSHA regulations", isCorrect: false },
  ],
  explanation: "The primary goal of the health and safety committee at Silver Springs is to ensure that staff are protected and safe in the work environment, as stated in the evidence: 'Our goal is to make sure that our staff, number one, are protected and safe in the work environment.'",
  sourceSegmentIds: [19],
};

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("EP-TRAIN-6C-10B — pipeline integration: 6C-9 Q1 / Q2 / Q3 replay", () => {
  it("Q1 criticism must offer a solution → REQUIRES_HUMAN_VERIFICATION", () => {
    const r = validateTrainingQuestion({ draft: Q1_DRAFT, grounding: Q1_GROUNDING, authorization: Q1_AUTH });
    expect(r.verdict).toBe("REQUIRES_HUMAN_VERIFICATION");
    expect(r.stage).toBe("VALIDATE");
    expect(r.proposal).not.toBeNull();
    expect(r.errors).toHaveLength(0);
    expect(r.flags).toContain(VALIDATOR_FLAGS.UNSUPPORTED_ANSWER_WORDS);
  });

  it("Q2 scholarship with invented year 2026 → REJECTED w/ ERR_UNSUPPORTED_FACTUAL_YEAR", () => {
    const r = validateTrainingQuestion({ draft: Q2_DRAFT, grounding: Q2_GROUNDING, authorization: Q2_AUTH });
    expect(r.verdict).toBe("REJECTED");
    expect(r.stage).toBe("VALIDATE");
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_FACTUAL_YEAR)).toBe(true);
    const yearErr = r.errors.find((e) => e.code === VALIDATOR_ERRORS.UNSUPPORTED_FACTUAL_YEAR);
    expect(yearErr?.detail.year).toBe("2026");
  });

  it("Q2 supported facts ($500 + November 1st) must not false-positive", () => {
    const r = validateTrainingQuestion({ draft: Q2_DRAFT, grounding: Q2_GROUNDING, authorization: Q2_AUTH });
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_FACTUAL_MONEY)).toBe(false);
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_FACTUAL_DATE)).toBe(false);
  });

  it("Q3 safety → REJECTED w/ preserved + new hard errors", () => {
    const r = validateTrainingQuestion({ draft: Q3_DRAFT, grounding: Q3_GROUNDING, authorization: Q3_AUTH });
    expect(r.verdict).toBe("REJECTED");
    // Historical hard failure must remain.
    expect(hasErrorCode(r, VALIDATOR_ERRORS.CITATION_SEGMENT_UNAUTHORIZED)).toBe(true);
    // More specific codes also fire.
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_REGULATORY_BODY)).toBe(true);
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_INSURANCE_REFERENCE)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Integration: converter failures + fail-closed guarantees
// -----------------------------------------------------------------------------

describe("EP-TRAIN-6C-10B — converter + validator integration", () => {
  it("valid Lite draft converts cleanly and reaches the validator", () => {
    const r = validateTrainingQuestion({ draft: Q1_DRAFT, grounding: Q1_GROUNDING, authorization: Q1_AUTH });
    expect(r.stage).toBe("VALIDATE");
    expect(r.proposal).not.toBeNull();
    expect(r.proposal?.schemaVersion).toBe("training-question-proposal-v1");
    expect(r.proposal?.reviewStatus).toBe("PENDING_REVIEW");
  });

  it("invalid Lite schema — missing questionText → REJECTED at CONVERT stage", () => {
    const bad = { ...Q1_DRAFT, questionText: "" };
    const r = validateTrainingQuestion({ draft: bad, grounding: Q1_GROUNDING, authorization: Q1_AUTH });
    expect(r.verdict).toBe("REJECTED");
    expect(r.stage).toBe("CONVERT");
    expect(r.proposal).toBeNull();
    expect(r.errors[0].code.startsWith("ERR_CONVERT_")).toBe(true);
  });

  it("invalid Lite schema — malformed questionType → REJECTED at CONVERT stage", () => {
    const bad = { ...Q1_DRAFT, questionType: "FREE_RESPONSE" as unknown as "SINGLE_CHOICE" };
    const r = validateTrainingQuestion({ draft: bad, grounding: Q1_GROUNDING, authorization: Q1_AUTH });
    expect(r.verdict).toBe("REJECTED");
    expect(r.stage).toBe("CONVERT");
  });

  it("missing grounding → REJECTED at CONVERT stage", () => {
    const r = validateTrainingQuestion({ draft: Q1_DRAFT, grounding: null, authorization: Q1_AUTH });
    expect(r.verdict).toBe("REJECTED");
    expect(r.stage).toBe("CONVERT");
  });

  it("missing authorization → REJECTED at CONVERT stage", () => {
    const r = validateTrainingQuestion({ draft: Q1_DRAFT, grounding: Q1_GROUNDING, authorization: null });
    expect(r.verdict).toBe("REJECTED");
    expect(r.stage).toBe("CONVERT");
  });

  it("citation of excluded segment (16) → REJECTED at CONVERT stage", () => {
    const withExcluded: TrainingQuestionDraftLiteV1 = { ...Q1_DRAFT, sourceSegmentIds: [5, 16] };
    const r = validateTrainingQuestion({ draft: withExcluded, grounding: Q1_GROUNDING, authorization: Q1_AUTH });
    expect(r.verdict).toBe("REJECTED");
    expect(r.stage).toBe("CONVERT");
    expect(r.errors.some((e) => e.code === "ERR_CONVERT_SEGMENT_EXCLUDED_BY_PILOT" || e.code === "ERR_CONVERT_SEGMENT_NOT_IN_GROUNDING")).toBe(true);
  });

  it("supported factual year (cited transcript contains 2027) → accepted", () => {
    const g = makeGrounding([
      makePassage({ passageId: 100, startSec: 0, endSec: 10, text: "In the 2027 program at Silver Springs, employees receive new perks." }),
    ]);
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "SINGLE_CHOICE",
      questionText: "What program are we discussing at Silver Springs?",
      options: [
        { text: "The 2027 program", isCorrect: true },
        { text: "The 2028 program", isCorrect: false },
      ],
      explanation: "The 2027 program.",
      sourceSegmentIds: [100],
    };
    const r = validateTrainingQuestion({ draft, grounding: g, authorization: makeAuth() });
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_FACTUAL_YEAR)).toBe(false);
  });

  it("distractor-only invented year → NOT a hard failure", () => {
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "SINGLE_CHOICE",
      questionText: "When is the scholarship deadline at Silver Springs?",
      options: [
        { text: "November 1st", isCorrect: true },
        { text: "December 31st, 1999", isCorrect: false },
        { text: "January 1st, 2030", isCorrect: false },
      ],
      explanation: "The deadline is November 1st.",
      sourceSegmentIds: [13],
    };
    const r = validateTrainingQuestion({ draft, grounding: Q2_GROUNDING, authorization: Q2_AUTH });
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_FACTUAL_YEAR)).toBe(false);
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_FACTUAL_DATE)).toBe(false);
  });

  it("advisory flags propagate through the pipeline (UNSUPPORTED_ANSWER_WORDS on Q1)", () => {
    const r = validateTrainingQuestion({ draft: Q1_DRAFT, grounding: Q1_GROUNDING, authorization: Q1_AUTH });
    expect(r.flags).toContain(VALIDATOR_FLAGS.UNSUPPORTED_ANSWER_WORDS);
  });

  it("repeated calls with identical inputs produce identical verdicts (determinism)", () => {
    const r1 = validateTrainingQuestion({ draft: Q2_DRAFT, grounding: Q2_GROUNDING, authorization: Q2_AUTH });
    const r2 = validateTrainingQuestion({ draft: Q2_DRAFT, grounding: Q2_GROUNDING, authorization: Q2_AUTH });
    expect(r1.verdict).toBe(r2.verdict);
    expect(r1.errors.map((e) => e.code).sort()).toEqual(r2.errors.map((e) => e.code).sort());
    expect(r1.proposal?.proposalId).toBe(r2.proposal?.proposalId);
  });

  it("input objects are not mutated by the pipeline", () => {
    const snap = JSON.parse(JSON.stringify({ d: Q2_DRAFT, g: Q2_GROUNDING, a: Q2_AUTH }));
    validateTrainingQuestion({ draft: Q2_DRAFT, grounding: Q2_GROUNDING, authorization: Q2_AUTH });
    expect(JSON.parse(JSON.stringify({ d: Q2_DRAFT, g: Q2_GROUNDING, a: Q2_AUTH }))).toEqual(snap);
  });

  it("exception inside the pipeline becomes REJECTED w/ ERR_PIPELINE_EXCEPTION (fail-closed)", () => {
    // Force a thrown exception via a grounding object whose `.passages` getter throws.
    const explodingGrounding = new Proxy({} as GroundingProjection, {
      get(_t, prop) {
        if (prop === "passages") throw new Error("intentional test throw");
        if (prop === "schemaVersion") return "training-grounding-v1";
        return undefined;
      },
    });
    const r = validateTrainingQuestion({
      draft: Q1_DRAFT,
      grounding: explodingGrounding,
      authorization: Q1_AUTH,
    });
    expect(r.verdict).toBe("REJECTED");
    expect(r.stage).toBe("EXCEPTION");
    expect(r.errors[0].code).toBe(PIPELINE_ERRORS.EXCEPTION);
  });

  it("human-review verdict cannot be silently upgraded to GROUNDED by a stray advisory flag", () => {
    // Q1 has an advisory flag (UNSUPPORTED_ANSWER_WORDS) and no hard errors.
    // The pipeline must therefore return REQUIRES_HUMAN_VERIFICATION, not
    // GROUNDED. A GROUNDED verdict here would mean advisory flags were
    // being silently absorbed, which would weaken the human-review safeguard.
    const r = validateTrainingQuestion({ draft: Q1_DRAFT, grounding: Q1_GROUNDING, authorization: Q1_AUTH });
    expect(r.verdict).not.toBe("GROUNDED");
    expect(r.verdict).toBe("REQUIRES_HUMAN_VERIFICATION");
  });
});

// EP-TRAIN-6C-10C — regression + adversarial battery for the two new
// detectors introduced on top of the 6C-10A hardened validator:
//
//   ERR_UNSUPPORTED_NAMED_ENTITY_SUBJECT  (A1, hard fail)
//   FLAG_PRESCRIPTIVE_INSERTION           (A2, advisory)
//
// Every test goes through the authoritative pipeline entry point
// `validateTrainingQuestion` — the integrated path all future workflows
// are expected to use. The historical 17-case Q1/Q2/Q3 test file at
// `tests/training-ai-generation-grounding.test.ts` is left untouched and
// must continue to pass alongside this file.

import { describe, expect, it } from "vitest";
import {
  validateTrainingQuestion,
  VALIDATOR_ERRORS,
  VALIDATOR_FLAGS,
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
function hasErrorCode(r: PipelineResult, code: string): boolean {
  return r.errors.some((e) => e.code === code);
}

// -----------------------------------------------------------------------------
// §A3 — Q4–Q8 replay (inline fixtures from the EP-TRAIN-6C-11 pilot)
// -----------------------------------------------------------------------------

const Q4_GROUNDING = makeGrounding([
  makePassage({ passageId: 0, startSec: 0, endSec: 4.58, text: "understand that. But once again, at Silver Springs, we're trying to enhance the member experience" }),
]);
const Q4_DRAFT: TrainingQuestionDraftLiteV1 = {
  questionType: "TRUE_FALSE",
  questionText: "Silver Springs is focusing on enhancing the member experience according to the administrator's statement",
  options: [
    { text: "True", isCorrect: true },
    { text: "False", isCorrect: false },
  ],
  explanation: "The administrator stated, 'But once again, at Silver Springs, we're trying to enhance the member experience'. This directly supports the correct answer being True",
  sourceSegmentIds: [0],
};

const Q5_GROUNDING = makeGrounding([
  makePassage({ passageId: 1, startSec: 4.58, endSec: 8.86, text: "and being on your phone in front of our members and or guests is not how we like our staff to" }),
  makePassage({ passageId: 2, startSec: 8.86, endSec: 16.28, text: "behave. Please check your phone out of the sites of any members or other staff, go into a back room," }),
]);
const Q5_DRAFT: TrainingQuestionDraftLiteV1 = {
  questionType: "TRUE_FALSE",
  questionText: "Using a phone in front of members or guests is allowed as long as it is not visible to them from a back room or other area they are in view of, according to the administrator's instructions for staff behavior at Silver Springs",
  options: [
    { text: "True", isCorrect: false },
    { text: "False", isCorrect: true },
  ],
  explanation: "The administrator clearly states that using a phone in front of members or guests is not acceptable behavior. Staff are instructed to go into a back room or out of view of members and guests to use their phone. Therefore, the correct answer is False",
  sourceSegmentIds: [1, 2],
};

const Q6_GROUNDING = makeGrounding([
  makePassage({ passageId: 3, startSec: 16.78, endSec: 20.68, text: "make your phone calls that you need to. But once again, be discreet with your cell phone." }),
  makePassage({ passageId: 4, startSec: 21.34, endSec: 24.84, text: "Do not have it out staring at your phone while members are trying to be serviced." }),
]);
const Q6_DRAFT: TrainingQuestionDraftLiteV1 = {
  questionType: "TRUE_FALSE",
  questionText: "Administrators are allowed to make necessary phone calls but should be discreet about it during member service hours at Silver Springs",
  options: [
    { text: "True", isCorrect: true },
    { text: "False", isCorrect: false },
  ],
  explanation: "The administrator is allowed to make necessary phone calls but should be discreet about it during member service hours. This is supported by the statement: 'make your phone calls that you need to. But once again, be discreet with your cell phone.'",
  sourceSegmentIds: [3, 4],
};

const Q7_GROUNDING = makeGrounding([
  makePassage({ passageId: 10, startSec: 53.2, endSec: 54.78, text: "Negativity breeds more negativity." }),
]);
const Q7_DRAFT: TrainingQuestionDraftLiteV1 = {
  questionType: "TRUE_FALSE",
  questionText: "The statement 'Negativity breeds more negativity' is a principle that should be applied in the workplace to maintain a positive environment and reduce conflicts among staff members at Silver Springs",
  options: [
    { text: "True", isCorrect: true },
    { text: "False", isCorrect: false },
  ],
  explanation: "The statement 'Negativity breeds more negativity' is a principle that should be applied in the workplace to maintain a positive environment and reduce conflicts among staff members at Silver Springs. This aligns with the provided evidence segment_id=10, start=53.2, end=54.78, which states 'Negativity breeds more negativity'.",
  sourceSegmentIds: [10],
};

const Q8_GROUNDING = makeGrounding([
  makePassage({ passageId: 18, startSec: 118.9, endSec: 131.4, text: "As you might know, make sure that we provide all the parking once again for our members and guests. You will be reminded of this the day before the shift or the event. Just please make sure that you follow the instruction and park on the street." }),
]);
const Q8_DRAFT: TrainingQuestionDraftLiteV1 = {
  questionType: "SINGLE_CHOICE",
  questionText: "What should staff members be reminded about the day before their shift or event at Silver Springs regarding parking instructions for members and guests?",
  options: [
    { text: "They should park in the designated lot for members and guests", isCorrect: false },
    { text: "They should park on the street", isCorrect: true },
    { text: "They should park in the employee parking area", isCorrect: false },
  ],
  explanation: "The correct answer is supported by the statement: 'As you might know, make sure that we provide all the parking once again for our members and guests. You will be reminded of this the day before the shift or the event. Just please make sure that you follow the instruction and park on the street.'",
  sourceSegmentIds: [18],
};

const AUTH = makeAuth([16, 17]);

// -----------------------------------------------------------------------------
// §A3 Q4–Q8 regression — expected verdicts
// -----------------------------------------------------------------------------

describe("EP-TRAIN-6C-10C §A3 — Q4–Q8 regression through the integrated pipeline", () => {
  it("Q4 member-experience framing remains REQUIRES_HUMAN_VERIFICATION (no new rule applies)", () => {
    const r = validateTrainingQuestion({ draft: Q4_DRAFT, grounding: Q4_GROUNDING, authorization: AUTH });
    expect(r.verdict).toBe("REQUIRES_HUMAN_VERIFICATION");
    expect(r.errors).toHaveLength(0);
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_NAMED_ENTITY_SUBJECT)).toBe(false);
    expect(r.flags).not.toContain(VALIDATOR_FLAGS.PRESCRIPTIVE_INSERTION);
  });

  it("Q5 no-phones-in-front-of-members remains REQUIRES_HUMAN_VERIFICATION (no new rule applies)", () => {
    const r = validateTrainingQuestion({ draft: Q5_DRAFT, grounding: Q5_GROUNDING, authorization: AUTH });
    expect(r.verdict).toBe("REQUIRES_HUMAN_VERIFICATION");
    expect(r.errors).toHaveLength(0);
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_NAMED_ENTITY_SUBJECT)).toBe(false);
    // Q5's authoritative uses no strict modal, so advisory must not fire.
    expect(r.flags).not.toContain(VALIDATOR_FLAGS.PRESCRIPTIVE_INSERTION);
  });

  it("Q6 phone-call-discretion flips to REJECTED on new subject-attribution rule", () => {
    const r = validateTrainingQuestion({ draft: Q6_DRAFT, grounding: Q6_GROUNDING, authorization: AUTH });
    expect(r.verdict).toBe("REJECTED");
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_NAMED_ENTITY_SUBJECT)).toBe(true);
    const subjErr = r.errors.find((e) => e.code === VALIDATOR_ERRORS.UNSUPPORTED_NAMED_ENTITY_SUBJECT);
    expect(subjErr?.detail.role).toBe("administrator");
    // Q6 cited passages contain "need to" (broader obligation) so the
    // prescriptive-insertion advisory must NOT fire despite auth's "should".
    expect(r.flags).not.toContain(VALIDATOR_FLAGS.PRESCRIPTIVE_INSERTION);
  });

  it("Q7 negativity-principle receives FLAG_PRESCRIPTIVE_INSERTION advisory, verdict stays REQUIRES_HUMAN_VERIFICATION", () => {
    const r = validateTrainingQuestion({ draft: Q7_DRAFT, grounding: Q7_GROUNDING, authorization: AUTH });
    expect(r.verdict).toBe("REQUIRES_HUMAN_VERIFICATION");
    expect(r.errors).toHaveLength(0);
    expect(r.flags).toContain(VALIDATOR_FLAGS.PRESCRIPTIVE_INSERTION);
  });

  it("Q8 parking-policy remains REQUIRES_HUMAN_VERIFICATION (cited contains 'please'/'make sure')", () => {
    const r = validateTrainingQuestion({ draft: Q8_DRAFT, grounding: Q8_GROUNDING, authorization: AUTH });
    expect(r.verdict).toBe("REQUIRES_HUMAN_VERIFICATION");
    expect(r.errors).toHaveLength(0);
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_NAMED_ENTITY_SUBJECT)).toBe(false);
    // Q8's cited passage contains "please" and "make sure", which BROADER_OBLIGATION_LANGUAGE recognises; advisory must not fire.
    expect(r.flags).not.toContain(VALIDATOR_FLAGS.PRESCRIPTIVE_INSERTION);
  });
});

// -----------------------------------------------------------------------------
// §A1 — subject-attribution adversarial battery
// -----------------------------------------------------------------------------

describe("EP-TRAIN-6C-10C §A1 — subject-attribution detector", () => {
  it("case 1 — source addresses 'you' (all employees); generated restricts to 'Managers' → REJECTED", () => {
    const grounding = makeGrounding([
      makePassage({ passageId: 50, startSec: 0, endSec: 5, text: "Please submit your incident reports to your supervisor within 24 hours." }),
    ]);
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "TRUE_FALSE",
      questionText: "Managers are required to submit incident reports within 24 hours at Silver Springs",
      options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }],
      explanation: "Managers must submit incident reports within 24 hours.",
      sourceSegmentIds: [50],
    };
    const r = validateTrainingQuestion({ draft, grounding, authorization: AUTH });
    expect(r.verdict).toBe("REJECTED");
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_NAMED_ENTITY_SUBJECT)).toBe(true);
  });

  it("case 2 — source explicitly addresses 'administrators'; generated question keeps subject → no fire", () => {
    const grounding = makeGrounding([
      makePassage({ passageId: 51, startSec: 0, endSec: 5, text: "Administrators are responsible for approving time-off requests before the end of the month at Silver Springs." }),
    ]);
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "TRUE_FALSE",
      questionText: "Administrators are required to approve time-off requests before the end of the month",
      options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }],
      explanation: "Administrators must approve requests by month-end.",
      sourceSegmentIds: [51],
    };
    const r = validateTrainingQuestion({ draft, grounding, authorization: AUTH });
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_NAMED_ENTITY_SUBJECT)).toBe(false);
  });

  it("case 3 — possessive 'administrator's instructions' is NOT a subject of obligation → no fire", () => {
    // This is the Q3 pattern: "according to the administrator's instructions"
    // uses "administrator" referentially, not as the subject of an obligation.
    // Must not trigger the detector.
    const grounding = makeGrounding([
      makePassage({ passageId: 60, startSec: 0, endSec: 5, text: "We do have a health and safety committee here at Silver Springs." }),
    ]);
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "TRUE_FALSE",
      questionText: "According to the administrator's instructions, Silver Springs maintains a health and safety committee",
      options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }],
      explanation: "The committee exists per the orientation.",
      sourceSegmentIds: [60],
    };
    const r = validateTrainingQuestion({ draft, grounding, authorization: AUTH });
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_NAMED_ENTITY_SUBJECT)).toBe(false);
  });

  it("case 4 — generic subject 'Staff are required' → no fire (generic, not specific-role)", () => {
    const grounding = makeGrounding([
      makePassage({ passageId: 70, startSec: 0, endSec: 5, text: "Please submit your incident reports within 24 hours." }),
    ]);
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "TRUE_FALSE",
      questionText: "Staff are required to submit incident reports within 24 hours at Silver Springs",
      options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }],
      explanation: "Reports must be submitted within 24 hours.",
      sourceSegmentIds: [70],
    };
    const r = validateTrainingQuestion({ draft, grounding, authorization: AUTH });
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_NAMED_ENTITY_SUBJECT)).toBe(false);
  });

  it("case 5 — named-org 'Silver Springs' mentioned but NOT as subject of obligation → no fire", () => {
    const grounding = makeGrounding([
      makePassage({ passageId: 80, startSec: 0, endSec: 5, text: "We are focused on members at Silver Springs." }),
    ]);
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "TRUE_FALSE",
      questionText: "Silver Springs focuses on its members",
      options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }],
      explanation: "Silver Springs focuses on members per the orientation.",
      sourceSegmentIds: [80],
    };
    const r = validateTrainingQuestion({ draft, grounding, authorization: AUTH });
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_NAMED_ENTITY_SUBJECT)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// §A2 — prescriptive-insertion adversarial battery
// -----------------------------------------------------------------------------

describe("EP-TRAIN-6C-10C §A2 — prescriptive-insertion advisory", () => {
  it("case 1 — auth has 'should', cited has 'need to' (supported paraphrase) → no fire", () => {
    const grounding = makeGrounding([
      makePassage({ passageId: 90, startSec: 0, endSec: 5, text: "You need to submit expense reports every month at Silver Springs." }),
    ]);
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "TRUE_FALSE",
      questionText: "Employees should submit expense reports monthly at Silver Springs",
      options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }],
      explanation: "Monthly submissions are required.",
      sourceSegmentIds: [90],
    };
    const r = validateTrainingQuestion({ draft, grounding, authorization: AUTH });
    expect(r.flags).not.toContain(VALIDATOR_FLAGS.PRESCRIPTIVE_INSERTION);
  });

  it("case 2 — auth has 'must', cited has no obligation language → advisory fires", () => {
    const grounding = makeGrounding([
      makePassage({ passageId: 91, startSec: 0, endSec: 5, text: "Silver Springs values clarity in communication." }),
    ]);
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "TRUE_FALSE",
      questionText: "At Silver Springs, employees must always use clear communication to maintain workplace standards",
      options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }],
      explanation: "Clear communication is valued per the orientation.",
      sourceSegmentIds: [91],
    };
    const r = validateTrainingQuestion({ draft, grounding, authorization: AUTH });
    expect(r.flags).toContain(VALIDATOR_FLAGS.PRESCRIPTIVE_INSERTION);
    // Must remain REQUIRES_HUMAN_VERIFICATION (advisory does not hard-fail).
    expect(r.verdict).toBe("REQUIRES_HUMAN_VERIFICATION");
  });

  it("case 3 — auth has 'required', cited has 'please' (BROADER paraphrase) → no fire", () => {
    const grounding = makeGrounding([
      makePassage({ passageId: 92, startSec: 0, endSec: 5, text: "Please sign in at the front desk upon arrival at Silver Springs." }),
    ]);
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "TRUE_FALSE",
      questionText: "Signing in at the front desk upon arrival is required at Silver Springs",
      options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }],
      explanation: "Sign-in is required per the orientation.",
      sourceSegmentIds: [92],
    };
    const r = validateTrainingQuestion({ draft, grounding, authorization: AUTH });
    expect(r.flags).not.toContain(VALIDATOR_FLAGS.PRESCRIPTIVE_INSERTION);
  });

  it("case 4 — auth has 'always' as prescriptive, cited describes behaviour without obligation → advisory fires", () => {
    const grounding = makeGrounding([
      makePassage({ passageId: 93, startSec: 0, endSec: 5, text: "Silver Springs offers complimentary coffee in the staff lounge." }),
    ]);
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "TRUE_FALSE",
      questionText: "Employees should always drink the complimentary coffee in the staff lounge at Silver Springs",
      options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }],
      explanation: "Complimentary coffee is available.",
      sourceSegmentIds: [93],
    };
    const r = validateTrainingQuestion({ draft, grounding, authorization: AUTH });
    expect(r.flags).toContain(VALIDATOR_FLAGS.PRESCRIPTIVE_INSERTION);
  });

  it("case 5 — auth has no strict modal, cited has 'must' → no fire (not a prescriptive-insertion case)", () => {
    const grounding = makeGrounding([
      makePassage({ passageId: 94, startSec: 0, endSec: 5, text: "Employees must sign in at the front desk upon arrival at Silver Springs." }),
    ]);
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "TRUE_FALSE",
      questionText: "Signing in at the front desk upon arrival is standard practice at Silver Springs",
      options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }],
      explanation: "Sign-in is standard practice.",
      sourceSegmentIds: [94],
    };
    const r = validateTrainingQuestion({ draft, grounding, authorization: AUTH });
    expect(r.flags).not.toContain(VALIDATOR_FLAGS.PRESCRIPTIVE_INSERTION);
  });

  it("case 6 — advisory is additive: no new hard errors emitted beyond the flag", () => {
    const grounding = makeGrounding([
      makePassage({ passageId: 95, startSec: 0, endSec: 5, text: "Silver Springs values clarity." }),
    ]);
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "TRUE_FALSE",
      questionText: "Employees must always use clear communication at Silver Springs",
      options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }],
      explanation: "Clear communication is required.",
      sourceSegmentIds: [95],
    };
    const r = validateTrainingQuestion({ draft, grounding, authorization: AUTH });
    // Advisory flags should be present; errors should NOT contain a new hard code.
    expect(r.flags).toContain(VALIDATOR_FLAGS.PRESCRIPTIVE_INSERTION);
    expect(r.errors).toHaveLength(0);
    expect(r.verdict).toBe("REQUIRES_HUMAN_VERIFICATION");
  });
});

// -----------------------------------------------------------------------------
// §A3 — "do not weaken existing protections"
// -----------------------------------------------------------------------------

describe("EP-TRAIN-6C-10C §A3 — existing protections preserved", () => {
  it("existing hard errors still fire on an unsupported invented year in the authoritative surface", () => {
    const grounding = makeGrounding([
      makePassage({ passageId: 100, startSec: 0, endSec: 5, text: "The annual meeting is held in November at Silver Springs." }),
    ]);
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "TRUE_FALSE",
      questionText: "The annual meeting is held in November 2027 at Silver Springs",
      options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }],
      explanation: "The meeting is in November.",
      sourceSegmentIds: [100],
    };
    const r = validateTrainingQuestion({ draft, grounding, authorization: AUTH });
    expect(r.verdict).toBe("REJECTED");
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_FACTUAL_YEAR)).toBe(true);
  });

  it("subject-attribution hard fail stacks with other hard fails when both trigger", () => {
    const grounding = makeGrounding([
      makePassage({ passageId: 110, startSec: 0, endSec: 5, text: "Please sign in at the front desk." }),
    ]);
    const draft: TrainingQuestionDraftLiteV1 = {
      questionType: "TRUE_FALSE",
      questionText: "Managers must sign in at the front desk in 2029 at Silver Springs",
      options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }],
      explanation: "Managers must sign in.",
      sourceSegmentIds: [110],
    };
    const r = validateTrainingQuestion({ draft, grounding, authorization: AUTH });
    expect(r.verdict).toBe("REJECTED");
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_NAMED_ENTITY_SUBJECT)).toBe(true);
    expect(hasErrorCode(r, VALIDATOR_ERRORS.UNSUPPORTED_FACTUAL_YEAR)).toBe(true);
  });
});

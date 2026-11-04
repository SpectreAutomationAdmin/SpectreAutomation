// EP-TRAIN-6D-1 — fixture data for the manager review experience.
//
// These are the eight accepted candidates from EP-TRAIN-6C-9 (Q1-Q3)
// and EP-TRAIN-6C-11 (Q4-Q8), each paired with the authoritative
// grounding projection subset the model was generated against.
//
// The fixtures are DELIBERATELY LOCAL. No live inference. No DB.
// No cross-tenant exposure. A fixture-driven review surface lets a
// manager feel the review workflow without any production risk.

import type {
  GroundingPassage,
  GroundingProjection,
  PilotAuthorizationV1,
  TrainingQuestionDraftLiteV1,
  PipelineResult,
  ValidatorError,
} from "@/lib/training/ai-generation";

/**
 * EP-TRAIN-6D-3 — predetermined revalidation outcome for the fixture
 * mode. Returned verbatim when the reviewer clicks "Revalidate (fixture)"
 * after editing. The point is to show the WORKFLOW — stale → re-run →
 * fresh verdict — without pretending to invoke the live validator on
 * arbitrary edited content.
 *
 * Each outcome describes the kind of hypothetical edit that would
 * produce it. The UI labels this clearly as "fixture outcome" so the
 * reviewer never thinks a real validation ran.
 */
export interface FixtureRevalidationOutcome {
  /** Short label shown in the "Revalidate (fixture)" button + status line. */
  readonly scenarioLabel: string;
  /** What hypothetical edit this outcome corresponds to — displayed as context. */
  readonly scenarioDescription: string;
  /** Pre-determined pipeline result for this outcome. Shape matches a real `PipelineResult`. */
  readonly result: PipelineResult;
}

export interface Fixture {
  readonly label: string;
  readonly topic: string;
  readonly draft: TrainingQuestionDraftLiteV1;
  readonly grounding: GroundingProjection;
  readonly authorization: PilotAuthorizationV1;
  readonly backend: "lm-format-enforcer";
  readonly metrics: {
    readonly inferenceMs: number;
    readonly gpuSeconds: number;
    readonly estimatedCostUsd: number;
    readonly promptTokenCount: number;
    readonly outputTokenCount: number;
  };
  readonly sourceWindow: { startSec: number; endSec: number };
  readonly provenance: string;
  /** Pre-determined outcome shown when the reviewer clicks "Revalidate (fixture)" after editing. */
  readonly revalidationDemo: FixtureRevalidationOutcome;
}

// Helper — builds a PipelineResult shape without touching the live pipeline.
function demoResult(opts: {
  verdict: PipelineResult["verdict"];
  errorCodes?: string[];
  flags?: string[];
}): PipelineResult {
  const errors: ValidatorError[] = (opts.errorCodes ?? []).map((code) => ({
    code,
    message: `[fixture] ${code}`,
    detail: {},
  }));
  return {
    verdict: opts.verdict,
    stage: "VALIDATE",
    proposal: null,
    propagatedSourceOrgFlags: [],
    errors,
    warnings: [],
    flags: opts.flags ?? [],
  };
}

function makePassage(opts: {
  passageId: number;
  startSec: number;
  endSec: number;
  text: string;
}): GroundingPassage {
  return {
    passageId: opts.passageId,
    sourceSegmentIds: [opts.passageId],
    sourceStartSec: opts.startSec,
    sourceEndSec: opts.endSec,
    text: opts.text,
    citationHandle: `segment-${opts.passageId}@${opts.startSec}-${opts.endSec}s`,
    flags: { pendingReview: [], sourceOrgMismatch: [], uncertaintyWarning: null },
  };
}
function makeGrounding(passages: GroundingPassage[]): GroundingProjection {
  return {
    schemaVersion: "training-grounding-v1",
    operation: "GENERATE_DRAFT_QUESTIONS",
    tenantId: "cmrvdeny7000144372ktmmg9c",
    courseId: "cmvzs3vz9000256qcu7lfysoz",
    versionId: "cmvzs3w05000456qcgfgps7gy",
    sourceVideoSha256: "d1ddb823437c78478c5f2388b5daa42c957a8706afcce871bd6a522801efee29",
    resolvedTranscriptBuildId: "d138a72b1c3eee7329629f5759e528ca8dbeee5000a71a698f512e78191a2237",
    passages,
  };
}
function makeAuth(label: string): PilotAuthorizationV1 {
  return {
    schemaVersion: "pilot-generation-authorization-v1",
    authorizationId: `auth-ep-train-6d-1-fixture-${label}`,
    tenantId: "cmrvdeny7000144372ktmmg9c",
    courseId: "cmvzs3vz9000256qcu7lfysoz",
    versionId: "cmvzs3w05000456qcgfgps7gy",
    sourceVideoSha256: "d1ddb823437c78478c5f2388b5daa42c957a8706afcce871bd6a522801efee29",
    resolvedTranscriptBuildId: "d138a72b1c3eee7329629f5759e528ca8dbeee5000a71a698f512e78191a2237",
    approvedGroundingProjectionSha256: "fixture-" + label,
    operation: "GENERATE_DRAFT_QUESTIONS",
    maxRequestedQuestions: 1,
    pilotRestrictions: {
      publicationProhibited: true,
      employeeAssignmentProhibited: true,
      databaseWritesProhibited: true,
      automaticRetriesProhibited: true,
      excludedSegmentIds: [16, 17],
      scope: "EP-TRAIN-6D-1 fixture — Coulee Ridge development tenant only",
    },
    issuedAtUtc: new Date(0).toISOString(),
    expiresAtUtc: new Date(3600_000).toISOString(),
    issuedBy: "ep-train-6d-1-fixture",
    fingerprint: "fixture-not-live",
  };
}

export const FIXTURES: readonly Fixture[] = [
  {
    label: "q1-criticism-must-offer-solution",
    topic: "Raising workplace concerns requires offering a solution",
    draft: {
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
    },
    grounding: makeGrounding([
      makePassage({ passageId: 5, startSec: 24.84, endSec: 30.96, text: "Criticism. If you see issues with our current procedures and how we execute things," }),
      makePassage({ passageId: 6, startSec: 30.96, endSec: 35.0, text: "we welcome your feedback, we do. We would like to hear from you." }),
      makePassage({ passageId: 7, startSec: 35.0, endSec: 41.0, text: "But the point is this: first we expect you not to vent out loud. Second, if you want something" }),
      makePassage({ passageId: 8, startSec: 41.0, endSec: 47.32, text: "changed, it's best not to talk about it to other staff, breed negativity, let that fester. If you" }),
      makePassage({ passageId: 9, startSec: 47.32, endSec: 55.08, text: "have some criticism, you must be offered or be prepared to offer at least one solution. Harassment" }),
    ]),
    authorization: makeAuth("q1"),
    backend: "lm-format-enforcer",
    metrics: { inferenceMs: 7599, gpuSeconds: 7.599, estimatedCostUsd: 0.0058, promptTokenCount: 2001, outputTokenCount: 277 },
    sourceWindow: { startSec: 24.84, endSec: 55.08 },
    provenance: "EP-TRAIN-6C-9 pilot, fingerprint 0776d2c0…",
    revalidationDemo: {
      scenarioLabel: "Edit tightens the question; advisory remains",
      scenarioDescription: "A reviewer rewords the question stem. The pipeline is expected to still flag unsupported connecting words as an advisory.",
      result: demoResult({ verdict: "REQUIRES_HUMAN_VERIFICATION", flags: ["FLAG_UNSUPPORTED_ANSWER_WORDS"] }),
    },
  },
  {
    label: "q2-scholarship-nov1-deadline",
    topic: "Scholarship awareness + November 1st application deadline",
    draft: {
      questionType: "TRUE_FALSE",
      questionText: "The deadline for submitting scholarship applications at Silver Springs is November 1st, and more information will be provided in monthly staff newsletters about the scholarship program and how to apply before the deadline arrives on November 1st, 2026",
      options: [
        { text: "True", isCorrect: true },
        { text: "False", isCorrect: false },
      ],
      explanation: "The evidence states that there are three $500 scholarships available and applications must be submitted by November 1st. Additionally, more information will be provided in monthly staff newsletters before the deadline. Therefore, the statement is true",
      sourceSegmentIds: [12, 13, 14, 15],
    },
    grounding: makeGrounding([
      makePassage({ passageId: 11, startSec: 55.08, endSec: 63.68, text: "And will not be tolerated at Silver Springs. Also, we'd like all of you to be aware that there" }),
      makePassage({ passageId: 12, startSec: 63.68, endSec: 69.3,  text: "are three $500 scholarships available at Silver Springs and your applications must be submitted" }),
      makePassage({ passageId: 13, startSec: 69.3,  endSec: 77.04, text: "by November 1st. There'll be more information that comes out on this in our monthly staff" }),
      makePassage({ passageId: 14, startSec: 77.04, endSec: 81.76, text: "newsletters. So make sure you're watching for that. Make sure you get in your application before" }),
      makePassage({ passageId: 15, startSec: 81.76, endSec: 88.12, text: "the deadline. A little reminder on parking. Please use caution when driving to the clubhouse. We don't" }),
    ]),
    authorization: makeAuth("q2"),
    backend: "lm-format-enforcer",
    metrics: { inferenceMs: 4570, gpuSeconds: 4.57, estimatedCostUsd: 0.0058, promptTokenCount: 2060, outputTokenCount: 173 },
    sourceWindow: { startSec: 55.08, endSec: 88.12 },
    provenance: "EP-TRAIN-6C-9 pilot, fingerprint 8a2d8c9b…",
    revalidationDemo: {
      scenarioLabel: "Edit strips the invented 2026 year; advisories remain",
      scenarioDescription: "A reviewer removes 'November 1st, 2026' and keeps only the supported 'November 1st' deadline. The year hard-error clears; the source-org + unsupported-words advisories remain.",
      result: demoResult({
        verdict: "REQUIRES_HUMAN_VERIFICATION",
        flags: ["SOURCE_ORG_MISMATCH", "FLAG_UNSUPPORTED_ANSWER_WORDS"],
      }),
    },
  },
  {
    label: "q3-safety-near-miss-reporting",
    topic: "Health-and-safety committee + near-miss reporting",
    draft: {
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
    },
    grounding: makeGrounding([
      makePassage({ passageId: 19, startSec: 132.3, endSec: 144.12, text: "We do have a health and safety committee here at Silver Springs. Our goal is to make sure that our staff, number one, are protected and safe in the work environment." }),
      makePassage({ passageId: 20, startSec: 144.12, endSec: 150.0, text: "We also want to make sure we review our processes and make sure things are being done correctly." }),
      makePassage({ passageId: 21, startSec: 150.0, endSec: 155.0, text: "If you see something that you think is a near miss, please report it to your manager." }),
    ]),
    authorization: makeAuth("q3"),
    backend: "lm-format-enforcer",
    metrics: { inferenceMs: 6004, gpuSeconds: 6.004, estimatedCostUsd: 0.0058, promptTokenCount: 1944, outputTokenCount: 224 },
    sourceWindow: { startSec: 132.3, endSec: 155.0 },
    provenance: "EP-TRAIN-6C-9 pilot, fingerprint 4e3a92c1…",
    revalidationDemo: {
      scenarioLabel: "Edit replaces OSHA + insurance distractors; hard errors clear",
      scenarioDescription: "A reviewer replaces the two policy-reading distractors (OSHA regulations, insurance company) with grounded alternatives. The three hard errors (ERR_CITATION_SEGMENT_UNAUTHORIZED, ERR_UNSUPPORTED_REGULATORY_BODY, ERR_UNSUPPORTED_INSURANCE_REFERENCE) all clear; verdict becomes REQUIRES_HUMAN_VERIFICATION. Approval becomes allowed.",
      result: demoResult({
        verdict: "REQUIRES_HUMAN_VERIFICATION",
        flags: ["SOURCE_ORG_MISMATCH", "FLAG_UNSUPPORTED_ANSWER_WORDS"],
      }),
    },
  },
  {
    label: "q4-member-experience-framing",
    topic: "Silver Springs member-experience framing",
    draft: {
      questionType: "TRUE_FALSE",
      questionText: "Silver Springs is focusing on enhancing the member experience according to the administrator's statement",
      options: [
        { text: "True", isCorrect: true },
        { text: "False", isCorrect: false },
      ],
      explanation: "The administrator stated, 'But once again, at Silver Springs, we're trying to enhance the member experience'. This directly supports the correct answer being True",
      sourceSegmentIds: [0],
    },
    grounding: makeGrounding([
      makePassage({ passageId: 0, startSec: 0, endSec: 4.58, text: "understand that. But once again, at Silver Springs, we're trying to enhance the member experience" }),
    ]),
    authorization: makeAuth("q4"),
    backend: "lm-format-enforcer",
    metrics: { inferenceMs: 3166, gpuSeconds: 3.166, estimatedCostUsd: 0.0058, promptTokenCount: 1714, outputTokenCount: 112 },
    sourceWindow: { startSec: 0, endSec: 4.58 },
    provenance: "EP-TRAIN-6C-11 pilot, SHA 8b418f96…",
    revalidationDemo: {
      scenarioLabel: "Edit trims trailing qualifier; advisories unchanged",
      scenarioDescription: "A reviewer removes the trailing 'according to the administrator's statement' qualifier. Verdict and advisories are expected to remain the same.",
      result: demoResult({
        verdict: "REQUIRES_HUMAN_VERIFICATION",
        flags: ["SOURCE_ORG_MISMATCH", "FLAG_UNSUPPORTED_ANSWER_WORDS"],
      }),
    },
  },
  {
    label: "q5-no-phones-in-front-of-members",
    topic: "Phone-policy rule — no phones in front of members or guests",
    draft: {
      questionType: "TRUE_FALSE",
      questionText: "Using a phone in front of members or guests is allowed as long as it is not visible to them from a back room or other area they are in view of, according to the administrator's instructions for staff behavior at Silver Springs",
      options: [
        { text: "True", isCorrect: false },
        { text: "False", isCorrect: true },
      ],
      explanation: "The administrator clearly states that using a phone in front of members or guests is not acceptable behavior. Staff are instructed to go into a back room or out of view of members and guests to use their phone. Therefore, the correct answer is False",
      sourceSegmentIds: [1, 2],
    },
    grounding: makeGrounding([
      makePassage({ passageId: 1, startSec: 4.58, endSec: 8.86, text: "and being on your phone in front of our members and or guests is not how we like our staff to" }),
      makePassage({ passageId: 2, startSec: 8.86, endSec: 16.28, text: "behave. Please check your phone out of the sites of any members or other staff, go into a back room," }),
    ]),
    authorization: makeAuth("q5"),
    backend: "lm-format-enforcer",
    metrics: { inferenceMs: 4353, gpuSeconds: 4.353, estimatedCostUsd: 0.0058, promptTokenCount: 1755, outputTokenCount: 162 },
    sourceWindow: { startSec: 4.58, endSec: 16.28 },
    provenance: "EP-TRAIN-6C-11 pilot, SHA 77cb58db…",
    revalidationDemo: {
      scenarioLabel: "Edit simplifies the convoluted stem; advisory remains",
      scenarioDescription: "A reviewer rewrites the double-negative stem to a simple assertion. Verdict stays REQUIRES_HUMAN_VERIFICATION with the unsupported-words advisory.",
      result: demoResult({ verdict: "REQUIRES_HUMAN_VERIFICATION", flags: ["FLAG_UNSUPPORTED_ANSWER_WORDS"] }),
    },
  },
  {
    label: "q6-phone-call-discretion-back-room",
    topic: "Phone-call discretion — go to a back room; be discreet",
    draft: {
      questionType: "TRUE_FALSE",
      questionText: "Administrators are allowed to make necessary phone calls but should be discreet about it during member service hours at Silver Springs",
      options: [
        { text: "True", isCorrect: true },
        { text: "False", isCorrect: false },
      ],
      explanation: "The administrator is allowed to make necessary phone calls but should be discreet about it during member service hours. This is supported by the statement: 'make your phone calls that you need to. But once again, be discreet with your cell phone.'",
      sourceSegmentIds: [3, 4],
    },
    grounding: makeGrounding([
      makePassage({ passageId: 3, startSec: 16.78, endSec: 20.68, text: "make your phone calls that you need to. But once again, be discreet with your cell phone." }),
      makePassage({ passageId: 4, startSec: 21.34, endSec: 24.84, text: "Do not have it out staring at your phone while members are trying to be serviced." }),
    ]),
    authorization: makeAuth("q6"),
    backend: "lm-format-enforcer",
    metrics: { inferenceMs: 3838, gpuSeconds: 3.838, estimatedCostUsd: 0.0058, promptTokenCount: 1746, outputTokenCount: 143 },
    sourceWindow: { startSec: 16.78, endSec: 24.84 },
    provenance: "EP-TRAIN-6C-11 pilot, SHA 5a5cac0e…",
    revalidationDemo: {
      scenarioLabel: "Edit replaces 'Administrators' with 'Staff members'; advisory remains",
      scenarioDescription: "A reviewer corrects the 'Administrators' subject-attribution defect to 'Staff members'. The pipeline is expected to still flag unsupported connecting words.",
      result: demoResult({ verdict: "REQUIRES_HUMAN_VERIFICATION", flags: ["FLAG_UNSUPPORTED_ANSWER_WORDS"] }),
    },
  },
  {
    label: "q7-negativity-principle",
    topic: "Workplace culture principle — negativity breeds more negativity",
    draft: {
      questionType: "TRUE_FALSE",
      questionText: "The statement 'Negativity breeds more negativity' is a principle that should be applied in the workplace to maintain a positive environment and reduce conflicts among staff members at Silver Springs",
      options: [
        { text: "True", isCorrect: true },
        { text: "False", isCorrect: false },
      ],
      explanation: "The statement 'Negativity breeds more negativity' is a principle that should be applied in the workplace to maintain a positive environment and reduce conflicts among staff members at Silver Springs. This aligns with the provided evidence segment_id=10, start=53.2, end=54.78, which states 'Negativity breeds more negativity'.",
      sourceSegmentIds: [10],
    },
    grounding: makeGrounding([
      makePassage({ passageId: 10, startSec: 53.2, endSec: 54.78, text: "Negativity breeds more negativity." }),
    ]),
    authorization: makeAuth("q7"),
    backend: "lm-format-enforcer",
    metrics: { inferenceMs: 4623, gpuSeconds: 4.623, estimatedCostUsd: 0.0058, promptTokenCount: 1651, outputTokenCount: 173 },
    sourceWindow: { startSec: 53.2, endSec: 54.78 },
    provenance: "EP-TRAIN-6C-11 pilot, SHA d0bc6c28…",
    revalidationDemo: {
      scenarioLabel: "Edit strips the invented prescriptive clause; advisory remains",
      scenarioDescription: "A reviewer removes the invented 'should be applied in the workplace to maintain… reduce conflicts' prescriptive clause. Verdict stays REQUIRES_HUMAN_VERIFICATION with the unsupported-words advisory.",
      result: demoResult({ verdict: "REQUIRES_HUMAN_VERIFICATION", flags: ["FLAG_UNSUPPORTED_ANSWER_WORDS"] }),
    },
  },
  {
    label: "q8-parking-policy",
    topic: "Parking policy — staff on street; members/guests in lot",
    draft: {
      questionType: "SINGLE_CHOICE",
      questionText: "What should staff members be reminded about the day before their shift or event at Silver Springs regarding parking instructions for members and guests?",
      options: [
        { text: "They should park in the designated lot for members and guests", isCorrect: false },
        { text: "They should park on the street", isCorrect: true },
        { text: "They should park in the employee parking area", isCorrect: false },
      ],
      explanation: "The correct answer is supported by the statement: 'As you might know, make sure that we provide all the parking once again for our members and guests. You will be reminded of this the day before the shift or the event. Just please make sure that you follow the instruction and park on the street.'",
      sourceSegmentIds: [18],
    },
    grounding: makeGrounding([
      makePassage({ passageId: 18, startSec: 118.9, endSec: 131.4, text: "As you might know, make sure that we provide all the parking once again for our members and guests. You will be reminded of this the day before the shift or the event. Just please make sure that you follow the instruction and park on the street." }),
    ]),
    authorization: makeAuth("q8"),
    backend: "lm-format-enforcer",
    metrics: { inferenceMs: 5256, gpuSeconds: 5.256, estimatedCostUsd: 0.0058, promptTokenCount: 1696, outputTokenCount: 195 },
    sourceWindow: { startSec: 118.9, endSec: 131.4 },
    provenance: "EP-TRAIN-6C-11 pilot, SHA 3ad4adc3…",
    revalidationDemo: {
      scenarioLabel: "Edit tightens the question stem; advisory remains",
      scenarioDescription: "A reviewer shortens the verbose 'What should staff members be reminded about…' stem. Verdict and advisories are expected to remain the same.",
      result: demoResult({ verdict: "REQUIRES_HUMAN_VERIFICATION", flags: ["FLAG_UNSUPPORTED_ANSWER_WORDS"] }),
    },
  },
];

export const COURSE_CONTEXT = {
  title: "2026 Employee Rules and Perks — Staff Orientation",
  clubName: "Silver Springs Golf & Country Club",
  tenantLabel: "Coulee Ridge (development tenant)",
  sourceVideoName: "staff-orientation-2026.mp4",
  resolvedTranscriptBuildId: "d138a72b1c3eee7329629f5759e528ca8dbeee5000a71a698f512e78191a2237",
  totalPassages: 20,
  excludedPassages: [16, 17],
  windowStartSec: 0,
  windowEndSec: 180,
} as const;

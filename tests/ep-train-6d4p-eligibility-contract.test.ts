// EP-TRAIN-6D-4P — Server-derived reviewer eligibility contract.
//
// The browser NEVER re-computes approvability. This file pins the
// contract of `computeReviewerEligibility` so a regression in the
// matrix (CLUB_ADMIN promoted to approver, historical candidates
// made approvable, MULTI_ANSWER opened up, etc.) fails here before
// it ships to a reviewer.

import { describe, expect, it } from "vitest";
import {
  computeReviewerEligibility,
  ELIGIBILITY_REASON_COPY,
  type EligibilityReason,
} from "@/lib/hr/training/ai-review/reviewer-eligibility";
import type { Principal } from "@/lib/rbac";
import type { CandidateDetail } from "@/lib/hr/training/ai-review/read-service";
import type { CandidateEvidence } from "@/lib/hr/training/ai-review/evidence-reader";
import type { VerifiedAnswerResolution } from "@/lib/hr/training/ai-review/verified-answer-reader";

function makePrincipal(role: "CLUB_ADMIN" | "SUPER_ADMIN" | "STAFF"): Principal {
  return {
    id: `user_${role.toLowerCase()}`,
    name: role,
    email: `${role.toLowerCase()}@example.test`,
    status: "ACTIVE",
    memberships:
      role === "SUPER_ADMIN"
        ? [{ clubId: null, roleKey: "SUPER_ADMIN" }]
        : [{ clubId: "club1", roleKey: role }],
    activeClubId: "club1",
    memberId: null,
  };
}

function detail(overrides: Partial<CandidateDetail> = {}): CandidateDetail {
  return {
    draftId: "d1",
    clubId: "club1",
    courseId: "crs1",
    courseVersionId: "ver1",
    state: "REQUIRES_HUMAN_REVIEW",
    contentHash: "h".repeat(64),
    recordVersion: 1,
    generatedAt: new Date(),
    updatedAt: new Date(),
    draft: {
      questionType: "SINGLE_CHOICE",
      questionText: "q?",
      options: [
        { text: "a", isCorrect: false },
        { text: "b", isCorrect: true },
      ],
      explanation: "e",
      sourceSegmentIds: [0, 1],
    },
    sourceVideoSha256: "v".repeat(64),
    resolvedTranscriptBuildId: "t".repeat(64),
    groundingProjectionSha256: "p".repeat(64),
    latestValidation: {
      id: "v1",
      draftContentHash: "h".repeat(64),
      validatorVersion: "6c-10c",
      validatorSource: "integrated-pipeline",
      verdict: "REQUIRES_HUMAN_VERIFICATION",
      stage: "VALIDATE",
      errors: [],
      flags: [],
      runAt: new Date(),
    },
    historicalValidations: [],
    reviews: [],
    ...overrides,
  };
}

const AUTHENTIC_EV: CandidateEvidence = {
  kind: "authentic",
  projectionId: "proj1",
  projectionSha256: "0".repeat(64),
  transcriptBuildId: "build1",
  transcriber: {
    transcriberName: "faster-whisper",
    transcriberVersion: "1.0.3",
    transcriberModelName: "large-v3",
    transcriberModelVersion: "stub",
    producedAt: new Date(),
  },
  sourceMaterial: {
    courseTitle: "Course",
    versionTitle: "v",
    versionNumber: 1,
    videoStorageKeyPresent: true,
    videoDurationSec: 120,
  },
  sourceOrgMismatchFlagsPresent: false,
  pendingReviewPresent: false,
  citedSegments: [],
  videoSeekEnabled: false,
  videoSourceVersionId: "ver1",
};

const HISTORICAL_EV: CandidateEvidence = {
  kind: "historical-unavailable",
  reason: "HISTORICAL_PILOT_NO_PROJECTION",
  sourceMaterial: AUTHENTIC_EV.sourceMaterial,
  citedSegmentIndices: [0, 1],
  groundingProjectionFingerprint: "fixture-test",
};

const INTEGRITY_FAIL_EV: CandidateEvidence = {
  kind: "evidence-integrity-failure",
  code: "CITED_SEGMENTS_UNRESOLVABLE",
  safeMessage: "Evidence integrity cannot be confirmed.",
  sourceMaterial: AUTHENTIC_EV.sourceMaterial,
  citedSegmentIndices: [0, 1],
};

const UNVERIFIED: VerifiedAnswerResolution = { kind: "unverified" };
const VERIFIED: VerifiedAnswerResolution = {
  kind: "verified",
  optionIndex: 1,
  optionText: "b",
  verifiedByUserId: "u1",
  verifiedByUserName: "Someone",
  verifiedAt: new Date(),
  validationId: "v1",
  reviewId: "r1",
};

describe("EP-TRAIN-6D-4P — reviewer eligibility", () => {
  it("SUPER_ADMIN on REQUIRES_HUMAN_REVIEW SINGLE_CHOICE + authentic evidence → eligible", () => {
    const e = computeReviewerEligibility(
      makePrincipal("SUPER_ADMIN"),
      "club1",
      detail(),
      AUTHENTIC_EV,
      UNVERIFIED,
      "Super Admin",
    );
    expect(e.canApprove).toBe(true);
    expect(e.selectedDraftEligibility?.eligible).toBe(true);
    expect(e.selectedDraftEligibility?.reasons).toEqual([]);
    expect(e.reviewerDisplayName).toBe("Super Admin");
  });

  it("CLUB_ADMIN never has canApprove", () => {
    const e = computeReviewerEligibility(
      makePrincipal("CLUB_ADMIN"),
      "club1",
      detail(),
      AUTHENTIC_EV,
      UNVERIFIED,
      "Club Admin",
    );
    expect(e.canApprove).toBe(false);
    // The per-draft gate may still report eligible: true (no reasons);
    // the UI gates on canApprove AND eligible — this separation is
    // intentional so a CLUB_ADMIN can see why a draft is otherwise
    // approvable.
    expect(e.selectedDraftEligibility?.eligible).toBe(true);
  });

  it("STAFF has no canApprove and no read either — eligibility returns canApprove=false", () => {
    const e = computeReviewerEligibility(
      makePrincipal("STAFF"),
      "club1",
      detail(),
      AUTHENTIC_EV,
      UNVERIFIED,
      "Staff Person",
    );
    expect(e.canApprove).toBe(false);
  });

  it("No candidate selected → selectedDraftEligibility is null", () => {
    const e = computeReviewerEligibility(
      makePrincipal("SUPER_ADMIN"),
      "club1",
      null,
      null,
      null,
      "Super",
    );
    expect(e.selectedDraftEligibility).toBeNull();
  });

  it("MULTI_ANSWER questions are not eligible (reason: QUESTION_TYPE_UNSUPPORTED)", () => {
    const e = computeReviewerEligibility(
      makePrincipal("SUPER_ADMIN"),
      "club1",
      detail({ draft: { ...detail().draft, questionType: "MULTI_ANSWER" } }),
      AUTHENTIC_EV,
      UNVERIFIED,
      "Super",
    );
    expect(e.selectedDraftEligibility?.eligible).toBe(false);
    expect(e.selectedDraftEligibility?.reasons).toContain("QUESTION_TYPE_UNSUPPORTED");
  });

  it("Historical candidates not eligible (reason: HISTORICAL_EVIDENCE_UNAVAILABLE)", () => {
    const e = computeReviewerEligibility(
      makePrincipal("SUPER_ADMIN"),
      "club1",
      detail(),
      HISTORICAL_EV,
      UNVERIFIED,
      "Super",
    );
    expect(e.selectedDraftEligibility?.eligible).toBe(false);
    expect(e.selectedDraftEligibility?.reasons).toContain("HISTORICAL_EVIDENCE_UNAVAILABLE");
  });

  it("Evidence integrity failure not eligible (reason: EVIDENCE_INTEGRITY_FAILURE)", () => {
    const e = computeReviewerEligibility(
      makePrincipal("SUPER_ADMIN"),
      "club1",
      detail(),
      INTEGRITY_FAIL_EV,
      UNVERIFIED,
      "Super",
    );
    expect(e.selectedDraftEligibility?.eligible).toBe(false);
    expect(e.selectedDraftEligibility?.reasons).toContain("EVIDENCE_INTEGRITY_FAILURE");
  });

  it("REJECTED state not eligible (reason: STATE_NOT_REQUIRES_HUMAN_REVIEW)", () => {
    const e = computeReviewerEligibility(
      makePrincipal("SUPER_ADMIN"),
      "club1",
      detail({ state: "REJECTED" }),
      AUTHENTIC_EV,
      UNVERIFIED,
      "Super",
    );
    expect(e.selectedDraftEligibility?.eligible).toBe(false);
    expect(e.selectedDraftEligibility?.reasons).toContain("STATE_NOT_REQUIRES_HUMAN_REVIEW");
  });

  it("APPROVED_DRAFT state not eligible (reason: STATE_NOT_REQUIRES_HUMAN_REVIEW)", () => {
    const e = computeReviewerEligibility(
      makePrincipal("SUPER_ADMIN"),
      "club1",
      detail({ state: "APPROVED_DRAFT" }),
      AUTHENTIC_EV,
      VERIFIED,
      "Super",
    );
    expect(e.selectedDraftEligibility?.eligible).toBe(false);
    const reasons = e.selectedDraftEligibility?.reasons ?? [];
    expect(reasons).toContain("STATE_NOT_REQUIRES_HUMAN_REVIEW");
    expect(reasons).toContain("ALREADY_VERIFIED");
  });

  it("Hard validation errors not eligible (reason: VALIDATION_HAS_HARD_ERRORS)", () => {
    const d = detail();
    const withErr: CandidateDetail = {
      ...d,
      latestValidation: {
        ...d.latestValidation!,
        errors: [{ code: "ERR_X", message: "bad" }],
      },
    };
    const e = computeReviewerEligibility(
      makePrincipal("SUPER_ADMIN"),
      "club1",
      withErr,
      AUTHENTIC_EV,
      UNVERIFIED,
      "Super",
    );
    expect(e.selectedDraftEligibility?.eligible).toBe(false);
    expect(e.selectedDraftEligibility?.reasons).toContain("VALIDATION_HAS_HARD_ERRORS");
  });

  it("Missing validation not eligible (reason: VALIDATION_ROW_MISSING)", () => {
    const e = computeReviewerEligibility(
      makePrincipal("SUPER_ADMIN"),
      "club1",
      detail({ latestValidation: null }),
      AUTHENTIC_EV,
      UNVERIFIED,
      "Super",
    );
    expect(e.selectedDraftEligibility?.eligible).toBe(false);
    expect(e.selectedDraftEligibility?.reasons).toContain("VALIDATION_ROW_MISSING");
  });

  it("Already-verified candidate not eligible (reason: ALREADY_VERIFIED)", () => {
    const e = computeReviewerEligibility(
      makePrincipal("SUPER_ADMIN"),
      "club1",
      detail(),
      AUTHENTIC_EV,
      VERIFIED,
      "Super",
    );
    expect(e.selectedDraftEligibility?.eligible).toBe(false);
    expect(e.selectedDraftEligibility?.reasons).toContain("ALREADY_VERIFIED");
  });

  it("TRUE_FALSE is approvable", () => {
    const e = computeReviewerEligibility(
      makePrincipal("SUPER_ADMIN"),
      "club1",
      detail({ draft: { ...detail().draft, questionType: "TRUE_FALSE" } }),
      AUTHENTIC_EV,
      UNVERIFIED,
      "Super",
    );
    expect(e.selectedDraftEligibility?.eligible).toBe(true);
  });

  it("Every eligibility reason has copy", () => {
    const reasons: EligibilityReason[] = [
      "STATE_NOT_REQUIRES_HUMAN_REVIEW",
      "QUESTION_TYPE_UNSUPPORTED",
      "HISTORICAL_EVIDENCE_UNAVAILABLE",
      "EVIDENCE_INTEGRITY_FAILURE",
      "VALIDATION_HAS_HARD_ERRORS",
      "ALREADY_VERIFIED",
      "VALIDATION_ROW_MISSING",
    ];
    for (const r of reasons) {
      expect(ELIGIBILITY_REASON_COPY[r]).toBeTruthy();
      expect(ELIGIBILITY_REASON_COPY[r].length).toBeGreaterThan(10);
    }
  });
});

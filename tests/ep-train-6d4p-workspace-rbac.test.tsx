// @vitest-environment jsdom
//
// EP-TRAIN-6D-4P — Workspace RBAC + eligibility rendering.
//
// Covers directive §§ 4, 5, 6, 8, 9:
//   - CLUB_ADMIN never sees an enabled Approve button.
//   - Historical candidates show the Historical banner AND the
//     reason-specific disabled explanation.
//   - MULTI_ANSWER candidates render refusal explanation.
//   - Evidence integrity failure renders refusal explanation.
//   - Approve button for an eligible SUPER_ADMIN opens the dialog.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

// The ReviewerDecisionPanel uses `useRouter` from next/navigation to
// call router.refresh() after a successful approval. In jsdom there
// is no App Router context, so we stub the hook. The stub is enough
// for every test here — we never assert a navigation call.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => {},
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    prefetch: async () => {},
  }),
}));

import PersistedReviewWorkspace from "@/components/ai-training/PersistedReviewWorkspace";
import type {
  CandidateDetail,
  CandidateQueueRow,
} from "@/lib/hr/training/ai-review/read-service";
import type { CandidateEvidence } from "@/lib/hr/training/ai-review/evidence-reader";
import type { VerifiedAnswerResolution } from "@/lib/hr/training/ai-review/verified-answer-reader";
import type { ReviewerEligibility } from "@/lib/hr/training/ai-review/reviewer-eligibility";

afterEach(() => cleanup());

const CONTENT_HASH = "f".repeat(64);

function detail(overrides: Partial<CandidateDetail> = {}): CandidateDetail {
  return {
    draftId: "draft_1",
    clubId: "club1",
    courseId: "crs1",
    courseVersionId: "ver1",
    state: "REQUIRES_HUMAN_REVIEW",
    contentHash: CONTENT_HASH,
    recordVersion: 2,
    generatedAt: new Date("2026-11-04"),
    updatedAt: new Date("2026-11-05"),
    draft: {
      questionType: "SINGLE_CHOICE",
      questionText: "Q?",
      options: [
        { text: "A", isCorrect: true },
        { text: "B", isCorrect: false },
      ],
      explanation: "",
      sourceSegmentIds: [0],
    },
    sourceVideoSha256: "v".repeat(64),
    resolvedTranscriptBuildId: "t".repeat(64),
    groundingProjectionSha256: "p".repeat(64),
    latestValidation: {
      id: "val1",
      draftContentHash: CONTENT_HASH,
      validatorVersion: "1",
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

const QUEUE: CandidateQueueRow[] = [
  {
    draftId: "draft_1",
    topic: "Q?",
    state: "REQUIRES_HUMAN_REVIEW",
    contentHash: CONTENT_HASH,
    recordVersion: 2,
    generatedAt: new Date(),
    updatedAt: new Date(),
    courseVersionId: "ver1",
    latestVerdict: "REQUIRES_HUMAN_VERIFICATION",
    latestValidatorSource: "integrated-pipeline",
    latestHardErrorCount: 0,
    latestAdvisoryCount: 0,
    latestValidationAt: new Date(),
  },
];

const EV_AUTHENTIC: CandidateEvidence = {
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

const EV_HISTORICAL: CandidateEvidence = {
  kind: "historical-unavailable",
  reason: "HISTORICAL_PILOT_NO_PROJECTION",
  sourceMaterial: EV_AUTHENTIC.sourceMaterial,
  citedSegmentIndices: [0],
  groundingProjectionFingerprint: "fixture-test",
};

const EV_INTEGRITY_FAIL: CandidateEvidence = {
  kind: "evidence-integrity-failure",
  code: "CITED_SEGMENTS_UNRESOLVABLE",
  safeMessage: "Evidence integrity cannot be confirmed.",
  sourceMaterial: EV_AUTHENTIC.sourceMaterial,
  citedSegmentIndices: [0],
};

const UNVERIFIED: VerifiedAnswerResolution = { kind: "unverified" };

function renderWorkspace(
  eligibility: ReviewerEligibility,
  ev: CandidateEvidence = EV_AUTHENTIC,
  detailOverrides: Partial<CandidateDetail> = {},
) {
  return render(
    <PersistedReviewWorkspace
      queue={QUEUE}
      selectedDetail={detail(detailOverrides)}
      selectedDraftId="draft_1"
      clubLabel="Alpha Club"
      totalCount={1}
      nextCursor={null}
      isEmptyQueue={false}
      sourceContext={{
        courseTitle: "Course",
        versionTitle: "v",
        versionNumber: 1,
        videoStorageKeyPresent: true,
        videoDurationSec: 120,
      }}
      evidence={ev}
      verifiedAnswer={UNVERIFIED}
      reviewerEligibility={eligibility}
    />,
  );
}

function elig(partial: Partial<ReviewerEligibility>): ReviewerEligibility {
  return {
    canApprove: false,
    reviewerUserId: "u1",
    reviewerDisplayName: "Reviewer",
    selectedDraftEligibility: { eligible: false, reasons: [] },
    ...partial,
  };
}

describe("EP-TRAIN-6D-4P — workspace RBAC + eligibility", () => {
  it("SUPER_ADMIN + eligible draft → Approve button is enabled", () => {
    renderWorkspace(
      elig({
        canApprove: true,
        selectedDraftEligibility: { eligible: true, reasons: [] },
      }),
    );
    const btn = screen.getByTestId("approve-candidate-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("CLUB_ADMIN (canApprove=false) → Approve button disabled + explanation", () => {
    const { container } = renderWorkspace(
      elig({
        canApprove: false,
        selectedDraftEligibility: { eligible: true, reasons: [] }, // per-draft side is fine
      }),
    );
    const btn = screen.getByTestId("approve-candidate-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.textContent).toMatch(/Approval requires the AI-training approval permission/i);
  });

  it("Approve button has aria-disabled when unapprovable", () => {
    renderWorkspace(
      elig({
        canApprove: false,
        selectedDraftEligibility: { eligible: false, reasons: ["HISTORICAL_EVIDENCE_UNAVAILABLE"] },
      }),
    );
    const btn = screen.getByTestId("approve-candidate-button");
    expect(btn.getAttribute("aria-disabled")).toBeTruthy();
  });

  it("Historical candidate → Approve disabled + historical-specific explanation", () => {
    const { container } = renderWorkspace(
      elig({
        canApprove: true,
        selectedDraftEligibility: {
          eligible: false,
          reasons: ["HISTORICAL_EVIDENCE_UNAVAILABLE"],
        },
      }),
      EV_HISTORICAL,
    );
    const btn = screen.getByTestId("approve-candidate-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.textContent).toMatch(/pilot-era transcript evidence was not durably persisted/i);
    // The 4M "Historical evidence unavailable" banner still renders.
    expect(container.textContent).toMatch(/Historical evidence unavailable/i);
  });

  it("MULTI_ANSWER → Approve disabled + unsupported-type copy", () => {
    const { container } = renderWorkspace(
      elig({
        canApprove: true,
        selectedDraftEligibility: {
          eligible: false,
          reasons: ["QUESTION_TYPE_UNSUPPORTED"],
        },
      }),
      EV_AUTHENTIC,
      { draft: { ...detail().draft, questionType: "MULTI_ANSWER" } },
    );
    const btn = screen.getByTestId("approve-candidate-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.textContent).toMatch(/Multi-answer questions are not yet supported/i);
  });

  it("Evidence integrity failure → Approve disabled + integrity-specific copy", () => {
    const { container } = renderWorkspace(
      elig({
        canApprove: true,
        selectedDraftEligibility: {
          eligible: false,
          reasons: ["EVIDENCE_INTEGRITY_FAILURE"],
        },
      }),
      EV_INTEGRITY_FAIL,
    );
    const btn = screen.getByTestId("approve-candidate-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.textContent).toMatch(/evidence integrity cannot be confirmed/i);
  });

  it("Already-verified candidate → Approve disabled", () => {
    const { container } = renderWorkspace(
      elig({
        canApprove: true,
        selectedDraftEligibility: { eligible: false, reasons: ["ALREADY_VERIFIED"] },
      }),
    );
    const btn = screen.getByTestId("approve-candidate-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(container.textContent).toMatch(/already been reviewer-verified/i);
  });

  it("Clicking the enabled Approve button opens the dialog", () => {
    renderWorkspace(
      elig({
        canApprove: true,
        selectedDraftEligibility: { eligible: true, reasons: [] },
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("approve-candidate-button"));
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("Approve button for CLUB_ADMIN cannot be bypassed by DOM click (stays disabled)", () => {
    const eligibility = elig({
      canApprove: false,
      selectedDraftEligibility: { eligible: true, reasons: [] },
    });
    renderWorkspace(eligibility);
    const btn = screen.getByTestId("approve-candidate-button") as HTMLButtonElement;
    // Browser would skip onClick on a disabled button; verify disabled attribute is present.
    expect(btn.disabled).toBe(true);
    // No dialog opens.
    fireEvent.click(btn);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Mode notice reads 'reviewer workspace' for approvers; 'read-only' otherwise", () => {
    const { container: adminC } = renderWorkspace(
      elig({ canApprove: true, selectedDraftEligibility: { eligible: true, reasons: [] } }),
    );
    expect(adminC.textContent).toMatch(/reviewer workspace/i);
    cleanup();
    const { container: readOnlyC } = renderWorkspace(
      elig({ canApprove: false, selectedDraftEligibility: { eligible: true, reasons: [] } }),
    );
    expect(readOnlyC.textContent).toMatch(/read-only/i);
  });
});

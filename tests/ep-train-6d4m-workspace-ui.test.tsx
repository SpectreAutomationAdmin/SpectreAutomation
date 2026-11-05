// @vitest-environment jsdom
//
// EP-TRAIN-6D-4M — PersistedReviewWorkspace UI assertions.
//
// Covers the directive's §6 + §9 UI rules without spinning the Next
// server:
//   - No emerald "Correct" styling on any option in any lifecycle
//     state (because 4N has not yet implemented the approval chain
//     that writes verifiedCorrectAnswerSnapshotJson).
//   - Model-selected options carry the neutral "Model-selected ·
//     unverified" chip.
//   - Historical-unavailable evidence surfaces the amber banner and
//     does NOT emit segment text.
//   - Authentic evidence renders segment text + timestamps + ▶ Play
//     when the video storage key is present.
//   - Evidence-integrity-failure surfaces the fail-closed safe
//     diagnostic, not segment text.
//   - Every mutation-adjacent element is DISABLED or absent.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import PersistedReviewWorkspace from "@/components/ai-training/PersistedReviewWorkspace";
import type {
  CandidateDetail,
  CandidateQueueRow,
} from "@/lib/hr/training/ai-review/read-service";
import type { CandidateEvidence } from "@/lib/hr/training/ai-review/evidence-reader";

function baseDetail(overrides: Partial<CandidateDetail> = {}): CandidateDetail {
  return {
    draftId: "d1",
    clubId: "c1",
    courseId: "crs1",
    courseVersionId: "ver1",
    state: "REQUIRES_HUMAN_REVIEW",
    contentHash: "h".repeat(64),
    recordVersion: 1,
    generatedAt: new Date("2026-11-04T00:00:00Z"),
    updatedAt: new Date("2026-11-04T00:00:00Z"),
    draft: {
      questionType: "SINGLE_CHOICE",
      questionText: "Which of these is the policy?",
      options: [
        { text: "Report to manager", isCorrect: true },
        { text: "Ignore", isCorrect: false },
      ],
      explanation: "The model's reasoning.",
      sourceSegmentIds: [0, 1],
    },
    sourceVideoSha256: "a".repeat(64),
    resolvedTranscriptBuildId: "b".repeat(64),
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

function baseQueue(): CandidateQueueRow[] {
  return [
    {
      draftId: "d1",
      topic: "Which of these is the policy?",
      state: "REQUIRES_HUMAN_REVIEW",
      contentHash: "h".repeat(64),
      recordVersion: 1,
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
    courseTitle: "Staff Orientation",
    versionTitle: "2026 refresh",
    versionNumber: 2,
    videoStorageKeyPresent: true,
    videoDurationSec: 240,
  },
  sourceOrgMismatchFlagsPresent: false,
  pendingReviewPresent: false,
  citedSegments: [
    {
      segmentIndex: 0,
      text: "This is the authoritative transcript for segment zero.",
      startSec: "0.00",
      endSec: "2.50",
      pendingReview: [],
      sourceOrgMismatch: [],
      uncertaintyWarning: null,
      unavailableReason: null,
    },
    {
      segmentIndex: 1,
      text: "Segment one body text.",
      startSec: "2.50",
      endSec: "5.00",
      pendingReview: [],
      sourceOrgMismatch: [],
      uncertaintyWarning: null,
      unavailableReason: null,
    },
  ],
  videoSeekEnabled: true,
  videoSourceVersionId: "ver1",
};

const HISTORICAL_EV: CandidateEvidence = {
  kind: "historical-unavailable",
  reason: "HISTORICAL_PILOT_NO_PROJECTION",
  sourceMaterial: {
    courseTitle: "Staff Orientation",
    versionTitle: "2026 refresh",
    versionNumber: 2,
    videoStorageKeyPresent: true,
    videoDurationSec: 240,
  },
  citedSegmentIndices: [5, 8],
  groundingProjectionFingerprint: "fixture-q1",
};

const INTEGRITY_FAIL_EV: CandidateEvidence = {
  kind: "evidence-integrity-failure",
  code: "PROJECTION_HASH_MISMATCH_VS_DRAFT",
  safeMessage: "Evidence integrity check failed. The stored grounding projection fingerprint does not match the candidate's recorded fingerprint. Contact support.",
  sourceMaterial: {
    courseTitle: "Staff Orientation",
    versionTitle: "2026 refresh",
    versionNumber: 2,
    videoStorageKeyPresent: true,
    videoDurationSec: 240,
  },
  citedSegmentIndices: [0, 1],
};

function renderPage(evidence: CandidateEvidence | null) {
  return render(
    <PersistedReviewWorkspace
      queue={baseQueue()}
      selectedDetail={baseDetail()}
      selectedDraftId="d1"
      clubLabel="Alpha Club"
      totalCount={1}
      nextCursor={null}
      isEmptyQueue={false}
      sourceContext={evidence ? {
        courseTitle: evidence.sourceMaterial.courseTitle,
        versionTitle: evidence.sourceMaterial.versionTitle,
        versionNumber: evidence.sourceMaterial.versionNumber,
        videoStorageKeyPresent: evidence.sourceMaterial.videoStorageKeyPresent,
        videoDurationSec: evidence.sourceMaterial.videoDurationSec,
      } : null}
      evidence={evidence}
    />,
  );
}

describe("EP-TRAIN-6D-4M — PersistedReviewWorkspace UI rules", () => {
  it("renders NO emerald 'Correct' label on any option in any lifecycle state", () => {
    const { container } = renderPage(AUTHENTIC_EV);
    // The option list is aria-labelled "Answer choices (model prediction — unverified)".
    const options = container.querySelectorAll('[role="radio"], [role="checkbox"]');
    expect(options.length).toBeGreaterThan(0);
    for (const opt of Array.from(options)) {
      // No element in the option subtree may carry emerald styling.
      const classString = (opt.getAttribute("class") ?? "") + " " +
        Array.from(opt.querySelectorAll("*")).map((n) => n.getAttribute("class") ?? "").join(" ");
      expect(classString).not.toMatch(/emerald-/);
      expect(classString).not.toMatch(/text-emerald/);
      expect(classString).not.toMatch(/bg-emerald/);
    }
  });

  it("renders the 'Model-selected · unverified' chip on the model-selected option", () => {
    const { container } = renderPage(AUTHENTIC_EV);
    const bodyText = container.textContent ?? "";
    expect(bodyText).toContain("Model-selected · unverified");
    // The rubric narration above the options is also present.
    expect(bodyText).toMatch(/model['’]s prediction/);
  });

  it("renders authentic segment text + timestamps when evidence.kind is 'authentic'", () => {
    const { container } = renderPage(AUTHENTIC_EV);
    const text = container.textContent ?? "";
    expect(text).toContain("This is the authoritative transcript for segment zero.");
    expect(text).toContain("Segment one body text.");
    // Timestamps present.
    expect(text).toContain("0.00s");
    expect(text).toContain("2.50s");
  });

  it("renders an authenticated <video> + Play button when videoSeekEnabled", () => {
    const { container } = renderPage(AUTHENTIC_EV);
    const videos = container.querySelectorAll("video");
    expect(videos.length).toBeGreaterThanOrEqual(1);
    for (const v of Array.from(videos)) {
      expect(v.getAttribute("src")).toMatch(/^\/api\/hr\/training\/versions\/ver1\/video$/);
      // The <video> MUST NOT autoplay (preload=metadata, no autoplay attr).
      expect(v.getAttribute("autoplay")).toBeNull();
    }
    expect(container.textContent).toContain("▶ Play");
  });

  it("renders the 'Historical evidence unavailable' banner for a 6D-4H candidate and NO segment text", () => {
    // The HistoricalCitedSegments component reads `detail.draft.sourceSegmentIds`
    // (the single source of truth). Align the detail + evidence so the
    // assertion reads the intended indices.
    const { container } = render(
      <PersistedReviewWorkspace
        queue={baseQueue()}
        selectedDetail={baseDetail({
          draft: {
            questionType: "SINGLE_CHOICE",
            questionText: "Historical Q",
            options: [{ text: "x", isCorrect: true }],
            explanation: "e",
            sourceSegmentIds: [5, 8],
          },
          groundingProjectionSha256: "fixture-q1",
        })}
        selectedDraftId="d1"
        clubLabel="Alpha Club"
        totalCount={1}
        nextCursor={null}
        isEmptyQueue={false}
        sourceContext={null}
        evidence={HISTORICAL_EV}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Historical evidence unavailable");
    // No segment body text (there's nothing to render).
    expect(text).not.toContain("This is the authoritative transcript for segment zero.");
    // Segment numbers are allowed.
    expect(text).toContain("seg 5");
    expect(text).toContain("seg 8");
    // No video is streamed.
    expect(container.querySelectorAll("video").length).toBe(0);
  });

  it("renders the 'Evidence integrity failure' banner + safe diagnostic for the fail-closed branch", () => {
    const { container } = renderPage(INTEGRITY_FAIL_EV);
    const text = container.textContent ?? "";
    expect(text).toContain("Evidence integrity failure");
    expect(text).toContain("Evidence integrity check failed");
    expect(text).toContain("PROJECTION_HASH_MISMATCH_VS_DRAFT");
    // No segment text at all.
    expect(text).not.toContain("This is the authoritative transcript for segment zero.");
    // The SAFE MESSAGE itself does NOT include any raw SHA. (The
    // collapsible technical-provenance footer is allowed to display
    // hashes per directive §8 — it's the explicit place for them.)
    expect(INTEGRITY_FAIL_EV.kind === "evidence-integrity-failure" && INTEGRITY_FAIL_EV.safeMessage).not.toMatch(/[0-9a-f]{64}/);
  });

  it("renders no enabled mutation buttons anywhere on the page (approve/edit/reject/revalidate/regenerate)", () => {
    const { container } = renderPage(AUTHENTIC_EV);
    const buttons = container.querySelectorAll("button");
    const mutationRe = /approve|reject|edit|revalidate|regenerate|publish|assign/i;
    for (const b of Array.from(buttons)) {
      const label = (b.textContent ?? "").trim();
      if (!mutationRe.test(label)) continue;
      // If a mutation-labelled button exists, it MUST be disabled.
      expect(b.hasAttribute("disabled")).toBe(true);
    }
  });

  it("the three-column layout, header, and queue-panel structure are preserved", () => {
    const { container } = renderPage(AUTHENTIC_EV);
    // Left panel aria-labelled
    expect(container.querySelector('[aria-label="Review queue"]')).not.toBeNull();
    // Center panel
    expect(container.querySelector('[aria-label="Question detail"]')).not.toBeNull();
    // Right panel
    expect(container.querySelector('[aria-label="Source evidence"]')).not.toBeNull();
  });
});

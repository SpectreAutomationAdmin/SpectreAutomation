// @vitest-environment jsdom
//
// EP-TRAIN-6D-4N — PersistedReviewWorkspace UI assertions for the
// verified-answer presentation.
//
// Covers directive §10:
//   - Unapproved candidates render all choices neutrally with the
//     "Model-selected · unverified" chip on the model's prediction.
//   - Successfully approved candidates render exactly ONE option with
//     emerald "Verified correct" styling + the reviewer name.
//   - Disagreement between model and reviewer is visible AS TEXT.
//   - A verified snapshot with a failed integrity check renders as
//     UNVERIFIED + an integrity-warning banner.
//   - Zero enabled mutation controls (preserves 6D-3's read-only guard
//     — the approval route is not driven by an enabled UI button in
//     this slice; a future slice can wire the button after the real-
//     reviewer identity + cross-check UX is designed).

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import PersistedReviewWorkspace from "@/components/ai-training/PersistedReviewWorkspace";
import type {
  CandidateDetail,
  CandidateQueueRow,
} from "@/lib/hr/training/ai-review/read-service";
import type { CandidateEvidence } from "@/lib/hr/training/ai-review/evidence-reader";
import type { VerifiedAnswerResolution } from "@/lib/hr/training/ai-review/verified-answer-reader";

function baseDetail(overrides: Partial<CandidateDetail> = {}): CandidateDetail {
  return {
    draftId: "d1",
    clubId: "c1",
    courseId: "crs1",
    courseVersionId: "ver1",
    state: "APPROVED_DRAFT",
    contentHash: "h".repeat(64),
    recordVersion: 1,
    generatedAt: new Date("2026-11-04T00:00:00Z"),
    updatedAt: new Date("2026-11-04T00:00:00Z"),
    draft: {
      questionType: "SINGLE_CHOICE",
      questionText: "Which of these is the policy?",
      options: [
        { text: "Model picked this", isCorrect: true },
        { text: "Reviewer picked this", isCorrect: false },
        { text: "Distractor", isCorrect: false },
      ],
      explanation: "e",
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
      verdict: "GROUNDED",
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

function queue(): CandidateQueueRow[] {
  return [{
    draftId: "d1",
    topic: "Which of these is the policy?",
    state: "APPROVED_DRAFT",
    contentHash: "h".repeat(64),
    recordVersion: 1,
    generatedAt: new Date(),
    updatedAt: new Date(),
    courseVersionId: "ver1",
    latestVerdict: "GROUNDED",
    latestValidatorSource: "integrated-pipeline",
    latestHardErrorCount: 0,
    latestAdvisoryCount: 0,
    latestValidationAt: new Date(),
  }];
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
  citedSegments: [],
  videoSeekEnabled: false,
  videoSourceVersionId: "ver1",
};

const VERIFIED: VerifiedAnswerResolution = {
  kind: "verified",
  optionIndex: 1,  // reviewer picked index 1, NOT the model's 0
  optionText: "Reviewer picked this",
  verifiedByUserId: "user_reviewer_42",
  verifiedByUserName: "Marion Reviewer",
  verifiedAt: new Date("2026-11-05T12:30:00Z"),
  validationId: "v1",
  reviewId: "r1",
};

const UNVERIFIED: VerifiedAnswerResolution = { kind: "unverified" };

const INTEGRITY_WARN: VerifiedAnswerResolution = {
  kind: "integrity-warning",
  code: "SNAPSHOT_HASH_BINDING_STALE",
  safeMessage:
    "The verified-answer snapshot is bound to an earlier version of this question. The current content is unverified.",
};

function renderPage(verifiedAnswer: VerifiedAnswerResolution | null, detailOverrides: Partial<CandidateDetail> = {}) {
  return render(
    <PersistedReviewWorkspace
      queue={queue()}
      selectedDetail={baseDetail(detailOverrides)}
      selectedDraftId="d1"
      clubLabel="Alpha Club"
      totalCount={1}
      nextCursor={null}
      isEmptyQueue={false}
      sourceContext={{
        courseTitle: "Staff Orientation",
        versionTitle: "2026 refresh",
        versionNumber: 2,
        videoStorageKeyPresent: true,
        videoDurationSec: 240,
      }}
      evidence={AUTHENTIC_EV}
      verifiedAnswer={verifiedAnswer}
    />,
  );
}

describe("EP-TRAIN-6D-4N — verified-answer presentation", () => {
  it("UNVERIFIED — every option is stone-neutral; model-selected chip renders; aria-checked all false", () => {
    const { container } = renderPage(UNVERIFIED, { state: "REQUIRES_HUMAN_REVIEW" });
    const bodyText = container.textContent ?? "";
    expect(bodyText).toContain("Model-selected · unverified");
    expect(bodyText).not.toContain("Verified correct");
    const radios = container.querySelectorAll('[role="radio"]');
    for (const r of Array.from(radios)) {
      expect(r.getAttribute("aria-checked")).toBe("false");
      const cls = (r.getAttribute("class") ?? "") + " " +
        Array.from(r.querySelectorAll("*")).map((n) => n.getAttribute("class") ?? "").join(" ");
      expect(cls).not.toMatch(/emerald/);
    }
  });

  it("VERIFIED — the option at verified optionIndex renders emerald with 'Verified correct' + reviewer name", () => {
    const { container } = renderPage(VERIFIED);
    const bodyText = container.textContent ?? "";
    expect(bodyText).toContain("Verified correct");
    expect(bodyText).toContain("Marion Reviewer");
    // Exactly one option is emerald. The model-selected option (index 0)
    // is NOT emerald; the reviewer-picked option (index 1) IS.
    const radios = container.querySelectorAll('[role="radio"]');
    expect(radios.length).toBe(3);
    const radio0 = radios[0] as HTMLElement;
    const radio1 = radios[1] as HTMLElement;
    const radio2 = radios[2] as HTMLElement;
    expect(radio1.getAttribute("aria-checked")).toBe("true");
    expect(radio0.getAttribute("aria-checked")).toBe("false");
    expect(radio2.getAttribute("aria-checked")).toBe("false");
    // Scan subtree classes.
    const cls0 = (radio0.getAttribute("class") ?? "") + Array.from(radio0.querySelectorAll("*")).map((n) => n.getAttribute("class") ?? "").join(" ");
    const cls1 = (radio1.getAttribute("class") ?? "") + Array.from(radio1.querySelectorAll("*")).map((n) => n.getAttribute("class") ?? "").join(" ");
    const cls2 = (radio2.getAttribute("class") ?? "") + Array.from(radio2.querySelectorAll("*")).map((n) => n.getAttribute("class") ?? "").join(" ");
    expect(cls1).toMatch(/emerald/);
    expect(cls0).not.toMatch(/emerald/);
    expect(cls2).not.toMatch(/emerald/);
  });

  it("VERIFIED — disagreement between model and reviewer is visible as a note", () => {
    const { container } = renderPage(VERIFIED);
    const bodyText = container.textContent ?? "";
    expect(bodyText).toContain("the reviewer verified a different answer than the model");
    // Both labels present.
    expect(bodyText).toContain("Model-selected · unverified");
    expect(bodyText).toContain("Verified correct");
  });

  it("INTEGRITY-WARNING — banner renders + options stay neutral", () => {
    const { container } = renderPage(INTEGRITY_WARN);
    const bodyText = container.textContent ?? "";
    expect(bodyText).toContain("Verified-answer integrity warning");
    expect(bodyText).toContain(INTEGRITY_WARN.kind === "integrity-warning" ? INTEGRITY_WARN.safeMessage : "");
    expect(bodyText).toContain("SNAPSHOT_HASH_BINDING_STALE");
    // Neutral options — zero emerald.
    const radios = container.querySelectorAll('[role="radio"]');
    for (const r of Array.from(radios)) {
      expect(r.getAttribute("aria-checked")).toBe("false");
      const cls = (r.getAttribute("class") ?? "") + " " +
        Array.from(r.querySelectorAll("*")).map((n) => n.getAttribute("class") ?? "").join(" ");
      expect(cls).not.toMatch(/emerald/);
    }
    expect(bodyText).toContain("Model-selected · unverified");
    expect(bodyText).not.toContain("Verified correct · ");
  });

  it("No approve/reject/edit/publish buttons are enabled anywhere on the page", () => {
    const { container } = renderPage(VERIFIED);
    const buttons = container.querySelectorAll("button");
    const mutationRe = /approve|reject|edit|revalidate|regenerate|publish|assign/i;
    for (const b of Array.from(buttons)) {
      const label = (b.textContent ?? "").trim();
      if (!mutationRe.test(label)) continue;
      expect(b.hasAttribute("disabled")).toBe(true);
    }
  });

  it("Three-column layout preserved regardless of verifiedAnswer kind", () => {
    const { container } = renderPage(VERIFIED);
    expect(container.querySelector('[aria-label="Review queue"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Question detail"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Source evidence"]')).not.toBeNull();
  });
});

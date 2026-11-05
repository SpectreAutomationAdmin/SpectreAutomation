// @vitest-environment jsdom
//
// EP-TRAIN-6D-4P — ApprovalDialog interaction contract.
//
// Covers directive §§ 3, 5, 6, 7:
//   - No preselection of the model's prediction.
//   - Approve button disabled until (answer selected && attestation).
//   - Idempotency key is generated on open and reused on retry.
//   - Submit sends the exact 4N request contract (not client-authored
//     answer text).
//   - Response dispatch: 200 closes + fires onApproved; 409/400/503
//     render inline error WITHOUT marking the candidate approved;
//     network failure renders an inline retry message.
//   - Duplicate rapid submit is prevented (fetch called once).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import ApprovalDialog from "@/components/ai-training/ApprovalDialog";
import type { CandidateDetail } from "@/lib/hr/training/ai-review/read-service";

afterEach(() => cleanup());

const CONTENT_HASH = "a".repeat(64);
const VALIDATION_ID = "ver_a1_v1";

function detail(overrides: Partial<CandidateDetail> = {}): CandidateDetail {
  return {
    draftId: "draft_123",
    clubId: "club1",
    courseId: "crs1",
    courseVersionId: "ver1",
    state: "REQUIRES_HUMAN_REVIEW",
    contentHash: CONTENT_HASH,
    recordVersion: 3,
    generatedAt: new Date("2026-11-04T00:00:00Z"),
    updatedAt: new Date("2026-11-05T00:00:00Z"),
    draft: {
      questionType: "SINGLE_CHOICE",
      questionText: "Which of these is the policy?",
      options: [
        { text: "Model picked this", isCorrect: true },
        { text: "Reviewer should pick this", isCorrect: false },
        { text: "Distractor", isCorrect: false },
      ],
      explanation: "explanation",
      sourceSegmentIds: [0, 1],
    },
    sourceVideoSha256: "v".repeat(64),
    resolvedTranscriptBuildId: "t".repeat(64),
    groundingProjectionSha256: "p".repeat(64),
    latestValidation: {
      id: VALIDATION_ID,
      draftContentHash: CONTENT_HASH,
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

const FIXED_UUID = "01234567-89ab-4cde-8f01-23456789abcd";

function renderDialog(overrides: Partial<Parameters<typeof ApprovalDialog>[0]> = {}) {
  const fetchImpl = overrides.fetchImpl ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  const onApproved = overrides.onApproved ?? vi.fn();
  const result = render(
    <ApprovalDialog
      open={true}
      detail={detail()}
      reviewerUserId="user_reviewer_42"
      reviewerDisplayName="Marion Reviewer"
      onClose={onClose}
      onApproved={onApproved}
      fetchImpl={fetchImpl as typeof fetch}
      makeUuid={() => FIXED_UUID}
      {...overrides}
    />,
  );
  return { ...result, fetchImpl, onClose, onApproved };
}

describe("EP-TRAIN-6D-4P — ApprovalDialog", () => {
  it("renders the immutable question verbatim", () => {
    renderDialog();
    expect(screen.getByText("Which of these is the policy?")).toBeDefined();
  });

  it("no answer is preselected on open", () => {
    renderDialog();
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBe(3);
    for (const r of radios) {
      expect((r as HTMLInputElement).checked).toBe(false);
    }
  });

  it("surfaces the model-selected option with the 'Model-selected · unverified' chip", () => {
    renderDialog();
    expect(screen.getByText("Model-selected · unverified")).toBeDefined();
  });

  it("approve button is disabled until both answer selected AND attestation checked", () => {
    renderDialog();
    const approveBtn = screen.getByRole("button", { name: /approve candidate/i }) as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(true);

    // Select an answer only.
    const radios = screen.getAllByRole("radio");
    fireEvent.click(radios[1]);
    expect(approveBtn.disabled).toBe(true);

    // Check attestation.
    const attestation = screen.getByRole("checkbox") as HTMLInputElement;
    fireEvent.click(attestation);
    expect(approveBtn.disabled).toBe(false);
  });

  it("approve POST payload matches the 4N request contract exactly", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        ok: true,
        draftId: "draft_123",
        reviewId: "r1",
        validationId: VALIDATION_ID,
        transitionId: "t1",
        recordVersionAfter: 4,
        state: "APPROVED_DRAFT",
        verifiedCorrectAnswer: {
          optionIndex: 1,
          optionText: "Reviewer should pick this",
          verifiedByUserId: "user_reviewer_42",
          verifiedAt: "2026-11-05T00:00:00Z",
        },
        replay: false,
      }),
    });

    const onClose = vi.fn();
    const onApproved = vi.fn();

    renderDialog({ fetchImpl: fetchImpl as unknown as typeof fetch, onClose, onApproved });

    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /approve candidate/i }));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/admin/ai-training/drafts/draft_123/approve");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      expectedRecordVersion: 3,
      expectedContentHash: CONTENT_HASH,
      expectedValidationId: VALIDATION_ID,
      verifiedCorrectAnswerIndex: 1,
      expectedOptionText: "Reviewer should pick this",
      evidenceAttestation: true,
      idempotencyKey: FIXED_UUID,
    });
    expect(body.reviewerNote).toBeUndefined();

    await waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("rapid double-click submits once (duplicate submit prevented)", async () => {
    let resolveFn: (value: unknown) => void = () => {};
    const pending = new Promise((r) => {
      resolveFn = r;
    });
    const fetchImpl = vi.fn().mockReturnValue(pending);

    renderDialog({ fetchImpl: fetchImpl as unknown as typeof fetch });

    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("checkbox"));
    const btn = screen.getByRole("button", { name: /approve candidate|approving/i });

    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFn({ status: 200, json: async () => ({ ok: true, replay: false }) });
  });

  it("409 APPROVAL_GUARD_BLOCKED renders inline error without calling onApproved", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 409,
      json: async () => ({
        error: "approval_rejected",
        rejectionCode: "APPROVAL_GUARD_BLOCKED",
        message: "server-side guard rejection",
      }),
    });
    const onApproved = vi.fn();
    const onClose = vi.fn();

    renderDialog({ fetchImpl: fetchImpl as unknown as typeof fetch, onApproved, onClose });

    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /approve candidate/i }));

    await waitFor(() => {
      expect(screen.getByTestId("approval-dialog-error")).toBeDefined();
    });
    expect(onApproved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("approval-dialog-error").textContent).toMatch(/no longer approvable|refresh and review/i);
  });

  it("409 IDEMPOTENCY_CONFLICT renders a distinct explanation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 409,
      json: async () => ({ error: "approval_rejected", rejectionCode: "IDEMPOTENCY_CONFLICT" }),
    });

    renderDialog({ fetchImpl: fetchImpl as unknown as typeof fetch });

    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /approve candidate/i }));

    await waitFor(() => {
      expect(screen.getByTestId("approval-dialog-error").textContent).toMatch(/regenerate the key|different payload/i);
    });
  });

  it("503 renders validation service unavailable copy", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 503,
      json: async () => ({ error: "unavailable" }),
    });
    renderDialog({ fetchImpl: fetchImpl as unknown as typeof fetch });
    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /approve candidate/i }));
    await waitFor(() => {
      expect(screen.getByTestId("approval-dialog-error").textContent).toMatch(/unavailable/i);
    });
  });

  it("404 (missing or cross-tenant) renders a safe generic message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 404,
      json: async () => ({ error: "not_found" }),
    });
    renderDialog({ fetchImpl: fetchImpl as unknown as typeof fetch });
    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /approve candidate/i }));
    await waitFor(() => {
      expect(screen.getByTestId("approval-dialog-error").textContent).toMatch(/cannot be approved/i);
    });
  });

  it("network failure renders a retry-friendly message and leaves dialog open", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const onApproved = vi.fn();
    const onClose = vi.fn();
    renderDialog({ fetchImpl: fetchImpl as unknown as typeof fetch, onApproved, onClose });
    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /approve candidate/i }));
    await waitFor(() => {
      expect(screen.getByTestId("approval-dialog-error").textContent).toMatch(/could not reach the server|retry/i);
    });
    expect(onApproved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("retry after a network failure reuses the same idempotency key", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          ok: true,
          draftId: "draft_123",
          reviewId: "r1",
          validationId: VALIDATION_ID,
          transitionId: "t1",
          recordVersionAfter: 4,
          state: "APPROVED_DRAFT",
          verifiedCorrectAnswer: {
            optionIndex: 1,
            optionText: "Reviewer should pick this",
            verifiedByUserId: "u1",
            verifiedAt: "2026-11-05T00:00:00Z",
          },
          replay: false,
        }),
      });

    renderDialog({ fetchImpl: fetchImpl as unknown as typeof fetch });

    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /approve candidate/i }));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    // Second click after failure — same idempotency key.
    await waitFor(() => screen.getByTestId("approval-dialog-error"));
    fireEvent.click(screen.getByRole("button", { name: /approve candidate/i }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    const body1 = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const body2 = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body1.idempotencyKey).toBe(body2.idempotencyKey);
    expect(body1.idempotencyKey).toBe(FIXED_UUID);
  });

  it("regenerating the idempotency key produces a new key on the next submit", async () => {
    let calls = 0;
    const makeUuid = () => {
      calls += 1;
      return `0000000${calls}-89ab-4cde-8f01-23456789abcd`;
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 409,
      json: async () => ({ rejectionCode: "IDEMPOTENCY_CONFLICT" }),
    });

    renderDialog({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      makeUuid,
    });

    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /approve candidate/i }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /regenerate idempotency key/i }));
    fireEvent.click(screen.getByRole("button", { name: /approve candidate/i }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    const body1 = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const body2 = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body1.idempotencyKey).not.toBe(body2.idempotencyKey);
  });

  it("dialog is not rendered when open=false", () => {
    render(
      <ApprovalDialog
        open={false}
        detail={detail()}
        reviewerUserId="u1"
        reviewerDisplayName="r"
        onClose={() => {}}
        onApproved={() => {}}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("escape key closes the dialog", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the submitted body NEVER carries a client-authored authoritative answer text field like 'verifiedAnswerText'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        ok: true,
        draftId: "draft_123",
        reviewId: "r1",
        validationId: VALIDATION_ID,
        transitionId: "t1",
        recordVersionAfter: 4,
        state: "APPROVED_DRAFT",
        verifiedCorrectAnswer: {
          optionIndex: 1,
          optionText: "Reviewer should pick this",
          verifiedByUserId: "u1",
          verifiedAt: "2026-11-05T00:00:00Z",
        },
        replay: false,
      }),
    });
    renderDialog({ fetchImpl: fetchImpl as unknown as typeof fetch });
    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /approve candidate/i }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    // Allowed server-contract fields only.
    const allowed = new Set([
      "expectedRecordVersion",
      "expectedContentHash",
      "expectedValidationId",
      "verifiedCorrectAnswerIndex",
      "expectedOptionText",
      "evidenceAttestation",
      "idempotencyKey",
      "reviewerNote",
    ]);
    for (const key of Object.keys(body)) {
      expect(allowed.has(key)).toBe(true);
    }
    // Confirm no field with "answerText" in the key.
    for (const key of Object.keys(body)) {
      expect(/answerText/i.test(key) && key !== "expectedOptionText").toBe(false);
    }
  });
});

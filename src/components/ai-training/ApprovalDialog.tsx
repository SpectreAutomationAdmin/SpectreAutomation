"use client";

// EP-TRAIN-6D-4P (2026-11-05) — Approval dialog for authorized reviewers.
//
// The dialog is a presentation + interaction layer. The server is the
// authority for approval eligibility; this component merely:
//   1. displays the exact immutable question + options the server
//      resolved (never re-derived from a mutable client cache);
//   2. requires the reviewer to independently select the verified
//      correct answer (no preselection of the model's prediction);
//   3. requires an explicit "I have reviewed the source evidence"
//      attestation checkbox;
//   4. generates a UUID-v4 idempotency key on open (regeneratable);
//   5. submits the exact 4N request contract to the already-accepted
//      `POST /api/admin/ai-training/drafts/[id]/approve` endpoint;
//   6. renders every 4N response code visibly; a failure NEVER
//      visually marks the candidate as approved.
//
// After a successful approval the dialog closes and calls
// `onApproved()` so the parent can trigger a fresh server read
// (`router.refresh()`). The authoritative emerald "Verified correct"
// chip comes from the server-side 4N verified-answer reader on the
// NEXT page render — NOT from local state here.

import { useEffect, useId, useRef, useState } from "react";
import type { CandidateDetail } from "@/lib/hr/training/ai-review/read-service";

const FOCUS_RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-stone-600";

/** The dialog is mounted by the workspace; opening is parent-controlled. */
export interface ApprovalDialogProps {
  readonly open: boolean;
  readonly detail: CandidateDetail;
  readonly reviewerUserId: string;
  readonly reviewerDisplayName: string;
  readonly onClose: () => void;
  /** Called after a successful 200 response (replay or first-time). */
  readonly onApproved: () => void;
  /** Injection seam for unit tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injection seam for unit tests. Defaults to `crypto.randomUUID`. */
  readonly makeUuid?: () => string;
}

interface SuccessResponse {
  readonly ok: true;
  readonly draftId: string;
  readonly reviewId: string;
  readonly validationId: string;
  readonly transitionId: string;
  readonly recordVersionAfter: number;
  readonly state: "APPROVED_DRAFT";
  readonly verifiedCorrectAnswer: {
    readonly optionIndex: number;
    readonly optionText: string;
    readonly verifiedByUserId: string;
    readonly verifiedAt: string;
  };
  readonly replay: boolean;
}

interface RejectedResponse {
  readonly error: string;
  readonly rejectionCode?: string;
  readonly message?: string;
  readonly detail?: Record<string, unknown>;
}

type InlineErrorKind =
  | "SELECT_ANSWER"
  | "CONFIRM_ATTESTATION"
  | "SERVER_REJECTED"
  | "NETWORK";

interface InlineError {
  readonly kind: InlineErrorKind;
  readonly message: string;
  readonly detail?: string;
}

const REJECTION_MESSAGES: Readonly<Record<string, string>> = {
  VERIFIED_ANSWER_MISSING:
    "Select a verified correct answer before approving.",
  VERIFIED_ANSWER_OUT_OF_RANGE:
    "The selected answer index is no longer valid. Refresh and try again.",
  VERIFIED_ANSWER_TEXT_MISMATCH:
    "The displayed option text no longer matches what the server has stored. Refresh and try again.",
  QUESTION_TYPE_INVALID:
    "This question type is not supported for approval.",
  ANSWER_CARDINALITY_INVALID:
    "Multi-answer approval is not supported in this slice.",
  VALIDATION_MISMATCH:
    "The validation record does not match this candidate. Refresh and review again.",
  EVIDENCE_ATTESTATION_MISSING:
    "The source-evidence attestation is required.",
  IDEMPOTENCY_CONFLICT:
    "An earlier approval used this request's key with a different payload. Regenerate the key, or refresh the page.",
  APPROVAL_GUARD_BLOCKED:
    "The candidate is no longer approvable. Refresh and review again.",
  TRANSITION_BLOCKED:
    "Another reviewer may have already acted on this candidate. Refresh and review again.",
};

function defaultMakeUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Legacy-browser fallback (RFC 4122 v4).
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default function ApprovalDialog(props: ApprovalDialogProps) {
  const {
    open,
    detail,
    reviewerDisplayName,
    onClose,
    onApproved,
    fetchImpl,
    makeUuid,
  } = props;

  const fetchFn = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const uuidFn = makeUuid ?? defaultMakeUuid;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFocusRef = useRef<HTMLInputElement | null>(null);
  const submittingRef = useRef<boolean>(false);

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [attestation, setAttestation] = useState<boolean>(false);
  const [reviewerNote, setReviewerNote] = useState<string>("");
  const [idempotencyKey, setIdempotencyKey] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [inlineError, setInlineError] = useState<InlineError | null>(null);

  const titleId = useId();
  const descriptionId = useId();
  const noteId = useId();
  const attestationId = useId();

  // Generate (or regenerate on reopen) the idempotency key every time
  // the dialog transitions from closed → open. Reopening after a close
  // intentionally produces a NEW key, which matches the reviewer's
  // mental model ("I'm starting a fresh approval decision").
  useEffect(() => {
    if (open) {
      setIdempotencyKey(uuidFn());
      setSelectedIndex(null);
      setAttestation(false);
      setReviewerNote("");
      setInlineError(null);
      // Focus the first radio for keyboard users after render.
      const t = setTimeout(() => {
        firstFocusRef.current?.focus();
      }, 0);
      return () => clearTimeout(t);
    }
  }, [open, uuidFn]);

  // Escape handling — close without submitting.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!submittingRef.current) onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const options = detail.draft.options;
  const modelSelectedIndex = options.findIndex((o) => o.isCorrect);
  const latestValidation = detail.latestValidation;

  const canSubmit =
    selectedIndex !== null &&
    attestation &&
    latestValidation !== null &&
    !submitting;

  const regenerateKey = () => {
    if (submitting) return;
    setIdempotencyKey(uuidFn());
    setInlineError(null);
  };

  const handleSubmit = async () => {
    setInlineError(null);
    if (submittingRef.current) return;

    if (selectedIndex === null) {
      setInlineError({
        kind: "SELECT_ANSWER",
        message: "Select the verified correct answer to continue.",
      });
      return;
    }
    if (!attestation) {
      setInlineError({
        kind: "CONFIRM_ATTESTATION",
        message:
          "Confirm you have reviewed the source evidence before approving.",
      });
      return;
    }
    if (!latestValidation) {
      setInlineError({
        kind: "SERVER_REJECTED",
        message:
          "This candidate has no validation to bind an approval to. Refresh and try again.",
      });
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);

    const payload = {
      expectedRecordVersion: detail.recordVersion,
      expectedContentHash: detail.contentHash,
      expectedValidationId: latestValidation.id,
      verifiedCorrectAnswerIndex: selectedIndex,
      expectedOptionText: options[selectedIndex]?.text ?? "",
      evidenceAttestation: true as const,
      idempotencyKey,
      reviewerNote: reviewerNote.trim().length > 0 ? reviewerNote.trim() : undefined,
    };

    try {
      const res = await fetchFn(
        `/api/admin/ai-training/drafts/${encodeURIComponent(detail.draftId)}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      if (res.status === 200) {
        // Parse but don't trust it for rendering — the authoritative
        // "Verified correct" chip comes from the next server read.
        const body = (await res.json()) as SuccessResponse;
        void body; // reference to silence unused var guard
        onApproved();
        onClose();
        return;
      }

      let body: RejectedResponse | null = null;
      try {
        body = (await res.json()) as RejectedResponse;
      } catch {
        body = null;
      }

      if (res.status === 401) {
        setInlineError({
          kind: "SERVER_REJECTED",
          message:
            "Your session has expired. Please sign in again and retry.",
        });
      } else if (res.status === 404) {
        setInlineError({
          kind: "SERVER_REJECTED",
          message:
            "This candidate cannot be approved from this account.",
        });
      } else if (res.status === 503) {
        setInlineError({
          kind: "SERVER_REJECTED",
          message:
            "The validation service is unavailable. Try again shortly.",
        });
      } else if (body?.rejectionCode && REJECTION_MESSAGES[body.rejectionCode]) {
        setInlineError({
          kind: "SERVER_REJECTED",
          message: REJECTION_MESSAGES[body.rejectionCode],
          detail: body.rejectionCode,
        });
      } else {
        setInlineError({
          kind: "SERVER_REJECTED",
          message:
            body?.message ??
            `The server refused the approval (HTTP ${res.status}).`,
          detail: body?.rejectionCode ?? body?.error ?? undefined,
        });
      }
    } catch (err) {
      setInlineError({
        kind: "NETWORK",
        message:
          "Could not reach the server. Check your connection and retry; the same request will be replayed safely.",
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-900/40 px-4 py-10"
      role="presentation"
      onClick={(e) => {
        // Backdrop click closes the dialog unless submitting.
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative w-full max-w-2xl rounded-lg bg-white shadow-2xl border border-stone-200"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-stone-200 flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500">
              AI-assisted training · manager review
            </div>
            <h2 id={titleId} className="mt-1 font-serif text-xl text-stone-900">
              Approve candidate
            </h2>
          </div>
          <button
            type="button"
            onClick={() => (submitting ? undefined : onClose())}
            aria-label="Close approval dialog"
            disabled={submitting}
            className={`-m-2 p-2 text-stone-500 hover:text-stone-900 ${FOCUS_RING} rounded disabled:opacity-40`}
          >
            <span aria-hidden className="text-xl leading-none">×</span>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          <div
            id={descriptionId}
            className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[12px] text-sky-900 leading-snug"
          >
            <span className="font-semibold uppercase tracking-widest text-[10px]">
              Reviewer attestation
            </span>
            <p className="mt-1">
              Approving this candidate records your verified answer
              selection and promotes the draft to <strong>APPROVED_DRAFT</strong>.
              The action is auditable. It does not publish the question or
              assign it to employees — those remain separately-authorised steps.
            </p>
          </div>

          {/* Immutable question */}
          <div>
            <div className="text-[11px] uppercase tracking-widest text-stone-500 mb-1">
              Question
            </div>
            <p className="text-stone-900 text-[15px] leading-relaxed font-serif">
              {detail.draft.questionText}
            </p>
          </div>

          {/* Answer selection */}
          <fieldset>
            <legend className="text-[11px] uppercase tracking-widest text-stone-500 mb-2">
              Choose the verified correct answer
            </legend>
            <p className="text-[12px] text-stone-600 mb-2 leading-snug">
              No answer is preselected. Pick the choice you have verified
              against the source evidence — this is independent of the
              model&rsquo;s prediction.
            </p>
            <ol className="space-y-2" role="radiogroup" aria-labelledby={titleId}>
              {options.map((o, i) => {
                const isModelSelected = i === modelSelectedIndex;
                const isSelected = selectedIndex === i;
                return (
                  <li key={i}>
                    <label
                      className={`flex items-start gap-3 rounded-md border px-3 py-2.5 cursor-pointer transition-colors ${
                        isSelected
                          ? "bg-emerald-50/70 border-emerald-300"
                          : "bg-stone-50 border-stone-200 hover:bg-stone-100"
                      }`}
                    >
                      <input
                        ref={i === 0 ? firstFocusRef : null}
                        type="radio"
                        name="verified-answer"
                        value={i}
                        checked={isSelected}
                        onChange={() => {
                          setSelectedIndex(i);
                          setInlineError(null);
                        }}
                        className={`mt-1 h-4 w-4 ${FOCUS_RING}`}
                        aria-describedby={isModelSelected ? `${titleId}-model-${i}` : undefined}
                      />
                      <span className="flex-1">
                        <span className="text-stone-900 text-[14px] leading-relaxed">
                          <span className="font-semibold mr-2">
                            {String.fromCharCode(65 + i)}.
                          </span>
                          {o.text}
                        </span>
                        {isModelSelected && (
                          <span
                            id={`${titleId}-model-${i}`}
                            className="ml-2 inline-block text-[10px] uppercase tracking-widest text-stone-500 rounded-full bg-stone-200 px-2 py-0.5"
                          >
                            Model-selected · unverified
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ol>
          </fieldset>

          {/* Attestation */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              id={attestationId}
              type="checkbox"
              checked={attestation}
              onChange={(e) => {
                setAttestation(e.target.checked);
                setInlineError(null);
              }}
              className={`mt-1 h-4 w-4 ${FOCUS_RING}`}
            />
            <span className="text-[13px] text-stone-800 leading-snug">
              <strong>I have reviewed the source evidence</strong> and I am
              independently verifying this answer.
              <span className="block text-[11px] text-stone-500 mt-0.5">
                Required. The server refuses the approval if this attestation
                is not submitted.
              </span>
            </span>
          </label>

          {/* Reviewer note */}
          <div>
            <label
              htmlFor={noteId}
              className="block text-[11px] uppercase tracking-widest text-stone-500 mb-1"
            >
              Reviewer note (optional)
            </label>
            <textarea
              id={noteId}
              value={reviewerNote}
              onChange={(e) => setReviewerNote(e.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="Context, caveats, or references."
              className={`w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-[13px] text-stone-900 leading-relaxed ${FOCUS_RING}`}
            />
            <div className="mt-1 text-[10px] text-stone-400 tabular-nums">
              {reviewerNote.length} / 2000
            </div>
          </div>

          {/* Request fingerprint — transparent provenance */}
          <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[11px] text-stone-600 leading-snug">
            <div className="uppercase tracking-widest text-[10px] text-stone-500">
              Request fingerprint
            </div>
            <div className="mt-0.5 font-mono">
              draft v{detail.recordVersion} · hash{" "}
              <span title={detail.contentHash}>
                {detail.contentHash.slice(0, 10)}…
              </span>
              {latestValidation ? (
                <>
                  {" · "}validation{" "}
                  <span title={latestValidation.id}>
                    {latestValidation.id.slice(0, 10)}…
                  </span>
                </>
              ) : (
                <> · <span className="text-rose-700">no validation bound</span></>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="uppercase tracking-widest text-[10px] text-stone-500">
                Idempotency key
              </span>
              <span className="font-mono" title={idempotencyKey}>
                {idempotencyKey.slice(0, 8)}…
              </span>
              <button
                type="button"
                onClick={regenerateKey}
                disabled={submitting}
                className={`text-[10px] uppercase tracking-widest text-stone-600 hover:text-stone-900 ${FOCUS_RING} rounded px-1.5 py-0.5 disabled:opacity-40`}
                aria-label="Regenerate idempotency key"
              >
                ↻ regenerate
              </button>
            </div>
          </div>

          {/* Inline error */}
          {inlineError && (
            <div
              role="alert"
              className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-[12px] text-rose-900 leading-snug"
              data-testid="approval-dialog-error"
            >
              <div className="font-semibold uppercase tracking-widest text-[10px] text-rose-800">
                Approval could not be submitted
              </div>
              <p className="mt-1">{inlineError.message}</p>
              {inlineError.detail && (
                <div className="mt-1 font-mono text-[10px] text-rose-700">
                  {inlineError.detail}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-stone-200 flex items-center justify-between gap-3 bg-stone-50 rounded-b-lg">
          <div className="text-[11px] text-stone-500 italic">
            Reviewer: {reviewerDisplayName}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => (submitting ? undefined : onClose())}
              disabled={submitting}
              className={`rounded-md border border-stone-300 bg-white px-4 py-2 text-[13px] text-stone-800 hover:bg-stone-100 ${FOCUS_RING} disabled:opacity-40`}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              aria-disabled={!canSubmit}
              className={`rounded-md bg-emerald-700 hover:bg-emerald-800 disabled:bg-stone-300 disabled:text-stone-500 text-white px-4 py-2 text-[13px] font-medium ${FOCUS_RING}`}
            >
              {submitting ? "Approving…" : "Approve candidate"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

// EP-TRAIN-4Y-S §5+§6+§7+§8 — Manager Review client component.
//
// Two-column desktop layout:
//   Left  — editable title/description, video player, checkpoint-time
//           markers (clickable), mode switcher (Checkpoints | Final).
//   Right — one question at a time: text, options, correct marker,
//           status pill, Accept / Discard / Prev / Next.
//
// Mutations:
//   Accept  → POST /approve (reviewer only; founder sees a disabled
//             tooltip) OR POST /promote (founder, once draft already
//             in APPROVED_DRAFT state).
//   Discard → POST /reject (reviewer OR founder; records reason).
//
// Edits are deferred to a future slice. For now, Edit links back to
// the full editor; the Accept / Discard / Prev / Next loop covers the
// founder's priority — getting from AI output to a reviewed course
// without exposing the pipeline.

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Checkpoint {
  id: string;
  title: string;
  atSecond: number;
}

interface Draft {
  id: string;
  state: string;
  questionText: string;
  questionType: string;
  options: { optionText: string; isCorrect: boolean }[];
  sourceSegmentIds: number[];
  correctOptionIndex: number;
  isPromoted: boolean;
}

interface PublishConfig {
  passingScore: number;
  retakesAllowed: boolean;
  required: boolean;
  requiresKnowledgeTest: boolean;
  audience: {
    kind: "everyone" | "scoped" | "explicit";
    deptCount: number;
    positionCount: number;
  };
  versionState: string;
  readinessReady: boolean;
  readinessReasons: string[];
}

interface Props {
  versionId: string;
  courseId: string;
  courseTitle: string;
  courseDescription: string;
  videoStorageKey: string | null;
  videoDurationSec: number | null;
  videoUrl: string | null;
  drafts: Draft[];
  checkpoints: Checkpoint[];
  canApprove: boolean;
  canAuthor: boolean;
  canPublish: boolean;
  publishConfig: PublishConfig;
}

function uuidV4(): string {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function formatTime(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function statusLabel(state: string, isPromoted: boolean): {
  label: string;
  tone: "amber" | "green" | "red" | "stone";
} {
  if (isPromoted) return { label: "Approved", tone: "green" };
  if (state === "APPROVED_DRAFT") return { label: "Awaiting promotion", tone: "amber" };
  if (state === "REJECTED") return { label: "Discarded", tone: "red" };
  if (state === "REQUIRES_HUMAN_REVIEW") return { label: "Needs review", tone: "amber" };
  if (state === "VALIDATION_PENDING") return { label: "Preparing", tone: "stone" };
  if (state === "GENERATED") return { label: "Preparing", tone: "stone" };
  return { label: state, tone: "stone" };
}

export default function ManagerReviewClient(props: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"checkpoints" | "final">(
    props.checkpoints.length > 0 ? "checkpoints" : "final",
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [editableTitle, setEditableTitle] = useState(props.courseTitle);
  const [editableDescription, setEditableDescription] = useState(props.courseDescription);
  const [titleSaveState, setTitleSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // For now, drafts aren't partitioned by checkpoint-vs-final at the
  // row level — the API distinguishes by `promotedCheckpointId` after
  // promotion. During review, treat ALL un-promoted drafts as part of
  // the active mode (manager accepts; promotion-destination is the
  // promote call's responsibility — defaults to FINAL_ASSESSMENT if
  // unspecified; checkpoint assignment is a follow-up).
  const activeDrafts = useMemo(() => props.drafts, [props.drafts]);

  const current = activeDrafts[currentIndex] ?? null;
  const totalInMode = activeDrafts.length;

  const saveTitle = useCallback(async () => {
    setTitleSaveState("saving");
    try {
      const form = new FormData();
      form.set("title", editableTitle);
      form.set("description", editableDescription);
      const resp = await fetch(
        `/api/admin/training/versions/${props.versionId}/draft-metadata`,
        { method: "PATCH", body: form },
      );
      if (!resp.ok) throw new Error(`metadata save failed (${resp.status})`);
      setTitleSaveState("saved");
      setTimeout(() => setTitleSaveState("idle"), 1500);
    } catch (_err) {
      setTitleSaveState("error");
    }
  }, [editableTitle, editableDescription, props.versionId]);

  const handleAccept = useCallback(async () => {
    if (!current || pendingBusy) return;
    setPendingBusy(true);
    setLastError(null);
    try {
      // Always pull fresh state right before action — approve expects
      // the expected-contract fields to match the current DB row.
      const stateResp = await fetch(
        `/api/admin/ai-training/drafts/${current.id}/state`,
        { cache: "no-store" },
      );
      const stateBody = await stateResp.json();
      if (!stateResp.ok) throw new Error("Could not read draft state.");
      // Reviewer path: approve.
      if (props.canApprove && stateBody.state === "REQUIRES_HUMAN_REVIEW") {
        const resp = await fetch(
          `/api/admin/ai-training/drafts/${current.id}/approve`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              expectedRecordVersion: stateBody.recordVersion,
              expectedContentHash: stateBody.contentHash,
              expectedValidationId: stateBody.latestValidationId,
              verifiedCorrectAnswerIndex: stateBody.correctOptionIndex,
              expectedOptionText: stateBody.correctOptionText,
              evidenceAttestation: true,
              idempotencyKey: uuidV4(),
              reviewerNote: "Manager review — accepted via unified review surface.",
            }),
          },
        );
        if (!resp.ok) {
          const b = await resp.json().catch(() => ({}));
          throw new Error(b?.message ?? `Approve failed (${resp.status}).`);
        }
      } else if (props.canAuthor && stateBody.state === "APPROVED_DRAFT") {
        // Founder path: promote an already-approved draft.
        const resp = await fetch(
          `/api/admin/ai-training/drafts/${current.id}/promote`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              destination: { kind: "FINAL_ASSESSMENT" },
              expectedDraftContentHash: stateBody.contentHash,
              expectedValidationId: stateBody.latestValidationId,
            }),
          },
        );
        if (!resp.ok) {
          const b = await resp.json().catch(() => ({}));
          throw new Error(b?.message ?? `Promote failed (${resp.status}).`);
        }
      } else if (stateBody.state === "APPROVED_DRAFT" && !props.canAuthor) {
        throw new Error("This draft is awaiting manager promotion.");
      } else {
        throw new Error(`Draft is in state ${stateBody.state}; no action available here.`);
      }
      // Refresh — server-rendered page will reflect the new state.
      router.refresh();
    } catch (err) {
      setLastError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setPendingBusy(false);
    }
  }, [current, pendingBusy, props.canApprove, props.canAuthor, router]);

  const handleDiscard = useCallback(async () => {
    if (!current || pendingBusy) return;
    if (!window.confirm("Discard this question? This can't be undone.")) return;
    setPendingBusy(true);
    setLastError(null);
    try {
      const stateResp = await fetch(
        `/api/admin/ai-training/drafts/${current.id}/state`,
        { cache: "no-store" },
      );
      const stateBody = await stateResp.json();
      const resp = await fetch(
        `/api/admin/ai-training/drafts/${current.id}/reject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedRecordVersion: stateBody.recordVersion,
            reason: "DISCARDED_BY_MANAGER",
          }),
        },
      );
      if (!resp.ok) {
        const b = await resp.json().catch(() => ({}));
        throw new Error(b?.message ?? `Discard failed (${resp.status}).`);
      }
      router.refresh();
    } catch (err) {
      setLastError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setPendingBusy(false);
    }
  }, [current, pendingBusy, router]);

  const seekToCheckpoint = useCallback((atSecond: number) => {
    if (videoRef.current) videoRef.current.currentTime = atSecond;
  }, []);

  if (!props.videoUrl && props.drafts.length === 0) {
    return (
      <div className="card card-body text-sm text-stone-500" data-testid="manager-review-empty">
        No video uploaded yet. <a href={`/app/admin/people/safety-training/${props.courseId}/${props.versionId}`} className="text-club-green hover:underline">Upload one here →</a>
      </div>
    );
  }

  const status = current ? statusLabel(current.state, current.isPromoted) : null;
  const toneClass =
    status?.tone === "green"
      ? "bg-green-100 text-green-800"
      : status?.tone === "amber"
        ? "bg-amber-100 text-amber-800"
        : status?.tone === "red"
          ? "bg-red-100 text-red-800"
          : "bg-stone-100 text-stone-700";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6">
      {/* ── Left column: title / description / video / timeline ── */}
      <div className="space-y-4" data-testid="manager-review-left">
        <section className="card card-body">
          <label className="label" htmlFor="course-title">Course title</label>
          <input
            id="course-title"
            className="input"
            value={editableTitle}
            onChange={(e) => setEditableTitle(e.target.value)}
            onBlur={saveTitle}
            data-testid="manager-review-title"
          />
          <label className="label mt-3" htmlFor="course-description">Description</label>
          <textarea
            id="course-description"
            className="input"
            rows={3}
            value={editableDescription}
            onChange={(e) => setEditableDescription(e.target.value)}
            onBlur={saveTitle}
            data-testid="manager-review-description"
          />
          <div className="mt-2 text-xs text-stone-500" aria-live="polite">
            {titleSaveState === "saving" && "Saving…"}
            {titleSaveState === "saved" && "Saved."}
            {titleSaveState === "error" && "Couldn't save — try again."}
          </div>
        </section>

        <section className="card card-body">
          {props.videoUrl ? (
            <video
              ref={videoRef}
              src={props.videoUrl}
              controls
              preload="metadata"
              className="w-full rounded-md bg-black"
              data-testid="manager-review-video"
            />
          ) : (
            <div className="rounded-md bg-stone-100 p-8 text-center text-sm text-stone-500">
              No video uploaded yet.
            </div>
          )}
          <div className="mt-3 text-xs text-stone-500">
            Duration: {formatTime(props.videoDurationSec)}
          </div>
        </section>

        <section className="card card-body">
          <h3 className="section-title text-sm">Checkpoints ({props.checkpoints.length})</h3>
          {props.checkpoints.length === 0 ? (
            <p className="text-xs text-stone-500 mt-2">
              AI-proposed checkpoints will appear here once preparation completes.
            </p>
          ) : (
            <ul className="mt-2 space-y-1" data-testid="manager-review-timeline-markers">
              {props.checkpoints.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="w-full text-left text-sm px-2 py-1 rounded hover:bg-stone-50"
                    onClick={() => seekToCheckpoint(c.atSecond)}
                    data-testid={`manager-review-timeline-marker-${c.id}`}
                  >
                    <span className="text-stone-500 font-mono text-xs">{formatTime(c.atSecond)}</span>
                    <span className="ml-2">{c.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ── Right column: one question at a time ── */}
      <div className="space-y-4" data-testid="manager-review-right">
        <div className="flex items-center gap-2 text-sm">
          <button
            type="button"
            className={`btn btn-sm ${mode === "checkpoints" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setMode("checkpoints")}
            data-testid="manager-review-mode-checkpoints"
          >
            Checkpoints
          </button>
          <button
            type="button"
            className={`btn btn-sm ${mode === "final" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setMode("final")}
            data-testid="manager-review-mode-final"
          >
            Final assessment
          </button>
        </div>

        <section className="card card-body" data-testid="manager-review-question-pane">
          {current ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs text-stone-500 font-mono">
                  Question {currentIndex + 1} of {totalInMode}
                </span>
                {status && (
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${toneClass}`}
                    data-testid="manager-review-status"
                  >
                    {status.label}
                  </span>
                )}
              </div>
              <h3 className="mt-3 text-base font-medium text-stone-900" data-testid="manager-review-question-text">
                {current.questionText}
              </h3>
              <ul className="mt-4 space-y-2">
                {current.options.map((o, i) => (
                  <li
                    key={i}
                    className={`rounded-md border px-3 py-2 text-sm ${
                      o.isCorrect
                        ? "border-green-300 bg-green-50 text-green-900"
                        : "border-stone-200 bg-white text-stone-800"
                    }`}
                    data-testid={`manager-review-option-${i}`}
                  >
                    <span className="font-mono text-xs text-stone-500 mr-2">
                      {String.fromCharCode(65 + i)}.
                    </span>
                    {o.optionText}
                    {o.isCorrect && (
                      <span className="ml-2 text-xs font-semibold text-green-700">
                        ✓ Correct answer
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              {lastError && (
                <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                  {lastError}
                </div>
              )}

              <div className="mt-6 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={pendingBusy || current.isPromoted}
                  onClick={handleAccept}
                  data-testid="manager-review-accept"
                  title={
                    !props.canApprove && !props.canAuthor
                      ? "You don't have permission to approve or promote."
                      : undefined
                  }
                >
                  {current.isPromoted
                    ? "Approved"
                    : current.state === "APPROVED_DRAFT" && props.canAuthor
                      ? "Promote"
                      : "Accept"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={pendingBusy}
                  onClick={handleDiscard}
                  data-testid="manager-review-discard"
                >
                  Discard
                </button>
                <a
                  href={`/app/admin/people/safety-training/${props.courseId}/${props.versionId}`}
                  className="btn btn-secondary btn-sm"
                  data-testid="manager-review-edit"
                >
                  Edit in full editor
                </a>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={currentIndex === 0 || pendingBusy}
                    onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
                    data-testid="manager-review-prev"
                  >
                    ← Prev
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={currentIndex >= totalInMode - 1 || pendingBusy}
                    onClick={() => setCurrentIndex((i) => Math.min(totalInMode - 1, i + 1))}
                    data-testid="manager-review-next"
                  >
                    Next →
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-stone-500" data-testid="manager-review-no-drafts">
              No AI-generated questions yet. They&apos;ll appear here once preparation completes.
            </p>
          )}
        </section>

        {totalInMode > 0 && (
          <div className="card card-body text-xs text-stone-500">
            <div className="flex items-center justify-between">
              <span>{totalInMode} AI-generated questions in queue</span>
              <a
                href={`/app/admin/people/safety-training/${props.courseId}/${props.versionId}/preview-as-employee`}
                className="text-club-green hover:underline"
                data-testid="manager-review-preview-link"
              >
                Preview as employee →
              </a>
            </div>
          </div>
        )}

        {/* ── §10 Approval & course assembly status ── */}
        <ApprovalStatusCard drafts={activeDrafts} />

        {/* ── §12 Pre-publish review summary ── */}
        <PrePublishSummary
          config={props.publishConfig}
          canPublish={props.canPublish}
          courseId={props.courseId}
          versionId={props.versionId}
        />
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// §10 — Approval & course-assembly status (observational card).
// Summarises how many drafts are in each lifecycle state so the
// manager always knows whether the reviewer still has work left,
// without needing to flip through every question.
// ──────────────────────────────────────────────────────────────────

function ApprovalStatusCard({ drafts }: { drafts: Draft[] }) {
  const counts = drafts.reduce(
    (acc, d) => {
      if (d.isPromoted) acc.promoted++;
      else if (d.state === "APPROVED_DRAFT") acc.awaitingPromotion++;
      else if (d.state === "REQUIRES_HUMAN_REVIEW") acc.needsReview++;
      else if (d.state === "REJECTED") acc.discarded++;
      else acc.preparing++;
      return acc;
    },
    { needsReview: 0, awaitingPromotion: 0, promoted: 0, discarded: 0, preparing: 0 },
  );
  const total = drafts.length;
  return (
    <section
      className="card card-body"
      data-testid="manager-review-approval-status"
    >
      <h3 className="section-title text-sm">Approval status</h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-stone-500">Needs review</dt>
        <dd className="text-right font-mono" data-testid="mrs-count-needs-review">{counts.needsReview}</dd>
        <dt className="text-stone-500">Awaiting promotion</dt>
        <dd className="text-right font-mono" data-testid="mrs-count-awaiting-promotion">{counts.awaitingPromotion}</dd>
        <dt className="text-stone-500">Approved &amp; in course</dt>
        <dd className="text-right font-mono" data-testid="mrs-count-promoted">{counts.promoted}</dd>
        <dt className="text-stone-500">Discarded</dt>
        <dd className="text-right font-mono" data-testid="mrs-count-discarded">{counts.discarded}</dd>
        <dt className="text-stone-500">Total</dt>
        <dd className="text-right font-mono">{total}</dd>
      </dl>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// §12 — Pre-publish summary. Consolidates audience, passing grade,
// required/optional, retakes, and readiness so the manager sees all
// publication settings in one card before the explicit publish
// action lives in the deep editor's PublishPanel.
// ──────────────────────────────────────────────────────────────────

function PrePublishSummary({
  config,
  canPublish,
  courseId,
  versionId,
}: {
  config: PublishConfig;
  canPublish: boolean;
  courseId: string;
  versionId: string;
}) {
  const audienceText =
    config.audience.kind === "everyone"
      ? "Everyone at the Club"
      : config.audience.kind === "scoped"
        ? `${config.audience.deptCount} department(s) · ${config.audience.positionCount} position(s)`
        : "Assigned individually";
  return (
    <section
      className="card card-body"
      data-testid="manager-review-prepublish-summary"
    >
      <h3 className="section-title text-sm">Before you publish</h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-stone-500">Audience</dt>
        <dd className="text-right" data-testid="prepub-audience">{audienceText}</dd>
        <dt className="text-stone-500">Passing grade</dt>
        <dd className="text-right font-mono" data-testid="prepub-passing-score">{config.passingScore}%</dd>
        <dt className="text-stone-500">Required for scheduling</dt>
        <dd className="text-right" data-testid="prepub-required">{config.required ? "Yes" : "No"}</dd>
        <dt className="text-stone-500">Retakes allowed</dt>
        <dd className="text-right" data-testid="prepub-retakes">{config.retakesAllowed ? "Yes" : "No"}</dd>
      </dl>

      {config.readinessReady ? (
        <div className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800" data-testid="prepub-ready">
          Ready to publish.
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="prepub-not-ready">
          <div className="font-medium">A few things need attention before publishing:</div>
          {config.readinessReasons.length > 0 && (
            <ul className="mt-1 list-disc pl-5 space-y-1">
              {config.readinessReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <a
        href={`/app/admin/people/safety-training/${courseId}/${versionId}/training-requirements`}
        className={`mt-3 inline-block btn btn-sm ${
          canPublish ? "btn-primary" : "btn-secondary"
        }`}
        data-testid="prepub-continue-link"
      >
        {canPublish ? "Continue to Training Requirements →" : "View Training Requirements →"}
      </a>
    </section>
  );
}

"use client";

// EP-TRAIN-4Y-S §5+§6+§7+§8 — Manager Review client component.
// EP-TRAIN-4Y-AA §2+§4+§5+§6 (2026-11-09):
//   §2 — inline title + description header with pencil edit, Preview
//        as employee at the top-right of the header. Persist writes to
//        the COURSE row (not the version), so the Qwen metadata guard
//        protects the manager's edit from silent overwrite.
//   §4 — checkpoint markers overlaid on a synchronized timeline track
//        underneath the native video player. Click seeks + selects the
//        corresponding question; the selected question highlights the
//        matching marker; keyboard-accessible.
//   §5 — tabs filter by persisted destination from the server-resolved
//        destinationKind on each draft. Checkpoints tab shows only
//        CHECKPOINT drafts; Final-assessment tab shows only
//        FINAL_ASSESSMENT drafts (with a truthful zero-question empty
//        state when the group generated none).
//   §6 — the redundant "N AI-generated questions in queue / Preview
//        as employee" card is removed; the preview action lives in the
//        header. The Course title / Description card is removed —
//        content moves inline into the page header.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";

type DestinationKind = "CHECKPOINT" | "FINAL_ASSESSMENT" | "UNKNOWN";

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
  destination: DestinationKind;
  planGroupKey: string | null;
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

// Small SVG pencil — self-contained, no icon package dependency.
function PencilIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11.5 2.5l2 2L5 13l-3 1 1-3 8.5-8.5z" />
      <path d="M10 4l2 2" />
    </svg>
  );
}

export default function ManagerReviewClient(props: Props) {
  const router = useRouter();

  // ── Destination-filtered drafts ─────────────────────────────────
  // EP-TRAIN-4Y-AA §5 — filter by server-resolved destination, not by
  // tab-label guesswork. Drafts resolved to UNKNOWN are shown in BOTH
  // tabs (defensive — never hide a reviewable item), but they should
  // not occur for any run generated on or after 4Y-AA ships because
  // the resolver reads the persisted shortfallReasonJson produced by
  // the worker.
  const [mode, setMode] = useState<"checkpoints" | "final">(() => {
    const hasCps = props.drafts.some(
      (d) => d.destination === "CHECKPOINT" || d.destination === "UNKNOWN",
    );
    return hasCps ? "checkpoints" : "final";
  });
  const checkpointDrafts = useMemo(
    () => props.drafts.filter((d) => d.destination === "CHECKPOINT" || d.destination === "UNKNOWN"),
    [props.drafts],
  );
  const finalDrafts = useMemo(
    () => props.drafts.filter((d) => d.destination === "FINAL_ASSESSMENT" || d.destination === "UNKNOWN"),
    [props.drafts],
  );
  const activeDrafts = mode === "checkpoints" ? checkpointDrafts : finalDrafts;
  const totalCheckpoint = checkpointDrafts.length;
  const totalFinal = finalDrafts.length;

  // Independent index per mode so switching tabs restores position.
  const [cpIndex, setCpIndex] = useState(0);
  const [faIndex, setFaIndex] = useState(0);
  // Clamp indices into bounds if the drafts array shape changes.
  useEffect(() => {
    if (cpIndex >= totalCheckpoint) setCpIndex(Math.max(0, totalCheckpoint - 1));
  }, [totalCheckpoint, cpIndex]);
  useEffect(() => {
    if (faIndex >= totalFinal) setFaIndex(Math.max(0, totalFinal - 1));
  }, [totalFinal, faIndex]);
  const currentIndex = mode === "checkpoints" ? cpIndex : faIndex;
  const setCurrentIndex = (updater: (prev: number) => number) => {
    if (mode === "checkpoints") setCpIndex(updater);
    else setFaIndex(updater);
  };

  // ── Header edit state ───────────────────────────────────────────
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [titleDraft, setTitleDraft] = useState(props.courseTitle);
  const [descDraft, setDescDraft] = useState(props.courseDescription);
  // Keep the visible values in sync when the parent passes fresh data
  // after a router.refresh() (e.g. a save completed server-side).
  useEffect(() => { if (!editingTitle) setTitleDraft(props.courseTitle); }, [props.courseTitle, editingTitle]);
  useEffect(() => { if (!editingDesc) setDescDraft(props.courseDescription); }, [props.courseDescription, editingDesc]);
  const [titleSaveState, setTitleSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [descSaveState, setDescSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const [pendingBusy, setPendingBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // ── Video + timeline state ──────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(
    props.videoDurationSec,
  );
  const [currentCheckpointId, setCurrentCheckpointId] = useState<string | null>(null);

  const current = activeDrafts[currentIndex] ?? null;
  const totalInMode = activeDrafts.length;

  // Sync marker highlight ↔ selected checkpoint question. When the
  // manager selects a checkpoint-group draft, the matching marker
  // highlights; we align by the draft's position inside the sorted
  // checkpoint list (works because the worker generates CP drafts in
  // atSec order and the server returns them ordered by generatedAt).
  const sortedCheckpoints = useMemo(
    () => [...props.checkpoints].sort((a, b) => a.atSecond - b.atSecond),
    [props.checkpoints],
  );
  useEffect(() => {
    if (mode !== "checkpoints") { setCurrentCheckpointId(null); return; }
    const cp = sortedCheckpoints[currentIndex];
    setCurrentCheckpointId(cp?.id ?? null);
  }, [mode, currentIndex, sortedCheckpoints]);

  // ── Header save handlers ────────────────────────────────────────
  const saveCourseField = useCallback(
    async (field: "title" | "description", value: string) => {
      const setState = field === "title" ? setTitleSaveState : setDescSaveState;
      setState("saving");
      try {
        const resp = await fetch(
          `/api/admin/training/courses/${props.courseId}/metadata`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [field]: value }),
          },
        );
        if (!resp.ok) {
          const b = await resp.json().catch(() => ({}));
          throw new Error(b?.message ?? `metadata save failed (${resp.status})`);
        }
        setState("saved");
        setTimeout(() => setState("idle"), 1500);
        router.refresh();
      } catch {
        setState("error");
      }
    },
    [props.courseId, router],
  );
  const commitTitle = useCallback(async () => {
    const trimmed = titleDraft.trim();
    if (trimmed.length < 3) { setTitleSaveState("error"); return; }
    if (trimmed !== props.courseTitle) {
      await saveCourseField("title", trimmed);
    }
    setEditingTitle(false);
  }, [titleDraft, props.courseTitle, saveCourseField]);
  const cancelTitle = useCallback(() => {
    setTitleDraft(props.courseTitle);
    setTitleSaveState("idle");
    setEditingTitle(false);
  }, [props.courseTitle]);
  const commitDesc = useCallback(async () => {
    const trimmed = descDraft.trim();
    if (trimmed !== props.courseDescription) {
      await saveCourseField("description", trimmed);
    }
    setEditingDesc(false);
  }, [descDraft, props.courseDescription, saveCourseField]);
  const cancelDesc = useCallback(() => {
    setDescDraft(props.courseDescription);
    setDescSaveState("idle");
    setEditingDesc(false);
  }, [props.courseDescription]);

  // ── Review action handlers ──────────────────────────────────────
  const handleAccept = useCallback(async () => {
    if (!current || pendingBusy) return;
    setPendingBusy(true);
    setLastError(null);
    try {
      const stateResp = await fetch(
        `/api/admin/ai-training/drafts/${current.id}/state`,
        { cache: "no-store" },
      );
      const stateBody = await stateResp.json();
      if (!stateResp.ok) throw new Error("Could not read draft state.");
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
        const resp = await fetch(
          `/api/admin/ai-training/drafts/${current.id}/promote`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              destination: {
                kind: current.destination === "CHECKPOINT" ? "CHECKPOINT" : "FINAL_ASSESSMENT",
              },
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

  // ── Timeline marker click + keyboard handling ───────────────────
  const seekToCheckpoint = useCallback((cpId: string, atSecond: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = atSecond;
      videoRef.current.pause();
    }
    // Align the question pane with the clicked checkpoint.
    const idx = sortedCheckpoints.findIndex((c) => c.id === cpId);
    if (idx >= 0 && mode === "checkpoints" && idx < totalCheckpoint) {
      setCpIndex(idx);
    }
    setCurrentCheckpointId(cpId);
  }, [mode, sortedCheckpoints, totalCheckpoint]);
  const handleMarkerKey = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, cp: Checkpoint) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        seekToCheckpoint(cp.id, cp.atSecond);
      }
    },
    [seekToCheckpoint],
  );

  // ── Empty state (no video + no drafts) ──────────────────────────
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

  const durationForMarkers = videoDuration ?? props.videoDurationSec ?? 0;

  return (
    <>
      {/* ── Breadcrumb + inline header (title + description + preview) ── */}
      <div className="mb-5">
        <a
          href={`/app/admin/people/safety-training/${props.courseId}/${props.versionId}`}
          className="text-sm text-stone-500 hover:text-club-ink"
        >
          ← Course editor
        </a>
      </div>

      <header
        className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"
        data-testid="manager-review-header"
      >
        <div className="flex-1 min-w-0">
          {/* Title row */}
          <div className="flex items-start gap-2">
            {editingTitle ? (
              <div className="flex-1">
                <input
                  autoFocus
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); void commitTitle(); }
                    if (e.key === "Escape") cancelTitle();
                  }}
                  className="w-full text-3xl font-serif tracking-tight text-stone-900 bg-transparent border-b border-club-green focus:outline-none"
                  data-testid="manager-review-title-input"
                  aria-label="Course title"
                />
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={commitTitle}
                    data-testid="manager-review-title-save"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={cancelTitle}
                    data-testid="manager-review-title-cancel"
                  >
                    Cancel
                  </button>
                  {titleSaveState === "saving" && <span className="text-stone-500">Saving…</span>}
                  {titleSaveState === "error" && (
                    <span className="text-red-600">
                      Couldn&apos;t save — title must be 3-200 characters.
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <>
                <h1
                  className="page-title text-stone-900"
                  data-testid="manager-review-title-display"
                >
                  {props.courseTitle}
                </h1>
                <button
                  type="button"
                  onClick={() => setEditingTitle(true)}
                  className="mt-2 inline-flex items-center justify-center h-7 w-7 rounded-full text-stone-400 hover:text-club-green hover:bg-stone-100 transition-colors"
                  aria-label="Edit course title"
                  data-testid="manager-review-title-edit"
                >
                  <PencilIcon />
                </button>
                {titleSaveState === "saved" && (
                  <span className="mt-3 text-xs text-stone-500">Saved.</span>
                )}
              </>
            )}
          </div>

          {/* Description row */}
          <div className="mt-2 flex items-start gap-2">
            {editingDesc ? (
              <div className="flex-1">
                <textarea
                  autoFocus
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancelDesc();
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      void commitDesc();
                    }
                  }}
                  rows={4}
                  className="w-full text-sm leading-relaxed text-stone-700 bg-white border border-club-green rounded-md p-2 focus:outline-none"
                  data-testid="manager-review-description-input"
                  aria-label="Course description"
                  placeholder="Describe what employees will learn."
                />
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={commitDesc}
                    data-testid="manager-review-description-save"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={cancelDesc}
                    data-testid="manager-review-description-cancel"
                  >
                    Cancel
                  </button>
                  {descSaveState === "saving" && <span className="text-stone-500">Saving…</span>}
                  {descSaveState === "error" && (
                    <span className="text-red-600">Couldn&apos;t save — try again.</span>
                  )}
                  <span className="ml-auto text-stone-400">Ctrl+Enter to save · Esc to cancel</span>
                </div>
              </div>
            ) : (
              <>
                <p
                  className="text-sm leading-relaxed text-stone-600 max-w-[760px]"
                  data-testid="manager-review-description-display"
                >
                  {props.courseDescription
                    ? props.courseDescription
                    : <span className="italic text-stone-400">No course description yet — click the pencil to add one.</span>}
                </p>
                <button
                  type="button"
                  onClick={() => setEditingDesc(true)}
                  className="mt-0.5 inline-flex items-center justify-center h-7 w-7 rounded-full text-stone-400 hover:text-club-green hover:bg-stone-100 transition-colors"
                  aria-label="Edit course description"
                  data-testid="manager-review-description-edit"
                >
                  <PencilIcon />
                </button>
                {descSaveState === "saved" && (
                  <span className="mt-1 text-xs text-stone-500">Saved.</span>
                )}
              </>
            )}
          </div>
        </div>

        <div className="flex-shrink-0" data-testid="manager-review-header-preview-slot">
          <a
            href={`/app/admin/people/safety-training/${props.courseId}/${props.versionId}/preview-as-employee`}
            className="btn btn-secondary btn-sm"
            data-testid="manager-review-preview-link"
          >
            Preview as employee →
          </a>
        </div>
      </header>

      {/* ── Two-column body ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6">
        {/* Left: video + timeline markers */}
        <div className="space-y-4" data-testid="manager-review-left">
          <section className="card card-body">
            {props.videoUrl ? (
              <>
                <video
                  ref={videoRef}
                  src={props.videoUrl}
                  controls
                  preload="metadata"
                  className="w-full rounded-md bg-black"
                  data-testid="manager-review-video"
                  onLoadedMetadata={(e) => {
                    const d = (e.target as HTMLVideoElement).duration;
                    if (Number.isFinite(d) && d > 0) setVideoDuration(d);
                  }}
                />
                {/* EP-TRAIN-4Y-AA §4 — synchronized timeline track with
                    checkpoint markers. Independent from the native
                    controls (which don't support interactive overlays
                    across browsers). Each marker's left position is
                    atSecond / duration. */}
                {props.checkpoints.length > 0 && durationForMarkers > 0 && (
                  <div
                    className="relative mt-3 h-9 select-none"
                    data-testid="manager-review-checkpoint-timeline"
                    aria-label="Checkpoint timeline"
                  >
                    {/* Track */}
                    <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-stone-200" />
                    {sortedCheckpoints.map((c) => {
                      const pct = Math.min(100, Math.max(0, (c.atSecond / durationForMarkers) * 100));
                      const isActive = c.id === currentCheckpointId;
                      const draftIdx = sortedCheckpoints.findIndex((x) => x.id === c.id);
                      const matchingDraft = checkpointDrafts[draftIdx] ?? null;
                      const qLabel = matchingDraft?.questionText?.slice(0, 80) ?? "";
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => seekToCheckpoint(c.id, c.atSecond)}
                          onKeyDown={(e) => handleMarkerKey(e, c)}
                          title={`Checkpoint ${draftIdx + 1} · ${formatTime(c.atSecond)}${qLabel ? ` · ${qLabel}${qLabel.length === 80 ? "…" : ""}` : ""}`}
                          aria-label={`Seek to checkpoint ${draftIdx + 1} at ${formatTime(c.atSecond)}`}
                          data-testid={`manager-review-checkpoint-marker-${c.id}`}
                          data-marker-active={isActive ? "true" : "false"}
                          className={[
                            "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 inline-flex items-center justify-center",
                            "h-6 w-6 rounded-full border transition-all",
                            "focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-club-green",
                            isActive
                              ? "bg-club-green text-white border-club-green scale-110 shadow"
                              : "bg-white text-stone-700 border-stone-300 hover:border-club-green hover:text-club-green",
                          ].join(" ")}
                          style={{ left: `${pct}%` }}
                        >
                          <span className="text-[10px] font-semibold font-mono leading-none">
                            {draftIdx + 1}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-xs text-stone-500">
                    Duration: {formatTime(durationForMarkers > 0 ? durationForMarkers : null)}
                  </span>
                  {props.checkpoints.length > 0 && (
                    <span className="text-xs text-stone-500">
                      {props.checkpoints.length} checkpoint{props.checkpoints.length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <div className="rounded-md bg-stone-100 p-8 text-center text-sm text-stone-500">
                No video uploaded yet.
              </div>
            )}
          </section>
        </div>

        {/* Right: one question at a time */}
        <div className="space-y-4" data-testid="manager-review-right">
          <div className="flex items-center gap-2 text-sm" data-testid="manager-review-tabs">
            <button
              type="button"
              className={`btn btn-sm ${mode === "checkpoints" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setMode("checkpoints")}
              data-testid="manager-review-mode-checkpoints"
              aria-pressed={mode === "checkpoints"}
            >
              Checkpoints · {totalCheckpoint}
            </button>
            <button
              type="button"
              className={`btn btn-sm ${mode === "final" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setMode("final")}
              data-testid="manager-review-mode-final"
              aria-pressed={mode === "final"}
            >
              Final assessment · {totalFinal}
            </button>
          </div>

          <section className="card card-body" data-testid="manager-review-question-pane">
            {current ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-stone-500 font-mono">
                    Question {currentIndex + 1} of {totalInMode}
                    {current.destination === "UNKNOWN" && (
                      <span className="ml-2 text-amber-700" title="Destination could not be resolved from the generation plan.">
                        · destination unknown
                      </span>
                    )}
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
            ) : mode === "final" && totalFinal === 0 ? (
              // EP-TRAIN-4Y-AA §5 — explicit truthful FA empty state.
              <div
                className="space-y-3 text-sm text-stone-700"
                data-testid="manager-review-final-empty"
              >
                <p className="font-medium text-stone-900">
                  No final-assessment questions were generated yet.
                </p>
                <p className="text-stone-500">
                  The AI generation for this course produced the checkpoint
                  questions but no final-assessment questions. A targeted
                  recovery can regenerate them — awaiting founder
                  authorization.
                </p>
              </div>
            ) : (
              <div
                className="space-y-3 text-sm text-stone-700"
                data-testid="manager-review-no-drafts"
              >
                <p className="font-medium text-stone-900">
                  AI preparation hasn&apos;t produced questions yet.
                </p>
                <p className="text-stone-500">
                  This usually means transcription or question generation hasn&apos;t completed
                  for this course. Return to the preparation page to see the current stage.
                </p>
                <a
                  href={`/app/admin/people/safety-training/${props.courseId}/${props.versionId}/upload`}
                  className="inline-block btn btn-primary btn-sm"
                  data-testid="manager-review-return-to-prep"
                >
                  ← Return to preparation
                </a>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

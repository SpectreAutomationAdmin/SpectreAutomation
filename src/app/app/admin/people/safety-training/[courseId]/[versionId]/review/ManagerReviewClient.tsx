"use client";

// EP-TRAIN-4Y-S §5+§6+§7+§8 — Manager Review client component.
// EP-TRAIN-4Y-AA §2+§4+§5+§6 — inline header (title + desc + pencil),
// destination-filter tabs, checkpoint timeline, redundant-card removal.
// EP-TRAIN-4Y-AB §2+§4+§5+§6 (2026-11-10):
//   §2 — reuses the canonical employee <CoursePlayer>'s PlayerControlBar
//        (extracted to src/components/training/PlayerControlBar.tsx).
//        Manager mode passes onMarkerClick, markerLabels, activeMarkerId,
//        allowUnrestrictedSeek so the control bar renders numbered,
//        clickable, selection-aware markers and keeps the look identical
//        to employee mode.
//   §4 — inline editor replaces "Edit in full editor". Save persists via
//        POST /api/admin/ai-training/drafts/[id]/edit which lands the
//        draft in EDITED_VALIDATION_STALE (SoD preserved).
//   §5 — 60/40 desktop layout (video 3fr / question-review 2fr) with
//        vertical stretch on the review column. Stacks on mobile.
//   §6 — Click-seek + question-sync + marker highlight maintained.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { PlayerControlBar } from "@/components/training/PlayerControlBar";

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
  contentHash?: string;
  recordVersion?: number;
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
  if (state === "EDITED_VALIDATION_STALE") return { label: "Edited — pending re-validation", tone: "amber" };
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

  // ── Destination-filtered drafts (unchanged from AA) ─────────────
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

  const [cpIndex, setCpIndex] = useState(0);
  const [faIndex, setFaIndex] = useState(0);
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

  // ── Header edit state (unchanged from AA) ───────────────────────
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [titleDraft, setTitleDraft] = useState(props.courseTitle);
  const [descDraft, setDescDraft] = useState(props.courseDescription);
  useEffect(() => { if (!editingTitle) setTitleDraft(props.courseTitle); }, [props.courseTitle, editingTitle]);
  useEffect(() => { if (!editingDesc) setDescDraft(props.courseDescription); }, [props.courseDescription, editingDesc]);
  const [titleSaveState, setTitleSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [descSaveState, setDescSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const [pendingBusy, setPendingBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // ── Inline question edit state (new in AB §4) ───────────────────
  interface EditingDraft {
    draftId: string;
    questionText: string;
    options: { text: string; isCorrect: boolean }[];
    explanation: string;
    originalContentHash: string;
    originalRecordVersion: number;
  }
  const [editing, setEditing] = useState<EditingDraft | null>(null);
  const [editSaveState, setEditSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [editError, setEditError] = useState<string | null>(null);
  // "Dirty" tracking — if the user has modified anything, prompt on
  // tab-switch / prev-next / discard. Compared against the snapshot
  // captured at edit-start so textareas can round-trip unchanged.
  const isDirty = useCallback((): boolean => {
    if (!editing) return false;
    const original = (mode === "checkpoints" ? checkpointDrafts : finalDrafts)
      [currentIndex];
    if (!original || original.id !== editing.draftId) return false;
    if (editing.questionText !== original.questionText) return true;
    if (editing.options.length !== original.options.length) return true;
    for (let i = 0; i < editing.options.length; i++) {
      if (editing.options[i].text !== original.options[i].optionText) return true;
      if (editing.options[i].isCorrect !== original.options[i].isCorrect) return true;
    }
    return false;
  }, [editing, mode, checkpointDrafts, finalDrafts, currentIndex]);
  const guardUnsaved = useCallback((intent: string): boolean => {
    if (!editing || !isDirty()) return true;
    return window.confirm(`You have unsaved edits to this question. ${intent} without saving?`);
  }, [editing, isDirty]);

  // ── Video + timeline state ──────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(
    props.videoDurationSec,
  );
  const [currentCheckpointId, setCurrentCheckpointId] = useState<string | null>(null);

  const current = activeDrafts[currentIndex] ?? null;
  const totalInMode = activeDrafts.length;

  // Sync marker highlight ↔ selected checkpoint question (unchanged).
  const sortedCheckpoints = useMemo(
    () => [...props.checkpoints].sort((a, b) => a.atSecond - b.atSecond),
    [props.checkpoints],
  );
  useEffect(() => {
    if (mode !== "checkpoints") { setCurrentCheckpointId(null); return; }
    const cp = sortedCheckpoints[currentIndex];
    setCurrentCheckpointId(cp?.id ?? null);
  }, [mode, currentIndex, sortedCheckpoints]);

  // ── Header save handlers (unchanged from AA) ────────────────────
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
    if (trimmed !== props.courseTitle) await saveCourseField("title", trimmed);
    setEditingTitle(false);
  }, [titleDraft, props.courseTitle, saveCourseField]);
  const cancelTitle = useCallback(() => {
    setTitleDraft(props.courseTitle);
    setTitleSaveState("idle");
    setEditingTitle(false);
  }, [props.courseTitle]);
  const commitDesc = useCallback(async () => {
    const trimmed = descDraft.trim();
    if (trimmed !== props.courseDescription) await saveCourseField("description", trimmed);
    setEditingDesc(false);
  }, [descDraft, props.courseDescription, saveCourseField]);
  const cancelDesc = useCallback(() => {
    setDescDraft(props.courseDescription);
    setDescSaveState("idle");
    setEditingDesc(false);
  }, [props.courseDescription]);

  // ── Review action handlers ──────────────────────────────────────
  const refreshDraftState = useCallback(async (draftId: string) => {
    const resp = await fetch(`/api/admin/ai-training/drafts/${draftId}/state`, { cache: "no-store" });
    if (!resp.ok) throw new Error("Could not read draft state.");
    return resp.json() as Promise<{
      state: string;
      recordVersion: number;
      contentHash: string;
      latestValidationId?: string;
      correctOptionIndex?: number;
      correctOptionText?: string;
    }>;
  }, []);

  const handleAccept = useCallback(async () => {
    if (!current || pendingBusy) return;
    if (!guardUnsaved("Accept this draft and leave the editor")) return;
    setPendingBusy(true);
    setLastError(null);
    try {
      const stateBody = await refreshDraftState(current.id);
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
      setEditing(null);
      router.refresh();
    } catch (err) {
      setLastError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setPendingBusy(false);
    }
  }, [current, pendingBusy, props.canApprove, props.canAuthor, router, guardUnsaved, refreshDraftState]);

  const handleDiscard = useCallback(async () => {
    if (!current || pendingBusy) return;
    if (!guardUnsaved("Discard this draft")) return;
    if (!window.confirm("Discard this question? This can't be undone.")) return;
    setPendingBusy(true);
    setLastError(null);
    try {
      const stateBody = await refreshDraftState(current.id);
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
      setEditing(null);
      router.refresh();
    } catch (err) {
      setLastError(err instanceof Error ? err.message : "Unknown error.");
    } finally {
      setPendingBusy(false);
    }
  }, [current, pendingBusy, router, guardUnsaved, refreshDraftState]);

  // ── Inline edit handlers ────────────────────────────────────────
  const beginEdit = useCallback(async () => {
    if (!current || pendingBusy) return;
    // Refresh state so we commit with the live contentHash +
    // recordVersion. Avoids a 409 CONTENT_HASH_MISMATCH if the client
    // cached stale props.
    setEditError(null);
    try {
      const stateBody = await refreshDraftState(current.id);
      setEditing({
        draftId: current.id,
        questionText: current.questionText,
        options: current.options.map((o) => ({ text: o.optionText, isCorrect: o.isCorrect })),
        explanation: "",
        originalContentHash: stateBody.contentHash,
        originalRecordVersion: stateBody.recordVersion,
      });
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Unknown error.");
    }
  }, [current, pendingBusy, refreshDraftState]);

  const cancelEdit = useCallback(() => {
    if (!editing) return;
    if (!guardUnsaved("Cancel")) return;
    setEditing(null);
    setEditSaveState("idle");
    setEditError(null);
  }, [editing, guardUnsaved]);

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    setEditSaveState("saving");
    setEditError(null);
    try {
      const resp = await fetch(
        `/api/admin/ai-training/drafts/${editing.draftId}/edit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            questionText: editing.questionText,
            options: editing.options,
            explanation: editing.explanation,
            expectedContentHash: editing.originalContentHash,
            expectedRecordVersion: editing.originalRecordVersion,
            reviewerNote: "Manager inline edit (review page)",
          }),
        },
      );
      const body = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
        detail?: unknown;
      };
      if (!resp.ok || body.ok !== true) {
        throw new Error(body?.message ?? body?.error ?? `Save failed (${resp.status}).`);
      }
      setEditSaveState("saved");
      setEditing(null);
      setTimeout(() => setEditSaveState("idle"), 1500);
      router.refresh();
    } catch (err) {
      setEditSaveState("error");
      setEditError(err instanceof Error ? err.message : "Unknown error.");
    }
  }, [editing, router]);

  // Browser-level guard: beforeunload prevents accidental tab-close
  // with unsaved edits.
  useEffect(() => {
    if (!editing || !isDirty()) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [editing, isDirty]);

  // ── Timeline marker click (for shared PlayerControlBar) ─────────
  const handleMarkerClick = useCallback(
    (cpId: string, atSecond: number) => {
      if (!guardUnsaved("Jump to a different checkpoint")) return;
      if (videoRef.current) {
        videoRef.current.currentTime = atSecond;
        videoRef.current.pause();
      }
      const idx = sortedCheckpoints.findIndex((c) => c.id === cpId);
      if (idx >= 0 && idx < totalCheckpoint) {
        if (mode !== "checkpoints") setMode("checkpoints");
        setCpIndex(idx);
      }
      setCurrentCheckpointId(cpId);
    },
    [mode, sortedCheckpoints, totalCheckpoint, guardUnsaved],
  );

  // Numbered marker labels — "1", "2", … in atSec order.
  const markerLabels = useMemo(() => {
    const m: Record<string, string> = {};
    sortedCheckpoints.forEach((c, i) => { m[c.id] = String(i + 1); });
    return m;
  }, [sortedCheckpoints]);
  // Manager mode sends an empty "cleared" set — the "cleared" concept
  // doesn't apply to content review.
  const emptyCleared = useMemo(() => new Set<string>(), []);
  // Adapt our Checkpoint[] into the PlayerCheckpointMarker shape.
  const playerCheckpoints = useMemo(
    () => sortedCheckpoints.map((c) => ({ id: c.id, atSecond: c.atSecond, label: c.title })),
    [sortedCheckpoints],
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
      {/* ── Breadcrumb + inline header ─────────────────────────── */}
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
                  <button type="button" className="btn btn-primary btn-sm" onClick={commitTitle} data-testid="manager-review-title-save">Save</button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={cancelTitle} data-testid="manager-review-title-cancel">Cancel</button>
                  {titleSaveState === "saving" && <span className="text-stone-500">Saving…</span>}
                  {titleSaveState === "error" && <span className="text-red-600">Couldn&apos;t save — title must be 3-200 characters.</span>}
                </div>
              </div>
            ) : (
              <>
                <h1 className="page-title text-stone-900" data-testid="manager-review-title-display">{props.courseTitle}</h1>
                <button
                  type="button"
                  onClick={() => setEditingTitle(true)}
                  className="mt-2 inline-flex items-center justify-center h-7 w-7 rounded-full text-stone-400 hover:text-club-green hover:bg-stone-100 transition-colors"
                  aria-label="Edit course title"
                  data-testid="manager-review-title-edit"
                >
                  <PencilIcon />
                </button>
                {titleSaveState === "saved" && <span className="mt-3 text-xs text-stone-500">Saved.</span>}
              </>
            )}
          </div>
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
                  <button type="button" className="btn btn-primary btn-sm" onClick={commitDesc} data-testid="manager-review-description-save">Save</button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={cancelDesc} data-testid="manager-review-description-cancel">Cancel</button>
                  {descSaveState === "saving" && <span className="text-stone-500">Saving…</span>}
                  {descSaveState === "error" && <span className="text-red-600">Couldn&apos;t save — try again.</span>}
                  <span className="ml-auto text-stone-400">Ctrl+Enter to save · Esc to cancel</span>
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm leading-relaxed text-stone-600 max-w-[760px]" data-testid="manager-review-description-display">
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
                {descSaveState === "saved" && <span className="mt-1 text-xs text-stone-500">Saved.</span>}
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

      {/* ── 60/40 two-column body (lg+); stacked on small screens ── */}
      <div
        className="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-6 items-start"
        data-testid="manager-review-body"
      >
        {/* Left (3fr): shared video + PlayerControlBar */}
        <div className="space-y-4" data-testid="manager-review-left">
          <section
            className="rounded-lg border border-stone-200 bg-white overflow-hidden"
            data-testid="portal-course-video-section"
          >
            {props.videoUrl ? (
              <>
                <div className="relative w-full aspect-video bg-stone-100">
                  <video
                    ref={videoRef}
                    src={props.videoUrl}
                    preload="metadata"
                    playsInline
                    className="absolute inset-0 w-full h-full bg-stone-900"
                    data-testid="portal-course-video"
                    onLoadedMetadata={(e) => {
                      const d = (e.target as HTMLVideoElement).duration;
                      if (Number.isFinite(d) && d > 0) setVideoDuration(d);
                    }}
                    onClick={() => {
                      const v = videoRef.current;
                      if (!v) return;
                      if (v.paused) void v.play().catch(() => {/* ignore */});
                      else v.pause();
                    }}
                  >
                    Your browser does not support the video tag.
                  </video>
                </div>
                {/* Shared control bar — manager mode (numbered + clickable
                    markers, no seek clamp, no cleared-count footer). */}
                <PlayerControlBar
                  videoRef={videoRef}
                  sortedCheckpoints={playerCheckpoints}
                  cleared={emptyCleared}
                  videoDurationSec={durationForMarkers > 0 ? durationForMarkers : props.videoDurationSec}
                  firstUnclearedRequiredAtSecond={Number.POSITIVE_INFINITY}
                  markerLabels={markerLabels}
                  onMarkerClick={handleMarkerClick}
                  activeMarkerId={currentCheckpointId ?? undefined}
                  allowUnrestrictedSeek={true}
                />
              </>
            ) : (
              <div className="rounded-md bg-stone-100 p-8 text-center text-sm text-stone-500">
                No video uploaded yet.
              </div>
            )}
          </section>
        </div>

        {/* Right (2fr): tabs + one-question-at-a-time review, stretches vertically. */}
        <div className="space-y-4 flex flex-col" data-testid="manager-review-right">
          <div className="flex items-center gap-2 text-sm" data-testid="manager-review-tabs">
            <button
              type="button"
              className={`btn btn-sm ${mode === "checkpoints" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => {
                if (!guardUnsaved("Switch tabs")) return;
                setMode("checkpoints");
                setEditing(null);
              }}
              data-testid="manager-review-mode-checkpoints"
              aria-pressed={mode === "checkpoints"}
            >
              Checkpoints · {totalCheckpoint}
            </button>
            <button
              type="button"
              className={`btn btn-sm ${mode === "final" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => {
                if (!guardUnsaved("Switch tabs")) return;
                setMode("final");
                setEditing(null);
              }}
              data-testid="manager-review-mode-final"
              aria-pressed={mode === "final"}
            >
              Final assessment · {totalFinal}
            </button>
          </div>

          <section
            className="card card-body flex-1"
            data-testid="manager-review-question-pane"
          >
            {current ? (
              editing && editing.draftId === current.id ? (
                /* ── Inline-edit mode (AB §4) ───────────────────────── */
                <div className="space-y-4" data-testid="manager-review-edit-pane">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-stone-500 font-mono">
                      Editing question {currentIndex + 1} of {totalInMode}
                    </span>
                    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800">
                      Unsaved edits
                    </span>
                  </div>

                  <label className="block">
                    <span className="label">Question text</span>
                    <textarea
                      className="input mt-1 w-full"
                      rows={4}
                      value={editing.questionText}
                      onChange={(e) =>
                        setEditing((prev) => (prev ? { ...prev, questionText: e.target.value } : prev))
                      }
                      data-testid="manager-review-edit-questionText"
                    />
                  </label>

                  <div className="space-y-2">
                    <span className="label">Options</span>
                    {editing.options.map((o, i) => (
                      <div key={i} className="flex items-start gap-2" data-testid={`manager-review-edit-option-${i}`}>
                        <label className="mt-2.5 inline-flex items-center gap-1 text-xs text-stone-600 shrink-0">
                          <input
                            type="radio"
                            name="correct-option"
                            checked={o.isCorrect}
                            onChange={() =>
                              setEditing((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      options: prev.options.map((opt, j) => ({
                                        ...opt,
                                        isCorrect: j === i,
                                      })),
                                    }
                                  : prev,
                              )
                            }
                            data-testid={`manager-review-edit-option-correct-${i}`}
                          />
                          <span className="font-mono">{String.fromCharCode(65 + i)}.</span>
                        </label>
                        <textarea
                          rows={2}
                          className="input w-full"
                          value={o.text}
                          onChange={(e) =>
                            setEditing((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    options: prev.options.map((opt, j) =>
                                      j === i ? { ...opt, text: e.target.value } : opt,
                                    ),
                                  }
                                : prev,
                            )
                          }
                          data-testid={`manager-review-edit-option-text-${i}`}
                        />
                      </div>
                    ))}
                  </div>

                  <label className="block">
                    <span className="label">Explanation (optional)</span>
                    <textarea
                      className="input mt-1 w-full"
                      rows={3}
                      value={editing.explanation}
                      onChange={(e) =>
                        setEditing((prev) => (prev ? { ...prev, explanation: e.target.value } : prev))
                      }
                      data-testid="manager-review-edit-explanation"
                      placeholder="Why this answer is correct. Shown to employees after they answer."
                    />
                  </label>

                  {editError && (
                    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert" data-testid="manager-review-edit-error">
                      {editError}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={editSaveState === "saving"}
                      onClick={saveEdit}
                      data-testid="manager-review-edit-save"
                    >
                      {editSaveState === "saving" ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={editSaveState === "saving"}
                      onClick={cancelEdit}
                      data-testid="manager-review-edit-cancel"
                    >
                      Cancel
                    </button>
                    {editSaveState === "saved" && (
                      <span className="text-xs text-stone-500" data-testid="manager-review-edit-saved">
                        Saved — awaiting re-validation.
                      </span>
                    )}
                    <span className="ml-auto text-xs text-stone-400">
                      Editing moves this draft to <strong>Pending re-validation</strong> and requires a reviewer to approve before it can be used.
                    </span>
                  </div>
                </div>
              ) : (
                /* ── Viewing mode (unchanged behaviour) ────────────── */
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
                    {/* AB §4 — "Edit in full editor" replaced with inline "Edit". */}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={pendingBusy || current.isPromoted || current.state === "REJECTED" || current.state === "ARCHIVED"}
                      onClick={beginEdit}
                      data-testid="manager-review-edit"
                    >
                      Edit
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
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={currentIndex === 0 || pendingBusy}
                        onClick={() => {
                          if (!guardUnsaved("Jump to the previous question")) return;
                          setEditing(null);
                          setCurrentIndex((i) => Math.max(0, i - 1));
                        }}
                        data-testid="manager-review-prev"
                      >
                        ← Prev
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={currentIndex >= totalInMode - 1 || pendingBusy}
                        onClick={() => {
                          if (!guardUnsaved("Jump to the next question")) return;
                          setEditing(null);
                          setCurrentIndex((i) => Math.min(totalInMode - 1, i + 1));
                        }}
                        data-testid="manager-review-next"
                      >
                        Next →
                      </button>
                    </div>
                  </div>
                </>
              )
            ) : mode === "final" && totalFinal === 0 ? (
              <div className="space-y-3 text-sm text-stone-700" data-testid="manager-review-final-empty">
                <p className="font-medium text-stone-900">No final-assessment questions were generated yet.</p>
                <p className="text-stone-500">
                  The AI generation for this course produced the checkpoint questions but no final-assessment questions. A targeted recovery can regenerate them — awaiting founder authorization.
                </p>
              </div>
            ) : (
              <div className="space-y-3 text-sm text-stone-700" data-testid="manager-review-no-drafts">
                <p className="font-medium text-stone-900">AI preparation hasn&apos;t produced questions yet.</p>
                <p className="text-stone-500">
                  This usually means transcription or question generation hasn&apos;t completed for this course. Return to the preparation page to see the current stage.
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

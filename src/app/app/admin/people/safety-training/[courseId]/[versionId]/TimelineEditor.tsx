"use client";

// EP-TRAIN-3 Slice 2 (2026-10-29) -- interactive video timeline editor.
// EP-TRAIN-4A §2 + §3 (2026-10-30) -- consolidated per-checkpoint editor
// (settings + questions in one yellow surface) and collision-free Add
// checkpoint timestamp selection.
//
// The authoring experience that lets a manager:
//   - play / pause / scrub the training video
//   - add a knowledge checkpoint at the current playhead (with
//     automatic conflict resolution against the 1-second minimum
//     separation server-side rule)
//   - see every checkpoint along the timeline as a vertical marker
//   - click a marker to open its consolidated editor (label / timestamp
//     / required / retries / question editor)
//   - delete a marker (with a confirm dialog)
//
// Fully disabled when `readOnly` is set (published / retired versions).

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import QuizEditor, { type TrainingQuestionType, type QuizQuestion } from "./QuizEditor";

export interface CheckpointSummary {
  id: string;
  atSecond: number;
  label: string | null;
  requiredToProceed: boolean;
  maxRetries: number;
  displayOrder: number;
  questionCount: number;
}

// EP-TRAIN-4A §3: must match CHECKPOINT_MIN_SPACING_SECONDS in
// src/lib/hr/training/checkpoints.ts.  Client-side collision resolver
// uses the same invariant so an add-click never surfaces a
// spacing-validation error from the server.
const MIN_SPACING_SECONDS = 1;

interface Props {
  courseId: string;
  versionId: string;
  videoUrl: string;
  initialDurationSec: number | null;
  checkpoints: CheckpointSummary[];
  /** EP-TRAIN-4A §2: per-checkpoint question map, keyed by checkpoint id. */
  questionsByCheckpointId: Record<string, QuizQuestion[]>;
  categorySuggestions: string[];
  readOnly?: boolean;
  createAction: (
    courseId: string,
    versionId: string,
    formData: FormData,
  ) => Promise<{ ok: true; checkpointId: string } | { ok: false; error: string }>;
  updateAction: (
    courseId: string,
    versionId: string,
    checkpointId: string,
    formData: FormData,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  deleteAction: (
    courseId: string,
    versionId: string,
    checkpointId: string,
    opts?: { deleteBoundQuestions?: boolean },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  createQuestionAction: (courseId: string, versionId: string, formData: FormData) => Promise<void>;
  updateQuestionAction: (courseId: string, versionId: string, questionId: string, formData: FormData) => Promise<void>;
  deleteQuestionAction: (courseId: string, versionId: string, questionId: string) => Promise<void>;
}

function formatSeconds(total: number): string {
  if (!Number.isFinite(total) || total < 0) return "0:00";
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * EP-TRAIN-4A §3 — collision-free timestamp picker.
 *
 * Finds the nearest valid second-integer timestamp given:
 *   - the preferred position (rounded playhead)
 *   - the sorted list of occupied timestamps
 *   - the min-1s separation rule
 *   - the video duration (upper bound)
 *
 * Algorithm (deterministic):
 *   1. Preferred position = `clamp(round(playhead), 0, floor(duration))`.
 *   2. If the preferred position is valid, return it.
 *   3. Otherwise, scan forward from `preferred + 1` up to `floor(duration)`;
 *      return the first valid position.
 *   4. If still none, scan backward from `preferred - 1` down to 0;
 *      return the first valid position.
 *   5. If no valid position exists anywhere in [0, floor(duration)],
 *      return null.
 *
 * A position is valid iff it is in [0, floor(duration)] AND is at least
 * `MIN_SPACING_SECONDS` away from every occupied timestamp.
 *
 * Exported for unit testing.
 */
export function findNextCheckpointPosition(
  playheadSeconds: number,
  occupiedSeconds: number[],
  durationSec: number | null,
): number | null {
  const upperBound = durationSec && durationSec > 0 ? Math.floor(durationSec) : null;
  const occupiedSet = new Set<number>();
  for (const s of occupiedSeconds) if (Number.isFinite(s)) occupiedSet.add(Math.round(s));
  const isValid = (t: number): boolean => {
    if (t < 0) return false;
    if (upperBound !== null && t > upperBound) return false;
    for (const s of occupiedSet) {
      if (Math.abs(s - t) < MIN_SPACING_SECONDS) return false;
    }
    return true;
  };
  const rawPreferred = Number.isFinite(playheadSeconds) ? Math.round(playheadSeconds) : 0;
  const preferred = Math.max(0, upperBound === null ? rawPreferred : Math.min(rawPreferred, upperBound));
  if (isValid(preferred)) return preferred;
  const maxScan = upperBound !== null ? upperBound : preferred + occupiedSet.size + MIN_SPACING_SECONDS;
  for (let t = preferred + 1; t <= maxScan; t++) {
    if (isValid(t)) return t;
  }
  for (let t = preferred - 1; t >= 0; t--) {
    if (isValid(t)) return t;
  }
  return null;
}

export default function TimelineEditor({
  courseId,
  versionId,
  videoUrl,
  initialDurationSec,
  checkpoints,
  questionsByCheckpointId,
  categorySuggestions,
  readOnly,
  createAction,
  updateAction,
  deleteAction,
  createQuestionAction,
  updateQuestionAction,
  deleteQuestionAction,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number>(initialDurationSec ?? 0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const sortedCheckpoints = useMemo(
    () => [...checkpoints].sort((a, b) => a.atSecond - b.atSecond),
    [checkpoints],
  );
  const editingCheckpoint = sortedCheckpoints.find((c) => c.id === editingId) ?? null;

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onTime = () => setCurrentTime(el.currentTime);
    const onMeta = () => {
      if (el.duration && Number.isFinite(el.duration)) setDuration(el.duration);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
    };
  }, []);

  function clearError() { if (error) setError(null); }

  async function handleAddCheckpoint() {
    if (readOnly || pending) return;
    clearError();
    // EP-TRAIN-4A §3 (2026-10-30): compute a collision-free timestamp
    // before calling the server so the "+ Add checkpoint" action never
    // surfaces a spacing-validation error.
    const occupied = sortedCheckpoints.map((c) => c.atSecond);
    const target = findNextCheckpointPosition(
      videoRef.current?.currentTime ?? 0,
      occupied,
      duration > 0 ? duration : null,
    );
    if (target === null) {
      setError(
        "The timeline has no available position for a new checkpoint. Lengthen the video or remove a checkpoint first.",
      );
      return;
    }
    const fd = new FormData();
    fd.set("atSecond", String(target));
    fd.set("label", "");
    fd.set("requiredToProceed", "true");
    startTransition(async () => {
      const result = await createAction(courseId, versionId, fd);
      if (!result.ok) {
        setError(result.error);
      } else {
        setEditingId(result.checkpointId);
        router.refresh();
      }
    });
  }

  async function handleUpdate(checkpointId: string, patch: Partial<{
    atSecond: number;
    label: string | null;
    requiredToProceed: boolean;
    maxRetries: number;
  }>) {
    if (readOnly || pending) return;
    clearError();
    const fd = new FormData();
    if (patch.atSecond !== undefined) fd.set("atSecond", String(patch.atSecond));
    if (patch.label !== undefined) fd.set("label", patch.label ?? "");
    if (patch.requiredToProceed !== undefined) fd.set("requiredToProceed", patch.requiredToProceed ? "true" : "false");
    if (patch.maxRetries !== undefined) fd.set("maxRetries", String(patch.maxRetries));
    startTransition(async () => {
      const result = await updateAction(courseId, versionId, checkpointId, fd);
      if (!result.ok) {
        setError(result.error);
      } else {
        router.refresh();
      }
    });
  }

  async function handleDelete(checkpointId: string) {
    if (readOnly || pending) return;
    clearError();
    const target = sortedCheckpoints.find((c) => c.id === checkpointId);
    const q = target?.questionCount ?? 0;
    const confirmMsg = q === 0
      ? "Delete this checkpoint?"
      : `This checkpoint has ${q} question${q === 1 ? "" : "s"} bound to it.\n\n` +
        `Click OK to delete the checkpoint AND the bound questions.\n` +
        `Click Cancel to keep the checkpoint. (To preserve the questions, ` +
        `reassign them to another checkpoint or move them to the final ` +
        `assessment before deleting.)`;
    if (!window.confirm(confirmMsg)) return;
    startTransition(async () => {
      const result = await deleteAction(courseId, versionId, checkpointId, {
        deleteBoundQuestions: q > 0,
      });
      if (!result.ok) {
        setError(result.error);
      } else {
        setEditingId(null);
        router.refresh();
      }
    });
  }

  function handleJumpTo(seconds: number) {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(duration || seconds, seconds));
    el.pause();
  }

  const safeDuration = duration > 0 ? duration : 1;

  return (
    <div className="space-y-5" data-testid="training-timeline-editor">
      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" data-testid="training-timeline-error">
          {error}
        </div>
      )}

      <div className="relative aspect-video bg-stone-900 rounded-md overflow-hidden">
        <video
          ref={videoRef}
          controls
          preload="metadata"
          src={videoUrl}
          className="absolute inset-0 w-full h-full"
          data-testid="training-timeline-video"
        />
      </div>

      <div>
        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-stone-500 mb-2">
          <span>Checkpoint timeline</span>
          <span data-testid="training-timeline-time">
            {formatSeconds(currentTime)} / {formatSeconds(duration)}
          </span>
        </div>
        <div
          className="relative h-10 rounded-md border border-stone-200 bg-gradient-to-r from-stone-50 via-stone-100 to-stone-50"
          data-testid="training-timeline-track"
        >
          {/* Playhead */}
          <div
            className="absolute top-0 bottom-0 w-[2px] bg-emerald-600"
            style={{ left: `${(currentTime / safeDuration) * 100}%` }}
            aria-label="Playhead"
          />
          {/* Checkpoint markers */}
          {sortedCheckpoints.map((cp) => {
            const left = Math.min(100, Math.max(0, (cp.atSecond / safeDuration) * 100));
            const selected = editingId === cp.id;
            return (
              <button
                key={cp.id}
                type="button"
                onClick={() => { setEditingId(cp.id); handleJumpTo(cp.atSecond); }}
                className={
                  "absolute top-0 bottom-0 -translate-x-1/2 flex flex-col items-center justify-center " +
                  "focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
                }
                style={{ left: `${left}%` }}
                data-testid={`training-timeline-marker-${cp.id}`}
                aria-label={`Checkpoint at ${formatSeconds(cp.atSecond)}${cp.label ? `: ${cp.label}` : ""}`}
              >
                <span
                  className={
                    "block w-[3px] h-full rounded-full " +
                    (selected ? "bg-amber-700" : cp.requiredToProceed ? "bg-amber-500" : "bg-stone-400")
                  }
                />
                <span
                  className={
                    "absolute -top-5 text-[10px] font-mono px-1 rounded " +
                    (selected ? "bg-amber-200 text-amber-900" : "bg-white text-stone-700 border border-stone-200")
                  }
                >
                  {formatSeconds(cp.atSecond)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="text-xs text-stone-500">
            {sortedCheckpoints.length === 0
              ? "No checkpoints yet. Scrub to a moment and add one."
              : `${sortedCheckpoints.length} checkpoint${sortedCheckpoints.length === 1 ? "" : "s"}`}
          </div>
          {!readOnly && (
            <button
              type="button"
              onClick={handleAddCheckpoint}
              disabled={pending}
              className="btn btn-primary btn-sm"
              data-testid="training-timeline-add"
            >
              + Add checkpoint at {formatSeconds(currentTime)}
            </button>
          )}
        </div>
      </div>

      {editingCheckpoint && (
        <CheckpointEditorPanel
          key={editingCheckpoint.id}
          courseId={courseId}
          versionId={versionId}
          checkpoint={editingCheckpoint}
          questions={questionsByCheckpointId[editingCheckpoint.id] ?? []}
          categorySuggestions={categorySuggestions}
          duration={duration}
          disabled={!!readOnly || pending}
          onJumpTo={handleJumpTo}
          onUpdate={(patch) => handleUpdate(editingCheckpoint.id, patch)}
          onDelete={() => handleDelete(editingCheckpoint.id)}
          onClose={() => setEditingId(null)}
          createQuestionAction={createQuestionAction}
          updateQuestionAction={updateQuestionAction}
          deleteQuestionAction={deleteQuestionAction}
        />
      )}

      {sortedCheckpoints.length > 0 && (
        <div className="rounded-md border border-stone-200 overflow-hidden">
          <div className="px-3 py-2 bg-stone-50 border-b border-stone-200 text-[11px] uppercase tracking-[0.18em] text-stone-500">
            All checkpoints
          </div>
          {/* EP-TRAIN-4A §5 (2026-10-30): wrap the 7-column table in a
              scoped horizontal-scroll container so it never pushes the
              page past 390px at mobile.  Table itself keeps a minimum
              width so columns stay readable; only the inner wrapper
              scrolls horizontally when necessary. */}
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm" data-testid="training-timeline-list">
            <thead>
              <tr className="text-left text-xs text-stone-500 border-b border-stone-200">
                <th className="px-3 py-2 font-normal">#</th>
                <th className="px-3 py-2 font-normal">Position</th>
                <th className="px-3 py-2 font-normal">Label</th>
                <th className="px-3 py-2 font-normal">Required</th>
                <th className="px-3 py-2 font-normal">Retries</th>
                <th className="px-3 py-2 font-normal">Questions</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {sortedCheckpoints.map((cp, i) => (
                <tr key={cp.id} className="border-b border-stone-100 last:border-b-0 hover:bg-stone-50">
                  <td className="px-3 py-2 text-stone-500 font-mono text-xs">{i + 1}</td>
                  <td className="px-3 py-2 font-mono text-xs">{formatSeconds(cp.atSecond)}</td>
                  <td className="px-3 py-2">{cp.label ?? <span className="text-stone-400">—</span>}</td>
                  <td className="px-3 py-2">{cp.requiredToProceed ? "Yes" : "No"}</td>
                  <td className="px-3 py-2">{cp.maxRetries}</td>
                  <td className={
                    "px-3 py-2 " + (cp.questionCount === 0 ? "text-amber-700" : "text-stone-700")
                  }>
                    {cp.questionCount}
                    {cp.questionCount === 0 && <span className="ml-1 text-[10px] uppercase tracking-wider">needs 1+</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => { setEditingId(cp.id); handleJumpTo(cp.atSecond); }}
                      className="text-xs underline underline-offset-4 text-stone-700 hover:text-club-ink"
                      data-testid={`training-timeline-row-${cp.id}-edit`}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}

function CheckpointEditorPanel({
  courseId,
  versionId,
  checkpoint,
  questions,
  categorySuggestions,
  duration,
  disabled,
  onJumpTo,
  onUpdate,
  onDelete,
  onClose,
  createQuestionAction,
  updateQuestionAction,
  deleteQuestionAction,
}: {
  courseId: string;
  versionId: string;
  checkpoint: CheckpointSummary;
  questions: QuizQuestion[];
  categorySuggestions: string[];
  duration: number;
  disabled: boolean;
  onJumpTo: (seconds: number) => void;
  onUpdate: (patch: Partial<{
    atSecond: number;
    label: string | null;
    requiredToProceed: boolean;
    maxRetries: number;
  }>) => void;
  onDelete: () => void;
  onClose: () => void;
  createQuestionAction: (courseId: string, versionId: string, formData: FormData) => Promise<void>;
  updateQuestionAction: (courseId: string, versionId: string, questionId: string, formData: FormData) => Promise<void>;
  deleteQuestionAction: (courseId: string, versionId: string, questionId: string) => Promise<void>;
}) {
  const [label, setLabel] = useState(checkpoint.label ?? "");
  const [atSecond, setAtSecond] = useState(checkpoint.atSecond);
  const [requiredToProceed, setRequiredToProceed] = useState(checkpoint.requiredToProceed);
  const [maxRetries, setMaxRetries] = useState(checkpoint.maxRetries);
  const dirty =
    label !== (checkpoint.label ?? "") ||
    atSecond !== checkpoint.atSecond ||
    requiredToProceed !== checkpoint.requiredToProceed ||
    maxRetries !== checkpoint.maxRetries;

  function save() {
    const patch: Partial<{
      atSecond: number;
      label: string | null;
      requiredToProceed: boolean;
      maxRetries: number;
    }> = {};
    if (atSecond !== checkpoint.atSecond) patch.atSecond = atSecond;
    if (label !== (checkpoint.label ?? "")) patch.label = label.trim().length === 0 ? null : label;
    if (requiredToProceed !== checkpoint.requiredToProceed) patch.requiredToProceed = requiredToProceed;
    if (maxRetries !== checkpoint.maxRetries) patch.maxRetries = maxRetries;
    if (Object.keys(patch).length === 0) return;
    onUpdate(patch);
  }

  return (
    <div
      className="rounded-md border-2 border-amber-300 bg-amber-50/60 p-4 space-y-5"
      data-testid={`training-timeline-editor-${checkpoint.id}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-amber-800">Checkpoint</div>
          <div className="text-sm font-medium text-stone-900">
            {checkpoint.label || <span className="text-stone-500">Unlabelled</span>}
            <span className="ml-2 text-xs font-mono text-stone-600">@ {atSecond}s</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-stone-500 hover:text-stone-800 underline underline-offset-4"
          data-testid={`training-timeline-editor-${checkpoint.id}-close`}
        >
          Close
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`cp-${checkpoint.id}-label`}>Label (optional)</label>
          <input
            id={`cp-${checkpoint.id}-label`}
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={100}
            disabled={disabled}
            placeholder="e.g. Hazard identification"
            data-testid={`training-timeline-editor-${checkpoint.id}-label`}
          />
        </div>
        <div>
          <label className="label" htmlFor={`cp-${checkpoint.id}-at`}>Position (seconds)</label>
          <div className="flex items-center gap-2">
            <input
              id={`cp-${checkpoint.id}-at`}
              type="number"
              min={0}
              max={duration > 0 ? Math.floor(duration) : undefined}
              step={1}
              className="input w-32"
              value={atSecond}
              onChange={(e) => setAtSecond(Math.max(0, Math.round(Number(e.target.value) || 0)))}
              disabled={disabled}
              data-testid={`training-timeline-editor-${checkpoint.id}-at`}
            />
            <button
              type="button"
              onClick={() => onJumpTo(atSecond)}
              className="btn btn-secondary btn-sm"
              disabled={disabled}
            >
              Preview
            </button>
          </div>
        </div>
        <div>
          <label className="label" htmlFor={`cp-${checkpoint.id}-retries`}>Max retries</label>
          <input
            id={`cp-${checkpoint.id}-retries`}
            type="number"
            min={0}
            max={10}
            step={1}
            className="input w-24"
            value={maxRetries}
            onChange={(e) => setMaxRetries(Math.max(0, Math.min(10, Math.round(Number(e.target.value) || 0))))}
            disabled={disabled}
            data-testid={`training-timeline-editor-${checkpoint.id}-retries`}
          />
          <p className="mt-1 text-xs text-stone-500">
            Attempts allowed before the employee must restart the segment.
          </p>
        </div>
        <div className="flex items-start gap-3 mt-2 md:mt-6">
          <input
            type="checkbox"
            id={`cp-${checkpoint.id}-req`}
            checked={requiredToProceed}
            onChange={(e) => setRequiredToProceed(e.target.checked)}
            disabled={disabled}
            className="mt-1"
            data-testid={`training-timeline-editor-${checkpoint.id}-required`}
          />
          <label htmlFor={`cp-${checkpoint.id}-req`} className="text-sm text-stone-800">
            Required to proceed
            <span className="block text-xs text-stone-500">
              When on, the employee cannot resume playback until this checkpoint is cleared.
            </span>
          </label>
        </div>
      </div>

      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          className="text-xs text-red-700 hover:text-red-900 underline underline-offset-4"
          data-testid={`training-timeline-editor-${checkpoint.id}-delete`}
        >
          Delete checkpoint
        </button>
        <button
          type="button"
          onClick={save}
          disabled={disabled || !dirty}
          className="btn btn-primary btn-sm"
          data-testid={`training-timeline-editor-${checkpoint.id}-save`}
        >
          Save changes
        </button>
      </div>

      {/* EP-TRAIN-4A §2 (2026-10-30): questions attached to this
          checkpoint are now authored INSIDE the same yellow surface
          as the settings.  The duplicate per-checkpoint questions
          section below "All checkpoints" has been removed. */}
      <div className="pt-4 border-t border-amber-300/70">
        <div className="text-[11px] uppercase tracking-[0.18em] text-amber-800 mb-3" data-testid={`training-timeline-editor-${checkpoint.id}-questions-heading`}>
          Checkpoint questions ({questions.length})
        </div>
        <QuizEditor
          courseId={courseId}
          versionId={versionId}
          checkpointId={checkpoint.id}
          questions={questions}
          disabled={disabled}
          categorySuggestions={categorySuggestions}
          createAction={createQuestionAction}
          updateAction={updateQuestionAction}
          deleteAction={deleteQuestionAction}
          surfaceLabel="checkpoint"
        />
      </div>
    </div>
  );
}

export type { TrainingQuestionType, QuizQuestion };

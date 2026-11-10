"use client";

// EP-TRAIN-4E B1 (2026-10-31) — course-row actions component.
// EP-TRAIN-4Y-AC §3+§5+§6 (2026-11-10):
//   §3B — new "active-published-with-draft" state renders a
//         version-scoped Delete draft that targets the DRAFT version
//         alone, preserving the published version + its employee-
//         training evidence.
//   §5 — confirmation copy updated to the directive's exact phrasing
//        and now identifies the course. For the published-with-draft
//        case the dialog explicitly states the published version will
//        remain available.
//   §6 — error UI stays inline; the action callers are already
//        wrapped so a failure surfaces here as a readable message
//        with a correlation id, never a dashboard crash.
//
// State-aware actions:
//   - "active-draft-only"            → "Delete draft" (hard delete of the whole course)
//   - "active-published-with-draft"  → "Delete draft version" (delete only the DRAFT version)
//   - "active-published"             → "Archive"
//   - "archived" + no history        → "Restore" + optional "Delete permanently"
//
// Server-side checks live in src/lib/hr/training/courses.ts. This
// client component only gates by state + offers an explicit confirm;
// the server is still the source of truth.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  archiveCourseAction,
  restoreCourseAction,
  deleteDraftCourseAction,
  deleteDraftVersionAction,
  permanentlyDeleteCourseAction,
} from "./_actions";

export interface CourseRowActionsProps {
  courseId: string;
  courseCode: string;
  courseTitle: string;
  state:
    | "active-draft-only"
    | "active-published"
    | "active-published-with-draft"
    | "archived";
  /** Whether any TrainingProgress/Attempt/Completion/Assignment rows
   *  exist (any > 0 means permanent delete is unsafe and must be
   *  disabled). */
  hasHistory: boolean;
  /** EP-TRAIN-4Y-AC §3B — version id when the course carries both a
   *  published version AND an unpublished draft. Null otherwise. */
  draftVersionId?: string | null;
}

export default function CourseRowActions({
  courseId,
  courseCode,
  courseTitle,
  state,
  hasHistory,
  draftVersionId,
}: CourseRowActionsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function run(
    _label: string,
    fn: () => Promise<{ ok: true } | { ok: false; error: string; correlationId?: string }>,
  ) {
    setErr(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      router.refresh();
    });
  }

  function onArchive() {
    if (!window.confirm(`Archive "${courseTitle}" (${courseCode})?\n\nThe course will stop being assigned to employees and won't appear in training recommendations.  Existing training history will be preserved and remains available to administrators.  You can restore the course later.`)) return;
    run("archive", () => archiveCourseAction(courseId));
  }

  function onRestore() {
    if (!window.confirm(`Restore "${courseTitle}" (${courseCode})?\n\nThe course will return to the active catalogue and resume being assignable to employees.`)) return;
    run("restore", () => restoreCourseAction(courseId));
  }

  function onDeleteDraft() {
    // EP-TRAIN-4Y-AC §5 (2026-11-10) — directive-specified copy.
    // "Delete this draft? This action cannot be undone." + course
    // identity.
    const msg = `Delete this draft? This action cannot be undone.\n\nCourse: "${courseTitle}" (${courseCode})\n\nThe draft, its questions, checkpoints, AI-generated candidates, generation history, and any uploaded video will be removed.`;
    if (!window.confirm(msg)) return;
    run("delete-draft", () => deleteDraftCourseAction(courseId));
  }

  function onDeleteDraftVersion() {
    if (!draftVersionId) return;
    // EP-TRAIN-4Y-AC §5 (2026-11-10) — published-with-draft copy
    // explicitly states the published version will remain available.
    const msg = `Delete this draft? This action cannot be undone.\n\nCourse: "${courseTitle}" (${courseCode})\n\nOnly the unpublished DRAFT version will be removed.\nThe published version remains available — employee assignments, completions, assessment history, and compliance records are preserved.`;
    if (!window.confirm(msg)) return;
    run("delete-draft-version", () => deleteDraftVersionAction(draftVersionId));
  }

  function onPermanentDelete() {
    const first = window.prompt(
      `Permanently delete "${courseTitle}" (${courseCode})?\n\nThis cannot be undone.  Type the course code (${courseCode}) to confirm you want to delete every version, question, checkpoint, and video for this course:`,
      "",
    );
    if (first !== courseCode) return;
    if (!window.confirm(`FINAL CHECK: permanently delete "${courseTitle}" and all its versions?`)) return;
    run("permanent-delete", () => permanentlyDeleteCourseAction(courseId));
  }

  return (
    <div className="flex flex-col items-end gap-1" data-testid={`training-course-row-actions-${courseId}`}>
      <div className="flex items-center gap-3">
        {(state === "active-published" || state === "active-published-with-draft") && (
          <button
            type="button"
            onClick={onArchive}
            disabled={isPending}
            className="text-xs text-stone-500 hover:text-amber-900 underline underline-offset-4"
            data-testid={`training-course-archive-${courseId}`}
          >
            Archive
          </button>
        )}
        {state === "active-published-with-draft" && draftVersionId && (
          <button
            type="button"
            onClick={onDeleteDraftVersion}
            disabled={isPending}
            className="text-xs text-stone-500 hover:text-red-800 underline underline-offset-4"
            data-testid={`training-course-delete-draft-version-${courseId}`}
            title="Delete only the unpublished draft version. The published version remains available."
          >
            Delete draft version
          </button>
        )}
        {state === "active-draft-only" && !hasHistory && (
          <button
            type="button"
            onClick={onDeleteDraft}
            disabled={isPending}
            className="text-xs text-stone-500 hover:text-red-800 underline underline-offset-4"
            data-testid={`training-course-delete-draft-${courseId}`}
          >
            Delete draft
          </button>
        )}
        {state === "archived" && (
          <>
            <button
              type="button"
              onClick={onRestore}
              disabled={isPending}
              className="text-xs text-stone-500 hover:text-emerald-900 underline underline-offset-4"
              data-testid={`training-course-restore-${courseId}`}
            >
              Restore
            </button>
            {!hasHistory && (
              <button
                type="button"
                onClick={onPermanentDelete}
                disabled={isPending}
                className="text-xs text-stone-500 hover:text-red-800 underline underline-offset-4"
                data-testid={`training-course-delete-permanent-${courseId}`}
                title="Only enabled when the course has no legitimate training history."
              >
                Delete permanently
              </button>
            )}
          </>
        )}
      </div>
      {err && (
        <span
          role="alert"
          className="text-[11px] text-red-700 max-w-[320px]"
          data-testid={`training-course-row-error-${courseId}`}
        >
          {err}
        </span>
      )}
    </div>
  );
}

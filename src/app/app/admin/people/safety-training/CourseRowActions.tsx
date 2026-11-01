"use client";

// EP-TRAIN-4E B1 (2026-10-31) — course-row actions component.
//
// Discreet inline actions on each row of the Safety & Training
// catalogue.  Follows the house convention (inline buttons +
// window.confirm, no bespoke modal primitive — see
// src/app/app/admin/governance/monthly-package/archive/RowActions.tsx
// for the canonical reference pattern).
//
// State-aware actions:
//   - active DRAFT without publish history → "Delete draft" (hard delete)
//   - active PUBLISHED → "Archive"
//   - archived (course.retiredAt !== null) → "Restore"
//   - any state WITH zero history → optional "Permanent delete" (secondary)
//
// Edit/View is handled by the parent row's main link; this component
// renders the destructive / lifecycle controls only.
//
// Server-side checks live in src/lib/hr/training/courses.ts.  This
// client component only gates by state + offers an explicit confirm;
// the server is still the source of truth.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  archiveCourseAction,
  restoreCourseAction,
  deleteDraftCourseAction,
  permanentlyDeleteCourseAction,
} from "./_actions";

export interface CourseRowActionsProps {
  courseId: string;
  courseCode: string;
  courseTitle: string;
  state: "active-draft-only" | "active-published" | "archived";
  /** Whether any TrainingProgress/Attempt/Completion/Assignment rows
   *  exist (any > 0 means permanent delete is unsafe and must be
   *  disabled). */
  hasHistory: boolean;
}

export default function CourseRowActions({
  courseId,
  courseCode,
  courseTitle,
  state,
  hasHistory,
}: CourseRowActionsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function run(label: string, fn: () => Promise<{ ok: true } | { ok: false; error: string }>) {
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
    if (!window.confirm(`Delete the draft course "${courseTitle}" (${courseCode})?\n\nThis cannot be undone.  The draft, its questions, checkpoints, and any uploaded video will be removed.`)) return;
    run("delete-draft", () => deleteDraftCourseAction(courseId));
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
        {state === "active-published" && (
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
          className="text-[11px] text-red-700"
          data-testid={`training-course-row-error-${courseId}`}
        >
          {err}
        </span>
      )}
    </div>
  );
}

"use client";

// HR-2C B5 (2026-08-28) — Manual "Assign training" affordance on the
// Employee Profile → Training tab. Wraps the canonical
// `assignCourseToEmployee` writer via a server action supplied by the
// parent page. This component owns only the small select-and-confirm
// UX; every authority decision (permission gate, cross-Club refusal,
// duplicate protection, audit) lives inside the canonical writer.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Course { id: string; code: string; title: string; }

interface Props {
  employeeId: string;
  courses: Course[];
  alreadyAssignedCourseIds: string[];
  action: (input: { courseId: string; note?: string | null }) => Promise<
    { ok: true; alreadyAssigned: boolean } | { ok: false; error: string }
  >;
}

export default function AssignTrainingButton({
  employeeId, courses, alreadyAssignedCourseIds, action,
}: Props) {
  const [open, setOpen] = useState(false);
  const [courseId, setCourseId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const alreadySet = new Set(alreadyAssignedCourseIds);

  void employeeId;

  if (!open) {
    return (
      <button
        type="button"
        className="text-xs text-emerald-800 hover:text-emerald-900 underline underline-offset-4"
        onClick={() => { setOpen(true); setError(null); setInfo(null); }}
        data-testid="btn-assign-training"
      >
        + Assign training
      </button>
    );
  }

  return (
    <div className="ml-4 flex flex-wrap items-end gap-2" data-testid="assign-training-form">
      <label className="text-xs text-stone-500">
        Course
        <select
          value={courseId}
          onChange={(e) => setCourseId(e.target.value)}
          className="input mt-1"
          data-testid="assign-training-course"
        >
          <option value="">Select a course…</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
              {alreadySet.has(c.id) ? " (already assigned)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-stone-500 grow max-w-xs">
        Note (optional)
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={200}
          className="input mt-1 w-full"
          placeholder="Reason or context"
          data-testid="assign-training-note"
        />
      </label>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={pending || !courseId}
        onClick={() => {
          setError(null); setInfo(null);
          startTransition(async () => {
            const result = await action({ courseId, note: note.trim() || null });
            if (result.ok) {
              if (result.alreadyAssigned) {
                setInfo("Course was already assigned — no change.");
              } else {
                setOpen(false);
                setCourseId(""); setNote("");
                router.refresh();
              }
            } else {
              setError(result.error);
            }
          });
        }}
        data-testid="assign-training-submit"
      >
        {pending ? "Assigning…" : "Assign"}
      </button>
      <button
        type="button"
        className="text-xs text-stone-500 underline"
        onClick={() => {
          setOpen(false); setCourseId(""); setNote("");
          setError(null); setInfo(null);
        }}
      >
        Cancel
      </button>
      {info && (
        <p className="w-full text-xs text-stone-600" role="status" data-testid="assign-training-info">
          {info}
        </p>
      )}
      {error && (
        <p className="w-full text-xs text-red-700" role="alert" data-testid="assign-training-error">
          {error}
        </p>
      )}
    </div>
  );
}

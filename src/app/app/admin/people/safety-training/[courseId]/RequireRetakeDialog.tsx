"use client";

// EP-TRAIN-5B (2026-11-01) — Require Retake administrative dialog.
//
// Opens from the course detail page's "Require Retake" button. The
// flow is:
//
//   1. Manager picks employees from the applicability roster.
//   2. Manager fills in a mandatory reason + optional due date.
//   3. Manager clicks "Review" -- the dialog calls the server
//      previewRetakeAction which returns per-employee latest
//      completion + any outstanding obligations currently in place.
//      The manager sees the full conflict picture.
//   4. Manager clicks "Confirm & Issue" -- a SINGLE server-generated
//      event id covers the whole submission so double-clicks are
//      idempotent.
//
// Terminology is professional / department-manager level.  State-
// machine names, "issuanceKey", database field names, "MANUAL_REINSTATE"
// are intentionally never surfaced in the UI copy.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { previewRetakeAction, requireRetakeAction } from "../_actions";
import type { EmployeeRetakePreviewRow } from "@/lib/hr/training/revisions";

export interface RosterOption {
  id: string;
  displayName: string;
  employeeNumber: string;
  statusLabel: string;
}

interface Props {
  courseId: string;
  courseTitle: string;
  roster: ReadonlyArray<RosterOption>;
}

type PreviewRow = EmployeeRetakePreviewRow;

export default function RequireRetakeDialog({ courseId, courseTitle, roster }: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"pick" | "review" | "success">("pick");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<ReadonlyArray<PreviewRow>>([]);
  const [error, setError] = useState<string | null>(null);
  // EP-TRAIN-5B-1 — per-employee conflict resolution choice, populated
  // in the review step when the preview surfaces prior OUTSTANDING
  // obligations for that employee.  Shape: { [employeeId]: "KEEP_BOTH" | "REPLACE" }.
  const [conflictChoice, setConflictChoice] = useState<Record<string, "KEEP_BOTH" | "REPLACE">>({});
  const [confirmedResult, setConfirmedResult] = useState<{
    eventId: string; obligationCount: number;
    canceledPriorCount: number; keptBothCount: number;
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function reset() {
    setStep("pick");
    setSelectedIds(new Set());
    setReason("");
    setDueAt("");
    setFilter("");
    setPreview([]);
    setError(null);
    setConfirmedResult(null);
    setConflictChoice({});
  }

  const filtered = filter
    ? roster.filter((r) =>
        r.displayName.toLowerCase().includes(filter.toLowerCase())
        || r.employeeNumber.toLowerCase().includes(filter.toLowerCase()))
    : roster;

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function goToReview() {
    setError(null);
    if (selectedIds.size === 0) { setError("Select at least one employee."); return; }
    if (reason.trim().length === 0) { setError("Enter a reason for the retake."); return; }
    startTransition(async () => {
      const result = await previewRetakeAction(courseId, JSON.stringify(Array.from(selectedIds)));
      if (!result.ok) { setError(result.error); return; }
      setPreview(result.preview.rows as PreviewRow[]);
      setStep("review");
    });
  }

  function confirm() {
    setError(null);
    // EP-TRAIN-5B-1 — every employee flagged as having a prior
    // OUTSTANDING obligation MUST have a conflict resolution picked
    // before we can submit.
    const unresolved = preview
      .filter((p) => p.existingOutstandingObligations.length > 0)
      .filter((p) => !conflictChoice[p.employeeId]);
    if (unresolved.length > 0) {
      setError(`Pick "Keep both" or "Replace" for ${unresolved.length} employee${unresolved.length === 1 ? "" : "s"} with existing requirements.`);
      return;
    }
    const fd = new FormData();
    for (const id of selectedIds) fd.append("employeeId", id);
    fd.set("reason", reason.trim());
    if (dueAt) fd.set("dueAt", dueAt);
    for (const [empId, choice] of Object.entries(conflictChoice)) {
      fd.set(`conflictResolution:${empId}`, choice);
    }
    startTransition(async () => {
      const result = await requireRetakeAction(courseId, fd);
      if (!result.ok) { setError(result.error); return; }
      setConfirmedResult(result);
      setStep("success");
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => { setOpen(true); reset(); }}
        data-testid="training-require-retake-open"
      >
        Require retake
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          data-testid="training-require-retake-dialog"
          role="dialog" aria-modal="true" aria-labelledby="require-retake-title"
        >
          <div className="w-full max-w-2xl rounded-lg bg-white shadow-xl max-h-[90vh] flex flex-col">
            <div className="px-6 pt-5 pb-4 border-b border-stone-200">
              <h2 id="require-retake-title" className="font-serif text-xl text-club-ink">
                Require retake — {courseTitle}
              </h2>
              <p className="mt-1 text-sm text-stone-600">
                {step === "pick" && "Pick the employees who should repeat this training. Enter a reason the manager will record for audit."}
                {step === "review" && "Review the employees you are about to require to retake. Historical completions are not changed."}
                {step === "success" && "Retake requirement issued."}
              </p>
            </div>

            {step === "pick" && (
              <>
                <div className="px-6 py-4 space-y-4 overflow-y-auto">
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-stone-500 mb-1">
                      Reason for retake <span className="text-red-600">*</span>
                    </label>
                    <textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
                      rows={3}
                      placeholder="e.g. Refresher following rooftop safety incident on 2026-10-28."
                      data-testid="training-require-retake-reason"
                    />
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-stone-500 mb-1">
                      Deadline (optional)
                    </label>
                    <input
                      type="date"
                      value={dueAt}
                      onChange={(e) => setDueAt(e.target.value)}
                      className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
                      data-testid="training-require-retake-dueAt"
                    />
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wide text-stone-500 mb-1">
                      Employees ({selectedIds.size} selected)
                    </label>
                    <input
                      type="search"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Filter by name or ID"
                      className="w-full rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm mb-2"
                      data-testid="training-require-retake-filter"
                    />
                    <div className="max-h-56 overflow-y-auto rounded-md border border-stone-200 bg-stone-50 p-2">
                      {filtered.length === 0 ? (
                        <p className="text-xs text-stone-500 px-2 py-3">
                          {roster.length === 0 ? "No employees are applicable for this course." : "No employees match that search."}
                        </p>
                      ) : (
                        <ul className="space-y-1 text-sm">
                          {filtered.map((e) => (
                            <li key={e.id}>
                              <label className="flex items-center gap-2 px-1 py-1 rounded hover:bg-stone-100 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={selectedIds.has(e.id)}
                                  onChange={() => toggle(e.id)}
                                  data-testid={`training-require-retake-select-${e.employeeNumber}`}
                                />
                                <span className="flex-1">
                                  <span className="text-club-ink">{e.displayName}</span>
                                  <span className="ml-2 text-xs text-stone-500 font-mono">{e.employeeNumber}</span>
                                </span>
                                <span className="text-[11px] text-stone-500">{e.statusLabel}</span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                  {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="training-require-retake-error">{error}</div>}
                </div>
                <div className="px-6 py-4 border-t border-stone-200 flex items-center justify-end gap-2">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={goToReview}
                    disabled={pending || selectedIds.size === 0 || reason.trim().length === 0}
                    data-testid="training-require-retake-review"
                  >
                    {pending ? "Loading…" : "Review"}
                  </button>
                </div>
              </>
            )}

            {step === "review" && (
              <>
                <div className="px-6 py-4 space-y-3 overflow-y-auto">
                  <div className="rounded-md bg-stone-50 border border-stone-200 px-4 py-3 text-xs text-stone-700">
                    <div><strong>Reason:</strong> {reason}</div>
                    {dueAt && <div className="mt-1"><strong>Deadline:</strong> {new Date(dueAt).toLocaleDateString()}</div>}
                  </div>
                  <table className="table-base w-full">
                    <thead>
                      <tr>
                        <th className="text-left">Employee</th>
                        <th className="text-left">Latest completion</th>
                        <th className="text-left">Existing requirement</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((p) => (
                        <tr key={p.employeeId} data-testid={`training-require-retake-review-${p.employeeNumber}`}>
                          <td>
                            {p.displayName}
                            <div className="text-xs text-stone-500 font-mono">{p.employeeNumber}</div>
                          </td>
                          <td className="text-xs">
                            {p.latestCompletion
                              ? `v${p.latestCompletion.versionNumber} · ${p.latestCompletion.completedAt.toLocaleDateString()} · ${p.latestCompletion.score}%`
                              : <span className="text-stone-500">Never completed</span>}
                          </td>
                          <td className="text-xs">
                            {p.existingOutstandingObligations.length === 0
                              ? <span className="text-stone-500">None</span>
                              : (
                                <div className="space-y-2" data-testid={`training-require-retake-conflict-${p.employeeNumber}`}>
                                  {p.existingOutstandingObligations.map((o) => (
                                    <div key={o.obligationId} className="text-amber-800">
                                      {o.reason === "REVISION" ? "Updated training required" : o.reason === "MANUAL_REINSTATE" ? "Retake required" : o.reason}
                                      {" · v"}{o.versionNumber}
                                      {" · issued "}{o.issuedAt.toLocaleDateString()}
                                      {o.reasonNote && <span className="block text-[10px] text-stone-500">“{o.reasonNote.slice(0, 60)}{o.reasonNote.length > 60 ? "…" : ""}”</span>}
                                    </div>
                                  ))}
                                  {/* EP-TRAIN-5B-1 — mandatory conflict choice. */}
                                  <div className="mt-2 rounded border border-stone-200 bg-white px-2 py-2">
                                    <div className="text-[10px] uppercase tracking-wide text-stone-500 mb-1">
                                      How should this be handled?
                                    </div>
                                    <label className="flex items-start gap-2 py-0.5 cursor-pointer">
                                      <input
                                        type="radio"
                                        name={`conflict-${p.employeeId}`}
                                        value="KEEP_BOTH"
                                        checked={conflictChoice[p.employeeId] === "KEEP_BOTH"}
                                        onChange={() => setConflictChoice((prev) => ({ ...prev, [p.employeeId]: "KEEP_BOTH" }))}
                                        className="mt-0.5"
                                        data-testid={`training-conflict-${p.employeeNumber}-keep-both`}
                                      />
                                      <span className="text-stone-700">
                                        <strong>Keep both.</strong> Employee will need two separate completions.
                                      </span>
                                    </label>
                                    <label className="flex items-start gap-2 py-0.5 cursor-pointer">
                                      <input
                                        type="radio"
                                        name={`conflict-${p.employeeId}`}
                                        value="REPLACE"
                                        checked={conflictChoice[p.employeeId] === "REPLACE"}
                                        onChange={() => setConflictChoice((prev) => ({ ...prev, [p.employeeId]: "REPLACE" }))}
                                        className="mt-0.5"
                                        data-testid={`training-conflict-${p.employeeNumber}-replace`}
                                      />
                                      <span className="text-stone-700">
                                        <strong>Replace existing.</strong> Cancel the prior requirement, issue this new one.
                                      </span>
                                    </label>
                                  </div>
                                </div>
                              )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
                </div>
                <div className="px-6 py-4 border-t border-stone-200 flex items-center justify-between gap-2">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setStep("pick")} disabled={pending}>Back</button>
                  <div className="flex items-center gap-2">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={confirm}
                      disabled={pending}
                      data-testid="training-require-retake-confirm"
                    >
                      {pending ? "Issuing…" : `Confirm & issue (${selectedIds.size})`}
                    </button>
                  </div>
                </div>
              </>
            )}

            {step === "success" && confirmedResult && (
              <div className="px-6 py-6 space-y-3" data-testid="training-require-retake-success">
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                  <div className="font-medium">Retake requirement issued.</div>
                  <div className="mt-1 space-y-0.5">
                    <div>{confirmedResult.obligationCount} new requirement{confirmedResult.obligationCount === 1 ? "" : "s"} created.</div>
                    {confirmedResult.canceledPriorCount > 0 && (
                      <div>{confirmedResult.canceledPriorCount} prior requirement{confirmedResult.canceledPriorCount === 1 ? "" : "s"} canceled.</div>
                    )}
                    {confirmedResult.keptBothCount > 0 && (
                      <div>{confirmedResult.keptBothCount} employee{confirmedResult.keptBothCount === 1 ? "" : "s"} kept their existing requirement in addition to the new one.</div>
                    )}
                    <div>Historical completions were not changed.</div>
                  </div>
                </div>
                <div className="flex justify-end">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => { setOpen(false); router.refresh(); }}>Close</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

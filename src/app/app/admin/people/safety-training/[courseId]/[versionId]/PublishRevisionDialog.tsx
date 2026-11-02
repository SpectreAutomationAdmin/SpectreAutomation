"use client";

// EP-TRAIN-5B (2026-11-01) — Revision publication confirmation dialog.
//
// Replaces the simple one-click Publish button on DRAFT versions
// that are being published AS A REVISION (i.e. a prior PUBLISHED
// version exists for the same course).  Presents three options:
//
//   A. Require all applicable employees to complete the revised version
//   B. Require only employees who have not previously completed the course
//   C. Require selected employees
//
// Delegates the issuance to the publishDraftWithPolicyAction server
// action; also surfaces the counts so a department manager sees how
// many obligations they are about to issue before confirming.
//
// This component never names the server state-machine fields
// (REVISION, OUTSTANDING, issuanceKey) in copy -- those are
// implementation details.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { publishDraftWithPolicyAction } from "../../_actions";

type Policy = "ALL_APPLICABLE" | "NON_COMPLETERS" | "SELECTED";

export interface EmployeeOption {
  id: string;
  displayName: string;
  employeeNumber: string;
  latestCompletionAt: Date | null;
}

interface Props {
  courseId: string;
  versionId: string;
  versionNumber: number;
  priorVersionNumber: number;
  applicableEmployees: ReadonlyArray<EmployeeOption>;
  previousCompleterCount: number;
}

export default function PublishRevisionDialog({
  courseId, versionId, versionNumber, priorVersionNumber,
  applicableEmployees, previousCompleterCount,
}: Props) {
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<Policy>("ALL_APPLICABLE");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ eventId: string; affectedCount: number } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const totalApplicable = applicableEmployees.length;
  const nonCompleterCount = totalApplicable - previousCompleterCount;

  function toggleEmployee(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function submit() {
    setError(null);
    const fd = new FormData();
    fd.set("policy", policy);
    if (policy === "SELECTED") {
      if (selectedIds.size === 0) {
        setError("Select at least one employee.");
        return;
      }
      for (const id of selectedIds) fd.append("selectedEmployeeId", id);
    }
    startTransition(async () => {
      const result = await publishDraftWithPolicyAction(courseId, versionId, fd);
      if (result.ok) {
        setSuccess({ eventId: result.eventId, affectedCount: result.affectedCount });
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  const effectiveCount = policy === "ALL_APPLICABLE" ? totalApplicable
    : policy === "NON_COMPLETERS" ? nonCompleterCount
      : selectedIds.size;

  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => { setOpen(true); setSuccess(null); setError(null); }}
        data-testid="training-publish-revision-open"
      >
        Publish this version
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          data-testid="training-publish-revision-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="publish-rev-title"
        >
          <div className="w-full max-w-xl rounded-lg bg-white shadow-xl">
            <div className="px-6 pt-5 pb-4 border-b border-stone-200">
              <h2 id="publish-rev-title" className="font-serif text-xl text-club-ink">
                Publish version {versionNumber}
              </h2>
              <p className="mt-1 text-sm text-stone-600">
                You are publishing a revision of a course that has already been
                in use. Please choose how this change should apply to employees
                who completed version {priorVersionNumber}.
              </p>
            </div>

            {success ? (
              <div className="px-6 py-6 space-y-3" data-testid="training-publish-revision-success">
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                  <div className="font-medium">Published.</div>
                  <div className="mt-1">
                    {success.affectedCount === 0
                      ? "No employees needed a new requirement for this revision."
                      : `New requirement issued to ${success.affectedCount} employee${success.affectedCount === 1 ? "" : "s"}.`}
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => { setOpen(false); router.refresh(); }}
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="px-6 py-4 space-y-3">
                  <label className="block cursor-pointer rounded-md border border-stone-200 bg-white px-4 py-3 hover:border-stone-300">
                    <div className="flex items-start gap-3">
                      <input
                        type="radio" name="policy" value="ALL_APPLICABLE"
                        checked={policy === "ALL_APPLICABLE"}
                        onChange={() => setPolicy("ALL_APPLICABLE")}
                        className="mt-1"
                        data-testid="training-publish-policy-ALL_APPLICABLE"
                      />
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-club-ink">
                          Require all applicable employees to complete the revised version
                        </div>
                        <div className="mt-0.5 text-xs text-stone-600">
                          Historical completions are preserved. Every employee the
                          course currently applies to will receive a new requirement.
                        </div>
                        <div className="mt-1 text-xs text-stone-500">
                          {totalApplicable} employee{totalApplicable === 1 ? "" : "s"} currently applicable.
                        </div>
                      </div>
                    </div>
                  </label>

                  <label className="block cursor-pointer rounded-md border border-stone-200 bg-white px-4 py-3 hover:border-stone-300">
                    <div className="flex items-start gap-3">
                      <input
                        type="radio" name="policy" value="NON_COMPLETERS"
                        checked={policy === "NON_COMPLETERS"}
                        onChange={() => setPolicy("NON_COMPLETERS")}
                        className="mt-1"
                        data-testid="training-publish-policy-NON_COMPLETERS"
                      />
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-club-ink">
                          Require only employees who have not previously completed the course
                        </div>
                        <div className="mt-0.5 text-xs text-stone-600">
                          Employees who completed version {priorVersionNumber} remain
                          compliant. Everyone else will receive the new requirement.
                        </div>
                        <div className="mt-1 text-xs text-stone-500">
                          {nonCompleterCount} of {totalApplicable} would receive a new requirement.
                        </div>
                      </div>
                    </div>
                  </label>

                  <label className="block cursor-pointer rounded-md border border-stone-200 bg-white px-4 py-3 hover:border-stone-300">
                    <div className="flex items-start gap-3">
                      <input
                        type="radio" name="policy" value="SELECTED"
                        checked={policy === "SELECTED"}
                        onChange={() => setPolicy("SELECTED")}
                        className="mt-1"
                        data-testid="training-publish-policy-SELECTED"
                      />
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-club-ink">
                          Require selected employees
                        </div>
                        <div className="mt-0.5 text-xs text-stone-600">
                          Pick specific people to receive the new requirement.
                        </div>
                      </div>
                    </div>
                  </label>

                  {policy === "SELECTED" && (
                    <div
                      className="mt-3 max-h-56 overflow-y-auto rounded-md border border-stone-200 bg-stone-50 p-3"
                      data-testid="training-publish-selected-list"
                    >
                      {applicableEmployees.length === 0 ? (
                        <p className="text-xs text-stone-500">
                          No employees are currently applicable for this course.
                        </p>
                      ) : (
                        <ul className="space-y-1 text-sm">
                          {applicableEmployees.map((e) => (
                            <li key={e.id}>
                              <label className="flex items-center gap-2 px-1 py-1 rounded hover:bg-stone-100 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={selectedIds.has(e.id)}
                                  onChange={() => toggleEmployee(e.id)}
                                  data-testid={`training-publish-select-${e.employeeNumber}`}
                                />
                                <span className="flex-1">
                                  <span className="text-club-ink">{e.displayName}</span>
                                  <span className="ml-2 text-xs text-stone-500 font-mono">{e.employeeNumber}</span>
                                </span>
                                {e.latestCompletionAt && (
                                  <span className="text-[11px] text-stone-500">
                                    Completed {e.latestCompletionAt.toLocaleDateString()}
                                  </span>
                                )}
                              </label>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  <div className="rounded-md bg-stone-50 border border-stone-200 px-4 py-3 text-xs text-stone-700" data-testid="training-publish-revision-summary">
                    <div><strong>Summary.</strong> {effectiveCount === 0
                      ? "No employees will receive a new requirement."
                      : `${effectiveCount} employee${effectiveCount === 1 ? "" : "s"} will receive a new requirement.`}
                    </div>
                    <div className="mt-1">Historical completions will be preserved exactly as they are.</div>
                  </div>

                  {error && (
                    <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="training-publish-revision-error">
                      {error}
                    </div>
                  )}
                </div>
                <div className="px-6 py-4 border-t border-stone-200 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setOpen(false)}
                    disabled={pending}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={submit}
                    disabled={pending || (policy === "SELECTED" && selectedIds.size === 0)}
                    data-testid="training-publish-revision-confirm"
                  >
                    {pending ? "Publishing…" : "Publish version"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

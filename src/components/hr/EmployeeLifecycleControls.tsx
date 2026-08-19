// HR-2B.3.6 (2026-08-19) — Admin-facing Delete / Archive controls.
//
// Renders the context-appropriate action based on the server-computed
// `deleteEligibility` prop. The two verbs are NEVER shown together:
//
//   eligibility.eligible === true  → Delete employee  (destructive, red)
//   eligibility.eligible === false → Archive employee (destructive-lite,
//                                     amber; explains why hard delete
//                                     is refused in the confirmation).
//
// Confirmation copy is stronger for Delete than for Archive, per
// founder brief §2.4.

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export interface EmployeeDeleteEligibility {
  eligible: boolean;
  reason?:
    | "onboarding_completed"
    | "has_payroll_lines"
    | "has_timesheet_entries"
    | "has_employment_period_activated";
}

interface Props {
  employeeId: string;
  employeeName: string;
  eligibility: EmployeeDeleteEligibility;
  currentLifecycle: string;
}

function reasonToCopy(reason?: EmployeeDeleteEligibility["reason"]): string {
  switch (reason) {
    case "onboarding_completed":
      return "Onboarding has been submitted, so hard delete is refused. Archive keeps every history record — payroll, tax, and audit — but removes the employee from the active directory.";
    case "has_payroll_lines":
      return "Payroll history exists for this employee, so hard delete is refused. Archive preserves every posted pay period and audit entry.";
    case "has_timesheet_entries":
      return "Timesheet entries exist for this employee, so hard delete is refused. Archive preserves them.";
    case "has_employment_period_activated":
      return "An active employment period is on file. Archive is the safe option.";
    default:
      return "Archive preserves every history record — payroll, tax, and audit — but removes the employee from the active directory.";
  }
}

export default function EmployeeLifecycleControls(props: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (props.currentLifecycle === "ARCHIVED") {
    return (
      <div
        data-testid="employee-lifecycle-archived"
        className="rounded-md border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-600"
      >
        This employee is archived. History is preserved and can still be
        viewed from the directory&apos;s Archived filter.
      </div>
    );
  }

  const isDelete = props.eligibility.eligible;
  const actionLabel = isDelete ? "Delete employee" : "Archive employee";
  const confirmVerb = isDelete ? "DELETE" : "ARCHIVE";

  async function runAction() {
    setError(null);
    startTransition(async () => {
      try {
        const res = isDelete
          ? await fetch(`/api/people/employees/${props.employeeId}/lifecycle`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
              credentials: "same-origin",
            })
          : await fetch(`/api/people/employees/${props.employeeId}/lifecycle`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "archive" }),
              credentials: "same-origin",
            });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setError(typeof j.error === "string" ? j.error : "Could not complete the action.");
          return;
        }
        // Hard delete removes the row; archive keeps it. Both send us
        // back to the directory.
        router.push("/app/admin/people/employees");
        router.refresh();
      } catch {
        setError("Network error — please try again.");
      }
    });
  }

  return (
    <section
      data-testid="employee-lifecycle-controls"
      className="mt-8 rounded-md border border-stone-200 bg-white px-4 py-4"
    >
      <h3 className="text-sm font-medium text-stone-900">Employee lifecycle</h3>
      <p className="mt-1 text-xs text-stone-500">
        {isDelete
          ? "This employee has not completed onboarding and has no payroll or timesheet history. You can delete them from the directory."
          : "This employee is past the point where hard delete is safe."}{" "}
        {!isDelete && reasonToCopy(props.eligibility.reason)}
      </p>
      {!showConfirm ? (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setError(null);
              setShowConfirm(true);
              setConfirmText("");
            }}
            data-testid={isDelete ? "employee-delete-button" : "employee-archive-button"}
            className={
              isDelete
                ? "rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
                : "rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-50"
            }
          >
            {actionLabel}
          </button>
        </div>
      ) : (
        <div
          data-testid="employee-lifecycle-confirm"
          className={`mt-3 rounded-md border px-3 py-3 ${
            isDelete ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"
          }`}
        >
          {isDelete ? (
            <p className="text-sm text-red-900">
              This will permanently delete <strong>{props.employeeName}</strong>
              &nbsp;and every onboarding record on file. This cannot be undone.
              Type <span className="font-mono">DELETE</span> below to confirm.
            </p>
          ) : (
            <p className="text-sm text-amber-900">
              Archive <strong>{props.employeeName}</strong>? The employee will
              disappear from the active directory. All history is preserved and
              they remain retrievable via the Archived filter. Type{" "}
              <span className="font-mono">ARCHIVE</span> below to confirm.
            </p>
          )}
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
            placeholder={confirmVerb}
            data-testid="employee-lifecycle-confirm-input"
            className="mt-3 block w-40 rounded-md border border-stone-300 bg-white px-2 py-1 text-sm font-mono text-stone-900 focus:border-stone-500 focus:ring-1 focus:ring-stone-500"
          />
          {error && (
            <p className="mt-2 text-xs text-red-700" role="alert">
              {error}
            </p>
          )}
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={runAction}
              disabled={confirmText !== confirmVerb || isPending}
              data-testid="employee-lifecycle-confirm-button"
              className={
                isDelete
                  ? "rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
                  : "rounded-md bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-50 disabled:cursor-not-allowed"
              }
            >
              {isPending ? "Working…" : isDelete ? "Delete permanently" : "Archive"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowConfirm(false);
                setConfirmText("");
                setError(null);
              }}
              className="text-xs text-stone-500 hover:text-stone-800 underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

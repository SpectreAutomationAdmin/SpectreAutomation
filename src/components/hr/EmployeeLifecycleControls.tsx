// HR-2B.3.6 (2026-08-19) — Admin-facing Delete / Archive controls.
// AUTH-3D.TEST-B.UNBLOCK (2026-09-26) — added Terminate as a
// first-class lifecycle action alongside Archive for ACTIVE employees
// past the point of hard-delete eligibility. Terminate is the
// employment-ending action; Archive is the record-hiding action; both
// coexist for the small set of ACTIVE employees where both are valid.
//
// Renders the context-appropriate action based on the server-computed
// `deleteEligibility` prop + current lifecycle + `canTerminate`:
//
//   currentLifecycle === "ARCHIVED"              → passive banner
//   currentLifecycle === "TERMINATED"            → passive banner + optional Archive (record hide)
//   eligibility.eligible === true                → Delete employee (hard delete)
//   eligibility.eligible === false + canTerminate → Terminate + Archive (side by side)
//   eligibility.eligible === false + !canTerminate → Archive only (existing behavior)
//
// Confirmation copy is stronger for Delete than for Archive; Terminate
// follows the founder-approved AUTH-3D.TEST-B.UNBLOCK §5 structure
// (title + human-language explanation + termination-date + optional
// reason + Terminate/Cancel). Session terminology is deliberately
// absent from the copy — the administrator sees the business
// consequence, not the security implementation.

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatCivilDate } from "@/lib/format/civil-date";

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
  /** AUTH-3D.TEST-B.UNBLOCK — set from server-side
   *  `hasPermission(principal, clubId, "hr:employee:terminate")`.
   *  CLUB_ADMIN + SUPER_ADMIN hold this; CONTROLLER + others do not.
   *  When false, the Terminate branch is not rendered — the admin
   *  sees only Archive (or Delete, if eligible). */
  canTerminate: boolean;
  /** AUTH-3D.TEST-B.UNBLOCK — presented in the terminated-state
   *  banner. Falls back to a generic message if null. */
  terminationDate?: string | null;
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

function todayIsoDate(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function EmployeeLifecycleControls(props: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<"none" | "delete" | "archive" | "terminate">("none");
  const [confirmText, setConfirmText] = useState("");
  const [terminationDate, setTerminationDate] = useState<string>(todayIsoDate());
  const [terminationReason, setTerminationReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  // ------------------------------------------------------------------
  // ARCHIVED passive banner — unchanged from HR-2B.3.6.
  // ------------------------------------------------------------------
  if (props.currentLifecycle === "ARCHIVED") {
    return (
      <section
        data-testid="employee-lifecycle-archived"
        className="mt-8 rounded-md border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-600"
      >
        This employee is archived. History is preserved and can still be
        viewed from the directory&apos;s Archived filter.
      </section>
    );
  }

  // ------------------------------------------------------------------
  // AUTH-3D.TEST-B.UNBLOCK — TERMINATED passive banner. Employment
  // ended but record and history preserved. Terminate no longer
  // available; Archive remains for optional record-hiding.
  // ------------------------------------------------------------------
  if (props.currentLifecycle === "TERMINATED") {
    const dateStr = formatCivilDate(props.terminationDate, { month: "long" });
    return (
      <section
        data-testid="employee-lifecycle-terminated"
        className="mt-8 rounded-md border border-stone-200 bg-white px-4 py-4"
      >
        <h3 className="text-sm font-medium text-stone-900">Employee lifecycle</h3>
        <p className="mt-1 text-sm text-stone-700">
          Employment ended{dateStr ? ` on ${dateStr}` : ""}. Employment,
          payroll, tax, document and audit history are retained.
        </p>
        {/* Optional Archive to remove the terminated record from the
            active directory. Archive is still gated on hr:employee:write
            server-side. */}
        {confirm === "none" ? (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setError(null); setConfirm("archive"); setConfirmText(""); }}
              data-testid="employee-archive-button"
              className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-50"
            >
              Archive employee record
            </button>
          </div>
        ) : (
          <ArchiveConfirm
            employeeName={props.employeeName}
            confirmText={confirmText}
            onChangeConfirm={setConfirmText}
            error={error}
            isPending={isPending}
            onCancel={() => { setConfirm("none"); setConfirmText(""); setError(null); }}
            onSubmit={() => runArchive({ employeeId: props.employeeId, startTransition, setError, router })}
          />
        )}
      </section>
    );
  }

  const isDelete = props.eligibility.eligible;

  // ------------------------------------------------------------------
  // ACTIVE + delete-eligible → Delete only. Unchanged from HR-2B.3.6.
  // ------------------------------------------------------------------
  if (isDelete) {
    return (
      <section
        data-testid="employee-lifecycle-controls"
        className="mt-8 rounded-md border border-stone-200 bg-white px-4 py-4"
      >
        <h3 className="text-sm font-medium text-stone-900">Employee lifecycle</h3>
        <p className="mt-1 text-xs text-stone-500">
          This employee has not completed onboarding and has no payroll
          or timesheet history. You can delete them from the directory.
        </p>
        {confirm === "none" ? (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setError(null); setConfirm("delete"); setConfirmText(""); }}
              data-testid="employee-delete-button"
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
            >
              Delete employee
            </button>
          </div>
        ) : (
          <DeleteConfirm
            employeeName={props.employeeName}
            confirmText={confirmText}
            onChangeConfirm={setConfirmText}
            error={error}
            isPending={isPending}
            onCancel={() => { setConfirm("none"); setConfirmText(""); setError(null); }}
            onSubmit={() => runDelete({ employeeId: props.employeeId, startTransition, setError, router })}
          />
        )}
      </section>
    );
  }

  // ------------------------------------------------------------------
  // ACTIVE + not delete-eligible. Show Terminate (if authorized) +
  // Archive side-by-side, with clear labels differentiating employment-
  // ending vs record-hiding semantics.
  // ------------------------------------------------------------------
  return (
    <section
      data-testid="employee-lifecycle-controls"
      className="mt-8 rounded-md border border-stone-200 bg-white px-4 py-4"
    >
      <h3 className="text-sm font-medium text-stone-900">Employee lifecycle</h3>
      <p className="mt-1 text-xs text-stone-500">
        This employee is past the point where hard delete is safe.
        {" "}{reasonToCopy(props.eligibility.reason)}
      </p>

      {/* Two-action layout: Terminate (employment) + Archive (record). */}
      {confirm === "none" ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {props.canTerminate && (
            <div className="rounded-md border border-stone-200 bg-white px-3 py-3" data-testid="employee-lifecycle-terminate-panel">
              <h4 className="text-sm font-medium text-stone-900">End employment</h4>
              <p className="mt-1 text-xs text-stone-500">
                Ends {props.employeeName}&apos;s employment and removes their
                Employee Portal access. Employment, payroll, tax and audit
                history are retained.
              </p>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => { setError(null); setConfirm("terminate"); setConfirmText(""); setTerminationDate(todayIsoDate()); setTerminationReason(""); }}
                  data-testid="employee-terminate-button"
                  className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
                >
                  Terminate employee
                </button>
              </div>
            </div>
          )}
          <div className="rounded-md border border-stone-200 bg-white px-3 py-3" data-testid="employee-lifecycle-archive-panel">
            <h4 className="text-sm font-medium text-stone-900">Archive record</h4>
            <p className="mt-1 text-xs text-stone-500">
              Removes {props.employeeName} from the active directory. All
              history is preserved and remains retrievable via the Archived
              filter.
            </p>
            <div className="mt-3">
              <button
                type="button"
                onClick={() => { setError(null); setConfirm("archive"); setConfirmText(""); }}
                data-testid="employee-archive-button"
                className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-50"
              >
                Archive employee
              </button>
            </div>
          </div>
        </div>
      ) : confirm === "archive" ? (
        <ArchiveConfirm
          employeeName={props.employeeName}
          confirmText={confirmText}
          onChangeConfirm={setConfirmText}
          error={error}
          isPending={isPending}
          onCancel={() => { setConfirm("none"); setConfirmText(""); setError(null); }}
          onSubmit={() => runArchive({ employeeId: props.employeeId, startTransition, setError, router })}
        />
      ) : (
        <TerminateConfirm
          employeeName={props.employeeName}
          terminationDate={terminationDate}
          onChangeDate={setTerminationDate}
          terminationReason={terminationReason}
          onChangeReason={setTerminationReason}
          confirmText={confirmText}
          onChangeConfirm={setConfirmText}
          error={error}
          isPending={isPending}
          onCancel={() => { setConfirm("none"); setConfirmText(""); setError(null); }}
          onSubmit={() => runTerminate({
            employeeId: props.employeeId,
            terminationDate,
            reason: terminationReason.trim() || undefined,
            startTransition,
            setError,
            router,
          })}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Confirmation subcomponents
// ---------------------------------------------------------------------------

function DeleteConfirm({
  employeeName, confirmText, onChangeConfirm, error, isPending, onCancel, onSubmit,
}: {
  employeeName: string;
  confirmText: string;
  onChangeConfirm: (v: string) => void;
  error: string | null;
  isPending: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      data-testid="employee-lifecycle-confirm"
      data-verb="DELETE"
      className="mt-3 rounded-md border px-3 py-3 border-red-200 bg-red-50"
    >
      <p className="text-sm text-red-900">
        This will permanently delete <strong>{employeeName}</strong> and
        every onboarding record on file. This cannot be undone. Type{" "}
        <span className="font-mono">DELETE</span> below to confirm.
      </p>
      <input
        type="text"
        value={confirmText}
        onChange={(e) => onChangeConfirm(e.target.value.toUpperCase())}
        placeholder="DELETE"
        data-testid="employee-lifecycle-confirm-input"
        className="mt-3 block w-40 rounded-md border border-stone-300 bg-white px-2 py-1 text-sm font-mono text-stone-900 focus:border-stone-500 focus:ring-1 focus:ring-stone-500"
      />
      {error && <p className="mt-2 text-xs text-red-700" role="alert">{error}</p>}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onSubmit}
          disabled={confirmText !== "DELETE" || isPending}
          data-testid="employee-lifecycle-confirm-button"
          className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending ? "Working…" : "Delete permanently"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-stone-500 hover:text-stone-800 underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ArchiveConfirm({
  employeeName, confirmText, onChangeConfirm, error, isPending, onCancel, onSubmit,
}: {
  employeeName: string;
  confirmText: string;
  onChangeConfirm: (v: string) => void;
  error: string | null;
  isPending: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      data-testid="employee-lifecycle-confirm"
      data-verb="ARCHIVE"
      className="mt-3 rounded-md border px-3 py-3 border-amber-200 bg-amber-50"
    >
      <p className="text-sm text-amber-900">
        Archive <strong>{employeeName}</strong>? The employee will
        disappear from the active directory. All history is preserved and
        they remain retrievable via the Archived filter. Type{" "}
        <span className="font-mono">ARCHIVE</span> below to confirm.
      </p>
      <input
        type="text"
        value={confirmText}
        onChange={(e) => onChangeConfirm(e.target.value.toUpperCase())}
        placeholder="ARCHIVE"
        data-testid="employee-lifecycle-confirm-input"
        className="mt-3 block w-40 rounded-md border border-stone-300 bg-white px-2 py-1 text-sm font-mono text-stone-900 focus:border-stone-500 focus:ring-1 focus:ring-stone-500"
      />
      {error && <p className="mt-2 text-xs text-red-700" role="alert">{error}</p>}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onSubmit}
          disabled={confirmText !== "ARCHIVE" || isPending}
          data-testid="employee-lifecycle-confirm-button"
          className="rounded-md bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending ? "Working…" : "Archive"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-stone-500 hover:text-stone-800 underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function TerminateConfirm({
  employeeName, terminationDate, onChangeDate, terminationReason, onChangeReason,
  confirmText, onChangeConfirm, error, isPending, onCancel, onSubmit,
}: {
  employeeName: string;
  terminationDate: string;
  onChangeDate: (v: string) => void;
  terminationReason: string;
  onChangeReason: (v: string) => void;
  confirmText: string;
  onChangeConfirm: (v: string) => void;
  error: string | null;
  isPending: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      data-testid="employee-lifecycle-terminate-confirm"
      className="mt-3 rounded-md border px-3 py-3 border-red-200 bg-red-50"
    >
      <p className="text-sm text-red-900">
        Terminate <strong>{employeeName}</strong>?
      </p>
      <p className="mt-1 text-sm text-red-900">
        Ending {employeeName}&apos;s employment will remove their access
        to the Employee Portal immediately. Their employment, payroll,
        tax, document and audit history will be retained.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-red-900">Termination date</span>
          <input
            type="date"
            value={terminationDate}
            onChange={(e) => onChangeDate(e.target.value)}
            data-testid="employee-terminate-date"
            className="mt-1 block w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-sm text-stone-900 focus:border-stone-500 focus:ring-1 focus:ring-stone-500"
          />
        </label>
        <label className="block">
          <span className="text-xs text-red-900">Reason (optional)</span>
          <input
            type="text"
            value={terminationReason}
            onChange={(e) => onChangeReason(e.target.value)}
            maxLength={200}
            placeholder="e.g. Resignation, End of contract"
            data-testid="employee-terminate-reason"
            className="mt-1 block w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-sm text-stone-900 focus:border-stone-500 focus:ring-1 focus:ring-stone-500"
          />
        </label>
      </div>
      <div className="mt-3">
        <label className="block">
          <span className="text-xs text-red-900">
            Type <span className="font-mono">TERMINATE</span> to confirm.
          </span>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => onChangeConfirm(e.target.value.toUpperCase())}
            placeholder="TERMINATE"
            data-testid="employee-terminate-confirm-input"
            className="mt-1 block w-40 rounded-md border border-stone-300 bg-white px-2 py-1 text-sm font-mono text-stone-900 focus:border-stone-500 focus:ring-1 focus:ring-stone-500"
          />
        </label>
      </div>
      {error && <p className="mt-2 text-xs text-red-700" role="alert">{error}</p>}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onSubmit}
          disabled={confirmText !== "TERMINATE" || !terminationDate || isPending}
          data-testid="employee-terminate-confirm-button"
          className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending ? "Working…" : "Terminate employee"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          data-testid="employee-terminate-cancel-button"
          className="text-xs text-stone-500 hover:text-stone-800 underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action runners — each hits the shared /api/people/employees/[id]/lifecycle
// endpoint with the right verb. Server-side services enforce authorization.
// ---------------------------------------------------------------------------

interface RunnerCtx {
  employeeId: string;
  startTransition: (cb: () => void) => void;
  setError: (v: string | null) => void;
  router: ReturnType<typeof useRouter>;
}

async function callLifecycle(
  employeeId: string,
  init: RequestInit,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`/api/people/employees/${employeeId}/lifecycle`, init);
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    return { ok: false, error: typeof j.error === "string" ? j.error : "Could not complete the action." };
  }
  return { ok: true };
}

function runDelete(ctx: RunnerCtx) {
  ctx.setError(null);
  ctx.startTransition(async () => {
    const r = await callLifecycle(ctx.employeeId, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      credentials: "same-origin",
    }).catch(() => ({ ok: false as const, error: "Network error — please try again." }));
    if (r.ok) {
      ctx.router.push("/app/admin/people/employees");
      ctx.router.refresh();
    } else {
      ctx.setError(r.error);
    }
  });
}

function runArchive(ctx: RunnerCtx) {
  ctx.setError(null);
  ctx.startTransition(async () => {
    const r = await callLifecycle(ctx.employeeId, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "archive" }),
      credentials: "same-origin",
    }).catch(() => ({ ok: false as const, error: "Network error — please try again." }));
    if (r.ok) {
      ctx.router.push("/app/admin/people/employees");
      ctx.router.refresh();
    } else {
      ctx.setError(r.error);
    }
  });
}

function runTerminate(ctx: RunnerCtx & { terminationDate: string; reason?: string }) {
  ctx.setError(null);
  ctx.startTransition(async () => {
    const r = await callLifecycle(ctx.employeeId, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "terminate",
        terminationDate: ctx.terminationDate,
        reason: ctx.reason,
      }),
      credentials: "same-origin",
    }).catch(() => ({ ok: false as const, error: "Network error — please try again." }));
    if (r.ok) {
      // Stay on the profile so the terminated-state UI can render.
      ctx.router.refresh();
    } else {
      ctx.setError(r.error);
    }
  });
}

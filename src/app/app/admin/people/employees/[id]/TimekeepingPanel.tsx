"use client";

// Payroll-3D-1A (2026-09-05) — Timekeeping method admin panel.
// Compact card that reads/writes Employee.timekeepingMethod through
// the canonical hr:employee:write server action. Rendered on the
// employee detail page (Overview/Employment adjacent). Employee
// self-service users never see this — the page's admin permission
// gate excludes them, and the action re-verifies hr:employee:write.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateTimekeepingMethodAction } from "./_timekeeping-actions";

type Method =
  | "NO_TIME_ENTRY_REQUIRED"
  | "CLOCK_REQUIRED"
  | "MANUAL_TIMESHEET"
  | "SCHEDULE_DERIVED";

const OPTIONS: Array<{ value: Method; label: string; hint: string }> = [
  { value: "CLOCK_REQUIRED",         label: "Clock required",        hint: "Employee must use Clock In / Out via the portal." },
  { value: "MANUAL_TIMESHEET",       label: "Manual timesheet",      hint: "Reserved — future manual timesheet entry." },
  { value: "SCHEDULE_DERIVED",       label: "Schedule derived",      hint: "Reserved — future scheduling integration." },
  { value: "NO_TIME_ENTRY_REQUIRED", label: "No time entry required", hint: "Default. Typical salaried employee." },
];

export default function TimekeepingPanel(props: {
  employeeId: string;
  initialMethod: Method;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [method, setMethod] = useState<Method>(props.initialMethod);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = method !== props.initialMethod;

  function onSave() {
    setError(null); setMessage(null);
    startTransition(async () => {
      const r = await updateTimekeepingMethodAction(props.employeeId, method);
      if (r.ok) {
        setMessage("Saved.");
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  }

  return (
    <section
      className="rounded-lg border p-4"
      style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-muted)" }}
      data-testid="timekeeping-panel"
    >
      <div className="mb-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">
          Timekeeping
        </div>
        <h3 className="mt-0.5 text-sm font-semibold text-club-ink">Timekeeping method</h3>
        <p className="mt-1 text-xs text-stone-500">
          Determines whether this employee must use Clock In / Out. Applies to future clock events
          only; historical time is unaffected.
        </p>
      </div>

      {props.canWrite ? (
        <>
          <select
            className="input w-full"
            value={method}
            onChange={(e) => setMethod(e.target.value as Method)}
            disabled={pending}
            data-testid="timekeeping-select"
          >
            {OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <p className="mt-1 text-[10px] text-stone-500">
            {OPTIONS.find((o) => o.value === method)?.hint}
          </p>
          <div className="mt-3 flex items-center justify-end gap-2">
            {message ? <span className="text-[11px] text-emerald-800" data-testid="timekeeping-message">{message}</span> : null}
            {error   ? <span className="text-[11px] text-red-700"      data-testid="timekeeping-error">{error}</span>     : null}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onSave}
              disabled={!dirty || pending}
              data-testid="timekeeping-save"
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      ) : (
        <div className="text-sm" data-testid="timekeeping-readonly">
          {OPTIONS.find((o) => o.value === method)?.label ?? method}
        </div>
      )}
    </section>
  );
}

// Slice E closeout (2026-09-19) §7-9 — real founder-facing zero-hours
// acknowledgement UI. Renders one card per unresolved
// NO_APPROVED_HOURS_FOR_HOURLY BLOCKER on the batch. Each card shows:
//   • employee identity (from the frozen snapshot when available)
//   • plain-language explanation of why payroll is blocked
//   • radio reason picker + optional detail field
//   • audit warning ("this action is recorded with your name")
//   • Acknowledge button that posts to the server action
//
// This is a client-side helper only in state management; the writes go
// through the canonical `acknowledgeZeroHours` service via the server
// action which requires `payroll:edit`.

"use client";

import { useState } from "react";

export interface AckRow {
  batchEmployeeId: string;
  employeeName: string;
  employeeNumber: string | null;
}

interface Props {
  batchId: string;
  rows: AckRow[];
  action: (form: FormData) => Promise<void>;
}

const REASONS = [
  { value: "NO_SHIFTS_IN_PERIOD", label: "No shifts scheduled in this period" },
  { value: "UNPAID_LEAVE",        label: "Unpaid leave" },
  { value: "SEASONAL_INACTIVE",   label: "Seasonal — inactive but still employed" },
  { value: "OTHER",               label: "Other (see note)" },
];

export default function ZeroHoursAckPanel({ batchId, rows, action }: Props) {
  return (
    <section
      className="mb-spectre-6 rounded-spectre-panel border p-spectre-6"
      style={{ background: "#fef2f2", borderColor: "#fecaca" }}
      data-testid="zero-hours-ack-panel"
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-red-800">
        Payroll blocker · Zero approved hours
      </div>
      <h2 className="mt-1 text-spectre-h3 font-semibold text-red-900">
        {rows.length === 1
          ? "1 hourly employee has no approved hours for this pay period"
          : `${rows.length} hourly employees have no approved hours for this pay period`}
      </h2>
      <p className="mt-2 text-sm text-red-900/80">
        An hourly employee with no approved payable hours cannot silently
        calculate to $0.00 — that would mask an approval gap. Either{" "}
        <strong>approve their time under Department Approvals</strong>, or
        acknowledge below with a legitimate reason.
        {" "}Your name and the reason are recorded in the payroll audit trail.
      </p>

      <div className="mt-4 space-y-3">
        {rows.map((r) => (
          <AckCard key={r.batchEmployeeId} row={r} batchId={batchId} action={action} />
        ))}
      </div>
    </section>
  );
}

function AckCard({ row, batchId, action }: { row: AckRow; batchId: string; action: (form: FormData) => Promise<void> }) {
  const [reason, setReason] = useState<string>("NO_SHIFTS_IN_PERIOD");
  const isOther = reason === "OTHER";
  return (
    <form
      action={action}
      className="rounded border bg-white p-3"
      style={{ borderColor: "#fecaca" }}
      data-testid={`zero-hours-ack-card-${row.batchEmployeeId}`}
    >
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="batchEmployeeId" value={row.batchEmployeeId} />
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-sm font-semibold text-stone-900">{row.employeeName}</div>
          {row.employeeNumber && (
            <div className="text-[11px] text-stone-500">{row.employeeNumber}</div>
          )}
        </div>
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase"
          style={{ background: "#fee2e2", color: "#991b1b" }}
          data-testid={`zero-hours-blocker-badge-${row.batchEmployeeId}`}
        >
          Blocker · Zero approved hours
        </span>
      </div>

      <fieldset className="mt-3">
        <legend className="text-[11px] font-semibold uppercase tracking-[0.06em] text-stone-500">
          Reason (required)
        </legend>
        <div className="mt-2 space-y-1 text-sm">
          {REASONS.map((r) => (
            <label key={r.value} className="flex items-center gap-2">
              <input
                type="radio"
                name="reason"
                value={r.value}
                checked={reason === r.value}
                onChange={() => setReason(r.value)}
                data-testid={`zero-hours-reason-${r.value.toLowerCase()}-${row.batchEmployeeId}`}
              />
              <span>{r.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {isOther && (
        <label className="mt-3 block text-sm">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-stone-500">
            Detail (required)
          </span>
          <input
            name="reasonDetail"
            className="mt-1 w-full rounded border px-2 py-1 text-sm"
            placeholder="Why is this employee at zero hours this period?"
            data-testid={`zero-hours-detail-${row.batchEmployeeId}`}
          />
        </label>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          data-testid={`zero-hours-ack-submit-${row.batchEmployeeId}`}
        >
          Acknowledge · payroll can proceed
        </button>
        <span className="text-[10px] text-stone-600">
          Your identity is recorded with this acknowledgement.
        </span>
      </div>
    </form>
  );
}

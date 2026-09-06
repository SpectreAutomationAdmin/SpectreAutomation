"use client";

// Payroll-3D-3 (2026-09-05) — Manager Timesheet Approval workspace.
// Compact operational surface — not a giant spreadsheet.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveCorrectionAction,
  rejectCorrectionAction,
  approveTimesheetScopeAction,
} from "./_timesheet-actions";

interface Employee {
  employeeId: string;
  employeeNumber: string | null;
  firstName: string;
  lastName: string;
  recordedSeconds: number;
  entryCount: number;
  exceptionCount: number;
  pendingCorrectionCount: number;
}
interface Entry {
  id: string;
  employeeId: string;
  workDateIso: string;
  clockInIso: string;
  clockOutIso: string;
  recordedSeconds: number;
  breakSeconds: number;
  employmentAssignmentId: string | null;
}
interface Correction {
  id: string;
  employeeId: string;
  requestType: string;
  requestedOccurredAtIso: string | null;
  originalClockEventId: string | null;
  reason: string;
  createdAtIso: string;
}
interface BlockingReason {
  kind: "MISSING_CLOCK_OUT" | "OPEN_BREAK" | "MISSING_ASSIGNMENT" | "PENDING_CORRECTION";
  count: number;
  detail: string;
}
interface ApprovalRecord {
  id: string;
  state: "APPROVED" | "REOPENED" | "REVIEW_REQUIRED";
  approvedAtIso: string;
  approvedByUserId: string;
  approvedRevision: string | null;
}

export interface TimesheetApprovalWorkspaceProps {
  clubId: string;
  payPeriodId: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  periodLabel: string;
  employees: Employee[];
  entries: Entry[];
  pendingCorrections: Correction[];
  totalRecordedSeconds: number;
  currentRevision: string;
  approval: ApprovalRecord | null;
  readiness: {
    ready: boolean;
    blockingReasons: BlockingReason[];
    approvalValid: boolean;
  };
  clubTimezone: string | null;
}

function fmtDuration(s: number): string {
  const seconds = Math.max(0, Math.floor(s));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtTime(iso: string, tz: string | null): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-CA", {
    timeZone: tz ?? undefined, hour: "numeric", minute: "2-digit", hour12: true,
  });
}
function fmtDay(iso: string, tz: string | null): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-CA", {
    timeZone: tz ?? undefined, weekday: "short", month: "short", day: "numeric",
  });
}
function prettyCorrectionType(t: string): string {
  switch (t) {
    case "ADD_MISSING_CLOCK_IN":  return "Add missing Clock In";
    case "ADD_MISSING_CLOCK_OUT": return "Add missing Clock Out";
    case "CORRECT_CLOCK_IN":      return "Correct Clock In";
    case "CORRECT_CLOCK_OUT":     return "Correct Clock Out";
    case "CORRECT_BREAK_START":   return "Correct Break Start";
    case "CORRECT_BREAK_END":     return "Correct Break End";
    default: return t;
  }
}

export default function TimesheetApprovalWorkspace(props: TimesheetApprovalWorkspaceProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [expandedEmp, setExpandedEmp] = useState<string | null>(null);

  const entriesByEmp = useMemo(() => {
    const g = new Map<string, Entry[]>();
    for (const e of props.entries) {
      const list = g.get(e.employeeId) ?? [];
      list.push(e);
      g.set(e.employeeId, list);
    }
    return g;
  }, [props.entries]);

  const empNameById = useMemo(() => {
    const g = new Map<string, string>();
    for (const emp of props.employees) g.set(emp.employeeId, `${emp.firstName} ${emp.lastName}`);
    return g;
  }, [props.employees]);

  const approvedAndCurrent = props.approval?.state === "APPROVED" && props.readiness.approvalValid;

  return (
    <section data-testid="timesheet-approval-workspace" className="space-y-6">
      <header className="rounded-lg border border-stone-200 bg-white p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-stone-500">
              Timesheet approval · {props.departmentName}
            </div>
            <h2 className="mt-1 text-xl font-semibold text-club-ink">
              {props.periodLabel}
            </h2>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-stone-500">Total recorded</div>
            <div className="text-2xl font-semibold tabular-nums text-club-ink"
                 data-testid="scope-total-recorded">
              {fmtDuration(props.totalRecordedSeconds)}
            </div>
          </div>
        </div>

        {/* Ready / blocked banner */}
        <div className="mt-3">
          {approvedAndCurrent ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
                 data-testid="scope-status-approved">
              <span className="font-semibold">Approved</span>
              {" · "}{new Date(props.approval!.approvedAtIso).toLocaleString("en-CA", { timeZone: props.clubTimezone ?? undefined })}
            </div>
          ) : props.readiness.ready ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
                 data-testid="scope-status-ready">
              <span className="font-semibold">Ready to approve</span>
              {" · "}{props.employees.length} employee{props.employees.length === 1 ? "" : "s"}
              {" · "}{fmtDuration(props.totalRecordedSeconds)}
            </div>
          ) : (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                 data-testid="scope-status-blocked">
              <span className="font-semibold">Needs attention</span>
              <ul className="mt-1 list-disc pl-5">
                {props.readiness.blockingReasons.map((r) => (
                  <li key={r.kind}>{r.detail}</li>
                ))}
                {props.approval?.state === "REVIEW_REQUIRED" ? (
                  <li>Source time changed after your previous approval — re-attest.</li>
                ) : null}
              </ul>
            </div>
          )}
        </div>

        {err ? (
          <p className="mt-2 text-xs text-red-700" data-testid="scope-error">{err}</p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="approve-scope-btn"
            disabled={pending || !props.readiness.ready || approvedAndCurrent}
            onClick={() => {
              setErr(null);
              startTransition(async () => {
                const r = await approveTimesheetScopeAction({
                  payPeriodId: props.payPeriodId,
                  departmentId: props.departmentId,
                  attestedRevision: props.currentRevision,
                });
                if (!r.ok) setErr(r.error);
                else router.refresh();
              });
            }}
          >
            {pending ? "Working…" : `Approve ${props.departmentName} time`}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => router.refresh()}
            data-testid="scope-refresh-btn"
          >
            Refresh
          </button>
        </div>
      </header>

      {/* Pending corrections */}
      {props.pendingCorrections.length > 0 ? (
        <section className="rounded-lg border border-stone-200 bg-white p-4"
                 data-testid="scope-pending-corrections">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Pending corrections ({props.pendingCorrections.length})
          </h3>
          <ul className="space-y-2 text-sm">
            {props.pendingCorrections.map((c) => (
              <li key={c.id}
                  className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
                  data-testid={`correction-row:${c.id}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <div className="font-medium text-club-ink">
                      {empNameById.get(c.employeeId) ?? c.employeeId} · {prettyCorrectionType(c.requestType)}
                    </div>
                    <div className="mt-0.5 text-xs text-stone-600">
                      {c.requestedOccurredAtIso ? `Proposed: ${fmtTime(c.requestedOccurredAtIso, props.clubTimezone)} · ` : ""}
                      Reason: {c.reason}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={pending}
                      data-testid={`correction-approve-btn:${c.id}`}
                      onClick={() => {
                        setErr(null);
                        startTransition(async () => {
                          const r = await approveCorrectionAction({ requestId: c.id });
                          if (!r.ok) setErr(r.error); else router.refresh();
                        });
                      }}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={pending}
                      data-testid={`correction-reject-btn:${c.id}`}
                      onClick={() => {
                        setErr(null);
                        const note = window.prompt("Optional note to the employee (why was this rejected)?") ?? "";
                        startTransition(async () => {
                          const r = await rejectCorrectionAction({ requestId: c.id, reviewerNote: note });
                          if (!r.ok) setErr(r.error); else router.refresh();
                        });
                      }}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Employee summary */}
      <section className="rounded-lg border border-stone-200 bg-white"
               data-testid="scope-employees">
        <div className="border-b border-stone-100 px-4 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
            Employees ({props.employees.length})
          </h3>
        </div>
        {props.employees.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-stone-500">
            No recorded time yet for this scope.
          </p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {props.employees.map((emp) => {
              const empEntries = entriesByEmp.get(emp.employeeId) ?? [];
              const expanded = expandedEmp === emp.employeeId;
              return (
                <li key={emp.employeeId} className="px-4 py-3"
                    data-testid={`scope-employee-row:${emp.employeeId}`}>
                  <button
                    type="button"
                    className="flex w-full items-baseline justify-between gap-4 text-left"
                    onClick={() => setExpandedEmp(expanded ? null : emp.employeeId)}
                  >
                    <div>
                      <div className="text-sm font-medium text-club-ink">
                        {emp.firstName} {emp.lastName}
                      </div>
                      <div className="text-[11px] text-stone-500">
                        {emp.entryCount} session{emp.entryCount === 1 ? "" : "s"}
                        {emp.exceptionCount > 0 ? ` · ${emp.exceptionCount} exception${emp.exceptionCount === 1 ? "" : "s"}` : ""}
                        {emp.pendingCorrectionCount > 0 ? ` · ${emp.pendingCorrectionCount} correction${emp.pendingCorrectionCount === 1 ? "" : "s"} pending` : ""}
                      </div>
                    </div>
                    <div className="text-right tabular-nums">
                      <div className="text-sm font-semibold text-club-ink">
                        {fmtDuration(emp.recordedSeconds)}
                      </div>
                      <div className="text-[10px] uppercase tracking-wider text-stone-500">
                        {expanded ? "Hide detail" : "Show detail"}
                      </div>
                    </div>
                  </button>
                  {expanded && empEntries.length > 0 ? (
                    <ul className="mt-2 space-y-1 border-l border-stone-200 pl-3 text-xs">
                      {empEntries.map((e) => (
                        <li key={e.id} className="flex items-baseline justify-between gap-2"
                            data-testid={`scope-entry:${e.id}`}>
                          <span className="text-stone-700">
                            {fmtDay(e.workDateIso, props.clubTimezone)} · {fmtTime(e.clockInIso, props.clubTimezone)} – {fmtTime(e.clockOutIso, props.clubTimezone)}
                            {e.breakSeconds > 0 ? ` · break ${fmtDuration(e.breakSeconds)}` : ""}
                          </span>
                          <span className="text-stone-500 tabular-nums">
                            {fmtDuration(e.recordedSeconds)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer className="text-[10px] uppercase tracking-wider text-stone-500">
        Revision {props.currentRevision.slice(0, 8)} · Recorded time · not yet payroll input.
      </footer>
    </section>
  );
}

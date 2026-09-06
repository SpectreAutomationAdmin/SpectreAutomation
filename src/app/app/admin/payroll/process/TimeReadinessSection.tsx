"use client";

// Payroll-3D-4 (2026-09-05) — Compact Time Approval Readiness section
// for the Payroll Admin processing workspace. Not a full dashboard —
// that is 3D-5.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { freezeScopeAction, resolveLateAdjustmentAction } from "./_time-readiness-actions";

export interface ScopeReadinessRow {
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  employeeCount: number;
  entryCount: number;
  entriesFrozenAndCurrent: number;
  entriesNotYetFrozen: number;
  openLateAdjustments: number;
  approvalState: "PENDING" | "APPROVED" | "REVIEW_REQUIRED";
  approvalIsCurrent: boolean;
  overallState:
    | "AWAITING_APPROVAL" | "APPROVAL_STALE" | "APPROVED_NOT_FROZEN"
    | "FROZEN_READY" | "FROZEN_LATE_REVIEW";
}
export interface LateExceptionRow {
  id: string;
  employeeDisplay: string;
  reason: string;
  differenceHours: string;
  createdAtIso: string;
  notes: string | null;
}
export interface TimeReadinessProps {
  payPeriodId: string;
  scopes: ScopeReadinessRow[];
  lateExceptions: LateExceptionRow[];
  overallReady: boolean;
  hasOpenLateAdjustments: boolean;
  hasStaleApprovals: boolean;
  hasUnapprovedScopes: boolean;
  canFreeze: boolean;
}

const STATE_LABEL: Record<ScopeReadinessRow["overallState"], string> = {
  AWAITING_APPROVAL:   "Awaiting manager approval",
  APPROVAL_STALE:      "Manager must re-attest",
  APPROVED_NOT_FROZEN: "Approved — ready to freeze",
  FROZEN_READY:        "Frozen · payroll input ready",
  FROZEN_LATE_REVIEW:  "Frozen · late-time review required",
};

export default function TimeReadinessSection(props: TimeReadinessProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  if (props.scopes.length === 0) {
    return (
      <section className="mb-spectre-6 rounded-lg border border-stone-200 bg-white p-4"
               data-testid="time-readiness-section">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Time approval readiness
        </h3>
        <p className="mt-1 text-sm text-stone-700"
           data-testid="time-readiness-salary-only">
          No hourly time recorded for this pay period. Salary payroll can proceed.
        </p>
      </section>
    );
  }

  return (
    <section className="mb-spectre-6 rounded-lg border border-stone-200 bg-white p-4"
             data-testid="time-readiness-section">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-stone-100 pb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Time approval readiness
        </h3>
        <div className="text-[11px]">
          {props.overallReady ? (
            <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-800"
                  data-testid="time-readiness-overall-ready">
              Ready
            </span>
          ) : (
            <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-800"
                  data-testid="time-readiness-overall-blocked">
              Not ready
            </span>
          )}
        </div>
      </div>
      {err ? (
        <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800"
           data-testid="time-readiness-error">{err}</p>
      ) : null}
      {okMsg ? (
        <p className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-800"
           data-testid="time-readiness-success">{okMsg}</p>
      ) : null}
      <ul className="mt-2 divide-y divide-stone-100">
        {props.scopes.map((s) => (
          <li key={s.departmentId} className="py-2"
              data-testid={`time-readiness-row:${s.departmentCode}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-club-ink">
                  {s.departmentName}
                </div>
                <div className="mt-0.5 text-[11px] text-stone-500">
                  {s.employeeCount} employee{s.employeeCount === 1 ? "" : "s"}
                  {" · "}{s.entryCount} entr{s.entryCount === 1 ? "y" : "ies"}
                  {" · "}{s.entriesFrozenAndCurrent}/{s.entryCount} frozen
                  {s.openLateAdjustments > 0 ? ` · ${s.openLateAdjustments} late review${s.openLateAdjustments === 1 ? "" : "s"}` : ""}
                </div>
                <div className="mt-0.5 text-[11px]"
                     data-testid={`time-readiness-state:${s.departmentCode}`}>
                  <span className={
                    s.overallState === "FROZEN_READY"
                      ? "text-emerald-800"
                      : s.overallState === "APPROVED_NOT_FROZEN"
                      ? "text-stone-700"
                      : "text-amber-800"
                  }>
                    {STATE_LABEL[s.overallState]}
                  </span>
                </div>
              </div>
              {s.overallState === "APPROVED_NOT_FROZEN" && props.canFreeze ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={pending}
                  data-testid={`freeze-scope-btn:${s.departmentCode}`}
                  onClick={() => {
                    setErr(null); setOkMsg(null);
                    startTransition(async () => {
                      const r = await freezeScopeAction({
                        payPeriodId: props.payPeriodId, departmentId: s.departmentId,
                      });
                      if (r.ok) {
                        setOkMsg(`Frozen ${r.entriesCreated} entr${r.entriesCreated === 1 ? "y" : "ies"} for ${s.departmentName}` + (r.timing === "LATE" ? " (late — review required)." : "."));
                        router.refresh();
                      } else setErr(r.error);
                    });
                  }}
                >
                  Freeze
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {props.lateExceptions.length > 0 ? (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3"
             data-testid="time-readiness-late-exceptions">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-900">
            Late time exceptions ({props.lateExceptions.length})
          </div>
          <ul className="mt-2 space-y-2 text-sm">
            {props.lateExceptions.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2"
                  data-testid={`late-exception-row:${e.id}`}>
                <div>
                  <div className="font-medium text-club-ink">
                    {e.employeeDisplay} · {e.reason} · {e.differenceHours}h
                  </div>
                  <div className="text-[11px] text-stone-500">
                    Created {new Date(e.createdAtIso).toLocaleString("en-CA")}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={pending}
                    data-testid={`late-exception-include-btn:${e.id}`}
                    onClick={() => {
                      setErr(null); setOkMsg(null);
                      startTransition(async () => {
                        const r = await resolveLateAdjustmentAction({
                          adjustmentId: e.id, resolution: "INCLUDE_CURRENT",
                        });
                        if (r.ok) { setOkMsg("Included in current payroll."); router.refresh(); }
                        else setErr(r.error);
                      });
                    }}
                  >
                    Include current
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={pending}
                    data-testid={`late-exception-defer-btn:${e.id}`}
                    onClick={() => {
                      setErr(null); setOkMsg(null);
                      startTransition(async () => {
                        const r = await resolveLateAdjustmentAction({
                          adjustmentId: e.id, resolution: "DEFER_NEXT_PAYROLL",
                        });
                        if (r.ok) { setOkMsg("Deferred to next payroll."); router.refresh(); }
                        else setErr(r.error);
                      });
                    }}
                  >
                    Defer to next
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

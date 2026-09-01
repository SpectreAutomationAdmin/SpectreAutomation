"use client";

import { useCallback, useMemo, useState } from "react";
import type { PreparedBatchView } from "@/lib/payroll/batch-preparation";

interface PayPeriodOpt {
  id: string;
  payGroupName: string;
  payGroupCode: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
}
interface DeptStatus {
  departmentId: string;
  code: string;
  name: string;
  state: "PENDING" | "APPROVED" | "REOPENED";
  employeeCount: number;
  totalHours: string;
}

interface Props {
  clubId: string;
  canRun: boolean;
  payPeriods: PayPeriodOpt[];
  initialPeriodId: string | null;
  initialBatch: PreparedBatchView | null;
  initialDepartmentStatus: DeptStatus[];
}

export default function PayrollProcessWorkspace({
  clubId,
  canRun,
  payPeriods,
  initialPeriodId,
  initialBatch,
  initialDepartmentStatus,
}: Props) {
  const [periodId, setPeriodId] = useState(initialPeriodId ?? "");
  const [batch, setBatch] = useState<PreparedBatchView | null>(initialBatch);
  const [deptStatus, setDeptStatus] = useState<DeptStatus[]>(initialDepartmentStatus);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "idle" | "ok" | "err"; text: string }>({
    tone: "idle",
    text: "",
  });

  const period = useMemo(() => payPeriods.find((p) => p.id === periodId) ?? null, [payPeriods, periodId]);
  const api = useCallback((path: string) => `/api/clubs/${clubId}/payroll${path}`, [clubId]);

  const refresh = useCallback(async (pid: string) => {
    const [statusRes, activeRes] = await Promise.all([
      fetch(api(`/pay-periods/${pid}/orchestrate`)),
      // Find the active batch id if any — use the process page's own
      // context by re-navigating with searchParams; simplest is a
      // client fetch that returns the batch if one exists via the
      // batches route once we know the id. For now, if we have a
      // batch, refresh it.
      Promise.resolve(null),
    ]);
    if (statusRes.ok) {
      const body = (await statusRes.json()) as {
        status: Array<{
          departmentId: string; departmentCode: string; departmentName: string;
          state: "PENDING" | "APPROVED" | "REOPENED"; employeeCount: number; totalHours: string;
        }>;
      };
      setDeptStatus(body.status.map((s) => ({
        departmentId: s.departmentId, code: s.departmentCode, name: s.departmentName,
        state: s.state, employeeCount: s.employeeCount, totalHours: s.totalHours,
      })));
    }
    if (batch) {
      const br = await fetch(api(`/batches/${batch.id}`));
      if (br.ok) {
        const body = (await br.json()) as { batch: PreparedBatchView };
        setBatch(body.batch);
      }
    }
  }, [api, batch]);

  const setPeriod = async (pid: string) => {
    setPeriodId(pid);
    setBatch(null);
    await refresh(pid);
  };

  const allApproved = deptStatus.length > 0 && deptStatus.every((s) => s.state === "APPROVED");

  const prepare = async () => {
    if (!canRun || !periodId) return;
    setBusy(true);
    setMessage({ tone: "idle", text: "" });
    try {
      const res = await fetch(api("/batches"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payPeriodId: periodId }),
      });
      if (!res.ok) throw new Error(await res.text());
      const body = (await res.json()) as {
        result: {
          status: "prepared" | "prepared-with-blockers" | "existing";
          batchId: string;
          employeeCount: number;
          salariedCount: number;
          hourlyCount: number;
          blockerCount: number;
          warningCount: number;
        };
      };
      const br = await fetch(api(`/batches/${body.result.batchId}`));
      if (br.ok) {
        const b = (await br.json()) as { batch: PreparedBatchView };
        setBatch(b.batch);
      }
      setMessage({
        tone: body.result.blockerCount > 0 ? "err" : "ok",
        text: body.result.status === "existing"
          ? "Existing batch returned (idempotent)."
          : body.result.blockerCount > 0
            ? `Batch prepared with ${body.result.blockerCount} blocker${body.result.blockerCount === 1 ? "" : "s"}. Resolve before calculation.`
            : `Batch prepared for ${body.result.employeeCount} employees.`,
      });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const voidBatch = async () => {
    if (!canRun || !batch) return;
    const reason = window.prompt("Optional reason for voiding this batch?") ?? undefined;
    setBusy(true);
    setMessage({ tone: "idle", text: "" });
    try {
      const res = await fetch(api(`/batches/${batch.id}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "void", reason }),
      });
      if (!res.ok) throw new Error(await res.text());
      setBatch(null);
      setMessage({ tone: "ok", text: "Batch voided. Time reservations released; you may re-prepare after correcting source facts." });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="process-workspace">
      <label className="block text-sm max-w-md">
        <span className="text-club-ink">Pay period</span>
        <select
          value={periodId}
          onChange={(e) => setPeriod(e.target.value)}
          className="spectre-input w-full mt-1"
          data-testid="process-period"
        >
          <option value="">— Select —</option>
          {payPeriods.map((p) => (
            <option key={p.id} value={p.id}>
              {p.payGroupName} · {p.periodStart.slice(0, 10)} → {new Date(new Date(p.periodEnd).getTime() - 86_400_000).toISOString().slice(0, 10)} · pay {p.payDate.slice(0, 10)}
            </option>
          ))}
        </select>
      </label>

      {period && (
        <section className="rounded-xl border border-stone-200 bg-white p-4" data-testid="process-readiness">
          <h2 className="font-serif text-[16px] text-club-ink mb-2">Readiness</h2>
          <ul className="text-sm space-y-1 text-stone-700">
            <li>Pay date: <strong>{period.payDate.slice(0, 10)}</strong></li>
            <li>Pay group: <strong>{period.payGroupName}</strong> ({period.payGroupCode})</li>
            <li>Departments approved: <strong>{deptStatus.filter((s) => s.state === "APPROVED").length}</strong> of {deptStatus.length}</li>
          </ul>
          {!allApproved && (
            <p className="mt-2 text-sm text-amber-800 bg-amber-50 border border-amber-300 rounded px-3 py-2" data-testid="process-blocked-approvals">
              Payroll cannot be prepared until every department with payable time is APPROVED.
              Missing: {deptStatus.filter((s) => s.state !== "APPROVED").map((s) => s.name).join(", ") || "—"}
            </p>
          )}
          {canRun && allApproved && !batch && (
            <button
              type="button"
              onClick={prepare}
              disabled={busy}
              className="spectre-btn spectre-btn-primary mt-3"
              data-testid="process-prepare"
            >
              Prepare payroll
            </button>
          )}
        </section>
      )}

      {batch && (
        <section className="rounded-xl border border-stone-200 bg-white p-4 space-y-3" data-testid="process-batch">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h2 className="font-serif text-[16px] text-club-ink">Prepared batch</h2>
            <span className={"text-[10px] uppercase tracking-widest rounded px-1.5 py-0.5 border " + (
              batch.status === "PREPARED" ? "bg-emerald-50 text-emerald-800 border-emerald-300" :
              batch.status === "DRAFT" ? "bg-amber-50 text-amber-800 border-amber-300" :
              batch.status === "VOIDED" ? "bg-stone-100 text-stone-500 border-stone-300" :
              "bg-sky-50 text-sky-800 border-sky-300"
            )}>{batch.status}</span>
            <span className="text-[11px] text-stone-500">Sequence {batch.sequence}</span>
          </div>
          <ul className="text-sm space-y-1 text-stone-700">
            <li>Employees: <strong>{batch.employees.length}</strong> ({batch.employees.filter((e) => e.salaried).length} salaried, {batch.employees.filter((e) => !e.salaried).length} hourly)</li>
            <li>Blockers: <strong className={batch.exceptions.filter((x) => x.severity === "BLOCKER").length ? "text-red-700" : "text-emerald-700"}>{batch.exceptions.filter((x) => x.severity === "BLOCKER").length}</strong></li>
            <li>Warnings: <strong>{batch.exceptions.filter((x) => x.severity === "WARNING").length}</strong></li>
          </ul>
          {batch.exceptions.length > 0 && (
            <div className="mt-2 space-y-1">
              <h3 className="text-[11px] uppercase tracking-widest text-stone-500">Exceptions</h3>
              <ul className="text-xs space-y-0.5">
                {batch.exceptions.slice(0, 10).map((x) => (
                  <li key={x.id} className={x.severity === "BLOCKER" ? "text-red-700" : "text-stone-600"}>
                    <span className="font-mono mr-1">[{x.severity}]</span> {x.code} — {x.message}
                  </li>
                ))}
                {batch.exceptions.length > 10 && (
                  <li className="text-stone-500">… and {batch.exceptions.length - 10} more</li>
                )}
              </ul>
            </div>
          )}
          {(batch.status === "PREPARED" || batch.status === "CALCULATED") && (
            <a
              href={`/app/admin/payroll/batches/${batch.id}`}
              className="inline-block text-sm text-emerald-800 hover:underline"
              data-testid="process-open-review"
            >
              Open batch review →
            </a>
          )}
          {canRun && batch.status !== "VOIDED" && (
            <button
              type="button"
              onClick={voidBatch}
              disabled={busy}
              className="text-sm text-red-700 hover:underline ml-4"
              data-testid="process-void"
            >
              Void this batch
            </button>
          )}
        </section>
      )}

      {message.text && (
        <p
          role={message.tone === "err" ? "alert" : "status"}
          className={"text-sm " + (message.tone === "ok" ? "text-emerald-700" : message.tone === "err" ? "text-red-700" : "text-stone-600")}
          data-testid="process-status"
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

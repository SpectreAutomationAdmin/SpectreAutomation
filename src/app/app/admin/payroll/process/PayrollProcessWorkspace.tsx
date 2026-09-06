"use client";

import { useCallback, useMemo, useState } from "react";
import type { PreparedBatchView } from "@/lib/payroll/batch-preparation";
import { evaluateTimeApprovalReadiness } from "@/lib/payroll/readiness-predicate";

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

  // Readiness rule: the time-approval prerequisite is satisfied when
  // every department that requires an approval is APPROVED. A salary-
  // only pay period has zero required departments, so the predicate
  // is trivially satisfied. See evaluateTimeApprovalReadiness — the
  // shared, unit-tested predicate.
  const readiness = evaluateTimeApprovalReadiness(deptStatus.map((s) => ({
    departmentId: s.departmentId, state: s.state,
  })));
  const requiredCount = readiness.requiredCount;
  const approvedCount = readiness.approvedCount;
  const salaryOnly    = readiness.salaryOnly;
  const allApproved   = readiness.ready;

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

  const calculate = async () => {
    if (!canRun || !batch) return;
    setBusy(true);
    setMessage({ tone: "idle", text: "" });
    try {
      const res = await fetch(api(`/batches/${batch.id}/calculate`), { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        result?: { batchId: string; lifecycleStatus: string; persisted: boolean; blockers: Array<{ code: string; message: string }> };
      };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const refreshed = await fetch(api(`/batches/${batch.id}`));
      if (refreshed.ok) {
        const b = (await refreshed.json()) as { batch: PreparedBatchView };
        setBatch(b.batch);
      }
      const blockerCount = body.result?.blockers?.length ?? 0;
      if (body.result?.lifecycleStatus === "CALCULATED") {
        setMessage({ tone: "ok", text: "Payroll calculated. Batch is ready for final approval by the Controller." });
      } else if (blockerCount > 0) {
        setMessage({ tone: "err", text: `Calculation blocked (${blockerCount}). ${body.result?.blockers?.[0]?.message ?? ""}` });
      } else {
        setMessage({ tone: "err", text: "Calculation did not complete." });
      }
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
            <li data-testid="process-time-approvals">
              Time approvals:{" "}
              {salaryOnly ? (
                <strong className="text-emerald-700">
                  Not required — this payroll contains salary-only employees.
                </strong>
              ) : (
                <strong className={allApproved ? "text-emerald-700" : "text-amber-800"}>
                  {approvedCount} of {requiredCount} departments approved
                </strong>
              )}
            </li>
          </ul>
          {!allApproved && (
            <p className="mt-2 text-sm text-amber-800 bg-amber-50 border border-amber-300 rounded px-3 py-2" data-testid="process-blocked-approvals">
              Payroll cannot be prepared until every department with payable time is APPROVED.
              Missing: {deptStatus.filter((s) => s.state !== "APPROVED").map((s) => s.name).join(", ") || "—"}
            </p>
          )}
          {allApproved && !batch && (
            <p className="mt-2 text-sm text-emerald-700" data-testid="process-ready">
              Ready to prepare.
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
            <li>
              Blockers:{" "}
              <strong className={batch.exceptions.filter((x) => x.severity === "BLOCKER").length ? "text-red-700" : "text-emerald-700"}>
                {batch.exceptions.filter((x) => x.severity === "BLOCKER").length}
              </strong>
            </li>
            <li>
              Advisory notes:{" "}
              <strong>
                {batch.exceptions.filter((x) => x.severity === "WARNING").length}
              </strong>{" "}
              <span className="text-stone-500 text-xs">(non-blocking)</span>
            </li>
          </ul>
          {batch.exceptions.length > 0 && (
            <GroupedExceptions exceptions={batch.exceptions} />
          )}
          {canRun && batch.status === "PREPARED" && batch.exceptions.filter((x) => x.severity === "BLOCKER").length === 0 && (
            <button
              type="button"
              onClick={calculate}
              disabled={busy}
              className="spectre-btn spectre-btn-primary mt-1 mr-3"
              data-testid="process-calculate"
            >
              Calculate payroll
            </button>
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

// -------------------------------------------------------------------
// Exception presentation
//
// Rules (Payroll MVP TD1 hotfix §15–16):
//   • Group by employee — the Payroll Admin needs one row per person
//     who needs attention, not a flat list of raw codes.
//   • Show human-readable copy — "Tax profile could not be securely
//     read" instead of "TD1_CLAIM_RESOLUTION_FAILED".
//   • Preserve the raw code inside a small diagnostic detail toggle
//     so support / QA can still find the enum.
// -------------------------------------------------------------------

interface ExceptionRow {
  id: string;
  severity: "BLOCKER" | "WARNING" | "INFO";
  code: string;
  message: string;
  batchEmployeeId: string | null;
  employeeId: string | null;
  employeeDisplayName: string | null;
  recommendedAction: string | null;
  resolvedAt: Date | string | null;
}

function humanLabelFor(code: string): string {
  switch (code) {
    case "TD1_CLAIM_RESOLUTION_FAILED":
      return "Tax profile could not be securely read";
    case "MISSING_SIN":
      return "SIN not on file";
    case "BANKING_NOT_VERIFIED":
      return "Direct-deposit banking not verified";
    case "MISSING_COMPENSATION":
      return "No compensation record for this pay period";
    case "MISSING_ASSIGNMENT":
      return "No employment assignment covering this pay period";
    case "NEGATIVE_NET_PAY":
      return "Deductions would exceed gross pay";
    case "STATUTORY_PACKAGE_UNRESOLVED":
      return "No statutory tax package available for the pay date";
    default:
      return code.replace(/_/g, " ").toLowerCase().replace(/^./, (s) => s.toUpperCase());
  }
}

function GroupedExceptions({ exceptions }: { exceptions: ExceptionRow[] }) {
  // Bucket by employeeId; batch-level exceptions (no employeeId)
  // share a synthetic bucket keyed by "__batch__".
  const groups = new Map<string, { name: string; rows: ExceptionRow[] }>();
  for (const x of exceptions) {
    const key = x.employeeId ?? "__batch__";
    const name = x.employeeDisplayName ?? (x.employeeId ? "Employee" : "Batch");
    const g = groups.get(key) ?? { name, rows: [] };
    g.rows.push(x);
    groups.set(key, g);
  }
  const totalBlockers = exceptions.filter((x) => x.severity === "BLOCKER").length;
  const totalWarnings = exceptions.filter((x) => x.severity === "WARNING").length;
  const affectedCount = Array.from(groups.keys()).filter((k) => k !== "__batch__").length;

  const buckets = Array.from(groups.entries()).sort(([, a], [, b]) => {
    const aBlock = a.rows.some((r) => r.severity === "BLOCKER") ? 0 : 1;
    const bBlock = b.rows.some((r) => r.severity === "BLOCKER") ? 0 : 1;
    return aBlock - bBlock || a.name.localeCompare(b.name);
  });

  return (
    <div className="mt-2 space-y-2" data-testid="process-grouped-exceptions">
      <h3 className="text-[11px] uppercase tracking-widest text-stone-500">
        Attention needed
        {totalBlockers > 0 || totalWarnings > 0 ? (
          <span className="ml-2 text-stone-400">
            · {affectedCount} employee{affectedCount === 1 ? "" : "s"}{" "}
            · {totalBlockers} blocking · {totalWarnings} advisory
          </span>
        ) : null}
      </h3>
      <ul className="space-y-2">
        {buckets.map(([key, group]) => {
          const hasBlocker = group.rows.some((r) => r.severity === "BLOCKER");
          return (
            <li
              key={key}
              className={"rounded border px-3 py-2 text-sm " + (
                hasBlocker
                  ? "border-red-200 bg-red-50"
                  : "border-stone-200 bg-stone-50"
              )}
              data-testid={`exception-employee:${key}`}
            >
              <div className={"font-medium " + (hasBlocker ? "text-red-800" : "text-stone-800")}>
                {group.name}
              </div>
              <ul className="mt-1 space-y-1 text-xs">
                {group.rows.map((r) => (
                  <li key={r.id} className={r.severity === "BLOCKER" ? "text-red-800" : "text-stone-700"}>
                    <span className="font-medium">{humanLabelFor(r.code)}.</span>{" "}
                    {r.recommendedAction ?? r.message}
                    <details className="mt-0.5 inline-block ml-2 text-[10px] text-stone-500">
                      <summary className="cursor-pointer">diagnostic</summary>
                      <span className="font-mono ml-1">{r.code}</span>
                    </details>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

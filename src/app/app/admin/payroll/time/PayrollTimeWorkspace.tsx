"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface PayPeriodOpt { id: string; label: string; payDate: string }
interface DepartmentOpt { id: string; code: string; name: string }
interface EmployeeOpt {
  id: string;
  display: string;
  employeeNumber: string;
  primaryAssignmentId: string | null;
  primaryDepartmentId: string | null;
}
interface StatusRow {
  clubId: string;
  payPeriodId: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  employeeCount: number;
  entryCount: number;
  totalHours: string;
  state: "PENDING" | "APPROVED" | "REOPENED";
  approvedAt: string | null;
  approvedByUserId: string | null;
  reopenedAt: string | null;
  workIntakeItemId: string | null;
}
interface EntryRow {
  id: string;
  employeeId: string;
  employmentAssignmentId: string | null;
  workDate: string;
  hours: string;
  earningClassification: string;
  approvalState: "DRAFT" | "APPROVED" | "POSTED";
  notes: string | null;
}

interface Props {
  clubId: string;
  canWrite: boolean;
  canApprove: boolean;
  payPeriods: PayPeriodOpt[];
  departments: DepartmentOpt[];
  employees: EmployeeOpt[];
  initialPeriodId: string | null;
  initialDepartmentId: string | null;
  initialStatus: StatusRow[];
}

const CLASSIFICATIONS: Array<{ value: string; label: string }> = [
  { value: "REGULAR",      label: "Regular" },
  { value: "OVERTIME",     label: "Overtime" },
  { value: "STAT_HOLIDAY", label: "Stat holiday" },
  { value: "VACATION",     label: "Vacation" },
  { value: "OTHER",        label: "Other" },
];

export default function PayrollTimeWorkspace({
  clubId,
  canWrite,
  canApprove,
  payPeriods,
  departments,
  employees,
  initialPeriodId,
  initialDepartmentId,
  initialStatus,
}: Props) {
  const [payPeriodId, setPayPeriodId] = useState(initialPeriodId ?? "");
  const [departmentId, setDepartmentId] = useState(initialDepartmentId ?? "");
  const [status, setStatus] = useState<StatusRow[]>(initialStatus);
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "idle" | "ok" | "err"; text: string }>({
    tone: "idle", text: "",
  });

  // Add form
  const [newEmployeeId, setNewEmployeeId] = useState("");
  const [newDate, setNewDate] = useState(todayIso());
  const [newHours, setNewHours] = useState<string>("8");
  const [newCls, setNewCls] = useState("REGULAR");

  const empById = useMemo(() => {
    const m = new Map<string, EmployeeOpt>();
    for (const e of employees) m.set(e.id, e);
    return m;
  }, [employees]);
  const deptById = useMemo(() => {
    const m = new Map<string, DepartmentOpt>();
    for (const d of departments) m.set(d.id, d);
    return m;
  }, [departments]);

  const api = useCallback((path: string) => `/api/clubs/${clubId}/payroll${path}`, [clubId]);

  const refresh = useCallback(async () => {
    if (!payPeriodId) return;
    const [entriesRes, statusRes] = await Promise.all([
      fetch(api(`/time-entries?payPeriodId=${payPeriodId}${departmentId ? `&departmentId=${departmentId}` : ""}`)),
      fetch(api(`/pay-periods/${payPeriodId}/orchestrate`)),
    ]);
    if (entriesRes.ok) {
      const body = (await entriesRes.json()) as { entries: EntryRow[] };
      setEntries(body.entries);
    }
    if (statusRes.ok) {
      const body = (await statusRes.json()) as { status: StatusRow[] };
      setStatus(body.status);
    }
  }, [api, payPeriodId, departmentId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const addEntry = async () => {
    if (!newEmployeeId || !payPeriodId) return;
    const emp = empById.get(newEmployeeId);
    if (!emp) return;
    setBusy(true);
    setMessage({ tone: "idle", text: "" });
    try {
      const res = await fetch(api("/time-entries"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: newEmployeeId,
          employmentAssignmentId: emp.primaryAssignmentId,
          workDate: new Date(newDate).toISOString(),
          hours: newHours,
          earningClassification: newCls,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      // Trigger orchestration so a Work Intake card is created/refreshed.
      await fetch(api(`/pay-periods/${payPeriodId}/orchestrate`), { method: "POST" });
      await refresh();
      setNewEmployeeId("");
      setNewHours("8");
      setMessage({ tone: "ok", text: "Time entry added." });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const approveDept = async (deptId: string) => {
    if (!canApprove || !payPeriodId) return;
    setBusy(true);
    try {
      const res = await fetch(
        api(`/pay-periods/${payPeriodId}/departments/${deptId}`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve" }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      setMessage({ tone: "ok", text: "Department time approved." });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const reopenDept = async (deptId: string) => {
    if (!canApprove || !payPeriodId) return;
    const reason = window.prompt("Optional reason for reopening this department's approval?") ?? undefined;
    setBusy(true);
    try {
      const res = await fetch(
        api(`/pay-periods/${payPeriodId}/departments/${deptId}`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reopen", reason }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      setMessage({ tone: "ok", text: "Approval reopened." });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const filteredEntries = departmentId
    ? entries.filter((e) => {
        const emp = empById.get(e.employeeId);
        return emp?.primaryDepartmentId === departmentId;
      })
    : entries;

  return (
    <div className="space-y-6" data-testid="payroll-time-workspace">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="block text-sm">
          <span className="text-club-ink">Pay period</span>
          <select
            value={payPeriodId}
            onChange={(e) => setPayPeriodId(e.target.value)}
            className="spectre-input w-full mt-1"
            data-testid="time-workspace-period"
          >
            <option value="">— Select —</option>
            {payPeriods.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-club-ink">Department (filter)</span>
          <select
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            className="spectre-input w-full mt-1"
            data-testid="time-workspace-department"
          >
            <option value="">— All departments —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name} ({d.code})</option>
            ))}
          </select>
        </label>
      </div>

      {payPeriodId && (
        <section
          className="rounded-xl border border-stone-200 bg-white p-4"
          data-testid="time-workspace-status"
        >
          <h2 className="font-serif text-[16px] text-club-ink mb-2">Department approval status</h2>
          {status.length === 0 ? (
            <p className="text-sm text-stone-600">No payable time recorded for this period yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-widest text-stone-500 border-b border-stone-200/70">
                  <th className="py-2 pr-3">Department</th>
                  <th className="py-2 pr-3">Employees</th>
                  <th className="py-2 pr-3">Entries</th>
                  <th className="py-2 pr-3">Hours</th>
                  <th className="py-2 pr-3">State</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {status.map((r) => (
                  <tr key={r.departmentId} className="border-b border-stone-200/50" data-testid={`time-status-${r.departmentId}`}>
                    <td className="py-2 pr-3">
                      <div className="text-club-ink">{r.departmentName}</div>
                      <div className="font-mono text-[11px] text-stone-500">{r.departmentCode}</div>
                    </td>
                    <td className="py-2 pr-3">{r.employeeCount}</td>
                    <td className="py-2 pr-3">{r.entryCount}</td>
                    <td className="py-2 pr-3 font-mono">{r.totalHours}</td>
                    <td className="py-2 pr-3">
                      <StatePill state={r.state} />
                    </td>
                    <td className="py-2 pr-3 space-x-2">
                      {r.state !== "APPROVED" && canApprove && (
                        <button
                          type="button"
                          onClick={() => approveDept(r.departmentId)}
                          disabled={busy}
                          className="spectre-btn spectre-btn--secondary text-xs"
                          data-testid={`time-approve-${r.departmentId}`}
                        >
                          Approve
                        </button>
                      )}
                      {r.state === "APPROVED" && canApprove && (
                        <button
                          type="button"
                          onClick={() => reopenDept(r.departmentId)}
                          disabled={busy}
                          className="text-xs text-stone-600 hover:underline"
                          data-testid={`time-reopen-${r.departmentId}`}
                        >
                          Reopen
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {canWrite && payPeriodId && (
        <section
          className="rounded-xl border border-stone-200 bg-white p-4 space-y-3"
          data-testid="time-workspace-add"
        >
          <h2 className="font-serif text-[16px] text-club-ink">Add time entry</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <label className="block text-sm">
              <span className="text-club-ink">Employee</span>
              <select
                value={newEmployeeId}
                onChange={(e) => setNewEmployeeId(e.target.value)}
                className="spectre-input w-full mt-1"
                data-testid="time-add-employee"
              >
                <option value="">— Select —</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.display} ({e.employeeNumber})
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-club-ink">Work date</span>
              <input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                className="spectre-input w-full mt-1"
                data-testid="time-add-date"
              />
            </label>
            <label className="block text-sm">
              <span className="text-club-ink">Hours</span>
              <input
                type="number"
                step="0.25"
                min="0.25"
                value={newHours}
                onChange={(e) => setNewHours(e.target.value)}
                className="spectre-input w-full mt-1"
                data-testid="time-add-hours"
              />
            </label>
            <label className="block text-sm">
              <span className="text-club-ink">Earning classification</span>
              <select
                value={newCls}
                onChange={(e) => setNewCls(e.target.value)}
                className="spectre-input w-full mt-1"
                data-testid="time-add-classification"
              >
                {CLASSIFICATIONS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            onClick={addEntry}
            disabled={busy || !newEmployeeId}
            className="spectre-btn spectre-btn-primary"
            data-testid="time-add-submit"
          >
            Add time entry
          </button>
        </section>
      )}

      {payPeriodId && (
        <section className="rounded-xl border border-stone-200 bg-white p-4" data-testid="time-workspace-entries">
          <h2 className="font-serif text-[16px] text-club-ink mb-2">
            Time entries {departmentId ? `— ${deptById.get(departmentId)?.name}` : "(all departments)"}
          </h2>
          {filteredEntries.length === 0 ? (
            <p className="text-sm text-stone-600">No entries for this filter.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-widest text-stone-500 border-b border-stone-200/70">
                  <th className="py-2 pr-3">Employee</th>
                  <th className="py-2 pr-3">Work date</th>
                  <th className="py-2 pr-3">Hours</th>
                  <th className="py-2 pr-3">Type</th>
                  <th className="py-2 pr-3">State</th>
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map((e) => {
                  const emp = empById.get(e.employeeId);
                  return (
                    <tr key={e.id} className="border-b border-stone-200/50" data-testid={`time-entry-${e.id}`}>
                      <td className="py-2 pr-3">
                        <div className="text-club-ink">{emp?.display ?? e.employeeId}</div>
                        {emp?.employeeNumber && <div className="text-[11px] text-stone-500">{emp.employeeNumber}</div>}
                      </td>
                      <td className="py-2 pr-3">{new Date(e.workDate).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}</td>
                      <td className="py-2 pr-3 font-mono">{e.hours}</td>
                      <td className="py-2 pr-3">{e.earningClassification}</td>
                      <td className="py-2 pr-3">
                        <StatePill state={e.approvalState} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      {message.text && (
        <p
          role={message.tone === "err" ? "alert" : "status"}
          className={"text-sm " + (message.tone === "ok" ? "text-emerald-700" : message.tone === "err" ? "text-red-700" : "text-stone-600")}
          data-testid="time-workspace-status-message"
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

function StatePill({ state }: { state: string }) {
  const map: Record<string, string> = {
    PENDING:  "bg-amber-50 text-amber-800 border-amber-300",
    DRAFT:    "bg-amber-50 text-amber-800 border-amber-300",
    APPROVED: "bg-emerald-50 text-emerald-800 border-emerald-300",
    REOPENED: "bg-orange-50 text-orange-800 border-orange-300",
    POSTED:   "bg-stone-100 text-stone-500 border-stone-300",
  };
  const cls = map[state] ?? "bg-stone-100 text-stone-500 border-stone-300";
  return (
    <span className={`text-[10px] uppercase tracking-widest rounded px-1.5 py-0.5 border ${cls}`}>
      {state}
    </span>
  );
}

function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

"use client";

import { useCallback, useMemo, useState } from "react";

interface MembershipRow {
  id: string;
  clubId: string;
  payGroupId: string;
  employeeId: string;
  effectiveFrom: string; // ISO
  effectiveTo: string | null; // ISO
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PayGroupOpt {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

interface EmployeeOpt {
  id: string;
  display: string;
  employeeNumber: string;
  lifecycle: string | null;
}

interface Props {
  clubId: string;
  canWrite: boolean;
  initialMemberships: MembershipRow[];
  payGroups: PayGroupOpt[];
  employees: EmployeeOpt[];
}

type Mode = "assign" | "transfer";

export default function MembershipEditor({
  clubId,
  canWrite,
  initialMemberships,
  payGroups,
  employees,
}: Props) {
  const [rows, setRows] = useState<MembershipRow[]>(initialMemberships);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "idle" | "ok" | "err"; text: string }>({
    tone: "idle",
    text: "",
  });
  const [mode, setMode] = useState<Mode>("assign");
  const [employeeId, setEmployeeId] = useState("");
  const [payGroupId, setPayGroupId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [effectiveAt, setEffectiveAt] = useState(todayIso());
  const [endAt, setEndAt] = useState(todayIso());
  const [endingId, setEndingId] = useState<string | null>(null);

  const payGroupById = useMemo(() => {
    const m = new Map<string, PayGroupOpt>();
    for (const g of payGroups) m.set(g.id, g);
    return m;
  }, [payGroups]);
  const employeeById = useMemo(() => {
    const m = new Map<string, EmployeeOpt>();
    for (const e of employees) m.set(e.id, e);
    return m;
  }, [employees]);

  const api = useCallback(
    (path: string) => `/api/clubs/${clubId}/payroll/pay-group-members${path}`,
    [clubId],
  );

  const refresh = async () => {
    const res = await fetch(api(""));
    if (!res.ok) return;
    const body = (await res.json()) as { memberships: MembershipRow[] };
    setRows(body.memberships);
  };

  const assign = async () => {
    if (!canWrite || !employeeId || !payGroupId || !effectiveFrom) return;
    setBusy(true);
    try {
      const res = await fetch(api(""), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "assign",
          payGroupId,
          employeeId,
          effectiveFrom: new Date(effectiveFrom).toISOString(),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      setEmployeeId("");
      setPayGroupId("");
      setStatus({ tone: "ok", text: "Assigned." });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const transfer = async () => {
    if (!canWrite || !employeeId || !payGroupId || !effectiveAt) return;
    setBusy(true);
    try {
      const res = await fetch(api(""), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "transfer",
          employeeId,
          toPayGroupId: payGroupId,
          effectiveAt: new Date(effectiveAt).toISOString(),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      setEmployeeId("");
      setPayGroupId("");
      setStatus({ tone: "ok", text: "Transferred." });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const endRow = async (id: string) => {
    if (!canWrite || !endAt) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/${id}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "end", endAt: new Date(endAt).toISOString() }),
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      setEndingId(null);
      setStatus({ tone: "ok", text: "Membership ended." });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="membership-editor">
      {payGroups.length === 0 && (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-300 rounded px-3 py-2">
          Create at least one Pay Group in Section 2 before assigning employees.
        </p>
      )}

      {canWrite && payGroups.length > 0 && (
        <div className="rounded-xl border border-stone-200 bg-white p-4 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-club-ink font-medium">Operation:</span>
            <label className="text-sm flex items-center gap-1">
              <input
                type="radio"
                checked={mode === "assign"}
                onChange={() => setMode("assign")}
                data-testid="membership-mode-assign"
              />
              Assign
            </label>
            <label className="text-sm flex items-center gap-1">
              <input
                type="radio"
                checked={mode === "transfer"}
                onChange={() => setMode("transfer")}
                data-testid="membership-mode-transfer"
              />
              Transfer
            </label>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="block text-sm">
              <span className="text-club-ink">Employee</span>
              <select
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className="spectre-input w-full mt-1"
                data-testid="membership-employee"
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
              <span className="text-club-ink">Pay Group</span>
              <select
                value={payGroupId}
                onChange={(e) => setPayGroupId(e.target.value)}
                className="spectre-input w-full mt-1"
                data-testid="membership-pay-group"
              >
                <option value="">— Select —</option>
                {payGroups.filter((g) => g.active).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.code})
                  </option>
                ))}
              </select>
            </label>
            {mode === "assign" ? (
              <label className="block text-sm">
                <span className="text-club-ink">Effective from</span>
                <input
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                  className="spectre-input w-full mt-1"
                  data-testid="membership-effective-from"
                />
              </label>
            ) : (
              <label className="block text-sm">
                <span className="text-club-ink">Effective at</span>
                <input
                  type="date"
                  value={effectiveAt}
                  onChange={(e) => setEffectiveAt(e.target.value)}
                  className="spectre-input w-full mt-1"
                  data-testid="membership-effective-at"
                />
              </label>
            )}
          </div>
          <div>
            {mode === "assign" ? (
              <button
                type="button"
                onClick={assign}
                disabled={busy || !employeeId || !payGroupId}
                className="spectre-btn spectre-btn-primary"
                data-testid="membership-assign"
              >
                Assign to Pay Group
              </button>
            ) : (
              <button
                type="button"
                onClick={transfer}
                disabled={busy || !employeeId || !payGroupId}
                className="spectre-btn spectre-btn-primary"
                data-testid="membership-transfer"
              >
                Transfer employee
              </button>
            )}
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-stone-600" data-testid="membership-empty">
          No pay-group memberships yet. Use the form above to assign an employee.
        </p>
      ) : (
        <table className="w-full text-sm" data-testid="membership-list">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest text-stone-500 border-b border-stone-200/70">
              <th className="py-2 pr-3">Employee</th>
              <th className="py-2 pr-3">Pay Group</th>
              <th className="py-2 pr-3">Effective from</th>
              <th className="py-2 pr-3">Effective to</th>
              <th className="py-2 pr-3"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const emp = employeeById.get(r.employeeId);
              const grp = payGroupById.get(r.payGroupId);
              const from = new Date(r.effectiveFrom);
              const to = r.effectiveTo ? new Date(r.effectiveTo) : null;
              const now = new Date();
              const active = from <= now && (!to || to > now);
              const upcoming = from > now;
              return (
                <tr key={r.id} className="border-b border-stone-200/50" data-testid={`membership-row-${r.id}`}>
                  <td className="py-2 pr-3">
                    <div className="text-club-ink">{emp?.display ?? r.employeeId}</div>
                    {emp?.employeeNumber && <div className="text-[11px] text-stone-500">{emp.employeeNumber}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="text-club-ink">{grp?.name ?? r.payGroupId}</div>
                    {grp?.code && <div className="font-mono text-[11px] text-stone-500">{grp.code}</div>}
                  </td>
                  <td className="py-2 pr-3">{formatDate(from)}</td>
                  <td className="py-2 pr-3">{to ? formatDate(to) : <span className="text-stone-400">—</span>}</td>
                  <td className="py-2 pr-3">
                    {active && (
                      <span className="text-[10px] uppercase tracking-widest rounded px-1.5 py-0.5 border border-emerald-300 bg-emerald-50 text-emerald-800">
                        Active
                      </span>
                    )}
                    {upcoming && (
                      <span className="text-[10px] uppercase tracking-widest rounded px-1.5 py-0.5 border border-sky-300 bg-sky-50 text-sky-800">
                        Upcoming
                      </span>
                    )}
                    {!active && !upcoming && (
                      <span className="text-[10px] uppercase tracking-widest rounded px-1.5 py-0.5 border border-stone-300 bg-stone-100 text-stone-500">
                        Past
                      </span>
                    )}
                    {canWrite && active && !to && (
                      <div className="mt-1">
                        {endingId === r.id ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="date"
                              value={endAt}
                              onChange={(e) => setEndAt(e.target.value)}
                              className="spectre-input text-xs"
                              data-testid={`membership-end-date-${r.id}`}
                            />
                            <button
                              type="button"
                              onClick={() => endRow(r.id)}
                              disabled={busy}
                              className="text-xs text-red-700 hover:underline"
                              data-testid={`membership-end-confirm-${r.id}`}
                            >
                              End
                            </button>
                            <button
                              type="button"
                              onClick={() => setEndingId(null)}
                              disabled={busy}
                              className="text-xs text-stone-500 hover:underline"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setEndingId(r.id)}
                            disabled={busy}
                            className="text-xs text-stone-600 hover:underline"
                            data-testid={`membership-end-${r.id}`}
                          >
                            End membership
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {status.text && (
        <p
          role={status.tone === "err" ? "alert" : "status"}
          className={
            "text-sm " +
            (status.tone === "ok" ? "text-emerald-700" : status.tone === "err" ? "text-red-700" : "text-stone-600")
          }
          data-testid="membership-status"
        >
          {status.text}
        </p>
      )}
    </div>
  );
}

function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

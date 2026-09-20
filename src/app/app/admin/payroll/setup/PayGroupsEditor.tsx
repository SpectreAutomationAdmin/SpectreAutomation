"use client";

import { useCallback, useState } from "react";
import type { PayGroupView } from "@/lib/payroll/pay-groups";
import type { PayFrequency } from "@/lib/payroll/club-config";

interface Props {
  clubId: string;
  canWrite: boolean;
  initialPayGroups: PayGroupView[];
  allowedPayFrequencies: readonly string[];
}

const FREQ_LABEL: Record<string, string> = {
  WEEKLY: "Weekly",
  BIWEEKLY: "Biweekly",
  SEMI_MONTHLY: "Semi-monthly",
  MONTHLY: "Monthly",
};

export default function PayGroupsEditor({
  clubId,
  canWrite,
  initialPayGroups,
  allowedPayFrequencies,
}: Props) {
  const [rows, setRows] = useState<PayGroupView[]>(initialPayGroups);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "idle" | "ok" | "err"; text: string }>({
    tone: "idle",
    text: "",
  });
  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newFreq, setNewFreq] = useState<PayFrequency>("BIWEEKLY");
  const [newOffset, setNewOffset] = useState(5);
  const [newAnchor, setNewAnchor] = useState("");
  const [newAdjustment, setNewAdjustment] =
    useState<"NONE" | "PREVIOUS_BUSINESS_DAY" | "NEXT_BUSINESS_DAY">("PREVIOUS_BUSINESS_DAY");

  const api = useCallback((path: string) => `/api/clubs/${clubId}/payroll/pay-groups${path}`, [clubId]);

  const refresh = async () => {
    const res = await fetch(api(""));
    if (!res.ok) return;
    const body = (await res.json()) as { payGroups: PayGroupView[] };
    setRows(body.payGroups);
  };

  const create = async () => {
    if (!canWrite || !newCode.trim() || !newName.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(api(""), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: newCode,
          name: newName,
          payFrequency: newFreq,
          payDateOffsetDays: newOffset,
          calendarAnchorDate: newAnchor ? new Date(newAnchor).toISOString() : null,
          payDateAdjustment: newAdjustment,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      setNewCode("");
      setNewName("");
      setNewFreq("BIWEEKLY");
      setNewOffset(5);
      setNewAnchor("");
      setCreating(false);
      setStatus({ tone: "ok", text: "Pay group created." });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const flip = async (id: string, active: boolean) => {
    if (!canWrite) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/${id}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: active ? "activate" : "deactivate" }),
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      setStatus({ tone: "ok", text: active ? "Pay group activated." : "Pay group deactivated." });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const rename = async (id: string, name: string) => {
    if (!canWrite) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      setStatus({ tone: "ok", text: "Renamed." });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="pay-groups-editor">
      <div className="flex items-center justify-between">
        <p className="text-sm text-stone-600">
          Create as many pay groups as you need. Common patterns: one salaried group and one or
          two hourly groups on different pay cycles.
        </p>
        {canWrite && !creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="spectre-btn spectre-btn-primary"
            data-testid="pay-groups-add"
          >
            + Add Pay Group
          </button>
        )}
      </div>

      {creating && (
        <div className="rounded-xl border border-stone-200 bg-white p-4 space-y-3" data-testid="pay-groups-new">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="text-club-ink">Code</span>
              <input
                value={newCode}
                onChange={(e) => setNewCode(e.target.value.toUpperCase())}
                className="spectre-input w-full mt-1"
                placeholder="HOURLY_BW"
                maxLength={32}
                data-testid="pay-groups-new-code"
              />
              <span className="text-[11px] text-stone-500">
                Short slug: A-Z, 0-9, underscores. Cannot be renamed later.
              </span>
            </label>
            <label className="block text-sm">
              <span className="text-club-ink">Name</span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="spectre-input w-full mt-1"
                placeholder="Hourly Employees - Biweekly"
                maxLength={80}
                data-testid="pay-groups-new-name"
              />
            </label>
            <label className="block text-sm">
              <span className="text-club-ink">Pay frequency</span>
              <select
                value={newFreq}
                onChange={(e) => setNewFreq(e.target.value as PayFrequency)}
                className="spectre-input w-full mt-1"
                data-testid="pay-groups-new-freq"
              >
                {allowedPayFrequencies.map((v) => (
                  <option key={v} value={v}>{FREQ_LABEL[v] ?? v}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-club-ink">Pay date offset (calendar days after period end)</span>
              <input
                type="number"
                min={0}
                max={30}
                value={newOffset}
                onChange={(e) => setNewOffset(parseInt(e.target.value || "0", 10) || 0)}
                className="spectre-input w-full mt-1"
                data-testid="pay-groups-new-offset"
              />
              <span className="text-[11px] text-stone-500">
                Calendar days, not business days. Banking-holiday shifting will arrive in a later release.
              </span>
            </label>
            {(newFreq === "WEEKLY" || newFreq === "BIWEEKLY") && (
              <label className="block text-sm md:col-span-2">
                <span className="text-club-ink">First known period start (calendar anchor)</span>
                <input
                  type="date"
                  value={newAnchor}
                  onChange={(e) => setNewAnchor(e.target.value)}
                  className="spectre-input w-full mt-1"
                  data-testid="pay-groups-new-anchor"
                />
                <span className="text-[11px] text-stone-500">
                  Weekly and biweekly cadences need a known period-start date so Spectre can
                  establish the recurring schedule both forward and backward. Semi-monthly and
                  monthly cadences don&rsquo;t need one.
                </span>
              </label>
            )}
            {/* Slice E §23 — pay-date adjustment policy */}
            <fieldset className="md:col-span-2 mt-1" data-testid="pay-groups-new-adjustment">
              <legend className="text-club-ink text-sm">
                When a scheduled pay date falls on a weekend:
              </legend>
              <div className="mt-2 space-y-1 text-sm">
                {[
                  { v: "NONE",                  t: "Keep the scheduled date" },
                  { v: "PREVIOUS_BUSINESS_DAY", t: "Pay on the previous weekday" },
                  { v: "NEXT_BUSINESS_DAY",     t: "Pay on the next weekday" },
                ].map((o) => (
                  <label key={o.v} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="pay-groups-new-pay-adjust"
                      value={o.v}
                      checked={newAdjustment === o.v}
                      onChange={() => setNewAdjustment(o.v as typeof newAdjustment)}
                    />
                    <span>{o.t}</span>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-stone-500">
                Statutory-holiday adjustment is not yet automated. Only weekend shifts are honoured.
              </p>
            </fieldset>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={create}
              disabled={busy || !newCode.trim() || !newName.trim()}
              className="spectre-btn spectre-btn-primary"
              data-testid="pay-groups-new-save"
            >
              Create Pay Group
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              disabled={busy}
              className="text-sm text-stone-600 hover:underline"
              data-testid="pay-groups-new-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="text-sm text-stone-600" data-testid="pay-groups-empty">
          No pay groups yet. Create at least one before you can assign employees.
        </div>
      ) : (
        <ul className="divide-y divide-stone-200/70">
          {rows.map((g) => (
            <li key={g.id} className="py-3" data-testid={`pay-group-row-${g.id}`}>
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span
                      className={
                        "text-[10px] uppercase tracking-widest rounded px-1.5 py-0.5 border " +
                        (g.active
                          ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                          : "bg-stone-100 text-stone-500 border-stone-300")
                      }
                    >
                      {g.active ? "Active" : "Inactive"}
                    </span>
                    <span className="font-mono text-xs text-stone-500">{g.code}</span>
                    <span className="text-[11px] text-stone-500">
                      {FREQ_LABEL[g.payFrequency] ?? g.payFrequency} · pay date +{g.payDateOffsetDays}d
                      {g.payFrequency === "SEMI_MONTHLY" ? (
                        <>
                          {" "}·{" "}
                          <span data-testid={`pay-group-strategy-${g.id}`}>
                            {g.periodBoundaryStrategy === "LAGGED_SEMI_MONTHLY"
                              ? "Lagged (work period ends before pay date)"
                              : "Calendar (1–15 / 16–EOM)"}
                          </span>
                        </>
                      ) : null}
                      {" "}· {g.memberCount} employee{g.memberCount === 1 ? "" : "s"} assigned
                    </span>
                  </div>
                  <input
                    defaultValue={g.name}
                    onBlur={(e) => e.target.value.trim() !== g.name && rename(g.id, e.target.value)}
                    className="spectre-input w-full mt-1"
                    maxLength={80}
                    data-testid={`pay-group-name-${g.id}`}
                    disabled={!canWrite || busy}
                  />
                </div>
                {canWrite && (
                  <div className="flex items-center gap-2 shrink-0">
                    {g.active ? (
                      <button
                        type="button"
                        onClick={() => flip(g.id, false)}
                        disabled={busy}
                        className="text-sm text-stone-600 hover:underline"
                        data-testid={`pay-group-deactivate-${g.id}`}
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => flip(g.id, true)}
                        disabled={busy}
                        className="text-sm text-emerald-700 hover:underline"
                        data-testid={`pay-group-activate-${g.id}`}
                      >
                        Activate
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {status.text && (
        <p
          role={status.tone === "err" ? "alert" : "status"}
          className={
            "text-sm " +
            (status.tone === "ok" ? "text-emerald-700" : status.tone === "err" ? "text-red-700" : "text-stone-600")
          }
          data-testid="pay-groups-status"
        >
          {status.text}
        </p>
      )}
    </div>
  );
}

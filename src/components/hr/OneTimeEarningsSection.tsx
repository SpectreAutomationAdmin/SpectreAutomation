"use client";
// Slice B (2026-09-18) — Employee Payroll → One-Time Earnings section.
// Founder-facing UI for pre-batch scheduled one-time earnings (bonuses,
// spot pay, etc). Additive to the 8-section IA established in Slice A;
// replaces the intentional empty-state placeholder.

import { useState, useTransition } from "react";

export type ScheduledStatus = "SCHEDULED" | "APPLIED" | "CANCELLED";

export interface OneTimeEarningRow {
  id: string;
  componentId: string;
  componentCode: string;
  componentDisplayName: string;
  amount: string;
  reason: string;
  status: ScheduledStatus;
  payPeriodId: string;
  payPeriodLabel: string;   // pre-formatted, e.g. "Sep 16 – Sep 30 · Pay Sep 30"
  createdAt: string;
  appliedAt: string | null;
  cancelledAt: string | null;
}

export interface PayPeriodOption {
  id: string;
  label: string;             // "Sep 16 – Sep 30, 2026 — Pay Sep 30, 2026"
  payDateIso: string;
  isCurrent: boolean;        // highlight as the sensible default
}

export interface OneTimeComponentOption {
  id: string;
  code: string;
  displayName: string;       // "Performance Bonus"
}

export interface OneTimeEarningsSectionProps {
  clubId: string;
  employeeId: string;
  canWrite: boolean;
  rows: OneTimeEarningRow[];
  eligibleComponents: OneTimeComponentOption[];
  payPeriodOptions: PayPeriodOption[];
  actions: {
    schedule: (
      clubId: string,
      employeeId: string,
      input: { componentId: string; payPeriodId: string; amount: string; reason: string; notes?: string | null },
    ) => Promise<{ ok: boolean; error?: string }>;
    cancel: (
      clubId: string,
      employeeId: string,
      scheduledId: string,
      reason?: string | null,
    ) => Promise<{ ok: boolean; error?: string }>;
  };
}

function formatMoney(v: string): string {
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString("en-CA", { style: "currency", currency: "CAD" })
    : v;
}
function humanStatus(s: ScheduledStatus): { label: string; tone: "ok" | "warn" | "neutral" } {
  switch (s) {
    case "SCHEDULED": return { label: "Scheduled",            tone: "warn"    };
    case "APPLIED":   return { label: "Included in Payroll",  tone: "ok"      };
    case "CANCELLED": return { label: "Cancelled",            tone: "neutral" };
  }
}
function Pill({ tone, children }: { tone: "ok" | "warn" | "neutral"; children: React.ReactNode }) {
  const cls = tone === "ok"
    ? "bg-[#dcfce7] text-[#166534]"
    : tone === "warn"
      ? "bg-amber-100 text-amber-800"
      : "bg-stone-200 text-stone-700";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase ${cls}`}>
      {children}
    </span>
  );
}

export default function OneTimeEarningsSection(props: OneTimeEarningsSectionProps) {
  const { clubId, employeeId, canWrite, rows, eligibleComponents, payPeriodOptions, actions } = props;
  const [showForm, setShowForm] = useState(false);
  const [componentId, setComponentId] = useState<string>(eligibleComponents[0]?.id ?? "");
  const [payPeriodId, setPayPeriodId] = useState<string>(
    payPeriodOptions.find((p) => p.isCurrent)?.id ?? payPeriodOptions[0]?.id ?? "",
  );
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="spectre-person-section mt-6" data-testid="payroll-one-time-earnings-slice-b">
      <div className="spectre-person-section-head flex items-center justify-between">
        <h3 className="spectre-person-eyebrow">One-Time Earnings</h3>
        {canWrite && eligibleComponents.length > 0 && payPeriodOptions.length > 0 && !showForm && (
          <button
            type="button"
            className="text-xs text-blue-700 hover:underline"
            onClick={() => { setShowForm(true); setError(null); }}
            data-testid="one-time-earning-add"
          >
            + Add One-Time Earning
          </button>
        )}
      </div>

      {rows.length === 0 && !showForm && (
        <p className="mt-2 text-sm text-stone-500">No one-time earnings scheduled.</p>
      )}

      {rows.length > 0 && (
        <table className="w-full text-sm mt-3" data-testid="one-time-earnings-table">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-stone-500 border-b border-stone-200">
              <th className="py-2 pr-3">Type</th>
              <th className="py-2 pr-3">Amount</th>
              <th className="py-2 pr-3">Pay period</th>
              <th className="py-2 pr-3">Reason</th>
              <th className="py-2 pr-3">Status</th>
              {canWrite && <th className="py-2 pr-3 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = humanStatus(r.status);
              return (
                <tr key={r.id} className="border-b border-stone-100" data-testid={`one-time-earning-row-${r.id}`}>
                  <td className="py-2 pr-3 text-stone-900">{r.componentDisplayName}</td>
                  <td className="py-2 pr-3 font-mono">{formatMoney(r.amount)}</td>
                  <td className="py-2 pr-3 text-stone-700">{r.payPeriodLabel}</td>
                  <td className="py-2 pr-3 text-stone-600">{r.reason}</td>
                  <td className="py-2 pr-3"><Pill tone={s.tone}>{s.label}</Pill></td>
                  {canWrite && (
                    <td className="py-2 pr-3 text-right">
                      {r.status === "SCHEDULED" && (
                        <button
                          type="button"
                          className="text-xs text-red-700 hover:underline"
                          data-testid={`one-time-earning-cancel-${r.id}`}
                          onClick={() => {
                            if (!confirm(`Cancel scheduled ${r.componentDisplayName} for ${r.payPeriodLabel}?`)) return;
                            startTransition(async () => {
                              const res = await actions.cancel(clubId, employeeId, r.id, null);
                              if (!res.ok) setError(res.error ?? "Failed to cancel");
                            });
                          }}
                          disabled={isPending}
                        >
                          Cancel
                        </button>
                      )}
                      {r.status === "APPLIED" && (
                        <span className="text-[10px] text-stone-500">Frozen into payroll</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {showForm && (
        <form
          className="mt-4 border border-stone-200 rounded p-3 space-y-3"
          data-testid="one-time-earning-form"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (!componentId || !payPeriodId || !amount || !reason.trim()) {
              setError("Type, amount, pay period, and reason are required.");
              return;
            }
            startTransition(async () => {
              const res = await actions.schedule(clubId, employeeId, {
                componentId, payPeriodId, amount, reason, notes: notes || null,
              });
              if (!res.ok) {
                setError(res.error ?? "Failed to schedule");
                return;
              }
              setShowForm(false);
              setAmount(""); setReason(""); setNotes("");
            });
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs">
              <span className="block text-stone-500 mb-1">Type</span>
              <select
                className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
                value={componentId}
                onChange={(e) => setComponentId(e.target.value)}
                data-testid="one-time-earning-component"
              >
                {eligibleComponents.map((c) => (
                  <option key={c.id} value={c.id}>{c.displayName}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs">
              <span className="block text-stone-500 mb-1">Amount</span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="1500.00"
                className="w-full rounded border border-stone-300 px-2 py-1 text-sm font-mono"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="one-time-earning-amount"
              />
            </label>
            <label className="block text-xs col-span-2">
              <span className="block text-stone-500 mb-1">Pay with</span>
              <select
                className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
                value={payPeriodId}
                onChange={(e) => setPayPeriodId(e.target.value)}
                data-testid="one-time-earning-payperiod"
              >
                {payPeriodOptions.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}{p.isCurrent ? "  (current)" : ""}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs col-span-2">
              <span className="block text-stone-500 mb-1">Reason</span>
              <input
                type="text"
                placeholder="Performance bonus"
                className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-testid="one-time-earning-reason"
              />
            </label>
            <label className="block text-xs col-span-2">
              <span className="block text-stone-500 mb-1">Notes (optional)</span>
              <input
                type="text"
                className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              className="rounded border border-stone-300 px-3 py-1 text-xs"
              onClick={() => { setShowForm(false); setError(null); }}
              disabled={isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded bg-stone-900 text-white px-3 py-1 text-xs disabled:opacity-50"
              disabled={isPending}
              data-testid="one-time-earning-save"
            >
              {isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}

      {rows.length === 0 && showForm === false && payPeriodOptions.length === 0 && (
        <p className="mt-2 text-xs text-stone-400">
          No open pay period exists yet for this employee's pay group.
        </p>
      )}
      {rows.length === 0 && showForm === false && eligibleComponents.length === 0 && payPeriodOptions.length > 0 && (
        <p className="mt-2 text-xs text-stone-400">
          No one-time-eligible earning components in the Club catalogue.
          Configure a Bonus in <em>Payroll Settings → Payroll components</em> with usage = ONE_TIME or BOTH.
        </p>
      )}
    </div>
  );
}

"use client";

// FPP-3 (2026-09-20) — Recurring Component Add flow (hotfix).
//
// The Employee → Payroll grid card "2. Recurring Earnings & Deductions"
// previously exposed a "+ Add Component" link that pointed to a
// non-existent `#recurring` fragment — clicking it did nothing. This
// component restores the workflow with a modal dialog that reuses the
// canonical Payroll-3C-1 EmployeeRecurringPayrollComponent architecture
// via the existing addRecurringPayrollComponentAction server action.
//
// UI adapts to the selected component's calculationMethod:
//
//   FIXED_AMOUNT                 → dollar amount per pay input
//   PERCENT_OF_ELIGIBLE_EARNINGS → percentage input (converted to bps)
//
// Effective date is required (no silent invention). Any server-side
// validation error (overlap, permission, catalogue mismatch) surfaces
// as an inline actionable message and the user's entered values are
// preserved for correction.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export interface RecurringAddComponentChoice {
  id: string;
  code: string;
  displayName: string;
  category: string;
  side: string;
  cashEffect: string;
  calculationMethod: "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS";
}

type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

export interface RecurringComponentAddModalProps {
  employeeId: string;
  clubId: string;
  canWrite: boolean;
  catalogue: RecurringAddComponentChoice[];
  addAction: (
    employeeId: string,
    clubId: string,
    input: {
      componentId: string;
      amount: string | null;
      percentBps: number | null;
      effectiveFrom: string;
      notes?: string | null;
    },
  ) => Promise<ActionResult>;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function RecurringComponentAddModal(props: RecurringComponentAddModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [componentId, setComponentId] = useState("");
  const [amount, setAmount] = useState("");
  const [percent, setPercent] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState<string>(todayIso());
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = useMemo(
    () => props.catalogue.find((c) => c.id === componentId) ?? null,
    [componentId, props.catalogue],
  );
  const isPercent = selected?.calculationMethod === "PERCENT_OF_ELIGIBLE_EARNINGS";

  function reset() {
    setComponentId(""); setAmount(""); setPercent("");
    setEffectiveFrom(todayIso()); setNotes(""); setErr(null);
  }

  if (!props.canWrite) {
    return (
      <span className="text-[12px] text-stone-500" title="Requires Payroll Admin access">
        + Add Component
      </span>
    );
  }

  if (props.catalogue.length === 0) {
    return (
      <span className="text-[12px] text-stone-500" title="No configured payroll components — configure in Payroll Settings first">
        + Add Component (catalogue empty)
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className="text-[12px] font-medium text-[#1e40af] hover:underline"
        onClick={() => setOpen(true)}
        data-testid="grid-recurring-add"
      >
        + Add Component
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-6"
          role="dialog"
          aria-modal
          data-testid="recurring-add-modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-xl rounded-lg bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-baseline justify-between">
              <div>
                <h3 className="text-lg font-semibold text-stone-900">Add Recurring Component</h3>
                <p className="mt-1 text-xs text-stone-600">
                  Assign a configured payroll component to this employee with an amount or
                  percentage and an effective date. Applies to the next PREPARED payroll batch;
                  batches already prepared are frozen and unaffected.
                </p>
              </div>
              <button
                type="button"
                className="text-sm text-stone-500 hover:text-stone-900"
                onClick={() => { setOpen(false); reset(); }}
                data-testid="recurring-add-close"
              >
                ✕ Close
              </button>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!componentId) { setErr("Choose a component."); return; }
                if (!effectiveFrom) { setErr("Effective date is required."); return; }
                if (!isPercent && !amount) { setErr("Enter an amount per pay."); return; }
                if (isPercent && !percent) { setErr("Enter a percentage."); return; }
                setPending(true); setErr(null);
                const parsedPercent = isPercent ? Math.round(Number(percent) * 100) : null;
                const r = await props.addAction(props.employeeId, props.clubId, {
                  componentId,
                  amount: isPercent ? null : (amount || null),
                  percentBps: parsedPercent != null && Number.isFinite(parsedPercent) ? parsedPercent : null,
                  effectiveFrom,
                  notes: notes.trim() || null,
                });
                setPending(false);
                if (!r.ok) { setErr(r.error); return; }
                setOpen(false);
                reset();
                router.refresh();
              }}
              className="space-y-4"
              data-testid="recurring-add-form"
            >
              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-stone-700">Payroll component</span>
                <select
                  required
                  value={componentId}
                  onChange={(e) => setComponentId(e.target.value)}
                  className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                  data-testid="recurring-add-component"
                >
                  <option value="">— Select —</option>
                  {props.catalogue.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName} ({c.category.replace(/_/g, " ").toLowerCase()})
                    </option>
                  ))}
                </select>
              </label>

              {selected ? (
                <div
                  className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[11.5px]"
                  data-testid="recurring-add-context"
                >
                  <p className="font-semibold text-stone-800">{selected.displayName}</p>
                  <p className="mt-0.5 text-stone-600">
                    {selected.category.replace(/_/g, " ").toLowerCase()}
                    {" · "}
                    {selected.calculationMethod === "PERCENT_OF_ELIGIBLE_EARNINGS"
                      ? "percentage of eligible earnings"
                      : "fixed amount per pay"}
                    {" · "}
                    {selected.side === "EMPLOYER"
                      ? "employer contribution"
                      : selected.cashEffect === "INCREASES_NET_PAY"
                      ? "increases net pay"
                      : selected.cashEffect === "DECREASES_NET_PAY"
                      ? "reduces net pay"
                      : "no net-pay effect"}
                  </p>
                  <p className="mt-1 text-stone-500">
                    Statutory treatment and GL accounts are configured on this component in{" "}
                    <em>Payroll Settings</em>. This assignment sets only the amount and effective date.
                  </p>
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {selected && !isPercent ? (
                  <label className="block text-xs">
                    <span className="mb-1 block font-semibold text-stone-700">Amount per pay (CAD)</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="w-full rounded border border-stone-300 px-2 py-1.5 text-right font-mono text-sm"
                      placeholder="0.00"
                      data-testid="recurring-add-amount"
                    />
                  </label>
                ) : null}
                {selected && isPercent ? (
                  <label className="block text-xs">
                    <span className="mb-1 block font-semibold text-stone-700">Percentage</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        required
                        value={percent}
                        onChange={(e) => setPercent(e.target.value)}
                        className="w-full rounded border border-stone-300 px-2 py-1.5 text-right font-mono text-sm"
                        placeholder="0.00"
                        data-testid="recurring-add-percent"
                      />
                      <span className="text-sm text-stone-500">%</span>
                    </div>
                  </label>
                ) : null}
                <label className="block text-xs">
                  <span className="mb-1 block font-semibold text-stone-700">Effective from</span>
                  <input
                    type="date"
                    required
                    value={effectiveFrom}
                    onChange={(e) => setEffectiveFrom(e.target.value)}
                    className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                    data-testid="recurring-add-effective"
                  />
                </label>
              </div>

              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-stone-700">Notes (optional)</span>
                <input
                  type="text"
                  maxLength={240}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                  data-testid="recurring-add-notes"
                />
              </label>

              {err ? (
                <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800"
                   data-testid="recurring-add-error">
                  {err}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-3 border-t pt-4">
                <button
                  type="submit"
                  disabled={pending || !componentId}
                  className="rounded-md bg-[#1e40af] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[#1e3a8a] disabled:opacity-50"
                  data-testid="recurring-add-submit"
                >
                  {pending ? "Saving..." : "Save assignment"}
                </button>
                <button
                  type="button"
                  className="text-[13px] text-stone-500 hover:text-stone-900"
                  onClick={() => { setOpen(false); reset(); }}
                  data-testid="recurring-add-cancel"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

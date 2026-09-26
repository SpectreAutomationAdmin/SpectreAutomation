"use client";

// Phase 4 (2026-09-16) — Employee Profile · Recurring Payroll
// Components section.
//
// Reuses the Payroll-3C-1 EmployeeRecurringPayrollComponent
// architecture: a Club catalogue of PayrollComponents defines WHAT
// exists (statutory/GL semantics), and each employee assignment
// records WHICH components apply plus amount + effective date.
//
// The component definition (statutory treatment, GL accounts,
// cash effect, category, side) is out-of-scope of this section —
// those live on Payroll Settings and are frozen at assignment
// snapshot time. The section renders:
//
//   * Active (current) assignments
//   * Upcoming (effectiveFrom in future) assignments
//   * Historical (ended) assignments — collapsed, with dates
//
// Add-flow lets an authorized admin pick from the Club's ACTIVE
// eligible PayrollComponents, enter an amount (for FIXED_AMOUNT)
// or a percent-basis-points value (for PERCENT_OF_ELIGIBLE_EARNINGS),
// and set an effective date. Ending an assignment sets effectiveTo
// so history is preserved — the assignment is never deleted.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCivilDate } from "@/lib/format/civil-date";

export interface RecurringComponentCatalogueOption {
  id: string;
  code: string;
  displayName: string;
  category: string;
  side: string;
  cashEffect: string;
  calculationMethod: "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS";
  displaySection: string;
}

export interface RecurringComponentAssignmentRow {
  id: string;
  componentId: string;
  componentCode: string;
  componentDisplayName: string;
  componentCategory: string;
  componentSide: string;
  cashEffect: string;
  calculationMethod: string;
  displaySection: string;
  amount: string | null;
  percentBps: number | null;
  effectiveFrom: string;   // ISO
  effectiveTo: string | null; // ISO or null
  active: boolean;
  notes: string | null;
}

type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

interface Props {
  employeeId: string;
  clubId: string;
  canWrite: boolean;
  catalogue: RecurringComponentCatalogueOption[];
  assignments: RecurringComponentAssignmentRow[];
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
  endAction: (
    employeeId: string,
    clubId: string,
    assignmentId: string,
    effectiveTo: string,
  ) => Promise<ActionResult>;
  changeAction: (
    employeeId: string,
    clubId: string,
    predecessorId: string,
    input: {
      amount: string | null;
      percentBps: number | null;
      effectiveFrom: string;
      notes?: string | null;
    },
  ) => Promise<ActionResult>;
}

// AUTH-3D.CLOSEOUT-FIX (2026-09-26): compensation-component effective
// dates are business civil dates. Delegate to the shared UTC-safe
// renderer so an effective-from of "2026-09-26" reads as September 26
// regardless of the viewer's timezone.
function fmtDate(iso: string | null): string {
  return formatCivilDate(iso, { fallback: "current" }) ?? "current";
}

function fmtMoney(amount: string | null): string {
  if (amount == null) return "—";
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return `$${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPercent(percentBps: number | null): string {
  if (percentBps == null) return "—";
  return `${(percentBps / 100).toFixed(2)}%`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function partition(rows: RecurringComponentAssignmentRow[]): {
  active: RecurringComponentAssignmentRow[];
  upcoming: RecurringComponentAssignmentRow[];
  historical: RecurringComponentAssignmentRow[];
} {
  const now = new Date();
  const active: RecurringComponentAssignmentRow[] = [];
  const upcoming: RecurringComponentAssignmentRow[] = [];
  const historical: RecurringComponentAssignmentRow[] = [];
  for (const r of rows) {
    const from = new Date(r.effectiveFrom);
    const to = r.effectiveTo ? new Date(r.effectiveTo) : null;
    if (from > now) {
      upcoming.push(r);
    } else if (to != null && to <= now) {
      historical.push(r);
    } else if (r.active) {
      active.push(r);
    } else {
      historical.push(r);
    }
  }
  return { active, upcoming, historical };
}

export default function EmployeeRecurringComponentsSection(props: Props) {
  const { active, upcoming, historical } = partition(props.assignments);

  return (
    <div className="spectre-person-section mt-6" data-testid="payroll-recurring-components-section">
      <div className="spectre-person-section-head">
        <h3 className="spectre-person-eyebrow">Recurring Earnings</h3>
      </div>
      <p className="mt-1 text-xs text-stone-500">
        Recurring earnings and deductions defined in the Club's Payroll Components catalogue.
        Amounts and effective dates are set here; statutory treatment and GL accounts are defined by each
        component in <em>Payroll Settings → Payroll components</em>.
      </p>

      <div className="mt-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Active</p>
        {active.length === 0 ? (
          <p className="mt-1 text-sm text-stone-500" data-testid="payroll-recurring-active-empty">
            No active recurring components.
          </p>
        ) : (
          <ul className="mt-2 space-y-2" data-testid="payroll-recurring-active-list">
            {active.map((r) => (
              <RowView
                key={r.id}
                assignment={r}
                canWrite={props.canWrite}
                employeeId={props.employeeId}
                clubId={props.clubId}
                endAction={props.endAction}
                changeAction={props.changeAction}
              />
            ))}
          </ul>
        )}
      </div>

      {upcoming.length > 0 ? (
        <div className="mt-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Upcoming</p>
          <ul className="mt-2 space-y-2" data-testid="payroll-recurring-upcoming-list">
            {upcoming.map((r) => (
              <RowView
                key={r.id}
                assignment={r}
                canWrite={props.canWrite}
                employeeId={props.employeeId}
                clubId={props.clubId}
                endAction={props.endAction}
                changeAction={props.changeAction}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {historical.length > 0 ? (
        <details className="mt-5" data-testid="payroll-recurring-historical-details">
          <summary className="text-[11px] font-semibold uppercase tracking-wide text-stone-500 cursor-pointer">
            Historical ({historical.length})
          </summary>
          <ul className="mt-2 space-y-2" data-testid="payroll-recurring-historical-list">
            {historical.map((r) => (
              <RowView
                key={r.id}
                assignment={r}
                canWrite={false}
                employeeId={props.employeeId}
                clubId={props.clubId}
                endAction={props.endAction}
                changeAction={props.changeAction}
              />
            ))}
          </ul>
        </details>
      ) : null}

      {props.canWrite ? (
        <AddForm
          employeeId={props.employeeId}
          clubId={props.clubId}
          catalogue={props.catalogue}
          addAction={props.addAction}
        />
      ) : null}
    </div>
  );
}

function RowView({
  assignment, canWrite, employeeId, clubId, endAction, changeAction,
}: {
  assignment: RecurringComponentAssignmentRow;
  canWrite: boolean;
  employeeId: string;
  clubId: string;
  endAction: (employeeId: string, clubId: string, assignmentId: string, effectiveTo: string) => Promise<ActionResult>;
  changeAction: Props["changeAction"];
}) {
  const router = useRouter();
  const [showEnd, setShowEnd] = useState(false);
  const [showChange, setShowChange] = useState(false);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [endDate, setEndDate] = useState(todayIso());
  const [changeDate, setChangeDate] = useState(todayIso());
  const [changeAmount, setChangeAmount] = useState<string>(assignment.amount ?? "");
  const [changePercent, setChangePercent] = useState<string>(
    assignment.percentBps != null ? (assignment.percentBps / 100).toFixed(2) : "",
  );
  const isPercentRow = assignment.calculationMethod === "PERCENT_OF_ELIGIBLE_EARNINGS";

  const amountLabel = assignment.calculationMethod === "PERCENT_OF_ELIGIBLE_EARNINGS"
    ? fmtPercent(assignment.percentBps)
    : `${fmtMoney(assignment.amount)} / pay`;

  return (
    <li
      className="rounded-md border border-stone-200 bg-white px-3 py-2"
      data-testid={`payroll-recurring-row-${assignment.id}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-stone-800">{assignment.componentDisplayName}</p>
          <p className="text-[11.5px] text-stone-500">
            {assignment.componentCode} · {assignment.componentCategory.replace(/_/g, " ").toLowerCase()}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm tabular-nums text-stone-900">{amountLabel}</p>
          <p className="text-[11px] text-stone-500">
            {fmtDate(assignment.effectiveFrom)} → {fmtDate(assignment.effectiveTo)}
          </p>
        </div>
      </div>
      {canWrite ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!showEnd && !showChange ? (
            <>
              <button
                type="button"
                className="text-[12px] text-[#1e40af] hover:underline"
                onClick={() => setShowChange(true)}
                data-testid={`payroll-recurring-change-open-${assignment.id}`}
              >
                Schedule change
              </button>
              <button
                type="button"
                className="text-[12px] text-[#dc2626] hover:underline"
                onClick={() => setShowEnd(true)}
                data-testid={`payroll-recurring-end-open-${assignment.id}`}
              >
                End assignment
              </button>
            </>
          ) : null}
          {showEnd ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setPending(true); setErr(null);
                const r = await endAction(employeeId, clubId, assignment.id, endDate);
                setPending(false);
                if (!r.ok) { setErr(r.error); return; }
                setShowEnd(false);
                router.refresh();
              }}
              className="flex items-center gap-2"
              data-testid={`payroll-recurring-end-form-${assignment.id}`}
            >
              <label className="text-[12px] text-stone-600">
                End date
                <input
                  type="date"
                  required
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="ml-1 h-7 rounded border border-stone-200 px-1 text-[12px]"
                  data-testid={`payroll-recurring-end-date-${assignment.id}`}
                />
              </label>
              <button
                type="submit"
                disabled={pending}
                className="rounded-md border border-stone-300 px-2 py-1 text-[12px] font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
                data-testid={`payroll-recurring-end-submit-${assignment.id}`}
              >
                {pending ? "Ending…" : "Confirm end"}
              </button>
              <button
                type="button"
                className="text-[12px] text-stone-500"
                onClick={() => { setShowEnd(false); setErr(null); }}
              >
                Cancel
              </button>
            </form>
          ) : null}
          {showChange ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setPending(true); setErr(null);
                const parsedPercent = isPercentRow
                  ? Math.round(Number(changePercent) * 100)
                  : null;
                const r = await changeAction(employeeId, clubId, assignment.id, {
                  amount: isPercentRow ? null : (changeAmount || null),
                  percentBps: parsedPercent != null && Number.isFinite(parsedPercent) ? parsedPercent : null,
                  effectiveFrom: changeDate,
                });
                setPending(false);
                if (!r.ok) { setErr(r.error); return; }
                setShowChange(false);
                router.refresh();
              }}
              className="flex flex-wrap items-center gap-2 rounded-md bg-stone-50 px-2 py-2"
              data-testid={`payroll-recurring-change-form-${assignment.id}`}
            >
              <label className="text-[12px] text-stone-600">
                Effective from
                <input
                  type="date"
                  required
                  value={changeDate}
                  onChange={(e) => setChangeDate(e.target.value)}
                  className="ml-1 h-7 rounded border border-stone-200 px-1 text-[12px]"
                  data-testid={`payroll-recurring-change-date-${assignment.id}`}
                />
              </label>
              {isPercentRow ? (
                <label className="text-[12px] text-stone-600">
                  New percentage
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    required
                    value={changePercent}
                    onChange={(e) => setChangePercent(e.target.value)}
                    className="ml-1 h-7 w-20 rounded border border-stone-200 px-1 text-[12px]"
                    data-testid={`payroll-recurring-change-percent-${assignment.id}`}
                  />
                  <span className="ml-0.5">%</span>
                </label>
              ) : (
                <label className="text-[12px] text-stone-600">
                  New amount (CAD)
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={changeAmount}
                    onChange={(e) => setChangeAmount(e.target.value)}
                    className="ml-1 h-7 w-24 rounded border border-stone-200 px-1 text-[12px]"
                    data-testid={`payroll-recurring-change-amount-${assignment.id}`}
                  />
                </label>
              )}
              <button
                type="submit"
                disabled={pending}
                className="rounded-md border border-[#1e40af] bg-[#1e40af] px-2 py-1 text-[12px] font-medium text-white hover:bg-[#1e3a8a] disabled:opacity-50"
                data-testid={`payroll-recurring-change-submit-${assignment.id}`}
              >
                {pending ? "Scheduling…" : "Confirm change"}
              </button>
              <button
                type="button"
                className="text-[12px] text-stone-500"
                onClick={() => { setShowChange(false); setErr(null); }}
              >
                Cancel
              </button>
            </form>
          ) : null}
          {err ? (
            <span className="text-[11.5px] text-[#8a2f00]" data-testid={`payroll-recurring-err-${assignment.id}`}>{err}</span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function AddForm({
  employeeId, clubId, catalogue, addAction,
}: {
  employeeId: string;
  clubId: string;
  catalogue: RecurringComponentCatalogueOption[];
  addAction: Props["addAction"];
}) {
  const router = useRouter();
  const [componentId, setComponentId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [percent, setPercent] = useState<string>("");
  const [effectiveFrom, setEffectiveFrom] = useState<string>(todayIso());
  const [notes, setNotes] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = catalogue.find((c) => c.id === componentId) ?? null;
  const isPercent = selected?.calculationMethod === "PERCENT_OF_ELIGIBLE_EARNINGS";

  return (
    <details className="mt-6" data-testid="payroll-recurring-add-details">
      <summary
        className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-[12.5px] font-medium text-stone-700 hover:bg-stone-100"
        data-testid="payroll-recurring-add-open"
      >
        + Add Recurring Component
      </summary>
      <form
        className="mt-3 rounded-md border border-stone-200 bg-white p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!componentId) { setErr("Choose a component."); return; }
          setPending(true); setErr(null);
          const parsedPercent = isPercent
            ? Math.round(Number(percent) * 100)
            : null;
          const r = await addAction(employeeId, clubId, {
            componentId,
            amount: isPercent ? null : amount || null,
            percentBps: parsedPercent != null && Number.isFinite(parsedPercent) ? parsedPercent : null,
            effectiveFrom,
            notes: notes.trim() || null,
          });
          setPending(false);
          if (!r.ok) { setErr(r.error); return; }
          // Reset + refresh.
          setComponentId(""); setAmount(""); setPercent(""); setEffectiveFrom(todayIso()); setNotes("");
          router.refresh();
        }}
        data-testid="payroll-recurring-add-form"
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="text-[12.5px]">
            <span className="mb-0.5 block font-medium text-stone-700">Payroll component</span>
            <select
              required
              value={componentId}
              onChange={(e) => setComponentId(e.target.value)}
              className="h-8 w-full rounded border border-stone-200 px-2 text-[12.5px]"
              data-testid="payroll-recurring-add-component"
            >
              <option value="">— Select —</option>
              {catalogue.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName} ({c.category.replace(/_/g, " ").toLowerCase()})
                </option>
              ))}
            </select>
          </label>
          <label className="text-[12.5px]">
            <span className="mb-0.5 block font-medium text-stone-700">Effective from</span>
            <input
              type="date"
              required
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              className="h-8 w-full rounded border border-stone-200 px-2 text-[12.5px]"
              data-testid="payroll-recurring-add-effective"
            />
          </label>
          {selected ? (
            <div
              className="col-span-full rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[11.5px]"
              data-testid="payroll-recurring-add-context"
            >
              <p className="font-semibold text-stone-800">{selected.displayName}</p>
              <p className="mt-0.5 text-stone-600">
                {selected.category.replace(/_/g, " ").toLowerCase()}
                {" · "}
                {selected.calculationMethod === "PERCENT_OF_ELIGIBLE_EARNINGS" ? "percentage of eligible earnings" : "fixed amount"}
                {" · "}
                {selected.side === "EMPLOYER" ? "employer contribution" : selected.cashEffect === "INCREASES_NET_PAY" ? "increases net pay" : selected.cashEffect === "DECREASES_NET_PAY" ? "reduces net pay" : "no net-pay effect"}
              </p>
              <p className="mt-1 text-stone-500">
                Statutory treatment (taxable, CPP-pensionable, EI-insurable) and GL accounts are configured on this component in <em>Payroll Settings</em>. This employee assignment only sets the amount and effective date.
              </p>
            </div>
          ) : null}
          {selected && !isPercent ? (
            <label className="text-[12.5px]">
              <span className="mb-0.5 block font-medium text-stone-700">Amount per pay (CAD)</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="h-8 w-full rounded border border-stone-200 px-2 text-[12.5px]"
                data-testid="payroll-recurring-add-amount"
              />
            </label>
          ) : null}
          {selected && isPercent ? (
            <label className="text-[12.5px]">
              <span className="mb-0.5 block font-medium text-stone-700">Percentage of eligible earnings</span>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  required
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                  className="h-8 w-full rounded border border-stone-200 px-2 text-[12.5px]"
                  data-testid="payroll-recurring-add-percent"
                />
                <span className="text-[12.5px] text-stone-500">%</span>
              </div>
            </label>
          ) : null}
        </div>
        <label className="mt-3 block text-[12.5px]">
          <span className="mb-0.5 block font-medium text-stone-700">Notes (optional)</span>
          <input
            type="text"
            maxLength={240}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="h-8 w-full rounded border border-stone-200 px-2 text-[12.5px]"
            data-testid="payroll-recurring-add-notes"
          />
        </label>
        <div className="mt-3 flex items-center justify-between">
          <p className="text-[11px] text-stone-500">
            Applies to the next PREPARED payroll batch. Batches already prepared are frozen and unaffected.
          </p>
          <button
            type="submit"
            disabled={pending || !componentId}
            className="rounded-md bg-[#1e40af] px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-[#1e3a8a] disabled:opacity-50"
            data-testid="payroll-recurring-add-submit"
          >
            {pending ? "Saving…" : "Save assignment"}
          </button>
        </div>
        {err ? (
          <p className="mt-2 text-[12px] text-[#8a2f00]" data-testid="payroll-recurring-add-error">{err}</p>
        ) : null}
      </form>
    </details>
  );
}

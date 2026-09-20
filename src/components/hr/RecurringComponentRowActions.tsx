"use client";

// FPP-4 (2026-09-20) — Change / End controls per recurring assignment row.
//
// The Employee → Payroll grid card "2. Recurring Earnings & Deductions"
// previously showed a read-only summary. This client component wraps
// each row with the canonical Payroll-3C-1 Change and End effective-
// dated actions so the founder never needs to visit the legacy Payroll
// section to correct an assignment.
//
// Semantics preserved:
//   * Change → an existing assignment is ENDED at (change effectiveFrom
//     minus one day) and a new successor row is created starting on the
//     change date. Amount/percent/notes may be updated together.
//   * End → sets effectiveTo on the assignment (half-open interval
//     semantics). No mutation of history.
//
// Both flows call the canonical actions exported from
// _recurring-component-actions.ts. No new server contract; no service
// change.

import { useState } from "react";
import { useRouter } from "next/navigation";

type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

export interface RecurringComponentRow {
  id: string;
  componentDisplayName: string;
  componentCode: string;
  amount: string | null;
  percentBps: number | null;
  calculationMethod: "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS";
  effectiveFromIso: string;
  effectiveToIso: string | null;
  active: boolean;
  /** FPP-4A (2026-09-20) — whether this assignment has been consumed
   *  by a PayrollBatchComponentSnapshot yet. When false, "Correct" is
   *  the appropriate control (edits in place). When true, only
   *  effective-dated "Change" applies. */
  isConsumed?: boolean;
}

export interface RecurringComponentRowActionsProps {
  employeeId: string;
  clubId: string;
  canWrite: boolean;
  row: RecurringComponentRow;
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
  /** FPP-4A — correction path for unused assignments. Required alongside
   *  changeAction; the UI chooses which control to render based on
   *  row.isConsumed. */
  correctAction?: (
    employeeId: string,
    clubId: string,
    assignmentId: string,
    input: {
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
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function RecurringComponentRowActions(props: RecurringComponentRowActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showChange, setShowChange] = useState(false);
  const [showEnd, setShowEnd] = useState(false);

  const isPercent = props.row.calculationMethod === "PERCENT_OF_ELIGIBLE_EARNINGS";
  const [changeAmount, setChangeAmount] = useState<string>(props.row.amount ?? "");
  const [changePercent, setChangePercent] = useState<string>(
    props.row.percentBps != null ? (props.row.percentBps / 100).toFixed(2) : "",
  );
  const [changeDate, setChangeDate] = useState<string>(props.row.effectiveFromIso.slice(0, 10));
  const [endDate, setEndDate] = useState<string>(todayIso());

  if (!props.canWrite) return null;

  // FPP-4A (2026-09-20) — an unused, still-active assignment gets the
  // Correct control (edits in place). A consumed assignment gets the
  // canonical effective-dated Change control instead.
  const useCorrect =
    props.correctAction != null && props.row.isConsumed === false && props.row.active;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {!showChange && !showEnd ? (
        <>
          <button
            type="button"
            className="text-[11.5px] font-medium text-[#1e40af] hover:underline"
            onClick={() => { setShowChange(true); setErr(null); }}
            data-testid={
              useCorrect
                ? `grid-recurring-correct-open-${props.row.id}`
                : `grid-recurring-change-open-${props.row.id}`
            }
          >
            {useCorrect ? "Correct" : "Change"}
          </button>
          <span className="text-stone-300">·</span>
          <button
            type="button"
            className="text-[11.5px] font-medium text-[#b91c1c] hover:underline"
            onClick={() => { setShowEnd(true); setErr(null); }}
            data-testid={`grid-recurring-end-open-${props.row.id}`}
          >
            End
          </button>
        </>
      ) : null}

      {showChange ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!changeDate) { setErr("Effective date is required."); return; }
            if (!isPercent && !changeAmount) { setErr("New amount is required."); return; }
            if (isPercent && !changePercent) { setErr("New percentage is required."); return; }
            setPending(true); setErr(null);
            const percentBps = isPercent ? Math.round(Number(changePercent) * 100) : null;
            const payload = {
              amount: isPercent ? null : (changeAmount || null),
              percentBps: percentBps != null && Number.isFinite(percentBps) ? percentBps : null,
              effectiveFrom: changeDate,
            };
            const r = useCorrect && props.correctAction
              ? await props.correctAction(props.employeeId, props.clubId, props.row.id, payload)
              : await props.changeAction(props.employeeId, props.clubId, props.row.id, payload);
            setPending(false);
            if (!r.ok) { setErr(r.error); return; }
            setShowChange(false);
            router.refresh();
          }}
          className="flex flex-wrap items-center gap-2 rounded-md bg-stone-50 px-2 py-1.5"
          data-testid={
            useCorrect
              ? `grid-recurring-correct-form-${props.row.id}`
              : `grid-recurring-change-form-${props.row.id}`
          }
        >
          <label className="text-[11.5px] text-stone-700">
            Effective from
            <input
              type="date"
              required
              value={changeDate}
              onChange={(e) => setChangeDate(e.target.value)}
              className="ml-1 h-6 rounded border border-stone-300 px-1 text-[11.5px]"
              data-testid={`grid-recurring-change-date-${props.row.id}`}
            />
          </label>
          {isPercent ? (
            <label className="text-[11.5px] text-stone-700">
              New %
              <input
                type="number" step="0.01" min="0" max="100" required
                value={changePercent}
                onChange={(e) => setChangePercent(e.target.value)}
                className="ml-1 h-6 w-16 rounded border border-stone-300 px-1 text-right text-[11.5px]"
                data-testid={`grid-recurring-change-percent-${props.row.id}`}
              />
            </label>
          ) : (
            <label className="text-[11.5px] text-stone-700">
              New amount (CAD)
              <input
                type="number" step="0.01" min="0" required
                value={changeAmount}
                onChange={(e) => setChangeAmount(e.target.value)}
                className="ml-1 h-6 w-20 rounded border border-stone-300 px-1 text-right text-[11.5px]"
                data-testid={`grid-recurring-change-amount-${props.row.id}`}
              />
            </label>
          )}
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-[#1e40af] px-2 py-0.5 text-[11.5px] font-semibold text-white hover:bg-[#1e3a8a] disabled:opacity-50"
            data-testid={`grid-recurring-change-submit-${props.row.id}`}
          >
            {pending ? "Saving..." : "Confirm change"}
          </button>
          <button
            type="button"
            className="text-[11.5px] text-stone-500 hover:text-stone-700"
            onClick={() => { setShowChange(false); setErr(null); }}
          >
            Cancel
          </button>
        </form>
      ) : null}

      {showEnd ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!endDate) { setErr("End date is required."); return; }
            setPending(true); setErr(null);
            const r = await props.endAction(props.employeeId, props.clubId, props.row.id, endDate);
            setPending(false);
            if (!r.ok) { setErr(r.error); return; }
            setShowEnd(false);
            router.refresh();
          }}
          className="flex flex-wrap items-center gap-2 rounded-md bg-stone-50 px-2 py-1.5"
          data-testid={`grid-recurring-end-form-${props.row.id}`}
        >
          <label className="text-[11.5px] text-stone-700">
            End date (last day of coverage, half-open)
            <input
              type="date"
              required
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="ml-1 h-6 rounded border border-stone-300 px-1 text-[11.5px]"
              data-testid={`grid-recurring-end-date-${props.row.id}`}
            />
          </label>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-[#b91c1c] px-2 py-0.5 text-[11.5px] font-semibold text-white hover:bg-[#991b1b] disabled:opacity-50"
            data-testid={`grid-recurring-end-submit-${props.row.id}`}
          >
            {pending ? "Ending..." : "Confirm end"}
          </button>
          <button
            type="button"
            className="text-[11.5px] text-stone-500 hover:text-stone-700"
            onClick={() => { setShowEnd(false); setErr(null); }}
          >
            Cancel
          </button>
        </form>
      ) : null}

      {err ? (
        <p className="w-full rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-800"
           data-testid={`grid-recurring-err-${props.row.id}`}>
          {err}
        </p>
      ) : null}
    </div>
  );
}

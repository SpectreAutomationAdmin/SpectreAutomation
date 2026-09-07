// Scheduling Foundation · Phase E (2026-09-07) — shift-detail panel
// (right-side drawer on desktop, bottom-sheet on mobile). Owns the
// Give Up flow + Offered/Waiting + Withdraw + past-shift read-only.
//
// Two consumers instantiate this component: ScheduleView (the weekly
// grid) and the mobile SelectedDayDetail — both pass an open shift
// via `activeShift` and receive an `onClose` callback.

"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { offerShiftAction, withdrawOpportunityAction } from "./_actions";

export type ShiftPanelShift = {
  assignmentId: string;
  shiftId: string;
  scheduledStartIso: string;
  scheduledEndIso: string;
  scheduledSeconds: number;
  departmentName: string;
  templateName: string;
  positionName: string | null;
  /** Present when an OPEN opportunity exists for this shift/assignment. */
  openOpportunity: null | { id: string; offeredAtIso: string };
  /** True when the shift's endAt is in the past. */
  isPast: boolean;
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const h24 = d.getUTCHours();
  const m = d.getUTCMinutes();
  const meridiem = h24 >= 12 ? "PM" : "AM";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${meridiem}`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });
}
function fmtHM(seconds: number): string {
  if (seconds <= 0) return "0h";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

const REASON_OPTIONS = [
  { value: "PERSONAL",    label: "Personal" },
  { value: "SICK",        label: "Sick / unable to work" },
  { value: "SCHOOL",      label: "School" },
  { value: "APPOINTMENT", label: "Appointment" },
  { value: "OTHER",       label: "Other" },
];

export default function ShiftDetailPanel({
  activeShift, onClose,
}: {
  activeShift: ShiftPanelShift | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"detail" | "give-up">("detail");
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [pending, startTransition] = useTransition();

  if (!activeShift) return null;

  function submitOffer() {
    if (!activeShift) return;
    const fd = new FormData();
    fd.set("shiftAssignmentId", activeShift.assignmentId);
    if (reason) fd.set("reason", reason);
    if (note) fd.set("note", note);
    // Close the panel immediately so the fixed backdrop doesn't
    // linger through the server-action navigation. If the action
    // fails, the ?err= toast surfaces on return.
    onClose();
    startTransition(() => { void offerShiftAction(fd); });
  }
  function submitWithdraw() {
    if (!activeShift?.openOpportunity) return;
    const fd = new FormData();
    fd.set("opportunityId", activeShift.openOpportunity.id);
    onClose();
    startTransition(() => { void withdrawOpportunityAction(fd); });
  }

  const isOffered = !!activeShift.openOpportunity;
  const canGiveUp = !activeShift.isPast && !isOffered;
  const canWithdraw = isOffered;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/30"
        data-testid="portal-schedule-panel-backdrop"
      />
      {/* Panel — bottom sheet on mobile, right drawer on desktop */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Shift detail"
        data-testid="portal-schedule-shift-panel"
        className={
          "fixed z-50 bg-white overflow-y-auto shadow-xl " +
          // Mobile: bottom sheet
          "bottom-0 left-0 right-0 rounded-t-2xl max-h-[85vh] pb-6 " +
          // Desktop (md+): right drawer
          "md:top-0 md:right-0 md:left-auto md:bottom-0 md:h-full md:w-[420px] md:rounded-none md:pb-0"
        }
      >
        <div className="px-6 pt-5 md:pt-8 flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
            Shift detail
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shift detail"
            data-testid="portal-schedule-panel-close"
            className="h-8 w-8 grid place-items-center rounded-md text-stone-500 hover:bg-stone-100"
          >×</button>
        </div>

        <div className="px-6 mt-2">
          <p className="font-serif text-2xl text-club-ink">
            {fmtDate(activeShift.scheduledStartIso)}
          </p>
          <p className="mt-3 text-[11px] uppercase tracking-[0.14em] text-club-green-800">
            {activeShift.positionName ?? activeShift.departmentName}
          </p>
          <p className="mt-0.5 font-serif text-xl text-club-ink">{activeShift.templateName}</p>
          <p className="mt-2 text-sm text-stone-700">
            {fmtTime(activeShift.scheduledStartIso)} – {fmtTime(activeShift.scheduledEndIso)}
          </p>
          <p className="text-xs text-stone-500">{fmtHM(activeShift.scheduledSeconds)}</p>
        </div>

        {/* ---------- OFFERED / WAITING ---------- */}
        {isOffered && (
          <div className="mt-6 mx-6 rounded-md border border-club-gold/40 bg-club-gold/10 px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.2em] text-club-gold-700">
              Shift offered
            </p>
            <p className="mt-1 text-sm text-stone-700">
              Waiting for a coworker to pick it up. You remain responsible
              until someone picks it up.
            </p>
          </div>
        )}

        {/* ---------- DEFAULT DETAIL: Give Up CTA ---------- */}
        {mode === "detail" && canGiveUp && (
          <div className="mt-8 px-6">
            <p className="text-sm text-stone-600">Can't work this shift?</p>
            <button
              type="button"
              onClick={() => setMode("give-up")}
              data-testid="portal-schedule-give-up-open"
              className="mt-3 w-full rounded-md border border-stone-300 bg-white px-4 py-2.5 text-sm font-medium text-stone-800 hover:border-stone-500"
            >
              Give Up Shift
            </button>
          </div>
        )}

        {/* ---------- GIVE UP CONFIRMATION ---------- */}
        {mode === "give-up" && canGiveUp && (
          <div className="mt-6 px-6 space-y-4" data-testid="portal-schedule-give-up-form">
            <div>
              <p className="font-serif text-lg text-club-ink">Give up this shift?</p>
              <p className="mt-1 text-sm text-stone-600">
                You can offer this shift to eligible coworkers in your department.
              </p>
            </div>
            <div>
              <label htmlFor="reason" className="block text-xs uppercase tracking-[0.14em] text-stone-500">
                Reason (optional)
              </label>
              <select
                id="reason" name="reason" value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-testid="portal-schedule-give-up-reason"
                className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Prefer not to say</option>
                {REASON_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="note" className="block text-xs uppercase tracking-[0.14em] text-stone-500">
                Note (optional)
              </label>
              <textarea
                id="note" name="note" rows={3}
                value={note} onChange={(e) => setNote(e.target.value)}
                data-testid="portal-schedule-give-up-note"
                placeholder="Anything your manager should know?"
                className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
              />
            </div>
            <p className="text-xs text-stone-500">
              You'll remain responsible for this shift until someone picks it up.
            </p>
            <div className="flex flex-col-reverse md:flex-row md:items-center md:justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setMode("detail")}
                data-testid="portal-schedule-give-up-cancel"
                className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm text-stone-700 hover:border-stone-500"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={submitOffer}
                data-testid="portal-schedule-give-up-submit"
                className="rounded-md bg-club-green-800 px-4 py-2 text-sm font-medium text-white hover:bg-club-green-900 disabled:opacity-50"
              >
                {pending ? "Offering…" : "Offer My Shift"}
              </button>
            </div>
          </div>
        )}

        {/* ---------- WITHDRAW OFFER ---------- */}
        {canWithdraw && (
          <div className="mt-4 px-6">
            <button
              type="button"
              disabled={pending}
              onClick={submitWithdraw}
              data-testid="portal-schedule-withdraw-offer"
              className="w-full rounded-md border border-stone-300 bg-white px-4 py-2.5 text-sm text-stone-800 hover:border-stone-500 disabled:opacity-50"
            >
              {pending ? "Withdrawing…" : "Withdraw Offer"}
            </button>
          </div>
        )}

        {/* ---------- PAST SHIFT (read-only) ---------- */}
        {activeShift.isPast && (
          <div className="mt-8 px-6 text-sm text-stone-500">
            Past shifts cannot be given up.
          </div>
        )}

        <div className="mt-8 px-6 pb-4 text-center text-xs text-stone-400">
          <Link href="/employee/announcements?tab=shifts" className="hover:underline underline-offset-4">
            Browse Shift Opportunities in FORE!
          </Link>
        </div>
      </aside>
    </>
  );
}

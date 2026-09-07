// Scheduling Foundation · Phase E (2026-09-07) — shift-detail panel
// (right-side drawer on desktop, bottom-sheet on mobile). Matches
// the approved visual concept: date as sheet title, shift summary
// card with calendar icon, direct-to-form Give Up flow.

"use client";

import { useState, useTransition } from "react";
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

function CalendarIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </svg>
  );
}

export default function ShiftDetailPanel({
  activeShift, onClose,
}: {
  activeShift: ShiftPanelShift | null;
  onClose: () => void;
}) {
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

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/30"
        data-testid="portal-schedule-panel-backdrop"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Shift detail"
        data-testid="portal-schedule-shift-panel"
        className={
          "fixed z-50 bg-white overflow-y-auto shadow-xl " +
          "bottom-0 left-0 right-0 rounded-t-2xl max-h-[88vh] pb-6 " +
          "md:top-0 md:right-0 md:left-auto md:bottom-0 md:h-full md:w-[440px] md:rounded-none md:pb-0"
        }
      >
        {/* Sheet title bar: date, X close */}
        <div className="px-6 pt-5 md:pt-8 pb-3 flex items-start justify-between border-b border-stone-100">
          <p className="font-serif text-[19px] text-club-ink leading-tight">
            {fmtDate(activeShift.scheduledStartIso)}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shift detail"
            data-testid="portal-schedule-panel-close"
            className="-mt-0.5 h-8 w-8 grid place-items-center rounded-md text-stone-500 hover:bg-stone-100"
          >×</button>
        </div>

        {/* Shift summary — tinted card with calendar icon */}
        <div className="px-6 mt-5">
          <div className="rounded-xl border border-club-green-100 bg-club-green-50/60 px-4 py-3 flex items-start gap-3">
            <div className="mt-0.5 h-9 w-9 grid place-items-center rounded-lg bg-white/70 text-club-green-800 shrink-0">
              <CalendarIcon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.14em] text-club-green-800 font-medium">
                {activeShift.positionName ?? activeShift.departmentName}
              </p>
              <p className="mt-0.5 font-serif text-[16px] text-club-ink leading-tight">
                {activeShift.templateName}
              </p>
              <p className="mt-1 text-[13px] text-stone-700 tabular-nums">
                {fmtTime(activeShift.scheduledStartIso)} – {fmtTime(activeShift.scheduledEndIso)}
              </p>
              <p className="text-[12px] text-stone-500">{fmtHM(activeShift.scheduledSeconds)}</p>
            </div>
          </div>
        </div>

        {/* OFFERED / WAITING state */}
        {isOffered && (
          <>
            <div className="mt-5 mx-6 rounded-md border border-club-gold/40 bg-club-gold/10 px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.2em] text-club-gold-700 font-medium">
                Shift offered
              </p>
              <p className="mt-1 text-[13px] text-stone-700">
                Waiting for a coworker to pick it up. You remain responsible
                until someone does.
              </p>
            </div>
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
          </>
        )}

        {/* GIVE UP FORM — direct, no intermediate CTA */}
        {canGiveUp && (
          <div className="mt-6 px-6" data-testid="portal-schedule-give-up-form">
            <p className="font-serif text-[17px] text-club-ink">Give up this shift?</p>
            <p className="mt-1 text-[13px] text-stone-600">
              You can offer this shift to eligible coworkers in your department.
            </p>
            <div className="mt-4">
              <label htmlFor="reason" className="block text-[11px] uppercase tracking-[0.14em] text-stone-500">
                Reason (optional)
              </label>
              <select
                id="reason" name="reason" value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-testid="portal-schedule-give-up-reason"
                className="mt-1.5 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-[13px]"
              >
                <option value="">Select a reason</option>
                {REASON_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="mt-4">
              <label htmlFor="note" className="block text-[11px] uppercase tracking-[0.14em] text-stone-500">
                Add a note (optional)
              </label>
              <textarea
                id="note" name="note" rows={3}
                value={note} onChange={(e) => setNote(e.target.value)}
                data-testid="portal-schedule-give-up-note"
                placeholder="e.g. family commitment"
                className="mt-1.5 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-[13px]"
              />
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={submitOffer}
              data-testid="portal-schedule-give-up-submit"
              className="mt-5 w-full rounded-md bg-club-green-800 px-4 py-3 text-[14px] font-medium text-white hover:bg-club-green-900 disabled:opacity-50"
            >
              {pending ? "Offering…" : "Offer My Shift"}
            </button>
            <button
              type="button"
              onClick={onClose}
              data-testid="portal-schedule-give-up-cancel"
              className="mt-2.5 w-full rounded-md border border-stone-300 bg-white px-4 py-2.5 text-[13px] text-stone-700 hover:border-stone-500"
            >
              Cancel
            </button>
            <div className="mt-4 flex items-start gap-2 text-[11.5px] text-stone-500">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
                strokeLinecap="round" strokeLinejoin="round"
                className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
              <span>You'll remain responsible for this shift until the change is confirmed.</span>
            </div>
          </div>
        )}

        {/* PAST SHIFT (read-only) */}
        {activeShift.isPast && (
          <div className="mt-6 px-6 text-[13px] text-stone-500">
            Past shifts cannot be given up.
          </div>
        )}
      </aside>
    </>
  );
}

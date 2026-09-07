// Scheduling Foundation · Phase E (2026-09-07) — pick-up shift
// panel. Matches the approved visual concept: date as sheet title,
// shift summary card with calendar icon, richer description, and
// confirmation footer.

"use client";

import { useState, useTransition } from "react";
import { pickUpShiftAction } from "../schedule/_actions";

export type PickUpPanelOpportunity = {
  opportunityId: string;
  shiftId: string;
  scheduledStartIso: string;
  scheduledEndIso: string;
  scheduledSeconds: number;
  departmentName: string;
  templateName: string;
  positionName: string | null;
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

export default function PickUpPanel({
  opportunity, onClose,
}: {
  opportunity: PickUpPanelOpportunity | null;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();

  if (!opportunity) return null;

  function submitPickUp() {
    if (!opportunity) return;
    const fd = new FormData();
    fd.set("opportunityId", opportunity.opportunityId);
    onClose();
    startTransition(() => { void pickUpShiftAction(fd); });
  }

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/30"
        data-testid="fore-pickup-backdrop"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Pick up shift"
        data-testid="fore-pickup-panel"
        className={
          "fixed z-50 bg-white overflow-y-auto shadow-xl " +
          "bottom-0 left-0 right-0 rounded-t-2xl max-h-[88vh] pb-6 " +
          "md:top-0 md:right-0 md:left-auto md:bottom-0 md:h-full md:w-[440px] md:rounded-none md:pb-0"
        }
      >
        {/* Sheet title bar */}
        <div className="px-6 pt-5 md:pt-8 pb-3 flex items-start justify-between border-b border-stone-100">
          <p className="font-serif text-[19px] text-club-ink leading-tight">
            Pick up this shift?
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close pick-up panel"
            data-testid="fore-pickup-close"
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
                {opportunity.positionName ?? opportunity.departmentName}
              </p>
              <p className="mt-0.5 font-serif text-[16px] text-club-ink leading-tight">
                {opportunity.templateName}
              </p>
              <p className="mt-1 text-[13px] text-stone-700">
                {fmtDate(opportunity.scheduledStartIso)}
              </p>
              <p className="mt-0.5 text-[13px] text-stone-700 tabular-nums">
                {fmtTime(opportunity.scheduledStartIso)} – {fmtTime(opportunity.scheduledEndIso)}
                {" · "}<span className="text-stone-500">{fmtHM(opportunity.scheduledSeconds)}</span>
              </p>
            </div>
          </div>
        </div>

        {/* Description */}
        <div className="mt-5 px-6">
          <p className="text-[13px] text-stone-700 leading-relaxed">
            This shift will be added to your schedule.
          </p>
          <p className="mt-2 text-[13px] text-stone-600 leading-relaxed">
            Once you confirm, the original shift will be updated and your
            manager will be notified.
          </p>
        </div>

        {/* Primary + Cancel actions, stacked */}
        <div className="mt-6 px-6">
          <button
            type="button"
            disabled={pending}
            onClick={submitPickUp}
            data-testid="fore-pickup-submit"
            className="w-full rounded-md bg-club-green-800 px-4 py-3 text-[14px] font-medium text-white hover:bg-club-green-900 disabled:opacity-50"
          >
            {pending ? "Picking up…" : "Pick Up Shift"}
          </button>
          <button
            type="button"
            onClick={onClose}
            data-testid="fore-pickup-cancel"
            className="mt-2.5 w-full rounded-md border border-stone-300 bg-white px-4 py-2.5 text-[13px] text-stone-700 hover:border-stone-500"
          >
            Cancel
          </button>
        </div>

        {/* Info footer */}
        <div className="mt-4 mx-6 flex items-start gap-2 text-[11.5px] text-stone-500 pb-6">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
            strokeLinecap="round" strokeLinejoin="round"
            className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span>You'll receive a confirmation once the shift has been added to your schedule.</span>
        </div>
      </aside>
    </>
  );
}

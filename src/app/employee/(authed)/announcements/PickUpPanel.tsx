// Scheduling Foundation · Phase E (2026-09-07) — pick-up shift
// panel (right-side drawer on desktop, bottom-sheet on mobile).
// Opened from the Shift Opportunities tab in FORE!.

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
    // Close the panel immediately so the fixed backdrop doesn't
    // linger through the server-action navigation.
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
          "bottom-0 left-0 right-0 rounded-t-2xl max-h-[85vh] pb-6 " +
          "md:top-0 md:right-0 md:left-auto md:bottom-0 md:h-full md:w-[420px] md:rounded-none md:pb-0"
        }
      >
        <div className="px-6 pt-5 md:pt-8 flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
            Pick up this shift?
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close pick-up panel"
            data-testid="fore-pickup-close"
            className="h-8 w-8 grid place-items-center rounded-md text-stone-500 hover:bg-stone-100"
          >×</button>
        </div>

        <div className="px-6 mt-2">
          <p className="font-serif text-2xl text-club-ink">
            {fmtDate(opportunity.scheduledStartIso)}
          </p>
          <p className="mt-3 text-[11px] uppercase tracking-[0.14em] text-club-green-800">
            {opportunity.positionName ?? opportunity.departmentName}
          </p>
          <p className="mt-0.5 font-serif text-xl text-club-ink">{opportunity.templateName}</p>
          <p className="mt-2 text-sm text-stone-700">
            {fmtTime(opportunity.scheduledStartIso)} – {fmtTime(opportunity.scheduledEndIso)}
          </p>
          <p className="text-xs text-stone-500">{fmtHM(opportunity.scheduledSeconds)}</p>
        </div>

        <div className="mt-6 px-6">
          <p className="text-sm text-stone-600">
            This shift will be added to your schedule.
          </p>
        </div>

        <div className="mt-6 px-6 pb-6 flex flex-col-reverse md:flex-row md:items-center md:justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            data-testid="fore-pickup-cancel"
            className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm text-stone-700 hover:border-stone-500"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={submitPickUp}
            data-testid="fore-pickup-submit"
            className="rounded-md bg-club-green-800 px-4 py-2 text-sm font-medium text-white hover:bg-club-green-900 disabled:opacity-50"
          >
            {pending ? "Picking up…" : "Pick Up Shift"}
          </button>
        </div>
      </aside>
    </>
  );
}

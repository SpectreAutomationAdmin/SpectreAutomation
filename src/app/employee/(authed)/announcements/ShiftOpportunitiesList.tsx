// Scheduling Foundation · Phase E (2026-09-07) — Shift Opportunities
// tab content in FORE!. Client component owning the "View Shift"
// interaction that opens the pick-up drawer/sheet.
//
// Founder amendment §14: do NOT identify the employee who offered.

"use client";

import { useState } from "react";
import PickUpPanel, { type PickUpPanelOpportunity } from "./PickUpPanel";

export interface ShiftOpportunityRow {
  opportunityId: string;
  shiftId: string;
  scheduledStartIso: string;
  scheduledEndIso: string;
  scheduledSeconds: number;
  departmentName: string;
  templateName: string;
  positionName: string | null;
}

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

export default function ShiftOpportunitiesList({
  opportunities,
}: {
  opportunities: ShiftOpportunityRow[];
}) {
  const [open, setOpen] = useState<PickUpPanelOpportunity | null>(null);
  if (opportunities.length === 0) {
    return (
      <div
        className="rounded-2xl bg-club-cream border border-stone-200/60 p-6 text-center"
        data-testid="fore-shifts-empty"
      >
        <p className="text-[14px] text-stone-600">No open shifts right now.</p>
        <p className="text-[12.5px] text-stone-500 mt-1">
          When a coworker offers up a shift you're eligible for, it'll appear here.
        </p>
      </div>
    );
  }
  return (
    <>
      <ol className="space-y-3" data-testid="fore-shifts-list">
        {opportunities.map((o) => (
          <li
            key={o.opportunityId}
            className="rounded-2xl bg-white border border-stone-200/70 p-5"
            data-testid={`fore-shifts-row-${o.opportunityId}`}
          >
            <p className="text-[11px] uppercase tracking-widest text-club-green-800">
              Available shift
            </p>
            <p className="mt-1 font-serif text-[19px] text-club-ink">
              {fmtDate(o.scheduledStartIso)}
            </p>
            <p className="mt-1 text-sm text-stone-700">
              <span className="uppercase tracking-wide text-[11px] text-club-green-800">
                {o.positionName ?? o.departmentName}
              </span>{" "}· {o.templateName}
            </p>
            <p className="mt-1 text-sm text-stone-600">
              {fmtTime(o.scheduledStartIso)} – {fmtTime(o.scheduledEndIso)}
              {" · "}{fmtHM(o.scheduledSeconds)}
            </p>
            <button
              type="button"
              onClick={() => setOpen({ ...o })}
              data-testid={`fore-shifts-view-${o.opportunityId}`}
              className="mt-4 rounded-md bg-club-green-800 px-4 py-2 text-sm font-medium text-white hover:bg-club-green-900"
            >
              View Shift
            </button>
          </li>
        ))}
      </ol>
      <PickUpPanel opportunity={open} onClose={() => setOpen(null)} />
    </>
  );
}

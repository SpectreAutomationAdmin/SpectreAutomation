// Scheduling Foundation · Phase C (2026-09-07) — client component
// for the hourly-only onboarding "Your Availability" step.
//
// Matches the approved scheduling design board:
//   - Desktop: left weekday × shift-template matrix, right preferences panel.
//   - Mobile: stacked day sections (day heading + one card per template),
//     scrolls vertically.
// Uses club-* tokens + Georgia serif, mirroring the existing onboarding
// steps. No native browser checkboxes; selectable rounded controls only.

"use client";

import { useMemo, useState, useTransition } from "react";
import { saveOnboardingAvailabilityAction, returnToPhotoAction } from "./_actions";

type ShiftTemplateRow = {
  id: string;
  code: string;
  name: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  startTimeMinutes: number;
  endTimeMinutes: number;
};

type PriorState = {
  // Serialisable from the server component; the client constructs a
  // Set for lookup convenience below.
  cellKeys: string[];
  preferredHoursPerWeek: number | null;
  maximumHoursPerWeek: number | null;
  notes: string;
  effectiveFromDate: string | null;
};

const WEEKDAYS = [
  { index: 1, label: "Monday",    short: "Mon" },
  { index: 2, label: "Tuesday",   short: "Tue" },
  { index: 3, label: "Wednesday", short: "Wed" },
  { index: 4, label: "Thursday",  short: "Thu" },
  { index: 5, label: "Friday",    short: "Fri" },
  { index: 6, label: "Saturday",  short: "Sat" },
  { index: 0, label: "Sunday",    short: "Sun" },
];

function formatTimeMinutes(minutes: number): string {
  // 11:00 AM style (club-local; the server persists minutes).
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const meridiem = h24 >= 12 ? "PM" : "AM";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  const mm = m.toString().padStart(2, "0");
  return `${h12}:${mm} ${meridiem}`;
}

export default function AvailabilityForm({
  templates,
  prior,
  suggestedPreferredHours,
  suggestedMaximumHours,
}: {
  templates: ShiftTemplateRow[];
  prior: PriorState;
  suggestedPreferredHours: number;
  suggestedMaximumHours: number;
}) {
  const [pending, startTransition] = useTransition();
  const [cells, setCells] = useState<Set<string>>(() => new Set(prior.cellKeys));
  const [preferred, setPreferred] = useState<string>(
    prior.preferredHoursPerWeek?.toString() ?? suggestedPreferredHours.toString(),
  );
  const [maximum, setMaximum] = useState<string>(
    prior.maximumHoursPerWeek?.toString() ?? suggestedMaximumHours.toString(),
  );
  const [notes, setNotes] = useState<string>(prior.notes ?? "");
  const [effectiveMode, setEffectiveMode] = useState<"IMMEDIATELY" | "SPECIFIC">(
    prior.effectiveFromDate ? "SPECIFIC" : "IMMEDIATELY",
  );
  const [effectiveDate, setEffectiveDate] = useState<string>(prior.effectiveFromDate ?? "");

  const templatesByDept = useMemo(() => {
    const groups = new Map<string, ShiftTemplateRow[]>();
    for (const t of templates) {
      const key = t.departmentId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }
    return groups;
  }, [templates]);

  function toggleCell(weekday: number, templateId: string) {
    const key = `${weekday}::${templateId}`;
    setCells((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function isSelected(weekday: number, templateId: string) {
    return cells.has(`${weekday}::${templateId}`);
  }

  function onSubmit(evt: React.FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    const form = new FormData(evt.currentTarget);
    // Rebuild avail_* cells from state (independent of DOM inputs so
    // Server Action gets an authoritative snapshot).
    for (const key of Array.from(form.keys())) {
      if (key.startsWith("avail_")) form.delete(key);
    }
    for (const cell of cells) {
      const [weekday, templateId] = cell.split("::");
      form.append(`avail_${weekday}_${templateId}`, "1");
    }
    startTransition(() => { void saveOnboardingAvailabilityAction(form); });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      {/* -----------------------------------------------------------
          DESKTOP LAYOUT — matrix left, preferences right.
          MOBILE  — matrix stacks first, then preferences.
      ----------------------------------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-8">
        {/* ============ MATRIX ============ */}
        <div className="rounded-lg border border-stone-200 bg-white">
          {templates.length === 0 ? (
            <div className="px-6 py-8 text-sm text-stone-600">
              We don't have any shift templates set up for your department yet.
              Please continue — your manager will follow up before your first shift.
            </div>
          ) : (
            <>
              {/* DESKTOP — full 7-day × N-template table */}
              <div className="hidden md:block px-6 py-6">
                {[...templatesByDept.entries()].map(([deptId, deptTemplates]) => (
                  <div key={deptId} className="mb-8 last:mb-0">
                    <p className="mb-4 text-[11px] uppercase tracking-[0.2em] text-stone-500">
                      {deptTemplates[0]?.departmentName ?? ""}
                    </p>
                    {/* Header row */}
                    <div
                      className="grid gap-3 items-center"
                      style={{ gridTemplateColumns: `120px repeat(${deptTemplates.length}, minmax(0, 1fr))` }}
                    >
                      <div />
                      {deptTemplates.map((t) => (
                        <div key={t.id} className="text-center">
                          <p className="font-serif text-sm text-stone-900">{t.name}</p>
                          <p className="mt-1 text-[11px] text-stone-500">
                            {formatTimeMinutes(t.startTimeMinutes)} – {formatTimeMinutes(t.endTimeMinutes)}
                          </p>
                        </div>
                      ))}
                    </div>
                    {/* Day rows */}
                    {WEEKDAYS.map((day) => (
                      <div
                        key={day.index}
                        className="mt-3 grid gap-3 items-center"
                        style={{ gridTemplateColumns: `120px repeat(${deptTemplates.length}, minmax(0, 1fr))` }}
                      >
                        <div className="text-sm text-stone-700">{day.label}</div>
                        {deptTemplates.map((t) => {
                          const on = isSelected(day.index, t.id);
                          return (
                            <button
                              key={`${day.index}::${t.id}`}
                              type="button"
                              onClick={() => toggleCell(day.index, t.id)}
                              aria-pressed={on}
                              data-testid={`avail-cell-${day.index}-${t.id}`}
                              className={
                                "h-10 rounded-full text-sm transition-colors border " +
                                (on
                                  ? "bg-club-green-800 text-white border-club-green-800 hover:bg-club-green-900"
                                  : "bg-club-cream text-stone-600 border-stone-200 hover:border-stone-400")
                              }
                            >
                              {on ? "✓ Available" : "Not available"}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {/* MOBILE — stacked day sections; template cards per day */}
              <div className="md:hidden px-4 py-4 divide-y divide-stone-100">
                {WEEKDAYS.map((day) => (
                  <div key={day.index} className="py-4 first:pt-0 last:pb-0">
                    <p className="text-[11px] uppercase tracking-[0.2em] text-stone-500">{day.label}</p>
                    <div className="mt-3 space-y-2">
                      {templates.map((t) => {
                        const on = isSelected(day.index, t.id);
                        return (
                          <button
                            key={`${day.index}::${t.id}`}
                            type="button"
                            onClick={() => toggleCell(day.index, t.id)}
                            aria-pressed={on}
                            data-testid={`avail-cell-${day.index}-${t.id}`}
                            className={
                              "w-full flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left transition-colors " +
                              (on
                                ? "bg-club-green-800 text-white border-club-green-800"
                                : "bg-club-cream text-stone-700 border-stone-200")
                            }
                          >
                            <div>
                              <p className={"font-serif text-sm " + (on ? "text-white" : "text-stone-900")}>{t.name}</p>
                              <p className={"mt-0.5 text-[11px] " + (on ? "text-white/80" : "text-stone-500")}>
                                {formatTimeMinutes(t.startTimeMinutes)} – {formatTimeMinutes(t.endTimeMinutes)}
                                {" · "}{t.departmentName}
                              </p>
                            </div>
                            <span className={"text-xs " + (on ? "text-white" : "text-stone-500")}>
                              {on ? "✓ Available" : "Not available"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ============ PREFERENCES ============ */}
        <div className="rounded-lg border border-stone-200 bg-white px-6 py-6 space-y-6 h-min">
          <div>
            <label htmlFor="preferredHoursPerWeek" className="block text-sm text-stone-700">
              Preferred hours per week
            </label>
            <input
              id="preferredHoursPerWeek"
              name="preferredHoursPerWeek"
              type="number"
              min={0}
              max={168}
              value={preferred}
              onChange={(e) => setPreferred(e.target.value)}
              className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
            />
            <p className="mt-1 text-[11px] text-stone-500">Roughly how many hours per week you'd like.</p>
          </div>
          <div>
            <label htmlFor="maximumHoursPerWeek" className="block text-sm text-stone-700">
              Maximum hours per week
            </label>
            <input
              id="maximumHoursPerWeek"
              name="maximumHoursPerWeek"
              type="number"
              min={0}
              max={168}
              value={maximum}
              onChange={(e) => setMaximum(e.target.value)}
              className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
            />
            <p className="mt-1 text-[11px] text-stone-500">
              The Club won't schedule you above this cap.
            </p>
          </div>
          <div>
            <label htmlFor="notes" className="block text-sm text-stone-700">
              Anything else we should know?
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. school schedule, other commitments or availability notes"
              className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm text-stone-700">This availability applies</legend>
            <label className="flex items-center gap-2 text-sm text-stone-700">
              <input
                type="radio"
                name="effectiveFromMode"
                value="IMMEDIATELY"
                checked={effectiveMode === "IMMEDIATELY"}
                onChange={() => setEffectiveMode("IMMEDIATELY")}
              />
              Starting immediately
            </label>
            <label className="flex items-center gap-2 text-sm text-stone-700">
              <input
                type="radio"
                name="effectiveFromMode"
                value="SPECIFIC"
                checked={effectiveMode === "SPECIFIC"}
                onChange={() => setEffectiveMode("SPECIFIC")}
              />
              Starting on a specific date
            </label>
            {effectiveMode === "SPECIFIC" && (
              <input
                type="date"
                name="effectiveFromDate"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
                required
                className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
              />
            )}
          </fieldset>
        </div>
      </div>

      {/* ============ ACTIONS ============ */}
      <div className="flex items-center justify-between border-t border-stone-100 pt-6">
        <button
          type="button"
          onClick={() => startTransition(() => { void returnToPhotoAction(); })}
          className="text-sm text-stone-600 hover:text-stone-900"
          data-testid="availability-back"
        >
          ← Back
        </button>
        <button
          type="submit"
          disabled={pending}
          data-testid="availability-continue"
          className="rounded-md bg-club-green-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-club-green-900 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Continue →"}
        </button>
      </div>
    </form>
  );
}

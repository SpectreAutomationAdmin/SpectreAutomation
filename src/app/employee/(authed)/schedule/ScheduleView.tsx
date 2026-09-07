// Scheduling Foundation · Phase D (2026-09-07) — My Schedule
// responsive view (desktop + mobile).
//
// One client component that renders both viewports via Tailwind
// breakpoints. Handles week navigation + view toggle client-side
// (server refetches on navigation). Countdown updates every 60s
// via setInterval — no live-tick jitter, no persisted countdown.

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import ShiftDetailPanel, { type ShiftPanelShift } from "./ShiftDetailPanel";

// Serialisable shape from the server component.
export interface ScheduleViewShift {
  assignmentId: string;
  shiftId: string;
  shiftDateIso: string;           // YYYY-MM-DD (club-local civil date; unused for compute)
  scheduledStartIso: string;      // ISO instant
  scheduledEndIso: string;        // ISO instant
  scheduledSeconds: number;
  departmentCode: string;
  departmentName: string;
  templateCode: string;
  templateName: string;
  positionName: string | null;
  worked: null | {
    clockInIso: string;
    clockOutIso: string;
    workedSeconds: number;
  };
  varianceSeconds: number | null;
  // Phase E — OPEN ShiftOpportunity for this shift/assignment.
  openOpportunity: null | { id: string; offeredAtIso: string };
}

export interface ScheduleViewProps {
  weekStartIso: string;           // Monday 00:00 UTC of the currently-viewed week
  prevWeekStartIso: string;
  nextWeekStartIso: string;
  todayIso: string;
  view: "week" | "month";
  weekShifts: ScheduleViewShift[];
  scheduledSeconds: number;
  workedSeconds: number;
  remainingSeconds: number;
  nextShift: ScheduleViewShift | null;
  recentShifts: ScheduleViewShift[];
  employeeDisplayName: string;
  hasTimeOffRoute: boolean;
  /** Server-action confirmation banner. */
  toast: null | { kind: "success" | "error"; msg: string };
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_LABELS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MS_PER_DAY = 86_400_000;

function fmtHM(seconds: number): string {
  if (seconds <= 0) return "0h";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
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

function fmtVariance(sec: number | null): { label: string; tone: "up" | "down" | "flat" | "none" } {
  if (sec == null) return { label: "—", tone: "none" };
  if (sec === 0) return { label: "On schedule", tone: "flat" };
  const abs = Math.abs(sec);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const compact = h > 0 ? `${h}h ${m}m` : `${m} min`;
  return {
    label: `${sec > 0 ? "+" : "-"}${compact}`,
    tone: sec > 0 ? "up" : "down",
  };
}

function fmtDayHeading(dayIso: string): string {
  const d = new Date(dayIso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtLongDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });
}

function isoDate(iso: string): string {
  return iso.slice(0, 10);
}

function weekLabel(weekStartIso: string): string {
  const start = new Date(weekStartIso);
  const end = new Date(start.getTime() + 6 * MS_PER_DAY);
  const startFmt = start.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const endFmt = start.getUTCMonth() === end.getUTCMonth()
    ? end.toLocaleDateString("en-US", { day: "numeric", timeZone: "UTC" })
    : end.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${startFmt} – ${endFmt}, ${end.getUTCFullYear()}`;
}

function relativeStart(startIso: string, endIso: string, nowMs: number): string {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  if (nowMs >= endMs) return "Completed";
  if (nowMs >= startMs) return "In progress";
  const delta = startMs - nowMs;
  const mins = Math.round(delta / 60_000);
  if (mins < 60) return `Starts in ${mins} min`;
  const hours = Math.floor(mins / 60);
  const remaining = mins - hours * 60;
  if (hours < 24) return `Starts in ${hours}h ${remaining.toString().padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  const restH = hours - days * 24;
  return `Starts in ${days}d ${restH}h`;
}

export default function ScheduleView(props: ScheduleViewProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const weekDays = useMemo(() => {
    const start = new Date(props.weekStartIso);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start.getTime() + i * MS_PER_DAY);
      return {
        iso: d.toISOString(),
        dateNumber: d.getUTCDate(),
        label: DAY_LABELS[i],
        longLabel: DAY_LABELS_LONG[i],
        headingLabel: fmtDayHeading(d.toISOString()),
        shifts: props.weekShifts.filter(
          (s) => isoDate(s.scheduledStartIso) === isoDate(d.toISOString()),
        ),
      };
    });
  }, [props.weekStartIso, props.weekShifts]);

  const selectedDayIso = params.get("day") ?? weekDays.find((d) => d.shifts.length > 0)?.iso ?? weekDays[0].iso;

  // Phase E — currently-open detail panel target.
  const [openShift, setOpenShift] = useState<ShiftPanelShift | null>(null);
  function openPanelFor(s: ScheduleViewShift) {
    const isPast = new Date(s.scheduledEndIso).getTime() <= Date.now();
    setOpenShift({
      assignmentId: s.assignmentId,
      shiftId: s.shiftId,
      scheduledStartIso: s.scheduledStartIso,
      scheduledEndIso: s.scheduledEndIso,
      scheduledSeconds: s.scheduledSeconds,
      departmentName: s.departmentName,
      templateName: s.templateName,
      positionName: s.positionName,
      openOpportunity: s.openOpportunity,
      isPast,
    });
  }

  function navigateWeek(nextWeekStart: string) {
    const p = new URLSearchParams(params);
    p.set("weekStart", isoDate(nextWeekStart));
    p.delete("day");
    router.push(`/employee/schedule?${p.toString()}`);
  }
  function navigateView(v: "week" | "month") {
    const p = new URLSearchParams(params);
    p.set("view", v);
    router.push(`/employee/schedule?${p.toString()}`);
  }
  function navigateDay(dayIso: string) {
    const p = new URLSearchParams(params);
    p.set("day", isoDate(dayIso));
    router.push(`/employee/schedule?${p.toString()}`);
  }

  const nextShiftRel = props.nextShift
    ? relativeStart(props.nextShift.scheduledStartIso, props.nextShift.scheduledEndIso, nowMs)
    : null;

  const isPopulated = props.weekShifts.length > 0 || props.nextShift != null;

  return (
    <div className="space-y-6 md:space-y-8" data-testid="portal-schedule-populated">
      {/* ============= TOAST (server-action confirmation) ============= */}
      {props.toast && (
        <div
          data-testid={`portal-schedule-toast-${props.toast.kind}`}
          className={
            "rounded-md border px-4 py-3 text-sm " +
            (props.toast.kind === "success"
              ? "border-club-green-200 bg-club-green-50 text-club-green-800"
              : "border-stone-300 bg-stone-50 text-stone-800")
          }
        >
          {props.toast.msg}
        </div>
      )}
      {/* ============= HEADER ============= */}
      <header>
        <p className="hidden md:block text-[11px] uppercase tracking-[0.2em] text-stone-500">
          App &nbsp;&rsaquo;&nbsp; Employee Portal &nbsp;&rsaquo;&nbsp; Schedule
        </p>
        <h1 className="mt-1 font-serif text-2xl md:text-3xl text-club-ink">
          My Schedule
        </h1>
      </header>

      {/* ============= TOOLBAR ============= */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="flex items-center gap-2 md:gap-3">
          <button
            type="button"
            onClick={() => navigateWeek(props.prevWeekStartIso)}
            data-testid="portal-schedule-week-prev"
            aria-label="Previous week"
            className="h-8 w-8 grid place-items-center rounded-md border border-stone-300 text-stone-600 hover:border-stone-500"
          >‹</button>
          <div className="font-serif text-base md:text-lg text-club-ink px-1" data-testid="portal-schedule-week-label">
            {weekLabel(props.weekStartIso)}
          </div>
          <button
            type="button"
            onClick={() => navigateWeek(props.nextWeekStartIso)}
            data-testid="portal-schedule-week-next"
            aria-label="Next week"
            className="h-8 w-8 grid place-items-center rounded-md border border-stone-300 text-stone-600 hover:border-stone-500"
          >›</button>
          <button
            type="button"
            onClick={() => navigateWeek(props.todayIso)}
            data-testid="portal-schedule-today"
            className="ml-1 md:ml-2 rounded-md border border-stone-300 bg-white px-3 py-1 text-xs text-stone-700 hover:border-stone-500"
          >Today</button>
        </div>
        <nav className="inline-flex rounded-md border border-stone-300 overflow-hidden text-xs md:text-sm" aria-label="Schedule view">
          {(["week", "month"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => navigateView(v)}
              data-testid={`portal-schedule-view-${v}`}
              aria-pressed={props.view === v}
              className={
                "px-3 py-1.5 " +
                (props.view === v
                  ? "bg-club-green-800 text-white"
                  : "bg-white text-stone-700 hover:bg-club-cream")
              }
            >
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
          <Link
            href="/employee/availability"
            data-testid="portal-schedule-my-availability"
            className="px-3 py-1.5 bg-white text-stone-700 hover:bg-club-cream border-l border-stone-300"
          >
            My Availability
          </Link>
        </nav>
      </div>

      {/* ============= MOBILE DATE STRIP ============= */}
      <div className="md:hidden">
        <div className="flex items-center justify-between rounded-md border border-stone-200 bg-white px-2 py-2">
          {weekDays.map((d) => {
            const isSelected = isoDate(d.iso) === isoDate(selectedDayIso);
            const hasShift = d.shifts.length > 0;
            return (
              <button
                key={d.iso}
                type="button"
                onClick={() => navigateDay(d.iso)}
                aria-pressed={isSelected}
                data-testid={`portal-schedule-mobile-day-${isoDate(d.iso)}`}
                className={
                  "flex flex-col items-center justify-center rounded-md w-9 py-1.5 text-[11px] " +
                  (isSelected
                    ? "bg-club-green-800 text-white"
                    : "text-stone-600 hover:bg-club-cream")
                }
              >
                <span className="uppercase tracking-wide">{d.label[0]}</span>
                <span className="mt-0.5 font-serif text-sm">{d.dateNumber}</span>
                {hasShift && (
                  <span className={
                    "mt-0.5 h-1 w-1 rounded-full " +
                    (isSelected ? "bg-white" : "bg-club-green-800")
                  } />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ============= DESKTOP WEEK GRID (only if view=week) ============= */}
      {props.view === "week" && (
        <div className="hidden md:grid grid-cols-7 gap-3" data-testid="portal-schedule-week-grid">
          {weekDays.map((d) => (
            <div key={d.iso} className="min-h-40 rounded-lg border border-stone-200 bg-white p-3">
              <div className="text-[11px] uppercase tracking-[0.15em] text-stone-500">
                {d.label}
              </div>
              <div className="mt-0.5 font-serif text-lg text-club-ink">{d.dateNumber}</div>
              <div className="mt-3 space-y-2">
                {d.shifts.length === 0 ? (
                  <p className="text-[11px] text-stone-400">No shift</p>
                ) : d.shifts.map((s) => {
                  const offered = !!s.openOpportunity;
                  return (
                    <button
                      key={s.assignmentId}
                      type="button"
                      onClick={() => openPanelFor(s)}
                      data-testid={`portal-schedule-shift-${s.assignmentId}`}
                      className={
                        "w-full text-left rounded-md border px-2.5 py-2 transition-colors " +
                        (offered
                          ? "border-club-gold/40 bg-club-gold/10 hover:bg-club-gold/20"
                          : "border-club-green-200 bg-club-green-50/70 hover:bg-club-green-100/70")
                      }
                    >
                      <p className={
                        "text-[10px] uppercase tracking-[0.14em] " +
                        (offered ? "text-club-gold-700" : "text-club-green-800")
                      }>
                        {s.positionName ?? s.departmentName}
                      </p>
                      <p className="mt-0.5 font-serif text-sm text-club-ink leading-tight">{s.templateName}</p>
                      <p className="mt-1 text-[11px] text-stone-600">
                        {fmtTime(s.scheduledStartIso)} – {fmtTime(s.scheduledEndIso)}
                      </p>
                      <p className="text-[11px] text-stone-500">{fmtHM(s.scheduledSeconds)}</p>
                      {offered && (
                        <p
                          className="mt-1 text-[10px] uppercase tracking-[0.14em] text-club-gold-700"
                          data-testid={`portal-schedule-shift-offered-${s.assignmentId}`}
                        >
                          Shift offered · waiting
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ============= DESKTOP MONTH (lightweight) ============= */}
      {props.view === "month" && (
        <MonthView weekStartIso={props.weekStartIso} weekShifts={props.weekShifts} />
      )}

      {/* ============= NEXT SHIFT / THIS WEEK / ACTIONS ============= */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
        <NextShiftCard shift={props.nextShift} relLabel={nextShiftRel} />
        <ThisWeekCard
          scheduledSeconds={props.scheduledSeconds}
          workedSeconds={props.workedSeconds}
          remainingSeconds={props.remainingSeconds}
        />
        <ActionsCard hasTimeOffRoute={props.hasTimeOffRoute} />
      </div>

      {/* ============= MOBILE — SELECTED DAY DETAIL ============= */}
      <div className="md:hidden">
        <SelectedDayDetail
          selectedDayIso={selectedDayIso}
          shifts={weekDays.find((d) => isoDate(d.iso) === isoDate(selectedDayIso))?.shifts ?? []}
          onSelectShift={openPanelFor}
        />
      </div>

      {/* ============= RECENT SHIFTS ============= */}
      {props.recentShifts.length > 0 && (
        <section aria-labelledby="portal-schedule-recent-heading" data-testid="portal-schedule-recent">
          <h2 id="portal-schedule-recent-heading" className="font-serif text-xl text-club-ink">
            Recent Shifts
          </h2>
          <div className="mt-3 space-y-2 md:space-y-3">
            {props.recentShifts.map((s) => (
              <RecentShiftRow key={s.assignmentId} shift={s} />
            ))}
          </div>
        </section>
      )}

      {/* ============= EMPTY STATE (eligible but no shifts) ============= */}
      {!isPopulated && (
        <section
          data-testid="portal-schedule-empty"
          className="rounded-lg border border-stone-200 bg-white px-6 py-10 text-center"
        >
          <p className="font-serif text-lg text-club-ink">No shifts scheduled</p>
          <p className="mt-2 text-sm text-stone-600 max-w-md mx-auto">
            You don't have any upcoming shifts yet. When your schedule is
            published, your shifts will appear here.
          </p>
          <Link
            href="/employee/availability"
            data-testid="portal-schedule-empty-view-availability"
            className="mt-4 inline-block text-sm text-club-green-800 underline underline-offset-4"
          >
            View Availability
          </Link>
        </section>
      )}

      {/* ============= SHIFT DETAIL PANEL (drawer/sheet) ============= */}
      <ShiftDetailPanel activeShift={openShift} onClose={() => setOpenShift(null)} />
    </div>
  );
}

function NextShiftCard({ shift, relLabel }: { shift: ScheduleViewShift | null; relLabel: string | null }) {
  if (!shift) {
    return (
      <div className="rounded-lg border border-stone-200 bg-white p-4 md:p-5">
        <p className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Next Shift</p>
        <p className="mt-3 text-sm text-stone-600">Nothing scheduled ahead.</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 md:p-5" data-testid="portal-schedule-next-shift">
      <p className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Next Shift</p>
      <p className="mt-2 font-serif text-lg text-club-ink">
        {fmtLongDate(shift.scheduledStartIso)}
      </p>
      <p className="mt-1 text-sm text-stone-700">
        <span className="uppercase tracking-wide text-[11px] text-club-green-800">
          {shift.positionName ?? shift.departmentName}
        </span>{" "}· {shift.templateName}
      </p>
      <p className="mt-1 text-sm text-stone-600">
        {fmtTime(shift.scheduledStartIso)} – {fmtTime(shift.scheduledEndIso)}
      </p>
      <p className="text-xs text-stone-500">{fmtHM(shift.scheduledSeconds)}</p>
      {relLabel && (
        <div className="mt-3 inline-block rounded-full bg-club-green-50 text-club-green-800 px-3 py-1 text-xs" data-testid="portal-schedule-next-rel">
          {relLabel}
        </div>
      )}
    </div>
  );
}

function ThisWeekCard({ scheduledSeconds, workedSeconds, remainingSeconds }: {
  scheduledSeconds: number; workedSeconds: number; remainingSeconds: number;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 md:p-5" data-testid="portal-schedule-this-week">
      <p className="text-[11px] uppercase tracking-[0.2em] text-stone-500">This Week</p>
      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between text-stone-700">
          <dt>Scheduled hours</dt>
          <dd className="font-serif" data-testid="portal-schedule-hours-scheduled">{fmtHM(scheduledSeconds)}</dd>
        </div>
        <div className="flex justify-between text-stone-700">
          <dt>Worked hours</dt>
          <dd className="font-serif" data-testid="portal-schedule-hours-worked">{fmtHM(workedSeconds)}</dd>
        </div>
        <div className="flex justify-between text-stone-700">
          <dt>Remaining hours</dt>
          <dd className="font-serif" data-testid="portal-schedule-hours-remaining">{fmtHM(remainingSeconds)}</dd>
        </div>
      </dl>
    </div>
  );
}

function ActionsCard({ hasTimeOffRoute }: { hasTimeOffRoute: boolean }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 md:p-5" data-testid="portal-schedule-actions">
      <p className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Actions</p>
      <ul className="mt-3 space-y-3 text-sm">
        <li>
          <Link
            href="/employee/availability"
            data-testid="portal-schedule-actions-view-availability"
            className="font-medium text-club-green-800 hover:text-club-green-900"
          >
            View my availability
          </Link>
          <p className="text-xs text-stone-500">Update your availability</p>
        </li>
        <li>
          {hasTimeOffRoute ? (
            <>
              <Link
                href="/employee/time-off"
                data-testid="portal-schedule-actions-time-off"
                className="font-medium text-club-green-800 hover:text-club-green-900"
              >
                Request time off
              </Link>
              <p className="text-xs text-stone-500">Submit a time off request</p>
            </>
          ) : (
            <>
              <span
                data-testid="portal-schedule-actions-time-off-disabled"
                className="font-medium text-stone-400 cursor-not-allowed"
                aria-disabled
              >
                Request time off
              </span>
              <p className="text-xs text-stone-500">Coming with the Time Off module.</p>
            </>
          )}
        </li>
      </ul>
    </div>
  );
}

function RecentShiftRow({ shift }: { shift: ScheduleViewShift }) {
  const variance = fmtVariance(shift.varianceSeconds);
  return (
    <div
      data-testid={`portal-schedule-recent-${shift.assignmentId}`}
      className="rounded-lg border border-stone-200 bg-white px-4 py-3 md:px-5 md:py-4"
    >
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-6">
        <div>
          <p className="text-xs uppercase tracking-wide text-stone-500">
            {new Date(shift.scheduledStartIso).toLocaleDateString("en-US", {
              weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
            })}
          </p>
          <p className="mt-0.5 text-sm text-stone-800">
            <span className="uppercase tracking-wide text-[11px] text-club-green-800">
              {shift.positionName ?? shift.departmentName}
            </span>{" "}· {shift.templateName}
          </p>
        </div>
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-5 gap-y-1 text-xs">
          <div>
            <dt className="text-stone-500">Scheduled</dt>
            <dd className="text-stone-800">
              {fmtTime(shift.scheduledStartIso)} – {fmtTime(shift.scheduledEndIso)}
            </dd>
          </div>
          <div>
            <dt className="text-stone-500">Worked</dt>
            <dd className="text-stone-800">
              {shift.worked
                ? `${fmtTime(shift.worked.clockInIso)} – ${fmtTime(shift.worked.clockOutIso)}`
                : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-stone-500">Total</dt>
            <dd className="text-stone-800 font-serif">
              {shift.worked ? fmtHM(shift.worked.workedSeconds) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-stone-500">Variance</dt>
            <dd
              className={
                "font-serif " +
                (variance.tone === "up" ? "text-club-green-800"
                  : variance.tone === "down" ? "text-stone-800"
                  : "text-stone-500")
              }
            >
              {variance.label}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function SelectedDayDetail({ selectedDayIso, shifts, onSelectShift }: {
  selectedDayIso: string; shifts: ScheduleViewShift[];
  onSelectShift: (s: ScheduleViewShift) => void;
}) {
  const heading = new Date(selectedDayIso).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });
  return (
    <section aria-labelledby="portal-schedule-selected-day-heading">
      <h2 id="portal-schedule-selected-day-heading" className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
        {heading}
      </h2>
      <div className="mt-2 space-y-2">
        {shifts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-stone-300 bg-white px-4 py-4 text-sm text-stone-500 text-center">
            No shift this day.
          </p>
        ) : shifts.map((s) => {
          const offered = !!s.openOpportunity;
          return (
            <button
              key={s.assignmentId}
              type="button"
              onClick={() => onSelectShift(s)}
              className={
                "w-full text-left rounded-lg border px-4 py-3 transition-colors " +
                (offered
                  ? "border-club-gold/40 bg-club-gold/10 hover:bg-club-gold/20"
                  : "border-club-green-200 bg-club-green-50/70 hover:bg-club-green-100/70")
              }
              data-testid={`portal-schedule-mobile-shift-${s.assignmentId}`}
            >
              <p className={
                "text-[11px] uppercase tracking-[0.14em] " +
                (offered ? "text-club-gold-700" : "text-club-green-800")
              }>
                {s.positionName ?? s.departmentName}
              </p>
              <p className="mt-0.5 font-serif text-base text-club-ink">{s.templateName}</p>
              <p className="mt-1 text-sm text-stone-700">
                {fmtTime(s.scheduledStartIso)} – {fmtTime(s.scheduledEndIso)}
              </p>
              <p className="text-xs text-stone-500">{fmtHM(s.scheduledSeconds)}</p>
              {offered && (
                <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-club-gold-700">
                  Shift offered · waiting
                </p>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function MonthView({ weekStartIso, weekShifts }: {
  weekStartIso: string; weekShifts: ScheduleViewShift[];
}) {
  const anchor = new Date(weekStartIso);
  const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const monthLabel = first.toLocaleDateString("en-US", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
  // First-Monday-of-view.
  const firstDay = first.getUTCDay(); // 0..6, Sun..Sat
  const daysBack = (firstDay + 6) % 7;
  const gridStart = new Date(first.getTime() - daysBack * MS_PER_DAY);
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart.getTime() + i * MS_PER_DAY);
    return {
      iso: d.toISOString(),
      inMonth: d.getUTCMonth() === first.getUTCMonth(),
      day: d.getUTCDate(),
      hasShift: weekShifts.some((s) => isoDate(s.scheduledStartIso) === isoDate(d.toISOString())),
    };
  });
  return (
    <div className="hidden md:block" data-testid="portal-schedule-month-view">
      <p className="mb-2 text-[11px] uppercase tracking-[0.2em] text-stone-500">
        {monthLabel}
      </p>
      <div className="grid grid-cols-7 gap-2 text-center text-[11px] uppercase tracking-[0.14em] text-stone-500">
        {DAY_LABELS.map((l) => <div key={l}>{l}</div>)}
      </div>
      <div className="mt-2 grid grid-cols-7 gap-2">
        {cells.map((c, i) => (
          <div
            key={i}
            className={
              "min-h-14 rounded-md border p-1.5 text-sm " +
              (c.inMonth
                ? "border-stone-200 bg-white text-stone-800"
                : "border-transparent bg-transparent text-stone-400")
            }
          >
            <div className="flex items-center justify-between">
              <span className={c.inMonth ? "font-serif" : ""}>{c.day}</span>
              {c.hasShift && (
                <span className="h-1.5 w-1.5 rounded-full bg-club-green-800" />
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-stone-500">
        Month view highlights days with shifts in the currently-loaded week only.
        Full-month shift loading arrives with the scheduler service in a later phase.
      </p>
    </div>
  );
}

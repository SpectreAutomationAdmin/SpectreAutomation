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
    <div className="space-y-5 md:space-y-6 md:max-w-[1180px]" data-testid="portal-schedule-populated">
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
        <p className="hidden md:block text-[10.5px] uppercase tracking-[0.22em] text-stone-500">
          App &nbsp;&rsaquo;&nbsp; Employee Portal &nbsp;&rsaquo;&nbsp; Schedule
        </p>
        <h1 className="mt-1 font-serif text-[24px] md:text-[28px] text-club-ink leading-[1.05]">
          My Schedule
        </h1>
      </header>

      {/* ============= TOOLBAR ============= */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="inline-flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigateWeek(props.prevWeekStartIso)}
            data-testid="portal-schedule-week-prev"
            aria-label="Previous week"
            className="h-8 w-8 grid place-items-center rounded-md border border-stone-300 bg-white text-stone-700 hover:border-stone-500 hover:text-club-ink transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <div className="font-serif text-[17px] md:text-[19px] text-club-ink px-3" data-testid="portal-schedule-week-label">
            {weekLabel(props.weekStartIso)}
          </div>
          <button
            type="button"
            onClick={() => navigateWeek(props.nextWeekStartIso)}
            data-testid="portal-schedule-week-next"
            aria-label="Next week"
            className="h-8 w-8 grid place-items-center rounded-md border border-stone-300 bg-white text-stone-700 hover:border-stone-500 hover:text-club-ink transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => navigateWeek(props.todayIso)}
            data-testid="portal-schedule-today"
            className="ml-2 rounded-md border border-stone-300 bg-white px-3.5 py-1.5 text-[13px] text-stone-800 hover:border-stone-500 transition-colors"
          >Today</button>
        </div>
        <nav
          className="inline-flex rounded-md border border-stone-300 overflow-hidden text-[13px] bg-white"
          aria-label="Schedule view"
        >
          {(["week", "month"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => navigateView(v)}
              data-testid={`portal-schedule-view-${v}`}
              aria-pressed={props.view === v}
              className={
                "px-4 py-1.5 border-r border-stone-300 last:border-r-0 transition-colors " +
                (props.view === v
                  ? "bg-club-green-800 text-white"
                  : "text-stone-700 hover:bg-club-cream")
              }
            >
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
          <Link
            href="/employee/availability"
            data-testid="portal-schedule-my-availability"
            className="px-4 py-1.5 text-stone-700 hover:bg-club-cream"
          >
            My Availability
          </Link>
        </nav>
      </div>

      {/* ============= MOBILE DATE STRIP ============= */}
      <div className="md:hidden">
        <div className="flex items-center justify-between rounded-xl border border-stone-200 bg-white px-1.5 py-2">
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
                  "flex flex-col items-center justify-center rounded-lg w-10 py-1.5 text-[11px] transition-colors " +
                  (isSelected
                    ? "bg-club-green-800 text-white"
                    : "text-stone-600 hover:bg-club-cream")
                }
              >
                <span className="uppercase tracking-wide">{d.label[0]}</span>
                <span className="mt-0.5 font-serif text-[15px]">{d.dateNumber}</span>
                <span className={
                  "mt-1 h-1 w-1 rounded-full " +
                  (hasShift
                    ? (isSelected ? "bg-white" : "bg-club-green-800")
                    : "bg-transparent")
                } />
              </button>
            );
          })}
        </div>
      </div>

      {/* ============= DESKTOP WEEK GRID — ONE UNIFIED CARD WITH 7 COLUMNS ============= */}
      {props.view === "week" && (
        <div
          className="hidden md:block rounded-lg border border-stone-200 bg-white overflow-hidden"
          data-testid="portal-schedule-week-grid"
        >
          <div className="grid grid-cols-7 divide-x divide-stone-100">
            {weekDays.map((d) => (
              <div key={d.iso} className="px-3 pt-4 pb-4 min-h-[200px] flex flex-col">
                <div className="text-[12.5px] text-stone-800 text-center font-medium">
                  {d.label}
                </div>
                <div className="mt-0.5 text-[11.5px] text-stone-500 text-center">
                  {d.headingLabel}
                </div>
                <div className="mt-4 flex-1 flex flex-col space-y-2">
                  {d.shifts.length === 0 ? (
                    <p className="my-auto text-center text-[12.5px] text-stone-400">— No shift</p>
                  ) : d.shifts.map((s) => {
                    const offered = !!s.openOpportunity;
                    return (
                      <button
                        key={s.assignmentId}
                        type="button"
                        onClick={() => openPanelFor(s)}
                        data-testid={`portal-schedule-shift-${s.assignmentId}`}
                        className={
                          "w-full text-left rounded-md border px-3 py-3.5 transition-colors " +
                          (offered
                            ? "border-club-gold/40 bg-club-gold/10 hover:bg-club-gold/20"
                            : "border-club-green-200/70 bg-club-green-50/70 hover:bg-club-green-100/70")
                        }
                      >
                        <p className={
                          "text-[11px] uppercase tracking-[0.13em] font-semibold " +
                          (offered ? "text-club-gold-700" : "text-club-green-800")
                        }>
                          {s.positionName ?? s.departmentName}
                        </p>
                        <p className="mt-1.5 font-serif text-[15px] text-club-ink leading-[1.15]">{s.templateName}</p>
                        <p className="mt-2 text-[12px] text-stone-600 leading-tight tabular-nums">
                          {fmtTime(s.scheduledStartIso)} – {fmtTime(s.scheduledEndIso)}
                        </p>
                        <p className="text-[12px] text-stone-500 leading-tight tabular-nums">{fmtHM(s.scheduledSeconds)}</p>
                        {offered && (
                          <p
                            className="mt-1.5 text-[10.5px] uppercase tracking-[0.12em] text-club-gold-700"
                            data-testid={`portal-schedule-shift-offered-${s.assignmentId}`}
                          >
                            Offered · waiting
                          </p>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============= DESKTOP MONTH (lightweight) ============= */}
      {props.view === "month" && (
        <MonthView weekStartIso={props.weekStartIso} weekShifts={props.weekShifts} />
      )}

      {/* ============= NEXT SHIFT / THIS WEEK / ACTIONS ============= */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-5">
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

      {/* ============= RECENT SHIFTS — one white card: title + divider + rows ============= */}
      {props.recentShifts.length > 0 && (
        <section
          aria-labelledby="portal-schedule-recent-heading"
          data-testid="portal-schedule-recent"
          className="rounded-lg border border-stone-200 bg-white overflow-hidden"
        >
          <div className="px-6 pt-5 pb-4">
            <h2 id="portal-schedule-recent-heading" className="font-serif text-[22px] text-club-ink leading-none">
              Recent Shifts
            </h2>
          </div>
          <div className="border-t border-stone-100" />
          <ul className="divide-y divide-stone-100">
            {props.recentShifts.map((s) => (
              <RecentShiftRow key={s.assignmentId} shift={s} />
            ))}
          </ul>
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

/* ------------------------------------------------------------------ */
/*  ICONS — dark-green outline, restrained, from the club-* palette.  */
/* ------------------------------------------------------------------ */
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
function ClockIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function UsersIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function AvailabilityIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 13l2 2 4-4" />
    </svg>
  );
}
function TimeOffIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4M9 15h6" />
    </svg>
  );
}
function ChevronRightIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function NextShiftCard({ shift, relLabel }: { shift: ScheduleViewShift | null; relLabel: string | null }) {
  if (!shift) {
    return (
      <div className="rounded-lg border border-stone-200 bg-white px-5 py-4 min-h-[170px]">
        <div className="flex items-center gap-2.5">
          <CalendarIcon className="h-5 w-5 text-club-green-800" />
          <p className="font-serif text-[19px] text-club-ink leading-none">Next Shift</p>
        </div>
        <p className="mt-5 text-sm text-stone-600">Nothing scheduled ahead.</p>
      </div>
    );
  }
  return (
    <div
      className="rounded-lg border border-stone-200 bg-white px-5 py-4 min-h-[170px]"
      data-testid="portal-schedule-next-shift"
    >
      <div className="flex items-center gap-2.5">
        <CalendarIcon className="h-5 w-5 text-club-green-800" />
        <p className="font-serif text-[19px] text-club-ink leading-none">Next Shift</p>
      </div>
      <p className="mt-4 font-serif text-[19px] text-club-ink leading-[1.15]">
        {fmtLongDate(shift.scheduledStartIso)}
      </p>
      <p className="mt-1.5 text-[14px] text-club-ink">
        {shift.positionName ?? shift.departmentName}{" "}<span className="text-stone-500">· {shift.templateName}</span>
      </p>
      <p className="mt-1 text-[13.5px] text-stone-600 tabular-nums">
        {fmtTime(shift.scheduledStartIso)} – {fmtTime(shift.scheduledEndIso)} ({fmtHM(shift.scheduledSeconds)})
      </p>
      {relLabel && (
        <div
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-club-green-50 text-club-green-800 px-3.5 py-1.5 text-[13px] font-medium"
          data-testid="portal-schedule-next-rel"
        >
          <ClockIcon className="h-3.5 w-3.5" />
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
    <div
      className="rounded-lg border border-stone-200 bg-white px-5 py-4 min-h-[170px]"
      data-testid="portal-schedule-this-week"
    >
      <div className="flex items-center gap-2.5">
        <CalendarIcon className="h-5 w-5 text-club-green-800" />
        <p className="font-serif text-[19px] text-club-ink leading-none">This Week</p>
      </div>
      <dl className="mt-4 text-[14px] space-y-2.5">
        <div className="flex justify-between items-baseline">
          <dt className="text-stone-600">Scheduled hours</dt>
          <dd className="font-medium text-club-ink tabular-nums" data-testid="portal-schedule-hours-scheduled">{fmtHM(scheduledSeconds)}</dd>
        </div>
        <div className="flex justify-between items-baseline">
          <dt className="text-stone-600">Worked hours</dt>
          <dd className="font-medium text-club-ink tabular-nums" data-testid="portal-schedule-hours-worked">{fmtHM(workedSeconds)}</dd>
        </div>
        <div className="flex justify-between items-baseline">
          <dt className="text-stone-600">Remaining hours</dt>
          <dd className="font-medium text-club-ink tabular-nums" data-testid="portal-schedule-hours-remaining">{fmtHM(remainingSeconds)}</dd>
        </div>
      </dl>
    </div>
  );
}

function ActionsCard({ hasTimeOffRoute }: { hasTimeOffRoute: boolean }) {
  return (
    <div
      className="rounded-lg border border-stone-200 bg-white px-5 py-4 min-h-[170px]"
      data-testid="portal-schedule-actions"
    >
      <div className="flex items-center gap-2.5">
        <UsersIcon className="h-5 w-5 text-club-green-800" />
        <p className="font-serif text-[19px] text-club-ink leading-none">Actions</p>
      </div>
      <ul className="mt-4 space-y-2.5">
        <li>
          <Link
            href="/employee/availability"
            data-testid="portal-schedule-actions-view-availability"
            className="flex items-start gap-3 rounded-md border border-stone-200 px-3.5 py-2.5 hover:border-stone-400 hover:bg-club-cream/40 transition-colors"
          >
            <AvailabilityIcon className="h-5 w-5 mt-0.5 shrink-0 text-club-green-800" />
            <span className="min-w-0">
              <span className="block font-medium text-[14px] text-club-ink leading-tight">View my availability</span>
              <span className="block text-[12.5px] text-stone-500 mt-0.5">Update your availability</span>
            </span>
          </Link>
        </li>
        <li>
          {hasTimeOffRoute ? (
            <Link
              href="/employee/time-off"
              data-testid="portal-schedule-actions-time-off"
              className="flex items-start gap-3 rounded-md border border-stone-200 px-3.5 py-2.5 hover:border-stone-400 hover:bg-club-cream/40 transition-colors"
            >
              <TimeOffIcon className="h-5 w-5 mt-0.5 shrink-0 text-club-green-800" />
              <span className="min-w-0">
                <span className="block font-medium text-[14px] text-club-ink leading-tight">Request time off</span>
                <span className="block text-[12.5px] text-stone-500 mt-0.5">Submit a time off request</span>
              </span>
            </Link>
          ) : (
            <div
              data-testid="portal-schedule-actions-time-off-disabled"
              aria-disabled
              className="flex items-start gap-3 rounded-md border border-stone-200 px-3.5 py-2.5 opacity-80"
            >
              <TimeOffIcon className="h-5 w-5 mt-0.5 shrink-0 text-club-green-800" />
              <span className="min-w-0">
                <span className="block font-medium text-[14px] text-club-ink leading-tight">Request time off</span>
                <span className="block text-[12.5px] text-stone-500 mt-0.5">Submit a time off request</span>
              </span>
            </div>
          )}
        </li>
      </ul>
    </div>
  );
}

function RecentShiftRow({ shift }: { shift: ScheduleViewShift }) {
  const variance = fmtVariance(shift.varianceSeconds);
  const varianceClass =
    variance.tone === "up"
      ? "bg-club-green-50 text-club-green-800"
      : variance.tone === "down"
        ? "bg-club-gold/10 text-club-gold-700"
        : "bg-stone-100 text-stone-500";
  const dayLabel = new Date(shift.scheduledStartIso).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
  return (
    <li
      data-testid={`portal-schedule-recent-${shift.assignmentId}`}
      className="px-5 py-3.5 md:px-6 md:py-4 hover:bg-club-cream/40 transition-colors"
    >
      {/* Desktop: single-row table layout matching the concept: title-case labels, role · shift */}
      <div className="hidden md:grid md:grid-cols-[150px_minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)_90px_88px_18px] items-center gap-4">
        <div>
          <p className="font-serif text-[14px] text-club-ink leading-tight">{dayLabel}</p>
        </div>
        <div className="min-w-0">
          <p className="text-[13.5px] text-stone-700 truncate">
            <span className="text-club-ink">{shift.positionName ?? shift.departmentName}</span>
            <span className="text-stone-500"> · {shift.templateName}</span>
          </p>
        </div>
        <div>
          <p className="text-[11px] text-stone-500">Scheduled</p>
          <p className="mt-0.5 text-[13px] text-stone-700 tabular-nums">
            {fmtTime(shift.scheduledStartIso)} – {fmtTime(shift.scheduledEndIso)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-stone-500">Worked</p>
          <p className="mt-0.5 text-[13px] text-stone-700 tabular-nums">
            {shift.worked
              ? `${fmtTime(shift.worked.clockInIso)} – ${fmtTime(shift.worked.clockOutIso)}`
              : "—"}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-stone-500">Total</p>
          <p className="mt-0.5 font-serif text-[14px] text-club-ink tabular-nums">
            {shift.worked ? fmtHM(shift.worked.workedSeconds) : "—"}
          </p>
        </div>
        <div className="justify-self-end">
          <span
            className={"inline-block rounded-full px-2.5 py-1 text-[11.5px] font-medium tabular-nums " + varianceClass}
          >
            {variance.label}
          </span>
        </div>
        <ChevronRightIcon className="h-4 w-4 text-stone-300" />
      </div>

      {/* Mobile: stacked but still dense — date on top, then role/name, then two-col metadata */}
      <div className="md:hidden">
        <div className="flex items-baseline justify-between">
          <p className="font-serif text-[14px] text-club-ink">{dayLabel}</p>
          <span
            className={"inline-block rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums " + varianceClass}
          >
            {variance.label}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] uppercase tracking-[0.12em] text-club-green-800 font-medium">
          {shift.positionName ?? shift.departmentName} <span className="normal-case tracking-normal text-stone-700 text-[12.5px]">· {shift.templateName}</span>
        </p>
        <div className="mt-1.5 grid grid-cols-2 gap-2 text-[11.5px] text-stone-600 tabular-nums">
          <p>
            <span className="text-stone-400">Sch.</span>{" "}
            {fmtTime(shift.scheduledStartIso)}–{fmtTime(shift.scheduledEndIso)}
          </p>
          <p>
            <span className="text-stone-400">Work.</span>{" "}
            {shift.worked
              ? `${fmtTime(shift.worked.clockInIso)}–${fmtTime(shift.worked.clockOutIso)}`
              : "—"}
          </p>
        </div>
      </div>
    </li>
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

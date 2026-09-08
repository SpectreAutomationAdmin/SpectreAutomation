// Isolated static desktop Schedule prototype — reproduces
// docs/design/scheduling/employee-schedule-desktop-1440x900-approved.png
// as closely as possible at 1440x900.
//
// FULLY SELF-CONTAINED: builds its own portal-shell visual wrapper
// (dark-green sidebar, dark-green topbar) and every schedule surface
// from scratch. Does NOT import from src/app/employee/(authed)/**
// or src/components/employee/**.
//
// STATIC ONLY:
//   - hardcoded illustrative data
//   - no data fetching
//   - no server actions
//   - no responsive behavior beyond 1440x900
//   - no handlers wired
//   - buttons/links are visual placeholders

import type { ReactNode } from "react";

/* ============================================================
   ICONS — inline SVG so no external icon dependency needed.
   ============================================================ */
function CalendarIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </svg>
  );
}
function UsersIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function DocumentIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5M9 13h6M9 17h6M9 9h1" />
    </svg>
  );
}
function ClockIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function ChevronLeft({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}
function ChevronRight({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
function HomeIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 11l9-8 9 8v10a2 2 0 0 1-2 2h-4v-6H10v6H5a2 2 0 0 1-2-2V11Z" />
    </svg>
  );
}
function PersonIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.418 3.582-8 8-8s8 3.582 8 8" />
    </svg>
  );
}
function BellIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M18 16v-5a6 6 0 0 0-12 0v5l-2 2h16l-2-2Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  );
}
function ChatIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V8a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v7Z" />
    </svg>
  );
}
function CircleInfo({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </svg>
  );
}
function ChevronDownSmall({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/* ============================================================
   SHELL — inline reproduction of the accepted employee portal.
   Not shared with the production portal.
   ============================================================ */
function StaticShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-club-cream" data-testid="static-schedule-shell">
      {/* Sidebar */}
      <aside className="w-[224px] shrink-0 bg-club-green-800 text-club-cream flex flex-col">
        <div className="pt-8 pb-8 px-6">
          <p className="font-serif text-[24px] tracking-[0.28em] leading-none">SPECTRE</p>
          <p className="mt-2.5 text-[12px] tracking-[0.34em] text-club-cream/70">AUTOMATION</p>
        </div>
        <nav className="px-3 space-y-1 text-[15px]">
          <div className="flex items-center gap-3 px-3.5 py-3 rounded-md bg-white/[0.10]">
            <HomeIcon className="h-[20px] w-[20px]" />
            <span>Home</span>
          </div>
          <div className="flex items-center gap-3 px-3.5 py-3 rounded-md text-club-cream/85">
            <PersonIcon className="h-[20px] w-[20px]" />
            <span>Profile</span>
          </div>
        </nav>
        <div className="mt-auto p-3">
          <div className="rounded-md bg-black/25 px-3.5 py-3">
            <div className="flex items-start gap-2.5">
              <ChatIcon className="h-[18px] w-[18px] mt-0.5 text-club-cream/85" />
              <div>
                <p className="text-[13.5px] leading-tight">Say what's on your mind</p>
                <p className="text-[12px] text-club-cream/60 mt-1">Send anonymous feedback</p>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Right side — topbar + content */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-[100px] bg-club-green-800 text-club-cream flex items-center pr-8 gap-6 border-l border-club-cream/20">
          {/* Tenant */}
          <div className="pl-8 flex items-center gap-3.5">
            <div className="w-px h-10 bg-club-cream/25" />
            <div>
              <p className="font-serif text-[18px] leading-tight">Coulee Ridge</p>
              <p className="font-serif text-[18px] leading-tight">Golf &amp; Country Club</p>
            </div>
          </div>
          <div className="flex-1" />
          <button aria-label="Notifications" className="p-2 text-club-cream/85 hover:text-club-cream">
            <BellIcon className="h-[22px] w-[22px]" />
          </button>
          <div className="flex items-center gap-2.5 pl-2">
            <div className="h-11 w-11 rounded-full bg-white/85 text-club-green-800 grid place-items-center font-medium text-[15px]">T</div>
            <span className="text-[15px]">Taylor</span>
            <ChevronDownSmall className="h-4 w-4 text-club-cream/70" />
          </div>
        </header>

        <main className="flex-1 min-w-0 flex flex-col">
          {children}
        </main>
      </div>
    </div>
  );
}

/* ============================================================
   PAGE — schedule content (matches reference at 1440x900).
   ============================================================ */
export default function StaticScheduleDesktop() {
  return (
    <StaticShell>
      <div className="pl-9 pr-9 pt-5 pb-6 w-full">
        {/* BREADCRUMB */}
        <p className="text-[12px] uppercase tracking-[0.22em] text-stone-500">
          App &nbsp;&rsaquo;&nbsp; Employee Portal &nbsp;&rsaquo;&nbsp; Schedule
        </p>

        {/* TITLE */}
        <h1 className="mt-1 font-serif text-[34px] font-semibold text-club-ink leading-[1.05]">
          My Schedule
        </h1>

        {/* TOOLBAR ROW */}
        <div className="mt-4 flex items-center justify-between">
          {/* Left group */}
          <div className="inline-flex items-center gap-2">
            <button className="h-10 w-10 grid place-items-center rounded-md border border-stone-300 bg-white text-stone-700">
              <ChevronLeft className="h-[18px] w-[18px]" />
            </button>
            <div className="font-serif text-[21px] text-club-ink px-3">
              September 7 – 13, 2026
            </div>
            <button className="h-10 w-10 grid place-items-center rounded-md border border-stone-300 bg-white text-stone-700">
              <ChevronRight className="h-[18px] w-[18px]" />
            </button>
            <button className="ml-3 rounded-md border border-stone-300 bg-white px-5 py-2.5 text-[15px] text-stone-800">
              Today
            </button>
          </div>
          {/* Right group */}
          <nav className="inline-flex rounded-md border border-stone-300 overflow-hidden text-[15px] bg-white">
            <button className="px-5 py-2.5 border-r border-stone-300 bg-club-green-800 text-white font-medium">Week</button>
            <button className="px-5 py-2.5 border-r border-stone-300 text-stone-700">Month</button>
            <button className="px-5 py-2.5 text-stone-700">My Availability</button>
          </nav>
        </div>

        {/* WEEK CALENDAR */}
        <section className="mt-4 rounded-lg border border-stone-200 bg-white overflow-hidden">
          {/* Header band */}
          <div className="grid grid-cols-7 divide-x divide-stone-100 border-b border-stone-200">
            {DAYS.map((d) => (
              <div key={`h-${d.iso}`} className="pt-4 pb-3.5 text-center">
                <div className="text-[14.5px] font-medium text-club-ink">{d.dayName}</div>
                <div className="mt-1 text-[13px] text-stone-500">Sep {d.dayNum}</div>
              </div>
            ))}
          </div>
          {/* Shift content band */}
          <div className="grid grid-cols-7 divide-x divide-stone-100" style={{ minHeight: "130px" }}>
            {DAYS.map((d) => (
              <div key={`s-${d.iso}`} className="px-3 pt-4 pb-5 flex flex-col">
                {d.shift ? (
                  <div className="mx-auto w-full max-w-[158px]">
                    <div
                      className={
                        "rounded-md border px-3.5 py-3.5 " +
                        (d.shift.tint === "bar"
                          ? "border-sky-200/70 bg-sky-50/60"
                          : "border-club-green-200/70 bg-club-green-50/70")
                      }
                    >
                      {/* Small uppercase role eyebrow (per approved PNG) */}
                      <p className={
                        "text-[11px] uppercase tracking-[0.14em] font-semibold whitespace-nowrap " +
                        (d.shift.tint === "bar" ? "text-sky-800" : "text-club-green-700")
                      }>
                        {d.shift.role}
                      </p>
                      {/* Dominant serif template name */}
                      <p className="mt-1.5 font-serif text-[16px] text-club-ink leading-[1.15] whitespace-nowrap">
                        {d.shift.template}
                      </p>
                      <p className="mt-2 text-[12.5px] text-stone-700 leading-tight tabular-nums whitespace-nowrap">
                        {d.shift.time}
                      </p>
                      <p className="text-[12.5px] text-stone-500 leading-tight tabular-nums whitespace-nowrap">
                        {d.shift.duration}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="my-auto flex flex-col items-center justify-center text-stone-400">
                    <span className="text-[18px] leading-none">—</span>
                    <span className="mt-2.5 text-[14px]">No shift</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* KPI TRIO */}
        <section className="mt-4 grid grid-cols-3 gap-5">
          {/* Next Shift — icon column + content column (title AND body share left edge) */}
          <div className="rounded-lg border border-stone-200 bg-white px-5 py-2.5 grid grid-cols-[36px_minmax(0,1fr)] gap-x-3">
            <div className="row-start-1 flex items-center h-[26px]">
              <img
                src="/design/scheduling/icons/next-shift.svg"
                alt=""
                aria-hidden="true"
                className="block w-[26px] h-[26px]"
              />
            </div>
            <p className="row-start-1 self-center font-serif text-[22px] text-club-ink leading-none">Next Shift</p>
            <div className="col-start-2">
              <p className="mt-3 font-serif text-[18px] font-normal text-club-ink leading-[1.15]">
                Tuesday, September 8
              </p>
              <p className="mt-2 text-[15px] text-club-ink font-medium">
                Server <span className="text-stone-500 font-normal">· Day Shift</span>
              </p>
              <p className="mt-1 text-[14.5px] text-stone-600 tabular-nums">
                11:00 AM – 5:30 PM (6h 30m)
              </p>
              <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-club-green-50 text-club-green-800 px-4 py-2 text-[14px] font-medium">
                <ClockIcon className="h-4 w-4" />
                Starts in 14h 22m
              </div>
            </div>
          </div>

          {/* This Week — icon column + content column (title AND rows share left edge) */}
          <div className="rounded-lg border border-stone-200 bg-white px-5 py-2.5 grid grid-cols-[36px_minmax(0,1fr)] gap-x-3">
            <div className="row-start-1 flex items-center h-[26px]">
              <img
                src="/design/scheduling/icons/this-week.svg"
                alt=""
                aria-hidden="true"
                className="block w-[26px] h-[26px]"
              />
            </div>
            <p className="row-start-1 self-center font-serif text-[22px] text-club-ink leading-none">This Week</p>
            <div className="col-start-2">
              <dl className="mt-4 text-[15px] divide-y divide-stone-100">
                <div className="flex justify-between items-baseline py-2.5">
                  <dt className="text-stone-600">Scheduled hours</dt>
                  <dd className="font-semibold text-club-ink tabular-nums">18h 30m</dd>
                </div>
                <div className="flex justify-between items-baseline py-2.5">
                  <dt className="text-stone-600">Worked hours</dt>
                  <dd className="font-semibold text-club-ink tabular-nums">6h 34m</dd>
                </div>
                <div className="flex justify-between items-baseline py-2.5">
                  <dt className="text-stone-600">Remaining hours</dt>
                  <dd className="font-semibold text-club-ink tabular-nums">11h 56m</dd>
                </div>
              </dl>
            </div>
          </div>

          {/* Actions — header uses the same 2-column alignment; action rows remain full-width per §11 */}
          <div className="rounded-lg border border-stone-200 bg-white px-5 py-2.5">
            <div className="grid grid-cols-[36px_minmax(0,1fr)] gap-x-3 items-center">
              <div className="flex items-center h-[26px]">
                <img
                  src="/design/scheduling/icons/actions.svg"
                  alt=""
                  aria-hidden="true"
                  className="block w-[26px] h-[26px]"
                />
              </div>
              <p className="font-serif text-[22px] text-club-ink leading-none">Actions</p>
            </div>
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-3.5 rounded-md border border-stone-200 px-4 py-2">
                <CalendarIcon className="h-[30px] w-[30px] self-center shrink-0 text-[#2f6a3e]" />
                <div>
                  <p className="text-[15px] font-medium text-club-ink leading-tight">View my availability</p>
                  <p className="text-[13px] text-stone-500 mt-0.5">Update your availability</p>
                </div>
              </div>
              <div className="flex items-center gap-3.5 rounded-md border border-stone-200 px-4 py-2">
                <DocumentIcon className="h-[30px] w-[30px] self-center shrink-0 text-[#2f6a3e]" />
                <div>
                  <p className="text-[15px] font-medium text-club-ink leading-tight">Request time off</p>
                  <p className="text-[13px] text-stone-500 mt-0.5">Submit a time off request</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* RECENT SHIFTS */}
        <section className="mt-4 rounded-lg border border-stone-200 bg-white overflow-hidden">
          <div className="px-8 pt-3.5 pb-2.5">
            <h2 className="font-serif text-[22px] text-club-ink leading-none">Recent Shifts</h2>
          </div>
          <div className="border-t border-stone-100" />
          <div className="px-8 py-2.5 grid grid-cols-[190px_minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)_110px_100px_20px] items-center gap-5">
            <div className="pr-5 border-r border-stone-200 self-stretch flex items-center">
              <p className="font-serif text-[16px] text-club-ink">Mon, Aug 31</p>
            </div>
            <div className="min-w-0">
              <p className="text-[15px] text-club-ink">
                Server <span className="text-stone-500">· Day Shift</span>
              </p>
            </div>
            <div>
              <p className="text-[12px] text-stone-500">Scheduled</p>
              <p className="mt-1 text-[14.5px] text-stone-700 tabular-nums">11:00 AM – 5:30 PM</p>
            </div>
            <div>
              <p className="text-[12px] text-stone-500">Worked</p>
              <p className="mt-1 text-[14.5px] text-stone-700 tabular-nums">10:58 AM – 5:42 PM</p>
            </div>
            <div>
              <p className="text-[12px] text-stone-500">Total</p>
              <p className="mt-1 font-serif text-[16px] text-club-ink leading-none">6h 44m</p>
            </div>
            <div className="justify-self-end">
              <span className="inline-block rounded-full bg-club-green-50 text-club-green-800 px-3 py-1 text-[13px] font-medium tabular-nums">
                +14 min
              </span>
            </div>
            <ChevronRight className="h-[18px] w-[18px] text-stone-300" />
          </div>
        </section>
      </div>
    </StaticShell>
  );
}

/* ============================================================
   STATIC DATA — reproduced verbatim from the approved reference.
   ============================================================ */
type StaticShift = {
  role: "SERVER" | "BARTENDER";
  template: "Day Shift" | "Evening Shift";
  time: string;
  duration: string;
  tint: "srv" | "bar";
};
type StaticDay = {
  iso: string;
  dayName: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  dayNum: number;
  shift: StaticShift | null;
};

const DAYS: StaticDay[] = [
  { iso: "2026-09-07", dayName: "Mon", dayNum: 7,  shift: null },
  { iso: "2026-09-08", dayName: "Tue", dayNum: 8,  shift: {
    role: "SERVER", template: "Day Shift",     time: "11:00 AM – 5:30 PM",  duration: "6h 30m", tint: "srv" } },
  { iso: "2026-09-09", dayName: "Wed", dayNum: 9,  shift: {
    role: "SERVER", template: "Evening Shift", time: "5:30 PM – 11:00 PM",  duration: "5h 30m", tint: "srv" } },
  { iso: "2026-09-10", dayName: "Thu", dayNum: 10, shift: {
    role: "SERVER", template: "Evening Shift", time: "5:30 PM – 11:00 PM",  duration: "5h 30m", tint: "srv" } },
  { iso: "2026-09-11", dayName: "Fri", dayNum: 11, shift: {
    role: "SERVER", template: "Evening Shift", time: "5:30 PM – 11:00 PM",  duration: "5h 00m", tint: "srv" } },
  { iso: "2026-09-12", dayName: "Sat", dayNum: 12, shift: {
    role: "BARTENDER", template: "Evening Shift", time: "5:30 PM – 11:30 PM", duration: "6h 00m", tint: "bar" } },
  { iso: "2026-09-13", dayName: "Sun", dayNum: 13, shift: null },
];

// Unused-import silencer:
export { CircleInfo };

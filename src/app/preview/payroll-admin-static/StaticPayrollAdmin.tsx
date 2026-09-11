// Isolated static desktop Payroll Admin prototype — reproduces
// docs/design/payroll/payroll-admin-desktop-1440x900-approved.png
// as closely as possible at 1440x900.
//
// FULLY SELF-CONTAINED: builds its own admin-shell visual wrapper
// (dark navy sidebar with SPECTRE AUTOMATION brand, light topbar with
// Coulee Ridge tenant identity + search + notifications + user chip),
// and every Payroll surface from scratch. Does NOT import from
// src/app/app/admin/** or src/components/Sidebar / TopBar.
//
// STATIC ONLY:
//   - hardcoded fixture data
//   - no data fetching, no server actions, no responsive behavior
//   - no real Payroll integration
//
// This shell is the visual specification for Phase 1 founder review.
// The reference image dimensions are 1440 x 900; every measurement
// below (sidebar width 183, KPI band, workspace/right-rail split,
// footer position) was derived from a pixel-scan of that reference.

import type { ReactNode } from "react";

/* ============================================================
   INLINE SVG ICONS — no external dependency; all sized per usage.
   ============================================================ */

// Spectre logo mark (hexagon-ish S) — used at the top of the sidebar.
function SpectreLogo({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" fill="none" className={className} aria-hidden="true">
      <path d="M20 3 L34 11 V29 L20 37 L6 29 V11 Z" stroke="#e5e7eb" strokeWidth="1.6" />
      <path
        d="M25 15c-1.5-2-4.5-2.5-6.5-1s-2 4 0 5.5c2 1.5 5.5 1 7.5 2.5s1.5 4-1 5.5-6 0.5-7.5-1.5"
        stroke="#e5e7eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"
      />
    </svg>
  );
}
// Mountain icon — for tenant identity in topbar + sidebar footer badge.
function MountainIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 20l6-11 4 6 3-4 5 9H3z" />
      <path d="M9 9l3 5" />
    </svg>
  );
}
function HomeIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" />
    </svg>
  );
}
function InboxIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 13h4l2 3h4l2-3h4" /><path d="M4 13l3-8h10l3 8" /><path d="M4 13v6h16v-6" />
    </svg>
  );
}
function UsersIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function CalendarIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </svg>
  );
}
function PayrollFolderIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}
function HrIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="8" r="3.5" /><path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6" />
    </svg>
  );
}
function ChatIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 5h16v11H8l-4 4V5z" />
    </svg>
  );
}
function BuildingIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 21V6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v15" />
      <path d="M16 10h3a2 2 0 0 1 2 2v9" />
      <path d="M7 9h4M7 13h4M7 17h4M18 14h1M18 18h1" />
    </svg>
  );
}
function CogIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.9l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
function ChevronDown({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
function ChevronRightSmall({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
function ChevronLeftSmall({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}
function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  );
}
function BellIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10 21a2 2 0 0 0 4 0" />
    </svg>
  );
}
function CheckCircleIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" />
    </svg>
  );
}
function CircleOutline({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}
function AlertTriangleIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3 2 20h20L12 3z" /><path d="M12 10v5M12 18v.5" />
    </svg>
  );
}
function ClockIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  );
}
function DollarIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3v18M17 7c-1-2-3-3-5-3s-4 1-4 3 1 3 4 3 5 1 5 4-2 4-5 4-5-1-6-3" />
    </svg>
  );
}
function DocIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}
function UsersRoundIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="9" cy="9" r="3" /><circle cx="17" cy="10" r="2.5" />
      <path d="M3 20c1-3 3.5-5 6-5s5 2 6 5" />
      <path d="M14 20c.5-2.5 2-4 4-4s3.5 1.5 4 4" />
    </svg>
  );
}
function DownloadIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 20h16" />
    </svg>
  );
}
function PlusIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function RefreshIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" />
    </svg>
  );
}
function EyeCheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" />
    </svg>
  );
}
function CalcIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 7h8M8 12h2M12 12h2M16 12h.5M8 16h2M12 16h2M16 16h.5" />
    </svg>
  );
}
function TrendUpIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" />
    </svg>
  );
}
function ArrowRight({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M5 12h14" /><path d="m13 6 6 6-6 6" />
    </svg>
  );
}

/* ============================================================
   STATIC FIXTURE DATA — matches the reference exactly.
   Not connected to real Payroll models, services, or DB.
   ============================================================ */
type EmployeeRow = {
  name: string;
  department: string;
  regularHrs: string;
  otHrs: string;
  totalHrs: string;
  grossPay: string;
  status: "Ready" | "Exception" | "Pending Approval";
};
const EMPLOYEE_ROWS: EmployeeRow[] = [
  { name: "Taylor Hourly",  department: "Events",         regularHrs: "32.00", otHrs: "0.00", totalHrs: "32.00", grossPay: "$784.00",   status: "Ready" },
  { name: "Riley Preview",  department: "Events",         regularHrs: "28.50", otHrs: "2.50", totalHrs: "31.00", grossPay: "$864.75",   status: "Ready" },
  { name: "Casey Preview",  department: "Events",         regularHrs: "16.00", otHrs: "0.00", totalHrs: "16.00", grossPay: "$392.00",   status: "Ready" },
  { name: "Devon Preview",  department: "Events",         regularHrs: "24.00", otHrs: "0.00", totalHrs: "24.00", grossPay: "$720.00",   status: "Ready" },
  { name: "Chris Turcato",  department: "Administration", regularHrs: "40.00", otHrs: "0.00", totalHrs: "40.00", grossPay: "$2,500.00", status: "Ready" },
  { name: "Lise Montsion",  department: "Administration", regularHrs: "40.00", otHrs: "0.00", totalHrs: "40.00", grossPay: "$2,200.00", status: "Ready" },
  { name: "Alex Chen",      department: "Maintenance",    regularHrs: "38.00", otHrs: "4.00", totalHrs: "42.00", grossPay: "$1,176.00", status: "Exception" },
  { name: "Jordan Keller",  department: "Food & Beverage", regularHrs: "36.00", otHrs: "0.00", totalHrs: "36.00", grossPay: "$936.00",  status: "Ready" },
  { name: "Morgan West",    department: "Golf Operations", regularHrs: "32.00", otHrs: "0.00", totalHrs: "32.00", grossPay: "$840.00",  status: "Pending Approval" },
  { name: "Jamie Park",     department: "Housekeeping",   regularHrs: "30.00", otHrs: "0.00", totalHrs: "30.00", grossPay: "$690.00",   status: "Ready" },
];

const WORKFLOW = [
  { n: 1, label: "Prepare",  sub: "Sep 7 – 13",   state: "done" as const },
  { n: 2, label: "Review",   sub: "Exceptions",    state: "current" as const },
  { n: 3, label: "Approvals", sub: "(Dept. Heads)", state: "pending" as const },
  { n: 4, label: "Calculate", sub: "Payroll",       state: "pending" as const },
  { n: 5, label: "Review & Adjust", sub: "", state: "pending" as const },
  { n: 6, label: "Submit",  sub: "for Approval",    state: "pending" as const },
  { n: 7, label: "Approved", sub: "(Controller)",   state: "pending" as const },
  { n: 8, label: "Posted",   sub: "Complete",       state: "pending" as const },
];

/* ============================================================
   REGION 1 — SPECTRE CHROME (sidebar + topbar)
   ============================================================ */

function AdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f8f6f3] flex text-[#1a1f1a]" style={{ fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' }}>
      {/* ============ SIDEBAR (dark navy) ============ */}
      <aside className="w-[184px] shrink-0 bg-[#0f172a] text-[#e5e7eb] flex flex-col min-h-screen">
        {/* Brand */}
        <div className="px-5 pt-5 pb-4 flex items-center gap-2.5">
          <SpectreLogo className="h-8 w-8" />
          <div className="leading-[1.05]">
            <p className="text-[13px] font-semibold tracking-[0.02em]">SPECTRE</p>
            <p className="text-[10.5px] tracking-[0.32em] text-[#9ca3af]">AUTOMATION</p>
          </div>
        </div>
        {/* Nav */}
        <nav className="mt-1 flex-1 flex flex-col text-[13.5px]">
          {/* Top-level */}
          <SideNavItem icon={<HomeIcon className="h-[17px] w-[17px]" />} label="Home" />
          <SideNavItem
            icon={<InboxIcon className="h-[17px] w-[17px]" />}
            label="Work Intake"
            trailing={<span className="ml-auto h-[18px] min-w-[18px] px-1 rounded-full bg-[#dc2626] text-white text-[10.5px] font-semibold grid place-items-center">3</span>}
          />
          <SideNavItem icon={<UsersIcon className="h-[17px] w-[17px]" />} label="Employees" />
          <SideNavItem icon={<CalendarIcon className="h-[17px] w-[17px]" />} label="Scheduling" />
          {/* Payroll (expanded) */}
          <div>
            <div className="mx-2 mt-0.5 rounded-md bg-[#1e293b] px-2.5 py-2 flex items-center gap-2.5 text-white">
              <PayrollFolderIcon className="h-[17px] w-[17px]" />
              <span className="flex-1 font-medium">Payroll</span>
              <ChevronDown className="h-4 w-4 text-[#9ca3af]" />
            </div>
            {/* Children */}
            <ul className="pt-1 pb-1 text-[12.5px] text-[#9ca3af]">
              <li>
                <div className="mx-2 rounded-md bg-[#152036] pl-[38px] pr-3 py-1 text-white">
                  Overview
                </div>
              </li>
              <li className="pl-[38px] pr-3 py-1 hover:text-white">Payroll Runs</li>
              <li className="pl-[38px] pr-3 py-1 hover:text-white">Time Approvals</li>
              <li className="pl-[38px] pr-3 py-1 hover:text-white">Adjustments</li>
              <li className="pl-[38px] pr-3 py-1 hover:text-white">Recurring Components</li>
              <li className="pl-[38px] pr-3 py-1 hover:text-white">Reports</li>
              <li className="pl-[38px] pr-3 py-1 hover:text-white">Settings</li>
            </ul>
          </div>
          <SideNavItem icon={<HrIcon className="h-[17px] w-[17px]" />} label="HR" trailingChevron />
          <SideNavItem icon={<ChatIcon className="h-[17px] w-[17px]" />} label="Communications" trailingChevron />
          <SideNavItem icon={<BuildingIcon className="h-[17px] w-[17px]" />} label="Club Operations" trailingChevron />
          <SideNavItem icon={<CogIcon className="h-[17px] w-[17px]" />} label="System Admin" trailingChevron />
        </nav>
        {/* Bottom tenant badge — mountain-range glyph + 2-line tenant name.
             No card wrapper (matches reference exactly). */}
        <div className="px-4 pb-2 text-center text-[#e5e7eb]">
          <svg viewBox="0 0 60 30" className="mx-auto h-8 w-16 text-[#e5e7eb]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 26 L14 10 L20 18 L28 6 L38 20 L46 12 L57 26 Z" />
            <path d="M14 10 L20 18" />
            <path d="M28 6 L38 20" />
          </svg>
          <p className="mt-2 text-[11.5px] leading-tight">Coulee Ridge</p>
          <p className="text-[11.5px] leading-tight text-[#9ca3af]">Golf &amp; Country Club</p>
        </div>
      </aside>

      {/* ============ RIGHT-HAND FRAME (topbar + main) ============ */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* ============ TOP BAR ============ */}
        <header className="h-[52px] bg-white border-b border-stone-200 flex items-center px-6 gap-6">
          {/* Tenant chip */}
          <button className="flex items-center gap-2 text-[13.5px] text-stone-700 hover:text-stone-900" type="button">
            <span className="h-6 w-6 rounded-full bg-[#eef1ec] text-[#3f7042] grid place-items-center">
              <MountainIcon className="h-4 w-4" />
            </span>
            <span className="font-medium">Coulee Ridge Golf &amp; Country Club</span>
            <ChevronDown className="h-3.5 w-3.5 text-stone-400" />
          </button>
          <div className="flex-1" />
          {/* Search */}
          <div className="relative w-[380px]">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400" />
            <input
              readOnly
              className="w-full h-9 rounded-md border border-stone-200 bg-white pl-9 pr-3 text-[13px] placeholder:text-stone-400"
              placeholder="Search employees, payroll, or reports..."
            />
          </div>
          {/* Bell */}
          <div className="relative">
            <button className="h-9 w-9 grid place-items-center rounded-md text-stone-500 hover:bg-stone-100" type="button">
              <BellIcon className="h-[19px] w-[19px]" />
            </button>
            <span className="absolute top-1.5 right-1.5 h-[16px] min-w-[16px] px-1 rounded-full bg-[#dc2626] text-white text-[10px] font-semibold grid place-items-center">1</span>
          </div>
          {/* User */}
          <button className="flex items-center gap-2 pl-2 hover:bg-stone-50 rounded-md p-1" type="button">
            <span className="h-8 w-8 rounded-full bg-[#2563eb] text-white grid place-items-center text-[12px] font-semibold">JS</span>
            <span className="text-left leading-[1.1]">
              <span className="block text-[13px] font-medium text-stone-800">Jennifer Smith</span>
              <span className="block text-[11px] text-stone-500">Payroll Admin</span>
            </span>
          </button>
        </header>

        {/* ============ MAIN ============ */}
        <main className="flex-1 min-w-0 flex flex-col">{children}</main>
      </div>
    </div>
  );
}

function SideNavItem({
  icon, label, trailing, trailingChevron,
}: { icon: ReactNode; label: string; trailing?: ReactNode; trailingChevron?: boolean }) {
  return (
    <div className="mx-2 rounded-md px-2.5 py-2 flex items-center gap-2.5 text-[#e5e7eb] hover:bg-[#152036]">
      {icon}
      <span className="flex-1">{label}</span>
      {trailing}
      {trailingChevron && <ChevronRightSmall className="h-3.5 w-3.5 text-[#9ca3af]" />}
    </div>
  );
}

/* ============================================================
   REGION 2 — HEADER + 8-STAGE WORKFLOW
   ============================================================ */

function PayrollHeader() {
  return (
    <section className="px-8 pt-3">
      {/* Title row */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-semibold text-[28px] text-stone-900 leading-[1.1]">Weekly Payroll</h1>
            <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-[#dcfce7] text-[#166534] text-[11px] font-semibold tracking-[0.06em]">
              IN PROGRESS
            </span>
          </div>
          <div className="mt-2 text-[13px] text-stone-600 flex items-center gap-8">
            <span><span className="font-semibold text-stone-700">Period:</span>&nbsp;Mon, Sep 7, 2026 – Sun, Sep 13, 2026</span>
            <span><span className="font-semibold text-stone-700">Pay Date:</span>&nbsp;Fri, Sep 18, 2026</span>
          </div>
        </div>
        <button className="inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white px-3.5 py-2 text-[13px] text-stone-700 hover:bg-stone-50" type="button">
          <CalendarIcon className="h-4 w-4 text-stone-500" />
          Change Period
          <ChevronDown className="h-3.5 w-3.5 text-stone-400" />
        </button>
      </div>

      {/* Workflow */}
      <div className="mt-4 relative">
        {/* Full connector line — sits vertically centered through the node ring */}
        <div className="absolute top-[14px] left-[68px] right-[68px] h-[2px] bg-stone-300" />
        {/* Filled segment — from node 1 center to node 2 center (12.5% per stage / 8) */}
        <div className="absolute top-[14px] h-[2px] bg-[#0f5f3f]" style={{ left: 68, width: "12.5%" }} />
        <div className="grid grid-cols-8 relative">
          {WORKFLOW.map((s) => (
            <div key={s.n} className="flex flex-col items-center relative">
              <div
                className={
                  "relative z-10 grid place-items-center rounded-full text-[12px] font-semibold h-[28px] w-[28px] " +
                  (s.state === "done"
                    ? "bg-[#0f5f3f] text-white ring-4 ring-[#0f5f3f]/15"
                    : s.state === "current"
                    ? "bg-white text-[#0f5f3f] border-2 border-[#0f5f3f]"
                    : "bg-white text-stone-400 border border-stone-300")
                }
              >
                {s.n}
              </div>
              <div className="mt-2 text-center leading-tight">
                <p className={"text-[12.5px] " + (s.state === "current" ? "text-[#0f5f3f] font-semibold underline underline-offset-4 decoration-2" : "text-stone-800 font-medium")}>
                  {s.label}
                </p>
                {s.sub && (
                  <p className="text-[11.5px] text-stone-500 mt-0.5">{s.sub}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   REGION 3 — 5-CARD KPI STRIP
   ============================================================ */

function KpiStrip() {
  return (
    <section className="px-8 mt-1.5 grid grid-cols-5 gap-4">
      <KpiCard
        icon={<UsersRoundIcon className="h-7 w-7" />}
        iconColor="text-[#3f7042]"
        label="Employees" value="48" sub="42 hourly · 6 salary"
      />
      <KpiCard
        icon={<ClockIcon className="h-7 w-7" />}
        iconColor="text-[#2563eb]"
        label="Total Hours" value="1,248.50"
        subEl={<span className="text-[#0f5f3f] font-medium inline-flex items-center gap-1"><TrendUpIcon className="h-3.5 w-3.5" />5% vs. previous period</span>}
      />
      <KpiCard
        icon={<DollarIcon className="h-7 w-7" />}
        iconColor="text-[#3f7042]"
        label="Estimated Gross Pay" value="$32,487.62"
        subEl={<span className="text-[#0f5f3f] font-medium inline-flex items-center gap-1"><TrendUpIcon className="h-3.5 w-3.5" />3% vs. previous period</span>}
      />
      <KpiCard
        icon={<DocIcon className="h-7 w-7" />}
        iconColor="text-[#7c3aed]"
        label="Adjustments" value="7" sub="3 one-time · 4 recurring"
      />
      <KpiCard
        icon={<AlertTriangleIcon className="h-7 w-7" />}
        iconColor="text-[#dc2626]"
        label="Exceptions" valueColor="text-[#dc2626]" value="3"
        subEl={<a href="#" className="text-[#dc2626] font-medium underline underline-offset-2 inline-flex items-center gap-1">View exceptions <ArrowRight className="h-3 w-3" /></a>}
      />
    </section>
  );
}

function KpiCard({
  icon, iconColor, label, value, valueColor, sub, subEl,
}: {
  icon: ReactNode; iconBg?: string; iconColor: string;
  label: string; value: string; valueColor?: string;
  sub?: string; subEl?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white px-4 py-1.5">
      <div className="flex items-start gap-3">
        <div className={"shrink-0 " + iconColor}>{icon}</div>
        <div className="min-w-0">
          <p className="text-[12px] text-stone-500 leading-tight">{label}</p>
          <p className={"mt-0.5 text-[24px] font-semibold leading-[1.1] tabular-nums " + (valueColor ?? "text-stone-900")}>{value}</p>
          {sub && <p className="mt-1 text-[11.5px] text-stone-500">{sub}</p>}
          {subEl && <p className="mt-1 text-[11.5px]">{subEl}</p>}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   REGION 4 — WORKSPACE (tabs + filters + table + pagination)
   ============================================================ */

function Workspace() {
  return (
    <section className="rounded-lg border border-stone-200 bg-white overflow-hidden">
      {/* Tabs */}
      <div className="px-6 pt-3 border-b border-stone-100">
        <nav className="flex items-end gap-8 text-[13.5px]">
          <span className="pb-2.5 text-[#1e40af] font-semibold border-b-2 border-[#1e40af]">Employees</span>
          <span className="pb-2.5 text-stone-500 hover:text-stone-800">Exceptions (3)</span>
          <span className="pb-2.5 text-stone-500 hover:text-stone-800">Adjustments (7)</span>
          <span className="pb-2.5 text-stone-500 hover:text-stone-800">Approvals</span>
          <span className="pb-2.5 text-stone-500 hover:text-stone-800">Summary</span>
        </nav>
      </div>
      {/* Filter row */}
      <div className="px-6 py-2 flex items-center gap-2.5">
        <div className="relative w-[280px]">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400" />
          <input readOnly placeholder="Search employees..." className="w-full h-9 rounded-md border border-stone-200 bg-white pl-9 pr-3 text-[13px] placeholder:text-stone-400" />
        </div>
        <FilterButton label="All Departments" />
        <FilterButton label="All Employment Types" />
        <FilterButton label="All Statuses" />
        <div className="flex-1" />
        <button className="inline-flex items-center gap-2 h-9 rounded-md border border-stone-200 bg-white px-3 text-[13px] text-stone-700 hover:bg-stone-50" type="button">
          <DownloadIcon className="h-4 w-4 text-stone-500" />
          Export
        </button>
      </div>
      {/* Employee table */}
      <div className="border-t border-stone-100">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[12px] text-stone-500 bg-[#fbfaf7]">
              <th className="pl-6 py-2.5 font-medium w-[38px]"><input type="checkbox" readOnly className="align-middle" /></th>
              <th className="py-2.5 font-medium">Employee</th>
              <th className="py-2.5 font-medium">Department</th>
              <th className="py-2.5 font-medium text-right pr-6">Regular Hrs</th>
              <th className="py-2.5 font-medium text-right pr-6">OT Hrs</th>
              <th className="py-2.5 font-medium text-right pr-6">Total Hrs</th>
              <th className="py-2.5 font-medium text-right pr-6">Gross Pay</th>
              <th className="py-2.5 font-medium">Status</th>
              <th className="py-2.5 font-medium pr-6">Actions</th>
            </tr>
          </thead>
          <tbody>
            {EMPLOYEE_ROWS.map((r, i) => (
              <tr key={r.name} className={"border-t border-stone-100 " + (i % 2 === 1 ? "" : "")}>
                <td className="pl-6 py-0.5"><input type="checkbox" readOnly className="align-middle" /></td>
                <td className="py-0.5 text-stone-900">{r.name}</td>
                <td className="py-0.5 text-stone-700">{r.department}</td>
                <td className="py-0.5 text-right text-stone-800 pr-6 tabular-nums">{r.regularHrs}</td>
                <td className="py-0.5 text-right text-stone-800 pr-6 tabular-nums">{r.otHrs}</td>
                <td className="py-0.5 text-right text-stone-800 pr-6 tabular-nums">{r.totalHrs}</td>
                <td className="py-0.5 text-right text-stone-800 pr-6 tabular-nums">{r.grossPay}</td>
                <td className="py-0.5"><StatusPill status={r.status} /></td>
                <td className="py-0.5 pr-6"><a href="#" className="text-[#1e40af]">View</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Pagination */}
      <div className="px-6 py-2 flex items-center justify-between text-[12.5px] text-stone-500 border-t border-stone-100">
        <p>Showing 1–10 of 48 employees</p>
        <div className="inline-flex items-center gap-1">
          <PageBtn><ChevronLeftSmall className="h-3.5 w-3.5" /></PageBtn>
          <PageBtn active>1</PageBtn>
          <PageBtn>2</PageBtn>
          <PageBtn>3</PageBtn>
          <PageBtn>4</PageBtn>
          <PageBtn>5</PageBtn>
          <PageBtn><ChevronRightSmall className="h-3.5 w-3.5" /></PageBtn>
        </div>
        <div className="inline-flex items-center gap-2">
          <button className="inline-flex items-center gap-1.5 h-8 rounded-md border border-stone-200 bg-white px-2.5 text-[12.5px] text-stone-700" type="button">
            10 per page <ChevronDown className="h-3 w-3 text-stone-400" />
          </button>
        </div>
      </div>
    </section>
  );
}

function FilterButton({ label }: { label: string }) {
  return (
    <button className="inline-flex items-center gap-2 h-9 rounded-md border border-stone-200 bg-white px-3 text-[13px] text-stone-700 hover:bg-stone-50 min-w-[160px] justify-between" type="button">
      <span>{label}</span>
      <ChevronDown className="h-3.5 w-3.5 text-stone-400" />
    </button>
  );
}
function StatusPill({ status }: { status: EmployeeRow["status"] }) {
  const cfg = status === "Ready"
    ? { bg: "bg-[#dcfce7]", text: "text-[#166534]", dot: "bg-[#16a34a]" }
    : status === "Exception"
    ? { bg: "bg-[#fee2e2]", text: "text-[#991b1b]", dot: "bg-[#dc2626]" }
    : { bg: "bg-[#fef3c7]", text: "text-[#92400e]", dot: "bg-[#f59e0b]" };
  return (
    <span className={"inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] " + cfg.bg + " " + cfg.text}>
      <span className={"h-1.5 w-1.5 rounded-full " + cfg.dot} />
      {status}
    </span>
  );
}
function PageBtn({ children, active }: { children: ReactNode; active?: boolean }) {
  return (
    <button type="button" className={"h-7 min-w-[28px] px-2 rounded text-[12.5px] " + (active ? "bg-[#e6effe] text-[#1e40af] font-semibold" : "text-stone-500 hover:bg-stone-100")}>
      {children}
    </button>
  );
}

/* ============================================================
   REGION 5 — PAYROLL ACTIONS
   ============================================================ */

function PayrollActionsCard() {
  return (
    <section className="rounded-lg border border-stone-200 bg-white overflow-hidden">
      <div className="px-5 pt-2.5 pb-1.5">
        <h2 className="font-semibold text-[15px] text-stone-900">Payroll Actions</h2>
      </div>
      <div className="px-4 pb-2.5 space-y-1.5">
        <button className="w-full inline-flex items-center justify-between rounded-md bg-[#1e40af] text-white px-3.5 py-1.5 text-[13px] font-medium hover:bg-[#1e3a8a]" type="button">
          <span className="inline-flex items-center gap-2"><AlertTriangleIcon className="h-4 w-4" /> Resolve Exceptions</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <PayrollActionBtn icon={<PlusIcon className="h-4 w-4 text-stone-500" />}>Add One-Time Adjustment</PayrollActionBtn>
        <PayrollActionBtn icon={<RefreshIcon className="h-4 w-4 text-stone-500" />}>Manage Recurring Components</PayrollActionBtn>
        <PayrollActionBtn icon={<EyeCheckIcon className="h-4 w-4 text-stone-500" />}>View Time Approvals</PayrollActionBtn>
        <PayrollActionBtn icon={<CalcIcon className="h-4 w-4 text-stone-500" />}>Calculate Payroll (Preview)</PayrollActionBtn>
      </div>
    </section>
  );
}
function PayrollActionBtn({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <button className="w-full inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white px-3.5 py-1.5 text-[13px] text-stone-800 hover:bg-stone-50" type="button">
      {icon}
      {children}
    </button>
  );
}

/* ============================================================
   REGION 6 — PRE-CALCULATION CHECKLIST
   ============================================================ */

function ChecklistCard() {
  return (
    <section className="rounded-lg border border-stone-200 bg-white overflow-hidden">
      <div className="px-5 pt-2.5 pb-1.5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-[15px] text-stone-900">Pre-Calculation Checklist</h2>
          <p className="text-[12px] text-stone-500 tabular-nums"><span className="font-semibold text-stone-900">5</span> of 6 complete</p>
        </div>
        <div className="mt-1.5 h-1.5 rounded-full bg-stone-100 overflow-hidden">
          <div className="h-full bg-[#0f5f3f]" style={{ width: `${(5 / 6) * 100}%` }} />
        </div>
      </div>
      <ul className="px-5 pb-2 pt-0.5 space-y-0.5 text-[12.5px] leading-tight">
        <ChecklistItem done>All time entries imported</ChecklistItem>
        <ChecklistItem done>Department head approvals (48/48)</ChecklistItem>
        <ChecklistItem>Resolve payroll exceptions (3 remaining)</ChecklistItem>
        <ChecklistItem done>Review one-time adjustments</ChecklistItem>
        <ChecklistItem done>Review recurring components</ChecklistItem>
        <ChecklistItem done>Verify employee data</ChecklistItem>
      </ul>
    </section>
  );
}
function ChecklistItem({ done, children }: { done?: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 leading-snug">
      {done
        ? <CheckCircleIcon className="h-[16px] w-[16px] text-[#0f5f3f] shrink-0 mt-[1px]" />
        : <CircleOutline className="h-[16px] w-[16px] text-stone-400 shrink-0 mt-[1px]" />}
      <span className={done ? "text-stone-700" : "text-stone-800"}>{children}</span>
    </li>
  );
}

/* ============================================================
   REGION 7 — PAY PERIOD INFORMATION + FOOTER
   ============================================================ */

function PayPeriodInfoCard() {
  return (
    <section className="rounded-lg border border-stone-200 bg-white overflow-hidden">
      <div className="px-5 pt-2.5 pb-1 flex items-center gap-2">
        <CalendarIcon className="h-4 w-4 text-stone-500" />
        <h2 className="font-semibold text-[15px] text-stone-900">Pay Period Information</h2>
      </div>
      <dl className="px-5 py-1 grid grid-cols-[auto_1fr] gap-x-6 gap-y-0.5 text-[12.5px]">
        <dt className="text-stone-500">Pay Period</dt>
        <dd className="text-stone-800 text-right tabular-nums">Sep 7, 2026 – Sep 13, 2026</dd>
        <dt className="text-stone-500">Pay Date</dt>
        <dd className="text-stone-800 text-right tabular-nums">Fri, Sep 18, 2026</dd>
        <dt className="text-stone-500">Frequency</dt>
        <dd className="text-stone-800 text-right">Weekly</dd>
        <dt className="text-stone-500">Employees in Period</dt>
        <dd className="text-stone-800 text-right tabular-nums">48</dd>
      </dl>
      <div className="px-5 pb-2 pt-0">
        <a href="#" className="text-[12.5px] text-[#1e40af] inline-flex items-center gap-1">
          View pay period calendar <ArrowRight className="h-3 w-3" />
        </a>
      </div>
    </section>
  );
}

function AdminFooter() {
  return (
    <footer className="mt-2 mb-1.5 px-8 flex items-center justify-between text-[11.5px] text-stone-500">
      <p>© 2026 Spectre Automation. All rights reserved.</p>
      <div className="inline-flex items-center gap-5">
        <a href="#" className="hover:text-stone-700">Privacy</a>
        <a href="#" className="hover:text-stone-700">Terms</a>
        <a href="#" className="hover:text-stone-700">Support</a>
      </div>
    </footer>
  );
}

/* ============================================================
   COMPOSITION — assemble the 7 regions into the reference layout.
   ============================================================ */

export default function StaticPayrollAdmin() {
  return (
    <AdminShell>
      {/* Region 2 — header + workflow */}
      <PayrollHeader />
      {/* Region 3 — KPI strip */}
      <KpiStrip />
      {/* Regions 4 + 5/6/7 — main workspace (left) + right rail */}
      <div className="px-8 mt-1 grid grid-cols-[minmax(0,1fr)_320px] gap-3">
        <Workspace />
        <div className="space-y-2">
          <PayrollActionsCard />
          <ChecklistCard />
          <PayPeriodInfoCard />
        </div>
      </div>
      {/* Footer */}
      <AdminFooter />
    </AdminShell>
  );
}

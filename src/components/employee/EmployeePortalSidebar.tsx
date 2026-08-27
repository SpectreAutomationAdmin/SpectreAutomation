"use client";

// HR mobile-hotfix continuation (2026-08-28) — desktop portal
// sidebar rebuilt to the accepted desktop reference.
//
// Dark forest-green rail from top of viewport to bottom, extending
// the same visual language established on mobile. Full navigation
// (Home / Schedule / Pay / Time Off · Forms / Safety & Training /
// Clock In / Out · More) with icon + label per row. Active row uses
// a lighter translucent overlay + brass accent. Bottom carries a
// compact "Need Help?" support panel.
//
// Preserves the tour anchor data-attributes so the coach-mark
// system keeps working for desktop-anchored tour steps.

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

interface NavItem {
  key: string;
  label: string;
  href: string | null;      // null → non-navigational (aria-disabled)
  icon: ReactNode;
  tourTarget?: string;
  matchExact?: boolean;
}

// Sidebar icons — scaled to 22 px per the accepted desktop reference
// fidelity pass (2026-08-26). Preserve the same glyphs; only the
// bounding size + stroke weight change.
function IconHome() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />
    </svg>
  );
}
function IconSchedule() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <line x1="3.5" y1="10" x2="20.5" y2="10" />
      <line x1="8" y1="3" x2="8" y2="7" />
      <line x1="16" y1="3" x2="16" y2="7" />
    </svg>
  );
}
function IconPay() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}
function IconTimeOff() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <polyline points="12 7.5 12 12 16 14" />
    </svg>
  );
}
function IconForms() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 3h6a1 1 0 0 1 1 1v2H8V4a1 1 0 0 1 1-1z" />
      <line x1="8.5" y1="11" x2="15.5" y2="11" />
      <line x1="8.5" y1="15" x2="15.5" y2="15" />
    </svg>
  );
}
function IconTraining() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 9.5 12 5l9.5 4.5L12 14 2.5 9.5z" />
      <path d="M6.5 11.5v4c0 1 2.5 2.5 5.5 2.5s5.5-1.5 5.5-2.5v-4" />
      <line x1="21.5" y1="9.5" x2="21.5" y2="14" />
    </svg>
  );
}
function IconClockInOut() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5h12l3 2.5L16 10H4z" />
      <path d="M4 14h14l3 2.5L18 19H4z" />
      <line x1="8" y1="10" x2="8" y2="14" />
    </svg>
  );
}
function IconMore() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="19" cy="12" r="1.3" />
    </svg>
  );
}
function IconHeadset() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 13v-1a8 8 0 0 1 16 0v1" />
      <rect x="3" y="13" width="4" height="7" rx="1" />
      <rect x="17" y="13" width="4" height="7" rx="1" />
      <path d="M20 20a3 3 0 0 1-3 3h-2" />
    </svg>
  );
}

const NAV_GROUPS: Array<{ items: NavItem[] }> = [
  {
    items: [
      { key: "home", label: "Home", href: "/employee", icon: <IconHome />, tourTarget: "home", matchExact: true },
      { key: "schedule", label: "Schedule", href: "/employee/schedule", icon: <IconSchedule />, tourTarget: "scheduling" },
      { key: "pay", label: "Pay", href: "/employee/pay", icon: <IconPay />, tourTarget: "paystubs" },
      { key: "time-off", label: "Time Off", href: null, icon: <IconTimeOff />, tourTarget: "time-off" },
    ],
  },
  {
    items: [
      // Uniform-terminology pass (2026-08-26) — user-facing label
      // renamed Forms → Documents to match the widget grid. The
      // `key`/testid remains stable for existing selectors.
      { key: "forms", label: "Documents", href: null, icon: <IconForms />, tourTarget: "documents" },
      { key: "training", label: "Safety & Training", href: "/employee/safety-training", icon: <IconTraining />, tourTarget: "training" },
      { key: "clock", label: "Clock In / Out", href: null, icon: <IconClockInOut />, tourTarget: "clocking-in-out" },
    ],
  },
  {
    items: [
      { key: "more", label: "More", href: "/employee/profile", icon: <IconMore /> },
    ],
  },
];

export default function EmployeePortalSidebar() {
  const pathname = usePathname();

  return (
    // Fidelity pass (2026-08-26) — sidebar is a full-viewport-height
    // sticky rail; it uses its own overflow-y so the Help panel is
    // always pinned to the bottom and NEVER clipped by the browser
    // edge, even at 720-px-tall viewports.
    <aside
      className="hidden md:flex md:flex-col w-64 shrink-0 bg-club-green-800 text-white sticky top-0 self-start"
      style={{ height: "100vh" }}
      data-testid="portal-sidebar"
    >
      {/* Density rebalance — sidebar header band matches the h-20
         top header. Branding sizes preserved so it still reads as
         premium brand chrome. */}
      <div className="h-20 px-5 flex items-center border-b border-white/10 shrink-0">
        <div className="flex flex-col leading-tight" data-testid="portal-sidebar-wordmark">
          <span className="font-serif text-[26px] font-semibold tracking-[0.16em] text-white">SPECTRE</span>
          <span className="font-sans text-[12px] tracking-[0.36em] text-white/75 mt-0.5">AUTOMATION</span>
        </div>
      </div>
      <nav className="flex-1 min-h-0 px-3 py-4 space-y-3 overflow-y-auto" data-testid="portal-nav" aria-label="Employee Portal navigation">
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className="space-y-0.5">
            {group.items.map((item) => {
              const active = item.href
                ? (item.matchExact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/"))
                : false;
              // Active state per accepted reference: substantial rounded
              // rectangle with translucent green overlay + subtle brass
              // ring. Non-active rows carry only the hover treatment.
              const cls = active
                ? "bg-white/[0.14] text-white font-medium ring-1 ring-club-gold/25"
                : "text-white/85 hover:bg-white/[0.06] hover:text-white";
              const inner = (
                <span className="flex items-center gap-3.5 px-3.5 py-2.5 rounded-lg text-[14.5px]">
                  <span className={active ? "text-white" : "text-white/80"} aria-hidden="true">{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                </span>
              );
              if (item.href) {
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    className={`block ${cls}`}
                    data-testid={`portal-nav-${item.key}`}
                    data-tour-target={item.tourTarget}
                    aria-current={active ? "page" : undefined}
                  >
                    {inner}
                  </Link>
                );
              }
              return (
                <div
                  key={item.key}
                  className={`block ${cls} cursor-default opacity-70`}
                  data-testid={`portal-nav-${item.key}`}
                  data-tour-target={item.tourTarget}
                  role="link"
                  aria-disabled="true"
                >
                  {inner}
                </div>
              );
            })}
            {gi < NAV_GROUPS.length - 1 && <div aria-hidden="true" className="h-px bg-white/10 mx-3 mt-2.5" />}
          </div>
        ))}
      </nav>
      {/* Help / Support panel — pinned to the bottom of the sidebar
         via `shrink-0` + `flex-1` on the nav above, so the panel is
         ALWAYS visible above the browser edge at every viewport
         height. Compacted for the one-screen-fit target. */}
      <div className="p-3 shrink-0">
        <div
          className="rounded-xl bg-white/[0.10] border border-white/[0.14] px-3.5 py-3 flex items-center gap-3"
          data-testid="portal-sidebar-help"
        >
          <div className="text-white/95 shrink-0" aria-hidden="true"><IconHeadset /></div>
          <div className="min-w-0">
            <div className="font-serif text-[14px] leading-tight text-white">Need Help?</div>
            <div className="text-[11.5px] text-white/75 truncate mt-0.5">Contact HR Support</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

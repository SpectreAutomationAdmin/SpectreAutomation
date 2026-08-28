"use client";

// HR-2C Employee Portal desktop sidebar (2026-08-27 refinement).
//
// This pass consolidates several founder-mandated changes:
//   • Icon set comes from the shared canonical module
//     (`portal-icons.tsx`) so sidebar and widget-grid glyphs cannot
//     drift again — same source, one edit.
//   • SPECTRE / AUTOMATION wordmark is horizontally centred within
//     its allotted branding column (was `px-5` left-aligned).
//   • The bottom "Need Help? / Contact HR Support" card is
//     replaced by an anonymous-feedback entry point that opens the
//     new `/employee/feedback` submission surface.
//
// Preserves: sidebar width, sticky positioning, height, nav
// grouping (Home/Schedule/Pay/Time Off · Documents/Safety &
// Training/Clock · More), active state chrome, tour anchors.

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { IconHome, IconProfile, IconFeedback } from "./portal-icons";

interface NavItem {
  key: string;
  label: string;
  href: string | null;
  icon: ReactNode;
  tourTarget?: string;
  matchExact?: boolean;
}

// HR-2C sidebar simplification (2026-08-27). The dashboard widgets
// on Home are the primary operational navigation; the sidebar no
// longer duplicates every destination. Desktop sidebar contains
// only Home + Profile plus the anonymous-feedback card at the
// bottom. Mobile still uses its own drawer / More affordance and
// is unaffected by this simplification.
const NAV_GROUPS: Array<{ items: NavItem[] }> = [
  {
    items: [
      { key: "home", label: "Home", href: "/employee", icon: <IconHome />, tourTarget: "home", matchExact: true },
      { key: "profile", label: "Profile", href: "/employee/profile", icon: <IconProfile /> },
    ],
  },
];

export default function EmployeePortalSidebar() {
  const pathname = usePathname();

  return (
    <aside
      className="hidden md:flex md:flex-col w-64 shrink-0 bg-club-green-800 text-white sticky top-0 self-start"
      style={{ height: "100vh" }}
      data-testid="portal-sidebar"
    >
      {/* Branding band — matches the h-20 top header height. The
         wordmark is horizontally centred inside this column so the
         letters sit visually balanced against the tenant identity
         across the gold separator. */}
      <div className="h-20 flex items-center justify-center border-b border-white/10 shrink-0">
        <div className="flex flex-col leading-tight items-center text-center" data-testid="portal-sidebar-wordmark">
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
      {/* Anonymous Feedback entry — replaces the prior Need Help /
         Contact HR Support card. Links to `/employee/feedback`
         where the employee can submit anonymous feedback to the
         Club. The record persists `clubId` (derived server-side)
         but never any employee identity. */}
      <div className="p-3 shrink-0">
        {/* Copy refinement (2026-08-27) — heading changed to
           "Say what's on your mind" per founder direction. Slight
           font-size drop to 13.5 px so the longer heading fits the
           same card footprint without wrapping to two lines on
           the fixed 256 px sidebar; subtitle stays at 11.5 px.
           Card height unchanged. */}
        <Link
          href="/employee/feedback"
          className="rounded-xl bg-white/[0.10] border border-white/[0.14] px-3.5 py-3 flex items-center gap-3 hover:bg-white/[0.14] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-gold"
          data-testid="portal-sidebar-feedback"
          aria-label="Share anonymous feedback with the Club"
        >
          <div className="text-white/95 shrink-0" aria-hidden="true"><IconFeedback /></div>
          <div className="min-w-0">
            <div className="font-serif text-[13.5px] leading-tight text-white truncate">Say what&rsquo;s on your mind</div>
            <div className="text-[11.5px] text-white/75 truncate mt-0.5">Send anonymous feedback</div>
          </div>
        </Link>
      </div>
    </aside>
  );
}

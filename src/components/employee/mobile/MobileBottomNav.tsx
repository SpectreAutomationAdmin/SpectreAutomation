"use client";

// HR mobile-hotfix (2026-08-27) — Accepted mobile reference bottom
// navigation. 5 tabs: Home / Schedule / Pay / Time Off / More.
// Active tab uses deep green with a short underline. Inactive tabs
// use restrained grey. iOS safe-area respected via
// `env(safe-area-inset-bottom)`.
//
// Route destinations map to the same routes the widget grid uses.
// "More" opens the existing mobile drawer (custom event listened to
// by EmployeePortalMobileNav) rather than duplicating navigation.

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Tab {
  key: string;
  label: string;
  href: string | null;
  icon: () => JSX.Element;
  matchExact?: boolean;
}

const TABS: Tab[] = [
  {
    key: "home", label: "Home", href: "/employee", matchExact: true,
    icon: () => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 11l9-7 9 7" />
        <path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />
      </svg>
    ),
  },
  {
    key: "schedule", label: "Schedule", href: "/employee/schedule",
    icon: () => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3.5" y="5" width="17" height="15" rx="2" />
        <line x1="3.5" y1="10" x2="20.5" y2="10" />
        <line x1="8" y1="3" x2="8" y2="7" />
        <line x1="16" y1="3" x2="16" y2="7" />
      </svg>
    ),
  },
  {
    key: "pay", label: "Pay", href: "/employee/pay",
    icon: () => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
  },
  {
    key: "time-off", label: "Time Off", href: null,
    icon: () => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" />
        <polyline points="12 7.5 12 12 16 14" />
      </svg>
    ),
  },
  {
    key: "more", label: "More", href: null,
    icon: () => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="5" cy="12" r="1.2" />
        <circle cx="12" cy="12" r="1.2" />
        <circle cx="19" cy="12" r="1.2" />
      </svg>
    ),
  },
];

export default function MobileBottomNav() {
  const pathname = usePathname();

  function isActive(tab: Tab): boolean {
    if (!tab.href) return false;
    if (tab.matchExact) return pathname === tab.href;
    return pathname === tab.href || pathname.startsWith(tab.href + "/");
  }

  function openDrawer() {
    if (typeof document === "undefined") return;
    document.dispatchEvent(new CustomEvent("spectre:portal:mobile-nav:open"));
  }

  return (
    <nav
      className="md:hidden fixed inset-x-0 bottom-0 z-40 bg-white border-t border-stone-200"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      data-testid="portal-mobile-bottom-nav"
      aria-label="Employee Portal navigation"
    >
      <ul className="grid grid-cols-5">
        {TABS.map((tab) => {
          const active = isActive(tab);
          const cls = active ? "text-club-green-800" : "text-stone-500";
          const inner = (
            <div className="flex flex-col items-center gap-0.5 py-2">
              <tab.icon />
              <span className="text-[10.5px] font-medium">{tab.label}</span>
              <span
                aria-hidden="true"
                className={`h-0.5 w-6 rounded-full mt-0.5 ${active ? "bg-club-green-700" : "bg-transparent"}`}
              />
            </div>
          );
          if (tab.href) {
            return (
              <li key={tab.key}>
                <Link
                  href={tab.href}
                  className={`block ${cls} hover:text-club-green-700`}
                  data-testid={`portal-mobile-bottom-${tab.key}`}
                  aria-current={active ? "page" : undefined}
                >
                  {inner}
                </Link>
              </li>
            );
          }
          // "More" opens the drawer; "Time Off" has no destination so
          // renders as a disabled tab (aria-disabled) to keep parity
          // with the widget grid's honesty rule.
          if (tab.key === "more") {
            return (
              <li key={tab.key}>
                <button
                  type="button"
                  onClick={openDrawer}
                  className={`block w-full ${cls} hover:text-club-green-700`}
                  data-testid={`portal-mobile-bottom-${tab.key}`}
                  aria-label="More"
                >
                  {inner}
                </button>
              </li>
            );
          }
          return (
            <li key={tab.key}>
              <div
                className={`block ${cls}`}
                data-testid={`portal-mobile-bottom-${tab.key}`}
                role="link"
                aria-disabled="true"
              >
                {inner}
              </div>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// Scheduling Foundation · Phase E (2026-09-07) — client tab strip
// for the FORE! page. Pushes ?tab=<value> so the server component
// re-renders the appropriate content.
//
// Announcements existing behaviour preserved (default tab); Shift
// Opportunities is the new employee-facing tab added in Phase E.

"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

export default function ForeTabs({
  shiftOpportunityCount,
}: {
  shiftOpportunityCount: number;
}) {
  const params = useSearchParams();
  const active = params.get("tab") === "shifts" ? "shifts" : "announcements";
  return (
    <nav
      className="mt-4 mb-6 flex items-center gap-6 border-b border-stone-200"
      aria-label="FORE! sections"
      data-testid="fore-tabs"
    >
      <Link
        href="/employee/announcements"
        aria-current={active === "announcements" ? "page" : undefined}
        data-testid="fore-tab-announcements"
        className={
          "-mb-px pb-3 text-sm " +
          (active === "announcements"
            ? "border-b-2 border-club-green-800 text-club-ink font-medium"
            : "text-stone-500 hover:text-stone-800")
        }
      >
        Announcements
      </Link>
      <Link
        href="/employee/announcements?tab=shifts"
        aria-current={active === "shifts" ? "page" : undefined}
        data-testid="fore-tab-shifts"
        className={
          "-mb-px pb-3 text-sm flex items-center gap-1.5 " +
          (active === "shifts"
            ? "border-b-2 border-club-green-800 text-club-ink font-medium"
            : "text-stone-500 hover:text-stone-800")
        }
      >
        Shift Opportunities
        {shiftOpportunityCount > 0 && (
          <span
            data-testid="fore-tab-shifts-count"
            className={
              "inline-block min-w-5 rounded-full px-1.5 py-0.5 text-[10px] leading-none text-center " +
              (active === "shifts"
                ? "bg-club-green-800 text-white"
                : "bg-club-green-50 text-club-green-800 border border-club-green-200")
            }
          >
            {shiftOpportunityCount}
          </span>
        )}
      </Link>
    </nav>
  );
}

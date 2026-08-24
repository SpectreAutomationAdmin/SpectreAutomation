"use client";

// HR-2B.5 §32 · HR-2C Shell Refinement (2026-08-24).
//
// The persistent left rail is now Home + Profile only. Club identity
// lives in the top header, not here — the upper-left identity block
// carries only the "EMPLOYEE PORTAL" eyebrow so the shell reads as a
// pared-down member of the Spectre workspace family.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/ui";
import { EMPLOYEE_NAV } from "@/components/sidebar-nav-data";

export default function EmployeePortalSidebar() {
  const pathname = usePathname();

  return (
    <aside
      className="hidden md:block w-60 shrink-0 border-r border-stone-200 bg-white min-h-screen"
      data-testid="portal-sidebar"
    >
      <div className="px-6 py-6 border-b border-stone-200">
        <div
          className="text-[11px] uppercase tracking-[0.2em] text-stone-500"
          data-testid="portal-sidebar-eyebrow"
        >
          Employee Portal
        </div>
      </div>
      <nav className="px-3 py-4 space-y-0.5" data-testid="portal-nav">
        {EMPLOYEE_NAV.map((item) => {
          // Home is `/employee` — exact match only, else it matches every child.
          const active = item.href === "/employee"
            ? pathname === "/employee"
            : pathname === item.href || pathname.startsWith(item.href + "/");
          const testid = `portal-nav-${item.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "block rounded-md px-3 py-2 text-sm",
                active
                  ? "bg-club-green-50 text-club-green-800 font-medium"
                  : "text-stone-600 hover:bg-stone-50 hover:text-club-ink",
              )}
              data-testid={testid}
              data-tour-target={item.tourTarget}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

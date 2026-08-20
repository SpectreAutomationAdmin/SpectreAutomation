"use client";

// HR-2B.5 §32 — Employee Portal sidebar.
//
// Distinct from the admin Sidebar (`components/Sidebar.tsx`) — no
// admin sections, no Mission Control, no Finance, no configuration.
// Consumes EMPLOYEE_NAV from the shared nav data so nav additions
// stay in one place.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/ui";
import { EMPLOYEE_NAV } from "@/components/sidebar-nav-data";

export default function EmployeePortalSidebar({ clubName }: { clubName: string }) {
  const pathname = usePathname();

  return (
    <aside className="w-60 shrink-0 border-r border-stone-200 bg-white min-h-screen">
      <div className="px-6 py-6 border-b border-stone-200">
        <div className="font-serif text-lg leading-tight text-club-ink" data-testid="portal-club-name">
          {clubName}
        </div>
        <div className="mt-2 text-[11px] uppercase tracking-[0.2em] text-stone-500">
          Employee Portal
        </div>
      </div>
      <nav className="px-3 py-4 space-y-0.5" data-testid="portal-nav">
        {EMPLOYEE_NAV.map((item) => {
          // Home is `/employee` — exact match only, else it matches every child.
          const active = item.href === "/employee"
            ? pathname === "/employee"
            : pathname === item.href || pathname.startsWith(item.href + "/");
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
              data-testid={`portal-nav-${item.label.toLowerCase()}`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

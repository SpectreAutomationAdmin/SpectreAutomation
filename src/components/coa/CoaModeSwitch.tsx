"use client";

// COA-MAP-2A (2026-10-06) — module-level workspace switch for
// Chart of Accounts.  Renders two tab-style links:
//
//   Account List              → /app/admin/coa
//   Financial Statement Mapping → /app/admin/coa-mapping
//
// The switch is identical on both pages so the user always sees
// where they are and where they can go.  No shared state — plain
// <Link> hrefs; the pages reload with their own data.
//
// Styling uses the Spectre neutral palette: active tab is a
// stone-900 pill; inactive tab is stone-600 text on hover-stone-100.

import Link from "next/link";

export type CoaMode = "list" | "mapping";

export function CoaModeSwitch({
  active,
  listHref = "/app/admin/coa",
  mappingHref = "/app/admin/coa-mapping",
}: {
  active: CoaMode;
  listHref?: string;
  mappingHref?: string;
}) {
  const tabs: Array<{ mode: CoaMode; label: string; href: string; testid: string }> = [
    { mode: "list",    label: "Account List",                 href: listHref,    testid: "coa-mode-list" },
    { mode: "mapping", label: "Financial Statement Mapping",  href: mappingHref, testid: "coa-mode-mapping" },
  ];
  return (
    <nav
      aria-label="Chart of Accounts workspace"
      className="inline-flex items-center gap-1 rounded border border-stone-200 bg-white p-0.5"
      data-testid="coa-mode-switch"
    >
      {tabs.map((t) => {
        const isActive = t.mode === active;
        return (
          <Link
            key={t.mode}
            href={t.href}
            data-testid={t.testid}
            aria-current={isActive ? "page" : undefined}
            className={
              "rounded px-3 py-1 text-xs font-semibold transition-colors " +
              (isActive
                ? "bg-stone-900 text-white"
                : "text-stone-600 hover:bg-stone-100")
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

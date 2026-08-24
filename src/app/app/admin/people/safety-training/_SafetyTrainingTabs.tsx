// HR-2C B5 (2026-08-28) — Safety & Training sub-navigation.
//
// Restrained horizontal tab pair (Courses / Compliance) — matches the
// existing admin sub-nav grammar. Client component only for the
// active-state highlight; both tabs are ordinary Next Links so
// permissions + server data fetch happen normally on the destination
// page.

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Props {
  canReadCompliance: boolean;
}

const TABS = [
  { key: "courses",    label: "Courses",    href: "/app/admin/people/safety-training" },
  { key: "compliance", label: "Compliance", href: "/app/admin/people/safety-training/compliance" },
] as const;

export default function SafetyTrainingTabs({ canReadCompliance }: Props) {
  const pathname = usePathname();
  return (
    <nav
      className="border-b border-stone-200 mb-6 flex items-center gap-6"
      role="tablist"
      aria-label="Safety and Training sections"
      data-testid="training-subnav"
    >
      {TABS.map((t) => {
        if (t.key === "compliance" && !canReadCompliance) return null;
        const active = t.key === "courses"
          ? pathname === "/app/admin/people/safety-training"
          : pathname.startsWith(t.href);
        return (
          <Link
            key={t.key}
            href={t.href}
            role="tab"
            aria-selected={active}
            data-testid={`training-subnav-${t.key}`}
            className={
              "-mb-px pb-2 pt-1 text-sm border-b-2 " +
              (active
                ? "border-club-green-700 text-club-ink font-medium"
                : "border-transparent text-stone-500 hover:text-club-ink hover:border-stone-300")
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

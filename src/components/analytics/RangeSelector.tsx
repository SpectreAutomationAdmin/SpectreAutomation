"use client";

// Date-range preset selector. Pure server-driven via query params so
// the dashboard stays cacheable; we just navigate to the same URL with
// `?range=` and let the server compute against the new window.
//
// Presets cover the comparisons the spec calls out: today, yesterday,
// week, last-week, month, last-month, year, last-year. A "Custom"
// option could land later; for the MVP we ship presets only.

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export type RangePreset =
  | "TODAY"
  | "YESTERDAY"
  | "THIS_WEEK"
  | "LAST_WEEK"
  | "THIS_MONTH"
  | "LAST_MONTH"
  | "THIS_YEAR"
  | "LAST_YEAR"
  | "LAST_60_DAYS";

const ORDER: { key: RangePreset; label: string }[] = [
  { key: "TODAY", label: "Today" },
  { key: "YESTERDAY", label: "Yesterday" },
  { key: "THIS_WEEK", label: "This week" },
  { key: "LAST_WEEK", label: "Last week" },
  { key: "THIS_MONTH", label: "This month" },
  { key: "LAST_MONTH", label: "Last month" },
  { key: "LAST_60_DAYS", label: "Last 60 days" },
];

export function RangeSelector({ defaultPreset = "THIS_WEEK" }: { defaultPreset?: RangePreset }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const active = (params.get("range") as RangePreset) || defaultPreset;
  return (
    <div className="inline-flex items-center rounded-md border border-stone-200 overflow-hidden bg-white text-xs">
      {ORDER.map((p) => {
        const isActive = p.key === active;
        const next = new URLSearchParams(params);
        next.set("range", p.key);
        return (
          <Link
            key={p.key}
            href={`${pathname}?${next.toString()}`}
            className={`px-3 py-1.5 border-r border-stone-200 last:border-r-0 ${
              isActive
                ? "bg-club-green-700 text-white font-medium"
                : "text-stone-600 hover:bg-stone-50"
            }`}
          >
            {p.label}
          </Link>
        );
      })}
    </div>
  );
}

"use client";

import { useState } from "react";
import { cn } from "@/lib/ui";

export type Tab = { id: string; label: string; content: React.ReactNode };

export function Tabs({ tabs, defaultTab }: { tabs: Tab[]; defaultTab?: string }) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.id);
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  return (
    <div>
      <div className="border-b border-stone-200 flex gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={cn(
              "px-4 py-2 text-sm -mb-px border-b-2",
              t.id === current.id
                ? "border-club-green-700 text-club-green-800 font-medium"
                : "border-transparent text-stone-500 hover:text-club-ink"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-6">{current?.content}</div>
    </div>
  );
}

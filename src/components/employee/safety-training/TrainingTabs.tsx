"use client";

// EP-UX-2 (2026-11-01) — tab primitive for the Safety & Training
// surfaces.  Uses the understated-underline pattern the founder
// reference images show on both the dashboard ("My Training |
// Training History") and the course page ("About This Course |
// Course Content | Your Result").
//
// The component is deliberately presentation-only — it does not
// own navigation; parents pass children keyed by tab id.  State
// lives here (useState) because tabs do not need to deep-link
// in the current slice.
//
// Visual contract:
//   - Dark-green active underline (`border-club-green-800`), 2 px
//   - Muted inactive labels (`text-stone-500`) with hover transition
//     to `text-club-ink`
//   - 48 px tab padding, 14 px type, medium weight
//   - Full-width hairline underline below the tab row

import { useId, useState, type ReactNode } from "react";

export interface TrainingTab {
  id: string;
  label: string;
  content: ReactNode;
}

interface Props {
  tabs: TrainingTab[];
  /** Optional default-selected tab id.  Defaults to the first tab. */
  defaultTabId?: string;
  /** data-testid root (per-tab buttons get `${testIdPrefix}-tab-${id}`,
   *  panels get `${testIdPrefix}-panel-${id}`). */
  testIdPrefix?: string;
}

export default function TrainingTabs({ tabs, defaultTabId, testIdPrefix = "training-tabs" }: Props) {
  const groupId = useId();
  const initial = defaultTabId && tabs.some((t) => t.id === defaultTabId) ? defaultTabId : tabs[0]?.id;
  const [activeId, setActiveId] = useState<string | undefined>(initial);
  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  return (
    <div data-testid={testIdPrefix}>
      <div
        role="tablist"
        aria-label="Training tabs"
        className="flex items-end gap-8 border-b border-stone-200"
      >
        {tabs.map((t) => {
          const isActive = t.id === activeTab?.id;
          const btnId = `${groupId}-${t.id}-tab`;
          const panelId = `${groupId}-${t.id}-panel`;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={btnId}
              aria-selected={isActive}
              aria-controls={panelId}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveId(t.id)}
              data-testid={`${testIdPrefix}-tab-${t.id}`}
              className={
                "pb-3 text-sm font-medium transition-colors border-b-2 -mb-px " +
                (isActive
                  ? "text-club-ink border-club-green-800"
                  : "text-stone-500 border-transparent hover:text-club-ink")
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {activeTab && (
        <div
          role="tabpanel"
          id={`${groupId}-${activeTab.id}-panel`}
          aria-labelledby={`${groupId}-${activeTab.id}-tab`}
          data-testid={`${testIdPrefix}-panel-${activeTab.id}`}
          className="pt-6"
        >
          {activeTab.content}
        </div>
      )}
    </div>
  );
}

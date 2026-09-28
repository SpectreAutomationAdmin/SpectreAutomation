// WI-2A — review tabs. Editorial underlined tabs with a hairline rule
// continuing across the remainder of the workspace.

import { REVIEW_TABS } from "./review-scaffold-data";

export default function WorkItemReviewTabs({ active = "overview" }: { active?: string }) {
  return (
    <nav className="wi-review-tabs" role="tablist" aria-label="Review sections">
      {REVIEW_TABS.map((t) => {
        const isActive = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`wi-review-tab${isActive ? " wi-review-tab--active" : ""}`}
            data-testid={`wi-review-tab-${t.key}`}
          >
            <span>{t.label}</span>
            {typeof t.badge === "number" && <span className="wi-review-tab-count">({t.badge})</span>}
          </button>
        );
      })}
    </nav>
  );
}

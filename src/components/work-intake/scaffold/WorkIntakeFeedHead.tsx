// WI-1 — feed head (§13). Static tab row + Filter + Search.
// §13 explicitly permits static / presentational-only here.

type Tab = "my-feed" | "ai" | "starred" | "archived";

const TABS: { id: Tab; label: string }[] = [
  { id: "my-feed", label: "My Feed" },
  { id: "ai", label: "AI Insights" },
  { id: "starred", label: "Starred" },
  { id: "archived", label: "Archived" },
];

export default function WorkIntakeFeedHead({ activeTab }: { activeTab: Tab }) {
  return (
    <div className="wi-feed-head">
      <div className="wi-feed-tabs" role="tablist" aria-label="Work intake feed">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === activeTab}
            className={`wi-feed-tab${t.id === activeTab ? " on" : ""}`}
            // Static scaffold — no navigation.
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="wi-feed-controls">
        <button type="button" className="wi-feed-filter" aria-label="Filter">
          Filter
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="wi-feed-search">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
            <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            placeholder="Search work intake..."
            aria-label="Search work intake"
            disabled
          />
        </div>
      </div>
    </div>
  );
}

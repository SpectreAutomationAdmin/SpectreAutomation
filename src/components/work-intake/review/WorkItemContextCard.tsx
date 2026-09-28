// WI-2A — Context card. Editorial metadata layout with a green check
// icon per row, a category label at left, primary + secondary text,
// and an optional action link at the far right.

import { CONTEXT_ROWS } from "./review-scaffold-data";

function CheckDot() {
  return (
    <span className="wi-review-check-dot" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="7" fill="#dff0dd" />
        <path d="M4.5 8.3l2.2 2.2L11.5 5.7" stroke="#1f6f3f" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function ArrowRight() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 6h6M7 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function WorkItemContextCard() {
  return (
    <section className="wi-review-card wi-review-card--context" aria-label="Context">
      <div className="wi-review-card-head">
        <h2 className="wi-review-card-title">Context</h2>
      </div>
      <div className="wi-review-context-list">
        {CONTEXT_ROWS.map((row) => (
          <div key={row.category} className="wi-review-context-row">
            <div className="wi-review-context-cat">{row.category}</div>
            <div className="wi-review-context-body">
              <CheckDot />
              <div className="wi-review-context-lines">
                <div className="wi-review-context-title">{row.title}</div>
                <div className="wi-review-context-meta">{row.meta}</div>
              </div>
            </div>
            <div className="wi-review-context-action">
              {row.action && (
                <a href={row.action.href} className="wi-review-linklike">
                  {row.action.label} <ArrowRight />
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

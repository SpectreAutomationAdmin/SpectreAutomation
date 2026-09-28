// WI-2A — right-side Spectre intelligence rail. Persistent contextual
// surface (not a floating modal, not a chat bubble). Contains the
// Spectre header, a lead explanation, Key Insights, Recommendations,
// two outlined action buttons, and the ask box.

import {
  KEY_INSIGHTS,
  RECOMMENDATIONS,
  SPECTRE_ASK_PLACEHOLDER,
  SPECTRE_LEAD_MESSAGE,
} from "./review-scaffold-data";

function Sparkle() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M10 2.5l1.3 3.7 3.7 1.3-3.7 1.3L10 12.5l-1.3-3.7L5 7.5l3.7-1.3z"
        fill="var(--wi-review-spectre-gold, #c9a24a)"
      />
      <path d="M15.5 12.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" fill="var(--wi-review-spectre-gold, #c9a24a)" />
    </svg>
  );
}

function CloseX() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CheckCircle() {
  return (
    <span className="wi-review-insight-check" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r="8" fill="#dff0dd" />
        <path d="M5 9.3l2.5 2.5L13 6.5" stroke="#1f6f3f" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function RecIcon({ tone }: { tone: "blue" | "purple" | "gold" }) {
  return (
    <span className={`wi-review-rec-icon wi-review-rec-icon--${tone}`} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M4 3h6l1 3-4 5-4-5z" fill="currentColor" opacity="0.15" />
        <path d="M4 3h6l1 3-4 5-4-5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function SendArrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 7h8M8 4l3 3-3 3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function SpectreReviewRail() {
  return (
    <aside className="wi-review-rail" aria-label="Spectre intelligence">
      <header className="wi-review-rail-head">
        <div className="wi-review-rail-brand">
          <Sparkle />
          <div className="wi-review-rail-brand-text">
            <div className="wi-review-rail-brand-name">Spectre</div>
            <div className="wi-review-rail-brand-sub">Your autonomous finance teammate</div>
          </div>
        </div>
        <button type="button" className="wi-review-rail-close" aria-label="Close Spectre">
          <CloseX />
        </button>
      </header>
      <div className="wi-review-rail-lead">
        <p>{SPECTRE_LEAD_MESSAGE}</p>
      </div>
      <section className="wi-review-rail-section">
        <h3 className="wi-review-rail-section-title">Key Insights</h3>
        <ul className="wi-review-insights">
          {KEY_INSIGHTS.map((k, i) => (
            <li key={i} className="wi-review-insight">
              <CheckCircle />
              <span>{k.body}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="wi-review-rail-section">
        <h3 className="wi-review-rail-section-title">Recommendations</h3>
        <ul className="wi-review-recs">
          {RECOMMENDATIONS.map((r, i) => (
            <li key={i} className="wi-review-rec">
              <RecIcon tone={r.iconTone} />
              <span>{r.body}</span>
            </li>
          ))}
        </ul>
        <div className="wi-review-rail-actions">
          <button type="button" className="wi-review-rail-btn">Show similar invoices</button>
          <button type="button" className="wi-review-rail-btn">Explain why this is capital vs. expense</button>
        </div>
      </section>
      <div className="wi-review-ask">
        <textarea
          className="wi-review-ask-field"
          placeholder={SPECTRE_ASK_PLACEHOLDER}
          aria-label="Ask Spectre about this invoice"
          rows={3}
        />
        <button type="button" className="wi-review-ask-send" aria-label="Send">
          <SendArrow />
        </button>
      </div>
    </aside>
  );
}

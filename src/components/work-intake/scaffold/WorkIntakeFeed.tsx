// WI-1 — compact editorial feed rows (§14 / §15).
// Fresh presentational component. NO reuse of EmailIntakeCard /
// IntelligenceReviewCard / PayrollActionCard / FeedItem.

import Link from "next/link";
import type { WiFeedRow, WiIcon, WiStatusTone } from "./scaffold-data";

const ROW_ICONS: Record<WiIcon, React.ReactNode> = {
  invoice: (
    <svg width="18" height="18" viewBox="0 0 20 20">
      <rect x="4" y="2.5" width="12" height="15" rx="1.5" stroke="currentColor" fill="none" strokeWidth="1.4" />
      <path d="M7 6.5h6M7 10h6M7 13.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  payroll: (
    <svg width="18" height="18" viewBox="0 0 20 20">
      <circle cx="7" cy="8" r="2.5" stroke="currentColor" fill="none" strokeWidth="1.4" />
      <circle cx="14" cy="8" r="2.5" stroke="currentColor" fill="none" strokeWidth="1.4" />
      <path d="M2.5 16c0-2 2-3.5 4.5-3.5s4.5 1.5 4.5 3.5M11 15.5c.5-1.5 2-2.5 3.5-2.5s2.5.5 3 1.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </svg>
  ),
  member: (
    <svg width="18" height="18" viewBox="0 0 20 20">
      <circle cx="10" cy="7.5" r="3" stroke="currentColor" fill="none" strokeWidth="1.4" />
      <path d="M3.5 17c0-3 3-5.5 6.5-5.5s6.5 2.5 6.5 5.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </svg>
  ),
  ap: (
    <svg width="18" height="18" viewBox="0 0 20 20">
      <path d="M3.5 6.5h13v10h-13z" stroke="currentColor" fill="none" strokeWidth="1.4" />
      <path d="M3.5 6.5L10 3l6.5 3.5" stroke="currentColor" fill="none" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 16.5v-4h4v4" stroke="currentColor" fill="none" strokeWidth="1.4" />
    </svg>
  ),
  hire: (
    <svg width="18" height="18" viewBox="0 0 20 20">
      <circle cx="8" cy="7" r="2.5" stroke="currentColor" fill="none" strokeWidth="1.4" />
      <path d="M2.5 16.5c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path d="M15 3.5v5M12.5 6h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  chart: (
    <svg width="18" height="18" viewBox="0 0 20 20">
      <path d="M3 17V4M17 17H3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="5.5" y="10" width="2.5" height="5" stroke="currentColor" fill="none" strokeWidth="1.4" />
      <rect x="9.5" y="7" width="2.5" height="8" stroke="currentColor" fill="none" strokeWidth="1.4" />
      <rect x="13.5" y="5" width="2.5" height="10" stroke="currentColor" fill="none" strokeWidth="1.4" />
    </svg>
  ),
};

function StatusBadge({ label, tone }: { label: string; tone: WiStatusTone }) {
  return <span className={`wi-status wi-status--${tone}`}>{label}</span>;
}

function AttachmentGlyph({ kind, count }: { kind: "thumb" | "doc"; count?: number }) {
  if (kind === "thumb") {
    return (
      <div className="wi-attach wi-attach--thumb" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 22 22">
          <rect x="2" y="3.5" width="18" height="15" rx="2" fill="#c9c2ae" />
          <path d="M2 15l5-5 4 4 3-2 6 6" fill="#a89f83" />
        </svg>
      </div>
    );
  }
  return (
    <div className="wi-attach wi-attach--doc" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 20 20">
        <rect x="4" y="2.5" width="12" height="15" rx="1.5" stroke="currentColor" fill="none" strokeWidth="1.4" />
        <path d="M7 6.5h6M7 10h6M7 13.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
      {typeof count === "number" && count > 0 && <span className="wi-attach-count">+{count}</span>}
    </div>
  );
}

function ParticipantAvatars({ people }: { people: NonNullable<WiFeedRow["participants"]> }) {
  return (
    <div className="wi-participants" aria-hidden="true">
      {people.map((p, i) => (
        <span key={i} className={`wi-participant wi-participant--${p.tone ?? "neutral"}`}>
          {p.initials}
        </span>
      ))}
    </div>
  );
}

export default function WorkIntakeFeed({ rows }: { rows: WiFeedRow[] }) {
  if (rows.length === 0) {
    // WI-2B — real tenants may have no active Work Intake. Show an
    // understated single-line empty state inside the accepted feed
    // surface (no illustration, no CTA), preserving the card chrome.
    return (
      <section className="wi-feed" aria-label="Work intake feed">
        <div className="wi-feed-empty" data-testid="wi-feed-empty">
          Nothing needs your attention right now.
        </div>
      </section>
    );
  }
  return (
    <section className="wi-feed" aria-label="Work intake feed">
      {rows.map((row) => (
        <div key={row.id} className="wi-feed-row">
          <div className="wi-feed-row-icon" aria-hidden="true">
            {ROW_ICONS[row.icon]}
          </div>
          <div className="wi-feed-row-body">
            <h3 className="wi-feed-row-title">{row.title}</h3>
            <div className="wi-feed-row-meta">{row.metaLine}</div>
            <p className="wi-feed-row-desc">{row.description}</p>
          </div>
          <div className="wi-feed-row-status">
            <StatusBadge label={row.status.label} tone={row.status.tone} />
            <div className="wi-feed-row-time">{row.timestamp}</div>
          </div>
          <div className="wi-feed-row-attachments">
            {row.attachments?.map((a, i) => (
              <AttachmentGlyph key={i} kind={a.kind} count={a.count} />
            ))}
            {row.participants && <ParticipantAvatars people={row.participants} />}
          </div>
          <div className="wi-feed-row-action">
            {row.reviewHref ? (
              <Link
                href={row.reviewHref}
                className="wi-feed-row-button"
                data-testid={`wi-feed-review-link-${row.id}`}
              >
                {row.actionLabel}
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M3 6h6M7 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>
            ) : (
              <button type="button" className="wi-feed-row-button">
                {row.actionLabel}
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M3 6h6M7 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            <button type="button" className="wi-feed-row-overflow" aria-label="More">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <circle cx="3" cy="7" r="1.1" fill="currentColor" />
                <circle cx="7" cy="7" r="1.1" fill="currentColor" />
                <circle cx="11" cy="7" r="1.1" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

// WI-2A — work-item review header. Matches the reference:
//   [back link]
//   [doc icon]  INTAKE eyebrow                          [⋯] [Send back] [Approve & Start →]
//               Title (editorial serif)
//               Detected 2h ago · Invoice · Fairway Irrigation · $48,750.00

import Link from "next/link";
import type { ReviewMetaChip, ReviewWorkItem } from "./review-scaffold-data";

function BackArrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M8 3l-4 4 4 4M4 7h7" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
      <path d="M8 5h10l5 5v15H8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M18 5v5h5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11 15h8M11 18.5h8M11 22h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function OverflowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}

function ArrowRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 6h6M7 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Small outlined dot before the first meta chip — matches the reference's
 *  hollow amber circle preceding "Invoice". */
function MetaLeadDot() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="wi-review-meta-dot">
      <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

function MetaChip({ chip, showLead }: { chip: ReviewMetaChip; showLead: boolean }) {
  return (
    <span className={`wi-review-meta-chip wi-review-meta-chip--${chip.tone}`}>
      {showLead && <MetaLeadDot />}
      <span>{chip.label}</span>
    </span>
  );
}

export default function WorkItemReviewHeader({ item }: { item: ReviewWorkItem }) {
  return (
    <header className="wi-review-header">
      <Link href="/app/admin/work-intake" className="wi-review-back">
        <BackArrow />
        <span>Back to Work Intake</span>
      </Link>
      <div className="wi-review-header-row">
        <div className="wi-review-header-icon" aria-hidden="true">
          <DocIcon />
        </div>
        <div className="wi-review-header-body">
          <div className="wi-review-eyebrow">{item.status}</div>
          <h1 className="wi-review-title">{item.title}</h1>
          <div className="wi-review-meta">
            <span className="wi-review-meta-item">{item.detectedAt}</span>
            {item.meta.map((chip, i) => (
              <MetaChip key={i} chip={chip} showLead={i === 0} />
            ))}
          </div>
        </div>
        <div className="wi-review-header-actions">
          <button type="button" className="wi-review-icon-btn" aria-label="More">
            <OverflowIcon />
          </button>
          <button type="button" className="wi-review-btn wi-review-btn--ghost">Send back</button>
          <button type="button" className="wi-review-btn wi-review-btn--primary">
            Approve &amp; Start <ArrowRight />
          </button>
        </div>
      </div>
    </header>
  );
}

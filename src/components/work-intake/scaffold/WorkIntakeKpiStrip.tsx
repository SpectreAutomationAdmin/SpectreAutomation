// WI-1 — 4-card KPI strip (§12). Static scaffold values.

import type { WiKpi } from "./scaffold-data";

const ICON_PATHS: Record<WiKpi["icon"], React.ReactNode> = {
  calendar: (
    <>
      <rect x="3" y="4.5" width="14" height="12" rx="1.5" stroke="currentColor" fill="none" strokeWidth="1.4" />
      <path d="M3 8.5h14M7 3v3M13 3v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  clock: (
    <>
      <circle cx="10" cy="10" r="6.5" stroke="currentColor" fill="none" strokeWidth="1.4" />
      <path d="M10 6v4l2.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  people: (
    <>
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" fill="none" strokeWidth="1.4" />
      <circle cx="14" cy="8" r="2.5" stroke="currentColor" fill="none" strokeWidth="1.4" />
      <path
        d="M3.5 15c0-2 2-3.5 4.5-3.5s4.5 1.5 4.5 3.5M11.5 14.5c.5-1.5 2-2.5 3.5-2.5 1.5 0 2.5.5 3 1.5"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
    </>
  ),
  check: (
    <>
      <circle cx="10" cy="10" r="7" stroke="currentColor" fill="none" strokeWidth="1.4" />
      <path d="M6.5 10.5l2.2 2.2L13.5 8" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};

function TrendGlyph({ direction }: { direction: "up" | "down" | "flat" }) {
  if (direction === "flat") {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2 5h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (direction === "down") {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2 3l3 4 3-4M2 7h6" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 7l3-4 3 4M2 3h6" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** WI-1G — shared card-navigation chevron. Refined two-segment
 *  right-facing chevron per the accepted design reference:
 *    - 16 × 16 rendered
 *    - viewBox 0 0 24 24 · path M9 18 L15 12 L9 6
 *    - stroke 1.5, round caps + joins
 *    - currentColor (controlled by .wi-kpi-chevron cool-grey token). */
function KpiNavChevron() {
  return (
    <svg
      className="wi-kpi-chevron"
      width="16" height="16" viewBox="0 0 24 24"
      data-testid="wi-kpi-chevron"
      aria-hidden="true"
    >
      <path
        d="M9 18 L15 12 L9 6"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function WorkIntakeKpiStrip({ cards }: { cards: WiKpi[] }) {
  return (
    <section className="wi-kpi" aria-label="Work overview">
      {cards.map((c) => (
        <article key={c.label} className="wi-kpi-card" data-testid="wi-kpi-card">
          <div className="wi-kpi-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 20 20">{ICON_PATHS[c.icon]}</svg>
          </div>
          <div className="wi-kpi-value">{c.value}</div>
          <KpiNavChevron />
          <div className="wi-kpi-label">{c.label}</div>
          <div className={`wi-kpi-trend wi-kpi-trend--${c.trend.tone}`}>
            <TrendGlyph direction={c.trend.direction} />
            <span>{c.trend.delta}</span>
          </div>
        </article>
      ))}
    </section>
  );
}

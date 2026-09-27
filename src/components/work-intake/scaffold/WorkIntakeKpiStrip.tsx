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

/** WI-1H — shared card-navigation chevron. Corrected visible geometry
 *  per the accepted design reference. WI-1G's path lived inside a
 *  24-unit viewBox but only spanned 6 units horizontally, so the
 *  rendered chevron was only ~4 px wide — visually a tick, not a
 *  navigation affordance. WI-1H matches the SVG viewBox to the
 *  rendered pixel size so the path fills its viewport:
 *    - 16 × 16 rendered
 *    - viewBox 0 0 16 16 · path M5 2.5 L10.5 8 L5 13.5
 *    - visible horizontal span 5.5 px, vertical span 11 px
 *    - stroke 1.4, round caps + joins
 *    - currentColor (controlled by .wi-kpi-chevron muted-slate token). */
function KpiNavChevron() {
  return (
    <svg
      className="wi-kpi-chevron"
      width="16" height="16" viewBox="0 0 16 16"
      data-testid="wi-kpi-chevron"
      aria-hidden="true"
      fill="none"
    >
      <path
        d="M5 2.5L10.5 8L5 13.5"
        stroke="currentColor"
        strokeWidth="1.4"
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

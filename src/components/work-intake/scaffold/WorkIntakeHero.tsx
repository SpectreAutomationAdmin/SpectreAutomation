// WI-1 — photographic hero (§9 / §10).
// FEED SYNCED pill is intentionally STATIC per §10 & §18.

export default function WorkIntakeHero() {
  return (
    <section className="wi-hero" aria-label="Work Intake hero">
      <picture>
        <source
          type="image/webp"
          srcSet="/marketing/photography/responsive/spectre-clubhouse-1440.webp 1440w, /marketing/photography/responsive/spectre-clubhouse-1920.webp 1920w"
          sizes="(min-width: 1600px) 1050px, 900px"
        />
        <img
          src="/marketing/photography/responsive/spectre-clubhouse-1440.jpg"
          srcSet="/marketing/photography/responsive/spectre-clubhouse-1024.jpg 1024w, /marketing/photography/responsive/spectre-clubhouse-1440.jpg 1440w, /marketing/photography/responsive/spectre-clubhouse-1920.jpg 1920w"
          sizes="(min-width: 1600px) 1050px, 900px"
          alt=""
          className="wi-hero-img"
          aria-hidden="true"
          loading="eager"
          decoding="async"
        />
      </picture>
      <div className="wi-hero-overlay" aria-hidden="true" />
      <div className="wi-hero-content">
        <div className="wi-hero-primary">
          <div className="wi-hero-eyebrow">MONDAY, SEPTEMBER 28</div>
          <h1 className="wi-hero-greeting">Good morning, Chris.</h1>
          <p className="wi-hero-subtitle">A clear day to keep the Club moving forward.</p>
          <div className="wi-hero-sync" aria-label="Feed sync status (scaffold)">
            <span className="wi-hero-sync-dot" aria-hidden="true" />
            <span className="wi-hero-sync-label">FEED SYNCED</span>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M2.5 6.5a4 4 0 0 1 7-2.4M9.5 5.5a4 4 0 0 1-7 2.4M9 3v2.5H6.5M3 9V6.5h2.5"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
        <div className="wi-hero-side">
          <div className="wi-hero-weather">
            <svg className="wi-hero-weather-icon" width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M12 3v2M12 19v2M5 12H3M21 12h-2M6 6l1.5 1.5M16.5 16.5L18 18M18 6l-1.5 1.5M7.5 16.5L6 18"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <div className="wi-hero-weather-temp">14°</div>
            <div className="wi-hero-weather-place">Calgary, AB</div>
            <div className="wi-hero-weather-cond">Mostly Sunny</div>
          </div>
          <p className="wi-hero-support">
            The details run quietly<br />
            in the background,<br />
            so you can focus on what<br />
            matters most.
          </p>
        </div>
      </div>
    </section>
  );
}

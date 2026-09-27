// WI-1 — photographic hero (§9 / §10).
// FEED SYNCED pill is intentionally STATIC per §10 & §18.
// WI-1D — HeroConfig lets a tenant admin substitute the photograph
// and control its focal point without changing the fixed hero window.

export type HeroConfig =
  | { kind: "default" }
  | { kind: "tenant"; url: string; focalX: number; focalY: number; zoom: number };

export default function WorkIntakeHero({ config }: { config?: HeroConfig } = {}) {
  const cfg: HeroConfig = config ?? { kind: "default" };
  const isTenant = cfg.kind === "tenant";
  const imgStyle: React.CSSProperties | undefined = isTenant
    ? {
        objectPosition: `${cfg.focalX}% ${cfg.focalY}%`,
        transform: cfg.zoom && cfg.zoom !== 1 ? `scale(${cfg.zoom})` : undefined,
        transformOrigin: `${cfg.focalX}% ${cfg.focalY}%`,
      }
    : undefined;
  return (
    <section className="wi-hero" aria-label="Work Intake hero">
      {isTenant ? (
        <img
          src={cfg.url}
          alt=""
          className="wi-hero-img"
          aria-hidden="true"
          loading="eager"
          decoding="async"
          style={imgStyle}
        />
      ) : (
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
      )}
      <div className="wi-hero-overlay" aria-hidden="true" />
      <div className="wi-hero-content">
        <div className="wi-hero-primary">
          <div className="wi-hero-eyebrow">MONDAY, SEPTEMBER 28</div>
          <h1 className="wi-hero-greeting">Good morning, Chris.</h1>
          <p className="wi-hero-subtitle">A clear day to keep the Club moving forward.</p>
          <div className="wi-hero-sync" aria-label="Feed sync status (scaffold)">
            <span className="wi-hero-sync-label">FEED SYNCED</span>
            {/* WI-1F — larger refresh glyph (15 px) with a heavier
                1.75 px stroke for legibility over the photograph. */}
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3 8a5 5 0 0 1 8.5-3.5M13 8a5 5 0 0 1-8.5 3.5M12 3v3H9M4 13v-3h3"
                stroke="currentColor"
                strokeWidth="1.75"
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

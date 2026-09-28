// WI-1 — photographic hero (§9 / §10).
// WI-2C (2026-09-28) — hero is now live. Accepts live date label +
// time-aware greeting + first name + weather observation + feed-sync
// pill. Existing hero geometry and photograph handling unchanged.

import type { CurrentWeatherObservation } from "@/lib/reporting/weather";
import WeatherIcon from "@/components/employee/WeatherIcon";
import type { ReactNode } from "react";

export type HeroConfig =
  | { kind: "default" }
  | { kind: "tenant"; url: string; focalX: number; focalY: number; zoom: number };

interface Props {
  config?: HeroConfig;
  /** WI-2C — live date label already formatted for the club timezone
   *  (e.g. "MONDAY, SEPTEMBER 28"). Falls back to the scaffold copy. */
  dateLabel?: string;
  /** WI-2C — time-aware greeting from mission-control/local-time
   *  (e.g. "Good morning"). Falls back to "Good morning". */
  greeting?: string;
  /** WI-2C — authenticated user's first name. Falls back to
   *  "there". */
  firstName?: string;
  /** WI-2C — live weather observation for the club location, or
   *  null when the provider was unavailable. When null, the pill
   *  quietly hides — weather never blocks the hero from rendering. */
  weather?: CurrentWeatherObservation | null;
  /** WI-2C — the FEED SYNCED / refresh region. Server passes the
   *  Mission Control pill + refresh trigger as ReactNode(s) so the
   *  hero has no coupling to those client components. When omitted
   *  the hero renders no sync UI (dev preview only). */
  feedSyncedSlot?: ReactNode;
}

export default function WorkIntakeHero({
  config,
  dateLabel,
  greeting,
  firstName,
  weather,
  feedSyncedSlot,
}: Props = {}) {
  const cfg: HeroConfig = config ?? { kind: "default" };
  const isTenant = cfg.kind === "tenant";
  const imgStyle: React.CSSProperties | undefined = isTenant
    ? {
        objectPosition: `${cfg.focalX}% ${cfg.focalY}%`,
        transform: cfg.zoom && cfg.zoom !== 1 ? `scale(${cfg.zoom})` : undefined,
        transformOrigin: `${cfg.focalX}% ${cfg.focalY}%`,
      }
    : undefined;
  const eyebrow = dateLabel && dateLabel.trim().length > 0
    ? dateLabel.toUpperCase()
    : "MONDAY, SEPTEMBER 28";
  const greetingText = `${greeting ?? "Good morning"}, ${firstName ?? "there"}.`;
  const temperatureText = weather
    ? `${Math.round(weather.temperature)}°${weather.temperatureUnit === "F" ? "F" : ""}`
    : null;
  const conditionText = weather ? conditionLabel(weather.condition, weather.isDay) : null;
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
          <div className="wi-hero-eyebrow" data-testid="wi-hero-eyebrow">{eyebrow}</div>
          <h1 className="wi-hero-greeting" data-testid="wi-hero-greeting">{greetingText}</h1>
          <p className="wi-hero-subtitle">A clear day to keep the Club moving forward.</p>
          {/* WI-2C — FEED SYNCED slot. The page composes the Mission
             Control pill + refresh trigger and passes them in. When
             absent (dev preview), the hero renders no sync UI. */}
          {feedSyncedSlot && (
            <div className="wi-hero-sync" data-testid="wi-hero-sync">
              {feedSyncedSlot}
            </div>
          )}
        </div>
        <div className="wi-hero-side">
          <div className="wi-hero-weather" data-testid="wi-hero-weather">
            {weather ? (
              <>
                <div className="wi-hero-weather-icon" style={{ color: "currentColor" }}>
                  <WeatherIcon condition={weather.condition} isDay={weather.isDay} size={28} />
                </div>
                <div className="wi-hero-weather-temp">{temperatureText}</div>
                <div className="wi-hero-weather-place" data-testid="wi-hero-weather-place">
                  {weather.locationLabel}
                </div>
                {conditionText && (
                  <div className="wi-hero-weather-cond">{conditionText}</div>
                )}
              </>
            ) : (
              // Failure state (§16): quiet fallback. Still shows the
              // location label if we know it; never blocks the hero.
              <div className="wi-hero-weather-place" data-testid="wi-hero-weather-place">
                Weather unavailable
              </div>
            )}
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

/** WI-2C — condition-enum → readable label. Mirrors the sanitized
 *  vocabulary the shared weather service already emits. Never
 *  fabricates a value the observation didn't state. */
function conditionLabel(cond: CurrentWeatherObservation["condition"], isDay: boolean): string {
  switch (cond) {
    case "clear":         return isDay ? "Clear" : "Clear (night)";
    case "partly-cloudy": return "Partly cloudy";
    case "cloudy":        return "Cloudy";
    case "fog":           return "Fog";
    case "drizzle":       return "Drizzle";
    case "rain":          return "Rain";
    case "showers":       return "Showers";
    case "snow":          return "Snow";
    case "thunderstorm":  return "Thunderstorm";
    default:              return "";
  }
}

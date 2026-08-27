// HR mobile-hotfix (2026-08-26) — canonical Employee Portal weather
// icon. Consumes `CurrentWeatherCondition` from the shared weather
// service (src/lib/reporting/weather) and picks an inline SVG that
// matches the accepted design language.
//
// Both the mobile and desktop hero variants render this component,
// so the two surfaces are guaranteed to reach the same icon for the
// same condition.

import type { CurrentWeatherCondition } from "@/lib/reporting/weather";

interface Props {
  condition: CurrentWeatherCondition;
  /** True when the observation is a daytime reading. Governs the
   *  clear-sky (sun) vs. clear-sky (moon) variant. */
  isDay?: boolean;
  /** SVG width / height in px. Defaults to 16 — small enough for the
   *  mobile pill; the desktop hero passes a larger value. */
  size?: number;
  /** Tailwind class(es) applied to the outer `<svg>`. Consumers pass
   *  colour tokens via `text-*`; the SVG uses `currentColor`. */
  className?: string;
}

export default function WeatherIcon({
  condition,
  isDay = true,
  size = 16,
  className,
}: Props) {
  const stroke = 1.8;
  const sharedProps = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: stroke,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
    className,
  };

  // Clear sky — sun (day) or moon (night)
  if (condition === "clear") {
    if (isDay) {
      return (
        <svg {...sharedProps}>
          <circle cx="12" cy="12" r="4" />
          <line x1="12" y1="2" x2="12" y2="5" />
          <line x1="12" y1="19" x2="12" y2="22" />
          <line x1="2" y1="12" x2="5" y2="12" />
          <line x1="19" y1="12" x2="22" y2="12" />
          <line x1="4.9" y1="4.9" x2="7" y2="7" />
          <line x1="17" y1="17" x2="19.1" y2="19.1" />
          <line x1="4.9" y1="19.1" x2="7" y2="17" />
          <line x1="17" y1="7" x2="19.1" y2="4.9" />
        </svg>
      );
    }
    return (
      <svg {...sharedProps}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    );
  }

  // Partly cloudy — sun-behind-cloud (matches the accepted design)
  if (condition === "partly-cloudy") {
    return (
      <svg {...sharedProps}>
        <circle cx="17" cy="8" r="3.2" />
        <path d="M14.7 10.5a4.5 4.5 0 0 0-8.7 1.5" />
        <path d="M6 12a4 4 0 1 0 0 8h10a3.5 3.5 0 0 0 0-7" />
      </svg>
    );
  }

  // Cloudy / overcast
  if (condition === "cloudy") {
    return (
      <svg {...sharedProps}>
        <path d="M6 19a4 4 0 1 1 0-8 5 5 0 0 1 9.7-1.5A4 4 0 1 1 18 19H6z" />
      </svg>
    );
  }

  // Fog — cloud with horizontal fog lines
  if (condition === "fog") {
    return (
      <svg {...sharedProps}>
        <path d="M6 13a4 4 0 1 1 0-8 5 5 0 0 1 9.7-1.5A4 4 0 1 1 18 13H6z" />
        <line x1="4" y1="17" x2="20" y2="17" />
        <line x1="6" y1="20" x2="18" y2="20" />
      </svg>
    );
  }

  // Drizzle — cloud + small drops
  if (condition === "drizzle") {
    return (
      <svg {...sharedProps}>
        <path d="M6 15a4 4 0 1 1 0-8 5 5 0 0 1 9.7-1.5A4 4 0 1 1 18 15H6z" />
        <line x1="9" y1="18" x2="8.5" y2="20" />
        <line x1="12" y1="18" x2="11.5" y2="20" />
        <line x1="15" y1="18" x2="14.5" y2="20" />
      </svg>
    );
  }

  // Rain / showers — cloud + longer streaks
  if (condition === "rain" || condition === "showers") {
    return (
      <svg {...sharedProps}>
        <path d="M6 15a4 4 0 1 1 0-8 5 5 0 0 1 9.7-1.5A4 4 0 1 1 18 15H6z" />
        <line x1="9" y1="18" x2="8" y2="22" />
        <line x1="13" y1="18" x2="12" y2="22" />
        <line x1="17" y1="18" x2="16" y2="22" />
      </svg>
    );
  }

  // Snow — cloud + snowflake stars
  if (condition === "snow") {
    return (
      <svg {...sharedProps}>
        <path d="M6 14a4 4 0 1 1 0-8 5 5 0 0 1 9.7-1.5A4 4 0 1 1 18 14H6z" />
        <circle cx="9" cy="19" r="0.6" fill="currentColor" />
        <circle cx="12" cy="21" r="0.6" fill="currentColor" />
        <circle cx="15" cy="19" r="0.6" fill="currentColor" />
        <circle cx="10.5" cy="17" r="0.6" fill="currentColor" />
        <circle cx="13.5" cy="17" r="0.6" fill="currentColor" />
      </svg>
    );
  }

  // Thunderstorm — cloud + lightning bolt
  if (condition === "thunderstorm") {
    return (
      <svg {...sharedProps}>
        <path d="M6 14a4 4 0 1 1 0-8 5 5 0 0 1 9.7-1.5A4 4 0 1 1 18 14H6z" />
        <polyline points="12 15 10 19 13 19 11 23" />
      </svg>
    );
  }

  // Unknown — subtle neutral fallback (matches "partly cloudy" glyph)
  return (
    <svg {...sharedProps}>
      <circle cx="17" cy="8" r="3.2" />
      <path d="M14.7 10.5a4.5 4.5 0 0 0-8.7 1.5" />
      <path d="M6 12a4 4 0 1 0 0 8h10a3.5 3.5 0 0 0 0-7" />
    </svg>
  );
}

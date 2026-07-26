// Weather provider abstraction — the source-agnostic contract every
// concrete provider (seed, Open-Meteo, NOAA, Environment Canada, …)
// implements. The Monthly Weather Summary service consumes only this
// interface so the underlying data source can be swapped via env var
// or per-club configuration without touching React or the panel.

/**
 * Resolved club location. Provider implementations MUST prefer
 * latitude/longitude when present and fall back to the city/region
 * pair otherwise. The `label` field is what the rendered subtitle
 * shows on the chapter ("Calgary, Alberta" — NEVER "Scottsdale,
 * Arizona").
 */
export type WeatherLocation = {
  /** Decimal-degree latitude (positive = north). */
  latitude: number | null;
  /** Decimal-degree longitude (positive = east, Calgary ~ −114.x). */
  longitude: number | null;
  /** Display city name, e.g. "Calgary". */
  city: string;
  /** Display province/state/region name, e.g. "Alberta". */
  region: string;
  /** Pre-formatted location label, e.g. "NW Calgary, Alberta". The
   *  panel renders this verbatim under the donut. */
  label: string;
  /** Optional structured address (street, postal code, …) — providers
   *  that geocode can use this when lat/long are absent. */
  street?: string | null;
  /** Presentation temperature unit for this club. Canadian / metric
   *  clubs read °C; American clubs read °F. The provider always
   *  returns the raw observation in Fahrenheit (Open-Meteo + the seed
   *  store F); the reporting service converts on the way out so
   *  React only renders the chosen presentation value. */
  temperatureUnit: "C" | "F";
};

/**
 * Normalised monthly weather observation. Concrete providers shape
 * their raw payloads into this contract so the service builder does
 * not branch on provider identity.
 */
export type MonthlyWeatherObservation = {
  /** ISO year/month the observation applies to ("2026-05"). */
  yearMonth: string;
  /** Day counts that partition the month. Sum to the actual day
   *  count of the period. */
  daysSunny: number;
  daysPartlyCloudy: number;
  daysRain: number;
  daysHighWind: number;
  /** Climate facets. */
  avgHighTempF: number;
  avgWindMph: number;
  /** Average daily rounds played by weather condition. These can
   *  come from the tee-sheet system once integrated; the seed
   *  provider models a typical relationship until then. */
  avgRoundsSunny: number;
  avgRoundsPartlyCloudy: number;
  avgRoundsHighWind: number;
  avgRoundsRain: number;
  /** Notable weather events for the period, normalised. */
  notableEvents: ReadonlyArray<NormalisedWeatherEvent>;
  /** Provenance — where the data came from + how precise. */
  provenance: WeatherProvenance;
};

export type NormalisedWeatherEventKind =
  | "heavy-rain"
  | "cold-frost"
  | "high-wind"
  | "prime-conditions"
  | "course-impact";

export type NormalisedWeatherEvent = {
  key: string;
  /** Pre-formatted date range using `period.monthShort` — e.g.
   *  "May 11–12". Providers MUST derive this from the period passed
   *  in to `fetchMonthly`, never from a calendar lookup. */
  dateLabel: string;
  kind: NormalisedWeatherEventKind;
  /** Short pill label, e.g. "Heavy Rain", "Prime Conditions". */
  pillLabel: string;
  description: string;
  /** Pre-formatted golf impact label + tone. */
  golfImpactLabel: string;
  golfImpactTone: "favorable" | "risk" | "neutral";
  /** Pre-formatted F&B impact label + tone. */
  fbImpactLabel: string;
  fbImpactTone: "favorable" | "risk" | "neutral";
  followUpLabel: string;
};

export type WeatherProvenance = {
  /** Data-source identifier, e.g. "seed-calgary",
   *  "open-meteo-archive", "noaa-ghcnd". */
  source: string;
  /** Coordinate precision the provider actually used. */
  precision: "coordinate" | "city" | "region" | "seed";
  /** Optional human-readable provider attribution shown in finance-
   *  committee disclosure footers if the founder later opts in. */
  attribution?: string;
  /** Lat/long the provider actually queried, when applicable. */
  queriedLatitude?: number;
  queriedLongitude?: number;
};

/** The minimum contract every weather data source must satisfy. */
export interface WeatherProvider {
  /** Stable identifier, e.g. "seed", "open-meteo". */
  readonly id: string;
  /**
   * Fetch the monthly observation for the given location + period.
   * Implementations MUST prefer `location.latitude` /
   * `location.longitude` when both are non-null, then fall back to
   * `location.city`+`location.region`, then return null if the
   * lookup is impossible (the caller then falls back to the seed
   * provider).
   *
   * `period` carries the year/month + monthShort the provider uses
   * to format event date labels.
   */
  fetchMonthly(input: {
    location: WeatherLocation;
    period: { year: number; month: number; monthShort: string };
  }): Promise<MonthlyWeatherObservation | null>;
}

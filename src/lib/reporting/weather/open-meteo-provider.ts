// Open-Meteo historical weather provider.
//
// Free, key-less API: https://open-meteo.com/en/docs/historical-weather-api
// Endpoint: https://archive-api.open-meteo.com/v1/archive
//
// Coordinates are mandatory — this provider intentionally returns
// `null` when the caller's location has no lat/long, so the factory
// upstream can fall back to the seed. That preserves the "prefer
// coordinates over city-level lookup" rule the founder asked for.
//
// The provider returns normalised monthly counts derived from daily
// observations. Notable events are NOT emitted by this provider yet
// — they require pairing with tee-sheet utilization data to produce
// meaningful golf/F&B impact labels, so the service layer falls back
// to the seed provider's events block until that integration ships.

import type {
  CurrentWeatherCondition,
  CurrentWeatherObservation,
  MonthlyWeatherObservation,
  WeatherLocation,
  WeatherProvider,
} from "./types";
import { seedWeatherProvider } from "./seed-provider";

const ARCHIVE_ENDPOINT = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";

type CurrentResponse = {
  current?: {
    time?: string;
    temperature_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    is_day?: number;
  };
};

/**
 * Map an Open-Meteo / WMO weather code to the canonical
 * `CurrentWeatherCondition` vocabulary. Full code list:
 * https://open-meteo.com/en/docs
 */
function mapWmoCodeToCondition(code: number | undefined): CurrentWeatherCondition {
  if (code == null) return "unknown";
  if (code === 0) return "clear";
  if (code === 1) return "clear";
  if (code === 2) return "partly-cloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code === 51 || code === 53 || code === 55) return "drizzle";
  if (code === 56 || code === 57) return "drizzle";
  if (code === 61 || code === 63 || code === 65) return "rain";
  if (code === 66 || code === 67) return "rain";
  if (code === 71 || code === 73 || code === 75 || code === 77) return "snow";
  if (code === 80 || code === 81 || code === 82) return "showers";
  if (code === 85 || code === 86) return "snow";
  if (code === 95 || code === 96 || code === 99) return "thunderstorm";
  return "unknown";
}

type DailyResponse = {
  daily: {
    time: string[];
    /** Daily maximum 2 m temperature in degrees Fahrenheit. */
    temperature_2m_max?: number[];
    /** Daily maximum 10 m wind speed in miles per hour. */
    wind_speed_10m_max?: number[];
    /** Daily total precipitation in millimetres. */
    precipitation_sum?: number[];
    /** Daily total sunshine duration in seconds. */
    sunshine_duration?: number[];
  };
};

function startEndIso(year: number, month: number): { startIso: string; endIso: string } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end   = new Date(Date.UTC(year, month, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { startIso: iso(start), endIso: iso(end) };
}

/**
 * Classify a single daily observation into one of the four buckets
 * the panel renders (sunny / partly cloudy / rain / high wind).
 * Thresholds are intentionally conservative — wind classification
 * wins over precipitation when both are above their threshold.
 */
function classifyDay(d: {
  tMaxF: number;
  windMaxMph: number;
  precipMm: number;
  sunshineHours: number;
}): "sunny" | "partly-cloudy" | "rain" | "high-wind" {
  if (d.windMaxMph >= 22) return "high-wind";
  if (d.precipMm >= 2.0) return "rain";
  if (d.sunshineHours >= 7) return "sunny";
  return "partly-cloudy";
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Build the Open-Meteo provider. The `fetchFn` is injectable so unit
 * tests can stub the HTTP without spinning up a network mock.
 */
export function createOpenMeteoProvider(opts?: {
  fetchFn?: typeof globalThis.fetch;
}): WeatherProvider {
  const f: typeof globalThis.fetch = opts?.fetchFn ?? (globalThis.fetch as typeof globalThis.fetch);
  return {
    id: "open-meteo",
    async fetchMonthly(input) {
      const { location, period } = input;
      // Prefer coordinates — this is the bar the founder set.
      if (location.latitude == null || location.longitude == null) {
        return null;
      }
      const { startIso, endIso } = startEndIso(period.year, period.month);
      const params = new URLSearchParams({
        latitude: String(location.latitude),
        longitude: String(location.longitude),
        start_date: startIso,
        end_date: endIso,
        daily: [
          "temperature_2m_max",
          "wind_speed_10m_max",
          "precipitation_sum",
          "sunshine_duration",
        ].join(","),
        timezone: "auto",
        temperature_unit: "fahrenheit",
        wind_speed_unit: "mph",
        precipitation_unit: "mm",
      });
      let payload: DailyResponse;
      try {
        const res = await f(`${ARCHIVE_ENDPOINT}?${params.toString()}`);
        if (!res.ok) return null;
        payload = (await res.json()) as DailyResponse;
      } catch {
        return null;
      }
      const daily = payload.daily;
      if (!daily?.time?.length) return null;
      const tMax = daily.temperature_2m_max ?? [];
      const wMax = daily.wind_speed_10m_max ?? [];
      const pSum = daily.precipitation_sum ?? [];
      const sSec = daily.sunshine_duration ?? [];

      let daysSunny = 0, daysPartlyCloudy = 0, daysRain = 0, daysHighWind = 0;
      for (let i = 0; i < daily.time.length; i++) {
        const bucket = classifyDay({
          tMaxF: tMax[i] ?? 0,
          windMaxMph: wMax[i] ?? 0,
          precipMm: pSum[i] ?? 0,
          sunshineHours: (sSec[i] ?? 0) / 3600,
        });
        switch (bucket) {
          case "sunny":         daysSunny++;        break;
          case "partly-cloudy": daysPartlyCloudy++; break;
          case "rain":          daysRain++;         break;
          case "high-wind":     daysHighWind++;     break;
        }
      }

      // Round-rate seeds (no tee-sheet integration yet) fall back to
      // the seed provider's averages so the bar chart keeps producing
      // a meaningful relationship. Notable events also reuse the seed
      // provider's event set until utilization integration lands.
      const seed = await seedWeatherProvider.fetchMonthly({
        location, period,
      });
      const seedAvgRounds = seed ?? {
        avgRoundsSunny: 142, avgRoundsPartlyCloudy: 118,
        avgRoundsHighWind: 64, avgRoundsRain: 28,
        notableEvents: [] as ReadonlyArray<NonNullable<MonthlyWeatherObservation["notableEvents"]>[number]>,
      };

      return {
        yearMonth: `${period.year}-${String(period.month).padStart(2, "0")}`,
        daysSunny, daysPartlyCloudy, daysRain, daysHighWind,
        avgHighTempF: Math.round(avg(tMax)),
        avgWindMph:   Math.round(avg(wMax)),
        avgRoundsSunny:        seedAvgRounds.avgRoundsSunny,
        avgRoundsPartlyCloudy: seedAvgRounds.avgRoundsPartlyCloudy,
        avgRoundsHighWind:     seedAvgRounds.avgRoundsHighWind,
        avgRoundsRain:         seedAvgRounds.avgRoundsRain,
        notableEvents: seedAvgRounds.notableEvents,
        provenance: {
          source: "open-meteo-archive",
          precision: "coordinate",
          attribution: "Historical weather data: Open-Meteo (open-meteo.com) — free, no API key.",
          queriedLatitude: location.latitude,
          queriedLongitude: location.longitude,
        },
      };
    },

    /**
     * Current-conditions endpoint — the Employee Portal hero pill.
     * Uses Open-Meteo's `/v1/forecast?current=...` route (free, no
     * API key). Returns `null` when the location has no coordinates
     * OR when the request fails, so the high-level helper can fall
     * back to the seed provider without swallowing the error.
     */
    async fetchCurrent({ location }) {
      if (location.latitude == null || location.longitude == null) {
        return null;
      }
      const params = new URLSearchParams({
        latitude: String(location.latitude),
        longitude: String(location.longitude),
        current: ["temperature_2m", "weather_code", "wind_speed_10m", "is_day"].join(","),
        timezone: "auto",
        temperature_unit: location.temperatureUnit === "C" ? "celsius" : "fahrenheit",
        wind_speed_unit: "mph",
      });
      let payload: CurrentResponse;
      try {
        const res = await f(`${FORECAST_ENDPOINT}?${params.toString()}`);
        if (!res.ok) return null;
        payload = (await res.json()) as CurrentResponse;
      } catch {
        return null;
      }
      const c = payload.current;
      if (!c || typeof c.temperature_2m !== "number") return null;
      return {
        observedAt: c.time ?? new Date().toISOString(),
        temperature: Math.round(c.temperature_2m),
        temperatureUnit: location.temperatureUnit,
        condition: mapWmoCodeToCondition(c.weather_code),
        isDay: c.is_day !== 0,
        windMph: typeof c.wind_speed_10m === "number" ? Math.round(c.wind_speed_10m) : null,
        locationLabel: location.city,
        provenance: {
          source: "open-meteo-forecast",
          precision: "coordinate",
          attribution: "Current weather data: Open-Meteo (open-meteo.com) — free, no API key.",
          queriedLatitude: location.latitude,
          queriedLongitude: location.longitude,
        },
      };
    },
  };
}

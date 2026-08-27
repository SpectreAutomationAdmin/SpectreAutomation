// Weather provider factory + barrel exports.
//
// Provider selection precedence:
//   1. Explicit override passed via `getWeatherProvider({ providerId })`.
//   2. `WEATHER_PROVIDER` env var (e.g. "open-meteo", "seed").
//   3. Default: the seed provider — keeps dev / test deterministic
//      and avoids external HTTP unless explicitly opted in.
//
// `fetchObservation` is the high-level entry point the reporting
// service uses: it asks the selected provider, then falls back to
// the seed provider if the primary returns null (e.g. Open-Meteo
// failed or the location lacks coordinates). The returned
// observation always carries a `provenance` block describing the
// effective source.

import type {
  CurrentWeatherObservation,
  MonthlyWeatherObservation,
  WeatherLocation,
  WeatherProvider,
} from "./types";
import { seedWeatherProvider } from "./seed-provider";
import { createOpenMeteoProvider } from "./open-meteo-provider";
import { resolveClubLocation, type ClubLike } from "./club-location";

export type {
  CurrentWeatherCondition,
  CurrentWeatherObservation,
  MonthlyWeatherObservation,
  WeatherLocation,
  WeatherProvider,
  NormalisedWeatherEvent,
  NormalisedWeatherEventKind,
  WeatherProvenance,
} from "./types";
export type { ClubLike } from "./club-location";
export { resolveClubLocation, temperatureUnitForRegion } from "./club-location";
export { seedWeatherProvider } from "./seed-provider";
export { createOpenMeteoProvider } from "./open-meteo-provider";

export type WeatherProviderId = "seed" | "open-meteo";

export function getWeatherProvider(opts?: {
  providerId?: WeatherProviderId;
}): WeatherProvider {
  const id =
    opts?.providerId ??
    (process.env.WEATHER_PROVIDER as WeatherProviderId | undefined) ??
    "seed";
  switch (id) {
    case "open-meteo": return createOpenMeteoProvider();
    case "seed":       return seedWeatherProvider;
  }
}

/**
 * High-level entry point used by the Monthly Weather Summary service.
 * Resolves location → calls the primary provider → falls back to seed
 * when the primary returns null. The result always carries a
 * `provenance` block so the panel + audit log can identify the source.
 */
export async function fetchObservation(input: {
  club: ClubLike;
  period: { year: number; month: number; monthShort: string };
  providerId?: WeatherProviderId;
  /** Test seam — when supplied, used instead of the factory choice. */
  provider?: WeatherProvider;
}): Promise<{ location: WeatherLocation; observation: MonthlyWeatherObservation }> {
  const location = resolveClubLocation(input.club);
  const primary = input.provider ?? getWeatherProvider({ providerId: input.providerId });
  const primaryResult = await primary.fetchMonthly({ location, period: input.period });
  if (primaryResult) {
    return { location, observation: primaryResult };
  }
  // Primary returned null — fall back to seed.
  const fallback = await seedWeatherProvider.fetchMonthly({ location, period: input.period });
  if (!fallback) {
    throw new Error("seed weather provider returned null — unreachable for any supported month");
  }
  return { location, observation: fallback };
}

// ---------------------------------------------------------------------------
// Current conditions — Employee Portal hero + Member portal weather widget.
//
// Server-side TTL cache: keyed by rounded lat/lng so multiple clubs at the
// same coordinates share a single upstream call. TTL is 15 minutes — the
// hero pill doesn't need minute-by-minute freshness and Open-Meteo's free
// tier appreciates the courtesy. Cache is per-Node-process; a rolling deploy
// warms every replica on its first request.
// ---------------------------------------------------------------------------

const CURRENT_CACHE_TTL_MS = 15 * 60 * 1000;

type CachedCurrent = {
  observation: CurrentWeatherObservation;
  location: WeatherLocation;
  expiresAt: number;
};

const currentCache = new Map<string, CachedCurrent>();

function currentCacheKey(location: WeatherLocation): string {
  const lat = location.latitude?.toFixed(3) ?? "null";
  const lng = location.longitude?.toFixed(3) ?? "null";
  return `${lat},${lng},${location.temperatureUnit}`;
}

/**
 * Canonical live current-conditions entry point used by the
 * Employee Portal hero (desktop + mobile), the Member portal weather
 * widget, and any future "current-conditions" reporting tile.
 *
 * The flow is the same as `fetchObservation`:
 *   coordinates → primary provider → seed fallback → cached result.
 *
 * On uncached miss + primary failure the seed provider produces a
 * deterministic observation so the portal is never empty. Callers
 * receive `null` only when the location cannot be resolved AT ALL
 * (which is unreachable today because `resolveClubLocation` always
 * returns a location object; it may however carry null coordinates,
 * in which case Open-Meteo is skipped and the seed provider fires).
 */
export async function getCurrentWeather(input: {
  club: ClubLike;
  providerId?: WeatherProviderId;
  /** Test seam — bypasses the factory. */
  provider?: WeatherProvider;
  /** Test seam — bypasses the process cache. */
  bypassCache?: boolean;
}): Promise<{ location: WeatherLocation; observation: CurrentWeatherObservation } | null> {
  const location = resolveClubLocation(input.club);
  const key = currentCacheKey(location);
  if (!input.bypassCache) {
    const cached = currentCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { location: cached.location, observation: cached.observation };
    }
  }
  const primary = input.provider ?? getWeatherProvider({ providerId: input.providerId });
  let observation: CurrentWeatherObservation | null = null;
  try {
    observation = await primary.fetchCurrent({ location });
  } catch {
    observation = null;
  }
  if (!observation) {
    observation = await seedWeatherProvider.fetchCurrent({ location });
  }
  if (!observation) return null;
  currentCache.set(key, {
    observation,
    location,
    expiresAt: Date.now() + CURRENT_CACHE_TTL_MS,
  });
  return { location, observation };
}

/** Test seam — drops the process-local current-weather cache. */
export function _clearCurrentWeatherCacheForTests(): void {
  currentCache.clear();
}

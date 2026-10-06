// Weather provider factory + barrel exports.
//
// Provider selection precedence:
//   1. Explicit override passed via `getWeatherProvider({ providerId })`.
//   2. `WEATHER_PROVIDER` env var (e.g. "open-meteo", "seed").
//   3. Default: the Open-Meteo provider — the canonical approved
//      historical weather source. Seed is only ever used as the
//      downstream fallback when coordinates are absent OR Open-Meteo
//      fails.
//
// `fetchObservation` is the high-level entry point the reporting
// service uses:
//   1. Resolve location from the ClubProfile fields on the Club.
//   2. Hit the persistent `WeatherObservationCache` for a prior
//      observation at those coordinates + that reporting period.
//   3. If miss, ask the selected provider; on success persist it to
//      the cache for future reads.
//   4. Fall back to seed when the primary returns null (e.g. the
//      club has no coordinates stored yet, or Open-Meteo failed).
//
// The returned observation always carries a `provenance` block
// describing the effective source. Cache invalidation on tenant
// location change lives in `observation-cache.ts`.

import type {
  CurrentWeatherObservation,
  MonthlyWeatherObservation,
  WeatherLocation,
  WeatherProvider,
} from "./types";
import { seedWeatherProvider } from "./seed-provider";
import { createOpenMeteoProvider } from "./open-meteo-provider";
import { resolveClubLocation, type ClubLike } from "./club-location";
import {
  readWeatherCache,
  writeWeatherCache,
} from "./observation-cache";

export type {
  CurrentWeatherCondition,
  CurrentWeatherObservation,
  DailyWeatherClassification,
  MonthlyWeatherObservation,
  WeatherLocation,
  WeatherProvider,
  NormalisedWeatherEvent,
  NormalisedWeatherEventKind,
  WeatherProvenance,
} from "./types";
export type { ClubLike, ClubProfileLike } from "./club-location";
export { resolveClubLocation, temperatureUnitForRegion } from "./club-location";
export { seedWeatherProvider } from "./seed-provider";
export { createOpenMeteoProvider } from "./open-meteo-provider";
export {
  readWeatherCache,
  writeWeatherCache,
  invalidateWeatherCacheForClub,
  roundCoordinate,
} from "./observation-cache";
export { geocodeClubProfileAddress } from "./geocode";

export type WeatherProviderId = "seed" | "open-meteo";

/**
 * GOLF-HIST-1B (2026-10-06) — canonical contract check.
 *
 * The current canonical `MonthlyWeatherObservation` MUST expose
 * authoritative per-date classifications via `dailyClassifications`.
 * Both the Weather Pattern aggregator AND the Weather × Golf join
 * read from this one array. A cache row written before
 * `dailyClassifications` existed carries only the monthly aggregates
 * — Weather Pattern still renders but the join sees nothing. This
 * predicate decides whether such a row counts as a cache HIT or a
 * stale MISS that must be refetched.
 */
export function isObservationContractCurrent(obs: MonthlyWeatherObservation): boolean {
  if (!Array.isArray(obs.dailyClassifications)) return false;
  if (obs.dailyClassifications.length === 0) return false;
  return true;
}

export function getWeatherProvider(opts?: {
  providerId?: WeatherProviderId;
}): WeatherProvider {
  const id =
    opts?.providerId ??
    (process.env.WEATHER_PROVIDER as WeatherProviderId | undefined) ??
    "open-meteo";
  switch (id) {
    case "open-meteo": return createOpenMeteoProvider();
    case "seed":       return seedWeatherProvider;
  }
}

/**
 * High-level entry point used by the Monthly Weather Summary service.
 *
 * Flow: resolve → cache read → provider → cache write → seed fallback.
 *
 * `clubId` is REQUIRED when the caller wants cache participation; omit
 * it for callers that lack a Prisma Club row (e.g. one-off tests). The
 * returned observation always carries a `provenance` block so the
 * panel + audit log can identify the source.
 */
export async function fetchObservation(input: {
  club: ClubLike;
  period: { year: number; month: number; monthShort: string };
  providerId?: WeatherProviderId;
  /** Test seam — when supplied, used instead of the factory choice. */
  provider?: WeatherProvider;
  /** Enables persistent cache participation. */
  clubId?: string | null;
  /** Test seam — bypass the DB cache without affecting other callers. */
  bypassCache?: boolean;
}): Promise<{ location: WeatherLocation; observation: MonthlyWeatherObservation }> {
  const location = resolveClubLocation(input.club);

  // -- 1. Cache lookup when we have both a clubId and coordinates. --
  // GOLF-HIST-1B (2026-10-06) — cache HIT and provider FETCH MUST
  // return equivalent contracts. A cache row written before
  // `dailyClassifications` was added (pre-GOLF-HIST-1) carries the
  // monthly aggregate counts but no per-day array. Treating that as
  // a HIT silently delivered a weaker contract to downstream
  // consumers — Weather Pattern rendered (uses aggregates) while
  // the Weather × Golf join saw `dailyClassifications: undefined`
  // and fell back to UNAVAILABLE. Fix: a cached observation lacking
  // the canonical per-day array is treated as a MISS; the provider
  // is refetched and the cache row is overwritten with the full
  // contract.
  const yearMonth = `${input.period.year}-${String(input.period.month).padStart(2, "0")}`;
  if (
    !input.bypassCache &&
    input.clubId &&
    location.latitude != null &&
    location.longitude != null
  ) {
    const cached = await readWeatherCache({
      clubId: input.clubId,
      yearMonth,
      latitude: location.latitude,
      longitude: location.longitude,
    });
    if (cached && isObservationContractCurrent(cached)) {
      return { location, observation: cached };
    }
    // Fall through — cache row is stale by contract. The provider
    // call below will overwrite it.
  }

  // -- 2. Primary provider. --
  const primary = input.provider ?? getWeatherProvider({ providerId: input.providerId });
  const primaryResult = await primary.fetchMonthly({ location, period: input.period });
  if (primaryResult) {
    // Persist for future reads. Fire-and-forget — a cache failure
    // (e.g. SQLite write contention) must not break the current
    // response.
    if (
      input.clubId &&
      location.latitude != null &&
      location.longitude != null
    ) {
      void writeWeatherCache({
        clubId: input.clubId,
        yearMonth,
        latitude: location.latitude,
        longitude: location.longitude,
        observation: primaryResult,
      }).catch(() => undefined);
    }
    return { location, observation: primaryResult };
  }

  // -- 3. Seed fallback — when coordinates are absent or provider failed. --
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
 * Flow: resolve → primary provider → seed fallback → cached result.
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

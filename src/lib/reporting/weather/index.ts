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
  MonthlyWeatherObservation,
  WeatherLocation,
  WeatherProvider,
} from "./types";
import { seedWeatherProvider } from "./seed-provider";
import { createOpenMeteoProvider } from "./open-meteo-provider";
import { resolveClubLocation, type ClubLike } from "./club-location";

export type {
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

// Weather provider abstraction tests — coordinate preference,
// seed-provider day-count balance, Open-Meteo HTTP shape, factory
// fallback, club-location resolution.

import { describe, it, expect, vi } from "vitest";

import {
  seedWeatherProvider,
  createOpenMeteoProvider,
  resolveClubLocation,
  fetchObservation,
  getCurrentWeather,
  _clearCurrentWeatherCacheForTests,
  temperatureUnitForRegion,
  type ClubLike,
  type WeatherLocation,
} from "@/lib/reporting/weather";

const SILVER_SPRINGS_CLUB: ClubLike = {
  name: "Silver Springs Golf & Country Club",
  slug: "silver-springs",
  address: "1 Fairway Lane, Calgary, AB",
  region: "Alberta",
};

const MAY_2026 = { year: 2026, month: 5, monthShort: "May" };

describe("temperatureUnitForRegion — Canada → °C, everywhere else → °F", () => {
  it("Canadian province full names → C", () => {
    for (const region of [
      "Alberta", "British Columbia", "Manitoba", "New Brunswick",
      "Newfoundland and Labrador", "Nova Scotia", "Nunavut",
      "Northwest Territories", "Ontario", "Prince Edward Island",
      "Quebec", "Saskatchewan", "Yukon",
    ]) {
      expect(temperatureUnitForRegion(region), `${region} → C`).toBe("C");
    }
  });
  it("Canadian two-letter postal codes → C (case-insensitive)", () => {
    for (const code of ["AB", "bc", "ON", "qc", "Sk", "NB", "NS", "PE", "MB", "NL", "NT", "NU", "YT"]) {
      expect(temperatureUnitForRegion(code), `${code} → C`).toBe("C");
    }
  });
  it("US states + unknown regions → F", () => {
    for (const region of ["Florida", "California", "FL", "CA", "Texas", "TX", "Illinois", "Mexico", null, undefined, ""]) {
      expect(temperatureUnitForRegion(region as string | null | undefined), `${region ?? "<empty>"} → F`).toBe("F");
    }
  });
});

describe("resolveClubLocation — coordinate-precision known clubs, city-precision otherwise", () => {
  it("Silver Springs → NW Calgary coordinates + 'NW Calgary, Alberta' label (matched by slug)", () => {
    const loc = resolveClubLocation(SILVER_SPRINGS_CLUB);
    expect(loc.latitude).toBeCloseTo(51.1078, 2);
    expect(loc.longitude).toBeCloseTo(-114.1815, 2);
    expect(loc.city).toBe("Calgary");
    expect(loc.region).toBe("Alberta");
    expect(loc.label).toBe("NW Calgary, Alberta");
  });

  it("Silver Springs fingerprint also matches by name only (no slug supplied)", () => {
    const loc = resolveClubLocation({
      name: "Silver Springs Golf & Country Club",
      address: "1 Fairway Lane, Calgary, AB",
      region: "Alberta",
    });
    expect(loc.latitude).toBeCloseTo(51.1078, 2);
    expect(loc.longitude).toBeCloseTo(-114.1815, 2);
  });

  it("unknown club falls back to address-parsed city + supplied region, with null coordinates", () => {
    const loc = resolveClubLocation({
      name: "Mountain View Golf Club",
      address: "100 Pinecrest Drive, Banff, AB",
      region: "Alberta",
    });
    expect(loc.latitude).toBeNull();
    expect(loc.longitude).toBeNull();
    expect(loc.city).toBe("Banff");
    expect(loc.region).toBe("Alberta");
    expect(loc.label).toBe("Banff, Alberta");
  });

  it("unknown club with no address falls back to the club name as the label", () => {
    const loc = resolveClubLocation({ name: "Lakeside Club", address: null, region: null });
    expect(loc.city).toBe("—");
    expect(loc.region).toBe("—");
    expect(loc.label).toBe("Lakeside Club");
  });
});

describe("seedWeatherProvider — Calgary climate, day counts sum to the actual month length", () => {
  it("May 2026 (31 days) — sunny:17 partly:7 rain:5 wind:2 sums to 31", async () => {
    const obs = await seedWeatherProvider.fetchMonthly({
      location: resolveClubLocation(SILVER_SPRINGS_CLUB),
      period: MAY_2026,
    });
    expect(obs).not.toBeNull();
    if (!obs) return;
    expect(obs.daysSunny).toBe(17);
    expect(obs.daysPartlyCloudy).toBe(7);
    expect(obs.daysRain).toBe(5);
    expect(obs.daysHighWind).toBe(2);
    expect(obs.daysSunny + obs.daysPartlyCloudy + obs.daysRain + obs.daysHighWind).toBe(31);
    expect(obs.avgHighTempF).toBe(65);
    expect(obs.avgWindMph).toBe(11);
  });

  it("Feb 2027 (28 days, non-leap) — day counts re-balance to actual month length", async () => {
    const obs = await seedWeatherProvider.fetchMonthly({
      location: resolveClubLocation(SILVER_SPRINGS_CLUB),
      period: { year: 2027, month: 2, monthShort: "Feb" },
    });
    if (!obs) throw new Error("seed returned null for Feb 2027");
    const total = obs.daysSunny + obs.daysPartlyCloudy + obs.daysRain + obs.daysHighWind;
    expect(total).toBe(28);
  });

  it("provenance identifies seed-nw-calgary with seed precision", async () => {
    const obs = await seedWeatherProvider.fetchMonthly({
      location: resolveClubLocation(SILVER_SPRINGS_CLUB),
      period: MAY_2026,
    });
    if (!obs) throw new Error("seed returned null");
    expect(obs.provenance.source).toBe("seed-nw-calgary");
    expect(obs.provenance.precision).toBe("seed");
    expect(obs.provenance.queriedLatitude).toBeCloseTo(51.1078, 2);
  });

  it("notable events use period.monthShort for date labels", async () => {
    const obs = await seedWeatherProvider.fetchMonthly({
      location: resolveClubLocation(SILVER_SPRINGS_CLUB),
      period: { year: 2026, month: 3, monthShort: "Mar" },
    });
    if (!obs) throw new Error("seed returned null");
    for (const e of obs.notableEvents) {
      expect(e.dateLabel).toMatch(/^Mar\b/);
    }
  });
});

describe("OpenMeteoProvider — prefers coordinates, returns null when absent", () => {
  it("returns null when the location has no latitude/longitude (no city-level fallback)", async () => {
    const cityOnlyLocation: WeatherLocation = {
      latitude: null,
      longitude: null,
      city: "Banff",
      region: "Alberta",
      label: "Banff, Alberta",
      temperatureUnit: "C",
    };
    const provider = createOpenMeteoProvider({
      // No HTTP allowed — coordinates absent, so the provider returns
      // before any fetch is even attempted.
      fetchFn: vi.fn() as unknown as typeof fetch,
    });
    const obs = await provider.fetchMonthly({
      location: cityOnlyLocation,
      period: MAY_2026,
    });
    expect(obs).toBeNull();
  });

  it("makes ONE HTTP call to the Open-Meteo archive with the supplied coordinates + monthly date range", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      daily: {
        time: Array.from({ length: 31 }, (_, i) => `2026-05-${String(i + 1).padStart(2, "0")}`),
        temperature_2m_max: Array.from({ length: 31 }, () => 65),
        wind_speed_10m_max: Array.from({ length: 31 }, () => 10),
        precipitation_sum: Array.from({ length: 31 }, (_, i) => (i < 5 ? 5 : 0)),
        sunshine_duration: Array.from({ length: 31 }, () => 8 * 3600),
      },
    }), { status: 200 }));
    const provider = createOpenMeteoProvider({ fetchFn: fetchSpy as unknown as typeof fetch });
    const loc = resolveClubLocation(SILVER_SPRINGS_CLUB);
    const obs = await provider.fetchMonthly({ location: loc, period: MAY_2026 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toMatch(/archive-api\.open-meteo\.com\/v1\/archive/);
    expect(url).toMatch(/latitude=51\.1078/);
    expect(url).toMatch(/longitude=-114\.1815/);
    expect(url).toMatch(/start_date=2026-05-01/);
    expect(url).toMatch(/end_date=2026-05-31/);
    // Returned observation classifies the 31 days into the 4 buckets.
    expect(obs).not.toBeNull();
    if (!obs) return;
    expect(obs.daysSunny + obs.daysPartlyCloudy + obs.daysRain + obs.daysHighWind).toBe(31);
    expect(obs.provenance.source).toBe("open-meteo-archive");
    expect(obs.provenance.precision).toBe("coordinate");
    expect(obs.provenance.queriedLatitude).toBeCloseTo(51.1078, 2);
  });

  it("returns null on HTTP error so the caller falls back to seed", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    const provider = createOpenMeteoProvider({ fetchFn: fetchSpy as unknown as typeof fetch });
    const obs = await provider.fetchMonthly({
      location: resolveClubLocation(SILVER_SPRINGS_CLUB),
      period: MAY_2026,
    });
    expect(obs).toBeNull();
  });

  it("returns null on network exception (provider never throws)", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const provider = createOpenMeteoProvider({ fetchFn: fetchSpy as unknown as typeof fetch });
    const obs = await provider.fetchMonthly({
      location: resolveClubLocation(SILVER_SPRINGS_CLUB),
      period: MAY_2026,
    });
    expect(obs).toBeNull();
  });
});

describe("fetchObservation — high-level entry point with seed fallback", () => {
  it("uses primary provider when it returns a non-null observation", async () => {
    const primary = {
      id: "stub-primary",
      fetchMonthly: vi.fn().mockResolvedValue({
        yearMonth: "2026-05",
        daysSunny: 20, daysPartlyCloudy: 6, daysRain: 4, daysHighWind: 1,
        avgHighTempF: 70, avgWindMph: 9,
        avgRoundsSunny: 142, avgRoundsPartlyCloudy: 118,
        avgRoundsHighWind: 64, avgRoundsRain: 28,
        notableEvents: [],
        provenance: { source: "stub-primary", precision: "coordinate" as const },
      }),
      fetchCurrent: vi.fn().mockResolvedValue(null),
    };
    const { location, observation } = await fetchObservation({
      club: SILVER_SPRINGS_CLUB,
      period: MAY_2026,
      provider: primary,
    });
    expect(primary.fetchMonthly).toHaveBeenCalledTimes(1);
    expect(observation.provenance.source).toBe("stub-primary");
    expect(observation.daysSunny).toBe(20);
    // The resolved location is the coordinate-precision NW Calgary
    // fingerprint, NOT a city-level fallback.
    expect(location.latitude).toBeCloseTo(51.1078, 2);
    expect(location.label).toBe("NW Calgary, Alberta");
  });

  it("falls back to the seed provider when the primary returns null", async () => {
    const primary = {
      id: "stub-primary",
      fetchMonthly: vi.fn().mockResolvedValue(null),
      fetchCurrent: vi.fn().mockResolvedValue(null),
    };
    const { observation } = await fetchObservation({
      club: SILVER_SPRINGS_CLUB,
      period: MAY_2026,
      provider: primary,
    });
    expect(primary.fetchMonthly).toHaveBeenCalledTimes(1);
    // Seed provider supplied the answer.
    expect(observation.provenance.source).toBe("seed-nw-calgary");
    expect(observation.daysSunny).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// Current conditions — Employee Portal + Member portal weather widget entry
// point. Same coordinate-preference contract as `fetchMonthly`. Seed fallback
// keeps the portal weather pill non-empty when Open-Meteo is unreachable.
// ---------------------------------------------------------------------------
describe("getCurrentWeather — canonical shared current-conditions entry point", () => {
  it("uses the tenant's coordinates and the primary provider result when available", async () => {
    _clearCurrentWeatherCacheForTests();
    const primary = {
      id: "stub-primary",
      fetchMonthly: vi.fn().mockResolvedValue(null),
      fetchCurrent: vi.fn().mockResolvedValue({
        observedAt: "2026-08-26T13:00:00Z",
        temperature: 22,
        temperatureUnit: "C" as const,
        condition: "partly-cloudy" as const,
        isDay: true,
        windMph: 8,
        locationLabel: "Calgary",
        provenance: {
          source: "stub-primary-current",
          precision: "coordinate" as const,
          queriedLatitude: 51.1078,
          queriedLongitude: -114.1815,
        },
      }),
    };
    const result = await getCurrentWeather({
      club: SILVER_SPRINGS_CLUB,
      provider: primary,
      bypassCache: true,
    });
    expect(primary.fetchCurrent).toHaveBeenCalledTimes(1);
    expect(result?.observation.condition).toBe("partly-cloudy");
    expect(result?.observation.temperature).toBe(22);
    expect(result?.observation.locationLabel).toBe("Calgary");
    // Coordinates flow from `resolveClubLocation` — never hardcoded.
    expect(result?.location.latitude).toBeCloseTo(51.1078, 2);
  });

  it("falls back to the seed current provider when the primary returns null", async () => {
    _clearCurrentWeatherCacheForTests();
    const primary = {
      id: "stub-primary",
      fetchMonthly: vi.fn().mockResolvedValue(null),
      fetchCurrent: vi.fn().mockResolvedValue(null),
    };
    const result = await getCurrentWeather({
      club: SILVER_SPRINGS_CLUB,
      provider: primary,
      bypassCache: true,
    });
    expect(primary.fetchCurrent).toHaveBeenCalledTimes(1);
    expect(result?.observation.provenance.source).toBe("seed-current");
    // Silver Springs is metric.
    expect(result?.observation.temperatureUnit).toBe("C");
    expect(result?.observation.locationLabel).toBe("Calgary");
  });

  it("does not throw when the primary provider raises — portal must render", async () => {
    _clearCurrentWeatherCacheForTests();
    const primary = {
      id: "stub-primary",
      fetchMonthly: vi.fn().mockResolvedValue(null),
      fetchCurrent: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    };
    const result = await getCurrentWeather({
      club: SILVER_SPRINGS_CLUB,
      provider: primary,
      bypassCache: true,
    });
    expect(result?.observation.provenance.source).toBe("seed-current");
  });

  it("caches the observation and does not re-hit the provider within the TTL window", async () => {
    _clearCurrentWeatherCacheForTests();
    const primary = {
      id: "stub-primary",
      fetchMonthly: vi.fn().mockResolvedValue(null),
      fetchCurrent: vi.fn().mockResolvedValue({
        observedAt: "2026-08-26T13:00:00Z",
        temperature: 15,
        temperatureUnit: "C" as const,
        condition: "clear" as const,
        isDay: true,
        windMph: 5,
        locationLabel: "Calgary",
        provenance: { source: "stub-primary-current", precision: "coordinate" as const },
      }),
    };
    await getCurrentWeather({ club: SILVER_SPRINGS_CLUB, provider: primary });
    await getCurrentWeather({ club: SILVER_SPRINGS_CLUB, provider: primary });
    await getCurrentWeather({ club: SILVER_SPRINGS_CLUB, provider: primary });
    expect(primary.fetchCurrent).toHaveBeenCalledTimes(1);
  });

  it("open-meteo current — sends coordinates + returns a normalised observation", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        current: {
          time: "2026-08-26T13:00",
          temperature_2m: 21.7,
          weather_code: 2,   // partly cloudy
          wind_speed_10m: 8.4,
          is_day: 1,
        },
      }),
    });
    const provider = createOpenMeteoProvider({ fetchFn: fetchSpy as unknown as typeof fetch });
    const obs = await provider.fetchCurrent({
      location: resolveClubLocation(SILVER_SPRINGS_CLUB),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain("latitude=51.1078");
    expect(url).toContain("longitude=-114.1815");
    expect(url).toContain("current=temperature_2m");
    expect(url).toContain("temperature_unit=celsius");
    expect(obs?.condition).toBe("partly-cloudy");
    expect(obs?.temperature).toBe(22);
    expect(obs?.temperatureUnit).toBe("C");
    expect(obs?.isDay).toBe(true);
    expect(obs?.locationLabel).toBe("Calgary");
    expect(obs?.provenance.source).toBe("open-meteo-forecast");
  });

  it("open-meteo current — returns null when the fetch throws", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const provider = createOpenMeteoProvider({ fetchFn: fetchSpy as unknown as typeof fetch });
    const obs = await provider.fetchCurrent({
      location: resolveClubLocation(SILVER_SPRINGS_CLUB),
    });
    expect(obs).toBeNull();
  });

  it("open-meteo current — returns null when the location has no coordinates", async () => {
    const fetchSpy = vi.fn();
    const provider = createOpenMeteoProvider({ fetchFn: fetchSpy as unknown as typeof fetch });
    const obs = await provider.fetchCurrent({
      location: {
        latitude: null,
        longitude: null,
        city: "—",
        region: "—",
        label: "Unknown Club",
        street: null,
        temperatureUnit: "F",
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(obs).toBeNull();
  });
});

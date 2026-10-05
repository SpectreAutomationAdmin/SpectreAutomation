// WEATHER-HIST-1 (2026-10-05) — resolver behaviour.
//
// Pure-function tests over `resolveClubLocation` + `fetchObservation`
// with an injected provider. No Prisma, no network.
//
// §1  ClubProfile coordinates win over any legacy address parsing.
// §2  No stored coordinates + city/provinceState present → city-
//     precision location with null coordinates.
// §3  No profile at all → fall back to legacy address parsing.
// §4  Two tenants with different ClubProfile coordinates get
//     different observations without any source-code changes
//     (TENANT PORTABILITY).
// §5  Changing the reporting period flips every period-derived
//     label (PERIOD REGRESSION).

import { describe, expect, it } from "vitest";
import { fetchObservation, resolveClubLocation } from "@/lib/reporting/weather";
import type {
  WeatherProvider,
  MonthlyWeatherObservation,
} from "@/lib/reporting/weather";

/** Minimal stub provider — echoes the location + period back as the
 *  observation so tests can assert what the resolver passed down. */
function makeEchoProvider(): WeatherProvider & {
  calls: Array<{ latitude: number | null; longitude: number | null; year: number; month: number }>;
} {
  const calls: Array<{ latitude: number | null; longitude: number | null; year: number; month: number }> = [];
  return {
    id: "stub-echo",
    calls,
    async fetchMonthly({ location, period }) {
      calls.push({
        latitude: location.latitude,
        longitude: location.longitude,
        year: period.year,
        month: period.month,
      });
      // Return a deterministic observation that encodes the queried
      // coordinates so tests can see what the resolver passed down.
      const result: MonthlyWeatherObservation = {
        yearMonth: `${period.year}-${String(period.month).padStart(2, "0")}`,
        daysSunny: 15,
        daysPartlyCloudy: 8,
        daysRain: 5,
        daysHighWind: 3,
        avgHighTempF: 65,
        avgWindMph: 11,
        avgRoundsSunny: 100,
        avgRoundsPartlyCloudy: 80,
        avgRoundsHighWind: 40,
        avgRoundsRain: 20,
        notableEvents: [],
        provenance: {
          source: "stub-echo",
          precision: "coordinate",
          queriedLatitude: location.latitude ?? undefined,
          queriedLongitude: location.longitude ?? undefined,
        },
      };
      return result;
    },
    async fetchCurrent() {
      return null;
    },
  };
}

describe("WEATHER-HIST-1 §1 — ClubProfile coordinates win over legacy address", () => {
  it("uses profile.latitude + profile.longitude when both are set", () => {
    const loc = resolveClubLocation({
      name: "Any Club",
      address: "1 Fairway, Phoenix, AZ", // intentionally different from profile
      region: "Arizona",
      profile: {
        latitude: 51.4636,
        longitude: -112.7208,
        city: "Drumheller",
        provinceState: "Alberta",
        physicalAddress: "Drumheller, Alberta",
      },
    });
    expect(loc.latitude).toBe(51.4636);
    expect(loc.longitude).toBe(-112.7208);
    expect(loc.city).toBe("Drumheller");
    expect(loc.region).toBe("Alberta");
    expect(loc.label).toBe("Drumheller, Alberta");
    expect(loc.temperatureUnit).toBe("C");
  });

  it("tolerates string lat/lng (Prisma Decimal on SQLite)", () => {
    const loc = resolveClubLocation({
      name: "Any Club",
      profile: {
        latitude: "40.7128",
        longitude: "-74.0060",
        city: "New York",
        provinceState: "New York",
      },
    });
    expect(loc.latitude).toBe(40.7128);
    expect(loc.longitude).toBe(-74.006);
    expect(loc.temperatureUnit).toBe("F");
  });

  it("tolerates Prisma Decimal-shaped { toString() } for lat/lng", () => {
    const loc = resolveClubLocation({
      name: "Any Club",
      profile: {
        latitude: { toString: () => "25.7617" },
        longitude: { toString: () => "-80.1918" },
        city: "Miami",
        provinceState: "Florida",
      },
    });
    expect(loc.latitude).toBe(25.7617);
    expect(loc.longitude).toBe(-80.1918);
  });
});

describe("WEATHER-HIST-1 §2 — city/province without coords → null coordinates", () => {
  it("returns city label with null coords when profile has no lat/lng", () => {
    const loc = resolveClubLocation({
      name: "Any Club",
      profile: {
        latitude: null,
        longitude: null,
        city: "Hamilton",
        provinceState: "Ontario",
      },
    });
    expect(loc.latitude).toBeNull();
    expect(loc.longitude).toBeNull();
    expect(loc.city).toBe("Hamilton");
    expect(loc.region).toBe("Ontario");
    expect(loc.label).toBe("Hamilton, Ontario");
    expect(loc.temperatureUnit).toBe("C");
  });
});

describe("WEATHER-HIST-1 §3 — no profile → legacy address parsing", () => {
  it("parses the city out of a 'Street, City, Province' address string", () => {
    const loc = resolveClubLocation({
      name: "Legacy Club",
      address: "1 Fairway Lane, Hamilton, ON",
      region: "Ontario",
    });
    expect(loc.city).toBe("Hamilton");
    expect(loc.region).toBe("Ontario");
    expect(loc.latitude).toBeNull();
    expect(loc.longitude).toBeNull();
    expect(loc.temperatureUnit).toBe("C");
  });

  it("falls back to club name as label when the address can't be parsed", () => {
    const loc = resolveClubLocation({
      name: "Mystery Club",
      address: null,
      region: null,
    });
    expect(loc.label).toBe("Mystery Club");
    expect(loc.city).toBe("—");
    expect(loc.region).toBe("—");
    expect(loc.temperatureUnit).toBe("F");
  });
});

describe("WEATHER-HIST-1 §4 — tenant portability: profile coordinates drive the observation", () => {
  it("two tenants with different ClubProfile coordinates get different Open-Meteo queries", async () => {
    const stub = makeEchoProvider();

    // Tenant A — Drumheller, AB
    await fetchObservation({
      club: {
        name: "Tenant A",
        profile: {
          latitude: 51.4636,
          longitude: -112.7208,
          city: "Drumheller",
          provinceState: "Alberta",
        },
      },
      period: { year: 2026, month: 1, monthShort: "Jan" },
      provider: stub,
    });

    // Tenant B — Hamilton, ON
    await fetchObservation({
      club: {
        name: "Tenant B",
        profile: {
          latitude: 43.2557,
          longitude: -79.8711,
          city: "Hamilton",
          provinceState: "Ontario",
        },
      },
      period: { year: 2026, month: 1, monthShort: "Jan" },
      provider: stub,
    });

    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0].latitude).toBe(51.4636);
    expect(stub.calls[0].longitude).toBe(-112.7208);
    expect(stub.calls[1].latitude).toBe(43.2557);
    expect(stub.calls[1].longitude).toBe(-79.8711);
  });
});

describe("WEATHER-HIST-1 §5 — reporting-period regression", () => {
  it("flipping period flips the yearMonth the provider is asked for", async () => {
    const stub = makeEchoProvider();
    await fetchObservation({
      club: {
        name: "T",
        profile: { latitude: 51.4636, longitude: -112.7208, city: "Drumheller", provinceState: "Alberta" },
      },
      period: { year: 2026, month: 1, monthShort: "Jan" },
      provider: stub,
    });
    await fetchObservation({
      club: {
        name: "T",
        profile: { latitude: 51.4636, longitude: -112.7208, city: "Drumheller", provinceState: "Alberta" },
      },
      period: { year: 2026, month: 7, monthShort: "Jul" },
      provider: stub,
    });
    expect(stub.calls[0].year).toBe(2026);
    expect(stub.calls[0].month).toBe(1);
    expect(stub.calls[1].year).toBe(2026);
    expect(stub.calls[1].month).toBe(7);
  });
});

describe("WEATHER-HIST-1 §6 — fingerprint-free: no clubName-based branching", () => {
  it("profiles with identical coordinates return identical locations regardless of club name", () => {
    const a = resolveClubLocation({
      name: "Coulee Ridge Golf & Country Club",
      profile: { latitude: 51.4636, longitude: -112.7208, city: "Drumheller", provinceState: "Alberta" },
    });
    const b = resolveClubLocation({
      name: "Totally Fictional Club",
      profile: { latitude: 51.4636, longitude: -112.7208, city: "Drumheller", provinceState: "Alberta" },
    });
    expect(a.latitude).toBe(b.latitude);
    expect(a.longitude).toBe(b.longitude);
    expect(a.city).toBe(b.city);
    expect(a.region).toBe(b.region);
    expect(a.label).toBe(b.label);
    expect(a.temperatureUnit).toBe(b.temperatureUnit);
  });

  it("clubs with no profile and no Drumheller fingerprint do NOT resolve to Drumheller", () => {
    const loc = resolveClubLocation({
      name: "Coulee Ridge Golf & Country Club",
      address: null,
      region: null,
      profile: null,
    });
    // Pre-WEATHER-HIST-1 this returned Drumheller coordinates. The
    // hardcoded fingerprint is GONE — the resolver returns the
    // "unknown location" shape instead.
    expect(loc.latitude).toBeNull();
    expect(loc.longitude).toBeNull();
    expect(loc.city).toBe("—");
    expect(loc.region).toBe("—");
  });
});

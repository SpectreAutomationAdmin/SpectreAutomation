// WEATHER-HIST-1 (2026-10-05) — source-contract pins.
//
// §A  The hardcoded Coulee/Drumheller tenant fingerprint is GONE.
// §B  The resolver reads from `club.profile` first (ClubProfile fields),
//     then falls back to parsed `address`/`region`, then to safe
//     defaults. No `clubName === "..."` or `city === "..."` branches.
// §C  `ClubProfile.latitude` / `.longitude` / `.locationGeocodedAt` +
//     `WeatherObservationCache` live on the Prisma schema (both the
//     SQLite dev schema and the Postgres schema).
// §D  Section XI live builder exists + emits `dataSource: "live"`.
// §E  monthly-package.ts wires live tenants to the canonical builder;
//     demo tenants keep the Silver Springs seed.
// §F  Redactor preserves `dataSource: "live"` Section XI (does not
//     wipe to UNAVAILABLE when training mode is active).
// §G  Open-Meteo provider receives DYNAMIC coordinates from the
//     resolver — never a hardcoded tenant value.
// §H  Geocoding helper is invoked from the ClubProfile upsert path,
//     NOT from any Section XI builder / per-report render path.
// §I  Weather cache invalidation on location change wired into the
//     ClubProfile upsert.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const CLUB_LOCATION  = path.join(REPO, "src/lib/reporting/weather/club-location.ts");
const WEATHER_INDEX  = path.join(REPO, "src/lib/reporting/weather/index.ts");
const OPEN_METEO     = path.join(REPO, "src/lib/reporting/weather/open-meteo-provider.ts");
const GEOCODE        = path.join(REPO, "src/lib/reporting/weather/geocode.ts");
const CACHE          = path.join(REPO, "src/lib/reporting/weather/observation-cache.ts");
const SECTION_XI     = path.join(REPO, "src/lib/reporting/monthly-weather-summary.ts");
const MONTHLY        = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const SQLITE_SCHEMA  = path.join(REPO, "prisma/schema.prisma");
const PG_SCHEMA      = path.join(REPO, "prisma-postgres/schema.prisma");
const PROFILE_SVC    = path.join(REPO, "src/lib/clubs/profile.ts");

/** Strip JS line + block comments so pattern tests only inspect
 *  executable code, not informative comments that may legitimately
 *  cite the patterns they forbid. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

describe("WEATHER-HIST-1 §A — hardcoded Coulee/Drumheller fingerprint removed", () => {
  const src = stripComments(readFileSync(CLUB_LOCATION, "utf8"));

  it("no hardcoded KNOWN_CLUBS array in the resolver", () => {
    expect(src).not.toMatch(/KNOWN_CLUBS/);
  });

  it("no hardcoded Coulee / Drumheller / Silver Springs fingerprints in CODE", () => {
    expect(src).not.toMatch(/coulee/i);
    expect(src).not.toMatch(/drumheller/i);
    expect(src).not.toMatch(/silver[\s-]?springs/i);
  });

  it("no hardcoded coordinates in the resolver CODE", () => {
    // 51.4636 (Drumheller) and 51.1078 (Calgary Silver Springs) were
    // the two fingerprint coordinates. Any residual decimal looking
    // like a lat/lng pair in code would re-introduce tenant-specific
    // baked-in location data.
    expect(src).not.toMatch(/51\.46/);
    expect(src).not.toMatch(/51\.10/);
    expect(src).not.toMatch(/-?112\.72/);
    expect(src).not.toMatch(/-?114\.18/);
  });

  it("no clubName or city equality branches in CODE", () => {
    expect(src).not.toMatch(/clubName\s*===/);
    expect(src).not.toMatch(/club\.name\s*===/);
    expect(src).not.toMatch(/city\s*===/);
  });
});

describe("WEATHER-HIST-1 §B — resolver reads from ClubProfile", () => {
  const src = readFileSync(CLUB_LOCATION, "utf8");

  it("ClubLike exposes an optional `profile` back-ref", () => {
    expect(src).toMatch(/profile\?: ClubProfileLike \| null;/);
  });

  it("ClubProfileLike declares latitude + longitude + city + provinceState + physicalAddress", () => {
    expect(src).toMatch(/latitude\?: number \| string \| DecimalLike \| null;/);
    expect(src).toMatch(/longitude\?: number \| string \| DecimalLike \| null;/);
    expect(src).toMatch(/city\?: string \| null;/);
    expect(src).toMatch(/provinceState\?: string \| null;/);
    expect(src).toMatch(/physicalAddress\?: string \| null;/);
  });

  it("resolveClubLocation reads profile BEFORE address/region", () => {
    const idx = src.indexOf("export function resolveClubLocation");
    const body = idx >= 0 ? src.slice(idx) : "";
    const profilePos = body.search(/profile\?/) >= 0 ? body.indexOf("const profile") : -1;
    const addressPos = body.indexOf("club.address");
    expect(profilePos).toBeGreaterThan(-1);
    expect(addressPos).toBeGreaterThan(profilePos);
  });

  it("resolver returns coordinates from the profile when both are supplied", () => {
    const idx = src.indexOf("export function resolveClubLocation");
    const body = idx >= 0 ? src.slice(idx) : "";
    expect(body).toMatch(/latitude: lat,/);
    expect(body).toMatch(/longitude: lng,/);
  });
});

describe("WEATHER-HIST-1 §C — schema carries lat/lng + WeatherObservationCache", () => {
  it("SQLite schema: ClubProfile has latitude, longitude, locationGeocodedAt", () => {
    const src = readFileSync(SQLITE_SCHEMA, "utf8");
    const idx = src.indexOf("model ClubProfile");
    const body = idx >= 0 ? src.slice(idx, idx + 4000) : "";
    expect(body).toMatch(/latitude\s+Decimal\?/);
    expect(body).toMatch(/longitude\s+Decimal\?/);
    expect(body).toMatch(/locationGeocodedAt\s+DateTime\?/);
  });

  it("SQLite schema: WeatherObservationCache model defined", () => {
    const src = readFileSync(SQLITE_SCHEMA, "utf8");
    expect(src).toMatch(/model WeatherObservationCache \{/);
    expect(src).toMatch(/@@unique\(\[clubId, yearMonth, latitude, longitude\]\)/);
  });

  it("Postgres schema: ClubProfile has latitude, longitude, locationGeocodedAt", () => {
    const src = readFileSync(PG_SCHEMA, "utf8");
    const idx = src.indexOf("model ClubProfile");
    const body = idx >= 0 ? src.slice(idx, idx + 4000) : "";
    expect(body).toMatch(/latitude\s+Decimal\?\s+@db\.Decimal\(9, 6\)/);
    expect(body).toMatch(/longitude\s+Decimal\?\s+@db\.Decimal\(9, 6\)/);
    expect(body).toMatch(/locationGeocodedAt\s+DateTime\?/);
  });

  it("Postgres schema: WeatherObservationCache model defined", () => {
    const src = readFileSync(PG_SCHEMA, "utf8");
    expect(src).toMatch(/model WeatherObservationCache \{/);
    expect(src).toMatch(/@@unique\(\[clubId, yearMonth, latitude, longitude\]\)/);
  });
});

describe("WEATHER-HIST-1 §D — Section XI live builder emits dataSource: 'live'", () => {
  const src = readFileSync(SECTION_XI, "utf8");

  it("buildCouleeMonthlyWeatherSummary is exported + async + takes clubId", () => {
    expect(src).toMatch(/export async function buildCouleeMonthlyWeatherSummary\(opts: \{[\s\S]*?clubId: string;/);
  });

  it("live builder calls fetchObservation with the resolved club + clubId", () => {
    const idx = src.indexOf("export async function buildCouleeMonthlyWeatherSummary");
    const body = idx >= 0 ? src.slice(idx) : "";
    expect(body).toMatch(/await fetchObservation\(\{[\s\S]*?club,[\s\S]*?clubId,/);
  });

  it("live builder returns dataSource: 'live'", () => {
    const idx = src.indexOf("export async function buildCouleeMonthlyWeatherSummary");
    const body = idx >= 0 ? src.slice(idx) : "";
    expect(body).toMatch(/dataSource: "live"/);
  });

  it("live builder emits partial-availability sentinels for utilization-dependent sections", () => {
    const idx = src.indexOf("export async function buildCouleeMonthlyWeatherSummary");
    const body = idx >= 0 ? src.slice(idx) : "";
    // Rounds-by-weather chart is unavailable (Tee Sheet pending).
    expect(body).toMatch(/Rounds-by-weather analysis unavailable/);
    // Correlation cards name the pending integration.
    expect(body).toMatch(/Tee Sheet integration not yet connected/);
    expect(body).toMatch(/Racquet booking source[\s\S]*?not yet connected/);
    expect(body).toMatch(/POS source not yet connected/);
    // Events table rows are empty (operational-impact data unavailable).
    expect(body).toMatch(/rows: \[\] as ReadonlyArray<WeatherEventRow>/);
  });

  it("live builder has no hardcoded tenant branches in CODE", () => {
    // Scope to the function body only (skip the function NAME which
    // intentionally includes "Coulee" as the live-tenant convention
    // used by Chapter X and Chapter XII in the same package).
    const idx = src.indexOf("export async function buildCouleeMonthlyWeatherSummary");
    const bodyFull = idx >= 0 ? src.slice(idx) : "";
    const openBrace = bodyFull.indexOf("{");
    const body = stripComments(bodyFull.slice(openBrace));
    expect(body).not.toMatch(/\bcoulee\b/i);
    expect(body).not.toMatch(/\bdrumheller\b/i);
    // The function name itself appears in the slice but it's up at
    // the signature. Just-the-body check: no literal coordinates
    // either.
    expect(body).not.toMatch(/51\.46/);
    expect(body).not.toMatch(/-?112\.72/);
  });
});

describe("WEATHER-HIST-1 §E — monthly-package wires live tenants to canonical builder", () => {
  const src = readFileSync(MONTHLY, "utf8");

  it("monthly-package imports buildCouleeMonthlyWeatherSummary", () => {
    expect(src).toMatch(/buildCouleeMonthlyWeatherSummary/);
  });

  it("Section XI picks the canonical live builder when hasRealData is true", () => {
    expect(src).toMatch(/monthlyWeatherSummary: hasRealData\s*\?\s*await buildCouleeMonthlyWeatherSummary\(\{[\s\S]*?clubId: club\.id,/);
  });

  it("Section XI falls back to buildSilverSpringsMonthlyWeatherSummary for demo tenants", () => {
    expect(src).toMatch(/: await buildSilverSpringsMonthlyWeatherSummary\(\{/);
  });

  it("club.findUnique selects the ClubProfile backref with lat/lng + city/provinceState", () => {
    const idx = src.indexOf("const club = await prisma.club.findUnique");
    const body = idx >= 0 ? src.slice(idx, idx + 2000) : "";
    expect(body).toMatch(/profile: \{[\s\S]*?latitude: true,[\s\S]*?longitude: true,[\s\S]*?city: true,[\s\S]*?provinceState: true,[\s\S]*?physicalAddress: true,/);
  });
});

describe("WEATHER-HIST-1 §F — redactor preserves live Section XI", () => {
  const src = readFileSync(MONTHLY, "utf8");
  it("Chapter XI redactor matches the Chapter X / XII contract: wipe only when dataSource !== 'live'", () => {
    const block = src.match(/monthlyWeatherSummary:[\s\S]*?pkg\.monthlyWeatherSummary\.dataSource === "live"[\s\S]*?: makeUnavailable\(pkg\.monthlyWeatherSummary, u\),/)?.[0];
    expect(block).toBeTruthy();
  });
});

describe("WEATHER-HIST-1 §G — Open-Meteo receives dynamic coordinates", () => {
  const src = readFileSync(OPEN_METEO, "utf8");

  it("provider reads lat/lng from location argument — not hardcoded", () => {
    expect(src).toMatch(/latitude: String\(location\.latitude\)/);
    expect(src).toMatch(/longitude: String\(location\.longitude\)/);
  });

  it("provider returns null when the caller has no coordinates", () => {
    expect(src).toMatch(/if \(location\.latitude == null \|\| location\.longitude == null\) \{\s*return null;\s*\}/);
  });

  it("no hardcoded fingerprints in the provider", () => {
    expect(src).not.toMatch(/51\.46/);
    expect(src).not.toMatch(/51\.10/);
    expect(src).not.toMatch(/drumheller/i);
    expect(src).not.toMatch(/coulee/i);
  });
});

describe("WEATHER-HIST-1 §H — geocoding is setup-time only", () => {
  it("geocode helper exists at the dedicated module", () => {
    const src = readFileSync(GEOCODE, "utf8");
    expect(src).toMatch(/export async function geocodeClubProfileAddress/);
    expect(src).toMatch(/geocoding-api\.open-meteo\.com\/v1\/search/);
  });

  it("Section XI builder NEVER imports the geocoding helper", () => {
    const src = readFileSync(SECTION_XI, "utf8");
    expect(src).not.toMatch(/geocodeClubProfileAddress/);
    expect(src).not.toMatch(/weather\/geocode/);
  });

  it("Open-Meteo provider NEVER imports the geocoding helper", () => {
    const src = readFileSync(OPEN_METEO, "utf8");
    expect(src).not.toMatch(/geocodeClubProfileAddress/);
    expect(src).not.toMatch(/weather\/geocode/);
  });

  it("ClubProfile upsert path imports the geocoding helper", () => {
    const src = readFileSync(PROFILE_SVC, "utf8");
    expect(src).toMatch(/import \{ geocodeClubProfileAddress \} from "@\/lib\/reporting\/weather\/geocode"/);
  });
});

describe("WEATHER-HIST-1 §I — weather cache invalidation on location change", () => {
  const src = readFileSync(PROFILE_SVC, "utf8");

  it("ClubProfile upsert imports invalidateWeatherCacheForClub", () => {
    expect(src).toMatch(/import \{ invalidateWeatherCacheForClub \} from "@\/lib\/reporting\/weather\/observation-cache"/);
  });

  it("ClubProfile upsert calls invalidateWeatherCacheForClub when lat/lng change", () => {
    expect(src).toMatch(/if \(locationChanged\) \{\s*await invalidateWeatherCacheForClub\(clubId\);/);
  });

  it("WeatherObservationCache service exports upsert + lookup + invalidate", () => {
    const cacheSrc = readFileSync(CACHE, "utf8");
    expect(cacheSrc).toMatch(/export async function readWeatherCache/);
    expect(cacheSrc).toMatch(/export async function writeWeatherCache/);
    expect(cacheSrc).toMatch(/export async function invalidateWeatherCacheForClub/);
  });
});

describe("WEATHER-HIST-1 §J — fetchObservation participates in persistent cache", () => {
  const src = readFileSync(WEATHER_INDEX, "utf8");

  it("fetchObservation accepts a clubId + enables cache reads", () => {
    expect(src).toMatch(/clubId\?: string \| null;/);
    expect(src).toMatch(/await readWeatherCache\(\{/);
  });

  it("fetchObservation persists live observations to the cache (fire-and-forget)", () => {
    expect(src).toMatch(/void writeWeatherCache\(\{/);
  });

  it("default provider is Open-Meteo (not seed)", () => {
    expect(src).toMatch(/\?? "open-meteo"/);
  });
});

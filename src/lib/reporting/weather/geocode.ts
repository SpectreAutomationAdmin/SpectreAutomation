// Setup-time geocoding helper — Open-Meteo /v1/search.
//
// WEATHER-HIST-1 (2026-10-05) — invoked ONLY from the ClubProfile
// upsert path (via `src/lib/clubs/profile.ts`) and the admin
// "Resolve Location" API endpoint. NEVER called per-report render.
// The output is persisted to `ClubProfile.latitude` + `.longitude` +
// `.locationGeocodedAt`; subsequent weather reads flow through the
// stored coordinates without ever contacting the geocoding endpoint
// again (unless the operator clears the fields).
//
// Open-Meteo geocoding is free + key-less:
//   https://geocoding-api.open-meteo.com/v1/search?name={city}&count=1
//
// The response includes `latitude`, `longitude`, `country`, `admin1`
// (province/state). We pick the first result where `country_code`
// matches the caller's country (CA for Canadian clubs by default) and
// `admin1` matches the supplied provinceState (case-insensitive) when
// provided. If no match is found, returns `null`; the caller then
// persists the city/provinceState alone and the resolver falls back
// to seed observations until the operator supplies coordinates
// manually.

const GEOCODING_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";

export type GeocodeInput = {
  /** City name — e.g. "Drumheller". Required. */
  city: string;
  /** Province or state — e.g. "Alberta", "AB", "Arizona", "AZ".
   *  Optional; narrows the match when supplied. */
  provinceState?: string | null;
  /** ISO 3166-1 alpha-2 country code — e.g. "CA", "US". Optional;
   *  defaults to Canada (clubs are North American in this product).
   *  Clubs outside those two countries should pass this explicitly. */
  countryCode?: string | null;
  /** Test seam — stubbable fetch. */
  fetchFn?: typeof globalThis.fetch;
};

export type GeocodeResult = {
  latitude: number;
  longitude: number;
  resolvedCity: string;
  resolvedProvinceState: string | null;
  resolvedCountryCode: string;
};

type OpenMeteoGeocodingResponse = {
  results?: Array<{
    name?: string;
    latitude?: number;
    longitude?: number;
    country_code?: string;
    admin1?: string;
  }>;
};

/** Canonicalise a region token to a lower-case single-word form so
 *  "Alberta" / "alberta" / "AB" / "ab" compare equal against the
 *  provinceState facet Open-Meteo returns (which may be either
 *  spelled out or abbreviated depending on the source gazetteer). */
function normalizeRegion(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Resolve `{city, provinceState}` to a lat/lng pair via Open-Meteo
 * geocoding. Returns `null` when no match is found.
 *
 * MUST be invoked from the ClubProfile upsert path or the explicit
 * admin "resolve location" endpoint — never from Section XI builders
 * or any per-report render path. The cost of a lookup is a single
 * upstream HTTP request + a persistent write of the result.
 */
export async function geocodeClubProfileAddress(
  input: GeocodeInput,
): Promise<GeocodeResult | null> {
  const city = input.city?.trim();
  if (!city) return null;
  const f: typeof globalThis.fetch = input.fetchFn ?? (globalThis.fetch as typeof globalThis.fetch);
  const country = (input.countryCode ?? "CA").toUpperCase();
  const params = new URLSearchParams({
    name: city,
    count: "10",
    language: "en",
    format: "json",
  });
  let payload: OpenMeteoGeocodingResponse;
  try {
    const res = await f(`${GEOCODING_ENDPOINT}?${params.toString()}`);
    if (!res.ok) return null;
    payload = (await res.json()) as OpenMeteoGeocodingResponse;
  } catch {
    return null;
  }
  const results = Array.isArray(payload.results) ? payload.results : [];
  if (!results.length) return null;

  const wantedRegion = normalizeRegion(input.provinceState);

  // Prefer: country match + province match.
  for (const r of results) {
    if ((r.country_code ?? "").toUpperCase() !== country) continue;
    const admin1 = normalizeRegion(r.admin1);
    if (wantedRegion && admin1 !== wantedRegion) {
      // Also allow postal-code vs full-name near-match. "ab" matches
      // "alberta" when the input was the postal code.
      const admin1Short = admin1
        .split(" ")
        .map((w) => w[0])
        .filter(Boolean)
        .join("");
      if (!(admin1Short === wantedRegion || admin1 === wantedRegion)) continue;
    }
    if (r.latitude == null || r.longitude == null) continue;
    return {
      latitude: r.latitude,
      longitude: r.longitude,
      resolvedCity: r.name ?? city,
      resolvedProvinceState: r.admin1 ?? null,
      resolvedCountryCode: country,
    };
  }

  // Fallback: first country match without province filter.
  for (const r of results) {
    if ((r.country_code ?? "").toUpperCase() !== country) continue;
    if (r.latitude == null || r.longitude == null) continue;
    return {
      latitude: r.latitude,
      longitude: r.longitude,
      resolvedCity: r.name ?? city,
      resolvedProvinceState: r.admin1 ?? null,
      resolvedCountryCode: country,
    };
  }

  // Fallback: first result at all (no country constraint).
  const first = results.find((r) => r.latitude != null && r.longitude != null);
  if (!first) return null;
  return {
    latitude: first.latitude as number,
    longitude: first.longitude as number,
    resolvedCity: first.name ?? city,
    resolvedProvinceState: first.admin1 ?? null,
    resolvedCountryCode: (first.country_code ?? country).toUpperCase(),
  };
}

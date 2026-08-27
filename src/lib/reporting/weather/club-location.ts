// Resolve a `WeatherLocation` from a Club's stored settings.
//
// The Prisma `Club` model carries `address` (free-text street),
// `region` (province/state name), and `name`. There is no dedicated
// `latitude`/`longitude` column yet, so this resolver maintains a
// small known-club index for the seeded clubs the founder demos
// against (today: Silver Springs in NW Calgary). For an unknown
// club, the resolver returns a city-precision location parsed from
// `address` + `region`; the upstream provider then falls back to
// the seed lookup when coordinates are missing.

import type { WeatherLocation } from "./types";

type KnownClubFingerprint = {
  /** Substring match against `club.slug` OR `club.name` (case-insensitive). */
  pattern: RegExp;
  resolve: (club: ClubLike) => WeatherLocation;
};

/** Subset of the Prisma Club fields this resolver consumes. The
 *  reporting service passes the live Prisma object; tests pass a
 *  literal that satisfies this shape. */
export type ClubLike = {
  name: string;
  slug?: string | null;
  address?: string | null;
  region?: string | null;
};

const KNOWN_CLUBS: ReadonlyArray<KnownClubFingerprint> = [
  {
    // Silver Springs Golf & Country Club — the seed demo club. The
    // real club sits in the Silver Springs neighborhood of NW
    // Calgary on the north bank of the Bow River.
    pattern: /silver[\s-]?springs/i,
    resolve: () => ({
      latitude: 51.1078,
      longitude: -114.1815,
      city: "Calgary",
      region: "Alberta",
      label: "NW Calgary, Alberta",
      street: "1 Fairway Lane, Calgary, AB",
      temperatureUnit: "C",
    }),
  },
  {
    // Coulee Ridge Golf & Country Club — the founder-review staging
    // tenant. Not a real course; placed near Cochrane, Alberta (the
    // Club.timezone is `America/Edmonton`, and "coulee" is Alberta
    // prairie vocabulary) so Open-Meteo returns realistic conditions
    // for the demo. This fingerprint will be replaced by a proper
    // `Club.latitude` / `Club.longitude` migration in a future pass.
    pattern: /coulee[\s-]?ridge/i,
    resolve: () => ({
      latitude: 51.1892,
      longitude: -114.4681,
      city: "Cochrane",
      region: "Alberta",
      label: "Cochrane, Alberta",
      street: null,
      temperatureUnit: "C",
    }),
  },
];

/**
 * Canadian provinces / territories — full names AND their two-letter
 * postal codes (case-insensitive). Used to pick the presentation
 * temperature unit (°C for Canada, °F otherwise).
 *
 * NOTE: the two-letter `BC` lives outside the list because it overlaps
 * with the postal-code shorthand for British Columbia and could be
 * intentionally meant as such; matching is exact / boundary-anchored.
 */
const CANADIAN_REGION_TOKENS = new Set<string>([
  // Full names
  "alberta",
  "british columbia",
  "manitoba",
  "new brunswick",
  "newfoundland and labrador",
  "newfoundland",
  "nova scotia",
  "nunavut",
  "northwest territories",
  "ontario",
  "prince edward island",
  "quebec",
  "saskatchewan",
  "yukon",
  // Two-letter postal codes
  "ab", "bc", "mb", "nb", "nl", "ns", "nt", "nu", "on", "pe", "qc", "sk", "yt",
]);

/** Resolve the presentation temperature unit for a region string.
 *  Canada → °C; everywhere else (today: US, default) → °F. */
function temperatureUnitForRegion(region: string | null | undefined): "C" | "F" {
  if (!region) return "F";
  const norm = region.trim().toLowerCase();
  if (CANADIAN_REGION_TOKENS.has(norm)) return "C";
  // Country tokens — useful when a club's `region` carries the country.
  if (norm === "canada") return "C";
  return "F";
}

/**
 * Parse a "Street, City, Province" address into city + region facets.
 * Falls back to the supplied `region` for the province if the address
 * tail does not contain a recognisable region token.
 */
function parseAddressCity(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  // Conventional Canadian format: "1 Fairway Lane, Calgary, AB" →
  // city is the second-to-last comma-separated segment.
  if (parts.length >= 3) return parts[parts.length - 2];
  if (parts.length === 2) return parts[0];
  return null;
}

/**
 * Resolve the best `WeatherLocation` we know how to produce for the
 * supplied club. Coordinates are returned when the club matches one
 * of the known fingerprints; otherwise the city + region come from
 * `address`/`region` and lat/long are null (the provider then knows
 * to fall back to the seed lookup).
 */
export function resolveClubLocation(club: ClubLike): WeatherLocation {
  for (const fp of KNOWN_CLUBS) {
    if (fp.pattern.test(club.name) || (club.slug && fp.pattern.test(club.slug))) {
      return fp.resolve(club);
    }
  }
  const parsedCity = parseAddressCity(club.address);
  const parsedRegion = club.region ?? null;
  const city = parsedCity ?? "—";
  const region = parsedRegion ?? "—";
  // Only build a "City, Region" label when we have real values for
  // both — otherwise fall back to the club name so the panel never
  // displays "—, —" placeholder noise.
  const label =
    parsedCity && parsedRegion ? `${parsedCity}, ${parsedRegion}` : club.name;
  return {
    latitude: null,
    longitude: null,
    city,
    region,
    label,
    street: club.address ?? null,
    // Pick °C / °F from the parsed region. Fingerprinted clubs in
    // KNOWN_CLUBS override this with their own explicit unit.
    temperatureUnit: temperatureUnitForRegion(parsedRegion),
  };
}

// Re-export for tests + downstream services that need the rule in
// isolation (e.g. the migration that backfills a `temperatureUnit`
// column on Club once the founder approves it).
export { temperatureUnitForRegion };

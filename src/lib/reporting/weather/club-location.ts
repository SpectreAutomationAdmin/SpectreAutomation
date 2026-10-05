// Resolve a `WeatherLocation` from a Club + its ClubProfile.
//
// WEATHER-HIST-1 (2026-10-05) — canonical tenant-geographic resolution.
// The SINGLE SOURCE OF TRUTH for a club's physical location is the
// `ClubProfile` row (fields: `latitude`, `longitude`, `city`,
// `provinceState`, `physicalAddress`). This resolver NEVER contains
// per-tenant fingerprints, per-tenant coordinates, or
// `clubName === "..."` / `city === "..."` branches. All tenants —
// including the staging Coulee Ridge tenant — flow through the same
// path: operator-configured ClubProfile fields → canonical resolver.
//
// Precedence:
//   1. `profile.latitude` + `profile.longitude` (both non-null) →
//      coordinate-precision location. Open-Meteo archive queries use
//      these dynamically. This is the authoritative path.
//   2. `profile.city` + `profile.provinceState` (both non-null) →
//      city-precision location with `latitude = longitude = null`.
//      The provider upstream then falls back to the seed observation.
//      Operators can bump a tenant to coordinate-precision via the
//      setup-time `geocodeClubProfileAddress()` helper.
//   3. Legacy `club.address` + `club.region` → best-effort city/region
//      parsing (preserved so existing Employee Portal + Work Intake
//      hero callers that pass only the Club row continue to render a
//      city label, albeit with null coordinates).
//   4. Nothing resolvable → `city = "—"`, `region = "—"`, label = club
//      name; coordinates null; provider falls back to seed.
//
// Open-Meteo receives the coordinates DYNAMICALLY from whatever
// ClubProfile row the caller supplies. Changing a tenant's lat/lng in
// ClubProfile changes the Section XI data the next time it renders
// (minus the cache; cache invalidation lives in `observation-cache.ts`).

import type { WeatherLocation } from "./types";

/**
 * Structural shape for a Prisma `Decimal` value — accepted alongside
 * plain JS numbers / strings so callers can pass the raw Prisma row
 * without converting first. Decimals from `prisma.clubProfile.findX`
 * arrive as `Decimal` instances (decimal.js); the resolver calls
 * `Number(v)` after a `v.toString()` round-trip.
 */
export type DecimalLike = { toString(): string };

/**
 * Subset of the Prisma ClubProfile fields this resolver consumes.
 * Supplied by the caller — the resolver itself NEVER queries Prisma
 * (keeps it a pure function, easy to test, and lets the caller control
 * tenant-scope on the fetch).
 */
export type ClubProfileLike = {
  latitude?: number | string | DecimalLike | null;
  longitude?: number | string | DecimalLike | null;
  city?: string | null;
  provinceState?: string | null;
  physicalAddress?: string | null;
};

/**
 * Subset of the Prisma Club fields this resolver consumes. The
 * reporting service passes the live Prisma object plus its
 * `profile` back-ref; the Employee Portal + Work Intake callers pass
 * only the top-level Club fields and the resolver falls back to
 * address parsing.
 */
export type ClubLike = {
  name: string;
  slug?: string | null;
  /** Legacy free-text street — used only when ClubProfile fields
   *  are empty. */
  address?: string | null;
  /** Legacy region string — used only when ClubProfile fields are
   *  empty. */
  region?: string | null;
  /** The authoritative source of tenant geographic data. When
   *  supplied + populated, overrides the legacy `address`/`region`
   *  parsing. */
  profile?: ClubProfileLike | null;
};

/**
 * Canadian provinces / territories — full names AND their two-letter
 * postal codes (case-insensitive). Used to pick the presentation
 * temperature unit (°C for Canada, °F otherwise).
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
export function temperatureUnitForRegion(region: string | null | undefined): "C" | "F" {
  if (!region) return "F";
  const norm = region.trim().toLowerCase();
  if (CANADIAN_REGION_TOKENS.has(norm)) return "C";
  if (norm === "canada") return "C";
  return "F";
}

/**
 * Parse a "Street, City, Province" address into the city facet.
 */
function parseAddressCity(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2];
  if (parts.length === 2) return parts[0];
  return null;
}

/**
 * Coerce a `number | string | Decimal | null | undefined` lat/lng
 * value to a finite JS `number`, or `null` when the input is absent /
 * malformed. Guards against Prisma `Decimal` arriving as an object
 * instance with `.toString()`, OR as a bare string on SQLite dev.
 */
function toFiniteNumber(v: number | string | DecimalLike | null | undefined): number | null {
  if (v == null) return null;
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string"
      ? Number(v)
      : Number(v.toString());
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the best `WeatherLocation` we know how to produce for the
 * supplied club. Reads from `club.profile` first; falls back to
 * `club.address`/`club.region` only when the profile fields are
 * absent / empty.
 */
export function resolveClubLocation(club: ClubLike): WeatherLocation {
  const profile = club.profile ?? null;
  const lat = toFiniteNumber(profile?.latitude ?? null);
  const lng = toFiniteNumber(profile?.longitude ?? null);
  const profileCity = profile?.city?.trim() || null;
  const profileRegion = profile?.provinceState?.trim() || null;
  const profileAddress = profile?.physicalAddress?.trim() || null;

  // --- Primary: ClubProfile fields --------------------------------------
  if (profileCity || profileRegion || lat != null || lng != null) {
    const city = profileCity ?? "—";
    const region = profileRegion ?? "—";
    const label =
      profileCity && profileRegion
        ? `${profileCity}, ${profileRegion}`
        : profileCity ?? profileRegion ?? club.name;
    return {
      latitude: lat,
      longitude: lng,
      city,
      region,
      label,
      street: profileAddress ?? club.address ?? null,
      temperatureUnit: temperatureUnitForRegion(profileRegion),
    };
  }

  // --- Legacy: parse Club.address + Club.region (city-precision only) ---
  const parsedCity = parseAddressCity(club.address);
  const parsedRegion = club.region ?? null;
  const city = parsedCity ?? "—";
  const region = parsedRegion ?? "—";
  const label =
    parsedCity && parsedRegion ? `${parsedCity}, ${parsedRegion}` : club.name;
  return {
    latitude: null,
    longitude: null,
    city,
    region,
    label,
    street: club.address ?? null,
    temperatureUnit: temperatureUnitForRegion(parsedRegion),
  };
}

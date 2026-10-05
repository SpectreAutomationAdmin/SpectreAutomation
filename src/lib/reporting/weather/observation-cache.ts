// Persistent weather observation cache — WEATHER-HIST-1 (2026-10-05).
//
// Immutable monthly historical observations keyed by
// (clubId, yearMonth, lat, lng). Open-Meteo archive data does not
// revise after the fact, so a cache hit is permanent until the
// tenant's location changes.
//
// Cache invalidation:
//   - `invalidateWeatherCacheForClub(clubId)` is called from the
//     ClubProfile upsert path whenever `latitude` or `longitude`
//     changes. This drops every cached observation for the tenant
//     (not just the matching coordinates) because the whole report
//     surface is reconsidered when a tenant moves.
//   - Operators can also force a refresh via the admin "resolve
//     location" endpoint, which calls `invalidate…` after storing
//     the new coordinates.
//
// Latitude + longitude are stored at 4-decimal precision (~11 metre
// resolution) so the composite unique key is stable against trivial
// floating-point drift.

import { prisma } from "@/lib/prisma";
import type { MonthlyWeatherObservation } from "./types";

const LAT_LNG_PRECISION_DP = 4;

export type CoordinateKey = { latitude: number; longitude: number };

/** Round a lat/lng to the cache's canonical precision. */
export function roundCoordinate(v: number): number {
  return Number(v.toFixed(LAT_LNG_PRECISION_DP));
}

export type ReadWeatherCacheInput = {
  clubId: string;
  yearMonth: string;
  latitude: number;
  longitude: number;
};

/** Hit the persistent cache. Returns the parsed observation or null. */
export async function readWeatherCache(
  input: ReadWeatherCacheInput,
): Promise<MonthlyWeatherObservation | null> {
  const row = await prisma.weatherObservationCache.findUnique({
    where: {
      clubId_yearMonth_latitude_longitude: {
        clubId: input.clubId,
        yearMonth: input.yearMonth,
        latitude: roundCoordinate(input.latitude),
        longitude: roundCoordinate(input.longitude),
      },
    },
  });
  if (!row) return null;
  try {
    return JSON.parse(row.observationJson) as MonthlyWeatherObservation;
  } catch {
    return null;
  }
}

export type WriteWeatherCacheInput = {
  clubId: string;
  yearMonth: string;
  latitude: number;
  longitude: number;
  observation: MonthlyWeatherObservation;
};

/** Persist an observation. Upsert semantics — overwrites a stale row
 *  for the same coordinate (e.g. after an operator force-refresh). */
export async function writeWeatherCache(
  input: WriteWeatherCacheInput,
): Promise<void> {
  const lat = roundCoordinate(input.latitude);
  const lng = roundCoordinate(input.longitude);
  const json = JSON.stringify(input.observation);
  await prisma.weatherObservationCache.upsert({
    where: {
      clubId_yearMonth_latitude_longitude: {
        clubId: input.clubId,
        yearMonth: input.yearMonth,
        latitude: lat,
        longitude: lng,
      },
    },
    update: {
      observationJson: json,
      source: input.observation.provenance.source,
      fetchedAt: new Date(),
    },
    create: {
      clubId: input.clubId,
      yearMonth: input.yearMonth,
      latitude: lat,
      longitude: lng,
      observationJson: json,
      source: input.observation.provenance.source,
    },
  });
}

/**
 * Invalidate every cached observation for a tenant. Called from the
 * ClubProfile upsert path when the operator changes `latitude` or
 * `longitude` — the old coordinates may still match some rows, but
 * none of those rows should keep informing the Section XI chapter
 * once the tenant has moved. Returns the number of rows deleted so
 * the caller can audit-log the effect.
 */
export async function invalidateWeatherCacheForClub(
  clubId: string,
): Promise<number> {
  const r = await prisma.weatherObservationCache.deleteMany({
    where: { clubId },
  });
  return r.count;
}

#!/usr/bin/env node
// WEATHER-HIST-1 (2026-10-05) — one-shot backfill.
//
// Writes Coulee Ridge Golf & Country Club's authoritative physical
// location (Drumheller, Alberta) into its canonical ClubProfile row.
// After this script runs, `src/lib/reporting/weather/club-location.ts`
// resolves Coulee's coordinates from the ClubProfile row — the
// hardcoded tenant fingerprint has been removed from the source.
//
// Values are the ones that previously lived in the removed
// `KNOWN_CLUBS[].resolve()` fingerprint; this is the directive-
// sanctioned "use the existing fingerprint as migration evidence
// for the authoritative coordinates" step. After the slice lands the
// source of truth is ClubProfile; the fingerprint is gone.
//
// Idempotent — if the ClubProfile already carries the Drumheller
// values, the upsert is a no-op write. Running twice is safe.
//
// Usage:
//   node scripts/weather-hist-1-backfill-coulee-location.mjs
//
// Env:
//   DATABASE_URL — Prisma connection string.
//   COULEE_CLUB_ID — override the Coulee club id (defaults to the
//     staging tenant id).

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const CLUB_ID = process.env.COULEE_CLUB_ID ?? "cmrvdeny7000144372ktmmg9c";

const AUTHORITATIVE_COULEE_LOCATION = {
  // Drumheller, Alberta — in the Canadian badlands, canonical
  // location of the fictional Coulee Ridge Golf & Country Club.
  physicalAddress: "Drumheller, Alberta, Canada",
  city: "Drumheller",
  provinceState: "Alberta",
  latitude: "51.4636",
  longitude: "-112.7208",
};

async function main() {
  const club = await prisma.club.findUnique({
    where: { id: CLUB_ID },
    select: { id: true, name: true, slug: true },
  });
  if (!club) {
    throw new Error(`Club ${CLUB_ID} not found — set COULEE_CLUB_ID.`);
  }
  console.log(`[weather-hist-1] Backfilling ClubProfile for club=${club.name} slug=${club.slug ?? "—"} id=${club.id}`);

  const before = await prisma.clubProfile.findUnique({
    where: { clubId: club.id },
    select: {
      physicalAddress: true,
      city: true,
      provinceState: true,
      latitude: true,
      longitude: true,
      locationGeocodedAt: true,
    },
  });
  console.log("[weather-hist-1] BEFORE:", JSON.stringify(before, null, 2));

  const saved = await prisma.clubProfile.upsert({
    where: { clubId: club.id },
    create: {
      clubId: club.id,
      physicalAddress: AUTHORITATIVE_COULEE_LOCATION.physicalAddress,
      city: AUTHORITATIVE_COULEE_LOCATION.city,
      provinceState: AUTHORITATIVE_COULEE_LOCATION.provinceState,
      latitude: AUTHORITATIVE_COULEE_LOCATION.latitude,
      longitude: AUTHORITATIVE_COULEE_LOCATION.longitude,
      // Operator-supplied (migrated-from-fingerprint) coordinates.
      // Null `locationGeocodedAt` signals "set manually, not via the
      // setup-time geocoder".
      locationGeocodedAt: null,
    },
    update: {
      physicalAddress: AUTHORITATIVE_COULEE_LOCATION.physicalAddress,
      city: AUTHORITATIVE_COULEE_LOCATION.city,
      provinceState: AUTHORITATIVE_COULEE_LOCATION.provinceState,
      latitude: AUTHORITATIVE_COULEE_LOCATION.latitude,
      longitude: AUTHORITATIVE_COULEE_LOCATION.longitude,
      locationGeocodedAt: null,
    },
    select: {
      physicalAddress: true,
      city: true,
      provinceState: true,
      latitude: true,
      longitude: true,
      locationGeocodedAt: true,
    },
  });
  console.log("[weather-hist-1] AFTER:", JSON.stringify(saved, null, 2));

  // Invalidate any prior WeatherObservationCache rows for this tenant
  // so Section XI picks up the new coordinates on the next render.
  const invalidated = await prisma.weatherObservationCache.deleteMany({
    where: { clubId: club.id },
  });
  console.log(`[weather-hist-1] Invalidated ${invalidated.count} WeatherObservationCache row(s).`);

  console.log("[weather-hist-1] OK.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("[weather-hist-1] FAILED:", err);
    await prisma.$disconnect();
    process.exit(1);
  });

-- WEATHER-HIST-1 (2026-10-05) — canonical tenant geographic
-- resolution for weather + persistent historical weather cache.
--
-- Section A: Add geographic coordinate columns to ClubProfile. These
--   are the single source of truth for a tenant's physical location.
--   Nullable so existing rows backfill in a separate step.
--
-- Section B: Create WeatherObservationCache — persistent cache of
--   immutable Open-Meteo monthly archive observations keyed by
--   (clubId, yearMonth, lat, lng). Overrides for a given club are
--   invalidated when its location changes.
--
-- Zero accounting-table mutations.

-- Section A -----------------------------------------------------------
ALTER TABLE "ClubProfile" ADD COLUMN "latitude"           DECIMAL(9, 6);
ALTER TABLE "ClubProfile" ADD COLUMN "longitude"          DECIMAL(9, 6);
ALTER TABLE "ClubProfile" ADD COLUMN "locationGeocodedAt" TIMESTAMP(3);

-- Section B -----------------------------------------------------------
CREATE TABLE "WeatherObservationCache" (
  "id"              TEXT           NOT NULL PRIMARY KEY,
  "clubId"          TEXT           NOT NULL REFERENCES "Club"("id") ON DELETE CASCADE,
  "yearMonth"       TEXT           NOT NULL,
  "latitude"        DECIMAL(9, 6)  NOT NULL,
  "longitude"       DECIMAL(9, 6)  NOT NULL,
  "observationJson" TEXT           NOT NULL,
  "source"          TEXT           NOT NULL,
  "fetchedAt"       TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "WeatherObservationCache_club_period_coord_unique"
  ON "WeatherObservationCache"("clubId", "yearMonth", "latitude", "longitude");

CREATE INDEX "WeatherObservationCache_clubId_yearMonth_idx"
  ON "WeatherObservationCache"("clubId", "yearMonth");

CREATE INDEX "WeatherObservationCache_clubId_idx"
  ON "WeatherObservationCache"("clubId");

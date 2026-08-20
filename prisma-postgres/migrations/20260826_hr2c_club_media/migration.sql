-- HR-2C (2026-08-20) — ClubMedia
--
-- Canonical per-Club media store for tenant-owned assets like the
-- Employee Portal hero photograph. Additive-only. No back-fill.
--
-- Categories (service-validated): employee_portal_hero (+ future).
-- One row per (clubId, category); replacing the row rotates the asset.

CREATE TABLE "ClubMedia" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "clubId"            TEXT NOT NULL,
  "category"          TEXT NOT NULL,
  "storageKey"        TEXT NOT NULL,
  "mimeType"          TEXT NOT NULL,
  "sizeBytes"         INTEGER NOT NULL,
  "sha256"            TEXT NOT NULL,
  "displayName"       TEXT,
  "uploadedByUserId"  TEXT,
  "uploadedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClubMedia_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ClubMedia_clubId_category_key"
  ON "ClubMedia"("clubId", "category");
CREATE INDEX "ClubMedia_clubId_idx"
  ON "ClubMedia"("clubId");

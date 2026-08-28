-- HR-2C Fore! Announcements (2026-08-27) — extend the existing
-- ClubAnnouncement table with the fields required by the Fore!
-- Announcements admin authoring workflow. This is the canonical
-- announcement model; no parallel EmployeeAnnouncement table is
-- introduced. Audience is stored as a String ("EMPLOYEE" |
-- "MEMBER" | "BOTH") — the service normalises legacy
-- "ALL_MEMBERS" rows to "EMPLOYEE" on read.

ALTER TABLE "ClubAnnouncement"
  ADD COLUMN IF NOT EXISTS "isPublished" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "isPinned"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "updatedByUserId" TEXT;

-- Any pre-existing rows that carried a `publishedAt` (the legacy
-- "published" gate) are considered published under the new
-- `isPublished` flag. Draft rows (publishedAt IS NULL) remain
-- drafts.
UPDATE "ClubAnnouncement"
  SET "isPublished" = true
  WHERE "publishedAt" IS NOT NULL AND "isPublished" = false;

CREATE INDEX IF NOT EXISTS "ClubAnnouncement_clubId_isPublished_idx"
  ON "ClubAnnouncement" ("clubId", "isPublished");

CREATE INDEX IF NOT EXISTS "ClubAnnouncement_clubId_audience_idx"
  ON "ClubAnnouncement" ("clubId", "audience");

CREATE INDEX IF NOT EXISTS "ClubAnnouncement_clubId_expiresAt_idx"
  ON "ClubAnnouncement" ("clubId", "expiresAt");

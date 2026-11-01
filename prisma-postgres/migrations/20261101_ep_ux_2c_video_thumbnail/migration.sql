-- EP-UX-2C (2026-11-01) -- Postgres mirror.  Additive; rollback does
-- NOT drop the columns.  Nullable so existing rows need no backfill
-- at migration time; the ep-ux-2c-thumbnail-backfill script fills
-- them in a controlled idempotent pass.

ALTER TABLE "TrainingCourseVersion"
  ADD COLUMN IF NOT EXISTS "videoThumbnailStorageKey" TEXT,
  ADD COLUMN IF NOT EXISTS "videoThumbnailMimeType"   TEXT,
  ADD COLUMN IF NOT EXISTS "videoThumbnailSizeBytes"  INTEGER;

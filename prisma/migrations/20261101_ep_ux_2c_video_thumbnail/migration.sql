-- EP-UX-2C (2026-11-01) -- SQLite (dev) mirror.  Additive; rollback
-- does NOT drop the columns.
--
-- Three nullable columns on TrainingCourseVersion for the
-- representative-frame thumbnail extracted at upload time (or by
-- the ep-ux-2c-thumbnail-backfill script for legacy rows).  The
-- actual R2 object lives at the storageKey; this table only
-- carries the metadata.

ALTER TABLE "TrainingCourseVersion" ADD COLUMN "videoThumbnailStorageKey" TEXT;
ALTER TABLE "TrainingCourseVersion" ADD COLUMN "videoThumbnailMimeType"   TEXT;
ALTER TABLE "TrainingCourseVersion" ADD COLUMN "videoThumbnailSizeBytes"  INTEGER;

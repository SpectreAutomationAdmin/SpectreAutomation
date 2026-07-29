-- Sprint 3 · Checkpoint 15S (2026-07-29) — persistent source-to-
-- canonical-AP relationship + composite analysis-version fingerprint.
--
-- Founder rule (architectural reset):
--   SHA deduplication reuses document bytes and analysis, but the
--   workflow relationship between a source email/attachment and the
--   canonical AP intake must be persisted explicitly. The projection
--   layer MUST NOT reconstruct that relationship from hash equality
--   alone.
--
-- Adds:
--   1. WorkIntakeItem.analysisVersion (nullable String) — composite
--      analyser version tag written at analysis time; stale-check on
--      read triggers controlled reanalysis.
--   2. ApIntakeSource table — one row per EmailAttachment that
--      participates in an AP workflow. Tenant-scoped via clubId.
--      Foreign-key cascades on all four related rows so an admin
--      delete of a canonical AP intake, ingested doc, source email,
--      or attachment does not leave orphan links.
--
-- Backwards-compat: legacy WorkIntakeItems (pre-15S) have
-- analysisVersion=null and no ApIntakeSource rows. The projection's
-- bounded legacy fallback (walking IngestedDocument → EmailAttachment
-- → EmailMessage → email intake) handles those exactly as before.

-- ---------------------------------------------------------------------------
-- 1. WorkIntakeItem.analysisVersion
-- ---------------------------------------------------------------------------
ALTER TABLE "WorkIntakeItem" ADD COLUMN "analysisVersion" TEXT;

-- ---------------------------------------------------------------------------
-- 2. ApIntakeSource table
-- ---------------------------------------------------------------------------
CREATE TABLE "ApIntakeSource" (
    "id"                      TEXT NOT NULL,
    "clubId"                  TEXT NOT NULL,
    "emailAttachmentId"       TEXT NOT NULL,
    "emailMessageId"          TEXT NOT NULL,
    "ingestedDocumentId"      TEXT NOT NULL,
    "canonicalApIntakeId"     TEXT NOT NULL,
    "relationship"            TEXT NOT NULL,
    "reason"                  TEXT,
    "analysisVersionAtLink"   TEXT,
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApIntakeSource_pkey" PRIMARY KEY ("id")
);

-- One source row per EmailAttachment. Re-linking an attachment to a
-- different canonical AP intake requires updating the row, not
-- inserting a second row.
CREATE UNIQUE INDEX "ApIntakeSource_emailAttachmentId_key" ON "ApIntakeSource"("emailAttachmentId");
CREATE INDEX "ApIntakeSource_clubId_canonicalApIntakeId_idx" ON "ApIntakeSource"("clubId", "canonicalApIntakeId");
CREATE INDEX "ApIntakeSource_clubId_emailMessageId_idx" ON "ApIntakeSource"("clubId", "emailMessageId");
CREATE INDEX "ApIntakeSource_clubId_ingestedDocumentId_idx" ON "ApIntakeSource"("clubId", "ingestedDocumentId");

ALTER TABLE "ApIntakeSource"
  ADD CONSTRAINT "ApIntakeSource_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ApIntakeSource"
  ADD CONSTRAINT "ApIntakeSource_emailAttachmentId_fkey"
  FOREIGN KEY ("emailAttachmentId") REFERENCES "EmailAttachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApIntakeSource"
  ADD CONSTRAINT "ApIntakeSource_emailMessageId_fkey"
  FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApIntakeSource"
  ADD CONSTRAINT "ApIntakeSource_ingestedDocumentId_fkey"
  FOREIGN KEY ("ingestedDocumentId") REFERENCES "IngestedDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApIntakeSource"
  ADD CONSTRAINT "ApIntakeSource_canonicalApIntakeId_fkey"
  FOREIGN KEY ("canonicalApIntakeId") REFERENCES "WorkIntakeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

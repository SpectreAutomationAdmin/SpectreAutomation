-- Sprint 3 · Checkpoint 15S (2026-07-29) — mirrors the postgres
-- migration for the local SQLite dev DB. See
-- prisma-postgres/migrations/20260729_c15s_ap_intake_source/migration.sql
-- for the doc block. Migration SQL adapts to SQLite conventions.

-- 1. WorkIntakeItem.analysisVersion
ALTER TABLE "WorkIntakeItem" ADD COLUMN "analysisVersion" TEXT;

-- 2. ApIntakeSource table
CREATE TABLE "ApIntakeSource" (
    "id"                      TEXT NOT NULL PRIMARY KEY,
    "clubId"                  TEXT NOT NULL,
    "emailAttachmentId"       TEXT NOT NULL,
    "emailMessageId"          TEXT NOT NULL,
    "ingestedDocumentId"      TEXT NOT NULL,
    "canonicalApIntakeId"     TEXT NOT NULL,
    "relationship"            TEXT NOT NULL,
    "reason"                  TEXT,
    "analysisVersionAtLink"   TEXT,
    "createdAt"               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               DATETIME NOT NULL,
    CONSTRAINT "ApIntakeSource_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApIntakeSource_emailAttachmentId_fkey"
      FOREIGN KEY ("emailAttachmentId") REFERENCES "EmailAttachment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApIntakeSource_emailMessageId_fkey"
      FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApIntakeSource_ingestedDocumentId_fkey"
      FOREIGN KEY ("ingestedDocumentId") REFERENCES "IngestedDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApIntakeSource_canonicalApIntakeId_fkey"
      FOREIGN KEY ("canonicalApIntakeId") REFERENCES "WorkIntakeItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ApIntakeSource_emailAttachmentId_key" ON "ApIntakeSource"("emailAttachmentId");
CREATE INDEX "ApIntakeSource_clubId_canonicalApIntakeId_idx" ON "ApIntakeSource"("clubId", "canonicalApIntakeId");
CREATE INDEX "ApIntakeSource_clubId_emailMessageId_idx" ON "ApIntakeSource"("clubId", "emailMessageId");
CREATE INDEX "ApIntakeSource_clubId_ingestedDocumentId_idx" ON "ApIntakeSource"("clubId", "ingestedDocumentId");

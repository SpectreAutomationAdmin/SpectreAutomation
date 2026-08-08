-- Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — page-level OCR
-- dispatch (SQLite dev variant).
--
-- SQLite requires rebuilding the unique index rather than an ALTER
-- INDEX. The column adds are ADD COLUMN which SQLite supports.

ALTER TABLE "DocumentOcrExtraction" ADD COLUMN "pageNumber" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DocumentOcrExtraction" ADD COLUMN "regionKey" TEXT;

DROP INDEX IF EXISTS "DocumentOcrExtraction_clubId_documentSha256_provider_extract_key";
DROP INDEX IF EXISTS "DocumentOcrExtraction_identity_key";

CREATE UNIQUE INDEX "DocumentOcrExtraction_clubId_documentSha256_provider_extractionVersion_pageNumber_key"
  ON "DocumentOcrExtraction"("clubId", "documentSha256", "provider", "extractionVersion", "pageNumber");

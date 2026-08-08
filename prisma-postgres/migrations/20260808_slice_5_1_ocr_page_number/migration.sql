-- Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — page-level OCR
-- dispatch. Persistence identity extends to include the specific
-- page the extraction covers so mixed digital+scanned PDFs can
-- run OCR page-by-page independently.
--
-- Existing rows migrate to pageNumber = 0 (whole-document extraction
-- semantics), preserving pre-5.1 provenance without gap. The new
-- unique constraint uses the 5-column key; the old 4-column
-- constraint is dropped in the same statement so a controlled
-- reprocess with the same version + new page can coexist with the
-- old whole-document row.
--
-- `regionKey` is nullable and reserved for a future deterministic
-- region identifier (§6 amendment). Adding a column here rather
-- than in a follow-on migration means the schema is forward-safe.

ALTER TABLE "DocumentOcrExtraction"
  ADD COLUMN "pageNumber" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "DocumentOcrExtraction"
  ADD COLUMN "regionKey" TEXT;

DROP INDEX "DocumentOcrExtraction_identity_key";

CREATE UNIQUE INDEX "DocumentOcrExtraction_identity_key"
  ON "DocumentOcrExtraction"("clubId", "documentSha256", "provider", "extractionVersion", "pageNumber");

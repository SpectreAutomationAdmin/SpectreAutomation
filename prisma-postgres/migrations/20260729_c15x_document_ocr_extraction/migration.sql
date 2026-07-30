-- Sprint 3 · Checkpoint 15X continuation (2026-07-29) — persistent
-- OCR extraction results.
--
-- Founder rules covered:
--   §3 Persist canonical document extraction — every column below.
--   §4 Idempotency — @@unique(clubId, documentSha256, provider,
--      extractionVersion). At most one row per identity, safe under
--      concurrent worker races.
--   §5 Controlled reprocessing — bumping extractionVersion inserts a
--      new row while the prior version remains for audit.
--   §11 Cache invalidation — @@index(clubId, updatedAt) supports the
--      per-club revision fingerprint used by the projection cache.
--
-- The OCR worker is the ONLY code path allowed to invoke a paid
-- provider. Rendering paths read persisted rows; no side effects.

CREATE TABLE "DocumentOcrExtraction" (
    "id"                        TEXT NOT NULL,
    "clubId"                    TEXT NOT NULL,
    "ingestedDocumentId"        TEXT NOT NULL,
    "documentSha256"            TEXT NOT NULL,
    "documentClass"             TEXT NOT NULL,
    "provider"                  TEXT NOT NULL,
    "providerApi"               TEXT NOT NULL,
    "providerRegion"            TEXT,
    "extractionVersion"         INTEGER NOT NULL,
    "normalizedSchemaVersion"   INTEGER NOT NULL,
    "strategy"                  TEXT NOT NULL,
    "status"                    TEXT NOT NULL DEFAULT 'PENDING',
    "normalizedExtractionJson"  TEXT,
    "confidenceSummaryJson"     TEXT,
    "warningsJson"              TEXT,
    "sanitizedErrorCode"        TEXT,
    "attemptCount"              INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt"               TIMESTAMP(3),
    "startedAt"                 TIMESTAMP(3),
    "completedAt"               TIMESTAMP(3),
    "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                 TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentOcrExtraction_pkey" PRIMARY KEY ("id")
);

-- §4 durable idempotency: unique per identity.
CREATE UNIQUE INDEX "DocumentOcrExtraction_identity_key"
  ON "DocumentOcrExtraction"("clubId", "documentSha256", "provider", "extractionVersion");

-- Common lookup patterns.
CREATE INDEX "DocumentOcrExtraction_clubId_status_idx"
  ON "DocumentOcrExtraction"("clubId", "status");
CREATE INDEX "DocumentOcrExtraction_ingestedDocumentId_idx"
  ON "DocumentOcrExtraction"("ingestedDocumentId");

-- §11 cache-invalidation fingerprint support.
CREATE INDEX "DocumentOcrExtraction_clubId_updatedAt_idx"
  ON "DocumentOcrExtraction"("clubId", "updatedAt");

ALTER TABLE "DocumentOcrExtraction"
  ADD CONSTRAINT "DocumentOcrExtraction_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DocumentOcrExtraction"
  ADD CONSTRAINT "DocumentOcrExtraction_ingestedDocumentId_fkey"
  FOREIGN KEY ("ingestedDocumentId") REFERENCES "IngestedDocument"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

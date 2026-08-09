-- Sprint 3 · Phase 4 Slice 5.7B (2026-08-09) — durable global
-- ProductReference infrastructure. Additive per §32.
--
-- Global product FACTS (no clubId) — tenant-specific accounting
-- interpretation is NEVER stored here. See §4-§9 design.
--
-- Postgres variant. Additive DDL only, safe under release_command
-- rolling deploy.

CREATE TABLE "ProductReference" (
  "id"                         TEXT NOT NULL,
  "normalizedKey"              TEXT NOT NULL,

  "normalizedManufacturer"     TEXT NOT NULL,
  "normalizedModel"            TEXT NOT NULL,
  "normalizedPartNumber"       TEXT,

  "productFamily"              TEXT,
  "objectType"                 TEXT,
  "identityEvidenceJson"       TEXT NOT NULL DEFAULT '[]',
  "sourceEvidenceJson"         TEXT NOT NULL DEFAULT '[]',

  "evidenceQuality"            TEXT NOT NULL DEFAULT 'UNKNOWN',
  "confidence"                 DOUBLE PRECISION NOT NULL DEFAULT 0,

  "researchState"              TEXT NOT NULL DEFAULT 'PENDING',

  "provider"                   TEXT,
  "providerVersion"            TEXT,
  "researchVersion"            TEXT NOT NULL DEFAULT '1',
  "evidenceSchemaVersion"      TEXT NOT NULL DEFAULT '1',

  "identityVerifiedAt"         TIMESTAMP(3),
  "identityExpiresAt"          TIMESTAMP(3),
  "priceExpiresAt"             TIMESTAMP(3),

  "researchAttempts"           INTEGER NOT NULL DEFAULT 0,
  "lastResearchAttemptAt"      TIMESTAMP(3),
  "lastResearchError"          TEXT,
  "nextRetryAt"                TIMESTAMP(3),

  "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProductReference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductReference_normalizedKey_key"
  ON "ProductReference"("normalizedKey");

CREATE INDEX "ProductReference_researchState_idx"
  ON "ProductReference"("researchState");

CREATE INDEX "ProductReference_normalizedManufacturer_normalizedModel_idx"
  ON "ProductReference"("normalizedManufacturer", "normalizedModel");

CREATE INDEX "ProductReference_nextRetryAt_idx"
  ON "ProductReference"("nextRetryAt");

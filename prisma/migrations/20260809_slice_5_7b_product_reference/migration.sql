-- Sprint 3 · Phase 4 Slice 5.7B (2026-08-09) — durable global
-- ProductReference infrastructure. Additive per §32.
--
-- Global product FACTS (no clubId) — tenant-specific accounting
-- interpretation is NEVER stored here. Reference the §4-§9 design.

CREATE TABLE "ProductReference" (
  "id"                         TEXT NOT NULL PRIMARY KEY,
  "normalizedKey"              TEXT NOT NULL,

  "normalizedManufacturer"     TEXT NOT NULL,
  "normalizedModel"            TEXT NOT NULL,
  "normalizedPartNumber"       TEXT,

  "productFamily"              TEXT,
  "objectType"                 TEXT,
  "identityEvidenceJson"       TEXT NOT NULL DEFAULT '[]',
  "sourceEvidenceJson"         TEXT NOT NULL DEFAULT '[]',

  "evidenceQuality"            TEXT NOT NULL DEFAULT 'UNKNOWN',
  "confidence"                 REAL NOT NULL DEFAULT 0,

  "researchState"              TEXT NOT NULL DEFAULT 'PENDING',

  "provider"                   TEXT,
  "providerVersion"            TEXT,
  "researchVersion"            TEXT NOT NULL DEFAULT '1',
  "evidenceSchemaVersion"      TEXT NOT NULL DEFAULT '1',

  "identityVerifiedAt"         DATETIME,
  "identityExpiresAt"          DATETIME,
  "priceExpiresAt"             DATETIME,

  "researchAttempts"           INTEGER NOT NULL DEFAULT 0,
  "lastResearchAttemptAt"      DATETIME,
  "lastResearchError"          TEXT,
  "nextRetryAt"                DATETIME,

  "createdAt"                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                  DATETIME NOT NULL
);

CREATE UNIQUE INDEX "ProductReference_normalizedKey_key"
  ON "ProductReference"("normalizedKey");

CREATE INDEX "ProductReference_researchState_idx"
  ON "ProductReference"("researchState");

CREATE INDEX "ProductReference_normalizedManufacturer_normalizedModel_idx"
  ON "ProductReference"("normalizedManufacturer", "normalizedModel");

CREATE INDEX "ProductReference_nextRetryAt_idx"
  ON "ProductReference"("nextRetryAt");

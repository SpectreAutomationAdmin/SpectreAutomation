-- FPP-9C (2026-09-22) — durable fingerprint-mismatch audit event.
-- Additive-only, idempotent.

CREATE TABLE IF NOT EXISTS "FingerprintMismatchEvent" (
  "id"                    TEXT PRIMARY KEY,
  "clubId"                TEXT NOT NULL,
  "batchId"               TEXT NOT NULL,
  "storedFingerprint"     TEXT NOT NULL,
  "recomputedFingerprint" TEXT NOT NULL,
  "detectedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "detectedByUserId"      TEXT,
  "detectionContext"      TEXT,
  "actionTaken"           TEXT NOT NULL DEFAULT 'HISTORICAL_VALUE_LEFT_UNCHANGED',
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FingerprintMismatchEvent_batchId_stored_recomputed_key') THEN
    ALTER TABLE "FingerprintMismatchEvent"
      ADD CONSTRAINT "FingerprintMismatchEvent_batchId_stored_recomputed_key"
      UNIQUE ("batchId", "storedFingerprint", "recomputedFingerprint");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FingerprintMismatchEvent_clubId_fkey') THEN
    ALTER TABLE "FingerprintMismatchEvent"
      ADD CONSTRAINT "FingerprintMismatchEvent_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FingerprintMismatchEvent_batchId_fkey') THEN
    ALTER TABLE "FingerprintMismatchEvent"
      ADD CONSTRAINT "FingerprintMismatchEvent_batchId_fkey"
      FOREIGN KEY ("batchId") REFERENCES "PayrollBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "FingerprintMismatchEvent_clubId_detectedAt_idx"
  ON "FingerprintMismatchEvent"("clubId", "detectedAt");
CREATE INDEX IF NOT EXISTS "FingerprintMismatchEvent_batchId_idx"
  ON "FingerprintMismatchEvent"("batchId");
